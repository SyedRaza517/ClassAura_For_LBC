// WHICH ACADEMIC DEPARTMENTS THE CURRENT CALLER MAY SEE, held for the life of a request.
//
// WHY THIS EXISTS AT ALL, given that this project deleted machinery of exactly this
// shape. Until 30 Aug 2026 db.js scoped every query by tenantId and threw when a query
// had no tenant. That went because the product became one deployment per college, so
// isolation moved into the infrastructure, which is the stronger place for it. This is
// NOT that coming back, and the differences are the reason:
//
//   * It is one institution, not many. Nothing here spans customers, so no amount of
//     forgetting can leak one college's data into another's.
//   * It is PARTIAL. A Semester belongs to no department. Declaring that per model is
//     the whole point of academicScopeModels.js; a blanket extension would be wrong.
//   * It has a designed all-access role (Staff.collegeWide). Tenancy deliberately had
//     none, which is why crossTenant() had to exist as an escape hatch bolted on beside.
//
// WHY AsyncLocalStorage RATHER THAN A PARAMETER. 21 of the 47 routers apply requireAuth
// per HANDLER, not per router, so there is no single seam to thread an argument through.
// Passing it explicitly means ~275 handlers each remembering, and the one that forgets
// fails OPEN and silently. db.js states the same conclusion for the same reason:
// "Rather than ask ~200 endpoints to remember a filter, the client itself refused."
//
// WHY THERE IS NO runInAcademicDepartment(). The tax db.js names for the old design was
// that "every scheduler, script and tool had to name the institution it meant". Work
// outside a request does not name a department here — it declares that it is
// institution-wide, once, with a reason, via withoutAcademicScope(). That keeps the
// widening loud and greppable without making ordinary background code carry an id.
const { AsyncLocalStorage } = require("node:async_hooks");

class AcademicScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = "AcademicScopeError";
  }
}

const storage = new AsyncLocalStorage();

/** The scope bound to the current async context, or null if there is none. */
function currentScope() {
  return storage.getStore() || null;
}

function assertScopeShape(scope) {
  if (!scope || typeof scope !== "object") {
    throw new AcademicScopeError("An academic scope must be an object");
  }
  if (!Array.isArray(scope.academicDepartmentIds)) {
    throw new AcademicScopeError("academicDepartmentIds must be an array");
  }
  if (typeof scope.collegeWide !== "boolean") {
    throw new AcademicScopeError("collegeWide must be a boolean");
  }
}

/**
 * Run `fn` with `scope` bound. The scope survives every await inside `fn`.
 *
 * The shape is asserted rather than coerced. A malformed scope silently becoming "see
 * nothing" or "see everything" are both wrong, and only one of them is safe — so neither
 * is guessed at.
 */
function runWithAcademicScope(scope, fn) {
  assertScopeShape(scope);
  // AWAITED INSIDE THE CONTEXT, not handed back as a promise. See runInside().
  return storage.run(scope, () => runInside(fn));
}

/**
 * Call `fn` and, if it returns a thenable, await it — all inside the caller's
 * AsyncLocalStorage context.
 *
 * PRISMA'S PROMISES ARE LAZY: `prisma.course.findMany()` does not run when it is called,
 * it runs when something awaits it. So `storage.run(scope, () => prisma.course.findMany())`
 * returns an unexecuted promise OUT of the scope, and the query then runs after the
 * context has exited — with no scope bound, throwing, in exactly the code path the guard
 * exists to protect.
 *
 * That is the most natural way to write the call. It reads correctly and it silently does
 * the wrong thing, which is the worst combination available. Awaiting here makes the
 * obvious spelling the correct one; academicScope.test.js has two tests holding this in
 * place with a deliberately lazy thenable.
 *
 * A synchronous `fn` still runs synchronously — it is invoked before the first await —
 * so a caller like requireAuth's `() => next()` is unaffected.
 */
async function runInside(fn) {
  return await fn();
}

