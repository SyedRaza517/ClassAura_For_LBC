// Every function either app surface offers, in one list, and whether it is switched on.
//
// WHAT THIS IS FOR. The Develop App screen lets a college switch a staff page or a
// student screen off for the WHOLE institution, and rename or reorder it. That is a
// different question from the two access questions that already existed, and it needed
// its own place to live:
//
//   ADMIN_PAGES + requirePage  -- may THIS PERSON use this page?
//   requireCollegeWide         -- may they do it to the whole college?
//   this file                  -- does this function exist in this deployment at all?
//
// The three combine with AND. A function switched off here is unreachable for everybody
// including a Super Admin; a function switched on here is still subject to both guards
// above. Nothing in this file widens access, which is why it can be consulted from the
// client without becoming a second source of truth about permissions -- see
// `navGroups.js`, which states the hazard: "a second place that decides who sees what
// is a second place for it to be got wrong."
//
// A GLOBAL TOGGLE NEVER MUTATES A PER-PERSON GRANT. Switching `staff:registers` off
// leaves every `adminPages` row exactly as it was and the two are combined when the
// question is asked. The alternative -- stripping the page from everyone's grants on
// save -- loses the information: switching it back on would silently leave every admin
// who used to hold it without it, and there is no record left of who did.
//
// WHY A FUNCTION IS IDENTIFIED BY SURFACE *AND* KEY. Three keys exist on both surfaces:
// `checkin`, `assessments` and `mitigations` are each a staff page AND a student
// screen, doing different jobs for different audiences. The stored config is therefore
// keyed `"<surface>:<key>"` and nothing here accepts a bare key. A flat namespace was
// the first attempt and appFunctions.test.js rejected it, because `{ checkin: false }`
// switched off the staff register and the student's own check-in together -- from one
// toggle, on a screen whose two tabs exist precisely to keep those audiences apart.
//
// WHY THE DEFAULTS LIVE IN CODE. Same reason as attendanceBandConfig.js, which is the
// reference implementation for the storage half of this: a college that has configured
// nothing must behave EXACTLY as it did before the feature existed. There is no config
// row until somebody changes something, so `{}` has to mean "everything on".

/* ------------------------------------------------------------------------------ ids */

// `"<surface>:<key>"`. One function, so the composition cannot drift between the
// writer, the reader and the client.
const fnId = (surface, key) => `${surface}:${key}`;

/* ------------------------------------------------------------------------- the staff */

