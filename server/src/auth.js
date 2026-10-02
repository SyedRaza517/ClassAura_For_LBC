// JWT + password helpers and Express middleware for auth / roles.
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const prisma = require("./db");
const { sStaff, sStudent, sApplicant } = require("./serializers");
const { runWithAcademicScope, withoutAcademicScope, currentScope, scopeForStaff, CONFINED_BY_ROUTER } = require("./academicScope");

// In production a real secret MUST be provided — never silently fall back to a
// publicly-known string (that would let anyone forge an admin token). That rule now lives
// in sessionSecret.js because the QR check-in signing key derives from the same secret,
// and the rule must not exist twice. Resolved at import, exactly as before, so a
// production process still refuses to start without one.
const { sessionSecret } = require("./sessionSecret");
const SECRET = sessionSecret();

// The short-TTL identity cache under requireAuth's per-request account lookup. The
// long WHY — why in-process is right here, what is and is not cached, exactly how
// stale it is allowed to be and for whom — lives at the top of identityCache.js.
// Every route that mutates a row's auth-relevant state calls
// identityCache.invalidate(kind, id) at the write, which is what keeps a 30-second
// cache from ever honouring a revoked session for those mutations.
const { identityCache } = require("./identityCache");

// Resolve the caller's row: cached if we have it, one (coalesced) database read if
// not. `passes` is this request's own validity check — token version, active flag,
// has-a-password — and it earns the cache its correctness backstop:
//
// A CACHED row that fails the check is never allowed to reject the request on its
// own. The cached copy might simply be older than the change that made this token
// valid — the classic case is change-password, where the caller's NEW token carries
// the bumped version and a stale row would 401 the very session the route just
// blessed. So: drop the entry, read fresh, and judge on the truth. The cost is one
// database read on a path that was headed for rejection anyway — exactly what every
// request cost before the cache — and it means a missed invalidation point can only
// ever cause one redundant read, never a wrong acceptance of a fresh token's
// rejection. (The reverse direction — a stale row wrongly ACCEPTING a revoked
// token — is what the invalidation calls at every mutating route are for; a check
// that passes gives this function no signal that anything changed.)
//
// The fresh row is cached whether or not it passes: it is the current truth, and
// caching it means a replayed dead token costs a Map hit, not a read, until TTL.
async function loadCallerRow(kind, id, loader, passes) {
  const cached = identityCache.get(kind, id);
  if (cached !== undefined && passes(cached)) return cached;
  if (cached !== undefined) identityCache.invalidate(kind, id);
  return identityCache.load(kind, id, loader);
}

// ASYNC, AND THAT IS THE POINT — both return Promises and every caller must await.
//
// These were bcrypt.hashSync / bcrypt.compareSync. bcryptjs is pure JavaScript, so a
// cost-10 hash or compare is ~80-100ms of arithmetic, and the Sync variants run all of
// it ON the event loop thread: while one person's password was being checked, every
// other request in the process — every register scan, every QR check-in — sat frozen.
// On Render's free plan (a fraction of one CPU) that stretched to hundreds of ms per
// login, and a burst of sign-ins serialised the whole API behind bcrypt. The async
// bcryptjs API (promise-returning when no callback is given) does the same arithmetic
// in small chunks yielded through setImmediate, so other requests interleave between
// chunks. The CPU cost per login is unchanged; the difference is that nobody else's
// request stops while it is paid.
//
// Native `bcrypt` (the compiled addon) was considered and REJECTED: it would move the
// work off-thread entirely, which is strictly better, but it swaps a pure-JS dependency
// for one that must compile on every deploy target — a Render build that has never
// needed a toolchain would suddenly depend on one, and a failed native build takes
// logins down with it. bcryptjs async already removes the event-loop blocking, which
// was the actual problem. The hash FORMAT is identical either way ($2a$/$2b$), so
// every stored hash keeps verifying; cost stays 10 for the same reason.
const hashPassword = (pw) => bcrypt.hash(pw, 10);
const verifyPassword = (pw, hash) => bcrypt.compare(pw, hash);
// purpose distinguishes a real session from the short-lived two-factor challenge
// token issued between the password step and the authenticator step. Both are
// signed with the same secret, so requireAuth MUST check this — otherwise a
// correct password alone would be enough to call the API and the second factor
// would be worthless.
// ver carries the staff row's tokenVersion. Bumping that column invalidates every
// token already issued for the account — the revocation a password reset needs.
// Session lifetime, configurable via JWT_EXPIRES (e.g. "8h", "1d", "7d").
// Shorter = tighter security, more frequent re-authentication. Default 1 day.
const EXPIRES = process.env.JWT_EXPIRES || "1d";
const signToken = (staff) => jwt.sign({ sub: staff.id, kind: "staff", role: staff.accountRole, purpose: "session", ver: staff.tokenVersion ?? 0 }, SECRET, { expiresIn: EXPIRES });
// A student session token. kind:"student" routes requireAuth down the student path.
const signStudentToken = (student) => jwt.sign({ sub: student.id, kind: "student", purpose: "session", ver: student.tokenVersion ?? 0 }, SECRET, { expiresIn: EXPIRES });
// An applicant session token. kind:"applicant" routes requireAuth down the applicant path
// (a prospective student tracking their own Admission record).
const signApplicantToken = (applicant) => jwt.sign({ sub: applicant.id, kind: "applicant", purpose: "session", ver: applicant.tokenVersion ?? 0 }, SECRET, { expiresIn: EXPIRES });

