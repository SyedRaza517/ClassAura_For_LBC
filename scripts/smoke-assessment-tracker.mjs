// The assessment tracker — and the empty table it must never read as a zero.
//
// The feature reports on work that is already in the database, but the one figure
// everybody asks for first — the submission rate — has NO DATA SOURCE YET.
// AssessmentSubmission is read by the prediction engine and written by nothing. So the
// assertions here are weighted toward what must NOT appear:
//
//   1. A submission rate of null, ON THE WIRE, when nothing has been synced. A 0 there
//      would put every module in the college on a watchlist for something nobody has
//      measured.
//   2. `marked` a real number in the SAME response — proving the null above is a
//      measurement decision and not a broken query.
//   3. A tracker-only admin can set a leader and a marking deadline, and CANNOT read
//      the gradebook, delete a unit or reach the rest of the HND surface. Two narrow
//      doors were added rather than widening two gates that guard far more; if a later
//      edit widens them after all, these are what say so.
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const require = createRequire(pathToFileURL(join(ROOT, "server", "package.json")));
const { PrismaClient } = require(`${ROOT}/server/node_modules/@prisma/client`);
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required — point it at a throwaway database."); process.exit(1); }
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const BASE = process.env.API_URL || "http://localhost:4010/api";
const ADMIN = process.env.SEED_ADMIN_EMAIL || "admin@edtech.co.uk";
const PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";
const TRACKER_EMAIL = "tracker.officer@edtech.co.uk";
const TRACKER_PW = "tracker-officer-2026";
const OUTSIDER_EMAIL = "no.tracker@edtech.co.uk";
const OUTSIDER_PW = "no-tracker-2026";

let passed = 0, failed = 0;
const ok = (label, detail) => { passed++; console.log(`✓ ${label}${detail ? "  — " + detail : ""}`); };
const bad = (label, e) => { failed++; console.log(`✗ ${label}\n    ${e && e.message ? e.message : e}`); };
async function check(label, fn) {
  try { const d = await fn(); ok(label, d); } catch (e) { bad(label, e); }
}
const call = async (path, { method = "GET", body, token, tenant } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  if (tenant) headers["X-Tenant"] = tenant;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
};

// Create a staff account and grant it exactly `pages`. The grant goes in directly
// because /staff/:id/access is Super Admin only and the seeded college has none —
// itself the realistic case.
async function adminWithPages(name, email, password, pages) {
  const made = await call("/staff", { method: "POST", token: adminToken, body: { name, email, password } });
  const id = made.body?.id || (await db.staff.findFirst({ where: { email }, select: { id: true } }))?.id;
  if (!id) return null;
  await db.staff.update({
    where: { id },
    data: { accountRole: "ADMIN", adminPages: JSON.stringify(pages), mustChangePassword: false },
  });
  const login = await call("/auth/login", { method: "POST", body: { email, password } });
  return login.body?.token ? { id, token: login.body.token } : null;
}

console.log("\n=== assessment tracker ===\n");

const admin = await call("/auth/login", { method: "POST", body: { email: ADMIN, password: PASSWORD } });
if (!admin.body.token) {
  console.log("✗ could not sign in as the seeded admin — is the API seeded?");
  console.log(JSON.stringify(admin.body).slice(0, 200));
  process.exit(1);
}
const adminToken = admin.body.token;

const officer = await adminWithPages("Tracker Officer", TRACKER_EMAIL, TRACKER_PW, ["assessment-tracker"]);
if (!officer) { console.log("✗ could not create the tracker officer fixture"); process.exit(1); }
const { id: officerId, token } = officer;

