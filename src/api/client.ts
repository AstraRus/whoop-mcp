/**
 * WHOOP API HTTP client.
 *
 * Thin wrapper around native `fetch` that injects the OAuth Bearer token,
 * prepends the WHOOP API base URL, parses JSON responses, and throws
 * typed errors for non-2xx status codes.
 */

import { WHOOP_API_BASE_URL } from "./endpoints.js";
import type { Logger } from "../logging/logger.js";
import { MemoryCache, DEFAULT_TTL_MS } from "../cache/memory-cache.js";
import { TokenRefreshError } from "../auth/token-refresh-error.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for creating a WHOOP API client */
export interface WhoopClientOptions {
  accessToken: string;
  /** Override base URL — useful for testing. Defaults to WHOOP_API_BASE_URL. */
  baseUrl?: string;
  /**
   * Callback to refresh the access token on 401. Returns a new access token.
   * Never called concurrently: requests that hit a 401 while a refresh is
   * running share its result (WHOOP rotates refresh tokens).
   */
  onTokenRefresh?: () => Promise<string>;
  /**
   * Optional structured logger for API call observability.
   * Successful calls log at `debug` with `durationMs`; 429 responses log at
   * `warn`; timeouts/network errors log at `error`.
   */
  logger?: Logger;
  /** Optional request ID propagated to all log entries for this client. */
  requestId?: string;
  /**
   * Optional shared cache. When provided, callers can opt individual GETs into
   * caching via the `cache` option on {@link WhoopClient.get}. Without it,
   * caching is a no-op and every GET hits the network.
   */
  cache?: MemoryCache;
}

/** Per-request options for {@link WhoopClient.get}. */
export interface WhoopGetOptions {
  /** When true (and a cache is configured), serve from / store in the cache. */
  cache?: boolean;
  /** TTL override in milliseconds for this cached entry. Defaults to the cache default. */
  ttlMs?: number;
}

/** WHOOP API client returned by createWhoopClient */
export interface WhoopClient {
  /** Send a GET request and parse the JSON response as T */
  get<T>(path: string, options?: WhoopGetOptions): Promise<T>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Error thrown when the WHOOP API returns a non-2xx response */
export class WhoopApiError extends Error {
  public override readonly name = "WhoopApiError";

  constructor(
    public readonly statusCode: number,
    public readonly statusText: string,
    public readonly body: unknown
  ) {
    super(`WHOOP API error: ${statusCode} ${statusText}`);
  }
}

/** Error thrown when a network-level failure prevents reaching the WHOOP API */
export class WhoopNetworkError extends Error {
  public override readonly name = "WhoopNetworkError";

  constructor(cause: unknown) {
    super("Network error: Unable to reach the WHOOP API. Check your internet connection.", {
      cause,
    });
  }
}

/** Error thrown when token refresh fails during automatic 401 recovery */
export class WhoopAuthError extends Error {
  public override readonly name = "WhoopAuthError";

