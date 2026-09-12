// This college's Teams automation settings, resolved and cached.
//
// The DB-backed half of teamsAutomationSettings.js, in the shape branding.js,
// attendanceBandConfig.js and teamsAttendanceConfig.js established: ONE settings row
// for this institution, defaults that make an unconfigured college behave exactly as it
// did before (both switches off — see constraints.md), an allowlist on the way out (in
// the settings module), and a short cache invalidated on save.
//
// The row is one per deployment, not one per tenant — same singleton pattern as
// teamsAttendanceConfig.js, reached without a tenant to name — and it stays in the
// database rather than moving to environment variables because an administrator turns
// meeting-creation or Team-provisioning on from the Settings screen, and a value only
// changeable by a deploy is not a setting.
const prisma = require("./db");
// Only merge() is needed here; DEFAULTS is applied as merge()'s own base when there is
// nothing stored, same as teamsAttendanceConfig.js.
const { merge } = require("./teamsAutomationSettings");

// The row's primary key is the constant "singleton". That constant IS the single-row
// guarantee. Writing through it (see save) makes two concurrent saves collide on the
// key rather than both succeeding — see configuration.md.
const CONFIG_ID = "singleton";

// Short, matching teamsAttendanceConfig.js and branding.js. This is read wherever a
// route or scheduler needs to know whether either switch is on, it changes about never,
// and an administrator who has just flipped a switch should see it take effect while
// still looking at the screen.
const TTL_MS = Number(process.env.TEAMS_AUTOMATION_CACHE_MS ?? 30_000);
// One cached value, not a map — one process serves one college, so a map would only
// ever hold one entry.
let cached = null; // { value, at } | null
// The last value the database actually confirmed, kept apart from the TTL cache above
// because it answers a different question. The cache says "recent enough not to ask
// again"; this says "the truth, the last time the database could be asked at all". It is
// what a read serves when the database cannot be reached, and it is NEVER set from a
// failure — see get().
let lastConfirmed = null;

function invalidate() {
  cached = null;
}

// Prisma's "the table does not exist" code. The one failure that genuinely means
// "nothing has been configured": the row's table has not been migrated in yet, so the
// defaults are the truth rather than a guess.
const TABLE_MISSING = "P2021";

/**
 * The settings in force for this institution. Always complete and always valid.
 *
 * A READ THAT FAILS DOES NOT INVENT SETTINGS — same reasoning as
 * teamsAttendanceConfig.js's get(). Treating every failure as "no row" would merge the
 * defaults over nothing and cache THAT for thirty seconds, so a pooler blip mid-run
 * would switch automation off for half a minute and a scheduler tick that should have
 * created a meeting would be told "automation isn't switched on" for what was a
 * connectivity fault, not a college's choice. Local Postgres never blips; a shared
 * Supabase pooler can.
 *
 * Now a failed read serves the last value the database confirmed, if there is one, and
 * throws if there is none: the caller sees a genuine server fault rather than a false
 * "switched off". Nothing about a failure is ever cached, so the next read that reaches
 * the database wins immediately.
 */
async function get() {
  if (TTL_MS > 0 && cached && Date.now() - cached.at < TTL_MS) return cached.value;

  let row = null;
  try {
    row = await prisma.teamsAutomationConfig.findFirst();
  } catch (e) {
    if (e?.code !== TABLE_MISSING) {
      if (lastConfirmed) return lastConfirmed;
      throw e;
    }
    row = null; // table not migrated yet — the defaults are correct, not an error
  }

  // Re-validated on the way OUT, not only on the way in: a row can predate a rule or be
  // edited by hand in a console, and merge() is what guarantees no caller is handed a
  // value the scheduler would act on wrongly. With no row at all the defaults apply, and
  // they carry both switches false — so a college that has never opened this screen
  // triggers no Graph calls at all.
  const value = merge(row?.settings);
  cached = { value, at: Date.now() };
  lastConfirmed = value;
  return value;
}

/**
 * Merge a patch into this college's settings.
 *
 * A PATCH, not a replacement: an administrator switching on meeting-creation should not
 * silently switch off Team-provisioning nobody asked to change. The allowlist and the
 * boolean-only coercion live in merge(), so nothing written here can be read back as
 * unusable.
 */
async function save(patch, updatedBy) {
  const existing = await prisma.teamsAutomationConfig.findFirst();
  // The current settings are the BASE, and the patch is merged over them. Spreading the
  // two together and merging over DEFAULTS looked equivalent and was not: merge() drops
  // an unusable value and falls back to its base, so with DEFAULTS as the base a single
  // malformed key reset the neighbour switch — which is exactly what the paragraph above
  // promises will not happen.
  const current = merge(existing?.settings);
  const next = merge(patch, current);

  // upsert on the constant key, not findFirst-then-create. Find-then-create is not
  // atomic: two administrators saving at the same moment both find nothing and both
  // create, after which findFirst returns an arbitrary one of the two rows and half this
  // college's settings silently vanish. The constant primary key makes the second
  // writer collide with the first instead, which is what the key is for.
  //
  // The read above is still a read-modify-write and so still races on the CONTENT of
  // the patch — the loser's field is overwritten by the winner. That is the ordinary
  // last-write-wins any settings form has, and it costs one field rather than the row.
  const data = { settings: next, updatedBy: updatedBy || null };
  await prisma.teamsAutomationConfig.upsert({
    where: { id: CONFIG_ID },
    update: data,
    create: { id: CONFIG_ID, ...data },
  });

  invalidate();
  // The database has just confirmed THIS value, so it is what a failed read serves from
  // here on. Without this line an administrator's switch-off, followed by a pooler blip
  // before any read succeeded, would have been served as the earlier "on".
  lastConfirmed = next;
  return { ok: true, settings: next };
}

/** Whether this college has settings of its own, or is running on the defaults. */
async function isCustomised() {
  try {
    return Boolean(await prisma.teamsAutomationConfig.findFirst({ select: { id: true } }));
  } catch {
    return false;
  }
}

module.exports = { get, save, invalidate, isCustomised };
