// Which functions this college offers, as the two apps read it.
//
// The server decides; this file only applies the answer. `/auth/me` returns
// `app: { functions: [key], labels: { key: label } }` — already filtered to the signed-in
// surface, already in the college's chosen order, already carrying the college's own
// wording. Nothing here re-derives any of that.
//
// PURE: no React, no lucide, no DOM, so it runs under plain node beside its tests the
// way navGroups.js and timetableView.js do. Added to the explicit list in
// scripts/test.mjs — that list is deliberately not a glob (a glob would drag in every
// .jsx, none of which run under plain node).
//
// IT IS NOT A PERMISSION CHECK AND MUST NEVER BE READ AS ONE. Every function named here
// is also enforced on the server: requireAnyPage for a staff page, requireEnabledScreen
// for a student screen. This module decides what to DRAW. If it and the server ever
// disagree, the server wins and the user sees a 403 — which is the right way round. The
// hazard navGroups.js states in its own comments applies here too: "a second place that
// decides who sees what is a second place for it to be got wrong", so this one decides
// nothing, it reports.

// A payload is only authoritative once it actually carries a list of functions.
//
// THE DISTINCTION THIS DRAWS IS LOAD-BEARING: a MISSING list means "no restrictions",
// an EMPTY list means "this surface offers nothing". Collapsing the two is how failing
// open becomes failing open always, and the toggle would quietly stop working at the
// one college that switched a lot off.
const listOf = (app) => (app && typeof app === "object" && Array.isArray(app.functions) ? app.functions : null);

/**
 * Is this function switched on?
 *
 * FAILS OPEN when there is no payload, and that is the single most important line in
 * this file. An app build older than the server, or a server that could not read the
 * config row, sends nothing — and the app must then behave exactly as it did before
 * this feature existed. Reading "no payload" as "nothing enabled" renders a shell with
 * no navigation in it, for every student at once, on any mid-deploy refresh. The server
 * fails open in both of its guards for the same reason.
 */
export function isOn(app, key) {
  const list = listOf(app);
  if (!list) return true;
  return list.includes(key);
}

/**
 * What this college calls a function — its override, or the wording we shipped.
 *
 * A blank or non-string override is ignored rather than honoured. The server already
 * refuses to store one (an empty box is how a rename is UNDONE), so this is the second
 * of two rails; a nav entry with no words in it cannot be clicked back.
 */
export function labelOf(app, key, fallback) {
  const override = app && typeof app === "object" && app.labels ? app.labels[key] : null;
  if (typeof override === "string" && override.trim()) return override.trim();
  return fallback;
}

/**
 * Filter and order a nav list by what the college offers.
 *
 * ORDERED BY THE PAYLOAD, NOT BY `items`, and that is the whole effect of the reorder
 * control. Walking `items` and dropping what is off — the obvious implementation — keeps
 * the CLIENT's hardcoded order, which looks correct in every default configuration
 * (because the default stored order is the client's order) and does nothing at all for
 * a college that reordered anything. Its own test says so.
 *
 * Entries are SPREAD, not rebuilt: they carry an `Icon` component and sometimes a
 * `group`, and reconstructing them from key and label alone drops the glyph from every
 * tab in the app.
 *
 * A key the payload names and `items` does not have is skipped. The payload is
 * authoritative about what is ON, never about what EXISTS in this bundle — a screen
 * added in a later release reaches an app that has not updated from the store, and a nav
 * entry for it would render nothing and could not be opened.
 */
export function filterByApp(items, app) {
  if (!Array.isArray(items)) return [];
  const list = listOf(app);
  if (!list) return items;

  const byKey = new Map(items.map((i) => [i?.key, i]));
  const out = [];
  for (const key of list) {
    const item = byKey.get(key);
    if (!item) continue;
    out.push({ ...item, label: labelOf(app, key, item.label) });
  }
  return out;
}

/**
 * The screen to actually render, given the one that was asked for.
 *
 * A switched-off screen is reachable by three routes that never touch the tab bar: a
 * push-notification deep link, a restored session that remembered where it was, and a
 * shortcut from Home to something the college switched off this morning. Rendering it
 * shows a screen whose every request answers 403 — an app that looks broken rather than
 * one that is configured — so it falls back to the root instead.
 *
 * IF THE ROOT ITSELF IS OFF, the requested screen is returned unchanged. That state is
 * pathological: `home` is locked on the server and cannot be switched off, so reaching
 * it means the payload is already wrong. One screen that may 403 is a smaller failure
 * than a shell that renders nothing, and it leaves the bug visible instead of hiding it.
 */
export function resolveScreen(screen, app, root) {
  if (isOn(app, screen)) return screen;
  if (!isOn(app, root)) return screen;
  return root;
}
