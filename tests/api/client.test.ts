import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  WhoopApiError,
  WhoopNetworkError,
  WhoopAuthError,
  createWhoopClient,
  describeWhoopError,
} from "../../src/api/client.js";
import type { WhoopClient } from "../../src/api/client.js";
import { TokenRefreshError } from "../../src/auth/token-refresh-error.js";

// ---------------------------------------------------------------------------
// Task 4a: WhoopApiError
// ---------------------------------------------------------------------------

describe("WhoopApiError", () => {
  it("extends Error", () => {
    const error = new WhoopApiError(401, "Unauthorized", { message: "Invalid token" });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(WhoopApiError);
  });

  it("has name 'WhoopApiError'", () => {
    const error = new WhoopApiError(500, "Internal Server Error", null);

    expect(error.name).toBe("WhoopApiError");
  });

  it("carries statusCode, statusText, and body", () => {
    const body = { error: "rate_limited", retry_after: 30 };
    const error = new WhoopApiError(429, "Too Many Requests", body);

    expect(error.statusCode).toBe(429);
    expect(error.statusText).toBe("Too Many Requests");
    expect(error.body).toEqual(body);
  });

  it("has a human-readable message", () => {
    const error = new WhoopApiError(401, "Unauthorized", null);

    expect(error.message).toBe("WHOOP API error: 401 Unauthorized");
  });
});

// ---------------------------------------------------------------------------
// describeWhoopError: user-facing messages
// ---------------------------------------------------------------------------

