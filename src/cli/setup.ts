/**
 * Interactive `whoop-ai-mcp setup` wizard.
 *
 * Walks a user through:
 *   1. WHOOP OAuth credential entry (prompted, secrets masked)
 *   2. (optional) `--verify` runs the full OAuth flow + a profile fetch
 *      to prove credentials and refresh tokens both work
 *   3. Generates client configuration:
 *        - claude-desktop: merges a `whoop` entry into the existing config
 *          file (creates `.bak` first; restores on failure)
 *        - claude-code:    prints the `claude mcp add ...` command to run
 *        - codex:          prints the `codex mcp add ...` command to run
 *        - copilot:        prints the `code --add-mcp ...` command to run
 *
 * No new runtime dependencies — uses only Node's built-in modules.
 * All output goes to stdout; errors throw and surface via the dispatcher.
 */

import { promises as fs } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface, type Interface } from "node:readline";

import { authenticate } from "../auth/oauth.js";
import type { OAuthConfig } from "../auth/oauth.js";
import {
  deleteTokens,
  loadTokens,
  redactHomePath,
  resolveTokenDir,
  saveTokens,
  TOKEN_DIR_ENV,
  type OAuthTokens,
} from "../auth/token-store.js";
import { refreshAccessToken, toOAuthTokens } from "../auth/oauth.js";
import {
  createWhoopClient,
  WhoopApiError,
  WhoopAuthError,
  WhoopNetworkError,
} from "../api/client.js";
import { getProfile } from "../tools/get-profile.js";

import {
  claudeDesktopConfigPath,
  generateClaudeCodeCommand,
  generateClaudeDesktopEntry,
  generateCodexCommand,
  generateCopilotCommand,
  mergeClaudeDesktopConfig,
  type ClaudeDesktopConfig,
  type ClientTarget,
} from "./config-generators.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SetupOptions {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly client?: ClientTarget;
  readonly verify?: boolean;
  /** Optional override for the Claude Desktop config path (used by tests). */
  readonly configPath?: string;
}

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

/**
 * Parse `setup`-subcommand arguments.
 *
 * Supported flags:
 *   --client-id=<value> | --client-id <value>
 *   --client-secret=<value> | --client-secret <value>
 *   --client=<claude-desktop|claude-code|codex|copilot>
 *   --verify
 *   --config-path=<value>   (test hook)
 */
export function parseSetupArgs(argv: readonly string[]): SetupOptions {
  const out: {
    clientId?: string;
    clientSecret?: string;
    client?: ClientTarget;
    verify?: boolean;
    configPath?: string;
  } = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const [key, inlineValue] = arg.startsWith("--") ? splitFlag(arg) : ["", undefined];

    const valueAt = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`Missing value for flag ${key}`);
      }
      i++;
      return next;
    };

    switch (key) {
      case "--client-id":
        out.clientId = valueAt();
        break;
      case "--client-secret":
        out.clientSecret = valueAt();
        break;
      case "--client": {
        const v = valueAt();
        if (!isClientTarget(v)) {
          throw new Error(
            `Invalid --client value: "${v}". Must be "claude-desktop", "claude-code", "codex", or "copilot".`
          );
        }
        out.client = v;
        break;
      }
      case "--verify":
        out.verify = true;
        break;
      case "--config-path":
        out.configPath = valueAt();
        break;
      case "":
        // Ignore positional args (none expected after `setup`)
        break;
      default:
        throw new Error(`Unknown flag: ${key}`);
    }
  }

  return out;
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  if (eq === -1) return [arg, undefined];
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}

const CLIENT_TARGETS: readonly ClientTarget[] = [
  "claude-desktop",
  "claude-code",
  "codex",
  "copilot",
];

function isClientTarget(value: string): value is ClientTarget {
  return (CLIENT_TARGETS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

interface PromptIO {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}

async function promptText(io: PromptIO, question: string): Promise<string> {
  const rl: Interface = createInterface({ input: io.input, output: io.output });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()));
    });
  } finally {
    rl.close();
  }
}

/**
 * Prompt for a secret with no echo. Reads characters from stdin in raw mode
 * and writes asterisks to the output. Falls back to plain readline (with a
 * warning) if raw mode is unavailable (e.g. piped stdin in CI).
 */
