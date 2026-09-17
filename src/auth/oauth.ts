/**
 * OAuth2 Authorization Code flow for the WHOOP API.
 *
 * Orchestrates: build auth URL → open browser → wait for callback code
 * → exchange code for tokens → save to token store. Also handles token refresh.
 */

import type { OAuthTokens } from "./token-store.js";
import { loadTokens, saveTokens, isTokenExpired, resolveTokenDir } from "./token-store.js";
import { startCallbackServer } from "./callback-server.js";
import {
  WHOOP_AUTH_URL,
  WHOOP_TOKEN_URL,
  WHOOP_REDIRECT_URI,
  WHOOP_REQUIRED_SCOPES,
} from "../api/endpoints.js";
import { WhoopNetworkError } from "../api/client.js";
import { parseOAuthErrorCode, TokenRefreshError } from "./token-refresh-error.js";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the OAuth flow */
export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Override the default redirect URI. Default: WHOOP_REDIRECT_URI */
  redirectUri?: string;
  /** Token storage directory. Default: resolveTokenDir() (WHOOP_MCP_TOKEN_DIR, else ~/.whoop-mcp/) */
  tokenDir?: string;
  /** Callback server port. Default: 3000 */
  port?: number;
}

/** Raw token response from the WHOOP token endpoint */
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/** What a token endpoint error response says, read without logging it */
interface TokenErrorBody {
  /** error_description, or "unknown error" */
  description: string;
  /** The OAuth error code (e.g. "invalid_grant"), when present and well formed */
  oauthError: string | undefined;
}

/**
 * Read a token endpoint error response. A body that is not a JSON object
 * (unreadable, non-JSON, null or an array) yields "unknown error".
 */
async function readTokenErrorBody(response: Response): Promise<TokenErrorBody> {
  const parsed: unknown = await response.json().catch(() => null);
  const body =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return {
    description:
      typeof body.error_description === "string" ? body.error_description : "unknown error",
    oauthError: parseOAuthErrorCode(body.error),
  };
}

// ---------------------------------------------------------------------------
// buildAuthorizationUrl
// ---------------------------------------------------------------------------

/**
 * Build the WHOOP authorization URL with all required parameters.
 *
 * Constructs a properly-encoded URL that the user will be redirected to
 * in order to authorize the application.
 */
export function buildAuthorizationUrl(
  config: OAuthConfig,
  state: string,
  codeChallenge?: string
): string {
  const url = new URL(WHOOP_AUTH_URL);

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri ?? WHOOP_REDIRECT_URI);
  url.searchParams.set("scope", WHOOP_REQUIRED_SCOPES);
  url.searchParams.set("state", state);
  if (codeChallenge) {
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }

  return url.toString();
}

// ---------------------------------------------------------------------------
// exchangeCodeForTokens
// ---------------------------------------------------------------------------

/**
 * Exchange an authorization code for tokens.
 *
 * POSTs to the WHOOP token endpoint with `application/x-www-form-urlencoded`
 * body per OAuth2 spec.
 */
export async function exchangeCodeForTokens(
  code: string,
  config: OAuthConfig,
  codeVerifier?: string
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri ?? WHOOP_REDIRECT_URI,
  });
  if (codeVerifier) {
    body.set("code_verifier", codeVerifier);
  }

  const response = await fetch(WHOOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const { description } = await readTokenErrorBody(response);
    throw new Error(`Token exchange failed (${response.status}): ${description}`);
  }

  try {
    return (await response.json()) as TokenResponse;
  } catch (error) {
    // A reset, timeout or non-JSON body after WHOOP accepted the code
    throw new WhoopNetworkError(error);
  }
}

// ---------------------------------------------------------------------------
// refreshAccessToken
// ---------------------------------------------------------------------------

/**
 * Use the refresh token to obtain a new access token.
 *
 * POSTs to the WHOOP token endpoint with `grant_type=refresh_token`. A non-2xx answer
 * throws TokenRefreshError carrying the status and the OAuth `error` code
 * (invalid_grant: the refresh token is dead; invalid_client: the client
 * credentials are wrong). The response body is never logged.
 */
