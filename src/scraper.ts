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
  // Anhænger (towing)
  min_tow?: number;
  tow_bar?: string[];
  // Batteri & opladning (EV)
  electric_range_min?: number;
  battery_capacity_min?: number;
  charger_type?: string[];
  charge_time_dc_max?: number;
  // Døre, sæder og bagagerum
  doors?: string[];
  trunk_size_min?: number;
  min_seven_seats?: boolean;
  // Ydelse (performance)
  drive_wheel?: string[];
  horsepower_from?: number;
  horsepower_to?: number;
  torque_from?: number;
  torque_to?: number;
  acceleration_max?: number;
  cylinders?: string[];
  engine_volume_from?: number;
  engine_volume_to?: number;
  // Økonomi & stand
  km_per_liter_min?: number;
  green_tax_max?: number;
  service_ok?: boolean;
  newly_inspected?: boolean;
  // Miljø
  co2_max?: number;
  euro_norm_min?: number;
  // Geografi
  zip_code?: number;
  distance_max?: number;
  // Udseende
  body_type?: string[];
  color?: string[];
  // Ekstraudstyr (equipment)
  equipment?: string[];
}

// --- Bilbasen URL parameter mappings (discovered from the live site) ---

// Scalar filters -> the Bilbasen query parameter carrying their raw number.
const NUMERIC_PARAMS: Array<[keyof SearchFilters, string]> = [
  ["min_tow", "mintow"],
  ["trunk_size_min", "trunksize"],
  ["euro_norm_min", "euronorm"],
  ["co2_max", "co2emission"],
  ["green_tax_max", "greentaxto"],
  ["km_per_liter_min", "kmlfrom"],
  ["electric_range_min", "rangefrom"],
  ["battery_capacity_min", "batterysizefrom"],
  ["acceleration_max", "zerotohundredacceleration"],
  ["charge_time_dc_max", "chargetimedc"],
  ["zip_code", "zipcode"],
  ["distance_max", "distance"],
  ["horsepower_from", "hpfrom"],
  ["horsepower_to", "hpto"],
  ["torque_from", "torquefrom"],
  ["torque_to", "torqueto"],
  ["engine_volume_from", "motorvolumeccmfrom"],
  ["engine_volume_to", "motorvolumeccmto"],
];

// Boolean filters -> a fixed `key=value` pair, emitted only when truthy.
const BOOLEAN_PARAMS: Array<[keyof SearchFilters, string, string]> = [
  ["service_ok", "serviceok", "true"],
  ["newly_inspected", "newlymot", "true"],
  ["min_seven_seats", "seatnumber", "sevenperson"],
];

// Multi-select filters -> param name; each value is appended as a repeated key.
const MULTI_VALUE_PARAMS: Array<[keyof SearchFilters, string]> = [
  ["body_type", "cartype"],
  ["drive_wheel", "drivewheel"],
  ["doors", "doors"],
  ["cylinders", "numberofcylinders"],
  ["color", "color"],
];

// Anhængertræk (tow_bar) types are bare valueless flags, OR-combined.
export const TOW_BAR_FLAGS: Record<string, string> = {
  fixed: "towbar",
  removable: "detachabletowbar",
  swing_manual: "swingawaytowbar",
  swing_electric: "swingawaytowbarelectric",
};
export const TOW_BAR_OPTIONS = Object.keys(TOW_BAR_FLAGS);

// Ladestik (charger_type) -> Bilbasen numeric codes.
export const CHARGER_TYPE_CODES: Record<string, number> = {
  ccs_combo: 1,
  chademo: 2,
  type1: 3,
  type2: 4,
};
export const CHARGER_TYPE_OPTIONS = Object.keys(CHARGER_TYPE_CODES);

// Karrosseri (body_type) accepted values.
export const BODY_TYPE_OPTIONS = [
  "micro", "stationcar", "suv", "cuv", "mpv", "sedan", "hatchback", "cabriolet", "coupe",
];

