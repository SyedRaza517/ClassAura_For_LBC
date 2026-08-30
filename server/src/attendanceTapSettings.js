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
  // Whether a lecturer can put a rotating QR code on screen and have students scan it.
  //
    // Ships OFF, and SEPARATELY from `enabled` rather than implied by it. These are two
  // different capture methods with different physical properties — a sticker needs
  // proximity, a screen can be photographed — and a college may reasonably want one and
  // not the other. Inferring this switch from the sticker switch would silently give an
  // institution a second way of writing to its attendance record on the next deploy,
  // which is the exact thing `enabled` defaulting to false exists to prevent.
  qrEnabled: false,
  // How often the on-screen code changes.
  //
  // This is the single number the feature's honesty rests on. A photographed screen works
  // until the code rotates, so this is literally how long proxy attendance stays possible
  // — and it trades directly against a student with a slow phone or poor signal, who is
  // refused if the code moves on before they can focus. Thirty seconds is the compromise;
  // it is a setting because this is exactly the sort of threshold a college will want to
  // argue about, and it should not need a deploy to say so.
  qrRotateSeconds: 30,
});

const SETTING_FIELDS = Object.freeze(Object.keys(DEFAULTS));

// A ceiling on every minute field. Without one, a typo of 600 in earlyGraceMins accepts
// a tap ten hours before the class starts — which is not a setting, it is an outage in
// the attendance record. Two hours is past any plausible intent.
const MAX_MINS = 120;
const MAX_ARM_SECONDS = 600;

// The rotation period is bounded at BOTH ends, and the floor does as much work as the
// ceiling — which is unusual here and worth saying why.
//
// Too long, and the code stops rotating in any meaningful sense: a square that lives for
// an hour is the permanent code this whole design exists to avoid, reachable by typing a
// large number into a settings box.
//
// Too short, and the feature simply does not work. A code that changes every second is
// gone before a phone at the back of a room can focus on it, and the failure presents as
// "the QR never works" rather than as a bad setting — so it gets blamed on the feature and
// switched off. Ten seconds is about the floor of what a phone camera plus a network round
// trip can actually complete.
const MIN_QR_ROTATE_SECONDS = 10;
const MAX_QR_ROTATE_SECONDS = 300;

/** A whole number of minutes within range, or null when the value is unusable. */
function minutes(v, max) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n < 0) return null;
  return Math.min(n, max);
}

/**
 * The settings this college actually runs on: `base`, with any usable value from
 * `stored` merged over it.
 *
 * Always complete and always valid, so no caller needs a fallback of its own and no
 * caller can be handed a half-configured object. A stored blob can predate a rule or be
 * edited by hand in a console; an unusable value falls back rather than reaching the
 * resolver, where a NaN comparison would silently mark nobody and look exactly like a
 * quiet day.
 *
 * WHAT `base` IS FOR, AND WHY IT IS NOT ALWAYS DEFAULTS
 *
 * Reading a stored row falls back to the platform defaults, which is right: nothing else
 * is known. But saving a PATCH must fall back to what the college ALREADY had, or a
 * single bad key silently undoes a neighbouring setting somebody tuned last term — send
 * `{ lateAfterMins: "twenty" }` and a carefully chosen 30 reverts to 15, answering 200 OK.
 * Worse, `{ enabled: null }` is reachable from JSON and would switch a whole college OFF
 * while reporting success. So save() passes the current settings as the base, which makes
 * an unusable key IGNORED rather than reset. That is what the PATCH contract in
 * attendanceTapConfig.save() actually promises.
 */
function merge(stored, base = DEFAULTS) {
  const out = { ...base };
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

  if (stored.qrEnabled === true || stored.qrEnabled === false) out.qrEnabled = stored.qrEnabled;

  // Clamped rather than merely capped, because this field has a meaningful floor. Note
  // `minutes()` is reused for the range check but returns null for anything unusable, so a
  // bad value still falls through to the base — ignored, not reset, as the PATCH contract
  // promises. A usable-but-too-small number is raised to the floor rather than ignored:
  // somebody typing 5 meant "as fast as possible", not "leave it alone".
  const rotate = minutes(stored.qrRotateSeconds, MAX_QR_ROTATE_SECONDS);
  if (rotate !== null) out.qrRotateSeconds = Math.max(MIN_QR_ROTATE_SECONDS, rotate);

  return out;
}

module.exports = {
  DEFAULTS, SETTING_FIELDS, MAX_MINS, MAX_ARM_SECONDS,
  MIN_QR_ROTATE_SECONDS, MAX_QR_ROTATE_SECONDS, merge,
};
