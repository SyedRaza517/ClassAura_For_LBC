// Referrals: handing a student on to Wellbeing, ASK or Student Support, and tracking
// what became of it.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE
//
// You read the queues for departments you BELONG TO. The tutor who raised a referral
// learns its status and its outcome code, and never the receiving team's case notes.
// That is not a UI decision — the two serialisers in serializers.js are what make it
// true, and every handler below picks the one matching who is asking.
//
// The page grant ("referrals") opens the FEATURE. Membership, in
// Staff.supportDepartments, decides which queues within it. That split is forced
// rather than chosen: the department list is configuration a college edits at runtime,
// so a college adding "Careers" at four in the afternoon cannot also add a permission
// key to the four hand-maintained copies of ADMIN_PAGES.
const router = require("express").Router();
const prisma = require("../db");
const { sReferralForDepartment, sReferralForReferrer } = require("../serializers");
const { requireAuth, requirePage, requireAnyPage } = require("../auth");
const { isRealDate } = require("../validate");
const { localDate } = require("../clock");
const departments = require("../supportDepartments");
const audit = require("../audit");
const email = require("../email");
const mailFrom = require("../mailFrom");
const branding = require("../branding");

// THE DEPARTMENT LIST IS MOUNTED ABOVE THE ROUTER GUARD, DELIBERATELY.
//
// Everything below needs the "referrals" page. These two do not, and putting them
// under it was wrong in both directions: an administrator holding "settings" — whose
// job editing the college's organisation chart actually is — could not even READ the
// list, so the editor could only render an authorisation error; while the guard
// implied that any caseworker could edit it.
//
// So: reading needs either page, because the nav cannot be built without it and the
// settings screen cannot render an editor for a list it may not fetch. Writing needs
// "settings" alone, because retiring the ASK desk is an administrative act and a
// wellbeing officer holds this feature to work their queue.
//
// Mounted here rather than guarded inside the handlers because router.use applies to
// what is registered AFTER it — the ordering is the mechanism, and it is the same
// reason index.js used to mount two routers above the tenant middleware.
router.get("/departments", requireAuth, requireAnyPage(["referrals", "settings"]), async (req, res) => {
  res.json({
    departments: await departments.all(),
    // Membership is only meaningful for somebody who holds the feature. A settings
    // admin reading this to render the editor gets an empty list, which is true.
    mine: departments.membershipOf(req.user),
  });
});

router.put("/departments", requireAuth, requirePage("settings"), async (req, res) => {
  const saved = await departments.save(req.body?.departments, req.user?.name || "");
  if (saved.error) return res.status(400).json({ error: saved.error });
  audit.record(req, {
    action: "supportDepartments.saved", entity: "SupportDepartmentConfig",
    summary: "Support departments updated by " + (req.user?.name || "an administrator") +
      " — " + saved.departments.map((d) => d.name).join(", "),
  });
  res.json({ departments: saved.departments });
});

// Everything from here needs the page. Reads included: a referral says which student
// was sent to Wellbeing and why, which is not a fact to hand to any signed-in member
// of staff.
router.use(requireAuth, requirePage("referrals"));

const str = (v) => (typeof v === "string" ? v.trim() : "");

const URGENCIES = ["routine", "urgent"];

// Department key -> mailFrom category, for the two that have one. An absent entry is a
// real answer: mailFrom.resolve(undefined) returns undefined, and the send falls back
// to the server's own address rather than borrowing another team's mailbox.
const MAILBOX_FOR = { ask: "ask", wellbeing: "wellbeing" };
// What became of it. Codes rather than prose, because this is the one part of the
// closure the referrer is shown, and free text would carry the reason with it.
const OUTCOMES = [
  "supported",          // the department worked with the student
  "referred_on",        // passed to somebody else, inside or outside the college
  "no_response",        // the student did not engage
  "not_appropriate",    // wrong department, or nothing for them to do
  "other",
];