// Trækhjul (drive_wheel) accepted values.
export const DRIVE_WHEEL_OPTIONS = ["front", "back", "four"];

// Antal døre (doors) accepted values.
export const DOOR_OPTIONS = ["1", "2", "3", "4", "5", "6"];

// Antal cylindre (cylinders) accepted values.
export const CYLINDER_OPTIONS = ["1", "2", "3", "4", "5", "6", "7", "8", "10", "12"];

// Farve (color) accepted values (Danish colour names as used by Bilbasen).
export const COLOR_OPTIONS = [
  "beige", "beigemetal", "blå", "blåmetal", "bordeaux", "bordeauxmetal", "bronzemetal",
  "brun", "brunmetal", "carbonsortmetal", "champagnemetal", "grøn", "grønmetal", "grå",
  "gråmetal", "gul", "guldmetal", "gulmetal", "hvid", "hvidmetal", "kobbermetal", "koks",
  "koksmetal", "lilla", "lillametal", "lysblå", "lysblåmetal", "lyserød", "lyserødmetal",
  "lysgrøn", "lysgrønmetal", "metal", "mørkblå", "mørkblåmetal", "mørkgrøn", "mørkgrønmetal",
  "mørkgrå", "mørkrød", "mørkrødmetal", "orange", "orangemetal", "perlemorshvid", "pink",
  "postgul", "rød", "rødmetal", "sort", "sortmetal", "sølvmetal", "turkis", "turkismetal",
  "violetmetal",
];

