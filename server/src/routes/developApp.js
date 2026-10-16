// Develop App — which functions this college offers, on each of its two app surfaces.
//
// SUPER-ADMIN ONLY, and not grantable as a page. This is the same decision the Access
// screen made and for the same reason: a screen that can switch a function off for the
// whole institution is not a department's tool, and handing it out as a page grant
// would let anybody holding that grant remove a colleague's work from the app. There is
// deliberately no "develop-app" key in ADMIN_PAGES — a key that existed would appear as
// a checkbox on the Access screen, which is precisely what must not happen.
//
// WHY THE GUARD IS requireSuperAdmin RATHER THAN requirePage("settings"). Settings is
// grantable, and several colleges grant it to a registrar or an office manager so they
// can edit letter wording and attendance thresholds. Those are reversible, bounded
// edits to how a feature behaves. Switching a feature OFF is neither bounded nor
// obviously reversible to somebody who did not do it — the screen simply stops being
// there for everybody — so it sits one level up.
//
// IT IS ALSO NOT GATED ON ITSELF. requireAnyPage now asks whether a page is switched on
// before asking who holds it, and a screen that can switch pages off must never be
// reachable through that mechanism: one save switching "develop-app" off would make the
// switch unreachable, permanently, with no route back that does not involve a database
// console. The registry has no entry for it, so there is nothing to switch.
const express = require("express");
const { requireAuth, requireSuperAdmin } = require("./../auth");
const { APP_FUNCTIONS, LOCKED, SURFACES, fnId, isEnabled, labelFor, surfaceView } = require("./../appFunctions");
const config = require("./../appFunctionConfig");
const audit = require("./../audit");

const router = express.Router();

// Every guard on every route in this file, stated once. requireAuth first so that
// requireSuperAdmin has a user to judge.
router.use(requireAuth, requireSuperAdmin);

/**
 * One function as this screen needs to draw it: what it is, what the college calls it,
 * whether it is on, and whether it may be switched off at all.
 *
 * AN ALLOWLIST, not the registry entry spread into JSON. `routes` is the obvious thing
 * that must not travel: it is the server's enforcement map, it is of no use to the
 * screen, and publishing it hands anybody who opens devtools a precise list of the
 * endpoints behind each toggle. The house rule is allowlists on the way out
 * (conventions.md), and the reason it is a rule is that `sAdmission` once stripped a
 * fixed list of secrets instead, so every column added afterwards shipped by default.
 */
const toPublic = (settings, f) => ({
  id: fnId(f.surface, f.key),
  key: f.key,
  surface: f.surface,
  // The registry's own wording, always — so the screen can show what a renamed
  // function was originally called, and offer to clear the override.
  defaultLabel: f.label,
  // What the college calls it now: the override, or the default.
  label: labelFor(settings, f.surface, f.key),
  enabled: isEnabled(settings.functions, f.surface, f.key),
  locked: LOCKED.has(fnId(f.surface, f.key)),
});

// Both surfaces as the apps themselves would receive them. Returned from the two write
// routes so the screen can show the administrator the nav they have just produced
// without a second request — and so that what it shows them is computed by the same
// code the apps use, rather than by the screen re-deriving it and disagreeing.
const viewAll = (settings) =>
  Object.fromEntries(SURFACES.map((s) => [s, surfaceView(settings, s)]));

// GET /api/develop-app — everything the screen needs to render both tabs.
router.get("/", async (req, res) => {
  const settings = await config.get();
  const functions = APP_FUNCTIONS.map((f) => toPublic(settings, f));
  res.json({
    // Grouped by surface because the screen has a tab per surface, so the client does
    // not have to partition it and cannot partition it differently from the server.
    staff: functions.filter((f) => f.surface === "staff"),
    student: functions.filter((f) => f.surface === "student"),
    // The stored order, if the college set one. Absent surfaces mean "registry order",
    // which the two lists above are already in.
    order: settings.order,
    customised: await config.isCustomised(),
  });
});

// PUT /api/develop-app — save the toggles, the renames and the order.
//
// Takes the whole settings object and REPLACES it, rather than patching one function at
// a time. Switching a function back on is done by removing its key, and a per-function
// PATCH endpoint cannot express that without a DELETE verb per function; more
// importantly, a screen with 45 toggles that saved each one separately would leave a
// college's configuration half-applied whenever a save failed midway.
router.put("/", async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "Expected a settings object." });
  }

  const before = await config.get();
  const settings = await config.save(
    { functions: body.functions, labels: body.labels, order: body.order },
    req.user?.email || req.user?.id || null,
  );

  // WORTH AUDITING, and audited as a COUNT and a LIST OF KEYS rather than as a diff of
  // the whole object. Switching a screen off removes it for every member of staff or
  // every student at once, which is the blast radius the audit trail exists for; but
  // the raw before/after would be two 45-key objects that nobody reads. The keys that
  // CHANGED are the answer to "what did they do".
  const offBefore = Object.keys(before.functions || {});
  const offAfter = Object.keys(settings.functions || {});
  const switchedOff = offAfter.filter((k) => !offBefore.includes(k));
  const switchedOn = offBefore.filter((k) => !offAfter.includes(k));
  const renamed = Object.keys(settings.labels || {})
    .filter((k) => (before.labels || {})[k] !== settings.labels[k]);

  audit.record(req, {
    action: "developApp.saved", entity: "AppFunctionConfig", entityId: config.CONFIG_ID,
    summary: [
      switchedOff.length ? `switched off ${switchedOff.join(", ")}` : null,
      switchedOn.length ? `switched on ${switchedOn.join(", ")}` : null,
      renamed.length ? `renamed ${renamed.join(", ")}` : null,
    ].filter(Boolean).join("; ") || "saved with no change",
    before: { disabled: offBefore, labels: before.labels },
    after: { disabled: offAfter, labels: settings.labels },
  });

  res.json({ saved: true, settings, surfaces: viewAll(settings) });
});

// DELETE /api/develop-app — back to offering everything, under our own wording.
router.delete("/", async (req, res) => {
  const existed = await config.isCustomised();
  const settings = await config.save(null, req.user?.email || req.user?.id || null);
  if (existed) {
    audit.record(req, {
      action: "developApp.reset", entity: "AppFunctionConfig", entityId: config.CONFIG_ID,
      summary: "Every app function restored to the platform defaults",
    });
  }
  res.json({ reset: existed, settings, surfaces: viewAll(settings) });
});

module.exports = router;
