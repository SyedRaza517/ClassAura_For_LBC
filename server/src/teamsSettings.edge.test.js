// Edge cases for the settings merges and the two fingerprints — the pure decisions that
// sit either side of the sync engine.
//
// The settings merge is the gate on whether anything runs at all, and its `base`
// contract is the subtle half: reading falls back to the platform defaults, but SAVING a
// patch must fall back to what the college already had, or one bad key silently undoes a
// neighbouring setting while answering 200 OK.
//
// The fingerprints are the gate on whether Microsoft re-notifies every attendee. A
// fingerprint that changes when nothing really changed re-PATCHes an unchanged meeting on
// every hourly tick, and every attendee gets an email about it, forever — the exact bug
// the per-event fingerprint was introduced to fix once already.
const test = require("node:test");
const assert = require("node:assert/strict");
const att = require("./teamsAttendanceSettings");
const auto = require("./teamsAutomationSettings");
const { meetingFingerprint, seriesFingerprint } = require("./teamsMeetings");
const { truncateName, teamNameFor } = require("./teamsProvisioning");

/* ------------------------------------------------ attendance settings: the base contract -- */

test("attendance: an unusable patch key leaves the college's OWN value standing, not the default", () => {
  // The whole reason merge takes a base. A college that deliberately set 75% sends a
  // patch with a typo'd percentage; the save must ignore that key, not quietly revert
  // their threshold to the platform 50 and report success.
  const current = { enabled: true, minAttendancePct: 75 };
  const saved = att.merge({ minAttendancePct: "half" }, current);
  assert.equal(saved.minAttendancePct, 75, "a bad key must be ignored, never reset to DEFAULTS");
  assert.equal(saved.enabled, true, "and its neighbour must be untouched");
});

test("attendance: a numeric STRING is not a number and is refused rather than coerced", () => {
  // percentage() checks typeof, deliberately. "75" arriving from a form that forgot to
  // parse is a bug upstream; coercing it here would hide that bug until the one day the
  // string is "75%" and coercion yields NaN.
  assert.equal(att.merge({ minAttendancePct: "75" }).minAttendancePct, 50);
});

test("attendance: NaN and both infinities fall back instead of reaching the sync", () => {
  // A NaN threshold makes every `minutes < required` comparison false, which marks the
  // whole college Present and looks exactly like a normal day on the register.
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.equal(att.merge({ minAttendancePct: bad }).minAttendancePct, 50, `${bad} must not survive`);
  }
});

test("attendance: the percentage floor is 1, because 0% would mark every ghost row Present", () => {
  assert.equal(att.merge({ minAttendancePct: 0 }).minAttendancePct, att.MIN_PCT);
  assert.equal(att.merge({ minAttendancePct: -40 }).minAttendancePct, att.MIN_PCT);
  assert.equal(att.MIN_PCT, 1);
});

test("attendance: the ceiling is 100, because nothing above 'the whole meeting' means anything", () => {
  assert.equal(att.merge({ minAttendancePct: 101 }).minAttendancePct, 100);
  assert.equal(att.merge({ minAttendancePct: 1e9 }).minAttendancePct, 100);
});

test("attendance: a fractional percentage is kept as-is, and decideStatus's ceil() absorbs it", () => {
  // Characterisation: percentage() clamps but does not round, so 62.5 survives the merge.
  // That is safe only because the threshold is computed with Math.ceil downstream — worth
  // pinning here so a future "simplification" to round() cannot quietly loosen it.
  assert.equal(att.merge({ minAttendancePct: 62.5 }).minAttendancePct, 62.5);
});

test("attendance: `enabled` accepts only a literal boolean — never a truthy string or 1", () => {
  // Reading "false" or 0 as consent to switch a college's attendance writing on is the
  // wrong failure to choose, so anything non-boolean falls through to the base.
  for (const bad of ["true", "false", 1, 0, null, [], {}]) {
    assert.equal(att.merge({ enabled: bad }).enabled, false, `${JSON.stringify(bad)} must not switch it on`);
  }
  assert.equal(att.merge({ enabled: true }).enabled, true);
  assert.equal(att.merge({ enabled: false }, { enabled: true, minAttendancePct: 50 }).enabled, false,
    "an explicit false must still be able to switch it OFF");
});

test("attendance: a stored blob that is not an object yields the base untouched", () => {
  for (const bad of [null, undefined, "", "enabled", 7, true]) {
    assert.deepEqual(att.merge(bad), att.DEFAULTS);
  }
  // An array is technically an object; it carries no known keys, so it is a no-op.
  assert.deepEqual(att.merge([]), att.DEFAULTS);
});

