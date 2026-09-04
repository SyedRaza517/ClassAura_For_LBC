// The academic department scope guard — and, mostly, what it refuses.
//
// This suite exists because the decision it tests cannot be verified by reading the
// code. "requireAuth binds a scope" and "requireAuth ran" look identical in a log, and
// the difference between them is whether every authenticated request in the application
// throws. So the wiring is asserted over real HTTP against a real database.
//
// SIX OF THE SEVEN ASSERTIONS COME IN PAIRS, deliberately. A server that returns an
// empty list for everybody passes "a scoped account sees nothing" perfectly, and
// discriminates nothing — which is exactly why scripts/smoke-tenant-isolation.mjs was
// deleted rather than adapted when tenancy went. Every refusal here is followed by the
// permission that proves the refusal was a decision.
//
// THE GUARD IS APPLIED TO THIS SUITE'S OWN PRISMA CLIENT rather than by requiring
// server/src/db.js. That file constructs a client with no explicit datasource, so which
// database it reaches depends on env-loading precedence — and server/.env points at live
// Supabase. withAcademicScopeGuard() takes a client, so the suite hands it one built
// explicitly from DATABASE_URL and there is nothing to get subtly wrong.
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

console.log("\n=== academic department scope ===\n");

const admin = await call("/auth/login", { method: "POST", body: { email: ADMIN, password: PASSWORD } });
if (!admin.body.token) {
  console.log("✗ could not sign in as the seeded admin — is the API seeded?");
  console.log(JSON.stringify(admin.body).slice(0, 200));
  process.exit(1);
}
const adminToken = admin.body.token;

