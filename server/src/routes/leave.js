const router = require("express").Router();
const prisma = require("../db");
const { sLeave } = require("../serializers");
const { requireAuth, requireAnyPage, hasPage } = require("../auth");
const { notifyStaff, notifyAdmins } = require("../notify");
const audit = require("../audit");
const { localDate } = require("../clock");
const { chargeableDays, bankHolidayCount, yearsSpanned, spanDays } = require("../bankHolidays");

// The longest single booking anyone can make. A year and a bit covers sabbaticals and
// long-term sick; beyond that it is a data-entry error or an attack (see the guard in
// POST / below). Deliberately smaller than bankHolidays.MAX_SPAN_DAYS, so the route
// gives a readable message before the module's silent backstop can engage.
const MAX_BOOKING_DAYS = 400;

// Local (London) date, not the server's UTC date — so a request made just after
// midnight BST is filed under the correct day, not the previous one.
const today = () => localDate();
const VALID_TYPES = ["annual", "sick", "personal", "training", "unpaid"];
// Admin sections that legitimately manage OTHER people's leave: seeing everyone's
// requests, booking on someone's behalf, and backfilling a past date. Being an ADMIN
// for an unrelated page (e.g. Documents) must not grant any of that.
const LEAVE_ADMIN_PAGES = ["requests", "approvals", "calendar"];
// Pages that DISPLAY other people's leave (who's off, pending counts, KPI balances)
// but do not manage it. Reading is wider than writing on purpose.
const LEAVE_READ_PAGES = [...LEAVE_ADMIN_PAGES, "balances", "overview", "kpi"];
// Types that DON'T draw down the paid holiday allowance. Unpaid leave is time off
// the books, so approving it neither checks nor consumes the allowance. Must stay
// in sync with the client's NON_ALLOWANCE_TYPES.
const UNPAID_TYPES = ["unpaid"];

// --- Per-staff serialisation for leave decisions ---
// Approvals check the allowance and then write, which is a classic read-then-write
// race: fired concurrently, both approvals see the old total and both succeed.
// Queueing per staff member makes each decision see the previous one's result.
const staffLocks = new Map();
function withStaffLock(staffId, fn) {
  const previous = staffLocks.get(staffId) || Promise.resolve();
  // Chain onto the previous holder, ignoring how it settled.
  const run = previous.then(fn, fn);
  // A rejection must not poison the next waiter, so the queue holds a swallowed
  // copy. Drop the entry only if nothing else chained on behind us, so the map
  // cannot grow without bound.
  const guarded = run.catch(() => {});
  staffLocks.set(staffId, guarded);
  guarded.then(() => { if (staffLocks.get(staffId) === guarded) staffLocks.delete(staffId); });
  return run;
}

// Inclusive day count between two YYYY-MM-DD dates (matches the client's daysBetween).
const daysBetween = (a, b) => {
  const d1 = new Date(a + "T00:00:00Z"), d2 = new Date(b + "T00:00:00Z");
  return Math.max(1, Math.round((d2 - d1) / 86400000) + 1);
};

// GET /api/leave  — admin: all; staff: own
router.get("/", requireAuth, async (req, res) => {
  // Leave rows carry a free-text reason, so "see everyone" needs one of the leave
  // sections — not merely being an ADMIN for some unrelated page.
  const where = hasPage(req.user, LEAVE_READ_PAGES) ? {} : { staffId: req.user.id };
  const rows = await prisma.leave.findMany({ where, orderBy: { requestedAt: "desc" } });
  res.json(rows.map(sLeave));
});