// THE ORDER OF THESE ENTRIES IS LOAD-BEARING AND IS NOT COSMETIC.
//
// `ADMIN_PAGES` in validate.js is now derived from this list, and
// adminPages-contract.test.js asserts that it is byte-identical to the hand-written
// copy in client/src/StaffHub.jsx *including order*. So reordering here fails that test
// until the client copy is reordered to match, which is the intended behaviour: the two
// lists being identical is what makes a diff of either file readable beside the other.
//
// `access` is deliberately absent, exactly as it is absent from ADMIN_PAGES: it is
// Super-Admin-only and never granted. `develop-app` is absent for the same reason —
// and additionally because a screen that can switch functions off must not be able to
// switch ITSELF off, which is a lockout no amount of clicking can undo.
const STAFF = [
  { key: "executive", label: "Executive Dashboard" },
  { key: "overview", label: "Overview" },
  { key: "kpi", label: "KPIs" },
  { key: "checkin", label: "Check-In" },
  { key: "balances", label: "Holiday Balances" },
  { key: "calendar", label: "Holiday Calendar" },
  { key: "requests", label: "Leave Requests" },
  { key: "documents", label: "Documents" },
  { key: "approvals", label: "Approvals" },
  { key: "signups", label: "Sign-Up Requests" },
  { key: "summaries", label: "Daily Summaries" },
  { key: "registers", label: "Attendance — Registers" },
  { key: "live-attendance", label: "Attendance — Dashboard" },
  { key: "attendance-settings", label: "Attendance — Settings" },
  { key: "students", label: "Students" },
  { key: "attendance-emails", label: "Attendance Emails" },
  { key: "assessments", label: "Assessments" },
  { key: "assessment-tracker", label: "Assessment Tracker" },
  // "timetable" was here until 8 Sep 2026 and is deliberately gone, along with the whole
  // page: routes/timetable.js, its mount, its api.js callers and the AdminTimetable
  // screen. It built the older weekly TimetableSlot timetable, and it sat in the sidebar
  // directly above "My Timetable" under a shorter, more obvious name while being
  // permanently empty -- so a reader looking for classes they had just entered clicked it
  // first, found nothing, and concluded the save had failed. Reported exactly that way.
  //
  // Removing the key alone was the first attempt and adminPages-contract.test.js refused
  // it: a router still gated on requirePage("timetable") would answer 403 to somebody
  // holding the very page it names, which is the attendance-tags bug the test was written
  // for. Either the key stays grantable or the router goes. The router went.
  //
  // WHAT THIS COSTS: /api/student/me/timetable still READS TimetableSlot, and this was
  // its only writer, so a student's weekly timetable can no longer be populated at all.
  // In practice nothing changed -- both databases hold zero TimetableSlot rows -- but the
  // gap is now permanent rather than merely unused, and closing it means pointing that
  // route at TimetableEvent, which is where the classes actually are.
  { key: "pat", label: "PAT" },
  { key: "prediction", label: "Predictive Analysis" },
  { key: "mitigations", label: "Mitigating Circumstances" },
  { key: "staffreviews", label: "Staff Reviews" },
  { key: "studentreviews", label: "Student Reviews" },
  { key: "studentqueries", label: "Student Queries" },
  { key: "staff", label: "Staff" },
  { key: "timesheets", label: "Timesheets" },
  { key: "scheduling", label: "Scheduling" },
  { key: "admissions", label: "Admissions" },
  { key: "admissions-tracker", label: "Admission Tracker" },
  { key: "ism", label: "ISM (Interviews)" },
  { key: "slc", label: "SLC — Student Loans" },
  { key: "referrals", label: "Referrals (support departments)" },
  { key: "passwords", label: "Reset Passwords" },
  // LOCKED. Not because the page is special, but because it owns the DETAIL behind nine
  // other config tables -- branding, integrations, attendance bands, letter wording,
  // the department list. Develop App deliberately does not duplicate any of those
  // controls (two places deciding one behaviour is how they disagree), so switching
  // Settings off would orphan every one of them with no other screen to reach them
  // from. The toggle renders, and renders disabled, with this reason beside it.
  { key: "settings", label: "Settings", locked: true },
];

/* ----------------------------------------------------------------------- the student */

// Order is the TAB ORDER, and the first six that survive filtering are what the bottom
// bar shows -- see StudentApp.jsx, where the bar is sized for six and the comment above
// TABS explains why Check In earns second place ("the only thing in this app with a
// deadline"). A screen reachable only from Home or More still belongs here: it is
// switchable, it just has no tab of its own.
//
// `routes` IS THE ENFORCEMENT HALF, and the reason the student surface needs this map
// at all. Student sessions are confined by a ROUTER allowlist (STUDENT_ROUTERS in
// auth.js), not by per-route guards, so there is no existing hook on which to hang
// "this screen is switched off" -- unlike a staff page, which already has requirePage
// on its own router. Hiding a screen in the client while its endpoints keep answering
// is not a control at all: the data is one fetch away for anybody who looks.
//
// Listed as PREFIXES where a route has parameters: `/me/referrals` covers
// `/me/referrals/:id/messages`. Matching is on segment boundaries only, so a later
// `/me/referrals-export` would NOT be gated here by accident -- see screenForRoute.
const STUDENT = [
  // LOCKED: Home is the navigation ROOT. StudentApp clears its back-trail on reaching
  // Home, so every back gesture in the app terminates there; with Home switched off,
  // back has nowhere to land. It reads from the shared bootstrap rather than any route
  // of its own, which is why it declares none.
  { key: "home", label: "Student Hub", locked: true, routes: [] },
  {
    key: "checkin", label: "Check In",
    routes: ["/me/tap-context", "/me/tap-check-in", "/me/qr-check-in", "/me/declare-check-in"],
  },
  { key: "attendance", label: "My Attendance", routes: ["/me/attendance", "/me/attendance-bands", "/me/streaks"] },
  { key: "assessments", label: "My Results", routes: ["/me/assessments"] },
  { key: "query", label: "Ask the College", routes: ["/me/queries", "/me/query"] },
  { key: "timetable", label: "My Timetable", routes: ["/me/timetable"] },
  { key: "reviews", label: "My Reviews", routes: ["/me/reviews"] },
  { key: "support", label: "Support", routes: ["/me/referrals", "/me/support-departments"] },
  { key: "mitigations", label: "Mitigating Circumstances", routes: ["/me/mitigations"] },
  { key: "inbox", label: "Inbox", routes: ["/me/notifications"] },
  // LOCKED: More holds Sign out, and the appearance and biometric settings. A student
  // whose college switched this off could not leave their own session.
  { key: "more", label: "More", locked: true, routes: [] },
];

