// Staff timesheets.
//
// Each row is one class/work session: a date, start & end time, whether it was on
// campus or online, and a title. Staff add entries as "draft"; "Send timesheet"
// flips a whole month's entries to "submitted" and notifies admins, who can review
// them on the dashboard. Times and dates are plain strings (local London values),
// matching the rest of the app; minutes is derived once and stored so daily and
// monthly totals aggregate in the database.
const router = require("express").Router();
const prisma = require("../db");
const { sTimesheet } = require("../serializers");
const { requireAuth, requirePage, hasPage } = require("../auth");
const { notifyAdmins, notifyStaff } = require("../notify");
const { localDate } = require("../clock");
const audit = require("../audit");

const VALID_MODES = ["campus", "online"];
const isTime = (v) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  (() => { const d = new Date(v + "T00:00:00Z"); return !isNaN(d) && d.toISOString().slice(0, 10) === v; })();
const isMonth = (v) => typeof v === "string" && /^\d{4}-\d{2}$/.test(v);

// Minutes between two HH:MM on the same day. Returns null if end is not after start.
const minutesBetween = (start, end) => {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const mins = (eh * 60 + em) - (sh * 60 + sm);
  return mins > 0 ? mins : null;
};

// Validate + normalise a create/update body. Returns { data } or { error }.
function parseBody(body) {
  const { date, start, end, mode, title, unitId, note } = body || {};
  if (!isDate(date)) return { error: "date must be a valid YYYY-MM-DD" };
  if (!isTime(start)) return { error: "start must be a time in HH:MM format" };
  if (!isTime(end)) return { error: "end must be a time in HH:MM format" };
  const minutes = minutesBetween(start, end);
  if (minutes == null) return { error: "end time must be after start time" };
  if (minutes > 24 * 60) return { error: "a single entry cannot exceed 24 hours" };
  if (!VALID_MODES.includes(mode)) return { error: "mode must be 'campus' or 'online'" };
  if (typeof title !== "string" || !title.trim()) return { error: "title is required" };
  if (title.length > 200) return { error: "title is too long (200 characters maximum)" };
  if (unitId != null && typeof unitId !== "string") return { error: "unitId must be a string" };
  if (note != null && typeof note !== "string") return { error: "note must be text" };
  if (typeof note === "string" && note.length > 1000) return { error: "note is too long (1000 characters maximum)" };
  return {
    data: {
      date, startTime: start, endTime: end, minutes, mode,
      title: title.trim(), unitId: unitId || null, note: (note || "").trim(),
    },
  };
}

// GET /api/timesheets?month=YYYY-MM&staffId=...
// Staff see only their own. Admins may pass staffId to view one person, or omit it
// to see every submitted entry (for the review screen).
router.get("/", requireAuth, async (req, res) => {
  // "See everyone" requires the timesheets page itself — being an ADMIN for some
  // OTHER section must not expose colleagues' timesheets (or their private drafts).
  const isAdmin = hasPage(req.user, "timesheets");
  const where = {};
  if (req.query.month) {
    if (!isMonth(req.query.month)) return res.status(400).json({ error: "month must be YYYY-MM" });
    where.date = { startsWith: String(req.query.month) };
  }
  // "See everyone" is now OPT-IN, not the default for an admin.
  //
  // The admin branch used to fire whenever no staffId was given — including for the
  // STAFF APP's own "My Timesheet" screen, which sends only a month. So a finance
  // admin's personal timesheet showed the whole college's hours; their own drafts
  // vanished (admins never see drafts) so they could never send their own month; and
  // colleagues' bounced-back entries rendered with Edit and Delete beside them.
  const wantsEveryone = isAdmin && (req.query.staffId || req.query.scope === "all");
  if (wantsEveryone) {
    if (req.query.staffId) where.staffId = String(req.query.staffId);
    // The finance review screen shows everything that has left "draft" — pending
    // (submitted), approved, and bounced-back (changes_requested) — so both the
    // approval queue and the history are visible. It NEVER shows private drafts,
    // whether or not a staffId is given.
    where.status = { in: ["submitted", "approved", "changes_requested"] };
  } else {
    where.staffId = req.user.id; // everyone, admin included, defaults to their own
  }
  const isAdminView = wantsEveryone;
  const rows = await prisma.timesheetEntry.findMany({
    where,
    orderBy: [{ date: "desc" }, { startTime: "asc" }],
    ...(isAdminView ? { include: { staff: { select: { name: true, dept: true, initials: true, colour: true } } } } : {}),
  });
  res.json(rows.map(sTimesheet));
});