// POST /api/leave  — staff create own; admin may pass staffId (on behalf)
router.post("/", requireAuth, async (req, res) => {
  const { type, start, end, reason, staffId } = req.body || {};
  if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: "Invalid leave type" });
  if (!start || !end) return res.status(400).json({ error: "Start and end dates required" });
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(start) || !dateRegex.test(end)) return res.status(400).json({ error: "Dates must be in YYYY-MM-DD format" });
  // Reject calendar-invalid dates (e.g. 2026-13-40, 2026-02-30) that pass the format check.
  const isRealDate = (s) => { const d = new Date(s + "T00:00:00Z"); return !isNaN(d) && d.toISOString().slice(0, 10) === s; };
  if (!isRealDate(start) || !isRealDate(end)) return res.status(400).json({ error: "Dates must be valid calendar dates" });
  if (start > end) return res.status(400).json({ error: "End date must not be before start date" });
  // Bound the range BEFORE any date maths touches it.
  //
  // chargeableDays walks the range a day at a time, synchronously, on Node's single
  // thread — and the approval path re-walks it once per calendar year spanned. A
  // request for "9999-12-31" passes every check above (it is a real date), produces
  // 2,016,373 days, and was measured blocking the event loop for 8.5 seconds; the row
  // then persists, and the approval that follows blocks it for hours. That is a total
  // API outage available to any signed-in member of staff, so it is refused here
  // rather than merely capped downstream.
  if (spanDays(start, end) > MAX_BOOKING_DAYS) {
    return res.status(400).json({ error: `A single booking can't be longer than ${MAX_BOOKING_DAYS} days. Split it into separate requests.` });
  }
  // Only a leave admin may backfill a past date, so they can still record a past
  // absence on someone's behalf. Ordinary staff can never book the past.
  if (!hasPage(req.user, LEAVE_ADMIN_PAGES) && start < today()) return res.status(400).json({ error: "You can't book leave for a past date." });
  if (staffId !== undefined && typeof staffId !== "string") return res.status(400).json({ error: "staffId must be a string" });
  const targetStaff = hasPage(req.user, LEAVE_ADMIN_PAGES) && staffId ? staffId : req.user.id;
  // Guard against a non-existent staffId (would otherwise throw a foreign-key error and crash the request).
  const exists = await prisma.staff.findUnique({ where: { id: targetStaff } });
  if (!exists) return res.status(400).json({ error: "Unknown staff member" });
  // A double-tap on the phone fires two identical POSTs, and both used to become
  // leave requests — two rows for one holiday, double-counted against the
  // allowance, and two approvals for the manager to work through. Treat a repeat
  // of an already-pending request as the same request and hand back the original.
  // Cost of the booking = working days only: Mon–Fri, excluding bank holidays.
  // Weekends and bank holidays inside the range are free. If NOTHING is chargeable
  // (the whole range is weekend and/or bank holiday) there is nothing to book, so we
  // block it with a clear message rather than creating an empty 0-day request.
  const chargeable = chargeableDays(start, end);
  if (chargeable === 0) {
    return res.status(400).json({ error: "Those dates are all weekends or bank holidays — there are no working days to book." });
  }
  // The duplicate check and the overlap check are both read-then-write, so they run
  // under the same per-staff lock the decision path uses. Without it two simultaneous
  // POSTs — a double-tap, or a mobile retry — both read "nothing there" and both
  // create, giving one holiday two rows and charging the allowance twice.
  try {
    const outcome = await withStaffLock(targetStaff, async () => {
      const duplicate = await prisma.leave.findFirst({
        where: { staffId: targetStaff, type, start, end, status: "pending" },
      });
      if (duplicate) return { status: 200, body: sLeave(duplicate) };

      // Overlapping bookings were each charged in full, so 10–14 Aug plus 12–18 Aug
      // took 10 days off the allowance for 7 days actually absent. Two ranges overlap
      // when each starts on or before the other ends.
      const clash = await prisma.leave.findFirst({
        where: {
          staffId: targetStaff,
          status: { in: ["pending", "approved"] },
          start: { lte: end },
          end: { gte: start },
        },
        orderBy: { start: "asc" },
      });
      if (clash) {
        return { status: 409, body: { error: `Those dates overlap leave already ${clash.status === "approved" ? "approved" : "requested"} for ${clash.start} to ${clash.end}. Cancel or amend that booking first.` } };
      }

      const rec = await prisma.leave.create({
        data: {
          staffId: targetStaff, type, start, end, days: chargeable, reason: reason || "—",
          requestedAt: today(),
          status: "pending",
        },
      });
      return { status: 201, body: sLeave(rec), created: true };
    });
    if (outcome.created) notifyAdmins({ type: "info", message: `New ${type} leave request from ${exists.name}`, link: "approvals" });
    res.status(outcome.status).json(outcome.body);
  } catch (e) {
    res.status(400).json({ error: "Could not create leave request" });
  }
});

