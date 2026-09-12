// Per-college settings for the Teams automation switches — the pure half.
//
// Split from teamsAutomationConfig.js on purpose: everything here is a function of its
// arguments, so the rule a college runs on is testable without a database. The
// DB-backed resolver next door does the caching and the writing.
//
// Shape follows teamsAttendanceSettings.js, which itself follows attendanceTapSettings.js
// and attendanceBandConfig.js, the reference implementation: platform defaults in code,
// one JSON column merged over them, an allowlist on the way out, and a short cache
// invalidated on save.

const DEFAULTS = Object.freeze({
  // Ships OFF, for the same reason teamsAttendanceSettings.js's `enabled` does: this
  // switch, once on, calls Graph to create a meeting for every timetabled session and
  // writes the resulting join URL back onto it — a side effect a college has not agreed
  // to just because the code shipped. A college that wants sessions to get meetings of
  // their own opts in from the Settings screen, after connecting an organizer account
  // capable of creating them. See constraints.md: OFF means no Graph calls at all.
  autoCreateMeetings: false,
  // Ships OFF for the same reason, and additive-only when it is on (see
  // constraints.md): it creates a Team and its channels and adds members it can match,
  // but it never removes a member, a channel or a Team, and never renames one after
  // creation. Two independent switches, not one, because a college may want meetings
  // created without a Team ever being provisioned, or the reverse — a Team space set up
  // once, with meetings still booked by hand.
  provisionTeams: false,
});

const SETTING_FIELDS = Object.freeze(Object.keys(DEFAULTS));

/**
 * The settings this college actually runs on: `base`, with any usable value from
 * `stored` merged over it.
 *
 * Always complete and always valid, so no caller needs a fallback of its own and no
 * caller can be handed a half-configured object. A stored blob can predate a rule or be
 * edited by hand in a console; an unusable value falls back rather than reaching the
 * scheduler, where a truthy-but-not-boolean value would be one accidental JSON edit away
 * from turning Graph calls on for every college.
 *
 * WHAT `base` IS FOR, AND WHY IT IS NOT ALWAYS DEFAULTS — same contract as
 * teamsAttendanceSettings.js's merge(): reading a stored row falls back to the platform
 * defaults, because nothing else is known. But saving a PATCH must fall back to what the
 * college ALREADY had, or a single bad key silently undoes the neighbour switch — send
 * `{ autoCreateMeetings: "yes" }` and a deliberately-enabled `provisionTeams` reverts to
 * false, answering 200 OK. So save() passes the current settings as the base, which
 * makes an unusable key IGNORED rather than reset.
 */
function merge(stored, base = DEFAULTS) {
  const out = { ...base };
  if (!stored || typeof stored !== "object") return out;

  // Compared identically, not coerced, exactly like `enabled` in
  // teamsAttendanceSettings.js and for the same reason: "true" and 1 are both mistakes
  // somewhere in a chain of JSON, and reading either as consent to let this deployment
  // create meetings or provision Teams on a college's behalf is the wrong failure to
  // choose. Anything that is not a literal boolean falls through to the base, which for
  // a college that has never opened this screen is DEFAULTS — both switches off.
  if (stored.autoCreateMeetings === true || stored.autoCreateMeetings === false) {
    out.autoCreateMeetings = stored.autoCreateMeetings;
  }
  if (stored.provisionTeams === true || stored.provisionTeams === false) {
    out.provisionTeams = stored.provisionTeams;
  }

  return out;
}

module.exports = { DEFAULTS, SETTING_FIELDS, merge };