// The ONLY routers a student session may reach.
//   /api/student  — their own data, every route scoped to req.user.id
//   /api/auth     — /me, /change-password and /account, each of which branches on
//                   req.user.kind === "student" before it touches a staff table
//   /api/devices  — register/unregister a push token for THIS device. Added after
//                   the 12 Sep survey found the student app already asking for push
//                   permission on first launch, with nowhere for the granted token
//                   to go: DeviceToken had no studentId column and every write in
//                   devices.js assumed req.user was staff, so a student who said yes
//                   to the permission prompt had that token silently discarded and
//                   could never be sent a push. Task 1 gave DeviceToken a nullable
//                   studentId; devices.js now branches on req.user.kind and scopes
//                   every route to req.user.id exactly as /api/student does, so this
//                   is the same shape of allowlist entry as the other two.
// Nothing else. See the check in requireAuth below.
const STUDENT_ROUTERS = ["/api/student", "/api/auth", "/api/devices"];
// The ONLY routers an applicant session may reach — same isolation idea as students.
//   /api/applicant — their own Admission (register is public; everything else scoped to req.user.id)
//   /api/auth      — /login and /change-password, which branch on kind before touching a staff table
const APPLICANT_ROUTERS = ["/api/applicant", "/api/auth"];

/**
 * Bind `scope` for the rest of the request, and make sure the promise cannot escape.
 *
 * requireAuth previously returned undefined; it now returns whatever runWithAcademicScope
 * returns. index.js states the hazard plainly: "an async middleware that rejects becomes
 * an unhandled rejection rather than a 500" -- i.e. process death, the outage that
 * asyncRoutes.js exists to prevent. And wrapAsync only patches `layer.route.stack`, so a
 * requireAuth mounted with router.use (26 of the 47 routers do) is not covered by it.
 *
 * In practice next() returns undefined synchronously and Express's own Layer.handle_request
 * converts a downstream synchronous throw into next(err) before it could reach here, so
 * there is nothing to reject today. This is insurance against that stopping being true:
 * any rejection is handed to Express's error middleware instead of to the process.
 */
function bindScope(scope, next) {
  return runWithAcademicScope(scope, () => next()).catch(next);
}

