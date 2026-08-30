// The gradebook — assessments, marks, bands and who is allowed to see any of it.
//
// A student's marks are the most consequential data this product holds: they decide
// whether somebody passes an HND, and a wrong figure surfaces months later in an
// appeal, when nobody can remember what was typed. So the assertions here are almost
// all about REFUSALS — the moments where the API has to say no and, in saying no,
// stops a number from quietly becoming wrong:
//
//   * the gradebook is admin-only, and a teacher/student token must never reach it;
//   * a mark outside 0..maxMarks, a mark that is not a whole number, the same student
//     twice in one save, or a student who was never on the unit, are all rejected;
//   * the maximum cannot be cut below a mark already awarded (STATUS.md §3.5) —
//     otherwise every percentage, band and pass rate derived from it inflates at once
//     without a single grade row being touched;
//   * the D/M/P/F boundaries really sit at 70/60/50;
//   * re-saving the same marks changes nothing (the grade screen re-submits the whole
//     unit on every save, so this runs constantly in production).
//
// Three assertions here are marked FIXED IN THIS PASS: they cover defects this suite
// turned up in routes/assessments.js and that were repaired alongside it — a blank
// cell being stored as a mark of zero, a non-numeric payload being coerced into a
// real mark, and an assessment being re-filed onto a different unit with nothing
// written to the audit log.
//
//   node scripts/smoke-assessments.mjs      (needs API_URL + DATABASE_URL)
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));

// API_URL is what scripts/test.mjs exports to a suite. Reading anything else (as
// smoke-branding once did) silently points the suite at a port with no server on it,
// and every assertion "passes" by never running.
const BASE = process.env.API_URL || "http://localhost:4000/api";
const ADMIN = process.env.SEED_ADMIN_EMAIL || "admin@edtech.co.uk";
const PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required — point it at a throwaway database.");
  process.exit(1);
}

// A BARE client: the two actors this suite needs (an admin restricted to one page,
// and a student who can actually sign in) cannot be produced through the API at all.
// Reading back through a different client from the one the API writes with is
// deliberate, and every row it touches is undone in the finally block.
const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));
const bcrypt = require(join(server, "node_modules", "bcryptjs"));
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

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

const login = async (email, password) => {
  const r = await call("/auth/login", { method: "POST", body: { email, password } });
  return r.body?.token || null;
};

console.log("\n=== assessments ===\n");

const token = await login(ADMIN, PASSWORD);
if (!token) { console.log("✗ could not sign in as the seeded admin — is the API seeded?"); process.exit(1); }
const staffToken = await login("j.whitfield@edtech.co.uk", PASSWORD);
if (!staffToken) { console.log("✗ could not sign in as the seeded teacher s1"); process.exit(1); }

// The seeded unit BS carries only the FIRST seven students; 100129 / 100135 / 100140
// are on other units. That gap is what makes "not enrolled" testable without touching
// a shared fixture.
const UNIT = "m-bs";
const ENROLLED = ["st-100121", "st-100122", "st-100126", "st-100133", "st-100110", "st-100123", "st-100118"];
const NOT_ENROLLED = "st-100129"; // Marek Kowalski — on OBM/WS/DITO, never on BS

const NARROW_EMAIL = "smoke-assessments-narrow@edtech.co.uk";
const NARROW_PW = "narrow-admin-password-2026";
const STUDENT_ID = "st-100140"; // Tobias Lindqvist — restored to passwordHash: null at the end
const STUDENT_PW = "smoke-assessments-student-2026";

let narrowId = null, studentTouched = false, assessmentId = null;

