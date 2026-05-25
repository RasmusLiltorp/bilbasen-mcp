import { CACHE_MAX_ENTRIES, CACHE_TTL_MS } from "./constants.ts";

interface Entry {
  value: string;
  expires: number;
}

/**
 * Minimal in-memory TTL cache with insertion-order (FIFO) eviction.
 * Keeps recently fetched Bilbasen pages so repeated queries - and the
 * multi-page sampling done by the statistics tool - avoid redundant requests.
 */
class TtlCache {
  private store = new Map<string, Entry>();

  get(key: string): string | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: string): void {
    if (this.store.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  }

  clear(): void {
    this.store.clear();
  }
}

export const pageCache = new TtlCache();
