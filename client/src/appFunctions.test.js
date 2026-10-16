// The client half of the Develop App toggle. PURE: no React, no lucide, no DOM, so it
// runs under plain node the way navGroups.js and timetableView.js do.
//
// WHY IT IS WORTH A TEST IN A CLIENT WITH NO TEST FRAMEWORK. There are exactly two
// things this module can get wrong, and both are silent:
//
//   FAIL CLOSED ON A MISSING PAYLOAD — an app build that is older than the server, or
//     a server that could not read the config row, sends no payload. Reading that as
//     "nothing is enabled" renders an app with no navigation at all. Every student in
//     the college, on an aeroplane-mode launch or a mid-deploy refresh, sees a blank
//     shell. The server fails OPEN for this exact reason and so must this.
//
//   IGNORE THE COLLEGE'S ORDER — the whole point of the reorder control is that the
//     stored order decides the nav, so filtering the client's own hardcoded list and
//     keeping ITS order silently discards half the feature. It would look correct,
//     because the default stored order IS the client's order.
//
// Run with: node --test src/appFunctions.test.js   (from client/)
import test from "node:test";
import { strict as assert } from "node:assert";

import { isOn, labelOf, filterByApp, resolveScreen } from "./appFunctions.js";

const TABS = [
  { key: "home", label: "Student Hub" },
  { key: "checkin", label: "Check In" },
  { key: "attendance", label: "My Attendance" },
  { key: "more", label: "More" },
];

/* ------------------------------------------------------------------ failing open */

test("no payload at all means every function is on", () => {
  // The case that must never regress. An app older than the server, or a server that
  // could not read the config row, sends nothing — and the app must behave exactly as
  // it did before this feature existed.
  for (const app of [null, undefined, {}, "nonsense", 42]) {
    assert.equal(isOn(app, "attendance"), true, `isOn went false for ${JSON.stringify(app)}`);
    assert.deepEqual(filterByApp(TABS, app), TABS, `filterByApp emptied the nav for ${JSON.stringify(app)}`);
  }
});

test("a payload whose functions list is not an array means every function is on", () => {
  // Same hazard arriving one level deeper: `{ app: { functions: null } }` is what a
  // half-written serialiser produces, and it must not blank the navigation either.
  for (const functions of [null, undefined, "home,more", 7, {}]) {
    assert.equal(isOn({ functions }, "attendance"), true);
    assert.deepEqual(filterByApp(TABS, { functions }), TABS);
  }
});

/* ---------------------------------------------------------------------- isOn */

test("a function named in the payload is on", () => {
  assert.equal(isOn({ functions: ["home", "attendance"] }, "attendance"), true);
});

test("a function absent from the payload is off", () => {
  assert.equal(isOn({ functions: ["home", "attendance"] }, "checkin"), false);
});

test("an empty list is authoritative, not read as unrestricted", () => {
  // An empty array is a real answer -- "this surface offers nothing" -- and is
  // distinguishable from a MISSING list, which means "no restrictions". Conflating the
  // two is how fail-open becomes fail-open-always and the toggle stops working at the
  // one college that switched everything off. The server guarantees the locked screens
  // are always present, so an empty list should never arrive in practice; if it does,
  // it is a server bug and hiding it here would make it unfindable.
  assert.equal(isOn({ functions: [] }, "home"), false);
  assert.deepEqual(filterByApp(TABS, { functions: [] }), []);
});

/* -------------------------------------------------------------------- labelOf */

test("a renamed function reports the college's wording", () => {
  assert.equal(labelOf({ labels: { attendance: "Attendance %" } }, "attendance", "My Attendance"), "Attendance %");
});

test("a function the college did not rename reports our wording", () => {
  assert.equal(labelOf({ labels: {} }, "attendance", "My Attendance"), "My Attendance");
  assert.equal(labelOf(null, "attendance", "My Attendance"), "My Attendance");
});

