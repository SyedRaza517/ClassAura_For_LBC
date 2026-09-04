// The request-scoped holder for "which academic departments may this caller see", and
// the pure function that decides it from a staff row.
//
// No database, no Express. Run with: node --test src/academicScope.test.js (from server/)
//
// WHY ASYNCLOCALSTORAGE AND NOT A PARAMETER. 21 of the 47 routers apply requireAuth per
// HANDLER rather than per router, so there is no single middleware seam to thread a
// scope argument through, and ~275 handlers would each have to remember to pass it. A
// handler that forgets fails OPEN and silently. db.js records this exact reasoning for
// the tenant era: "Rather than ask ~200 endpoints to remember a filter, the client
// itself refused."
//
// WHY scopeForStaff IS A SEPARATE PURE FUNCTION. It answers the single most dangerous
// question in this feature — does this account see everything? — and as a pure function
// every answer can be asserted here in milliseconds instead of by booting a server and
// reading a list. requireAuth is then plumbing, and the plumbing is what the smoke suite
// exercises.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  runWithAcademicScope, withoutAcademicScope, currentScope, scopeForStaff,
  CONFINED_BY_ROUTER, AcademicScopeError,
} = require("./academicScope");

/* -------------------------------------------------------------------------- */
/* The holder                                                                  */
/* -------------------------------------------------------------------------- */

test("currentScope is null outside any scope", () => {
  assert.equal(currentScope(), null);
});

test("runWithAcademicScope makes the scope readable inside, and only inside", () => {
  const scope = { academicDepartmentIds: ["a", "b"], collegeWide: false };
  runWithAcademicScope(scope, () => {
    assert.deepEqual(currentScope(), scope);
  });
  assert.equal(currentScope(), null);
});

test("the scope survives an await", async () => {
  // The whole point: a handler that awaits a Prisma call must still be inside its scope
  // when the query is finally issued. Without this, the guard would fire on every
  // asynchronous route in the application.
  await runWithAcademicScope({ academicDepartmentIds: ["a"], collegeWide: false }, async () => {
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(currentScope().academicDepartmentIds, ["a"]);
  });
});

test("nested scopes do not leak outward", async () => {
  await runWithAcademicScope({ academicDepartmentIds: ["outer"], collegeWide: false }, async () => {
    await runWithAcademicScope({ academicDepartmentIds: ["inner"], collegeWide: false }, async () => {
      assert.deepEqual(currentScope().academicDepartmentIds, ["inner"]);
    });
    assert.deepEqual(currentScope().academicDepartmentIds, ["outer"]);
  });
});

test("runWithAcademicScope rejects a malformed scope rather than coercing it", () => {
  // A scope object that is wrong in shape must not silently become "see nothing" or
  // "see everything". Both are wrong answers and only one of them is safe, so neither is
  // guessed at.
  for (const bad of [null, undefined, {}, { collegeWide: false }, { academicDepartmentIds: "a", collegeWide: false }, { academicDepartmentIds: [], collegeWide: "yes" }]) {
    assert.throws(() => runWithAcademicScope(bad, () => {}), AcademicScopeError, `should reject ${JSON.stringify(bad)}`);
  }
});

/* -------------------------------------------------------------------------- */
/* withoutAcademicScope — the declared widening                                */
/* -------------------------------------------------------------------------- */

test("withoutAcademicScope grants college-wide and records why", async () => {
  await withoutAcademicScope("prediction: institution-wide probes", async () => {
    assert.equal(currentScope().collegeWide, true);
    assert.deepEqual(currentScope().academicDepartmentIds, []);
    assert.equal(currentScope().reason, "prediction: institution-wide probes");
  });
});

test("withoutAcademicScope refuses to run without a reason", async () => {
  // The reason is the entire audit trail for a deliberate widening. An unnamed one is
  // indistinguishable from a forgotten one, and greppability is the only thing keeping
  // this from becoming the silent default it replaced.
  for (const bad of ["", "   ", null, undefined, 7]) {
    await assert.rejects(
      () => withoutAcademicScope(bad, async () => {}),
      (e) => e instanceof AcademicScopeError && /reason/i.test(e.message),
      `should reject reason ${JSON.stringify(bad)}`,
    );
  }
});

test("withoutAcademicScope does not run the body when the reason is missing", async () => {
  // Rejecting while still running the work would be worse than not checking at all: the
  // query goes out institution-wide and the error arrives afterwards.
  let ran = false;
  await assert.rejects(() => withoutAcademicScope("", async () => { ran = true; }));
  assert.equal(ran, false);
});

/* -------------------------------------------------------------------------- */
/* The lazy-promise trap                                                       */
/* -------------------------------------------------------------------------- */

// PRISMA'S PROMISES ARE LAZY. `prisma.course.findMany()` does not run when it is called;
// it runs when something awaits it. So a callback shaped
//
//     withoutAcademicScope("why", () => prisma.course.findMany())
//
// returns an unexecuted promise OUT of the scope, and the query then runs after the
// context has exited — with no scope bound, throwing, in the one code path the widening
// exists to protect. It is the most natural way to write the call, it type-checks, it
// reads correctly, and it silently does the wrong thing.
//
// Both entry points therefore await inside the context rather than handing the promise
// back. These two tests are what stop that being quietly removed as redundant.
const lazyScopeReader = () => ({
  then(resolve) { resolve(currentScope()); },
});

