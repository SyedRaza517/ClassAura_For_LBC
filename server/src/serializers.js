// Convert DB rows -> the shape the React client expects.
// NOTE: totpSecret is deliberately absent — only the enrolment endpoint ever
// returns it, and only to the person enrolling.
const sStaff = (s) => ({
  id: s.id, name: s.name, role: s.jobTitle, dept: s.dept, email: s.email,
  site: s.site ?? null,
  allowance: s.allowance, initials: s.initials, colour: s.colour, accountRole: s.accountRole,
  dob: s.dob ?? null,
  mustChangePassword: s.mustChangePassword ?? false,
  totpEnabled: s.totpEnabled ?? false,
  totpRequired: s.mustSetupTotp ?? false,
  // True while an admin-created account is waiting for the person to set their
  // own password from the invitation email. Such an account cannot be signed into.
  pendingActivation: s.pendingActivation ?? false,
  // --- Admin access control ---
  isSuperAdmin: s.isSuperAdmin ?? false,
  // Parsed to an array of allowed page keys, or null = "never configured" (full
  // access). Bad/corrupt JSON is treated as null rather than throwing.
  adminPages: parseAdminPages(s.adminPages),
  // Which support-department queues this person reads. An array, always — parsed here
  // rather than shipped as the raw JSON string, matching adminPages above.
  //
  // Unparseable reads as NO membership rather than as full membership. A corrupted
  // column must not open every queue, and this one decides who reads a student's
  // disclosures to the wellbeing team.
  supportDepartments: (() => {
    try {
      const parsed = JSON.parse(s.supportDepartments || "[]");
      return Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : [];
    } catch { return []; }
  })(),
  // --- Academic departments ---
  // Which TEACHING departments this person may see -- Business, Computing, Law. NOT
  // supportDepartments above, which is who reads a student's wellbeing disclosure. Two
  // access boundaries with one English word between them; see academicDepartments.js.
  //
  // Present only when the query included the join rows, and ABSENT otherwise rather than
  // defaulted to []. "Nobody asked for them" and "belongs to none" are different facts,
  // and the second is a real answer the Access screen has to be able to show.
  ...(s.academicDepartments
    ? { academicDepartmentIds: s.academicDepartments.map((m) => m.academicDepartmentId) }
    : {}),
  // Lifts the departmental boundary entirely. `=== true` on read, for the same reason
  // parseAdminPages below fails closed: an account that suddenly sees everything is a
  // silent, dangerous failure.
  collegeWide: s.collegeWide === true,
});

// NULL → null, which every caller reads as "never configured → full access".
//
// Anything UNPARSEABLE now returns [] — deny everything — not null. This is a
// security decision and it must fail closed: a truncated or corrupt column used to
// be indistinguishable from "unconfigured", so one bad value silently promoted a
// page-scoped admin to an unrestricted one, with no audit trail and no visible
// change in the Access grid. An admin who suddenly has no pages is a loud, safe
// failure; an admin who suddenly has all of them is a silent, dangerous one.
function parseAdminPages(raw) {
  if (raw == null) return null;
  try {
    const a = JSON.parse(raw);
    if (Array.isArray(a)) return a;
    console.error(`[rbac] adminPages is not an array, denying all pages: ${String(raw).slice(0, 120)}`);
    return [];
  } catch (_) {
    console.error(`[rbac] adminPages is not valid JSON, denying all pages: ${String(raw).slice(0, 120)}`);
    return [];
  }
}

