// The Admission Tracker — aggregate admissions figures, and nothing else.
//
// THIS ROUTER EMITS AGGREGATES ONLY. No applicant id, name, email, address or document
// number leaves it, and that is not a nicety — it is the entire reason the tracker has
// its own admin page. The "admissions" grant opens the full application record:
// passport and ID numbers, National Insurance numbers, home addresses, criminal-record
// and medical declarations. A principal or a marketing lead wants the funnel, not four
// thousand people's identity documents, and until now there was no way to give them one
// without the other.
//
// The rule is enforced in three places, deliberately, because a rule with one guard is a
// rule somebody widens for a screen they are building:
//   1. SELECT below names the columns, so a personal field is absent rather than unused.
//   2. schema-contract.test.js reads this file AS TEXT and fails if a personal field
//      appears in that select — the same technique that guards metrics.js against
//      selecting a mitigating-circumstances reason.
//   3. smoke-admission-tracker.mjs asserts no seeded applicant's name, email or NI
//      number appears anywhere in the response body.
//
// The arithmetic is not here. It is in src/admissions/stats.js, pure and unit-tested,
// because there is no client-side test framework and this route is not the place to
// discover that a funnel rule is wrong.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth, requireAnyPage } = require("../auth");
const audit = require("../audit");
const { buildStats, previousIntake } = require("../admissions/stats");
const { merge } = require("../admissions/trackerSettings");

// "admissions" is included alongside the new page for the reason
// /assessments/exec-summary includes "executive": an admissions officer looking at
// their own funnel should not need a second grant to see figures derived from records
// they can already open in full. The new page is what lets somebody have the figures
// WITHOUT that access — it adds an audience, it does not take one away.
router.use(requireAuth, requireAnyPage(["admissions-tracker", "admissions"]));

// The only columns this router may read.
//
// A NAMED LIST, NOT A `select`-EVERYTHING WITH FIELDS DROPPED LATER. Same rule as
// sAdmission's allowlist and for the same reason: a denylist ships every column added
// afterwards by default, and nobody adding a column comes back to a serialiser to opt
// it out. That is how a bcrypt hash once reached the admin dashboard.
//
// postCode and countryOfCitizenship ARE personal data and are here on purpose — they
// are read to bucket a student into a region or a citizenship group and are dropped
// inside stats.js. Neither value reaches the response; the tests prove it.
//
// `id` is deliberately absent. stats.js never needs it, and a select that cannot read
// an identifier cannot leak one.
const SELECT = {
  createdAt: true,
  applicationSubmittedAt: true,
  course: true,
  intake: true,
  foundVia: true,
  source: true,
  countryOfCitizenship: true,
  postCode: true,
  offerStatus: true,
  offerSentAt: true,
  offerAcceptedAt: true,
  enrollStatus: true,
  enrolEmailSentAt: true,
  documents: { select: { docType: true } },
  isms: { select: { interviewDate: true } },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * The Prisma `where` for one scope.
 *
 * The date range filters on createdAt — when the record ARRIVED — because that is the
 * date every applicant has. Filtering on an offer or enrolment date would silently drop
 * everybody who has not got that far, which is most of a live intake.
 *
 * Boundaries are UTC. The organisation runs in Europe/London, so during BST a record
 * created in the last hour of a day falls on the neighbouring day of the filter. That
 * is a known, one-hour edge on a filter whose ends an admin picks by eye; the month
 * buckets inside stats.js, which get quoted, are zoned properly.
 */
function scopeWhere({ intake, course, from, to }) {
  const where = {};
  if (intake) where.intake = intake;
  if (course) where.course = course;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(`${from}T00:00:00.000Z`);
    // `lt` the day AFTER `to`, so the range includes every moment of the end date. `lte`
    // on the date alone means midnight, which silently excludes the whole final day —
    // an off-by-one that reads as a quiet week rather than as a filter bug.
    if (to) where.createdAt.lt = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86400000);
  }
  return where;
}

/** This college's tracker configuration, or the code defaults if it has never saved. */
async function loadConfig() {
  let row = null;
  try {
    // findFirst, not findUnique on the constant id: a read must not be able to create a
    // row, and the constant primary key is what guarantees there is at most one to find.
    row = await prisma.admissionTrackerSettings.findFirst();
  } catch {
    row = null; // table not migrated yet — defaults are correct, not an error
  }
  return merge(row?.data);
}

/** Course name → fee in pence, for courses whose fee this college has actually set. */
async function loadCourseFees() {
  const rows = await prisma.admissionCourse.findMany({ select: { name: true, feeAmountPence: true } });
  const fees = {};
  // A null fee is OMITTED rather than written as 0. stats.js distinguishes "no fee
  // recorded" from "free", and putting a 0 here would erase that distinction before it
  // ever reached the code that cares about it.
  for (const c of rows) if (typeof c.feeAmountPence === "number") fees[c.name] = c.feeAmountPence;
  return fees;
}

