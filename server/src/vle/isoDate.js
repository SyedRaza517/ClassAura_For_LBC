// An academic date, in the college's own timezone.
//
// Shared by both VLE normalisers. It began as four identical lines in each, which is
// ordinarily fine duplication — until a code review found the same timezone bug in
// both copies and it needed fixing twice. One bug, two homes, is the argument.
//
// PURE, and imports nothing — not clock.js, not process.env — so the normalisers that
// use it stay testable with no fixtures and no environment. The zone is a parameter
// with the same default clock.js uses, and the sync passes the tenant's own zone once
// per-college timezones exist.
//
// WHY NOT slice(0, 10) OFF THE ISO STRING
//
// Because that is UTC, and an academic date is not. A student who hands work in at
// 00:30 BST on the deadline day submitted ON the deadline day; the UTC string says
// 23:30 the night before, and slicing it dates their submission to the previous day.
// Lateness is then derived from the same value and inherits the error — so a
// submission made half an hour inside the deadline is recorded as late.
//
// clock.js carries the same warning for the same reason: "Render and most hosts run
// in UTC; without pinning a zone a 9:30 London check-in gets stamped 8:30."
const DEFAULT_ZONE = "Europe/London";

/**
 * An ISO timestamp as the YYYY-MM-DD the academic side stores, or null.
 *
 * "en-CA" formats dates in ISO order, which is the standard trick for getting a zoned
 * ISO date string out of toLocaleDateString.
 */
function isoDate(v, zone = DEFAULT_ZONE) {
  if (!v || typeof v !== "string") return null;
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return null;
  try {
    return d.toLocaleDateString("en-CA", { timeZone: zone });
  } catch {
    // An unrecognised zone must not lose the date entirely — fall back to the default
    // rather than returning null, which a caller would read as "no date at all".
    return d.toLocaleDateString("en-CA", { timeZone: DEFAULT_ZONE });
  }
}

module.exports = { isoDate, DEFAULT_ZONE };
