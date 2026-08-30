// This college's tap check-in settings, resolved and cached.
//
// The DB-backed half of attendanceTapSettings.js, in the shape branding.js and
// attendanceBandConfig.js established: ONE settings row for this institution, defaults
// that make an unconfigured college behave exactly as it did before, an allowlist on
// the way out (in the settings module), and a short cache invalidated on save.
//
// The row used to be one per tenant. It is one per deployment now — same singleton,
// reached without a tenant to name — and the settings stayed in the database rather
// than moving to environment variables because an administrator turns tap check-in on
// from the Settings screen, and a value only changeable by a deploy is not a setting.
//
// No unit test on this file, deliberately: every line of it is a Prisma call or a cache
// read, and the logic worth testing was split into attendanceTapSettings.js precisely so
// it could be tested without a database. The smoke suite covers this one.
const prisma = require("./db");
// Only merge() is needed here. DEFAULTS used to be imported as well, for the
// "outside a request there is no institution to look up" early return that returned
// them directly; there is no such case now, and merge() applies them as its own base.
const { merge } = require("./attendanceTapSettings");

// The row's primary key is the constant "singleton". That constant IS the single-row
// guarantee — it replaced the old `@@unique([tenantId])`. Writing through it (see
// save) makes two concurrent saves collide on the key rather than both succeeding.
const CONFIG_ID = "singleton";

// Short, matching branding.js and attendanceBandConfig.js. This is read on every tap, it
// changes about never, and an administrator who has just switched the feature on should
// see it work while they are still looking at the screen.
const TTL_MS = Number(process.env.ATTENDANCE_TAP_CACHE_MS ?? 30_000);
// One cached value, not a map. It was keyed by tenant id because one process served
// every college; one process now serves one, so the map only ever held one entry.
let cached = null; // { value, at } | null

function invalidate() {
  cached = null;
}

/**
 * The settings in force for this institution. Always complete and always valid.
 */
async function get() {
  if (TTL_MS > 0 && cached && Date.now() - cached.at < TTL_MS) return cached.value;

  let row = null;
  try {
    row = await prisma.attendanceTapConfig.findFirst();
  } catch {
    row = null; // table not migrated yet — the defaults are correct, not an error
  }

  // Re-validated on the way OUT, not only on the way in: a row can predate a rule or be
  // edited by hand in a console, and merge() is what guarantees no caller is handed a
  // value the resolver would choke on. With no row at all the defaults apply, and they
  // carry enabled:false — so a college that has never opened this screen marks nobody.
  const value = merge(row?.settings);
  cached = { value, at: Date.now() };
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
  const existing = await prisma.attendanceTapConfig.findFirst();
  // The current settings are the BASE, and the patch is merged over them. Spreading the
  // two together and merging over DEFAULTS looked equivalent and was not: merge() drops
  // an unusable value and falls back to its base, so with DEFAULTS as the base a single
  // malformed key reset a neighbouring setting the college had tuned — which is exactly
  // what the paragraph above promises will not happen.
  const current = merge(existing?.settings);
  const next = merge(patch, current);

  // upsert on the constant key, not findFirst-then-create. Find-then-create is not
  // atomic: two administrators saving at the same moment both find nothing and both
  // create, after which findFirst returns an arbitrary one of the two rows and half
  // this college's settings silently vanish. The constant primary key makes the second
  // writer collide with the first instead, which is what the key is for.
  //
  // The read above is still a read-modify-write and so still races on the CONTENT of
  // the patch — the loser's field is overwritten by the winner. That is the ordinary
  // last-write-wins any settings form has, and it costs one field rather than the row.
  const data = { settings: next, updatedBy: updatedBy || null };
  await prisma.attendanceTapConfig.upsert({
    where: { id: CONFIG_ID },
    update: data,
    create: { id: CONFIG_ID, ...data },
  });

  invalidate();
  return { ok: true, settings: next };
}

/** Whether this college has settings of its own, or is running on the defaults. */
async function isCustomised() {
  try {
    return Boolean(await prisma.attendanceTapConfig.findFirst({ select: { id: true } }));
  } catch {
    return false;
  }
}

module.exports = { get, save, invalidate, isCustomised };