// A referral in the audit trail: WHO it concerns and WHERE it went, never why.
//
// The audit log is read on Settings and Access by administrators who were never
// granted this page — the same reason routes/interactions.js keeps the substance of a
// pastoral note out of its own audit summary, and the same reason the mitigating
// circumstances summary names the decision and not the category.
const label = (r, dept) =>
  "Referral to " + (dept?.name || r.department) +
  (r.student ? " for " + r.student.firstName + " " + r.student.lastName + " (" + r.student.studentRef + ")" : "");

/* -------------------------------------------------------------------------- */
/* Queues                                                                     */
/* -------------------------------------------------------------------------- */

// GET /api/referrals?department=wellbeing&status=open
//
// Refused unless the caller is on that department. A 403 rather than an empty list,
// deliberately: an empty queue and a queue you may not read are different answers, and
// returning [] for the second teaches staff that the wellbeing desk has no work.
router.get("/", async (req, res) => {
  const key = str(req.query?.department).toLowerCase();
  if (!key) return res.status(400).json({ error: "Name a department." });
  if (!departments.canReadDepartment(req.user, key)) {
    return res.status(403).json({ error: "You are not a member of that department." });
  }
  const status = str(req.query?.status);
  const where = { department: key, ...(["open", "accepted", "closed"].includes(status) ? { status } : {}) };
  const rows = await prisma.referral.findMany({
    where, include: { student: true },
    // Urgent first, then oldest first: a queue is worked from the top, and the thing
    // that has been waiting longest is the thing most likely to have gone cold.
    orderBy: [{ urgency: "desc" }, { raisedOn: "asc" }],
  });
  res.json(rows.map(sReferralForDepartment));
});

// GET /api/referrals/mine — what I have sent, and what became of it.
//
// THE REFERRER'S SERIALISER, and this is the route that makes the confidentiality
// split survive contact with a real workflow. A tutor who never learns what happened
// stops referring and starts emailing, which takes the whole conversation off the
// record — so they are told the status and the outcome code, and nothing else.
router.get("/mine", async (req, res) => {
  const me = req.user?.name || null;
  // Matched on the stored name, because raisedBy is a plain string for the same reason
  // loggedBy is on Interaction: the record must still attribute the referral after the
  // person has left. A staff id would be a relation, and a relation would be SetNull.
  const rows = me
    ? await prisma.referral.findMany({ where: { raisedBy: me }, include: { student: true }, orderBy: { raisedOn: "desc" } })
    : [];
  res.json(rows.map(sReferralForReferrer));
});

/* -------------------------------------------------------------------------- */
/* Raising one                                                                */
/* -------------------------------------------------------------------------- */

