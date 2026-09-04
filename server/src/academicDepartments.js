// The college's own list of ACADEMIC departments — Business, Computing, Law, Health &
// Social Care — resolved and cached.
//
// NOT THE SAME THING AS supportDepartments.js, and the difference is the whole reason
// this file exists separately. That file lists WELLBEING TEAMS: who reads a student's
// disclosure. This one lists TEACHING DEPARTMENTS: which courses and students a member
// of staff may see at all. Two access boundaries with one English word between them, so
// every identifier here is `academicDepartment` and never a bare `department`. CLAUDE.md
// records that the `outcome` collision caused three bugs by a fix landing on the wrong
// vocabulary; this collision would grant the wrong people the wrong records.
//
// A REAL TABLE, NOT A JSON CONFIG COLUMN, which is the other difference from
// supportDepartments.js. A support department deliberately has no foreign keys pointing
// at it, so a referral outlives its team. An academic department is joined to from
// Course and Student on the hottest query path in the application, and a JSON blob
// cannot be indexed. Deletion safety comes from onDelete: SetNull on the referencing
// side instead — the same choice Unit.courseId already makes so that registers never
// vanish with a deleted course.
//
// Everything else follows supportDepartments.js exactly: an allowlist on the way out,
// and a short cache invalidated on save.
const prisma = require("./db");

const TTL_MS = Number(process.env.ACADEMIC_DEPARTMENTS_CACHE_MS ?? 30_000);
let cached = null; // { value, at } | null

function invalidate() {
  cached = null;
}

// A key is a slug: lower case, digits and hyphens. Narrow on purpose. Course and Student
// carry the department's cuid id rather than this key, so the key is not written onto
// every row — but it IS what a saved filter, a URL fragment and the VLE mapping screen
// carry, and it can never be edited afterwards without orphaning them.
const KEY_RE = /^[a-z0-9-]{1,40}$/;
// Six-digit hex only. The colour is rendered into a style attribute; anything else is
// replaced rather than escaped, because a value that needs escaping is one that will
// eventually reach somewhere that forgets to.
const COLOUR_RE = /^#[0-9a-f]{6}$/;
const DEFAULT_COLOUR = "#1a3a8f";

const str = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * Clean one submitted department. Returns null if it cannot be made valid.
 *
 * An ALLOWLIST, not a blocklist: exactly four fields are read and everything else a
 * client sends is dropped rather than stored. sAdmission is the cautionary tale — it
 * stripped a fixed list of secrets, so every column added afterwards shipped to the
 * browser by default.
 */
function cleanOne(d) {
  const key = str(d?.key).toLowerCase();
  const name = str(d?.name);
  if (!KEY_RE.test(key)) return null;
  if (!name) return null;
  const colour = str(d?.colour).toLowerCase();
  return {
    key,
    name: name.slice(0, 60),
    colour: COLOUR_RE.test(colour) ? colour : DEFAULT_COLOUR,
    // `!== false` rather than Boolean(): a college that omits the field means "active",
    // and a truthy non-boolean must not be read as "retired".
    active: d?.active !== false,
  };
}

/**
 * Clean a whole submitted list. Duplicate keys collapse to the FIRST occurrence — two
 * departments sharing a key would make one of them unreachable, because the mapping
 * screen, a saved filter and every membership check match on the key alone.
 *
 * An invalid row is DROPPED rather than failing the whole submission, matching
 * supportDepartments.cleanList: an administrator editing eight departments should not
 * lose seven good edits to one typo.
 */
function cleanList(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const d of list.slice(0, 50)) {
    const c = cleanOne(d);
    if (!c || seen.has(c.key)) continue;
    seen.add(c.key);
    out.push(c);
  }
  return out;
}

/**
 * Every department this college has, retired ones included.
 *
 * NO DEFAULTS, which is the one place this deliberately diverges from
 * supportDepartments.js. That file ships three, because a college with no wellbeing team
 * configured still has students to refer and the referral screen must offer somewhere to
 * send them. There is no equivalent here: inventing a "General" department and letting
 * every course fall into it is exactly the silent fail-open the migration was written to
 * avoid. The first account narrowed off college-wide would be scoped to a department
 * containing the whole institution, and the screen would say nothing was wrong.
 *
 * An empty list is therefore the correct answer for a college that has not set its
 * departments up, and the Settings screen says so out loud.
 */
async function all() {
  if (TTL_MS > 0 && cached && Date.now() - cached.at < TTL_MS) return cached.value;

  let rows = [];
  try {
    rows = await prisma.academicDepartment.findMany({ orderBy: { name: "asc" } });
  } catch {
    // Table not migrated yet. An empty list is the correct answer rather than an error —
    // the same fallback attendanceBandConfig.js and supportDepartments.js make, and what
    // keeps a half-deployed environment showing a working screen instead of a stack
    // trace.
    rows = [];
  }
  const value = rows.map((r) => ({
    id: r.id, key: r.key, name: r.name, colour: r.colour, active: r.active,
  }));
  cached = { value, at: Date.now() };
  return value;
}

/** Only the departments the college is currently running. */
async function active() {
  return (await all()).filter((d) => d.active);
}

/** One department by its slug, retired ones included. Null when there is no such key. */
async function byKey(key) {
  const k = str(key).toLowerCase();
  if (!KEY_RE.test(k)) return null;
  return (await all()).find((d) => d.key === k) || null;
}

/**
 * Which academic department a cohort belongs to, via its course. Null when the cohort has
 * none, its course has none, or there is no cohort at all.
 *
 * THE ONE IMPLEMENTATION OF THE DENORMALISATION, and it is deliberately shared. Student
 * .academicDepartmentId is a stored copy of this answer -- stored because Student.cohortId
 * is nullable, so deriving it on read would leave cohortless students belonging to no
 * department and invisible to every scoped account, and because it would be a two-hop join
 * on the most frequent query in the application.
 *
 * The price of a stored copy is drift, and drift is only avoidable if every writer uses
 * the same rule. Three call sites do: creating a student, changing a student's cohort, and
 * mapping a VLE category onto a department. A fourth that computed it by hand would be the
 * bug this function exists to prevent.
 */
async function forCohort(cohortId) {
  if (!cohortId) return null;
  const cohort = await prisma.cohort.findUnique({
    where: { id: cohortId },
    select: { course: { select: { academicDepartmentId: true } } },
  });
  return cohort?.course?.academicDepartmentId ?? null;
}

module.exports = {
  KEY_RE, COLOUR_RE, DEFAULT_COLOUR,
  cleanOne, cleanList, invalidate,
  all, active, byKey, forCohort,
};
