/**
 * Global in-memory API result cache with TTL.
 *
 * Caches Reloadly discovery results (operators, billers, gift cards, FX rates)
 * so that repeated requests within the TTL window are instant — no API call needed.
 *
 * This is a GLOBAL cache shared across all users. When user A fetches operators
 * for Nigeria, user B gets the cached result if they ask within the TTL window.
 *
 * What's cached (30 min): operators, billers, gift cards, country services, detect operator
 * What's cached (15 min): promotions, FX rates, gift card search
 * What's NOT cached: transactions, balance, redeem codes (unique per request)
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const MAX_CACHE_ENTRIES = 2000;

class ApiCache {
  private store = new Map<string, CacheEntry<any>>();

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    // Move to end of Map iteration order (LRU: recently accessed = last evicted)
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.data;
  }

  set<T>(key: string, data: T, ttlMs: number): void {
    // If updating existing key, delete first to move to end of Map order
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= MAX_CACHE_ENTRIES) {
      // Evict: prefer expired entries first, then oldest-accessed (LRU)
      const now = Date.now();
      let evicted = false;
      for (const [k, v] of this.store) {
        if (now > v.expiresAt) {
          this.store.delete(k);
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        // No expired entries — evict least-recently-used (first in Map order)
        const firstKey = this.store.keys().next().value;
        if (firstKey !== undefined) this.store.delete(firstKey);
      }
    }
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  /** Clean up expired entries (call periodically) */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }

  get size() { return this.store.size; }
}

export const apiCache = new ApiCache();

// Clean up expired entries every 10 minutes
setInterval(() => apiCache.cleanup(), 10 * 60 * 1000);

/** Cache TTLs — tuned per data volatility */
export const CACHE_TTL = {
  /** Operators, billers, gift card products — rarely change */
  OPERATORS: 60 * 60 * 1000,
  BILLERS: 60 * 60 * 1000,
  GIFT_CARDS: 60 * 60 * 1000,
  COUNTRY_SERVICES: 60 * 60 * 1000,
  DETECT_OPERATOR: 60 * 60 * 1000,

  /** Promotions, FX rates, search — change more often */
  PROMOTIONS: 15 * 60 * 1000,
  FX_RATE: 15 * 60 * 1000,
  SEARCH: 60 * 60 * 1000,
} as const;
