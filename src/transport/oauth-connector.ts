/**
 * OAuth 2.1 connector provider for claude.ai web/mobile (Task 13c).
 *
 * Implements the SDK's `OAuthServerProvider` interface. The connector lets
 * claude.ai web/mobile clients authenticate to the MCP server via OAuth 2.1
 * + PKCE S256, with a connector password as the user-facing credential.
 *
 * Architecture:
 * - One static OAuth client (MCP_OAUTH_CLIENT_ID) plus stateless dynamic client
 *   registration: a registered client id is a signed, self-describing token
 *   (redirect URIs, name, public or confidential, a random per-registration
 *   nonce), and a confidential client's
 *   secret is derived from its id. Nothing is stored, so registrations survive
 *   restarts and redeploys; the connector password still gates /authorize.
 * - Authorization codes stored in-memory with 60s TTL, one-time use.
 * - Access/refresh tokens are signed JWTs (HS256, HKDF-derived key) that always
 *   carry the single scope "mcp" and, when the client sent one, the resource
 *   indicator (the /mcp URL or the bare origin of PUBLIC_URL).
 * - redirect_uri is validated as exact string match against the allowlist
 *   on registration, `/authorize` and `/token`.
 *
 * Rotating the JWT key (MCP_AUTH_TOKEN without a fixed MCP_JWT_SECRET) revokes
 * every OAuth session and every registered client id. Consumed refresh-token
 * ids are remembered in memory only (see UsedJtiStore).
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import express, { type Request, type Response, type NextFunction } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  CustomOAuthError,
  InvalidClientError,
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import {
  AuthCodeStore,
  CONNECTOR_SCOPE,
  UsedJtiStore,
  generateAuthCode,
  generateJti,
  isAcceptedResource,
  isAllowedRedirectUri,
  mcpResourceUrls,
  normalizeResource,
  redirectUriOrigins,
  validateConnectorPassword,
  type McpResourceUrls,
} from "./oauth-helpers.js";
import {
  signToken,
  verifyToken,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  type VerifyResult,
} from "./oauth-jwt.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Prefix of dynamically registered client ids. */
export const DCR_CLIENT_ID_PREFIX = "dcr.";

/** HMAC domain of registered client ids. */
const DCR_ID_DOMAIN = "dcr-v1|";

/** HMAC domain of confidential clients' secrets. */
const DCR_SECRET_DOMAIN = "dcr-secret-v1|";

/** Longest client_name kept in a registered client id. */
export const DCR_MAX_CLIENT_NAME_LENGTH = 64;

/** Longest client id examined (anything longer is unknown). */
export const MAX_CLIENT_ID_LENGTH = 4096;

/** Largest accepted /register request body. */
export const REGISTER_MAX_BODY_BYTES = 2048;

/** Registrations accepted per IP per minute. */
export const REGISTER_RATE_LIMIT_PER_MINUTE = 10;

/** Name advertised in the protected resource metadata. */
export const RESOURCE_NAME = "WHOOP MCP";

const ALLOWED_GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);
const ALLOWED_RESPONSE_TYPES = new Set(["code"]);

// ---------------------------------------------------------------------------
// Client store: the static connector client plus stateless DCR clients
// ---------------------------------------------------------------------------

export interface ConnectorClientConfig {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  clientName?: string;
}

/** Decoded payload of a registered client id. */
const dcrPayloadSchema = z
  .object({
    /** Sorted, unique redirect URIs. */
    r: z.array(z.string().min(1).max(2048)).min(1).max(32),
    /** client_name, at most DCR_MAX_CLIENT_NAME_LENGTH characters. */
    n: z.string().max(DCR_MAX_CLIENT_NAME_LENGTH).optional(),
    /** Token endpoint auth: 'n' none (public), 'p' client_secret_post (confidential). */
    m: z.enum(["n", "p"]),
    /**
     * Per-registration nonce (16 random bytes, base64url), so two registrations
     * with the same metadata never share a client id or secret.
     */
    i: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  })
  .strict();

type DcrPayload = z.infer<typeof dcrPayloadSchema>;

function hmac(secret: Uint8Array, data: string): Buffer {
  return createHmac("sha256", secret).update(data, "utf8").digest();
}

