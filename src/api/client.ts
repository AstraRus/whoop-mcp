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
import { WhoopRateBudgetError, type RateLimiter } from "./rate-limiter.js";

export { WhoopRateBudgetError } from "./rate-limiter.js";

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
  /**
   * Optional process-wide request pacing. When provided, every request attempt
   * (first try, 429 retries and the retry after a token refresh) waits for a
   * slot and releases it once the response headers arrive. Without it, requests
   * are sent immediately.
   */
  rateLimiter?: RateLimiter;
}

/** Per-request options for {@link WhoopClient.get}. */
export interface WhoopGetOptions {
  /** When true (and a cache is configured), serve from / store in the cache. */
  cache?: boolean;
  /** TTL override in milliseconds for this cached entry. Defaults to the cache default. */
  ttlMs?: number;
  /**
   * Epoch ms after which no further request attempt is sent: waiting for the
   * rate limiter, or a 429 retry delay, that would pass it rejects with
   * {@link WhoopRateBudgetError} instead.
   */
  deadlineMs?: number;
  /**
   * With `cache`: drop the stored entry for this path first, then fetch and
   * store a fresh value (a fetch for the same path already in flight is joined).
   */
  refresh?: boolean;
}

/** A GET result with when it was fetched and whether it came from the cache. */
export interface WhoopFetchResult<T> {
  data: T;
  /** Epoch ms when the data was fetched from WHOOP (for a cache hit: when it was stored). */
  fetchedAt: number;
  /** "hit" when served from a stored cache entry; "miss" when fetched (or joined in flight). */
  cacheStatus: "hit" | "miss";
}

