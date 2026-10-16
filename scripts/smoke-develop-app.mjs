// Develop App — and above all, whether switching a function off actually switches it off.
//
// THE ASSERTION THIS SUITE EXISTS FOR is the one in the middle: after a Super Admin
// switches the student Results screen off, `GET /student/me/assessments` must answer
// 403. A toggle that only removes a tab from the client has not switched anything off —
// it has stopped linking to it, and every mark in the college is still one fetch away
// for anybody who opens the network tab. The screen says "off"; the server has to mean
// it. Everything else here is scaffolding around that sentence.
//
// The rest is weighted negative, as the suites here are (testing.md): who is refused
// (a student, a plain admin, nobody at all), what cannot be done however the request is
// written (switching off a locked screen, storing a function that does not exist), and
// what must keep working regardless (the bootstrap route, which is what tells the app
// which screens it has — gating it would sign out the college).
//
// IT ALSO PROVES THE TOGGLE OUTRANKS AN UNRESTRICTED GRANT. The seeded admin has
// adminPages: null, which means "never configured, so full access". That is the account
// most likely to slip past a new guard, because every per-person check waves it through
// — so the staff-side assertion uses exactly that account rather than a narrow one.
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

// A BARE client. Two things this suite needs cannot be produced through the API at all:
// a Super Admin (nothing promotes one — by design, since that is the account that hands
// out every other permission) and a student who can sign in (seeded students have no
// password). Every row touched here is undone in the finally block.
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

console.log("\n=== develop app ===\n");

const ADMIN_ID = "admin";
const STUDENT_ID = "st-100140";          // Tobias Lindqvist — restored to passwordHash: null at the end
const STUDENT_EMAIL = "100140@edtech.co.uk";
const STUDENT_PW = "smoke-develop-app-student-2026";

let promoted = false, studentTouched = false;

// Signed in BEFORE the promotion, deliberately: this token therefore carries a plain
// admin's claims, which is what the "a plain admin is refused" assertion needs. The
// super-admin token is minted after.
const plainToken = await login(ADMIN, PASSWORD);
if (!plainToken) { console.log("✗ could not sign in as the seeded admin — is the API seeded?"); process.exit(1); }

