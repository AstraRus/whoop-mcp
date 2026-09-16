/**
 * File-based OAuth token storage.
 *
 * Stores tokens at ~/.whoop-mcp/tokens.json with secure file permissions.
 * Pure I/O module — no dependencies on API client or OAuth flow.
 */

import { mkdir, writeFile, readFile, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Stored OAuth token set with absolute expiry time */
export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  /** Unix epoch milliseconds — computed at save time: Date.now() + expires_in * 1000 */
  expires_at: number;
  /** Typically "Bearer" */
  token_type: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default token storage directory */
const DEFAULT_TOKEN_DIR = join(homedir(), ".whoop-mcp");

/** Token filename */
const TOKEN_FILENAME = "tokens.json";

/** Buffer in milliseconds before actual expiry to consider token expired */
const EXPIRY_BUFFER_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Replace the home directory prefix with ~ for safe logging (avoids disclosing usernames). */
function redactHomePath(filePath: string): string {
  const home = homedir();
  if (filePath.startsWith(home)) {
    return "~" + filePath.slice(home.length);
  }
  return filePath;
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Check whether the given tokens are expired (or within the 60s safety buffer).
 *
 * Returns `true` if `expires_at <= Date.now() + EXPIRY_BUFFER_MS`.
 */
export function isTokenExpired(tokens: OAuthTokens): boolean {
  return tokens.expires_at <= Date.now() + EXPIRY_BUFFER_MS;
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

/** Resolve the full path to the tokens file */
function tokenFilePath(tokenDir?: string): string {
  return join(tokenDir ?? DEFAULT_TOKEN_DIR, TOKEN_FILENAME);
}

/**
 * Save tokens to disk.
 *
 * Creates the token directory (0700) if it doesn't exist, then writes
 * the token file with 0600 (user-only read/write) permissions.
 */
export async function saveTokens(tokens: OAuthTokens, tokenDir?: string): Promise<void> {
  const dir = tokenDir ?? DEFAULT_TOKEN_DIR;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = tokenFilePath(tokenDir);
  const data = JSON.stringify(tokens, null, 2);
  const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  // Write-then-rename so a crash mid-write can never leave a truncated file
  // behind after WHOOP has already rotated (invalidated) the old refresh token.
  // Where the rename is not possible (tokens.json held open on Windows, a
  // single-file bind mount, a read-only directory) fall back to writing the
  // file in place, which is what worked before: losing the new tokens is worse.
  try {
    await writeFile(temp, data, { encoding: "utf-8", mode: 0o600 });
    await renameWithRetry(temp, target);
  } catch (error: unknown) {
    if (!IN_PLACE_FALLBACK_CODES.has(errorCode(error) ?? "")) {
      throw error;
    }
    await writeFile(target, data, { encoding: "utf-8", mode: 0o600 });
  } finally {
    // Never leave a second copy of the refresh token behind. ENOENT after a
    // successful rename is expected.
    await unlink(temp).catch(() => undefined);
  }
}

/** Error codes for which saveTokens falls back to an in-place write */
const IN_PLACE_FALLBACK_CODES: ReadonlySet<string> = new Set([
  "EPERM",
  "EACCES",
  "EBUSY",
  "EXDEV",
  "EROFS",
]);

/** Error codes worth retrying a rename for on Windows (transient sharing violations) */
const WIN32_RENAME_RETRY_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Delays between Windows rename retries (about 1.5 s in total) */
const WIN32_RENAME_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 750];

/** The `code` of a Node.js system error, if any */
function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Rename, retrying briefly on Windows where antivirus, indexers and backup
 * tools transiently hold files open (as graceful-fs does).
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error: unknown) {
      const delayMs = WIN32_RENAME_RETRY_DELAYS_MS[attempt];
      if (
        process.platform !== "win32" ||
        delayMs === undefined ||
        !WIN32_RENAME_RETRY_CODES.has(errorCode(error) ?? "")
      ) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Validate that parsed JSON has the required OAuthTokens shape.
 * Prevents confusing runtime errors from corrupted/tampered tokens.json.
 */
function isValidTokenShape(data: unknown): data is OAuthTokens {
  if (typeof data !== "object" || data === null) return false;

  const record = data as Record<string, unknown>;
  return (
    typeof record.access_token === "string" &&
    record.access_token.length > 0 &&
    typeof record.refresh_token === "string" &&
    record.refresh_token.length > 0 &&
    typeof record.expires_at === "number"
  );
}

/**
 * Load tokens from disk.
 *
 * Returns the parsed `OAuthTokens` if the file exists and contains valid JSON
 * with the correct shape. Returns `null` if the file is missing, contains
 * malformed JSON, or has an invalid shape. Logs the reason to stderr for
 * diagnostics.
 */
export async function loadTokens(tokenDir?: string): Promise<OAuthTokens | null> {
  const filePath = tokenFilePath(tokenDir);
  const safePath = redactHomePath(filePath);
  try {
    const raw = await readFile(filePath, { encoding: "utf-8" });
    const parsed: unknown = JSON.parse(raw);
    if (!isValidTokenShape(parsed)) {
      console.error(`Token file ${safePath} exists but has invalid shape — ignoring.`);
      return null;
    }
    return parsed;
  } catch (error: unknown) {
    // Differentiate "file not found" (expected on first run) from real errors
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      console.error(`No token file found at ${safePath}.`);
    } else {
      const message = error instanceof Error ? error.message : "unknown error";
      console.error(`Failed to read token file at ${safePath}: ${message}`);
    }
    return null;
  }
}

/**
 * Delete the token file from disk.
 *
 * No-op if the file does not exist.
 */
export async function deleteTokens(tokenDir?: string): Promise<void> {
  try {
    await unlink(tokenFilePath(tokenDir));
  } catch (error: unknown) {
    // Ignore "file not found" — it's the expected no-op case
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}
