// UK postcode → region, for the Admission Tracker's geography panel.
//
// PURE: a string in, a region name or null out. No database, no Prisma, no clock.
// Same reasoning as src/prediction/ — the rules a marketing lead would query are
// checkable in milliseconds, and the table below is data somebody may need to correct
// without touching a route.
//
// WHY THIS RUNS ON THE SERVER AND NOT IN THE BROWSER. The tracker's endpoint emits
// aggregates only; that is the whole reason it has its own permission, separate from
// the "admissions" grant that opens passport and NI numbers. A postcode is personal
// data — it identifies a household — so it is read here, bucketed, and DROPPED. What
// leaves the building is a count against a region name.
//
// WHAT A "REGION" IS HERE. The nine English ITL1 regions plus Wales, Scotland,
// Northern Ireland, and one bucket for the Crown Dependencies. This is the split a
// college recruits and advertises against, not a statistical one.
//
// POSTCODE AREAS STRADDLE REGION BOUNDARIES AND THIS TABLE DOES NOT. KT is named for
// Kingston, a London borough, but reaches deep into Surrey; DA is named for Dartford
// in Kent but covers the London borough of Bexley; SY runs from Shropshire into
// mid-Wales. Each area is assigned to the region holding most of it, which means a
// minority of applicants land one region out. That is a known, bounded inaccuracy in
// a figure used to steer marketing spend — not a defect to be fixed by splitting on
// the district digit, which would need a full ONS postcode lookup (1.8m rows) that
// this feature does not justify. Say so if the figure is ever quoted precisely.

// The bucket for a postcode that could not be read at all. Deliberately a NAMED
// EXPORT rather than a bare string: the client renders it, the tests assert on it,
// and three copies of the word "Unknown" is how they drift apart.
const UNKNOWN = "Unknown";

// Postcode area → region. Keyed by the AREA — the letters before the first digit of
// the outward code ("B15 2TT" → "B", "SW1A 1AA" → "SW").
const AREA_REGION = {
  // Greater London. The outer areas (BR, CR, EN, HA, IG, KT, RM, SM, TW, UB) are
  // London postal areas whose bulk sits inside the Greater London boundary.
  BR: "Greater London", CR: "Greater London", E: "Greater London", EC: "Greater London",
  EN: "Greater London", HA: "Greater London", IG: "Greater London", KT: "Greater London",
  N: "Greater London", NW: "Greater London", RM: "Greater London", SE: "Greater London",
  SM: "Greater London", SW: "Greater London", TW: "Greater London", UB: "Greater London",
  W: "Greater London", WC: "Greater London",

  // South East
  BN: "South East", CT: "South East", DA: "South East", GU: "South East",
  HP: "South East", ME: "South East", MK: "South East", OX: "South East",
  PO: "South East", RG: "South East", RH: "South East", SL: "South East",
  SO: "South East", TN: "South East",

  // South West
  BA: "South West", BH: "South West", BS: "South West", DT: "South West",
  EX: "South West", GL: "South West", PL: "South West", SN: "South West",
  SP: "South West", TA: "South West", TQ: "South West", TR: "South West",

  // East of England
  AL: "East of England", CB: "East of England", CM: "East of England",
  CO: "East of England", IP: "East of England", LU: "East of England",
  NR: "East of England", PE: "East of England", SG: "East of England",
  SS: "East of England", WD: "East of England",

  // East Midlands
  DE: "East Midlands", LE: "East Midlands", LN: "East Midlands",
  NG: "East Midlands", NN: "East Midlands",

  // West Midlands
  B: "West Midlands", CV: "West Midlands", DY: "West Midlands", HR: "West Midlands",
  ST: "West Midlands", SY: "West Midlands", TF: "West Midlands", WR: "West Midlands",
  WS: "West Midlands", WV: "West Midlands",

  // Yorkshire and the Humber
  BD: "Yorkshire and the Humber", DN: "Yorkshire and the Humber",
  HD: "Yorkshire and the Humber", HG: "Yorkshire and the Humber",
  HU: "Yorkshire and the Humber", HX: "Yorkshire and the Humber",
  LS: "Yorkshire and the Humber", S: "Yorkshire and the Humber",
  WF: "Yorkshire and the Humber", YO: "Yorkshire and the Humber",

  // North West
  BB: "North West", BL: "North West", CA: "North West", CH: "North West",
  CW: "North West", FY: "North West", L: "North West", LA: "North West",
  M: "North West", OL: "North West", PR: "North West", SK: "North West",
  WA: "North West", WN: "North West",

  // North East
  DH: "North East", DL: "North East", NE: "North East", SR: "North East",
  TS: "North East",

  // Wales
  CF: "Wales", LD: "Wales", LL: "Wales", NP: "Wales", SA: "Wales",

  // Scotland
  AB: "Scotland", DD: "Scotland", DG: "Scotland", EH: "Scotland", FK: "Scotland",
  G: "Scotland", HS: "Scotland", IV: "Scotland", KA: "Scotland", KW: "Scotland",
  KY: "Scotland", ML: "Scotland", PA: "Scotland", PH: "Scotland", TD: "Scotland",
  ZE: "Scotland",

  BT: "Northern Ireland",

  // Not part of the UK, but a UK college recruits from all three, so they get a named
  // bucket. Folding them into UNKNOWN would mix real places with unreadable junk and
  // lose the only thing that bucket is for.
  GY: "Channel Islands & Isle of Man",
  IM: "Channel Islands & Isle of Man",
  JE: "Channel Islands & Isle of Man",
};

