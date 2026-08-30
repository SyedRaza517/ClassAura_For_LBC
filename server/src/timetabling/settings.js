// Reading and writing timetable display settings.
//
// The rules live next door in settingsDefaults.js and are tested without a database.
// This file is only the storage and the cache, in the shape attendanceBandConfig.js
// established.
const prisma = require("../db");
const { mergeSettings, cleanInstitution, cleanUser, DEFAULTS } = require("./settingsDefaults");

// Short, matching branding.js and attendanceBandConfig.js. These are read on every
// timetable load, change about never, and an administrator who has just edited the
// notice banner should see it while still looking at the screen.
//
// IN-PROCESS. Correct for one Node process; a clustered deployment would need Redis,
// and until then a second instance can serve a stale banner for up to TTL_MS.
// ONE ENTRY, NOT A MAP. This was keyed by tenant id because one process served
// every college. One process now serves one college, so the key had exactly one
// possible value and the Map was a dictionary with a single entry.
const TTL_MS = Number(process.env.TIMETABLE_SETTINGS_CACHE_MS ?? 30_000);
let cached = null; // { value, at }

// The tenant id parameter is gone. Callers that passed one — routes/timetabling.js
// among them — now call invalidate() with nothing, which is the whole cache.
function invalidate() {
  cached = null;
}

/** This college's stored settings, cleaned. `{}` when it has never edited anything. */
async function getInstitution() {
  // This used to return {} outside a request, because with no tenant resolved there
  // was no college to look up. A script now reads the same single row a request
  // does, so the defaults are no longer a special case for it.
  if (TTL_MS > 0 && cached && Date.now() - cached.at < TTL_MS) return cached.value;

  let row = null;
  try {
    row = await prisma.timetableSettings.findFirst();
  } catch {
    // Table not migrated yet. The defaults are the correct answer, not an error —
    // the same fallback attendanceBandConfig.js makes, and what keeps a partially
    // deployed environment showing a timetable rather than a stack trace.
    row = null;
  }

  const value = cleanInstitution(row?.display || {});
  cached = { value, at: Date.now() };
  return value;
}

/**
 * What this member of staff actually sees: platform defaults, the college's
 * settings, then their own. Always complete.
 *
 * The user row is NOT cached. There is one per person rather than one per college,
 * so the hit rate would be poor, and a lecturer who has just changed a setting is
 * the single reader most likely to reload immediately.
 */
async function getEffective(staffId) {
  const institution = await getInstitution();
  if (!staffId) return mergeSettings(institution, null);

  let row = null;
  try {
    row = await prisma.timetableUserPref.findFirst({ where: { staffId } });
  } catch {
    row = null;
  }
  return mergeSettings(institution, row?.display || {});
}

/**
 * Replace this college's settings. `patch` is merged over what is stored, so a
 * screen that sends only the field it changed does not blank the rest.
 *
 * Returns the college's new stored blob (not the merged view) — the admin screen
 * edits the college layer and must see the college layer, or an individual's
 * override would look like the college's own setting.
 */
async function saveInstitution(patch, updatedBy = "") {
  const existing = await prisma.timetableSettings.findFirst();
  const next = { ...cleanInstitution(existing?.display || {}), ...cleanInstitution(patch) };

  // UPSERT ON A CONSTANT ID, rather than the find-then-create this used to do.
  // TimetableSettings.id now defaults to "singleton" and is the primary key, which
  // is what replaced the per-tenant unique as the guarantee that this table holds
  // one row. Find-then-create is not atomic: two saves arriving together both found
  // nothing, both inserted, and findFirst afterwards returned whichever the planner
  // picked — half the college's settings silently lost. An upsert on a known id
  // cannot do that. "No row until a college edits something" still holds: nothing
  // creates the row except a save, exactly as in branding.js.
  await prisma.timetableSettings.upsert({
    where: { id: existing?.id || "singleton" },
    update: { display: next, updatedBy: String(updatedBy || "").slice(0, 200) },
    create: { display: next, updatedBy: String(updatedBy || "").slice(0, 200) },
  });

  invalidate();
  return next;
}

/** Replace one staff member's own overrides. Returns their new stored blob. */
async function saveUser(staffId, patch) {
  const existing = await prisma.timetableUserPref.findFirst({ where: { staffId } });
  const next = { ...cleanUser(existing?.display || {}), ...cleanUser(patch) };

  if (existing) await prisma.timetableUserPref.update({ where: { id: existing.id }, data: { display: next } });
  else await prisma.timetableUserPref.create({ data: { staffId, display: next } });

  return next;
}

module.exports = { getInstitution, getEffective, saveInstitution, saveUser, invalidate, DEFAULTS };