// Feature present at all? A build predating the migration has no AcademicDepartment
// table, and reporting seven failures would bury that one fact.
try {
  await db.academicDepartment.count();
} catch {
  console.log("SKIP — AcademicDepartment is not migrated in this build");
  await db.$disconnect();
  process.exit(2);
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

// Built here rather than added to prisma/seed.js. A fixture in the shared seed is a
// change to every other suite, which smoke-referrals.mjs already records the cost of.
const stamp = Date.now();
const business = await db.academicDepartment.create({ data: { key: `biz-${stamp}`, name: `Business ${stamp}` } });
const computing = await db.academicDepartment.create({ data: { key: `cmp-${stamp}`, name: `Computing ${stamp}` } });
const businessCourse = await db.course.create({ data: { name: `HND Business ${stamp}`, academicDepartmentId: business.id } });
const computingCourse = await db.course.create({ data: { name: `HND Computing ${stamp}`, academicDepartmentId: computing.id } });

// ONE EXTRA ACCOUNT, which starts college-wide exactly as the migration leaves every
// real account. It is narrowed mid-suite, because the state that matters — narrowed off
// college-wide, not yet given a department — does not exist in a freshly migrated
// college and cannot be reached by looking at one.
const narrowedEmail = `dept.narrowed.${stamp}@edtech.co.uk`;
const made = await call("/staff", { method: "POST", token: adminToken, body: { name: "Narrowed Tutor", email: narrowedEmail, password: "NarrowPass123!" } });
if (!made.body?.id) {
  console.log("✗ could not create the staff fixture");
  console.log(JSON.stringify(made.body).slice(0, 200));
  process.exit(1);
}
const narrowedId = made.body.id;
// The page grant and role go in directly, for the reason smoke-mitigations.mjs records.
// `registers` is what PUT /hnd/courses/:id requires, and assertion 7 needs that route.
await db.staff.update({
  where: { id: narrowedId },
  // collegeWide is deliberately NOT set here. Leaving it at the column default is what
  // lets the "a newly created staff account is college-wide by default" assertion below
  // test the default rather than test this line.
  data: { accountRole: "ADMIN", adminPages: JSON.stringify(["registers"]), mustChangePassword: false },
});
const narrowedLogin = await call("/auth/login", { method: "POST", body: { email: narrowedEmail, password: "NarrowPass123!" } });
const narrowedToken = narrowedLogin.body?.token;
if (!narrowedToken) { console.log("✗ could not sign in as the staff fixture"); process.exit(1); }

try {
  /* ------------------------------------------------------------------------ */
  /* 1-2. The guard fires with no scope bound, and only then                   */
  /* ------------------------------------------------------------------------ */

  const { withAcademicScopeGuard } = require(`${ROOT}/server/src/academicScopeGuard`);
  const { withoutAcademicScope, runWithAcademicScope } = require(`${ROOT}/server/src/academicScope`);
  const guarded = withAcademicScopeGuard(db);

  // Breaks if: the extension returns query(args) instead of throwing when currentScope()
  // is null. That is the fail-open db.js records as lost when the tenant guard went, and
  // the only thing that catches a background job nobody wrapped.
  await check("a departmental query with no bound scope throws", async () => {
    await assert.rejects(() => guarded.course.findMany(), /no academic scope bound/);
    return "AcademicScopeError";
  });

  // AN UNSCOPED MODEL NEEDS NO SCOPE, and this is not a nicety — it is what makes the
  // application boot. requireAuth reads Staff to work out what the scope IS, so demanding
  // a scope before that read completes deadlocks every request against the guard: the
  // 401 handler swallows the error and the whole college is signed out.
  //
  // It is also the difference between this guard and the tenant one db.js describes. That
  // one could demand a tenant for every query because every model had one. Most models
  // here belong to no department, and requiring a declaration for them would be the "tax
  // on writing anything outside a request" that db.js names as the old design's cost.
  await check("an unscoped model is readable with no scope bound at all", async () => {
    const rows = await guarded.semester.findMany();
    assert.ok(Array.isArray(rows), "expected an array");
    return `${rows.length} semester(s), no scope needed`;
  });

  // The control for the assertion above. Without it, a client that is simply broken
  // passes assertion 1 perfectly.
  await check("the same query succeeds inside a declared institution-wide scope", async () => {
    const rows = await withoutAcademicScope("smoke: control for the unscoped rejection", () => guarded.course.findMany());
    assert.ok(Array.isArray(rows), "expected an array of courses");
    return `${rows.length} course(s)`;
  });

  // Breaks if: the findUnique -> findFirst widening is removed. Asserted at the client
  // rather than only over HTTP because it is the mechanism, and assertion 7 below is the
  // same rule reached through a real route.
  await check("findUnique cannot cross the boundary", async () => {
    const seen = await runWithAcademicScope({ academicDepartmentIds: [business.id], collegeWide: false },
      () => guarded.course.findUnique({ where: { id: computingCourse.id } }));
    assert.equal(seen, null, "a Business scope reached a Computing course by id");
    const own = await runWithAcademicScope({ academicDepartmentIds: [business.id], collegeWide: false },
      () => guarded.course.findUnique({ where: { id: businessCourse.id } }));
    assert.ok(own, "a Business scope could not reach its OWN course, so the test proves nothing");
    return "null for the other department, the row for its own";
  });

  /* ------------------------------------------------------------------------ */
  /* 3-4. requireAuth binds a scope, and college-wide still sees everything    */
  /* ------------------------------------------------------------------------ */

  // Breaks if: requireAuth calls next() without runWithAcademicScope. Asserted over HTTP
  // rather than by reading the file, because the failure mode is "the middleware ran but
  // bound nothing" — invisible to grep, and a 500 on every authenticated read.
  await check("an authenticated request reaches its handler with a scope bound", async () => {
    const res = await call("/hnd/courses", { token: adminToken });
    assert.equal(res.status, 200, `expected 200, got ${res.status} — ${JSON.stringify(res.body).slice(0, 200)}`);
    return "200";
  });

  // A NEWLY CREATED ACCOUNT IS COLLEGE-WIDE UNTIL SOMEBODY NARROWS IT.
  //
  // Breaks if: Staff.collegeWide defaults to false. The migration set the flag on every
  // account that existed WHEN IT RAN, which says nothing about accounts created after —
  // and a college in spec 1 has no departments at all, so a new tutor defaulting to
  // "scoped" would see no students, no courses and no registers, with no screen
  // explaining why. The whole foundation spec promises no behaviour change.
  //
  // Fail-open at the account level, exactly as adminPages already is: NULL there means
  // "never configured -> full access, so existing admins are not locked out". Narrowing
  // is the deliberate act; the Departments screen's "N of M staff have college-wide
  // access" line is what stops it being silent.
  await check("a newly created staff account is college-wide by default", async () => {
    const fresh = await db.staff.findUnique({ where: { id: narrowedId }, select: { collegeWide: true } });
    assert.equal(fresh.collegeWide, true, "a new account was created scoped-to-nothing");
    return "collegeWide";
  });

  // Breaks if: scopeForStaff ignores collegeWide, or the extension applies a predicate to
  // a wide scope. THIS IS THE ASSERTION THAT PROVES SPEC 1 IS INERT — every account is
  // college-wide, so nothing may be filtered for anybody yet.
  await check("a college-wide admin sees courses from every department", async () => {
    const res = await call("/hnd/courses", { token: adminToken });
    const ids = (res.body || []).map((c) => c.id);
    assert.ok(ids.includes(businessCourse.id), "the Business course is missing");
    assert.ok(ids.includes(computingCourse.id), "the Computing course is missing");
    return `${ids.length} course(s), both departments present`;
  });

  /* ------------------------------------------------------------------------ */
  /* 5-7. A narrowed account: nothing, then its own, then refused the other    */
  /* ------------------------------------------------------------------------ */

  // Breaks if: scopePredicateFor returns null for an empty id list, or scopeForStaff
  // defaults a missing flag to true. The single most dangerous state in the design.
  //
  // NO RE-LOGIN. The token carries only the subject and a version; requireAuth re-reads
  // the staff row on every request, so an access change takes effect immediately. That
  // is a property worth having and this is where it is demonstrated.
  await check("an account narrowed off college-wide with no departments sees no courses", async () => {
    await db.staff.update({ where: { id: narrowedId }, data: { collegeWide: false } });
    const res = await call("/hnd/courses", { token: narrowedToken });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    assert.equal((res.body || []).length, 0, `expected no courses, got ${(res.body || []).length}`);
    return "0 courses";
  });

  // The control for the assertion above. Without it, a server returning [] for everyone
  // passes assertion 5 and discriminates nothing.
  await check("the same account sees exactly its own department once granted one", async () => {
    await db.staffAcademicDepartment.create({ data: { staffId: narrowedId, academicDepartmentId: business.id } });
    const res = await call("/hnd/courses", { token: narrowedToken });
    const ids = (res.body || []).map((c) => c.id);
    assert.deepEqual(ids, [businessCourse.id], `expected only the Business course, got ${ids.length}`);
    return "1 course, the right one";
  });

  // Breaks if: the widening is removed. By ID through a real route, not by list — a build
  // that filters lists correctly while findUnique does not passes assertions 5 and 6
  // straight through.
  await check("a Business-scoped admin gets 404 renaming a Computing course by id", async () => {
    const res = await call(`/hnd/courses/${computingCourse.id}`, { method: "PUT", token: narrowedToken, body: { name: `Hijacked ${stamp}` } });
    assert.equal(res.status, 404, `expected 404, got ${res.status} — ${JSON.stringify(res.body).slice(0, 200)}`);
    const still = await db.course.findUnique({ where: { id: computingCourse.id } });
    assert.equal(still.name, `HND Computing ${stamp}`, "the course was renamed despite the 404");
    return "404, and the row is untouched";
  });

  // The control: the same route, the same account, its OWN course. Without this, a route
  // that 404s on everything passes the assertion above.
  await check("...and can still rename its own department's course", async () => {
    const res = await call(`/hnd/courses/${businessCourse.id}`, { method: "PUT", token: narrowedToken, body: { name: `HND Business Renamed ${stamp}` } });
    assert.equal(res.status, 200, `expected 200, got ${res.status} — ${JSON.stringify(res.body).slice(0, 200)}`);
    return "200";
  });
} finally {
  /* -------------------------------------------------------------------------- */
  /* Cleanup — in a finally, so a failed run leaves no scoped account behind      */
  /* -------------------------------------------------------------------------- */
  // A half-cleaned run would leave the next suite with a staff account that is NOT
  // college-wide, in a college where every other account is — which would look like a
  // bug in whatever suite ran next rather than a mess left by this one.
  await db.staffAcademicDepartment.deleteMany({ where: { staffId: narrowedId } }).catch(() => {});
  await db.staff.deleteMany({ where: { email: narrowedEmail } }).catch(() => {});
  await db.course.deleteMany({ where: { id: { in: [businessCourse.id, computingCourse.id] } } }).catch(() => {});
  await db.academicDepartment.deleteMany({ where: { id: { in: [business.id, computing.id] } } }).catch(() => {});
  await db.$disconnect();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
