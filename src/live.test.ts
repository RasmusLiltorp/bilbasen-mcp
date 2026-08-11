/**
 * Live checks against bilbasen.dk.
 *
 * Bilbasen silently ignores a query parameter whose name or value it does not
 * recognise and returns the full catalogue instead of erroring. A wrong
 * parameter name, an anglicised enum value or an off-step number therefore
 * looks exactly like a working filter to the unit tests in scraper.test.ts,
 * which only assert that buildSearchUrl echoes its own constants back.
 *
 * These tests catch that by asserting each filter genuinely narrows the result
 * set. They hit the network and are slow, so they are opt-in:
 *
 *   BILBASEN_LIVE=1 npm test
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import {
  searchListings,
  BODY_TYPE_OPTIONS,
  CYLINDER_OPTIONS,
  DOOR_OPTIONS,
  DRIVE_WHEEL_OPTIONS,
  CHARGER_TYPE_OPTIONS,
  TOW_BAR_OPTIONS,
  type SearchFilters,
} from "./scraper.ts";

const skip = process.env.BILBASEN_LIVE === "1" ? false : "set BILBASEN_LIVE=1 to run";

let baseline = 0;
before(async () => {
  if (!skip) baseline = (await searchListings({}, 1)).total;
});

/** Asserts the filter actually reduced the result count (i.e. was not ignored). */
async function assertNarrows(label: string, filters: SearchFilters): Promise<void> {
  const { total } = await searchListings(filters, 1);
  assert.ok(
    total < baseline,
    `${label} did not narrow results (${total} of ${baseline}); Bilbasen likely ignored it`,
  );
}

const SCALAR_CASES: Array<[string, SearchFilters]> = [
  ["min_tow", { min_tow: 1500 }],
  ["trunk_size_min", { trunk_size_min: 500 }],
  ["electric_range_min", { electric_range_min: 400 }],
  ["battery_capacity_min", { battery_capacity_min: 70 }],
  ["charge_time_dc_max", { charge_time_dc_max: 30 }],
  ["horsepower_from", { horsepower_from: 300 }],
  ["horsepower_to", { horsepower_to: 90 }],
  ["torque_from", { torque_from: 500 }],
  ["engine_volume_from", { engine_volume_from: 3000 }],
  ["km_per_liter_min", { km_per_liter_min: 25 }],
  ["green_tax_max", { green_tax_max: 1000 }],
  ["co2_max", { co2_max: 100 }],
  ["euro_norm_min", { euro_norm_min: 6 }],
  ["acceleration_max", { acceleration_max: 5 }],
  ["zip_code + distance_max", { zip_code: 2100, distance_max: 10 }],
  ["service_ok", { service_ok: true }],
  ["newly_inspected", { newly_inspected: true }],
  ["min_seven_seats", { min_seven_seats: true }],
  ["equipment (bare flag)", { equipment: ["glassroof"] }],
];

for (const [label, filters] of SCALAR_CASES) {
  test(`${label} narrows results`, { skip }, () => assertNarrows(label, filters));
}

// Every advertised enum value must be one Bilbasen actually recognises. This is
// what catches an invalid option such as body_type 'micro' (the site spells it
// 'mikro') or a cylinder count the site has no option for, both of which would
// otherwise silently return the entire catalogue.
const ENUM_CASES: Array<[string, (v: string) => SearchFilters, string[]]> = [
  ["body_type", (v) => ({ body_type: [v] }), BODY_TYPE_OPTIONS],
  ["cylinders", (v) => ({ cylinders: [v] }), CYLINDER_OPTIONS],
  ["doors", (v) => ({ doors: [v] }), DOOR_OPTIONS],
  ["drive_wheel", (v) => ({ drive_wheel: [v] }), DRIVE_WHEEL_OPTIONS],
  ["charger_type", (v) => ({ charger_type: [v] }), CHARGER_TYPE_OPTIONS],
  ["tow_bar", (v) => ({ tow_bar: [v] }), TOW_BAR_OPTIONS],
];

for (const [field, build, values] of ENUM_CASES) {
  for (const value of values) {
    test(`${field}='${value}' is a recognised value`, { skip }, () =>
      assertNarrows(`${field}='${value}'`, build(value)));
  }
}

test("multi-selects are OR-combined (widen the result set)", { skip }, async () => {
  const [suv, both] = await Promise.all([
    searchListings({ body_type: ["suv"] }, 1),
    searchListings({ body_type: ["suv", "stationcar"] }, 1),
  ]);
  assert.ok(both.total > suv.total, `expected OR semantics, got ${both.total} <= ${suv.total}`);
});

test("equipment flags are AND-combined (narrow the result set)", { skip }, async () => {
  const [roof, pump, both] = await Promise.all([
    searchListings({ equipment: ["glassroof"] }, 1),
    searchListings({ equipment: ["heatpump"] }, 1),
    searchListings({ equipment: ["glassroof", "heatpump"] }, 1),
  ]);
  assert.ok(
    both.total < roof.total && both.total < pump.total,
    `expected AND semantics, got ${both.total} vs ${roof.total}/${pump.total}`,
  );
});