const sSignup = (r) => ({
  id: r.id, kind: r.kind || "staff", studentId: r.studentId ?? null, collegeId: r.collegeId ?? null,
  name: r.name, email: r.email, role: r.jobTitle, dept: r.dept, site: r.site ?? null,
  status: r.status, note: r.note, decidedBy: r.decidedBy, decidedAt: r.decidedAt,
  requestedAt: r.createdAt,
});
const sNotification = (n) => ({ id: n.id, type: n.type, message: n.message, link: n.link, read: n.read, at: n.createdAt });
// tagId is named explicitly for the same reason as checkedInAt below — sCheckin is an
// allowlist. It says the clock-in was made at a sticker in the building rather than by
// pressing the button, which is the difference between "was here" and "said so".
const sCheckin = (c) => ({ id: c.id, staffId: c.staffId, date: c.date, in: c.timeIn, out: c.timeOut, summary: c.summary, site: c.site ?? null, tagId: c.tagId ?? null });
const sLeave = (l) => ({
  id: l.id, staffId: l.staffId, type: l.type, start: l.start, end: l.end, days: l.days, reason: l.reason,
  status: l.status, requestedAt: l.requestedAt, decidedBy: l.decidedBy, decidedAt: l.decidedAt, note: l.note,
});
const sDoc = (d) => ({
  id: d.id, name: d.name, type: d.type, date: d.date, scope: d.scope, assignedTo: d.assignedToId,
  // hasFile drives whether the UI offers to open it. filePath itself is deliberately
  // NOT sent: it is a key inside a private bucket, and the client has no use for it —
  // downloads go through /documents/:id/download, which checks access before signing.
  hasFile: Boolean(d.filePath),
  fileName: d.fileName ?? null,
  mimeType: d.mimeType ?? null,
  sizeBytes: d.sizeBytes ?? null,
  uploadedAt: d.uploadedAt ?? null,
});
const sAdj = (a) => ({ id: a.id, staffId: a.staffId, days: a.days, note: a.note, date: a.date });

/* ---------- HND attendance registers ---------- */
const sSemester = (s) => ({ id: s.id, name: s.name, start: s.start, end: s.end });
const sCourse = (p) => ({
  id: p.id, name: p.name, colour: p.colour,
  // Present only when the query asked Prisma to count relations.
  ...(p._count ? { unitCount: p._count.units, cohortCount: p._count.cohorts } : {}),
});
const sCohort = (c) => ({ id: c.id, name: c.name, courseId: c.courseId, startDate: c.startDate ?? null, createdAt: c.createdAt });
const sTerm = (t) => ({ id: t.id, cohortId: t.cohortId, year: t.year, index: t.index, name: t.name, start: t.start, end: t.end });
const sUnit = (m) => ({
  id: m.id, code: m.code, unitNumber: m.unitNumber ?? "", name: m.name, tutor: m.tutor, courseId: m.courseId ?? null,
  // Where the unit sits in the course structure ("Year 1 · Term 2"), null when it
  // has not been classified. Separate from termId, which is a dated teaching term.
  year: m.year ?? null, termNumber: m.termNumber ?? null,
  // The teaching window, which decides whether the unit is running, finished or
  // still to come. Set in Staff Hub; never overwritten by the Moodle sync.
  startDate: m.startDate ?? null, endDate: m.endDate ?? null,
  // When work is due in — shown on the unit in both Registers and Assessments.
  submissionDate: m.submissionDate ?? null,
  // The staff account teaching this unit, when one is linked. `tutor` above stays as
  // the display name, so a unit assigned before this existed still shows a name.
  tutorStaffId: m.tutorStaffId ?? null,
  tutorName: m.tutorStaff?.name ?? m.tutor ?? "",
  // The module leader, beside the lecturer above. Null when nobody has been named —
  // "not recorded", which the tracker renders as "—" rather than as a finding. No
  // fallback to a free-text name, unlike tutorName: there is no pre-relation history
  // to carry here, so an empty string would invent a distinction that does not exist.
  leaderStaffId: m.leaderStaffId ?? null,
  leaderName: m.leaderStaff?.name ?? null,
  cohortId: m.cohortId ?? null, termId: m.termId ?? null,
  // Present only when the query asked Prisma to count relations.
  ...(m._count ? { sessionCount: m._count.sessions, studentCount: m._count.enrolments } : {}),
});
const sStudent = (s) => ({
  id: s.id, firstName: s.firstName, lastName: s.lastName, name: `${s.firstName} ${s.lastName}`,
  studentRef: s.studentRef, email: s.email, initials: s.initials, colour: s.colour, active: s.active,
  dob: s.dob ?? null,
  cohortId: s.cohortId ?? null,
  ...(s.enrolments ? { unitIds: s.enrolments.map((e) => e.unitId) } : {}),
});
// The applicant (prospective-student portal) identity attached to req.user by requireAuth.
// Deliberately minimal and secret-free — NEVER the passwordHash, and no admin fields, so an
// applicant object can't masquerade as staff/admin. The full application record is assembled
// by the /api/applicant routes themselves.
const sApplicant = (a) => ({
  id: a.id, email: a.email || "",
  firstName: a.firstName || "", surname: a.surname || "",
  name: [a.firstName, a.surname].filter(Boolean).join(" ") || a.email || "Applicant",
  course: a.course || "", intake: a.intake || "", active: a.active !== false,
});
const sSession = (x) => ({
  id: x.id, unitId: x.unitId, date: x.date, start: x.startTime, end: x.endTime,
  description: x.description, audience: x.audience, kind: x.kind ?? "",
  ...(x._count ? { markedCount: x._count.marks } : {}),
});
// checkedInAt is named explicitly because this is an allowlist, not a blocklist: a
// column added to AttendanceMark tomorrow stays private until somebody publishes it
// deliberately. It is the minute the student tapped in, distinct from takenAt, which is
// reset every time the register is saved.
const sMark = (m) => ({ id: m.id, sessionId: m.sessionId, studentId: m.studentId, status: m.status, remark: m.remark, takenBy: m.takenBy, takenAt: m.takenAt, checkedInAt: m.checkedInAt ?? null });
const sInteraction = (i) => ({
  id: i.id, studentId: i.studentId, date: i.date, time: i.time, queryType: i.queryType,
  summary: i.summary, followUpActions: i.followUpActions, followUpRequired: i.followUpRequired,
  followUpDate: i.followUpDate,
  followUpCompletedOn: i.followUpCompletedOn ?? null,
  followUpCompletedBy: i.followUpCompletedBy ?? null,
  tutor: i.tutor, loggedBy: i.loggedBy, createdAt: i.createdAt,
  // When the query includes the student, surface the fields the log table shows.
  ...(i.student ? { student: { id: i.student.id, name: `${i.student.firstName} ${i.student.lastName}`, studentRef: i.student.studentRef, initials: i.student.initials, colour: i.student.colour } } : {}),
});