// GET /api/timesheets/pending-count — how many staff have a timesheet awaiting review
// (any "submitted" entries). Powers the amber badge on the admin Timesheets tab.
router.get("/pending-count", requireAuth, requirePage("timesheets"), async (req, res) => {
  const groups = await prisma.timesheetEntry.groupBy({ by: ["staffId"], where: { status: "submitted" } });
  res.json({ count: groups.length });
});

// POST /api/timesheets — staff adds an entry for themselves (admin may pass staffId)
router.post("/", requireAuth, async (req, res) => {
  const parsed = parseBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  // Creating an entry for someone else is a timesheets-page power.
  const staffId = hasPage(req.user, "timesheets") && req.body.staffId ? String(req.body.staffId) : req.user.id;
  const exists = await prisma.staff.findUnique({ where: { id: staffId } });
  if (!exists) return res.status(400).json({ error: "Unknown staff member" });
  const rec = await prisma.timesheetEntry.create({ data: { ...parsed.data, staffId, status: "draft", createdAt: new Date() } });
  res.status(201).json(sTimesheet(rec));
});

// PUT /api/timesheets/:id — edit an entry (owner only, and only while still a draft)
router.put("/:id", requireAuth, async (req, res) => {
  const existing = await prisma.timesheetEntry.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Entry not found" });
  // Only a timesheets admin may touch someone else's entry or a locked one.
  const isAdmin = hasPage(req.user, "timesheets");
  const isOwn = existing.staffId === req.user.id;
  if (!isOwn && !isAdmin) return res.status(403).json({ error: "Forbidden" });
  // Unlocking a sent or approved entry is a REVIEWER's power, so it stops at the
  // reviewer's own hours — exactly like POST /review below.
  //
  // The lock used to lift for any timesheets admin, their own entries included. That
  // handed back everything the self-review rule takes away: log 8 hours, send the
  // month, have a colleague approve it, then edit the approved rows to say 18. The
  // entries still carry the colleague's name in reviewedBy and the month still reads
  // "approved", so nothing downstream — payroll included — shows the numbers changed
  // after sign-off. The audit row written at review time records what was approved,
  // not what is now stored.
  const canUnlock = isAdmin && !isOwn;
  // Editable only while the owner still holds it: a fresh draft, or a month bounced
  // back with "changes_requested". Once submitted or approved it is locked.
  if (!canUnlock && !["draft", "changes_requested"].includes(existing.status)) return res.status(409).json({ error: "This timesheet has been sent and can't be edited until it's reviewed" });
  const parsed = parseBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const rec = await prisma.timesheetEntry.update({ where: { id: existing.id }, data: parsed.data });
  res.json(sTimesheet(rec));
});

// DELETE /api/timesheets/:id — remove an entry (owner only, draft only)
router.delete("/:id", requireAuth, async (req, res) => {
  const existing = await prisma.timesheetEntry.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Entry not found" });
  const isAdmin = hasPage(req.user, "timesheets");
  const isOwn = existing.staffId === req.user.id;
  if (!isOwn && !isAdmin) return res.status(403).json({ error: "Forbidden" });
  // Same rule as PUT above, and the more dangerous half of it: deleting your own
  // approved entry leaves no row to compare against the sign-off at all.
  const canUnlock = isAdmin && !isOwn;
  if (!canUnlock && !["draft", "changes_requested"].includes(existing.status)) return res.status(409).json({ error: "This timesheet has been sent and can't be changed until it's reviewed" });
  await prisma.timesheetEntry.delete({ where: { id: existing.id } });
  res.json({ ok: true });
});

