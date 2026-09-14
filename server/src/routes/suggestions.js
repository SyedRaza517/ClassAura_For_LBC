// GET /api/suggestions — the insights feed: plain-language, actionable cards
// computed from data the platform already trusts. The arithmetic that decides what
// a card says lives in ../suggestions/cards.js (pure, tested); this file is the
// gather and the gate.
//
// THE GATE IS THE POINT. Two audiences, two rules, and neither widens anything:
//   * LECTURER cards are identity-scoped — computed only over students enrolled on
//     units that name the caller (tutor, or on a timetable event), which is exactly
//     the audience the register already shows them. No prediction data reaches
//     these: the risk band's own switch and page govern that, and an insights feed
//     must not become the side door.
//   * ADMIN cards are page-gated per card: the prediction card needs the
//     prediction page, the registers trend needs registers, the leave card needs a
//     leave-deciding page. A caller holding none simply gets none — an empty feed
//     is a true answer, not an error.
//
// COST. The admin aggregates sweep whole tables, so they are computed once per TTL
// for everyone and filtered per caller at serve time; the lecturer cards depend on
// who is asking and cache per user. Both caches are in-process module state —
// correct for one Node process, Redis for a cluster, the standing caveat.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth, hasPage, isStudent } = require("../auth");
const { summariseCounts } = require("../attendance");
const { localDate } = require("../clock");
const predictionSettings = require("../prediction/settings");
const {
  staleAttendanceCard, lowAttendanceCard, unitTrendCards,
  unownedRiskCard, stalePendingLeaveCard,
} = require("../suggestions/cards");

router.use(requireAuth, (req, res, next) =>
  (isStudent(req.user) ? res.status(403).json({ error: "Student accounts have no staff suggestions." }) : next()));

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return iso(d); };

/* ----------------------------- admin aggregates ---------------------------- */

const ADMIN_TTL_MS = Number(process.env.SUGGESTIONS_ADMIN_CACHE_MS ?? 10 * 60_000);
let adminCache = null; // { at, cards: [{card, page}] }

async function adminCards() {
  if (adminCache && Date.now() - adminCache.at < ADMIN_TTL_MS) return adminCache.cards;
  const cards = [];
  const today = localDate();

  // Unowned high risk: students at or below the intervention band with no OPEN
  // intervention. The band set comes from the college's own ladder — bands are
  // ordered best → worst, so "at or below" is the tail from interventionBand on.
  try {
    const cfg = await predictionSettings.get();
    const keys = cfg.bands.map((b) => b.key);
    const from = keys.indexOf(cfg.interventionBand);
    const badKeys = from >= 0 ? keys.slice(from) : [];
    if (badKeys.length) {
      const [risky, owned] = await Promise.all([
        prisma.studentPredictionCurrent.findMany({ where: { riskLevel: { in: badKeys } }, select: { studentId: true } }),
        prisma.intervention.findMany({ where: { status: "open" }, select: { studentId: true } }),
      ]);
      const ownedSet = new Set(owned.map((o) => o.studentId));
      const unowned = risky.filter((r) => !ownedSet.has(r.studentId)).length;
      const c = unownedRiskCard({ count: unowned });
      if (c) cards.push({ card: c, pages: ["prediction"] });
    }
  } catch (e) { console.error("[suggestions] unowned-risk skipped:", e.message); }

  // Unit attendance trend: the last 21 days against the 21 before, per unit, both
  // windows floored at 30 marks. Marks arrive flat and are folded in Node — the
  // unit lives on the session, out of groupBy's reach.
  try {
    const cutoff = daysAgo(42);
    const mid = daysAgo(21);
    const marks = await prisma.attendanceMark.findMany({
      where: { session: { date: { gte: cutoff } } },
      select: { status: true, session: { select: { date: true, unit: { select: { id: true, code: true, name: true } } } } },
    });
    const byUnit = new Map();
    for (const m of marks) {
      const u = m.session.unit;
      if (!u) continue;
      if (!byUnit.has(u.id)) byUnit.set(u.id, { code: u.code, name: u.name, recent: { P: 0, L: 0, E: 0, A: 0 }, prior: { P: 0, L: 0, E: 0, A: 0 } });
      const side = m.session.date >= mid ? byUnit.get(u.id).recent : byUnit.get(u.id).prior;
      if (m.status in side) side[m.status] += 1;
    }
    const units = [...byUnit.values()].map((u) => {
      const r = summariseCounts(u.recent.P, u.recent.L, u.recent.E, u.recent.A);
      const p = summariseCounts(u.prior.P, u.prior.L, u.prior.E, u.prior.A);
      return { code: u.code, name: u.name, recentPct: r.pct, priorPct: p.pct, recentMarks: r.marked, priorMarks: p.marked };
    });
    for (const c of unitTrendCards({ units })) cards.push({ card: c, pages: ["registers", "executive"] });
  } catch (e) { console.error("[suggestions] unit-trend skipped:", e.message); }

  // Leave requests pending over a week. requestedAt is a YYYY-MM-DD string
  // (routes/leave.js writes localDate()), so the cutoff compares lexically.
  try {
    const weekAgo = daysAgo(7);
    const stale = await prisma.leave.findMany({ where: { status: "pending", requestedAt: { lt: weekAgo } }, select: { requestedAt: true } });
    if (stale.length) {
      const oldest = stale.reduce((a, b) => (a.requestedAt < b.requestedAt ? a : b)).requestedAt;
      const DAY = 24 * 60 * 60 * 1000;
      const oldestDays = Math.floor((Date.parse(today + "T00:00:00Z") - Date.parse(oldest + "T00:00:00Z")) / DAY);
      const c = stalePendingLeaveCard({ count: stale.length, oldestDays });
      if (c) cards.push({ card: c, pages: ["requests", "approvals", "calendar"] });
    }
  } catch (e) { console.error("[suggestions] stale-leave skipped:", e.message); }

  adminCache = { at: Date.now(), cards };
  return cards;
}

