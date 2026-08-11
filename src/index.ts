/**
 * MCP server for Bilbasen.dk - Denmark's largest used-car marketplace.
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
  BODY_TYPE_OPTIONS,
  CHARGER_TYPE_OPTIONS,
  COLOR_OPTIONS,
  CYLINDER_OPTIONS,
  DOOR_OPTIONS,
  DRIVE_WHEEL_OPTIONS,
  EQUIPMENT_FLAGS,
  EQUIPMENT_OPTIONS,
  getListingDetail,
  getPriceStats,
  searchListings,
  type Listing,
  type NumericStats,
  type SearchFilters,
} from "./scraper.ts";

/** Wraps a runtime string list as a Zod enum (Zod needs a non-empty tuple type). */
const enumFrom = (values: string[]) => z.enum(values as [string, ...string[]]);
const EQUIPMENT_SET = new Set(EQUIPMENT_OPTIONS);
const equipmentCategories = Object.entries(EQUIPMENT_FLAGS)
  .map(([cat, flags]) => `${cat}: ${flags.join(", ")}`)
  .join("\n");

enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

/**
 * The advanced filters roughly triple the size of the published tool schema,
 * which every session pays for whether or not it searches by tow-bar type. They
 * are therefore opt-in: set BILBASEN_FILTERS=full to expose them.
 */
// Accepts "true"/"1" as well as "full" so the .mcpb boolean user_config, which
// interpolates as the string "true", can drive this without a separate knob.
const ADVANCED_FILTERS_ENABLED = ["full", "true", "1"].includes(
  (process.env.BILBASEN_FILTERS ?? "").trim().toLowerCase(),
);

