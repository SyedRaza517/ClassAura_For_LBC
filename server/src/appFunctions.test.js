// The function registry, tested without a database.
//
// WHY THIS FILE EXISTS AT ALL, when adminPages-contract.test.js already guards the page
// list. That test pins two hand-written copies of ADMIN_PAGES to each other; it says
// nothing about what a function IS, and nothing about the new question this registry
// answers: "is this function switched on in this deployment". The resolution logic for
// that question is pure -- a config object in, a boolean out, no Prisma -- so it lives
// here beside its tests the way prediction/ and vle/*Normalise.js do (see testing.md).
//
// WHY A FUNCTION IS IDENTIFIED BY SURFACE *AND* KEY, which is the first thing this file
// pins. Three keys exist on both surfaces -- `checkin`, `assessments` and `mitigations`
// are a staff page AND a student screen, and they are different screens doing different
// jobs for different people. A flat key namespace was the first design and these tests
// rejected it: storing `{ checkin: false }` would switch off the staff register and the
// student's own check-in together, from one toggle, on a screen whose two tabs exist
// precisely to keep those audiences apart. So the stored config is keyed
// `"<surface>:<key>"` and nothing in this module takes a bare key.
//
// The behaviours below are the ones that can lock a college out of its own installation
// or leak a screen that was switched off, so they are asserted rather than trusted:
//
//   1. an unconfigured college behaves EXACTLY as it did before this feature existed
//   2. a locked function cannot be switched off, whatever the stored config says
//   3. a student route resolves to the screen that owns it -- and `/me` never does
//
// Run with: node --test src/appFunctions.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  APP_FUNCTIONS, STAFF_PAGES, STUDENT_SCREENS, LOCKED,
  fnId, isEnabled, enabledKeys, screenForRoute,
} = require("./appFunctions");

/* ---------------------------------------------------------------- the registry itself */

test("every function declares a key, a surface and a label", () => {
  for (const f of APP_FUNCTIONS) {
    assert.ok(f.key, `a function has no key: ${JSON.stringify(f)}`);
    assert.ok(["staff", "student"].includes(f.surface),
      `${f.key} has surface "${f.surface}" -- only "staff" and "student" exist`);
    // A function with no label renders as an unlabelled toggle on the Develop App
    // screen, which is the same defect adminPages-contract.test.js was written for
    // after "prediction" and "mitigations" shipped with no PAGE_LABELS entry.
    assert.ok(f.label, `${f.key} has no label -- it would render as an unlabelled toggle`);
  }
});

test("no function id is declared twice", () => {
  // The id, not the key. `checkin` legitimately appears on both surfaces; what must
  // never appear twice is `staff:checkin`, because the config is a flat map and the
  // second entry would silently decide the first one's screen.
  const seen = new Set();
  const dupes = [];
  for (const f of APP_FUNCTIONS) {
    const id = fnId(f.surface, f.key);
    if (seen.has(id)) dupes.push(id);
    seen.add(id);
  }
  assert.deepEqual(dupes, [], `these ids are declared more than once: ${dupes.join(", ")}`);
});

test("the three keys that exist on both surfaces are still distinct functions", () => {
  // Pinning the collision itself, so that nobody "tidies" the registry by merging them.
  // If this fails because a key stopped being shared, delete the key from the list
  // deliberately -- do not delete the test.
  for (const key of ["checkin", "assessments", "mitigations"]) {
    const both = APP_FUNCTIONS.filter(f => f.key === key).map(f => f.surface).sort();
    assert.deepEqual(both, ["staff", "student"],
      `"${key}" was a shared key on both surfaces and is now ${JSON.stringify(both)}`);
  }
  // And the consequence that matters: switching off the staff one leaves the student
  // one alone. This is the assertion a flat namespace would have failed.
  const off = { "staff:checkin": false };
  assert.equal(isEnabled(off, "staff", "checkin"), false);
  assert.equal(isEnabled(off, "student", "checkin"), true,
    "switching off the staff register also switched off the student's check-in");
});

test("STAFF_PAGES and STUDENT_SCREENS partition the registry", () => {
  assert.equal(STAFF_PAGES.length + STUDENT_SCREENS.length, APP_FUNCTIONS.length);
  assert.deepEqual(STAFF_PAGES, APP_FUNCTIONS.filter(f => f.surface === "staff").map(f => f.key));
  assert.deepEqual(STUDENT_SCREENS, APP_FUNCTIONS.filter(f => f.surface === "student").map(f => f.key));
});

