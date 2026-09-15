// HND attendance registers — units, students, enrolments, sessions, marks.
// Reads require a signed-in user; every mutation is admin-only, matching the
// rest of the admin console.
const router = require("express").Router();
const prisma = require("../db");
// requireAuth caches student identity rows (see identityCache.js). The student edit,
// delete and group-move writes below change fields that cached copy carries — most
// critically `active`, which is this platform's student suspension switch — so each
// drops the affected entries when it commits.
const { identityCache } = require("../identityCache");
// THE RAW SQL IN THIS FILE USED TO CARRY A TENANT PREDICATE, AND NO LONGER DOES.
//
// One database served every college, and $queryRaw bypassed the isolation extension in
// db.js entirely — that hooked $allModels, while $queryRaw is a client-level method
// that never reached it. So every raw query here scoped itself by hand, through a
// requireTenant() helper that threw rather than let a query span customers.
//
// One deployment now serves one institution and its own database, so there is no other
// college's rows for these aggregates to reach: `SELECT ... FROM "AttendanceMark"` is
// this college's attendance by construction. The tenant predicates are gone rather than
// defaulted to a resolved id, because a predicate that is always true reads as a
// working guard to the next person and would be the thing they trusted.
//
// AND THEN A PREDICATE CAME BACK, ON 4 SEP 2026 -- A DEPARTMENTAL ONE.
//
// The prediction of the paragraph above turned out to be exactly right, one boundary
// early. These aggregates are still the queries NOT protected by anything the ORM does:
// academicScopeGuard.js hooks $allModels, and $queryRawUnsafe is a client-level method
// that never reaches it. So each of the four raw queries in this file now appends a
// predicate by hand, from academicScopeSql.js, whose helper THROWS when no scope is bound
// for precisely the reason stated above.
//
// TWO SHAPES, because these queries reach a department two different ways. A mark belongs
// to a student, and Student carries academicDepartmentId -- scopedStudentJoin. A SESSION
// has no student at all (a scheduled class whose register may be empty), so it goes through
// its unit -- scopedUnitJoin.
//
// Both are ONE join since spec 2. The session path used to go Unit -> Course, so the two
// shapes reached a department by two different definitions and could disagree: a unit could
// render with populated marks beside a session count of zero on the same screen. Unit
// carries the column now, so there is one definition.
//
// THE JOIN IS OMITTED ENTIRELY FOR A COLLEGE-WIDE CALLER, and that is deliberate rather
// than an optimisation. An INNER JOIN drops rows whose foreign key is null, and
// Unit.courseId is nullable -- so always joining would quietly change the session counts
// for everybody, in a spec whose whole promise is that nothing changes.
const { sSemester, sCourse, sCohort, sTerm, sUnit, sStudent, sSession, sMark } = require("../serializers");
const { rosterForSession, unitStudentCounts, unitTeachingContext } = require("../timetabling/registers");
const { deriveRoster, enrolmentIsAuthoritativeFor } = require("../timetabling/roster");
const { requireAuth, requireAnyPage, hasPage, isStudent } = require("../auth");
const audit = require("../audit");
const { scopedStudentJoin, scopedUnitJoin } = require("../academicScopeSql");
const academicDepartments = require("../academicDepartments");
const { currentScope } = require("../academicScope");

/**
 * Turn ?academicDepartmentId= into a `where` fragment.
 *
 * A FILTER, NOT A BOUNDARY, and the distinction is the whole reason this is separate from
 * the scope guard. Scoping is enforced by the server and confines an account; this is a
 * view the caller chooses and it grants nothing — a college-wide admin filtering to
 * Business sees Business, and clearing the filter shows everything again.
 *
 * Three cases, and the third is the one an administrator actually needs. The Settings
 * screen reports "N students are not assigned to a department"; without `none` there is no
 * way to see WHICH, and the count is a number nobody can act on.
 *
 *   omitted        -> {}                              everything
 *   "none"         -> { academicDepartmentId: null }   not yet assigned
 *   an id          -> { academicDepartmentId: id }     that department
 *
 * An UNRECOGNISED id is passed through as itself and simply matches nothing. It is not
 * ignored: a filter that silently dropped a value it did not recognise would show the whole
 * college under a department heading, which is the failure worth avoiding here.
 */
function academicDepartmentFilter(raw) {
  const v = str(raw);
  if (!v) return {};
  if (v === "none") return { academicDepartmentId: null };
  return { academicDepartmentId: v };
}

/**
 * Validate a submitted academicDepartmentId.
 *
 * An unknown id is REJECTED rather than dropped: silently ignoring it leaves the screen
 * showing an assignment that was never made, which is worse than an error somebody can
 * act on. A non-string that is not null is refused rather than coerced -- coercion is what
 * turned a numeric id into a silent un-assign on the VLE mapping route.
 *
 * @returns {{id: string|null}|{error: string}}
 */
/**
 * The department a child of a course belongs to: the course's own.
 *
 * A unit or a cohort created under a Business course IS Business. Leaving it null makes it
 * visible only to college-wide accounts — so a scoped admin adds a unit to their own course
 * and it disappears, taking every session, enrolment and mark built on it with it. Found by
 * running the suite as a scoped account.
 *
 * Inherited from the COURSE rather than defaulted from the caller, because the course is the
 * better answer: it is right even when a college-wide admin creates the unit.
 */
/**
 * The caller's own department, when that is unambiguous — otherwise null.
 *
 * Exactly one department and not college-wide. An account on two has not said which it
 * meant, and a college-wide account creating an unassigned row is doing something
 * legitimate: that is how a row waiting to be sorted is expressed.
 */
function callerDepartmentId() {
  const scope = currentScope();
  if (scope && !scope.collegeWide && scope.academicDepartmentIds.length === 1) {
    return scope.academicDepartmentIds[0];
  }
  return null;
}

async function departmentOfCourse(courseId) {
  if (!courseId) return null;
  const c = await prisma.course.findUnique({
    where: { id: courseId }, select: { academicDepartmentId: true },
  });
  return c?.academicDepartmentId ?? null;
}

async function resolveAcademicDepartment(raw, { defaultForCaller = false } = {}) {
  if (raw === undefined || raw === null || raw === "") {
    // A COURSE CREATED BY A SCOPED ADMIN DEFAULTS TO THEIR OWN DEPARTMENT.
    //
    // Without this, an admin narrowed to Business who adds a course without picking a
    // department gets one with academicDepartmentId null -- which is visible ONLY to
    // college-wide accounts, so the course vanishes the instant they create it, and so does
    // every cohort, unit and student they then build on it. They cannot even see it to
    // correct it.
    //
    // Only when the answer is UNAMBIGUOUS: exactly one department, and not college-wide. An
    // account on two departments is not telling us which one they meant, and a college-wide
    // account creating an unassigned course is doing something legitimate -- that is how a
    // course waiting to be sorted is expressed.
    //
    // Found by running the whole smoke suite as a scoped account (SMOKE_SCOPED_DEPARTMENT=1),
    // which is the branch nothing had ever executed.
    if (defaultForCaller) return { id: callerDepartmentId() };
    return { id: null };
  }
  if (typeof raw !== "string") return { error: "academicDepartmentId must be a department id, or null" };
  const found = await prisma.academicDepartment.findUnique({ where: { id: raw.trim() } });
  if (!found) return { error: "No such academic department" };
  return { id: found.id };
}
const predictionRunner = require("../prediction/runner");
// For ONE read: showBandToLecturers, which decides whether the live view carries the
// risk band. The rest of the prediction feature stays behind its page grant.
const predictionSettings = require("../prediction/settings");

/**
 * Flag students whose progression score a change here has invalidated.
 *
 * Attendance, enrolment, term dates and unit structure all feed the score, and none
 * of them is written by the prediction feature itself — so every route in this file
 * that touches one has to say so. Flagging is cheap (one statement per 200 ids) and
 * deliberately does NOT rescore: taking a register must not wait on a cohort's worth
 * of arithmetic.
 *
 * Never throws into a request that has already written. The register is saved; a
 * failure to invalidate a cache must not tell a member of staff otherwise.
 */
async function flagStale(studentIds, what) {
  try { await predictionRunner.markStale(studentIds); }
  catch (e) { console.error(`[prediction] could not flag scores after ${what}:`, e.message); }
}

/** Every student in a cohort — the affected set whenever a TERM's dates move, since
 *  term dates are the window each score is calculated over. */
async function studentsOfCohort(cohortId) {
  if (!cohortId) return [];
  return (await prisma.student.findMany({ where: { cohortId }, select: { id: true } })).map((s) => s.id);
}

/** Every student enrolled on a unit. */
async function studentsOfUnit(unitId) {
  if (!unitId) return [];
  return (await prisma.enrolment.findMany({ where: { unitId }, select: { studentId: true } })).map((e) => e.studentId);
}

// A student named for a log line: the identifiers a registry needs to find the
// person, and nothing else off the record.
const studentLabel = (s) => `${s.firstName} ${s.lastName} (${s.studentRef})`;
// Mutating registers/units/courses needs one of the sections that manages them.
// (Previously these used requireAdmin, which only checks the ADMIN role — and being
// granted ANY single page makes an account an ADMIN, so a read-only "executive"
// admin would have been able to write here.)
// TWO grants, deliberately separate — they are two checkboxes in the Access grid, so
// they must not be one authority on the server. Accepting either for every write meant
// an admin granted only "Students" (to maintain the directory) could delete courses,
// cohorts and units and rewrite registers, while an admin granted only "Registers"
// could delete a student and cascade away their attendance, grades and PAT records.
// A permission grid nobody can trust is worse than a narrow one.
const requireRegisters = requireAnyPage(["registers"]);      // course structure + registers
const requireStudentAdmin = requireAnyPage(["students"]);    // the student directory
// The handful of routes that genuinely serve both screens (enrolments link a student
// to a unit, so either side may legitimately edit them).
const requireHndWrite = requireAnyPage(["registers", "students"]);
// The live attendance dashboard. Its own grantable page, because the audience differs
// from the Registers page: a lecturer watching their class fill in is not the person who
// restructures a course. "registers" is included so an administrator who already has the
// registers themselves does not have to be granted a second page to watch one being
// taken — but a college can now grant the watching WITHOUT the editing, which is the
// point of the key existing at all.
// (Since 3 Sep 2026 the four routes that used this take `lecturerGate` instead, which
// admits the same pages plus the tutor of the session — see THE LECTURER'S DOOR below.)
const { isStatus, summarise, summariseCounts } = require("../attendance");

// THE ASSESSMENT TRACKER'S SETUP GRID SETS A MODULE LEADER, AND ONLY A MODULE LEADER.
//
// Registered ABOVE the router-wide gate below, and given its own narrow guard, because
// neither of the obvious alternatives is safe:
//
//   - Widening the router-wide gate would hand a tracker admin the whole HND read
//     surface: the student directory, the attendance matrix, every register.
//   - Widening requireRegisters, which is what PUT /units/:id uses, would hand them
//     DELETE /units/:id as well — the power to delete a unit and cascade away its
//     sessions and marks — in exchange for the ability to name a module leader.
//
// The comment on requireRegisters puts it better than this one can: a permission grid
// nobody can trust is worse than a narrow one. So this is a separate, much smaller
// door. It writes one column and reads none. Precedent for the shape:
// /assessments/exec-summary, registered above its own router's gate for the same reason.
//
// It delegates to teachingFromBody so the "unknown staff member" check has exactly one
// implementation — a second copy is a second place for it to drift, and a drifted copy
// here would silently accept a staff id that does not resolve to a real account.
router.put("/units/:id/leader", requireAuth, requireAnyPage(["registers", "assessment-tracker"]), async (req, res) => {
  const existing = await prisma.unit.findUnique({ where: { id: req.params.id }, select: { id: true, code: true, leaderStaffId: true } });
  if (!existing) return res.status(404).json({ error: "Unit not found" });
  // Only leaderStaffId is passed through, so a body carrying tutorStaffId or
  // submissionDate cannot reach the update by way of this route.
  const parsed = await teachingFromBody({ leaderStaffId: req.body?.leaderStaffId });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (parsed.leaderStaffId === undefined) return res.status(400).json({ error: "leaderStaffId is required" });
  const unit = await prisma.unit.update({
    where: { id: existing.id },
    data: { leaderStaffId: parsed.leaderStaffId },
    include: { tutorStaff: { select: { name: true } }, leaderStaff: { select: { name: true } } },
  });
  audit.record(req, {
    action: "unit.leaderSet", entity: "Unit", entityId: unit.id,
    summary: `Module leader for ${existing.code} set to ${unit.leaderStaff?.name || "nobody"}`,
    before: { leaderStaffId: existing.leaderStaffId ?? null },
    after: { leaderStaffId: unit.leaderStaffId ?? null },
  });
  res.json(sUnit(unit));
});

// DEF-01: HND registers are an admin-only feature (they live entirely in the admin
// dashboard; no staff/mobile flow reads them). Guard EVERY route — reads included —
// so a non-admin token cannot read the student directory, attendance matrix or
// registers. Individual routes keep their own write guard too (defence in depth).
// "executive" is included because the Executive Dashboard reads courses, units,
// sessions and the monthly attendance summary from here; every WRITE route below
// additionally requires requireHndWrite, so this only ever grants read access.
//
// THE LECTURER'S DOOR (3 Sep 2026). Four paths below — the lecturer's live view — are
// also reachable by an ordinary STAFF account, for the classes it is recorded as
// teaching. The router-wide gate steps aside for exactly those paths and nothing else;
// each of the four then applies its own guard (`lecturerGate`), which admits the page
// holders it always did OR the tutor of that one session. Everything DEF-01 protects —
// the directory, the matrix, the units, the paper register — stays behind this gate.
//
// An allowlist of paths rather than moving the routes above the gate, because the four
// share helpers with the rest of this file and the point is legible in one place: these
// are the only doors, and the list is the thing to read.
//
// Found on the way: an administrator granted ONLY `live-attendance` never passed this
// gate at all, so the page a college could grant "for watching without editing" opened
// nothing. The bypass fixes that too — the per-route guard was right, the gate above it
// was not consulted.
// `register` and the per-student history joined the list on 9 Sep 2026, and both belong
// here for the same reason the live view does: they are the register a lecturer is
// standing in front of. Marking a student from the live screen POSTs to
// /sessions/:id/register, so leaving it off the list offered a control the router then
// refused; the history is the same register read one student at a time, scoped to the
// module that register belongs to. Each still applies lecturerGate of its own — this
// list decides which doors EXIST for a page-less lecturer, not who may walk through one.
// METHOD MATTERS ON ONE OF THESE, so the list carries it.
//
// /sessions/:id/register is two different doors behind one path. The PUT is a lecturer
// saving marks from the live view they are already entitled to open — without it the
// marking dropdown is a control the router refuses. The GET is the PAPER REGISTER: the
// full admin sheet, with remarks, which smoke-qr-checkin asserts stays shut to a tutor
// alongside the student directory and the units list. Adding the path methodless opened
// both, and the suite caught it.
//
// Everything else is method-agnostic because it has only one.
const LECTURER_PATHS = [
  { re: /^\/my-sessions\/today$/ },
  { re: /^\/sessions\/[^/]+\/(live|qr-code|mark-remaining-absent|check-in-window)$/ },
  { re: /^\/sessions\/[^/]+\/students\/[^/]+\/history$/ },
  { re: /^\/sessions\/[^/]+\/register$/, methods: ["PUT"] },
];
const isLecturerPath = (req) =>
  LECTURER_PATHS.some(({ re, methods }) => re.test(req.path) && (!methods || methods.includes(req.method)));
const adminGate = requireAnyPage(["registers", "students", "executive"]);
router.use(requireAuth, (req, res, next) => (isLecturerPath(req) ? next() : adminGate(req, res, next)));

// WHO TEACHES A CLASS — and there are TWO answers, because there are two systems that
// record it and they answer different questions.
//
//   Unit.tutorStaffId          the term-long role: whoever owns the module. This is what
//                              a Moodle-synced unit carries, and it was the only answer
//                              until the timetabling module existed.
//   TimetableEventStaff        the per-EVENT assignment: whoever the timetable says is
//                              in the room for THIS class on THIS day. Registers built
//                              from the timetable carry HndSession.timetableEventId back
//                              to it (routes/timetabling.js).
//
// Both are identities (a staff id), never the free-text `Unit.tutor` or
// `TimetableSlot.lecturer` — a name typed into a box is not an identity, and matching on
// it hands one lecturer another's register the moment two people share a surname.
//
// The second answer is the MORE specific one: a visiting lecturer, a cover, or the
// second of two staff on a merged class is named on the event and tutors nothing, and
// before this they saw an empty dashboard and were refused their own register. Neither
// answer subsumes the other, so it is an OR and not a replacement.
const teachesSession = (user, session) => Boolean(
  user?.id && (
    (session?.unit?.tutorStaffId && session.unit.tutorStaffId === user.id)
    || (session?.timetableEvent?.staff || []).some((a) => a.staffId === user.id)
  ),
);
// The same question as a Prisma `where`, for the list route, which cannot load sessions
// before deciding which ones are the caller's. One `findMany` with this OR returns each
// session exactly once — a row matching both halves is still one row, so no `distinct`
// is needed and none is used.
const teachesSessionWhere = (staffId) => ({
  OR: [
    { unit: { tutorStaffId: staffId } },
    { timetableEvent: { staff: { some: { staffId } } } },
  ],
});
// Everything the two halves of `teachesSession` need, for any handler that has to ask.
// A `select` rather than a bare include so the event's staff list arrives as ids and
// nothing else: this is a guard, not a screen, and a colleague's name or email has no
// business travelling with it.
const TEACHES_SELECT = { unit: { select: { tutorStaffId: true } }, timetableEvent: { select: { staff: { select: { staffId: true } } } } };

// Page holders as before, OR whoever teaches the session named in the URL. Async because
// the second answer needs the session. A session that does not exist answers 403 for a
// non-page-holder rather than 404: whether a register exists is itself something the
// directory-less caller has no standing to learn.
function lecturerGate(pages) {
  return async (req, res, next) => {
    try {
      if (hasPage(req.user, pages)) return next();
      if (isStudent(req.user)) return res.status(403).json({ error: "Student accounts cannot open a register." });
      const s = await prisma.hndSession.findUnique({ where: { id: String(req.params.id || "") }, select: TEACHES_SELECT });
      if (teachesSession(req.user, s)) return next();
      return res.status(403).json({ error: "You can only open the classes you teach." });
    } catch (e) { next(e); }
  };
}
// The today list has no session in its URL: any signed-in member of staff may ask, and
// gets back only the classes they teach (or nothing, plus `teaches: false`).
const requireStaffAccount = (req, res, next) => (isStudent(req.user) ? res.status(403).json({ error: "Student accounts cannot open a register." }) : next());
// Whether THIS caller may close THIS session's register: the page that always could, or
// whoever teaches it. Computed once here so the guard and the `canClose` flag the live
// view hands the screen cannot disagree — which is why it goes through the same
// `teachesSession` the gate above does rather than repeating half of it.
const mayClose = (user, session) => hasPage(user, ["registers"]) || teachesSession(user, session);

const PALETTE = ["#1a3a8f", "#9e1b32", "#0d7a5f", "#b45309", "#6d28d9", "#0e7490", "#be123c"];
const colourFor = (seed) => PALETTE[Math.abs(String(seed).split("").reduce((a, c) => a + c.charCodeAt(0), 0)) % PALETTE.length];
const initialsOf = (first, last) => `${(first || "").trim()[0] || ""}${(last || "").trim()[0] || ""}`.toUpperCase() || "??";
const str = (v) => (typeof v === "string" ? v.trim() : "");
// Strict calendar validity. The previous check only proved the string PARSED —
// but V8 rolls "2039-02-30" over to 2 March rather than returning Invalid Date, so
// impossible dates were accepted. A session dated to a day that doesn't exist falls
// outside every semester range and shows different totals depending on the scope.
const { isRealDate } = require("../validate");
const { localDate, localTime } = require("../clock");
const tapConfig = require("../attendanceTapConfig");
const { subMinutes, addMinutes, isSelfCheckIn, isStudentAction, checkInMethod, withinSessionWindow, termOpenOn, checkInClosesAt } = require("../attendanceTap");
const { sharedDeviceGroups } = require("../sharedDevice");
const { windowIndexFor, deriveCode } = require("../attendanceQr");
const { qrSigningKey, SecretsNotConfigured } = require("../secrets");
const isDate = (v) => isRealDate(v);
const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

// Dates are YYYY-MM-DD, so plain string comparison is date comparison.
const inRange = (date, s) => date >= s.start && date <= s.end;
const overlaps = (a, b) => a.start <= b.end && b.start <= a.end;

/* ============================== semesters ============================== */

router.get("/semesters", requireAuth, async (_req, res) => {
  const rows = await prisma.semester.findMany({ orderBy: { start: "asc" } });
  // How many sessions land in each semester, plus the ones that land in none —
  // those would otherwise be invisible in every scoped view.
  const sessions = await prisma.hndSession.findMany({ select: { date: true } });
  const out = rows.map((s) => ({ ...sSemester(s), sessionCount: sessions.filter((x) => inRange(x.date, s)).length }));
  const unassigned = sessions.filter((x) => !rows.some((s) => inRange(x.date, s))).length;
  res.json({ semesters: out, unassignedSessions: unassigned });
});

