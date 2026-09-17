/**
 * HTTP transport for the WHOOP MCP server.
 *
 * Provides bearer-token authenticated HTTP access to the MCP server
 * using the SDK's StreamableHTTPServerTransport.
 *
 * Routes, in matching order:
 * - POST /webhooks/whoop: WHOOP webhooks (only when `webhooks` is configured;
 *   signature-verified, no bearer token, own per-IP limit)
 * - OPTIONS: CORS preflight
 * - GET /health: public {status} or, with a valid bearer token, runtime status
 * - /authorize, /token, /register, /.well-known/*: the OAuth connector app
 * - /mcp: MCP over HTTP, with the static MCP_AUTH_TOKEN or a connector access
 *   token (checked by `authenticateBearer`)
 *
 * Every /mcp response carries X-Request-Id and one access log line (method,
 * tool name, status, duration, auth kind), never bodies, arguments or tokens.
 *
 * All logging goes to stderr — stdout is reserved for stdio MCP channel.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import type { Logger } from "../logging/logger.js";
import { stackFramesOf } from "../logging/tool-events.js";
import { packageVersion, readCommit, type RuntimeStatus } from "../runtime-status.js";
import { CONNECTOR_SCOPE, isAcceptedResource } from "./oauth-helpers.js";
import { DEFAULT_MAX_CONNECTIONS } from "./port-config.js";
import {
  createWhoopWebhookHandler,
  WEBHOOK_PATH,
  WEBHOOK_RATE_LIMIT_PER_MINUTE,
  type WhoopWebhookOptions,
} from "./webhooks.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Requests that may wait for a free slot. */
export const DEFAULT_QUEUE_MAX = 32;

/** How long a request waits for a free slot before 503. */
export const DEFAULT_QUEUE_TIMEOUT_MS = 5_000;

/** Failed bearer-token verifications allowed per IP per window before 429. */
export const AUTH_FAILURES_PER_WINDOW = 20;

/** Window of the per-IP failure and webhook counters. */
export const RATE_WINDOW_MS = 60_000;

/** Longest bearer token examined. */
export const MAX_BEARER_TOKEN_LENGTH = 4096;

/** AuthInfo.clientId of requests authenticated with the static MCP_AUTH_TOKEN. */
export const STATIC_BEARER_CLIENT_ID = "static-bearer";

/** Largest /mcp request body. */
const MAX_MCP_BODY_BYTES = 1024 * 1024;

/** Per-IP counters kept before expired windows are pruned. */
const MAX_TRACKED_IPS = 10_000;

/** Tool names written to the access log. */
const LOGGED_TOOL_NAME = /^[a-z_]{1,64}$/;

/** JSON-RPC method names written to the access log. */
const LOGGED_RPC_METHOD = /^[A-Za-z0-9_/.-]{1,64}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How a /mcp request authenticated. */
export interface McpAuthContext {
  kind: "static" | "oauth";
  /** STATIC_BEARER_CLIENT_ID, or the OAuth client id of the access token. */
  clientId: string;
}

/** The request a per-request MCP server is created for. */
export interface McpRequestContext {
  requestId: string;
  auth: McpAuthContext;
}