test("every locked id is a real function", () => {
  // A typo in LOCKED is the dangerous direction: the guard reads it to decide what may
  // never be switched off, so a misspelt id means the screen it was meant to protect is
  // switchable after all -- and `student:more` going off leaves a student with no way
  // to sign out.
  const ids = new Set(APP_FUNCTIONS.map(f => fnId(f.surface, f.key)));
  const unknown = [...LOCKED].filter(id => !ids.has(id));
  assert.deepEqual(unknown, [], `LOCKED names functions that do not exist: ${unknown.join(", ")}`);
});

/* ------------------------------------------------------------------------- isEnabled */

test("an unconfigured college has every function switched on", () => {
  // THE MOST IMPORTANT ASSERTION IN THIS FILE. The config table holds no row until an
  // administrator changes something, so every existing deployment reads `{}` here, and
  // anything other than "all on" would switch screens off on upgrade for colleges that
  // never asked for this feature.
  for (const f of APP_FUNCTIONS) {
    assert.equal(isEnabled({}, f.surface, f.key), true, `${f.key} is off with an empty config`);
    assert.equal(isEnabled(null, f.surface, f.key), true, `${f.key} is off with a null config`);
    assert.equal(isEnabled(undefined, f.surface, f.key), true, `${f.key} is off with no config`);
  }
});

test("an explicit false switches a function off", () => {
  assert.equal(isEnabled({ "student:attendance": false }, "student", "attendance"), false);
});

test("an explicit false leaves every other function alone", () => {
  assert.equal(isEnabled({ "student:attendance": false }, "student", "assessments"), true);
});

test("a locked function stays on however the config is written", () => {
  // The rail that stops an administrator removing their own way back in.
  for (const id of LOCKED) {
    const [surface, key] = id.split(":");
    assert.equal(isEnabled({ [id]: false }, surface, key), true,
      `${id} is locked but an explicit false switched it off -- that is a lockout`);
  }
});

test("an unknown function is not enabled", () => {
  // A key the registry does not declare reaches no screen and holds no meaning. Reading
  // it as enabled is the wrong default: it would let a stale config row, or a renamed
  // function, quietly re-open something nothing in the code gates any more.
  assert.equal(isEnabled({}, "student", "no-such-screen"), false);
  assert.equal(isEnabled({ "student:no-such-screen": true }, "student", "no-such-screen"), false);
  // And an unknown SURFACE, which is the same mistake arriving from the other side.
  assert.equal(isEnabled({}, "applicant", "home"), false);
});

test("a truthy non-boolean does not count as switched off", () => {
  // The stored JSON is written by an HTTP client, so the values are whatever arrived.
  // Only an explicit `false` means off; a string, a number or a null must not be able
  // to switch a screen off by accident.
  assert.equal(isEnabled({ "student:attendance": "false" }, "student", "attendance"), true);
  assert.equal(isEnabled({ "student:attendance": 0 }, "student", "attendance"), true);
  assert.equal(isEnabled({ "student:attendance": null }, "student", "attendance"), true);
});

/* ------------------------------------------------------------------------ enabledKeys */

test("enabledKeys returns one surface only, in registry order", () => {
  assert.deepEqual(enabledKeys({}, "student"), STUDENT_SCREENS);
  assert.deepEqual(enabledKeys({}, "staff"), STAFF_PAGES);
});

test("enabledKeys drops what the config switched off", () => {
  const out = enabledKeys({ "student:attendance": false }, "student");
  assert.ok(!out.includes("attendance"));
  assert.ok(out.includes("home"), "switching one screen off removed another");
});

test("enabledKeys is not confused by the other surface being switched off", () => {
  // The collision again, from the list side: switching off the staff register must not
  // shorten the student's tab bar.
  assert.deepEqual(enabledKeys({ "staff:checkin": false }, "student"), STUDENT_SCREENS);
});

/* --------------------------------------------------------------------- screenForRoute */

test("a student route resolves to the screen that owns it", () => {
  assert.equal(screenForRoute("/me/attendance"), "attendance");
  assert.equal(screenForRoute("/me/assessments"), "assessments");
  assert.equal(screenForRoute("/me/mitigations"), "mitigations");
});