// Validate a semester's name/dates and guard against overlapping another one,
// which would make "which semester is this session in?" ambiguous.
async function validateSemester(body, excludeId) {
  const name = str(body?.name);
  const start = str(body?.start);
  const end = str(body?.end);
  if (!name) return { error: "Semester name required" };
  if (!isDate(start) || !isDate(end)) return { error: "Valid start and end dates required (YYYY-MM-DD)" };
  if (end < start) return { error: "End date must be on or after the start date" };
  const others = await prisma.semester.findMany({ where: excludeId ? { id: { not: excludeId } } : undefined });
  const clash = others.find((o) => overlaps({ start, end }, o));
  if (clash) return { error: `Those dates overlap "${clash.name}" (${clash.start} → ${clash.end})` };
  return { data: { name, start, end } };
}

router.post("/semesters", requireAuth, requireRegisters, async (req, res) => {
  const v = await validateSemester(req.body, null);
  if (v.error) return res.status(400).json({ error: v.error });
  const s = await prisma.semester.create({ data: v.data });
  res.status(201).json(sSemester(s));
});

router.put("/semesters/:id", requireAuth, requireRegisters, async (req, res) => {
  const existing = await prisma.semester.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Semester not found" });
  const v = await validateSemester({ ...existing, ...req.body }, existing.id);
  if (v.error) return res.status(400).json({ error: v.error });
  const s = await prisma.semester.update({ where: { id: existing.id }, data: v.data });
  res.json(sSemester(s));
});

// Deleting a semester never touches sessions or marks — it only changes how
// they're grouped, so the underlying registers are always safe.
router.delete("/semesters/:id", requireAuth, requireRegisters, async (req, res) => {
  try { await prisma.semester.delete({ where: { id: req.params.id } }); res.json({ ok: true }); }
  catch (_e) { res.status(404).json({ error: "Semester not found" }); }
});

/* ============================== courses ============================== */
// A course (e.g. "HND Business") groups the units taught under it. Deleting
// one leaves its units intact but unassigned (schema-level onDelete: SetNull),
// so no register is ever lost by reorganising the course structure.

// Resolve a courseId from the body into a value Prisma can store. Returns
// { value } on success (null clears the link) or { error } if the id is unknown.
async function resolveCourse(raw) {
  if (raw === undefined) return { skip: true };
  const id = str(raw);
  if (!id) return { value: null };
  const exists = await prisma.course.findUnique({ where: { id } });
  if (!exists) return { error: "Unknown course" };
  return { value: id };
}

// Resolve a unit's cohort + term, ensuring the term (if any) belongs to the cohort.
// Either may be null. A term given without a cohort derives the cohort from it.
async function resolveCohortTerm(rawCohort, rawTerm) {
  const cohortId = str(rawCohort) || null;
  const termId = str(rawTerm) || null;
  if (cohortId && !(await prisma.cohort.findUnique({ where: { id: cohortId } }))) return { error: "Unknown cohort" };
  if (termId) {
    const t = await prisma.term.findUnique({ where: { id: termId } });
    if (!t) return { error: "Unknown term" };
    if (cohortId && t.cohortId !== cohortId) return { error: "That term isn't in the chosen cohort" };
    return { cohortId: cohortId || t.cohortId, termId };
  }
  return { cohortId, termId: null };
}

// Where a unit sits in the course structure: "Year 1 · Term 2". Both parts are set
// together or both cleared — a year with no term (or the reverse) is a half-placement
// that no filter could show sensibly. Terms are numbered 1-6 straight through, because
// the college calls Year 2's first term "Term 4".
const MAX_YEAR = 2;
const MAX_TERM = 6;
function placeFromBody(body) {
  const blank = (v) => v === undefined || v === null || v === "";
  if (blank(body?.year) && blank(body?.termNumber)) return { year: null, termNumber: null };
  if (blank(body?.year) || blank(body?.termNumber)) return { error: "Choose both a year and a term, or neither" };
  const year = Number(body.year);
  const termNumber = Number(body.termNumber);
  if (!Number.isInteger(year) || year < 1 || year > MAX_YEAR) return { error: `Year must be between 1 and ${MAX_YEAR}` };
  if (!Number.isInteger(termNumber) || termNumber < 1 || termNumber > MAX_TERM) return { error: `Term must be between 1 and ${MAX_TERM}` };
  return { year, termNumber };
}

// The unit's teaching window. Both dates or neither: a start with no end can't say
// whether the unit has finished, which is the whole point of holding them.
// The submission deadline and the teaching staff. Both optional and independent of
// each other, so a unit can have a tutor with no deadline set, or the reverse.
// Returns { submissionDate, tutorStaffId, tutor, leaderStaffId } or { error }.
async function teachingFromBody(body, current = {}) {
  const out = {};
  if (body?.submissionDate !== undefined) {
    const d = str(body.submissionDate);
    if (!d) out.submissionDate = null;
    else if (!isDate(d)) return { error: "The submission date must be a real calendar date (YYYY-MM-DD)" };
    else out.submissionDate = d;
  }
  if (body?.tutorStaffId !== undefined) {
    const id = str(body.tutorStaffId);
    if (!id) { out.tutorStaffId = null; }
    else {
      const staff = await prisma.staff.findUnique({ where: { id }, select: { id: true, name: true } });
      if (!staff) return { error: "Unknown staff member" };
      out.tutorStaffId = staff.id;
      // Mirror the name into the free-text field, so anything still reading `tutor`
      // keeps working and the name survives if the account is later removed.
      out.tutor = staff.name;
    }
  }
  // The module LEADER, which is a different person from the tutor above and is set on
  // the assessment tracker's setup grid rather than here. Handled in this helper anyway
  // so there is exactly one place that resolves a staff id onto a unit — a second
  // implementation is a second place for the "unknown staff member" check to drift.
  //
  // No mirror into a free-text field, unlike tutorStaffId: `tutor` exists only because
  // units were assigned by name before accounts were linked, and there is no such
  // history to carry here.
  if (body?.leaderStaffId !== undefined) {
    const id = str(body.leaderStaffId);
    if (!id) { out.leaderStaffId = null; }
    else {
      // Resolved against Staff rather than stored as given, so an id that names no
      // account is refused as unknown instead of being written to the column and
      // reappearing later as a module leader nobody can find.
      const staff = await prisma.staff.findUnique({ where: { id }, select: { id: true } });
      if (!staff) return { error: "Unknown staff member" };
      out.leaderStaffId = staff.id;
    }
  }
  return out;
}

// Returns { startDate, endDate } or { error }.
function windowFromBody(body) {
  const blank = (v) => v === undefined || v === null || v === "";
  if (blank(body?.startDate) && blank(body?.endDate)) return { startDate: null, endDate: null };
  if (blank(body?.startDate) || blank(body?.endDate)) return { error: "Give both a start and an end date, or neither" };
  const startDate = str(body.startDate), endDate = str(body.endDate);
  if (!isDate(startDate) || !isDate(endDate)) return { error: "Dates must be real calendar dates (YYYY-MM-DD)" };
  if (endDate < startDate) return { error: "The end date must be on or after the start date" };
  return { startDate, endDate };
}

router.get("/courses", requireAuth, async (req, res) => {
  const rows = await prisma.course.findMany({
    where: academicDepartmentFilter(req.query?.academicDepartmentId),
    orderBy: { name: "asc" },
    include: { _count: { select: { units: true, cohorts: true } } },
  });
  res.json(rows.map(sCourse));
});

router.post("/courses", requireAuth, requireRegisters, async (req, res) => {
  const name = str(req.body?.name);
  if (!name) return res.status(400).json({ error: "Course name required" });
  const clash = await prisma.course.findFirst({ where: { name: { equals: name } } });
  if (clash) return res.status(409).json({ error: `A course called "${name}" already exists` });
  const colour = str(req.body?.colour) || colourFor(name);

  // THE DEPARTMENT IS SETTABLE HERE, and until it was, the VLE category mapping was the
  // ONLY writer of Course.academicDepartmentId in the application. That mapping selects
  // courses by vleCategoryExternalId, which a hand-created course does not have -- so a
  // college that does not run Moodle, or that simply adds a course in the app, could never
  // assign it to a department at all. Its students stayed unassigned and invisible to
  // their own tutors.
  const dept = await resolveAcademicDepartment(req.body?.academicDepartmentId, { defaultForCaller: true });
  if (dept.error) return res.status(400).json({ error: dept.error });

  const p = await prisma.course.create({
    data: { name, colour, academicDepartmentId: dept.id },
    include: { _count: { select: { units: true, cohorts: true } } },
  });
  res.status(201).json(sCourse(p));
});

router.put("/courses/:id", requireAuth, requireRegisters, async (req, res) => {
  const existing = await prisma.course.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Course not found" });
  const data = {};
  if (req.body?.name !== undefined) {
    const name = str(req.body.name);
    if (!name) return res.status(400).json({ error: "Course name required" });
    const clash = await prisma.course.findFirst({ where: { name: { equals: name }, id: { not: existing.id } } });
    if (clash) return res.status(409).json({ error: `A course called "${name}" already exists` });
    data.name = name;
  }
  if (req.body?.colour !== undefined) data.colour = str(req.body.colour) || existing.colour;

  // UNDEFINED MEANS "not being changed", so a rename cannot un-assign a department. An
  // explicit null is the deliberate un-assign. Same convention routes/staff.js uses for
  // supportDepartments, and the same distinction the VLE mapping now enforces.
  let deptChange = null;
  if (req.body?.academicDepartmentId !== undefined) {
    const dept = await resolveAcademicDepartment(req.body.academicDepartmentId);
    if (dept.error) return res.status(400).json({ error: dept.error });
    if (dept.id !== existing.academicDepartmentId) deptChange = dept.id;
    else deptChange = undefined; // no move needed
  }

  const p = await prisma.course.update({ where: { id: existing.id }, data, include: { _count: { select: { units: true, cohorts: true } } } });

  // THE STUDENTS FOLLOW THE COURSE, through the shared helper rather than a second copy of
  // the transaction. Moving a course and leaving its students behind leaves them visible
  // to the department the course has just left and hidden from the one it joined.
  let moved = null;
  if (deptChange !== undefined && req.body?.academicDepartmentId !== undefined) {
    moved = await academicDepartments.assignCourses(prisma, [existing.id], deptChange);
  }

  audit.record(req, {
    action: "course.updated", entity: "Course", entityId: existing.id,
    summary: `Course ${p.name} updated` +
      (moved ? ` — moved to another academic department, with ${moved.studentCount} student(s)` : ""),
    before: { name: existing.name, academicDepartmentId: existing.academicDepartmentId },
    after: { name: p.name, academicDepartmentId: deptChange === undefined ? existing.academicDepartmentId : deptChange },
  });

  res.json(sCourse({ ...p, academicDepartmentId: deptChange === undefined ? existing.academicDepartmentId : deptChange }));
});

// Units are un-assigned (not deleted) when their course goes.
router.delete("/courses/:id", requireAuth, requireRegisters, async (req, res) => {
  try { await prisma.course.delete({ where: { id: req.params.id } }); res.json({ ok: true }); }
  catch (_e) { res.status(404).json({ error: "Course not found" }); }
});

/* ============================== cohorts ============================== */
// An intake of students on a course, e.g. "SEP 2025". One course runs many
// cohorts over time; each name is unique within its course.

router.get("/cohorts", requireAuth, async (req, res) => {
  const courseId = str(req.query?.courseId);
  const where = courseId ? { courseId } : {};
  const rows = await prisma.cohort.findMany({ where, orderBy: [{ courseId: "asc" }, { createdAt: "asc" }] });
  res.json(rows.map(sCohort));
});

router.post("/cohorts", requireAuth, requireRegisters, async (req, res) => {
  const name = str(req.body?.name);
  const courseId = str(req.body?.courseId);
  const startDate = str(req.body?.startDate) || null;
  if (!name) return res.status(400).json({ error: "Cohort name required" });
  if (!courseId) return res.status(400).json({ error: "Course is required" });
  if (startDate && !isDate(startDate)) return res.status(400).json({ error: "Start date must be a valid date (YYYY-MM-DD)" });
  const prog = await prisma.course.findUnique({ where: { id: courseId } });
  if (!prog) return res.status(400).json({ error: "Unknown course" });
  const clash = await prisma.cohort.findFirst({ where: { courseId, name } });
  if (clash) return res.status(409).json({ error: `"${name}" already exists on this course` });
  try {
    const c = await prisma.cohort.create({
      data: { name, courseId, startDate, academicDepartmentId: await departmentOfCourse(courseId) },
    });
    res.status(201).json(sCohort(c));
  } catch (_e) { res.status(400).json({ error: "Could not create the cohort" }); }
});

router.put("/cohorts/:id", requireAuth, requireRegisters, async (req, res) => {
  const existing = await prisma.cohort.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Cohort not found" });
  const data = {};
  if (req.body?.name !== undefined) {
    const name = str(req.body.name);
    if (!name) return res.status(400).json({ error: "Cohort name required" });
    const clash = await prisma.cohort.findFirst({ where: { courseId: existing.courseId, name, id: { not: existing.id } } });
    if (clash) return res.status(409).json({ error: `"${name}" already exists on this course` });
    data.name = name;
  }
  if (req.body?.startDate !== undefined) {
    const sd = str(req.body.startDate) || null;
    if (sd && !isDate(sd)) return res.status(400).json({ error: "Start date must be a valid date (YYYY-MM-DD)" });
    data.startDate = sd;
  }
  const c = await prisma.cohort.update({ where: { id: existing.id }, data });
  res.json(sCohort(c));
});

router.delete("/cohorts/:id", requireAuth, requireRegisters, async (req, res) => {
  // Read the students BEFORE the delete. Student.cohortId is set to null by the
  // cascade, so afterwards there is nothing left connecting these students to the
  // cohort whose term dates their scores were calculated over.
  const affected = await studentsOfCohort(req.params.id);
  try {
    await prisma.cohort.delete({ where: { id: req.params.id } });
    await flagStale(affected, "a cohort being deleted");
    res.json({ ok: true });
  }
  catch (_e) { res.status(404).json({ error: "Cohort not found" }); }
});

/* ---------------------- who is IN a group ---------------------- */
//
// A cohort IS the reusable named group — "BSc Software Engineering SEP 25" — that a
// timetabled class is addressed to. These two routes are how a whole class gets put
// into one in a single action instead of student by student.
//
// GUARDED ON "students", NOT ON "registers" OR "scheduling", and that is not a
// stylistic choice. Moving a student between cohorts rewrites their stored
// academicDepartmentId, which is what decides WHICH DEPARTMENT CAN SEE THEM. Behind the
// scheduling page it would let somebody whose job is placing classes on a calendar move
// a student out of one department's sight and into another's. It is the same act as
// PUT /students/:id with a cohortId, so it carries the same guard.

