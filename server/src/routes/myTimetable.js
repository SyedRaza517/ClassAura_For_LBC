// The timetable a member of staff READS. The planner half is routes/timetabling.js.
//
// requireAuth ONLY — no requirePage. Every lecturer reads their own timetable, and
// gating that on an admin page would mean granting an admin page to the entire
// teaching staff, which is the opposite of what page grants are for.
//
// Student and applicant tokens cannot reach here at all: they are confined by the
// STUDENT_ROUTERS / APPLICANT_ROUTERS allowlists in auth.js, and this router is in
// neither. That is closed-by-default and is why there is no per-route check for it;
// smoke-timetabling.mjs asserts it rather than trusting the comment.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth } = require("../auth");
const { sResource } = require("../timetabling/serialize");

router.use(requireAuth);

const str = (v) => (typeof v === "string" ? v.trim() : "");

// A picker, not an export. The reference institution's list runs to 9,009 students,
// and a limit is what keeps this from becoming a way to page the whole directory
// into a file.
const MAX_LIMIT = 50;

/**
 * Search one resource type.
 *
 * ALL FIVE TYPES ARE OPEN TO ANY SIGNED-IN MEMBER OF STAFF, matching the system this
 * reproduces. That includes looking up a named student's week, which is a larger
 * disclosure than anything else in the staff app — a decision taken deliberately and
 * recorded in the design document, not an oversight. Narrowing it later means
 * removing types from this switch and nothing else.
 */
router.get("/resources", async (req, res) => {
  const type = str(req.query.type);
  const q = str(req.query.q).slice(0, 100);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || 25));
  const like = { contains: q, mode: "insensitive" };

  let rows = [], total = 0;
  switch (type) {
    case "room": {
      // Active only. The planner shows retired rooms because it manages them; a
      // reader looking for somewhere to be should not be offered one.
      // Searches BOTH the campus relation and the legacy string. Only the relation
      // would miss every room the migration's fold could not place — which are exactly
      // the rooms whose campus somebody is most likely to be hunting for. Only the
      // string would miss any campus renamed since.
      const where = {
        active: true,
        ...(q ? { OR: [{ name: like }, { campus: like }, { campusRef: { name: like } }] } : {}),
      };
      [rows, total] = await Promise.all([
        prisma.room.findMany({ where, include: { campusRef: { select: { name: true } } }, orderBy: [{ campus: "asc" }, { name: "asc" }], take: limit }),
        prisma.room.count({ where }),
      ]);
      break;
    }
    case "staff": {
      const where = q ? { name: like } : {};
      [rows, total] = await Promise.all([
        prisma.staff.findMany({ where, orderBy: { name: "asc" }, take: limit, select: { id: true, name: true, dept: true } }),
        prisma.staff.count({ where }),
      ]);
      break;
    }
    case "student": {
      // Requiring a query for students is deliberate. Every other type is small
      // enough to browse; this one is thousands of named people, and an empty search
      // returning the first 25 of them makes the picker a directory you scroll.
      if (!q) return res.json({ type, total: 0, results: [], needsQuery: true });
      // There is no `name` column on Student — it is firstName, lastName and
      // studentRef. All three are searched, because a member of staff looking a
      // student up has whichever one they happen to be holding.
      const where = { OR: [{ firstName: like }, { lastName: like }, { studentRef: like }] };
      [rows, total] = await Promise.all([
        prisma.student.findMany({ where, orderBy: [{ lastName: "asc" }, { firstName: "asc" }], take: limit, select: { id: true, firstName: true, lastName: true, studentRef: true } }),
        prisma.student.count({ where }),
      ]);
      break;
    }
    case "group": {
      const where = q ? { name: like } : {};
      [rows, total] = await Promise.all([
        prisma.cohort.findMany({ where, orderBy: { name: "asc" }, take: limit, select: { id: true, name: true, course: { select: { name: true } } } }),
        prisma.cohort.count({ where }),
      ]);
      break;
    }
    case "module": {
      const where = q ? { OR: [{ name: like }, { code: like }] } : {};
      [rows, total] = await Promise.all([
        prisma.unit.findMany({ where, orderBy: { name: "asc" }, take: limit, select: { id: true, name: true, code: true } }),
        prisma.unit.count({ where }),
      ]);
      break;
    }
    default:
      return res.status(400).json({ error: "type must be one of: module, room, staff, student, group" });
  }

  res.json({ type, total, results: rows.map((r) => sResource(type, r)) });
});

/* ------------------------------------------------------- the timetable -- */

const { sEvent } = require("../timetabling/serialize");
const timetableSettings = require("../timetabling/settings");