test("the bootstrap route is never owned by a screen", () => {
  // `/me` is what tells the client who is signed in and which functions are on. It is a
  // prefix of every other student route, so a careless prefix match would hand it to
  // whichever screen sorted first -- and gating it would sign out every student in the
  // college the moment that screen was switched off.
  assert.equal(screenForRoute("/me"), null);
  assert.equal(screenForRoute("/me/"), null);
});

test("a nested route resolves to its screen, not to a shorter neighbour", () => {
  // `/me/referrals/:id/messages` belongs to Support. Exact matching alone would miss it
  // (the id varies), so the lookup falls back to the longest declared prefix.
  assert.equal(screenForRoute("/me/referrals/42/messages"), "support");
  assert.equal(screenForRoute("/me/referrals"), "support");
  assert.equal(screenForRoute("/me/notifications/read"), "inbox");
});

test("a prefix only matches on a segment boundary", () => {
  // THE BUG THIS PINS, and it is pinned on a route that is NOT declared so that the
  // assertion actually discriminates. `/me/attendance` is a prefix of the STRING
  // `/me/attendance-summary`, so a naive startsWith would gate a hypothetical new
  // endpoint behind the Attendance toggle without anybody having declared it there.
  // Resolving to null instead means a route added later is gated only once somebody
  // lists it deliberately -- never by the accident of how it was spelt.
  assert.equal(screenForRoute("/me/attendance-summary"), null);
  // Whereas the real sibling IS declared, and resolves because it is listed, not
  // because it shares a prefix.
  assert.equal(screenForRoute("/me/attendance-bands"), "attendance");
});

test("an unrecognised route is not owned by any screen", () => {
  // An ungated route is the safe answer here and the deliberate one: this registry
  // decides what the DEVELOP APP toggle covers, not who may call an endpoint. A route
  // nobody declared stays as protected as it was before this feature existed --
  // requireAuth and the student router allowlist still apply.
  assert.equal(screenForRoute("/me/something-new"), null);
  assert.equal(screenForRoute("/not-even-me"), null);
  assert.equal(screenForRoute(""), null);
  assert.equal(screenForRoute(null), null);
});

test("every declared student route resolves back to its own screen", () => {
  // The join between the two halves of each registry entry. A route listed under the
  // wrong screen gates the wrong toggle, which is silent in both directions: the screen
  // stays visible with a dead API, or a switched-off screen keeps answering.
  for (const f of APP_FUNCTIONS) {
    for (const r of f.routes || []) {
      assert.equal(screenForRoute(r), f.key,
        `${r} is declared under "${f.key}" but resolves to "${screenForRoute(r)}"`);
    }
  }
});

test("only student functions declare routes", () => {
  // Staff pages are gated by requirePage on their own routers, which is a mechanism
  // that already exists and already works. Declaring routes for them here would create
  // a second place that decides who reaches a staff endpoint -- the hazard navGroups.js
  // states in its own comments. The student surface needs this map precisely BECAUSE it
  // has no per-route guard of its own (see STUDENT_ROUTERS in auth.js).
  const staffWithRoutes = APP_FUNCTIONS.filter(f => f.surface === "staff" && (f.routes || []).length);
  assert.deepEqual(staffWithRoutes.map(f => f.key), [],
    "staff pages must be gated by requirePage, not by a route map");
});

/* ===================================================================================
   normaliseSettings -- what arrives over HTTP, reduced to what may be stored.
   =================================================================================== */
//
// The stored shape is { functions, labels, order }: which functions are off, what the
// college renamed them to, and what order they sit in. All three arrive from an HTTP
// client, so all three are untrusted, and the failure modes are not symmetrical:
//
//   a bad `functions` entry takes a screen away from a college
//   a bad `labels` entry puts attacker-chosen text on every student's screen
//   a bad `order` entry can drop a screen out of the nav without switching it off
//
// So this normaliser DROPS what it does not recognise rather than rejecting the whole
// save. A rejected save is recoverable -- the administrator sees an error and tries
// again -- but a PARTIALLY applied one is not, and an all-or-nothing rule on a screen
// with 45 toggles means one stale key from an older version blocks every later edit.

const { normaliseSettings, LABEL_MAX } = require("./appFunctions");

test("an empty save stores an empty settings object", () => {
  const out = normaliseSettings({});
  assert.deepEqual(out, { functions: {}, labels: {}, order: {} });
});

