// Mitigating circumstances — the claim a college agreed to, and what it must never leak.
//
// The feature exists because TRIP_CHRONIC_LATE was live and the prediction layer had no
// idea an extension had ever been granted, so a college reported a student as chronically
// late for using an accommodation it had granted them itself.
//
// Two families of assertion, and the second matters more:
//
//   1. The decision actually changes the measurement. An approval must move a deadline
//      and a rejection must not.
//   2. WHAT NEVER LEAVES THE BUILDING. A claim is Article 9 health data — illness,
//      bereavement, mental health — collected so a college can support a student, not so
//      it can score one. It has its own permission, and the audit trail must record the
//      fact of a decision without ever recording the reason, because the audit log is
//      read on Settings by admins who were never granted this page.
//
// Weighted toward refusals on purpose, like the rest of scripts/.
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

let passed = 0, failed = 0;
const ok = (label, detail) => { passed++; console.log(`✓ ${label}${detail ? "  — " + detail : ""}`); };
const bad = (label, e) => { failed++; console.log(`✗ ${label}\n    ${e && e.message ? e.message : e}`); };
async function check(label, fn) {
  try { const d = await fn(); ok(label, d); } catch (e) { bad(label, e); }
}

const call = async (path, { method = "GET", body, token } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
};

console.log("\n=== mitigating circumstances ===\n");

const admin = await call("/auth/login", { method: "POST", body: { email: ADMIN, password: PASSWORD } });
if (!admin.body.token) {
  console.log("✗ could not sign in as the seeded admin — is the API seeded?");
  console.log(JSON.stringify(admin.body).slice(0, 200));
  process.exit(1);
}
const adminToken = admin.body.token;

// THE SUITE RUNS AS A WELFARE OFFICER, NOT AS THE FULL ADMIN, and the reason is the
// point of the feature. `mitigations` is explicit-grant-only: an admin whose pages were
// never configured — which the seeded HR administrator is — correctly gets 403, because
// Article 9 health data must not arrive with a deploy. So the route body is reachable
// only by somebody holding the page deliberately, which is exactly the arrangement the
// separate page exists to allow.
//
// BUILT HERE RATHER THAN SEEDED, and that is a lesson rather than a preference. The first
// version added this account to prisma/seed.js, which gave the college a SECOND admin —
// and smoke-account-deletion.mjs has a rule that only applies while there is one ("the
// last administrator cannot delete themselves"). That rule silently stopped applying, the
// suite went on to delete the shared admin account, and every suite after it failed
// against a dead API. A fixture in the shared seed is a change to every other suite.
const OFFICER_EMAIL = `mitig.officer.${Date.now()}@edtech.co.uk`;
const OFFICER_PW = "OfficerPass123!";

const made = await call("/staff", {
  method: "POST", token: adminToken,
  body: { name: "Mitigations Officer", email: OFFICER_EMAIL, password: OFFICER_PW },
});
if (!made.body || !made.body.id) {
  console.log("✗ could not create the welfare officer fixture");
  console.log(JSON.stringify(made.body).slice(0, 200));
  process.exit(1);
}
// The grant itself goes in directly: /staff/:id/access is Super Admin only and the
// seeded college has none, which is itself the realistic case.
await db.staff.update({
  where: { id: made.body.id },
  data: {
    accountRole: "ADMIN",
    adminPages: JSON.stringify(["mitigations", "students", "registers", "assessments", "staff", "prediction"]),
    mustChangePassword: false,
  },
});

const officer = await call("/auth/login", { method: "POST", body: { email: OFFICER_EMAIL, password: OFFICER_PW } });
if (!officer.body.token) {
  console.log("✗ could not sign in as the welfare officer fixture");
  process.exit(1);
}
const token = officer.body.token;

const students = await call("/hnd/students", { token });
const student = (students.body || [])[0];
if (!student) {
  // EXIT 2, NOT 0 — the runner maps only 2 to SKIP, so exit 0 reported this whole
  // health-data suite as PASS with none of it run. Article 9 data is what it covers.
  console.log("SKIP — no seeded students, so there is nobody to record a claim against");
  process.exit(2);
}

const created = [];

/* -------------------------------------------------------------------------- */
/* Who may reach it at all                                                     */
/* -------------------------------------------------------------------------- */

await check("an unauthenticated request is refused", async () => {
  const r = await call("/mitigations");
  assert.equal(r.status, 401);
  return "401";
});