/**
 * Client store for the connector: the static client configured at startup and
 * clients registered through /register.
 *
 * Registration stores nothing. The client id is
 * `dcr.<base64url(JSON {r, n?, m, i})>.<base64url(HMAC-SHA256(key, 'dcr-v1|' + payload))>`
 * and a confidential client's secret is
 * `base64url(HMAC-SHA256(key, 'dcr-secret-v1|' + client_id))`, so any process
 * with the same JWT key recognizes the client. `i` is a random nonce, so every
 * registration gets its own id and secret even for identical metadata: one
 * registrant cannot learn another's secret, or use another's refresh token, by
 * registering the same body. Redirect URIs are checked
 * against ALLOWED_REDIRECT_URIS on registration and again on every lookup, so
 * narrowing the allowlist disables clients registered with removed URIs.
 */
export class SignedClientsStore implements OAuthRegisteredClientsStore {
  private readonly staticClient: OAuthClientInformationFull;

  constructor(
    config: ConnectorClientConfig,
    private readonly allowedRedirectUris: readonly string[],
    private readonly secret: Uint8Array
  ) {
    this.staticClient = {
      client_id: config.clientId,
      redirect_uris: config.redirectUris,
      ...(config.clientSecret !== undefined && { client_secret: config.clientSecret }),
      ...(config.clientName !== undefined && { client_name: config.clientName }),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    if (clientId === this.staticClient.client_id) return this.staticClient;
    if (!clientId.startsWith(DCR_CLIENT_ID_PREFIX) || clientId.length > MAX_CLIENT_ID_LENGTH) {
      return undefined;
    }
    const payload = this.verifyClientId(clientId);
    if (payload === null) return undefined;
    if (!payload.r.every((uri) => isAllowedRedirectUri(uri, this.allowedRedirectUris))) {
      return undefined;
    }
    return this.clientInformation(clientId, payload);
  }

  registerClient(
    clientInfo: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">
  ): OAuthClientInformationFull {
    const redirectUris = [...new Set(clientInfo.redirect_uris)].sort();
    if (
      redirectUris.length === 0 ||
      !redirectUris.every((uri) => isAllowedRedirectUri(uri, this.allowedRedirectUris))
    ) {
      throw new CustomOAuthError(
        "invalid_redirect_uri",
        "Every redirect_uri must be listed in the server's ALLOWED_REDIRECT_URIS."
      );
    }
    if (clientInfo.grant_types?.some((grant) => !ALLOWED_GRANT_TYPES.has(grant))) {
      throw new InvalidClientMetadataError(
        "grant_types may only contain authorization_code and refresh_token."
      );
    }
    if (clientInfo.response_types?.some((type) => !ALLOWED_RESPONSE_TYPES.has(type))) {
      throw new InvalidClientMetadataError("response_types may only contain code.");
    }
    const method = clientInfo.token_endpoint_auth_method;
    let mode: DcrPayload["m"];
    if (method === "none") {
      mode = "n";
    } else if (method === undefined || method === "client_secret_post") {
      mode = "p";
    } else {
      throw new InvalidClientMetadataError(
        "token_endpoint_auth_method must be none or client_secret_post."
      );
    }

    const payload: DcrPayload = {
      r: redirectUris,
      m: mode,
      i: randomBytes(16).toString("base64url"),
    };
    const name = clientInfo.client_name?.slice(0, DCR_MAX_CLIENT_NAME_LENGTH);
    if (name !== undefined && name.length > 0) payload.n = name;
    if (!dcrPayloadSchema.safeParse(payload).success) {
      throw new InvalidClientMetadataError("Too many or too long redirect_uris.");
    }

    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const mac = hmac(this.secret, DCR_ID_DOMAIN + encoded).toString("base64url");
    const clientId = `${DCR_CLIENT_ID_PREFIX}${encoded}.${mac}`;
    if (clientId.length > MAX_CLIENT_ID_LENGTH) {
      throw new InvalidClientMetadataError("Too many or too long redirect_uris.");
    }
    return {
      ...this.clientInformation(clientId, payload),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
  }

  /** The payload of a registered client id whose MAC verifies, or null. */
  private verifyClientId(clientId: string): DcrPayload | null {
    const parts = clientId.slice(DCR_CLIENT_ID_PREFIX.length).split(".");
    if (parts.length !== 2) return null;
    const [encoded, providedMac] = parts as [string, string];
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]{43}$/.test(providedMac)) {
      return null;
    }
    const expected = hmac(this.secret, DCR_ID_DOMAIN + encoded);
    const provided = Buffer.from(providedMac, "base64url");
    // Only the canonical encoding is accepted: the last base64url character
    // carries unused bits, so other spellings of the same MAC (or payload)
    // would otherwise be distinct client ids for one registration.
    if (
      provided.length !== expected.length ||
      provided.toString("base64url") !== providedMac ||
      !timingSafeEqual(provided, expected)
    ) {
      return null;
    }
    const payloadBytes = Buffer.from(encoded, "base64url");
    if (payloadBytes.toString("base64url") !== encoded) return null;
    try {
      const parsed = dcrPayloadSchema.safeParse(JSON.parse(payloadBytes.toString("utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private clientInformation(clientId: string, payload: DcrPayload): OAuthClientInformationFull {
    const client: OAuthClientInformationFull = {
      client_id: clientId,
      redirect_uris: payload.r,
      ...(payload.n !== undefined && { client_name: payload.n }),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: CONNECTOR_SCOPE,
      token_endpoint_auth_method: payload.m === "n" ? "none" : "client_secret_post",
    };
    if (payload.m === "p") {
      client.client_secret = hmac(this.secret, DCR_SECRET_DOMAIN + clientId).toString("base64url");
      client.client_secret_expires_at = 0;
    }
    return client;
  }
}

// ---------------------------------------------------------------------------
// Provider options
// ---------------------------------------------------------------------------

export interface OAuthConnectorOptions {
  /** Static client config (single pre-configured claude.ai connector) */
  client: ConnectorClientConfig;
  /** Allowed redirect URIs (exact match) */
  allowedRedirectUris: string[];
  /** JWT signing key (32 bytes) — derived via HKDF or set explicitly */
  jwtSecret: Uint8Array;
  /**
   * Public https:// origin of the server (PUBLIC_URL). Resource indicators must
   * name `${origin}/mcp` or the origin itself.
   */
  publicUrl: string;
  /** Auth code store (injectable for tests) */
  authCodeStore?: AuthCodeStore;
  /** Consumed-jti store for refresh-token rotation reuse detection */
  usedJtiStore?: UsedJtiStore;
}

// ---------------------------------------------------------------------------
// OAuthConnectorProvider
// ---------------------------------------------------------------------------

export class OAuthConnectorProvider implements OAuthServerProvider {
  private readonly _clientsStore: SignedClientsStore;
  private readonly _authCodes: AuthCodeStore;
  private readonly _usedJtis: UsedJtiStore;
  private readonly _allowedRedirectUris: string[];
  private readonly _jwtSecret: Uint8Array;
  private readonly _resourceUrls: McpResourceUrls;

  constructor(options: OAuthConnectorOptions) {
    this._resourceUrls = mcpResourceUrls(options.publicUrl);
    this._clientsStore = new SignedClientsStore(
      options.client,
      options.allowedRedirectUris,
      options.jwtSecret
    );
    this._authCodes = options.authCodeStore ?? new AuthCodeStore();
    this._usedJtis = options.usedJtiStore ?? new UsedJtiStore();
    this._allowedRedirectUris = options.allowedRedirectUris;
    this._jwtSecret = options.jwtSecret;
  }

  get clientsStore(): SignedClientsStore {
    return this._clientsStore;
  }

  /** The resource URLs this provider binds tokens to. */
  get resourceUrls(): McpResourceUrls {
    return this._resourceUrls;
  }

  /**
   * Begin authorization. The SDK has already validated `client_id`, `state`,
   * `code_challenge`, and `code_challenge_method=S256` before reaching here.
   *
   * We additionally enforce that `redirect_uri` exactly matches our allowlist
   * (the SDK's check is against the client's registered URIs, but we want a
   * second layer using `ALLOWED_REDIRECT_URIS` for defense in depth), and that
   * a resource indicator names this server.
   *
   * The requested scope is ignored: the connector always grants "mcp". (The SDK
   * passes [] when no scope was sent, and claude.ai may request "claudeai".)
   *
   * Note: the password prompt UI is implemented separately as a route that
   * sits in front of the SDK's authorize handler; by the time we get here,
   * password verification has already passed (or this is being called by a
   * trusted internal flow).
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    // Enforce PKCE S256 (defense in depth — SDK already enforces this in the
    // schema, but we make the contract explicit here)
    if (!params.codeChallenge) {
      throw new InvalidRequestError("PKCE code_challenge is required");
    }

    // Validate redirect_uri against our allowlist
    if (!isAllowedRedirectUri(params.redirectUri, this._allowedRedirectUris)) {
      throw new InvalidRequestError("redirect_uri not in ALLOWED_REDIRECT_URIS");
    }

    if (params.resource !== undefined && !isAcceptedResource(params.resource, this._resourceUrls)) {
      throw new InvalidTargetError("The resource indicator does not name this MCP server.");
    }

    // Generate a one-time authorization code
    const code = generateAuthCode();
    this._authCodes.store(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: "S256",
      redirectUri: params.redirectUri,
      state: params.state ?? "",
      scopes: [CONNECTOR_SCOPE],
      ...(params.resource !== undefined && { resource: params.resource.href }),
    });

    // Build redirect URL with code (and state if provided)
    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (params.state) {
      redirectUrl.searchParams.set("state", params.state);
    }

    res.redirect(redirectUrl.toString());
  }

  /**
   * Return the codeChallenge stored when the authorization began.
   * Used by the SDK's PKCE verifier check.
   */
  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const record = this._authCodes.peek(authorizationCode);
    if (!record) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return record.codeChallenge;
  }

  /**
   * Exchange an authorization code for access + refresh tokens.
   * Marks the code as consumed (replay protection).
   */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const record = this._authCodes.consume(authorizationCode);
    if (!record) {
      throw new InvalidGrantError("Invalid, expired, or already-consumed authorization code");
    }

    // redirect_uri must exactly match what was used in /authorize AND must be
    // in our allowlist
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the value used during /authorize");
    }
    if (!isAllowedRedirectUri(record.redirectUri, this._allowedRedirectUris)) {
      throw new InvalidGrantError("redirect_uri not in allowlist");
    }

    // Code must belong to the requesting client
    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError("Authorization code was issued to a different client");
    }

    // A resource sent to /token must name this server and, when /authorize
    // already bound one, the same resource.
    let boundResource = record.resource;
    if (resource !== undefined) {
      if (!isAcceptedResource(resource, this._resourceUrls)) {
        throw new InvalidTargetError("The resource indicator does not name this MCP server.");
      }
      if (
        boundResource !== undefined &&
        normalizeResource(resource.href) !== normalizeResource(boundResource)
      ) {
        throw new InvalidTargetError("resource indicator does not match the authorization request");
      }
      boundResource ??= resource.href;
    }

    return this._issueTokens(client.client_id, boundResource);
  }