try {
  /* ============================================ who may configure the app at all === */

  await check("no token is refused", async () => {
    const r = await call("/develop-app");
    assert.equal(r.status, 401, `expected 401, got ${r.status}`);
    return r.body.error;
  });

  await check("a plain admin with unrestricted pages is still refused", async () => {
    // adminPages: null means "full access" to every PAGE. It must not mean access to
    // the screen that decides which pages exist — that is a Super Admin question, and
    // the whole reason this router guards on requireSuperAdmin rather than on a page.
    const r = await call("/develop-app", { token: plainToken });
    assert.equal(r.status, 403, `expected 403, got ${r.status}`);
    assert.match(r.body.error, /Super Admin/i);
    return r.body.error;
  });

  // Now promote, and mint the two sessions the rest of the suite runs on.
  await db.staff.update({ where: { id: ADMIN_ID }, data: { isSuperAdmin: true } });
  promoted = true;
  const token = await login(ADMIN, PASSWORD);
  assert.ok(token, "could not sign in after promotion");

  await db.student.update({ where: { id: STUDENT_ID }, data: { passwordHash: bcrypt.hashSync(STUDENT_PW, 10) } });
  studentTouched = true;
  const studentToken = await login(STUDENT_EMAIL, STUDENT_PW);
  assert.ok(studentToken, "could not mint a student session");

  await check("a student token cannot reach the Develop App screen", async () => {
    // The student router allowlist (STUDENT_ROUTERS) refuses this before any page or
    // super-admin check runs. If it ever stops, a student configures the college's app.
    const r = await call("/develop-app", { token: studentToken });
    assert.equal(r.status, 403, `expected 403, got ${r.status}`);
    return r.body.error;
  });

  /* ========================================================= what the screen reads === */

  await check("an unconfigured college is offered every function, on both surfaces", async () => {
    const r = await call("/develop-app", { token });
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    assert.equal(r.body.staff.length, 34, `expected 34 staff pages, got ${r.body.staff.length}`);
    assert.equal(r.body.student.length, 11, `expected 11 student screens, got ${r.body.student.length}`);
    assert.ok(r.body.staff.every((f) => f.enabled), "a staff page started switched off");
    assert.ok(r.body.student.every((f) => f.enabled), "a student screen started switched off");
    assert.equal(r.body.customised, false, "an untouched college reported itself customised");
    return `${r.body.staff.length} staff + ${r.body.student.length} student`;
  });

  await check("the enforcement route map never leaves the building", async () => {
    // `routes` is the server's map of which endpoint belongs to which screen. It is of
    // no use to the screen and publishing it hands anybody with devtools a precise list
    // of the endpoints behind each toggle. An allowlist on the way out is the house rule
    // (conventions.md) precisely so that a field added to the registry tomorrow is
    // private until somebody publishes it deliberately.
    const r = await call("/develop-app", { token });
    const leaked = [...r.body.staff, ...r.body.student].filter((f) => "routes" in f);
    assert.equal(leaked.length, 0, `these entries carried their route map: ${leaked.map((f) => f.id).join(", ")}`);
    return "no `routes` field on any entry";
  });

  /* ================================================== THE ASSERTION THAT MATTERS === */

  await check("a student can read their own results before anything is switched off", async () => {
    // The control. Without it the 403 below proves nothing — it could be a student who
    // never had access to begin with, which is exactly the shape of a test that passes
    // while discriminating nothing (testing.md).
    const r = await call("/student/me/assessments", { token: studentToken });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body).slice(0, 120)}`);
    return "200 before";
  });

  await check("switching the Results screen off makes its API refuse the student", async () => {
    const save = await call("/develop-app", {
      method: "PUT", token, body: { functions: { "student:assessments": false } },
    });
    assert.equal(save.status, 200, `save failed: ${save.status} ${JSON.stringify(save.body).slice(0, 160)}`);

    const r = await call("/student/me/assessments", { token: studentToken });
    assert.equal(r.status, 403, `THE TOGGLE IS COSMETIC: expected 403, got ${r.status}`);
    assert.equal(r.body.code, "FUNCTION_DISABLED", `expected code FUNCTION_DISABLED, got ${r.body.code}`);
    return "403 FUNCTION_DISABLED";
  });

  await check("the bootstrap route still answers, and reports the screen as gone", async () => {
    // /me is what tells the app which screens it has. Gating it behind a screen's own
    // toggle would sign out every student in the college the moment that screen went
    // off — so it is deliberately owned by no screen in the registry.
    const r = await call("/student/me", { token: studentToken });
    assert.equal(r.status, 200, `the bootstrap route was gated: ${r.status}`);
    assert.ok(r.body.app, "the bootstrap carried no app payload");
    assert.ok(!r.body.app.functions.includes("assessments"), "a switched-off screen is still offered to the app");
    assert.ok(r.body.app.functions.includes("home"), "the bootstrap dropped an enabled screen");
    assert.ok(!("assessments" in r.body.app.labels), "a switched-off screen still carried its label");
    return `app.functions = ${r.body.app.functions.length} screens`;
  });

  await check("a sibling screen is untouched", async () => {
    // The blast radius. Switching one screen off must not take its neighbours with it.
    const r = await call("/student/me/attendance", { token: studentToken });
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    return "attendance still 200";
  });

  /* ============================ the bootstrap the apps ACTUALLY call === */
  //
  // /auth/me, not /student/me. api.js#studentMe exists and nothing calls it, so this is
  // the only route either app bootstraps from — a screen list delivered anywhere else
  // switches nothing off in practice. That gap was live during this feature's own
  // development: the payload was added to /student/me first, the server tests passed,
  // and the student app would have carried on showing every screen.

  await check("the student app's real bootstrap carries its screen list", async () => {
    const save = await call("/develop-app", {
      method: "PUT", token, body: { functions: { "student:timetable": false } },
    });
    assert.equal(save.status, 200, `save failed: ${save.status}`);

    const r = await call("/auth/me", { token: studentToken });
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    assert.ok(r.body.app, "/auth/me carried no app payload — the student app cannot gate itself");
    assert.ok(!r.body.app.functions.includes("timetable"), "a switched-off screen is still offered");
    assert.ok(r.body.app.functions.includes("home"), "an enabled screen went missing");
    return `${r.body.app.functions.length} screens offered`;
  });

  await check("the staff app's bootstrap carries its page list", async () => {
    const r = await call("/auth/me", { token });
    assert.ok(r.body.app, "/auth/me carried no app payload for staff");
    assert.ok(r.body.app.functions.includes("settings"), "the staff payload is missing a page it should have");
    // The staff payload must be the STAFF surface, not the student one. The two share
    // three key names (checkin, assessments, mitigations), so a crossed wire here would
    // be invisible on those three and wrong on every other.
    assert.ok(!r.body.app.functions.includes("home"), "the staff payload carried a student screen");
    assert.equal(r.body.app.functions.length, 34, `expected 34 staff pages, got ${r.body.app.functions.length}`);
    return `${r.body.app.functions.length} pages offered`;
  });

  await check("neither surface is told the other's configuration", async () => {
    // A student learning which staff pages the college switched off is a leak of the
    // college's internal arrangements to an audience with no use for them.
    //
    // Uses `timesheets` rather than `slc` DELIBERATELY: the staff-side assertion below
    // switches `slc` off itself and checks it answered 200 first, so borrowing that
    // same page here left it switched off and broke that test's control. Which is a
    // small lesson about shared fixtures, and the reason this comment exists.
    const off = await call("/develop-app", {
      method: "PUT", token, body: { functions: { "staff:timesheets": false, "student:timetable": false } },
    });
    assert.equal(off.status, 200, `save failed: ${off.status}`);

    const asStudent = await call("/auth/me", { token: studentToken });
    const asStaff = await call("/auth/me", { token });

    // "timesheets" is a staff page and must not appear in a student's payload in any
    // form — neither as offered nor as withheld.
    assert.ok(!asStudent.body.app.functions.includes("timesheets"), "a student was told about a staff page");
    assert.ok(!("timesheets" in asStudent.body.app.labels), "a student was given a staff page's label");
    // And the student's own switched-off screen is absent from their payload.
    assert.ok(!asStudent.body.app.functions.includes("timetable"), "a switched-off student screen is still offered");

    // The staff payload is the mirror image: it carries the staff page (switched off,
    // so absent) and never the student screen.
    assert.ok(!asStaff.body.app.functions.includes("timesheets"), "a switched-off staff page is still offered to staff");
    assert.ok(!asStaff.body.app.functions.includes("timetable"), "the staff payload carried a student screen");

    // Put it back, so the staff-side assertion below starts from a clean college.
    const back = await call("/develop-app", { method: "PUT", token, body: { functions: {} } });
    assert.equal(back.status, 200, `restore failed: ${back.status}`);
    return "surfaces kept apart";
  });

  /* ======================================================== the staff side, likewise === */

  await check("a staff page switched off refuses the unrestricted admin who holds it", async () => {
    // /api/slc is `router.use(requireAuth, requirePage("slc"))`, and this account has
    // adminPages: null — full access to every page. It is also now a Super Admin, which
    // short-circuits every per-person check in hasPage. If the institution-wide toggle
    // did not combine with AND, this account would sail through.
    const before = await call("/slc", { token });
    assert.equal(before.status, 200, `control failed: expected 200 before, got ${before.status}`);

    const save = await call("/develop-app", {
      method: "PUT", token, body: { functions: { "staff:slc": false } },
    });
    assert.equal(save.status, 200, `save failed: ${save.status}`);

    const r = await call("/slc", { token });
    assert.equal(r.status, 403, `a switched-off staff page still answered: ${r.status}`);
    assert.equal(r.body.code, "FUNCTION_DISABLED", `expected FUNCTION_DISABLED, got ${r.body.code}`);
    return "403 FUNCTION_DISABLED even for a Super Admin";
  });

  await check("the Develop App screen itself cannot be switched off", async () => {
    // Not by refusing the request — there is simply nothing to refuse. "develop-app" is
    // not in the registry, so it cannot be named, which is what makes the lockout
    // impossible rather than merely guarded against. The save is accepted and the key
    // is dropped; what matters is that the screen still answers afterwards.
    const save = await call("/develop-app", {
      method: "PUT", token, body: { functions: { "staff:develop-app": false, "develop-app": false } },
    });
    assert.equal(save.status, 200, `save failed: ${save.status}`);
    const r = await call("/develop-app", { token });
    assert.equal(r.status, 200, "the Develop App screen switched itself off — this is a permanent lockout");
    return "still reachable";
  });

  /* ============================================================== what cannot be done === */

  await check("a locked screen cannot be switched off, however the request is written", async () => {
    // `student:more` holds Sign out. A college that could switch it off would leave its
    // students unable to leave their own session.
    const save = await call("/develop-app", {
      method: "PUT", token, body: { functions: { "student:more": false, "student:home": false } },
    });
    assert.equal(save.status, 200, `save failed: ${save.status}`);

    const r = await call("/develop-app", { token });
    const more = r.body.student.find((f) => f.key === "more");
    const home = r.body.student.find((f) => f.key === "home");
    assert.equal(more.enabled, true, "the More screen was switched off — a student cannot sign out");
    assert.equal(home.enabled, true, "the Home screen was switched off — back navigation has nowhere to land");
    assert.equal(more.locked, true, "More is not reported as locked, so the screen would offer the toggle");

    const me = await call("/student/me", { token: studentToken });
    assert.ok(me.body.app.functions.includes("more"), "the app was told it has no More screen");
    return "both still on, and reported locked";
  });

  await check("a function that does not exist is not stored", async () => {
    // A stale key — a function renamed in a later version, a tab left open across a
    // deploy — must not be able to re-open or close anything, and must not accumulate
    // in the row. Dropping it rather than rejecting the save is deliberate: one stale
    // key must not block every later edit on a screen with 45 toggles.
    const save = await call("/develop-app", {
      method: "PUT", token, body: { functions: { "student:no-such-screen": false, "nonsense": false } },
    });
    assert.equal(save.status, 200, `save failed: ${save.status}`);
    const stored = Object.keys(save.body.settings.functions);
    assert.ok(!stored.includes("student:no-such-screen"), "an unknown function id was stored");
    assert.ok(!stored.includes("nonsense"), "an unkeyed name was stored");
    return `stored keys: ${stored.length ? stored.join(", ") : "none"}`;
  });

  await check("a rename is stored, and clearing it reverts to our own wording", async () => {
    const r1 = await call("/develop-app", {
      method: "PUT", token, body: { labels: { "student:attendance": "  Attendance %  " } },
    });
    assert.equal(r1.body.settings.labels["student:attendance"], "Attendance %", "the label was not trimmed/stored");

    const me = await call("/student/me", { token: studentToken });
    assert.equal(me.body.app.labels.attendance, "Attendance %", "the app was not told the new wording");

    const r2 = await call("/develop-app", {
      method: "PUT", token, body: { labels: { "student:attendance": "   " } },
    });
    assert.ok(!("student:attendance" in r2.body.settings.labels), "an empty label was stored, so the rename cannot be undone");

    const back = await call("/student/me", { token: studentToken });
    assert.equal(back.body.app.labels.attendance, "My Attendance", "clearing the rename did not restore the default");
    return "set, then cleared";
  });

  await check("saving twice leaves one row, not two", async () => {
    // The constant-key single-row guarantee (configuration.md). Find-then-create is not
    // atomic, and two rows would make every later read a coin toss between them.
    await Promise.all([
      call("/develop-app", { method: "PUT", token, body: { functions: { "staff:kpi": false } } }),
      call("/develop-app", { method: "PUT", token, body: { functions: { "staff:slc": false } } }),
    ]);
    const rows = await db.appFunctionConfig.count();
    assert.equal(rows, 1, `expected exactly 1 config row, found ${rows}`);
    return "1 row";
  });

  /* =========================================================================== reset === */

  await check("reset restores every function and removes the row", async () => {
    const r = await call("/develop-app", { method: "DELETE", token });
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);

    const rows = await db.appFunctionConfig.count();
    assert.equal(rows, 0, `reset left ${rows} row(s) behind`);

    const after = await call("/develop-app", { token });
    assert.ok(after.body.staff.every((f) => f.enabled), "a staff page stayed off after a reset");
    assert.ok(after.body.student.every((f) => f.enabled), "a student screen stayed off after a reset");
    assert.equal(after.body.customised, false, "a reset college still reports itself customised");
    return "all 45 back on";
  });

  await check("and the APIs answer again", async () => {
    // The round trip closed. A toggle that switches off but not back on is a one-way
    // door, which is the failure a merge-on-save would have produced — see
    // appFunctionConfig.save on why the settings object is replaced, not merged.
    const slc = await call("/slc", { token });
    assert.equal(slc.status, 200, `the staff page did not come back: ${slc.status}`);
    const marks = await call("/student/me/assessments", { token: studentToken });
    assert.equal(marks.status, 200, `the student screen did not come back: ${marks.status}`);
    return "both 200 again";
  });

  await check("a second reset is not an error", async () => {
    // deleteMany, not delete: an administrator pressing Reset twice is not a failure,
    // and `delete` on a missing row throws P2025.
    const r = await call("/develop-app", { method: "DELETE", token });
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    assert.equal(r.body.reset, false, "a no-op reset reported that it had reset something");
    return "idempotent";
  });

} catch (e) {
  bad("the suite threw before it finished", e);
} finally {
  // Undo every row this suite touched, whatever happened above. A left-behind config row
  // would make the next suite start from a college that has switched features off, and a
  // left-behind Super Admin would make the "a plain admin is refused" assertion pass for
  // the wrong reason on the next run — the worst kind of residue, because it is invisible
  // and it makes a real test green.
  try { await db.appFunctionConfig.deleteMany({}); } catch { /* table may not exist */ }
  try { if (promoted) await db.staff.update({ where: { id: ADMIN_ID }, data: { isSuperAdmin: false } }); } catch { /* already gone */ }
  try { if (studentTouched) await db.student.update({ where: { id: STUDENT_ID }, data: { passwordHash: null } }); } catch { /* already gone */ }
  await db.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
