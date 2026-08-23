// Proves each bug found in the audit is actually fixed. Creates only its own rows and
// deletes them; never touches the owner's data.
require("dotenv").config();
// Run against a LOCAL server only — it creates and deletes staff and review rows.
const BASE = "http://localhost:4000/api";
let pass = 0, fail = 0;
const ok = (c, m) => { console.log(c ? "  PASS  " + m : "  FAIL  " + m); c ? pass++ : fail++; };

async function call(path, { method = "GET", token, body } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await r.json(); } catch { }
  return { status: r.status, data };
}

(async () => {
  const prisma = require("../src/db");
  // Credentials come from the environment — never hard-coded, so this file is safe to
  // commit:  ADMIN_EMAIL=you@edtech.co.uk ADMIN_PASSWORD=... node scripts/verify-reviews.js
  const EMAIL = process.env.ADMIN_EMAIL, PASSWORD = process.env.ADMIN_PASSWORD;
  if (!EMAIL || !PASSWORD) {
    console.log("Set ADMIN_EMAIL and ADMIN_PASSWORD, and make sure the API is running on :4000.");
    process.exit(1);
  }
  const login = await call("/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
  const A = login.data?.token;
  if (!A) { console.log(`cannot sign in as ${EMAIL} (${login.status})`); process.exit(1); }

  // A throwaway lecturer with no admin pages at all — the audience the roster fix is for.
  const email = `verify.${Date.now()}@edtech.co.uk`;
  const bcrypt = require("bcryptjs");
  // Created through the API so every required column gets its normal default, then
  // given a password directly so this test can sign in as them.
  const mk = async (name, jobTitle, addr, role, pages) => {
    const r = await call("/staff", { method: "POST", token: A, body: { name, jobTitle, dept: "HND", email: addr, accountRole: role, adminPages: pages } });
    if (r.status !== 201) { console.log("could not create fixture staff:", r.status, JSON.stringify(r.data)); process.exit(1); }
    // Created via the API, so the account is invite-pending with a random password.
    // Clear that and set a known one, which is what accepting the invite would do.
    await prisma.staff.update({ where: { id: r.data.id }, data: { passwordHash: bcrypt.hashSync("Passw0rd!verify", 10), pendingActivation: false } });
    return r.data;
  };
  const lec = await mk("Verify Lecturer", "Lecturer", email, "STAFF", []);
  const L = (await call("/auth/login", { method: "POST", body: { email, password: "Passw0rd!verify" } })).data?.token;
  ok(!!L, "throwaway lecturer signs in (no admin pages)");

  const staffId = lec.id;
  const anyStudent = await prisma.student.findFirst({ select: { id: true } });
  const created = { staffReviews: [], studentReviews: [] };

  console.log("\n--- 1. status-only PUT must re-validate (was: filed an empty review) ---");
  const draft = await call("/staff-reviews", { method: "POST", token: A, body: { type: "monthly", staffId, status: "draft", answers: { lecturerName: "X" } } });
  ok(draft.status === 201, `one-answer draft created (${draft.status})`);
  if (draft.data?.id) created.staffReviews.push(draft.data.id);
  const promote = await call(`/staff-reviews/${draft.data?.id}`, { method: "PUT", token: A, body: { status: "submitted" } });
  ok(promote.status === 400, `promoting it to submitted is refused (${promote.status})`);
  ok(/required/i.test(promote.data?.error || ""), `and says what is missing: "${String(promote.data?.error).slice(0, 58)}…"`);
  const stillDraft = await call(`/staff-reviews/${draft.data?.id}`, { token: A });
  ok(stillDraft.data?.status === "draft", "the review is still a draft");

  console.log("\n--- 2. self-service scope: a manager's review is not the subject's to read or delete ---");
  const mine = await call("/my-reviews", { token: L });
  ok(Array.isArray(mine.data) && !mine.data.some(r => r.id === draft.data?.id), "the monthly review about them is NOT in /my-reviews");
  ok((await call(`/my-reviews/${draft.data?.id}`, { token: L })).status === 404, "they cannot read it directly (404)");
  ok((await call(`/my-reviews/${draft.data?.id}`, { method: "DELETE", token: L })).status === 404, "they cannot delete it (404)");
  ok((await call(`/staff-reviews/${draft.data?.id}`, { token: A })).status === 200, "and it still exists afterwards");

  console.log("\n--- 3. staffId is pinned on update ---");
  const other = await prisma.staff.findFirst({ where: { id: { not: staffId } }, select: { id: true } });
  const moved = await call(`/staff-reviews/${draft.data?.id}`, { method: "PUT", token: A, body: { staffId: other.id, answers: { lecturerName: "X" }, status: "draft" } });
  ok(moved.status === 200 && moved.data?.staffId === staffId, "a review cannot be reassigned to another lecturer");

  console.log("\n--- 4. free text: refused, not silently truncated ---");
  const long = await call("/staff-reviews", { method: "POST", token: A, body: { type: "monthly", staffId, status: "draft", answers: { lecturerName: "y".repeat(6000) } } });
  ok(long.status === 400 && /too long/i.test(long.data?.error || ""), `a 6,000-character answer is refused (${long.status})`);
  const objAns = await call("/staff-reviews", { method: "POST", token: A, body: { type: "monthly", staffId, status: "draft", answers: { lecturerName: { a: 1 } } } });
  ok(objAns.status === 400, `an object where text belongs is refused (${objAns.status}) — no more "[object Object]"`);
  const cbBad = await call("/staff-reviews", { method: "POST", token: A, body: { type: "evaluation", staffId, status: "draft", answers: { evidenceReviewed: "Attendance Data" } } });
  ok(cbBad.status === 400, `a bare string for a multi-select is refused (${cbBad.status})`);

  console.log("\n--- 5. Evaluation's date now reaches the list column ---");
  const evalAns = { lecturerName: "E", reviewTerm: "Term 1 - Autumn", dateReviewed: "2026-05-04" };
  const ev = await call("/staff-reviews", { method: "POST", token: A, body: { type: "evaluation", staffId, status: "draft", answers: evalAns } });
  if (ev.data?.id) created.staffReviews.push(ev.data.id);
  ok(ev.data?.dateCompleted === "2026-05-04", `dateCompleted is populated (${ev.data?.dateCompleted}) — was null for every Evaluation`);

  console.log("\n--- 6. the roster a lecturer needs to file a student review ---");
  ok((await call("/hnd/students", { token: L })).status === 403, "the HND student list is still page-gated (403)");
  const roster = await call("/student-reviews/roster", { token: L });
  ok(roster.status === 200, `but the review roster is reachable (${roster.status})`);
  ok((roster.data?.students?.length || 0) > 0 && (roster.data?.units?.length || 0) > 0, `and returns ${roster.data?.students?.length} students / ${roster.data?.units?.length} units`);
  ok(!!roster.data?.students?.[0]?.email, "each carries an email, so the app can filter by it");
  ok(roster.data?.students?.[0]?.passwordHash === undefined, "and no password hash leaks into it");

  console.log("\n--- 7. student review validation ---");
  const sr = await call("/student-reviews", { method: "POST", token: L, body: { studentId: anyStudent.id, date: "2026-08-04", progress: "Monitor", concerns: ["Attendance"], summary: "s", agreedActions: "a", followUp: true, followUpDate: "2026-09-01" } });
  ok(sr.status === 201, `the lecturer can file one (${sr.status})`);
  if (sr.data?.id) created.studentReviews.push(sr.data.id);
  ok(!!sr.data?.student?.email, "the row carries the student email for filtering");
  const wipe = await call(`/student-reviews/${sr.data?.id}`, { method: "PUT", token: L, body: { concerns: "Attendance" } });
  ok(wipe.status === 400, `a non-list "concerns" is refused (${wipe.status}) — used to silently erase them`);
  const after = await call(`/student-reviews/${sr.data?.id}`, { token: L });
  ok(JSON.stringify(after.data?.concerns) === '["Attendance"]', "and the original concerns are intact");
  const backdate = await call("/student-reviews", { method: "POST", token: L, body: { studentId: anyStudent.id, date: "2026-08-04", progress: "Monitor", concerns: [], summary: "s", agreedActions: "a", followUp: true, followUpDate: "2020-01-01" } });
  ok(backdate.status === 400, `a follow-up before the conversation is refused (${backdate.status})`);
  const farOff = await call("/student-reviews", { method: "POST", token: L, body: { studentId: anyStudent.id, date: "9999-12-31", progress: "Monitor", concerns: [], summary: "s", agreedActions: "a", followUp: false } });
  ok(farOff.status === 400, `the year 9999 is refused (${farOff.status}) — it pinned itself to the top of the list`);
  const dateOnly = await call(`/student-reviews/${sr.data?.id}`, { method: "PUT", token: L, body: { followUpDate: "2026-10-01" } });
  ok(dateOnly.status === 200 && dateOnly.data?.followUpDate === "2026-10-01", "a follow-up date can be changed on its own (was a silent no-op)");

  console.log("\n--- 8. no existence oracle on someone else's review ---");
  const others = await call("/student-reviews", { method: "POST", token: A, body: { studentId: anyStudent.id, date: "2026-08-04", progress: "On Track", concerns: [], summary: "admin's", agreedActions: "-", followUp: false } });
  if (others.data?.id) created.studentReviews.push(others.data.id);
  const probeGet = await call(`/student-reviews/${others.data?.id}`, { token: L });
  const probePut = await call(`/student-reviews/${others.data?.id}`, { method: "PUT", token: L, body: { summary: "x" } });
  const probeDel = await call(`/student-reviews/${others.data?.id}`, { method: "DELETE", token: L });
  ok(probeGet.status === 404 && probePut.status === 404 && probeDel.status === 404,
    `GET/PUT/DELETE all answer 404 (${probeGet.status}/${probePut.status}/${probeDel.status}) — no longer confirms the id exists`);

  console.log("\n--- 9. ?followUp=false actually filters ---");
  const all = await call("/student-reviews", { token: A });
  const noFollow = await call("/student-reviews?followUp=false", { token: A });
  const yesFollow = await call("/student-reviews?followUp=true", { token: A });
  ok(Array.isArray(noFollow.data) && noFollow.data.every(r => r.followUp === false), "every row returned has followUp false");
  ok((noFollow.data?.length || 0) + (yesFollow.data?.length || 0) === (all.data?.length || 0),
    `the two halves sum to the whole (${noFollow.data?.length} + ${yesFollow.data?.length} = ${all.data?.length})`);

  console.log("\n--- 10. the studentreviews page grant means what it says ---");
  const patOnly = await mk("Verify PAT", "Administrator", `verify.pat.${Date.now()}@edtech.co.uk`, "ADMIN", ["pat"]);
  const P = (await call("/auth/login", { method: "POST", body: { email: patOnly.email, password: "Passw0rd!verify" } })).data?.token;
  ok((await call("/student-reviews", { token: P })).status === 403, "a 'pat'-only admin can no longer read every student review");

  console.log("\n--- 11. login lockout survives a forged address ---");
  const ghost = `nobody.${Date.now()}@edtech.co.uk`;
  let locked = false;
  for (let i = 0; i < 24; i++) {
    const r = await fetch(BASE + "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": `203.0.113.${i + 1}` },
      body: JSON.stringify({ email: ghost, password: "wrong" }),
    });
    if (r.status === 429) { locked = true; break; }
  }
  ok(locked, "a new spoofed IP per attempt still hits the per-account lockout");

  console.log("\n--- 12. CSV hardening (pure helpers) ---");
  const { toCSV } = await import("file://" + require("path").resolve(__dirname, "../../client/src/csv.js"));
  const csv = toCSV([{ key: "a", label: "Answer" }], [{ a: '=HYPERLINK("http://evil","x")' }, { a: 'O\'Brien, "Sam"' }, { a: "line1\nline2" }]);
  ok(csv.includes(`"'=HYPERLINK`), "a formula is neutralised with a leading apostrophe");
  ok(csv.includes('"O\'Brien, ""Sam"""'), "commas and quotes are still escaped correctly");
  ok(/"line1\nline2"/.test(csv), "newlines are still quoted");

  /* -------------------------------------------------- restore -------------- */
  console.log("\n--- cleanup ---");
  for (const id of created.studentReviews) await call(`/student-reviews/${id}`, { method: "DELETE", token: A });
  for (const id of created.staffReviews) await call(`/staff-reviews/${id}`, { method: "DELETE", token: A });
  await prisma.staff.deleteMany({ where: { id: { in: [lec.id, patOnly.id] } } });
  const leftReviews = await prisma.staffReview.count({ where: { staffId: { in: [lec.id, patOnly.id] } } });
  const leftStudent = await prisma.studentReview.count({ where: { id: { in: created.studentReviews } } });
  const leftStaff = await prisma.staff.count({ where: { email: { startsWith: "verify." } } });
  ok(leftReviews === 0 && leftStudent === 0 && leftStaff === 0, "every row this test created is gone");
  console.log(`  staff=${await prisma.staff.count()} staffReviews=${await prisma.staffReview.count()} studentReviews=${await prisma.studentReview.count()} students=${await prisma.student.count()}`);
  await prisma.$disconnect();

  console.log(`\n${fail === 0 ? "ALL PASSED" : "FAILURES"} — ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
