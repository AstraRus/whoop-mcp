/**
 * Tests for the entry point (src/index.ts).
 *
 * All dependencies are mocked — no real OAuth, no real fetch, no real filesystem.
 * Verifies env var validation, authentication wiring, client creation with
 * token refresh, MCP server creation, and stdio transport connection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockAuthenticate = vi.fn<() => Promise<string>>();
const mockRefreshAccessToken = vi.fn();
const mockToOAuthTokens = vi.fn();

vi.mock("../src/auth/oauth.js", () => ({
  authenticate: (...args: unknown[]) =>
    mockAuthenticate(...(args as Parameters<typeof mockAuthenticate>)),
  refreshAccessToken: (...args: unknown[]) => mockRefreshAccessToken(...args),
  toOAuthTokens: (...args: unknown[]) => mockToOAuthTokens(...args),
}));

const mockLoadTokens = vi.fn();
const mockSaveTokens = vi.fn();

vi.mock("../src/auth/token-store.js", () => ({
  loadTokens: (...args: unknown[]) => mockLoadTokens(...args),
  saveTokens: (...args: unknown[]) => mockSaveTokens(...args),
}));

const mockCreateWhoopClient = vi.fn();

vi.mock("../src/api/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api/client.js")>()),
  createWhoopClient: (...args: unknown[]) => mockCreateWhoopClient(...args),
}));

const mockConnect = vi.fn<() => Promise<void>>();
const mockCreateWhoopServer = vi.fn();

vi.mock("../src/server.js", () => ({
  createWhoopServer: (...args: unknown[]) => mockCreateWhoopServer(...args),
}));

const mockStdioTransportInstance = { _mock: true };
const MockStdioServerTransport = vi.fn();

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: MockStdioServerTransport,
}));

const mockCreateHttpServer = vi.fn();
const mockHttpClose = vi.fn(() => Promise.resolve());

vi.mock("../src/transport/http.js", () => ({
  createHttpServer: (...args: unknown[]) => mockCreateHttpServer(...args),
}));

// ---------------------------------------------------------------------------
// Import the module under test — must be after mocks
// ---------------------------------------------------------------------------

// We dynamically import so vi.mock() hoists above the import.
// Note: ESM import() caches — every call returns the same module.
// This works because main() reads process.env at call time, not import time.
async function importMain(): Promise<{
  main: () => Promise<void>;
  parseRateLimitPerMinute: (raw: string | undefined) => number;
}> {
  const mod = await import("../src/index.js");
  return mod;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set up mocks for the happy path */
