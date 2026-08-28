// Turning what a VLE says about a student's activity into something safe to store.
//
// PURE. No network, no database, no clock — the same seam canvasNormalise.js and
// blackboardNormalise.js keep, and for the same reason: these are the judgements that
// get argued with, and they have to be checkable without standing up a Moodle.
//
// THE ONE ENCODING EVERYTHING RESTS ON: A ROW MEANS "WE LOOKED".
//
// An observed-but-inactive student gets a row saying `accessed: false`. A student we
// could not observe gets NO ROW AT ALL. Absence is the null.
//
// This matters more here than anywhere else in the codebase, because engagement breaks
// the trick the other institution guards rely on. Those work by counting: zero "L"
// attendance marks across a whole college can only mean the register has no lateness
// code, because a college where nobody was ever late does not exist. Engagement is not
// like that. Zero engagement across a college is EXACTLY what a genuinely disengaged
// cohort looks like, AND exactly what a missing web-service capability looks like, AND
// exactly what a college that teaches face to face and uses Moodle as a filing cabinet
// looks like. No count can separate them. The separation has to be recorded at the
// moment of the pull, by the code that saw the HTTP response — which is why there is a
// capability record, and why silence is stored as absence rather than as zero.
//
// THE ZERO THAT IS NOT A DATE.
//
// Moodle sends `lastaccess: 0` to mean NEVER. Multiplying that by 1000 and calling it a
// timestamp dates the student to 1 January 1970, and "twenty thousand days since last
// access" sorts them straight to the top of every risk list in the college. moodle.js
// already gets this right for grade dates; the same rule is mandatory here.
//
// THE KEY THAT IS ABSENT RATHER THAN NULL.
//
// A Moodle site can suppress `lastaccess` through $CFG->hiddenuserfields, and when it
// does the field is OMITTED from the response rather than returned as null. Testing
// `=== null` therefore misses it entirely — the same trap canvasNormalise documents for
// sis_user_id. Every read here tests presence, not equality.

/** Unix seconds -> YYYY-MM-DD, or null.
 *
 *  Null for: absent, non-numeric, and — critically — ZERO, which Moodle uses for
 *  "never accessed". Zero is not the epoch here; it is the absence of an event. */
function accessDate(seconds, toIsoDate) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  if (seconds <= 0) return null;   // Moodle's "never", not 1970
  return toIsoDate(new Date(seconds * 1000).toISOString());
}

/**
 * One enrolled-user record from Moodle into one day's observation.
 *
 * @param {object} user      a row from core_enrol_get_enrolled_users
 * @param {string} day       YYYY-MM-DD in the college's own zone — the day this
 *                           observation is ABOUT, passed in rather than read from a clock
 * @param {function} toIsoDate  the zoned converter (vle/isoDate)
 * @returns {{accessed: boolean|null, lastAccessOn: string|null, observable: boolean}}
 *
 * `observable: false` means this site does not expose the field at all — the caller
 * must then write NO ROW, because a row would claim we looked and saw nothing.
 */
function observeUser(user, day, toIsoDate) {
  const u = user || {};

  // PRESENCE, not equality. A site hiding the field omits the key; a site that exposes
  // it and has never seen this student sends 0. Those are different facts and the first
  // one must not be storable.
  const hasCourse = Object.prototype.hasOwnProperty.call(u, "lastcourseaccess");
  const hasSite = Object.prototype.hasOwnProperty.call(u, "lastaccess");
  if (!hasCourse && !hasSite) return { accessed: null, lastAccessOn: null, observable: false };

  // The course-scoped field is the one that means anything for a unit-level signal.
  // Site-wide last access is the fallback and is weaker: a student who logged in to
  // read a different course's notes counts.
  const raw = hasCourse ? u.lastcourseaccess : u.lastaccess;
  const lastAccessOn = accessDate(raw, toIsoDate);

  return {
    // Did they reach it ON the day being observed? A last-access date earlier than
    // today is a real observation of inactivity — that is the `false` this whole table
    // exists to be able to record, and it is what makes an active-days denominator
    // possible at all.
    accessed: lastAccessOn === day,
    lastAccessOn,
    observable: true,
  };
}

/**
 * What a failed web-service call tells us about the college, as opposed to about a bug.
 *
 * Moodle answers a permissions problem with a machine-readable errorcode. Matching on
 * the human message instead would break the first time a college runs a language pack,
 * and would classify a genuine fault as a missing capability — which would silently
 * turn a broken sync into "this college does not record engagement" and mute every
 * signal rather than reporting a failure.
 */
const DENIED_CODES = new Set([
  "accessexception",
  "nopermissions",
  "required_capability_exception",
  "webservice_access_exception",
  "invalidtoken",
]);

function classifyFailure(errorcode) {
  if (!errorcode) return "error";
  return DENIED_CODES.has(String(errorcode)) ? "denied" : "error";
}

/**
 * The coverage of one run: how much of the college we actually managed to look at.
 *
 * A partial run is not a smaller success. `lastcourseaccess` is a scalar that has moved
 * on by the next night, so a scope missed tonight is missed FOR EVER — there is no
 * backfill and one must not be faked by interpolating. Recording the fraction is what
 * lets a later reader discount a figure rather than trusting it.
 */
function coverage(attempted, observed) {
  if (!attempted) return null;          // nothing was tried; not "nothing was found"
  return Math.round((observed / attempted) * 1000) / 10;
}

module.exports = { observeUser, accessDate, classifyFailure, coverage, DENIED_CODES };
