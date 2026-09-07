// Weekly expansion: "this event, every week until December" into the dates it falls
// on.
//
// This exists because hand-entering twelve weeks of a Tuesday lecture is not a
// feature, it is a reason the tool goes unused.
//
// Pure — strings in, strings out, no database and no notion of what a college does
// on those dates. Bank holidays and reading weeks are the CALLER's business, passed
// in through `skip`, because whether a college teaches on Easter Monday is a policy
// question and hardcoding one answer to somebody else's policy is the worse failure.

// A typo in the end date must not generate fifty thousand rows. The register
// generator in routes/hnd.js caps at 60 weeks for the same reason, and a college
// year is under 52.
const MAX_WEEKS = 60;

/**
 * Every date on the same weekday as `startDate`, from `startDate` to `endDate`
 * inclusive, minus anything in `skip`.
 *
 * All arithmetic is in UTC. Local-time arithmetic across the spring clock change
 * lands on 23:00 the previous day and slips the entire remaining series back by one
 * date — a term of Tuesday lectures silently becoming Monday lectures at the end of
 * March. recurrence.test.js pins that case.
 */
function weeklyDates(startDate, endDate, { skip = [], maxWeeks = MAX_WEEKS } = {}) {
  const out = [];
  if (!startDate || !endDate || endDate < startDate) return out;

  const skipSet = new Set(skip);
  const cursor = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime())) return out;

  for (let i = 0; i < maxWeeks; i++) {
    const iso = cursor.toISOString().slice(0, 10);
    if (iso > endDate) break;
    // A skipped week is a week with no class, not a class moved to the following
    // week — shifting would push the whole term along by seven days.
    if (!skipSet.has(iso)) out.push(iso);
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return out;
}

// A term of Monday/Wednesday/Friday classes across a whole year is under 160 dates. The
// cap is the same insurance MAX_WEEKS is: a typo in the end date must not generate a
// year of rows for every weekday at once.
const MAX_DATES = 400;

/**
 * Every date between `startDate` and `endDate` inclusive whose ISO weekday is in `days`,
 * minus anything in `skip`.
 *
 * MULTI-WEEKDAY, which weeklyDates deliberately is not. A module taught Monday and
 * Thursday is ONE decision by the person entering it and TWO series to weeklyDates — and
 * two series drift, because somebody moves the Monday one and the Thursday one stays
 * where it was, with nothing recording that they were ever the same class.
 *
 * `days` is ISO weekdays, 1 = Monday to 7 = Sunday. Empty means "the weekday the start
 * date falls on", so a caller that passes nothing gets the obvious single-day series
 * rather than an empty one — the failure mode that would silently create no classes.
 *
 * All arithmetic is in UTC, for the reason weeklyDates records above: local-time
 * arithmetic across the spring clock change lands on 23:00 the previous day and slips
 * the rest of the series back by a date.
 */
function seriesDates(startDate, endDate, days = [], { skip = [], max = MAX_DATES } = {}) {
  const out = [];
  if (!startDate || !endDate || endDate < startDate) return out;

  const cursor = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime())) return out;

  // JS getUTCDay is 0 = Sunday; ISO is 7 = Sunday. Everything else in this feature
  // speaks ISO, so the conversion happens here rather than leaking two conventions.
  const isoDay = (d) => (d.getUTCDay() === 0 ? 7 : d.getUTCDay());

  const wanted = new Set(
    (Array.isArray(days) ? days : [])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7),
  );
  if (!wanted.size) wanted.add(isoDay(cursor));

  const skipSet = new Set(skip);
  while (out.length < max) {
    const iso = cursor.toISOString().slice(0, 10);
    if (iso > endDate) break;
    // A skipped date is a class that does NOT happen, not one moved to the next
    // occurrence — shifting would push the rest of the term along by a week.
    if (wanted.has(isoDay(cursor)) && !skipSet.has(iso)) out.push(iso);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

module.exports = { weeklyDates, seriesDates, MAX_WEEKS, MAX_DATES };