  constructor(cause: unknown) {
    super("Authentication error: Failed to refresh token. Re-authentication may be required.", {
      cause,
    });
  }
}

// ---------------------------------------------------------------------------
// User-facing error descriptions
// ---------------------------------------------------------------------------

/** Maximum depth followed through `cause` chains when classifying an error */
const MAX_CAUSE_DEPTH = 5;

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/**
 * How to sign in to WHOOP again once the stored tokens are unusable. The
 * server only runs the WHOOP authorization flow at startup, when tokens.json is
 * missing or its access token has expired and cannot be refreshed; a local
 * setup --verify runs the same check. When WHOOP rejects a refresh, the server
 * marks the stored tokens expired, so a restart is enough.
 */
const SIGN_IN_FLOW =
  "it opens the WHOOP authorization page, or prints the authorization link in the server logs when it cannot open a browser (e.g. the deploy logs of a hosted server)";

/** Remediation that forces a new sign-in: needed when refreshing still works but WHOOP refuses the tokens. */
const SIGN_IN_AFTER_DELETING_TOKENS = `To sign in again, delete tokens.json from the server's token folder (~/.whoop-mcp; on a hosted server, its mounted volume), then restart the server (locally, setup --verify also works): ${SIGN_IN_FLOW}.`;

function describeApiStatus(statusCode: number): string {
  if (statusCode === 400) {
    return "WHOOP rejected the request parameters (HTTP 400). Check the ids and dates: use ISO 8601 dates or a supported date expression, and make sure start is before end.";
  }
  if (statusCode === 401) {
    return `WHOOP rejected the authorization (HTTP 401). ${SIGN_IN_AFTER_DELETING_TOKENS}`;
  }
  if (statusCode === 403) {
    return `WHOOP denied access (HTTP 403). The connection may be missing a required permission. ${SIGN_IN_AFTER_DELETING_TOKENS}`;
  }
  if (statusCode === 404) {
    return "WHOOP found no matching record (HTTP 404). Check the ids and dates: use an id taken from a collection response (sleep and workout ids are UUIDs, cycle ids are numbers).";
  }
  if (statusCode === 429) {
    return "WHOOP rate limit reached (HTTP 429). Wait a minute, then retry.";
  }
  if (statusCode >= 500) {
    return `WHOOP API is temporarily unavailable (HTTP ${statusCode}). Retry later.`;
  }
  if (statusCode >= 400) {
    return `WHOOP rejected the request (HTTP ${statusCode}). Check the ids and dates, then retry.`;
  }
  return `WHOOP API returned an unexpected response (HTTP ${statusCode}). Retry later.`;
}

/**
 * Describe a WHOOP client error in plain language for tool and resource
 * responses.
 *
 * Messages depend only on the error type and HTTP status code — never on the
 * response body, request URL, tokens or health data. Wrapped causes are
 * followed where they explain the failure better: a token refresh that could
 * not reach WHOOP is a network problem, and a WhoopNetworkError wrapping an
 * API or auth error (e.g. a composite tool rethrowing its first rejection) is
 * described by that error.
 *
 * @returns The description, or `undefined` when the error is not a WHOOP client error.
 */
export function describeWhoopError(error: unknown): string | undefined {
  return describeWhoopErrorAt(error, 0);
}

function describeWhoopErrorAt(error: unknown, depth: number): string | undefined {
  if (depth > MAX_CAUSE_DEPTH) {
    return undefined;
  }
  if (error instanceof WhoopApiError) {
    return describeApiStatus(error.statusCode);
  }
  if (error instanceof WhoopAuthError) {
    if (error.cause instanceof WhoopNetworkError) {
      return describeWhoopErrorAt(error.cause, depth + 1);
    }
    if (error.cause instanceof TokenRefreshError && !error.cause.rejected) {
      return error.cause.statusCode === 429
        ? "WHOOP rate-limited the token refresh. Your sign-in is still valid; retry in a minute."
        : "WHOOP's sign-in service is temporarily unavailable. Your sign-in is still valid; retry shortly.";
    }
    return `WHOOP authentication failed: the access token could not be refreshed. To sign in again, restart the server (locally, setup --verify also works): ${SIGN_IN_FLOW}. If it starts without asking you to sign in, delete tokens.json from its token folder (~/.whoop-mcp; on a hosted server, its mounted volume) and restart it again.`;
  }
  if (error instanceof WhoopNetworkError) {
    const cause = error.cause;
    if (cause instanceof WhoopApiError || cause instanceof WhoopAuthError) {
      return describeWhoopErrorAt(cause, depth + 1);
    }
    if (isTimeoutError(cause)) {
      return "Network error: the WHOOP API did not respond in time. Retry shortly.";
    }
    if (cause instanceof SyntaxError) {
      return "WHOOP API returned an unreadable response. Retry later.";
    }
    return "Network error: Unable to reach the WHOOP API. Check your internet connection.";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of retries for 429 rate limit responses */
const MAX_RETRIES = 3;

/** Base delay in milliseconds for exponential backoff (1s, 2s, 4s) */
const BASE_RETRY_DELAY_MS = 1000;

/** Default request timeout in milliseconds (30 seconds) */
const REQUEST_TIMEOUT_MS = 30_000;

/** Maximum Retry-After delay in milliseconds (1 minute) — caps server-controlled header */
const MAX_RETRY_AFTER_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait for a given number of milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse the Retry-After header as seconds.
 * Returns the delay in milliseconds (capped at MAX_RETRY_AFTER_MS),
 * or null if the header is missing/unparseable.
 */
function parseRetryAfter(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (header === null) {
    return null;
  }
  const seconds = Number(header);
  if (Number.isNaN(seconds) || seconds < 0) {
    return null;
  }
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/**
 * Build a deterministic cache key for a GET request.
 * Query parameters are sorted so that semantically identical paths collapse to
 * the same key (e.g. `?a=1&b=2` and `?b=2&a=1`). No auth data is included.
 */
export function cacheKey(path: string): string {
  const qIndex = path.indexOf("?");
  if (qIndex === -1) {
    return `GET:${path}`;
  }
  const base = path.slice(0, qIndex);
  const params = new URLSearchParams(path.slice(qIndex + 1));
  params.sort();
  const query = params.toString();
  return query.length > 0 ? `GET:${base}?${query}` : `GET:${base}`;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Create a WHOOP API client.
 *
 * The client prepends the base URL to all paths, injects the Bearer token,
 * parses JSON responses, retries 429 rate limit responses with backoff,
 * and throws typed errors for non-2xx status codes.
 */
export function createWhoopClient(options: WhoopClientOptions): WhoopClient {
  const baseUrl = options.baseUrl ?? WHOOP_API_BASE_URL;
  const logger = options.logger;
  const requestId = options.requestId;
  const cache = options.cache;
  /** Latest access token; replaced when a refresh succeeds. */
  let accessToken = options.accessToken;
  /** The token refresh currently in progress, shared by every request that hits a 401. */
  let refreshInFlight: Promise<string> | null = null;

  function logExtras(extra: Record<string, unknown>): Record<string, unknown> {
    return requestId !== undefined ? { requestId, ...extra } : extra;
  }

  async function doFetch(url: string, accessToken: string): Promise<Response> {
    const startedAt = Date.now();
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      logger?.debug(
        "whoop api request",
        logExtras({ url, status: res.status, durationMs: Date.now() - startedAt })
      );
      return res;
    } catch (error: unknown) {
      const durationMs = Date.now() - startedAt;
      if (error instanceof WhoopApiError) {
        throw error;
      }
      // AbortError from AbortSignal.timeout → request timed out
      const isTimeout =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      if (isTimeout) {
        logger?.error("whoop api timeout", logExtras({ url, durationMs, error: error.message }));
      } else {
        logger?.error(
          "whoop api network error",
          logExtras({
            url,
            durationMs,
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
      throw new WhoopNetworkError(error);
    }
  }

  /**
   * Parse a successful response body. The request timeout also covers reading
   * the body, so a reset, a timeout mid-body or a non-JSON body (e.g. a proxy
   * page) is reported as a WhoopNetworkError like a failed fetch.
   */
  async function readJson<T>(response: Response, url: string): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch (error: unknown) {
      // Log the error name only: a SyntaxError message can quote the body.
      logger?.error(
        "whoop api response read failed",
        logExtras({ url, error: error instanceof Error ? error.name : typeof error })
      );
      throw new WhoopNetworkError(error);
    }
  }

  async function parseErrorBody(response: Response): Promise<unknown> {
    try {
      const rawBody = await response.text();
      try {
        return JSON.parse(rawBody) as unknown;
      } catch {
        return rawBody;
      }
    } catch {
      return null;
    }
  }

  return {
    async get<T>(path: string, getOptions?: WhoopGetOptions): Promise<T> {
      if (getOptions?.cache && cache) {
        return cache.getOrFetch<T>(cacheKey(path), getOptions.ttlMs ?? DEFAULT_TTL_MS, () =>
          doGet<T>(path)
        );
      }
      return doGet<T>(path);
    },
  };

  /**
   * Refresh the access token at most once at a time.
   *
   * WHOOP rotates refresh tokens, so two refreshes racing with the same stored
   * refresh token would make all but one fail and can revoke the grant. Every
   * request that hits a 401 while a refresh is running waits for that same
   * refresh. The shared promise is cleared once it settles, so after a failed
   * refresh (which rejects every waiter) the next 401 may try again.
   */
  function refreshAccessTokenOnce(refresh: () => Promise<string>, url: string): Promise<string> {
    if (refreshInFlight !== null) {
      logger?.debug("whoop token refresh already in progress", logExtras({ url }));
      return refreshInFlight;
    }
    const flight = (async (): Promise<string> => {
      const newToken = await refresh();
      accessToken = newToken;
      logger?.info("whoop token refreshed", logExtras({ url }));
      return newToken;
    })();
    refreshInFlight = flight;
    const settle = (): void => {
      if (refreshInFlight === flight) {
        refreshInFlight = null;
      }
    };
    // Registered before any waiter, so the slot is free by the time waiters resume.
    flight.then(settle, settle);
    return flight;
  }

  async function doGet<T>(path: string): Promise<T> {
    const url = `${baseUrl}${path}`;
    let lastError: WhoopApiError | undefined;
    let lastResponse: Response | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Wait before retry (not before the first attempt)
      if (attempt > 0 && lastResponse) {
        const retryDelay =
          parseRetryAfter(lastResponse) ?? BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        await delay(retryDelay);
      }

      // Always send the latest token: another request may have refreshed it.
      const sentToken = accessToken;
      const response = await doFetch(url, sentToken);

      if (response.ok) {
        return await readJson<T>(response, url);
      }

      const body = await parseErrorBody(response);
      const apiError = new WhoopApiError(response.status, response.statusText, body);

      // Only retry on 429 rate limit
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response);
        logger?.warn(
          "whoop api rate limited",
          logExtras({ url, attempt, retryAfterMs: retryAfterMs ?? undefined })
        );
        lastError = apiError;
        lastResponse = response;
        continue;
      }

      // 401: refresh the token (shared with concurrent requests) and retry once
      if (response.status === 401 && options.onTokenRefresh) {
        let newToken: string;
        if (accessToken !== sentToken) {
          // Another request already refreshed the token while this one was in flight.
          newToken = accessToken;
        } else {
          try {
            newToken = await refreshAccessTokenOnce(options.onTokenRefresh, url);
          } catch (refreshError: unknown) {
            throw new WhoopAuthError(refreshError);
          }
        }

        // Retry with the new token
        const retryResponse = await doFetch(url, newToken);
        if (retryResponse.ok) {
          return await readJson<T>(retryResponse, url);
        }

        // Retry also failed — throw the original error
        const retryBody = await parseErrorBody(retryResponse);
        throw new WhoopApiError(retryResponse.status, retryResponse.statusText, retryBody);
      }

      // All other errors: throw immediately
      throw apiError;
    }

    // All retries exhausted
    throw lastError!;
  }
}
