// Per-college settings for NFC tap check-in — the pure half.
//
// Split from attendanceTapConfig.js on purpose: everything here is a function of its
// arguments, so the rules a college's attendance depends on are testable without a
// database. The DB-backed resolver next door does the caching and the writing.
//
// Shape follows attendanceBandConfig.js, which is the reference implementation:
// platform defaults in code, one JSON column merged over them, an allowlist on the way
// out, and a short cache invalidated on save.

const DEFAULTS = Object.freeze({
  // Ships OFF. Attendance emails do the same, and for the same reason: a feature that
  // writes to the attendance record must not switch itself on at every college on the
  // next deploy.
  enabled: false,
  // Past this many minutes after the start, a tap records L rather than P.
  lateAfterMins: 15,
  // Minutes BEFORE the start that taps begin to be accepted. Zero is the rule as
  // specified — not before the lecture. It is a setting because a student outside the
  // door at 08:58 for a 09:00 class is a normal thing that will be reported as a bug in
  // week one, and a college that decides five minutes is fine should not need a deploy
  // to say so.
  earlyGraceMins: 0,
  // How long a tag read keeps the check-in button live in the app. Long enough to press,
  // too short to walk to another room.
  armSeconds: 60,
  // Whether the same stickers also clock staff in.
  staffTapEnabled: true,
});

const SETTING_FIELDS = Object.freeze(Object.keys(DEFAULTS));

// A ceiling on every minute field. Without one, a typo of 600 in earlyGraceMins accepts
// a tap ten hours before the class starts — which is not a setting, it is an outage in
// the attendance record. Two hours is past any plausible intent.
const MAX_MINS = 120;
const MAX_ARM_SECONDS = 600;

/** A whole number of minutes within range, or null when the value is unusable. */
function minutes(v, max) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n < 0) return null;
  return Math.min(n, max);
}

/**
 * The settings this college actually runs on: the defaults, with any stored value
 * merged over them.
 *
 * Always complete and always valid, so no caller needs a fallback of its own and no
 * caller can be handed a half-configured object. A stored blob can predate a rule or be
 * edited by hand in a console; an unusable value falls back to the platform default
 * rather than reaching the resolver, where a NaN comparison would silently mark nobody
 * and look exactly like a quiet day.
 */
function merge(stored) {
  const out = { ...DEFAULTS };
  if (!stored || typeof stored !== "object") return out;

  // Booleans are compared identically, not coerced. "false" and 0 are both mistakes
  // somewhere in a chain of JSON, and reading either as consent to switch a college on
  // is the wrong failure to choose.
  if (stored.enabled === true || stored.enabled === false) out.enabled = stored.enabled;
  if (stored.staffTapEnabled === true || stored.staffTapEnabled === false) out.staffTapEnabled = stored.staffTapEnabled;

  const late = minutes(stored.lateAfterMins, MAX_MINS);
  if (late !== null) out.lateAfterMins = late;

  const grace = minutes(stored.earlyGraceMins, MAX_MINS);
  if (grace !== null) out.earlyGraceMins = grace;

  const arm = minutes(stored.armSeconds, MAX_ARM_SECONDS);
  if (arm !== null) out.armSeconds = arm;

  return out;
}

module.exports = { DEFAULTS, SETTING_FIELDS, MAX_MINS, MAX_ARM_SECONDS, merge };
