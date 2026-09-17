/**
 * `whoop-ai-mcp revoke --yes [--keep-tokens]`: revoke this app's access to the
 * WHOOP account with the stored tokens (DELETE /v2/user/access).
 *
 * Human-only: this is a CLI subcommand and never an MCP tool, so an assistant
 * cannot disconnect the account. Without --yes it only explains what would
 * happen and sends nothing.
 *
 * The request goes through a local fetch helper, not WhoopClient: the client
 * is read-only (GET) by design and refreshes tokens on a 401, which must not
 * happen here.
 */

import { WHOOP_API_BASE_URL } from "../api/endpoints.js";
import { WhoopNetworkError } from "../api/client.js";
import { refreshAccessToken, toOAuthTokens } from "../auth/oauth.js";
import { TokenRefreshError } from "../auth/token-refresh-error.js";
import {
  deleteTokens,
  isTokenExpired,
  loadTokens,
  redactHomePath,
  resolveTokenDir,
  saveTokens,
  type OAuthTokens,
} from "../auth/token-store.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** WHOOP endpoint that revokes the access granted to this app */
export const REVOKE_ACCESS_PATH = "/v2/user/access";

/** Timeout for the revoke request */
const REVOKE_TIMEOUT_MS = 30_000;

/** Exit codes */
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const USAGE = "Usage: whoop-ai-mcp revoke --yes [--keep-tokens]";

/** What the command does; printed without --yes, when nothing is sent. */
const PLAN = [
  "whoop-ai-mcp revoke: revoke this app's access to your WHOOP account.",
  "",
  "With --yes it will:",
  "  1. Read tokens.json from the token folder (WHOOP_MCP_TOKEN_DIR, default ~/.whoop-mcp). If the access token has expired it refreshes it first, which needs WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET.",
  "  2. Ask WHOOP to revoke this app's access (DELETE /v2/user/access). WHOOP then no longer accepts these tokens, and webhooks for this account stop.",
  "  3. Delete tokens.json, unless --keep-tokens is given.",
  "",
  "Stop the running service first: a refresh here rotates the refresh token it uses.",
  "Afterwards, any server for this account needs a new WHOOP sign-in.",
  "",
  "Nothing was sent.",
  USAGE,
].join("\n");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injectable dependencies (tests) */
export interface RevokeDependencies {
  /** Environment for WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET. Default: process.env */
  env: NodeJS.ProcessEnv;
  /** Performs the revoke request. Default: the global fetch, read at call time */
  fetch: typeof fetch;
  /** Writes one line (or block) of output. Default: stdout */
  write: (text: string) => void;
}

interface RevokeOptions {
  keepTokens: boolean;
}

type RefreshOutcome = { ok: true; tokens: OAuthTokens } | { ok: false; message: string };

type RevokeResponse = { status: number } | { status: null };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse the arguments: {yes, keepTokens}, or null for anything unknown. */
function parseRevokeArgs(args: readonly string[]): { yes: boolean; keepTokens: boolean } | null {
  let yes = false;
  let keepTokens = false;
  for (const arg of args) {
    if (arg === "--yes") yes = true;
    else if (arg === "--keep-tokens") keepTokens = true;
    else return null;
  }
  return { yes, keepTokens };
}

/** The `code` of a failed file operation, else the error class */
function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.name : "unknown";
}

/**
 * Refresh expired tokens and save the result. WHOOP rotates the refresh token,
 * so the new tokens are saved before anything else can fail; a failed save is
 * reported but does not stop the revocation.
 */
async function refreshStoredTokens(
  tokens: OAuthTokens,
  tokenDir: string,
  deps: RevokeDependencies
): Promise<RefreshOutcome> {
  const clientId = deps.env.WHOOP_CLIENT_ID?.trim() ?? "";
  const clientSecret = deps.env.WHOOP_CLIENT_SECRET?.trim() ?? "";
  if (clientId === "" || clientSecret === "") {
    return {
      ok: false,
      message:
        "The stored access token has expired, and refreshing it needs WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET. Set both and run revoke again. Nothing was revoked; tokens.json was kept.",
    };
  }
  let refreshed: Awaited<ReturnType<typeof refreshAccessToken>>;
  try {
    refreshed = await refreshAccessToken(tokens.refresh_token, { clientId, clientSecret });
  } catch (error: unknown) {
    return { ok: false, message: describeRefreshError(error) };
  }
  const fresh = toOAuthTokens(refreshed, tokens.refresh_token);
  try {
    await saveTokens(fresh, tokenDir);
  } catch (error: unknown) {
    deps.write(
      `Could not save the refreshed WHOOP tokens (${errorCode(error)}); continuing with them in memory.`
    );
  }
  return { ok: true, tokens: fresh };
}

/** Why refreshing the stored tokens failed, and that nothing was revoked */
function describeRefreshError(error: unknown): string {
  const kept = "Nothing was revoked; tokens.json was kept.";
  if (error instanceof TokenRefreshError) {
    if (error.clientRejected) {
      return `WHOOP rejected this app's client credentials (HTTP ${error.statusCode} invalid_client). Check WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET. ${kept}`;
    }
    if (error.rejected) {
      return `WHOOP rejected the stored refresh token (HTTP ${error.statusCode}${error.oauthError ? ` ${error.oauthError}` : ""}), so these tokens cannot revoke access: the sign-in has already ended, or a running server has rotated the refresh token (stop it and run revoke with its token folder). ${kept}`;
    }
    return `WHOOP could not refresh the stored tokens right now (HTTP ${error.statusCode}). Run revoke again shortly. ${kept}`;
  }
  if (error instanceof WhoopNetworkError) {
    return `Could not reach WHOOP to refresh the stored tokens. Check the connection and run revoke again. ${kept}`;
  }
  return `Refreshing the stored tokens failed (${errorCode(error)}). ${kept}`;
}

