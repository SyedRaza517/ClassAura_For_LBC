// Tests for the VLE engagement judgements.
//
// No network, no database, no clock. Weighted towards the cases where a plausible
// number would be a lie, because that is the failure mode this whole subsystem is
// arranged around: zero engagement across a college is indistinguishable from a missing
// capability by counting, so every distinction has to be made here, at the boundary.
//
// Run with: node --test src/vle/engagementNormalise.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { observeUser, accessDate, classifyFailure, coverage, summariseEngagement } = require("./engagementNormalise");
const { isoDate } = require("./isoDate");

const toIso = (s) => isoDate(s, "Europe/London");
const DAY = "2026-08-28";
const at = (iso) => Math.floor(Date.parse(iso) / 1000);

/* -------------------------------------------------------------------------- */
/* The zero that is not a date                                                 */
/* -------------------------------------------------------------------------- */

test("Moodle's lastaccess of 0 means NEVER, not 1970", () => {
  // The failure this prevents is loud and specific: 0 treated as a timestamp dates the
  // student to 1 January 1970, and "twenty thousand days since last access" sorts them
  // to the top of every risk list in the college.
  assert.equal(accessDate(0, toIso), null);
});

test("a real timestamp becomes the college's own date", () => {
  assert.equal(accessDate(at("2026-08-28T09:15:00Z"), toIso), "2026-08-28");
});

test("a timestamp just after midnight in the college's zone is dated correctly", () => {
  // 23:30Z on the 27th is 00:30 on the 28th in London. A UTC slice would date it a day
  // early, and every day-count built on it would be off by one.
  assert.equal(accessDate(at("2026-08-27T23:30:00Z"), toIso), "2026-08-28");
});

test("nonsense timestamps produce no date rather than a wrong one", () => {
  for (const junk of [null, undefined, NaN, -1, "yesterday", {}]) {
    assert.equal(accessDate(junk, toIso), null, String(junk));
  }
});

/* -------------------------------------------------------------------------- */
/* The key that is absent rather than null                                     */
/* -------------------------------------------------------------------------- */

test("a site that hides last access is NOT OBSERVABLE, and must not be stored", () => {
  // $CFG->hiddenuserfields OMITS the key rather than nulling it, so testing === null
  // misses it entirely. A row written here would claim we looked and saw nothing, which
  // is the one lie this table exists to prevent.
  const r = observeUser({ id: 7, fullname: "A Student" }, DAY, toIso);
  assert.equal(r.observable, false);
  assert.equal(r.accessed, null);
  assert.equal(r.lastAccessOn, null);
});

test("a student the site HAS never seen is observable, and observed as inactive", () => {
  // The distinction the whole design turns on: the field is present and says 0, so we
  // looked and they have never been. That is a finding. The case above is not.
  const r = observeUser({ id: 7, lastcourseaccess: 0 }, DAY, toIso);
  assert.equal(r.observable, true);
  assert.equal(r.accessed, false);
  assert.equal(r.lastAccessOn, null);
});

test("a student who reached the course today is recorded as having accessed it", () => {
  const r = observeUser({ id: 7, lastcourseaccess: at("2026-08-28T10:00:00Z") }, DAY, toIso);
  assert.equal(r.accessed, true);
  assert.equal(r.lastAccessOn, DAY);
});

test("a student who last came a week ago is observed INACTIVE today, with the date kept", () => {
  // accessed:false is a real observation, not an absence — it is what makes an
  // active-days denominator possible at all.
  const r = observeUser({ id: 7, lastcourseaccess: at("2026-08-21T10:00:00Z") }, DAY, toIso);
  assert.equal(r.observable, true);
  assert.equal(r.accessed, false);
  assert.equal(r.lastAccessOn, "2026-08-21");
});

test("the course-scoped field wins over the site-wide one", () => {
  // Site-wide access counts a student who logged in to read a different course's notes.
  // For a unit-level signal that is the wrong question.
  const r = observeUser({
    lastcourseaccess: at("2026-08-21T10:00:00Z"),
    lastaccess: at("2026-08-28T10:00:00Z"),
  }, DAY, toIso);
  assert.equal(r.lastAccessOn, "2026-08-21");
  assert.equal(r.accessed, false);
});

test("the site-wide field is used only when the course-scoped one is absent", () => {
  const r = observeUser({ lastaccess: at("2026-08-28T10:00:00Z") }, DAY, toIso);
  assert.equal(r.observable, true);
  assert.equal(r.accessed, true);
});