// The area is the letters before the first digit. `{1,2}` is greedy and backtracks,
// which is exactly the behaviour needed: "BT1" takes two letters and finds Belfast,
// while "B1" cannot take two (the "1" is not a letter) and falls back to one and finds
// Birmingham. Reading only the first letter — the obvious shortcut — files every
// Belfast applicant under Birmingham, so both directions are tested.
//
// The lookahead for a DIGIT is what stops ordinary words being read as postcodes:
// "London" would otherwise present the area "LO". Every UK outward code is letters
// then a digit, with no exceptions this table needs to care about.
const AREA_RE = /^([A-Z]{1,2})(?=[0-9])/;

/**
 * The region a postcode falls in, or null when it cannot be read.
 *
 * Null means "not measurable", not "nowhere" — `Admission.postCode` is free text with
 * no validation and legitimately holds "N/A", a foreign postal code, or nothing.
 * Callers must show that as a bucket, never discard it.
 */
function regionOf(postcode) {
  if (typeof postcode !== "string") return null;
  const m = AREA_RE.exec(postcode.trim().toUpperCase());
  if (!m) return null;
  // An unrecognised area answers null rather than falling back to its first letter.
  // A fallback would map the invented area "QQ" onto real Scottish counts.
  return AREA_REGION[m[1]] || null;
}

/**
 * Count postcodes by region, largest first, with unreadable ones kept as an explicit
 * UNKNOWN bucket.
 *
 * UNKNOWN SORTS LAST WHATEVER ITS SIZE. At a college with patchy address data it is
 * often the biggest bucket, and a chart that opens on it reads as though most students
 * come from somewhere called Unknown — the caveat displacing the answer. It is present
 * so nobody can mistake a filtered chart for a complete one, which is a different job
 * from being ranked.
 *
 * Ties break on region name so that refetching the same data cannot reshuffle the bars.
 */
function countByRegion(postcodes) {
  const counts = new Map();
  for (const pc of postcodes || []) {
    const key = regionOf(pc) || UNKNOWN;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([region, count]) => ({ region, count }))
    .sort((a, b) => {
      if (a.region === UNKNOWN) return 1;
      if (b.region === UNKNOWN) return -1;
      return b.count - a.count || a.region.localeCompare(b.region);
    });
}

module.exports = { regionOf, countByRegion, UNKNOWN, AREA_REGION };