/* ---------------------------------------------------------------------- the registry */

const APP_FUNCTIONS = [
  ...STAFF.map((f) => ({ ...f, surface: "staff", locked: !!f.locked, routes: f.routes || [] })),
  ...STUDENT.map((f) => ({ ...f, surface: "student", locked: !!f.locked, routes: f.routes || [] })),
];

const BY_ID = new Map(APP_FUNCTIONS.map((f) => [fnId(f.surface, f.key), f]));

const STAFF_PAGES = APP_FUNCTIONS.filter((f) => f.surface === "staff").map((f) => f.key);
const STUDENT_SCREENS = APP_FUNCTIONS.filter((f) => f.surface === "student").map((f) => f.key);

// Derived from the entries rather than written out again, so `locked: true` on the
// entry is the single statement of the fact and the two cannot disagree.
const LOCKED = new Set(APP_FUNCTIONS.filter((f) => f.locked).map((f) => fnId(f.surface, f.key)));

/* -------------------------------------------------------------------- the resolution */

/**
 * Is this function switched on for this college?
 *
 * `config` is the stored map, `{ "student:attendance": false }`, or `{}` / null / absent
 * for a college that has never changed anything.
 *
 * Only an explicit `false` switches a function off. Every other stored value -- a
 * string, a zero, a null, the key being absent -- reads as ON. The stored JSON arrived
 * over HTTP, and "off" is the destructive direction: a client that posted `0` for a
 * checkbox should not be able to take a screen away from a college.
 */
function isEnabled(config, surface, key) {
  const id = fnId(surface, key);
  // An unknown function reaches no screen and holds no meaning. Reading it as enabled
  // would let a stale row, or a function renamed in a later version, quietly re-open
  // something nothing in the code gates any more.
  if (!BY_ID.has(id)) return false;
  if (LOCKED.has(id)) return true;
  return (config || {})[id] !== false;
}

/** The enabled keys of one surface, in registry order -- i.e. in nav order. */
function enabledKeys(config, surface) {
  return APP_FUNCTIONS
    .filter((f) => f.surface === surface && isEnabled(config, surface, f.key))
    .map((f) => f.key);
}

/* ------------------------------------------------------------------ route -> screen */

// Longest declared route first, so `/me/referrals/:id/messages` cannot be claimed by a
// shorter sibling that merely shares its opening segments. Built once at load.
const ROUTE_OWNERS = APP_FUNCTIONS
  .flatMap((f) => f.routes.map((r) => [r, f.key]))
  .sort((a, b) => b[0].length - a[0].length);

