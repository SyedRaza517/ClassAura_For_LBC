// Progression risk — the scores, the rules that override them, and who may read them.
//
// This feature decides which named students a college is told to worry about, so the
// assertions here are mostly about what a WRONG answer would do to a person:
//
//   - A student nobody has measured must not be scored. Scoring an absence of
//     evidence as zero would put every newly-enrolled student at the top of the
//     Critical Risk list, and staff would go and intervene with students who are fine.
//   - A score and the band shown beside it must never disagree. "High Risk (82)" is a
//     record nobody can act on and everybody stops believing.
//   - A configuration that cannot be honoured must be refused, not stored. Weights
//     totalling 90% deflate every student in the college by the same 10% invisibly;
//     an override naming a band that does not exist is a rule that appears on the
//     settings screen and never fires for anybody.
//   - The register is not a statistic. It is a list of named students judged likely
//     to fail, and a member of staff without the page grant must not reach it.
//
// The engine's arithmetic is covered by unit tests (server/src/prediction/*.test.js),
// which run with no database. This suite covers the parts those cannot: the HTTP
// surface, the guards, and the round trip through Postgres.
import { strict as assert } from "node:assert";
import { collegeWideReader } from "./lib/college-wide-reader.mjs";

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

console.log("\n=== predictive analysis (progression risk) ===\n");

const admin = await call("/auth/login", { method: "POST", body: { email: ADMIN, password: PASSWORD } });
if (!admin.body.token) {
  console.log("✗ could not sign in as the seeded admin — is the API seeded?");
  console.log(JSON.stringify(admin.body).slice(0, 200));
  process.exit(1);
}
const token = admin.body.token;

const getSettings = () => call("/prediction/settings", { token });
const putSettings = (config) => call("/prediction/settings", { method: "PUT", token, body: { config } });
const resetSettings = () => call("/prediction/settings", { method: "DELETE", token });

// Start from a known state, and put it back at the end.
await resetSettings();
const base = (await getSettings()).body.config;

/* ------------------------------------------------- the model a college runs on --- */

await check("a college that has configured nothing runs on the platform defaults", async () => {
  const r = await getSettings();
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.customised, false, "a college that has saved nothing must not be reported as customised");
  const w = r.body.config.weights;
  const sum = Object.values(w).reduce((t, n) => t + n, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `the default weights must total 1, got ${sum}`);
  assert.equal(r.body.config.bands.length, 5, "five default bands");
  return `${Object.keys(w).length} components, ${r.body.config.bands.length} bands`;
});

await check("the settings carry the vocabulary the screen needs, so codes are not duplicated in the client", async () => {
  const r = await getSettings();
  assert.ok(Array.isArray(r.body.vocabulary.redCodes), "redCodes must be served");
  assert.equal(r.body.vocabulary.redCodes.length, 6,
    `there must be exactly six red indicators or the OVR-004 threshold ceiling is wrong; got ${r.body.vocabulary.redCodes.length}`);
  return r.body.vocabulary.redCodes.length + " red indicators";
});

/* --------------------------------------------- configurations that must be refused --- */

await check("weights that do not total 100% are refused, and the message says what it would do", async () => {
  const r = await putSettings({ ...base, weights: { ...base.weights, averageGrade: 0.15 } });
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  assert.match(r.body.error, /total/i, r.body.error);
  assert.match(r.body.error, /0\.9|90%/, `the error must name the actual total: ${r.body.error}`);
  return "refused";
});

await check("a gap in the bands is refused — a student landing in it would be silently skipped", async () => {
  const bands = base.bands.map((b) => (b.key === "R3" ? { ...b, max: 65 } : b));
  const r = await putSettings({ ...base, bands });
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  assert.match(r.body.error, /gap/i, r.body.error);
  return "refused";
});

await check("an overlap in the bands is refused — a risk level must not depend on array order", async () => {
  const bands = base.bands.map((b) => (b.key === "R2" ? { ...b, max: 90 } : b));
  const r = await putSettings({ ...base, bands });
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  assert.match(r.body.error, /overlap/i, r.body.error);
  return "refused";
});

await check("a ladder that stops short of 0 is refused — it loses the student it matters most to find", async () => {
  const bands = base.bands.map((b) => (b.key === "R5" ? { ...b, min: 10 } : b));
  const r = await putSettings({ ...base, bands });
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  return "refused";
});

await check("an override naming a band that does not exist is refused, not stored as a dead rule", async () => {
  const r = await putSettings({ ...base, missingOverrideBand: "R9" });
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  assert.match(r.body.error, /R9/, r.body.error);
  return "refused";
});