test("attendance: merge never mutates the base it was given", () => {
  // DEFAULTS is frozen, so a mutating implementation would throw in strict mode — but the
  // base is usually the college's live settings object, which is not frozen, and silently
  // editing it would make a rejected save look applied in the caller's memory.
  const base = { enabled: false, minAttendancePct: 50 };
  const out = att.merge({ enabled: true, minAttendancePct: 80 }, base);
  assert.deepEqual(base, { enabled: false, minAttendancePct: 50 }, "the base must be left alone");
  assert.notEqual(out, base);
});

/* ------------------------------------------------ automation settings: the two switches -- */

test("automation: an unusable key leaves the neighbour switch exactly as it was", () => {
  const current = { autoCreateMeetings: false, provisionTeams: true };
  const saved = auto.merge({ autoCreateMeetings: "yes" }, current);
  assert.deepEqual(saved, current, "a bad key must not revert a deliberately-enabled switch");
});

test("automation: each switch can be turned off explicitly without disturbing the other", () => {
  const both = { autoCreateMeetings: true, provisionTeams: true };
  assert.deepEqual(auto.merge({ autoCreateMeetings: false }, both), { autoCreateMeetings: false, provisionTeams: true });
  assert.deepEqual(auto.merge({ provisionTeams: false }, both), { autoCreateMeetings: true, provisionTeams: false });
});

test("automation: a non-object stored blob yields the base, and never throws", () => {
  for (const bad of [null, undefined, "", 0, false, "provisionTeams"]) {
    assert.deepEqual(auto.merge(bad), auto.DEFAULTS);
  }
});

test("automation: merge never mutates the base it was given", () => {
  const base = { autoCreateMeetings: false, provisionTeams: false };
  auto.merge({ autoCreateMeetings: true }, base);
  assert.deepEqual(base, { autoCreateMeetings: false, provisionTeams: false });
});

/* ------------------------------------------------------------------------ fingerprints -- */

const mbase = { subject: "OBM Lecture", date: "2026-09-15", startTime: "10:00", endTime: "12:00", attendeeEmails: ["a@x.ac.uk", "b@x.ac.uk"] };

test("meeting fingerprint: a duplicated attendee DOES read as a change — de-duplication is the caller's job", () => {
  // Characterisation, not an endorsement. The fingerprint sorts but does not de-duplicate,
  // so a list that gained a duplicate looks like a real edit and would re-PATCH the
  // meeting, re-notifying everyone on it. That is safe only because every caller builds
  // the list through `new Set(...)` first. If a future caller skips that, this is the line
  // that explains the mystery weekly email.
  assert.notEqual(
    meetingFingerprint(mbase),
    meetingFingerprint({ ...mbase, attendeeEmails: ["a@x.ac.uk", "a@x.ac.uk", "b@x.ac.uk"] }),
    "characterisation: a duplicate DOES change the fingerprint — the caller de-duplicates, this does not",
  );
});

test("meeting fingerprint: an empty attendee list is stable, and differs from one attendee", () => {
  assert.equal(meetingFingerprint({ ...mbase, attendeeEmails: [] }), meetingFingerprint({ ...mbase, attendeeEmails: [] }));
  assert.notEqual(meetingFingerprint({ ...mbase, attendeeEmails: [] }), meetingFingerprint({ ...mbase, attendeeEmails: ["a@x.ac.uk"] }));
});

test("meeting fingerprint: a subject containing the separator still distinguishes two meetings", () => {
  // Fields are joined with "|", and a subject is free text a human typed. Two genuinely
  // different meetings must not collapse to one fingerprint and stop being updated.
  const a = { ...mbase, subject: "OBM | Group A" };
  const b = { ...mbase, subject: "OBM | Group B" };
  assert.notEqual(meetingFingerprint(a), meetingFingerprint(b));
  assert.notEqual(meetingFingerprint(a), meetingFingerprint({ ...mbase, subject: "OBM" }));
});

test("meeting fingerprint: a missing attendee list THROWS — an asymmetry with the series one", () => {
  // Characterisation of a real inconsistency, written down rather than smoothed over.
  // seriesFingerprint guards every list with `|| []`; meetingFingerprint spreads
  // attendeeEmails unguarded. Unreachable today — every caller builds the array before
  // calling — but a new caller that omits it gets a thrown run rather than a fingerprint,
  // and a thrown run inside reconcile costs the remaining events in that pass.
  assert.throws(() => meetingFingerprint({ ...mbase, attendeeEmails: undefined }));
});

