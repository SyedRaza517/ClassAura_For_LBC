// HOW EACH PRISMA MODEL IS SCOPED TO AN ACADEMIC DEPARTMENT.
//
// Three kinds, and every model in schema.prisma is exactly one of them:
//
//   "UNSCOPED"          — belongs to no department. A Semester, every config table, and
//                         for now every HR, admissions and pastoral table too.
//   { column: "…" }     — carries academicDepartmentId itself.
//   { via: "relation" } — reachable through an owner that carries it.
//
// A MODEL ABSENT FROM THIS MAP THROWS. That is the whole design. db.js records that the
// tenant guard's "fail-closed guard on unrecognised operations" was lost when it went,
// and that a Prisma upgrade adding an operation could then slip past unscoped. The same
// hazard applies to a MODEL added by a later migration: defaulting it to unscoped is a
// silent leak, so adding one is forced to be a decision. academicScopeModels.test.js
// diffs this map against the schema and fails in BOTH directions — an undeclared model
// is a leak, and a declared-but-deleted one is a dead rule nobody will notice.
//
// SPEC 1 SCOPES NOTHING IN PRACTICE. The migration marks every account college-wide, so
// scopePredicateFor returns null for everything and no row is filtered. The map is
// complete now anyway, because discovering seventy models' worth of decisions during
// spec 2 — the highest-risk slice — is exactly the wrong moment to be making them.
//
// HOW TO MOVE A MODEL OUT OF "UNSCOPED". Only in the spec that actually filters it, and
// only with a smoke assertion proving the filter works. A path declared here and never
// exercised is a claim nothing tests, which is worse than no claim at all.
const { AcademicScopeError } = require("./academicScope");