function setupHappyPath(): void {
  mockAuthenticate.mockResolvedValue("test-access-token");
  const mockClient = { get: vi.fn() };
  mockCreateWhoopClient.mockReturnValue(mockClient);
  const mockServer = { connect: mockConnect };
  mockCreateWhoopServer.mockReturnValue({ server: mockServer });
  mockConnect.mockResolvedValue(undefined);
  MockStdioServerTransport.mockReturnValue(mockStdioTransportInstance);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("main() entry point", () => {
  const originalEnv = { ...process.env };
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    // Suppress console.error output during tests
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Set required env vars by default
    process.env.WHOOP_CLIENT_ID = "test-client-id";
    process.env.WHOOP_CLIENT_SECRET = "test-client-secret";
    // Silence logger output during tests (existing tests still validate console.error)
    process.env.LOG_LEVEL = "error";
    // Reset transport-related env vars so tests start from a clean slate
    delete process.env.MCP_TRANSPORT;
    delete process.env.MCP_PORT;
    delete process.env.MCP_AUTH_TOKEN;
    delete process.env.MCP_HOST;
    delete process.env.MCP_ALLOWED_ORIGINS;
    delete process.env.LOG_FORMAT;
    delete process.env.WHOOP_MCP_PRIVACY_MODE;
    delete process.env.WHOOP_RATE_LIMIT_PER_MINUTE;
  });

  afterEach(() => {
    // Restore env
    process.env = { ...originalEnv };
    consoleErrorSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Env var validation
  // -------------------------------------------------------------------------

  describe("environment variable validation", () => {
    it("validates privacy before authentication", async () => {
      process.env.WHOOP_MCP_PRIVACY_MODE = "raw";
      setupHappyPath();
      const { main } = await importMain();
      await expect(main()).rejects.toThrow();
      expect(mockAuthenticate).not.toHaveBeenCalled();
    });

    it("passes aggregate privacy to the server", async () => {
      process.env.WHOOP_MCP_PRIVACY_MODE = "aggregate";
      setupHappyPath();
      const { main } = await importMain();
      await main();
      expect(mockCreateWhoopServer).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ privacyMode: "aggregate" })
      );
    });

    it("throws when WHOOP_CLIENT_ID is missing", async () => {
      delete process.env.WHOOP_CLIENT_ID;
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow("WHOOP_CLIENT_ID");
    });

    it("throws when WHOOP_CLIENT_ID is empty string", async () => {
      process.env.WHOOP_CLIENT_ID = "";
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow("WHOOP_CLIENT_ID");
    });

    it("throws when WHOOP_CLIENT_SECRET is missing", async () => {
      delete process.env.WHOOP_CLIENT_SECRET;
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow("WHOOP_CLIENT_SECRET");
    });

    it("throws when WHOOP_CLIENT_SECRET is empty string", async () => {
      process.env.WHOOP_CLIENT_SECRET = "";
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow("WHOOP_CLIENT_SECRET");
    });
  });

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  describe("authentication", () => {
    it("calls authenticate with client ID and secret from env", async () => {
      setupHappyPath();

      const { main } = await importMain();
      await main();

      expect(mockAuthenticate).toHaveBeenCalledOnce();
      expect(mockAuthenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
        }),
        expect.objectContaining({ onTokens: expect.any(Function) })
      );
    });

    it("propagates authentication errors", async () => {
      setupHappyPath();
      mockAuthenticate.mockRejectedValue(new Error("OAuth flow failed"));

      const { main } = await importMain();
      await expect(main()).rejects.toThrow("OAuth flow failed");
    });
  });

  // -------------------------------------------------------------------------
  // Client creation
  // -------------------------------------------------------------------------

  describe("WHOOP client creation", () => {
    it("creates a WHOOP client with the access token from authenticate", async () => {
      setupHappyPath();
      mockAuthenticate.mockResolvedValue("my-access-token-123");

      const { main } = await importMain();
      await main();

      expect(mockCreateWhoopClient).toHaveBeenCalledOnce();
      expect(mockCreateWhoopClient).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "my-access-token-123",
        })
      );
    });

    it("provides an onTokenRefresh callback to the client", async () => {
      setupHappyPath();

      const { main } = await importMain();
      await main();

      const clientOptions = mockCreateWhoopClient.mock.calls[0][0] as {
        onTokenRefresh?: () => Promise<string>;
      };
      expect(clientOptions.onTokenRefresh).toBeTypeOf("function");
    });
  });

  // -------------------------------------------------------------------------
  // Token refresh callback
  // -------------------------------------------------------------------------

  describe("onTokenRefresh callback", () => {
    it("loads tokens, refreshes, saves, and returns new access token", async () => {
      setupHappyPath();

      const storedTokens = {
        access_token: "old-access",
        refresh_token: "stored-refresh-token",
        expires_at: Date.now() - 1000,
        token_type: "Bearer",
      };
      mockLoadTokens.mockResolvedValue(storedTokens);

      const refreshResponse = {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "read:recovery",
      };
      mockRefreshAccessToken.mockResolvedValue(refreshResponse);

      const newTokens = {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_at: Date.now() + 3_600_000,
        token_type: "Bearer",
      };
      mockToOAuthTokens.mockReturnValue(newTokens);
      mockSaveTokens.mockResolvedValue(undefined);

      const { main } = await importMain();
      await main();

      // Extract the onTokenRefresh callback
      const clientOptions = mockCreateWhoopClient.mock.calls[0][0] as {
        onTokenRefresh: () => Promise<string>;
      };
      const newAccessToken = await clientOptions.onTokenRefresh();

      expect(mockLoadTokens).toHaveBeenCalled();
      expect(mockRefreshAccessToken).toHaveBeenCalledWith(
        "stored-refresh-token",
        expect.objectContaining({
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
        })
      );
      expect(mockToOAuthTokens).toHaveBeenCalledWith(refreshResponse, "stored-refresh-token");
      expect(mockSaveTokens).toHaveBeenCalledWith(newTokens);
      expect(newAccessToken).toBe("new-access-token");
    });

    it("throws when no stored tokens are found", async () => {
      setupHappyPath();
      mockLoadTokens.mockResolvedValue(null);

      const { main } = await importMain();
      await main();

      const clientOptions = mockCreateWhoopClient.mock.calls[0][0] as {
        onTokenRefresh: () => Promise<string>;
      };
      await expect(clientOptions.onTokenRefresh()).rejects.toThrow(/no stored tokens/i);
    });

    it("removes every cache entry except history chunks on token refresh", async () => {
      setupHappyPath();

      const storedTokens = {
        access_token: "old-access",
        refresh_token: "stored-refresh-token",
        expires_at: Date.now() - 1000,
        token_type: "Bearer",
      };
      mockLoadTokens.mockResolvedValue(storedTokens);

      const refreshResponse = {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "read:recovery",
      };
      mockRefreshAccessToken.mockResolvedValue(refreshResponse);
      mockToOAuthTokens.mockReturnValue({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_at: Date.now() + 3_600_000,
        token_type: "Bearer",
      });
      mockSaveTokens.mockResolvedValue(undefined);

      const { main } = await importMain();
      await main();

      // The shared cache is constructed inside main() and passed to the client.
      const clientOptions = mockCreateWhoopClient.mock.calls[0][0] as {
        onTokenRefresh: () => Promise<string>;
        cache: import("../src/cache/memory-cache.js").MemoryCache;
      };
      const cache = clientOptions.cache;
      cache.set("GET:/v2/cycle?limit=1", { records: [] });
      cache.set("GET:/v2/user/profile/basic", { user_id: 1 });
      cache.set("HIST:v1:/v2/cycle:1788480000000", { records: [], complete: true });
      const clearSpy = vi.spyOn(cache, "clear");

      await clientOptions.onTokenRefresh();

      expect(clearSpy).not.toHaveBeenCalled();
      expect(cache.has("GET:/v2/cycle?limit=1")).toBe(false);
      expect(cache.has("GET:/v2/user/profile/basic")).toBe(false);
      expect(cache.has("HIST:v1:/v2/cycle:1788480000000")).toBe(true);
    });

    it("records refresh outcomes and the access token expiry in the runtime status", async () => {
      setupHappyPath();
      const expiresAt = Date.parse("2026-09-16T12:00:00Z");
      mockAuthenticate.mockImplementation(async (...args: unknown[]): Promise<string> => {
        const options = args[1] as { onTokens: (t: unknown) => void };
        options.onTokens({
          access_token: "A0",
          refresh_token: "R0",
          expires_at: expiresAt,
          token_type: "Bearer",
        });
        return "A0";
      });
      mockLoadTokens.mockResolvedValue({
        access_token: "A0",
        refresh_token: "R0",
        expires_at: Date.now() - 1000,
        token_type: "Bearer",
      });
      const { TokenRefreshError } = await import("../src/auth/token-refresh-error.js");
      mockRefreshAccessToken
        .mockRejectedValueOnce(new TokenRefreshError(503, "unavailable"))
        .mockResolvedValueOnce({ access_token: "A1", refresh_token: "R1", expires_in: 3600 })
        .mockRejectedValueOnce(new TokenRefreshError(400, "invalid_grant"));
      mockToOAuthTokens.mockReturnValue({
        access_token: "A1",
        refresh_token: "R1",
        expires_at: expiresAt + 3_600_000,
        token_type: "Bearer",
      });
      mockSaveTokens.mockResolvedValue(undefined);

      const { main } = await importMain();
      await main();

      const { runtimeStatus } = mockCreateWhoopServer.mock.calls[0][1] as {
        runtimeStatus: import("../src/runtime-status.js").RuntimeStatus;
      };
      const onTokenRefresh = (
        mockCreateWhoopClient.mock.calls[0][0] as { onTokenRefresh: () => Promise<string> }
      ).onTokenRefresh;
      expect(runtimeStatus.snapshot().whoop_auth).toEqual({
        access_token_expires_at: "2026-09-16T12:00:00.000Z",
        last_refresh: null,
      });

      await expect(onTokenRefresh()).rejects.toThrow("(503)");
      expect(runtimeStatus.snapshot().whoop_auth.last_refresh?.outcome).toBe("transient_failure");

      await expect(onTokenRefresh()).resolves.toBe("A1");
      expect(runtimeStatus.snapshot().whoop_auth).toMatchObject({
        access_token_expires_at: "2026-09-16T13:00:00.000Z",
        last_refresh: { outcome: "ok" },
      });

      await expect(onTokenRefresh()).rejects.toThrow("(400)");
      expect(runtimeStatus.snapshot().whoop_auth.last_refresh?.outcome).toBe("rejected");
      // Never token values
      expect(JSON.stringify(runtimeStatus.snapshot())).not.toMatch(/"A\d"|"R\d"/);
    });

    // R20: WHOOP rotates refresh tokens, so tokens it issued must never be lost
    // because saving them failed.
    describe("when saving refreshed tokens fails", () => {
      const tokens = (n: number, expiresAt: number): Record<string, unknown> => ({
        access_token: `A${n}`,
        refresh_token: `R${n}`,
        expires_at: expiresAt,
        token_type: "Bearer",
      });

      /** Fake WHOOP: each refresh token works once and yields the next pair. */
      function rotatingWhoop(): void {
        mockRefreshAccessToken.mockImplementation(async (refreshToken: string) => {
          const n = Number(refreshToken.slice(1)) + 1;
          return { access_token: `A${n}`, refresh_token: `R${n}`, expires_in: 3600 };
        });
        let clock = Date.now();
        mockToOAuthTokens.mockImplementation((response: { access_token: string }) => {
          clock += 1000;
          const n = Number(response.access_token.slice(1));
          return tokens(n, clock + 3_600_000);
        });
      }

      async function startAndGetRefresh(): Promise<() => Promise<string>> {
        const { main } = await importMain();
        await main();
        const clientOptions = mockCreateWhoopClient.mock.calls[0][0] as {
          onTokenRefresh: () => Promise<string>;
        };
        return clientOptions.onTokenRefresh;
      }

      it("still returns the new access token, logs only the error code, and refreshes from the kept tokens", async () => {
        setupHappyPath();
        rotatingWhoop();
        // Disk keeps R0: every save fails like a rename onto a bind-mounted file
        mockLoadTokens.mockResolvedValue(tokens(0, Date.now() - 1000));
        mockSaveTokens.mockRejectedValue(
          Object.assign(new Error("EBUSY: rename '/home/node/.whoop-mcp/tokens.json.tmp'"), {
            code: "EBUSY",
          })
        );
        const stderr: string[] = [];
        const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
          stderr.push(String(chunk));
          return true;
        });

        try {
          const onTokenRefresh = await startAndGetRefresh();

          await expect(onTokenRefresh()).resolves.toBe("A1");
          await expect(onTokenRefresh()).resolves.toBe("A2");
        } finally {
          writeSpy.mockRestore();
        }

        expect(mockRefreshAccessToken.mock.calls.map((c) => c[0])).toEqual(["R0", "R1"]);
        const log = stderr.join("");
        expect(log).toContain("whoop token save failed");
        expect(log).toContain("EBUSY");
        expect(log).not.toContain("/home/node");
        expect(log).not.toMatch(/"R\d"|"A\d"/);
      });

      it("prefers newer tokens on disk (e.g. written by setup --verify) over the kept ones", async () => {
        setupHappyPath();
        rotatingWhoop();
        mockLoadTokens.mockResolvedValueOnce(tokens(0, Date.now() - 1000));
        mockSaveTokens.mockRejectedValue(Object.assign(new Error("EPERM"), { code: "EPERM" }));

        const onTokenRefresh = await startAndGetRefresh();
        await onTokenRefresh(); // keeps A1/R1 in memory, disk still R0

        mockLoadTokens.mockResolvedValueOnce(tokens(40, Date.now() + 10 * 3_600_000));
        await expect(onTokenRefresh()).resolves.toBe("A41");
        expect(mockRefreshAccessToken.mock.calls.map((c) => c[0])).toEqual(["R0", "R40"]);
      });

      it("refreshes from the tokens authenticate() obtained when they never reached disk", async () => {
        setupHappyPath();
        rotatingWhoop();
        mockAuthenticate.mockImplementation(async (...args: unknown[]): Promise<string> => {
          const options = args[1] as { onTokens: (t: unknown) => void };
          options.onTokens(tokens(7, Date.now() + 3_600_000));
          return "A7";
        });
        mockLoadTokens.mockResolvedValue(tokens(6, Date.now() - 1000));
        mockSaveTokens.mockResolvedValue(undefined);

        const onTokenRefresh = await startAndGetRefresh();

        await expect(onTokenRefresh()).resolves.toBe("A8");
        expect(mockRefreshAccessToken).toHaveBeenCalledWith("R7", expect.anything());
      });
    });

    // R24: a restart must reach the sign-in flow after WHOOP rejected the refresh
    // token, even while the cached access token has not expired yet.
    describe("when WHOOP rejects the refresh token", () => {
      const stored = {
        access_token: "A0",
        refresh_token: "R0",
        expires_at: Date.now() + 50 * 60_000,
        token_type: "Bearer",
      };

      async function refreshFn(): Promise<() => Promise<string>> {
        const { main } = await importMain();
        await main();
        return (mockCreateWhoopClient.mock.calls[0][0] as { onTokenRefresh: () => Promise<string> })
          .onTokenRefresh;
      }

      it("marks the stored tokens expired so the next start signs in again", async () => {
        setupHappyPath();
        mockLoadTokens.mockResolvedValue(stored);
        mockSaveTokens.mockResolvedValue(undefined);
        const { TokenRefreshError } = await import("../src/auth/token-refresh-error.js");
        const rejection = new TokenRefreshError(400, "invalid_grant");
        mockRefreshAccessToken.mockRejectedValue(rejection);

        const onTokenRefresh = await refreshFn();

        await expect(onTokenRefresh()).rejects.toBe(rejection);
        expect(mockSaveTokens).toHaveBeenCalledOnce();
        expect(mockSaveTokens).toHaveBeenCalledWith({ ...stored, expires_at: 0 });
      });

      it("leaves the stored tokens alone on a network failure", async () => {
        setupHappyPath();
        mockLoadTokens.mockResolvedValue(stored);
        const { WhoopNetworkError } = await import("../src/api/client.js");
        mockRefreshAccessToken.mockRejectedValue(new WhoopNetworkError(new TypeError("fetch")));

        const onTokenRefresh = await refreshFn();

        await expect(onTokenRefresh()).rejects.toBeInstanceOf(WhoopNetworkError);
        expect(mockSaveTokens).not.toHaveBeenCalled();
      });

      it.each([429, 500, 503])(
        "keeps every token after a transient %i from the token endpoint",
        async (status) => {
          setupHappyPath();
          const { TokenRefreshError } = await import("../src/auth/token-refresh-error.js");
          mockLoadTokens.mockResolvedValue(stored);
          mockRefreshAccessToken.mockRejectedValue(new TokenRefreshError(status, "unavailable"));

          const onTokenRefresh = await refreshFn();

          await expect(onTokenRefresh()).rejects.toThrow(`(${status})`);
          expect(mockSaveTokens).not.toHaveBeenCalled();
        }
      );

      it("keeps a rotated in-memory refresh token through a transient 503 after a failed save", async () => {
        setupHappyPath();
        const { TokenRefreshError } = await import("../src/auth/token-refresh-error.js");
        mockLoadTokens.mockResolvedValue({ ...stored, expires_at: Date.now() - 1000 });
        mockSaveTokens.mockRejectedValue(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));
        mockToOAuthTokens.mockImplementation(
          (response: { access_token: string; refresh_token: string }) => ({
            access_token: response.access_token,
            refresh_token: response.refresh_token,
            expires_at: Date.now() + 3_600_000,
            token_type: "Bearer",
          })
        );
        mockRefreshAccessToken
          .mockResolvedValueOnce({ access_token: "A1", refresh_token: "R1", expires_in: 3600 })
          .mockRejectedValueOnce(new TokenRefreshError(503, "unavailable"))
          .mockResolvedValueOnce({ access_token: "A2", refresh_token: "R2", expires_in: 3600 });

        const onTokenRefresh = await refreshFn();

        await expect(onTokenRefresh()).resolves.toBe("A1"); // save failed: R1 only in memory
        await expect(onTokenRefresh()).rejects.toThrow("(503)");
        await expect(onTokenRefresh()).resolves.toBe("A2");
        expect(mockRefreshAccessToken.mock.calls.map((call) => call[0])).toEqual([
          "R0",
          "R1",
          "R1",
        ]);
      });

      it("does not mark newer tokens another process saved meanwhile", async () => {
        setupHappyPath();
        const newer = { ...stored, refresh_token: "R9", expires_at: stored.expires_at + 60_000 };
        mockLoadTokens.mockResolvedValueOnce(stored).mockResolvedValueOnce(newer);
        const { TokenRefreshError } = await import("../src/auth/token-refresh-error.js");
        mockRefreshAccessToken.mockRejectedValue(new TokenRefreshError(400, "invalid_grant"));

        const onTokenRefresh = await refreshFn();

        await expect(onTokenRefresh()).rejects.toThrow("Token refresh failed");
        expect(mockSaveTokens).not.toHaveBeenCalled();
      });
    });
  });

  // -------------------------------------------------------------------------
  // MCP server creation and transport
  // -------------------------------------------------------------------------

  describe("MCP server and stdio transport", () => {
    it("creates the MCP server with the WHOOP client", async () => {
      setupHappyPath();
      const mockClient = { get: vi.fn() };
      mockCreateWhoopClient.mockReturnValue(mockClient);

      const { main } = await importMain();
      await main();

      expect(mockCreateWhoopServer).toHaveBeenCalledOnce();
      expect(mockCreateWhoopServer).toHaveBeenCalledWith(mockClient, {
        disableResources: false,
        privacyMode: "standard",
        historyCache: expect.any(Object),
        runtimeStatus: expect.objectContaining({ snapshot: expect.any(Function) }),
        logger: expect.objectContaining({ warn: expect.any(Function) }),
      });
      // The history cache is the client's shared cache
      const clientOptions = mockCreateWhoopClient.mock.calls[0][0] as { cache: unknown };
      const serverOptions = mockCreateWhoopServer.mock.calls[0][1] as { historyCache: unknown };
      expect(serverOptions.historyCache).toBe(clientOptions.cache);
    });

    it("gives the client a rate limiter whose counters the runtime status reports", async () => {
      setupHappyPath();

      const { main } = await importMain();
      await main();

      const { rateLimiter } = mockCreateWhoopClient.mock.calls[0][0] as {
        rateLimiter: import("../src/api/rate-limiter.js").RateLimiter;
      };
      const { runtimeStatus } = mockCreateWhoopServer.mock.calls[0][1] as {
        runtimeStatus: import("../src/runtime-status.js").RuntimeStatus;
      };
      (await rateLimiter.acquire())();
      expect(runtimeStatus.snapshot().whoop_api.requests_last_minute).toBe(1);
      expect(runtimeStatus.snapshot().privacy_mode).toBe("standard");
    });

    it("creates a StdioServerTransport", async () => {
      setupHappyPath();

      const { main } = await importMain();
      await main();

      expect(MockStdioServerTransport).toHaveBeenCalledOnce();
    });

    it("connects the server to the stdio transport", async () => {
      setupHappyPath();

      const { main } = await importMain();
      await main();

      expect(mockConnect).toHaveBeenCalledOnce();
      expect(mockConnect).toHaveBeenCalledWith(mockStdioTransportInstance);
    });
  });

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  describe("stderr logging", () => {
    it("logs startup message to stderr", async () => {
      setupHappyPath();

      const { main } = await importMain();
      await main();

      // At least one call to console.error with startup info
      const allMessages = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join(" ");
      expect(allMessages).toMatch(/whoop.*mcp.*start/i);
    });
  });

  // -------------------------------------------------------------------------
  // Transport selection (MCP_TRANSPORT)
  // -------------------------------------------------------------------------

  describe("transport selection", () => {
    function setupHttpHappyPath(): void {
      const mockTransport = { _http: true };
      mockCreateHttpServer.mockResolvedValue({
        server: {},
        transport: mockTransport,
        close: mockHttpClose,
      });
    }

    it("defaults to stdio transport when MCP_TRANSPORT is unset", async () => {
      setupHappyPath();
      const { main } = await importMain();
      await main();

      expect(MockStdioServerTransport).toHaveBeenCalledOnce();
      expect(mockCreateHttpServer).not.toHaveBeenCalled();
    });

    it("explicit MCP_TRANSPORT=stdio behaves identically to default", async () => {
      process.env.MCP_TRANSPORT = "stdio";
      setupHappyPath();
      const { main } = await importMain();
      await main();

      expect(MockStdioServerTransport).toHaveBeenCalledOnce();
      expect(mockCreateHttpServer).not.toHaveBeenCalled();
    });

    it("MCP_TRANSPORT=http starts only the HTTP server (no stdio)", async () => {
      process.env.MCP_TRANSPORT = "http";
      process.env.MCP_AUTH_TOKEN = "test-bearer-token-32chars-aaaa";
      process.env.MCP_PORT = "4001";
      setupHappyPath();
      setupHttpHappyPath();

      const { main } = await importMain();
      await main();

      expect(MockStdioServerTransport).not.toHaveBeenCalled();
      expect(mockCreateHttpServer).toHaveBeenCalledOnce();
      expect(mockCreateHttpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          authToken: "test-bearer-token-32chars-aaaa",
          port: 4001,
        })
      );
      // HTTP builds a fresh server per request instead of connecting a shared one
      expect(mockConnect).not.toHaveBeenCalled();
      const [{ createMcpServer }] = mockCreateHttpServer.mock.calls[0] as [
        { createMcpServer: () => unknown },
      ];
      const serversBefore = mockCreateWhoopServer.mock.calls.length;
      expect(createMcpServer()).toEqual({ connect: mockConnect });
      expect(mockCreateWhoopServer).toHaveBeenCalledTimes(serversBefore + 1);
      // Every per-request server shares the process-wide cache, status and logger
      const perRequest = mockCreateWhoopServer.mock.calls[serversBefore]![1] as Record<
        string,
        unknown
      >;
      const clientOptions = mockCreateWhoopClient.mock.calls[0][0] as { cache: unknown };
      expect(perRequest.historyCache).toBe(clientOptions.cache);
      expect(perRequest.runtimeStatus).toBeDefined();
      expect(perRequest.logger).toBeDefined();
    });

    it("MCP_TRANSPORT=both starts both stdio AND HTTP", async () => {
      process.env.MCP_TRANSPORT = "both";
      process.env.MCP_AUTH_TOKEN = "test-bearer-token-32chars-aaaa";
      setupHappyPath();
      setupHttpHappyPath();

      const { main } = await importMain();
      await main();

      expect(MockStdioServerTransport).toHaveBeenCalledOnce();
      expect(mockCreateHttpServer).toHaveBeenCalledOnce();
      // server.connect called once for stdio; HTTP creates servers per request
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it("uses default port 3000 when MCP_PORT is unset", async () => {
      process.env.MCP_TRANSPORT = "http";
      process.env.MCP_AUTH_TOKEN = "tok";
      setupHappyPath();
      setupHttpHappyPath();

      const { main } = await importMain();
      await main();

      expect(mockCreateHttpServer).toHaveBeenCalledWith(expect.objectContaining({ port: 3000 }));
    });

    it("forwards MCP_HOST and MCP_ALLOWED_ORIGINS to the HTTP server", async () => {
      process.env.MCP_TRANSPORT = "http";
      process.env.MCP_AUTH_TOKEN = "tok";
      process.env.MCP_HOST = "127.0.0.1";
      process.env.MCP_ALLOWED_ORIGINS = "https://claude.ai, https://app.example.com";
      setupHappyPath();
      setupHttpHappyPath();

      const { main } = await importMain();
      await main();

      expect(mockCreateHttpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "127.0.0.1",
          allowedOrigins: ["https://claude.ai", "https://app.example.com"],
        })
      );
    });

    it("MCP_TRUST_PROXY=1 enables trustProxy on the HTTP server", async () => {
      process.env.MCP_TRANSPORT = "http";
      process.env.MCP_AUTH_TOKEN = "tok";
      process.env.MCP_TRUST_PROXY = "1";
      setupHappyPath();
      setupHttpHappyPath();

      const { main } = await importMain();
      await main();
      delete process.env.MCP_TRUST_PROXY;

      expect(mockCreateHttpServer).toHaveBeenCalledWith(
        expect.objectContaining({ trustProxy: true })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Configuration validation errors
  // -------------------------------------------------------------------------

  describe("configuration validation", () => {
    it("throws on invalid MCP_TRANSPORT value", async () => {
      process.env.MCP_TRANSPORT = "websocket";
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow(/MCP_TRANSPORT/);
    });

    it("throws when MCP_TRANSPORT=http but MCP_AUTH_TOKEN is missing", async () => {
      process.env.MCP_TRANSPORT = "http";
      delete process.env.MCP_AUTH_TOKEN;
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow(/MCP_AUTH_TOKEN/);
    });

    it("throws on non-numeric MCP_PORT", async () => {
      process.env.MCP_TRANSPORT = "http";
      process.env.MCP_AUTH_TOKEN = "tok";
      process.env.MCP_PORT = "abc";
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow(/MCP_PORT/);
    });

    it("throws on out-of-range MCP_PORT", async () => {
      process.env.MCP_TRANSPORT = "http";
      process.env.MCP_AUTH_TOKEN = "tok";
      process.env.MCP_PORT = "99999";
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow(/MCP_PORT/);
    });

    it("throws on invalid LOG_LEVEL", async () => {
      process.env.LOG_LEVEL = "verbose";
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow(/LOG_LEVEL/);
    });

    it("throws on invalid LOG_FORMAT", async () => {
      process.env.LOG_FORMAT = "yaml";
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow(/LOG_FORMAT/);
    });

    it("throws on an invalid WHOOP_RATE_LIMIT_PER_MINUTE before authenticating", async () => {
      process.env.WHOOP_RATE_LIMIT_PER_MINUTE = "100";
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).rejects.toThrow(/WHOOP_RATE_LIMIT_PER_MINUTE/);
      expect(mockAuthenticate).not.toHaveBeenCalled();
    });

    it("parses WHOOP_RATE_LIMIT_PER_MINUTE as an integer 10-95, default 60", async () => {
      const { parseRateLimitPerMinute } = await importMain();
      expect(parseRateLimitPerMinute(undefined)).toBe(60);
      expect(parseRateLimitPerMinute(" ")).toBe(60);
      expect(parseRateLimitPerMinute("10")).toBe(10);
      expect(parseRateLimitPerMinute(" 95 ")).toBe(95);
      for (const invalid of ["9", "96", "60.5", "1e2", "-20", "abc", "0x3c"]) {
        expect(() => parseRateLimitPerMinute(invalid)).toThrow(/WHOOP_RATE_LIMIT_PER_MINUTE/);
      }
    });

    it("accepts LOG_LEVEL=debug", async () => {
      process.env.LOG_LEVEL = "debug";
      setupHappyPath();

      const { main } = await importMain();
      await expect(main()).resolves.toBeUndefined();
    });
  });
});