// A referral, for THE DEPARTMENT IT WAS SENT TO. Everything, case notes included.
const sReferralForDepartment = (r) => ({
  id: r.id, studentId: r.studentId, department: r.department,
  reason: r.reason, urgency: r.urgency, status: r.status,
  outcome: r.outcome ?? null, outcomeDetail: r.outcomeDetail, notes: r.notes,
  raisedBy: r.raisedBy ?? null, raisedOn: r.raisedOn,
  acceptedBy: r.acceptedBy ?? null, acceptedOn: r.acceptedOn ?? null,
  closedBy: r.closedBy ?? null, closedOn: r.closedOn ?? null,
  studentNotified: r.studentNotified, interactionId: r.interactionId ?? null,
  // WHO ASKED. The queue card leads with it, because a student who came of their own
  // accord is opened differently from one a tutor sent — and a self-referral has no
  // raisedBy at all, so without this the card would fall back to "raised by a member of
  // staff", which is the one thing it certainly was not.
  selfReferred: r.selfReferred === true,
  createdAt: r.createdAt,
  ...(r.student ? { student: { id: r.student.id, name: r.student.firstName + " " + r.student.lastName, studentRef: r.student.studentRef, initials: r.student.initials, colour: r.student.colour } } : {}),
});

// A referral, for THE TUTOR WHO RAISED IT. Status and an outcome CODE; never the case
// notes, and never the free text written at closure.
//
// THE OMISSION IS THE FEATURE, AND IT IS AN ALLOWLIST FOR THAT REASON. This function
// names every field it emits, so a column added to Referral tomorrow does not appear
// here — it has to be added on purpose. Written as a denylist (spread the row, delete
// two keys) the next column would ship to the referrer by default, which is exactly
// how sAdmission leaked: it stripped a fixed list of secrets, so everything added
// afterwards was public the moment it existed.
//
// The outcome is a code; outcomeDetail is prose; only the code crosses. A tutor learns
// their referral was closed as "supported", and what the student disclosed to the
// wellbeing team is not theirs to read. Same line MitigatingCircumstance draws between
// what the college decided and why.
//
// scripts/smoke-referrals.mjs asserts this key set EXACTLY, rather than asserting that
// two names are absent — a test checking for the absence of two strings passes just as
// happily when a third one leaks.
const sReferralForReferrer = (r) => ({
  id: r.id, studentId: r.studentId, department: r.department,
  reason: r.reason, urgency: r.urgency, status: r.status,
  outcome: r.outcome ?? null,
  raisedOn: r.raisedOn,
  acceptedOn: r.acceptedOn ?? null,
  closedOn: r.closedOn ?? null,
  studentNotified: r.studentNotified, interactionId: r.interactionId ?? null,
  createdAt: r.createdAt,
  ...(r.student ? { student: { id: r.student.id, name: r.student.firstName + " " + r.student.lastName, studentRef: r.student.studentRef, initials: r.student.initials, colour: r.student.colour } } : {}),
});