describe("describeWhoopError", () => {
  it("tells the user to retry, not to sign in again, after a transient token-endpoint failure", () => {
    expect(
      describeWhoopError(new WhoopAuthError(new TokenRefreshError(503, "unavailable")))
    ).toMatch(/temporarily unavailable.*still valid/);
    expect(describeWhoopError(new WhoopAuthError(new TokenRefreshError(429, "slow down")))).toMatch(
      /rate-limited.*still valid/
    );
    expect(
      describeWhoopError(new WhoopAuthError(new TokenRefreshError(400, "invalid_grant")))
    ).toMatch(/sign in again/);
  });

  it.each([401, 400])(
    "blames the app's client credentials, not the sign-in, for HTTP %i invalid_client",
    (status) => {
      const error = new WhoopAuthError(
        new TokenRefreshError(status, "Client SECRET-DESCRIPTION failed", "invalid_client")
      );
      const expected = `WHOOP rejected this app's client credentials (HTTP ${status} invalid_client). Check WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET; your WHOOP sign-in itself is still valid.`;

      expect(describeWhoopError(error)).toBe(expected);
      // Also when a composite tool rethrows it wrapped in a network error
      expect(describeWhoopError(new WhoopNetworkError(error))).toBe(expected);
      expect(describeWhoopError(error)).not.toMatch(
        /sign in again|tokens\.json|SECRET-DESCRIPTION/
      );
    }
  );

  it("still asks for a new sign-in when invalid_grant carries its error code", () => {
    expect(
      describeWhoopError(new WhoopAuthError(new TokenRefreshError(400, "d", "invalid_grant")))
    ).toMatch(/sign in again/);
  });

  const SECRET_BODY = { error_description: "token abc.def.ghi for jane@example.com", hrv: 61.2 };

  it.each([
    [400, "Bad Request", ["HTTP 400", "rejected the request parameters", "ids and dates"]],
    [401, "Unauthorized", ["HTTP 401", "authorization", "setup --verify"]],
    [403, "Forbidden", ["HTTP 403", "denied access", "setup --verify"]],
    [404, "Not Found", ["HTTP 404", "no matching record", "ids and dates"]],
    [422, "Unprocessable Entity", ["HTTP 422", "rejected the request", "ids and dates"]],
    [429, "Too Many Requests", ["HTTP 429", "rate limit", "retry"]],
    [500, "Internal Server Error", ["HTTP 500", "unavailable", "Retry later"]],
    [503, "Service Unavailable", ["HTTP 503", "unavailable", "Retry later"]],
  ])("describes WHOOP %i responses", (status, statusText, phrases) => {
    const message = describeWhoopError(new WhoopApiError(status, statusText, SECRET_BODY));

    for (const phrase of phrases) {
      expect(message).toContain(phrase);
    }
  });

  it("never includes the response body or status text", () => {
    for (const status of [400, 401, 403, 404, 429, 500]) {
      const message = describeWhoopError(
        new WhoopApiError(status, "Custom status text", JSON.stringify(SECRET_BODY))
      );
      expect(message).not.toContain("abc.def.ghi");
      expect(message).not.toContain("jane@example.com");
      expect(message).not.toContain("61.2");
      expect(message).not.toContain("Custom status text");
    }
  });

  it("does not tell the user to retry 400 or 404 responses", () => {
    expect(describeWhoopError(new WhoopApiError(400, "Bad Request", null))).not.toMatch(/retry/i);
    expect(describeWhoopError(new WhoopApiError(404, "Not Found", null))).not.toMatch(/retry/i);
  });

  it("describes a failed token refresh as an authentication problem", () => {
    const message = describeWhoopError(new WhoopAuthError(new Error("invalid_grant secret")));

    expect(message).toContain("authentication failed");
    expect(message).toContain("setup --verify");
    expect(message).not.toContain("secret");
  });

  // R24: the advice must match how the server actually signs in again. It runs
  // the WHOOP authorization flow only at startup (or in a local setup --verify),
  // when tokens.json is missing or its expired access token cannot be refreshed.
  it("tells the user to restart the server (local or hosted) after a failed refresh", () => {
    const message = describeWhoopError(new WhoopAuthError(new Error("invalid_grant")));

    expect(message).toContain("restart the server");
    expect(message).toContain("authorization link in the server logs");
    expect(message).toContain("hosted server");
    // Fallback when the stored tokens could not be marked expired
    expect(message).toContain("delete tokens.json");
    expect(message).not.toContain("to reconnect");
  });

  it.each([401, 403])(
    "tells the user to delete tokens.json and restart for HTTP %i (refreshing cannot fix it)",
    (status) => {
      const message = describeWhoopError(new WhoopApiError(status, "x", null)) ?? "";

      expect(message).toMatch(/delete tokens\.json .*then restart the server/);
      expect(message).toContain("~/.whoop-mcp");
      expect(message).toContain("mounted volume");
      expect(message).toContain("authorization link in the server logs");
    }
  );

  it("describes an unreadable response body separately from an unreachable API", () => {
    expect(describeWhoopError(new WhoopNetworkError(new SyntaxError("Unexpected token")))).toBe(
      "WHOOP API returned an unreadable response. Retry later."
    );
  });

  it("describes a token refresh that could not reach WHOOP as a network problem", () => {
    const message = describeWhoopError(
      new WhoopAuthError(new WhoopNetworkError(new TypeError("fetch failed")))
    );

    expect(message).toContain("Network error");
    expect(message).not.toContain("setup --verify");
  });

  it("describes network failures and timeouts", () => {
    expect(describeWhoopError(new WhoopNetworkError(new TypeError("fetch failed")))).toBe(
      "Network error: Unable to reach the WHOOP API. Check your internet connection."
    );
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    expect(describeWhoopError(new WhoopNetworkError(timeout))).toContain("did not respond in time");
  });

  it("describes a network error wrapping an API or auth error by that error", () => {
    expect(
      describeWhoopError(new WhoopNetworkError(new WhoopApiError(429, "Too Many Requests", null)))
    ).toContain("rate limit");
    expect(describeWhoopError(new WhoopNetworkError(new WhoopAuthError(new Error("x"))))).toContain(
      "authentication failed"
    );
  });

  it("returns undefined for errors that are not WHOOP client errors", () => {
    expect(describeWhoopError(new Error("boom"))).toBeUndefined();
    expect(describeWhoopError(new RangeError("Invalid time value"))).toBeUndefined();
    expect(describeWhoopError("a string")).toBeUndefined();
    expect(describeWhoopError(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Task 4b: createWhoopClient + successful GET
// ---------------------------------------------------------------------------

describe("createWhoopClient", () => {
  const TEST_BASE_URL = "https://test.whoop.api";
  const TEST_TOKEN = "test_access_token_abc123";

  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Helper to create a mock Response for successful JSON responses */
  function mockJsonResponse(data: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    } as Response;
  }

  describe("get (happy path)", () => {
    it("calls fetch with the correct URL (baseUrl + path)", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ user_id: 1 }));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await client.get("/v2/user/profile/basic");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://test.whoop.api/v2/user/profile/basic",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("sends Authorization: Bearer <token> header", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({}));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await client.get("/v2/recovery");

      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1].headers as Record<string, string>;
      expect(headers["Authorization"]).toBe(`Bearer ${TEST_TOKEN}`);
    });

    it("sends Content-Type: application/json header", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({}));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await client.get("/v2/recovery");

      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1].headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("parses and returns the JSON response body", async () => {
      const responseData = {
        user_id: 10129,
        email: "test@whoop.com",
        first_name: "Test",
        last_name: "User",
      };
      mockFetch.mockResolvedValue(mockJsonResponse(responseData));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      const result = await client.get<{ user_id: number; email: string }>("/v2/user/profile/basic");

      expect(result.user_id).toBe(10129);
      expect(result.email).toBe("test@whoop.com");
    });

    it("defaults to WHOOP_API_BASE_URL when baseUrl not provided", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({}));
      const client = createWhoopClient({ accessToken: TEST_TOKEN });

      await client.get("/v2/recovery");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.prod.whoop.com/developer/v2/recovery",
        expect.anything()
      );
    });

    it("sends AbortSignal.timeout for request timeout", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ ok: true }));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await client.get("/v2/recovery");

      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(callArgs[1].signal).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Task 4c: Error handling — non-2xx responses
  // -------------------------------------------------------------------------

  describe("get (error responses)", () => {
    /** Helper to create a mock error Response with JSON body */
    function mockErrorResponse(status: number, statusText: string, body: unknown): Response {
      return {
        ok: false,
        status,
        statusText,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      } as Response;
    }

    it("throws WhoopApiError on 401 Unauthorized", async () => {
      mockFetch.mockResolvedValue(
        mockErrorResponse(401, "Unauthorized", { message: "Invalid token" })
      );
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await expect(client.get("/v2/recovery")).rejects.toThrow(WhoopApiError);

      try {
        await client.get("/v2/recovery");
      } catch (error) {
        expect(error).toBeInstanceOf(WhoopApiError);
        const apiError = error as WhoopApiError;
        expect(apiError.statusCode).toBe(401);
        expect(apiError.statusText).toBe("Unauthorized");
        expect(apiError.body).toEqual({ message: "Invalid token" });
      }
    });

    it("throws WhoopApiError on 429 Too Many Requests (after retries)", async () => {
      vi.useFakeTimers();
      const response429 = {
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: { get: () => null },
        json: () => Promise.resolve({ retry_after: 30 }),
        text: () => Promise.resolve('{"retry_after":30}'),
      } as unknown as Response;
      mockFetch
        .mockResolvedValueOnce(response429)
        .mockResolvedValueOnce(response429)
        .mockResolvedValueOnce(response429)
        .mockResolvedValueOnce(response429);
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      const promise = client.get("/v2/recovery");
      // Prevent PromiseRejectionHandledWarning — rejection is handled below
      promise.catch(() => {});
      // Advance through all retries
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);

      try {
        await promise;
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WhoopApiError);
        const apiError = error as WhoopApiError;
        expect(apiError.statusCode).toBe(429);
        expect(apiError.body).toEqual({ retry_after: 30 });
      }
      vi.useRealTimers();
    });

    it("throws WhoopApiError on 500 Internal Server Error", async () => {
      mockFetch.mockResolvedValue(
        mockErrorResponse(500, "Internal Server Error", { error: "unexpected" })
      );
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await expect(client.get("/v2/recovery")).rejects.toThrow(WhoopApiError);

      try {
        await client.get("/v2/recovery");
      } catch (error) {
        const apiError = error as WhoopApiError;
        expect(apiError.statusCode).toBe(500);
        expect(apiError.statusText).toBe("Internal Server Error");
      }
    });

    it("includes status code and text in error message", async () => {
      mockFetch.mockResolvedValue(mockErrorResponse(403, "Forbidden", null));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await expect(client.get("/v2/recovery")).rejects.toThrow("WHOOP API error: 403 Forbidden");
    });

    it("falls back to text body when error response is not valid JSON", async () => {
      const htmlBody = "<html>Service Unavailable</html>";
      const response = {
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        json: () => Promise.reject(new SyntaxError("Unexpected token")),
        text: () => Promise.resolve(htmlBody),
      } as Response;
      mockFetch.mockResolvedValue(response);
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      try {
        await client.get("/v2/recovery");
        expect.fail("should have thrown");
      } catch (error) {
        const apiError = error as WhoopApiError;
        expect(apiError.statusCode).toBe(503);
        expect(apiError.body).toBe(htmlBody);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Task 8b: 429 retry with backoff
  // -------------------------------------------------------------------------

  describe("get (429 retry)", () => {
    /** Helper to create a 429 response with optional Retry-After header */
    function mock429Response(retryAfter?: string): Response {
      const headers = new Map<string, string>();
      if (retryAfter !== undefined) {
        headers.set("retry-after", retryAfter);
      }
      return {
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
        json: () => Promise.resolve({ error: "rate_limited" }),
        text: () => Promise.resolve("rate limited"),
      } as unknown as Response;
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries on 429 and succeeds on 2nd attempt", async () => {
      mockFetch
        .mockResolvedValueOnce(mock429Response())
        .mockResolvedValueOnce(mockJsonResponse({ user_id: 1 }));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      const promise = client.get<{ user_id: number }>("/v2/recovery");
      await vi.advanceTimersByTimeAsync(1000);

      const result = await promise;
      expect(result.user_id).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("retries on 429 and succeeds on 3rd attempt", async () => {
      mockFetch
        .mockResolvedValueOnce(mock429Response())
        .mockResolvedValueOnce(mock429Response())
        .mockResolvedValueOnce(mockJsonResponse({ ok: true }));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      const promise = client.get("/v2/recovery");
      await vi.advanceTimersByTimeAsync(1000); // 1st retry
      await vi.advanceTimersByTimeAsync(2000); // 2nd retry

      const result = await promise;
      expect(result).toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("throws WhoopApiError after max retries exhausted", async () => {
      mockFetch
        .mockResolvedValueOnce(mock429Response())
        .mockResolvedValueOnce(mock429Response())
        .mockResolvedValueOnce(mock429Response())
        .mockResolvedValueOnce(mock429Response());
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      const promise = client.get("/v2/recovery");
      // Prevent PromiseRejectionHandledWarning — rejection is handled below
      promise.catch(() => {});
      // Advance through all 3 retry delays: 1s, 2s, 4s
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);

      try {
        await promise;
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WhoopApiError);
        expect((error as WhoopApiError).statusCode).toBe(429);
      }
      // 1 initial + 3 retries = 4 total calls
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it("respects Retry-After header (seconds)", async () => {
      mockFetch
        .mockResolvedValueOnce(mock429Response("5"))
        .mockResolvedValueOnce(mockJsonResponse({ ok: true }));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      const promise = client.get("/v2/recovery");

      // Should not resolve before 5 seconds
      await vi.advanceTimersByTimeAsync(4000);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Should resolve after 5 seconds
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;
      expect(result).toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("caps Retry-After to 60 seconds maximum", async () => {
      // Server says wait 999999 seconds — should be capped to 60s
      mockFetch
        .mockResolvedValueOnce(mock429Response("999999"))
        .mockResolvedValueOnce(mockJsonResponse({ ok: true }));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      const promise = client.get("/v2/recovery");

      // Should not resolve before 60 seconds
      await vi.advanceTimersByTimeAsync(59_000);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Should resolve at 60 seconds (the cap), not 999999 seconds
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;
      expect(result).toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry on non-429 errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () => Promise.resolve({ error: "server_error" }),
        text: () => Promise.resolve("server error"),
      } as unknown as Response);
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await expect(client.get("/v2/recovery")).rejects.toThrow(WhoopApiError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("uses exponential backoff: 1s, 2s, 4s", async () => {
      mockFetch
        .mockResolvedValueOnce(mock429Response()) // initial call
        .mockResolvedValueOnce(mock429Response()) // retry 1
        .mockResolvedValueOnce(mock429Response()) // retry 2
        .mockResolvedValueOnce(mock429Response()); // retry 3 (still fails)
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      const promise = client.get("/v2/recovery");
      // Prevent PromiseRejectionHandledWarning — rejection is handled below
      promise.catch(() => {});

      // After 999ms: only 1 call (initial)
      await vi.advanceTimersByTimeAsync(999);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // After 1s: retry 1 fires
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // After 2s more: retry 2 fires
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockFetch).toHaveBeenCalledTimes(3);

      // After 4s more: retry 3 fires
      await vi.advanceTimersByTimeAsync(4000);
      expect(mockFetch).toHaveBeenCalledTimes(4);

      // All retries exhausted → throws
      try {
        await promise;
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WhoopApiError);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Task 4d + Task 8a: Network errors
  // -------------------------------------------------------------------------

  describe("get (network errors)", () => {
    it("wraps network errors in WhoopNetworkError", async () => {
      mockFetch.mockRejectedValue(new TypeError("fetch failed"));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await expect(client.get("/v2/recovery")).rejects.toThrow(WhoopNetworkError);
    });

    it("WhoopNetworkError has a user-friendly message", async () => {
      mockFetch.mockRejectedValue(new TypeError("fetch failed"));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await expect(client.get("/v2/recovery")).rejects.toThrow(
        "Network error: Unable to reach the WHOOP API. Check your internet connection."
      );
    });

    it("WhoopNetworkError preserves the original error as cause", async () => {
      const originalError = new TypeError("fetch failed");
      mockFetch.mockRejectedValue(originalError);
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      try {
        await client.get("/v2/recovery");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WhoopNetworkError);
        expect((error as WhoopNetworkError).cause).toBe(originalError);
      }
    });

    it("WhoopNetworkError has name 'WhoopNetworkError'", async () => {
      mockFetch.mockRejectedValue(new TypeError("fetch failed"));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      try {
        await client.get("/v2/recovery");
        expect.fail("should have thrown");
      } catch (error) {
        expect((error as WhoopNetworkError).name).toBe("WhoopNetworkError");
      }
    });

    it("wraps non-TypeError network errors too", async () => {
      mockFetch.mockRejectedValue(new Error("DNS resolution failed"));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await expect(client.get("/v2/recovery")).rejects.toThrow(WhoopNetworkError);
    });

    it("does not wrap WhoopApiError as WhoopNetworkError", async () => {
      // Simulate a case where response processing throws a WhoopApiError
      // (this shouldn't be wrapped in network error)
      const apiError = new WhoopApiError(500, "Internal Server Error", null);
      mockFetch.mockRejectedValue(apiError);
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      await expect(client.get("/v2/recovery")).rejects.toThrow(WhoopApiError);
      await expect(client.get("/v2/recovery")).rejects.not.toThrow(WhoopNetworkError);
    });
  });

  // -------------------------------------------------------------------------
  // R23: failures while reading a 200 body are network errors too
  // -------------------------------------------------------------------------

  describe("get (response body read failures)", () => {
    /** A 200 response whose body stream sends a partial JSON chunk, then fails. */
    function brokenBodyResponse(cause: Error): Response {
      const body = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('{"records":['));
          controller.error(cause);
        },
      });
      return new Response(body, { status: 200 });
    }

    it("wraps a connection reset mid-body in WhoopNetworkError", async () => {
      const reset = new TypeError("terminated");
      mockFetch.mockResolvedValue(brokenBodyResponse(reset));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      const error = await client.get("/v2/recovery").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(WhoopNetworkError);
      expect((error as WhoopNetworkError).cause).toBe(reset);
      expect(describeWhoopError(error)).toBe(
        "Network error: Unable to reach the WHOOP API. Check your internet connection."
      );
    });

    it("describes a timeout while reading the body as a timeout", async () => {
      const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
      mockFetch.mockResolvedValue(brokenBodyResponse(timeout));
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

      const error = await client.get("/v2/recovery").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(WhoopNetworkError);
      expect(describeWhoopError(error)).toContain("did not respond in time");
    });

    it("describes a non-JSON 200 body (e.g. a proxy page) as an unreadable response", async () => {
      mockFetch.mockResolvedValue(
        new Response("<html>SECRET proxy page</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      );
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL, logger });

      const error = await client.get("/v2/recovery").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(WhoopNetworkError);
      expect(describeWhoopError(error)).toBe(
        "WHOOP API returned an unreadable response. Retry later."
      );
      expect(JSON.stringify(logger.error.mock.calls)).toContain("SyntaxError");
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain("SECRET");
    });

    it("wraps a body read failure on the retry after a token refresh", async () => {
      mockFetch
        .mockResolvedValueOnce(new Response("{}", { status: 401, statusText: "Unauthorized" }))
        .mockResolvedValueOnce(brokenBodyResponse(new TypeError("terminated")));
      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        onTokenRefresh: vi.fn().mockResolvedValue("new_token"),
      });

      await expect(client.get("/v2/recovery")).rejects.toBeInstanceOf(WhoopNetworkError);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // Task 8c: 401 token refresh
  // -------------------------------------------------------------------------

  describe("get (401 token refresh)", () => {
    function mock401Response(): Response {
      return {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: { get: () => null },
        json: () => Promise.resolve({ message: "Invalid token" }),
        text: () => Promise.resolve("Unauthorized"),
      } as unknown as Response;
    }

    it("refreshes token and retries on 401", async () => {
      const NEW_TOKEN = "refreshed_token_xyz";
      mockFetch
        .mockResolvedValueOnce(mock401Response())
        .mockResolvedValueOnce(mockJsonResponse({ user_id: 42 }));
      const onTokenRefresh = vi.fn().mockResolvedValue(NEW_TOKEN);
      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        onTokenRefresh,
      });

      const result = await client.get<{ user_id: number }>("/v2/user/profile/basic");

      expect(result.user_id).toBe(42);
      expect(onTokenRefresh).toHaveBeenCalledOnce();
      // Second fetch should use the refreshed token
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const retryCall = mockFetch.mock.calls[1] as [string, RequestInit];
      expect(retryCall[1].headers).toEqual(
        expect.objectContaining({ Authorization: `Bearer ${NEW_TOKEN}` })
      );
    });

    it("throws WhoopApiError if retry after refresh also returns 401", async () => {
      mockFetch.mockResolvedValueOnce(mock401Response()).mockResolvedValueOnce(mock401Response());
      const onTokenRefresh = vi.fn().mockResolvedValue("new_token");
      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        onTokenRefresh,
      });

      try {
        await client.get("/v2/recovery");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WhoopApiError);
        expect((error as WhoopApiError).statusCode).toBe(401);
      }
      // Should NOT retry again (no infinite loop)
      expect(onTokenRefresh).toHaveBeenCalledOnce();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("throws WhoopApiError immediately when no onTokenRefresh callback", async () => {
      mockFetch.mockResolvedValueOnce(mock401Response());
      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        // no onTokenRefresh
      });

      try {
        await client.get("/v2/recovery");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WhoopApiError);
        expect((error as WhoopApiError).statusCode).toBe(401);
      }
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("throws WhoopAuthError when onTokenRefresh callback fails", async () => {
      mockFetch.mockResolvedValueOnce(mock401Response());
      const refreshError = new Error("Refresh token expired");
      const onTokenRefresh = vi.fn().mockRejectedValue(refreshError);
      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        onTokenRefresh,
      });

      try {
        await client.get("/v2/recovery");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WhoopAuthError);
        expect((error as WhoopAuthError).message).toContain("refresh token");
        expect((error as WhoopAuthError).cause).toBe(refreshError);
      }
    });

    it("WhoopAuthError has name 'WhoopAuthError'", async () => {
      mockFetch.mockResolvedValueOnce(mock401Response());
      const onTokenRefresh = vi.fn().mockRejectedValue(new Error("fail"));
      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        onTokenRefresh,
      });

      try {
        await client.get("/v2/recovery");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(WhoopAuthError);
        expect((error as WhoopAuthError).name).toBe("WhoopAuthError");
      }
    });

    it("does not call onTokenRefresh for non-401 errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        headers: { get: () => null },
        json: () => Promise.resolve({ message: "Forbidden" }),
        text: () => Promise.resolve("Forbidden"),
      } as unknown as Response);
      const onTokenRefresh = vi.fn().mockResolvedValue("new_token");
      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        onTokenRefresh,
      });

      await expect(client.get("/v2/recovery")).rejects.toThrow(WhoopApiError);
      expect(onTokenRefresh).not.toHaveBeenCalled();
    });

    it("refreshes token when 401 body is plain text and not valid JSON", async () => {
      const NEW_TOKEN = "refreshed_token_plain_text";
      let bodyUsed = false;
      const nonJson401Response = {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: { get: () => null },
        // Simulate undici behavior where parsing JSON consumes body and fails.
        json: async () => {
          bodyUsed = true;
          throw new SyntaxError("Unexpected token U in JSON at position 0");
        },
        text: async () => {
          if (bodyUsed) {
            throw new TypeError("Body is unusable: Body has already been read");
          }
          bodyUsed = true;
          return "Unauthorized";
        },
      } as unknown as Response;

      mockFetch
        .mockResolvedValueOnce(nonJson401Response)
        .mockResolvedValueOnce(mockJsonResponse({ user_id: 42 }));
      const onTokenRefresh = vi.fn().mockResolvedValue(NEW_TOKEN);
      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        onTokenRefresh,
      });

      const result = await client.get<{ user_id: number }>("/v2/user/profile/basic");

      expect(result.user_id).toBe(42);
      expect(onTokenRefresh).toHaveBeenCalledOnce();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("persists refreshed token across sequential requests", async () => {
      const NEW_TOKEN = "refreshed_token_persisted";
      const onTokenRefresh = vi.fn().mockResolvedValue(NEW_TOKEN);

      mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
        const authHeader = (init?.headers as Record<string, string>)["Authorization"];

        if (authHeader === `Bearer ${TEST_TOKEN}`) {
          return Promise.resolve({
            ok: false,
            status: 401,
            statusText: "Unauthorized",
            headers: { get: () => null },
            json: () => Promise.resolve({ message: "Invalid token" }),
            text: () => Promise.resolve("Unauthorized"),
          } as unknown as Response);
        }

        if (authHeader === `Bearer ${NEW_TOKEN}`) {
          return Promise.resolve(
            mockJsonResponse({ user_id: 42, tokenUsed: NEW_TOKEN }) as unknown as Response
          );
        }

        return Promise.reject(new Error(`unexpected authorization header: ${authHeader}`));
      });

      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        onTokenRefresh,
      });

      await client.get<{ user_id: number }>("/v2/user/profile/basic");
      await client.get<{ user_id: number }>("/v2/user/profile/basic");

      expect(onTokenRefresh).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent 401s: single-flight token refresh (WHOOP rotates refresh tokens)
  // -------------------------------------------------------------------------

  describe("get (concurrent 401 token refresh)", () => {
    const NEW_TOKEN = "rotated_access_token";
    /** The four endpoints get_today requests in parallel */
    const TODAY_PATHS = [
      "/v2/recovery?limit=25",
      "/v2/activity/sleep?limit=25",
      "/v2/cycle?limit=25",
      "/v2/activity/workout?limit=25",
    ];

    function unauthorized(): Response {
      return {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: { get: () => null },
        json: () => Promise.resolve({ error: "invalid_token" }),
        text: () => Promise.resolve('{"error":"invalid_token"}'),
      } as unknown as Response;
    }

    function okJson(data: unknown): Response {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(data),
        text: () => Promise.resolve(JSON.stringify(data)),
      } as Response;
    }

    function deferred<T>(): {
      promise: Promise<T>;
      resolve: (value: T) => void;
      reject: (reason: unknown) => void;
    } {
      let resolve: (value: T) => void = () => {};
      let reject: (reason: unknown) => void = () => {};
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    function authHeader(init?: RequestInit): string | undefined {
      return (init?.headers as Record<string, string> | undefined)?.["Authorization"];
    }

    /** Let every pending request run until it blocks on the refresh. */
    async function settleMicrotasks(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    /** fetch mock: 401 for any token except `validToken`, which echoes the requested URL. */
    function acceptOnly(validToken: string): void {
      mockFetch.mockImplementation((url: string, init?: RequestInit) =>
        Promise.resolve(
          authHeader(init) === `Bearer ${validToken}` ? okJson({ url }) : unauthorized()
        )
      );
    }

    it("calls onTokenRefresh once when several parallel requests get 401", async () => {
      acceptOnly(NEW_TOKEN);
      const refresh = deferred<string>();
      const onTokenRefresh = vi.fn(() => refresh.promise);
      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        onTokenRefresh,
      });

      const pending = Promise.all(TODAY_PATHS.map((path) => client.get<{ url: string }>(path)));
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(TODAY_PATHS.length));
      await settleMicrotasks();

      // Every request has hit its 401 and is waiting on the same refresh.
      expect(onTokenRefresh).toHaveBeenCalledTimes(1);
      refresh.resolve(NEW_TOKEN);

      const results = await pending;
      expect(results.map((r) => r.url)).toEqual(TODAY_PATHS.map((p) => `${TEST_BASE_URL}${p}`));
      expect(onTokenRefresh).toHaveBeenCalledTimes(1);
      const retries = mockFetch.mock.calls.slice(TODAY_PATHS.length) as Array<
        [string, RequestInit]
      >;
      expect(retries).toHaveLength(TODAY_PATHS.length);
      for (const [, init] of retries) {
        expect(authHeader(init)).toBe(`Bearer ${NEW_TOKEN}`);
      }
    });

    it("calls onTokenRefresh once for 3 parallel 401s when the refresh resolves immediately", async () => {
      acceptOnly(NEW_TOKEN);
      const onTokenRefresh = vi.fn().mockResolvedValue(NEW_TOKEN);
      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        onTokenRefresh,
      });

      const results = await Promise.all(
        TODAY_PATHS.slice(0, 3).map((path) => client.get<{ url: string }>(path))
      );

      expect(results).toHaveLength(3);
      expect(onTokenRefresh).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(6);
    });

    it("retries a late 401 with the already-refreshed token instead of refreshing again", async () => {
      const lateUnauthorized = deferred<Response>();
      mockFetch
        // Request A's first attempt: 401 straight away.
        .mockImplementationOnce(() => Promise.resolve(unauthorized()))
        // Request B's first attempt (sent with the old token): its 401 arrives later.
        .mockImplementationOnce(() => lateUnauthorized.promise)
        .mockImplementation((url: string, init?: RequestInit) =>
          Promise.resolve(
            authHeader(init) === `Bearer ${NEW_TOKEN}` ? okJson({ url }) : unauthorized()
          )
        );
      const onTokenRefresh = vi.fn().mockResolvedValue(NEW_TOKEN);
      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        onTokenRefresh,
      });

      const requestA = client.get<{ url: string }>("/v2/recovery?limit=25");
      const requestB = client.get<{ url: string }>("/v2/cycle?limit=25");

      await expect(requestA).resolves.toEqual({ url: `${TEST_BASE_URL}/v2/recovery?limit=25` });
      expect(onTokenRefresh).toHaveBeenCalledTimes(1);

      lateUnauthorized.resolve(unauthorized());
      await expect(requestB).resolves.toEqual({ url: `${TEST_BASE_URL}/v2/cycle?limit=25` });

      expect(onTokenRefresh).toHaveBeenCalledTimes(1);
      const calls = mockFetch.mock.calls as Array<[string, RequestInit]>;
      expect(calls).toHaveLength(4);
      expect(authHeader(calls[1]![1])).toBe(`Bearer ${TEST_TOKEN}`);
      expect(authHeader(calls[3]![1])).toBe(`Bearer ${NEW_TOKEN}`);
    });

    it("sends the refreshed token on requests that start while the refresh is running", async () => {
      acceptOnly(NEW_TOKEN);
      const refresh = deferred<string>();
      const onTokenRefresh = vi.fn(() => refresh.promise);
      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        onTokenRefresh,
      });

      const first = client.get("/v2/recovery?limit=25");
      await vi.waitFor(() => expect(onTokenRefresh).toHaveBeenCalledTimes(1));
      // Starts mid-refresh with the old token, gets 401 and joins the same refresh.
      const second = client.get("/v2/cycle?limit=25");
      await settleMicrotasks();
      refresh.resolve(NEW_TOKEN);
      await Promise.all([first, second]);

      // A request after the refresh goes straight out with the new token.
      await client.get("/v2/activity/sleep?limit=25");

      expect(onTokenRefresh).toHaveBeenCalledTimes(1);
      const lastCall = mockFetch.mock.calls.at(-1) as [string, RequestInit];
      expect(lastCall[0]).toBe(`${TEST_BASE_URL}/v2/activity/sleep?limit=25`);
      expect(authHeader(lastCall[1])).toBe(`Bearer ${NEW_TOKEN}`);
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });

    it("rejects every waiter with WhoopAuthError when the shared refresh fails", async () => {
      acceptOnly(NEW_TOKEN);
      const refresh = deferred<string>();
      const refreshError = new Error("Token refresh failed (400): invalid_grant");
      const onTokenRefresh = vi.fn(() => refresh.promise);
      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        onTokenRefresh,
      });

      const settled = Promise.allSettled(TODAY_PATHS.slice(0, 3).map((path) => client.get(path)));
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
      await settleMicrotasks();
      refresh.reject(refreshError);

      const results = await settled;
      expect(onTokenRefresh).toHaveBeenCalledTimes(1);
      for (const result of results) {
        expect(result.status).toBe("rejected");
        const reason = (result as PromiseRejectedResult).reason as WhoopAuthError;
        expect(reason).toBeInstanceOf(WhoopAuthError);
        expect(reason.cause).toBe(refreshError);
      }
      // No retry is sent after a failed refresh.
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("lets the next 401 try again after a failed refresh", async () => {
      acceptOnly(NEW_TOKEN);
      const onTokenRefresh = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error("network blip"))
        .mockResolvedValueOnce(NEW_TOKEN);
      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        onTokenRefresh,
      });

      await expect(client.get("/v2/recovery?limit=25")).rejects.toBeInstanceOf(WhoopAuthError);
      await expect(client.get<{ url: string }>("/v2/recovery?limit=25")).resolves.toEqual({
        url: `${TEST_BASE_URL}/v2/recovery?limit=25`,
      });
      expect(onTokenRefresh).toHaveBeenCalledTimes(2);
    });

    it("recovers when onTokenRefresh throws synchronously", async () => {
      acceptOnly(NEW_TOKEN);
      const onTokenRefresh = vi
        .fn<() => Promise<string>>()
        .mockImplementationOnce(() => {
          throw new Error("synchronous failure");
        })
        .mockResolvedValueOnce(NEW_TOKEN);
      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        onTokenRefresh,
      });

      await expect(client.get("/v2/cycle?limit=1")).rejects.toBeInstanceOf(WhoopAuthError);
      await expect(client.get("/v2/cycle?limit=1")).resolves.toEqual({
        url: `${TEST_BASE_URL}/v2/cycle?limit=1`,
      });
      expect(onTokenRefresh).toHaveBeenCalledTimes(2);
    });

    it("logs one refresh at info level for concurrent 401s", async () => {
      acceptOnly(NEW_TOKEN);
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const refresh = deferred<string>();
      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
        onTokenRefresh: () => refresh.promise,
        logger,
      });

      const pending = Promise.all(TODAY_PATHS.map((path) => client.get(path)));
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(TODAY_PATHS.length));
      await settleMicrotasks();
      refresh.resolve(NEW_TOKEN);
      await pending;

      const refreshedLogs = logger.info.mock.calls.filter(
        ([message]) => message === "whoop token refreshed"
      );
      expect(refreshedLogs).toHaveLength(1);
      const serialized = JSON.stringify([
        logger.debug.mock.calls,
        logger.info.mock.calls,
        logger.warn.mock.calls,
      ]);
      expect(serialized).not.toContain(NEW_TOKEN);
      expect(serialized).not.toContain(TEST_TOKEN);
    });
  });

  // -------------------------------------------------------------------------
  // Task 4d: Edge cases
  // -------------------------------------------------------------------------

  describe("get (edge cases)", () => {
    it("WhoopClient type can be used to type a variable", () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      } as Response);

      const client: WhoopClient = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
      });

      expect(client).toBeDefined();
      expect(typeof client.get).toBe("function");
    });

    it("falls back to exponential backoff when Retry-After header is non-numeric", async () => {
      // 429 with a non-numeric Retry-After header → parseRetryAfter returns null → exponential backoff
      const headers429 = new Headers();
      headers429.set("retry-after", "not-a-number");

      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          headers: headers429,
          json: () => Promise.resolve({ message: "rate limited" }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: "ok" }),
        } as Response);

      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
      });

      const result = await client.get<{ data: string }>("/v2/recovery");
      expect(result).toEqual({ data: "ok" });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("falls back to exponential backoff when Retry-After header is negative", async () => {
      const headers429 = new Headers();
      headers429.set("retry-after", "-5");

      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          headers: headers429,
          json: () => Promise.resolve({ message: "rate limited" }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: "ok" }),
        } as Response);

      const client = createWhoopClient({
        accessToken: TEST_TOKEN,
        baseUrl: TEST_BASE_URL,
      });

      const result = await client.get<{ data: string }>("/v2/recovery");
      expect(result).toEqual({ data: "ok" });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Logging integration
