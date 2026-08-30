// Reading and writing timetable display settings.
//
// The rules live next door in settingsDefaults.js and are tested without a database.
// This file is only the storage and the cache, in the shape attendanceBandConfig.js
// established.
const prisma = require("../db");
const { currentTenantId } = require("../db");
const { mergeSettings, cleanTenant, cleanUser, DEFAULTS } = require("./settingsDefaults");

// Short, matching branding.js and attendanceBandConfig.js. These are read on every
// timetable load, change about never, and an administrator who has just edited the
// notice banner should see it while still looking at the screen.
//
// IN-PROCESS. Correct for one Node process; a clustered deployment would need Redis,
// and until then a second instance can serve a stale banner for up to TTL_MS.
const TTL_MS = Number(process.env.TIMETABLE_SETTINGS_CACHE_MS ?? 30_000);
const tenantCache = new Map(); // tenantId -> { value, at }

function invalidate(tenantId) {
  if (tenantId) tenantCache.delete(tenantId);
  else tenantCache.clear();
}

/** This college's stored settings, cleaned. `{}` when it has never edited anything. */
async function getTenant() {
  const tenantId = currentTenantId();
  // Outside a request — a script, a one-off — there is no college to look up, and
  // the defaults are the honest answer.
  if (!tenantId) return {};

  const hit = tenantCache.get(tenantId);
  if (TTL_MS > 0 && hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let row = null;
  try {
    row = await prisma.timetableSettings.findFirst();
  } catch {
    // Table not migrated yet. The defaults are the correct answer, not an error —
    // the same fallback attendanceBandConfig.js makes, and what keeps a partially
    // deployed environment showing a timetable rather than a stack trace.
    row = null;
  }

  const value = cleanTenant(row?.display || {});
  tenantCache.set(tenantId, { value, at: Date.now() });
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
  const tenant = await getTenant();
  if (!staffId) return mergeSettings(tenant, null);

  let row = null;
  try {
    row = await prisma.timetableUserPref.findFirst({ where: { staffId } });
  } catch {
    row = null;
  }
  return mergeSettings(tenant, row?.display || {});
}

/**
 * Replace this college's settings. `patch` is merged over what is stored, so a
 * screen that sends only the field it changed does not blank the rest.
 *
 * Returns the college's new stored blob (not the merged view) — the admin screen
 * edits the college layer and must see the college layer, or an individual's
 * override would look like the college's own setting.
 */
async function saveTenant(patch, updatedBy = "") {
  const tenantId = currentTenantId();
  const existing = await prisma.timetableSettings.findFirst();
  const next = { ...cleanTenant(existing?.display || {}), ...cleanTenant(patch) };

  if (existing) {
    await prisma.timetableSettings.update({
      where: { id: existing.id },
      data: { display: next, updatedBy: String(updatedBy || "").slice(0, 200) },
    });
  } else {
    // No row until a college edits something — so "no row" and "a row holding the
    // defaults" cannot both mean the same thing, exactly as in branding.js.
    await prisma.timetableSettings.create({
      data: { display: next, updatedBy: String(updatedBy || "").slice(0, 200) },
    });
  }

  invalidate(tenantId);
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

module.exports = { getTenant, getEffective, saveTenant, saveUser, invalidate, DEFAULTS };
