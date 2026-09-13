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

  /* ---- Student-owned: everything hanging off one student -------------------- */
  // Declared in spec 2. Each has a top-level listing route, and scoping the model closes
  // BOTH that route and every nested include reading a Student through it -- which is the
  // leak that stopped spec 1. See scripts/smoke-academic-nested-reads.mjs.
  //
  // The prediction models are declared for the ROUTES that read them. The pipeline that
  // WRITES them runs under withoutAcademicScope and is unaffected: CLAUDE.md records that
  // computing its institution-wide probes from a subset is the most repeated bug in that
  // area, got wrong three times.
  StudentPredictionCurrent: { via: "student" },
  StudentPredictionHistory: { via: "student" },
  Intervention: { via: "student" },
  StudentOutcome: { via: "student" },
  Interaction: { via: "student" },
  StudentQuery: { via: "student" },
  StudentReview: { via: "student" },
  // A behaviour/merit event is a pastoral record of one student, so it follows the
  // student's own department exactly as the interaction and review beside it do.
  ConductEvent: { via: "student" },
  AssessmentGrade: { via: "student" },
  AssessmentSubmission: { via: "student" },
  VleEngagement: { via: "student" },
  // Article 9 health data. routes/mitigations.js carries a confidentiality split of its own
  // that this boundary must not weaken or duplicate -- read its header before touching that
  // route.
  MitigatingCircumstance: { via: "student" },
  // TAGTAP CANNOT BE SCOPED THROUGH A RELATION, because it does not have one.
  //
  // `studentId` is a bare column with no Prisma relation, and the model's own comment says
  // why: a refused tap has no student AND no staff -- "an unknown code matches nothing, a
  // retired sticker is filtered out, a rate-limited tap never reaches the lookup" -- so a
  // required foreign key made the three outcomes an administrator is most often asked about
  // literally unwritable. Declaring { via: "student" } does not filter, it THROWS: Prisma
  // rejects `student` as an unknown argument. Found by running the whole suite scoped, which
  // is the branch nothing had ever executed.
  //
  // Left UNSCOPED rather than given a relation, because the relation is precisely what was
  // deliberately removed. The residual exposure is real and small: an admin holding the
  // attendance-tags page reads a diagnostic log of tap OUTCOMES carrying student ids, with
  // no name, no email and no mark. Scoping it properly needs either a denormalised column on
  // TagTap or a nullable relation that does not resurrect the unwritable-refusal bug, and
  // that is a decision for whoever next touches this model.
  TagTap: "UNSCOPED",

  /* ---- Curriculum: reached through the columns spec 2 added ------------------ */
  // Unit and Cohort carry the column themselves, which is what makes every path here a
  // SINGLE hop. `via` resolves one hop and needs the related model to hold the column, so
  // HndSession { via: "unit" } threw rather than filtered until Unit had one.
  Unit: { column: "academicDepartmentId" },
  Cohort: { column: "academicDepartmentId" },
  HndSession: { via: "unit" },
  Assessment: { via: "unit" },
  Term: { via: "cohort" },
  TimetableEventGroup: { via: "cohort" },
  TermCalendar: { via: "course" },

  /* ---- Timetable: null means SHOWN TO EVERYONE ------------------------------- */
  // THE ONE INVERSION IN THE FEATURE, and it is on the models whose own schema comments say
  // they deliberately carry sessions that are not units -- "Academic Skills Workshop",
  // "Study Support". Scoped by their OWN column rather than through the course, so a null is
  // a decision somebody took rather than a course that happens to be missing.
  //
  // `{ column }` emits { academicDepartmentId: { in: ids } }, which EXCLUDES nulls and would
  // delete every workshop from a departmental tutor's timetable. `columnOrNull` is the kind
  // that lets them through.
  TimetableSlot: { columnOrNull: "academicDepartmentId" },
  TimetableEvent: { columnOrNull: "academicDepartmentId" },

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
  // The sender's own record of what they told a class (routes/announcements.js). Read
  // only ever scoped by senderId — the sender's identity, not a department — and the
  // delivery rows are Notifications, already classified above.
  Announcement: "UNSCOPED",
  // Configuration, like every other constant-key table above.
  ConductVocabularyConfig: "UNSCOPED",
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
  AssessmentAdjustment: "UNSCOPED",
  MoodleSync: "UNSCOPED",
  // A sync run log, same shape as MoodleSync directly above: no relation to a student or
  // a department, just a record of a run. Its `issues` JSON can name a student by email
  // in prose -- "no match for jane.doe@example.ac.uk" -- rather than through a column
  // Prisma could scope on, which is the same residual-exposure shape TagTap's comment
  // describes for its diagnostic log above: real but small, and confined by the route
  // rather than this map, because only a settings-page admin (college-wide, by
  // definition) ever reads a sync log.
  TeamsSync: "UNSCOPED",
  // Same run-log reasoning as TeamsSync directly above, for the meeting/provisioning
  // automations instead of the attendance sync.
  TeamsProvisionSync: "UNSCOPED",
  // Provisioning metadata: which Microsoft group/channel a cohort/unit was mapped to.
  // Reachable through Cohort/Unit, both of which already carry academicDepartmentId,
  // but declared UNSCOPED rather than `via` because nothing filters it yet — only
  // teamsProvisioning.js reads these rows, running college-wide like every other sync
  // job, and a `via` path with no smoke assertion behind it is exactly the "claim
  // nothing tests" this file's header warns against.
  CohortTeam: "UNSCOPED",
  UnitChannel: "UNSCOPED",

  /* ---- Institution-wide for now: attendance hardware ---------------------- */
  AttendanceTag: "UNSCOPED",
  AttendanceTapConfig: "UNSCOPED",
  AttendanceEmailConfig: "UNSCOPED",
  AttendanceBandConfig: "UNSCOPED",
  // A singleton config table, same shape as the three directly above: one settings row
  // for the whole institution, no academicDepartmentId column and nothing to reach one
  // through. Every config table in this file is UNSCOPED for that reason -- a college's
  // switches and thresholds describe the college, not a department within it.
  TeamsAttendanceConfig: "UNSCOPED",
  // Config table, same reasoning as TeamsAttendanceConfig directly above: one
  // settings row for the whole institution, switching on the meeting/provisioning
  // automations rather than the attendance sync.
  TeamsAutomationConfig: "UNSCOPED",

  /* ---- Institution-wide for now: timetabling ------------------------------ */
  Room: "UNSCOPED",
  // A campus is a building, not a department. Two departments teach in the same one and
  // neither owns it, so there is no department to scope it by — the same reasoning as
  // Room directly above, which it is the parent of.
  Campus: "UNSCOPED",
  EventCategory: "UNSCOPED",
  TimetableEventStaff: "UNSCOPED",
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
  // SHOWN TO EVERYONE WHEN NULL. The only kind in this map that lets a row through on the
  // ABSENCE of a department, and it exists for exactly two models -- see their declaration
  // above for why a workshop must not vanish from a departmental tutor's timetable.
  if (rule.columnOrNull) {
    return { OR: [{ [rule.columnOrNull]: match }, { [rule.columnOrNull]: null }] };
  }
  if (rule.column) return { [rule.column]: match };

  // `is:` RATHER THAN A BARE NESTED OBJECT, and it is not stylistic. Prisma REFUSES
  // `{ relation: { field: … } }` for an OPTIONAL to-one relation and demands `is` — so
  // an optional to-one relation, which several models here have.
  // nobody, threw PrismaClientValidationError on every scoped read rather than filtering.
  // `is` is also valid for a required relation, so one form covers both and there is no
  // per-model decision to get wrong.
  //
  // A NULL relation does not match `is`, which is the fail-closed answer we want here: an
  // unmatched tap is an administrative diagnostic, visible to college-wide accounts only.
  return { [rule.via]: { is: { academicDepartmentId: match } } };
}

module.exports = { MODEL_SCOPE, scopePredicateFor };
