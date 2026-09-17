/**
 * Tests for HTTP transport layer (Task 13a).
 *
 * Covers: bearer auth (static token and OAuth access tokens), safeTokenCompare,
 * health endpoint, in-flight slots and queue, request ids and access logs,
 * CORS, graceful shutdown.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  AUTH_FAILURES_PER_WINDOW,
  MAX_BEARER_TOKEN_LENGTH,
  STATIC_BEARER_CLIENT_ID,
  safeTokenCompare,
  createHttpServer,
  type HttpServerOptions,
  type McpRequestContext,
} from "../../src/transport/http.js";
import { OAuthConnectorProvider } from "../../src/transport/oauth-connector.js";
import { signToken } from "../../src/transport/oauth-jwt.js";
import { createRuntimeStatus, readCommit } from "../../src/runtime-status.js";
import type { Logger } from "../../src/logging/logger.js";

// ---------------------------------------------------------------------------
// Helper: make HTTP requests to the test server
// ---------------------------------------------------------------------------

interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  server: http.Server,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      reject(new Error("Server not listening"));
      return;
    }
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      }
    );
    req.on("error", reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

const TOKEN = "test-token-abc123";
const PUBLIC_ORIGIN = "https://mcp.example.com";
const CANONICAL = `${PUBLIC_ORIGIN}/mcp`;
const METADATA_URL = `${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp`;

/** JSON-RPC over the Streamable HTTP transport (JSON responses). */
function mcpPost(
  server: http.Server,
  token: string | null,
  message: unknown,
  headers: Record<string, string> = {}
): Promise<TestResponse> {
  return request(server, "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(message),
  });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "http-test", version: "0.0.0" },
  },
};

function callTool(name: string, id = 2): unknown {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } };
}

/** The text of a tools/call JSON response. */
function toolText(res: TestResponse): string {
  const body = JSON.parse(res.body) as { result?: { content?: Array<{ text?: string }> } };
  return body.result?.content?.[0]?.text ?? "";
}

/**
 * A small MCP server: `whoami` returns the request's authInfo client id,
 * `slow` waits `delayMs` and reports the peak number of concurrent calls.
 */
function testMcpServer(state: { active: number; peak: number }, delayMs = 150): McpServer {
  const server = new McpServer({ name: "http-test", version: "0.0.0" });
  server.registerTool(
    "whoami",
    { description: "Returns the authenticated client id.", inputSchema: z.object({}) },
    async (_args, extra) => ({
      content: [{ type: "text", text: extra.authInfo?.clientId ?? "none" }],
    })
  );
  server.registerTool(
    "slow",
    { description: "Waits, then answers.", inputSchema: z.object({}) },
    async () => {
      state.active++;
      state.peak = Math.max(state.peak, state.active);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      state.active--;
      return { content: [{ type: "text", text: "done" }] };
    }
  );
  return server;
}

function oauthInfo(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return {
    token: "oauth-good",
    clientId: "client-a",
    scopes: ["mcp"],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    resource: new URL(CANONICAL),
    ...overrides,
  };
}