// Attaches req.user = { id, accountRole, ...publicStaff } when a valid Bearer token is present.
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing token" });
    const payload = jwt.verify(token, SECRET);
    // Reject anything that is not a full session — notably the "mfa" challenge
    // token, which is only valid at the /auth/totp/* endpoints. Tokens issued
    // before this field existed have no purpose at all, so treat only an explicit
    // non-session purpose as a rejection.
    if (payload.purpose && payload.purpose !== "session") return res.status(401).json({ error: "Invalid token" });

    // A `tid` claim used to pin a session to one institution, because a token
    // issued by college A could otherwise be replayed against college B just by
    // changing the X-Tenant header. One deployment now serves one college and there
    // is no header to change, so the claim is neither issued nor checked.
    //
    // It is IGNORED rather than rejected, deliberately. Every session in the wild at
    // the moment of this deploy carries a tid, and treating its presence as invalid
    // would sign out every member of staff and every student at once, mid-term, for
    // a change that is invisible to them.

    // Student session — a fully isolated path. The staff branch below is unchanged,
    // so nothing about existing staff/admin auth is affected.
    if (payload.kind === "student") {
      // A student token may reach ONLY these three routers. Every other one — staff,
      // hnd, leave, assessments, timesheets, documents, adjustments, moodle,
      // staff-reviews, student-reviews, passwords, my-reviews, interactions,
      // notifications, signup, student-queries — is off-limits. (Notifications
      // themselves are not off-limits to a student — /api/student/me/notifications
      // is exactly that — it is the STAFF notifications router, /api/notifications,
      // that stays closed; a student's own notifications are read through
      // /api/student like everything else that belongs to them.)
      //
      // An ALLOWLIST, deliberately: a router added tomorrow is closed to students
      // without anyone remembering to close it. This single check is what keeps
      // students out of every staff and admin surface regardless of each route's own
      // guards, so it is the one line in the file most worth not breaking.
      if (!STUDENT_ROUTERS.includes(req.baseUrl)) {
        return res.status(403).json({ error: "Not available for student accounts" });
      }
      // RESOLVING THE ACCOUNT IS WHAT PRODUCES THE SCOPE, so it cannot require one.
      //
      // Student is a departmental model, and this read runs before any scope is bound --
      // requiring one would be circular, the guard would throw, and the catch below would
      // turn it into a 401 that signed out every student in the college. Staff avoids
      // this only by being declared UNSCOPED; the student path arrives at the same
      // problem from the other side and says so explicitly instead.
      //
      // Deliberately narrow: the lookup alone, not the branch, so nothing downstream
      // inherits an institution-wide scope. The real scope is bound three lines below.
      //
      // Cached via loadCallerRow: the cache get/set are synchronous Map operations
      // with no scope of their own, so only the actual Prisma read needs (and gets)
      // the withoutAcademicScope wrapper — a cache hit touches no scoped model at all.
      const student = await loadCallerRow(
        "student", payload.sub,
        () => withoutAcademicScope(
          "auth: resolving the student account, which is what produces the scope",
          () => prisma.student.findUnique({ where: { id: payload.sub } }),
        ),
        (s) => Boolean(s && s.passwordHash && s.active !== false && (payload.ver ?? 0) === (s.tokenVersion ?? 0)),
      );
      if (!student || !student.passwordHash || student.active === false) return res.status(401).json({ error: "Invalid token" });
      if ((payload.ver ?? 0) !== (student.tokenVersion ?? 0)) return res.status(401).json({ error: "Session expired — please sign in again" });
      req.user = { id: student.id, kind: "student", isStudent: true, ...sStudent(student) };
      // A student's token reaches ONLY STUDENT_ROUTERS, and every query in those routers
      // is already narrowed to their own id. Binding CONFINED_BY_ROUTER is therefore not
      // a widening: it says the departmental boundary is not what confines this caller,
      // which is true, and it keeps the guard's "no scope bound" error meaning exactly
      // one thing -- a bug -- rather than sometimes meaning "a student".
      return bindScope(CONFINED_BY_ROUTER, next);
    }

    // Applicant session — a prospective student tracking their own admission. Isolated to
    // /api/applicant + /api/auth by the allowlist, exactly like the student path above.
    if (payload.kind === "applicant") {
      if (!APPLICANT_ROUTERS.includes(req.baseUrl)) {
        return res.status(403).json({ error: "Not available for applicant accounts" });
      }
      const applicant = await loadCallerRow(
        "applicant", payload.sub,
        () => prisma.admission.findUnique({ where: { id: payload.sub } }),
        (a) => Boolean(a && a.passwordHash && a.active !== false && (payload.ver ?? 0) === (a.tokenVersion ?? 0)),
      );
      if (!applicant || !applicant.passwordHash || applicant.active === false) return res.status(401).json({ error: "Invalid token" });
      if ((payload.ver ?? 0) !== (applicant.tokenVersion ?? 0)) return res.status(401).json({ error: "Session expired — please sign in again" });
      req.user = { id: applicant.id, kind: "applicant", isApplicant: true, ...sApplicant(applicant) };
      // Same reasoning as the student branch above, with APPLICANT_ROUTERS as the fence.
      return bindScope(CONFINED_BY_ROUTER, next);
    }

    // THE MEMBERSHIPS ARE LOADED HERE, and here is the only place they can be. 41 of the
    // 43 routers apply requireAuth per HANDLER rather than per router, so there is no
    // later middleware seam guaranteed to run on every authenticated request.
    //
    // This read itself runs before any scope exists, which is why Staff is declared
    // UNSCOPED in academicScopeModels.js and must stay so through spec 1 -- a filtered
    // Staff query would need the scope this very query is being made to compute.
    // Cached WITH the memberships include — the point of the cache is to store
    // exactly what this lookup returned, so a hit hands scopeForStaff the same
    // shape a fresh read would, membership rows and all. Membership changes go
    // through PUT /api/academic-departments/staff/:staffId, which invalidates.
    const staff = await loadCallerRow(
      "staff", payload.sub,
      () => prisma.staff.findUnique({
        where: { id: payload.sub },
        include: { academicDepartments: { select: { academicDepartmentId: true } } },
      }),
      (s) => Boolean(s && (payload.ver ?? 0) === (s.tokenVersion ?? 0)),
    );
    if (!staff) return res.status(401).json({ error: "Invalid token" });
    // Tokens issued before the last password reset/change are dead. Tokens minted
    // before this field existed carry no `ver`, which reads as 0 and still matches
    // an account that has never bumped it.
    if ((payload.ver ?? 0) !== (staff.tokenVersion ?? 0)) return res.status(401).json({ error: "Session expired — please sign in again" });
    req.user = { id: staff.id, kind: "staff", accountRole: staff.accountRole, ...sStaff(staff) };
    // Bind the scope for the REST OF THE REQUEST. Everything downstream of next() runs
    // inside this context, including async handlers and the Prisma calls they await.
    //
    // scopeForStaff is a pure function in academicScope.js rather than inline here, so
    // the question it answers -- does this account see everything? -- is assertable in a
    // unit test instead of only by booting the server and reading a list.
    return bindScope(scopeForStaff(staff), next);
  } catch (e) {
    // A BAD TOKEN AND A BROKEN DATABASE ARE DIFFERENT ANSWERS.
    //
    // This `try` spans the jwt.verify AND the staff/student/applicant lookups, so every
    // failure came back as 401 "Invalid or expired token" — including a database outage.
    // The client reads that as "your session ended" and signs the user out, so a
    // transient infrastructure fault logged out every member of staff and every student
    // in the college at once, and the logs recorded it as a wave of bad tokens rather
    // than as the outage it was.
    //
    // jwt.verify throws named errors for the cases that really are the caller's fault;
    // anything else is ours, and 503 says so without inviting a sign-out. Logged too,
    // because a 401 needs no explanation and this does.
    if (e?.name === "JsonWebTokenError" || e?.name === "TokenExpiredError" || e?.name === "NotBeforeError") {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    console.error("[auth] could not resolve the account for a valid token:", e?.message || e);
    return res.status(503).json({ error: "Sign-in is temporarily unavailable. Please try again shortly." });
  }
}

