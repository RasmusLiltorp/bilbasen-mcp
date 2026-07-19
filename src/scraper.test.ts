import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSearchUrl } from "./scraper.ts";

/** Returns the decoded query parameters of a built search URL. */
function query(filters: Parameters<typeof buildSearchUrl>[0], page = 1): URLSearchParams {
  return new URL(buildSearchUrl(filters, page)).searchParams;
}

test("encodes the core filters with their Bilbasen parameter names", () => {
  const q = query({
    query: "bmw ix",
    fuel: "el",
    gear: "automatic",
    price_from: 300000,
    price_to: 450000,
    year_from: 2022,
    mileage_to: 60000,
    seller_type: "dealer",
  });
  assert.equal(q.get("free"), "bmw ix");
  assert.equal(q.get("fuel"), "3");
  assert.equal(q.get("gear"), "2");
  assert.equal(q.get("pricefrom"), "300000");
  assert.equal(q.get("priceto"), "450000");
  assert.equal(q.get("yearfrom"), "2022");
  assert.equal(q.get("mileageto"), "60000");
  assert.equal(q.get("SellerTypes"), "Dealer");
});

test("maps scalar and range filters to the verified parameter names", () => {
  const q = query({
    min_tow: 1500,
    trunk_size_min: 500,
    electric_range_min: 444,
    battery_capacity_min: 77,
    charge_time_dc_max: 30,
    horsepower_from: 150,
    horsepower_to: 600,
    torque_from: 250,
    engine_volume_from: 1200,
    engine_volume_to: 4000,
    km_per_liter_min: 22,
    green_tax_max: 3300,
    co2_max: 111,
    euro_norm_min: 6,
    acceleration_max: 6,
    zip_code: 2100,
    distance_max: 25,
  });
  assert.equal(q.get("mintow"), "1500");
  assert.equal(q.get("trunksize"), "500");
  assert.equal(q.get("rangefrom"), "444");
  assert.equal(q.get("batterysizefrom"), "77");
  assert.equal(q.get("chargetimedc"), "30");
  assert.equal(q.get("hpfrom"), "150");
  assert.equal(q.get("hpto"), "600");
  assert.equal(q.get("torquefrom"), "250");
  assert.equal(q.get("motorvolumeccmfrom"), "1200");
  assert.equal(q.get("motorvolumeccmto"), "4000");
  assert.equal(q.get("kmlfrom"), "22");
  assert.equal(q.get("greentaxto"), "3300");
  assert.equal(q.get("co2emission"), "111");
  assert.equal(q.get("euronorm"), "6");
  assert.equal(q.get("zerotohundredacceleration"), "6");
  assert.equal(q.get("zipcode"), "2100");
  assert.equal(q.get("distance"), "25");
});

test("emits booleans as fixed key=value pairs only when truthy", () => {
  const q = query({ service_ok: true, newly_inspected: true, min_seven_seats: true });
  assert.equal(q.get("serviceok"), "true");
  assert.equal(q.get("newlymot"), "true");
  assert.equal(q.get("seatnumber"), "sevenperson");
  assert.equal(query({ service_ok: false }).has("serviceok"), false);
});

test("appends multi-select filters as repeated keys", () => {
  const q = query({
    body_type: ["suv", "stationcar"],
    drive_wheel: ["four"],
    doors: ["4", "5"],
    cylinders: ["4"],
    color: ["blå", "sort"],
  });
  assert.deepEqual(q.getAll("cartype"), ["suv", "stationcar"]);
  assert.deepEqual(q.getAll("drivewheel"), ["four"]);
  assert.deepEqual(q.getAll("doors"), ["4", "5"]);
  assert.deepEqual(q.getAll("numberofcylinders"), ["4"]);
  assert.deepEqual(q.getAll("color"), ["blå", "sort"]);
});

test("maps charger_type names to Bilbasen numeric codes", () => {
  const q = query({ charger_type: ["ccs_combo", "chademo", "type1", "type2"] });
  assert.deepEqual(q.getAll("chargertype"), ["1", "2", "3", "4"]);
});

test("appends tow-bar types and equipment as bare valueless flags", () => {
  const url = buildSearchUrl({ tow_bar: ["removable", "swing_electric"], equipment: ["glassroof", "heatpump"] }, 1);
  for (const flag of ["detachabletowbar", "swingawaytowbarelectric", "glassroof", "heatpump"]) {
    assert.ok(url.includes(`&${flag}`) || url.includes(`?${flag}`), `expected bare flag ${flag}`);
    assert.ok(!url.includes(`${flag}=`), `flag ${flag} must not carry a value`);
  }
});

test("silently drops unknown equipment flags", () => {
  const url = buildSearchUrl({ equipment: ["glassroof", "not_a_real_flag"] }, 1);
  assert.ok(url.includes("glassroof"));
  assert.ok(!url.includes("not_a_real_flag"));
});

test("omits the page parameter for page 1 and includes it otherwise", () => {
  assert.equal(query({ fuel: "el" }, 1).has("page"), false);
  assert.equal(query({ fuel: "el" }, 3).get("page"), "3");
});