// DELETE /api/leave/:id — cancel a booking and give the days back.
//
// Without this an approved holiday could never be undone: a trip cancelled in advance
// kept consuming the allowance for good, and the only workaround (a balance
// adjustment) then applied to every future year as well.
router.delete("/:id", requireAuth, async (req, res) => {
  // Read the row once outside the lock only to learn WHOSE queue to join — every
  // check that matters is redone inside it. Guarding on a row read beforehand let a
  // staff member cancel a booking in the instant between their read and a manager's
  // approval, defeating the "approved needs an admin" rule entirely.
  const peek = await prisma.leave.findUnique({ where: { id: req.params.id }, select: { staffId: true } });
  if (!peek) return res.status(404).json({ error: "Leave not found" });
  const isLeaveAdmin = hasPage(req.user, LEAVE_ADMIN_PAGES);

  const outcome = await withStaffLock(peek.staffId, async () => {
    const existing = await prisma.leave.findUnique({ where: { id: req.params.id } });
    if (!existing) return { status: 404, body: { error: "Leave not found" } };
    // Staff may withdraw their OWN request; only a leave admin can cancel someone
    // else's, or anything already approved.
    if (existing.staffId !== req.user.id && !isLeaveAdmin) return { status: 403, body: { error: "You can only cancel your own leave" } };
    if (existing.status === "approved" && !isLeaveAdmin) {
      return { status: 403, body: { error: "This leave is already approved — ask an administrator to cancel it." } };
    }
    // Cancelling leave already taken would rewrite history; an admin still can.
    if (existing.end < today() && !isLeaveAdmin) {
      return { status: 400, body: { error: "That leave has already been taken." } };
    }
    // A DECLINED request is part of the audit trail, not the requester's to erase.
    // Deleting it is a hard delete, so the decision, the decider, the date and the
    // manager's note all vanished — and since the overlap check only looks at pending
    // and approved rows, the same dates could then be re-submitted with no trace that
    // they had ever been refused.
    if (existing.status === "rejected" && !isLeaveAdmin) {
      return { status: 403, body: { error: "This request was declined, so it stays on your record. Ask an administrator if it needs removing." } };
    }
    try {
      await prisma.leave.delete({ where: { id: existing.id } });
    } catch (e) {
      // Already gone — a double-tap, or a retry on a flaky connection. Not an error.
      if (e?.code === "P2025") return { status: 404, body: { error: "Leave not found" } };
      throw e;
    }
    return { status: 200, body: { ok: true, days: existing.days }, cancelled: existing };
  });

  const c = outcome.cancelled;
  if (c && c.staffId !== req.user.id) {
    notifyStaff(c.staffId, {
      type: "info",
      message: `${req.user.name} cancelled your ${c.type} leave for ${c.start} to ${c.end}. Those days are back in your allowance.`,
      link: "leave",
    });
  }
  res.status(outcome.status).json(outcome.body);
});