// ---------------------------------------------------------------------------

describe("createWhoopClient — logger integration", () => {
  const TEST_BASE_URL = "https://test.whoop.api";
  const TEST_TOKEN = "test_access_token_abc123";

  let mockFetch: ReturnType<typeof vi.fn>;
  let logger: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs successful GET at debug level with durationMs and requestId", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ user_id: 1 }),
    } as Response);

    const client = createWhoopClient({
      accessToken: TEST_TOKEN,
      baseUrl: TEST_BASE_URL,
      logger,
      requestId: "req-abc",
    });
    await client.get("/v2/user/profile/basic");

    expect(logger.debug).toHaveBeenCalledTimes(1);
    const [msg, extra] = logger.debug.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toBe("whoop api request");
    expect(extra.requestId).toBe("req-abc");
    expect(extra.status).toBe(200);
    expect(typeof extra.durationMs).toBe("number");
    expect(extra.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("logs 429 responses at warn level with attempt + retryAfterMs", async () => {
    const headers429 = new Headers();
    headers429.set("retry-after", "0"); // zero so test is fast
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: headers429,
        json: () => Promise.resolve({ message: "rate limited" }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: "ok" }),
      } as Response);

    const client = createWhoopClient({
      accessToken: TEST_TOKEN,
      baseUrl: TEST_BASE_URL,
      logger,
      requestId: "req-rate",
    });
    await client.get("/v2/recovery");

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [msg, extra] = logger.warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toBe("whoop api rate limited");
    expect(extra.requestId).toBe("req-rate");
    expect(extra.attempt).toBe(0);
    expect(extra.retryAfterMs).toBe(0);
  });

  it("logs network/timeout errors at error level", async () => {
    const timeoutErr = new Error("The operation timed out.");
    timeoutErr.name = "TimeoutError";
    mockFetch.mockRejectedValueOnce(timeoutErr);

    const client = createWhoopClient({
      accessToken: TEST_TOKEN,
      baseUrl: TEST_BASE_URL,
      logger,
    });

    await expect(client.get("/v2/recovery")).rejects.toBeInstanceOf(WhoopNetworkError);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [msg, extra] = logger.error.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toBe("whoop api timeout");
    expect(typeof extra.durationMs).toBe("number");
  });

  it("logs at info level when token is refreshed after 401", async () => {
    const onTokenRefresh = vi.fn().mockResolvedValue("new_token");
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: () => Promise.resolve({ error: "invalid_token" }),
        text: () => Promise.resolve('{"error":"invalid_token"}'),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ user_id: 1 }),
      } as Response);

    const client = createWhoopClient({
      accessToken: TEST_TOKEN,
      baseUrl: TEST_BASE_URL,
      onTokenRefresh,
      logger,
    });
    await client.get("/v2/user/profile/basic");

    expect(logger.info).toHaveBeenCalledWith(
      "whoop token refreshed",
      expect.objectContaining({ url: expect.stringContaining("/v2/user/profile/basic") })
    );
  });
});