router.get("/cohorts/:id/students", requireAuth, async (req, res) => {
  const rows = await prisma.student.findMany({
    where: { cohortId: req.params.id },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  res.json(rows.map(sStudent));
});

/**
 * Put students into a group, or take them out of it (`cohortId: null` on the body's
 * behalf when `remove` is true).
 *
 * ONE STUDENT IS IN ONE GROUP. Student.cohortId is a single column, so adding somebody
 * to this group REMOVES them from whichever they were in. That is reported back rather
 * than done quietly: `moved` names the students who were somewhere else, because an
 * administrator adding forty people has no other way to notice they have just emptied
 * another class.
 */
async function setCohortMembership(req, res, { remove }) {
  const cohort = remove ? null : await prisma.cohort.findUnique({ where: { id: req.params.id } });
  if (!remove && !cohort) return res.status(404).json({ error: "Group not found" });

  const ids = Array.isArray(req.body?.studentIds)
    ? [...new Set(req.body.studentIds.filter((x) => typeof x === "string" && x.trim()))]
    : [];
  if (!ids.length) return res.status(400).json({ error: "studentIds must be a non-empty list" });
  // The same ceiling the audit blob uses. A request larger than this is an import,
  // and an import is a different endpoint with a different confirmation.
  if (ids.length > 500) return res.status(400).json({ error: "Move at most 500 students at a time" });

  const students = await prisma.student.findMany({
    where: { id: { in: ids } },
    select: { id: true, firstName: true, lastName: true, studentRef: true, cohortId: true },
  });
  if (students.length !== ids.length) return res.status(400).json({ error: "One or more students do not exist" });

  // On removal, only students actually in THIS group are touched. Without that check a
  // stale browser tab could pull somebody out of a group they were never in.
  const targets = remove ? students.filter((s) => s.cohortId === req.params.id) : students;
  if (!targets.length) return res.json({ ok: true, changed: 0, moved: [] });

  const cohortId = remove ? null : cohort.id;
  // THE STORED DEPARTMENT FOLLOWS THE COHORT, resolved ONCE for the group rather than
  // per student — it is a property of the cohort, and asking it per student would be
  // the same query forty times for one answer.
  const academicDepartmentId = await academicDepartments.forCohort(cohortId);

  const { count } = await prisma.student.updateMany({
    where: { id: { in: targets.map((s) => s.id) } },
    data: { cohortId, academicDepartmentId },
  });
  // Not a security field, but cohortId/academicDepartmentId ride on the cached row
  // into req.user and the student app's /me — a moved student should see their new
  // group on the next request, not a TTL later. Bounded by the request's own id
  // list, so this is cheap.
  for (const s of targets) identityCache.invalidate("student", s.id);

  // A cohort change moves a student's scoring window to that cohort's term calendar,
  // so every one of them is restated as stale. Same call the single-student path makes.
  await flagStale(targets.map((s) => s.id), remove ? "students being removed from a group" : "students being added to a group");

  const moved = targets
    .filter((s) => s.cohortId && s.cohortId !== cohortId)
    .map((s) => ({ id: s.id, name: `${s.firstName} ${s.lastName}`.trim(), studentRef: s.studentRef, fromCohortId: s.cohortId }));

  audit.record(req, {
    action: remove ? "cohort.students.removed" : "cohort.students.added",
    entity: "Cohort", entityId: req.params.id,
    summary: remove
      ? `${count} student(s) removed from a group by ${req.user?.name || "an administrator"}`
      : `${count} student(s) added to ${cohort.name} by ${req.user?.name || "an administrator"}` +
        (moved.length ? ` — ${moved.length} moved out of another group` : ""),
    before: Object.fromEntries(targets.slice(0, 40).map((s) => [s.id, s.cohortId])),
    after: Object.fromEntries(targets.slice(0, 40).map((s) => [s.id, cohortId])),
  });

  res.json({ ok: true, changed: count, moved });
}

router.post("/cohorts/:id/students", requireAuth, requireStudentAdmin, (req, res) => setCohortMembership(req, res, { remove: false }));
router.delete("/cohorts/:id/students", requireAuth, requireStudentAdmin, (req, res) => setCohortMembership(req, res, { remove: true }));

/* ============================== terms ============================== */
// Each cohort runs 6 terms (Year 1 T1-3, Year 2 T1-3). Dates drive which term is
// "active" (contains today) — that's what opens/pauses attendance later.

// Add whole days to a YYYY-MM-DD string, UTC-safe.
const addDays = (iso, days) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

router.get("/terms", requireAuth, async (req, res) => {
  const cohortId = str(req.query?.cohortId);
  const where = cohortId ? { cohortId } : {};
  const rows = await prisma.term.findMany({ where, orderBy: [{ cohortId: "asc" }, { year: "asc" }, { index: "asc" }] });
  res.json(rows.map(sTerm));
});

// Generate the standard 6 terms for a cohort, back-to-back from a start date.
// Body: { start?, weeksPerTerm? } — start defaults to the cohort's own start date.
router.post("/cohorts/:id/terms/generate", requireAuth, requireRegisters, async (req, res) => {
  const cohort = await prisma.cohort.findUnique({ where: { id: req.params.id } });
  if (!cohort) return res.status(404).json({ error: "Cohort not found" });
  const start = str(req.body?.start) || cohort.startDate;
  if (!start || !isDate(start)) return res.status(400).json({ error: "A valid start date is needed — set the cohort's start date or pass one" });
  const weeks = Number.isInteger(req.body?.weeksPerTerm) && req.body.weeksPerTerm > 0 && req.body.weeksPerTerm <= 52 ? req.body.weeksPerTerm : 14;
  if (await prisma.term.count({ where: { cohortId: cohort.id } }) > 0) {
    return res.status(409).json({ error: "This cohort already has terms — edit or delete them first" });
  }
  const len = weeks * 7;
  const data = [];
  let cursor = start;
  for (let i = 0; i < 6; i++) {
    const year = i < 3 ? 1 : 2, index = (i % 3) + 1;
    const end = addDays(cursor, len - 1);
    data.push({ cohortId: cohort.id, year, index, name: `Year ${year} · Term ${index}`, start: cursor, end });
    cursor = addDays(end, 1);
  }
  try {
    await prisma.term.createMany({ data });
  } catch (e) {
    // Two generate calls can both pass the count check above; the loser trips the
    // (cohortId, year, index) unique index. Report that as the same clean 409.
    if (e?.code === "P2002") return res.status(409).json({ error: "This cohort already has terms — edit or delete them first" });
    throw e;
  }
  const terms = await prisma.term.findMany({ where: { cohortId: cohort.id }, orderBy: [{ year: "asc" }, { index: "asc" }] });
  res.status(201).json(terms.map(sTerm));
});

router.put("/terms/:id", requireAuth, requireRegisters, async (req, res) => {
  const existing = await prisma.term.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Term not found" });
  const data = {};
  if (req.body?.name !== undefined) { const n = str(req.body.name); if (!n) return res.status(400).json({ error: "Term name required" }); data.name = n; }
  if (req.body?.start !== undefined) { if (!isDate(str(req.body.start))) return res.status(400).json({ error: "Valid start date required (YYYY-MM-DD)" }); data.start = str(req.body.start); }
  if (req.body?.end !== undefined) { if (!isDate(str(req.body.end))) return res.status(400).json({ error: "Valid end date required (YYYY-MM-DD)" }); data.end = str(req.body.end); }
  const start = data.start ?? existing.start, end = data.end ?? existing.end;
  if (end < start) return res.status(400).json({ error: "End date must be on or after the start date" });
  // Terms drive attendance locking, so two terms must never claim the same day —
  // otherwise two terms read as "current" and which register opens is arbitrary.
  const siblings = await prisma.term.findMany({ where: { cohortId: existing.cohortId, id: { not: existing.id } } });
  const clash = siblings.find((o) => overlaps({ start, end }, o));
  if (clash) return res.status(409).json({ error: `Those dates overlap ${clash.name} (${clash.start} → ${clash.end})` });
  const t = await prisma.term.update({ where: { id: existing.id }, data });
  // A gap between terms leaves days covered by no term at all, which silently locks
  // every register in that window. Not an error (the college may intend a break), but
  // report it so the UI can warn instead of leaving the admin to guess.
  // A term's dates are the window every score in that cohort is calculated over, so
  // moving them re-scopes every student in it — without writing a single student row.
  if (data.start !== undefined || data.end !== undefined) {
    await flagStale(await studentsOfCohort(existing.cohortId), "a term's dates changing");
  }
  const all = [...siblings, t].sort((a, b) => a.start.localeCompare(b.start));
  const gaps = [];
  for (let i = 1; i < all.length; i++) {
    if (addDays(all[i - 1].end, 1) < all[i].start) gaps.push({ after: all[i - 1].name, before: all[i].name, from: addDays(all[i - 1].end, 1), to: addDays(all[i].start, -1) });
  }
  res.json({ ...sTerm(t), gaps });
});

router.delete("/terms/:id", requireAuth, requireRegisters, async (req, res) => {
  // Read the term BEFORE deleting it: its cohort is the only route to the students
  // whose scoring window this removes, and after the delete that link is gone.
  const existing = await prisma.term.findUnique({ where: { id: req.params.id }, select: { cohortId: true } });
  try {
    await prisma.term.delete({ where: { id: req.params.id } });
    if (existing) await flagStale(await studentsOfCohort(existing.cohortId), "a term being deleted");
    res.json({ ok: true });
  }
  catch (_e) { res.status(404).json({ error: "Term not found" }); }
});

/* ============================== units ============================== */

router.get("/units", requireAuth, async (_req, res) => {
  // Grouped aggregations instead of a per-unit _count (which issues a correlated
  // subquery per row and collapsed at scale). Same response shape.
  //
  // studentCount is NOT a count of Enrolment rows any more, and that was the bug:
  // BUS701–BUS705 read "0 students · 20 sessions" while the register for those very
  // classes listed the twenty students of the group scheduled against them. A student
  // reaches a register by two routes, not one, and the card only knew about one of
  // them. unitStudentCounts applies the same rule the registers do — see roster.js —
  // and is shared with GET /attendance below so the two cannot drift.
  const [rows, sessAgg, studentCounts, teaching] = await Promise.all([
    prisma.unit.findMany({ orderBy: { code: "asc" } }),
    prisma.hndSession.groupBy({ by: ["unitId"], _count: { _all: true }, _max: { date: true } }),
    unitStudentCounts(),
    // WHO it is taught to and WHERE, which a Unit row does not carry: both are properties
    // of the timetable, because the same module runs for two intakes on two campuses.
    unitTeachingContext(),
  ]);
  const sMap = new Map(sessAgg.map((s) => [s.unitId, s._count._all]));
  const endMap = new Map(sessAgg.map((s) => [s.unitId, s._max.date || null]));
  // lastSessionDate is DERIVED (the newest register on this unit) and must not be
  // called endDate — that is the unit's own, admin-set teaching end date, and
  // spreading a derived value over it silently replaced the real one.
  //
  // `?? null` and not `|| 0`: a unit with no enrolments AND no group timetabled against
  // it has no route to a student at all, and "0 students" is the sentence a genuinely
  // empty module says. Null-is-not-zero, excluded rather than counted.
  res.json(rows.map((m) => ({
    ...sUnit(m),
    studentCount: studentCounts.get(m.id) ?? null,
    sessionCount: sMap.get(m.id) || 0,
    lastSessionDate: endMap.get(m.id) || null,
    // Empty arrays, not null: "this module is timetabled for nobody yet" is an answer,
    // and a screen can render an empty list without a special case for the absence.
    cohorts: teaching.get(m.id)?.cohorts || [],
    campuses: teaching.get(m.id)?.campuses || [],
  })));
});

router.post("/units", requireAuth, requireRegisters, async (req, res) => {
  const code = str(req.body?.code).toUpperCase();
  const name = str(req.body?.name);
  if (!code) return res.status(400).json({ error: "Unit code required" });
  if (!name) return res.status(400).json({ error: "Unit name required" });
  const prog = await resolveCourse(req.body?.courseId);
  if (prog.error) return res.status(400).json({ error: prog.error });
  const courseId = prog.skip ? null : prog.value;
  // Unit codes are unique WITHIN a course only — the same code may exist on another
  // course, so we scope the clash check to this unit's course. Note that the composite
  // unique index can't enforce this for course-LESS units (Postgres treats NULLs as
  // distinct), so for those this check is the only guard and two simultaneous creates
  // could still slip through; assigning a course closes that gap.
  const where = courseId ? { code, courseId } : { code, courseId: null };
  const clash = await prisma.unit.findFirst({ where });
  if (clash) return res.status(409).json({ error: courseId ? `Unit code "${code}" already exists in this course` : `Unit code "${code}" already exists among units with no course` });
  const ct = await resolveCohortTerm(req.body?.cohortId, req.body?.termId);
  if (ct.error) return res.status(400).json({ error: ct.error });
  const place = placeFromBody(req.body);
  if (place.error) return res.status(400).json({ error: place.error });
  const win = windowFromBody(req.body);
  if (win.error) return res.status(400).json({ error: win.error });
  const teach = await teachingFromBody(req.body);
  if (teach.error) return res.status(400).json({ error: teach.error });
  try {
    const m = await prisma.unit.create({
      data: {
        code, unitNumber: str(req.body?.unitNumber), name, tutor: str(req.body?.tutor), courseId,
        // Inherited from the course. A unit with a null department is visible only to
        // college-wide accounts, so a scoped admin's own new unit would vanish on creation.
        academicDepartmentId: await departmentOfCourse(courseId),
        year: place.year, termNumber: place.termNumber,
        startDate: win.startDate, endDate: win.endDate,
        cohortId: ct.cohortId, termId: ct.termId,
        ...teach,
      },
    });
    res.status(201).json(sUnit(m));
  } catch (e) {
    // P2002 = the DB's unique index rejected it. A clean 409 beats a raw 500.
    if (e?.code === "P2002") return res.status(409).json({ error: courseId ? `Unit code "${code}" already exists in this course` : `Unit code "${code}" is already in use` });
    throw e;
  }
});

router.put("/units/:id", requireAuth, requireRegisters, async (req, res) => {
  const existing = await prisma.unit.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Unit not found" });
  const data = {};
  // Resolve the target course first — the code-uniqueness check is scoped to it.
  const prog = await resolveCourse(req.body?.courseId);
  if (prog.error) return res.status(400).json({ error: prog.error });
  const courseChanging = !prog.skip;
  const targetCourseId = courseChanging ? prog.value : existing.courseId;
  if (courseChanging) data.courseId = prog.value;
  const codeChanging = req.body?.code !== undefined;
  const effectiveCode = codeChanging ? str(req.body.code).toUpperCase() : existing.code;
  if (codeChanging && !effectiveCode) return res.status(400).json({ error: "Unit code required" });
  // Re-check uniqueness within the (possibly new) course whenever code OR course moves.
  if (codeChanging || courseChanging) {
    const clash = await prisma.unit.findFirst({ where: { code: effectiveCode, courseId: targetCourseId, id: { not: existing.id } } });
    if (clash) return res.status(409).json({ error: `Unit code "${effectiveCode}" already exists in ${targetCourseId ? "this course" : "the no-course group"}` });
  }
  if (codeChanging) data.code = effectiveCode;
  if (req.body?.name !== undefined) {
    const name = str(req.body.name);
    if (!name) return res.status(400).json({ error: "Unit name required" });
    data.name = name;
  }
  if (req.body?.tutor !== undefined) data.tutor = str(req.body.tutor);
  if (req.body?.unitNumber !== undefined) data.unitNumber = str(req.body.unitNumber);
  const teach = await teachingFromBody(req.body, existing);
  if (teach.error) return res.status(400).json({ error: teach.error });
  Object.assign(data, teach);
  // Year/term travel together — "Year 1" with no term is not a placement.
  if (req.body?.year !== undefined || req.body?.termNumber !== undefined) {
    const place = placeFromBody({
      year: req.body?.year !== undefined ? req.body.year : existing.year,
      termNumber: req.body?.termNumber !== undefined ? req.body.termNumber : existing.termNumber,
    });
    if (place.error) return res.status(400).json({ error: place.error });
    data.year = place.year; data.termNumber = place.termNumber;
  }
  // Teaching window — same all-or-nothing rule, and the partner date is carried over
  // when only one of the two is being changed.
  if (req.body?.startDate !== undefined || req.body?.endDate !== undefined) {
    const win = windowFromBody({
      startDate: req.body?.startDate !== undefined ? req.body.startDate : existing.startDate,
      endDate: req.body?.endDate !== undefined ? req.body.endDate : existing.endDate,
    });
    if (win.error) return res.status(400).json({ error: win.error });
    data.startDate = win.startDate; data.endDate = win.endDate;
  }
  // cohort/term are set together (the UI picks a cohort then its term).
  //
  // But an OMITTED termId must mean "leave it alone", not "clear it". It meant the
  // latter — str(undefined) is "" — so PUT {"cohortId":"..."} on its own silently
  // nulled termId and permanently unlocked every register on that unit, returning 200
  // with nothing to say a term link had been dropped. startDate/endDate above already
  // treat undefined as "unchanged"; this now matches.
  if (req.body?.cohortId !== undefined || req.body?.termId !== undefined) {
    const ct = await resolveCohortTerm(
      req.body?.cohortId !== undefined ? req.body.cohortId : existing.cohortId,
      req.body?.termId !== undefined ? req.body.termId : existing.termId,
    );
    if (ct.error) return res.status(400).json({ error: ct.error });
    data.cohortId = ct.cohortId; data.termId = ct.termId;
  }
  try {
    const m = await prisma.unit.update({ where: { id: existing.id }, data });
    // A unit's term and dates decide which of its assessments and sessions fall inside
    // a student's scoring window, so moving them re-scopes everyone enrolled.
    if (data.termId !== undefined || data.cohortId !== undefined || data.startDate !== undefined || data.endDate !== undefined || data.courseId !== undefined) {
      await flagStale(await studentsOfUnit(existing.id), "a unit being re-scheduled");
    }
    res.json(sUnit(m));
  } catch (e) {
    if (e?.code === "P2002") return res.status(409).json({ error: `Unit code "${data.code || existing.code}" already exists in ${targetCourseId ? "this course" : "the no-course group"}` });
    throw e;
  }
});

// Deleting a unit cascades to its sessions, marks and enrolments (schema-level).
router.delete("/units/:id", requireAuth, requireRegisters, async (req, res) => {
  // Read first: the cascade is silent and wide, and the log has to be able to say how
  // much attendance history went with the unit.
  const existing = await prisma.unit.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { sessions: true, enrolments: true, assessments: true } } },
  });
  if (!existing) return res.status(404).json({ error: "Unit not found" });

  // Read the affected students BEFORE the cascade. Enrolments AND mark-holders: a
  // student un-enrolled from the unit keeps the marks they were given (see the note on
  // PUT /units/:id/enrolments), so the two sets are not the same and neither survives
  // the delete.
  const enrolled = await studentsOfUnit(existing.id);
  const marked = (await prisma.attendanceMark.findMany({
    where: { session: { unitId: existing.id } }, select: { studentId: true }, distinct: ["studentId"],
  })).map((m) => m.studentId);

  // TAKEN ATTENDANCE IS NOT DELETABLE THROUGH A MODULE, and this refusal is the whole
  // reason the reads above happen first.
  //
  // HndSession.unitId is NOT NULL with onDelete: Cascade, and AttendanceMark.sessionId
  // cascades in turn — so deleting a unit silently destroyed every register on it and
  // every mark on those registers. Every neighbouring foreign key in this feature is
  // deliberately SetNull with a comment saying attendance must outlive the thing it was
  // taken against: an event, a group, a room. This one was the exception, and nothing in
  // the schema said so on purpose.
  //
  // It cannot be fixed by loosening the FK. A register with no module is not a register —
  // it has no roster to derive, no percentage to belong to and no screen that can show
  // it — so `unitId` has to stay required, and a required Cascade means the only place
  // left to say no is here.
  //
  // A register with NO marks is not evidence and does not block: nobody took it, and it
  // is regenerated by publishing the dates again. What blocks is a mark, because a mark
  // is somebody's record of who was in a room.
  const markCount = await prisma.attendanceMark.count({ where: { session: { unitId: existing.id } } });
  if (markCount > 0) {
    const sessionCount = await prisma.hndSession.count({ where: { unitId: existing.id, marks: { some: {} } } });
    return res.status(409).json({
      error: `"${existing.code}" cannot be deleted: ${markCount} attendance mark${markCount === 1 ? " has" : "s have"} been taken on it, across ${sessionCount} register${sessionCount === 1 ? "" : "s"}. Deleting the module would delete them, and attendance is a record of who was in a room. Delete those registers first if that is really what you mean.`,
      markCount,
      sessionCount,
    });
  }

  try {
    await prisma.unit.delete({ where: { id: existing.id } });
    await flagStale([...new Set([...enrolled, ...marked])], "a unit being deleted");
    audit.record(req, {
      action: "unit.deleted", entity: "Unit", entityId: existing.id,
      summary: `Unit ${existing.code} "${existing.name}" deleted, taking ${existing._count.sessions} session(s) and their attendance marks, ${existing._count.enrolments} enrolment(s) and ${existing._count.assessments} assessment(s) with it`,
      before: { code: existing.code, name: existing.name, termId: existing.termId, sessions: existing._count.sessions, enrolments: existing._count.enrolments, assessments: existing._count.assessments },
      after: null,
    });
    res.json({ ok: true });
  }
  catch (_e) { res.status(404).json({ error: "Unit not found" }); }
});

// Set which students are enrolled on a unit — the unit-side mirror of
// PUT /students/:id/enrolments. Replaces the whole set; un-enrolling a student
// deliberately KEEPS any marks they already have, so past registers still read
// as they were taken.
router.put("/units/:id/enrolments", requireAuth, requireHndWrite, async (req, res) => {
  const mod = await prisma.unit.findUnique({ where: { id: req.params.id } });
  if (!mod) return res.status(404).json({ error: "Unit not found" });
  if (!Array.isArray(req.body?.studentIds)) return res.status(400).json({ error: "studentIds must be an array of student ids" });
  if (req.body.studentIds.some((x) => typeof x !== "string")) return res.status(400).json({ error: "studentIds must contain only student ids" });
  const studentIds = [...new Set(req.body.studentIds)];
  if (studentIds.length) {
    const found = await prisma.student.count({ where: { id: { in: studentIds } } });
    if (found !== studentIds.length) return res.status(400).json({ error: "One or more students do not exist" });
  }
  // The set as it stands, so the log can name who was taken OFF rather than only
  // who is on now — un-enrolling is the half of this call that loses something.
  const before = (await prisma.enrolment.findMany({ where: { unitId: mod.id }, select: { studentId: true } })).map((e) => e.studentId);
  const removed = before.filter((id) => !studentIds.includes(id));
  await prisma.$transaction([
    prisma.enrolment.deleteMany({ where: { unitId: mod.id, studentId: { notIn: studentIds.length ? studentIds : ["__none__"] } } }),
    ...studentIds.map((studentId) => prisma.enrolment.upsert({
      where: { studentId_unitId: { studentId, unitId: mod.id } },
      create: { studentId, unitId: mod.id },
      update: {},
    })),
  ]);
  // The UNION of who was on and who is on now. A student taken OFF a unit loses that
  // unit's assessments from their score, which moves it just as much as being added —
  // so flagging only the new set would leave everybody removed frozen at a score
  // computed from work they are no longer doing.
  await flagStale([...new Set([...before, ...studentIds])], "a unit's enrolment being replaced");

  const m = await prisma.unit.findUnique({ where: { id: mod.id }, include: { _count: { select: { sessions: true, enrolments: true } } } });
  // Enrolment decides whose name appears on a register and whose attendance is
  // reported. This call replaces the whole set, so a mistake here silently removes
  // people from a course rather than obviously failing.
  audit.record(req, {
    action: "unit.enrolments.replaced", entity: "Unit", entityId: mod.id,
    summary: `Enrolment on ${mod.code} "${mod.name}" set to ${studentIds.length} student(s), replacing the previous ${before.length}` + (removed.length ? ` — ${removed.length} un-enrolled, their existing marks kept` : ""),
    before: { studentIds: before },
    after: { studentIds, unEnrolled: removed },
  });
  res.json(sUnit(m));
});

/* ============================== students ============================== */

router.get("/students", requireAuth, async (req, res) => {
  const rows = await prisma.student.findMany({
    where: academicDepartmentFilter(req.query?.academicDepartmentId),
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    include: { enrolments: { select: { unitId: true } } },
  });
  res.json(rows.map(sStudent));
});

router.post("/students", requireAuth, requireStudentAdmin, async (req, res) => {
  const firstName = str(req.body?.firstName);
  const lastName = str(req.body?.lastName);
  const studentRef = str(req.body?.studentRef);
  if (!firstName || !lastName) return res.status(400).json({ error: "First and last name required" });
  if (!studentRef) return res.status(400).json({ error: "Student number required" });
  // Lower-case BOTH branches. The generated address previously kept whatever case
  // the student number had, so "HND123@..." and a later hand-typed "hnd123@..."
  // both passed the exact-match uniqueness check and two students shared a mailbox.
  // A generated address is built on the INSTITUTION's own domain, never a hardcoded
  // one: minting "100121@edtech.co.uk" for a different college invents an address on
  // a domain that college does not own, which then fails to deliver and, worse, is a
  // real mailbox belonging to somebody else. With no contact domain configured, the
  // address is left empty and the student simply has none — which every caller
  // already handles, and which is honest.
  const brand = await require("../branding").get();
  const domain = String(brand.contactEmail || "").split("@")[1] || "";
  const email = (str(req.body?.email) || (domain ? `${studentRef}@${domain}` : "")).toLowerCase();

  const refClash = await prisma.student.findFirst({ where: { studentRef } });
  if (refClash) return res.status(409).json({ error: `Student number ${studentRef} is already in use` });
  const emailClash = await prisma.student.findFirst({ where: { email } });
  if (emailClash) return res.status(409).json({ error: `Email ${email} is already in use` });

  // Validate enrolments up front so a bad unitId can't blow up the nested create.
  const unitIds = Array.isArray(req.body?.unitIds) ? [...new Set(req.body.unitIds.filter((x) => typeof x === "string"))] : [];
  if (unitIds.length) {
    const found = await prisma.unit.count({ where: { id: { in: unitIds } } });
    if (found !== unitIds.length) return res.status(400).json({ error: "One or more units do not exist" });
  }
  const cohortId = str(req.body?.cohortId) || null;
  if (cohortId && !(await prisma.cohort.findUnique({ where: { id: cohortId } }))) return res.status(400).json({ error: "Unknown cohort" });

  // Optional date of birth (powers birthday emails). Empty → null; otherwise it must
  // be a real YYYY-MM-DD calendar date, same rule as every other date in this file.
  const dob = str(req.body?.dob);
  if (dob && !isDate(dob)) return res.status(400).json({ error: "Date of birth must be a valid date (YYYY-MM-DD)" });

  // Enrolments are created as their OWN top-level call, never nested under the
  // student.
  //
  // This was once a hard requirement: the tenant extension in db.js stamped tenantId
  // onto `args.data` for the model being called and nothing deeper, so a nested
  // `enrolments: { create: [...] }` reached Prisma with no tenantId on the child rows
  // and was rejected outright — which 500'd the normal way a student is added. That
  // extension is gone and a nested create would now work.
  //
  // The shape is kept anyway, for the two reasons it independently earns: `createMany`
  // takes `skipDuplicates`, which a nested create does not, so re-submitting the same
  // unit list is not an error; and the ids are validated in one `count` up front rather
  // than discovered as a foreign-key violation halfway through a write. See the
  // identical shape in PUT /students/:id/enrolments below.
  let s = await prisma.student.create({
    data: {
      firstName, lastName, studentRef, email, cohortId,
      // Denormalised from the cohort's course. Written HERE, in the same statement as the
      // cohort, because the two must never disagree: a student whose stored department
      // does not match their cohort is a student visible to the wrong department's staff.
      // From the cohort's course when there is one; otherwise from the creator, when that
      // is unambiguous.
      //
      // THE FALLBACK IS NOT A NICETY. Without it a scoped admin adding a student with no
      // cohort creates a row with a null department -- visible only to college-wide accounts
      // -- and the re-read below then returns NULL to its own creator, so the audit line
      // crashes and the request 500s. They cannot see the student they just made, or even
      // find it to fix it. Found by running the suite as a scoped account.
      academicDepartmentId: (await academicDepartments.forCohort(cohortId)) ?? callerDepartmentId(),
      dob: dob || null,
      initials: initialsOf(firstName, lastName),
      colour: colourFor(studentRef + lastName),
    },
    include: { enrolments: { select: { unitId: true } } },
  });
  if (unitIds.length) {
    // Every id was checked above, so this is a straight insert; re-read so the
    // response carries the unitIds the caller just set rather than an empty list.
    await prisma.enrolment.createMany({ data: unitIds.map((unitId) => ({ studentId: s.id, unitId })), skipDuplicates: true });
    s = await prisma.student.findUnique({ where: { id: s.id }, include: { enrolments: { select: { unitId: true } } } });
  }
  audit.record(req, {
    action: "student.created", entity: "Student", entityId: s.id,
    summary: `Student ${studentLabel(s)} added` + (unitIds.length ? `, enrolled on ${unitIds.length} unit(s)` : ""),
    after: { firstName: s.firstName, lastName: s.lastName, studentRef: s.studentRef, email: s.email, cohortId: s.cohortId, units: unitIds.length },
  });
  res.status(201).json(sStudent(s));
});