export async function refreshAccessToken(
  refreshToken: string,
  config: OAuthConfig
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  let response: Response;
  try {
    response = await fetch(WHOOP_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (error) {
    // fetch throws on transport-level failures (DNS, TCP, TLS) — distinct from auth failure.
    throw new WhoopNetworkError(error);
  }

  if (!response.ok) {
    const { description, oauthError } = await readTokenErrorBody(response);
    throw new TokenRefreshError(response.status, description, oauthError);
  }

  try {
    return (await response.json()) as TokenResponse;
  } catch (error) {
    // The connection dropped, timed out or returned a non-JSON body after WHOOP
    // accepted the request: a transport problem, not a rejected refresh token.
    throw new WhoopNetworkError(error);
  }
}

// ---------------------------------------------------------------------------
// toOAuthTokens
// ---------------------------------------------------------------------------

/**
 * Convert the raw TokenResponse into our OAuthTokens shape for storage.
 *
 * Computes `expires_at` (absolute epoch ms) from `expires_in` (relative seconds).
 *
 * Per RFC 6749 §6, the authorization server MAY issue a new refresh token on
 * refresh — but is not required to. If the response omits `refresh_token`,
 * pass `existingRefreshToken` to preserve the current one so the token file
 * stays valid on the next load.
 */
export function toOAuthTokens(response: TokenResponse, existingRefreshToken?: string): OAuthTokens {
  return {
    access_token: response.access_token,
    refresh_token: response.refresh_token || existingRefreshToken || "",
    expires_at: Date.now() + response.expires_in * 1000,
    token_type: response.token_type,
  };
}

// ---------------------------------------------------------------------------
// openBrowser
// ---------------------------------------------------------------------------

/**
 * Open a URL in the user's default browser.
 *
 * Uses `spawn` with argument arrays to avoid shell injection.
 * Throws if the URL is malformed or not http(s) — callers must pass a
 * trusted scheme. Otherwise best-effort: spawn errors are logged, not thrown.
 */
export function openBrowser(url: string): void {
  // Reject non-http(s) schemes (e.g. javascript:, file:, vbscript:) before spawn.
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Refusing to open browser for non-HTTP(S) URL scheme: ${parsed.protocol}`);
  }
  try {
    const commands: Record<string, [string, string[]]> = {
      darwin: ["open", [url]],
      // Pass empty title argument ("") to avoid Windows `start` parsing pitfalls.
      win32: ["cmd", ["/c", "start", '""', url]],
      linux: ["xdg-open", [url]],
    };

    const [cmd, args] = commands[process.platform] ?? ["xdg-open", [url]];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    // spawn emits 'error' asynchronously when the command can't be found
    // (e.g. running in a headless container with no xdg-open). Without a
    // handler, Node treats this as an unhandled error and crashes the process.
    child.on("error", () => {
      console.error(
        `\nCould not open browser automatically. Please open this URL manually:\n${url}\n`
      );
    });
    child.unref();
  } catch {
    // Best-effort — log the URL for manual copy/paste
    console.error(
      `\nCould not open browser automatically. Please open this URL manually:\n${url}\n`
    );
  }
}

// ---------------------------------------------------------------------------
// authenticate
// ---------------------------------------------------------------------------

/** Options for {@link authenticate} */
export interface AuthenticateOptions {
  /**
   * Receives the token set authenticate() settled on (cached, refreshed or
   * newly authorized), so the caller can keep it in memory. WHOOP rotates
   * refresh tokens: when saving to disk fails, this is the only copy.
   */
  onTokens?: (tokens: OAuthTokens) => void;
}

/**
 * Save tokens after WHOOP issued them, tolerating a failed save.
 *
 * WHOOP has already invalidated the previous refresh token at this point, so a
 * save failure must not discard the new tokens. The failure is logged by error
 * code only (never the path or token values).
 */
async function saveIssuedTokens(tokens: OAuthTokens, tokenDir: string | undefined): Promise<void> {
  try {
    await saveTokens(tokens, tokenDir);
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "unknown";
    console.error(
      `Could not save the new WHOOP tokens (${code}); they are kept in memory for this run only.`
    );
  }
}

/**
 * Main entry point. Returns a valid access token.
 *
 * - If valid (non-expired) tokens exist on disk → returns `access_token`
 * - If tokens exist but are expired → refreshes and returns new `access_token`
 * - If no tokens or WHOOP rejects the refresh token (invalid_grant) → starts
 *   full OAuth flow
 * - If the refresh cannot reach WHOOP (WhoopNetworkError), or WHOOP answers
 *   429/5xx or rejects the client credentials (invalid_client) → rethrows, so
 *   the caller can retry: signing in again would not help, and on a hosted
 *   server nobody is there to complete it
 *
 * A failure to save refreshed tokens does not start the OAuth flow: the new
 * tokens are returned (and passed to `options.onTokens`) anyway.
 */
export async function authenticate(
  config: OAuthConfig,
  options: AuthenticateOptions = {}
): Promise<string> {
  // Validate required credentials
  if (!config.clientId) {
    throw new Error("Missing WHOOP_CLIENT_ID. Set it in your environment variables.");
  }
  if (!config.clientSecret) {
    throw new Error("Missing WHOOP_CLIENT_SECRET. Set it in your environment variables.");
  }

  // Resolved once, so a relative WHOOP_MCP_TOKEN_DIR fails here with guidance
  // and every read and write of this run uses the same folder.
  const tokenDir = resolveTokenDir(config.tokenDir);

  // 1. Check for existing tokens
  const existing = await loadTokens(tokenDir);

  if (existing) {
    // 2a. If valid, return immediately
    if (!isTokenExpired(existing)) {
      console.error("Using cached WHOOP tokens (not expired).");
      options.onTokens?.(existing);
      return existing.access_token;
    }

    // 2b. If expired, try to refresh
    console.error("Cached tokens expired, attempting refresh...");
    let refreshed: TokenResponse | undefined;
    try {
      refreshed = await refreshAccessToken(existing.refresh_token, config);
    } catch (error: unknown) {
      // Network failures, transient 429/5xx answers and rejected client
      // credentials leave the stored sign-in valid: never force a fresh OAuth
      // flow for them — let the caller retry.
      if (
        error instanceof WhoopNetworkError ||
        (error instanceof TokenRefreshError && !error.rejected)
      ) {
        throw error;
      }
      // Log the refresh failure so it's diagnosable (status and OAuth error code
      // only, never the response body), then fall through to full OAuth flow
      console.error(
        `Token refresh failed (${describeRefreshFailure(error)}), starting full OAuth flow.`
      );
    }
    if (refreshed !== undefined) {
      // Outside the try above: the refresh token is already rotated, so a save
      // failure must never fall through to a full OAuth flow.
      const tokens = toOAuthTokens(refreshed, existing.refresh_token);
      options.onTokens?.(tokens);
      await saveIssuedTokens(tokens, tokenDir);
      console.error("Token refresh successful.");
      return tokens.access_token;
    }
  } else {
    console.error("No cached tokens found, starting OAuth flow...");
  }

  // 3. Full OAuth flow
  const tokens = await performOAuthFlow(config, tokenDir);
  options.onTokens?.(tokens);
  return tokens.access_token;
}

/** A refresh failure for logs: HTTP status and OAuth error code, or the error class */
function describeRefreshFailure(error: unknown): string {
  if (error instanceof TokenRefreshError) {
    return error.oauthError === undefined
      ? `HTTP ${error.statusCode}`
      : `HTTP ${error.statusCode} ${error.oauthError}`;
  }
  return error instanceof Error ? error.name : "unknown error";
}

/**
 * Run the full OAuth Authorization Code flow:
 * start callback server → open browser → wait for code → exchange → save.
 */
async function performOAuthFlow(config: OAuthConfig, tokenDir: string): Promise<OAuthTokens> {
  const state = randomBytes(16).toString("hex");
  const pkce = generatePkcePair();
  const port = config.port ?? 3000;

  // Start the callback server before opening the browser
  const callbackHandle = startCallbackServer({
    port,
    expectedState: state,
    timeoutMs: process.env.CALLBACK_TIMEOUT_MS
      ? Number(process.env.CALLBACK_TIMEOUT_MS)
      : undefined,
  });

  // Build the authorization URL and open the browser
  const authUrl = buildAuthorizationUrl(config, state, pkce.codeChallenge);
  openBrowser(authUrl);

  console.error(
    `\nWaiting for WHOOP authorization...\nIf the browser didn't open, visit:\n${authUrl}\n`
  );

  // Wait for the callback
  const { code } = await callbackHandle.result;

  // Exchange the code for tokens
  const tokenResponse = await exchangeCodeForTokens(code, config, pkce.codeVerifier);
  const tokens = toOAuthTokens(tokenResponse);
  await saveIssuedTokens(tokens, tokenDir);

  return tokens;
}

function generatePkcePair(): PkcePair {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}
