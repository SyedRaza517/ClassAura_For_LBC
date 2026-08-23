// JWT + password helpers and Express middleware for auth / roles.
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const prisma = require("./db");
const { sStaff, sStudent, sApplicant } = require("./serializers");

// In production a real secret MUST be provided — never silently fall back to a
// publicly-known string (that would let anyone forge an admin token).
const SECRET = process.env.JWT_SECRET || (
  process.env.NODE_ENV === "production"
    ? (() => { throw new Error("JWT_SECRET environment variable must be set in production"); })()
    : "dev-only-change-me"
);

const hashPassword = (pw) => bcrypt.hashSync(pw, 10);
const verifyPassword = (pw, hash) => bcrypt.compareSync(pw, hash);
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
const signToken = (staff) => jwt.sign({ sub: staff.id, kind: "staff", role: staff.accountRole, purpose: "session", ver: staff.tokenVersion ?? 0, tid: staff.tenantId }, SECRET, { expiresIn: EXPIRES });
// A student session token. kind:"student" routes requireAuth down the student path.
const signStudentToken = (student) => jwt.sign({ sub: student.id, kind: "student", purpose: "session", ver: student.tokenVersion ?? 0, tid: student.tenantId }, SECRET, { expiresIn: EXPIRES });
// An applicant session token. kind:"applicant" routes requireAuth down the applicant path
// (a prospective student tracking their own Admission record).
const signApplicantToken = (applicant) => jwt.sign({ sub: applicant.id, kind: "applicant", purpose: "session", ver: applicant.tokenVersion ?? 0, tid: applicant.tenantId }, SECRET, { expiresIn: EXPIRES });

// The ONLY routers a student session may reach.
//   /api/student  — their own data, every route scoped to req.user.id
//   /api/auth     — /me, /change-password and /account, each of which branches on
//                   req.user.kind === "student" before it touches a staff table
// Nothing else. See the check in requireAuth below.
const STUDENT_ROUTERS = ["/api/student", "/api/auth"];
// The ONLY routers an applicant session may reach — same isolation idea as students.
//   /api/applicant — their own Admission (register is public; everything else scoped to req.user.id)
//   /api/auth      — /login and /change-password, which branch on kind before touching a staff table
const APPLICANT_ROUTERS = ["/api/applicant", "/api/auth"];

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

    // A session belongs to ONE institution. Without this, a token issued by college
    // A could be presented against college B just by changing the X-Tenant header:
    // the signature is valid, the account exists, and every query would then run in
    // B's scope. Tokens minted before tenancy carry no tid and are still accepted,
    // so upgrading does not sign everyone out.
    if (payload.tid && req.tenant && payload.tid !== req.tenant.id) {
      return res.status(401).json({ error: "Session does not belong to this institution" });
    }

    // Student session — a fully isolated path. The staff branch below is unchanged,
    // so nothing about existing staff/admin auth is affected.
    if (payload.kind === "student") {
      // A student token may reach ONLY these two routers. Every other one — staff,
      // hnd, leave, assessments, timesheets, documents, adjustments, moodle,
      // staff-reviews, student-reviews, passwords, my-reviews, interactions,
      // notifications, devices, signup, student-queries — is off-limits.
      //
      // An ALLOWLIST, deliberately: a router added tomorrow is closed to students
      // without anyone remembering to close it. This single check is what keeps
      // students out of every staff and admin surface regardless of each route's own
      // guards, so it is the one line in the file most worth not breaking.
      if (!STUDENT_ROUTERS.includes(req.baseUrl)) {
        return res.status(403).json({ error: "Not available for student accounts" });
      }
      const student = await prisma.student.findUnique({ where: { id: payload.sub } });
      if (!student || !student.passwordHash || student.active === false) return res.status(401).json({ error: "Invalid token" });
      if ((payload.ver ?? 0) !== (student.tokenVersion ?? 0)) return res.status(401).json({ error: "Session expired — please sign in again" });
      req.user = { id: student.id, kind: "student", isStudent: true, ...sStudent(student) };
      return next();
    }

    // Applicant session — a prospective student tracking their own admission. Isolated to
    // /api/applicant + /api/auth by the allowlist, exactly like the student path above.
    if (payload.kind === "applicant") {
      if (!APPLICANT_ROUTERS.includes(req.baseUrl)) {
        return res.status(403).json({ error: "Not available for applicant accounts" });
      }
      const applicant = await prisma.admission.findUnique({ where: { id: payload.sub } });
      if (!applicant || !applicant.passwordHash || applicant.active === false) return res.status(401).json({ error: "Invalid token" });
      if ((payload.ver ?? 0) !== (applicant.tokenVersion ?? 0)) return res.status(401).json({ error: "Session expired — please sign in again" });
      req.user = { id: applicant.id, kind: "applicant", isApplicant: true, ...sApplicant(applicant) };
      return next();
    }

    const staff = await prisma.staff.findUnique({ where: { id: payload.sub } });
    if (!staff) return res.status(401).json({ error: "Invalid token" });
    // Tokens issued before the last password reset/change are dead. Tokens minted
    // before this field existed carry no `ver`, which reads as 0 and still matches
    // an account that has never bumped it.
    if ((payload.ver ?? 0) !== (staff.tokenVersion ?? 0)) return res.status(401).json({ error: "Session expired — please sign in again" });
    req.user = { id: staff.id, kind: "staff", accountRole: staff.accountRole, ...sStaff(staff) };
    next();
  } catch (e) {
    res.status(401).json({ error: "Invalid or expired token" });
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
  const allowed = user.adminPages; // null = unconfigured = full access
  if (allowed == null) return true;
  const wanted = Array.isArray(pages) ? pages : [pages];
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

module.exports = { hashPassword, verifyPassword, signToken, signStudentToken, signApplicantToken, requireAuth, requireAdmin, requireStudent, requireApplicant, requireSuperAdmin, requirePage, requireAnyPage, hasPage, isStudent, isApplicant, outranks, blockedByRank, STUDENT_ROUTERS, APPLICANT_ROUTERS, SECRET };