export interface HttpServerOptions {
  /** Bearer token required for /mcp routes */
  authToken: string;
  /** Port to listen on (0 = dynamic, used in tests) */
  port: number;
  /** Hostname to bind to (default: 0.0.0.0) */
  host?: string;
  /**
   * MCP requests handled at once (default 16). Further requests wait in a FIFO
   * queue; 0 rejects every request with 503.
   */
  maxConnections?: number;
  /**
   * Queue for requests beyond maxConnections: at most `max` waiting (default
   * 32), each for at most `timeoutMs` (default 5000) before 503 with
   * Retry-After: 1. A full queue answers 503 immediately.
   */
  queue?: { max?: number; timeoutMs?: number };
  /** Allowed CORS origins (default: deny all) */
  allowedOrigins?: string[];
  /** Whether to trust proxy headers (default: false) */
  trustProxy?: boolean;
  /**
   * Optional async probe used by GET /health (with valid bearer) to report
   * upstream WHOOP API status. Resolves true if reachable, false otherwise.
   * Probe failures are caught and reported as `whoopApi: "error"`.
   */
  healthCheck?: () => Promise<boolean>;
  /**
   * Optional handler for OAuth-related routes. When provided, requests whose
   * pathname starts with `/authorize`, `/token`, `/register`, or
   * `/.well-known/` are forwarded to it (typically an Express app from
   * `createOAuthApp`). Allows the connector + MCP transport to share a port.
   */
  oauthHandler?: (req: IncomingMessage, res: ServerResponse) => void;
  /**
   * Per-IP rate limit for /mcp (default: 100 requests / 60s window).
   * Set both to 0 to disable.
   */
  mcpRateLimit?: { windowMs: number; max: number };
  /**
   * SSE re-validation interval in ms (default: 5 * 60 * 1000 = 5 min).
   * Active /mcp GET (SSE) connections whose bearer token no longer matches
   * are terminated. Set to 0 to disable.
   */
  sseReauthIntervalMs?: number;
  /**
   * Optional bearer-token validator used by the SSE re-auth sweep. Defaults
   * to the static token or a token accepted through `authenticateBearer`. A
   * rejected promise ends the connection.
   */
  validateBearerToken?: (token: string) => boolean | Promise<boolean>;
  /**
   * Verifies a bearer token that is not the static MCP_AUTH_TOKEN (OAuth
   * connector access tokens). Resolve null (or reject) for an invalid token.
   * An accepted token must carry a numeric future `expiresAt`, the "mcp"
   * scope and, when it names a resource, `canonicalResource` or its origin.
   */
  authenticateBearer?: (token: string) => Promise<AuthInfo | null>;
  /**
   * Protected resource metadata URL. When set, a 401 from /mcp is
   * {error: 'invalid_token'} with a WWW-Authenticate header pointing clients
   * to it (OAuth discovery).
   */
  resourceMetadataUrl?: string;
  /** This server's resource identifier (`${PUBLIC_URL}/mcp`). */
  canonicalResource?: string;
  /**
   * Factory for a fresh MCP server. When provided, /mcp runs statelessly:
   * every POST gets its own server + transport pair, so any number of clients
   * can connect and reconnect, and a redeploy never strands a session. GET and
   * DELETE return 405 (no standalone SSE stream, no sessions to terminate).
   *
   * Without it, callers connect a single server to the returned `transport`,
   * which accepts exactly one `initialize` for the lifetime of the process —
   * every later client is rejected with "Server already initialized".
   */
  createMcpServer?: (ctx: McpRequestContext) => McpServer;
  /** Process status reported by authenticated /health. */
  runtimeStatus?: RuntimeStatus;
  /** Access, failure and webhook logs. */
  logger?: Logger;
  /** Enables POST /webhooks/whoop. */
  webhooks?: WhoopWebhookOptions;
}

export interface HttpServerResult {
  server: Server;
  /** Shared transport — only used when `createMcpServer` is not supplied */
  transport: StreamableHTTPServerTransport;
  /** Gracefully close the server and drain connections */
  close: () => Promise<void>;
}

export interface HealthResponse {
  status: "ok";
  uptime?: number;
  version?: string;
  /** Deployed git commit (12 hex characters), or null when unknown. */
  commit?: string | null;
  /** Upstream WHOOP API reachability — only present on authed /health */
  whoopApi?: "ok" | "error" | "unknown";
  privacyMode?: string;
  oauthConnector?: boolean;
  webhooks?: { enabled: boolean; lastEventAt: string | null };
  whoopAuth?: {
    /** Seconds until the WHOOP access token expires (negative once expired), or null. */
    accessTokenExpiresInS: number | null;
    lastRefresh: { at: string; outcome: string } | null;
  };
  whoopRate?: {
    requestsLastMinute: number;
    requestsTodayUtc: number;
    rateLimitedResponsesTotal: number;
  };
}

// ---------------------------------------------------------------------------
// safeTokenCompare — SHA-256 hash comparison (no length oracle)
// ---------------------------------------------------------------------------

/**
 * Compare two tokens using SHA-256 hashing + timing-safe comparison.
 * Hashing first ensures constant-time comparison regardless of token length.
 * Returns false for empty strings (avoids vacuous truth).
 */