/* ----------------------------- lecturer cards ------------------------------ */

const USER_TTL_MS = Number(process.env.SUGGESTIONS_USER_CACHE_MS ?? 5 * 60_000);
const userCache = new Map(); // staffId -> { at, cards }

async function lecturerCards(staffId) {
  const hit = userCache.get(staffId);
  if (hit && Date.now() - hit.at < USER_TTL_MS) return hit.cards;

  const cards = [];
  const today = localDate();
  const myUnits = await prisma.unit.findMany({
    where: { OR: [{ tutorStaffId: staffId }, { timetableEvents: { some: { staff: { some: { staffId } } } } }] },
    select: { id: true, code: true },
  });
  if (myUnits.length) {
    const unitIds = myUnits.map((u) => u.id);
    const codeOf = new Map(myUnits.map((u) => [u.id, u.code]));

    // Everything each of my students has ever been marked on my units — status
    // tallies via groupBy (cheap), and the recent P/L dates flat for lastAttendedOn.
    const [tallies, recentSeen, students] = await Promise.all([
      prisma.attendanceMark.groupBy({
        by: ["studentId", "status"],
        where: { session: { unitId: { in: unitIds } } },
        _count: { _all: true },
      }),
      prisma.attendanceMark.findMany({
        where: { session: { unitId: { in: unitIds }, date: { gte: daysAgo(90) } }, status: { in: ["P", "L"] } },
        select: { studentId: true, session: { select: { date: true } } },
      }),
      prisma.enrolment.findMany({
        where: { unitId: { in: unitIds } },
        select: { studentId: true, unitId: true, student: { select: { firstName: true, lastName: true } } },
      }),
    ]);

    const marksOf = new Map(); // studentId -> {P,L,E,A}
    for (const t of tallies) {
      if (!marksOf.has(t.studentId)) marksOf.set(t.studentId, { P: 0, L: 0, E: 0, A: 0 });
      if (t.status in marksOf.get(t.studentId)) marksOf.get(t.studentId)[t.status] += t._count._all;
    }
    const lastSeen = new Map();
    for (const m of recentSeen) {
      const d = m.session.date;
      if (!lastSeen.has(m.studentId) || lastSeen.get(m.studentId) < d) lastSeen.set(m.studentId, d);
    }

    const seenIds = new Set();
    const staleRows = [];
    const lowRows = [];
    for (const e of students) {
      const name = `${e.student.firstName} ${e.student.lastName}`;
      const t = marksOf.get(e.studentId);
      if (!seenIds.has(e.studentId)) {
        seenIds.add(e.studentId);
        staleRows.push({
          id: e.studentId, name,
          lastAttendedOn: lastSeen.get(e.studentId) ?? null,
          hasMarks: Boolean(t),
        });
      }
      // Low attendance is PER UNIT, so a student on two of my units appears for the
      // one that is actually low — but the tallies above are across my units, so
      // only single-figure students are judged... no: judge on the combined figure,
      // labelled with the student's first of my units. Combined is the honest v1 —
      // a per-unit split needs per-unit tallies, which is a follow-up, not a lie.
      const sum = t ? summariseCounts(t.P, t.L, t.E, t.A) : { pct: null, marked: 0 };
      if (!lowRows.some((r) => r.id === e.studentId)) {
        lowRows.push({ id: e.studentId, name, unitCode: codeOf.get(e.unitId) || "", pct: sum.pct, marked: sum.marked });
      }
    }

    const stale = staleAttendanceCard({ students: staleRows, today });
    if (stale) cards.push(stale);
    const low = lowAttendanceCard({ rows: lowRows });
    if (low) cards.push(low);
  }

  userCache.set(staffId, { at: Date.now(), cards });
  return cards;
}

/* ----------------------------- the feed ------------------------------------ */

const SEVERITY_ORDER = { urgent: 0, warn: 1, info: 2 };

router.get("/", async (req, res) => {
  const [mine, admin] = await Promise.all([lecturerCards(req.user.id), adminCards()]);
  const visible = admin.filter((a) => hasPage(req.user, a.pages)).map((a) => a.card);
  const suggestions = [...mine, ...visible]
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9))
    .slice(0, 8);
  res.json({ suggestions });
});

module.exports = router;