/** WHOOP API client returned by createWhoopClient */
export interface WhoopClient {
  /** Send a GET request and parse the JSON response as T */
  get<T>(path: string, options?: WhoopGetOptions): Promise<T>;
  /**
   * {@link get} that also reports the fetch time and cache status. Optional:
   * test doubles may omit it, and callers then report both as unknown.
   */
  getWithMeta?<T>(path: string, options?: WhoopGetOptions): Promise<WhoopFetchResult<T>>;
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

/** undici error codes of a fetch that timed out (surfaced as the cause of a TypeError). */
const UNDICI_TIMEOUT_CODES: ReadonlySet<string> = new Set([
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * A request that did not complete in time: an abort or timeout (including a
 * DOMException TimeoutError), or undici's "fetch failed" TypeError caused by a
 * headers, body or connect timeout.
 */
function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  if (name === "TimeoutError" || name === "AbortError") return true;
  if (error instanceof TypeError) {
    const cause: unknown = error.cause;
    const code =
      typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
    return typeof code === "string" && UNDICI_TIMEOUT_CODES.has(code);
  }
  return false;
}

/**
 * The endpoint of a request path for logs: no query string, and every path
 * segment that is not a version or a lower-case word (ids, dates) replaced by
 * ':id'.
 */
function logEndpoint(path: string): string {
  return path
    .split("?")[0]!
    .split("/")
    .map((s) => (s === "" || /^v\d+$/.test(s) || /^[a-z_]+$/.test(s) ? s : ":id"))
    .join("/");
}

/** The name of a thrown value for logs (never its message, which can quote a URL or body). */
function errorClassOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
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
const SIGN_IN_AFTER_DELETING_TOKENS = `To sign in again, delete tokens.json from the server's token folder (WHOOP_MCP_TOKEN_DIR when set, else ~/.whoop-mcp; on a hosted server, its mounted volume), then restart the server (locally, setup --verify also works): ${SIGN_IN_FLOW}.`;

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
  if (error instanceof WhoopRateBudgetError) {
    return "The server paused WHOOP requests to stay within WHOOP's per-minute request limit; retry in a minute or request a shorter period.";
  }
  if (error instanceof WhoopApiError) {
    return describeApiStatus(error.statusCode);
  }
  if (error instanceof WhoopAuthError) {
    if (error.cause instanceof WhoopNetworkError) {
      return describeWhoopErrorAt(error.cause, depth + 1);
    }
    if (error.cause instanceof TokenRefreshError && error.cause.clientRejected) {
      // invalid_client: the app's credentials, not the user's refresh token
      return `WHOOP rejected this app's client credentials (HTTP ${error.cause.statusCode} invalid_client). Check WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET; your WHOOP sign-in itself is still valid.`;
    }
    if (error.cause instanceof TokenRefreshError && !error.cause.rejected) {
      return error.cause.statusCode === 429
        ? "WHOOP rate-limited the token refresh. Your sign-in is still valid; retry in a minute."
        : "WHOOP's sign-in service is temporarily unavailable. Your sign-in is still valid; retry shortly.";
    }
    return `WHOOP authentication failed: the access token could not be refreshed. To sign in again, restart the server (locally, setup --verify also works): ${SIGN_IN_FLOW}. If it starts without asking you to sign in, delete tokens.json from its token folder (WHOOP_MCP_TOKEN_DIR when set, else ~/.whoop-mcp; on a hosted server, its mounted volume) and restart it again.`;
  }
  if (error instanceof WhoopNetworkError) {
    const cause = error.cause;
    if (
      cause instanceof WhoopApiError ||
      cause instanceof WhoopAuthError ||
      cause instanceof WhoopRateBudgetError
    ) {
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

/** A numeric response header, or null when missing or not a finite number. */
function numericHeader(response: Response, name: string): number | null {
  const header = response.headers?.get(name);
  if (header === null || header === undefined || header.trim() === "") {
    return null;
  }
  const value = Number(header);
  return Number.isFinite(value) ? value : null;
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
  const rateLimiter = options.rateLimiter;
  /** Latest access token; replaced when a refresh succeeds. */
  let accessToken = options.accessToken;
  /** The token refresh currently in progress, shared by every request that hits a 401. */
  let refreshInFlight: Promise<string> | null = null;

  function logExtras(extra: Record<string, unknown>): Record<string, unknown> {
    return requestId !== undefined ? { requestId, ...extra } : extra;
  }

  async function doFetch(url: string, endpoint: string, accessToken: string): Promise<Response> {
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
        logExtras({ endpoint, status: res.status, durationMs: Date.now() - startedAt })
      );
      return res;
    } catch (error: unknown) {
      const durationMs = Date.now() - startedAt;
      if (error instanceof WhoopApiError) {
        throw error;
      }
      // TimeoutError from AbortSignal.timeout, or an undici timeout: the request timed out.
      // Only the error class is logged: messages can quote the URL.
      const errorClass = errorClassOf(error);
      if (isTimeoutError(error)) {
        logger?.error("whoop api timeout", logExtras({ endpoint, durationMs, errorClass }));
      } else {
        logger?.error("whoop api network error", logExtras({ endpoint, durationMs, errorClass }));
      }
      throw new WhoopNetworkError(error);
    }
  }

  /**
   * Send one request attempt: refuse it once the deadline has passed, wait for
   * a rate-limiter slot (released as soon as the headers arrive) and report
   * WHOOP's rate-limit signals back to the limiter.
   */
  async function sendAttempt(
    url: string,
    endpoint: string,
    token: string,
    deadlineMs: number | undefined
  ): Promise<Response> {
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
      throw new WhoopRateBudgetError();
    }
    if (rateLimiter === undefined) {
      return doFetch(url, endpoint, token);
    }
    const release = await rateLimiter.acquire(deadlineMs);
    try {
      const response = await doFetch(url, endpoint, token);
      rateLimiter.noteHeaders(
        numericHeader(response, "x-ratelimit-remaining"),
        numericHeader(response, "x-ratelimit-reset")
      );
      if (response.status === 429) {
        rateLimiter.note429(parseRetryAfter(response));
      }
      return response;
    } finally {
      release();
    }
  }

  /**
   * Parse a successful response body. The request timeout also covers reading
   * the body, so a reset, a timeout mid-body or a non-JSON body (e.g. a proxy
   * page) is reported as a WhoopNetworkError like a failed fetch.
   */
  async function readJson<T>(response: Response, endpoint: string): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch (error: unknown) {
      // Log the error name only: a SyntaxError message can quote the body.
      logger?.error(
        "whoop api response read failed",
        logExtras({ endpoint, errorClass: errorClassOf(error) })
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

  async function getWithMeta<T>(
    path: string,
    getOptions?: WhoopGetOptions
  ): Promise<WhoopFetchResult<T>> {
    const deadlineMs = getOptions?.deadlineMs;
    if (getOptions?.cache && cache) {
      const key = cacheKey(path);
      if (getOptions.refresh === true) {
        cache.delete(key);
      }
      // The fetcher runs synchronously when this call starts the fetch, so a
      // rejection without it having run came from a fetch another call started.
      let ownFetch = false;
      try {
        const { value, storedAt, hit } = await cache.getOrFetchWithMeta<T>(
          key,
          getOptions.ttlMs ?? DEFAULT_TTL_MS,
          () => {
            ownFetch = true;
            return doGet<T>(path, deadlineMs);
          }
        );
        return { data: value, fetchedAt: storedAt, cacheStatus: hit ? "hit" : "miss" };
      } catch (error: unknown) {
        // A joined fetch runs within the deadline of the call that started it:
        // when that deadline stopped it and this call still has time, read once
        // more with this call's own deadline.
        const canStillRead = deadlineMs === undefined || Date.now() < deadlineMs;
        if (ownFetch || !(error instanceof WhoopRateBudgetError) || !canStillRead) {
          throw error;
        }
        const data = await doGet<T>(path, deadlineMs);
        return { data, fetchedAt: Date.now(), cacheStatus: "miss" };
      }
    }
    const data = await doGet<T>(path, deadlineMs);
    return { data, fetchedAt: Date.now(), cacheStatus: "miss" };
  }

  return {
    async get<T>(path: string, getOptions?: WhoopGetOptions): Promise<T> {
      return (await getWithMeta<T>(path, getOptions)).data;
    },
    getWithMeta,
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
  function refreshAccessTokenOnce(
    refresh: () => Promise<string>,
    endpoint: string
  ): Promise<string> {
    if (refreshInFlight !== null) {
      logger?.debug("whoop token refresh already in progress", logExtras({ endpoint }));
      return refreshInFlight;
    }
    const flight = (async (): Promise<string> => {
      const newToken = await refresh();
      accessToken = newToken;
      // The token owner (index.ts) logs the refresh at info; this line ties it to an endpoint.
      logger?.debug("whoop token refreshed", logExtras({ endpoint }));
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

  /**
   * Wait for the shared token refresh, but no longer than this request's
   * deadline. The refresh itself is not cancelled (other requests and the
   * stored tokens depend on it); only this request stops waiting, with a
   * WhoopNetworkError whose cause is a TimeoutError. A failed refresh is a
   * WhoopAuthError.
   */
  async function awaitRefresh(
    refresh: () => Promise<string>,
    endpoint: string,
    deadlineMs: number | undefined
  ): Promise<string> {
    const refreshing = refreshAccessTokenOnce(refresh, endpoint).catch(
      (refreshError: unknown): never => {
        throw new WhoopAuthError(refreshError);
      }
    );
    if (deadlineMs === undefined) {
      return refreshing;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => {
          reject(
            new WhoopNetworkError(
              new DOMException("The token refresh did not finish in time", "TimeoutError")
            )
          );
        },
        Math.max(0, deadlineMs - Date.now())
      );
    });
    try {
      return await Promise.race([refreshing, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function doGet<T>(path: string, deadlineMs?: number): Promise<T> {
    const url = `${baseUrl}${path}`;
    const endpoint = logEndpoint(path);
    let lastError: WhoopApiError | undefined;
    let lastResponse: Response | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Wait before retry (not before the first attempt)
      if (attempt > 0 && lastResponse) {
        const retryDelay =
          parseRetryAfter(lastResponse) ?? BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        if (deadlineMs !== undefined && Date.now() + retryDelay >= deadlineMs) {
          // The retry could not be sent before the deadline: stop now.
          throw new WhoopRateBudgetError({ cause: lastError });
        }
        await delay(retryDelay);
      }

      // Always send the latest token: another request may have refreshed it.
      const sentToken = accessToken;
      const response = await sendAttempt(url, endpoint, sentToken, deadlineMs);

      if (response.ok) {
        return await readJson<T>(response, endpoint);
      }

      const body = await parseErrorBody(response);
      const apiError = new WhoopApiError(response.status, response.statusText, body);

      // Only retry on 429 rate limit
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response);
        logger?.warn(
          "whoop api rate limited",
          logExtras({ endpoint, attempt, retryAfterMs: retryAfterMs ?? undefined })
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
          newToken = await awaitRefresh(options.onTokenRefresh, endpoint, deadlineMs);
        }

        // Retry with the new token
        const retryResponse = await sendAttempt(url, endpoint, newToken, deadlineMs);
        if (retryResponse.ok) {
          return await readJson<T>(retryResponse, endpoint);
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
