/**
 * Generic in-memory cache with TTL expiry, LRU eviction, and in-flight
 * request deduplication.
 *
 * Single source of truth for caching across the server — used by both the
 * API client (opt-in per-request caching) and the MCP resources layer.
 *
 * Design notes:
 * - Expiry is lazy: entries are pruned on access, not via a background timer.
 * - LRU order is tracked by `Map` insertion order; a "use" (get/set) moves the
 *   key to the most-recently-used position by delete-then-reinsert.
 * - `getOrFetch` adds stampede prevention (concurrent misses share one fetch)
 *   and a generation counter so a `clear()` (or a matching `deleteWhere()`)
 *   mid-flight cannot repopulate the cache with stale data.
 * - `getOrFetchWithMeta` also reports hit/miss and the stored-at time, and can
 *   decline to store a value (e.g. an incomplete history chunk).
 * - `getOrFetch` honours the reading caller's TTL as well as the writer's: an
 *   entry older than the reader's `ttlMs` is a miss. Callers that share a key
 *   with different freshness needs (e.g. a 2-minute resource and a longer-lived
 *   lookup) are never served data older than they asked for.
 * - No tokens or auth data should ever be used as cache keys (caller's
 *   responsibility — keys are endpoint + sorted params).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default time-to-live for entries when none is supplied — 5 minutes. */
export const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Default maximum number of entries before LRU eviction kicks in. */
export const DEFAULT_MAX_ENTRIES = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for constructing a {@link MemoryCache}. */
export interface MemoryCacheOptions {
  /** Default TTL in milliseconds applied to `set`/`getOrFetch` calls without an explicit TTL. */
  defaultTtlMs?: number;
  /** Maximum entries retained before the least-recently-used entry is evicted. */
  maxEntries?: number;
}

/** Options for {@link MemoryCache.getOrFetchWithMeta}. */
export interface GetOrFetchOptions<R> {
  /** Return false to skip storing a fetched value (it is still returned to the callers). */
  store?: (value: R) => boolean;
}

/** A value served by {@link MemoryCache.getOrFetchWithMeta}. */
export interface CacheFetchResult<R> {
  value: R;
  /** Epoch ms when the value was stored (hit) or fetched (miss). */
  storedAt: number;
  /** True when the value came from a stored entry rather than a fetch. */
  hit: boolean;
}

interface InflightEntry {
  /** Generation the fetch may store under; `deleteWhere` moves non-matching fetches forward. */
  generation: number;
  promise: Promise<{ value: unknown; storedAt: number }>;
}

interface CacheEntry {
  value: unknown;
  /** Epoch ms after which the entry is expired for every reader (the writer's TTL). */
  expiry: number;
  /** Epoch ms when the entry was written, so each reader can apply its own TTL. */
  storedAt: number;
}

// ---------------------------------------------------------------------------
// MemoryCache
// ---------------------------------------------------------------------------

/**
 * LRU + TTL in-memory cache.
 *
 * The instance type `T` describes the values stored via `get`/`set`. The
 * `getOrFetch` method is independently generic so a single shared cache can
 * hold heterogeneous values (instantiate as `MemoryCache<unknown>`).
 */
export class MemoryCache<T = unknown> {
  private readonly store = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, InflightEntry>();
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;
  private generation = 0;

  constructor(options: MemoryCacheOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** Number of unexpired entries currently retained. */
  get size(): number {
    return this.store.size;
  }

  /**
   * Return the cached value for `key`, or `undefined` if missing or expired.
   * A hit moves the key to the most-recently-used position.
   */
  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (Date.now() >= entry.expiry) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh LRU position.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value as T;
  }

