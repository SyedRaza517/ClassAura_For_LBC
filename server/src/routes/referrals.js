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
const { sReferralForDepartment, sReferralForReferrer, sReferralTransfer, sReferralMessage } = require("../serializers");
const { requireAuth, requirePage, requireAnyPage } = require("../auth");
const { isRealDate } = require("../validate");
const { localDate } = require("../clock");
const departments = require("../supportDepartments");
const audit = require("../audit");
const email = require("../email");
const mailFrom = require("../mailFrom");
const branding = require("../branding");
// Required as a namespace, not destructured, because POST / below (line ~212) already
// declares a LOCAL `const notifyStudent` — the "tell the student" tickbox on a raised
// referral — and that name is 30-odd lines away from the destructuring site, exactly
// the distance at which a shadowed import stops being obvious. `notify.notifyStudent`
// at each call site below can never collide with it.
const notify = require("../notify");

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

// Tell a department that work has arrived, in the app rather than by email.
//
// A queue nobody is told about is a queue nobody works. But a shared mailbox widens the
// confidentiality surface for nothing, so this names NO STUDENT and carries no reason —
// it says work has arrived, and the queue itself says what.
//
// Hoisted out of the raise handler when transfers arrived, because a case handed to
// Wellbeing at four in the afternoon has to reach them exactly as a new one does: the
// second copy of this block is where the two notifications drift apart, and the one
// that gets forgotten is always the transfer.
async function notifyDepartment(key, deptName, { urgent = false, verb = "New referral" } = {}) {
  // Staff has no "active" column — it has pendingActivation, for an account an
  // administrator created and the person has not yet claimed. Filtering on a column
  // that does not exist made Prisma throw inside the caller's catch, so this failed
  // silently and the department was never told anything at all. Someone who has not set
  // a password cannot read the queue, so there is nothing to tell them about.
  const members = await prisma.staff.findMany({ where: { pendingActivation: false } });
  const recipients = members.filter((s) => departments.canReadDepartment(s, key));
  if (!recipients.length) return;
  await prisma.notification.createMany({
    data: recipients.map((s) => ({
      staffId: s.id,
      type: urgent ? "error" : "info",
      message: (urgent ? "Urgent — " : "") + verb + " waiting for " + deptName,
      // The FRAGMENT of the queue itself, not the bare word. There is no page keyed
      // "referrals" — the parent is a group and the real screens are
      // referrals-<deptkey> — so the bare word routed nowhere and the tap fell back to
      // home. A notification that does not open the thing it is about is most of the
      // way to no notification.
      link: "referrals-" + key,
    })),
  });
}

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

  notifyDepartment(key, dept.name, { urgent: urgency === "urgent" }).catch(() => {});

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

  // GET /api/student/me/referrals (routes/student.js) shows `status` on every row
  // with studentNotified true — regardless of selfReferred, unlike the message
  // thread above, because sReferralForStudent's `status`/`outcome` fields carry no
  // case content, only WHERE the referral got to. Gated on the same flag that route's
  // WHERE clause reads, so a referral the student was never told about (studentNotified
  // false — the tickbox's default) can never surface a status ping either.
  if (updated.studentNotified) {
    notify.notifyStudent(updated.studentId, {
      type: "info",
      message: `${(await departments.byKey(updated.department))?.name || updated.department} has picked up your referral`,
      link: "support",
    });
  }
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

  // sReferralForStudent ships `status` and `outcome` (the CODE, same as the audit
  // summary above — never `outcomeDetail`, which is the prose the code exists to keep
  // out of both places). "Closed" is the one status change a student who asked for
  // help is actively waiting on, so this fires even though nobody tapped a "reply"
  // button — the WHY comment on the accept handler above about the studentNotified
  // gate applies identically here.
  if (updated.studentNotified) {
    notify.notifyStudent(updated.studentId, {
      type: "info",
      message: `Your referral to ${(await departments.byKey(updated.department))?.name || updated.department} has been closed`,
      link: "support",
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Handing it on                                                              */
/* -------------------------------------------------------------------------- */

// Load a referral for somebody who is a PARTY to it — a wider set than
// loadForDepartment allows, and deliberately so.
//
// A wellbeing officer who transferred a case to ASK last week is no longer on its
// current department, so loadForDepartment would 403 them out of the record of their
// own hand-off. The referrer is in the same position and always was. So: the current
// department, the referrer, or any department this case has previously sat with.
//
// The flags come back with the row rather than being recomputed by each caller,
// because "may you read this" and "how much of it" are two different questions and the
// second is answered differently by every handler below.
async function loadForParticipant(req, res) {
  const row = await prisma.referral.findUnique({
    where: { id: req.params.id },
    include: { student: true, transfers: { orderBy: { createdAt: "asc" } } },
  });
  if (!row) { res.status(404).json({ error: "Referral not found" }); return null; }

  const me = req.user?.name || null;
  const isReferrer = !!me && row.raisedBy === me;
  const onCurrent = departments.canReadDepartment(req.user, row.department);
  const onPrevious = row.transfers.some((t) => departments.canReadDepartment(req.user, t.fromDepartment));

  if (!isReferrer && !onCurrent && !onPrevious) {
    // 403 and no detail, exactly as loadForDepartment: confirming that this id names a
    // real referral would tell an ASK caseworker that a wellbeing referral exists for
    // somebody.
    res.status(403).json({ error: "You are not a party to that referral." });
    return null;
  }
  return { row, isReferrer, onCurrent, onPrevious };
}

// PUT /api/referrals/:id/transfer — the wrong desk, or the right one for a while.
//
// THE CASE NOTES DO NOT TRAVEL, AND THAT IS THE WHOLE DESIGN.
//
// Transferring is not re-addressing an envelope. A student disclosed something to
// Wellbeing; handing the case to Careers must not hand over the disclosure with it —
// and Referral.notes is read by whoever is on the CURRENT department, so leaving it in
// place would do exactly that. The notes are archived onto the transfer row under the
// department that wrote them, and the live field is cleared. Deleting them instead was
// rejected: an officer who mis-clicked would have destroyed their own record, and the
// college could no longer answer what its wellbeing team knew and when.
//
// The status resets to "open" for the same reason. A case arriving already marked
// accepted, stamped with a name from another team, is a case the receiving desk has no
// reason to pick up — which is the failure a queue exists to prevent.
router.put("/:id/transfer", async (req, res) => {
  const row = await loadForDepartment(req, res);
  if (!row) return;

  // A closed case is a finished one. Reopening it by moving it would erase the outcome
  // the referrer has already been shown, so the answer is a new referral rather than a
  // resurrection of this one.
  if (row.status === "closed") {
    return res.status(409).json({ error: "That referral is closed. Raise a new one instead." });
  }

  const toKey = str(req.body?.department).toLowerCase();
  if (toKey === row.department) {
    return res.status(400).json({ error: "That referral is already with that department." });
  }
  // Only an ACTIVE department may receive it, same rule as raising one: a desk the
  // college has closed is a desk where the case is never seen again.
  const to = (await departments.active()).find((d) => d.key === toKey);
  if (!to) return res.status(400).json({ error: "Choose a department that is currently taking referrals." });

  const reason = str(req.body?.reason).slice(0, 5000);
  if (!reason) return res.status(400).json({ error: "Say why you are handing this on." });

  const on = localDate();
  if (!isRealDate(on)) return res.status(500).json({ error: "Clock misconfigured" });

  const from = await departments.byKey(row.department);

  // One transaction, because the archive and the clearing are two halves of one fact.
  // Written separately, a failure between them either loses the notes entirely or
  // leaves them readable by the department that has just been handed the case — and
  // the second is the confidentiality incident this whole route exists to avoid.
  const [, updated] = await prisma.$transaction([
    prisma.referralTransfer.create({
      data: {
        referralId: row.id,
        fromDepartment: row.department, toDepartment: toKey,
        reason, notesAtTransfer: row.notes,
        transferredBy: req.user?.name || null, transferredOn: on,
      },
    }),
    prisma.referral.update({
      where: { id: row.id },
      data: {
        department: toKey,
        notes: "",
        status: "open", acceptedBy: null, acceptedOn: null,
      },
      include: { student: true },
    }),
  ]);

  audit.record(req, {
    action: "referral.transferred", entity: "Referral", entityId: row.id,
    // WHERE it went and who moved it, never why: the transfer reason is prose written
    // about a student, and the audit log is read on Settings by administrators who were
    // never granted this page.
    summary: label(row, from) + " handed to " + to.name + " by " + (req.user?.name || "a member of staff"),
    before: { department: row.department, status: row.status },
    after: { department: toKey, status: "open" },
  });

  res.json(sReferralForDepartment(updated));

  // The receiving desk is told exactly as it would be for a new referral. Urgency
  // carries across because it is a property of the student's situation, not of which
  // team happens to be holding the case.
  notifyDepartment(toKey, to.name, { urgent: updated.urgency === "urgent", verb: "Transferred referral" }).catch(() => {});

  // A transfer changes both `department` and `status` on the row sReferralForStudent
  // serialises (department back to "open" — see `data` above), and departmentName is
  // one of the eight fields that serialiser ships, so a student watching their own
  // referral would otherwise see it silently reappear under a new team's name with no
  // notification pointing at why. The receiving team's name only — never `to` vs
  // `from`, which would tell the student which desk is done with them, a fact this
  // router keeps for staff (label() above) precisely because it names the confidential
  // routing, not the outcome.
  if (updated.studentNotified) {
    notify.notifyStudent(updated.studentId, {
      type: "info",
      message: `Your referral has moved to ${to.name}`,
      link: "support",
    });
  }
});

// GET /api/referrals/:id/history — where this case has been.
//
// The archived case notes are added back ONE ENTRY AT A TIME, for a caller who is on
// that entry's fromDepartment. sReferralTransfer never names the field, so this is an
// allowlist widened on purpose rather than a payload trimmed afterwards — the
// sAdmission lesson, where a blocklist meant every column added later shipped by
// default.
//
// Department NAMES are resolved here rather than in the serialiser because the list is
// configuration and the serialiser is pure. A retired department still resolves, which
// is why the trail renders as names after the college has closed a desk.
router.get("/:id/history", async (req, res) => {
  const loaded = await loadForParticipant(req, res);
  if (!loaded) return;
  const { row } = loaded;
  const all = await departments.all();
  const nameOf = (k) => all.find((d) => d.key === k)?.name || k;
  res.json(row.transfers.map((t) => ({
    ...sReferralTransfer(t),
    fromName: nameOf(t.fromDepartment),
    toName: nameOf(t.toDepartment),
    ...(departments.canReadDepartment(req.user, t.fromDepartment) ? { notesAtTransfer: t.notesAtTransfer } : {}),
  })));
});

/* -------------------------------------------------------------------------- */
/* The conversation                                                           */
/* -------------------------------------------------------------------------- */

// GET /api/referrals/:id/messages
//
// WHICH MESSAGES YOU SEE IS SCOPED BY DEPARTMENT, NOT BY REFERRAL.
//
// The referrer reads every message, because every message was written to or by them.
// A member of staff reads the messages written under a department they are on — so
// after a transfer the receiving team reads its own thread and not the previous team's,
// which is the same line the transfer draws through the case notes. Reading it any
// other way would hand Careers a conversation Wellbeing had about a disclosure.
router.get("/:id/messages", async (req, res) => {
  const loaded = await loadForParticipant(req, res);
  if (!loaded) return;
  const { row, isReferrer } = loaded;
  const rows = await prisma.referralMessage.findMany({
    where: { referralId: row.id }, orderBy: { createdAt: "asc" },
  });
  const visible = rows.filter((m) => isReferrer || departments.canReadDepartment(req.user, m.department));
  res.json(visible.map(sReferralMessage));
});

// POST /api/referrals/:id/messages — ask the tutor something, or answer them.
//
// The gap this fills: `reason` is the referrer talking once, `notes` is the department
// talking to itself. "Which unit is this about?" had nowhere to go, so it went into the
// case notes where the person who asked could not read the answer, or out of the system
// into email, which is worse.
//
// WRITING IS NARROWER THAN READING, deliberately. The referrer and the CURRENT
// department may post; a department that has handed the case on may not. They keep
// their own thread to read and they no longer hold the case, and a case being answered
// by two teams at once is how a student gets two different answers.
router.post("/:id/messages", async (req, res) => {
  const loaded = await loadForParticipant(req, res);
  if (!loaded) return;
  const { row, isReferrer, onCurrent } = loaded;
  if (!isReferrer && !onCurrent) {
    return res.status(403).json({ error: "Only the referrer and the department holding this referral can reply." });
  }

  const body = str(req.body?.body).slice(0, 5000);
  if (!body) return res.status(400).json({ error: "Write a message." });

  // The department is stamped from the referral's CURRENT department rather than from
  // the author's membership: the referrer is on no department at all, and their message
  // still belongs to the thread the department holding the case reads.
  //
  // Somebody who is on the current department AND raised the referral counts as the
  // department, not the referrer — the check is ordered rather than ambiguous, because
  // the screen labels the two differently and a role that depended on which branch was
  // written first would flip when this function was next edited.
  const created = await prisma.referralMessage.create({
    data: {
      referralId: row.id,
      department: row.department,
      authorRole: onCurrent ? "department" : "referrer",
      authorName: req.user?.name || null,
      body,
    },
  });

  audit.record(req, {
    action: "referral.messaged", entity: "Referral", entityId: row.id,
    // THAT a message was sent, never what it said. Same rule as the case notes above:
    // this is prose about a student, and the audit log is read by administrators who do
    // not hold this page.
    summary: "Message added to " + label(row, await departments.byKey(row.department)) +
      " by " + (req.user?.name || "a member of staff"),
  });

  res.status(201).json(sReferralMessage(created));

  // A REFERRER's message needs a notification to the DEPARTMENT: the department is
  // looking at its queue, while the tutor is not — they raised this weeks ago and
  // moved on. A department's reply reaches the tutor through Sent by me, which is
  // where they go to find out what happened anyway.
  if (isReferrer) {
    (async () => {
      const dept = await departments.byKey(row.department);
      await notifyDepartment(row.department, dept?.name || row.department, { verb: "Referral reply" });
    })().catch(() => {});
  } else if (onCurrent && row.selfReferred && row.studentNotified) {
    // A DEPARTMENT's reply needs a notification to the STUDENT — but only when the
    // student can actually open it. GET /api/student/me/referrals/:id/messages
    // (routes/student.js) hands back exactly the rows this insert just added — same
    // referralId, same department — but filtered on `selfReferred: true`, because a
    // TUTOR-raised referral's thread is a conversation between the tutor and the
    // department that the student was never party to (that file's own comment: "two
    // people who did not know the student would read it"), even when studentNotified
    // is true and the referral's STATUS is shown to them. So this checks selfReferred
    // here too, not just studentNotified — a message the student cannot open would
    // be a notification pointing at nothing.
    //
    // A tutor's own reply (the `isReferrer` branch above) can never reach here: a
    // self-referred row has `raisedBy: null` (see routes/student.js POST
    // /me/referrals), which cannot equal any signed-in staff member's name, so
    // `isReferrer` is always false on a self-referred case and this is the only
    // branch a department's reply to one can take.
    (async () => {
      const dept = await departments.byKey(row.department);
      notify.notifyStudent(row.studentId, {
        type: "info",
        message: `${dept?.name || row.department} replied to your request`,
        link: "support",
      });
    })().catch(() => {});
  }
});

module.exports = router;
module.exports.OUTCOMES = OUTCOMES;
module.exports.URGENCIES = URGENCIES;
