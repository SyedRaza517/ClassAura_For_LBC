// Tests for UK postcode → region bucketing.
//
// The module is pure — a string in, a region name or null out — so every mapping a
// marketing lead would query is checkable here in milliseconds.
//
// The rule these tests exist to protect: AN UNPARSEABLE POSTCODE IS NEVER SILENTLY
// DROPPED. `postCode` on Admission is free text with no validation, so a real slice
// of rows hold "N/A", a US zip, or nothing at all. A region chart that quietly omits
// them reports a smaller, cleaner-looking college than the one that exists, and the
// omission is invisible — which is worse than an "Unknown" bar somebody can ask about.
//
// Run with: node --test src/admissions/postcodeRegions.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { regionOf, countByRegion, UNKNOWN } = require("./postcodeRegions");

/* -------------------------------------------------------------------------- */
/* regionOf — the area letters decide the region                              */
/* -------------------------------------------------------------------------- */

test("maps a single-letter postcode area to its region", () => {
  assert.equal(regionOf("B15 2TT"), "West Midlands");
});

test("maps a two-letter postcode area to its region", () => {
  assert.equal(regionOf("BN1 9RH"), "South East");
});

test("reads the area from a postcode with no space", () => {
  assert.equal(regionOf("M11AE"), "North West");
});

test("is case-insensitive", () => {
  assert.equal(regionOf("eh1 1yz"), "Scotland");
});

test("tolerates surrounding whitespace", () => {
  assert.equal(regionOf("  CF10 1EP  "), "Wales");
});

test("distinguishes the single-letter area B from the two-letter area BT", () => {
  // The greedy-letters bug: reading only the first letter puts every Belfast
  // applicant in Birmingham. Both directions are asserted so neither can regress.
  assert.equal(regionOf("B1 1AA"), "West Midlands");
  assert.equal(regionOf("BT1 5GS"), "Northern Ireland");
});

test("distinguishes the single-letter area S from the two-letter area SW", () => {
  assert.equal(regionOf("S1 2HE"), "Yorkshire and the Humber");
  assert.equal(regionOf("SW1A 1AA"), "Greater London");
});

test("gives the Crown Dependencies their own bucket rather than Unknown", () => {
  // Jersey, Guernsey and the Isle of Man are real places a UK college recruits from.
  // Dropping them into Unknown would mix them with "N/A" and unreadable junk, which
  // loses the one thing the bucket is for — telling a real answer from a missing one.
  assert.equal(regionOf("JE2 3AA"), "Channel Islands & Isle of Man");
  assert.equal(regionOf("GY1 1AA"), "Channel Islands & Isle of Man");
  assert.equal(regionOf("IM1 1AA"), "Channel Islands & Isle of Man");
});

/* -------------------------------------------------------------------------- */
/* regionOf — everything unmappable answers null, never a guess               */
/* -------------------------------------------------------------------------- */

test("returns null for an empty or missing postcode", () => {
  assert.equal(regionOf(""), null);
  assert.equal(regionOf(null), null);
  assert.equal(regionOf(undefined), null);
  assert.equal(regionOf("   "), null);
});

test("returns null for free text that is not a postcode", () => {
  // All of these are really in the column.
  assert.equal(regionOf("N/A"), null);
  assert.equal(regionOf("none"), null);
  assert.equal(regionOf("-"), null);
});

test("returns null for a non-UK postal code", () => {
  assert.equal(regionOf("90210"), null);      // US zip — no leading letters
  assert.equal(regionOf("75008"), null);      // Paris
});

test("returns null for a well-formed postcode in an area we do not know", () => {
  // Shape is right, area is not a real one. A guess here would invent a region.
  assert.equal(regionOf("QQ1 1AA"), null);
});

test("does not treat a bare area with no district digit as a postcode", () => {
  // "London" starts with two letters and would otherwise read as the LO area.
  assert.equal(regionOf("London"), null);
});

/* -------------------------------------------------------------------------- */
/* countByRegion — the Unknown bucket is the point                            */
/* -------------------------------------------------------------------------- */

test("counts postcodes into their regions, largest first", () => {
  const out = countByRegion(["B1 1AA", "B15 2TT", "EH1 1YZ"]);
  assert.deepEqual(out, [
    { region: "West Midlands", count: 2 },
    { region: "Scotland", count: 1 },
  ]);
});

test("keeps unparseable postcodes as an explicit Unknown bucket", () => {
  const out = countByRegion(["B1 1AA", "N/A", "", null]);
  assert.deepEqual(out, [
    { region: "West Midlands", count: 1 },
    { region: UNKNOWN, count: 3 },
  ]);
});

test("sorts Unknown last even when it is the largest bucket", () => {
  // Otherwise a college with patchy address data opens its region chart on a bar
  // labelled Unknown, which reads as the answer rather than as the caveat.
  const out = countByRegion(["x", "x", "x", "B1 1AA"]);
  assert.deepEqual(out, [
    { region: "West Midlands", count: 1 },
    { region: UNKNOWN, count: 3 },
  ]);
});

test("omits the Unknown bucket entirely when every postcode parsed", () => {
  const out = countByRegion(["B1 1AA", "EH1 1YZ"]);
  assert.equal(out.some((r) => r.region === UNKNOWN), false);
});

test("returns an empty list for no input at all", () => {
  // Not a zero-count Unknown row: nobody is unknown, because nobody is anything.
  assert.deepEqual(countByRegion([]), []);
});

test("breaks ties by region name so the order is stable between runs", () => {
  // Two regions on one count must not swap places when the same data is refetched.
  const out = countByRegion(["EH1 1YZ", "B1 1AA"]);
  assert.deepEqual(out, [
    { region: "Scotland", count: 1 },
    { region: "West Midlands", count: 1 },
  ]);
});