// One definition of "this is a student", used by every guard below so they cannot
// drift apart. Two independent markers, both set by requireAuth's student branch.
const isStudent = (user) => user?.kind === "student" || user?.isStudent === true;

function requireAdmin(req, res, next) {
  if (isStudent(req.user)) return res.status(403).json({ error: "Not available for student accounts" });
  if (req.user?.accountRole !== "ADMIN") return res.status(403).json({ error: "Admin access required" });
  next();
}

// Guard a student-only endpoint. Staff/admin tokens are rejected here, just as a
// student token is rejected by requireAdmin/requireAnyPage — the two worlds don't
// cross.
function requireStudent(req, res, next) {
  if (req.user?.kind !== "student") return res.status(403).json({ error: "Student access required" });
  next();
}

// One definition of "this is an applicant", and the guard for the applicant router.
const isApplicant = (user) => user?.kind === "applicant" || user?.isApplicant === true;
function requireApplicant(req, res, next) {
  if (req.user?.kind !== "applicant") return res.status(403).json({ error: "Applicant access required" });
  next();
}

// Only the Super Admin — used to guard the access-management endpoints.
function requireSuperAdmin(req, res, next) {
  if (isStudent(req.user)) return res.status(403).json({ error: "Not available for student accounts" });
  if (!req.user?.isSuperAdmin) return res.status(403).json({ error: "Super Admin access required" });
  next();
}