// Repeated from routes/timetabling.js rather than shared, because the two routers
// must be able to diverge: this one will grow a "published only" constraint that the
// planner must never inherit.
const EVENT_INCLUDE = {
  unit: { select: { code: true, name: true } },
  course: { select: { name: true } },
  // campusRef IS REQUIRED HERE, not optional detail. roomLabel() reads the related
  // campus first and falls back to the legacy `campus` string, so selecting only the
  // string silently drops the campus for every room created since campuses became rows
  // — those have campusId set and the string left empty. The planner's copy of this
  // include has always had it, which is why the same class read "101 [Harrow]" there and
  // a bare "101" here. Reported as: there is no campus in the timetable popup.
  room: { select: { id: true, name: true, floor: true, campus: true, campusRef: { select: { name: true } } } },
  category: { select: { name: true, colour: true } },
  staff: { include: { staff: { select: { name: true } } } },
  groups: { include: { cohort: { select: { name: true } } } },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A window, not a firehose. Twelve months is more than any view asks for — the
// widest is a month — and it stops a hand-written request pulling every event the
// college has ever held.
const MAX_WINDOW_DAYS = 366;

const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/**
 * The events this reader asked for, in a date window.
 *
 * With no `type`, the answer is THEIR OWN teaching — the equivalent of the source
 * system's "My Resources" checkbox, which is its entire answer to "my timetable".
 * That is one join on an id. It is not a match on their name, and the difference is
 * the whole point of the module: two lecturers sharing a surname would otherwise see
 * each other's classes with nothing reporting it.
 *
 * PUBLISHED ONLY, always. A draft term an administrator is still building must not
 * appear in a lecturer's app, where it would be indistinguishable from a real one.
 */
router.get("/", async (req, res) => {
  const from = str(req.query.from), to = str(req.query.to);
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return res.status(400).json({ error: "from and to must be YYYY-MM-DD" });
  if (to < from) return res.status(400).json({ error: "to must not be before from" });
  if (daysBetween(from, to) > MAX_WINDOW_DAYS) return res.status(400).json({ error: "That date range is too wide — ask for a year or less" });

  const type = str(req.query.type);
  const wanted = str(req.query.ids).split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20);

  let scope, where = { published: true, date: { gte: from, lte: to } };
  // EVERY PUBLISHED CLASS, and unlike the other scopes it takes no ids -- so it is
  // checked before the `wanted.length` test below, which would otherwise fall it through
  // to "me" and silently answer a different question than the one asked.
  //
  // This grants NO disclosure that was not already available. Any signed-in member of
  // staff can already ask for any room's, group's, module's, colleague's or named
  // student's week one at a time, deliberately, and /resources will enumerate them to
  // find the ids. "all" is a convenience over that, not a new permission, which is why
  // it carries no requirePage of its own -- adding one would imply the pieces were
  // protected when they are not.
  //
  // It exists because "my teaching" is the wrong default for the person who BUILT the
  // timetable. An administrator who has just scheduled a term is not teaching any of it,
  // so their own timetable is empty and the screen looked broken. Asked for in exactly
  // those words: the events in Scheduling need to be here as well.
  if (type === "all") {
    scope = { type: "all", ids: [] };
  } else if (!type || !wanted.length) {
    scope = { type: "me", ids: [req.user.id] };
    where.staff = { some: { staffId: req.user.id } };
  } else {
    scope = { type, ids: wanted };
    switch (type) {
      case "room":    where.roomId = { in: wanted }; break;
      case "staff":   where.staff = { some: { staffId: { in: wanted } } }; break;
      case "group":   where.groups = { some: { cohortId: { in: wanted } } }; break;
      case "module":  where.unitId = { in: wanted }; break;
      case "student": {
        // A student's timetable is derived rather than stored: the groups they are
        // in, plus the units they are enrolled on. A third join table naming
        // individual students would earn its keep only for one-to-one tutorials,
        // which nothing has asked for.
        const students = await prisma.student.findMany({
          where: { id: { in: wanted } },
          select: { cohortId: true, enrolments: { select: { unitId: true } } },
        });
        const cohortIds = [...new Set(students.map((s) => s.cohortId).filter(Boolean))];
        const unitIds = [...new Set(students.flatMap((s) => s.enrolments.map((e) => e.unitId)))];
        // No cohort and no enrolments means no timetable — not "every event".
        if (!cohortIds.length && !unitIds.length) {
          return res.json({ from, to, scope, events: [], settings: await timetableSettings.getEffective(req.user.id) });
        }
        where.OR = [
          ...(cohortIds.length ? [{ groups: { some: { cohortId: { in: cohortIds } } } }] : []),
          ...(unitIds.length ? [{ unitId: { in: unitIds } }] : []),
        ];
        break;
      }
      default: return res.status(400).json({ error: "type must be one of: module, room, staff, student, group" });
    }
  }

  const [rows, settings] = await Promise.all([
    prisma.timetableEvent.findMany({ where, include: EVENT_INCLUDE, orderBy: [{ date: "asc" }, { startTime: "asc" }] }),
    // Sent WITH the events, in one round trip. The grid cannot draw a row until it
    // knows which periods and days to draw, so a second request would mean a visible
    // reflow on every load.
    timetableSettings.getEffective(req.user.id),
  ]);

  res.json({ from, to, scope, events: rows.map(sEvent), settings });
});

/* --------------------------------------------------------- my settings -- */

// The merged view is what the screen renders; the college's own layer is sent
// alongside so "reset to the college default" has something to reset to.
router.get("/settings", async (req, res) => {
  const [settings, institution] = await Promise.all([
    timetableSettings.getEffective(req.user.id),
    timetableSettings.getInstitution(),
  ]);
  res.json({ settings, institution });
});

// A patch of this person's own overrides. `notice` is not in USER_FIELDS and is
// silently dropped: the banner is the college's statement about itself, and an
// individual editing their copy would be editing what every reader is told.
router.put("/settings", async (req, res) => {
  await timetableSettings.saveUser(req.user.id, req.body || {});
  res.json({ settings: await timetableSettings.getEffective(req.user.id) });
});

module.exports = router;