  /**
   * Exchange a refresh token for a new access token (and rotated refresh).
   * Requested scopes are ignored: the new tokens always carry "mcp" (a refresh
   * token issued with no scope counts as "mcp").
   */
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    let verified: VerifyResult;
    try {
      verified = await verifyToken(refreshToken, this._jwtSecret);
    } catch {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }

    if (verified.type !== "refresh") {
      throw new InvalidGrantError("Token is not a refresh token");
    }
    if (verified.clientId !== client.client_id) {
      throw new InvalidGrantError("Refresh token was issued to a different client");
    }
    // The granted scopes are not checked: a token issued with no scope (or by
    // an older build with other scopes) is still a grant for this server and
    // is re-issued with "mcp".

    // Resource indicator MUST match the original grant (RFC 8707 §2.2).
    // Caller-supplied resource cannot upgrade or alter the binding.
    if (
      resource !== undefined &&
      (verified.resource === undefined ||
        normalizeResource(resource.href) !== normalizeResource(verified.resource))
    ) {
      throw new InvalidTargetError("resource indicator does not match the original grant");
    }

    // Reuse detection: refresh tokens MUST carry a jti and MUST NOT be replayed.
    // Per OAuth 2.1 §4.14 / RFC 6819 §5.2.2, a replayed refresh token signals
    // potential token theft.
    if (!verified.jti) {
      throw new InvalidGrantError("Refresh token missing jti — cannot enforce rotation");
    }
    if (this._usedJtis.has(verified.jti)) {
      throw new InvalidGrantError("Refresh token has already been used (replay detected)");
    }
    this._usedJtis.add(verified.jti, verified.expiresAt);