// POST /api/timesheets/submit  { month: "YYYY-MM" }
// Sends a whole month: every draft entry that month becomes "submitted" and admins
// are notified. Returns the count sent + the month's total minutes.
router.post("/submit", requireAuth, async (req, res) => {
  const { month } = req.body || {};
  if (!isMonth(month)) return res.status(400).json({ error: "month must be YYYY-MM" });
  // Send everything the staff member still holds: fresh drafts AND any month that was
  // bounced back for changes. Clearing the review fields resets it for a fresh look.
  const where = { staffId: req.user.id, date: { startsWith: month }, status: { in: ["draft", "changes_requested"] } };
  const drafts = await prisma.timesheetEntry.findMany({ where });
  if (drafts.length === 0) return res.status(400).json({ error: "There are no timesheet entries to send for that month" });
  await prisma.timesheetEntry.updateMany({ where, data: { status: "submitted", submittedAt: localDate(), reviewNote: null, reviewedBy: null, reviewedAt: null } });
  const totalMinutes = drafts.reduce((s, d) => s + d.minutes, 0);
  const hours = Math.round((totalMinutes / 60) * 10) / 10;
  notifyAdmins({ type: "info", message: `${req.user.name} sent their timesheet for ${month} — ${drafts.length} sessions, ${hours}h — awaiting approval`, link: "timesheets" });
  res.json({ ok: true, month, sent: drafts.length, totalMinutes, hours });
});

// POST /api/timesheets/review  { staffId, month, decision: "approved"|"changes_requested", note }
// Finance/admin decision on a staff member's monthly timesheet. Approving locks the
// month as approved; requesting changes bounces every entry back to the staff member
// with a required comment so they can fix and re-send. Acts only on entries that are
// currently "submitted" (awaiting review).
router.post("/review", requireAuth, requirePage("timesheets"), async (req, res) => {
  const { staffId, month, decision, note } = req.body || {};
  if (!staffId || typeof staffId !== "string") return res.status(400).json({ error: "staffId is required" });
  if (!isMonth(month)) return res.status(400).json({ error: "month must be YYYY-MM" });
  if (!["approved", "changes_requested"].includes(decision)) return res.status(400).json({ error: "decision must be 'approved' or 'changes_requested'" });
  if (note != null && typeof note !== "string") return res.status(400).json({ error: "note must be text" });
  if (note && note.length > 2000) return res.status(400).json({ error: "note is too long (2000 characters maximum)" });
  if (decision === "changes_requested" && !(note && note.trim())) return res.status(400).json({ error: "Add a comment explaining what needs changing" });

  // Nobody signs off their own hours. The screen groups by staff member and rendered
  // an Approve button on every group including the reviewer's own, so a finance admin
  // could log 180 hours, send them, and approve them — stamped reviewedBy themselves,
  // with no second pair of eyes anywhere in the flow.
  if (staffId === req.user.id) {
    return res.status(403).json({ error: "Your own timesheet has to be reviewed by someone else." });
  }

  const staff = await prisma.staff.findUnique({ where: { id: staffId } });
  if (!staff) return res.status(404).json({ error: "Unknown staff member" });

  const where = { staffId, date: { startsWith: month }, status: "submitted" };
  const pending = await prisma.timesheetEntry.count({ where });
  if (pending === 0) return res.status(400).json({ error: "There is no submitted timesheet awaiting review for that month" });

  const newStatus = decision === "approved" ? "approved" : "changes_requested";
  await prisma.timesheetEntry.updateMany({ where, data: { status: newStatus, reviewNote: note ? note.trim() : null, reviewedBy: req.user.name, reviewedAt: localDate() } });

  const monthName = new Date(month + "-01T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  notifyStaff(staffId, decision === "approved"
    ? { type: "success", message: `Your ${monthName} timesheet was approved.`, link: "timesheet" }
    : { type: "error", message: `Your ${monthName} timesheet needs changes: "${note.trim()}"`, link: "timesheet" });

  // Signing off someone's hours is a payroll decision. It is stamped reviewedBy on
  // the entries themselves, but those get re-submitted and overwritten; this row does
  // not, which is what makes it the record that a later payroll query can rely on.
  audit.record(req, {
    action: "timesheet.reviewed", entity: "TimesheetEntry", entityId: `${staffId}:${month}`,
    summary: `${monthName} timesheet for ${staff.name} ${decision === "approved" ? "approved" : "sent back for changes"} by ${req.user.name} — ${pending} entr${pending === 1 ? "y" : "ies"}` + (note ? ` — "${note.trim()}"` : ""),
    before: { status: "submitted", entries: pending },
    after: { staffId, staffName: staff.name, month, status: newStatus, entries: pending, note: note ? note.trim() : null },
  });

  res.json({ ok: true, staffId, month, decision, reviewed: pending });
});

module.exports = router;