await check("a setting nothing reads is refused rather than dropped", async () => {
  // Dropping is worse than refusing: the save succeeds, the administrator believes
  // the setting is live, and nothing honours it.
  const r = await putSettings({ ...base, enableTelepathy: true });
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  assert.match(r.body.error, /enableTelepathy/, r.body.error);
  return "refused";
});

await check("a save with no settings in it is refused, not treated as 'reset to defaults'", async () => {
  // validate(undefined) legitimately means "the platform defaults" inside the
  // resolver — that is what a college with no stored row runs on. Arriving over HTTP
  // it would mean a truncated request body silently replaced a college's own model
  // and marked every score in the institution stale, answering 200.
  await putSettings({ ...base, passThreshold: 45 });          // give the college something to lose
  const r = await call("/prediction/settings", { method: "PUT", token, body: {} });
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);

  const back = await getSettings();
  assert.equal(back.body.config.passThreshold, 45, "the college's saved model must survive a malformed save");
  await resetSettings();
  return "refused, model intact";
});

await check("a valid change is stored, and marks the college's scores for recalculation", async () => {
  const r = await putSettings({ ...base, passThreshold: 45 });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.config.passThreshold, 45);
  assert.equal(typeof r.body.staleCount, "number", "the response must say how many scores are now out of date");

  const back = await getSettings();
  assert.equal(back.body.config.passThreshold, 45, "the change must survive the round trip");
  assert.equal(back.body.customised, true, "a college that has saved something is customised");
  return "saved and re-read";
});

await check("resetting returns the college to the platform defaults", async () => {
  const r = await resetSettings();
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  const back = await getSettings();
  assert.equal(back.body.config.passThreshold, base.passThreshold, "the pass mark must be back to the default");
  assert.equal(back.body.customised, false);
  return "reset";
});

/* ----------------------------------------------------------------- scoring --- */

await check("recalculating reports what it did rather than claiming success", async () => {
  const r = await call("/prediction/recalculate", { method: "POST", token, body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.equal(typeof r.body.scored, "number", "the run must say how many students it scored");
  assert.equal(typeof r.body.insufficientData, "number",
    "the run must say how many students it could NOT score — a silent skip is how a cohort goes missing");
  return `scored ${r.body.scored}, ${r.body.insufficientData} with too little data`;
});

await check("a student with nothing measurable is NOT scored, rather than scored at zero", async () => {
  const r = await call("/prediction/students", { token });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));

  // Whatever the fixtures contain, no stored row may be a fabricated zero across the
  // board — that is the shape "unmeasurable was treated as absent" would take.
  for (const s of r.body.students) {
    const allZero = s.overallAttendance === 0 && s.submissionRate === 0 && s.averageGrade === 0 && s.missingAssessmentCount === 0;
    assert.ok(!allZero,
      `${s.student.studentRef} is stored as zero on every measure with nothing missing — an unmeasurable student has been scored as a failing one`);
  }
  return `${r.body.students.length} scored student(s) checked`;
});

await check("every stored score falls inside the band stored beside it", async () => {
  const cfg = (await getSettings()).body.config;
  const r = await call("/prediction/students", { token });

  for (const s of r.body.students) {
    const band = cfg.bands.find((b) => s.progressionScore >= b.min);
    assert.ok(band, `${s.student.studentRef} scored ${s.progressionScore}, which falls in no band at all`);
    assert.equal(band.key, s.riskLevel,
      `${s.student.studentRef} scored ${s.progressionScore} (reads as ${band.key}) but is recorded as ${s.riskLevel}`);
  }
  return `${r.body.students.length} row(s) consistent`;
});

await check("a score that an override moved keeps the untouched arithmetic beside it", async () => {
  const r = await call("/prediction/students", { token });
  const overridden = r.body.students.filter((s) => s.overrideApplied);

  for (const s of overridden) {
    assert.ok(s.baseRiskLevel, "an overridden row must keep the band the maths produced");
    assert.ok(Array.isArray(s.overrideCodes) && s.overrideCodes.length,
      `${s.student.studentRef} is marked as overridden but names no rule — nobody could explain the score`);
    assert.ok(s.progressionScore <= s.baseProgressionScore,
      `an override moved ${s.student.studentRef} UP, from ${s.baseProgressionScore} to ${s.progressionScore}`);
  }
  return `${overridden.length} overridden row(s)`;
});