test("a missing or non-object payload normalises to empty rather than throwing", () => {
  // The route validates before calling this, but a stored row re-read on the way OUT
  // can predate a rule or have been edited by hand in a console -- the same reason
  // attendanceBandConfig re-validates in get() and not only in save().
  for (const bad of [null, undefined, "nope", 42, []]) {
    assert.deepEqual(normaliseSettings(bad), { functions: {}, labels: {}, order: {} });
  }
});

test("only an explicit false is stored as off", () => {
  const out = normaliseSettings({ functions: { "student:attendance": false } });
  assert.deepEqual(out.functions, { "student:attendance": false });
});

test("a function left on is not stored at all", () => {
  // Absence means on, so storing `true` would be a second way of saying the same
  // thing -- and the row would grow a key per function the first time anybody opened
  // the screen and pressed Save without changing anything.
  const out = normaliseSettings({ functions: { "student:attendance": true } });
  assert.deepEqual(out.functions, {});
});

test("an unknown function id is dropped, not stored", () => {
  const out = normaliseSettings({ functions: { "student:no-such-screen": false } });
  assert.deepEqual(out.functions, {});
});

test("a locked function cannot be stored as off", () => {
  // isEnabled already refuses to honour it, so this is the second of two rails. It
  // matters on its own: a stored `"student:more": false` would render the toggle as
  // off on the Develop App screen while the screen itself stayed visible, and an
  // administrator would reasonably report that as a bug.
  for (const id of LOCKED) {
    const out = normaliseSettings({ functions: { [id]: false } });
    assert.deepEqual(out.functions, {}, `${id} is locked but was stored as off`);
  }
});

test("a label override is trimmed and stored", () => {
  const out = normaliseSettings({ labels: { "student:attendance": "  Attendance %  " } });
  assert.deepEqual(out.labels, { "student:attendance": "Attendance %" });
});

test("an empty or whitespace label is dropped, meaning revert to the default", () => {
  // Clearing the box is how an administrator undoes a rename, so it must not store "".
  // An empty string reaching the client would render a nav entry with no words in it.
  assert.deepEqual(normaliseSettings({ labels: { "student:attendance": "" } }).labels, {});
  assert.deepEqual(normaliseSettings({ labels: { "student:attendance": "   " } }).labels, {});
});

test("a label is capped in length", () => {
  const out = normaliseSettings({ labels: { "student:attendance": "x".repeat(LABEL_MAX + 50) } });
  assert.equal(out.labels["student:attendance"].length, LABEL_MAX);
});

test("a non-string label is dropped", () => {
  for (const bad of [42, true, null, {}, []]) {
    assert.deepEqual(normaliseSettings({ labels: { "student:attendance": bad } }).labels, {},
      `a label of ${JSON.stringify(bad)} was stored`);
  }
});

test("a label for an unknown function is dropped", () => {
  assert.deepEqual(normaliseSettings({ labels: { "student:nope": "Hello" } }).labels, {});
});

test("order keeps only real keys of the named surface", () => {
  const out = normaliseSettings({ order: { student: ["attendance", "home", "not-a-screen"] } });
  assert.ok(!out.order.student.includes("not-a-screen"));
});

test("order appends whatever the client did not mention, in registry order", () => {
  // THE BUG THIS PINS. A client that posts a partial order -- an older app version, or
  // a drag-and-drop that only sends what moved -- must not make the screens it omitted
  // vanish from the nav. They are not switched off, so they have to come back
  // somewhere, and the end in registry order is the only stable answer.
  const out = normaliseSettings({ order: { student: ["attendance"] } });
  assert.equal(out.order.student[0], "attendance");
  assert.deepEqual([...out.order.student].sort(), [...STUDENT_SCREENS].sort(),
    "a partial order dropped screens that were never switched off");
});

test("order ignores a surface that does not exist", () => {
  assert.deepEqual(normaliseSettings({ order: { applicant: ["home"] } }).order, {});
});

test("order ignores a duplicate key rather than listing it twice", () => {
  // A duplicated key would render the same nav entry twice, and React would warn about
  // two children with the same key.
  const out = normaliseSettings({ order: { student: ["home", "home", "attendance"] } });
  const homes = out.order.student.filter(k => k === "home").length;
  assert.equal(homes, 1, "a duplicated key was stored twice");
});