/**
 * Which student screen owns this route path, or null if none does.
 *
 * `path` is relative to the student router's mount -- `/me/attendance`, not
 * `/api/student/me/attendance`.
 *
 * `/me` RESOLVES TO NULL ON PURPOSE, and it is the one case that must never be got
 * wrong. It is the bootstrap: it reports who is signed in and which functions are on,
 * and it is a prefix of every other student route. Gating it behind any screen's toggle
 * would sign out every student in the college the moment that screen was switched off.
 * It is not declared by any entry, so it falls through to null like any other
 * undeclared route -- stated here because the consequence is invisible in the code.
 *
 * An undeclared route returns null, which leaves it exactly as protected as it was
 * before this feature existed -- requireAuth and the STUDENT_ROUTERS allowlist still
 * apply. This registry decides what the Develop App toggle covers, not who may call an
 * endpoint, so a route nobody listed is one nobody chose to put behind a toggle.
 */
function screenForRoute(path) {
  if (!path || typeof path !== "string") return null;
  // Trailing slash removed first: `/me/` and `/me` are the same route, and Express will
  // hand over either. Not applied to "/" itself, which has nothing left after it.
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  for (const [route, key] of ROUTE_OWNERS) {
    if (p === route) return key;
    // A SEGMENT BOUNDARY, not a bare startsWith. `/me/attendance` is a prefix of the
    // string `/me/attendance-summary`, and matching that would gate an endpoint added
    // later behind a toggle nobody declared it under -- silently, and decided by how it
    // happened to be spelt. Requiring the next character to be "/" means a route is
    // gated only once somebody lists it deliberately.
    if (p.startsWith(route + "/")) return key;
  }
  return null;
}

/* -------------------------------------------------------------------- normalisation */

// A nav label has to fit a sidebar row and a 48px-wide student tab. The cap is defined
// here rather than taken from validate.js's MAX_TEXT ON PURPOSE: validate.js now
// REQUIRES this module for ADMIN_PAGES, so requiring it back would close a cycle, and
// under CommonJS a cycle does not throw -- it hands whichever module loaded second a
// half-populated object. ADMIN_PAGES would be undefined at require time and every
// requirePage in the app would silently gate on nothing.
const LABEL_MAX = 40;

const SURFACES = ["staff", "student"];
const KEYS_BY_SURFACE = { staff: STAFF_PAGES, student: STUDENT_SCREENS };

/**
 * Reduce a submitted settings object to what may be stored.
 *
 * Returns { functions, labels, order } -- always all three, always objects.
 *
 * DROPS what it does not recognise rather than rejecting the whole save, and that is a
 * deliberate choice between two bad outcomes. An all-or-nothing rule on a screen with
 * 45 toggles means one stale key -- a function renamed in a later version, a tab left
 * open across a deploy -- blocks every subsequent edit with an error naming something
 * the administrator cannot see or remove. Dropping the unknown key applies the rest,
 * which is both what they asked for and the state the screen will show them.
 *
 * Called on the way IN and again on the way OUT, so it must be idempotent: a stored row
 * can predate a rule or have been edited by hand in a console, which is the same reason
 * attendanceBandConfig re-validates in get() rather than trusting what save() wrote.
 */
