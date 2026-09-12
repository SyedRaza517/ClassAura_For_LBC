// Per-college settings for the Teams auto-attendance sync — the pure half.
//
// Split from teamsAttendanceConfig.js on purpose: everything here is a function of its
// arguments, so the rule a college's attendance depends on is testable without a
// database. The DB-backed resolver next door does the caching and the writing.
//
// Shape follows attendanceTapSettings.js, which itself follows attendanceBandConfig.js,
// the reference implementation: platform defaults in code, one JSON column merged over
// them, an allowlist on the way out, and a short cache invalidated on save.

const DEFAULTS = Object.freeze({
  // Ships OFF, and for the reason every other auto-attendance switch in this codebase
  // ships off: this writes to the attendance record, and a feature that does that must
  // not turn itself on at every college on the next deploy. A college that wants Teams
  // registers to feed attendance opts in from the Settings screen, after connecting an
  // organizer account and pointing timetabled sessions at real meetings — none of which
  // this deployment can know has happened just because the code shipped.
  enabled: false,
  // The minimum share of a meeting's duration a student must have been present for
  // before the sync marks them Present. Below this, and above 0% (a report row with no
  // time at all gets no mark rather than a guessed Absent — see the engine, not here),
  // the sync marks Absent.
  //
  // FIFTY, as a starting point a college can see and argue with rather than a number
  // buried in code. It is deliberately not the same value QR check-in or the tap
  // threshold use for anything: those observe a moment (a scan, a tap), this observes a
  // Teams attendance report's duration column, and "half the meeting" is a defensible
  // reading of "present" for a duration-based source in a way "half of an instant"
  // would not be.
  minAttendancePct: 50,
});

const SETTING_FIELDS = Object.freeze(Object.keys(DEFAULTS));

// Clamped at both ends, and the floor is doing real work, not just the ceiling — same
// reasoning as MIN_QR_ROTATE_SECONDS in attendanceTapSettings.js. Zero looks like the
// natural bottom of a percentage field, but zero percent is not a threshold at all: a
// student the report shows for one second out of a two-hour lecture still clears "more
// than 0%", so 0 would mark every ghost row Present. One is the true floor — it still
// requires the report to show SOME presence, which is the whole point of using a
// duration source rather than a tap or a scan. A hundred is the honest ceiling: nothing
// above "the whole meeting" means anything.
const MIN_PCT = 1;
const MAX_PCT = 100;

/** A finite percentage clamped to [MIN_PCT, MAX_PCT], or null when the value is unusable. */
function percentage(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(MAX_PCT, Math.max(MIN_PCT, v));
}

/**
 * The settings this college actually runs on: `base`, with any usable value from
 * `stored` merged over it.
 *
 * Always complete and always valid, so no caller needs a fallback of its own and no
 * caller can be handed a half-configured object. A stored blob can predate a rule or be
 * edited by hand in a console; an unusable value falls back rather than reaching the
 * sync, where a NaN comparison would silently mark nobody and look exactly like a quiet
 * day.
 *
 * WHAT `base` IS FOR, AND WHY IT IS NOT ALWAYS DEFAULTS — same contract as
 * attendanceTapSettings.js's merge(): reading a stored row falls back to the platform
 * defaults, because nothing else is known. But saving a PATCH must fall back to what
 * the college ALREADY had, or a single bad key silently undoes a neighbouring setting —
 * send `{ minAttendancePct: "half" }` and a carefully chosen 75 reverts to 50, answering
 * 200 OK. So save() passes the current settings as the base, which makes an unusable
 * key IGNORED rather than reset.
 */
function merge(stored, base = DEFAULTS) {
  const out = { ...base };
  if (!stored || typeof stored !== "object") return out;

  // Compared identically, not coerced, exactly like `enabled` in attendanceTapSettings.js
  // and for the same reason: "false" and 0 are both mistakes somewhere in a chain of
  // JSON, and reading either as consent to switch a college's attendance sync on is the
  // wrong failure to choose. Anything that is not a literal boolean falls through to the
  // base, which for a college that has never opened this screen is DEFAULTS — off.
  if (stored.enabled === true || stored.enabled === false) out.enabled = stored.enabled;

  const pct = percentage(stored.minAttendancePct);
  if (pct !== null) out.minAttendancePct = pct;

  return out;
}

module.exports = { DEFAULTS, SETTING_FIELDS, MIN_PCT, MAX_PCT, merge };