// THE SEED CREATES UNITS, STUDENTS AND ENROLMENTS BUT NO ASSESSMENTS, so this suite
// makes its own. Skipping instead would be worse than useless: every assertion below
// is about an assessment, so an all-skip run would report PASS while discriminating
// nothing at all — and PASS is meant to mean something here.
//
// It is created on a unit that HAS enrolments, because a submission rate with a zero
// denominator is null for a second, uninteresting reason, and that would mask the
// null this suite exists to check.
const seedUnit = await db.enrolment.groupBy({ by: ["unitId"], _count: { _all: true }, orderBy: { _count: { unitId: "desc" } }, take: 1 });
if (!seedUnit.length) { console.log("SKIP — the seed produced no enrolments, so no cohort exists to measure"); process.exit(0); }
const fixtureUnitId = seedUnit[0].unitId;
const madeAssessment = await call("/assessments", {
  method: "POST", token: adminToken,
  body: { unitId: fixtureUnitId, title: "Tracker fixture assignment", type: "Assignment", maxMarks: 100, weight: 40, dueDate: "2026-11-15" },
});
if (madeAssessment.status !== 201) {
  console.log(`✗ could not create the fixture assessment (${madeAssessment.status}) — ${JSON.stringify(madeAssessment.body).slice(0, 200)}`);
  process.exit(1);
}

const tracker = await call("/assessment-tracker", { token });
if (tracker.status !== 200) {
  console.log(`✗ the tracker refused its own admin (${tracker.status}) — ${JSON.stringify(tracker.body).slice(0, 200)}`);
  process.exit(1);
}
// Narrowed to the fixture: the tracker returns every assessment in the college, and
// asserting over rows this suite did not create would make it pass or fail on whatever
// the last run happened to leave behind.
const allRows = tracker.body?.rows || [];
const rows = allRows.filter((r) => r.assessmentId === madeAssessment.body.id);
if (!rows.length) {
  console.log("✗ the fixture assessment was created but does not appear on the tracker");
  process.exit(1);
}

const submissionRows = await db.assessmentSubmission.count();

/* ---------------- the null that matters ---------------- */

await check("submission rate is null, not 0, while nothing has been synced", () => {
  if (submissionRows > 0) return "skipped — this database has submission rows";
  const zeroed = rows.filter((r) => r.submissionRate === 0);
  assert.equal(zeroed.length, 0,
    `${zeroed.length} row(s) report a 0% submission rate with no submission data — a college-wide crisis manufactured from a missing integration`);
  assert.equal(rows.every((r) => r.submissionRate === null), true, "every row should report null");
  return `${rows.length} row(s), all null`;
});

await check("submitted is null and NOT 0 in the same rows", () => {
  if (submissionRows > 0) return "skipped — this database has submission rows";
  assert.equal(rows.every((r) => r.submitted === null), true);
  return "null throughout";
});

await check("marked is a real number in the same response", () => {
  // Proves the nulls above are a measurement decision and not a broken query.
  assert.equal(rows.every((r) => typeof r.marked === "number"), true, "marked should be a number on every row");
  return `e.g. ${rows[0].marked} marked of ${rows[0].enrolled} enrolled`;
});

await check("coverage is measurable even though the marking rate is not", () => {
  const withCohort = rows.filter((r) => r.enrolled > 0);
  if (!withCohort.length) return "skipped — no enrolled cohorts seeded";
  assert.equal(withCohort.every((r) => typeof r.coverageRate === "number"), true, "coverage should be a number wherever anyone is enrolled");
  if (submissionRows === 0) {
    assert.equal(withCohort.every((r) => r.markingRate === null), true,
      "the marking rate needs a submitted denominator and must be null without one");
  }
  return "coverage real, marking rate null";
});

await check("the marking state is never 'overdue' while submissions are unknown", () => {
  if (submissionRows > 0) return "skipped — this database has submission rows";
  const accused = rows.filter((r) => r.markingState === "overdue");
  assert.equal(accused.length, 0,
    `${accused.length} row(s) accuse a module leader of a marking backlog with no submission data to establish one`);
  return "none accused";
});

await check("recordsSubmissions reports the institution, not the page", () => {
  assert.equal(typeof tracker.body.recordsSubmissions, "boolean");
  assert.equal(tracker.body.recordsSubmissions, submissionRows > 0);
  return String(tracker.body.recordsSubmissions);
});

/* ---------------- refusals ---------------- */

const outsider = await adminWithPages("No Tracker", OUTSIDER_EMAIL, OUTSIDER_PW, ["timesheets"]);