export function safeTokenCompare(provided: string, expected: string): boolean {
  if (!provided || !expected) {
    return false;
  }
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/**
 * The bearer token of a request: scheme "Bearer" (any case) followed by
 * exactly one token of at most MAX_BEARER_TOKEN_LENGTH characters.
 */
export function extractBearerToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || !/^bearer$/i.test(parts[0] ?? "")) return null;
  const token = parts[1] ?? "";
  if (token.length === 0 || token.length > MAX_BEARER_TOKEN_LENGTH) return null;
  return token;
}

/** An AuthInfo the HTTP layer accepts for /mcp (see HttpServerOptions.authenticateBearer). */
export function isAcceptedAccessToken(
  info: AuthInfo,
  canonicalResource: string | undefined,
  nowMs: number
): boolean {
  if (typeof info.expiresAt !== "number" || !Number.isFinite(info.expiresAt)) return false;
  if (info.expiresAt * 1000 <= nowMs) return false;
  if (!Array.isArray(info.scopes) || !info.scopes.includes(CONNECTOR_SCOPE)) return false;
  if (info.resource === undefined) return true;
  if (canonicalResource === undefined) return false;
  let origin: string;
  try {
    origin = new URL(canonicalResource).origin;
  } catch {
    return false;
  }
  return isAcceptedResource(String(info.resource), { origin, canonicalResource });
}

/** A client id short enough to log: registered (DCR) ids are reduced to a fingerprint. */
function loggableClientId(clientId: string): string {
  if (clientId.startsWith("dcr.")) {
    const mac = clientId.slice(clientId.lastIndexOf(".") + 1);
    return `dcr.${mac.slice(0, 12)}`;
  }
  return clientId.length <= 64 ? clientId : `${clientId.slice(0, 64)}…`;
}

// ---------------------------------------------------------------------------
// Per-IP fixed-window counter
// ---------------------------------------------------------------------------

/** Fixed-window counts per key, pruned when many keys are tracked. */
class WindowCounter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  private get enabled(): boolean {
    return this.limit > 0 && this.windowMs > 0;
  }

  private live(key: string, now: number): { count: number; resetAt: number } | undefined {
    const bucket = this.buckets.get(key);
    return bucket !== undefined && bucket.resetAt > now ? bucket : undefined;
  }

  /** True when the key reached the limit in the current window. */
  exceeded(key: string): boolean {
    if (!this.enabled) return false;
    const bucket = this.live(key, Date.now());
    return bucket !== undefined && bucket.count >= this.limit;
  }

  /** Count one event. */
  add(key: string): void {
    if (!this.enabled) return;
    const now = Date.now();
    const bucket = this.live(key, now);
    if (bucket === undefined) {
      this.prune(now);
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      bucket.count++;
    }
  }

  /** Count one event if the key is below the limit; false when it is not. */
  tryAdd(key: string): boolean {
    if (this.exceeded(key)) return false;
    this.add(key);
    return true;
  }

  /** Whole seconds until the key's window resets (at least 1). */
  retryAfterSeconds(key: string): number {
    const bucket = this.live(key, Date.now());
    const ms = bucket === undefined ? this.windowMs : bucket.resetAt - Date.now();
    return Math.max(1, Math.ceil(ms / 1000));
  }

  private prune(now: number): void {
    if (this.buckets.size < MAX_TRACKED_IPS) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    // Still full of live windows: drop the oldest entries.
    for (const key of this.buckets.keys()) {
      if (this.buckets.size < MAX_TRACKED_IPS) break;
      this.buckets.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// CORS handling
// ---------------------------------------------------------------------------

function handleCors(req: IncomingMessage, res: ServerResponse, allowedOrigins: string[]): boolean {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Mcp-Session-Id, WWW-Authenticate, X-Request-Id"
    );
    res.setHeader("Access-Control-Max-Age", "86400");
  }

  // Handle preflight
  if (req.method === "OPTIONS") {
    res.writeHead(origin && allowedOrigins.includes(origin) ? 204 : 403);
    res.end();
    return true; // request fully handled
  }

  return false; // not a preflight, continue processing
}

