// Student Reviews — a lecturer's record of a progress conversation with a student.
//
// Three audiences, three scopes, all from this one router:
//   • staff    GET /?mine=true   their own; POST/PUT/DELETE their own
//   • student  NOT here — see GET /api/student/me/reviews (the student router)
//   • admin    GET /             everything, filterable — needs the studentreviews page
//
// The scope is always derived from the token, never from a query parameter, so there
// is no id to tamper with.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth, hasPage } = require("../auth");
const { isRealDate, isString } = require("../validate");
const audit = require("../audit");

// Who the review is about and who wrote it — never what it says. A progress review
// is a lecturer's candid account of a named student, and the audit trail is read on
// pages this router's own gate deliberately keeps separate from it.
const srLabel = (row) => `Student review of ${row.student ? `${row.student.firstName} ${row.student.lastName} (${row.student.studentRef})` : "a student"}`;

const PROGRESS = ["On Track", "Monitor", "At Risk"];
const CONCERNS = ["Attendance", "Assessment Progress", "Academic Performance", "Wellbeing", "Engagement", "No Concerns"];
// Exactly the page the Access grid offers for this feature — nothing else. It also
// accepted "pat" and "students", which meant granting either of those silently handed
// over every lecturer's pastoral records, including the right to edit and delete them,
// with no checkbox anywhere saying so. A permission grid nobody can trust is worse than
// a narrow one. Super admins (adminPages === null) are unaffected.
const ADMIN_PAGES = ["studentreviews"];

// Matches the cap on a staff-review free-text answer, so the two forms behave alike.
const MAX_TEXT_LEN = 5000;
// A conversation can't have happened before the college kept these records, and a
// far-future typo like 9999-12-31 would sit at the top of the date-sorted list for ever.
const MIN_DATE = "2000-01-01";
const MAX_DATE = "2100-12-31";

const str = (v) => (typeof v === "string" ? v.trim() : "");
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

router.use(requireAuth);

