export const BASE_URL = "https://www.bilbasen.dk/brugt/bil";

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Maximum response size in characters before results are truncated.
export const CHARACTER_LIMIT = 25000;

// Listings shown per Bilbasen search results page.
export const PAGE_SIZE = 30;

// How long fetched pages stay cached in memory (listings change slowly).
export const CACHE_TTL_MS = 5 * 60 * 1000;

// Maximum number of pages kept in the in-memory cache.
export const CACHE_MAX_ENTRIES = 200;

// Network request timeout for plain fetches, in milliseconds.
export const FETCH_TIMEOUT_MS = 30000;

// Bilbasen URL query codes for the `fuel` filter.
export const FUEL_CODES: Record<string, number> = {
  benzin: 1,
  diesel: 2,
  el: 3,
  hybrid: 6,
};

// Bilbasen URL query codes for the `gear` filter.
export const GEAR_CODES: Record<string, number> = {
  manual: 1,
  automatic: 2,
};