    return this._issueTokens(client.client_id, verified.resource);
  }

  /**
   * Verify a presented bearer token (JWT) and return AuthInfo for the request.
   * The HTTP layer additionally checks expiry, the "mcp" scope and the
   * resource binding.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let verified: VerifyResult;
    try {
      verified = await verifyToken(token, this._jwtSecret);
    } catch {
      throw new InvalidTokenError("Invalid or expired access token");
    }

    if (verified.type !== "access") {
      throw new InvalidTokenError("Token is not an access token");
    }

    const info: AuthInfo = {
      token,
      clientId: verified.clientId,
      scopes: verified.scopes,
      expiresAt: verified.expiresAt,
    };
    if (verified.resource !== undefined) {
      try {
        info.resource = new URL(verified.resource);
      } catch {
        throw new InvalidTokenError("Invalid resource claim");
      }
    }
    return info;
  }

  /**
   * Internal: shut down the auth code cleanup timer.
   * Call when stopping the server.
   */
  stop(): void {
    this._authCodes.stop();
    this._usedJtis.stop();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async _issueTokens(clientId: string, resource: string | undefined): Promise<OAuthTokens> {
    const scopes = [CONNECTOR_SCOPE];
    const accessOpts = {
      clientId,
      scopes,
      ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
      type: "access" as const,
      ...(resource !== undefined && { resource }),
    };
    // Refresh tokens always get a fresh jti so each one is uniquely revocable
    const refreshOpts = {
      clientId,
      scopes,
      ttlSeconds: REFRESH_TOKEN_TTL_SECONDS,
      type: "refresh" as const,
      jti: generateJti(),
      ...(resource !== undefined && { resource }),
    };

    const [accessToken, refreshToken] = await Promise.all([
      signToken(accessOpts, this._jwtSecret),
      signToken(refreshOpts, this._jwtSecret),
    ]);

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}

// ---------------------------------------------------------------------------
// Express app factory: password-prompt UI in front of the SDK's auth router
// ---------------------------------------------------------------------------

const HTML_FORBIDDEN = /[&<>"']/g;
const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(HTML_FORBIDDEN, (c) => HTML_ENTITIES[c] ?? c);
}

/** Constant-time password compare (hashes both sides to avoid length leak). */
function comparePassword(provided: string, expected: string): boolean {
  if (provided.length === 0 || expected.length === 0) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const AUTHORIZE_PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "resource",
] as const;

function renderPasswordPage(params: Record<string, string>, error?: string): string {
  const hidden = AUTHORIZE_PARAMS.map((k) => {
    const v = params[k];
    if (v === undefined) return "";
    return `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`;
  }).join("\n      ");

  const errorBlock = error
    ? `<p style="color:#c00;margin:0 0 12px 0;">${escapeHtml(error)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>WHOOP MCP — Authorize Connection</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f7f7f8; margin: 0; display: flex; align-items: center;
      justify-content: center; min-height: 100vh; padding: 20px; }
    .card { background: #fff; border-radius: 12px; padding: 32px; max-width: 400px;
      width: 100%; box-shadow: 0 1px 3px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.04); }
    h1 { font-size: 18px; margin: 0 0 8px 0; }
    p { color: #555; font-size: 14px; line-height: 1.5; margin: 0 0 16px 0; }
    label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; }
    input[type=password] { width: 100%; padding: 10px 12px; border: 1px solid #ddd;
      border-radius: 6px; font-size: 14px; box-sizing: border-box; }
    button { margin-top: 16px; width: 100%; padding: 10px; border: 0;
      border-radius: 6px; background: #111; color: #fff; font-size: 14px;
      font-weight: 500; cursor: pointer; }
    button:hover { background: #333; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize WHOOP MCP connection</h1>
    <p>Enter the connector password to grant this client access to your WHOOP data.</p>
    ${errorBlock}
    <form method="POST" action="/authorize" autocomplete="off">
      ${hidden}
      <label for="connector_password">Connector password</label>
      <input id="connector_password" name="connector_password" type="password"
             required autofocus>
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`;
}

/**
 * The authorize page's Content-Security-Policy. form-action allows the page's
 * own origin plus the allowlisted redirect origins, because browsers apply
 * form-action to the redirect that follows the form POST.
 */
export function authorizePageCsp(allowedRedirectUris: readonly string[]): string {
  const formAction = ["'self'", ...redirectUriOrigins(allowedRedirectUris)].join(" ");
  return `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`;
}

/** Apply anti-clickjacking + tight CSP headers to the password-prompt response. */
function applyAuthorizePageHeaders(res: Response, csp: string): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

/** A JSON OAuth error response (never an HTML page or a stack trace). */
function sendOAuthError(res: Response, status: number, error: string, description: string): void {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json({ error, error_description: description });
}

/** The status of an Express/body-parser error, or 500. */
function errorStatus(err: unknown): number {
  if (typeof err === "object" && err !== null) {
    const status =
      (err as { status?: unknown; statusCode?: unknown }).status ??
      (err as { statusCode?: unknown }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 600) return status;
  }
  return 500;
}

export interface CreateOAuthAppOptions {
  /** Plain-text connector password (validated; must be ≥12 chars) */
  connectorPassword: string;
  /** Public origin (must be https://) — used as OAuth issuer */
  publicUrl: string;
  /** Allowed redirect URIs (exact match) */
  allowedRedirectUris: string[];
  /** JWT signing secret (32 bytes from HKDF or MCP_JWT_SECRET) */
  jwtSecret: Uint8Array;
  /** Static client config */
  client: ConnectorClientConfig;
  /**
   * Configures Express's `trust proxy` setting so `express-rate-limit` and
   * `req.ip` reflect the real client IP behind a reverse proxy. Pass a number
   * of trusted hops (recommended) or a CIDR/IP string. Defaults to `false`
   * (no proxy trust) for safe local-dev behaviour.
   */
  trustProxy?: boolean | number | string | string[];
  /** Pre-built provider (for tests) — overrides internal construction */
  provider?: OAuthConnectorProvider;
}

export interface CreateOAuthAppResult {
  app: express.Express;
  provider: OAuthConnectorProvider;
  /** The resource URLs advertised and enforced for /mcp. */
  resourceUrls: McpResourceUrls;
  /** Stops periodic timers (auth code cleanup) */
  close: () => void;
}

/**
 * Build an Express app exposing the OAuth 2.1 connector endpoints:
 *   GET  /authorize       — password prompt page
 *   POST /authorize       — password verification → SDK authorize handler
 *   POST /token           — SDK token handler (PKCE-verified)
 *   POST /register        — stateless dynamic client registration
 *   GET  /.well-known/oauth-authorization-server  — metadata
 *   GET  /.well-known/oauth-protected-resource/mcp — protected resource metadata
 *   GET  /.well-known/oauth-protected-resource     — the same document
 *
 * Caller is responsible for mounting on an HTTP server and adding /mcp routes.
 *
 * @throws Error if connectorPassword is too short or publicUrl isn't https://
 */
export function createOAuthApp(options: CreateOAuthAppOptions): CreateOAuthAppResult {
  // Startup validation — fail fast on misconfiguration
  validateConnectorPassword(options.connectorPassword);
  const resourceUrls = mcpResourceUrls(options.publicUrl);
  const publicUrl = new URL(options.publicUrl);

  const provider =
    options.provider ??
    new OAuthConnectorProvider({
      client: options.client,
      allowedRedirectUris: options.allowedRedirectUris,
      jwtSecret: options.jwtSecret,
      publicUrl: options.publicUrl,
    });
  const csp = authorizePageCsp(options.allowedRedirectUris);

  const app = express();
  app.disable("x-powered-by");
  if (options.trustProxy !== undefined) {
    app.set("trust proxy", options.trustProxy);
  }

  // Body parser for the password form (also used downstream by SDK)
  const formParser = express.urlencoded({ extended: false });

  // Per-endpoint rate limits (override the SDK's built-in rate limiting)
  const authorizeLimiter = rateLimit({
    windowMs: 60_000,
    limit: 3,
    standardHeaders: true,
    legacyHeaders: false,
  });
  const tokenLimiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
  });
  const registerLimiter = rateLimit({
    windowMs: 60_000,
    limit: REGISTER_RATE_LIMIT_PER_MINUTE,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: "too_many_requests",
      error_description: "Too many client registrations; retry in a minute.",
    },
  });

  /**
   * Check client_id and redirect_uri before showing or accepting the password
   * form, as the SDK authorize handler does, so no form is rendered for an
   * unknown client or an unregistered redirect.
   */
  const validateAuthorizeClient = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const source = (req.method === "POST" ? req.body : req.query) as Record<string, unknown>;
    const clientId = source?.client_id;
    const redirectUri = source?.redirect_uri;
    const client =
      typeof clientId === "string" ? await provider.clientsStore.getClient(clientId) : undefined;
    if (!client) {
      const error = new InvalidClientError("Invalid client_id");
      sendOAuthError(res, 400, error.errorCode, error.message);
      return;
    }
    if (redirectUri !== undefined) {
      if (
        typeof redirectUri !== "string" ||
        !client.redirect_uris.some((registered) => redirectUriMatches(redirectUri, registered))
      ) {
        sendOAuthError(res, 400, "invalid_request", "Unregistered redirect_uri");
        return;
      }
    } else if (client.redirect_uris.length !== 1) {
      sendOAuthError(
        res,
        400,
        "invalid_request",
        "redirect_uri must be specified when client has multiple registered URIs"
      );
      return;
    }
    next();
  };

  // GET /authorize — render password prompt with OAuth params as hidden fields
  app.get(
    "/authorize",
    authorizeLimiter,
    validateAuthorizeClient,
    (req: Request, res: Response) => {
      const params: Record<string, string> = {};
      for (const k of AUTHORIZE_PARAMS) {
        const v = req.query[k];
        if (typeof v === "string") params[k] = v;
      }
      applyAuthorizePageHeaders(res, csp);
      res.status(200).send(renderPasswordPage(params));
    }
  );

  // POST /authorize — verify password, then forward to SDK authorize handler
  app.post(
    "/authorize",
    authorizeLimiter,
    formParser,
    validateAuthorizeClient,
    (req: Request, res: Response, next: NextFunction) => {
      const body = req.body as Record<string, unknown>;
      const provided = typeof body.connector_password === "string" ? body.connector_password : "";

      if (!comparePassword(provided, options.connectorPassword)) {
        const params: Record<string, string> = {};
        for (const k of AUTHORIZE_PARAMS) {
          const v = body[k];
          if (typeof v === "string") params[k] = v;
        }
        applyAuthorizePageHeaders(res, csp);
        res.status(401).send(renderPasswordPage(params, "Incorrect password. Try again."));
        return;
      }

      // Strip the password before forwarding so it never reaches downstream logs
      delete body.connector_password;
      next();
    }
  );

  // Apply a separate token rate limit before the SDK router handles /token
  app.post("/token", tokenLimiter);

  // POST /register — per-IP limit and a small JSON body, parsed here so the
  // SDK's own (100 KB) JSON parser never reads a larger one.
  app.post("/register", registerLimiter, express.json({ limit: REGISTER_MAX_BODY_BYTES }));
  app.use("/register", (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const status = errorStatus(err);
    if (status === 413) {
      sendOAuthError(res, 413, "invalid_request", "Registration request body too large.");
    } else if (status === 400) {
      sendOAuthError(res, 400, "invalid_client_metadata", "Registration body is not valid JSON.");
    } else {
      next(err);
    }
  });

  // SDK auth router: handles /authorize (POST forwarded), /token, /register,
  // metadata endpoints. Disable its own rate limiting since we set our own.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: publicUrl,
      resourceServerUrl: new URL(resourceUrls.canonicalResource),
      scopesSupported: [CONNECTOR_SCOPE],
      resourceName: RESOURCE_NAME,
      authorizationOptions: { rateLimit: false },
      tokenOptions: { rateLimit: false },
      clientRegistrationOptions: { rateLimit: false },
    })
  );

  // SDK 1.30 serves the protected resource metadata only at the path-specific
  // URL (/.well-known/oauth-protected-resource/mcp). Serve the identical
  // document at the root URL for clients that look there. Mounted after the
  // SDK router, so the /mcp path is still answered by the SDK.
  const protectedResourceMetadata: OAuthProtectedResourceMetadata = {
    resource: new URL(resourceUrls.canonicalResource).href,
    authorization_servers: [publicUrl.href],
    scopes_supported: [CONNECTOR_SCOPE],
    resource_name: RESOURCE_NAME,
  };
  app.use("/.well-known/oauth-protected-resource", metadataHandler(protectedResourceMetadata));

  // Any other error (e.g. an unparseable form body): a JSON error without
  // details, never Express's default HTML page with a stack trace.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status = errorStatus(err);
    if (status >= 500) {
      sendOAuthError(res, 500, "server_error", "Internal Server Error");
    } else {
      sendOAuthError(res, status, "invalid_request", "The request could not be processed.");
    }
  });

  return {
    app,
    provider,
    resourceUrls,
    close: () => provider.stop(),
  };
}