/** Send DELETE /v2/user/access; status null when WHOOP could not be reached or timed out */
async function sendRevokeRequest(
  accessToken: string,
  deps: RevokeDependencies
): Promise<RevokeResponse> {
  try {
    const response = await deps.fetch(`${WHOOP_API_BASE_URL}${REVOKE_ACCESS_PATH}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
    // The body is never read or printed (204 has none).
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status };
  } catch {
    return { status: null };
  }
}

/** Why WHOOP did not confirm the revocation (status only, never the body) */
function describeRevokeStatus(status: number): string {
  const kept = "tokens.json was kept.";
  if (status === 400) {
    return `WHOOP rejected the revoke request (HTTP 400). Access was not revoked; ${kept}`;
  }
  if (status === 403) {
    return `WHOOP denied the revoke request (HTTP 403). Access was not revoked; ${kept}`;
  }
  if (status === 429) {
    return `WHOOP rate-limited the revoke request (HTTP 429). Access was not revoked; ${kept} Wait a minute, then run revoke again.`;
  }
  if (status >= 500) {
    return `WHOOP could not process the revoke request (HTTP ${status}), so the revocation is not confirmed; ${kept} Run revoke again later.`;
  }
  return `WHOOP answered the revoke request with HTTP ${status}, so the revocation is not confirmed; ${kept}`;
}

/** Delete (or keep) tokens.json after WHOOP no longer accepts the tokens */
async function finishWithTokens(
  tokenDir: string,
  options: RevokeOptions,
  deps: RevokeDependencies
): Promise<number> {
  const location = redactHomePath(tokenDir);
  if (options.keepTokens) {
    deps.write(`Kept tokens.json in ${location} (--keep-tokens).`);
  } else {
    try {
      await deleteTokens(tokenDir);
      deps.write(`Deleted tokens.json from ${location}.`);
    } catch (error: unknown) {
      deps.write(
        `Could not delete tokens.json from ${location} (${errorCode(error)}); delete it manually.`
      );
      return EXIT_FAILED;
    }
  }
  deps.write(
    "To use the WHOOP MCP server with this account again, sign in to WHOOP again: start the server without tokens.json, or run setup --verify."
  );
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Run `whoop-ai-mcp revoke`.
 *
 * @returns The exit code: 0 when WHOOP revoked the access (HTTP 2xx) or no
 *   longer accepts the stored access token (HTTP 401); 1 when revoking failed
 *   or could not be confirmed (tokens kept); 2 without --yes or for unknown
 *   arguments (no request sent).
 */
export async function runRevoke(
  args: readonly string[],
  dependencies: Partial<RevokeDependencies> = {}
): Promise<number> {
  // Defaults are read at call time (process.env and the global fetch can be replaced).
  const deps: RevokeDependencies = {
    env: dependencies.env ?? process.env,
    fetch: dependencies.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    write:
      dependencies.write ??
      ((text): void => {
        process.stdout.write(`${text}\n`);
      }),
  };
  const parsed = parseRevokeArgs(args);
  if (parsed === null) {
    deps.write(USAGE);
    return EXIT_USAGE;
  }
  if (!parsed.yes) {
    deps.write(PLAN);
    return EXIT_USAGE;
  }

  let tokenDir: string;
  try {
    tokenDir = resolveTokenDir();
  } catch (error: unknown) {
    deps.write(error instanceof Error ? error.message : "Invalid WHOOP_MCP_TOKEN_DIR.");
    return EXIT_FAILED;
  }
  const location = redactHomePath(tokenDir);

  const stored = await loadTokens(tokenDir);
  if (stored === null) {
    deps.write(`No usable WHOOP tokens found in ${location}. Nothing was revoked.`);
    return EXIT_FAILED;
  }

  let tokens = stored;
  if (isTokenExpired(tokens)) {
    deps.write("The stored access token has expired; refreshing it first.");
    const refresh = await refreshStoredTokens(tokens, tokenDir, deps);
    if (!refresh.ok) {
      deps.write(refresh.message);
      return EXIT_FAILED;
    }
    tokens = refresh.tokens;
  }

  const response = await sendRevokeRequest(tokens.access_token, deps);
  if (response.status === null) {
    deps.write(
      "Could not reach WHOOP, or it did not answer in time, so the revocation is not confirmed; tokens.json was kept. Run revoke again."
    );
    return EXIT_FAILED;
  }
  if (response.status >= 200 && response.status < 300) {
    deps.write(`WHOOP revoked this app's access to the account (HTTP ${response.status}).`);
    return finishWithTokens(tokenDir, parsed, deps);
  }
  if (response.status === 401) {
    deps.write(
      "WHOOP no longer accepts the stored access token (HTTP 401): this app's access was already revoked, or this sign-in has ended."
    );
    return finishWithTokens(tokenDir, parsed, deps);
  }
  deps.write(describeRevokeStatus(response.status));
  return EXIT_FAILED;
}