async function promptSecret(io: PromptIO, question: string): Promise<string> {
  const stdin = io.input as NodeJS.ReadStream;
  const stdout = io.output;

  if (typeof stdin.setRawMode !== "function" || !stdin.isTTY) {
    stdout.write(`${question}(input will be visible) `);
    const value = await promptText({ input: io.input, output: io.output }, "");
    return value;
  }

  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === "\n" || ch === "\r") {
          cleanup();
          stdout.write("\n");
          resolve(buffer);
          return;
        }
        if (code === 3) {
          // Ctrl-C
          cleanup();
          stdout.write("\n");
          reject(new Error("Interrupted"));
          return;
        }
        if (code === 127 || code === 8) {
          // Backspace / DEL
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (code < 32) continue; // ignore other control chars
        buffer += ch;
        stdout.write("*");
      }
    };
    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    stdin.on("data", onData);
  });
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export interface RunSetupDeps {
  readonly io?: PromptIO;
  readonly authenticate?: (config: OAuthConfig) => Promise<string>;
  /** Fetch the profile after authenticate() to prove the access token works. */
  readonly fetchProfile?: (accessToken: string) => Promise<unknown>;
  /** Delete the stored WHOOP tokens so authenticate() runs a new authorization. */
  readonly deleteTokens?: () => Promise<void>;
  readonly fs?: {
    readFile: (path: string, encoding: "utf8") => Promise<string>;
    writeFile: (path: string, data: string) => Promise<void>;
    rename: (from: string, to: string) => Promise<void>;
    mkdir: (path: string, opts: { recursive: true }) => Promise<void>;
  };
}

const DEFAULT_DEPS: Required<Omit<RunSetupDeps, "io">> & { io: PromptIO } = {
  io: { input: process.stdin, output: process.stdout },
  authenticate,
  fetchProfile: defaultFetchProfile,
  deleteTokens: () => deleteTokens(),
  fs: {
    readFile: (p, enc) => fs.readFile(p, enc),
    writeFile: (p, d) => fs.writeFile(p, d, { mode: 0o600 }),
    rename: (a, b) => fs.rename(a, b),
    mkdir: async (p, o) => {
      await mkdir(p, o);
    },
  },
};

async function defaultFetchProfile(accessToken: string): Promise<unknown> {
  // Build a real client that supports refresh, in case the cached token
  // expired between authenticate() and now. This mirrors src/index.ts.
  // Newest tokens issued during this run, in case saving them fails.
  let latest: OAuthTokens | null = null;
  const onTokenRefresh = async (): Promise<string> => {
    const stored = await loadTokens();
    const tokens =
      latest !== null && (stored === null || latest.expires_at > stored.expires_at)
        ? latest
        : stored;
    if (!tokens) throw new Error("No stored tokens to refresh");
    const refreshed = await refreshAccessToken(tokens.refresh_token, {
      clientId: process.env.WHOOP_CLIENT_ID ?? "",
      clientSecret: process.env.WHOOP_CLIENT_SECRET ?? "",
    });
    const fresh = toOAuthTokens(refreshed, tokens.refresh_token);
    // WHOOP has already rotated the refresh token: a failed save must not turn
    // a working refresh into a verification failure.
    latest = fresh;
    try {
      await saveTokens(fresh);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
      console.error(`Could not save the refreshed WHOOP tokens (${code}).`);
    }
    return fresh.access_token;
  };
  const client = createWhoopClient({ accessToken, onTokenRefresh });
  return getProfile(client);
}

/**
 * Run the setup wizard. Resolves after writing config / printing instructions,
 * or rejects with a human-readable Error if anything goes wrong.
 */