// ---------------------------------------------------------------------------
// JSON response helper
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Body parser (reads raw body for POST requests)
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_MCP_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** JSON-RPC method, tool name and batch size of a parsed /mcp body, safe to log. */
function describeRpc(body: unknown): { rpcMethod?: string; tool?: string; batchSize?: number } {
  if (Array.isArray(body)) return { rpcMethod: "batch", batchSize: body.length };
  if (body === null || typeof body !== "object") return {};
  const { method, params } = body as { method?: unknown; params?: unknown };
  if (typeof method !== "string" || !LOGGED_RPC_METHOD.test(method)) return {};
  const described: { rpcMethod: string; tool?: string } = { rpcMethod: method };
  if (method === "tools/call" && params !== null && typeof params === "object") {
    const name = (params as { name?: unknown }).name;
    if (typeof name === "string" && LOGGED_TOOL_NAME.test(name)) described.tool = name;
  }
  return described;
}

// ---------------------------------------------------------------------------
// createHttpServer
// ---------------------------------------------------------------------------

/**
 * Create an HTTP server with bearer-token auth for the MCP transport.
 *
 * The server exposes:
 * - POST /mcp — MCP protocol (requires bearer token)
 * - GET /mcp — SSE stream (requires bearer token)
 * - DELETE /mcp — Session termination (requires bearer token)
 * - GET /health — Health check (public: basic, authed: detailed)
 * - POST /webhooks/whoop — WHOOP webhooks (when configured)
 *
 * Authentication on /mcp and /health: the static token always works. Any
 * other token goes to `authenticateBearer` (when set); a token it accepts
 * always works. After AUTH_FAILURES_PER_WINDOW failed verifications per IP per
 * minute, further invalid tokens from that IP get 429 instead of 401.
 *
 * @throws Error if authToken is empty or resourceMetadataUrl is not a plain URL
 */