/* -------------------------------------------------------------------------- */
/* Telling a refusal from a fault                                              */
/* -------------------------------------------------------------------------- */

test("a permissions refusal is a fact about the college, not a bug", () => {
  for (const code of ["accessexception", "nopermissions", "required_capability_exception"]) {
    assert.equal(classifyFailure(code), "denied", code);
  }
});

test("anything else is a fault and must not be recorded as a missing capability", () => {
  // Misclassifying a fault as "denied" would silently turn a broken sync into "this
  // college does not record engagement" and mute every signal instead of reporting a
  // failure — the quietest possible way for this feature to stop working.
  for (const code of ["dmlwriteexception", "servertimeout", "invalidrecord", ""]) {
    assert.equal(classifyFailure(code), "error", code);
  }
});

/* -------------------------------------------------------------------------- */
/* Coverage                                                                    */
/* -------------------------------------------------------------------------- */

test("a partial run reports the fraction it managed", () => {
  assert.equal(coverage(12, 5), 41.7);
});

test("attempting nothing is null coverage, not zero", () => {
  // Zero would read as "we looked at the whole college and found nothing", which is the
  // opposite of "we did not look".
  assert.equal(coverage(0, 0), null);
});

test("a complete run reports one hundred", () => {
  assert.equal(coverage(12, 12), 100);
});

/* -------------------------------------------------------------------------- */
/* Summarising a run of observations                                           */
/* -------------------------------------------------------------------------- */

const obs = (day, accessed, unitId, lastAccessOn) => ({ observedOn: day, accessed, unitId, lastAccessOn });

test("no observations is NULL engagement, not zero", () => {
  // The rule the whole table exists to make expressible. Zero would say "we looked at
  // this student every day and they never came", which is a finding. No rows says
  // nobody could look, which is not.
  const r = summariseEngagement([]);
  assert.deepEqual(r, { lastAccessOn: null, activeDayRate: null, observedDays: null, unitsObserved: null });
});

test("the denominator is DAYS, not rows", () => {
  // A student on four units gets four rows a day. Counting rows would make somebody who
  // opened one course out of four EVERY day look 75% disengaged, when the question is
  // whether they turned up to the VLE at all.
  const rows = [];
  for (const day of ["2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28"]) {
    rows.push(obs(day, true, "u1"), obs(day, false, "u2"), obs(day, false, "u3"), obs(day, false, "u4"));
  }
  const r = summariseEngagement(rows);
  assert.equal(r.observedDays, 5, "five days, not twenty rows");
  assert.equal(r.activeDayRate, 100, "they reached the VLE on every one of them");
  assert.equal(r.unitsObserved, 4);
});

test("a genuinely dormant student who WAS observed reads zero, and that zero is real", () => {
  const rows = ["2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28"]
    .map((d) => obs(d, false, "u1"));
  const r = summariseEngagement(rows);
  assert.equal(r.observedDays, 5);
  assert.equal(r.activeDayRate, 0, "observed five times and never came — a finding, not an absence");
});

test("a rate is withheld below the minimum denominator, but the dates are not", () => {
  // One observed day where the student did not log in reads 0% and the screen renders
  // "never active" — a pattern claimed from one data point, on the first day of
  // observation. The DATE survives, because a date is true from one observation.
  const r = summariseEngagement([obs("2026-08-28", false, "u1", "2026-07-01")]);
  assert.equal(r.activeDayRate, null);
  assert.equal(r.observedDays, 1);
  assert.equal(r.lastAccessOn, "2026-07-01");
});

test("the floor is configurable and honoured", () => {
  const rows = [obs("2026-08-27", true, "u1"), obs("2026-08-28", false, "u1")];
  assert.equal(summariseEngagement(rows).activeDayRate, null);
  assert.equal(summariseEngagement(rows, { minObservedDays: 2 }).activeDayRate, 50);
});

test("last access is the latest the SITE reported, which may predate every observation", () => {
  // A student last seen in July, observed daily through September, was last active in
  // July — and today's row is what says so. Reporting the observation date instead would
  // claim they had just been on.
  const rows = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"]
    .map((d) => obs(d, false, "u1", "2026-07-14"));
  const r = summariseEngagement(rows);
  assert.equal(r.lastAccessOn, "2026-07-14");
  assert.equal(r.activeDayRate, 0);
});

test("a never-accessed student carries no last-access date rather than a fake one", () => {
  const rows = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"]
    .map((d) => obs(d, false, "u1", null));
  assert.equal(summariseEngagement(rows).lastAccessOn, null);
});