const MODEL_SCOPE = {
  /* ---- Carries the column itself ------------------------------------------ */
  Course: { column: "academicDepartmentId" },
  Student: { column: "academicDepartmentId" },

  /* ---- Reachable through an owner ----------------------------------------- */
  // Only the two spec 2 will filter first. Everything else stays UNSCOPED until the
  // slice that scopes it says otherwise.
  Enrolment: { via: "student" },
  AttendanceMark: { via: "student" },

  /* ---- Institution-wide: the institution itself --------------------------- */
  // Tenant survives as the single institution settings row rather than a registry, and
  // its integrations, branding and templates describe the college, not a department.
  Tenant: "UNSCOPED",
  TenantIntegration: "UNSCOPED",
  TenantBranding: "UNSCOPED",
  TenantDocTemplate: "UNSCOPED",
  TenantEmailTemplate: "UNSCOPED",
  AuditLog: "UNSCOPED",

  /* ---- Institution-wide: HR and identity ---------------------------------- */
  // Staff is UNSCOPED and MUST stay so through spec 1: requireAuth reads the staff row
  // to work out the scope, so a filtered Staff query would need a scope that does not
  // exist yet — the bootstrap would deadlock against its own guard. Spec 4 is what
  // scopes HR, and it will need an explicit bypass for exactly that read.
  Staff: "UNSCOPED",
  StaffAcademicDepartment: "UNSCOPED",
  DeviceToken: "UNSCOPED",
  PasswordReset: "UNSCOPED",
  SignupRequest: "UNSCOPED",
  Notification: "UNSCOPED",
  SentNotification: "UNSCOPED",
  CheckIn: "UNSCOPED",
  Leave: "UNSCOPED",
  Adjustment: "UNSCOPED",
  Document: "UNSCOPED",
  TimesheetEntry: "UNSCOPED",
  StaffReview: "UNSCOPED",

  /* ---- Institution-wide: the departments themselves ----------------------- */
  // Reading the department list must never be filtered by department membership, or a
  // scoped account could not be shown the name of the department it belongs to.
  AcademicDepartment: "UNSCOPED",

  /* ---- Institution-wide for now: curriculum ------------------------------- */
  // Cohort and Unit gain their own academicDepartmentId in spec 2, where they are first
  // filtered. Declared UNSCOPED here rather than given a `via` path that nothing tests.
  Semester: "UNSCOPED",
  Cohort: "UNSCOPED",
  Term: "UNSCOPED",
  Unit: "UNSCOPED",
  Assessment: "UNSCOPED",
  AssessmentGrade: "UNSCOPED",
  AssessmentSubmission: "UNSCOPED",
  AssessmentAdjustment: "UNSCOPED",
  HndSession: "UNSCOPED",
  StudentQuery: "UNSCOPED",
  Interaction: "UNSCOPED",
  StudentReview: "UNSCOPED",
  VleEngagement: "UNSCOPED",
  MoodleSync: "UNSCOPED",

  /* ---- Institution-wide for now: attendance hardware ---------------------- */
  AttendanceTag: "UNSCOPED",
  TagTap: "UNSCOPED",
  AttendanceTapConfig: "UNSCOPED",
  AttendanceEmailConfig: "UNSCOPED",
  AttendanceBandConfig: "UNSCOPED",

  /* ---- Institution-wide for now: timetabling ------------------------------ */
  TimetableSlot: "UNSCOPED",
  TermCalendar: "UNSCOPED",
  Room: "UNSCOPED",
  EventCategory: "UNSCOPED",
  TimetableEvent: "UNSCOPED",
  TimetableEventStaff: "UNSCOPED",
  TimetableEventGroup: "UNSCOPED",
  TimetableSettings: "UNSCOPED",
  TimetableUserPref: "UNSCOPED",

  /* ---- Institution-wide for now: admissions, funding ---------------------- */
  // Spec 3 scopes these, and it is NOT blocked. An earlier version of this comment said it
  // was -- that Admission and SlcApplication hold the student's name and typed college id
  // as plain strings, so matching on them would attach one student's record to another.
  // That was true when CLAUDE.md was written and is no longer true of the schema:
  // SlcApplication.student and Admission.linkedStudent are both real relations with
  // indexes, added by migration 20260828T230000_link_finance_to_student. Both can carry a
  // { via: … } whenever spec 3 runs. The stale note would have deferred spec 3 for a
  // reason that had already been fixed.
  Admission: "UNSCOPED",
  AdmissionDocument: "UNSCOPED",
  AdmissionCourse: "UNSCOPED",
  AdmissionIntake: "UNSCOPED",
  AdmissionTrackerSettings: "UNSCOPED",
  Ism: "UNSCOPED",
  SlcApplication: "UNSCOPED",

  /* ---- Institution-wide for now: prediction and pastoral ------------------ */
  // The prediction pipeline runs under withoutAcademicScope regardless: its cohort
  // standing and institution-wide probes are questions about the college, and CLAUDE.md
  // records that computing them from a subset is the most repeated bug in that area.
  PredictionModelSettings: "UNSCOPED",
  StudentPredictionCurrent: "UNSCOPED",
  StudentPredictionHistory: "UNSCOPED",
  Intervention: "UNSCOPED",
  StudentOutcome: "UNSCOPED",
  MitigatingCircumstance: "UNSCOPED",

  /* ---- Institution-wide, permanently: support referrals ------------------- */
  // These carry the OTHER department vocabulary — Wellbeing, ASK, Student Support — and
  // are confined by Staff.supportDepartments, a boundary that is deliberately not the
  // academic one. A wellbeing officer reads their queue across every teaching
  // department, and narrowing it academically would hide disclosures from the team the
  // student made them to.
  SupportDepartmentConfig: "UNSCOPED",
  Referral: "UNSCOPED",
  ReferralTransfer: "UNSCOPED",
  ReferralMessage: "UNSCOPED",
};

/**
 * The `where` fragment for one model under one scope, or null when nothing should be
 * added.
 *
 * Returns null — "do not filter" — in exactly two cases: the caller is college-wide, or
 * the model is declared UNSCOPED. It NEVER returns null because the caller has no
 * departments; that case returns `{ in: [] }`, which matches nothing. Collapsing those
 * two into one answer is precisely how an account narrowed off college-wide, but not yet
 * given a department, would silently be handed the entire college.
 */
function scopePredicateFor(model, scope) {
  const rule = MODEL_SCOPE[model];
  if (rule === undefined) {
    throw new AcademicScopeError(
      `Model "${model}" is not declared in academicScopeModels.js. Add it as "UNSCOPED", ` +
      `{ column: "academicDepartmentId" } or { via: "<relation>" } — a model must not ` +
      `default to unscoped.`,
    );
  }
  if (rule === "UNSCOPED") return null;

  if (!scope || typeof scope !== "object") {
    // db.js throws before it ever reaches here, but the two guards are independent and
    // this one must not be the weak half: reading a missing scope as "no predicate"
    // would make any future caller that skips the db.js check silently unscoped.
    throw new AcademicScopeError(`scopePredicateFor("${model}") needs a scope`);
  }
  if (scope.collegeWide) return null;

  const match = { in: scope.academicDepartmentIds || [] };
  if (rule.column) return { [rule.column]: match };
  return { [rule.via]: { academicDepartmentId: match } };
}

module.exports = { MODEL_SCOPE, scopePredicateFor };