await check("an admin without the page is refused both endpoints", async () => {
  if (!outsider) throw new Error("could not create the outsider fixture");
  const r = await call("/assessment-tracker", { token: outsider.token });
  assert.equal(r.status, 403, `tracker expected 403, got ${r.status}`);
  const s = await call("/assessment-tracker/setup", { token: outsider.token });
  assert.equal(s.status, 403, `setup expected 403, got ${s.status}`);
  return "403 on both";
});

await check("no token at all is refused", async () => {
  const r = await call("/assessment-tracker");
  assert.equal(r.status, 401, `expected 401, got ${r.status}`);
  return "401";
});

await check("a tracker-only admin still cannot read the gradebook", async () => {
  // The narrow door must not have become a wide one: student marks are sensitive and
  // this admin was never granted them.
  const r = await call(`/assessments/${rows[0].assessmentId}/grades`, { token });
  assert.equal(r.status, 403, `expected 403, got ${r.status} — a tracker admin is reading student marks`);
  return "403";
});

await check("a tracker-only admin cannot reach the rest of the HND surface", async () => {
  // The leader door was added rather than widening requireRegisters, which also gates
  // DELETE /units/:id. If somebody widens it later, this is what says so.
  const r = await call("/hnd/students", { token });
  assert.equal(r.status, 403, `expected 403 on the student directory, got ${r.status}`);
  return "403 on /hnd/students";
});

await check("a tracker-only admin cannot delete a unit", async () => {
  const r = await call(`/hnd/units/${rows[0].unitId}`, { method: "DELETE", token });
  assert.equal(r.status, 403, `expected 403, got ${r.status} — the tracker can delete units and cascade away their marks`);
  const still = await db.unit.findUnique({ where: { id: rows[0].unitId }, select: { id: true } });
  assert.ok(still, "the unit was deleted");
  return "403, unit intact";
});

/* ---------------- the two saves ---------------- */

await check("a tracker-only admin can set a module leader", async () => {
  const r = await call(`/hnd/units/${rows[0].unitId}/leader`, { method: "PUT", token, body: { leaderStaffId: officerId } });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  const after = await db.unit.findUnique({ where: { id: rows[0].unitId }, select: { leaderStaffId: true } });
  assert.equal(after.leaderStaffId, officerId);
  return "saved and read back";
});

await check("an empty leader clears the field rather than failing", async () => {
  const r = await call(`/hnd/units/${rows[0].unitId}/leader`, { method: "PUT", token, body: { leaderStaffId: "" } });
  assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  const after = await db.unit.findUnique({ where: { id: rows[0].unitId }, select: { leaderStaffId: true } });
  assert.equal(after.leaderStaffId, null);
  // Put it back so the tracker row below has a leader to report.
  await call(`/hnd/units/${rows[0].unitId}/leader`, { method: "PUT", token, body: { leaderStaffId: officerId } });
  return "cleared to null";
});

await check("an unknown staff id is refused as a module leader", async () => {
  const r = await call(`/hnd/units/${rows[0].unitId}/leader`, { method: "PUT", token, body: { leaderStaffId: "not-a-real-staff-id" } });
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  return "400";
});

await check("the leader door cannot rename a unit or move its deadline", async () => {
  const before = await db.unit.findUnique({ where: { id: rows[0].unitId }, select: { code: true, name: true, submissionDate: true, tutorStaffId: true } });
  await call(`/hnd/units/${rows[0].unitId}/leader`, {
    method: "PUT", token,
    body: { leaderStaffId: officerId, code: "HACKED", name: "Renamed by the tracker", submissionDate: "2031-01-01", tutorStaffId: officerId },
  });
  const after = await db.unit.findUnique({ where: { id: rows[0].unitId }, select: { code: true, name: true, submissionDate: true, tutorStaffId: true } });
  assert.deepEqual(after, before, "the narrow door wrote a field it should not accept");
  return "code, name, submissionDate and tutor unchanged";
});

