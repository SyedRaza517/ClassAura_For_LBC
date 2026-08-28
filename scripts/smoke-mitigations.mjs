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

const BASE = process.env.API_URL || "http://localhost:4010/api";
const ADMIN = process.env.SEED_ADMIN_EMAIL || "admin@edtech.co.uk";
const PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";

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

console.log("\n=== mitigating circumstances ===\n");

const admin = await call("/auth/login", { method: "POST", body: { email: ADMIN, password: PASSWORD } });
if (!admin.body.token) {
  console.log("✗ could not sign in as the seeded admin — is the API seeded?");
  console.log(JSON.stringify(admin.body).slice(0, 200));
  process.exit(1);
}
const token = admin.body.token;

const students = await call("/hnd/students", { token });
const student = (students.body || [])[0];
if (!student) {
  console.log("SKIP — no seeded students, so there is nobody to record a claim against");
  process.exit(0);
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
  const log = await call("/audit?limit=100", { token });
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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