test("a non-array order is dropped", () => {
  for (const bad of ["home", 42, {}, null]) {
    assert.deepEqual(normaliseSettings({ order: { student: bad } }).order, {},
      `an order of ${JSON.stringify(bad)} was stored`);
  }
});

test("normaliseSettings is idempotent", () => {
  // Its own output must survive another pass unchanged, because get() re-validates a
  // row that save() already normalised. If the two disagreed, a saved row would read
  // back differently from how it was written.
  const once = normaliseSettings({
    functions: { "student:attendance": false },
    labels: { "student:assessments": "Grades" },
    order: { student: ["attendance"] },
  });
  assert.deepEqual(normaliseSettings(once), once);
});

/* ===================================================================================
   surfaceView -- the payload one app surface is given at bootstrap.
   =================================================================================== */
//
// The client must not have to combine `functions`, `labels` and `order` itself. That
// combination has an order of operations that is easy to get wrong in a way nothing
// would catch: a stored order naming a function that was later switched off must not
// put it back in the nav, and a nav built from `order` alone would do exactly that.
//
// Returning the EFFECTIVE label for every enabled key also means the client is not a
// fourth place where the wording of a page is written down.

const { surfaceView } = require("./appFunctions");

test("an unconfigured college gets the registry, in registry order", () => {
  const v = surfaceView({}, "student");
  assert.deepEqual(v.functions, STUDENT_SCREENS);
});

test("surfaceView names only its own surface", () => {
  const v = surfaceView({}, "staff");
  assert.deepEqual(v.functions, STAFF_PAGES);
  assert.ok(!v.functions.includes("home"), "a student screen reached the staff payload");
});

test("a switched-off function is absent from the payload", () => {
  const v = surfaceView({ functions: { "student:attendance": false } }, "student");
  assert.ok(!v.functions.includes("attendance"));
  assert.ok(!("attendance" in v.labels), "a switched-off function still carried a label");
});

test("a stored order is honoured", () => {
  const settings = normaliseSettings({ order: { student: ["attendance", "home"] } });
  const v = surfaceView(settings, "student");
  assert.equal(v.functions[0], "attendance");
  assert.equal(v.functions[1], "home");
});

test("a function switched off does NOT come back via a stored order", () => {
  // THE BUG THIS PINS, and the reason this function exists rather than the client
  // reading the three parts itself. `order` is written by the reorder control and
  // `functions` by the toggles, so a screen can perfectly well be named in an order
  // list that predates it being switched off. A nav built from `order` alone -- the
  // obvious implementation -- would render it, and the server would then 403 every
  // request behind it: a visible screen that does not work.
  const settings = normaliseSettings({
    order: { student: ["attendance", "home"] },
    functions: { "student:attendance": false },
  });
  const v = surfaceView(settings, "student");
  assert.ok(!v.functions.includes("attendance"),
    "a switched-off screen was restored to the nav by the stored order");
  assert.equal(v.functions[0], "home");
});

test("a locked function survives both a stored order that omits it and a false", () => {
  const settings = normaliseSettings({
    order: { student: ["attendance"] },
    functions: { "student:more": false },
  });
  const v = surfaceView(settings, "student");
  assert.ok(v.functions.includes("more"), "a locked screen was dropped");
});

test("every enabled function carries its effective label", () => {
  const settings = normaliseSettings({ labels: { "student:attendance": "Attendance %" } });
  const v = surfaceView(settings, "student");
  assert.equal(v.labels.attendance, "Attendance %", "the override was not applied");
  assert.equal(v.labels.home, "Student Hub", "the default label was not supplied");
  // Keyed by PLAIN key, not by id: the client thinks in screen keys, and handing it
  // "student:attendance" would make every lookup site strip the prefix.
  assert.ok(!("student:attendance" in v.labels));
});

test("surfaceView tolerates a raw unnormalised settings object", () => {
  // It is called with what get() returns, and get() normalises -- but a caller that
  // passes the row's JSON straight through must not produce a broken nav.
  const v = surfaceView({ functions: { "student:attendance": false }, order: { student: "nonsense" } }, "student");
  assert.ok(!v.functions.includes("attendance"));
  assert.ok(v.functions.includes("home"));
});

test("an unknown surface yields an empty payload rather than throwing", () => {
  assert.deepEqual(surfaceView({}, "applicant"), { functions: [], labels: {} });
});
