import { load } from "cheerio";
import { fetchHtml } from "./session.ts";
import { BASE_URL, FUEL_CODES, GEAR_CODES, PAGE_SIZE } from "./constants.ts";

export interface SearchFilters {
  query?: string;
  fuel?: string;
  gear?: string;
  price_from?: number;
  price_to?: number;
  year_from?: number;
  year_to?: number;
  mileage_from?: number;
  mileage_to?: number;
  seller_type?: string;
  sort?: string;
}

export interface Listing {
  id: number;
  url: string;
  make: string;
  model: string;
  variant: string;
  price_kr: number | null;
  display_price: string;
  year: number | null;
  first_registration: string;
  mileage_km: number | null;
  fuel: string;
  gear: string;
  horsepower: string;
  fuel_economy: string;
  city: string;
  zip_code: number | null;
  region: string;
  seller_type: string;
  image_url: string | null;
  description: string;
}

export interface SearchResult {
  total: number;
  page: number;
  listings: Listing[];
  has_more: boolean;
}

export interface ListingDetail {
  url: string;
  title: string;
  display_price: string;
  monthly_payment: string | null;
  finance_company: string | null;
  facts: Record<string, string>;
  model_info: Record<string, string>;
  equipment: string[];
  dealer_name: string | null;
  dealer_address: string | null;
  description: string;
}

// Bilbasen URL values for the `sort` parameter (sortby + sortorder).
const SORT_VALUES: Record<string, { sortby?: string; sortorder?: string }> = {
  relevance: {},
  price_asc: { sortby: "price", sortorder: "asc" },
  price_desc: { sortby: "price", sortorder: "desc" },
  newest: { sortby: "date", sortorder: "desc" },
  year_desc: { sortby: "year", sortorder: "desc" },
  mileage_asc: { sortby: "mileage", sortorder: "asc" },
};

export const SORT_OPTIONS = Object.keys(SORT_VALUES);

// Bilbasen URL values for the `SellerTypes` parameter.
const SELLER_TYPE_VALUES: Record<string, string> = {
  dealer: "Dealer",
  private: "Private",
};

export const SELLER_TYPE_OPTIONS = Object.keys(SELLER_TYPE_VALUES);

/** Strips Danish thousands separators and units, returning the integer value. */
function parseInteger(text: string | undefined | null): number | null {
  if (!text) return null;
  const digits = text.replace(/[^\d]/g, "");
  return digits ? parseInt(digits, 10) : null;
}

/** Extracts a 4-digit year from strings like "12/2018" or "2019". */
function parseYear(text: string | undefined | null): number | null {
  if (!text) return null;
  const match = text.match(/(\d{4})/);
  return match ? parseInt(match[1], 10) : null;
}

export function buildSearchUrl(filters: SearchFilters, page: number): string {
  const params = new URLSearchParams();
  if (filters.query) params.set("free", filters.query);
  if (filters.fuel && FUEL_CODES[filters.fuel] !== undefined) {
    params.set("fuel", String(FUEL_CODES[filters.fuel]));
  }
  if (filters.gear && GEAR_CODES[filters.gear] !== undefined) {
    params.set("gear", String(GEAR_CODES[filters.gear]));
  }
  if (filters.price_from !== undefined) params.set("pricefrom", String(filters.price_from));
  if (filters.price_to !== undefined) params.set("priceto", String(filters.price_to));
  if (filters.year_from !== undefined) params.set("yearfrom", String(filters.year_from));
  if (filters.year_to !== undefined) params.set("yearto", String(filters.year_to));
  if (filters.mileage_from !== undefined) params.set("mileagefrom", String(filters.mileage_from));
  if (filters.mileage_to !== undefined) params.set("mileageto", String(filters.mileage_to));
  if (filters.seller_type && SELLER_TYPE_VALUES[filters.seller_type]) {
    params.set("SellerTypes", SELLER_TYPE_VALUES[filters.seller_type]);
  }
  if (filters.sort && SORT_VALUES[filters.sort]) {
    const { sortby, sortorder } = SORT_VALUES[filters.sort];
    if (sortby) params.set("sortby", sortby);
    if (sortorder) params.set("sortorder", sortorder);
  }
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `${BASE_URL}?${query}` : BASE_URL;
}

interface RawListing {
  externalId: number;
  uri: string;
  make: string;
  model: string;
  variant: string;
  price?: { price?: number; displayPrice?: string };
  location?: { city?: string; zipCode?: number; region?: string };
  media?: { mediaType: string; url: string }[];
  properties?: Record<string, { displayTextShort?: string; displayTextLong?: string }>;
  sellerType?: string;
  description?: string;
}

function mapListing(raw: RawListing): Listing {
  const props = raw.properties ?? {};
  const prop = (k: string): string => props[k]?.displayTextShort ?? "";
  const picture = raw.media?.find((m) => m.mediaType === "Picture")?.url ?? null;
  return {
    id: raw.externalId,
    url: raw.uri,
    make: raw.make ?? "",
    model: raw.model ?? "",
    variant: raw.variant ?? "",
    price_kr: raw.price?.price ?? null,
    display_price: raw.price?.displayPrice ?? "",
    year: parseYear(prop("firstregistrationdate")),
    first_registration: prop("firstregistrationdate"),
    mileage_km: parseInteger(prop("mileage")),
    fuel: prop("fueltype"),
    gear: prop("geartype"),
    horsepower: prop("hk"),
    fuel_economy: prop("kml"),
    city: raw.location?.city ?? "",
    zip_code: raw.location?.zipCode ?? null,
    region: raw.location?.region ?? "",
    seller_type: raw.sellerType ?? "",
    image_url: picture,
    description: (raw.description ?? "").trim(),
  };
}