test("a blank or non-string override does not blank the label", () => {
  // A nav entry with no words in it cannot be clicked back. The server already refuses
  // to store one, so this is the second of two rails.
  for (const bad of ["", "   ", 42, null, {}]) {
    assert.equal(labelOf({ labels: { attendance: bad } }, "attendance", "My Attendance"), "My Attendance",
      `an override of ${JSON.stringify(bad)} replaced the label`);
  }
});

/* ----------------------------------------------------------------- filterByApp */

test("a switched-off function is dropped from the nav", () => {
  const out = filterByApp(TABS, { functions: ["home", "attendance", "more"] });
  assert.deepEqual(out.map((t) => t.key), ["home", "attendance", "more"]);
});

test("the nav follows the COLLEGE's order, not the client's", () => {
  // THE SECOND SILENT BUG. The reorder control's entire effect is that the stored order
  // decides the nav. Filtering the client's own list and keeping its order would look
  // right in every default configuration -- because the default stored order IS this
  // order -- and do nothing at the one college that reordered anything.
  const out = filterByApp(TABS, { functions: ["more", "attendance", "home"] });
  assert.deepEqual(out.map((t) => t.key), ["more", "attendance", "home"]);
});

test("filterByApp applies the college's labels as it goes", () => {
  const out = filterByApp(TABS, { functions: ["home", "attendance"], labels: { attendance: "Attendance %" } });
  assert.equal(out.find((t) => t.key === "attendance").label, "Attendance %");
  assert.equal(out.find((t) => t.key === "home").label, "Student Hub", "an un-renamed entry lost its label");
});

test("filterByApp keeps every other field on the entry", () => {
  // The entries carry an Icon component and sometimes a `group`. Rebuilding them from
  // key and label alone would silently drop the glyph from every tab.
  const withIcon = [{ key: "home", label: "Home", Icon: "GLYPH", group: "g1" }];
  const out = filterByApp(withIcon, { functions: ["home"] });
  assert.equal(out[0].Icon, "GLYPH");
  assert.equal(out[0].group, "g1");
});

test("a function the college offers but this app build does not have is ignored", () => {
  // The payload is authoritative about what is ON, never about what EXISTS. A key the
  // server knows and this bundle does not -- a screen added in a later release, reaching
  // an app from the store that has not updated -- must not produce a nav entry that
  // renders nothing and cannot be opened.
  const out = filterByApp(TABS, { functions: ["home", "a-screen-from-the-future", "more"] });
  assert.deepEqual(out.map((t) => t.key), ["home", "more"]);
});

test("filterByApp tolerates a missing or odd item list", () => {
  assert.deepEqual(filterByApp(null, { functions: ["home"] }), []);
  assert.deepEqual(filterByApp(undefined, null), []);
});

/* ---------------------------------------------------------------- resolveScreen */

test("an enabled screen is left alone", () => {
  assert.equal(resolveScreen("attendance", { functions: ["home", "attendance"] }, "home"), "attendance");
});

test("a switched-off screen falls back to the root", () => {
  // Reachable three ways that have nothing to do with the tab bar: a push notification
  // deep link, a restored session that remembered the screen, and a Home-screen shortcut
  // to a screen the college switched off this morning. Rendering it would show a screen
  // whose every request 403s -- an app that looks broken rather than one that is
  // configured.
  assert.equal(resolveScreen("assessments", { functions: ["home", "more"] }, "home"), "home");
});

test("resolveScreen leaves everything alone when there is no payload", () => {
  assert.equal(resolveScreen("assessments", null, "home"), "assessments");
});

test("resolveScreen never returns a root that is itself switched off", () => {
  // Pathological, and deliberately handled rather than left to produce a blank screen:
  // `home` is locked on the server and cannot be switched off, so reaching this means
  // the payload is already wrong. Returning the requested screen is the lesser evil --
  // one screen that may 403, rather than a shell rendering nothing at all.
  assert.equal(resolveScreen("assessments", { functions: [] }, "home"), "assessments");
});
