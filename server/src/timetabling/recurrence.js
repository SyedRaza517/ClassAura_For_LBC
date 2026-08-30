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

module.exports = { weeklyDates, MAX_WEEKS };