router.post("/", async (req, res) => {
  const b = req.body || {};

  const studentId = str(b.studentId);
  if (!studentId) return res.status(400).json({ error: "Student is required" });
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) return res.status(404).json({ error: "Unknown student" });

  // Only an ACTIVE department may receive something new. A retired one still resolves
  // for reading, so its old queue renders under its name rather than its slug — but
  // sending new work to a desk the college has closed is how a referral is never seen.
  const key = str(b.department).toLowerCase();
  const dept = (await departments.active()).find((d) => d.key === key);
  if (!dept) return res.status(400).json({ error: "Choose a department that is currently taking referrals." });

  const urgency = URGENCIES.includes(str(b.urgency)) ? str(b.urgency) : "routine";
  const reason = str(b.reason).slice(0, 5000);
  if (!reason) return res.status(400).json({ error: "Say why you are referring this student." });

  // The PAT meeting behind it, when there is one. Optional: a referral raised from the
  // student record or logged by the department itself has no meeting.
  let interactionId = str(b.interactionId) || null;
  if (interactionId) {
    const it = await prisma.interaction.findUnique({ where: { id: interactionId } });
    if (!it) return res.status(400).json({ error: "That meeting does not exist." });
    if (it.studentId !== studentId) {
      return res.status(400).json({ error: "That meeting belongs to a different student." });
    }
  }

  // DEFAULTS OFF, and the client cannot change that by omitting the field. A tutor
  // referring somebody to ASK about an extension ticks it; a tutor raising a
  // safeguarding concern does not, and does not have to remember to suppress anything.
  const notifyStudent = b.notifyStudent === true;

  const raisedOn = localDate();
  if (!isRealDate(raisedOn)) return res.status(500).json({ error: "Clock misconfigured" });

  const row = await prisma.referral.create({
    data: {
      studentId, department: key, reason, urgency,
      raisedBy: req.user?.name || null, raisedOn,
      studentNotified: notifyStudent, interactionId,
    },
    include: { student: true },
  });

  audit.record(req, {
    action: "referral.raised", entity: "Referral", entityId: row.id,
    summary: label(row, dept) + " raised by " + (row.raisedBy || "a member of staff"),
    after: { department: row.department, urgency: row.urgency, raisedBy: row.raisedBy, raisedOn: row.raisedOn },
  });

  res.status(201).json(sReferralForReferrer(row));

  // --- Everything below runs AFTER the response and is never awaited -------------

  // Tell the department, in the app rather than by email.
  //
  // A queue nobody is told about is a queue nobody works. But a shared mailbox widens
  // the confidentiality surface for nothing, so this names no student and carries no
  // reason — it says work has arrived, and the queue itself says what.
  (async () => {
    // Staff has no "active" column — it has pendingActivation, for an account an
    // administrator created and the person has not yet claimed. Filtering on a column
    // that does not exist made Prisma throw inside the catch below, so this failed
    // silently and the department was never told anything at all. Someone who has not
    // set a password cannot read the queue, so there is nothing to tell them about.
    const members = await prisma.staff.findMany({ where: { pendingActivation: false } });
    const recipients = members.filter((s) => departments.canReadDepartment(s, key));
    if (!recipients.length) return;
    await prisma.notification.createMany({
      data: recipients.map((s) => ({
        staffId: s.id,
        type: urgency === "urgent" ? "error" : "info",
        message: (urgency === "urgent" ? "Urgent referral" : "New referral") + " waiting for " + dept.name,
        // The FRAGMENT of the queue itself, not the bare word. There is no page keyed
        // "referrals" — the parent is a group and the real screens are
        // referrals-<deptkey> — so the bare word routed nowhere and the tap fell back
        // to home. A notification that does not open the thing it is about is most of
        // the way to no notification.
        link: "referrals-" + key,
      })),
    });
  })().catch(() => {});

  // Tell the student, only if asked.
  if (notifyStudent && row.student?.email) {
    (async () => {
      const brand = await branding.get();
      const first = str(row.student.firstName) || "there";
      const subject = "You have been referred to " + dept.name;
      const text = [
        "Hello " + first + ",",
        "",
        "Your tutor has referred you to " + dept.name + " at " + (brand.displayName || "your college") + ".",
        "Somebody from the team will be in touch.",
        "",
        "You do not need to do anything right now.",
      ].join("\n");
      // From the department's own mailbox where the college has configured one, so a
      // reply reaches the team rather than the server. mailFrom returns undefined when
      // nothing is set, and email.js then sends as the server's own address.
      // Only two departments have a mailbox category, because mailFrom's categories
      // are fixed in code while the department list is configuration the college edits
      // at runtime. An unmapped department resolves to undefined and email.js sends as
      // the server's own address, which is honest. Mapping everything else onto
      // wellbeing would send a Careers desk's mail from the wellbeing mailbox, so a
      // reply about a careers appointment would land with the safeguarding team.
      const from = await mailFrom.resolve(MAILBOX_FOR[key]);
      const to = row.student.firstName
        ? row.student.firstName + " " + row.student.lastName + " <" + row.student.email + ">"
        : row.student.email;
      await email.sendEmail(to, subject, text, { from });
    })().catch(() => {});
  }
});