/* -------------------------------------------------------------------------- */
/* What the route refuses                                                      */
/* -------------------------------------------------------------------------- */

await check("a claim with no student is refused", async () => {
  const r = await call("/mitigations", { token, method: "POST", body: { coversFrom: "2026-03-01", coversTo: "2026-03-10" } });
  assert.equal(r.status, 400);
  return r.body.error;
});

await check("a window that ends before it starts is refused", async () => {
  // A reversed window matches NOTHING — every comparison is `date >= from && date <= to`
  // — so it would be stored, shown as though it protected the student, and cover nobody.
  const r = await call("/mitigations", {
    token, method: "POST",
    body: { studentId: student.id, coversFrom: "2026-03-10", coversTo: "2026-03-01" },
  });
  assert.equal(r.status, 400);
  return r.body.error;
});

await check("an unbounded window is refused, because it would be a permanent suppression", async () => {
  // A claim suppresses signals for as long as it runs, so an open-ended one is
  // indistinguishable from taking the student off the risk register altogether.
  const r = await call("/mitigations", {
    token, method: "POST",
    body: { studentId: student.id, coversFrom: "2026-01-01", coversTo: "2027-12-31" },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /longest|days/i);
  return r.body.error.slice(0, 60);
});

await check("an unknown category is refused rather than stored verbatim", async () => {
  const r = await call("/mitigations", {
    token, method: "POST",
    body: { studentId: student.id, coversFrom: "2026-03-01", coversTo: "2026-03-10", category: "made-up" },
  });
  assert.equal(r.status, 400);
  return r.body.error;
});

/* -------------------------------------------------------------------------- */
/* The happy path, and what it defaults to                                     */
/* -------------------------------------------------------------------------- */

let claimId = null;
await check("a claim is created OPEN, not approved", async () => {
  // Nobody has decided anything yet, and the status must say so. An "approved" default
  // would let a claim work as a self-service score suppressant.
  const r = await call("/mitigations", {
    token, method: "POST",
    body: {
      studentId: student.id, coversFrom: "2026-03-01", coversTo: "2026-03-31",
      category: "illness", detail: "Hospital admission — private",
      raisedOn: "2026-02-25",
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, "open");
  assert.equal(r.body.coversAttendance, false, "attendance cover must be opt-in, never a default");
  claimId = r.body.id;
  created.push(claimId);
  return `id ${claimId}`;
});

await check("the date the STUDENT raised it is kept, not the date it was typed in", async () => {
  // The gap between the two is the college's own response time — the figure it is least
  // likely to record if this field silently defaults to today.
  const r = await call(`/mitigations/${claimId}`, { token });
  assert.equal(r.body.raisedOn, "2026-02-25");
  return r.body.raisedOn;
});

/* -------------------------------------------------------------------------- */
/* Adjustments                                                                 */
/* -------------------------------------------------------------------------- */

const assessments = await call("/assessments/overview", { token });
const anyAssessment = Array.isArray(assessments.body)
  ? assessments.body.flatMap((u) => u.assessments || [])[0]
  : null;

if (!anyAssessment) {
  console.log("SKIP — no assessments seeded, so an extension has nothing to move");
} else {
  await check("an extension that moves a deadline EARLIER is refused", async () => {
    // Accepting it would turn this table into a way of manufacturing lateness — the exact
    // harm the feature exists to undo, pointed the other way.
    if (!anyAssessment.dueDate) return "skipped, assessment has no due date";
    const r = await call(`/mitigations/${claimId}/adjustments`, {
      token, method: "POST",
      body: { assessmentId: anyAssessment.id, adjustmentType: "extension", revisedDueDate: "2020-01-01" },
    });
    assert.equal(r.status, 400);
    return r.body.error.slice(0, 60);
  });

  await check("an extension with no new deadline is refused", async () => {
    const r = await call(`/mitigations/${claimId}/adjustments`, {
      token, method: "POST",
      body: { assessmentId: anyAssessment.id, adjustmentType: "extension" },
    });
    assert.equal(r.status, 400);
    return r.body.error;
  });

  await check("an adjustment against an unknown assessment is refused", async () => {
    const r = await call(`/mitigations/${claimId}/adjustments`, {
      token, method: "POST",
      body: { assessmentId: "does-not-exist", adjustmentType: "exclusion" },
    });
    assert.equal(r.status, 404);
    return "404";
  });

  await check("one adjustment per assessment per claim", async () => {
    const body = { assessmentId: anyAssessment.id, adjustmentType: "exclusion" };
    const first = await call(`/mitigations/${claimId}/adjustments`, { token, method: "POST", body });
    assert.equal(first.status, 201);
    const second = await call(`/mitigations/${claimId}/adjustments`, { token, method: "POST", body });
    assert.equal(second.status, 409);
    return "409 on the duplicate";
  });
}

/* -------------------------------------------------------------------------- */
/* Deciding it                                                                 */
/* -------------------------------------------------------------------------- */

await check("approving stamps WHO decided and WHEN", async () => {
  // An approval with nobody's name on it cannot be explained to a student who asks why,
  // and this is exactly the record an appeal turns on.
  const r = await call(`/mitigations/${claimId}`, {
    token, method: "PATCH", body: { status: "approved", decisionNote: "Evidence seen." },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "approved");
  assert.ok(r.body.decidedOn, "no decision date");
  assert.ok(r.body.decidedBy, "no decider");
  return `${r.body.decidedOn} by ${r.body.decidedBy}`;
});

await check("reopening CLEARS the decision rather than leaving a stale approver on it", async () => {
  // A retraction that leaves the old fields in place is how a record comes to say two
  // contradictory things at once.
  const r = await call(`/mitigations/${claimId}`, { token, method: "PATCH", body: { status: "open" } });
  assert.equal(r.body.status, "open");
  assert.equal(r.body.decidedOn, null);
  assert.equal(r.body.decidedBy, null);
  return "decision cleared";
});

await check("an unknown status is refused", async () => {
  const r = await call(`/mitigations/${claimId}`, { token, method: "PATCH", body: { status: "maybe" } });
  assert.equal(r.status, 400);
  return r.body.error;
});

/* -------------------------------------------------------------------------- */
/* What never leaves the building                                              */
/* -------------------------------------------------------------------------- */

await check("the audit trail records the DECISION and never the reason", async () => {
  // The assertion this whole suite is really for. The audit log is read on Settings and
  // Staff by admins who were never granted the mitigations page, so a summary reading
  // "bereavement claim approved for J Smith" would route health data straight past the
  // access control this feature exists to apply.
  await call(`/mitigations/${claimId}`, { token, method: "PATCH", body: { status: "approved" } });
  // Read as the FULL ADMIN on purpose: the whole risk is that health data reaches the
  // audit log, which is read by admins who were never granted the mitigations page. This
  // reads it as exactly such a person.
  const log = await call("/audit?limit=100", { token: adminToken });
  const rows = log.body.entries || log.body.rows || log.body || [];
  const mine = (Array.isArray(rows) ? rows : []).filter((e) => (e.entityId === claimId) || (e.action || "").startsWith("mitigation."));
  assert.ok(mine.length, "no audit rows written for the claim at all");

  const blob = JSON.stringify(mine);
  assert.ok(!/illness/i.test(blob), "the audit trail contains the claim CATEGORY");
  assert.ok(!/Hospital admission/i.test(blob), "the audit trail contains the claim DETAIL");
  return `${mine.length} rows, no category or detail`;
});

await check("the prediction register never carries the reason for a claim", async () => {
  // The engine must know THAT a student has cover, never WHY. The server-side test reads
  // metrics.js as text; this one checks what actually reaches a browser.
  const r = await call("/prediction/students?limit=50", { token });
  const blob = JSON.stringify(r.body || {});
  assert.ok(!/"category"/.test(blob), "a category leaked into the prediction payload");
  assert.ok(!/Hospital admission/i.test(blob), "claim detail leaked into the prediction payload");
  return "no category, no detail";
});

/* -------------------------------------------------------------------------- */
/* Who may reach it — the assertions this suite existed without                */
/* -------------------------------------------------------------------------- */

await check("a member of staff without the page grant is refused", async () => {
  // This suite shipped asserting only that an anonymous caller gets 401, which proves
  // almost nothing about a page holding Article 9 health data. The sibling suite twelve
  // files away already had this exact pattern.
  const staff = await call("/staff", { token: adminToken });
  // GET /staff returns a BARE ARRAY, not { staff: [...] }. The original form of this
  // check read `staff.body.staff`, which is always undefined, so it took the skip branch
  // on every run — a security assertion that has never actually executed. Both shapes are
  // accepted here so the fix survives the response gaining an envelope later.
  const list = Array.isArray(staff.body) ? staff.body : staff.body.staff;
  if (staff.status !== 200 || !Array.isArray(list)) return "skipped — could not read the staff list";

  const plain = list.find((s) => s.accountRole !== "ADMIN" && !s.isSuperAdmin);
  if (!plain) return "skipped — no non-admin account in the fixtures";

  const login = await call("/auth/login", { method: "POST", body: { email: plain.email, password: PASSWORD } });
  if (!login.body.token) return `skipped — could not sign in as ${plain.email}`;

  const r = await call("/mitigations", { token: login.body.token });
  assert.equal(r.status, 403, `a member of staff without the grant got ${r.status} from the claims list`);
  return `${plain.email} refused`;
});

await check("an ADMIN whose pages were never configured is refused", async () => {
  // THE ONE THIS FEATURE MOST NEEDED. `adminPages: null` means "nobody has configured
  // grants here", and it grants every other page — correctly, so a college that never
  // touched the screen is not locked out. Under that rule, adding `mitigations` to
  // ADMIN_PAGES would have handed illness and bereavement records to every existing
  // admin at every such college the moment this deployed, decided by nobody.
  //
  // It is now explicit-grant-only, like `access`. A super admin still reaches it, so
  // there is always somebody who can grant it.
  const staff = await call("/staff", { token: adminToken });
  // GET /staff returns a BARE ARRAY, not { staff: [...] }. The original form of this
  // check read `staff.body.staff`, which is always undefined, so it took the skip branch
  // on every run — a security assertion that has never actually executed. Both shapes are
  // accepted here so the fix survives the response gaining an envelope later.
  const list = Array.isArray(staff.body) ? staff.body : staff.body.staff;
  if (staff.status !== 200 || !Array.isArray(list)) return "skipped — could not read the staff list";

  const unconfigured = list.find(
    (s) => s.accountRole === "ADMIN" && !s.isSuperAdmin && s.adminPages == null
      && s.email !== OFFICER_EMAIL
  );
  if (!unconfigured) return "skipped — no unconfigured admin in the fixtures";

  const login = await call("/auth/login", { method: "POST", body: { email: unconfigured.email, password: PASSWORD } });
  if (!login.body.token) return `skipped — could not sign in as ${unconfigured.email}`;

  const r = await call("/mitigations", { token: login.body.token });
  assert.equal(r.status, 403,
    `an admin with adminPages:null got ${r.status} — health data is being granted by default`);

  // And the same account must still hold an ordinary page, or the fix has locked people
  // out of the product rather than out of one screen.
  const ordinary = await call("/prediction/summary", { token: login.body.token });
  assert.equal(ordinary.status, 200, "the unconfigured admin lost access to ordinary pages too");
  return `${unconfigured.email} refused the claims, kept the register`;
});

// This replaces "a claim cannot be read across a tenant boundary", which fetched a real
// claim id with X-Tenant: does-not-exist and required 404/403. Half of what it proved is
// gone with tenancy — there is no second institution to read from. The OTHER half is not,
// and is the reason it was written: the claim id is a cuid, and the route must not be
// leaning on that. An unguessable id is not an access control, and this is the route that
// serves a single claim by id — the shape most likely to be mounted outside the guard,
// because the guard is usually thought about for the list.
//
// The unauthenticated assertion near the top of this suite covers GET /mitigations, the
// LIST. It says nothing about /mitigations/:id, which is a separate handler.
await check("a single claim by id is behind the guard, not behind an unguessable id", async () => {
  if (!claimId) return "skipped — no claim was created";
  const r = await call(`/mitigations/${claimId}`);
  assert.equal(r.status, 401,
    `an anonymous caller holding a claim id got ${r.status} — the id is being treated as the secret`);
  return "401 with no token, holding a real claim id";
});

/* -------------------------------------------------------------------------- */
/* Tidy up                                                                     */
/* -------------------------------------------------------------------------- */

for (const id of created) {
  await call(`/mitigations/${id}`, { token, method: "DELETE" });
}



await check("a deleted claim is gone", async () => {
  const r = await call(`/mitigations/${claimId}`, { token });
  assert.equal(r.status, 404);
  return "404";
});

// The officer goes LAST, after every assertion that uses its token. Deleting it earlier
// made the final check answer 401 instead of 404 — the fixture outliving the suite is not
// optional. Leaving it behind is what broke smoke-account-deletion.mjs the first time
// this fixture existed, so it must go, just not yet.
await db.staff.deleteMany({ where: { email: OFFICER_EMAIL } });
await db.$disconnect();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