function normaliseSettings(input) {
  const src = (input && typeof input === "object" && !Array.isArray(input)) ? input : {};

  /* functions -- only an explicit false, only a real id, never a locked one */
  const functions = {};
  const fin = (src.functions && typeof src.functions === "object" && !Array.isArray(src.functions))
    ? src.functions : {};
  for (const [id, v] of Object.entries(fin)) {
    // Only `false`. Every other value -- "false", 0, null, a missing key -- means ON.
    // "Off" is the direction that takes a screen away from a college, so it requires
    // the one unambiguous value rather than anything merely falsy.
    if (v !== false) continue;
    if (!BY_ID.has(id)) continue;
    // Stored separately from isEnabled's refusal to honour it: without this, the
    // Develop App screen would read the row back and draw a locked toggle in the OFF
    // position while its screen stayed visible, which reads as a bug.
    if (LOCKED.has(id)) continue;
    functions[id] = false;
  }

  /* labels -- a trimmed, capped, non-empty string against a real id */
  const labels = {};
  const lin = (src.labels && typeof src.labels === "object" && !Array.isArray(src.labels))
    ? src.labels : {};
  for (const [id, v] of Object.entries(lin)) {
    if (!BY_ID.has(id)) continue;
    if (typeof v !== "string") continue;
    const text = v.trim().slice(0, LABEL_MAX);
    // An empty box is how a rename is UNDONE, so it must not store "". Storing it
    // would render a nav entry with no words in it, which cannot be clicked back.
    if (!text) continue;
    labels[id] = text;
  }

  /* order -- a permutation of one surface's keys, completed from the registry */
  const order = {};
  const oin = (src.order && typeof src.order === "object" && !Array.isArray(src.order))
    ? src.order : {};
  for (const surface of SURFACES) {
    const list = oin[surface];
    if (!Array.isArray(list)) continue;
    const known = KEYS_BY_SURFACE[surface];
    const seen = new Set();
    const out = [];
    for (const k of list) {
      if (typeof k !== "string" || !known.includes(k) || seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    // ANYTHING THE CLIENT DID NOT MENTION IS APPENDED, in registry order. A partial
    // order arrives whenever an older app version saves, or a drag-and-drop sends only
    // what moved; the screens it omitted are not switched off, so they must still
    // appear somewhere, and the end in registry order is the only stable answer. The
    // alternative loses a screen from the nav without anybody having switched it off.
    for (const k of known) if (!seen.has(k)) out.push(k);
    order[surface] = out;
  }

  return { functions, labels, order };
}

/** The label this college uses for a function -- its override, or the registry's. */
function labelFor(settings, surface, key) {
  const id = fnId(surface, key);
  const f = BY_ID.get(id);
  if (!f) return null;
  const override = (settings && settings.labels) ? settings.labels[id] : null;
  return (typeof override === "string" && override.trim()) ? override.trim() : f.label;
}

/* ----------------------------------------------------------------- the app's payload */

/**
 * What one app surface is told at bootstrap: which functions it has, in which order,
 * under which words.
 *
 * Returns { functions: [key], labels: { key: label } } with PLAIN keys, because the
 * client thinks in screen keys -- handing it "student:attendance" would make every
 * lookup site strip the prefix, and one of them eventually would not.
 *
 * THE ORDER OF OPERATIONS HERE IS THE POINT, and it is why this lives on the server
 * rather than being assembled in the client from the three stored parts. `order` is
 * written by the reorder control and `functions` by the toggles, so a screen can
 * perfectly well still be named in an order list that predates it being switched off.
 * Building the nav from `order` and then subtracting -- rather than filtering the
 * ENABLED set into the stored order -- restores it: a visible screen behind which every
 * request 403s. The test for this names it as the bug it is.
 *
 * Labels are the EFFECTIVE labels, override or registry default, for exactly the
 * functions that survived. That keeps the client from becoming a further place where
 * the wording of a page is written down, and means a switched-off function cannot leak
 * its name to a surface that may not reach it.
 */
function surfaceView(settings, surface) {
  const known = KEYS_BY_SURFACE[surface];
  if (!known) return { functions: [], labels: {} };

  const s = normaliseSettings(settings);
  // The enabled set first, as a Set, so the ordering pass below can only ever REMOVE
  // from it and never reintroduce something that is switched off.
  const on = new Set(enabledKeys(s.functions, surface));

  const stored = Array.isArray(s.order[surface]) ? s.order[surface] : known;
  const functions = stored.filter((k) => on.has(k));
  // Anything enabled that the stored order somehow failed to mention is appended rather
  // than lost. normaliseSettings already completes a partial order, so this cannot fire
  // today; it is here so that a hand-edited row, or a later change to that completion,
  // cannot make an enabled screen silently unreachable.
  for (const k of known) if (on.has(k) && !functions.includes(k)) functions.push(k);

  const labels = {};
  for (const k of functions) labels[k] = labelFor(s, surface, k);

  return { functions, labels };
}

module.exports = {
  APP_FUNCTIONS, STAFF_PAGES, STUDENT_SCREENS, LOCKED, LABEL_MAX, SURFACES,
  fnId, isEnabled, enabledKeys, screenForRoute, normaliseSettings, labelFor, surfaceView,
};