export async function runSetup(options: SetupOptions = {}, deps: RunSetupDeps = {}): Promise<void> {
  const merged: Required<Omit<RunSetupDeps, "io">> & { io: PromptIO } = {
    ...DEFAULT_DEPS,
    ...deps,
    fs: { ...DEFAULT_DEPS.fs, ...(deps.fs ?? {}) },
    io: deps.io ?? DEFAULT_DEPS.io,
  };
  const out = merged.io.output;

  out.write("WHOOP MCP — Setup Wizard\n");
  out.write("------------------------\n\n");
  writeTokenDirNote(out);

  // --- Resolve target client first so we can peek at any existing config. ---
  const target: ClientTarget =
    options.client ??
    (((await promptText(
      merged.io,
      "Target client (claude-desktop / claude-code / codex / copilot) [claude-desktop]: "
    )) || "claude-desktop") as ClientTarget);
  if (!isClientTarget(target)) {
    throw new Error(`Invalid client target: "${target}"`);
  }

  // --- Existing claude-desktop config short-circuit. ---
  // If the user already ran setup, the target config will contain a `whoop`
  // entry with valid env. In that case skip prompting + rewriting; just use
  // those creds and (if --verify) confirm they still work. Explicit
  // --client-id / --client-secret flags force a rewrite.
  const explicitFlags = options.clientId !== undefined || options.clientSecret !== undefined;
  let existingCreds: { clientId: string; clientSecret: string } | null = null;
  let existingConfigPath: string | null = null;
  if (target === "claude-desktop" && !explicitFlags) {
    existingConfigPath = options.configPath ?? claudeDesktopConfigPath();
    existingCreds = await readExistingWhoopCreds(existingConfigPath, merged.fs);
  }

  if (existingCreds && existingConfigPath) {
    out.write(`Existing whoop entry found in ${existingConfigPath}.\n`);
    process.env.WHOOP_CLIENT_ID = existingCreds.clientId;
    process.env.WHOOP_CLIENT_SECRET = existingCreds.clientSecret;
    if (options.verify) {
      await verifyCredentials(existingCreds, merged, out);
      out.write("Existing config verified — no changes made.\n");
    } else {
      out.write("Re-run with --verify to confirm credentials work.\n");
    }
    return;
  }

  // --- Step 1: credentials ---
  // Precedence: explicit flags > WHOOP_CLIENT_ID/SECRET env vars > interactive prompt.
  const envId = process.env.WHOOP_CLIENT_ID?.trim() ?? "";
  const envSecret = process.env.WHOOP_CLIENT_SECRET?.trim() ?? "";
  const usingEnvCreds =
    options.clientId === undefined &&
    options.clientSecret === undefined &&
    envId.length > 0 &&
    envSecret.length > 0;

  if (usingEnvCreds) {
    out.write("Using credentials from environment (WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET).\n\n");
  }

  const clientId =
    options.clientId !== undefined
      ? options.clientId.trim()
      : usingEnvCreds
        ? envId
        : (
            await promptText(merged.io, "WHOOP Client ID (from https://developer.whoop.com): ")
          ).trim();
  if (!clientId) throw new Error("WHOOP_CLIENT_ID is required");

  const clientSecret =
    options.clientSecret !== undefined
      ? options.clientSecret.trim()
      : usingEnvCreds
        ? envSecret
        : (await promptSecret(merged.io, "WHOOP Client Secret (input hidden): ")).trim();
  if (!clientSecret) throw new Error("WHOOP_CLIENT_SECRET is required");

  // Expose to downstream calls (authenticate / fetchProfile pull from env)
  process.env.WHOOP_CLIENT_ID = clientId;
  process.env.WHOOP_CLIENT_SECRET = clientSecret;

  // --- Step 2: optional --verify (OAuth + profile fetch) ---
  if (options.verify) {
    await verifyCredentials({ clientId, clientSecret }, merged, out);
  }

  // --- Step 3: emit config ---
  const env = { WHOOP_CLIENT_ID: clientId, WHOOP_CLIENT_SECRET: clientSecret };

  if (target === "claude-code") {
    out.write("\nRun this command in your shell to register the server:\n\n");
    out.write(`  ${generateClaudeCodeCommand(env)}\n\n`);
    return;
  }

  if (target === "codex") {
    out.write("\nRun this command in your shell to register the server with Codex:\n\n");
    out.write(`  ${generateCodexCommand(env)}\n\n`);
    return;
  }

  if (target === "copilot") {
    out.write("\nRun this command to register the server with GitHub Copilot in VS Code:\n\n");
    out.write(`  ${generateCopilotCommand(env)}\n\n`);
    return;
  }

  // claude-desktop — read existing, backup, merge, write atomically
  const path = options.configPath ?? claudeDesktopConfigPath();
  await writeClaudeDesktopConfig(path, env, merged.fs, out);
}

/**
 * When WHOOP_MCP_TOKEN_DIR is set, say where --verify stores the tokens and
 * that the server needs the same variable: the generated client configuration
 * only carries the WHOOP credentials, so the server would look in ~/.whoop-mcp.
 */
function writeTokenDirNote(out: NodeJS.WritableStream): void {
  const value = process.env[TOKEN_DIR_ENV];
  if (value === undefined || value.trim() === "") return;
  let location: string;
  try {
    location = redactHomePath(resolveTokenDir());
  } catch (error: unknown) {
    out.write(`Warning: ${error instanceof Error ? error.message : String(error)}\n\n`);
    return;
  }
  out.write(
    `WHOOP tokens are stored in ${location} (${TOKEN_DIR_ENV}). Set the same ${TOKEN_DIR_ENV} in the server's environment; the generated configuration does not include it.\n\n`
  );
}