await check("the summary distinguishes 'not scored' from 'not at risk'", async () => {
  const r = await call("/prediction/summary", { token });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(typeof r.body.notScored, "number",
    "the screen must be able to say a student has no score, rather than implying they are safe");
  assert.equal(r.body.scored + r.body.notScored, r.body.activeStudents,
    `scored (${r.body.scored}) + not scored (${r.body.notScored}) must account for every active student (${r.body.activeStudents})`);
  assert.ok(Array.isArray(r.body.bands), "every band must be listed, including the empty ones");
  return `${r.body.scored} scored, ${r.body.notScored} not scored`;
});

await check("a band with nobody in it is still reported, so the ladder does not look shorter than it is", async () => {
  const r = await call("/prediction/summary", { token });
  const cfg = (await getSettings()).body.config;
  assert.equal(r.body.bands.length, cfg.bands.length, "every configured band must appear in the summary");
  return `${r.body.bands.length} bands`;
});

/* ------------------------------------------------------------ interventions --- */

let createdInterventionId = null;
let subjectRef = null;
let subjectSurname = null;

await check("an intervention snapshots the student's figures as they are now", async () => {
  const list = await call("/prediction/students", { token });
  const subject = list.body.students[0];
  if (!subject) return "skipped — no scored students in the fixtures";
  subjectRef = subject.student.studentRef;
  subjectSurname = subject.student.lastName;

  const r = await call("/prediction/interventions", {
    method: "POST", token,
    body: { studentId: subject.student.id, interventionType: "tutorial", notes: "smoke-prediction test" },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 300));
  createdInterventionId = r.body.intervention.id;

  assert.equal(r.body.intervention.riskLevelAtIntervention, subject.riskLevel,
    "the risk level at the time must be copied onto the record, not read back later");
  assert.equal(r.body.intervention.progressionScoreAtIntervention, subject.progressionScore);
  return `snapshotted at ${subject.riskLevel} / ${subject.progressionScore}`;
});

/**
 * Assert nothing in the audit trail names the student or carries their notes.
 *
 * A FUNCTION, because it has to run TWICE. The first version ran only after the
 * create, and at that point the update row does not exist yet — so restoring
 * `before: existing, after: updated` would have left this suite green, and that was
 * the more severe half of the leak: up to 500 characters of pastoral free text per
 * side, against a surname in a summary.
 */
async function assertAuditCarriesNoCaseload(when) {
  // THE AUDIT TRAIL IS COLLEGE-WIDE ONLY since 28 Sep 2026, so this assertion needs a
  // college-wide reader to keep running in the scoped pass, where every seeded account is
  // narrowed. In the ordinary pass this IS the caller's own token and nothing is created.
  // See lib/college-wide-reader.mjs for why the assertion is worth the helper.
  const reader = await collegeWideReader({ call, token, label: "pred" });
  const r = await call("/audit?entity=Intervention&take=50", { token: reader.token });
  await reader.dispose();
  assert.equal(r.status, 200, `the audit trail should be readable by the seeded admin; got HTTP ${r.status}`);

  const rows = (r.body.entries || []).filter((e) => e.entityId === createdInterventionId);
  assert.ok(rows.length, `${when}: the intervention should appear in the trail`);

  const blob = JSON.stringify(rows);
  assert.equal(blob.includes("smoke-prediction test"), false,
    `${when}: an intervention's free-text notes must not reach the audit trail`);
  if (subjectSurname) {
    assert.equal(blob.includes(subjectSurname), false,
      `${when}: the trail names "${subjectSurname}" beside an intervention type, which is exactly the disclosure requirePage("prediction") withholds`);
  }
  return rows.length;
}

await check("the audit trail does not become a less-guarded copy of the caseload", async () => {
  // The disclosure this router exists to control is "which named students is the
  // college worried about". It is gated on requirePage("prediction") for that reason.
  //
  // The audit trail is read under AUDIT_PAGES — settings, access, staff — which is a
  // DIFFERENT and disjoint grant. So anything written there is readable by an
  // administrator this page refuses, and a summary naming a student beside
  // "welfare_referral", or a before/after carrying free-text pastoral notes, hands
  // over exactly what the gate withholds.
  //
  // Found by a security review on 25 Aug 2026: both were happening.
  if (!createdInterventionId) return "skipped — nothing was created";
  const n = await assertAuditCarriesNoCaseload("after create");
  return `${n} audit row(s) after create: no notes, no student name`;
});

