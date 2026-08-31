// The college's own list of support departments, resolved and cached.
//
// CONFIGURATION, NOT A CONSTANT, and that is the whole point of the file. "Wellbeing,
// ASK, Student Support" is one college's vocabulary. The next one calls ASK something
// else, or runs Wellbeing and Student Support as a single team — which this college's
// own attendance letters already do, writing them as one contact. Hardcoding one
// institution's organisation chart into a product sold to others is the failure this
// codebase has already decided against for branding, attendance bands, prediction
// thresholds and letter wording.
//
// Same shape as attendanceBandConfig.js and prediction/settings.js: platform defaults
// in code, one JSON column merged over them, no row until a college edits something,
// an allowlist on the way out, and a short cache invalidated on save.
const prisma = require("./db");

// The row's primary key is the constant "singleton", which IS the single-row
// guarantee — see TenantBranding. save() upserts on it, so two administrators saving
// at once collide on the key rather than both inserting.
const CONFIG_ID = "singleton";

const TTL_MS = Number(process.env.SUPPORT_DEPARTMENTS_CACHE_MS ?? 30_000);
let cached = null; // { value, at } | null

function invalidate() {
  cached = null;
}

// What a college gets before it has said anything. Deliberately the three the first
// customer asked for, and deliberately not treated as special afterwards: once the
// college saves its own list, these are gone rather than merged underneath, because a
// department this college retired must not reappear at the next deploy.
const DEFAULTS = [
  { key: "wellbeing", name: "Wellbeing", active: true },
  { key: "ask", name: "ASK", active: true },
  { key: "student-support", name: "Student Support", active: true },
];

// A key is a slug: lower case, digits and hyphens. Narrow on purpose — the key is
// STORED ON EVERY REFERRAL as a plain string and is what a URL fragment carries, so
// it has to survive both without escaping, and it can never be edited afterwards.
const KEY_RE = /^[a-z0-9-]{1,40}$/;

const str = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * Clean one submitted department. Returns null if it cannot be made valid.
 *
 * An ALLOWLIST, not a blocklist: exactly three fields are read and everything else a
 * client sends is dropped rather than stored. sAdmission is the cautionary tale —
 * it stripped a fixed list of secrets, so every column added after it shipped to the
 * browser by default.
 */
function cleanOne(d) {
  const key = str(d?.key).toLowerCase();
  const name = str(d?.name);
  if (!KEY_RE.test(key)) return null;
  if (!name) return null;
  return { key, name: name.slice(0, 60), active: d?.active !== false };
}

/**
 * Clean a whole submitted list. Duplicate keys collapse to the FIRST occurrence —
 * two departments sharing a key would make one of them unreachable, because every
 * referral, every queue and every membership check matches on the key alone.
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

/** Every department this college has, retired ones included. */
async function all() {
  if (TTL_MS > 0 && cached && Date.now() - cached.at < TTL_MS) return cached.value;

  let row = null;
  try {
    row = await prisma.supportDepartmentConfig.findFirst();
  } catch {
    // Table not migrated yet. The defaults are the correct answer rather than an
    // error — the same fallback attendanceBandConfig.js makes, and what keeps a
    // half-deployed environment showing a working screen instead of a stack trace.
    row = null;
  }

  const stored = row ? cleanList(row.departments) : null;
  // An empty stored list is a real answer ("this college runs no support desks"), so
  // it must not fall back to the defaults. Only the ABSENCE of a row does.
  const value = stored === null ? DEFAULTS : stored;
  cached = { value, at: Date.now() };
  return value;
}

/** The departments a referral may currently be raised against. */
async function active() {
  return (await all()).filter((d) => d.active);
}

/**
 * Look one up by key, retired included.
 *
 * Retired ones still resolve, deliberately: a queue full of referrals raised last term
 * against a department the college has since closed still has to render, and rendering
 * it as its raw key would show staff a slug instead of a name.
 */
async function byKey(key) {
  const k = str(key).toLowerCase();
  return (await all()).find((d) => d.key === k) || null;
}

/**
 * Replace the list. Returns the cleaned list actually stored.
 *
 * A REPLACEMENT, not a patch, because the screen edits the whole list — and because
 * removing a department has to be expressible. Retiring is `active: false`; a key that
 * simply disappears from the list takes its name with it, which is why byKey() above
 * has to tolerate not finding one.
 */
async function save(list, updatedBy = "") {
  const departments = cleanList(list);
  if (departments === null) return { error: "Send an array of departments." };

  await prisma.supportDepartmentConfig.upsert({
    where: { id: CONFIG_ID },
    update: { departments, updatedBy: str(updatedBy).slice(0, 200) },
    create: { id: CONFIG_ID, departments, updatedBy: str(updatedBy).slice(0, 200) },
  });
  invalidate();
  return { departments };
}

/**
 * The department keys one member of staff belongs to.
 *
 * Staff.supportDepartments holds a JSON array, exactly as adminPages does. Anything
 * unparseable reads as NO membership rather than as full membership: a corrupted
 * column must not open every queue.
 */
function membershipOf(staff) {
  if (!staff) return [];
  const raw = staff.supportDepartments;

  // TWO SHAPES REACH HERE, AND ASSUMING ONE OF THEM LOCKED THE WHOLE FEATURE.
  //
  // A raw Prisma row carries the JSON string this column stores. But req.user is
  // sStaff(row), and that serialiser has ALREADY parsed it into an array — so the
  // request path arrives holding an array while a scheduler or script arrives holding
  // a string. Parsing unconditionally threw on the array, the catch swallowed it, and
  // canReadDepartment answered false for every member of staff: every queue 403,
  // including to the people whose job is to work it. Every NEGATIVE test still passed,
  // which is the fingerprint of this kind of bug.
  //
  // Accepting both shapes is right rather than merely defensive. The alternative —
  // insisting callers hand over one shape — means this function and the serialiser
  // have to agree forever about which, and the failure when they stop agreeing is
  // silent and total.
  if (Array.isArray(raw)) return raw.filter((k) => typeof k === "string");
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : [];
  } catch {
    // Unparseable reads as NO membership, never as full membership. A corrupted column
    // must not open every queue.
    return [];
  }
}

/**
 * May this person read this department's queue?
 *
 * NOT exempted for a Super Admin, unlike adminPages. Holding every admin page is a
 * statement about administrative authority; being on the wellbeing team is a statement
 * about who reads a student's disclosures. "The most senior account sees every case
 * note by default" is the outcome the whole confidentiality split exists to prevent,
 * and a Super Admin who needs the wellbeing queue can put themselves on the team —
 * visibly, in a column somebody can audit.
 */
function canReadDepartment(staff, key) {
  return membershipOf(staff).includes(str(key).toLowerCase());
}

module.exports = {
  DEFAULTS, all, active, byKey, save, invalidate,
  membershipOf, canReadDepartment,
  // Exported for the unit tests, which cover the pure half without a database.
  cleanOne, cleanList, KEY_RE,
};
