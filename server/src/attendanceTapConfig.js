// This college's tap check-in settings, resolved and cached.
//
// The DB-backed half of attendanceTapSettings.js, in the shape branding.js and
// attendanceBandConfig.js established: a per-tenant row, defaults that make an
// unconfigured college behave exactly as it did before, an allowlist on the way out
// (in the settings module), and a short cache invalidated on save.
//
// No unit test on this file, deliberately: every line of it is a Prisma call or a cache
// read, and the logic worth testing was split into attendanceTapSettings.js precisely so
// it could be tested without a database. The smoke suite covers this one.
const prisma = require("./db");
const { currentTenantId } = require("./db");
const { DEFAULTS, merge } = require("./attendanceTapSettings");

// Short, matching branding.js and attendanceBandConfig.js. This is read on every tap, it
// changes about never, and an administrator who has just switched the feature on should
// see it work while they are still looking at the screen.
const TTL_MS = Number(process.env.ATTENDANCE_TAP_CACHE_MS ?? 30_000);
const cache = new Map(); // tenantId -> { value, at }

function invalidate(tenantId) {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

/**
 * The settings in force for the current institution. Always complete and always valid.
 */
async function get() {
  const tenantId = currentTenantId();
  // Outside a request — a script, a one-off — there is no institution to look up, and
  // the defaults are the honest answer. They carry enabled:false, so nothing running
  // outside a request can accidentally mark anybody.
  if (!tenantId) return { ...DEFAULTS };

  const hit = cache.get(tenantId);
  if (TTL_MS > 0 && hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let row = null;
  try {
    row = await prisma.attendanceTapConfig.findFirst();
  } catch {
    row = null; // table not migrated yet — the defaults are correct, not an error
  }

  // Re-validated on the way OUT, not only on the way in: a row can predate a rule or be
  // edited by hand in a console, and merge() is what guarantees no caller is handed a
  // value the resolver would choke on.
  const value = merge(row?.settings);
  cache.set(tenantId, { value, at: Date.now() });
  return value;
}

/**
 * Merge a patch into this college's settings.
 *
 * A PATCH, not a replacement: an administrator switching the feature on should not
 * silently reset a lateness threshold somebody tuned last term. The allowlist and the
 * caps live in merge(), so nothing written here can be read back as unusable.
 */
async function save(patch, updatedBy) {
  const tenantId = currentTenantId();
  const existing = await prisma.attendanceTapConfig.findFirst();
  const next = merge({ ...(existing?.settings || {}), ...(patch || {}) });

  if (existing) {
    await prisma.attendanceTapConfig.update({ where: { id: existing.id }, data: { settings: next, updatedBy: updatedBy || null } });
  } else {
    await prisma.attendanceTapConfig.create({ data: { settings: next, updatedBy: updatedBy || null } });
  }

  invalidate(tenantId);
  return { ok: true, settings: next };
}

/** Whether this college has settings of its own, or is running on the defaults. */
async function isCustomised() {
  if (!currentTenantId()) return false;
  try {
    return Boolean(await prisma.attendanceTapConfig.findFirst({ select: { id: true } }));
  } catch {
    return false;
  }
}

module.exports = { get, save, invalidate, isCustomised };
