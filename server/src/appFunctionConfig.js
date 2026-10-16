// Which functions this college offers — the stored half of the Develop App screen.
//
// The pure half is appFunctions.js: the registry of what a function IS, and the
// resolution of whether one is switched on. This file is only storage, and it is the
// eleventh table of the shape configuration.md describes:
//
//   platform defaults in code → one JSON column merged over them → no row until the
//   college edits something → an allowlist on the way out → a short cache invalidated
//   on save.
//
// attendanceBandConfig.js is the reference implementation and this follows it closely
// enough that a reader who knows that file already knows this one. Two differences are
// deliberate and both are explained where they happen: the stored object is REPLACED
// rather than merged (see save), and `get` returns a normalised object rather than a
// list (see get).
//
// WHY THE DEFAULTS ARE NOT A ROW. There is no row until an administrator changes
// something, and `{}` means "everything on". Seeding a row at migration time would
// make "this college has never configured anything" indistinguishable from "this
// college configured exactly today's defaults", and the next time a default changed it
// would not reach any college that had been through the migration. Same reasoning as
// branding and the attendance bands.
const prisma = require("./db");
const { normaliseSettings, surfaceView } = require("./appFunctions");

// The row's primary key is the constant "singleton". That constant IS the single-row
// guarantee — it replaced the old `@@unique([tenantId])` — and writing through it (see
// save) means two administrators saving at the same moment collide on the key rather
// than both inserting and leaving findFirst to pick between them.
const CONFIG_ID = "singleton";

// Short, matching branding.js, integrationConfig.js and attendanceBandConfig.js. This
// is read on every app bootstrap and on every gated student request, it changes about
// never, and an administrator who has just switched a screen off should see it go while
// they are still looking at the screen.
const TTL_MS = Number(process.env.APP_FUNCTIONS_CACHE_MS ?? 30_000);
let cached = null; // { value, at } | null

/**
 * This college's function settings: what it saved, or an empty object.
 *
 * Always a complete, VALID `{ functions, labels, order }` — never null, never partial
 * — so no caller needs a fallback of its own and no caller can gate a request against
 * half a config.
 *
 * NORMALISED ON THE WAY OUT, not only on the way in. A row can predate a rule, or be
 * edited by hand in a console, and the failure mode is not cosmetic: a stored
 * `"student:more": false` that normaliseSettings would have dropped on save would, if
 * trusted here, draw a locked toggle in the off position and leave an administrator
 * reporting a screen that will not switch off. Re-validating means the only shape any
 * reader sees is one this code would have written.
 */
async function get() {
  if (TTL_MS > 0 && cached && Date.now() - cached.at < TTL_MS) return cached.value;

  let row = null;
  try {
    row = await prisma.appFunctionConfig.findFirst();
  } catch (e) {
    // NARROWED TO A MISSING TABLE, DELIBERATELY, and this is the one place this file
    // does NOT follow attendanceBandConfig — which swallows everything here.
    //
    // A bare catch cost an afternoon during this feature's own development. The two
    // models were not yet declared in academicScopeModels.js, so every read threw
    // AcademicScopeError; the bare catch read that as "table not migrated yet" and
    // returned the empty defaults. The result was a screen that rendered correctly,
    // saved without error, reported success, and forgot every change — the most
    // expensive shape a bug can take, because nothing anywhere said no.
    //
    // A missing table is still swallowed, and must be: this is read on every app
    // bootstrap, and an empty config is genuinely CORRECT mid-migration — it means
    // every function is on, which is how the app behaved before the feature existed.
    // Throwing would take the student app down during a deploy instead.
    //
    // Anything else is a programming error and is allowed to be loud.
    const missingTable = e?.code === "P2021" || /does not exist/i.test(e?.message || "");
    if (!missingTable) throw e;
    row = null;
  }

  const value = normaliseSettings(row ? row.settings : {});
  cached = { value, at: Date.now() };
  return value;
}

/**
 * Replace this college's settings. `input` is whatever the administrator submitted; it
 * is normalised here, so no caller can write a shape `get` would then have to repair.
 *
 * REPLACED, NOT MERGED, and this is the one place this file diverges from the shallow
 * merge most of the config tables use. Switching a function back ON is done by
 * DELETING its key — that is what "absence means enabled" costs — and a merge cannot
 * express a deletion. Merging would mean a key, once written, survived every later
 * save: the screen would go off and never come back, and no amount of clicking the
 * toggle would fix it. attendanceBandConfig reaches the same conclusion from the same
 * direction for its band list ("a merge cannot express 'five bands where it had six'").
 *
 * Passing null RESETS by deleting the row, so "no row" and "a row that happens to hold
 * no changes" mean the same thing they do in branding: this college has never
 * customised anything.
 *
 * Returns the stored settings. There is no `{ ok: false }` path: normaliseSettings
 * drops what it cannot use rather than rejecting the save, which is the deliberate
 * choice explained in its own comment — one stale key from an older version must not
 * block every later edit on a screen with 45 toggles.
 */
async function save(input, updatedBy) {
  if (input === null) {
    // deleteMany rather than delete: "reset" means the table ends up empty, and delete
    // on a missing row throws P2025 — an administrator pressing Reset twice is not an
    // error. The empty `where` also catches a row created before the id became a
    // constant, which `{ id: CONFIG_ID }` would leave behind, silently making the reset
    // do nothing.
    await prisma.appFunctionConfig.deleteMany({});
    invalidate();
    return normaliseSettings({});
  }

  const settings = normaliseSettings(input);
  const data = { settings, updatedBy: updatedBy || null };
  // upsert on the constant key, not findFirst-then-create. Find-then-create is not
  // atomic: two administrators saving at the same moment both find nothing and both
  // create, after which findFirst returns whichever row Postgres feels like and half
  // this college's edits are invisible. The constant primary key makes the second
  // writer collide with the first instead, which is the whole point of it.
  await prisma.appFunctionConfig.upsert({
    where: { id: CONFIG_ID },
    update: data,
    create: { id: CONFIG_ID, ...data },
  });

  invalidate();
  return settings;
}

/**
 * The bootstrap payload for one surface — `{ functions, labels }`, plain keys.
 *
 * The apps call this rather than `get`, so that no client ever receives the other
 * surface's settings. A student's bootstrap naming every staff page the college
 * switched off is a small leak, but it is a leak of the college's internal
 * configuration to an audience with no reason for it, and an allowlist on the way out
 * is the house rule (conventions.md).
 */
async function viewFor(surface) {
  return surfaceView(await get(), surface);
}

/** Whether this college has changed anything, or is running on the defaults. */
async function isCustomised() {
  try {
    return Boolean(await prisma.appFunctionConfig.findFirst({ select: { id: true } }));
  } catch {
    return false;
  }
}

/** Drop the cached settings — called after every save. */
const invalidate = () => { cached = null; };

module.exports = { get, save, viewFor, isCustomised, invalidate, CONFIG_ID };
