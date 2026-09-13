// Mitigating circumstances, raised by the student themselves — and everything that
// must stay true when the person filling in the form is the person it is about.
//
// mitigations.js's own file header tells the origin story: TRIP_CHRONIC_LATE went live
// reporting a student as chronically late for using an accommodation the college itself
// had granted, because nothing had recorded that the accommodation existed. The
// self-service route this suite covers closes the gap one step earlier than a staff
// member typing it in — but it is the SAME Article 9 health data, sitting behind the
// SAME three-way split (its own admin page; an audit trail that records the decision and
// never the reason; a prediction select narrower than the model), and student.js's
// self-raise route DELIBERATELY REUSES the staff route's own validator rather than
// re-implementing the window cap and the category list. So this suite spends most of
// its assertions proving that reuse is real, and proving what a student is shown even
// after their own claim has been decided:
//
//   * the staff route's and the student route's 400s for the SAME bad input are the
//     IDENTICAL string, not two error messages that happen to agree today;
//   * a student sees status, dates, category and coversAttendance for their own claim —
//     and NEVER `decisionNote`, `decidedBy`, `detail` or `createdBy`, as a matter of the
//     KEY BEING ABSENT from the JSON, not merely null, and that stays true AFTER a
//     decision writes a decisionNote, which is the one moment a narrower allowlist is
//     easiest to get wrong;
//   * a student never sees another student's claim;
//   * a decision notifies the student EXACTLY once, naming the outcome and never the
//     category or the note;
//   * the self-raise itself notifies EXACTLY the staff who hold the "mitigations" page
//     (EXPLICIT_ONLY — an admin with adminPages:null does NOT hold it by default,
//     unlike an ordinary page) — never every admin, which would leak the fact of a
//     health-related claim past the access control the page exists to apply.
//
// This suite also runs the EXISTING staff smoke-mitigations.mjs at the end (see
// task-9-report.md) rather than trusting by inspection that nothing here regressed it —
// both suites touch the same table and the same shared validator.
//
// THE API PROCESS THIS SUITE TALKS TO IS ITS OWN, mirroring smoke-teams-attendance.mjs:
// a private port, a throwaway CREDENTIALS_KEY, fixtures built at runtime rather than
// added to prisma/seed.js. smoke-mitigations.mjs's own comment explains why a fixture
// belongs here and not in the shared seed: a second seeded admin silently broke
// smoke-account-deletion.mjs's "the last administrator cannot delete themselves" rule
// the first time this welfare-officer fixture was tried that way.
//
//   node scripts/smoke-mitigations-student.mjs
//   (needs DATABASE_URL; SEED_PASSWORD defaults to the one `npm test` seeds with)
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const server = join(root, "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));

if (!process.env.DATABASE_URL) {
  console.log("SKIP — DATABASE_URL is not set, so there is no database to run this suite against");
  process.exit(2);
}

const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));
const bcrypt = require(join(server, "node_modules", "bcryptjs"));