// Ekstraudstyr (equipment) flags, grouped by the site's categories. Each is a
// bare valueless query flag; the URL parameter IS the flag itself.
export const EQUIPMENT_FLAGS: Record<string, string[]> = {
  interior: [
    "adjustablelumbarsupport", "akustikglasibag", "akustikglasifor", "alcantaraupholstery",
    "ambientlighting", "darkheadliner", "digitalcockpit", "dobbeltbagagerumsbund",
    "driverseatmassage", "electricadjustabledriverseat", "electricadjustabledriversseatwithmemory",
    "electricadjustablefrontseats", "electricadjustablelumbarsupport", "electriccomfortseats",
    "fabricinterior", "heightadjustabledriversseat", "imitationleatherupholstery",
    "integratedchildseats", "integratedsunblinds", "leatherstearing", "leatherupholstery",
    "massageinfrontseats", "multifunctionsteeringwheel", "onboardcomputer",
    "partialalcantaraupholstery", "partialimitationleatherupholstery", "partialleatherupholstery",
    "pilotseats", "sevenseater", "sixseater", "splitbackseat", "sportseats",
    "threeindividualseatsinback", "trunkcover",
  ],
  exterior: [
    "adaptiveheadlights", "allseasonwheels", "alurims", "arealighting", "bixenonlamps",
    "curvelight", "darktintedrearwindows", "detachabletowbar", "dynamicrearturnsignals",
    "dynamicturnsignals", "eighteeninchalloywheels", "electricfoldablesidemirrors",
    "electricfoldablesidemirrorsheated", "fifteeninchalloywheels", "foglamps", "fullledheadlights",
    "glassroof", "heatedmirrors", "laserheadlights", "leddrivinglights", "ledrearlights",
    "matrixledheadlights", "nineteeninchalloywheels", "powersunroof", "roofrails",
    "seventeeninchalloywheels", "sixteeninchalloywheels", "solarpanels", "sunroof",
    "twentyinchalloywheels", "twentyoneinchalloywheels", "twentytwoinchalloywheels",
    "virtualsidemirrors", "wingmirrors", "winterwheels", "xenon",
  ],
  safety: [
    "airbags", "alarm", "antispin", "autoemergencyassistant", "autohold", "automaticemergencybrake",
    "automatichighbeam", "automaticlight", "automaticparkingsystem", "blindspotdetection",
    "citysteering", "doubleairbags", "drivermonitoringwithwarning", "edrbox", "eightairbags",
    "esp", "fatiguedetection", "fourairbags", "intelligentspeedassist", "isofix", "lampwashers",
    "laneassist", "nightvision", "nineairbags", "parkingsensorback", "parkingsensorfront",
    "rainsensor", "reversecamera", "semiautoparkingsystem", "sevenairbags", "sixairbags",
    "tenairbags", "threesixtycamera", "tirepressuresystem", "trafficcamera",
    "trafficsignrecognition", "videosurveillance", "virtualrearviewmirror", "voicecontrol",
  ],
  comfort: [
    "adaptivechassis", "adaptivecruisecontrol", "adaptivecruisewithtrafficassist", "aircon",
    "airsuspension", "appintegration", "autgear", "autobatterypreheat", "autodimmingrearmirror",
    "automaticstartstop", "cabinheater", "centrallock", "cooledglovebox", "cruisecontrol",
    "electricdoors", "electricfronthood", "electricparkingbrake", "electrictailgate",
    "emergencycharger", "enginecabinheater", "externaltempgauge", "footoperatedtailgate",
    "fourzoneclimate", "fronttrunk", "fullautoclimate", "headupdisplay", "heatedseats",
    "heatedsteeringwheel", "heatedwindshield", "heatpump", "integratedchargingcable",
    "keylessaccess", "keylessstart", "manualbatterypreheat", "powerwindows", "powerwindowsx4",
    "rearseatheating", "remotelock", "seatcooling", "steeringwheelshifters", "thirdrowseatheating",
    "threezoneclimate", "twozoneclimate", "type2chargingcable", "v2g", "v2l",
    "wirelesscellphonecharging",
  ],
  multimedia: [
    "androidauto", "applecarplay", "auxconnection", "bluetoothaudiostreaming", "cdplayer",
    "cdradio", "dabplusradio", "dabradio", "gps", "handsfreemobile", "internet",
    "rearseatentertainment", "sdcardreader", "usbtypeaconnection", "usbtypecconnection",
  ],
};
export const EQUIPMENT_OPTIONS = Object.values(EQUIPMENT_FLAGS).flat();
const EQUIPMENT_SET = new Set(EQUIPMENT_OPTIONS);

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

  for (const [field, param] of NUMERIC_PARAMS) {
    const value = filters[field] as number | undefined;
    if (value !== undefined) params.set(param, String(value));
  }
  for (const [field, param, value] of BOOLEAN_PARAMS) {
    if (filters[field]) params.set(param, value);
  }
  for (const [field, param] of MULTI_VALUE_PARAMS) {
    const values = filters[field] as string[] | undefined;
    if (Array.isArray(values)) for (const value of values) params.append(param, value);
  }
  for (const charger of filters.charger_type ?? []) {
    const code = CHARGER_TYPE_CODES[charger];
    if (code !== undefined) params.append("chargertype", String(code));
  }

  if (filters.sort && SORT_VALUES[filters.sort]) {
    const { sortby, sortorder } = SORT_VALUES[filters.sort];
    if (sortby) params.set("sortby", sortby);
    if (sortorder) params.set("sortorder", sortorder);
  }
  if (page > 1) params.set("page", String(page));

  // Tow-bar types and equipment are bare valueless flags (e.g. `&detachabletowbar`);
  // Bilbasen drops them if given a value, so they can't go through URLSearchParams.
  const bareFlags: string[] = [];
  for (const t of filters.tow_bar ?? []) {
    const flag = TOW_BAR_FLAGS[t];
    if (flag) bareFlags.push(flag);
  }
  for (const equip of filters.equipment ?? []) {
    if (EQUIPMENT_SET.has(equip)) bareFlags.push(equip);
  }

  const parts = [params.toString(), ...bareFlags].filter(Boolean);
  return parts.length ? `${BASE_URL}?${parts.join("&")}` : BASE_URL;
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