await check("an intervention type nobody implemented is refused", async () => {
  const list = await call("/prediction/students", { token });
  const subject = list.body.students[0];
  if (!subject) return "skipped — no scored students in the fixtures";

  const r = await call("/prediction/interventions", {
    method: "POST", token,
    body: { studentId: subject.student.id, interventionType: "hoping_for_the_best" },
  });
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  return "refused";
});

await check("an intervention for a student who does not exist is a 404, not a stray row", async () => {
  const r = await call("/prediction/interventions", {
    method: "POST", token,
    body: { studentId: "no-such-student-id", interventionType: "tutorial" },
  });
  assert.equal(r.status, 404, `expected 404, got ${r.status}`);
  return "refused";
});

await check("reviewing an intervention records the outcome without rewriting the baseline", async () => {
  if (!createdInterventionId) return "skipped — nothing was created";
  const before = await call("/prediction/interventions", { token, });
  const original = before.body.interventions.find((i) => i.id === createdInterventionId);

  const r = await call(`/prediction/interventions/${createdInterventionId}`, {
    method: "PUT", token, body: { outcome: "improved", status: "reviewed" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.body.intervention.outcome, "improved");
  assert.ok(r.body.intervention.reviewedAt, "a reviewed intervention must record when");

  // The snapshot is the baseline the outcome is judged against. A review that moved
  // it would be marking its own homework.
  assert.equal(r.body.intervention.progressionScoreAtIntervention, original.progressionScoreAtIntervention,
    "the snapshotted score must not change when the intervention is reviewed");
  assert.equal(r.body.intervention.riskLevelAtIntervention, original.riskLevelAtIntervention,
    "the snapshotted risk level must not change when the intervention is reviewed");
  return "reviewed, baseline intact";
});

await check("an outcome nobody implemented is refused", async () => {
  if (!createdInterventionId) return "skipped — nothing was created";
  const r = await call(`/prediction/interventions/${createdInterventionId}`, {
    method: "PUT", token, body: { outcome: "vibes" },
  });
  assert.equal(r.status, 400, `expected 400, got ${r.status}`);
  return "refused";
});

/* ------------------------------------------------------------------ access --- */

await check("the register is not reachable without a session", async () => {
  for (const path of ["/prediction/students", "/prediction/summary", "/prediction/settings", "/prediction/interventions"]) {
    const r = await call(path);
    assert.equal(r.status, 401, `${path} answered ${r.status} to an anonymous caller`);
  }
  return "4 routes refuse anonymous callers";
});

await check("recalculating is not reachable without a session", async () => {
  const r = await call("/prediction/recalculate", { method: "POST", body: {} });
  assert.equal(r.status, 401, `expected 401, got ${r.status}`);
  return "refused";
});

await check("a member of staff without the page grant cannot read who the college is worried about", async () => {
  // A risk level is a judgement about a named student's likelihood of failing, drawn
  // from their attendance, their marks and a pastoral conversation. It is a wider
  // disclosure than the gradebook, and the gradebook is page-gated.
  const staff = await call("/staff", { token });
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

  const r = await call("/prediction/students", { token: login.body.token });
  assert.equal(r.status, 403, `a member of staff without the grant got ${r.status} from the risk register`);
  return `${plain.email} refused`;
});

/* ------------------------------------------------------------------ tidy up --- */

await check("the suite leaves the model as it found it", async () => {
  const r = await resetSettings();
  assert.equal(r.status, 200);
  const back = await getSettings();
  assert.equal(back.body.customised, false);
  return "reset to defaults";
});

if (createdInterventionId) {
  // There is deliberately no delete route — an intervention is a record of what the
  // college knew and when — so the row it created is closed rather than removed, and
  // its note says where it came from.
  await call(`/prediction/interventions/${createdInterventionId}`, {
    method: "PUT", token, body: { status: "closed", notes: "smoke-prediction test — closed by the suite" },
  });
  console.log(`  (left one closed intervention on ${subjectRef}; there is no delete route by design)`);

  // AND CHECK THE TRAIL AGAIN, now that an UPDATE has rewritten `notes`.
  //
  // This is the half that matters. The earlier check runs before any PUT exists, so
  // restoring `before: existing, after: updated` on the update route would have left
  // it green — while leaking up to 500 characters of pastoral free text per side,
  // which is worse than the surname the first check catches.
  await check("the audit trail carries no notes after an intervention is EDITED", async () => {
    const n = await assertAuditCarriesNoCaseload("after update");
    return `${n} audit row(s) after update: no notes, no student name`;
  });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