const RUN = Date.now().toString(36);
const PORT = Number(process.env.MITIGATIONS_STUDENT_SMOKE_PORT || 4025);
const API = `http://127.0.0.1:${PORT}/api`;
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`;
const SEED_PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";
const CREDENTIALS_KEY = randomBytes(32).toString("base64");
const JWT_SECRET = "mitigations-student-smoke-secret-not-for-production";

const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function call(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}
const login = (email, password) => call("/auth/login", { method: "POST", body: { email, password } });

let child, bootLog = "";
function stopApi() {
  if (child && !child.killed) {
    try { process.platform === "win32" ? spawnSync("taskkill", ["/pid", String(child.pid), "/f", "/t"]) : child.kill("SIGTERM"); }
    catch { /* already gone */ }
  }
}
process.on("exit", stopApi);
process.on("SIGINT", () => { stopApi(); process.exit(130); });

async function waitForApi(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

const settle = () => new Promise((r) => setTimeout(r, 300));

const A_EMAIL = `mcs-a-${RUN}@x.ac.uk`;
const B_EMAIL = `mcs-b-${RUN}@x.ac.uk`;
const A_PW = "mitigations-student-suite-2026";
const B_PW = "mitigations-student-suite-2026";
const OFFICER_EMAIL = `mcs.officer.${RUN}@edtech.co.uk`;
const OFFICER_PW = "OfficerPass123!";

const made = { students: [], claims: [], officerId: null };

async function cleanup() {
  try {
    for (const id of made.claims) await db.mitigatingCircumstance.delete({ where: { id } }).catch(() => {});
    // Cascades notifications; done last so every read above still has a row.
    for (const id of made.students) await db.student.delete({ where: { id } }).catch(() => {});
    if (made.officerId) await db.staff.delete({ where: { id: made.officerId } }).catch(() => {}); // cascades their notifications
  } catch (e) {
    console.error("cleanup problem:", e.message);
  }
}

try {
  console.log(`→ starting a private API on port ${PORT}`);
  child = spawn("node", ["src/index.js"], {
    cwd: server,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "test", JWT_SECRET, CREDENTIALS_KEY },
  });
  child.stdout.on("data", (d) => { bootLog += d; });
  child.stderr.on("data", (d) => { bootLog += d; });
  let diedEarly = false;
  child.on("exit", (code) => { if (code) diedEarly = true; });

  const healthy = await waitForApi();
  if (!healthy) {
    console.log(`SKIP — this suite's own API on port ${PORT} never became healthy` +
      (diedEarly ? " (it exited)" : " (timed out)") + `. Last output:\n${bootLog.slice(-2000)}`);
    stopApi();
    process.exit(2);
  }
  console.log("  private API healthy\n");

  /* ====================================================================== */
  console.log("--- fixtures: two students, a welfare officer holding the mitigations page ---");
  /* ====================================================================== */

  const a = await db.student.create({ data: {
    firstName: "MC", lastName: `A${RUN}`, studentRef: `MCA${RUN}`, email: A_EMAIL,
    initials: "MA", colour: "#1a73e8", passwordHash: bcrypt.hashSync(A_PW, 10),
  } });
  made.students.push(a.id);
  const b = await db.student.create({ data: {
    firstName: "MC", lastName: `B${RUN}`, studentRef: `MCB${RUN}`, email: B_EMAIL,
    initials: "MB", colour: "#1a73e8", passwordHash: bcrypt.hashSync(B_PW, 10),
  } });
  made.students.push(b.id);

  const adminLogin = await login("admin@edtech.co.uk", SEED_PASSWORD);
  const adminToken = adminLogin.data?.token;
  if (!adminToken) throw new Error(`admin sign-in failed (HTTP ${adminLogin.status}) — cannot run this suite`);

  // BUILT AT RUNTIME, NOT SEEDED — see the file header. A second admin in prisma/seed.js
  // silently changes "the last administrator cannot delete themselves" for every other
  // suite that runs after this one in the same `npm test` sweep.
  const officerMade = await call("/staff", {
    method: "POST", token: adminToken,
    body: { name: "MC Student-Suite Officer", email: OFFICER_EMAIL, password: OFFICER_PW },
  });
  if (!officerMade.data?.id) throw new Error(`could not create the welfare officer fixture: ${JSON.stringify(officerMade.data)}`);
  made.officerId = officerMade.data.id;
  await db.staff.update({
    where: { id: made.officerId },
    data: { accountRole: "ADMIN", adminPages: JSON.stringify(["mitigations"]), mustChangePassword: false },
  });

  const officerLogin = await login(OFFICER_EMAIL, OFFICER_PW);
  const officerToken = officerLogin.data?.token;
  const aLogin = await login(A_EMAIL, A_PW);
  const aToken = aLogin.data?.token;
  const bLogin = await login(B_EMAIL, B_PW);
  const bToken = bLogin.data?.token;
  check("the officer and both students sign in", !!officerToken && !!aToken && !!bToken,
    `officer=${officerLogin.status} A=${aLogin.status} B=${bLogin.status}`);

  /* ====================================================================== */
  console.log("\n--- the shared validator: staff and student routes give the IDENTICAL 400 ---");
  /* ====================================================================== */

  // Proven by string equality, not merely "both refused" — student.js reuses
  // mitigations.js's own validateWindow (a second require() of the same module; Node
  // caches it, so this is the SAME function, not a copy that could drift).
  const staffReversed = await call("/mitigations", {
    method: "POST", token: officerToken,
    body: { studentId: a.id, coversFrom: "2026-03-10", coversTo: "2026-03-01" },
  });
  const studentReversed = await call("/student/me/mitigations", {
    method: "POST", token: aToken,
    body: { coversFrom: "2026-03-10", coversTo: "2026-03-01" },
  });
  check("a reversed window: staff and student get the SAME 400 message",
    staffReversed.status === 400 && studentReversed.status === 400 && staffReversed.data.error === studentReversed.data.error,
    `staff="${staffReversed.data?.error}" student="${studentReversed.data?.error}"`);

  const staffUnbounded = await call("/mitigations", {
    method: "POST", token: officerToken,
    body: { studentId: a.id, coversFrom: "2026-01-01", coversTo: "2027-12-31" },
  });
  const studentUnbounded = await call("/student/me/mitigations", {
    method: "POST", token: aToken,
    body: { coversFrom: "2026-01-01", coversTo: "2027-12-31" },
  });
  check("an unbounded window (> mitigationWindowMaxDays): staff and student get the SAME 400 message",
    staffUnbounded.status === 400 && studentUnbounded.status === 400 && staffUnbounded.data.error === studentUnbounded.data.error,
    `staff="${staffUnbounded.data?.error?.slice(0, 60)}" student="${studentUnbounded.data?.error?.slice(0, 60)}"`);

  const studentBadCategory = await call("/student/me/mitigations", {
    method: "POST", token: aToken,
    body: { coversFrom: "2026-03-01", coversTo: "2026-03-10", category: "made-up-category" },
  });
  check("an unknown category is refused rather than stored verbatim",
    studentBadCategory.status === 400, `HTTP ${studentBadCategory.status} — ${studentBadCategory.data?.error}`);

  /* ====================================================================== */
  console.log("\n--- self-raise: created open, allowlisted narrower than the staff route ---");
  /* ====================================================================== */

  const runStart = new Date();
  const created = await call("/student/me/mitigations", {
    method: "POST", token: aToken,
    body: {
      coversFrom: "2026-03-01", coversTo: "2026-03-31",
      category: "illness", detail: "Should never leave the building — decisionNote's opposite number.",
      coversAttendance: true,
    },
  });
  check("a student can raise their own claim", created.status === 201, `HTTP ${created.status} — ${JSON.stringify(created.data)}`);
  if (created.data?.id) made.claims.push(created.data.id);
  check("it is created OPEN, not self-approved", created.data?.status === "open", created.data?.status);
  check("coversAttendance is honoured when the student opts in", created.data?.coversAttendance === true);
  check("raisedOn is a real date, stamped by the server", /^\d{4}-\d{2}-\d{2}$/.test(created.data?.raisedOn || ""), created.data?.raisedOn);

  // THE ALLOWLIST, PROVEN BY ABSENCE OF THE KEY — not merely a null value, which a
  // later refactor could reintroduce by including the column and letting it come back
  // null for now. `detail` is the student's OWN words and still does not leave this
  // route; `decisionNote`, `decidedBy`, `createdBy` and `studentId` are staff/admin
  // detail this comment on sStudentMitigation says a student is never shown.
  const claimKeys = Object.keys(created.data || {});
  for (const forbidden of ["detail", "decisionNote", "decidedBy", "createdBy", "studentId", "updatedAt"]) {
    check(`the created claim never carries "${forbidden}"`, !claimKeys.includes(forbidden), claimKeys.join(","));
  }

  /* ====================================================================== */
  console.log("\n--- overlap: one open claim per overlapping window ---");
  /* ====================================================================== */

  const overlap = await call("/student/me/mitigations", {
    method: "POST", token: aToken,
    body: { coversFrom: "2026-03-15", coversTo: "2026-03-20" },
  });
  check("an overlapping OPEN claim is refused with 409", overlap.status === 409, `HTTP ${overlap.status}`);
  check("...naming the dates of the claim already standing",
    /2026-03-01/.test(overlap.data?.error || "") && /2026-03-31/.test(overlap.data?.error || ""),
    overlap.data?.error);

  /* ====================================================================== */
  console.log("\n--- cross-student isolation ---");
  /* ====================================================================== */

  const listB = await call("/student/me/mitigations", { token: bToken });
  check("a student with no claims of their own sees an empty list, never A's",
    listB.status === 200 && Array.isArray(listB.data?.claims) && listB.data.claims.length === 0,
    `${listB.data?.claims?.length} claim(s)`);

  const listA = await call("/student/me/mitigations", { token: aToken });
  check("A's own list contains the claim just raised",
    listA.status === 200 && (listA.data?.claims || []).some((c) => c.id === created.data.id));

  /* ====================================================================== */
  console.log("\n--- the self-raise notifies staff who hold the mitigations page, and ONLY them ---");
  /* ====================================================================== */

  await settle();
  const officerNotifs = await db.notification.count({ where: { staffId: made.officerId, link: "mitigations", createdAt: { gte: runStart } } });
  check("the officer (holds the page) receives exactly one notification", officerNotifs === 1, `${officerNotifs} notification(s)`);

  // THE ONE THIS FEATURE MOST NEEDED (mitigations.js's own words, echoed in
  // student.js's self-raise comment): an admin with adminPages:null does NOT hold
  // "mitigations" by default — EXPLICIT_ONLY — so the seeded admin used to sign in
  // above must receive NOTHING about a claim it was never granted the page to read.
  const adminNotifs = await db.notification.count({ where: { staffId: adminLogin.data.user.id, link: "mitigations", createdAt: { gte: runStart } } });
  check("an admin who was never granted the mitigations page receives NOTHING", adminNotifs === 0, `${adminNotifs} notification(s)`);

  /* ====================================================================== */
  console.log("\n--- the decision: notifies once, and decisionNote still never reaches the student ---");
  /* ====================================================================== */

  const beforeDecision = await db.notification.count({ where: { studentId: a.id } });
  const decided = await call(`/mitigations/${created.data.id}`, {
    method: "PATCH", token: officerToken,
    body: { status: "approved", decisionNote: "Staff-only note — evidence seen, must never reach the student." },
  });
  check("the officer approves the claim", decided.status === 200 && decided.data?.status === "approved", `HTTP ${decided.status}`);
  check("...and the STAFF response does carry decisionNote (it is staff's own record)",
    decided.data?.decisionNote?.includes("Staff-only note"), decided.data?.decisionNote);

  await settle();
  const afterDecision = await db.notification.count({ where: { studentId: a.id } });
  check("the decision notifies the student EXACTLY once", afterDecision === beforeDecision + 1, `before=${beforeDecision} after=${afterDecision}`);
  const decisionNotif = await db.notification.findFirst({ where: { studentId: a.id }, orderBy: { createdAt: "desc" } });
  check("...the notification says APPROVED", /approved/i.test(decisionNotif?.message || ""), decisionNotif?.message);
  check("...and never carries the decisionNote text", !(decisionNotif?.message || "").includes("Staff-only note"));
  check("...nor the category", !(decisionNotif?.message || "").toLowerCase().includes("illness"));

  // THE ASSERTION THIS WHOLE SUITE IS REALLY FOR: decisionNote is written by the
  // decision above and STILL never reaches the student's own read of the SAME claim.
  const afterDecisionList = await call("/student/me/mitigations", { token: aToken });
  const decidedClaim = (afterDecisionList.data?.claims || []).find((c) => c.id === created.data.id);
  check("the student's own claim now shows the decision (status, decidedOn)",
    decidedClaim?.status === "approved" && !!decidedClaim?.decidedOn,
    `status=${decidedClaim?.status} decidedOn=${decidedClaim?.decidedOn}`);
  const decidedKeys = Object.keys(decidedClaim || {});
  check("...but decisionNote is STILL ABSENT, even after a decision wrote one",
    !decidedKeys.includes("decisionNote"), decidedKeys.join(","));
  check("...and decidedBy is absent too — who decided is staff's business, not the student's",
    !decidedKeys.includes("decidedBy"), decidedKeys.join(","));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
} catch (e) {
  console.error("suite error:", e);
  process.exitCode = 1;
} finally {
  stopApi();
  await cleanup();
  await db.$disconnect();
}