router.put("/students/:id", requireAuth, requireStudentAdmin, async (req, res) => {
  const existing = await prisma.student.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Student not found" });

  const data = {};
  if (req.body?.firstName !== undefined) {
    const firstName = str(req.body.firstName);
    if (!firstName) return res.status(400).json({ error: "First name required" });
    data.firstName = firstName;
  }
  if (req.body?.lastName !== undefined) {
    const lastName = str(req.body.lastName);
    if (!lastName) return res.status(400).json({ error: "Last name required" });
    data.lastName = lastName;
  }
  if (data.firstName || data.lastName) {
    data.initials = initialsOf(data.firstName || existing.firstName, data.lastName || existing.lastName);
  }
  if (req.body?.studentRef !== undefined) {
    const studentRef = str(req.body.studentRef);
    if (!studentRef) return res.status(400).json({ error: "Student number required" });
    const clash = await prisma.student.findFirst({ where: { studentRef } });
    if (clash && clash.id !== existing.id) return res.status(409).json({ error: `Student number ${studentRef} is already in use` });
    data.studentRef = studentRef;
  }
  if (req.body?.email !== undefined) {
    const email = str(req.body.email).toLowerCase();
    if (!email) return res.status(400).json({ error: "Email required" });
    const clash = await prisma.student.findFirst({ where: { email } });
    if (clash && clash.id !== existing.id) return res.status(409).json({ error: `Email ${email} is already in use` });
    data.email = email;
  }
  if (typeof req.body?.active === "boolean") data.active = req.body.active;
  if (req.body?.cohortId !== undefined) {
    const cohortId = str(req.body.cohortId) || null;
    if (cohortId && !(await prisma.cohort.findUnique({ where: { id: cohortId } }))) return res.status(400).json({ error: "Unknown cohort" });
    data.cohortId = cohortId;
    // THE STORED DEPARTMENT FOLLOWS THE COHORT, in the same update. Without this the
    // column is correct on the day it is written and wrong from the first reorganisation
    // onward -- and a stale value here is not a cosmetic error, it is a student left
    // visible to the department they have just left and hidden from the one they joined.
    data.academicDepartmentId = await academicDepartments.forCohort(cohortId);
  }
  if (req.body?.dob !== undefined) {
    const dob = str(req.body.dob);
    if (dob && !isDate(dob)) return res.status(400).json({ error: "Date of birth must be a valid date (YYYY-MM-DD)" });
    data.dob = dob || null;
  }

  const s = await prisma.student.update({
    where: { id: existing.id }, data,
    include: { enrolments: { select: { unitId: true } } },
  });
  // This route can set `active: false` — deactivation IS suspension here, and
  // requireAuth refuses an inactive student row. A cached active copy must not keep
  // the account signed in for the rest of the TTL. (Email and studentRef edits are
  // identity changes too, per the audit note below — same immediacy, same line.)
  identityCache.invalidate("student", existing.id);
  // Moving a student to another cohort moves their scoring window to that cohort's
  // term calendar; deactivating them takes them out of the register entirely.
  if (data.cohortId !== undefined || data.active !== undefined) {
    await flagStale([existing.id], "a student's cohort or active state changing");
  }
  // The student number and the email are the two identifiers everything else keys
  // off — a register, a Moodle sync and a sign-in all resolve through them — so a
  // change to either is an identity change, not a typo fix.
  audit.record(req, {
    action: "student.updated", entity: "Student", entityId: s.id,
    summary: `Student ${studentLabel(s)} updated` + (data.studentRef && data.studentRef !== existing.studentRef ? ` — student number changed from ${existing.studentRef}` : "") + (data.email && data.email !== existing.email ? ` — email changed from ${existing.email}` : "") + (data.active === false ? " — deactivated" : ""),
    before: { firstName: existing.firstName, lastName: existing.lastName, studentRef: existing.studentRef, email: existing.email, cohortId: existing.cohortId, active: existing.active, dob: existing.dob },
    after: { firstName: s.firstName, lastName: s.lastName, studentRef: s.studentRef, email: s.email, cohortId: s.cohortId, active: s.active, dob: s.dob },
  });
  res.json(sStudent(s));
});

router.delete("/students/:id", requireAuth, requireStudentAdmin, async (req, res) => {
  const existing = await prisma.student.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Student not found" });
  try {
    // Enrolments, attendance marks, grades and PAT interactions cascade at the DB
    // level. Their SignupRequest does NOT — it is matched only by email, which is
    // @unique, so a leftover row would silently stop this person ever signing up
    // again (the endpoint would see a live request and create nothing).
    await prisma.$transaction([
      prisma.signupRequest.deleteMany({ where: { email: existing.email } }),
      prisma.student.delete({ where: { id: existing.id } }),
    ]);
    // The erasure must reach requireAuth immediately: a deleted student's cached row
    // would otherwise keep their app signed in until the TTL ran out.
    identityCache.invalidate("student", existing.id);
    // Their attendance, marks, grades and PAT interactions go with them. Under a
    // retention schedule this is the erasure the college has to be able to evidence,
    // and this row is what survives to evidence it.
    audit.record(req, {
      action: "student.deleted", entity: "Student", entityId: existing.id,
      summary: `Student ${studentLabel(existing)} deleted — enrolments, attendance marks, grades and PAT interactions removed with the record`,
      before: { firstName: existing.firstName, lastName: existing.lastName, studentRef: existing.studentRef, email: existing.email, cohortId: existing.cohortId },
      after: null,
    });
    res.json({ ok: true });
  } catch (_e) { res.status(400).json({ error: "Could not delete this student" }); }
});

// Replace a student's unit enrolments wholesale.
// Un-enrolling drops the student from future registers but deliberately KEEPS
// their existing marks, so past registers still read as they were taken.
router.put("/students/:id/enrolments", requireAuth, requireHndWrite, async (req, res) => {
  const student = await prisma.student.findUnique({ where: { id: req.params.id } });
  if (!student) return res.status(404).json({ error: "Student not found" });
  // This is the one call that can wipe a student's whole enrolment set, so malformed
  // input must NOT be read as "clear everything". Sending a string, or omitting the
  // field, previously dropped the student off every register with a cheerful 200.
  if (!Array.isArray(req.body?.unitIds)) return res.status(400).json({ error: "unitIds must be an array of unit ids" });
  if (req.body.unitIds.some((x) => typeof x !== "string")) return res.status(400).json({ error: "unitIds must contain only unit ids" });
  const unitIds = [...new Set(req.body.unitIds)];
  if (unitIds.length) {
    const found = await prisma.unit.count({ where: { id: { in: unitIds } } });
    if (found !== unitIds.length) return res.status(400).json({ error: "One or more units do not exist" });
  }
  const before = (await prisma.enrolment.findMany({ where: { studentId: student.id }, select: { unitId: true } })).map((e) => e.unitId);
  const removed = before.filter((id) => !unitIds.includes(id));
  await prisma.$transaction([
    prisma.enrolment.deleteMany({ where: { studentId: student.id, unitId: { notIn: unitIds.length ? unitIds : ["__none__"] } } }),
    ...unitIds.map((unitId) => prisma.enrolment.upsert({
      where: { studentId_unitId: { studentId: student.id, unitId } },
      create: { studentId: student.id, unitId },
      update: {},
    })),
  ]);
  // One student, whose set of units — and therefore whose assessments and registers —
  // has just been replaced wholesale.
  await flagStale([student.id], "a student's enrolments being replaced");

  const s = await prisma.student.findUnique({ where: { id: student.id }, include: { enrolments: { select: { unitId: true } } } });
  audit.record(req, {
    action: "student.enrolments.replaced", entity: "Student", entityId: student.id,
    summary: `${studentLabel(student)} enrolled on ${unitIds.length} unit(s), replacing the previous ${before.length}` + (removed.length ? ` — dropped from ${removed.length}, their existing marks kept` : ""),
    before: { unitIds: before },
    after: { unitIds, droppedFrom: removed },
  });
  res.json(sStudent(s));
});

/* ============================== sessions ============================== */

router.get("/sessions", requireAuth, async (req, res) => {
  const unitId = str(req.query?.unitId);
  const [rows, agg] = await Promise.all([
    // Oldest first: the start-date register is on top, and within a day the earlier
    // block (e.g. 09:00 before 13:00) comes first.
    prisma.hndSession.findMany({ where: unitId ? { unitId } : undefined, orderBy: [{ date: "asc" }, { startTime: "asc" }] }),
    prisma.attendanceMark.groupBy({ by: ["sessionId"], _count: { _all: true }, where: unitId ? { session: { unitId } } : undefined }),
  ]);
  const cMap = new Map(agg.map((a) => [a.sessionId, a._count._all]));
  res.json(rows.map((s) => ({ ...sSession(s), markedCount: cMap.get(s.id) || 0 })));
});

router.post("/sessions", requireAuth, requireRegisters, async (req, res) => {
  const unitId = str(req.body?.unitId);
  const date = str(req.body?.date);
  const start = str(req.body?.start);
  const end = str(req.body?.end);
  if (!unitId) return res.status(400).json({ error: "Unit required" });
  const mod = await prisma.unit.findUnique({ where: { id: unitId } });
  if (!mod) return res.status(400).json({ error: "Unknown unit" });
  if (!isDate(date)) return res.status(400).json({ error: "Valid date required (YYYY-MM-DD)" });
  if (!isTime(start) || !isTime(end)) return res.status(400).json({ error: "Valid start and end times required (HH:MM)" });
  if (end <= start) return res.status(400).json({ error: "End time must be after the start time" });

  // One register per unit / date / start-time is now enforced by the database. A
  // clash must read as a conflict the admin can act on, not "Server error".
  let s;
  try {
    s = await prisma.hndSession.create({
      data: {
        unitId, date, startTime: start, endTime: end,
        description: str(req.body?.description) || mod.code,
        audience: str(req.body?.audience) || "All students",
        kind: str(req.body?.kind) || "",
      },
    });
  } catch (e) {
    if (e?.code === "P2002") return res.status(409).json({ error: `${mod.code} already has a register on ${date} at ${start}.` });
    throw e;
  }
  res.status(201).json(sSession(s));
});

router.put("/sessions/:id", requireAuth, requireRegisters, async (req, res) => {
  const existing = await prisma.hndSession.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Session not found" });
  const data = {};
  if (req.body?.date !== undefined) {
    if (!isDate(str(req.body.date))) return res.status(400).json({ error: "Valid date required (YYYY-MM-DD)" });
    data.date = str(req.body.date);
  }
  if (req.body?.start !== undefined) {
    if (!isTime(str(req.body.start))) return res.status(400).json({ error: "Valid start time required (HH:MM)" });
    data.startTime = str(req.body.start);
  }
  if (req.body?.end !== undefined) {
    if (!isTime(str(req.body.end))) return res.status(400).json({ error: "Valid end time required (HH:MM)" });
    data.endTime = str(req.body.end);
  }
  const start = data.startTime || existing.startTime;
  const end = data.endTime || existing.endTime;
  if (end <= start) return res.status(400).json({ error: "End time must be after the start time" });
  if (req.body?.description !== undefined) data.description = str(req.body.description);
  if (req.body?.audience !== undefined) data.audience = str(req.body.audience) || "All students";
  if (req.body?.kind !== undefined) data.kind = str(req.body.kind);
  let s;
  try {
    s = await prisma.hndSession.update({ where: { id: existing.id }, data });
  } catch (e) {
    // Moving a register onto a slot the unit already uses.
    if (e?.code === "P2002") return res.status(409).json({ error: "There is already a register for this unit at that date and time." });
    throw e;
  }
  // The session's DATE is what places its marks inside or outside a student's scoring
  // window, so moving a register moves everyone on it — without touching a mark.
  if (data.date !== undefined) {
    const onIt = (await prisma.attendanceMark.findMany({ where: { sessionId: existing.id }, select: { studentId: true } })).map((m) => m.studentId);
    await flagStale(onIt, "a register being moved to another date");
  }
  res.json(sSession(s));
});

router.delete("/sessions/:id", requireAuth, requireRegisters, async (req, res) => {
  // A closed term's registers are the record an awarding-body or UKVI audit treats as
  // final. Editing one is gated behind the 423 below; DELETING one — which cascades
  // away every mark on it — was not gated at all, so the lock protected the marks and
  // not the register that held them.
  const existing = await prisma.hndSession.findUnique({
    where: { id: req.params.id },
    include: { unit: { include: { term: true } }, _count: { select: { marks: true } } },
  });
  if (!existing) return res.status(404).json({ error: "Session not found" });
  const term = existing.unit?.term;
  if (term && existing._count.marks > 0 && req.body?.override !== true) {
    const today = localDate();
    if (today < term.start || today > term.end) {
      return res.status(423).json({ error: `${term.name} is ${today > term.end ? "over" : "not open yet"} — this register holds ${existing._count.marks} mark${existing._count.marks === 1 ? "" : "s"} and can't be deleted while the term is closed.`, locked: true });
    }
  }
  // Read who was on the register BEFORE deleting it — the marks cascade away with the
  // session, and with them any way of knowing whose attendance figure just changed.
  const onIt = (await prisma.attendanceMark.findMany({ where: { sessionId: existing.id }, select: { studentId: true } })).map((m) => m.studentId);
  try {
    await prisma.hndSession.delete({ where: { id: existing.id } });
    await flagStale(onIt, "a register being deleted");
    res.json({ ok: true });
  }
  catch (_e) { res.status(404).json({ error: "Session not found" }); }
});

// Generate one weekly session for a unit across a date range — the same weekday
// as the start date, every 7 days up to and including the end date. Used when a
// course is created with a term start/end so its whole register schedule appears
// at once. Idempotent: dates that already have a session for this unit are
// skipped, so re-running never duplicates.
const MAX_WEEKLY_SESSIONS = 60; // ~14 months of weeks — a safety cap, not a limit anyone hits
// No register can hold more rows than a unit has students; 500 leaves generous room
// while keeping one save to a transaction the database can finish quickly.
const MAX_REGISTER_ROWS = 500;
router.post("/units/:id/sessions/generate", requireAuth, requireRegisters, async (req, res) => {
  const mod = await prisma.unit.findUnique({ where: { id: req.params.id } });
  if (!mod) return res.status(404).json({ error: "Unit not found" });

  // Fall back to the unit's own teaching window, so "create the registers" needs no
  // dates re-typed once the unit is scheduled.
  const start = str(req.body?.start) || mod.startDate || "";
  const end = str(req.body?.end) || mod.endDate || "";
  const audience = str(req.body?.audience) || "All students";
  if (!isDate(start) || !isDate(end)) return res.status(400).json({ error: "Valid start and end dates required (YYYY-MM-DD) — set the unit's teaching dates, or pass a range" });
  if (end < start) return res.status(400).json({ error: "End date must be on or after the start date" });

  // Registers per class day come from the taught hours: each register covers 3 hours,
  // so 3h → 1 register, 6h → 2, and so on. Registers fall into fixed 3-hour blocks.
  const hours = Number(req.body?.hours);
  const HOURS_PER_REGISTER = 3;
  const BLOCKS = [["10:00", "13:00"], ["14:00", "17:00"], ["17:00", "20:00"], ["20:00", "23:00"]];
  let blocks;
  if (Number.isFinite(hours) && hours > 0) {
    const perDay = Math.min(Math.max(1, Math.round(hours / HOURS_PER_REGISTER)), BLOCKS.length);
    blocks = BLOCKS.slice(0, perDay);
  } else {
    // Backward-compatible fallback: a single register at any supplied times.
    const st = isTime(str(req.body?.startTime)) ? str(req.body.startTime) : "09:00";
    const et = isTime(str(req.body?.endTime)) ? str(req.body.endTime) : "12:00";
    blocks = [[st, et]];
  }

  // Step weekly in UTC so a timezone can't nudge a date across midnight.
  const dates = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last && dates.length < MAX_WEEKLY_SESSIONS) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  // Was the range longer than the cap allows? Reported so a two-year window can't
  // quietly produce fourteen months of registers and still say "created".
  const truncatedAt = cursor <= last ? dates[dates.length - 1] : null;

  // A register is unique per (date, block start-time), so we can add missing blocks
  // without duplicating ones already generated. The DB enforces the same key, so a
  // concurrent second call can't slip a duplicate past this read.
  const existing = await prisma.hndSession.findMany({ where: { unitId: mod.id, date: { in: dates } }, select: { date: true, startTime: true } });
  const have = new Set(existing.map((x) => `${x.date}|${x.startTime}`));
  // On a multi-register day the first block is Teaching, the second a Seminar.
  const KINDS = ["Teaching", "Seminar", "Teaching", "Seminar"];
  const toCreate = [];
  for (const date of dates) {
    blocks.forEach(([s, e], i) => {
      if (!have.has(`${date}|${s}`)) toCreate.push({ unitId: mod.id, date, startTime: s, endTime: e, description: mod.code, audience, kind: KINDS[i] || "" });
    });
  }
  // skipDuplicates so a race with another generate is a no-op rather than a 500.
  // Report what the DATABASE actually inserted. With skipDuplicates a concurrent run
  // can win some rows, so the intended count over-states what this call achieved.
  let createdCount = 0;
  if (toCreate.length) createdCount = (await prisma.hndSession.createMany({ data: toCreate, skipDuplicates: true })).count;

  // Registers on this unit that fall OUTSIDE the requested window — usually a
  // previous run on a different weekday, which used to be invisible.
  const strayCount = await prisma.hndSession.count({
    where: { unitId: mod.id, OR: [{ date: { lt: start } }, { date: { gt: end } }] },
  });
  res.status(201).json({
    ok: true, weeks: dates.length, registersPerWeek: blocks.length, created: createdCount,
    truncatedAt, strayCount,
  });
});

/* ============================== the register ============================== */