/** Extracts and parses the Next.js `__NEXT_DATA__` payload from a search page. */
function parseSearchPage(html: string, page: number): SearchResult {
  // Search pages are ~1 MB; a regex avoids the cost of parsing the whole DOM.
  // Next.js escapes `<` as `<` inside this script, so `</script>` is safe.
  const match = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  const json = match?.[1];
  if (!json) {
    throw new Error("Bilbasen search page contained no data (the page layout may have changed).");
  }

  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("Failed to parse Bilbasen search data.");
  }

  const queries =
    (data as { props?: { pageProps?: { dehydratedState?: { queries?: unknown[] } } } })
      ?.props?.pageProps?.dehydratedState?.queries ?? [];
  const searchQuery = queries.find(
    (q) =>
      Array.isArray((q as { queryKey?: unknown[] }).queryKey) &&
      (q as { queryKey: unknown[] }).queryKey[0] === "search",
  ) as { state?: { data?: { listings?: RawListing[]; hits?: number } } } | undefined;

  const result = searchQuery?.state?.data;
  if (!result) {
    throw new Error("Bilbasen search returned no result set (the page layout may have changed).");
  }

  const rawListings = result.listings ?? [];
  const total = result.hits ?? rawListings.length;
  return {
    total,
    page,
    listings: rawListings.map(mapListing),
    has_more: page * PAGE_SIZE < total,
  };
}

export async function searchListings(
  filters: SearchFilters,
  page: number,
): Promise<SearchResult> {
  const html = await fetchHtml(buildSearchUrl(filters, page));
  return parseSearchPage(html, page);
}

export async function getListingDetail(url: string): Promise<ListingDetail> {
  const html = await fetchHtml(url);
  const $ = load(html);

  const e2eText = (key: string): string =>
    $(`[data-e2e="${key}"]`).first().text().trim();

  const parseTable = (key: string): Record<string, string> => {
    const rows: Record<string, string> = {};
    $(`[data-e2e="${key}"] tr`).each((_, tr) => {
      const th = $(tr).find("th").first();
      const td = $(tr).find("td").first();
      const label = th.text().trim();
      if (label && td.length) rows[label] = td.text().trim();
    });
    return rows;
  };

  if (!e2eText("car-make-model-variant")) {
    throw new Error(
      `No listing found at ${url}. The advert may have been removed or the URL is invalid.`,
    );
  }

  let description = "";
  $("h2, h3").each((_, el) => {
    if (description) return;
    if (/beskriv/i.test($(el).text())) {
      description = $(el)
        .parent()
        .text()
        .replace(/^\s*Beskrivelse\s*/i, "")
        .trim();
    }
  });

  const dealerName = e2eText("vip-section-seller-more-info")
    .replace(/^Om\s+/i, "")
    .split("\n")[0]
    .trim();

  const financeTop = e2eText("finance-top-button");
  const monthlyMatch = financeTop.match(/([\d.]+)\s*kr/);

  return {
    url,
    title: e2eText("car-make-model-variant"),
    display_price: e2eText("car-retail-price"),
    monthly_payment: monthlyMatch ? `${monthlyMatch[1]} kr` : null,
    finance_company: e2eText("finance-company") || null,
    facts: {
      ...parseTable("car-facts-table-preview"),
      ...parseTable("car-facts-table-collapsed"),
    },
    model_info: {
      ...parseTable("model-information-table-preview"),
      ...parseTable("model-information-table-collapsed"),
    },
    equipment: $('[data-e2e="car-equipment-item"]')
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean),
    dealer_name: dealerName || null,
    dealer_address: e2eText("seller-address") || null,
    description,
  };
}

export interface NumericStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
}

function computeStats(values: number[]): NumericStats | null {
  const sorted = values.filter((v) => v != null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round(sum / sorted.length),
    median: Math.round(median),
  };
}

export interface PriceStats {
  total_matches: number;
  sample_size: number;
  pages_fetched: number;
  price: NumericStats | null;
  mileage_km: NumericStats | null;
  model_year: NumericStats | null;
}

export async function getPriceStats(
  filters: SearchFilters,
  maxPages: number,
): Promise<PriceStats> {
  const first = await searchListings(filters, 1);
  const totalPages = Math.min(
    maxPages,
    Math.max(1, Math.ceil(first.total / PAGE_SIZE)),
  );

  // Pages are fetched sequentially: a burst of parallel requests can trip
  // Bilbasen's WAF, and warm cached fetches are fast enough that serial wins.
  const collected: Listing[] = [...first.listings];
  let pagesFetched = 1;
  for (let page = 2; page <= totalPages; page++) {
    const next = await searchListings(filters, page);
    collected.push(...next.listings);
    pagesFetched = page;
    if (!next.has_more) break;
  }

  return {
    total_matches: first.total,
    sample_size: collected.length,
    pages_fetched: pagesFetched,
    price: computeStats(
      collected.map((l) => l.price_kr).filter((v): v is number => v != null),
    ),
    mileage_km: computeStats(
      collected.map((l) => l.mileage_km).filter((v): v is number => v != null),
    ),
    model_year: computeStats(
      collected.map((l) => l.year).filter((v): v is number => v != null),
    ),
  };
}