// ---------------------------------------------------------------------------
// Cache integration
// ---------------------------------------------------------------------------

describe("createWhoopClient — cache integration", () => {
  const TEST_BASE_URL = "https://test.whoop.api";
  const TEST_TOKEN = "test_access_token_abc123";

  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function jsonOk(data: unknown): Response {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    } as Response;
  }

  it("does not cache when no cache is configured even if cache:true is passed", async () => {
    mockFetch.mockResolvedValue(jsonOk({ ok: 1 }));
    const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL });

    await client.get("/v2/recovery?limit=1", { cache: true });
    await client.get("/v2/recovery?limit=1", { cache: true });

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not cache when cache option is absent", async () => {
    const { MemoryCache } = await import("../../src/cache/memory-cache.js");
    const cache = new MemoryCache();
    mockFetch.mockResolvedValue(jsonOk({ ok: 1 }));
    const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL, cache });

    await client.get("/v2/recovery?limit=1");
    await client.get("/v2/recovery?limit=1");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("serves a cache hit from a single fetch when cache:true", async () => {
    const { MemoryCache } = await import("../../src/cache/memory-cache.js");
    const cache = new MemoryCache();
    mockFetch.mockResolvedValue(jsonOk({ value: 42 }));
    const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL, cache });

    const first = await client.get<{ value: number }>("/v2/recovery?limit=1", { cache: true });
    const second = await client.get<{ value: number }>("/v2/recovery?limit=1", { cache: true });

    expect(first).toEqual({ value: 42 });
    expect(second).toEqual({ value: 42 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("caches by normalized key regardless of query param order", async () => {
    const { MemoryCache } = await import("../../src/cache/memory-cache.js");
    const cache = new MemoryCache();
    mockFetch.mockResolvedValue(jsonOk({ value: 1 }));
    const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL, cache });

    await client.get("/v2/recovery?limit=1&start=a", { cache: true });
    await client.get("/v2/recovery?start=a&limit=1", { cache: true });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent identical requests (stampede prevention)", async () => {
    const { MemoryCache } = await import("../../src/cache/memory-cache.js");
    const cache = new MemoryCache();
    let resolveFetch: (r: Response) => void = () => {};
    mockFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL, cache });

    const p1 = client.get("/v2/recovery?limit=1", { cache: true });
    const p2 = client.get("/v2/recovery?limit=1", { cache: true });

    resolveFetch(jsonOk({ value: 7 }));
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toEqual({ value: 7 });
    expect(r2).toEqual({ value: 7 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("shares cache across the resource and tool paths for the same key", async () => {
    const { MemoryCache } = await import("../../src/cache/memory-cache.js");
    const cache = new MemoryCache();
    mockFetch.mockResolvedValue(jsonOk({ value: 99 }));
    const client = createWhoopClient({ accessToken: TEST_TOKEN, baseUrl: TEST_BASE_URL, cache });

    // First caller (e.g. resource) populates, second caller (e.g. get_today) hits.
    await client.get("/v2/cycle?limit=1", { cache: true });
    await client.get("/v2/cycle?limit=1", { cache: true });

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