// GET the register for one session: every enrolled student, with their existing
// mark if the register has already been taken.
router.get("/sessions/:id/register", requireAuth, async (req, res) => {
  const session = await prisma.hndSession.findUnique({
    where: { id: req.params.id },
    include: { unit: true, marks: true },
  });
  if (!session) return res.status(404).json({ error: "Session not found" });

  const enrolments = await prisma.enrolment.findMany({
    where: { unitId: session.unitId },
    include: { student: true },
  });
  const byStudent = new Map(session.marks.map((m) => [m.studentId, m]));
  // WHO ON THIS REGISTER SHARED A HANDSET WITH WHOM.
  //
  // Computed here, from the marks already loaded, rather than sent to the browser as raw
  // device ids for it to compare. The ids never leave the building: a random tracking
  // identifier handed to a browser is a tracking identifier whatever it was collected for,
  // and the screen has no use for the value — only for the fact of a collision.
  //
  // A FLAG, NEVER A VERDICT. Two accounts marked from one phone is what proxy attendance
  // looks like from here, and it is also what a flat battery and a ten-second loan look
  // like. It goes in front of the member of staff who knows the room.
  const sharedDevices = sharedDeviceGroups(session.marks);

  // Kept as a set of ids rather than asked of `enrolments` row by row, so this handler
  // and the live view answer `enrolled` the same way — the two rendered the identical
  // line and one of them had no such set, which is how a stray edit to one silently
  // 500'd the other.
  const enrolledIds = new Set(enrolments.map((e) => e.studentId));

  // THE ROSTER, NOT THE ENROLMENT LIST. This read only Enrolment, so a register built
  // for a GROUP on a module with no enrolment data listed nobody — while its own
  // `audience` line said it held the whole group. rosterForSession applies the rule that
  // built the register, so the sheet and its description now agree.
  const roster = await rosterForSession(session);
  const rosterIds = new Set(roster.studentIds);

  // A student who has since left the group or been un-enrolled but was marked on this
  // session still belongs on the register — otherwise their mark would silently vanish.
  const extra = session.marks.filter((m) => !rosterIds.has(m.studentId)).map((m) => m.studentId);

  // Fetched by id rather than reused from `enrolments`, because a cohort-only roster
  // contains students who have no Enrolment row at all — exactly the ones that were
  // missing — so the enrolment join cannot supply them.
  const needed = [...rosterIds, ...extra];
  const students = needed.length
    ? await prisma.student.findMany({ where: { id: { in: needed } } })
    : [];
  students.sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));

  res.json({
    session: sSession(session),
    unit: sUnit(session.unit),
    rows: students.map((s) => {
      const mark = byStudent.get(s.id);
      return {
        student: sStudent(s),
        status: mark?.status || null,
        remark: mark?.remark || "",
        // Whether the student put themselves on this register or a member of staff did,
        // decided by the SAME predicate the live view uses. The paper register is where a
        // disputed mark is actually argued about, and it could not tell a tap from a
        // lecturer's tick — it shipped `takenBy` and nothing else, so the screen either
        // ignored provenance or had to re-derive it from a string.
        //
        // Answered here rather than on the client on purpose. `isSelfCheckIn` matches an
        // allowlist of stamps that only this module knows about; a browser comparing
        // against one of them would report every OTHER capture method as staff-marked,
        // which is the bug that already had to be fixed once on the live view. Two screens
        // that disagree about what counts as a self check-in is worse than neither showing
        // it, because one of them is then quietly wrong on the register an inspector reads.
        //
        // FALSE HERE IS NOT "A MEMBER OF STAFF DID IT". An unmarked student, and a mark
        // whose takenBy was never recorded, both come back `selfMarked: false` with
        // `takenBy: null` — "not recorded", which the screen must say rather than
        // attributing the mark to a person who may not have made it.
        selfMarked: isSelfCheckIn(mark?.takenBy),
        // WHICH self check-in — "qr", "nfc", or null for everything else. Derived from the
        // same map `isSelfCheckIn` reads, so the two can never disagree about a row.
        //
        // Here because the browser was doing it: both screens re-derived the method by
        // comparing `takenBy` against the literal "Self check-in (QR)", which put a frozen
        // English string in three files and made a change to its WORDING silently relabel
        // every QR mark as a tap. A sticker needs somebody in the room; a code on a
        // projector can be photographed and sent to a friend. Those are different answers
        // to "how could this mark exist", and this is the field an administrator arguing
        // about a disputed register is reading. `takenBy` still ships beside it — it is the
        // human-readable provenance, and other screens print it.
        //
        // NULL IS NOT "STAFF". A row with no mark, and a mark whose takenBy was never
        // recorded, both come back null here, and neither is evidence about a person.
        checkInMethod: checkInMethod(mark?.takenBy),
        takenBy: mark?.takenBy || null,
        // Whether this mark and another student's on the SAME register came from the same
        // handset — as a count of the others, never their names.
        //
        // A NUMBER RATHER THAN A LIST, deliberately. The names are already on the screen:
        // a lecturer looking at a flagged row is looking at a register of thirty students
        // and can see which other row carries the same flag. Shipping the names would put
        // "checked in on the same device as Jane Smith" into a payload about Tom Brown,
        // which is a statement about Jane in Tom's record, reachable by anybody who can
        // read Tom's row.
        //
        // 0 IS A REAL ANSWER HERE, unlike almost everywhere else in this codebase: it
        // means "we recorded a handset and it was theirs alone". A hand-marked row has no
        // handset to compare and is also 0, which is the right reading — nothing was
        // observed, so nothing is claimed.
        sharedDeviceWith: sharedDevices.get(s.id)?.length || 0,

        // Still literally 'has an Enrolment row'. A student present through their GROUP
      // is on the register and is NOT enrolled, and a tick here would state something
      // false about their academic record.
      enrolled: enrolledIds.has(s.id),
      };
    }),
    taken: session.marks.length > 0,
  });
});

// Save the register. Accepts a partial list — only the students present in the
// body are written, so a half-finished register can be saved and resumed.
// A row with status null/"" clears that student's mark.
// lecturerGate, NOT requireRegisters, and this REMOVES an asymmetry rather than adding a
// permission. Whoever teaches a class could already close its register — writing "A"
// against every unmarked student in one action, through /mark-remaining-absent, which
// lecturerGate has fronted since 3 Sep 2026. What they could not do was set ONE student
// present. So the blunter, more damaging action was the more permitted one, and a
// lecturer correcting a single mark had to ask an administrator.
//
// Same predicate as `mayClose` and as the `canMark` flag the live view hands the screen,
// so the control, the flag and the route cannot disagree — a dropdown that is offered
// and then 403s is worse than no dropdown.
router.put("/sessions/:id/register", requireAuth, lecturerGate(["registers"]), async (req, res) => {
  const session = await prisma.hndSession.findUnique({ where: { id: req.params.id }, include: { unit: { include: { term: true } } } });
  if (!session) return res.status(404).json({ error: "Session not found" });

  // Term gate: if the unit belongs to a term, only its ACTIVE window (today within
  // the term dates) accepts marks. A past or not-yet-started term is locked, so
  // attendance "pauses" when the term ends — unless an admin reopens it to fix a
  // mark (override:true). Units with no term are unaffected.
  const term = session.unit?.term;
  if (term && req.body?.override !== true) {
    const today = localDate();
    if (today < term.start || today > term.end) {
      return res.status(423).json({ error: `${term.name} is ${today > term.end ? "over" : "not open yet"} — reopen it to edit this register.`, locked: true });
    }
  }

  const marks = Array.isArray(req.body?.marks) ? req.body.marks : null;
  if (!marks) return res.status(400).json({ error: "marks array required" });
  // A register can never legitimately carry more rows than the unit has students.
  // Without a cap, one 1MB request becomes ~15,000 operations in a single
  // transaction, which holds a connection long enough to starve the whole API.
  if (marks.length > MAX_REGISTER_ROWS) return res.status(400).json({ error: `Too many rows in one save (limit ${MAX_REGISTER_ROWS})` });

  const rows = [];
  const seen = new Set();
  for (const m of marks) {
    const studentId = str(m?.studentId);
    if (!studentId) return res.status(400).json({ error: "Each mark needs a studentId" });
    // Duplicates previously slipped past the existence check (which compared against
    // the de-duplicated count) and became repeated writes to the same row.
    if (seen.has(studentId)) return res.status(400).json({ error: "The same student appears twice in one save" });
    seen.add(studentId);
    const status = m?.status == null || m.status === "" ? null : str(m.status).toUpperCase();
    if (status !== null && !isStatus(status)) return res.status(400).json({ error: `Invalid status "${m.status}" — use P, L, E or A` });
    // `remark` is only written when the caller actually sent one, so a partial save
    // that omits the field can't wipe a note somebody left.
    const hasRemark = typeof m?.remark === "string";
    rows.push({ studentId, status, remark: hasRemark ? m.remark.slice(0, 500) : "", hasRemark });
  }

  // A CLASS THAT HAS NOT HAPPENED YET CANNOT BE MARKED, and mark-remaining-absent's
  // comment has named this hole since it grew its own guard: "PUT /register has the same
  // hole".
  //
  // AFTER the body is parsed, not before it. Placed first, this answered "that class
  // hasn't happened yet" to a request with a malformed status or a duplicate student —
  // describing the wrong fault, and quietly turning two existing assertions green for a
  // reason that had nothing to do with what they test. A caller gets told what THEY got
  // wrong before being told what the calendar says.
  //
  // A mark on a future class is not merely premature, it is DISQUALIFYING. A tap can
  // never overwrite an existing mark — deliberately, so a lecturer's decision is not
  // undone by a student's phone — so an A planted on next Tuesday means that student
  // cannot check in when next Tuesday arrives. The register looks taken and the student
  // looks absent, and nothing on either screen explains why their tap did nothing.
  //
  // `override: true` still passes, exactly as it does for the term lock above: recording
  // an authorised absence in advance is a real thing an administrator does, and this
  // stops it being something anybody does BY ACCIDENT.
  if (session.date > localDate() && req.body?.override !== true) {
    return res.status(400).json({
      error: "That class hasn't happened yet. Marking it now would stop those students checking in when it runs.",
      future: true,
    });
  }

  const ids = rows.map((r) => r.studentId);
  if (ids.length) {
    // Enrolment, not mere existence. Checking only that the student exists let a
    // mistyped or stale id attach a mark — and therefore a whole unit — to somebody
    // who was never on the course.
    // THE SAME ROSTER THE LISTING USES. Gating on Enrolment alone made every register
    // built for a group unusable on a module with no enrolment data: the sheet listed
    // the group (after the fix above) and then refused every mark on it with "not
    // enrolled on this unit". Two endpoints answering "who is on this register"
    // differently is what produced that, so both now ask rosterForSession.
    //
    // This is not a loosening. The check exists so a mistyped or stale id cannot attach
    // a mark — and therefore a unit — to somebody who was never on the course, and
    // cohort membership is an explicit act by an administrator exactly as enrolment is.
    // What it stops being is a check that only recognises ONE of the two ways a student
    // legitimately arrives on a register.
    const okIds = new Set((await rosterForSession(session)).studentIds);
    // Marks already on this register stay editable even if the student has since left
    // the group or been un-enrolled, so historic registers remain correctable.
    //
    // ASKED OF THE IDS IN THE REQUEST, not of two unrelated quantities. This read
    // `okIds.size !== ids.length` — the size of the ROSTER against the length of the
    // REQUEST — which are measuring different things and coincide by accident. Whenever
    // they happened to match, the top-up never ran and a student plainly on the sheet was
    // refused: correcting one mark for a student who had since left the group failed,
    // while sending that same correction alongside one other row succeeded. The same
    // edit, accepted or rejected by how many OTHER rows the client bundled with it.
    if (ids.some((id) => !okIds.has(id))) {
      const existing = await prisma.attendanceMark.findMany({ where: { sessionId: session.id, studentId: { in: ids } }, select: { studentId: true } });
      for (const e of existing) okIds.add(e.studentId);
    }
    const stray = ids.filter((id) => !okIds.has(id));
    if (stray.length) return res.status(400).json({ error: `${stray.length} student${stray.length === 1 ? " is" : "s are"} not on this register` });
  }

  // Stamp an out-of-term correction so it is identifiable afterwards. A reopened
  // register was written exactly like an in-term one, so nothing in the data
  // distinguished a mark taken on the day from one added months after the term closed
  // — which is the first question an audit asks.
  const outOfTerm = Boolean(term && req.body?.override === true);
  const takenBy = req.user?.name ? (outOfTerm ? `${req.user.name} (out-of-term correction)` : req.user.name) : null;
  // The register as it stands, read before the write. takenBy on the mark itself is
  // overwritten by the next save, so without this snapshot a mark changed from A to P
  // months later leaves nothing behind saying it was ever an A.
  const priorMarks = new Map(
    (await prisma.attendanceMark.findMany({ where: { sessionId: session.id }, select: { studentId: true, status: true, takenBy: true } }))
      .map((m) => [m.studentId, { status: m.status, takenBy: m.takenBy }])
  );

  // A SAVE THAT CHANGES NOTHING MUST NOT RESTAMP THE WHOLE CLASS AS LECTURER-MARKED.
  //
  // This wrote `takenBy` on every row in the request, and a register save re-sends the
  // ENTIRE class whether or not anything moved. So opening a register and pressing Save —
  // the most ordinary action on this screen — replaced every student's self check-in stamp
  // with the lecturer's name. `selfMarked` went false, `checkInMethod` went null, and the
  // register, the live view and the exported CSV all stopped showing that thirty students
  // had tapped in. No status changed, so `moved` was 0 and NOTHING WAS AUDITED: the only
  // record that those marks were ever self check-ins was destroyed silently, by a save
  // that did nothing else.
  //
  // The brief's rule is "once marked, cannot be overridden unless the lecturer does it from
  // the dashboard". A lecturer who CHANGES a mark is doing exactly that and takes ownership
  // of it, which is why takenBy still moves to their name below. A lecturer who changes
  // nothing has overridden nothing, and must not inherit the authorship of a mark the
  // student made.
  //
  // Keyed on the STATUS, not on the remark. A remark is a note about a mark; it does not
  // assert that the student was or was not there, so editing one leaves the question this
  // column answers — who says this status is right — untouched.
  const statusMoved = (r) => (priorMarks.get(r.studentId)?.status ?? null) !== r.status;

  // AND THE SAME RULE AGAIN FOR A MARK WE DID NOT KNOW ABOUT — the race.
  //
  // `priorMarks` is read before the writes. A student who checks themselves in during that
  // gap has no entry in it, so `statusMoved` compares null against their status, says
  // "changed", and the update stamps the LECTURER's name over "Self check-in (QR)". The
  // row is then internally contradictory: attributed to a member of staff, carrying a
  // student's arrival time and the handset it came from.
  //
  // Worse, the audit below reads the same stale map, records `before: null`, and so claims
  // the lecturer CREATED a mark they did not — and `overrodeSelf` counts zero, because the
  // stale map has no takenBy to recognise. In the race, the trail added to record overrides
  // says the opposite of what happened.
  //
  // So takenBy moves only when we actually SAW the prior mark. Absent from the map means
  // one of two things and both want the same handling: either there is no row, in which
  // case the `create` branch below sets takenBy anyway; or a row appeared underneath us, in
  // which case we know nothing about its provenance and must not overwrite it. Narrowing
  // the window further — an interactive transaction — would not close it either, because
  // Postgres reads at READ COMMITTED; declining to write the field we cannot reason about
  // is the fix that does not depend on timing at all.
  const knownPrior = (r) => priorMarks.has(r.studentId);

  await prisma.$transaction(rows.map((r) => (
    r.status === null
      ? prisma.attendanceMark.deleteMany({ where: { sessionId: session.id, studentId: r.studentId } })
      : prisma.attendanceMark.upsert({
          where: { sessionId_studentId: { sessionId: session.id, studentId: r.studentId } },
          create: { sessionId: session.id, studentId: r.studentId, status: r.status, remark: r.remark, takenBy },
          update: {
            status: r.status,
            ...(r.hasRemark ? { remark: r.remark } : {}),
            ...(knownPrior(r) && statusMoved(r) ? { takenBy } : {}),
            takenAt: new Date(),
          },
        })
  )));

  // Attendance is the record a college is asked to evidence most often — funding,
  // visa compliance, a student disputing a mark. Only the marks that actually MOVED
  // are written: a register save re-sends the whole class whether or not anything
  // changed, and one corrected A buried under thirty unchanged Ps is not a record of
  // anything. audit.js caps the object at 40 keys, which covers a class and stops a
  // bulk import writing a several-hundred-key blob.
  const before = {}, after = {};
  for (const r of rows) {
    // `null` here means "there was no mark", which is a CLAIM about the register's prior
    // state. In the race above there was a mark and we simply had not read it, so the
    // entry would say the lecturer created something that already existed. Where we did
    // not see the row, the honest word is that we do not know.
    const was = priorMarks.has(r.studentId) ? priorMarks.get(r.studentId).status : "(not read)";
    if (was === r.status) continue;
    before[r.studentId] = was;
    after[r.studentId] = r.status;
  }
  const moved = Object.keys(after).length;
  // HOW MANY OF THOSE REPLACED A STUDENT'S OWN CHECK-IN, counted before the write is
  // described. "P changed to A" is the whole audit entry today, and it does not say the P
  // was a student's own tap — which is precisely the fact a disputed mark turns on, and
  // precisely what the student will say when they appeal. It is one number and it costs
  // nothing to record.
  //
  // `isStudentAction`, not `isSelfCheckIn`, is what this sentence needs. The two used to
  // be the same predicate, back when every entry in SELF_CHECKIN_METHODS was something a
  // student pressed a button for; TEAMS_AUTO_STAMP broke that, because it is written by a
  // sync process reading Microsoft's record, never by the student in the moment. Counting
  // it under `isSelfCheckIn` here made the sentence say a lecturer's correction "replaced
  // a mark the student had made themselves" when what it replaced was a machine's report
  // — exactly backwards in the one document an appeal turns on. `overrodeMachine` gets its
  // own count and its own honest clause instead of being silently folded into either the
  // student's count or nothing at all.
  const overrodeSelf = Object.keys(after).filter((id) => isStudentAction(priorMarks.get(id)?.takenBy)).length;
  const overrodeMachine = Object.keys(after).filter((id) => {
    const prior = priorMarks.get(id)?.takenBy;
    return isSelfCheckIn(prior) && !isStudentAction(prior);
  }).length;
  // Only the marks that actually MOVED. A register save re-sends the whole class, so
  // flagging every student on it would rescore the cohort every time a register is
  // opened and closed unchanged.
  if (moved) await flagStale(Object.keys(after), "a register save");
  if (moved) {
    audit.record(req, {
      action: outOfTerm ? "attendance.register.corrected" : "attendance.register.saved",
      entity: "HndSession", entityId: session.id,
      summary: `${moved} attendance mark(s) changed on the ${session.date} register for ${session.unit?.code || "a unit"}` +
        (overrodeSelf ? `, ${overrodeSelf} of which replaced a mark the student had made themselves` : "") +
        (overrodeMachine ? `, ${overrodeMachine} of which replaced a mark recorded automatically from the online class` : "") +
        (outOfTerm ? ` — an out-of-term correction made after ${term.name} closed on ${term.end}` : "") +
        ` by ${req.user?.name || "an administrator"}`,
      before, after,
    });
  }

  const saved = await prisma.attendanceMark.findMany({ where: { sessionId: session.id } });
  res.json({ ok: true, saved: saved.length, marks: saved.map(sMark) });
});

// GET /api/hnd/check-in-settings — which self check-in methods this college has on.
//
// For the Registers page, which offers a "QR code" action on each session only when
// there is a code to show. Behind the router-wide gate like every other read here; the
// full settings (thresholds, rotation) stay on /tags/settings behind their own page.
router.get("/check-in-settings", async (_req, res) => {
  const settings = await tapConfig.get();
  res.json({ tapEnabled: settings.enabled === true, qrEnabled: settings.qrEnabled === true });
});

/* ========================= the lecturer's live view ========================= */