try {
  /* ================================================== who may look at marks === */

  await check("no token gets nothing", async () => {
    const r = await call("/assessments");
    assert.equal(r.status, 401, `expected 401, got ${r.status}`);
    return r.body.error;
  });

  await check("a teacher cannot read the gradebook", async () => {
    // DEF-01. Marks are read through an admin page, never through a staff or mobile
    // flow — a lecturer browsing the whole college's results is a data-protection
    // incident, not a convenience. The guard sits on router.use, so even the LIST is
    // closed, not just the writes.
    const r = await call("/assessments", { token: staffToken });
    assert.equal(r.status, 403, `expected 403, got ${r.status}`);
    assert.match(r.body.error, /Admin access required/);
    return r.body.error;
  });

  await check("a teacher cannot post an assessment either", async () => {
    const r = await call("/assessments", { method: "POST", token: staffToken, body: { unitId: UNIT, title: "Sneaky" } });
    assert.equal(r.status, 403, `expected 403, got ${r.status}`);
    return r.body.error;
  });

  await check("a teacher cannot read the executive pass statistics", async () => {
    // exec-summary is registered BEFORE the router-wide gate so an executive-only
    // admin can reach it. That ordering must widen access to a second admin page,
    // not to non-admins.
    const r = await call("/assessments/exec-summary", { token: staffToken });
    assert.equal(r.status, 403, `expected 403, got ${r.status}`);
    return r.body.error;
  });

  // An administrator granted ONLY the executive page. Cannot be made through the API:
  // adminPages is set by a super-admin route no seeded account can reach.
  const narrow = await db.staff.create({
    data: {
      name: "Smoke Narrow Admin", jobTitle: "Principal", dept: "Leadership",
      email: NARROW_EMAIL, passwordHash: bcrypt.hashSync(NARROW_PW, 10),
      accountRole: "ADMIN", adminPages: JSON.stringify(["executive"]),
      initials: "NA", colour: "#334155",
    },
  });
  narrowId = narrow.id;
  const narrowToken = await login(NARROW_EMAIL, NARROW_PW);

  await check("an executive-only admin still gets the dashboard summary", async () => {
    assert.ok(narrowToken, "the narrow admin could not sign in");
    const r = await call("/assessments/exec-summary", { token: narrowToken });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 160));
    assert.ok(r.body.totals && typeof r.body.totals.students === "number", "totals.students missing");
    return `${r.body.totals.students} students counted`;
  });

  await check("...but not the gradebook behind it", async () => {
    // The whole point of a page-scoped admin: the Executive Dashboard shows pass
    // RATES, the gradebook shows named students' individual marks. Granting the
    // first must not hand over the second.
    const r = await call("/assessments", { token: narrowToken });
    assert.equal(r.status, 403, `expected 403, got ${r.status}`);
    assert.match(r.body.error, /access to this section/);
    return r.body.error;
  });

  // No seeded student has a password, so a student session has to be minted.
  await db.student.update({ where: { id: STUDENT_ID }, data: { passwordHash: bcrypt.hashSync(STUDENT_PW, 10) } });
  studentTouched = true;
  const studentToken = await login("100140@edtech.co.uk", STUDENT_PW);

  await check("a student token cannot reach the gradebook at all", async () => {
    // requireAuth's router allowlist. If this ever breaks, a student reads every
    // other student's marks with their own perfectly valid session — the single
    // worst failure available in this codebase.
    assert.ok(studentToken, "could not mint a student session");
    const r = await call("/assessments", { token: studentToken });
    assert.equal(r.status, 403, `expected 403, got ${r.status}`);
    assert.match(r.body.error, /Not available for student accounts/);
    return r.body.error;
  });

  /* ======================================================= what may be saved === */

  await check("an assessment with no unit is refused", async () => {
    const r = await call("/assessments", { method: "POST", token, body: { title: "Orphan" } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    return r.body.error;
  });

  await check("an assessment on a unit that does not exist is refused", async () => {
    // Without this, a typo'd unitId creates a gradebook nobody can find and no
    // student is enrolled on — marks entered against it vanish from every view.
    const r = await call("/assessments", { method: "POST", token, body: { unitId: "m-nope", title: "Ghost" } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    assert.match(r.body.error, /Unknown unit/);
    return r.body.error;
  });

  await check("a blank title is refused", async () => {
    const r = await call("/assessments", { method: "POST", token, body: { unitId: UNIT, title: "   " } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    return r.body.error;
  });

  await check("an assessment type outside the closed set is refused", async () => {
    const r = await call("/assessments", { method: "POST", token, body: { unitId: UNIT, title: "T", type: "Vibes" } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    assert.match(r.body.error, /Assignment/);
    return r.body.error;
  });

  await check("a maximum of zero, 1001 or a fraction is refused", async () => {
    // maxMarks is the denominator under every percentage the college publishes. Zero
    // divides by nothing; a fraction makes "a whole number between 0 and max"
    // unenforceable on the marks themselves.
    for (const max of [0, -5, 1001, 12.5]) {
      const r = await call("/assessments", { method: "POST", token, body: { unitId: UNIT, title: "T", maxMarks: max } });
      assert.equal(r.status, 400, `maxMarks ${max} should be refused, got ${r.status}`);
    }
    return "0, -5, 1001 and 12.5 all rejected";
  });

  await check("a weighting over 100% is refused", async () => {
    const r = await call("/assessments", { method: "POST", token, body: { unitId: UNIT, title: "T", weight: 101 } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    return r.body.error;
  });

  await check("a due date that is not a real calendar day is refused", async () => {
    // 2039-02-30 parses happily as a string and would sit in the UI as a deadline
    // that can never arrive. isRealDate round-trips it through Date to catch exactly
    // this.
    const r = await call("/assessments", { method: "POST", token, body: { unitId: UNIT, title: "T", dueDate: "2039-02-30" } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    assert.match(r.body.error, /valid date/);
    return r.body.error;
  });

  /* ============================================================ grade entry === */

  await check("an assessment can be created on a real unit", async () => {
    const r = await call("/assessments", {
      method: "POST", token,
      body: { unitId: UNIT, title: "Smoke — BS Portfolio", type: "Portfolio", maxMarks: 100, weight: 40, dueDate: "2026-07-01" },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 200));
    assessmentId = r.body.id;
    assert.ok(assessmentId, "no id returned");
    assert.equal(r.body.maxMarks, 100);
    assert.equal(r.body.type, "Portfolio");
    assert.equal(r.body.gradedCount, 0, "a brand-new assessment cannot already have marks");
    return assessmentId;
  });

  await check("the grade sheet lists exactly the students enrolled on the unit", async () => {
    // A marker types into this list. A student who appears here but is not on the
    // unit gets marked by mistake; one missing from it never gets marked at all.
    const r = await call(`/assessments/${assessmentId}/grades`, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 160));
    const ids = r.body.rows.map((x) => x.student.id).sort();
    assert.deepEqual(ids, [...ENROLLED].sort());
    assert.ok(r.body.rows.every((x) => x.marks === null && x.grade === null), "nothing should be marked yet");
    assert.ok(r.body.rows.every((x) => x.enrolled === true));
    return `${ids.length} students, none marked`;
  });

  await check("a mark above the maximum is refused", async () => {
    const r = await call(`/assessments/${assessmentId}/grades`, { method: "PUT", token, body: { grades: [{ studentId: ENROLLED[0], marks: 101 }] } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    assert.match(r.body.error, /between 0 and 100/);
    return r.body.error;
  });

  await check("a negative or fractional mark is refused", async () => {
    // pctOf clamps a stray value to 0–100 when READING, which hides the damage. The
    // refusal has to happen on the way in or the stored number is simply wrong.
    for (const marks of [-1, 62.5]) {
      const r = await call(`/assessments/${assessmentId}/grades`, { method: "PUT", token, body: { grades: [{ studentId: ENROLLED[0], marks }] } });
      assert.equal(r.status, 400, `marks ${marks} should be refused, got ${r.status}`);
    }
    return "-1 and 62.5 both rejected";
  });

  await check("the same student twice in one save is refused", async () => {
    // A bulk upsert applies both rows in order and the last one wins silently — two
    // markers submitting at once, and the lower mark sticks with nobody told.
    const r = await call(`/assessments/${assessmentId}/grades`, {
      method: "PUT", token, body: { grades: [{ studentId: ENROLLED[0], marks: 55 }, { studentId: ENROLLED[0], marks: 91 }] },
    });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    assert.match(r.body.error, /twice/);
    return r.body.error;
  });

  await check("a student who was never on the unit cannot be marked", async () => {
    // Existence is not enough: a mistyped id that happens to be a real student would
    // otherwise attach a mark to somebody who never sat the assessment, and it would
    // show up on their transcript.
    const r = await call(`/assessments/${assessmentId}/grades`, { method: "PUT", token, body: { grades: [{ studentId: NOT_ENROLLED, marks: 60 }] } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    assert.match(r.body.error, /not enrolled/);
    return r.body.error;
  });

  await check("a save of more than 500 rows is refused before any work is done", async () => {
    // Matches the register endpoint's cap. Without it a 1MB body forces a 20k-row
    // loop and two enormous IN() queries before the enrolment check rejects it —
    // enough pre-check work to stall the API for every other user.
    const grades = Array.from({ length: 501 }, (_, i) => ({ studentId: `st-fake-${i}`, marks: 1 }));
    const r = await call(`/assessments/${assessmentId}/grades`, { method: "PUT", token, body: { grades } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}`);
    assert.match(r.body.error, /limit 500/);
    return r.body.error;
  });

  await check("nothing was stored by any of those refusals", async () => {
    // Each rejection above must be atomic. A partially-applied bulk save is worse
    // than an outright failure, because nobody is told which half landed.
    const r = await call(`/assessments/${assessmentId}/grades`, { token });
    assert.ok(r.body.rows.every((x) => x.marks === null), "a rejected save left marks behind");
    return "grade sheet still empty";
  });

  /* ===================================================== bands and rescoring === */

  // Out of 100, so mark == percentage and the D/M/P/F boundaries are readable.
  const BANDS = [
    [ENROLLED[0], 70, "Distinction"], // exactly on the Distinction line
    [ENROLLED[1], 60, "Merit"],       // exactly on the Merit line
    [ENROLLED[2], 50, "Pass"],        // exactly on the Pass line — PASS_MARK
    [ENROLLED[3], 49, "Fail"],        // one mark below it
  ];

  await check("the D/M/P/F boundaries sit exactly at 70/60/50", async () => {
    // The college's published grade boundaries. bandOf is duplicated in
    // routes/student.js and in the client, so a boundary that drifts here shows a
    // student one grade in the app and another on their results letter.
    const r = await call(`/assessments/${assessmentId}/grades`, {
      method: "PUT", token, body: { grades: BANDS.map(([studentId, marks]) => ({ studentId, marks })) },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 160));
    assert.equal(r.body.saved, 4);
    const sheet = await call(`/assessments/${assessmentId}/grades`, { token });
    const byId = new Map(sheet.body.rows.map((x) => [x.student.id, x]));
    for (const [studentId, marks, band] of BANDS) {
      const row = byId.get(studentId);
      assert.equal(row.marks, marks, `${studentId} should hold ${marks}`);
      assert.equal(row.pct, marks, `${studentId} out of 100 should read ${marks}%`);
      assert.equal(row.grade, band, `${marks}% should band as ${band}, got ${row.grade}`);
    }
    return "70=Distinction, 60=Merit, 50=Pass, 49=Fail";
  });

  await check("a hand-typed mark is stamped 'manual' so the Moodle sync cannot revert it", async () => {
    // The sync only spares source === "manual". A correction stored without that
    // provenance is overwritten by the VLE on its next run and the marker is never
    // told — the UPDATE branch of the upsert has to set it, not just the create.
    const r = await call(`/assessments/${assessmentId}/grades`, { token });
    const row = r.body.rows.find((x) => x.student.id === ENROLLED[0]);
    assert.equal(row.source, "manual");
    assert.ok(row.gradedBy, "the marker's name should travel with the mark");
    return `${row.source}, by ${row.gradedBy}`;
  });

  await check("re-saving the identical sheet changes nothing", async () => {
    // The grade screen re-submits every student on the unit on every save, so this is
    // the common case, not an edge one. A non-idempotent upsert would duplicate rows
    // (the @@unique([assessmentId, studentId]) is what stops it).
    const before = await call(`/assessments/${assessmentId}/grades`, { token });
    const r = await call(`/assessments/${assessmentId}/grades`, {
      method: "PUT", token, body: { grades: BANDS.map(([studentId, marks]) => ({ studentId, marks })) },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.saved, 4, "a second identical save must not create extra grade rows");
    const after = await call(`/assessments/${assessmentId}/grades`, { token });
    assert.deepEqual(after.body.rows.map((x) => x.marks), before.body.rows.map((x) => x.marks));
    return "4 rows before, 4 rows after";
  });

  await check("the maximum cannot be cut below a mark already awarded", async () => {
    // STATUS.md §3.5. A maximum of 60 under an awarded 70 makes that student score
    // 117% — except pctOf clamps it to 100, so the mark reads as a perfect score and
    // every average, band and pass rate built on it inflates with no grade row having
    // changed. Refuse, and name the mark that is in the way.
    const r = await call(`/assessments/${assessmentId}`, { method: "PUT", token, body: { maxMarks: 60 } });
    assert.equal(r.status, 409, `expected 409, got ${r.status}`);
    assert.match(r.body.error, /70/, "the error should name the highest awarded mark");
    return r.body.error;
  });

  await check("the refused change really did not happen", async () => {
    // A 409 that still wrote would be the worst of both worlds.
    const r = await call(`/assessments?unitId=${UNIT}`, { token });
    const mine = r.body.find((a) => a.id === assessmentId);
    assert.equal(mine.maxMarks, 100, "maxMarks moved despite the 409");
    assert.equal(mine.gradedCount, 4);
    assert.equal(mine.avgMarks, 57.3, "average of 70/60/50/49 out of 100");
    return `still out of ${mine.maxMarks}, avg ${mine.avgMarks}`;
  });

  await check("cutting the maximum to exactly the highest mark is allowed", async () => {
    // 70 out of 70 is 100%, not over it. The rule is "below an awarded mark", and a
    // boundary that is one out either way blocks a legitimate correction.
    const r = await call(`/assessments/${assessmentId}`, { method: "PUT", token, body: { maxMarks: 70 } });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 160));
    assert.equal(r.body.maxMarks, 70);
    return "70 accepted";
  });

  await check("raising the maximum re-scores every mark already awarded", async () => {
    // This is exactly why the guard above exists, seen from the safe direction: the
    // marks did not change and the grades did. A 70 that was a Distinction is a Fail
    // out of 200, and nothing in the grade rows records that it moved.
    const r = await call(`/assessments/${assessmentId}`, { method: "PUT", token, body: { maxMarks: 200 } });
    assert.equal(r.status, 200);
    const sheet = await call(`/assessments/${assessmentId}/grades`, { token });
    const top = sheet.body.rows.find((x) => x.student.id === ENROLLED[0]);
    assert.equal(top.marks, 70, "the stored mark must not have been rewritten");
    assert.equal(top.pct, 35, "70 out of 200 is 35%");
    assert.equal(top.grade, "Fail", "a Distinction became a Fail with no grade row touched");
    // Put it back so the rest of the suite reads in whole percentages.
    await call(`/assessments/${assessmentId}`, { method: "PUT", token, body: { maxMarks: 100 } });
    return "70/200 = 35% = Fail";
  });

  await check("a null mark clears the grade rather than storing a zero", async () => {
    // "Not marked yet" and "scored nothing" are different facts. Storing 0 for an
    // absent mark drags the unit average down and fails a student who has simply not
    // been marked.
    const r = await call(`/assessments/${assessmentId}/grades`, { method: "PUT", token, body: { grades: [{ studentId: ENROLLED[3], marks: null }] } });
    assert.equal(r.status, 200);
    assert.equal(r.body.saved, 3, "the cleared row should be gone, not zeroed");
    const sheet = await call(`/assessments/${assessmentId}/grades`, { token });
    const row = sheet.body.rows.find((x) => x.student.id === ENROLLED[3]);
    assert.equal(row.marks, null);
    assert.equal(row.grade, null, "an unmarked student has no band, not a Fail");
    return "3 marks remain";
  });


  await check("a whitespace-only cell clears the mark, it does not award a zero", async () => {
    // FIXED IN THIS PASS. Number(" ") is 0, so a cell holding nothing but a spacebar
    // was saved as a real mark of zero. "Not marked yet" and "scored nothing" are
    // different facts: a zero drags the unit average down and fails a student nobody
    // had got round to marking, and there is nothing on the sheet to show it was an
    // accident. The handler already treats "" and null as a clear — a trimmed blank
    // has to mean the same thing.
    const r = await call(`/assessments/${assessmentId}/grades`, { method: "PUT", token, body: { grades: [{ studentId: ENROLLED[4], marks: "   " }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 160));
    const sheet = await call(`/assessments/${assessmentId}/grades`, { token });
    const row = sheet.body.rows.find((x) => x.student.id === ENROLLED[4]);
    assert.equal(row.marks, null, "a blank cell was stored as a mark");
    assert.equal(row.grade, null, "an unmarked student must not band as a Fail");
    return "blank means unmarked";
  });

  await check("a mark that is not a number is refused rather than coerced into one", async () => {
    // FIXED IN THIS PASS. Number([]) is 0 and Number(true) is 1, so a malformed
    // payload awarded real marks with a 200 and no warning — the quietest way for a
    // wrong figure to enter a student's record. A numeric STRING still has to work:
    // the grade grid posts its cells as text.
    for (const marks of [[], true, {}]) {
      const r = await call(`/assessments/${assessmentId}/grades`, { method: "PUT", token, body: { grades: [{ studentId: ENROLLED[4], marks }] } });
      assert.equal(r.status, 400, `marks ${JSON.stringify(marks)} should be refused, got ${r.status}`);
    }
    const good = await call(`/assessments/${assessmentId}/grades`, { method: "PUT", token, body: { grades: [{ studentId: ENROLLED[4], marks: "62" }] } });
    assert.equal(good.status, 200, "a numeric string is how the grade grid posts a mark");
    const sheet = await call(`/assessments/${assessmentId}/grades`, { token });
    assert.equal(sheet.body.rows.find((x) => x.student.id === ENROLLED[4]).marks, 62);
    // Put the sheet back to the four band rows the later assertions count on.
    await call(`/assessments/${assessmentId}/grades`, { method: "PUT", token, body: { grades: [{ studentId: ENROLLED[4], marks: null }] } });
    return "[], true and {} rejected; \"62\" accepted";
  });

  await check("re-filing an assessment onto another unit is recorded", async () => {
    // FIXED IN THIS PASS. This route accepts a change of unit, and every mark already
    // awarded travels with it — off one unit's average, band distribution and pass
    // rate and onto another's. unitId was in neither the before nor the after object,
    // so diff() found nothing, both came out null, and moving a whole gradebook
    // between units looked exactly like a save that changed nothing. That is the one
    // question an audit trail is asked in a marking dispute.
    const moved = await call(`/assessments/${assessmentId}`, { method: "PUT", token, body: { unitId: "m-obm" } });
    assert.equal(moved.status, 200, JSON.stringify(moved.body).slice(0, 160));
    // audit.record is fire-and-forget by design, so give the write a moment to land.
    // Poll for the row describing THIS move rather than merely the newest update, so
    // an earlier assessment.updated entry cannot stand in for the one being tested.
    let log = null;
    for (let i = 0; i < 25; i++) {
      const rows = await db.auditLog.findMany({ where: { entityId: assessmentId, action: "assessment.updated" }, orderBy: { at: "desc" }, take: 5 });
      log = rows.find((r) => r.after && r.after.unitId === "m-obm") || null;
      if (log) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(log, "the move left no audit row naming the unit it moved to");
    assert.ok(log.before && log.after, "before/after were null — the change left no diff to read");
    assert.equal(log.before.unitId, UNIT, "the log must say which unit the marks came off");
    assert.equal(log.after.unitId, "m-obm", "and which unit they landed on");
    assert.match(log.summary, /moved to unit OBM/, log.summary);
    // Move it back: the remaining assertions read it through m-bs.
    const back = await call(`/assessments/${assessmentId}`, { method: "PUT", token, body: { unitId: UNIT } });
    assert.equal(back.status, 200);
    return log.summary;
  });

  /* ============================================================== the views === */

  await check("the flat grade list reports the true total and whether it truncated", async () => {
    // DEF-06: a capped list that says nothing looks like a complete one, and a
    // registrar reconciling marks would swear records had been deleted.
    const r = await call(`/assessments/grades?studentId=${ENROLLED[0]}`, { token });
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.total, "number");
    assert.equal(r.body.capped, r.body.total > r.body.returned);
    assert.equal(r.body.limit, 2000);
    const mine = r.body.records.find((g) => g.assessmentId === assessmentId);
    assert.equal(mine.marks, 70);
    assert.equal(mine.grade, "Distinction");
    assert.equal(mine.source, "manual");
    assert.equal(mine.unit.id, UNIT);
    return `${r.body.returned} of ${r.body.total}`;
  });

  await check("a student's own summary counts only what has been graded", async () => {
    // An unmarked assessment must not count as 0% — the same "not marked yet is not a
    // zero" rule, seen from the student's transcript.
    const r = await call(`/assessments/student/${ENROLLED[3]}`, { token });
    assert.equal(r.status, 200);
    const mine = r.body.assessments.find((a) => a.id === assessmentId);
    assert.ok(mine, "the assessment should still be listed for an enrolled student");
    assert.equal(mine.marks, null, "this student's mark was just cleared");
    assert.equal(mine.grade, null);
    return `${r.body.graded} graded of ${r.body.count} listed`;
  });

  await check("an unknown id is a 404 everywhere, not a 500 or an empty 200", async () => {
    const paths = [
      ["/assessments/no-such-id/grades", "GET"],
      ["/assessments/no-such-id", "PUT"],
      ["/assessments/no-such-id", "DELETE"],
      ["/assessments/student/no-such-student", "GET"],
    ];
    for (const [path, method] of paths) {
      const r = await call(path, { method, token, body: method === "PUT" ? { title: "x" } : undefined });
      assert.equal(r.status, 404, `${method} ${path} → ${r.status}`);
    }
    return "4 endpoints, all 404";
  });

  await check("deleting an assessment takes its marks with it", async () => {
    // Deliberate and logged: an assessment is not scaffolding, it is the container
    // for student academic record, so the cascade must be complete rather than
    // leaving orphaned grade rows that still count toward averages.
    const r = await call(`/assessments/${assessmentId}`, { method: "DELETE", token });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 160));
    const flat = await call(`/assessments/grades?unitId=${UNIT}`, { token });
    assert.equal(flat.body.records.filter((g) => g.assessmentId === assessmentId).length, 0, "grades outlived their assessment");
    const gone = await call(`/assessments/${assessmentId}/grades`, { token });
    assert.equal(gone.status, 404);
    assessmentId = null;
    return "assessment and its marks gone";
  });
} catch (e) {
  bad("the suite itself threw", e);
} finally {
  /* ================================================================= cleanup === */
  // Eight suites share one seeded database in a single run and the seed is not re-run
  // between them. Anything created here has to go, and anything mutated has to be put
  // back exactly as the seed left it.
  try { if (assessmentId) await db.assessment.deleteMany({ where: { id: assessmentId } }); } catch { /* already gone */ }
  try { if (narrowId) await db.staff.delete({ where: { id: narrowId } }); } catch { /* already gone */ }
  // The seed leaves every student with passwordHash: null — no seeded student can
  // sign in. Leaving a usable student password behind would be a fixture that lies.
  try { if (studentTouched) await db.student.update({ where: { id: STUDENT_ID }, data: { passwordHash: null } }); } catch { /* already gone */ }
  await db.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