/* -------------------------------------------------------------------------- */
/* Working one                                                                */
/* -------------------------------------------------------------------------- */

// Load a referral and refuse anyone not on its department. Shared by every mutation
// below, so the membership check cannot be forgotten on a handler added later.
async function loadForDepartment(req, res) {
  const row = await prisma.referral.findUnique({ where: { id: req.params.id }, include: { student: true } });
  if (!row) { res.status(404).json({ error: "Referral not found" }); return null; }
  if (!departments.canReadDepartment(req.user, row.department)) {
    // 403 and no detail: confirming that this id names a real referral would tell an
    // ASK caseworker that a wellbeing referral exists for somebody.
    res.status(403).json({ error: "You are not a member of that department." });
    return null;
  }
  return row;
}

// PUT /api/referrals/:id/accept — somebody has picked it up.
router.put("/:id/accept", async (req, res) => {
  const row = await loadForDepartment(req, res);
  if (!row) return;
  // Not twice. The second acceptance would overwrite who picked it up and when, which
  // is the one thing this transition exists to record.
  if (row.status !== "open") {
    return res.status(409).json({ error: "That referral has already been picked up." });
  }
  const updated = await prisma.referral.update({
    where: { id: row.id },
    data: { status: "accepted", acceptedBy: req.user?.name || null, acceptedOn: localDate() },
    include: { student: true },
  });
  audit.record(req, {
    action: "referral.accepted", entity: "Referral", entityId: row.id,
    summary: label(row, await departments.byKey(row.department)) + " picked up by " + (updated.acceptedBy || "a member of staff"),
  });
  res.json(sReferralForDepartment(updated));
});

// PUT /api/referrals/:id/notes — the receiving team's own record.
router.put("/:id/notes", async (req, res) => {
  const row = await loadForDepartment(req, res);
  if (!row) return;
  const notes = str(req.body?.notes).slice(0, 20000);
  const updated = await prisma.referral.update({
    where: { id: row.id }, data: { notes }, include: { student: true },
  });
  // The audit entry says the notes CHANGED and never what they say — this is the field
  // the whole confidentiality split is built around, and the audit trail is read by
  // administrators who do not hold this page.
  audit.record(req, {
    action: "referral.noted", entity: "Referral", entityId: row.id,
    summary: "Case notes updated on " + label(row, await departments.byKey(row.department)) +
      " by " + (req.user?.name || "a member of staff"),
  });
  res.json(sReferralForDepartment(updated));
});

// PUT /api/referrals/:id/close — and say what became of it.
router.put("/:id/close", async (req, res) => {
  const row = await loadForDepartment(req, res);
  if (!row) return;
  if (row.status === "closed") {
    return res.status(409).json({ error: "That referral is already closed." });
  }
  // An outcome is REQUIRED to close. Null on this column means "not closed yet", and
  // allowing a closure with no outcome would collapse those two states into one — at
  // which point the referrer's view can no longer distinguish a case still being
  // worked from one finished and never recorded.
  const outcome = str(req.body?.outcome);
  if (!OUTCOMES.includes(outcome)) {
    return res.status(400).json({ error: "Choose what became of this referral." });
  }
  const updated = await prisma.referral.update({
    where: { id: row.id },
    data: {
      status: "closed", outcome,
      outcomeDetail: str(req.body?.outcomeDetail).slice(0, 5000),
      closedBy: req.user?.name || null, closedOn: localDate(),
    },
    include: { student: true },
  });
  audit.record(req, {
    action: "referral.closed", entity: "Referral", entityId: row.id,
    // The CODE is in the summary and the detail is not: the code is what the referrer
    // is shown anyway, and the prose is the part that carries the reason.
    summary: label(row, await departments.byKey(row.department)) + " closed as " + outcome +
      " by " + (updated.closedBy || "a member of staff"),
  });
  res.json(sReferralForDepartment(updated));
});

module.exports = router;
module.exports.OUTCOMES = OUTCOMES;
module.exports.URGENCIES = URGENCIES;
