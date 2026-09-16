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
 *   and a generation counter so a `clear()` mid-flight cannot repopulate the
 *   cache with stale data.
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
  private readonly inflight = new Map<string, Promise<unknown>>();
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
    this.store.delete(key);
    const now = Date.now();
    this.store.set(key, { value, expiry: now + (ttlMs ?? this.defaultTtlMs), storedAt: now });
    this.evictIfNeeded();
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
   * Return the cached value for `key`, or run `fetcher` to populate it.
   * Concurrent misses for the same key share a single in-flight request.
   *
   * `ttlMs` is both the TTL stored on a freshly fetched entry and the maximum
   * age this caller accepts: an entry written `ttlMs` or more ago is refetched,
   * even when another caller stored it with a longer TTL.
   */
  async getOrFetch<R>(key: string, ttlMs: number, fetcher: () => Promise<R>): Promise<R> {
    const entry = this.store.get(key);
    if (entry !== undefined) {
      const now = Date.now();
      if (now >= entry.expiry) {
        this.store.delete(key);
      } else if (now - entry.storedAt < ttlMs) {
        // Fresh enough for this reader: refresh the LRU position and serve it.
        this.store.delete(key);
        this.store.set(key, entry);
        return entry.value as R;
      }
    }

    const existing = this.inflight.get(key);
    if (existing !== undefined) {
      return existing as Promise<R>;
    }

    const gen = this.generation;
    const promise = fetcher()
      .then((data) => {
        if (this.generation === gen) {
          this.set(key, data as unknown as T, ttlMs);
        }
        this.inflight.delete(key);
        return data;
      })
      .catch((error: unknown) => {
        this.inflight.delete(key);
        throw error;
      });

    this.inflight.set(key, promise);
    return promise;
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