const CoreFilterShape = {
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

/** Appended to the search tool description only when the advanced tier is on. */
const ADVANCED_ARGS_NOTE = `
Advanced filters are enabled: towing, EV battery/charging, body, colour, doors,
seats, boot, performance, economy, emissions, location and equipment flags.
Spec filters (euro_norm_min, co2_max, trunk_size_min, ...) exclude listings that
do not report that spec at all, so they narrow results more than expected.`;

/** Opt-in filters, exposed only when BILBASEN_FILTERS=full. */
const AdvancedFilterShape = {
  min_tow: z
    .number()
    .int()
    .min(1)
    .max(9999)
    .optional()
    .describe(
      "Minimum braked towing capacity in kg (Anhængertræk / anhængervægt). Only returns cars rated to tow at least this weight.",
    ),
  tow_bar: z
    .array(z.enum(["fixed", "removable", "swing_manual", "swing_electric"]))
    .optional()
    .describe(
      "Require a fitted tow bar of the given type(s). fixed=fast monteret, removable=aftageligt, swing_manual=svingbart manuelt, swing_electric=svingbart elektrisk. NOTE: multiple types are AND-combined (a car must have all of them). To match any fitted bar, search each type separately and merge.",
    ),
  // --- Battery & charging (EV) ---
  electric_range_min: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Minimum electric/plug-in range in km (WLTP)."),
  battery_capacity_min: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Minimum battery capacity in kWh."),
  charger_type: z
    .array(enumFrom(CHARGER_TYPE_OPTIONS))
    .optional()
    .describe("Required charging connector(s). OR-combined."),
  charge_time_dc_max: z
    .number()
    .int()
    .min(15)
    .max(50)
    .multipleOf(5)
    .optional()
    .describe(
      "Maximum DC fast-charge time in minutes (10-80%). Bilbasen only offers 15-50 in steps of 5; other values are rejected.",
    ),
  // --- Doors, seats & boot ---
  doors: z
    .array(enumFrom(DOOR_OPTIONS))
    .optional()
    .describe("Number of doors. Multiple values are OR-combined."),
  trunk_size_min: z
    .number()
    .int()
    .min(100)
    .max(3000)
    .multipleOf(100)
    .optional()
    .describe("Minimum boot/luggage capacity in litres. Must be a multiple of 100 (100-3000)."),
  min_seven_seats: z
    .boolean()
    .optional()
    .describe("If true, only cars with at least 7 seats."),
  // --- Performance ---
  drive_wheel: z
    .array(enumFrom(DRIVE_WHEEL_OPTIONS))
    .optional()
    .describe("Driven wheels: front (forhjulstræk), back (baghjulstræk), four (firehjulstræk/AWD). OR-combined."),
  horsepower_from: z.number().int().min(0).optional().describe("Minimum horsepower (hk)."),
  horsepower_to: z.number().int().min(0).optional().describe("Maximum horsepower (hk)."),
  torque_from: z.number().int().min(0).optional().describe("Minimum torque (Nm)."),
  torque_to: z.number().int().min(0).optional().describe("Maximum torque (Nm)."),
  acceleration_max: z
    .number()
    .min(0)
    .optional()
    .describe("Maximum 0-100 km/h acceleration in seconds."),
  cylinders: z
    .array(enumFrom(CYLINDER_OPTIONS))
    .optional()
    .describe("Number of cylinders. Multiple values are OR-combined."),
  engine_volume_from: z.number().int().min(0).optional().describe("Minimum engine displacement in ccm."),
  engine_volume_to: z.number().int().min(0).optional().describe("Maximum engine displacement in ccm."),
  // --- Economy & condition ---
  km_per_liter_min: z.number().min(0).optional().describe("Minimum fuel economy in km/l (petrol/diesel/hybrid)."),
  green_tax_max: z.number().int().min(0).optional().describe("Maximum annual ownership tax (ejerafgift) in kr./year."),
  service_ok: z.boolean().optional().describe("If true, only cars with service history in order (service overholdt)."),
  newly_inspected: z.boolean().optional().describe("If true, only newly MOT-inspected cars (nysynet)."),
  // --- Environment ---
  co2_max: z.number().int().min(0).optional().describe("Maximum CO2 emission in g/km."),
  euro_norm_min: z
    .number()
    .int()
    .min(1)
    .max(6)
    .optional()
    .describe("Minimum EuroNorm emission class (1-6)."),
  // --- Location ---
  zip_code: z.number().int().min(1000).max(9999).optional().describe("Your Danish postal code (1000-9999), used with distance_max."),
  distance_max: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Maximum distance to seller in km. Only takes effect together with zip_code."),
  // --- Appearance ---
  body_type: z
    .array(enumFrom(BODY_TYPE_OPTIONS))
    .optional()
    .describe("Body type(s), OR-combined. Note the Danish spelling 'mikro'."),
  color: z
    .array(enumFrom(COLOR_OPTIONS))
    .optional()
    .describe("Exterior colour(s), Danish names (e.g. 'sort', 'hvid', 'blåmetal'). OR-combined."),
  // --- Equipment (Ekstraudstyr) ---
  equipment: z
    .array(z.string())
    .optional()
    // The full 171-flag list lives in the error rather than the description: it
    // would otherwise cost ~1.6k tokens of context in every session, on both
    // tools, to serve one niche filter. An invalid guess returns the whole list.
    .refine((arr) => !arr || arr.every((e) => EQUIPMENT_SET.has(e)), {
      message: `Unknown equipment flag. Valid flags by category:\n${equipmentCategories}`,
    })
    .describe(
      `Required equipment feature flags, AND-combined (cars must have ALL of them). Lowercase, no separators, e.g. 'glassroof', 'heatedseats', 'applecarplay', 'adaptivecruisecontrol', 'towbar'. ${EQUIPMENT_OPTIONS.length} flags exist across ${Object.keys(EQUIPMENT_FLAGS).join("/")}; passing an invalid one returns the full list.`,
    ),
};

const SearchFilterShape = ADVANCED_FILTERS_ENABLED
  ? { ...CoreFilterShape, ...AdvancedFilterShape }
  : CoreFilterShape;

const SearchInputSchema = z
  .object({
    ...SearchFilterShape,
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

// Statistics describe a market segment, which the core filters already define;
// the advanced set is deliberately not mirrored here to keep the schema small.
const StatsInputSchema = z
  .object({
    ...CoreFilterShape,
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

// The filters are just the filter-relevant subset of the validated tool input
// (page/limit/response_format excluded). Both shapes are listed regardless of
// the active tier: the input schema is strict, so a filter the tier does not
// expose can never reach here.
const ALL_FILTER_SHAPE = { ...CoreFilterShape, ...AdvancedFilterShape };
const FILTER_KEYS = Object.keys(ALL_FILTER_SHAPE) as (keyof SearchFilters)[];

// Compile-time guard: a filter declared in a shape but missing from
// SearchFilters would otherwise be dropped silently on its way to the scraper.
type FilterKeysAreDeclared =
  keyof typeof ALL_FILTER_SHAPE extends keyof SearchFilters ? true : never;
const _filterKeysAreDeclared: FilterKeysAreDeclared = true;
void _filterKeysAreDeclared;

function pickFilters(input: Record<string, unknown>): SearchFilters {
  const filters: Record<string, unknown> = {};
  for (const key of FILTER_KEYS) {
    if (input[key] !== undefined) filters[key] = input[key];
  }
  // Bilbasen silently drops `distance` when no zip code is present and returns
  // the full unfiltered catalogue, so reject the pair instead of quietly lying.
  // (Checked here rather than as a schema .refine(): wrapping the input object
  // in a ZodEffects makes the MCP SDK publish an empty JSON schema.)
  if (filters.distance_max !== undefined && filters.zip_code === undefined) {
    throw new Error("distance_max only takes effect together with zip_code - supply both or neither.");
  }
  return filters as SearchFilters;
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

Args: every filter is described in the input schema - free-text 'query' plus
price, year, mileage, fuel, gear and seller. Paging via 'page'/'limit', output
via 'response_format'.${ADVANCED_FILTERS_ENABLED ? ADVANCED_ARGS_NOTE : ""}

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
          result.has_more ? `More results available - request page ${result.page + 1}.` : "End of results.",
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
          detail.dealer_name ? `**Dealer**: ${detail.dealer_name} - ${detail.dealer_address ?? ""}` : "",
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

Args: the core filters (query, fuel, gear, seller, price, year, mileage), all
described in the input schema, plus 'max_pages' to control the sample size and
'response_format'. Statistics are always computed over the core filters; use
bilbasen_search_listings for finer-grained filtering.

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