/**
 * The comparison period's scope, or null for no comparison.
 *
 * Null is a real answer here. A first-ever intake, or a college that has not been on
 * the system a year, genuinely has nothing to compare against — and a dashboard that
 * invents a +100% rise for it is worse than one showing no chip at all.
 */
async function resolveCompare({ intake, course, from, to, compare }) {
  if (compare === "none") return null;
  // An explicitly chosen intake wins over anything derived.
  if (compare) return scopeWhere({ intake: compare, course });

  if (intake) {
    const labels = (await prisma.admissionIntake.findMany({ select: { label: true } })).map((i) => i.label);
    const prev = previousIntake(labels, intake);
    return prev ? scopeWhere({ intake: prev, course }) : null;
  }

  if (from && to) {
    // The preceding window of the SAME LENGTH, ending the day before this one starts.
    // Comparing a six-week range against a whole previous year is how a dashboard
    // reports a healthy intake as a collapse.
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);
    const span = end.getTime() - start.getTime() + 86400000;
    const prevEnd = new Date(start.getTime() - 86400000);
    const prevStart = new Date(start.getTime() - span);
    return scopeWhere({
      course,
      from: prevStart.toISOString().slice(0, 10),
      to: prevEnd.toISOString().slice(0, 10),
    });
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* The dashboard                                                               */
/* -------------------------------------------------------------------------- */

router.get("/", async (req, res) => {
  const intake = str(req.query.intake);
  const course = str(req.query.course);
  const from = DATE_RE.test(str(req.query.from)) ? str(req.query.from) : "";
  const to = DATE_RE.test(str(req.query.to)) ? str(req.query.to) : "";
  const compare = str(req.query.compare);

  const [config, courseFees] = await Promise.all([loadConfig(), loadCourseFees()]);
  const compareWhere = await resolveCompare({ intake, course, from, to, compare });

  const [rows, compareRows] = await Promise.all([
    prisma.admission.findMany({ where: scopeWhere({ intake, course, from, to }), select: SELECT }),
    compareWhere ? prisma.admission.findMany({ where: compareWhere, select: SELECT }) : Promise.resolve(null),
  ]);

  const stats = buildStats({ rows, compareRows, config, courseFees, intake: intake || null });

  // The scope is echoed back so the client can label a comparison chip with the period
  // it is actually against, rather than assuming it got what it asked for.
  res.json({
    ...stats,
    scope: {
      intake: intake || null,
      course: course || null,
      from: from || null,
      to: to || null,
      comparedTo: compareWhere ? (compare || compareWhere.intake || "the preceding period") : null,
    },
  });
});

/* -------------------------------------------------------------------------- */
/* Settings: targets, required documents, course fees                          */
/* -------------------------------------------------------------------------- */

router.get("/settings", async (_req, res) => {
  const config = await loadConfig();
  const courses = await prisma.admissionCourse.findMany({
    select: { id: true, name: true, active: true, feeAmountPence: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  const intakes = await prisma.admissionIntake.findMany({
    select: { label: true, active: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  res.json({ ...config, courses, intakes });
});

router.put("/settings", async (req, res) => {
  const body = req.body || {};

  // merge() is the allowlist and the validator in one, so what is stored is what a read
  // would have produced anyway — no route-shaped second opinion on what a target is.
  const current = await loadConfig();
  const next = merge({
    targets: body.targets !== undefined ? body.targets : current.targets,
    requiredDocTypes: body.requiredDocTypes !== undefined ? body.requiredDocTypes : current.requiredDocTypes,
  });

  // upsert on the constant key, NOT findFirst-then-create. Find-then-create is not
  // atomic: two administrators saving at the same moment both find nothing and both
  // insert, after which findFirst returns whichever row the planner picks and the
  // targets this dashboard measures against become a coin toss between them.
  const data = { data: next, updatedBy: req.user?.email || null };
  await prisma.admissionTrackerSettings.upsert({
    where: { id: "singleton" },
    update: data,
    create: { id: "singleton", ...data },
  });

  // Course fees ride along on the same form. Keyed by AdmissionCourse id, and each
  // value is pence or null — null CLEARS the fee back to "not recorded", which is a
  // meaningful thing to do and not the same as setting it to zero.
  if (body.courseFees && typeof body.courseFees === "object") {
    for (const [id, raw] of Object.entries(body.courseFees)) {
      const pence =
        raw === null || raw === "" ? null
          : Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Math.round(Number(raw))
            : undefined;
      // undefined = unusable input. Skipped rather than written as null, so a typo in
      // one field cannot silently wipe a fee somebody set correctly last term.
      if (pence === undefined) continue;
      await prisma.admissionCourse.updateMany({ where: { id: String(id) }, data: { feeAmountPence: pence } });
    }
  }

  // Worth an audit line: these numbers are what an executive screen judges the
  // admissions team against, and "the target changed" is a fair question to be able to
  // answer. No applicant is named — there is nothing personal in this row.
  audit.record(req, {
    action: "admissionTracker.settingsSaved",
    entity: "AdmissionTrackerSettings",
    entityId: "singleton",
    summary: "Admission tracker targets and required documents updated",
  });

  res.json(next);
});

module.exports = router;