// A referral, for THE STUDENT IT IS ABOUT.
//
// THE NARROWEST OF THE THREE, AND THE ONE WITH A PRECONDITION THE OTHERS DO NOT HAVE.
// routes/student.js only ever hands rows with studentNotified === true to this
// function, because a student portal that listed every referral would defeat the
// tickbox that decides whether the student is told at all — a safeguarding concern
// raised with the box UNTICKED would appear in the student's app that evening.
// The filter is in the route rather than here so that it is a query the database
// enforces, not a field this function could be trusted to omit.
//
// No reason, no notes, no outcomeDetail, no names. The reason is the tutor's account
// of the student written for somebody else, and a student reading it is how tutors
// learn to write nothing. departmentName is resolved by the caller and passed in,
// because a student must never be shown a slug.
const sReferralForStudent = (r, departmentName) => ({
  id: r.id,
  department: r.department,
  departmentName: departmentName || r.department,
  status: r.status,
  outcome: r.outcome ?? null,
  raisedOn: r.raisedOn,
  acceptedOn: r.acceptedOn ?? null,
  closedOn: r.closedOn ?? null,
  // Who started it. The screen says "you asked for this" or "your tutor referred you",
  // which are different enough that a student should not have to guess.
  selfReferred: r.selfReferred === true,
  // THE ONE FIELD THAT DEPENDS ON WHO WROTE IT.
  //
  // On a staff referral the reason is somebody else's account of this student, written
  // for a third party, and showing it is how tutors learn to write nothing useful. On a
  // self-referral it is the student's own words, typed into a form by them — withholding
  // those would be absurd, and worse, it would leave them unable to check what they
  // actually said before a wellbeing officer replies to it.
  //
  // Conditional on the stored boolean, not on the caller: a route cannot opt a staff
  // referral into this by passing a flag.
  ...(r.selfReferred === true ? { reason: r.reason } : {}),
});

// One hand-off. NEVER carries notesAtTransfer: this shape is shown to the receiving
// team and to the referrer, and the archived notes belong to the department that
// wrote them. routes/referrals.js adds that field back for a caller who is on the
// fromDepartment, one entry at a time — an allowlist widened deliberately rather than
// a payload trimmed afterwards.
const sReferralTransfer = (t) => ({
  id: t.id, referralId: t.referralId,
  fromDepartment: t.fromDepartment, toDepartment: t.toDepartment,
  reason: t.reason,
  transferredBy: t.transferredBy ?? null, transferredOn: t.transferredOn,
  createdAt: t.createdAt,
});

// One message in the referrer/department thread. Everything here is visible to both
// parties by construction — the thread IS the shared channel, and the field that is
// not shared is Referral.notes, which no message ever touches.
// authorRole is one of "student" | "referrer" | "department". "student" arrived with
// self-referral: on those there is no staff referrer at all, so a message from the
// person the case is about would otherwise have had to masquerade as one — and the
// screens label the two differently.
const sReferralMessage = (m) => ({
  id: m.id, referralId: m.referralId, department: m.department,
  authorRole: m.authorRole, authorName: m.authorName ?? null,
  body: m.body, createdAt: m.createdAt,
});