/**
 * Guard an action that is institution-wide BY ITS NATURE, whoever starts it.
 *
 * The departmental guard narrows what a query READS. It cannot narrow a JOB: the monthly
 * attendance letters, a Moodle sync, a Teams run all declare themselves institution-wide
 * with withoutAcademicScope(), correctly, because a scheduler starting them at 02:00 has
 * no department. But the same function behind a button meant an admin narrowed to
 * Business could press "Run" and write to every student in the college -- the guard was
 * never asked, because the job had already told it not to be.
 *
 * Narrowing the job to the caller's departments was the rejected alternative. A monthly
 * letter run that sends to Business only would still mark the month as done
 * (lastRunPeriod) for everyone, and a Moodle sync cannot be partial: it walks one VLE and
 * adopts courses by name before it knows their department. A job that is one thing
 * should be started by someone who can see all of it.
 *
 * `what` names the action in the refusal, so the person reading it knows which button
 * they cannot use and why, rather than meeting a bare 403. `code` lets the client tell
 * this refusal apart from a missing page grant.
 *
 * Staff only. Students and applicants are bound CONFINED_BY_ROUTER, which is collegeWide
 * true, so checking the scope alone would wave them through any router that forgot its
 * own staff check.
 */
function requireCollegeWide(what) {
  return (req, res, next) => {
    if (req.user?.kind !== "staff" || currentScope()?.collegeWide !== true) {
      return res.status(403).json({
        error: `${what} covers the whole college, so it needs college-wide access. Your account is limited to particular departments -- ask a Super Admin if you need this.`,
        code: "COLLEGE_WIDE_REQUIRED",
      });
    }
    next();
  };
}

// Guard an admin-only endpoint by admin-dashboard page(s). The Super Admin always
// passes. A regular admin passes if their adminPages is null (never configured →
// full access, so existing admins aren't locked out) or includes at least one of
// the given page keys. Non-admins are rejected. Supersedes requireAdmin on the
// routes it's applied to (it already enforces the ADMIN role).
function requireAnyPage(pages) {
  const wanted = Array.isArray(pages) ? pages : [pages];
  return (req, res, next) => {
    if (isStudent(req.user)) return res.status(403).json({ error: "Not available for student accounts" });
    if (hasPage(req.user, wanted)) return next();
    if (req.user?.accountRole !== "ADMIN" && !req.user?.isSuperAdmin) return res.status(403).json({ error: "Admin access required" });
    return res.status(403).json({ error: "You don't have access to this section" });
  };
}
const requirePage = (page) => requireAnyPage([page]);