export async function createHttpServer(options: HttpServerOptions): Promise<HttpServerResult> {
  const {
    authToken,
    port,
    host = "0.0.0.0",
    maxConnections = DEFAULT_MAX_CONNECTIONS,
    allowedOrigins = [],
    trustProxy = false,
    healthCheck,
    oauthHandler,
    mcpRateLimit = { windowMs: 60_000, max: 100 },
    sseReauthIntervalMs = 5 * 60 * 1000,
    validateBearerToken,
    authenticateBearer,
    resourceMetadataUrl,
    canonicalResource,
    createMcpServer,
    runtimeStatus,
    logger,
    webhooks,
  } = options;
  const queueMax = Math.max(0, options.queue?.max ?? DEFAULT_QUEUE_MAX);
  const queueTimeoutMs = Math.max(0, options.queue?.timeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS);

  if (!authToken) {
    throw new Error(
      "MCP_AUTH_TOKEN is required when MCP_TRANSPORT=http or MCP_TRANSPORT=both. " +
        "Set it to a secure random string (32+ characters recommended)."
    );
  }
  if (resourceMetadataUrl !== undefined && !/^https?:\/\/[^\s"\\]+$/.test(resourceMetadataUrl)) {
    throw new Error("resourceMetadataUrl must be an http(s) URL without quotes or spaces.");
  }

  const startTime = Date.now();
  const webhookHandler = webhooks ? createWhoopWebhookHandler(webhooks) : undefined;

  const mcpRateBuckets = new WindowCounter(mcpRateLimit.max, mcpRateLimit.windowMs);
  const authFailures = new WindowCounter(AUTH_FAILURES_PER_WINDOW, RATE_WINDOW_MS);
  const webhookRequests = new WindowCounter(WEBHOOK_RATE_LIMIT_PER_MINUTE, RATE_WINDOW_MS);

  /**
   * The address that rate limits and the auth throttle key on. With
   * trustProxy, exactly one proxy hop is trusted: the rightmost
   * X-Forwarded-For entry, which that proxy appended (entries to its left come
   * from the client and can be forged). The OAuth connector's Express app
   * trusts the same single hop (`trust proxy: 1`, see index.ts), so both
   * layers see the same client.
   */
  function clientIp(req: IncomingMessage): string {
    if (trustProxy) {
      const xff = req.headers["x-forwarded-for"];
      if (typeof xff === "string") {
        const hops = xff
          .split(",")
          .map((hop) => hop.trim())
          .filter((hop) => hop.length > 0);
        const nearest = hops.at(-1);
        if (nearest !== undefined) return nearest;
      }
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  /** The AuthInfo of an accepted non-static token, or null. Never throws. */
  async function verifyOAuthToken(token: string): Promise<AuthInfo | null> {
    if (!authenticateBearer) return null;
    let info: AuthInfo | null;
    try {
      info = await authenticateBearer(token);
    } catch {
      return null;
    }
    if (info === null || typeof info !== "object") return null;
    return isAcceptedAccessToken(info, canonicalResource, Date.now()) ? info : null;
  }

  type AuthOutcome =
    | { result: "ok"; info: AuthInfo; auth: McpAuthContext }
    | { result: "missing" | "invalid" | "throttled" };

  async function authenticate(req: IncomingMessage, token: string | null): Promise<AuthOutcome> {
    if (token === null) return { result: "missing" };
    // 1. The static token: independent of any OAuth configuration.
    if (safeTokenCompare(token, authToken)) {
      return {
        result: "ok",
        info: { token, clientId: STATIC_BEARER_CLIENT_ID, scopes: [CONNECTOR_SCOPE] },
        auth: { kind: "static", clientId: STATIC_BEARER_CLIENT_ID },
      };
    }
    if (!authenticateBearer) return { result: "invalid" };
    // 2. A connector access token that verifies is always accepted, even from
    // an IP over the failure limit: a shared address (a proxy, claude.ai's
    // egress) must not lock out a signed-in client. Verification is a local
    // signature check, so verifying before the throttle costs no WHOOP calls.
    const info = await verifyOAuthToken(token);
    if (info !== null) {
      return { result: "ok", info, auth: { kind: "oauth", clientId: info.clientId } };
    }
    // 3. Too many failed verifications from this IP: 429 instead of 401.
    const ip = clientIp(req);
    if (authFailures.exceeded(ip)) return { result: "throttled" };
    authFailures.add(ip);
    return { result: "invalid" };
  }

  function sendUnauthorized(res: ServerResponse): void {
    if (resourceMetadataUrl !== undefined) {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer realm="whoop-mcp", error="invalid_token", resource_metadata="${resourceMetadataUrl}"`
      );
      sendJson(res, 401, {
        error: "invalid_token",
        error_description: "Missing or invalid access token",
      });
      return;
    }
    sendJson(res, 401, { error: "Unauthorized" });
  }

  // -------------------------------------------------------------------------
  // In-flight slots with a FIFO queue
  // -------------------------------------------------------------------------

  let activeSlots = 0;
  interface SlotWaiter {
    grant: (granted: boolean) => void;
    timer: NodeJS.Timeout;
  }
  const waiters: SlotWaiter[] = [];

  function removeWaiter(waiter: SlotWaiter): boolean {
    const index = waiters.indexOf(waiter);
    if (index === -1) return false;
    waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    return true;
  }

  /**
   * Take a slot, waiting in the queue when all are in use. Resolves false when
   * the queue is full, the wait times out or the client goes away.
   */
  function acquireSlot(res: ServerResponse): Promise<boolean> {
    if (maxConnections <= 0) return Promise.resolve(false);
    if (activeSlots < maxConnections && waiters.length === 0) {
      activeSlots++;
      return Promise.resolve(true);
    }
    if (waiters.length >= queueMax || queueTimeoutMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter: SlotWaiter = {
        grant: resolve,
        timer: setTimeout(() => {
          if (removeWaiter(waiter)) resolve(false);
        }, queueTimeoutMs),
      };
      res.once("close", () => {
        if (removeWaiter(waiter)) resolve(false);
      });
      waiters.push(waiter);
    });
  }

  function releaseSlot(): void {
    activeSlots = Math.max(0, activeSlots - 1);
    while (activeSlots < maxConnections && waiters.length > 0) {
      const next = waiters.shift();
      if (next === undefined) break;
      clearTimeout(next.timer);
      activeSlots++;
      next.grant(true);
    }
  }

  // -------------------------------------------------------------------------
  // SSE re-validation
  // -------------------------------------------------------------------------

  const validate =
    validateBearerToken ??
    (async (t: string): Promise<boolean> =>
      safeTokenCompare(t, authToken) || (await verifyOAuthToken(t)) !== null);

  // Track live SSE responses so we can re-validate the bearer token periodically.
  const sseConnections = new Set<{ res: ServerResponse; token: string }>();
  let sseTimer: NodeJS.Timeout | null = null;
  let sweeping = false;
  if (sseReauthIntervalMs > 0) {
    sseTimer = setInterval(() => {
      if (sweeping || sseConnections.size === 0) return;
      sweeping = true;
      const entries = [...sseConnections];
      void Promise.allSettled(entries.map(async (entry) => validate(entry.token)))
        .then((results) => {
          results.forEach((outcome, index) => {
            const entry = entries[index];
            if (entry === undefined) return;
            if (outcome.status === "rejected" || outcome.value !== true) {
              entry.res.end();
              sseConnections.delete(entry);
            }
          });
        })
        .finally(() => {
          sweeping = false;
        });
    }, sseReauthIntervalMs);
    sseTimer.unref();
  }

  // Create the SDK transport (stateful with session IDs)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  async function handleHealth(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = extractBearerToken(req);
    let isAuthed = false;
    if (token !== null) {
      const outcome = await authenticate(req, token);
      isAuthed = outcome.result === "ok";
    }

    const health: HealthResponse = { status: "ok" };
    if (isAuthed) {
      health.uptime = Math.floor((Date.now() - startTime) / 1000);
      health.version = runtimeStatus?.snapshot().version ?? packageVersion();
      health.commit =
        runtimeStatus !== undefined ? runtimeStatus.snapshot().commit : readCommit(process.env);
      if (healthCheck) {
        try {
          health.whoopApi = (await healthCheck()) ? "ok" : "error";
        } catch {
          health.whoopApi = "error";
        }
      } else {
        health.whoopApi = "unknown";
      }
      if (runtimeStatus !== undefined) {
        // Read after the probe, so its WHOOP request is counted.
        const snapshot = runtimeStatus.snapshot();
        const expiresAt = snapshot.whoop_auth.access_token_expires_at;
        health.privacyMode = snapshot.privacy_mode;
        health.oauthConnector = snapshot.oauth_connector;
        health.webhooks = {
          enabled: snapshot.webhooks.enabled,
          lastEventAt: snapshot.webhooks.last_event_at,
        };
        health.whoopAuth = {
          accessTokenExpiresInS:
            expiresAt === null ? null : Math.round((Date.parse(expiresAt) - Date.now()) / 1000),
          lastRefresh: snapshot.whoop_auth.last_refresh,
        };
        health.whoopRate = {
          requestsLastMinute: snapshot.whoop_api.requests_last_minute,
          requestsTodayUtc: snapshot.whoop_api.requests_today_utc,
          rateLimitedResponsesTotal: snapshot.whoop_api.rate_limited_responses_total,
        };
      }
    }
    sendJson(res, 200, health);
  }

  async function handleWebhook(
    req: IncomingMessage,
    res: ServerResponse,
    handler: NonNullable<typeof webhookHandler>
  ): Promise<void> {
    const requestId = randomUUID();
    res.setHeader("X-Request-Id", requestId);
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJson(res, 405, { error: "Method Not Allowed" });
      return;
    }
    const ip = clientIp(req);
    if (!webhookRequests.tryAdd(ip)) {
      res.setHeader("Retry-After", String(webhookRequests.retryAfterSeconds(ip)));
      sendJson(res, 429, { error: "Too Many Requests" });
      return;
    }
    await handler(req, res, requestId);
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    res.setHeader("X-Request-Id", requestId);

    const access: {
      rpcMethod?: string;
      tool?: string;
      batchSize?: number;
      auth: McpAuthContext | null;
    } = { auth: null };
    let responseClosed = false;
    res.once("close", () => {
      responseClosed = true;
      logger?.info("mcp request", {
        requestId,
        rpcMethod: access.rpcMethod,
        tool: access.tool,
        batchSize: access.batchSize,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
        auth: access.auth?.kind ?? null,
        clientId: access.auth ? loggableClientId(access.auth.clientId) : undefined,
        ...(res.writableFinished ? {} : { aborted: true }),
      });
    });

    // Auth check
    const token = extractBearerToken(req);
    const outcome = await authenticate(req, token);
    if (outcome.result === "throttled") {
      res.setHeader("Retry-After", String(authFailures.retryAfterSeconds(clientIp(req))));
      sendJson(res, 429, { error: "Too Many Requests" });
      return;
    }
    if (outcome.result !== "ok") {
      sendUnauthorized(res);
      return;
    }
    access.auth = outcome.auth;
    // The SDK transport passes req.auth to handlers as extra.authInfo.
    (req as IncomingMessage & { auth?: AuthInfo }).auth = outcome.info;

    // Per-IP rate limit (100/min default)
    const ip = clientIp(req);
    if (!mcpRateBuckets.tryAdd(ip)) {
      res.setHeader("Retry-After", String(Math.ceil(mcpRateLimit.windowMs / 1000)));
      sendJson(res, 429, { error: "Too Many Requests" });
      return;
    }

    // Stateless mode serves POST only
    if (createMcpServer && req.method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJson(res, 405, { error: "Method Not Allowed" });
      return;
    }

    // In-flight slot (waits in the queue when all are in use)
    const granted = await acquireSlot(res);
    if (!granted) {
      // The client may have given up while queued: nothing to answer.
      if (responseClosed) return;
      res.setHeader("Retry-After", "1");
      sendJson(res, 503, {
        error: "Service Unavailable",
        message: "Maximum connections reached",
      });
      return;
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      releaseSlot();
    };
    if (responseClosed) {
      release();
      return;
    }
    res.once("close", release);

    const sseEntry = { res, token: token ?? "" };
    if (req.method === "GET") {
      sseConnections.add(sseEntry);
      res.once("close", () => sseConnections.delete(sseEntry));
    }

    // Parse body for POST requests
    let parsedBody: unknown = undefined;
    if (req.method === "POST") {
      try {
        const rawBody = await readBody(req);
        parsedBody = JSON.parse(rawBody) as unknown;
      } catch {
        sendJson(res, 400, { error: "Bad Request", message: "Invalid JSON body" });
        return;
      }
      Object.assign(access, describeRpc(parsedBody));
    }

    // Delegate to SDK transport
    try {
      if (createMcpServer) {
        const requestServer = createMcpServer({ requestId, auth: outcome.auth });
        const requestTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.once("close", () => {
          void requestServer.close().catch(() => undefined);
        });
        await requestServer.connect(requestTransport);
        await requestTransport.handleRequest(req, res, parsedBody);
        return;
      }
      await transport.handleRequest(req, res, parsedBody);
    } catch (error: unknown) {
      logger?.error("mcp request failed", {
        requestId,
        errorClass:
          error instanceof Error && /^\w{1,64}$/.test(error.name) ? error.name : "unknown",
        stackFrames: stackFramesOf(error),
      });
      // If response hasn't been sent yet
      sendJson(res, 500, { error: "Internal Server Error", requestId });
    }
  }

  // Create HTTP server
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      sendJson(res, 400, { error: "Bad Request" });
      return;
    }

    try {
      // WHOOP webhooks: before CORS, OAuth and /mcp; no bearer token.
      if (webhookHandler && pathname === WEBHOOK_PATH) {
        await handleWebhook(req, res, webhookHandler);
        return;
      }

      // CORS handling
      if (handleCors(req, res, allowedOrigins)) {
        return; // preflight handled
      }

      // Route: /health
      if (pathname === "/health") {
        await handleHealth(req, res);
        return;
      }

      // OAuth connector routes — forward to mounted handler if configured
      if (
        oauthHandler &&
        (pathname === "/authorize" ||
          pathname === "/token" ||
          pathname === "/register" ||
          pathname.startsWith("/.well-known/"))
      ) {
        oauthHandler(req, res);
        return;
      }

      // Route: /mcp (all methods)
      if (pathname === "/mcp") {
        await handleMcp(req, res);
        return;
      }

      // Unknown routes
      sendJson(res, 404, { error: "Not Found" });
    } catch (error: unknown) {
      logger?.error("http request failed", {
        errorClass:
          error instanceof Error && /^\w{1,64}$/.test(error.name) ? error.name : "unknown",
        stackFrames: stackFramesOf(error),
      });
      sendJson(res, 500, { error: "Internal Server Error" });
    }
  });

  // Start listening
  await new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      resolve();
    });
  });

  // Graceful shutdown
  const close = async (): Promise<void> => {
    if (sseTimer) {
      clearInterval(sseTimer);
      sseTimer = null;
    }
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.grant(false);
    }
    await transport.close();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };

  return { server, transport, close };
}