await check("a tracker-only admin can set a marking deadline", async () => {
  const r = await call(`/assessments/${rows[0].assessmentId}/marking-deadline`, { method: "PUT", token, body: { markingDueDate: "2026-12-01" } });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  const after = await db.assessment.findUnique({ where: { id: rows[0].assessmentId }, select: { markingDueDate: true } });
  assert.equal(after.markingDueDate, "2026-12-01");
  return "saved and read back";
});

await check("a malformed marking deadline is refused", async () => {
  const r = await call(`/assessments/${rows[0].assessmentId}/marking-deadline`, { method: "PUT", token, body: { markingDueDate: "1st December" } });
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  return "400";
});

await check("the marking-deadline door cannot touch marks or weighting", async () => {
  const before = await db.assessment.findUnique({ where: { id: rows[0].assessmentId }, select: { maxMarks: true, weight: true, title: true, unitId: true } });
  await call(`/assessments/${rows[0].assessmentId}/marking-deadline`, {
    method: "PUT", token,
    body: { markingDueDate: "2026-12-02", maxMarks: 7, weight: 99, title: "Renamed by the tracker" },
  });
  const after = await db.assessment.findUnique({ where: { id: rows[0].assessmentId }, select: { maxMarks: true, weight: true, title: true, unitId: true } });
  assert.deepEqual(after, before, "the narrow door wrote a field it should not accept");
  return "maxMarks, weight, title and unitId unchanged";
});

await check("the saved leader and deadline come back on the tracker row", async () => {
  const again = await call("/assessment-tracker", { token });
  const row = (again.body?.rows || []).find((r) => r.assessmentId === rows[0].assessmentId);
  assert.ok(row, "the assessment vanished from the tracker");
  assert.equal(row.leaderStaffId, officerId);
  assert.equal(row.markingDueDate, "2026-12-02");
  return `leader ${row.leaderName}, marking deadline ${row.markingDueDate}`;
});

/* ---------------- tenant isolation ---------------- */

await check("a unit from another college never appears", async () => {
  const mineTenant = (await db.staff.findUnique({ where: { id: officerId }, select: { tenantId: true } })).tenantId;
  const theirs = await db.unit.findMany({ where: { tenantId: { not: mineTenant } }, select: { id: true } });
  if (!theirs.length) return "skipped — only one college seeded";
  const visible = new Set(((await call("/assessment-tracker", { token })).body?.rows || []).map((r) => r.unitId));
  const leaked = theirs.filter((u) => visible.has(u.id));
  assert.equal(leaked.length, 0, `${leaked.length} unit(s) from another college appeared`);
  const setupVisible = new Set(((await call("/assessment-tracker/setup", { token })).body?.modules || []).map((m) => m.unitId));
  const leakedSetup = theirs.filter((u) => setupVisible.has(u.id));
  assert.equal(leakedSetup.length, 0, `${leakedSetup.length} unit(s) from another college appeared on the setup grid`);
  return `${theirs.length} foreign unit(s), none visible on either screen`;
});

/* ---------------- cleanup ---------------- */
//
// NOT optional tidiness. The fixture assessment is created on the unit with the most
// enrolments, which is a unit the seeded student is on — and smoke-studentportal
// asserts an EXACT assessment count for that student. Leaving the fixture behind made
// that suite fail while passing in isolation, which is the most expensive kind of test
// failure to diagnose: the suite that breaks is not the suite that is wrong.
//
// Done in a finally-shaped block rather than inside a check(), so a failed assertion
// above still leaves the database as it was found.
try {
  await db.assessment.delete({ where: { id: madeAssessment.body.id } });
  await db.unit.update({ where: { id: fixtureUnitId }, data: { leaderStaffId: null } });
  await db.staff.deleteMany({ where: { email: { in: [TRACKER_EMAIL, OUTSIDER_EMAIL] } } });
  console.log("\ncleanup: fixture assessment, module leader and both admin fixtures removed");
} catch (e) {
  // Reported, never thrown: a cleanup failure must not turn a green suite red, but it
  // must not be silent either — the next suite in the run is the one that will suffer.
  console.log(`\n! cleanup incomplete — ${e.message}`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