/**
 * Run `fn` as institution-wide, saying why.
 *
 * For schedulers, the prediction runner, the VLE sync and any other work that has no
 * caller and legitimately spans every department. The prediction pipeline in particular
 * MUST run this way: CLAUDE.md records that computing its institution-wide probes from a
 * subset is the most repeated bug in that area — got wrong three times — and departmental
 * scoping must not narrow them.
 *
 * `reason` is mandatory, and the body does not run without one. It is the entire audit
 * trail for a deliberate widening, and an unnamed widening is indistinguishable from a
 * forgotten one. It also makes every such site greppable, which is what keeps this from
 * quietly becoming the default it replaced.
 */
function withoutAcademicScope(reason, fn) {
  const why = typeof reason === "string" ? reason.trim() : "";
  if (!why) {
    // Rejected rather than thrown so every caller can await it uniformly, and rejected
    // BEFORE fn is invoked — widening the query and then reporting the error afterwards
    // would be worse than not checking at all.
    return Promise.reject(new AcademicScopeError(
      "withoutAcademicScope requires a reason saying why this work is institution-wide",
    ));
  }
  // Awaited inside the context for the lazy-promise reason runInside() explains. This is
  // the entry point background work uses, and background work is precisely where the
  // natural spelling — withoutAcademicScope("why", () => prisma.x.findMany()) — is
  // written, so it is the one that most needs to be safe.
  return storage.run({ academicDepartmentIds: [], collegeWide: true, reason: why }, () => runInside(fn));
}

/**
 * The scope for a student's or applicant's request.
 *
 * College-wide, and that is not a widening. Their tokens reach only STUDENT_ROUTERS /
 * APPLICANT_ROUTERS, and every query in those routers is already narrowed to their own
 * id — the router allowlist is what confines them, not the departmental boundary. Binding
 * this says so explicitly, and keeps the guard's "no scope bound" error meaning exactly
 * one thing: a bug.
 *
 * Frozen because it is a single shared object bound on every such request. One handler
 * mutating it would silently change the scope of every other request in the process.
 */
const CONFINED_BY_ROUTER = Object.freeze({
  academicDepartmentIds: Object.freeze([]),
  collegeWide: true,
});

/**
 * The scope for a signed-in member of staff.
 *
 * PURE, AND SEPARATE FROM requireAuth ON PURPOSE. This answers the most dangerous
 * question in the feature — does this account see everything? — and as a pure function
 * every case is assertable without booting a server: college-wide, scoped with
 * memberships, scoped with none, a missing flag, a truthy non-boolean flag, and a row
 * whose `include` somebody dropped.
 *
 * @param {{collegeWide?: unknown, academicDepartments?: Array<{academicDepartmentId: string}>}} staff
 */
function scopeForStaff(staff) {
  if (!staff || typeof staff !== "object") {
    throw new AcademicScopeError("scopeForStaff needs a staff row");
  }
  if (!Array.isArray(staff.academicDepartments)) {
    // UNDEFINED IS NOT EMPTY. If a later edit drops the `include` from requireAuth's
    // findUnique, the memberships arrive undefined — and quietly reading that as
    // "belongs to no department" would scope every member of staff in the college to
    // nothing. That looks like a data problem and is actually a one-line code bug, so it
    // fails loudly instead of plausibly.
    throw new AcademicScopeError(
      "scopeForStaff needs the academicDepartments relation — the query that loaded this " +
      "staff row is missing its include",
    );
  }
  return {
    academicDepartmentIds: staff.academicDepartments.map((m) => m.academicDepartmentId),
    // `=== true`, not truthiness. serializers.js states the rule this follows, for
    // parseAdminPages: "An admin who suddenly has no pages is a loud, safe failure; an
    // admin who suddenly has all of them is a silent, dangerous one."
    collegeWide: staff.collegeWide === true,
  };
}

module.exports = {
  AcademicScopeError,
  runWithAcademicScope, withoutAcademicScope, currentScope,
  scopeForStaff, CONFINED_BY_ROUTER,
};