// GET /api/hnd/my-sessions/today — the classes this account is teaching today.
//
// WHO CAN ACTUALLY SEE THIS. Everything on this router is admin-only by design —
// see DEF-01 at the top of the file — so "lecturer" here means a member of staff
// who also holds an admin account with live-attendance or registers. An ordinary
// teaching account cannot reach registers at all and never could. That is a
// deliberate decision recorded above, not an oversight, but it does mean this
// screen is narrower than "the lecturer's dashboard" would suggest: a college
// wanting every tutor to watch their own register has to grant them the page.
//
// "Mine" means BOTH answers `teachesSession` knows about — the tutor of the unit, and
// the staff the TIMETABLE names on the event this register was built from. It was only
// the first for as long as Unit.tutorStaffId was the only identity the platform held,
// and the consequence was a lecturer who genuinely had three classes today being shown
// "No classes of yours today" and told to ask an administrator to make them the tutor of
// a module somebody else owns. Free text (`Unit.tutor`, `TimetableSlot.lecturer`) is
// still deliberately NOT matched on: a name typed into a box is not an identity, and
// matching on it would hand one lecturer another's register whenever two people share a
// surname.
router.get("/my-sessions/today", requireAuth, requireStaffAccount, async (req, res) => {
  // ?date=YYYY-MM-DD, DEFAULTING TO TODAY.
  //
  // A screen that can only ever show today is unusable on the day it matters most: the
  // afternoon before term starts, an administrator checking that Tuesday's registers
  // exist sees "no classes today" and cannot tell a correctly-empty Wednesday from a
  // term that failed to save. Reported exactly that way, on a college whose first class
  // was six days out.
  //
  // It widens no access. The same teachesSessionWhere filter runs whatever the date, so
  // this lets a lecturer look at their OWN other days and nothing else; ?scope=all is
  // still gated on the administrative pages. A malformed date is REFUSED rather than
  // silently falling back to today — a request that asked about Tuesday and was answered
  // about Wednesday is worse than an error, because nothing on the screen says so.
  const asked = str(req.query.date || "");
  if (asked && !isDate(asked)) return res.status(400).json({ error: "date must be a real date, YYYY-MM-DD" });
  const date = asked || localDate();

  // ?to=YYYY-MM-DD TURNS THE DAY INTO A RANGE.
  //
  // "How did last week go" and "is next week's timetable actually there" are the two
  // questions this screen could not answer at all, and both are asked far more often
  // than "what is happening in the next hour". `to` is optional and absent means the
  // single day, so every existing caller is unaffected.
  //
  // CAPPED AT 92 DAYS, and the cap is not arbitrary politeness: this handler reads every
  // register in the range plus their marks, and with ?scope=all that is the whole
  // college. A term is thirteen weeks, so a term fits and a year does not — which is the
  // line between a question about teaching and a report that should be exported.
  const to = str(req.query.to || "");
  if (to && !isDate(to)) return res.status(400).json({ error: "to must be a real date, YYYY-MM-DD" });
  if (to && to < date) return res.status(400).json({ error: "to must not be before the start date" });
  const MAX_RANGE_DAYS = 92;
  if (to && Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000) > MAX_RANGE_DAYS) {
    return res.status(400).json({ error: `That range is too wide — ask for ${MAX_RANGE_DAYS} days or fewer.` });
  }
  const dateWhere = to ? { gte: date, lte: to } : date;

  // A RANGE IS NEVER "TODAY", even one that contains it. Everything gated on isToday
  // says "right now" — the running-class highlight, the tap window — and a week that
  // happens to include today is still not a moment.
  const isToday = !to && date === localDate();
  const time = localTime();
  const settings = await tapConfig.get();
  // Whether this account teaches anything at all, ever — not today, and not on this
  // list. The staff app shows its "My classes" tile on this, not on the day's list being
  // non-empty: a lecturer with no class today still teaches, and a tile that vanishes on
  // quiet days reads as the feature breaking. Both halves of "teaches", for the same
  // reason the list has both: somebody named only on timetable events tutors no unit,
  // and counting units alone told them they teach nothing.
  const [tutorsUnits, namedOnEvents] = await Promise.all([
    prisma.unit.count({ where: { tutorStaffId: req.user.id } }),
    prisma.timetableEventStaff.count({ where: { staffId: req.user.id } }),
  ]);
  const teaches = tutorsUnits > 0 || namedOnEvents > 0;

  // ?scope=all — every session running today, not only the caller's own.
  //
  // Without this the screen was empty for almost everybody who can reach it. The default
  // filters on who TEACHES the class, and an administrator, a head of department or an
  // inspector teaches nothing — so a page they had been deliberately granted showed "no
  // classes of yours today" and looked broken. Watching a register fill is exactly what a
  // manager wants during an inspection or a funding visit.
  //
  // Gated harder than the default view: seeing YOUR OWN classes follows from teaching
  // them, but seeing the whole college's is an administrative act, so it needs one of the
  // pages that already carry that authority rather than live-attendance alone.
  const wantsAll = String(req.query.scope || "") === "all";
  const maySeeAll = hasPage(req.user, ["registers", "students", "executive"]);
  if (wantsAll && !maySeeAll) {
    return res.status(403).json({ error: "You can only see the classes you teach." });
  }

  const sessions = await prisma.hndSession.findMany({
    where: { date: dateWhere, ...(wantsAll ? {} : teachesSessionWhere(req.user.id)) },
    include: {
      unit: {
        select: {
          id: true, code: true, name: true,
          // Whether this module's enrolment list was ENUMERATED by the Moodle sync or
          // assembled one student at a time. deriveRoster needs it below; sUnit is an
          // allowlist, so neither id reaches the browser. See roster.js.
          moodleSectionId: true, moodleCourseId: true,
          term: { select: { start: true, end: true } },
          // Only a name and only for display. NOT the staff email — GET /staff already
          // denies colleagues' addresses to page-scoped admins, and a session list must
          // not become a way around that.
          tutorStaff: { select: { name: true } },
          tutor: true,
        },
      },
      _count: { select: { marks: true } },
    },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
  });

  /* ---- how the day's registers actually stand, per class ------------------- *
   *
   * P / L / E / A are the four statuses this codebase has (see src/attendance.js);
   * there is no fifth. "N/A" is therefore NOT a status and is never written anywhere:
   * it is the count of students ON the register who have no mark yet — UNMEASURED,
   * which this codebase represents as null and never as zero and never as an absence.
   * Nothing on this route writes a mark. The only path from this screen to an A is
   * POST /mark-remaining-absent, with a named human on the end of it.
   *
   * WHO IS "ON THE REGISTER" is the enrolment list UNION the students already marked,
   * which is exactly the roster GET /sessions/:id/live builds — a student since
   * un-enrolled who was marked on this register still belongs on it. Built the same way
   * here so the summary on the list and the roll inside it cannot disagree by one.
   *
   * `notMarked` is NULL, not 0, when that roster is empty. A register with no enrolment
   * rows and no marks is one nobody can size — a Moodle import that never synced
   * enrolments is the ordinary cause — and "0 not marked" there reads as "everybody is
   * accounted for", which is a reassuring answer to a question nobody was able to ask.
   *
   * Two queries for the whole day rather than two per class: a lecturer's day is a
   * handful of sessions, but ?scope=all is every register the college is running, and a
   * pair of round trips each is how a dashboard that polls becomes the slowest thing on
   * the server. */
  const sessionIds = sessions.map((s) => s.id);
  const unitIds = [...new Set(sessions.map((s) => s.unitId))];
  // THE GROUPS TOO, NOT JUST THE ENROLMENTS. A student reaches a register by two routes
  // -- an enrolment on the module, or membership of a group the class was timetabled for
  // -- and roster.js is the one place that decides between them. Counting only enrolments
  // here would make this panel report "nobody to mark" for exactly the classes whose
  // register lists a full group: every module created by hand rather than synced from
  // Moodle. That is the same contradiction the register screen itself had, one screen
  // further along, and it is worth one extra query to not ship it twice.
  const cohortIds = [...new Set(sessions.map((s) => s.cohortId).filter(Boolean))];
  const [enrolments, dayMarks, cohortStudents] = sessionIds.length
    ? await Promise.all([
        prisma.enrolment.findMany({ where: { unitId: { in: unitIds } }, select: { unitId: true, studentId: true } }),
        // Ids and the letter, nothing else. This is a counting query, and a remark on an
        // attendance mark is pastoral text that has no business on a list screen.
        prisma.attendanceMark.findMany({ where: { sessionId: { in: sessionIds } }, select: { sessionId: true, studentId: true, status: true } }),
        // One query for the whole day's groups, not one per class. A day is a handful of
        // classes; `?scope=all` is every register in the college, which is exactly when a
        // per-session query would matter.
        cohortIds.length
          ? prisma.student.findMany({ where: { cohortId: { in: cohortIds } }, select: { id: true, cohortId: true } })
          : [],
      ])
    : [[], [], []];

  const studentsByCohort = new Map();
  for (const st of cohortStudents) {
    if (!studentsByCohort.has(st.cohortId)) studentsByCohort.set(st.cohortId, []);
    studentsByCohort.get(st.cohortId).push(st.id);
  }

  const enrolledByUnit = new Map();
  for (const e of enrolments) {
    if (!enrolledByUnit.has(e.unitId)) enrolledByUnit.set(e.unitId, new Set());
    enrolledByUnit.get(e.unitId).add(e.studentId);
  }
  const marksBySession = new Map();
  for (const m of dayMarks) {
    if (!marksBySession.has(m.sessionId)) marksBySession.set(m.sessionId, []);
    marksBySession.get(m.sessionId).push(m);
  }
  const countsFor = (s) => {
    const mine = marksBySession.get(s.id) || [];
    const counts = { P: 0, L: 0, E: 0, A: 0 };
    // Guarded by isStatus rather than trusting the column, so a letter this codebase
    // does not know about is left out of every figure instead of inventing a fifth key
    // on the object the screen renders.
    for (const m of mine) if (isStatus(m.status)) counts[m.status] += 1;
    // deriveRoster, not a second opinion: enrolments where the module records them, the
    // whole group where it records none. A student already MARKED is added afterwards
    // regardless -- they may have left the group since, and dropping them would shrink
    // the denominator under a mark that still exists.
    const enrolledIds = [...(enrolledByUnit.get(s.unitId) || [])];
    const roster = new Set(
      s.cohortId
        ? deriveRoster({
            cohortStudentIds: studentsByCohort.get(s.cohortId) || [],
            enrolledStudentIds: enrolledIds,
            unitHasEnrolments: enrolledIds.length > 0,
            // The fourth answer deriveRoster needs, and the reason this panel does not
            // report "1 to mark" for a class of twenty-five the moment somebody ticks
            // that module on one student's record. Read off the unit already loaded
            // above, so it costs no query.
            enrolmentIsAuthoritative: enrolmentIsAuthoritativeFor(s.unit),
          }).studentIds
        : enrolledIds,
    );
    for (const m of mine) roster.add(m.studentId);
    const marked = counts.P + counts.L + counts.E + counts.A;
    return {
      ...counts,
      marked,
      // The size of the register, or null where there is no way to know it — the same
      // distinction notMarked turns on, published so the screen can say "not recorded"
      // rather than printing a dash it cannot explain.
      roster: roster.size || null,
      notMarked: roster.size ? Math.max(0, roster.size - marked) : null,
    };
  };
  const perSession = new Map(sessions.map((s) => [s.id, countsFor(s)]));

  // The day added up. A count of MARKS, not of people: a student on two registers today
  // is two rows here and should be, because the question this answers is "how much of
  // today's attendance is taken", not "how many students are in". `notMarked` sums only
  // the classes where it could be measured and is null when NONE of them could — an
  // institution-wide "we cannot tell", not a day on which everybody was marked.
  const totals = { P: 0, L: 0, E: 0, A: 0, marked: 0, roster: null, notMarked: null };
  for (const c of perSession.values()) {
    for (const k of ["P", "L", "E", "A", "marked"]) totals[k] += c[k];
    if (c.roster !== null) totals.roster = (totals.roster || 0) + c.roster;
    if (c.notMarked !== null) totals.notMarked = (totals.notMarked || 0) + c.notMarked;
  }

  res.json({
    date,
    // The end of the range, or null for a single day. Echoed back rather than assumed,
    // so a screen cannot label a week as a day after a request it half-remembers.
    to: to || null,
    // Whether `date` is actually today, decided on the SERVER. The client cannot work it
    // out safely: APP_TIMEZONE is the college's, and a lecturer on a laptop in another
    // timezone would compute a different "today" and mislabel the day they are looking
    // at. Everything that says "now" on this screen — the running-class highlight, the
    // tap window — is only meaningful when this is true.
    isToday,
    tapEnabled: settings.enabled,
    // Separately, because the list screen's "switched off" warning must only show when
    // BOTH capture methods are off — a QR-only college's registers do fill on their own.
    qrEnabled: settings.qrEnabled,
    scope: wantsAll ? "all" : "mine",
    // Whether to OFFER the toggle. The client cannot work this out for itself without
    // duplicating the page check above, and a control that always 403s is worse than no
    // control at all.
    canSeeAll: maySeeAll,
    teaches,
    // Today added up across the classes on this list — so the panel at the top of the
    // dashboard is the sum of exactly the rows underneath it and cannot drift from them.
    totals,
    sessions: sessions.map((s) => ({
      id: s.id,
      // The class's OWN date. Redundant on a single day, and the only thing that
      // distinguishes two rows once `to` makes this a range — without it a fortnight of
      // the same Tuesday lecture is fourteen identical lines.
      date: s.date,
      unit: s.unit ? { id: s.unit.id, code: s.unit.code, name: s.unit.name } : null,
      startTime: s.startTime,
      endTime: s.endTime,
      description: s.description,
      kind: s.kind,
      // Free text `tutor` is the fallback for a visiting lecturer with no account, and
      // null when neither is set — which is a real state (nobody has been assigned) and
      // not an empty string pretending otherwise.
      tutor: s.unit?.tutorStaff?.name || s.unit?.tutor || null,
      marked: s._count.marks,
      // { P, L, E, A, marked, roster, notMarked } — see the block above the response.
      // notMarked and roster are null where the register's size is unknowable, and that
      // null must reach the screen as "not recorded" rather than as a zero.
      counts: perSession.get(s.id),
      // Whether self check-ins are being accepted for this class RIGHT NOW. Derived at
      // read time rather than stored: "is it running" changes every minute, and a column
      // holding it would be wrong within one and have nothing to correct it.
      // The term is part of this, matching what the tap route will actually do. Without
      // it the dashboard advertised "Open now" for a session inside a closed term while
      // every tap on it came back 409, which reads as the app being broken.
      // EITHER capture method counts: a QR-only college's class is open now in every
      // sense this flag is read for — the badge, and whether the live view keeps polling.
      // The shared predicates, not an inline copy — this test existed four times and the
      // copies had already drifted (one dropped the term; two coerced grace differently).
      // isToday GATES THIS, and it is not belt-and-braces. withinSessionWindow compares
      // the class's start and end against the WALL CLOCK, so on any other date it is
      // asking "is 10:04 between 09:00 and 12:00" about a day that is not happening —
      // which is true, and wrong. A dashboard browsed forward to next Tuesday would badge
      // every morning class "Open now" and invite a lecturer to wait for taps that cannot
      // arrive. A class is only accepting taps on the day it runs.
      acceptingTaps: isToday
        && (settings.enabled || settings.qrEnabled)
        && withinSessionWindow(s, { date, time }, settings)
        && termOpenOn(s.unit?.term, date),
    })),
  });
});

// GET /api/hnd/sessions/:id/students/:studentId/history
//
// One student's whole attendance on THE MODULE THIS CLASS BELONGS TO: every register,
// its date and time, and what they were marked.
//
// KEYED ON THE SESSION, NOT THE UNIT, and that is the access decision. lecturerGate
// answers "may you open THIS class", which is a question about a register somebody is
// standing in front of. A /units/:unitId/students/:id route would be a different
// question — "may you read this person's history on a module you are not teaching
// today" — and would need its own answer. Hanging it off the session means the gate
// already fits: if you can open the register, you can see how the people ON it have
// been attending the module it belongs to.
//
// Scoped to the unit and nothing wider. A lecturer looking at a row wants "how have they
// been on MY module"; their attendance elsewhere is somebody else's business and is
// already on the student's own record for those who hold that page.
router.get("/sessions/:id/students/:studentId/history", requireAuth, lecturerGate(["live-attendance", "registers"]), async (req, res) => {
  const session = await prisma.hndSession.findUnique({
    where: { id: String(req.params.id || "") },
    // moodleSectionId/moodleCourseId for rosterForSession — see roster.js.
    select: { id: true, unitId: true, cohortId: true, unit: { select: { code: true, name: true, moodleSectionId: true, moodleCourseId: true } } },
  });
  if (!session) return res.status(404).json({ error: "That class could not be found." });

  const studentId = String(req.params.studentId || "");

  // THE STUDENT MUST BE ON THIS REGISTER, and the check was missing.
  //
  // The access argument above is "if you can open the register, you can see how the
  // people ON IT have been attending" -- but nothing enforced the second half, so any
  // student id reached this route and came back with a name, a student reference, an
  // email address and a date of birth. lecturerGate still held the outer door and a cuid
  // is not enumerable, so this was a widening rather than an open directory; it was still
  // a lecturer holding one class being able to read any student in the college.
  //
  // Already-marked students count as on it, matching every other roster question here: a
  // student who has since left the group still has a mark on this sheet, and their own
  // history is exactly what somebody looking at that mark needs.
  const [roster, hasMark] = await Promise.all([
    rosterForSession(session),
    prisma.attendanceMark.count({ where: { sessionId: session.id, studentId } }),
  ]);
  if (!roster.studentIds.includes(studentId) && !hasMark) {
    // 404, not 403: whether a given student exists is not something a caller who has no
    // standing to ask about them should learn from the difference between two codes.
    return res.status(404).json({ error: "That student is not on this register." });
  }

  const student = await prisma.student.findUnique({ where: { id: studentId }, select: { id: true, firstName: true, lastName: true, studentRef: true, initials: true, colour: true, active: true, email: true, dob: true, cohortId: true, academicDepartmentId: true } });
  if (!student) return res.status(404).json({ error: "That student could not be found." });

  // EVERY REGISTER ON THE MODULE, not only the ones they were marked on. A class the
  // student was never marked for is the most interesting row on this list — it is the
  // difference between "absent" and "nobody took the register" — and a query driven by
  // AttendanceMark could not produce it at all.
  // SCOPED TO THE REGISTERS THIS STUDENT COULD BE ON, which on a merged class is not
  // every register of the module. A merged class keeps one register per GROUP; listing
  // both told a student on group A that they had missed group B's classes, and the screen
  // renders this as "marked on 3 of 6 registers" — half a term of absences invented by a
  // missing filter. The percentage was unaffected (it counts marks), so the number and
  // the sentence printed beside it disagreed.
  //
  // A student's own group is the group of THIS register. Ungrouped registers (cohortId
  // null — generated from a unit rather than a timetable) belong to everyone on the
  // module and are always included, which is what they were before groups existed.
  const [sessions, marks] = await Promise.all([
    prisma.hndSession.findMany({
      where: {
        unitId: session.unitId,
        ...(session.cohortId ? { OR: [{ cohortId: session.cohortId }, { cohortId: null }] } : {}),
      },
      select: { id: true, date: true, startTime: true, endTime: true, description: true, cohortId: true },
      orderBy: [{ date: "desc" }, { startTime: "desc" }],
    }),
    prisma.attendanceMark.findMany({
      where: { studentId, session: { unitId: session.unitId } },
      select: { sessionId: true, status: true, takenBy: true, checkedInAt: true, remark: true },
    }),
  ]);
  const bySession = new Map(marks.map((m) => [m.sessionId, m]));

  const rows = sessions.map((s) => {
    const m = bySession.get(s.id);
    return {
      sessionId: s.id,
      date: s.date,
      startTime: s.startTime,
      endTime: s.endTime,
      description: s.description || "",
      // null means NOBODY MARKED THEM, which is not the same as absent and must never be
      // rendered as one. The screen prints it as "not marked".
      status: m?.status || null,
      selfMarked: isSelfCheckIn(m?.takenBy),
      // "qr" | "nfc" | null, from the same map as the predicate above. Null on every
      // session this student was never marked on — a history row with no mark states
      // nothing about how a mark was captured, because there is no mark.
      checkInMethod: checkInMethod(m?.takenBy),
      takenBy: m?.takenBy || null,
      checkedInAt: m?.checkedInAt ?? null,
      remark: m?.remark || "",
    };
  });

  // The same points model as every other attendance figure on the platform, so this
  // total and the percentage on the register row cannot disagree.
  const summary = summarise(rows.filter((r) => r.status).map((r) => ({ status: r.status })));

  res.json({
    student: sStudent(student),
    unit: { id: session.unitId, code: session.unit?.code || "", name: session.unit?.name || "" },
    // How many registers exist on this module at all, beside how many they were marked
    // on. "Marked on 4 of 20" is the sentence that explains a percentage nobody expected.
    totalSessions: rows.length,
    summary,
    rows,
  });
});