test("withoutAcademicScope awaits inside the scope, so a lazy promise still sees it", async () => {
  const seen = await withoutAcademicScope("lazy promise", lazyScopeReader);
  assert.ok(seen, "the scope had already exited by the time the promise ran");
  assert.equal(seen.collegeWide, true);
});

test("runWithAcademicScope awaits inside the scope, so a lazy promise still sees it", async () => {
  const seen = await runWithAcademicScope({ academicDepartmentIds: ["d1"], collegeWide: false }, lazyScopeReader);
  assert.ok(seen, "the scope had already exited by the time the promise ran");
  assert.deepEqual(seen.academicDepartmentIds, ["d1"]);
});

/* -------------------------------------------------------------------------- */
/* scopeForStaff — the security decision, isolated                             */
/* -------------------------------------------------------------------------- */

test("a college-wide staff member gets a college-wide scope", () => {
  const scope = scopeForStaff({ collegeWide: true, academicDepartments: [] });
  assert.equal(scope.collegeWide, true);
});

test("a scoped staff member gets exactly their membership ids", () => {
  const scope = scopeForStaff({
    collegeWide: false,
    academicDepartments: [{ academicDepartmentId: "d1" }, { academicDepartmentId: "d2" }],
  });
  assert.equal(scope.collegeWide, false);
  assert.deepEqual(scope.academicDepartmentIds, ["d1", "d2"]);
});

test("a staff member with NO departments and no college-wide flag sees nothing", () => {
  // The single most dangerous state in the design: narrowed off college-wide but not yet
  // given a department. An empty id list must survive all the way to the query as an
  // empty list — it is scopePredicateFor's job to turn it into "matches nothing", and it
  // cannot do that if this function has already collapsed it into something else.
  const scope = scopeForStaff({ collegeWide: false, academicDepartments: [] });
  assert.equal(scope.collegeWide, false);
  assert.deepEqual(scope.academicDepartmentIds, []);
});

test("collegeWide fails CLOSED for anything that is not exactly true", () => {
  // `=== true`, not truthiness. parseAdminPages in serializers.js states the rule this
  // follows: "An admin who suddenly has no pages is a loud, safe failure; an admin who
  // suddenly has all of them is a silent, dangerous one." A column read back as 1, "true"
  // or null must not grant the whole college.
  for (const bad of [1, "true", "yes", {}, undefined, null]) {
    assert.equal(
      scopeForStaff({ collegeWide: bad, academicDepartments: [] }).collegeWide, false,
      `collegeWide: ${JSON.stringify(bad)} must not grant college-wide access`,
    );
  }
});

test("a staff row whose include was forgotten throws rather than being scoped to nothing", () => {
  // requireAuth must load academicDepartments. If a later edit drops the include, the
  // memberships are UNDEFINED, not empty — and quietly treating that as "belongs to no
  // department" would scope every member of staff in the college to nothing, which looks
  // like a data problem and is actually a one-line code bug. Loud beats plausible.
  assert.throws(() => scopeForStaff({ collegeWide: false }), AcademicScopeError);
  assert.throws(() => scopeForStaff({ collegeWide: false, academicDepartments: null }), AcademicScopeError);
  assert.throws(() => scopeForStaff(null), AcademicScopeError);
});

test("the scope scopeForStaff returns is accepted by runWithAcademicScope", () => {
  // The two functions have to agree on the shape. Asserting the keys by hand here would
  // pass while the real handshake was broken.
  const scope = scopeForStaff({ collegeWide: false, academicDepartments: [{ academicDepartmentId: "d1" }] });
  runWithAcademicScope(scope, () => {
    assert.deepEqual(currentScope().academicDepartmentIds, ["d1"]);
  });
});

/* -------------------------------------------------------------------------- */
/* CONFINED_BY_ROUTER — students and applicants                                */
/* -------------------------------------------------------------------------- */

test("CONFINED_BY_ROUTER is a valid college-wide scope", () => {
  // A student's token reaches only STUDENT_ROUTERS and every query there is already
  // narrowed to their own id, so the departmental boundary is not what confines them.
  // Binding this keeps "no scope bound" meaning exactly one thing: a bug.
  assert.equal(CONFINED_BY_ROUTER.collegeWide, true);
  runWithAcademicScope(CONFINED_BY_ROUTER, () => {
    assert.equal(currentScope().collegeWide, true);
  });
});

test("CONFINED_BY_ROUTER survives an attempt to mutate it", () => {
  // It is a single shared object bound on every student and applicant request. One
  // handler mutating it would silently change the scope of every other request in the
  // process — including, if collegeWide were flipped, turning every student request into
  // a scoped one and emptying their timetable.
  //
  // The assertion is on the VALUE, not on a thrown TypeError. Assigning to a frozen
  // property throws only under "use strict", which is a property of whichever module
  // attempts the write, not of this one — so asserting the throw would be testing the
  // caller's strict mode rather than our invariant. What we guarantee is that the value
  // does not change, and that holds either way.
  try { CONFINED_BY_ROUTER.collegeWide = false; } catch { /* strict-mode callers throw */ }
  try { CONFINED_BY_ROUTER.academicDepartmentIds.push("x"); } catch { /* frozen array */ }
  assert.equal(CONFINED_BY_ROUTER.collegeWide, true);
  assert.deepEqual(CONFINED_BY_ROUTER.academicDepartmentIds, []);
});