function silentLogger(): Logger & { [K in keyof Logger]: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// ---------------------------------------------------------------------------
// safeTokenCompare
// ---------------------------------------------------------------------------

describe("safeTokenCompare", () => {
  it("returns true for matching tokens", () => {
    expect(safeTokenCompare("my-secret-token", "my-secret-token")).toBe(true);
  });

  it("returns false for non-matching tokens", () => {
    expect(safeTokenCompare("my-secret-token", "wrong-token")).toBe(false);
  });

  it("returns false for empty provided token", () => {
    expect(safeTokenCompare("", "my-secret-token")).toBe(false);
  });

  it("returns false for empty expected token", () => {
    expect(safeTokenCompare("my-secret-token", "")).toBe(false);
  });

  it("returns false when both are empty", () => {
    expect(safeTokenCompare("", "")).toBe(false);
  });

  it("handles tokens of different lengths", () => {
    expect(safeTokenCompare("short", "a-much-longer-token-value")).toBe(false);
  });

  it("handles unicode tokens", () => {
    expect(safeTokenCompare("tökën-🔑", "tökën-🔑")).toBe(true);
    expect(safeTokenCompare("tökën-🔑", "tökën-🔒")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HTTP Server: Health endpoint
// ---------------------------------------------------------------------------

describe("HTTP Server", () => {
  let server: http.Server;
  let cleanup: (() => Promise<void>) | null = null;

  const defaultOptions: HttpServerOptions = {
    authToken: TOKEN,
    port: 0, // dynamic port
  };

  async function start(options: Partial<HttpServerOptions> = {}): Promise<http.Server> {
    const result = await createHttpServer({
      ...defaultOptions,
      sseReauthIntervalMs: 0,
      ...options,
    });
    server = result.server;
    cleanup = result.close;
    return server;
  }

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  describe("/health endpoint", () => {
    beforeEach(async () => {
      const result = await createHttpServer(defaultOptions);
      server = result.server;
      cleanup = result.close;
    });

    it("returns { status: 'ok' } without auth", async () => {
      const res = await request(server, "/health");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as { status: string };
      expect(body.status).toBe("ok");
      // Should NOT include detailed info without auth
      expect(body).not.toHaveProperty("uptime");
    });

    it("returns detailed health with valid bearer token", async () => {
      const res = await request(server, "/health", {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as { status: string; uptime: number };
      expect(body.status).toBe("ok");
      expect(body).toHaveProperty("uptime");
      expect(typeof body.uptime).toBe("number");
    });

    it("returns basic health with invalid bearer token", async () => {
      const res = await request(server, "/health", {
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as { status: string };
      expect(body.status).toBe("ok");
      expect(body).not.toHaveProperty("uptime");
    });
  });

  describe("/health runtime status", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8")
    ) as { version: string };

    function runtimeStatus(): ReturnType<typeof createRuntimeStatus> {
      const status = createRuntimeStatus({
        version: packageJson.version,
        commit: readCommit({ RAILWAY_GIT_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567" }),
        privacyMode: "standard",
      });
      status.setFlags({ oauthConnector: true, webhooksEnabled: true });
      status.setAccessTokenExpiry(Date.now() + 3_600_000);
      status.recordRefresh("ok");
      status.attachLimiter({
        stats: () => ({
          requests_last_minute: 7,
          requests_today_utc: 42,
          throttled_waits_total: 1,
          rate_limited_responses_total: 2,
          last_rate_limited_at: null,
        }),
      });
      return status;
    }

    it("reports version, commit, auth and WHOOP request counters when authenticated", async () => {
      const healthCheck = vi.fn(() => Promise.resolve(true));
      await start({ runtimeStatus: runtimeStatus(), healthCheck });
      const res = await request(server, "/health", {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body).toMatchObject({
        status: "ok",
        version: packageJson.version,
        commit: "0123456789ab",
        whoopApi: "ok",
        privacyMode: "standard",
        oauthConnector: true,
        webhooks: { enabled: true, lastEventAt: null },
        whoopAuth: { lastRefresh: { outcome: "ok" } },
        whoopRate: { requestsLastMinute: 7, requestsTodayUtc: 42, rateLimitedResponsesTotal: 2 },
      });
      const expiresIn = (body.whoopAuth as { accessTokenExpiresInS: number }).accessTokenExpiresInS;
      expect(expiresIn).toBeGreaterThan(3590);
      expect(expiresIn).toBeLessThanOrEqual(3600);
      expect(Object.keys(body)).toEqual([
        "status",
        "uptime",
        "version",
        "commit",
        "whoopApi",
        "privacyMode",
        "oauthConnector",
        "webhooks",
        "whoopAuth",
        "whoopRate",
      ]);
    });

    it("unauthenticated /health has neither version nor counters and never probes WHOOP", async () => {
      const healthCheck = vi.fn(() => Promise.resolve(true));
      await start({ runtimeStatus: runtimeStatus(), healthCheck });
      const res = await request(server, "/health");
      expect(JSON.parse(res.body)).toEqual({ status: "ok" });
      expect(healthCheck).not.toHaveBeenCalled();
    });

    it("reports the package version without a runtime status", async () => {
      await start();
      const res = await request(server, "/health", {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const body = JSON.parse(res.body) as { version: string; whoopRate?: unknown };
      expect(body.version).toBe(packageJson.version);
      expect(body.whoopRate).toBeUndefined();
    });

    it("accepts a valid OAuth access token", async () => {
      await start({
        runtimeStatus: runtimeStatus(),
        authenticateBearer: async (t) => (t === "oauth-good" ? oauthInfo() : null),
        canonicalResource: CANONICAL,
        resourceMetadataUrl: METADATA_URL,
      });
      const good = await request(server, "/health", {
        headers: { authorization: "Bearer oauth-good" },
      });
      expect(JSON.parse(good.body)).toHaveProperty("whoopRate");
      const bad = await request(server, "/health", {
        headers: { authorization: "Bearer oauth-bad" },
      });
      expect(JSON.parse(bad.body)).toEqual({ status: "ok" });
    });
  });

  // ---------------------------------------------------------------------------
  // Bearer auth on /mcp
  // ---------------------------------------------------------------------------

  describe("/mcp authentication", () => {
    beforeEach(async () => {
      const result = await createHttpServer(defaultOptions);
      server = result.server;
      cleanup = result.close;
    });

    it("returns 401 without authorization header", async () => {
      const res = await request(server, "/mcp", { method: "POST" });
      expect(res.status).toBe(401);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toBe("Unauthorized");
      expect(res.headers["www-authenticate"]).toBeUndefined();
    });

    it("returns 401 with invalid bearer token", async () => {
      const res = await request(server, "/mcp", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 with non-Bearer scheme", async () => {
      const res = await request(server, "/mcp", {
        method: "POST",
        headers: { authorization: "Basic dXNlcjpwYXNz" },
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 when the header carries more than one token", async () => {
      const res = await request(server, "/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN} extra` },
      });
      expect(res.status).toBe(401);
    });

    it("passes auth with valid bearer token (POST)", async () => {
      // Valid token should reach the transport handler (which may return 400
      // for invalid MCP payload, but NOT 401)
      const res = await request(server, "/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
      });
      // Transport will process it — should not be 401
      expect(res.status).not.toBe(401);
    });

    it("passes auth with valid bearer token (GET for SSE)", async () => {
      const res = await request(server, "/mcp", {
        method: "GET",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      // Should not be 401 (may be 400 if no session established)
      expect(res.status).not.toBe(401);
    });
  });

  describe("/mcp static and OAuth tokens (stateless)", () => {
    const state = { active: 0, peak: 0 };

    beforeEach(() => {
      state.active = 0;
      state.peak = 0;
    });

    it("serves the static token unchanged, with any capitalization of the scheme", async () => {
      const contexts: McpRequestContext[] = [];
      await start({
        createMcpServer: (ctx) => {
          contexts.push(ctx);
          return testMcpServer(state);
        },
      });
      const init = await mcpPost(server, TOKEN, INITIALIZE);
      expect(init.status).toBe(200);
      const lower = await request(server, "/mcp", {
        method: "POST",
        headers: {
          authorization: `bearer ${TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(callTool("whoami")),
      });
      expect(lower.status).toBe(200);
      expect(toolText(lower)).toBe(STATIC_BEARER_CLIENT_ID);
      expect(contexts[1]).toEqual({
        requestId: lower.headers["x-request-id"],
        auth: { kind: "static", clientId: STATIC_BEARER_CLIENT_ID },
      });
    });

    it("accepts an access token from an async verifier and passes authInfo to tools", async () => {
      const contexts: McpRequestContext[] = [];
      await start({
        authenticateBearer: (t) =>
          new Promise((resolve) =>
            setImmediate(() => resolve(t === "oauth-good" ? oauthInfo() : null))
          ),
        canonicalResource: CANONICAL,
        resourceMetadataUrl: METADATA_URL,
        createMcpServer: (ctx) => {
          contexts.push(ctx);
          return testMcpServer(state);
        },
      });
      expect((await mcpPost(server, "oauth-good", INITIALIZE)).status).toBe(200);
      const res = await mcpPost(server, "oauth-good", callTool("whoami"));
      expect(res.status).toBe(200);
      expect(toolText(res)).toBe("client-a");
      expect(contexts[1]?.auth).toEqual({ kind: "oauth", clientId: "client-a" });
    });

    it("accepts a token bound to the bare origin (trailing slash ignored)", async () => {
      await start({
        authenticateBearer: async () => oauthInfo({ resource: new URL(`${PUBLIC_ORIGIN}/`) }),
        canonicalResource: CANONICAL,
        resourceMetadataUrl: METADATA_URL,
        createMcpServer: () => testMcpServer(state),
      });
      expect((await mcpPost(server, "oauth-good", INITIALIZE)).status).toBe(200);
    });

    it.each([
      ["an expired token", oauthInfo({ expiresAt: Math.floor(Date.now() / 1000) - 1 })],
      ["a token without expiry", oauthInfo({ expiresAt: undefined })],
      ["a token without the mcp scope", oauthInfo({ scopes: [] })],
      [
        "a token for another resource",
        oauthInfo({ resource: new URL("https://evil.example/mcp") }),
      ],
    ])("rejects %s with 401 and resource metadata", async (_label, info) => {
      await start({
        authenticateBearer: async () => info,
        canonicalResource: CANONICAL,
        resourceMetadataUrl: METADATA_URL,
        createMcpServer: () => testMcpServer(state),
      });
      const res = await mcpPost(server, "oauth-token", INITIALIZE);
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body)).toEqual({
        error: "invalid_token",
        error_description: "Missing or invalid access token",
      });
      expect(res.headers["www-authenticate"]).toBe(
        `Bearer realm="whoop-mcp", error="invalid_token", resource_metadata="${METADATA_URL}"`
      );
    });

    it("answers a missing token with the discovery header when a connector is mounted", async () => {
      await start({
        authenticateBearer: async () => null,
        canonicalResource: CANONICAL,
        resourceMetadataUrl: METADATA_URL,
      });
      const res = await mcpPost(server, null, INITIALIZE);
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toContain(`resource_metadata="${METADATA_URL}"`);
    });

    it("treats a verifier rejecting with a non-Error as an invalid token (401, not 500)", async () => {
      await start({
        authenticateBearer: () => Promise.reject("not an error"),
        canonicalResource: CANONICAL,
        resourceMetadataUrl: METADATA_URL,
        createMcpServer: () => testMcpServer(state),
      });
      expect((await mcpPost(server, "anything", INITIALIZE)).status).toBe(401);
    });

    it("rejects a refresh token presented to the real provider, accepts its access token", async () => {
      const secret = new Uint8Array(randomBytes(32));
      const provider = new OAuthConnectorProvider({
        client: {
          clientId: "static-client",
          redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
        },
        allowedRedirectUris: ["https://claude.ai/api/mcp/auth_callback"],
        jwtSecret: secret,
        publicUrl: PUBLIC_ORIGIN,
      });
      try {
        await start({
          authenticateBearer: async (t) => {
            try {
              return await provider.verifyAccessToken(t);
            } catch {
              return null;
            }
          },
          canonicalResource: CANONICAL,
          resourceMetadataUrl: METADATA_URL,
          createMcpServer: () => testMcpServer(state),
        });
        const base = { clientId: "static-client", scopes: ["mcp"], resource: CANONICAL };
        const refresh = await signToken(
          { ...base, ttlSeconds: 3600, type: "refresh", jti: "j1" },
          secret
        );
        const access = await signToken({ ...base, ttlSeconds: 3600, type: "access" }, secret);
        expect((await mcpPost(server, refresh, INITIALIZE)).status).toBe(401);
        expect((await mcpPost(server, access, INITIALIZE)).status).toBe(200);
      } finally {
        provider.stop();
      }
    });

    it("never sends an over-long token to the verifier", async () => {
      const verifier = vi.fn(async () => oauthInfo());
      await start({ authenticateBearer: verifier, canonicalResource: CANONICAL });
      const res = await mcpPost(server, "x".repeat(MAX_BEARER_TOKEN_LENGTH + 1), INITIALIZE);
      expect(res.status).toBe(401);
      expect(verifier).not.toHaveBeenCalled();
    });

    it("answers 429 after 20 failed verifications per IP, without locking out the static token", async () => {
      const verifier = vi.fn(async () => null);
      await start({
        authenticateBearer: verifier,
        canonicalResource: CANONICAL,
        resourceMetadataUrl: METADATA_URL,
        createMcpServer: () => testMcpServer(state),
      });
      for (let i = 0; i < AUTH_FAILURES_PER_WINDOW; i++) {
        expect((await mcpPost(server, `bad-${i}`, INITIALIZE)).status).toBe(401);
      }
      const throttled = await mcpPost(server, "bad-21", INITIALIZE);
      expect(throttled.status).toBe(429);
      expect(Number(throttled.headers["retry-after"])).toBeGreaterThan(0);
      expect(verifier).toHaveBeenCalledTimes(AUTH_FAILURES_PER_WINDOW);
      expect((await mcpPost(server, TOKEN, INITIALIZE)).status).toBe(200);
    });

    it("keeps the legacy 401 without a verifier", async () => {
      await start({ createMcpServer: () => testMcpServer(state) });
      const res = await mcpPost(server, "oauth-good", INITIALIZE);
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ error: "Unauthorized" });
      expect(res.headers["www-authenticate"]).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // In-flight slots and queue
  // ---------------------------------------------------------------------------

  describe("in-flight slots", () => {
    const state = { active: 0, peak: 0 };

    beforeEach(() => {
      state.active = 0;
      state.peak = 0;
    });

    it("serves 6 concurrent slow calls at the default limit", async () => {
      await start({ createMcpServer: () => testMcpServer(state) });
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, i) => mcpPost(server, TOKEN, callTool("slow", i + 1)))
      );
      expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(responses.every((r) => toolText(r) === "done")).toBe(true);
      expect(state.peak).toBe(6);
    });

    it("queues a request beyond maxConnections until a slot frees", async () => {
      await start({ maxConnections: 1, createMcpServer: () => testMcpServer(state) });
      const responses = await Promise.all([
        mcpPost(server, TOKEN, callTool("slow", 1)),
        mcpPost(server, TOKEN, callTool("slow", 2)),
      ]);
      expect(responses.map((r) => r.status)).toEqual([200, 200]);
      expect(state.peak).toBe(1);
    });

    it("answers 503 with Retry-After immediately when the queue is full", async () => {
      await start({
        maxConnections: 1,
        queue: { max: 1 },
        createMcpServer: () => testMcpServer(state, 300),
      });
      const first = mcpPost(server, TOKEN, callTool("slow", 1));
      const second = mcpPost(server, TOKEN, callTool("slow", 2));
      await new Promise((resolve) => setTimeout(resolve, 60));
      const startedAt = Date.now();
      const third = await mcpPost(server, TOKEN, callTool("slow", 3));
      expect(third.status).toBe(503);
      expect(third.headers["retry-after"]).toBe("1");
      expect(Date.now() - startedAt).toBeLessThan(250);
      expect((await first).status).toBe(200);
      expect((await second).status).toBe(200);
    });

    it("answers 503 when a queued request waits longer than the queue timeout", async () => {
      await start({
        maxConnections: 1,
        queue: { timeoutMs: 50 },
        createMcpServer: () => testMcpServer(state, 400),
      });
      const first = mcpPost(server, TOKEN, callTool("slow", 1));
      await new Promise((resolve) => setTimeout(resolve, 40));
      const second = await mcpPost(server, TOKEN, callTool("slow", 2));
      expect(second.status).toBe(503);
      expect(second.headers["retry-after"]).toBe("1");
      expect((await first).status).toBe(200);
      // The slot is free again afterwards.
      expect((await mcpPost(server, TOKEN, callTool("whoami", 3))).status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Request ids, errors and access logs
  // ---------------------------------------------------------------------------

  describe("request ids and logging", () => {
    const state = { active: 0, peak: 0 };
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    it("sets X-Request-Id on every /mcp response", async () => {
      await start({ maxConnections: 0, createMcpServer: () => testMcpServer(state) });
      const unauthorized = await mcpPost(server, "wrong", INITIALIZE);
      const unavailable = await mcpPost(server, TOKEN, INITIALIZE);
      expect(unauthorized.status).toBe(401);
      expect(unavailable.status).toBe(503);
      expect(unauthorized.headers["x-request-id"]).toMatch(UUID);
      expect(unavailable.headers["x-request-id"]).toMatch(UUID);
      expect(unauthorized.headers["x-request-id"]).not.toBe(unavailable.headers["x-request-id"]);
    });

    it("answers 500 with the request id and no error message", async () => {
      const logger = silentLogger();
      await start({
        logger,
        createMcpServer: () => {
          throw new Error("secret-internal-detail");
        },
      });
      const res = await mcpPost(server, TOKEN, INITIALIZE);
      expect(res.status).toBe(500);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body).toEqual({
        error: "Internal Server Error",
        requestId: res.headers["x-request-id"],
      });
      expect(res.body).not.toContain("secret-internal-detail");
      expect(logger.error).toHaveBeenCalledWith(
        "mcp request failed",
        expect.objectContaining({ requestId: body.requestId, errorClass: "Error" })
      );
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain("secret-internal-detail");
    });

    it("logs one access line per request with method, tool, status and auth only", async () => {
      const logger = silentLogger();
      await start({ logger, createMcpServer: () => testMcpServer(state) });
      const res = await mcpPost(server, TOKEN, callTool("whoami"));
      expect(res.status).toBe(200);
      await vi.waitFor(() => expect(logger.info).toHaveBeenCalledTimes(1));
      const [msg, fields] = logger.info.mock.calls[0] as [string, Record<string, unknown>];
      expect(msg).toBe("mcp request");
      expect(fields).toMatchObject({
        requestId: res.headers["x-request-id"],
        rpcMethod: "tools/call",
        tool: "whoami",
        status: 200,
        auth: "static",
        clientId: STATIC_BEARER_CLIENT_ID,
      });
      expect(typeof fields.durationMs).toBe("number");
      expect(JSON.stringify(logger.info.mock.calls)).not.toContain(TOKEN);

      const denied = await mcpPost(server, "wrong-token", callTool("whoami"));
      expect(denied.status).toBe(401);
      await vi.waitFor(() => expect(logger.info).toHaveBeenCalledTimes(2));
      expect(logger.info.mock.calls[1]?.[1]).toMatchObject({ status: 401, auth: null });
      expect(JSON.stringify(logger.info.mock.calls)).not.toContain("wrong-token");
    });

    it("logs a batch by size and never an unexpected tool name", async () => {
      const logger = silentLogger();
      await start({ logger, createMcpServer: () => testMcpServer(state) });
      await mcpPost(server, TOKEN, [callTool("whoami", 1), callTool("whoami", 2)]);
      await mcpPost(server, TOKEN, callTool("Secret Value 123.456789", 3));
      await vi.waitFor(() => expect(logger.info).toHaveBeenCalledTimes(2));
      expect(logger.info.mock.calls[0]?.[1]).toMatchObject({ rpcMethod: "batch", batchSize: 2 });
      expect(logger.info.mock.calls[1]?.[1]).toMatchObject({ rpcMethod: "tools/call" });
      expect((logger.info.mock.calls[1]?.[1] as Record<string, unknown>).tool).toBeUndefined();
      expect(JSON.stringify(logger.info.mock.calls)).not.toContain("123.456789");
    });
  });

  // ---------------------------------------------------------------------------
  // Connection limiting
  // ---------------------------------------------------------------------------

  describe("connection limiting", () => {
    it("returns 503 when max connections exceeded", async () => {
      // maxConnections=0 means ALL requests get rejected immediately
      const result = await createHttpServer({
        ...defaultOptions,
        maxConnections: 0,
      });
      server = result.server;
      cleanup = result.close;

      const res = await request(server, "/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).toBe(503);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toBe("Service Unavailable");
    });

    it("activeConnections counter does not go negative after repeated malformed JSON bodies", async () => {
      // Regression for double-decrement bug: a malformed-JSON catch path must
      // not release its slot twice, since res.on("close") already handles it.
      // Otherwise the counter goes negative and the connection limit silently
      // stops working.
      const result = await createHttpServer({
        ...defaultOptions,
        maxConnections: 1,
        // No waiting: a request beyond the limit is rejected at once.
        queue: { max: 0 },
      });
      server = result.server;
      cleanup = result.close;

      // Send several malformed POSTs sequentially. Each should return 400
      // and leave activeConnections at 0 (would go to -5 with the bug).
      for (let i = 0; i < 5; i++) {
        const res = await request(server, "/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
          body: "this is not json",
        });
        expect(res.status).toBe(400);
      }

      // Open a POST that writes a partial body but never ends, so the server
      // is stuck inside `await readBody(...)`. This holds activeConnections
      // at 1 (== maxConnections). With the bug it would be at -4 and the
      // limit would not engage.
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      const slowReq = http.request({
        hostname: "127.0.0.1",
        port: addr.port,
        path: "/mcp",
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      });
      slowReq.on("error", () => {});
      slowReq.write("{");
      // Brief wait so the server-side handler reaches `await readBody` and
      // activeConnections is incremented.
      await new Promise((r) => setTimeout(r, 50));

      // A subsequent POST must be rejected with 503 because the limiter is
      // still working (counter at cap, not negative).
      const blocked = await request(server, "/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(blocked.status).toBe(503);

      slowReq.destroy();
    });
  });

  // ---------------------------------------------------------------------------
  // CORS
  // ---------------------------------------------------------------------------

  describe("CORS", () => {
    it("denies CORS for unknown origins", async () => {
      const result = await createHttpServer({
        ...defaultOptions,
        allowedOrigins: ["https://allowed.example.com"],
      });
      server = result.server;
      cleanup = result.close;

      const res = await request(server, "/health", {
        method: "OPTIONS",
        headers: { origin: "https://evil.example.com" },
      });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("allows CORS for configured origins", async () => {
      const result = await createHttpServer({
        ...defaultOptions,
        allowedOrigins: ["https://allowed.example.com"],
      });
      server = result.server;
      cleanup = result.close;

      const res = await request(server, "/health", {
        method: "OPTIONS",
        headers: { origin: "https://allowed.example.com" },
      });
      expect(res.headers["access-control-allow-origin"]).toBe("https://allowed.example.com");
      expect(res.headers["access-control-expose-headers"]).toContain("WWW-Authenticate");
    });

    it("denies all origins when no allowedOrigins configured", async () => {
      const result = await createHttpServer(defaultOptions);
      server = result.server;
      cleanup = result.close;

      const res = await request(server, "/health", {
        method: "OPTIONS",
        headers: { origin: "https://any.example.com" },
      });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  describe("graceful shutdown", () => {
    it("close() resolves and stops accepting connections", async () => {
      const result = await createHttpServer(defaultOptions);
      server = result.server;
      cleanup = result.close;

      // Server should be listening
      expect(server.listening).toBe(true);

      // Close should resolve
      await result.close();

      // Server should no longer be listening
      expect(server.listening).toBe(false);

      // Set cleanup to null since we already closed
      cleanup = null;
    });
  });

  // ---------------------------------------------------------------------------
  // Unknown routes
  // ---------------------------------------------------------------------------

  describe("unknown routes", () => {
    beforeEach(async () => {
      const result = await createHttpServer(defaultOptions);
      server = result.server;
      cleanup = result.close;
    });

    it("returns 404 for unknown paths", async () => {
      const res = await request(server, "/unknown");
      expect(res.status).toBe(404);
    });

    it("returns 404 for the webhook path when webhooks are disabled", async () => {
      const res = await request(server, "/webhooks/whoop", { method: "POST", body: "{}" });
      expect(res.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Missing auth token at startup
  // ---------------------------------------------------------------------------

  describe("startup validation", () => {
    it("throws if authToken is empty", async () => {
      await expect(createHttpServer({ ...defaultOptions, authToken: "" })).rejects.toThrow(
        /MCP_AUTH_TOKEN/
      );
    });

    it("throws for a resource metadata URL that cannot be quoted in a header", async () => {
      await expect(
        createHttpServer({ ...defaultOptions, resourceMetadataUrl: 'https://x.example/"a' })
      ).rejects.toThrow(/resourceMetadataUrl/);
    });
  });

  // ---------------------------------------------------------------------------
  // /health — upstream WHOOP API status (Task 13a/13d gap)
  // ---------------------------------------------------------------------------

  describe("/health WHOOP API probe", () => {
    it("reports whoopApi='ok' when healthCheck resolves true (authed)", async () => {
      const result = await createHttpServer({
        ...defaultOptions,
        healthCheck: () => Promise.resolve(true),
      });
      server = result.server;
      cleanup = result.close;

      const res = await request(server, "/health", {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const body = JSON.parse(res.body) as { whoopApi: string };
      expect(body.whoopApi).toBe("ok");
    });

    it("reports whoopApi='error' when healthCheck rejects (authed)", async () => {
      const result = await createHttpServer({
        ...defaultOptions,
        healthCheck: () => Promise.reject(new Error("upstream down")),
      });
      server = result.server;
      cleanup = result.close;

      const res = await request(server, "/health", {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const body = JSON.parse(res.body) as { whoopApi: string };
      expect(body.whoopApi).toBe("error");
    });

    it("reports whoopApi='unknown' when no healthCheck configured (authed)", async () => {
      const result = await createHttpServer(defaultOptions);
      server = result.server;
      cleanup = result.close;

      const res = await request(server, "/health", {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const body = JSON.parse(res.body) as { whoopApi: string };
      expect(body.whoopApi).toBe("unknown");
    });

    it("does not include whoopApi field on unauthenticated /health", async () => {
      const result = await createHttpServer({
        ...defaultOptions,
        healthCheck: () => Promise.resolve(true),
      });
      server = result.server;
      cleanup = result.close;

      const res = await request(server, "/health");
      const body = JSON.parse(res.body) as { whoopApi?: string };
      expect(body.whoopApi).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Per-IP rate limiting on /mcp (Task 13c-13)
  // ---------------------------------------------------------------------------

  describe("/mcp per-IP rate limit", () => {
    it("returns 429 once the per-IP window cap is exceeded", async () => {
      const result = await createHttpServer({
        ...defaultOptions,
        mcpRateLimit: { windowMs: 60_000, max: 2 },
      });
      server = result.server;
      cleanup = result.close;

      const headers = {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      };
      const body = JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 });

      const r1 = await request(server, "/mcp", { method: "POST", headers, body });
      const r2 = await request(server, "/mcp", { method: "POST", headers, body });
      const r3 = await request(server, "/mcp", { method: "POST", headers, body });

      expect(r1.status).not.toBe(429);
      expect(r2.status).not.toBe(429);
      expect(r3.status).toBe(429);
      expect(r3.headers["retry-after"]).toBeDefined();
    });

    it("can be disabled with mcpRateLimit max=0", async () => {
      const result = await createHttpServer({
        ...defaultOptions,
        mcpRateLimit: { windowMs: 60_000, max: 0 },
      });
      server = result.server;
      cleanup = result.close;

      const headers = {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      };
      const body = JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 });

      // Many requests, none should be 429
      for (let i = 0; i < 5; i++) {
        const r = await request(server, "/mcp", { method: "POST", headers, body });
        expect(r.status).not.toBe(429);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // OAuth handler forwarding (Task 13c runtime wiring)
  // ---------------------------------------------------------------------------

  describe("OAuth handler forwarding", () => {
    it("forwards /authorize, /token, /register, /.well-known/* to the configured handler", async () => {
      const seen: string[] = [];
      const oauthHandler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
        seen.push(req.url ?? "");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ forwarded: req.url }));
      };

      const result = await createHttpServer({ ...defaultOptions, oauthHandler });
      server = result.server;
      cleanup = result.close;

      const paths = [
        "/authorize?x=1",
        "/token",
        "/register",
        "/.well-known/oauth-authorization-server",
      ];
      for (const p of paths) {
        const r = await request(server, p);
        expect(r.status).toBe(200);
        const body = JSON.parse(r.body) as { forwarded: string };
        expect(body.forwarded).toBe(p);
      }
      expect(seen).toHaveLength(4);
    });

    it("does not forward when oauthHandler is undefined (returns 404)", async () => {
      const result = await createHttpServer(defaultOptions);
      server = result.server;
      cleanup = result.close;

      const r = await request(server, "/authorize");
      expect(r.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // trustProxy: client IP from X-Forwarded-For
  // ---------------------------------------------------------------------------

  describe("trustProxy header parsing", () => {
    it("uses X-Forwarded-For first IP for rate-limit bucketing when trustProxy is true", async () => {
      const result = await createHttpServer({
        ...defaultOptions,
        trustProxy: true,
        mcpRateLimit: { windowMs: 60_000, max: 1 },
      });
      server = result.server;
      cleanup = result.close;

      const body = JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 });
      const headersA = {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "x-forwarded-for": "10.0.0.1",
      };
      const headersB = {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "x-forwarded-for": "10.0.0.2",
      };

      const r1 = await request(server, "/mcp", { method: "POST", headers: headersA, body });
      const r2 = await request(server, "/mcp", { method: "POST", headers: headersA, body });
      const r3 = await request(server, "/mcp", { method: "POST", headers: headersB, body });

      expect(r1.status).not.toBe(429);
      expect(r2.status).toBe(429); // same XFF IP
      expect(r3.status).not.toBe(429); // different XFF IP
    });
  });

  // ---------------------------------------------------------------------------
  // SSE periodic token re-validation (Task 13c-15)
  // ---------------------------------------------------------------------------

  describe("SSE re-auth sweep", () => {
    /** Open GET /mcp and resolve once the server ends the response. */
    function openSse(target: http.Server): Promise<void> {
      const addr = target.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      return new Promise<void>((resolve) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: addr.port,
            path: "/mcp",
            method: "GET",
            headers: {
              authorization: `Bearer ${TOKEN}`,
              accept: "text/event-stream",
            },
          },
          (res) => {
            res.on("data", () => {});
            res.on("end", resolve);
            res.on("close", resolve);
          }
        );
        req.on("error", () => resolve());
        req.end();
      });
    }

    async function closedWithin(done: Promise<void>, ms: number): Promise<void> {
      await Promise.race([
        done,
        new Promise<void>((_, rej) =>
          setTimeout(() => rej(new Error("SSE not closed in time")), ms)
        ),
      ]);
    }

    it("closes an active SSE connection when validateBearerToken returns false", async () => {
      let valid = true;
      const result = await createHttpServer({
        ...defaultOptions,
        sseReauthIntervalMs: 25, // fast for test
        validateBearerToken: () => valid,
      });
      server = result.server;
      cleanup = result.close;

      // Open an SSE connection (GET /mcp). Don't await — we want it open.
      const sseDone = openSse(server);

      // Wait for connection to register
      await new Promise((r) => setTimeout(r, 50));

      // Invalidate the token — sweep should close the connection
      valid = false;

      await closedWithin(sseDone, 1000);
    });

    it("awaits async validators and ends the connection when one rejects", async () => {
      const result = await createHttpServer({
        ...defaultOptions,
        sseReauthIntervalMs: 25,
        validateBearerToken: () => Promise.reject(new Error("verifier down")),
      });
      server = result.server;
      cleanup = result.close;
      await closedWithin(openSse(server), 1000);
    });
  });
});