// The same rule as requireAnyPage, but as a plain predicate for routes that serve
// BOTH the signed-in user's own data and (for a privileged admin) everyone's. Those
// routes previously widened on `accountRole === "ADMIN"` alone — but granting ANY
// page makes an account an ADMIN, so a page-scoped admin could read/modify sections
// they were never granted. Gate the "see everyone" branch on this instead.
// PAGES THAT AN UNCONFIGURED ADMIN DOES NOT GET.
//
// `adminPages: null` means "nobody has configured grants at this college", and it grants
// everything — which is right, because a college that has never touched the screen must
// not find its administrators locked out of the product.
//
// That default stops being right the moment a page holds data of a different KIND.
// `mitigations` carries UK GDPR Article 9 health data: illness, bereavement, mental
// health, pregnancy. Adding it to ADMIN_PAGES under the old rule meant that at every
// college which has never configured grants, EVERY existing admin silently gained read
// access to it the moment this deployed. Nobody would have made that decision; the grant
// would have arrived with a migration.
//
// So it is explicit-grant-only. This is not a new idea — `access` is already handled the
// same way on the client (`canAccessPage`), for the same reason: some pages are too
// consequential to arrive by default.
//
// THIS CANNOT LOCK A COLLEGE OUT. isSuperAdmin short-circuits above, so a super admin
// always reaches the page and is exactly who would grant it to somebody else.
//
// Semantics: an unconfigured admin holds every page EXCEPT these, so a requireAnyPage
// check that also names an ordinary page still passes on the strength of that one.
const EXPLICIT_ONLY = new Set(["mitigations"]);

function hasPage(user, pages) {
  if (!user) return false;
  // A student NEVER holds an admin page. This is already true incidentally — sStudent
  // sets no accountRole — but it is stated explicitly and FIRST, because the
  // isSuperAdmin short-circuit below runs before the role check, so anything that ever
  // put a truthy isSuperAdmin on a student object would sail straight past it.
  // Isolation this important should not rest on a field simply being absent.
  if (isStudent(user)) return false;
  if (user.isSuperAdmin) return true;
  if (user.accountRole !== "ADMIN") return false;
  const wanted = Array.isArray(pages) ? pages : [pages];
  const allowed = user.adminPages; // null = unconfigured = full access, EXCEPT below
  if (allowed == null) return wanted.some((p) => !EXPLICIT_ONLY.has(p));
  return wanted.some((p) => allowed.includes(p));
}

// May `actor` (req.user) act ON this staff row — edit it, delete it, reset its
// password, strip its second factor, re-send its invitation?
//
// RANK, not merely "is the target the Super Admin". The previous guard protected
// exactly one row, which left every OTHER administrator open to takeover by any
// colleague holding a single narrow page:
//
//   • an admin with only "passwords" could PUT /api/passwords/staff/<anyAdmin> and
//     own that account outright, in one request;
//   • an admin with only "staff" could strip a colleague admin's 2FA, repoint their
//     email at their own inbox, and run a password reset.
//
// Either way they inherit every page that account holds. The rule is therefore: you
// may only act on an account whose authority your own already covers.
function outranks(actor, target) {
  if (!actor || !target) return false;
  if (actor.id === target.id) return true;                 // acting on yourself
  if (actor.isSuperAdmin) return true;                     // the Super Admin outranks all
  if (target.isSuperAdmin) return false;                   // and only they outrank one
  if (target.accountRole !== "ADMIN") return true;         // a plain staff member
  // Both are admins. The actor must hold every page the target holds.
  const actorPages = actor.adminPages;                     // already parsed by sStaff; null = unrestricted
  if (actorPages == null) return true;                     // unrestricted actor covers anything
  const { parseAdminPages } = require("./serializers");
  const targetPages = parseAdminPages(target.adminPages);  // raw DB row, still a JSON string
  if (targetPages == null) return false;                   // target unrestricted, actor is not
  return targetPages.every((p) => actorPages.includes(p));
}

// Express-friendly wrapper: returns an error MESSAGE when the action is refused, or
// null when it is allowed — matching how the staff routes already read.
function blockedByRank(actor, target) {
  if (outranks(actor, target)) return null;
  if (target?.isSuperAdmin) return "Only a Super Admin can change or remove the Super Admin account";
  return "You can't change an administrator whose access is broader than your own";
}

module.exports = { hashPassword, verifyPassword, signToken, signStudentToken, signApplicantToken, requireAuth, requireAdmin, requireStudent, requireApplicant, requireSuperAdmin, requireCollegeWide, requirePage, requireAnyPage, hasPage, isStudent, isApplicant, outranks, blockedByRank, STUDENT_ROUTERS, APPLICANT_ROUTERS, SECRET, EXPLICIT_ONLY};