const sAssessment = (a) => ({
  id: a.id, unitId: a.unitId, title: a.title, type: a.type, maxMarks: a.maxMarks,
  weight: a.weight, dueDate: a.dueDate, createdAt: a.createdAt,
  // When the scripts are to be MARKED by, as opposed to dueDate above, which is when
  // students hand them in. Null when the college sets no internal marking deadline.
  markingDueDate: a.markingDueDate ?? null,
  ...(a._count ? { gradedCount: a._count.grades } : {}),
  ...(a.unit ? { unitCode: a.unit.code, unitName: a.unit.name } : {}),
});
const sGrade = (g) => ({
  id: g.id, assessmentId: g.assessmentId, studentId: g.studentId, marks: g.marks,
  feedback: g.feedback, gradedBy: g.gradedBy, gradedAt: g.gradedAt,
  // Where the mark came from ("manual" = typed here, "moodle" = imported) and the
  // VLE's own dates. Exposed so staff can see provenance, and so the sync's promise
  // that it never overwrites hand-entered marks is verifiable from outside.
  source: g.source ?? "manual", submittedAt: g.submittedAt ?? null, gradedOn: g.gradedOn ?? null,
});

/* ---------- Timesheets ---------- */
const sTimesheet = (t) => ({
  id: t.id, staffId: t.staffId, date: t.date, start: t.startTime, end: t.endTime,
  minutes: t.minutes, hours: Math.round((t.minutes / 60) * 100) / 100,
  mode: t.mode, title: t.title, unitId: t.unitId ?? null, note: t.note,
  status: t.status, submittedAt: t.submittedAt, createdAt: t.createdAt,
  reviewNote: t.reviewNote ?? null, reviewedBy: t.reviewedBy ?? null, reviewedAt: t.reviewedAt ?? null,
  ...(t.staff ? { staffName: t.staff.name, staffDept: t.staff.dept, staffInitials: t.staff.initials, staffColour: t.staff.colour } : {}),
});

// A student query + its (optional) admin response. Includes a light student summary
// for the admin list.
const sStudentQuery = (q) => ({
  id: q.id, studentId: q.studentId,
  subject: q.subject || "", message: q.message,
  status: q.status, response: q.response || "",
  respondedBy: q.respondedBy ?? null, respondedAt: q.respondedAt ?? null,
  createdAt: q.createdAt,
  ...(q.student ? { studentName: q.student.name || `${q.student.firstName} ${q.student.lastName}`, studentRef: q.student.studentRef, studentEmail: q.student.email, studentInitials: q.student.initials, studentColour: q.student.colour } : {}),
});

// One weekly timetable row. `unit` is included when the query asks, so the client can
// show the unit code alongside the free-text title.
const sTimetableSlot = (t) => ({
  id: t.id, courseId: t.courseId ?? null, year: t.year ?? null, termNumber: t.termNumber ?? null,
  unitId: t.unitId ?? null, day: t.day, start: t.startTime, end: t.endTime,
  title: t.title, lecturer: t.lecturer ?? "", room: t.room ?? "", published: !!t.published,
  ...(t.unit ? { unitCode: t.unit.code } : {}),
  ...(t.course ? { courseName: t.course.name } : {}),
});

const sTermCalendar = (c) => ({
  courseId: c.courseId ?? null, year: c.year ?? null, termNumber: c.termNumber ?? null,
  startDate: c.startDate || null, endDate: c.endDate || null,
  weeks: Array.isArray(c.weeks) ? c.weeks : (() => { try { return JSON.parse(c.weeks || "[]"); } catch { return []; } })(),
  published: !!c.published,
});

module.exports = { sStaff, sSignup, sCheckin, sLeave, sDoc, sAdj, sNotification, sSemester, sCourse, sCohort, sTerm, sUnit, sStudent, sApplicant, sSession, sMark, sInteraction, sReferralForDepartment, sReferralForReferrer, sReferralForStudent, sReferralTransfer, sReferralMessage, sAssessment, sGrade, sTimesheet, sStudentQuery, sTimetableSlot, sTermCalendar, parseAdminPages };
