// The attendance bands ONE college monitors its students against.
//
// WHY THIS IS PER TENANT
//
// The six bands in attendanceBands.js (85+, 70–84, 60–69, 50–59, 40–49, 0–39) are
// one college's policy, written into the code. Another college warns at 75% and
// escalates at 60%; another runs three bands and only emails the bottom one; a
// college with a Student-visa cohort has a hard 80% line that the six-band ladder
// cannot express at all. Monitoring students against another institution's
// thresholds is not a cosmetic mismatch — it decides who receives a letter telling
// them their place is at risk, and who does not.
//
// So the bands are DATA. This module is their single resolver, in the shape
// branding.js established: a per-tenant row, defaults that make an unconfigured
// college behave exactly as it did before, an allowlist on the way out, and a short
// cache invalidated on save.
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
const { currentTenantId } = require("./db");
const bands = require("./attendanceBands");

// Short, matching branding.js and integrationConfig.js. This is read on every
// attendance computation and every send, it changes about never, and an
// administrator who has just moved a threshold should see students move band while
// they are still looking at the screen.
const TTL_MS = Number(process.env.ATTENDANCE_BANDS_CACHE_MS ?? 30_000);
const cache = new Map(); // tenantId -> { value, at }

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
  const tenantId = currentTenantId();
  // Outside a request — a script, a one-off — there is no institution to look up.
  // The defaults are the honest answer, and they are the behaviour this system had
  // before bands were configurable.
  if (!tenantId) return bands.DEFAULT_BANDS.map(toPublic);

  const hit = cache.get(tenantId);
  if (TTL_MS > 0 && hit && Date.now() - hit.at < TTL_MS) return hit.value;

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
    else console.error(`[attendance-bands] tenant ${tenantId} has an unusable stored band list (${checked.error}) — using the defaults`);
  }

  cache.set(tenantId, { value, at: Date.now() });
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
  const tenantId = currentTenantId();
  const existing = await prisma.attendanceBandConfig.findFirst();

  if (list === null) {
    if (existing) await prisma.attendanceBandConfig.delete({ where: { id: existing.id } });
    invalidate(tenantId);
    return { ok: true, bands: bands.DEFAULT_BANDS.map(toPublic), reset: true };
  }

  const checked = bands.normaliseBands(list);
  if (!checked.ok) return { ok: false, error: checked.error };
  const stored = checked.bands.map(toPublic);

  const data = { bands: stored, updatedBy: updatedBy || null };
  if (existing) await prisma.attendanceBandConfig.update({ where: { id: existing.id }, data });
  else await prisma.attendanceBandConfig.create({ data });

  invalidate(tenantId);
  return { ok: true, bands: stored };
}

/** Whether this college has bands of its own, or is running on the defaults. */
async function isCustomised() {
  if (!currentTenantId()) return false;
  try {
    return Boolean(await prisma.attendanceBandConfig.findFirst({ select: { id: true } }));
  } catch {
    return false;
  }
}

/** Drop the cached list — called after every save. */
const invalidate = (tenantId) => (tenantId ? void cache.delete(tenantId) : cache.clear());

module.exports = { get, save, invalidate, isCustomised, toPublic, BAND_FIELDS };
