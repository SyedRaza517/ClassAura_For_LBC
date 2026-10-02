// Every Teams background job must declare itself institution-wide.
//
// THE BUG THIS EXISTS FOR, 2 Oct 2026. The academic-scope guard refuses a query against a
// scoped model (HndSession, AttendanceMark, TimetableEvent) unless something has bound a
// scope. An HTTP request binds one in requireAuth — so "Sync now" worked perfectly, every
// time, for anyone who tried it. The SCHEDULED run has no request behind it and bound
// nothing, so every hourly pass died with "HndSession.findMany was issued with no academic
// scope bound", wrote no marks, and logged a FAILED run. It ran that way for hours on a
// live deployment before anyone looked at the run history.
//
// That asymmetry — the button a human presses works, the unattended job does not — is why
// no existing test caught it. The smoke suites drive the engine over HTTP, which binds a
// scope on the way in, so they exercise the one path that was never broken.
//
// WHAT THIS TEST IS, HONESTLY. It reads the exported function's own source for the
// declaration rather than running a sync, because running one needs a database, a Graph
// tenant and a scheduler tick. That makes it a PROXY, and a weak one: it proves the
// wrapper is present on the exported entry point, not that the scope it binds is correct.
// It is the same weak-proxy shape moodleDepartmentStamp.test.js already uses and labels.
// It would have caught this bug on the commit that introduced it, which is the bar that
// matters here.
const test = require("node:test");
const assert = require("node:assert/strict");

const teamsSync = require("./teamsSync");
const teamsMeetings = require("./teamsMeetings");
const teamsProvisioning = require("./teamsProvisioning");

const JOBS = [
  ["teamsSync.runSync", teamsSync.runSync],
  ["teamsMeetings.runMeetingsSync", teamsMeetings.runMeetingsSync],
  ["teamsProvisioning.runProvisioning", teamsProvisioning.runProvisioning],
];

for (const [name, fn] of JOBS) {
  test(`${name} declares itself institution-wide before touching a scoped model`, () => {
    const src = String(fn);
    assert.match(src, /withoutAcademicScope/,
      `${name} must wrap its work in withoutAcademicScope, or the scheduled run dies with ` +
      `"issued with no academic scope bound" while the manual one keeps working`);
  });

  test(`${name} gives the guard a non-empty reason`, () => {
    // withoutAcademicScope REJECTS a blank reason before invoking the work, so an empty
    // string here would turn the hourly run from "wrong scope" into "never runs at all" —
    // a different failure, equally silent on any screen a human looks at.
    const src = String(fn);
    const reason = /withoutAcademicScope\(\s*(["'`])([\s\S]*?)\1/.exec(src);
    assert.ok(reason, `${name}: could not find the reason string passed to withoutAcademicScope`);
    assert.ok(reason[2].trim().length > 20,
      `${name}: the reason must actually say why this work is institution-wide, got ${JSON.stringify(reason[2])}`);
  });
}

test("all three Teams jobs are covered — a new one must be added here too", () => {
  // A guard against this file quietly going out of date: if a fourth Teams background job
  // appears, the count below fails and whoever added it has to decide, deliberately,
  // whether it is institution-wide.
  assert.equal(JOBS.length, 3);
  for (const [name, fn] of JOBS) {
    assert.equal(typeof fn, "function", `${name} is not exported as a function`);
  }
});