// GET /api/hnd/sessions/:id/live — who is in, who is late, who has not appeared.
//
// The register as it stands during the class, with the minute each student tapped in.
// Polled every few seconds by the dashboard; this codebase has no websocket layer and
// one three-hour class does not justify introducing one.
//
// "Not tapped" is a DISPLAY state, not a mark. Nothing is written for those students
// here — the roll simply has no row for them yet. The only route from this feature to an
// A is POST /mark-remaining-absent below, with a named human on the end of it.
router.get("/sessions/:id/live", requireAuth, lecturerGate(["live-attendance", "registers"]), async (req, res) => {
  const session = await prisma.hndSession.findUnique({
    where: { id: req.params.id },
    include: {
      // moodleSectionId/moodleCourseId for rosterForSession — see roster.js. sUnit is an
      // allowlist, so neither reaches the browser.
      unit: { select: { id: true, code: true, name: true, moodleSectionId: true, moodleCourseId: true, tutorStaffId: true, term: { select: { name: true, start: true, end: true } } } },
      // Ids only, and only so `mayClose` below can ask the same question `lecturerGate`
      // already asked at the door. Without it the lecturer the TIMETABLE names walks
      // through the gate and is then told `canClose: false` about a route that would
      // have let them close it — the exact disagreement mayClose exists to prevent.
      timetableEvent: { select: { staff: { select: { staffId: true } } } },
    },
  });
  if (!session) return res.status(404).json({ error: "That class could not be found." });

  const [enrolments, marks, settings, roster] = await Promise.all([
    prisma.enrolment.findMany({ where: { unitId: session.unitId }, select: { studentId: true } }),
    prisma.attendanceMark.findMany({ where: { sessionId: session.id } }),
    tapConfig.get(),
    // THE ROSTER, NOT THE ENROLMENT LIST — the third screen to have got this wrong.
    //
    // This built its list from Enrolment alone, so a class timetabled for a GROUP on a
    // module that records no enrolments showed nobody: the register listed the group,
    // the unit card counted the group, and the live view — the screen a lecturer stands
    // in front of a class holding — was empty. rosterForSession is the same call the
    // register and the save path make, so all three now answer "who is in this class"
    // identically or none of them do.
    rosterForSession(session),
  ]);

  const byStudent = new Map(marks.map((m) => [m.studentId, m]));
  // WHO ON THIS REGISTER SHARED A HANDSET WITH WHOM.
  //
  // Computed here, from the marks already loaded, rather than sent to the browser as raw
  // device ids for it to compare. The ids never leave the building: a random tracking
  // identifier handed to a browser is a tracking identifier whatever it was collected for,
  // and the screen has no use for the value — only for the fact of a collision.
  //
  // A FLAG, NEVER A VERDICT. Two accounts marked from one phone is what proxy attendance
  // looks like from here, and it is also what a flat battery and a ten-second loan look
  // like. It goes in front of the member of staff who knows the room.
  const sharedDevices = sharedDeviceGroups(marks);

  const enrolledIds = new Set(enrolments.map((e) => e.studentId));
  const rosterIds = new Set(roster.studentIds);

  // A student since removed from the group or un-enrolled, but MARKED on this register,
  // still belongs on it — matching GET /register — otherwise their mark would vanish
  // from the screen while remaining in the database.
  const needed = [...new Set([...rosterIds, ...marks.map((m) => m.studentId)])];
  const students = needed.length
    ? await prisma.student.findMany({ where: { id: { in: needed } } })
    : [];
  students.sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));

  // WHO EACH STUDENT IS, AND HOW THEY HAVE BEEN ATTENDING — in three bulk queries, not
  // three per student. A register is thirty people and this screen polls; a query per row
  // is ninety round trips a minute for a list that changes when somebody taps a sticker.
  //
  // The percentage is for THIS MODULE, not the student's whole college career. A lecturer
  // deciding whether to chase somebody in front of them is asking "how have they been on
  // MY unit", and a college-wide figure would be dominated by modules this person does
  // not teach. It uses the same points model as everywhere else (P=2, L/E=1, A=0, over
  // marked sessions only) via summariseCounts, so it cannot drift from the figure the
  // attendance screens show.
  const studentIds = students.map((s) => s.id);
  const cohortIdsOf = [...new Set(students.map((s) => s.cohortId).filter(Boolean))];
  const deptIdsOf = [...new Set(students.map((s) => s.academicDepartmentId).filter(Boolean))];

  // Whether the college shows the risk band on this screen — showBandToLecturers,
  // prediction/settings.js, OFF by default. Read before the fetch below so the query
  // does not even run when the answer is no: the gate is server-side precisely so a
  // client cannot leak a field it never receives. (get() is cached, so this is not an
  // extra query on every poll.) The switch is named for lecturers but the audience is
  // everyone this route admits — the page-holders lecturerGate lets through already
  // hold registers-level trust, and a band that appears for a tutor and vanishes for
  // the attendance officer beside them would read as a bug, not a permission.
  const predCfg = await predictionSettings.get();
  const showRiskBands = predCfg.showBandToLecturers === true;

  const [unitMarkAgg, cohortRows, deptRows, bandRows, conductAgg] = await Promise.all([
    studentIds.length
      ? prisma.attendanceMark.groupBy({
          by: ["studentId", "status"],
          where: { studentId: { in: studentIds }, session: { unitId: session.unitId } },
          _count: { _all: true },
        })
      : [],
    cohortIdsOf.length
      ? prisma.cohort.findMany({ where: { id: { in: cohortIdsOf } }, select: { id: true, name: true, course: { select: { name: true } } } })
      : [],
    deptIdsOf.length
      ? prisma.academicDepartment.findMany({ where: { id: { in: deptIdsOf } }, select: { id: true, name: true } })
      : [],
    // The band KEY only. The score, the components and the driver codes stay behind
    // the prediction page — this screen answers "should I keep an eye on them", not
    // "why", and the WHY row includes material (mitigating circumstances among it)
    // that has its own, stricter audience.
    showRiskBands && studentIds.length
      ? prisma.studentPredictionCurrent.findMany({ where: { studentId: { in: studentIds } }, select: { studentId: true, riskLevel: true } })
      : [],
    // Net conduct points per student, all-time, for the chip beside the name. A
    // groupBy returns rows only for students WITH events, which is the distinction
    // the screen needs: no row is "nothing recorded" (no chip), a row summing to 0
    // is a real zero (merits and demerits netting out) and shows as one.
    studentIds.length
      ? prisma.conductEvent.groupBy({ by: ["studentId"], where: { studentId: { in: studentIds } }, _sum: { points: true } })
      : [],
  ]);
  const tallies = new Map();
  for (const r of unitMarkAgg) {
    if (!isStatus(r.status)) continue;
    if (!tallies.has(r.studentId)) tallies.set(r.studentId, { P: 0, L: 0, E: 0, A: 0 });
    tallies.get(r.studentId)[r.status] += r._count._all;
  }
  const cohortById = new Map(cohortRows.map((c) => [c.id, c]));
  const deptById = new Map(deptRows.map((d) => [d.id, d]));
  const bandByStudent = new Map(bandRows.map((b) => [b.studentId, b.riskLevel]));
  const conductByStudent = new Map(conductAgg.map((c) => [c.studentId, c._sum.points ?? 0]));
  // The college's OWN label for each band key, from the same settings row that owns
  // the switch — a college that renamed R3 to "Amber" must see "Amber" here, not the
  // platform default the key happened to start life as.
  const bandLabelByKey = new Map((predCfg.bands || []).map((b) => [b.key, b.label]));

  const rows = students.map((s) => {
    const mark = byStudent.get(s.id);
    const t = tallies.get(s.id) || { P: 0, L: 0, E: 0, A: 0 };
    const sum = summariseCounts(t.P, t.L, t.E, t.A);
    const co = s.cohortId ? cohortById.get(s.cohortId) : null;
    return {
      student: sStudent(s),
      // The COURSE the student is on, through their group. Null rather than the unit's
      // own course as a fallback: those are different facts, and quietly substituting one
      // would tell a lecturer this student is on a course nobody has put them on.
      course: co?.course?.name || null,
      group: co?.name || null,
      // NULL means "not assigned to a school", which Settings counts as a real state.
      school: s.academicDepartmentId ? (deptById.get(s.academicDepartmentId)?.name || null) : null,
      // Null when they have never been marked on this module — NOT 0%, which would put a
      // student nobody has taken a register for at the bottom of the class.
      attendancePct: sum.pct,
      attendanceMarked: sum.marked,
      status: mark?.status || null,
      remark: mark?.remark || "",
      checkedInAt: mark?.checkedInAt ?? null,
      // Whether the student put themselves on this register or a member of staff did.
      // takenBy already carries provenance this way for the Moodle importer.
      //
      // A PREDICATE, not an equality against one stamp. There is now more than one way a
      // student marks themselves — a sticker and a code on screen — and comparing against
      // just the NFC string would report every QR check-in as staff-marked, which is the
      // exact opposite of the truth on the one screen built to show the difference.
      selfMarked: isSelfCheckIn(mark?.takenBy),
      // And WHICH — "qr", "nfc", or null. The live view chose its icon by comparing
      // takenBy against the literal QR stamp, so the frozen wording of a database column
      // decided what a lecturer saw; a token cannot be reworded.
      checkInMethod: checkInMethod(mark?.takenBy),
      takenBy: mark?.takenBy || null,
      // Whether this mark and another student's on the SAME register came from the same
      // handset — as a count of the others, never their names.
      //
      // A NUMBER RATHER THAN A LIST, deliberately. The names are already on the screen:
      // a lecturer looking at a flagged row is looking at a register of thirty students
      // and can see which other row carries the same flag. Shipping the names would put
      // "checked in on the same device as Jane Smith" into a payload about Tom Brown,
      // which is a statement about Jane in Tom's record, reachable by anybody who can
      // read Tom's row.
      //
      // 0 IS A REAL ANSWER HERE, unlike almost everywhere else in this codebase: it
      // means "we recorded a handset and it was theirs alone". A hand-marked row has no
      // handset to compare and is also 0, which is the right reading — nothing was
      // observed, so nothing is claimed.
      sharedDeviceWith: sharedDevices.get(s.id)?.length || 0,

      enrolled: enrolments.some((e) => e.studentId === s.id),

      // Null when NOTHING has ever been recorded for this student (no chip), a
      // number — including a real 0 of merits and demerits netting out — when
      // something has. The distinction is the groupBy's row-existence, see above.
      conductPoints: conductByStudent.has(s.id) ? conductByStudent.get(s.id) : null,

      // ABSENT (not null) when the college has not switched showBandToLecturers on —
      // absent is "this screen does not carry bands", null is "bands are on and this
      // student has no score yet", and collapsing the two would make an unscored
      // student indistinguishable from a switched-off college. A key stored against
      // a band the college has since deleted still ships, with the key as its own
      // label, rather than vanishing — the history row it came from still means what
      // it meant.
      ...(showRiskBands
        ? {
            risk: bandByStudent.has(s.id)
              ? { key: bandByStudent.get(s.id), label: bandLabelByKey.get(bandByStudent.get(s.id)) || bandByStudent.get(s.id) }
              : null,
          }
        : {}),
    };
  });

  const time = localTime();
  const counts = { P: 0, L: 0, E: 0, A: 0, notMarked: 0 };
  for (const r of rows) {
    if (r.status && r.status in counts) counts[r.status] += 1;
    else counts.notMarked += 1;
  }

  // Where this class sits, in the same words the mint route uses, so the screen can
  // offer "end now" only while open and "reopen" only once over or ended — and
  // nothing at all before the class starts or inside a locked term.
  const today = localDate();
  const termOpen = termOpenOn(session.unit?.term, today);
  const accepting = (settings.enabled || settings.qrEnabled)
    && withinSessionWindow(session, { date: today, time }, settings)
    && termOpen;
  const opensAt = subMinutes(session.startTime, Number(settings.earlyGraceMins) || 0);
  const phase = !termOpen
    ? "closed"
    : session.checkInClosedAt
      ? "ended"
      : accepting
        ? "open"
        : session.date > today || (session.date === today && time < opensAt) ? "before" : "over";

  res.json({
    session: sSession(session),
    today,
    phase,
    unit: session.unit ? { id: session.unit.id, code: session.unit.code, name: session.unit.name } : null,
    // Whether the rotating-code card belongs on this screen at all. Returned here
    // because the live view already holds the settings; the card itself fetches its
    // code from /sessions/:id/qr-code, which re-checks this server-side.
    qrEnabled: settings.qrEnabled,
    // The sticker switch too, so the screen can say "nothing here will fill on its own"
    // only when BOTH are off, with a way to the settings.
    tapEnabled: settings.enabled,
    // Whether to OFFER the close button. An administrator granted the watching page
    // alone could see this screen and press a button that only ever answered 403.
    canClose: mayClose(req.user, session),
    // Whether to OFFER the per-student dropdown at all. Same question as canClose, asked
    // through the same predicate: the screen must not render a control this caller's next
    // request would refuse.
    canMark: mayClose(req.user, session),
    // The minute check-in actually shuts (later than the timetable when held open), so
    // the screen can say "open until 12:20" rather than the end time it already shows.
    closesAt: checkInClosesAt(session),
    // Either capture method keeps this true — it gates the badge AND the client's poll,
    // and a QR-only college's register fills exactly as an NFC one's does.
    // The term is part of "accepting", matching the today list and what a tap will
    // actually be answered — this copy lacked it, so the badge read "Accepting" on a
    // locked-term register whose every self check-in came back 423. termLocked below
    // stays as the separate display detail saying WHY.
    acceptingTaps: accepting,
    // Null when the unit has no term, which is a real state — the register is simply
    // never term-locked — and not the same as "the term is open".
    termLocked: session.unit?.term ? !termOpen : null,
    counts,
    // Whether the rows carry `risk` at all, so the screen can draw a legend or a
    // column head without sniffing the first row for the field.
    showRiskBands,
    rows,
  });
});

// In-process, module-level, and therefore correct for ONE Node process — a clustered
// deployment needs Redis. The screen asks for a new code once per rotation (20s by
// default), so thirty a minute is well clear of every legitimate cadence and still
// stops a broken client timer from turning one projector into a request loop.
const qrMintHits = new Map(); // staffId -> number[] of timestamps
const QR_MINT_WINDOW_MS = 60_000;
const QR_MINT_MAX = 30;
function qrMintAllowed(staffId) {
  const now = Date.now();
  const recent = (qrMintHits.get(staffId) || []).filter((t) => now - t < QR_MINT_WINDOW_MS);
  if (recent.length >= QR_MINT_MAX) { qrMintHits.set(staffId, recent); return false; }
  recent.push(now);
  qrMintHits.set(staffId, recent);
  return true;
}

// GET /api/hnd/sessions/:id/qr-code — the rotating code the lecturer puts on screen.
//
// The code is derived, never stored (see attendanceQr.js), so this route is a read in
// every sense: nothing opens, nothing can be left open, and a lecturer who never loads
// it has simply declined a shortcut. Gated like the live view because the person
// holding the code IS the person watching the register fill.
//
// Outside the session's own window no code is minted at all. Verification would
// refuse it anyway — the window is enforced where it matters, at the scan — but a QR
// square that can only refuse is worse than a message saying when check-in opens.
router.get("/sessions/:id/qr-code", requireAuth, lecturerGate(["live-attendance", "registers"]), async (req, res) => {
  const settings = await tapConfig.get();
  // 409 rather than 404: the session may be real and the feature simply off, and the
  // screen needs to tell a lecturer those apart.
  if (!settings.qrEnabled) return res.status(409).json({ error: "QR check-in isn't switched on for this college.", reason: "qr_disabled" });
  if (!qrMintAllowed(req.user.id)) return res.status(429).json({ error: "The code is refreshing on its own. Give it a few seconds.", reason: "too_many" });

  const session = await prisma.hndSession.findUnique({
    where: { id: req.params.id },
    // The term travels with the session because "accepting" INCLUDES it. The first
    // version of this query left it out, so the route minted a live code for a session
    // inside a closed term — a projector full of "scan to check in" where every scan
    // answered 423, the exact failure the today list's acceptingTaps comment records.
    select: { id: true, date: true, startTime: true, endTime: true, checkInClosedAt: true, checkInOpenUntil: true, unit: { select: { term: { select: { start: true, end: true } } } } },
  });
  if (!session) return res.status(404).json({ error: "That class could not be found." });

  // Epoch seconds for the window arithmetic, local strings for the register decision —
  // the same split the verify route keeps. The rotation window is timezone-free maths;
  // "is the class on now" is a question about the college's own clock.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const rotateSeconds = settings.qrRotateSeconds;
  const secondsLeft = rotateSeconds - (nowSeconds % rotateSeconds);
  const opensAt = subMinutes(session.startTime, Number(settings.earlyGraceMins) || 0);
  const date = localDate();
  const time = localTime();
  // The shared predicates the verify route and both dashboards use — the mint and the
  // scan MUST agree to the minute, or the screen advertises what the server refuses.
  const termOpen = termOpenOn(session.unit?.term, date);
  const accepting = withinSessionWindow(session, { date, time }, settings) && termOpen;

  if (!accepting) {
    // Which side of the window we are on, decided here where the college's clock lives —
    // the client's own clock may sit in any timezone, and "opens at 09:00" shown for a
    // class that finished at lunchtime reads as the screen being broken.
    // A session dated tomorrow is "before" even though today's time is past its start.
    // A closed term outranks both: "opens at 09:00" for a register the term has locked
    // would promise a code that is never coming.
    // "ended" is the lecturer's doing, not the clock's, and the screen offers the
    // reopen button on exactly that word.
    const phase = !termOpen
      ? "closed"
      : session.checkInClosedAt
        ? "ended"
        : session.date > date || (session.date === date && time < opensAt) ? "before" : "over";
    return res.json({ code: null, secondsLeft, rotateSeconds, acceptingTaps: false, phase, opensAt, closesAt: checkInClosesAt(session) });
  }

  let secret;
  try {
    secret = qrSigningKey();
  } catch (e) {
    // Fail loudly at the person who can act on it. A quietly-degraded screen would
    // present as "the QR never works" to a room of students, one scan at a time.
    if (e instanceof SecretsNotConfigured) {
      // Loudly, but not verbatim. e.message names the environment variable and carries
      // the shell command that generates it, and this response lands on a screen that is
      // frequently being projected to a room. The detail belongs in the server log,
      // where the person who can act on it is actually looking.
      console.error("[qr] cannot sign codes for the screen:", e.message);
      return res.status(e.status).json({ error: "Check-in codes aren't set up on this server yet. Ask whoever runs it.", reason: "qr_unavailable" });
    }
    throw e;
  }

  const code = deriveCode({ secret, sessionId: session.id, windowIndex: windowIndexFor(nowSeconds, rotateSeconds) });
  // closesAt is the minute check-in actually shuts, which is later than the timetable
  // when the lecturer is holding it open for late arrivals.
  res.json({ code, secondsLeft, rotateSeconds, acceptingTaps: true, phase: "open", opensAt, closesAt: checkInClosesAt(session) });
});

// POST /api/hnd/sessions/:id/check-in-window — the lecturer's hand on the window.
//
//   { action: "close" }                 end check-in now, before the timetabled end
//   { action: "reopen", minutes: 10 }   accept scans again (or still) until now + minutes
//
// Two overrides for one class on one day, nothing more: no schedule, no default, no
// college-wide state. Closing sets checkInClosedAt; reopening clears it and holds the
// window open until the later of the timetabled end and now + minutes. Every surface
// reads the result through the one window predicate, so the code disappears from the
// projector, the badge changes and the next scan is refused in the same instant.
//
// Gated like the close-off: the registers page, or the tutor of this unit. A watch-only
// administrator can see the register but must not be able to change what it accepts.
const REOPEN_MAX_MINS = 120;
router.post("/sessions/:id/check-in-window", requireAuth, lecturerGate(["registers"]), async (req, res) => {
  const session = await prisma.hndSession.findUnique({
    where: { id: req.params.id },
    include: { unit: { select: { code: true, tutorStaffId: true, term: { select: { name: true, start: true, end: true } } } } },
  });
  if (!session) return res.status(404).json({ error: "That class could not be found." });

  const action = String(req.body?.action || "");
  if (action !== "close" && action !== "reopen") {
    return res.status(400).json({ error: "action must be \"close\" or \"reopen\"" });
  }
  const date = localDate();
  const time = localTime();
  // Only today's class. Closing tomorrow's register is meaningless, and holding open
  // last week's would let a scan land on a register nobody is in a room for.
  if (session.date !== date) {
    return res.status(400).json({ error: "Only a class running today can have its check-in changed." });
  }
  // The same term gate the register save and the close-off enforce: this must not be a
  // way of letting scans into a locked term.
  if (!termOpenOn(session.unit?.term, date)) {
    return res.status(423).json({ error: `${session.unit.term.name} is closed, so this register is locked.`, locked: true });
  }

  let data;
  if (action === "close") {
    data = { checkInClosedAt: new Date() };
  } else {
    const minutes = Number(req.body?.minutes ?? 10);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > REOPEN_MAX_MINS) {
      return res.status(400).json({ error: `minutes must be a whole number from 1 to ${REOPEN_MAX_MINS}` });
    }
    // The later of the timetabled end and now + minutes, so "reopen for ten minutes"
    // pressed mid-class does not shorten the class.
    const until = addMinutes(time, minutes);
    data = { checkInClosedAt: null, checkInOpenUntil: until > session.endTime ? until : session.endTime };
  }
  const updated = await prisma.hndSession.update({ where: { id: session.id }, data });
  const settings = await tapConfig.get();
  const accepting = (settings.enabled || settings.qrEnabled) && withinSessionWindow(updated, { date, time }, settings);

  audit.record(req, {
    action: action === "close" ? "attendance.checkin.closed" : "attendance.checkin.reopened",
    entity: "HndSession", entityId: session.id,
    summary: action === "close"
      ? `Self check-in ended early at ${time} on the ${session.date} register for ${session.unit?.code || "a unit"} by ${req.user?.name || "an administrator"}`
      : `Self check-in held open until ${data.checkInOpenUntil} on the ${session.date} register for ${session.unit?.code || "a unit"} by ${req.user?.name || "an administrator"}`,
    before: { checkInClosedAt: session.checkInClosedAt ?? null, checkInOpenUntil: session.checkInOpenUntil ?? null },
    after: { checkInClosedAt: updated.checkInClosedAt ?? null, checkInOpenUntil: updated.checkInOpenUntil ?? null },
  });

  res.json({
    ok: true,
    checkInClosedAt: updated.checkInClosedAt ? updated.checkInClosedAt.toISOString() : null,
    checkInOpenUntil: updated.checkInOpenUntil ?? null,
    acceptingTaps: accepting,
    closesAt: checkInClosesAt(updated),
  });
});