const sReview = (r) => ({
  id: r.id,
  studentId: r.studentId,
  student: r.student ? { id: r.student.id, name: `${r.student.firstName} ${r.student.lastName}`, studentRef: r.student.studentRef, email: r.student.email, initials: r.student.initials, colour: r.student.colour } : null,
  unitId: r.unitId,
  unit: r.unit ? { id: r.unit.id, code: r.unit.code, name: r.unit.name } : null,
  staffId: r.staffId,
  // staffName is stored, so a review still says who wrote it after that person leaves.
  staffName: r.staffName || r.staff?.name || "",
  date: r.date,
  progress: r.progress,
  concerns: parse(r.concerns, []),
  summary: r.summary,
  agreedActions: r.agreedActions,
  followUp: r.followUp,
  followUpDate: r.followUpDate,
  followUpCompletedOn: r.followUpCompletedOn ?? null,
  followUpCompletedBy: r.followUpCompletedBy ?? null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const INCLUDE = { student: true, unit: true, staff: { select: { name: true } } };

// The fixed choice lists, so the three clients never hard-code them.
router.get("/options", (_req, res) => res.json({ progress: PROGRESS, concerns: CONCERNS }));

// The student and unit pickers for the review form.
//
// This exists because /api/hnd is gated on requireAnyPage(["registers","students",
// "executive"]) for the whole router, and an ordinary lecturer holds none of those. The
// Student Review tile is shown to every staff member and the server accepts a review
// from any of them — so without this, the one group the feature is FOR opened the screen
// to an empty student list and a permanently disabled "New review" button. An admin
// granted only the "Student Reviews" page hit the same wall on the admin tab.
//
// Deliberately minimal: just enough to identify a person and a unit in a dropdown. No
// contact details, no enrolments, no attendance or grades — filing a review needs a
// name, not a record. Anyone who can write a review can read this.
router.get("/roster", async (_req, res) => {
  const [students, units] = await Promise.all([
    prisma.student.findMany({
      select: {
        // No email. This roster is open to ANY authenticated staff member (a lecturer
        // with no admin page), and the comment above says "no contact details" — but
        // email was being returned, leaking every student's address to the whole staff
        // body. The picker needs a name and reference to identify a student, not a
        // contact detail.
        id: true, firstName: true, lastName: true, studentRef: true, initials: true, colour: true,
        // The school, for the admin list's school filter. An id, not a contact detail —
        // sStudent already ships it to any authenticated caller, so this widens nothing.
        academicDepartmentId: true,
        // Both routes to a course, so the app can pick the student and have their
        // course follow. Only 4 of 136 students have a cohort, so the enrolments are
        // what actually answers it for almost everyone.
        cohort: { select: { courseId: true } },
        enrolments: { select: { unit: { select: { courseId: true } } } },
      },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    }),
    // courseId comes too, so the app can ask which course first and then show only
    // that course's units — otherwise a lecturer scrolls 39 units across four
    // intakes, several of which are called "UNIT 1".
    prisma.unit.findMany({
      select: { id: true, code: true, name: true, courseId: true, course: { select: { id: true, name: true } } },
      orderBy: { code: "asc" },
    }),
  ]);
  res.json({
    students: students.map((s) => {
      // The cohort is authoritative when set; otherwise take the course their units
      // agree on. Left null when the units span courses, so the app asks rather than
      // guessing at a lecturer's expense.
      const fromUnits = [...new Set(s.enrolments.map((e) => e.unit?.courseId).filter(Boolean))];
      return {
        id: s.id, name: `${s.firstName} ${s.lastName}`.trim(),
        // No email — it isn't selected above (contact details are withheld from this
        // roster). Emitting the undefined field was harmless but misleading.
        studentRef: s.studentRef, initials: s.initials, colour: s.colour,
        academicDepartmentId: s.academicDepartmentId ?? null,
        courseId: s.cohort?.courseId || (fromUnits.length === 1 ? fromUnits[0] : null),
      };
    }),
    // Only units that belong to a course can be offered behind a course picker; a unit
    // with no course would be unreachable, so it is left in the list unscoped.
    units: units.map((u) => ({ id: u.id, code: u.code, name: u.name, courseId: u.courseId || null })),
    courses: [...new Map(units.filter((u) => u.course).map((u) => [u.course.id, u.course])).values()]
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
});

// A student never reaches this router: requireAuth blocks a student token on every
// mount except /api/student. Their own reviews are served by GET /api/student/me/reviews.

// Staff and admin listing. `mine=true` limits it to the caller's own; otherwise the
// caller must hold an admin page that covers student records.
router.get("/", async (req, res) => {
  if (req.user?.kind === "student") return res.status(403).json({ error: "Not available for student accounts" });
  const mine = req.query?.mine === "true";
  const where = {};
  if (mine) {
    where.staffId = req.user.id;
  } else if (!hasPage(req.user, ADMIN_PAGES)) {
    return res.status(403).json({ error: "You don't have access to all student reviews" });
  }
  const studentId = str(req.query?.studentId);
  const progress = str(req.query?.progress);
  if (studentId) where.studentId = studentId;
  if (progress) {
    if (!PROGRESS.includes(progress)) return res.status(400).json({ error: "Unknown progress value" });
    where.progress = progress;
  }
  if (req.query?.followUp === "true") where.followUp = true;
  else if (req.query?.followUp === "false") where.followUp = false;
  const rows = await prisma.studentReview.findMany({ where, include: INCLUDE, orderBy: [{ date: "desc" }, { createdAt: "desc" }] });
  res.json(rows.map(sReview));
});

// Validate a create/update body. `partial` allows omitted fields on update.
async function validate(body, partial, current, actorName = null) {
  const data = {};
  const need = (k) => !partial || body?.[k] !== undefined;

  if (need("studentId")) {
    const studentId = str(body?.studentId);
    if (!studentId) return { error: "Choose the student this review is about" };
    const exists = await prisma.student.findUnique({ where: { id: studentId } });
    if (!exists) return { error: "Unknown student" };
    data.studentId = studentId;
  }
  if (body?.unitId !== undefined) {
    const unitId = str(body.unitId);
    if (unitId) {
      const unit = await prisma.unit.findUnique({ where: { id: unitId } });
      if (!unit) return { error: "Unknown unit" };
      data.unitId = unitId;
    } else data.unitId = null;
  }
  if (need("date")) {
    const date = str(body?.date);
    if (!isRealDate(date)) return { error: "Enter a real date for the conversation (YYYY-MM-DD)" };
    if (date < MIN_DATE || date > MAX_DATE) return { error: `That date looks wrong — enter a date between ${MIN_DATE} and ${MAX_DATE}` };
    data.date = date;
  }
  if (need("progress")) {
    const progress = str(body?.progress);
    if (!PROGRESS.includes(progress)) return { error: `Progress must be one of: ${PROGRESS.join(", ")}` };
    data.progress = progress;
  }
  if (body?.concerns !== undefined) {
    if (!Array.isArray(body.concerns)) return { error: "Concerns must be a list" };
    const list = body.concerns.map(String);
    const bad = list.find((c) => !CONCERNS.includes(c));
    if (bad) return { error: `"${bad}" is not one of the listed concerns` };
    // "No Concerns" is a statement that there are none, so it cannot sit alongside a
    // concern — the record would contradict itself.
    if (list.includes("No Concerns") && list.length > 1) {
      return { error: `"No Concerns" can't be selected together with a specific concern` };
    }
    // Store in the form's own order so two reviews always read the same way.
    data.concerns = JSON.stringify(CONCERNS.filter((c) => list.includes(c)));
  }
  // Refuse rather than truncate. Silently dropping everything past 5000 characters lost
  // the tail of a long summary with no warning — including from the student's own copy.
  for (const [key, label] of [["summary", "Summary of the conversation"], ["agreedActions", "Agreed actions"]]) {
    if (body?.[key] === undefined) continue;
    if (typeof body[key] !== "string") return { error: `${label} must be text` };
    const v = str(body[key]);
    if (v.length > MAX_TEXT_LEN) return { error: `${label} is too long — please keep it under ${MAX_TEXT_LEN.toLocaleString()} characters (currently ${v.length.toLocaleString()})` };
    data[key] = v;
  }

  if (body?.followUp !== undefined) {
    if (typeof body.followUp !== "boolean") return { error: "followUp must be true or false" };
    data.followUp = body.followUp;
  }
  // A follow-up date only means anything when a follow-up is actually required; the
  // date is cleared otherwise so a "No" can't leave a stale date behind.
  //
  // `current` is the row being edited, so a partial update that sends only a new date
  // still knows a follow-up is outstanding. Reading `data.followUp` alone made
  // PUT {followUpDate} a silent no-op that returned 200 and changed nothing.
  const wantsFollowUp = data.followUp !== undefined ? data.followUp : current?.followUp;
  if (wantsFollowUp === true) {
    const d = str(body?.followUpDate) || (body?.followUpDate === undefined ? str(current?.followUpDate) : "");
    if (!isRealDate(d)) return { error: "Enter a follow-up date" };
    // A follow-up is by definition after the conversation it follows.
    const on = data.date || current?.date;
    if (on && d < on) return { error: "The follow-up date can't be before the date of the conversation" };
    data.followUpDate = d;
  } else if (wantsFollowUp === false) {
    // Clearing the FLAG no longer clears the DATE. Clearing it was the only way to
    // close a follow-up and it destroyed the record that one had ever been due, which
    // is why `followUpDate < today` was true for ever and the overdue signal could not
    // be built.
    //
    // RETRACTION IS STILL A REAL EVENT and needs its own gesture — the student
    // withdrew, the concern resolved itself. This branch used to be EMPTY, which meant
    // the explicit `followUpDate: ""` the comment promised did nothing at all: an empty
    // string arriving while the flag was already false fell through here and the date
    // survived, so nothing could retract a promise. Two smoke assertions written
    // against that promise could never have passed.
    if (body?.followUpDate !== undefined && !str(body.followUpDate)) {
      data.followUpDate = null;
      // A retracted promise cannot carry a completion. Leaving one would say the
      // follow-up that no longer exists was held.
      data.followUpCompletedOn = null;
      data.followUpCompletedBy = null;
    }
  }

  // RE-PROMISING CLEARS THE OLD COMPLETION. Moving the date to a NEW day is a new
  // promise, and a completion attached to the old one does not carry over — leaving it
  // would say the new follow-up was held on a date before it was arranged, and would
  // make the re-promised follow-up permanently invisible to the overdue count, which
  // only ever asks whether a completion is ABSENT.
  if (current && data.followUpDate !== undefined && data.followUpDate !== current.followUpDate
      && body?.followUpCompletedOn === undefined) {
    data.followUpCompletedOn = null;
    data.followUpCompletedBy = null;
  }

  if (body?.followUpCompletedOn !== undefined) {
    const done = isString(body.followUpCompletedOn) ? body.followUpCompletedOn.trim() : "";
    if (done && !isRealDate(done)) {
      return { error: "Enter a real date for when the follow-up happened (YYYY-MM-DD)." };
    }
    // Nothing can be completed that was never promised — see routes/interactions.js.
    const due = data.followUpDate !== undefined ? data.followUpDate : (current ? current.followUpDate : null);
    if (done && !due) return { error: "There is no follow-up on this review to mark as done." };
    const on = data.date !== undefined ? data.date : (current ? current.date : null);
    if (done && on && done < on) {
      return { error: "The follow-up can't have happened before the conversation." };
    }
    data.followUpCompletedOn = done || null;
    // From the token, never the body, exactly as staffName is.
    data.followUpCompletedBy = done ? (actorName || null) : null;
    // Recording a completion closes it, or the row says both done and outstanding.
    if (done) data.followUp = false;
  }
  return { data };
}

router.post("/", async (req, res) => {
  if (req.user?.kind === "student") return res.status(403).json({ error: "Students can't file reviews" });
  const v = await validate(req.body, false, null, req.user?.name || null);
  if (v.error) return res.status(400).json({ error: v.error });
  const row = await prisma.studentReview.create({
    // staffId always comes from the token — never the body.
    data: { ...v.data, staffId: req.user.id, staffName: req.user?.name || "" },
    include: INCLUDE,
  });
  audit.record(req, {
    action: "studentReview.created", entity: "StudentReview", entityId: row.id,
    summary: `${srLabel(row)} filed by ${row.staffName || "a lecturer"}`,
    after: { studentId: row.studentId, staffId: row.staffId, date: row.date, followUpDate: row.followUpDate },
  });
  res.status(201).json(sReview(row));
});

// The author may correct their own; an admin may correct any.
async function mayEdit(req, id) {
  const row = await prisma.studentReview.findUnique({ where: { id } });
  if (!row) return { error: 404 };
  if (row.staffId === req.user.id) return { row };
  if (hasPage(req.user, ADMIN_PAGES)) return { row };
  return { error: 403 };
}

router.get("/:id", async (req, res) => {
  const row = await prisma.studentReview.findUnique({ where: { id: req.params.id }, include: INCLUDE });
  if (!row) return res.status(404).json({ error: "Review not found" });
  const isAuthor = row.staffId === req.user.id;
  if (!isAuthor && !hasPage(req.user, ADMIN_PAGES)) return res.status(404).json({ error: "Review not found" });
  res.json(sReview(row));
});

router.put("/:id", async (req, res) => {
  if (req.user?.kind === "student") return res.status(403).json({ error: "Students can't edit reviews" });
  const found = await mayEdit(req, req.params.id);
  if (found.error) return res.status(404).json({ error: "Review not found" });
  const v = await validate(req.body, true, found.row, req.user?.name || null);
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const row = await prisma.studentReview.update({ where: { id: found.row.id }, data: v.data, include: INCLUDE });
    // An admin correcting somebody else's review is the case worth separating out:
    // the author's name stays on the record either way, so without this the edit is
    // invisible and the review still reads as entirely theirs.
    audit.record(req, {
      action: "studentReview.updated", entity: "StudentReview", entityId: row.id,
      summary: `${srLabel(row)} edited` + (found.row.staffId !== req.user.id ? ` by ${req.user.name}, who is not its author (${row.staffName || "unknown"})` : ""),
      after: { studentId: row.studentId, staffId: row.staffId, date: row.date, followUpDate: row.followUpDate, editedByAuthor: found.row.staffId === req.user.id, fieldsChanged: audit.changedKeys(found.row, { ...found.row, ...v.data }) },
    });
    res.json(sReview(row));
  } catch (e) {
    // Two admins on the same review: one deletes while the other saves. P2025 is "record
    // not found" — the honest answer is 404, not a 500 "Something went wrong".
    if (e?.code === "P2025") return res.status(404).json({ error: "Review not found" });
    throw e;
  }
});

router.delete("/:id", async (req, res) => {
  if (req.user?.kind === "student") return res.status(403).json({ error: "Students can't delete reviews" });
  const found = await mayEdit(req, req.params.id);
  if (found.error) return res.status(404).json({ error: "Review not found" });
  try {
    await prisma.studentReview.delete({ where: { id: found.row.id } });
    audit.record(req, {
      action: "studentReview.deleted", entity: "StudentReview", entityId: found.row.id,
      summary: `Student review dated ${found.row.date}, filed by ${found.row.staffName || "a lecturer"}, deleted` + (found.row.staffId !== req.user.id ? ` by ${req.user.name}, who is not its author` : ""),
      before: { studentId: found.row.studentId, staffId: found.row.staffId, staffName: found.row.staffName, date: found.row.date },
      after: null,
    });
    res.json({ ok: true });
  } catch (e) {
    if (e?.code === "P2025") return res.status(404).json({ error: "Review not found" });
    throw e;
  }
});

module.exports = router;
