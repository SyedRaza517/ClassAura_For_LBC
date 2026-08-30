// The attendance bands this college monitors its students against.
//
// WHY THE BANDS ARE STILL DATA, NOW THAT THERE IS ONLY ONE COLLEGE
//
// The six bands in attendanceBands.js (85+, 70–84, 60–69, 50–59, 40–49, 0–39) are one
// college's policy, written into the code. Another college warns at 75% and escalates
// at 60%; another runs three bands and only emails the bottom one; a college with a
// Student-visa cohort has a hard 80% line that the six-band ladder cannot express at
// all. That is what made them configurable in the first place, when one deployment
// served every institution.
//
// One deployment now serves one institution, so the leak this guarded against — a
// student monitored against somebody else's thresholds — is gone. The configurability
// is not, and deliberately: which band a student lands in decides who receives a letter
// telling them their place is at risk. That is the college's decision, not the
// supplier's, and hardcoding it back into attendanceBands.js would mean every
// threshold change is a deploy. The DEFAULTS stay in code because a college that has
// configured nothing must behave exactly as it did before; the bands themselves stay
// DATA because the college owns them.
//
// So the shape is unchanged, minus the tenant: ONE row for this institution, defaults
// merged under it, an allowlist on the way out, and a short cache invalidated on save.
// branding.js and prediction/settings.js are the same pattern.
//
// WHY THE WHOLE LIST IS ONE JSON COLUMN AND NOT A ROW PER BAND
//
// A band list is only ever valid as a SET: it has to tile 0–100 with no gap and no
// overlap (see normaliseBands). A row per band would make that invariant something
// to defend across several statements, and any window in which one row is written
// and the next is not is a window in which a student is classified against a ladder
// with a hole in it. One column means the set is replaced atomically — a reader
// either sees the old complete list or the new complete list, never half of either.
//
// It is also deliberately NOT stored inside AttendanceEmailConfig.data, which is
// shallow-merged on save: a merge cannot express "this college now has five bands
// where it had six", and deleting a band is the one edit that must work.
const prisma = require("./db");
const bands = require("./attendanceBands");

// The row's primary key is the constant "singleton". That constant IS the
// single-row guarantee — it replaced the old `@@unique([tenantId])`, which is what
// used to stop a second row appearing. Writing through it (see save) means two
// concurrent saves collide on the key and one wins, rather than both succeeding and
// leaving findFirst to pick between them.
const CONFIG_ID = "singleton";

// Short, matching branding.js and integrationConfig.js. This is read on every
// attendance computation and every send, it changes about never, and an
// administrator who has just moved a threshold should see students move band while
// they are still looking at the screen.
const TTL_MS = Number(process.env.ATTENDANCE_BANDS_CACHE_MS ?? 30_000);
// One cached value, not a map. It was a Map keyed by tenant id, because the same
// process served every college and one cached ladder would have classified all of
// them. One process now serves one college, so the map only ever held one entry and
// the key was always the same string.
let cached = null; // { value, at } | null

// What a caller outside this module may see. An allowlist rather than the row, so a
// column added tomorrow (an internal note, a "who last edited this") is private
// until someone publishes it deliberately — the same rule as branding's
// PUBLIC_FIELDS, and the reason a stored blob cannot leak a field nobody reviewed.
const BAND_FIELDS = ["key", "label", "min", "max", "colour", "emailTrigger"];

/** One band, reduced to the published fields, in a fixed key order. */
function toPublic(band) {
  const out = {};
  for (const f of BAND_FIELDS) out[f] = band[f];
  return out;
}

/**
 * This institution's attendance bands: what it saved, or the platform defaults.
 *
 * Always a complete, VALID list — never null, never partial — so no caller needs a
 * fallback of its own and no caller can classify a student against half a ladder.
 */
async function get() {
  if (TTL_MS > 0 && cached && Date.now() - cached.at < TTL_MS) return cached.value;

  let row = null;
  try {
    row = await prisma.attendanceBandConfig.findFirst();
  } catch {
    row = null; // table not migrated yet — the defaults are correct, not an error
  }

  // Re-validated on the way OUT, not only on the way in. A row can predate a rule,
  // or be edited by hand in a console, and a list with a gap in it silently drops
  // students out of the send. Falling back to the defaults keeps every student
  // classified; the alternative is a college quietly emailing nobody.
  let value = bands.DEFAULT_BANDS.map(toPublic);
  if (row && Array.isArray(row.bands)) {
    const checked = bands.normaliseBands(row.bands);
    if (checked.ok) value = checked.bands.map(toPublic);
    else console.error(`[attendance-bands] the stored band list is unusable (${checked.error}) — using the defaults`);
  }

  cached = { value, at: Date.now() };
  return value;
}

/**
 * Replace this institution's bands. `list` is whatever the administrator submitted;
 * it is validated here, so no caller can write a list that get() would then refuse.
 * Returns { ok: true, bands } or { ok: false, error } — the error is the message the
 * administrator is shown, and it names the band and the problem.
 *
 * Passing null RESETS to the platform defaults by deleting the row: "no row" and "a
 * row that happens to hold the default six" then mean the same thing they do in
 * branding — this college has never customised anything.
 */
async function save(list, updatedBy) {
  if (list === null) {
    // deleteMany rather than delete: "reset" means the table ends up empty, and
    // delete on a missing row throws P2025 — an administrator pressing Reset twice
    // is not an error. The empty `where` also catches a row created before the id
    // became a constant, which `{ id: CONFIG_ID }` would leave behind, silently
    // making the reset do nothing.
    await prisma.attendanceBandConfig.deleteMany({});
    invalidate();
    return { ok: true, bands: bands.DEFAULT_BANDS.map(toPublic), reset: true };
  }

  const checked = bands.normaliseBands(list);
  if (!checked.ok) return { ok: false, error: checked.error };
  const stored = checked.bands.map(toPublic);

  const data = { bands: stored, updatedBy: updatedBy || null };
  // upsert on the constant key, not findFirst-then-create. Find-then-create is not
  // atomic: two administrators saving at the same moment both find nothing and both
  // create, after which findFirst returns whichever row Postgres feels like and half
  // this college's band edits are invisible. The constant primary key makes the
  // second writer collide with the first instead, which is the whole point of it.
  await prisma.attendanceBandConfig.upsert({
    where: { id: CONFIG_ID },
    update: data,
    create: { id: CONFIG_ID, ...data },
  });

  invalidate();
  return { ok: true, bands: stored };
}

/** Whether this college has bands of its own, or is running on the defaults. */
async function isCustomised() {
  try {
    return Boolean(await prisma.attendanceBandConfig.findFirst({ select: { id: true } }));
  } catch {
    return false;
  }
}

/** Drop the cached list — called after every save. */
const invalidate = () => { cached = null; };

module.exports = { get, save, invalidate, isCustomised, toPublic, BAND_FIELDS };