const sbase = { subject: "OBM", firstDate: "2026-09-14", lastDate: "2026-12-07", weekdays: ["monday", "thursday"], startTime: "10:00", endTime: "12:00", attendeeEmails: ["a@x", "b@x"], staffEmails: ["t@x"] };

test("series fingerprint: the staff list is tracked SEPARATELY from attendees, which is the point of it", () => {
  // The stated reason the series fingerprint carries staffEmails at all: staff drive the
  // co-organizer write, so swapping the lecturer must re-sync even when the attendee list
  // is unchanged — and even when that lecturer's address is already among the attendees,
  // where a union-only fingerprint would see nothing happen.
  const withStaffInAttendees = { ...sbase, attendeeEmails: ["a@x", "b@x", "t@x"], staffEmails: ["t@x"] };
  const lecturerSwapped = { ...withStaffInAttendees, attendeeEmails: ["a@x", "b@x", "u@x"], staffEmails: ["u@x"] };
  assert.notEqual(seriesFingerprint(withStaffInAttendees), seriesFingerprint(lecturerSwapped));
});

test("series fingerprint: staff order does not matter, only membership", () => {
  const two = { ...sbase, staffEmails: ["t@x", "u@x"] };
  assert.equal(seriesFingerprint(two), seriesFingerprint({ ...two, staffEmails: ["u@x", "t@x"] }));
});

test("series fingerprint: missing lists are treated as empty, never as a throw", () => {
  // The guard meetingFingerprint lacks. A series with no staff resolved yet is a real
  // state during a first run, and it must produce a fingerprint rather than kill the pass.
  const bare = { subject: "OBM", firstDate: "2026-09-14", lastDate: "2026-12-07", startTime: "10:00", endTime: "12:00" };
  assert.equal(seriesFingerprint(bare), seriesFingerprint({ ...bare, weekdays: [], attendeeEmails: [], staffEmails: [] }));
});

test("series fingerprint: a shifted date range changes it, so the whole-series range is load-bearing", () => {
  // The bug this guards: computing firstDate from the reconcile window rather than the
  // whole series makes it walk forward as past weeks age out, changing the fingerprint
  // every week and re-notifying every attendee on every tick for the rest of term.
  assert.notEqual(seriesFingerprint(sbase), seriesFingerprint({ ...sbase, firstDate: "2026-09-21" }));
  assert.notEqual(seriesFingerprint(sbase), seriesFingerprint({ ...sbase, lastDate: "2026-11-30" }));
});

test("series fingerprint: a removed weekday changes it as surely as an added one", () => {
  assert.notEqual(seriesFingerprint(sbase), seriesFingerprint({ ...sbase, weekdays: ["monday"] }));
});

/* --------------------------------------------------------------------- the Team names -- */

test("truncateName clips to exactly the Graph limit, including at the boundary", () => {
  // Graph rejects a displayName over its limit outright, which fails the Team creation
  // for that cohort — so the boundary is the case that matters, not the comfortable middle.
  assert.equal(truncateName("x".repeat(120), 120).length, 120);
  assert.equal(truncateName("x".repeat(121), 120).length, 120);
  assert.equal(truncateName("x".repeat(119), 120).length, 119);
});

test("truncateName with a zero limit is empty; a NEGATIVE limit slices from the end", () => {
  // Characterisation, and a quirk worth having in writing. The implementation is
  // `s.length > max ? s.slice(0, max) : s`, and String.slice reads a negative index as
  // an offset from the end — so a limit of -5 returns "any" from "anything" rather than
  // the empty string an eye would predict. Unreachable today (both call sites pass
  // Graph's own constants, 120 and 50), so this is pinned rather than fixed: changing it
  // would be a change nothing asks for, but a future caller computing a limit could.
  assert.equal(truncateName("anything", 0), "");
  assert.equal(truncateName("anything", -5), "any");
});

test("truncateName trims before measuring, so trailing spaces never cost real characters", () => {
  assert.equal(truncateName("  HND Computing  ", 120), "HND Computing");
});

test("teamNameFor uses an em dash separator, which the channel limit test depends on", () => {
  assert.equal(teamNameFor({ name: "SEP 2025", course: { name: "HND Computing" } }), "HND Computing — SEP 2025");
});

test("teamNameFor copes with an empty cohort name without producing a dangling separator", () => {
  // Characterisation: with no cohort name the separator still appears. A cohort with no
  // name is a data fault, and a visibly odd Team name in the admin centre is a better
  // outcome than a crashed nightly provisioning run.
  const name = teamNameFor({ name: "", course: { name: "HND Computing" } });
  assert.equal(typeof name, "string");
  assert.ok(name.startsWith("HND Computing"));
});
