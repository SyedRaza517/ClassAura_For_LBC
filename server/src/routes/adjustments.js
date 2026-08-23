const router = require("express").Router();
const prisma = require("../db");
const { sAdj } = require("../serializers");
const { requireAuth, requirePage, hasPage } = require("../auth");
const { isInt32, MAX_ADJUSTMENT_DAYS, isRealDate } = require("../validate");
const { localDate } = require("../clock");
const audit = require("../audit");

const today = () => localDate();

// GET /api/adjustments — admin: all; staff: own
router.get("/", requireAuth, async (req, res) => {
  // Only a balances admin sees everyone's adjustments (they carry HR notes).
  // Balances owns adjustments; KPIs and Overview derive balance figures from them.
  const where = hasPage(req.user, ["balances", "kpi", "overview"]) ? {} : { staffId: req.user.id };
  const rows = await prisma.adjustment.findMany({ where, orderBy: { date: "desc" } });
  res.json(rows.map(sAdj));
});

// POST /api/adjustments  (admin) — add a +/- holiday adjustment
router.post("/", requireAuth, requirePage("balances"), async (req, res) => {
  const { staffId, days, note } = req.body || {};
  if (!staffId || days == null) return res.status(400).json({ error: "staffId and days required" });
  // Reject NaN / fractional / zero day counts — a NaN here would poison every
  // balance calculation that sums adjustments (effectiveAllowance → NaN).
  const nDays = Number(days);
  if (!Number.isInteger(nDays) || nDays === 0) return res.status(400).json({ error: "days must be a non-zero whole number" });
  // And bound it. `days` is a 32-bit Int column: SQLite would store a larger value
  // that Prisma then cannot read back, breaking GET /adjustments — and therefore
  // every holiday balance — for everyone, permanently.
  if (!isInt32(nDays) || Math.abs(nDays) > MAX_ADJUSTMENT_DAYS) {
    return res.status(400).json({ error: `days must be between -${MAX_ADJUSTMENT_DAYS} and ${MAX_ADJUSTMENT_DAYS}` });
  }
  // Guard against a non-existent staffId (would otherwise throw a foreign-key error and crash the request).
  const staffExists = await prisma.staff.findUnique({ where: { id: staffId } });
  if (!staffExists) return res.status(400).json({ error: "Unknown staff member" });
  // Optional explicit date, so an adjustment can be filed against the leave year it
  // belongs to. It was always stamped with TODAY, which made carry-over impossible to
  // record: "+3 carried into next year", entered in December, added 3 bookable days
  // to the year that was ending and gave none to the year it was for.
  let date = today();
  if (req.body?.date != null) {
    if (!isRealDate(req.body.date)) return res.status(400).json({ error: "date must be a valid calendar date (YYYY-MM-DD)" });
    const y = Number(String(req.body.date).slice(0, 4));
    const thisYear = Number(today().slice(0, 4));
    if (y < thisYear - 1 || y > thisYear + 1) return res.status(400).json({ error: "Adjustments can only be dated in the previous, current or next leave year" });
    date = String(req.body.date);
  }
  const adj = await prisma.adjustment.create({
    data: { staffId, days: nDays, note: note || "Manual adjustment", date },
  });
  // One administrator moving another person's holiday entitlement by hand, with no
  // request behind it. It is the leave figure most likely to be queried a year later,
  // and the note explaining it is the only context the number carries.
  audit.record(req, {
    action: "adjustment.created", entity: "Adjustment", entityId: adj.id,
    summary: `${nDays > 0 ? "+" : ""}${nDays} day(s) adjustment for ${staffExists.name} dated ${date} — "${adj.note}"`,
    after: { staffId, staffName: staffExists.name, days: nDays, date, note: adj.note },
  });
  res.status(201).json(sAdj(adj));
});

// DELETE /api/adjustments/:id  (admin) — undo a mistake.
//
// There was no way to remove one. A fat-fingered "+50" could only be answered with a
// "−50", which landed in whatever year it was entered — so the wrong year kept the
// +50 for ever and the next year went to zero, locking that person out of booking any
// leave at all.
router.delete("/:id", requireAuth, requirePage("balances"), async (req, res) => {
  const existing = await prisma.adjustment.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Adjustment not found" });
  await prisma.adjustment.delete({ where: { id: existing.id } });
  // Removing an adjustment silently changes a balance back. Without this row the
  // figure moves and nothing in the database says it ever held another value.
  audit.record(req, {
    action: "adjustment.deleted", entity: "Adjustment", entityId: existing.id,
    summary: `${existing.days > 0 ? "+" : ""}${existing.days} day(s) adjustment dated ${existing.date} removed — "${existing.note}"`,
    before: { staffId: existing.staffId, days: existing.days, date: existing.date, note: existing.note },
    after: null,
  });
  res.json({ ok: true });
});

module.exports = router;