async function readExistingWhoopCreds(
  path: string,
  filesystem: Required<RunSetupDeps>["fs"]
): Promise<{ clientId: string; clientSecret: string } | null> {
  let raw: string;
  try {
    raw = await filesystem.readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: ClaudeDesktopConfig;
  try {
    parsed = JSON.parse(raw) as ClaudeDesktopConfig;
  } catch {
    return null;
  }
  const entry = parsed.mcpServers?.whoop;
  const clientId = entry?.env?.WHOOP_CLIENT_ID?.trim();
  const clientSecret = entry?.env?.WHOOP_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

async function verifyCredentials(
  creds: { clientId: string; clientSecret: string },
  deps: Required<Omit<RunSetupDeps, "io">> & { io: PromptIO },
  out: NodeJS.WritableStream
): Promise<void> {
  out.write("\nVerifying credentials with WHOOP...\n");
  let accessToken: string;
  try {
    accessToken = await deps.authenticate(creds);
  } catch (err) {
    throw new Error(
      `Verification failed during OAuth: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  out.write("OAuth flow complete. Fetching profile...\n");
  let profile: unknown;
  try {
    profile = await deps.fetchProfile(accessToken);
  } catch (err) {
    if (!isRejectedSignIn(err)) {
      throw profileError(err);
    }
    // authenticate() reuses an unexpired cached access token, so a revoked
    // grant or a missing permission would never reach the consent screen.
    // Discard the stored tokens and authorize once more.
    out.write("WHOOP rejected the stored sign-in. Starting a new WHOOP authorization...\n");
    await deps.deleteTokens();
    try {
      accessToken = await deps.authenticate(creds);
    } catch (authErr) {
      throw new Error(
        `Verification failed during OAuth: ${authErr instanceof Error ? authErr.message : String(authErr)}`
      );
    }
    try {
      profile = await deps.fetchProfile(accessToken);
    } catch (retryErr) {
      throw profileError(retryErr);
    }
  }
  out.write(`Profile OK: ${JSON.stringify(profile)}\n\n`);
}

/**
 * Whether WHOOP refused the stored sign-in itself (not a network problem): the
 * refresh token was rejected, or the access token is unauthorized (401) or
 * lacks a permission (403).
 */
function isRejectedSignIn(error: unknown): boolean {
  if (error instanceof WhoopAuthError) {
    return !(error.cause instanceof WhoopNetworkError);
  }
  return error instanceof WhoopApiError && (error.statusCode === 401 || error.statusCode === 403);
}

function profileError(err: unknown): Error {
  return new Error(
    `Verification failed fetching profile: ${err instanceof Error ? err.message : String(err)}`
  );
}

async function writeClaudeDesktopConfig(
  path: string,
  env: { WHOOP_CLIENT_ID: string; WHOOP_CLIENT_SECRET: string },
  filesystem: Required<RunSetupDeps>["fs"],
  out: NodeJS.WritableStream
): Promise<void> {
  await filesystem.mkdir(dirname(path), { recursive: true });

  let existing: ClaudeDesktopConfig | null = null;
  let existingRaw: string | null = null;
  try {
    existingRaw = await filesystem.readFile(path, "utf8");
    existing = JSON.parse(existingRaw) as ClaudeDesktopConfig;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // Existing file is unreadable or invalid JSON — refuse to clobber it.
      throw new Error(
        `Could not parse existing Claude Desktop config at ${path}: ${
          err instanceof Error ? err.message : String(err)
        }. Refusing to overwrite — fix or move the file and re-run setup.`
      );
    }
  }

  const merged = mergeClaudeDesktopConfig(existing, generateClaudeDesktopEntry(env));
  const serialized = `${JSON.stringify(merged, null, 2)}\n`;

  // Backup existing file before overwriting (so a write failure is recoverable)
  const backupPath = `${path}.bak`;
  let backedUp = false;
  if (existingRaw !== null) {
    await filesystem.writeFile(backupPath, existingRaw);
    backedUp = true;
  }

  // Atomic write: tmp file + rename. If anything fails after the backup,
  // restore the original from .bak so the user is never left with a
  // half-written config.
  const tmpPath = `${path}.tmp`;
  try {
    await filesystem.writeFile(tmpPath, serialized);
    await filesystem.rename(tmpPath, path);
  } catch (err) {
    if (backedUp) {
      try {
        await filesystem.rename(backupPath, path);
      } catch {
        // best-effort restore; the .bak still exists for manual recovery
      }
    }
    throw new Error(
      `Failed to write Claude Desktop config: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  out.write(`\nClaude Desktop config written: ${path}\n`);
  if (backedUp) out.write(`Previous config backed up to: ${backupPath}\n`);
  out.write("Restart Claude Desktop to load the new server.\n\n");
}