  /** Return true only if `key` exists and is within its TTL. */
  has(key: string): boolean {
    const entry = this.store.get(key);
    if (entry === undefined) {
      return false;
    }
    if (Date.now() >= entry.expiry) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Store `value` under `key` with an optional TTL override.
   * Evicts the least-recently-used entry if `maxEntries` would be exceeded.
   */
  set(key: string, value: T, ttlMs?: number): void {
    // Treat a write to an existing key as a use (move to MRU).
    this.writeEntry(key, value, ttlMs ?? this.defaultTtlMs, Date.now());
  }

  /** Remove a single entry. Returns true if an entry was removed. */
  delete(key: string): boolean {
    return this.store.delete(key);
  }

  /**
   * Remove all entries and bump the generation counter so any in-flight
   * `getOrFetch` resolving after this call does not repopulate the cache.
   */
  clear(): void {
    this.store.clear();
    this.inflight.clear();
    this.generation++;
  }

  /** Alias for {@link clear}, kept for call sites that invalidate on token refresh. */
  invalidateAll(): void {
    this.clear();
  }

  /**
   * Remove every stored and in-flight entry whose key matches `predicate` and
   * bump the generation, so a matching fetch that is still in flight cannot
   * store its (possibly stale) result. In-flight fetches for keys that do not
   * match keep their right to store.
   *
   * @returns The number of distinct keys removed (stored, in flight, or both).
   */
  deleteWhere(predicate: (key: string) => boolean): number {
    const removed = new Set<string>();
    for (const key of [...this.store.keys()]) {
      if (predicate(key)) {
        this.store.delete(key);
        removed.add(key);
      }
    }
    for (const [key, flight] of [...this.inflight.entries()]) {
      if (predicate(key)) {
        this.inflight.delete(key);
        removed.add(key);
      } else {
        flight.generation = this.generation + 1;
      }
    }
    this.generation++;
    return removed.size;
  }

  /**
   * Return the cached value for `key`, or run `fetcher` to populate it.
   * Concurrent misses for the same key share a single in-flight request.
   *
   * `ttlMs` is both the TTL stored on a freshly fetched entry and the maximum
   * age this caller accepts: an entry written `ttlMs` or more ago is refetched,
   * even when another caller stored it with a longer TTL.
   */
  async getOrFetch<R>(key: string, ttlMs: number, fetcher: () => Promise<R>): Promise<R> {
    return (await this.getOrFetchWithMeta(key, ttlMs, fetcher)).value;
  }

  /**
   * {@link getOrFetch} that also reports whether the value came from the cache
   * (`hit`) and when it was stored or fetched (`storedAt`, epoch ms).
   *
   * A fetched value is stored only when no `clear`/matching `deleteWhere`
   * happened while it was in flight and `options.store(value)` does not return
   * false (e.g. an incomplete result that must not be served to later readers).
   * Callers joining an in-flight fetch share its result with `hit: false`.
   */
  getOrFetchWithMeta<R>(
    key: string,
    ttlMs: number,
    fetcher: () => Promise<R>,
    options: GetOrFetchOptions<R> = {}
  ): Promise<CacheFetchResult<R>> {
    const entry = this.store.get(key);
    if (entry !== undefined) {
      const now = Date.now();
      if (now >= entry.expiry) {
        this.store.delete(key);
      } else if (now - entry.storedAt < ttlMs) {
        // Fresh enough for this reader: refresh the LRU position and serve it.
        this.store.delete(key);
        this.store.set(key, entry);
        return Promise.resolve({ value: entry.value as R, storedAt: entry.storedAt, hit: true });
      }
    }

    const existing = this.inflight.get(key);
    if (existing !== undefined) {
      return existing.promise.then((result) => ({
        value: result.value as R,
        storedAt: result.storedAt,
        hit: false,
      }));
    }

    const flight: InflightEntry = {
      generation: this.generation,
      promise: Promise.resolve({ value: undefined, storedAt: 0 }),
    };
    const settle = (): void => {
      if (this.inflight.get(key) === flight) {
        this.inflight.delete(key);
      }
    };
    const run = async (): Promise<{ value: R; storedAt: number }> => {
      try {
        const value = await fetcher();
        const storedAt = Date.now();
        if (
          flight.generation === this.generation &&
          this.inflight.get(key) === flight &&
          options.store?.(value) !== false
        ) {
          this.writeEntry(key, value, ttlMs, storedAt);
        }
        return { value, storedAt };
      } finally {
        settle();
      }
    };
    // Registered before the fetcher runs, so a synchronous throw still settles it.
    this.inflight.set(key, flight);
    const promise = run();
    flight.promise = promise;
    return promise.then(({ value, storedAt }) => ({ value, storedAt, hit: false }));
  }

  private writeEntry(key: string, value: unknown, ttlMs: number, storedAt: number): void {
    this.store.delete(key);
    this.store.set(key, { value, expiry: storedAt + ttlMs, storedAt });
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    while (this.store.size > this.maxEntries) {
      // The first key in insertion order is the least-recently-used.
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.store.delete(oldest);
    }
  }
}