// PUT /api/leave/:id/decision  (admin) — approve / reject with optional note
router.put("/:id/decision", requireAuth, requireAnyPage(LEAVE_ADMIN_PAGES), async (req, res) => {
  const { status, note } = req.body || {};
  if (!["approved", "rejected"].includes(status)) return res.status(400).json({ error: "status must be approved or rejected" });
  // `note` goes straight into a String column. A non-string made Prisma throw, and
  // an async throw here used to take the whole process down (see asyncRoutes.js).
  if (note != null && typeof note !== "string") return res.status(400).json({ error: "note must be text" });
  if (typeof note === "string" && note.length > 2000) return res.status(400).json({ error: "note is too long (2000 characters maximum)" });

  const existing = await prisma.leave.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Request not found" });

  // Everything below runs one-at-a-time per staff member. The allowance check is a
  // read followed by a write, so two approvals racing each other both read the
  // pre-approval total and both pass — 12 days approved against a 10-day allowance.
  // Serialising per staffId closes that window. (Single-process only; a multi-process
  // deployment would need a DB-level lock or a SELECT ... FOR UPDATE equivalent.)
  const result = await withStaffLock(existing.staffId, async () => {
    // Re-read inside the lock: the request may have been decided while we queued.
    const leave = await prisma.leave.findUnique({ where: { id: req.params.id } });
    if (!leave) return { error: { code: 404, message: "Request not found" } };
    // A request can only be decided once — block re-deciding so an existing
    // decision (and its decidedBy/decidedAt/note audit trail) can't be overwritten.
    if (leave.status !== "pending") return { error: { code: 409, message: "This request has already been decided" } };

    // On approval, enforce the staff member's effective allowance server-side.
    // Most leave types consume allowance — sick included (matches the client's
    // usedDays rule). Unpaid leave is the exception: it neither checks nor consumes
    // the allowance, so it can always be approved regardless of the balance.
    if (status === "approved" && !UNPAID_TYPES.includes(leave.type)) {
      // The allowance is per LEAVE YEAR (calendar year), so each year is checked
      // against its own pot. A booking that straddles New Year is charged to BOTH
      // years — only the days that actually fall in a year count against it.
      const years = yearsSpanned(leave.start, leave.end);
      const [staff, adj, others] = await Promise.all([
        prisma.staff.findUnique({ where: { id: leave.staffId } }),
        // Adjustments belong to the leave year they were recorded in. Summing them
        // across all time meant a one-off "+3 carried over" granted 3 extra days in
        // every future year as well — and, because usedDays IS year-scoped, the two
        // could never reconcile once the year turned.
        prisma.adjustment.findMany({ where: { staffId: leave.staffId }, select: { days: true, date: true } }),
        // Every other approved allowance-consuming booking that could overlap any of
        // these years. We read the DATES (not the stored `days`) and recompute, so a
        // legacy row whose `days` was a raw calendar count can't over-charge.
        prisma.leave.findMany({
          where: {
            staffId: leave.staffId, status: "approved", id: { not: leave.id },
            type: { notIn: UNPAID_TYPES },
            start: { lte: `${years[years.length - 1]}-12-31` },
            end: { gte: `${years[0]}-01-01` },
          },
          select: { start: true, end: true },
        }),
      ]);
      for (const year of years) {
        // The bookable pot excludes the bank holidays (normally 8), which are a
        // separate entitlement and never bookable: bookable = total + adjustments − 8.
        const bankPot = bankHolidayCount(Number(year));
        const adjForYear = adj.reduce((n, a) => n + (String(a.date || "").slice(0, 4) === String(year) ? a.days : 0), 0);
        const bookableAllowance = Math.max(0, (staff?.allowance || 0) + adjForYear - bankPot);
        const usedDays = others.reduce((n, l) => n + chargeableDays(l.start, l.end, year), 0);
        const thisDays = chargeableDays(leave.start, leave.end, year);
        if (thisDays === 0) continue; // this booking uses none of that year's pot
        if (usedDays + thisDays > bookableAllowance) {
          return { error: { code: 400, message: `Approval would exceed the ${year} allowance: ${usedDays} used + ${thisDays} requested > ${bookableAllowance} available` } };
        }
      }
    }

    // Conditional update: only transitions a row that is still pending, so even if
    // the lock were bypassed the decision could not be applied twice. `days` is
    // re-derived here so a legacy row stored with a raw calendar count is corrected
    // on approval and every later reader agrees on the cost.
    const claimed = await prisma.leave.updateMany({
      where: { id: leave.id, status: "pending" },
      data: { status, days: chargeableDays(leave.start, leave.end), note: note || (status === "approved" ? "Approved" : "Declined"), decidedBy: req.user.name, decidedAt: today() },
    });
    if (claimed.count === 0) return { error: { code: 409, message: "This request has already been decided" } };
    return { leave: await prisma.leave.findUnique({ where: { id: leave.id } }) };
  });

  if (result.error) return res.status(result.error.code).json({ error: result.error.message });
  const rec = result.leave;
  // Notify the requester of the decision (persisted + best-effort email).
  const span = rec.start === rec.end ? rec.start : `${rec.start} → ${rec.end}`;
  notifyStaff(rec.staffId, {
    type: status === "approved" ? "success" : "error",
    message: `Your ${rec.type} leave (${span}) was ${status}.` + (note ? ` Note: "${note}"` : ""),
    link: "balance",
  });
  // A material record change: it moves someone's holiday balance and is the thing
  // most likely to be disputed months later.
  audit.record(req, {
    action: "leave.decided", entity: "Leave", entityId: rec.id,
    summary: `Leave for ${rec.start} to ${rec.end} ${rec.status} by ${req.user && req.user.email}` + (rec.note ? ` — "${rec.note}"` : ""),
    before: { status: "pending" },
    after: { status: rec.status, note: rec.note, staffId: rec.staffId, start: rec.start, end: rec.end },
  });
  res.json(sLeave(rec));
});

module.exports = router;
