/**
 * MCP server for Bilbasen.dk — Denmark's largest used-car marketplace.
 *
 * Bilbasen has no public API and is protected by an AWS WAF JavaScript
 * challenge. A headless browser solves that challenge once; afterwards every
 * page is retrieved with a plain cached `fetch`. See session.ts for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CHARACTER_LIMIT } from "./constants.ts";
import { BilbasenBlockedError } from "./session.ts";
import {
  getListingDetail,
  getPriceStats,
  searchListings,
  type Listing,
  type NumericStats,
  type SearchFilters,
} from "./scraper.ts";

enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

const FilterShape = {
  query: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Free-text search, e.g. 'audi a4' or 'tesla model 3'. Matches make, model and variant."),
  fuel: z
    .enum(["benzin", "diesel", "el", "hybrid"])
    .optional()
    .describe("Fuel type filter. 'benzin'=petrol, 'el'=electric, 'hybrid'=plug-in hybrid."),
  gear: z
    .enum(["manual", "automatic"])
    .optional()
    .describe("Gearbox type filter."),
  seller_type: z
    .enum(["dealer", "private"])
    .optional()
    .describe("Restrict to dealer ('dealer') or private-seller ('private') listings."),
  price_from: z.number().int().min(0).optional().describe("Minimum cash price in DKK."),
  price_to: z.number().int().min(0).optional().describe("Maximum cash price in DKK."),
  year_from: z.number().int().min(1900).max(2100).optional().describe("Earliest model year."),
  year_to: z.number().int().min(1900).max(2100).optional().describe("Latest model year."),
  mileage_from: z.number().int().min(0).optional().describe("Minimum mileage in kilometres."),
  mileage_to: z.number().int().min(0).optional().describe("Maximum mileage in kilometres."),
  sort: z
    .enum(["relevance", "price_asc", "price_desc", "newest", "year_desc", "mileage_asc"])
    .optional()
    .describe("Result ordering: 'price_asc'/'price_desc' by price, 'newest' by listing date, 'year_desc' by model year, 'mileage_asc' by mileage. Default: relevance."),
};

const SearchInputSchema = z
  .object({
    ...FilterShape,
    page: z.number().int().min(1).max(100).default(1).describe("Results page (30 listings per page)."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(30)
      .describe("Maximum listings to return from the page."),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable."),
  })
  .strict();

const ListingInputSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((u) => u.includes("bilbasen.dk"), "Must be a bilbasen.dk listing URL")
      .describe("Full Bilbasen listing URL, as returned in the 'url' field of bilbasen_search_listings."),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable."),
  })
  .strict();

const StatsInputSchema = z
  .object({
    ...FilterShape,
    max_pages: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(3)
      .describe("How many result pages (30 listings each) to sample for the statistics."),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe("Output format: 'markdown' for human-readable or 'json' for machine-readable."),
  })
  .strict();

function pickFilters(input: Record<string, unknown>): SearchFilters {
  return {
    query: input.query as string | undefined,
    fuel: input.fuel as string | undefined,
    gear: input.gear as string | undefined,
    price_from: input.price_from as number | undefined,
    price_to: input.price_to as number | undefined,
    year_from: input.year_from as number | undefined,
    year_to: input.year_to as number | undefined,
    mileage_from: input.mileage_from as number | undefined,
    mileage_to: input.mileage_to as number | undefined,
    seller_type: input.seller_type as string | undefined,
    sort: input.sort as string | undefined,
  };
}

function listingToMarkdown(l: Listing): string {
  const lines = [
    `## ${l.make} ${l.model} ${l.variant} (#${l.id})`,
    `- **Price**: ${l.display_price || "n/a"}`,
    `- **Year**: ${l.first_registration || "n/a"} | **Mileage**: ${
      l.mileage_km != null ? l.mileage_km.toLocaleString("da-DK") + " km" : "n/a"
    }`,
    `- **Fuel/Gear**: ${l.fuel || "n/a"} / ${l.gear || "n/a"} | **Power**: ${l.horsepower || "n/a"}`,
    `- **Location**: ${[l.city, l.zip_code, l.region].filter(Boolean).join(", ")} (${l.seller_type || "n/a"})`,
    `- **URL**: ${l.url}`,
  ];
  return lines.join("\n");
}

function statsBlock(label: string, s: NumericStats | null, unit: string, raw = false): string {
  if (!s) return `- **${label}**: no data`;
  const f = (n: number) => (raw ? String(n) : n.toLocaleString("da-DK"));
  return `- **${label}** (n=${s.count}): min ${f(s.min)}${unit}, median ${f(s.median)}${unit}, mean ${f(
    s.mean,
  )}${unit}, max ${f(s.max)}${unit}`;
}

function toolResult(text: string, structured: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: structured as Record<string, unknown>,
  };
}

function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${message}` }],
  };
}

function describeError(error: unknown): string {
  if (error instanceof BilbasenBlockedError) {
    return `${error.message} Bilbasen's anti-bot protection blocked the request.`;
  }
  return error instanceof Error ? error.message : String(error);
}

const server = new McpServer({
  name: "bilbasen-mcp-server",
  version: "1.0.0",
});

server.registerTool(
  "bilbasen_search_listings",
  {
    title: "Search Bilbasen Car Listings",
    description: `Search used-car listings on Bilbasen.dk (Denmark's largest car marketplace).

Filters can be combined freely. Results are paginated at 30 listings per page.
This is a read-only search; it does not contact sellers or modify anything.

Args:
  - query (string, optional): Free-text search across make/model/variant
  - fuel ('benzin'|'diesel'|'el'|'hybrid', optional): Fuel type
  - gear ('manual'|'automatic', optional): Gearbox type
  - seller_type ('dealer'|'private', optional): Restrict by seller
  - price_from / price_to (number, optional): Cash price range in DKK
  - year_from / year_to (number, optional): Model year range
  - mileage_from / mileage_to (number, optional): Mileage range in km
  - sort ('relevance'|'price_asc'|'price_desc'|'newest'|'year_desc'|'mileage_asc'): Result ordering (default: 'relevance')
  - page (number): Results page, 1-100 (default: 1)
  - limit (number): Max listings to return, 1-30 (default: 30)
  - response_format ('markdown'|'json'): Output format (default: 'markdown')

Returns JSON with schema:
  {
    "total": number,        // Total matches for these filters
    "page": number,
    "count": number,        // Listings in this response
    "has_more": boolean,
    "listings": [ { "id", "url", "make", "model", "variant", "price_kr",
                    "display_price", "year", "mileage_km", "fuel", "gear",
                    "horsepower", "city", "region", "seller_type", ... } ]
  }

Examples:
  - "Find automatic Audi A4s under 250.000 kr" -> query='audi a4', gear='automatic', price_to=250000
  - "Cheapest electric cars from 2022 or newer" -> fuel='el', year_from=2022, sort='price_asc'
  - "Newest private-seller VW Golfs" -> query='vw golf', seller_type='private', sort='newest'`,
    inputSchema: SearchInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input) => {
    try {
      const result = await searchListings(pickFilters(input), input.page);
      const listings = result.listings.slice(0, input.limit);
      const structured = {
        total: result.total,
        page: result.page,
        count: listings.length,
        has_more: result.has_more,
        listings,
      };

      if (listings.length === 0) {
        return toolResult("No listings found matching the given filters.", structured);
      }

      let text: string;
      if (input.response_format === ResponseFormat.JSON) {
        text = JSON.stringify(structured, null, 2);
      } else {
        text = [
          `# Bilbasen results (${result.total} total, page ${result.page})`,
          "",
          ...listings.map(listingToMarkdown),
          "",
          result.has_more ? `More results available — request page ${result.page + 1}.` : "End of results.",
        ].join("\n\n");
      }

      if (text.length > CHARACTER_LIMIT) {
        const half = Math.max(1, Math.floor(listings.length / 2));
        const trimmed = { ...structured, listings: listings.slice(0, half), truncated: true };
        text =
          JSON.stringify(trimmed, null, 2) +
          `\n\nResponse truncated to ${half} listings. Use 'limit' or add filters to narrow results.`;
        return toolResult(text, trimmed);
      }
      return toolResult(text, structured);
    } catch (error) {
      return toolError(describeError(error));
    }
  },
);

server.registerTool(
  "bilbasen_get_listing",
  {
    title: "Get Bilbasen Listing Details",
    description: `Fetch full details for a single Bilbasen car listing by URL.

Returns the complete fact sheet, general model information, equipment list,
dealer details, financing, and the seller's description text.
Use bilbasen_search_listings first to obtain listing URLs.

Args:
  - url (string): Full bilbasen.dk listing URL (from a search result's 'url' field)
  - response_format ('markdown'|'json'): Output format (default: 'markdown')

Returns JSON with schema:
  {
    "url": string,
    "title": string,
    "display_price": string,
    "monthly_payment": string | null,
    "finance_company": string | null,
    "facts": { <label>: <value>, ... },        // mileage, fuel, power, etc.
    "model_info": { <label>: <value>, ... },   // dimensions, weight, etc.
    "equipment": string[],
    "dealer_name": string | null,
    "dealer_address": string | null,
    "description": string
  }

Error Handling:
  - Returns an error if the URL is unreachable or no longer listed.`,
    inputSchema: ListingInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input) => {
    try {
      const detail = await getListingDetail(input.url);

      let text: string;
      if (input.response_format === ResponseFormat.JSON) {
        text = JSON.stringify(detail, null, 2);
      } else {
        const factLines = Object.entries(detail.facts).map(([k, v]) => `- **${k}**: ${v}`);
        const modelLines = Object.entries(detail.model_info).map(([k, v]) => `- **${k}**: ${v}`);
        text = [
          `# ${detail.title}`,
          `**Price**: ${detail.display_price}` +
            (detail.monthly_payment ? ` | **Monthly**: ${detail.monthly_payment}` : ""),
          detail.dealer_name ? `**Dealer**: ${detail.dealer_name} — ${detail.dealer_address ?? ""}` : "",
          "",
          "## Facts",
          ...factLines,
          "",
          "## Model information",
          ...modelLines,
          "",
          `## Equipment (${detail.equipment.length})`,
          detail.equipment.join(", "),
          "",
          "## Description",
          detail.description || "(none)",
        ]
          .filter((l) => l !== "")
          .join("\n");
      }

      if (text.length > CHARACTER_LIMIT) {
        text = text.slice(0, CHARACTER_LIMIT) + "\n\n[Response truncated]";
      }
      return toolResult(text, detail);
    } catch (error) {
      return toolError(describeError(error));
    }
  },
);

server.registerTool(
  "bilbasen_price_stats",
  {
    title: "Bilbasen Price Statistics",
    description: `Compute aggregate price, mileage and model-year statistics across Bilbasen
listings matching a set of filters. Useful for understanding the market value
of a given car before buying or selling.

Samples up to max_pages result pages (30 listings each) and reports min, max,
mean and median for price (DKK), mileage (km) and model year.

The 'sort' filter is accepted but does not affect the statistics.

Args:
  - query (string, optional): Free-text search across make/model/variant
  - fuel ('benzin'|'diesel'|'el'|'hybrid', optional): Fuel type
  - gear ('manual'|'automatic', optional): Gearbox type
  - seller_type ('dealer'|'private', optional): Restrict by seller
  - price_from / price_to (number, optional): Cash price range in DKK
  - year_from / year_to (number, optional): Model year range
  - mileage_from / mileage_to (number, optional): Mileage range in km
  - max_pages (number): Result pages to sample, 1-10 (default: 3)
  - response_format ('markdown'|'json'): Output format (default: 'markdown')

Returns JSON with schema:
  {
    "total_matches": number,   // All listings matching the filters
    "sample_size": number,     // Listings actually included in the stats
    "pages_fetched": number,
    "price":      { "count", "min", "max", "mean", "median" } | null,
    "mileage_km": { "count", "min", "max", "mean", "median" } | null,
    "model_year": { "count", "min", "max", "mean", "median" } | null
  }

Examples:
  - "What's the going rate for a Tesla Model 3?" -> query='tesla model 3'
  - "Price spread for diesel cars under 5 years old" -> fuel='diesel', year_from=2021`,
    inputSchema: StatsInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (input) => {
    try {
      const stats = await getPriceStats(pickFilters(input), input.max_pages);

      if (stats.sample_size === 0) {
        return toolResult("No listings found matching the given filters.", stats);
      }

      let text: string;
      if (input.response_format === ResponseFormat.JSON) {
        text = JSON.stringify(stats, null, 2);
      } else {
        text = [
          `# Bilbasen price statistics`,
          `Matched ${stats.total_matches} listings; sampled ${stats.sample_size} across ${stats.pages_fetched} page(s).`,
          "",
          statsBlock("Price", stats.price, " kr"),
          statsBlock("Mileage", stats.mileage_km, " km"),
          statsBlock("Model year", stats.model_year, "", true),
        ].join("\n");
      }
      return toolResult(text, stats);
    } catch (error) {
      return toolError(describeError(error));
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("bilbasen-mcp-server running on stdio");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => process.exit(0));
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