// POST /api/hnd/sessions/:id/mark-remaining-absent — the lecturer closes the register.
//
// Writes A for every ENROLLED student who has no mark on this session. This is the only
// path from tap check-in to an absence, and it exists precisely so that no automatic
// process ever takes it: a phone with a flat battery, a forgotten handset or a device
// with no NFC must not become an academic record without somebody deciding it should.
router.post("/sessions/:id/mark-remaining-absent", requireAuth, lecturerGate(["registers"]), async (req, res) => {
  const session = await prisma.hndSession.findUnique({
    where: { id: req.params.id },
    include: { unit: { include: { term: true } } },
  });
  if (!session) return res.status(404).json({ error: "That class could not be found." });

  // The same term gate the register save enforces. A convenience button must not be a
  // way around a closed term.
  const term = session.unit?.term;
  if (term && req.body?.override !== true) {
    const today = localDate();
    if (today < term.start || today > term.end) {
      return res.status(423).json({ error: `${term.name} is ${today > term.end ? "over" : "not open yet"} — reopen it to edit this register.`, locked: true });
    }
  }

  // A register for a class that has not happened yet cannot be closed off. Nothing
  // stopped this before, so one press marked a whole cohort absent for next Tuesday —
  // and because a tap can never overwrite a mark, those students would then be unable to
  // check in when the class actually ran. PUT /register grew the same guard on 9 Sep
  // 2026; this one stays because it is a single button that reaches the whole register at
  // once, and because it refuses outright where PUT admits a deliberate `override`.
  if (session.date > localDate()) {
    return res.status(400).json({ error: "That class hasn't happened yet, so its register can't be closed off." });
  }

  // THE ROSTER, NOT THE ENROLMENT LIST — the fourth handler to have got this wrong, and
  // the only one of the four that WRITES. The other three showed the wrong people; this
  // one recorded a permanent A against them.
  //
  // Both directions were broken, and each is worse than a plain empty screen:
  //
  //   TOO WIDE. On a merged class, `enrolment.findMany({ unitId })` is every student on
  //   the MODULE, so closing group A's register wrote an absence for group B — students
  //   who were in another room, whose attendance percentage then fell and who were
  //   rescored by flagStale. GET /register and GET /live correctly refuse to list them,
  //   so the marks were invisible on the screen that made them and present in every
  //   figure. PUT /register refused the identical write: the blunt button reached
  //   students the precise one could not.
  //
  //   TOO NARROW. On a module with no enrolments at all — every unit created by hand
  //   rather than synced — the list was empty, so the route answered "Everyone on this
  //   register already has a mark" having written nothing, about a register where nobody
  //   had been marked. That is the reassuring answer to a question nobody could ask.
  //
  // rosterForSession is the same call GET /register, GET /live and PUT /register make,
  // so all four now answer "who is on this register" identically or none of them do.
  const [roster, marks] = await Promise.all([
    rosterForSession(session),
    prisma.attendanceMark.findMany({ where: { sessionId: session.id }, select: { studentId: true } }),
  ]);
  const marked = new Set(marks.map((m) => m.studentId));
  const missing = roster.studentIds.filter((id) => !marked.has(id));

  if (!missing.length) return res.json({ ok: true, marked: 0, message: "Everyone on this register already has a mark." });

  const outOfTerm = Boolean(term && req.body?.override === true);
  const takenBy = req.user?.name ? (outOfTerm ? `${req.user.name} (out-of-term correction)` : req.user.name) : null;

  // createMany, not upsert: every id here provably has no mark, and using create makes
  // it structurally impossible for this route to overwrite one. skipDuplicates covers
  // the race where a student taps in between the read above and this write — their P
  // wins, which is the correct outcome.
  const created = await prisma.attendanceMark.createMany({
    data: missing.map((studentId) => ({ sessionId: session.id, studentId, status: "A", remark: "", takenBy })),
    skipDuplicates: true,
  });

  await flagStale(missing, "a register being closed off");

  audit.record(req, {
    action: outOfTerm ? "attendance.register.corrected" : "attendance.register.closed",
    entity: "HndSession", entityId: session.id,
    summary: `${created.count} student(s) marked absent on the ${session.date} register for ${session.unit?.code || "a unit"} by ${req.user?.name || "an administrator"}` +
      (outOfTerm ? ` — an out-of-term correction made after ${term.name} closed on ${term.end}` : ""),
    before: null,
    after: Object.fromEntries(missing.slice(0, 40).map((id) => [id, "A"])),
  });

  res.json({ ok: true, marked: created.count });
});

/* ============================== percentages ============================== */

// The attendance matrix: every student's percentage per unit, their overall
// percentage across all units, and the cohort figures per unit + overall.
//
// ?semesterId=<id>       -> only sessions dated inside that semester
// ?semesterId=unassigned -> only sessions outside every semester
// (omitted)              -> every session on record
// GET /hnd/attendance/monthly?studentId= — attendance % bucketed by calendar month,
// for the whole college (default) or a single student. Counting happens IN POSTGRES
// (GROUP BY on left(date,7) = 'YYYY-MM') so it stays memory-safe at scale, exactly
// like the /attendance matrix. Powers the dashboards' "Attendance % by Year & Month".
router.get("/attendance/monthly", requireAuth, async (req, res) => {
  const studentId = str(req.query?.studentId);
  const unitId = str(req.query?.unitId);
  const courseId = str(req.query?.courseId);
  // Curriculum stage — "Year 1 · Term 2". Narrows to the units taught at that point
  // in the course. Ignored unless it parses to a sensible number, so a stray query
  // string can never silently empty the dashboard.
  const yearNum = Number(req.query?.year);
  const termNum = Number(req.query?.termNumber);
  const byYear = Number.isInteger(yearNum) && yearNum >= 1 && yearNum <= MAX_YEAR;
  const byTerm = Number.isInteger(termNum) && termNum >= 1 && termNum <= MAX_TERM;
  // Join Unit when filtering by course or by curriculum stage.
  const needUnit = Boolean(courseId || byYear || byTerm);
  const unitJoin = needUnit ? `JOIN "Unit" u ON u.id = se."unitId"` : "";
  const base = `
    SELECT left(se.date, 7) ym,
      count(*) FILTER (WHERE am.status='P')::int p,
      count(*) FILTER (WHERE am.status='L')::int l,
      count(*) FILTER (WHERE am.status='E')::int e,
      count(*) FILTER (WHERE am.status='A')::int a
    FROM "AttendanceMark" am JOIN "HndSession" se ON se.id = am."sessionId" ${unitJoin}`;
  // Every filter here is optional, so `conds` is legitimately empty for the unfiltered
  // dashboard and the WHERE clause is omitted entirely — see the guard below.
  const conds = [], params = [];
  if (studentId) { params.push(studentId); conds.push(`am."studentId" = $${params.length}`); }
  if (unitId) { params.push(unitId); conds.push(`se."unitId" = $${params.length}`); }
  if (courseId) { params.push(courseId); conds.push(`u."courseId" = $${params.length}`); }
  if (byYear) { params.push(yearNum); conds.push(`u."year" = $${params.length}`); }
  if (byTerm) { params.push(termNum); conds.push(`u."termNumber" = $${params.length}`); }
  // Departmental scope, appended by hand because $queryRaw never reaches the client
  // extension -- see the header of this file. A college-wide caller gets an empty join
  // and an empty predicate, so the query below is character-for-character what it was.
  const dept = scopedStudentJoin('am."studentId"', params.length);
  const where = conds.length ? ` WHERE ${conds.join(" AND ")}${dept.sql}`
    : (dept.sql ? ` WHERE TRUE${dept.sql}` : "");
  const rows = await prisma.$queryRawUnsafe(
    `${base}${dept.join}${where} GROUP BY 1 ORDER BY 1`,
    ...params, ...dept.params,
  );
  let P = 0, L = 0, E = 0, A = 0;
  const months = rows.map((r) => {
    P += r.p; L += r.l; E += r.e; A += r.a;
    const s = summariseCounts(r.p, r.l, r.e, r.a);
    return { month: r.ym, pct: s.pct, marked: s.marked, P: r.p, L: r.l, E: r.e, A: r.a };
  });
  const t = summariseCounts(P, L, E, A);
  // Session count under the SAME course/unit scope (independent of student/marks),
  // so the dashboard's "Total Sessions" tracks the filters too.
  const sJoin = needUnit ? `JOIN "Unit" u ON u.id = se."unitId"` : "";
  const sConds = [], sParams = [];
  if (unitId) { sParams.push(unitId); sConds.push(`se."unitId" = $${sParams.length}`); }
  if (courseId) { sParams.push(courseId); sConds.push(`u."courseId" = $${sParams.length}`); }
  if (byYear) { sParams.push(yearNum); sConds.push(`u."year" = $${sParams.length}`); }
  if (byTerm) { sParams.push(termNum); sConds.push(`u."termNumber" = $${sParams.length}`); }
  // A session has no student, so it reaches a department through its unit — one join since
  // spec 2, and the SAME definition of "which department" the mark path above uses.
  const sDept = scopedUnitJoin('se."unitId"', sParams.length);
  const sWhere = sConds.length ? ` WHERE ${sConds.join(" AND ")}${sDept.sql}`
    : (sDept.sql ? ` WHERE TRUE${sDept.sql}` : "");
  const sessRows = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int n FROM "HndSession" se ${sJoin}${sDept.join}${sWhere}`,
    ...sParams, ...sDept.params,
  );
  res.json({ months, totals: { pct: t.pct, marked: t.marked, present: P, late: L, excused: E, absent: A }, sessions: sessRows[0]?.n || 0 });
});

router.get("/attendance", requireAuth, async (req, res) => {
  const semesterId = str(req.query?.semesterId);
  const semesters = await prisma.semester.findMany({ orderBy: { start: "asc" } });

  // ?termId=<id> scopes to one term's dates; ?semesterId scopes to a semester (or
  // "unassigned" = outside every semester); omitted = everything cumulative.
  const termId = str(req.query?.termId);
  const term = termId ? await prisma.term.findUnique({ where: { id: termId } }) : null;
  if (termId && !term) return res.status(404).json({ error: "Term not found" });
  if (semesterId && semesterId !== "unassigned" && !semesters.some((s) => s.id === semesterId))
    return res.status(404).json({ error: "Semester not found" });

  // The date scope as a SQL predicate on a session-date column, so the counting
  // happens IN POSTGRES. Previously this pulled every AttendanceMark row into Node
  // and grouped them in memory, which OOM-crashed the server at scale. Values come
  // from our own semester/term rows (never user input), so inlining them is safe.
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const dateCond = (col) => {
    if (termId) { return `${col} >= ${q(term.start)} AND ${col} <= ${q(term.end)}`; }
    if (semesterId === "unassigned") {
      if (!semesters.length) return "TRUE";
      return `NOT (${semesters.map((s) => `(${col} >= ${q(s.start)} AND ${col} <= ${q(s.end)})`).join(" OR ")})`;
    }
    if (semesterId) { const sem = semesters.find((s) => s.id === semesterId); return `${col} >= ${q(sem.start)} AND ${col} <= ${q(sem.end)}`; }
    return "TRUE";
  };

  // Both raw aggregates below are scoped by hand. perSM hangs off the mark, so it goes
  // through the student; sessAgg counts SESSIONS, which have no student, so it goes
  // through the unit's course. Neither takes bound parameters (the dates are inlined from
  // our own semester rows), so both offsets are 0.
  const pDept = scopedStudentJoin('am."studentId"');
  const sessDept = scopedUnitJoin('hs."unitId"');
  const [units, students, perSM, sessAgg, studentCounts] = await Promise.all([
    prisma.unit.findMany({ orderBy: { code: "asc" } }),
    prisma.student.findMany({
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      include: { enrolments: { select: { unitId: true } } },
    }),
    // One aggregate row per (student, unit): the four status counts, scoped by date.
    prisma.$queryRawUnsafe(`
      SELECT am."studentId" sid, se."unitId" mid,
        count(*) FILTER (WHERE am.status='P')::int p,
        count(*) FILTER (WHERE am.status='L')::int l,
        count(*) FILTER (WHERE am.status='E')::int e,
        count(*) FILTER (WHERE am.status='A')::int a
      FROM "AttendanceMark" am JOIN "HndSession" se ON se.id = am."sessionId"${pDept.join}
      WHERE ${dateCond("se.date")}${pDept.sql}
      GROUP BY am."studentId", se."unitId"`, ...pDept.params),
    // Session counts per unit: all-time and scoped, in one pass.
    prisma.$queryRawUnsafe(`
      SELECT hs."unitId" mid, count(*)::int all_c,
        count(*) FILTER (WHERE ${dateCond("hs.date")})::int scoped_c
      FROM "HndSession" hs${sessDept.join}
      ${sessDept.sql ? `WHERE TRUE${sessDept.sql}` : ""}
      GROUP BY hs."unitId"`, ...sessDept.params),
    // The SAME definition of "students on this unit" GET /units emits, and for the same
    // reason: a count of Enrolment rows reads 0 for every module Moodle never synced,
    // while its registers list the group scheduled against it. Shared rather than
    // repeated — two handlers each holding their own copy is how the two screens came
    // to disagree in the first place.
    unitStudentCounts(),
  ]);

  // studentId -> Map(unitId -> {P,L,E,A}); plus per-unit and global totals.
  //
  // The totals must obey the SAME leaver rule as the rows below, or the table
  // contradicts itself. This loop had no enrolment filter while every row skipped
  // units the student had left, so after any Moodle attendance import — which writes
  // marks onto a synthetic TUTORIAL unit nobody is enrolled on — every student row
  // read 100% while the "Cohort average", the "Across all units" donut and the
  // headline "Overall attendance" card read 75%, with "at risk: 0" beside it.
  const enrolledPairs = new Set(
    students.flatMap((s) => s.enrolments.map((e) => `${s.id}|${e.unitId}`))
  );
  const index = new Map();
  const modTot = new Map();
  const gTot = { P: 0, L: 0, E: 0, A: 0 };
  for (const r of perSM) {
    if (!index.has(r.sid)) index.set(r.sid, new Map());
    index.get(r.sid).set(r.mid, r);
    // Still indexed above (so the cell renders, flagged enrolled:false), but not
    // counted into any aggregate.
    if (!enrolledPairs.has(`${r.sid}|${r.mid}`)) continue;
    const mt = modTot.get(r.mid) || { P: 0, L: 0, E: 0, A: 0 };
    mt.P += r.p; mt.L += r.l; mt.E += r.e; mt.A += r.a; modTot.set(r.mid, mt);
    gTot.P += r.p; gTot.L += r.l; gTot.E += r.e; gTot.A += r.a;
  }

  const rows = students.map((s) => {
    const per = index.get(s.id) || new Map();
    const enrolledIds = new Set(s.enrolments.map((e) => e.unitId));
    // Marks on units the student has since LEFT are still listed (flagged
    // enrolled:false, so the register view can badge them) but are NOT counted in
    // their overall percentage. Including them made this matrix disagree with both
    // the per-student drill-down and the student's own app, which have always
    // counted current enrolments only — one student, two compliance figures.
    const relevant = new Set([...enrolledIds, ...per.keys()]);
    const unitsOut = {};
    const acc = { P: 0, L: 0, E: 0, A: 0 };
    for (const modId of relevant) {
      const c = per.get(modId) || { p: 0, l: 0, e: 0, a: 0 };
      const enrolled = enrolledIds.has(modId);
      unitsOut[modId] = { ...summariseCounts(c.p, c.l, c.e, c.a), enrolled };
      if (!enrolled) continue;
      acc.P += c.p; acc.L += c.l; acc.E += c.e; acc.A += c.a;
    }
    return { student: sStudent(s), units: unitsOut, overall: summariseCounts(acc.P, acc.L, acc.E, acc.A) };
  });

  const scopedSess = new Map(), allSess = new Map();
  for (const r of sessAgg) { scopedSess.set(r.mid, r.scoped_c); allSess.set(r.mid, r.all_c); }
  const scopedSessionTotal = sessAgg.reduce((n, r) => n + r.scoped_c, 0);

  const unitTotals = {};
  for (const mod of units) {
    const mt = modTot.get(mod.id) || { P: 0, L: 0, E: 0, A: 0 };
    unitTotals[mod.id] = { ...summariseCounts(mt.P, mt.L, mt.E, mt.A), sessionCount: scopedSess.get(mod.id) || 0 };
  }

  res.json({
    // `?? null`, not `|| 0` — a unit with neither enrolments nor a timetabled group has
    // no route to a student, and that is unmeasurable rather than empty.
    units: units.map((m) => ({ ...sUnit(m), studentCount: studentCounts.get(m.id) ?? null, sessionCount: allSess.get(m.id) || 0 })),
    rows,
    unitTotals,
    overall: summariseCounts(gTot.P, gTot.L, gTot.E, gTot.A),
    scope: { semesterId: semesterId || "", sessionCount: scopedSessionTotal },
  });
});


// GET /api/hnd/staff/:id/teaching — a lecturer's teaching load.
//
// The mirror of the student dashboard: for the staff member, the units they teach,
// how attendance is running on each, how much marking is outstanding, and the dates
// that matter. Answers "how are my units doing" without opening four screens.
router.get("/staff/:id/teaching", requireAuth, async (req, res) => {
  // No email. This route is behind registers/students/executive — pages that GET
  // /staff deliberately DENY colleagues' email addresses to. Returning it here let a
  // page-scoped admin harvest every staff email by looping the roster ids. The
  // teaching-load view only needs a name and job title.
  const staff = await prisma.staff.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, jobTitle: true, dept: true, initials: true, colour: true } });
  if (!staff) return res.status(404).json({ error: "Staff member not found" });

  const units = await prisma.unit.findMany({
    where: { tutorStaffId: staff.id },
    include: {
      course: { select: { id: true, name: true } },
      sessions: { select: { id: true, date: true, marks: { select: { status: true } } } },
      enrolments: { select: { studentId: true } },
      assessments: { select: { id: true, maxMarks: true, grades: { select: { marks: true } } } },
    },
    orderBy: { code: "asc" },
  });

  const today = localDate();
  const rows = units.map((u) => {
    const marks = u.sessions.flatMap((x) => x.marks);
    const att = summarise(marks);
    // A register counts as taken once it has any mark on it; the gap is what the
    // lecturer still owes.
    const taken = u.sessions.filter((x) => x.marks.length).length;
    const graded = u.assessments.reduce((n, a) => n + a.grades.length, 0);
    const expected = u.assessments.length * u.enrolments.length;
    return {
      id: u.id, code: u.code, name: u.name,
      course: u.course ? { id: u.course.id, name: u.course.name } : null,
      startDate: u.startDate ?? null, endDate: u.endDate ?? null, submissionDate: u.submissionDate ?? null,
      students: u.enrolments.length,
      sessions: u.sessions.length, registersTaken: taken, registersDue: u.sessions.length - taken,
      attendance: att,
      assessments: u.assessments.length, graded, expectedGrades: expected,
      finished: !!(u.endDate && u.endDate < today),
    };
  });

  const allMarks = units.flatMap((u) => u.sessions.flatMap((x) => x.marks));
  res.json({
    staff,
    units: rows,
    totals: {
      units: rows.length,
      students: new Set(units.flatMap((u) => u.enrolments.map((e) => e.studentId))).size,
      registersDue: rows.reduce((n, r) => n + r.registersDue, 0),
      graded: rows.reduce((n, r) => n + r.graded, 0),
      expectedGrades: rows.reduce((n, r) => n + r.expectedGrades, 0),
      attendance: summarise(allMarks),
    },
  });
});

// GET /api/hnd/students/:id/attendance-terms
// A student's attendance split into CURRENT vs PREVIOUS units by each unit's own
// end date. A unit's end date is its last scheduled session (the "end date" set when
// its registers were created). Once that date passes, the unit has finished and drops
// into "previous"; the overall % counts only the units still running, so it rolls
// over automatically as units finish.
router.get("/students/:id/attendance-terms", requireAuth, async (req, res) => {
  const student = await prisma.student.findUnique({ where: { id: req.params.id }, include: { enrolments: { select: { unitId: true } } } });
  if (!student) return res.status(404).json({ error: "Student not found" });
  const enrolledIds = student.enrolments.map((e) => e.unitId);
  const safeIds = enrolledIds.length ? enrolledIds : ["__none__"];

  const [units, marks, sessions] = await Promise.all([
    prisma.unit.findMany({ where: { id: { in: safeIds } } }),
    prisma.attendanceMark.findMany({ where: { studentId: student.id }, select: { status: true, sessionId: true } }),
    prisma.hndSession.findMany({ where: { unitId: { in: safeIds } }, select: { id: true, unitId: true, date: true } }),
  ]);

  const today = localDate();

  // Each unit's end date = the date of its last scheduled session.
  const endByUnit = new Map();
  const sessMod = new Map();
  for (const s of sessions) {
    sessMod.set(s.id, s.unitId);
    const cur = endByUnit.get(s.unitId);
    if (!cur || s.date > cur) endByUnit.set(s.unitId, s.date);
  }

  const marksByUnit = new Map();
  for (const m of marks) { const mid = sessMod.get(m.sessionId); if (!mid) continue; if (!marksByUnit.has(mid)) marksByUnit.set(mid, []); marksByUnit.get(mid).push(m); }

  // A unit is FINISHED when its teaching window has passed. The window (Unit.endDate)
  // is what the Registers tab shows, so staff and students now agree; the last session
  // date is only a fallback for units nobody has scheduled. Deriving it from sessions
  // alone meant a unit whose registers were generated one term at a time read
  // "finished" here while the Registers tab still said "Running now".
  const rowFor = (mod) => {
    const lastSession = endByUnit.get(mod.id) || null;
    const endDate = mod.endDate || lastSession;
    return {
      unit: sUnit(mod),
      summary: summarise(marksByUnit.get(mod.id) || []),
      endDate, lastSessionDate: lastSession,
      finished: !!(endDate && endDate < today),
    };
  };
  const rows = units.map(rowFor);
  const currentRows = rows.filter((r) => !r.finished).sort((a, b) => (a.endDate || "9999").localeCompare(b.endDate || "9999"));
  const previousRows = rows.filter((r) => r.finished).sort((a, b) => (b.endDate || "").localeCompare(a.endDate || ""));

  const currentOverall = summarise(currentRows.flatMap((r) => marksByUnit.get(r.unit.id) || []));

  res.json({
    studentId: student.id,
    cohortId: student.cohortId || null,
    today,
    current: { units: currentRows, overall: currentOverall },
    previous: previousRows,
  });
});

module.exports = router;
