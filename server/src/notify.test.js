// titleFor is pure (no I/O) and is tested directly with hand-picked strings — see
// .claude/rules/testing.md. Everything else in notify.js talks to Prisma, sendEmail
// or sendPush, which is why this file also stubs db.js and push.js (the same
// require-cache technique attendanceTapConfig.test.js uses) to cover the REAL path a
// notification actually takes, below the pure tests.
//
// THE STUBS MUST BE PLANTED BEFORE notify.js IS REQUIRED FOR THE FIRST TIME — a
// module's `require("./db")` binds to whatever is in require.cache at the moment IT
// runs, once, and a later overwrite of require.cache does not reach back and change
// an already-bound reference. So this file requires nothing of its own until the
// fakes are in place, and requires notify.js exactly once, below, for both halves of
// the suite to share.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Disabled so every call below re-reads the fake "database" rather than serving a
// previous test's resolved branding back from a cache — same reasoning as
// attendanceTapConfig.test.js's own ATTENDANCE_TAP_CACHE_MS=0. Must be set before
// branding.js is first required (it reads this once, at module load).
process.env.BRANDING_CACHE_MS = "0";

let brandingRow = null; // TenantBranding row, or null — what the college has saved
let tenantRow = null;   // Tenant row, or null — the institution's own `name`
const sent = [];        // { token, title, body } for every sendPush() call below

const fakePrisma = {
  tenantBranding: { findFirst: async () => brandingRow },
  tenant: { findFirst: async () => tenantRow },
  deviceToken: {
    findMany: async () => [{ id: "dev1", token: "tok-1", studentId: "s1" }],
    delete: async () => {},
  },
  notification: { create: async ({ data }) => ({ id: "n1", ...data }) },
};
require.cache[require.resolve("./db")] = { id: require.resolve("./db"), filename: path.resolve(__dirname, "db.js"), loaded: true, exports: fakePrisma };

const fakePush = {
  // Real push.js's own signature: sendPush(token, { title, body, data }).
  sendPush: async (token, { title, body }) => { sent.push({ token, title, body }); return { sent: true, stubbed: false }; },
};
require.cache[require.resolve("./push")] = { id: require.resolve("./push"), filename: path.resolve(__dirname, "push.js"), loaded: true, exports: fakePush };

// The ONE require of notify.js in this file — its own top-level `require("./db")`/
// `require("./push")`, and branding.js's lazy `require("./db")` the first time
// pushToStudentDevices calls it, all resolve to the fakes above because both are
// already sitting in require.cache by this line.
const { titleFor, notifyStudent } = require("./notify");

test("titleFor: a configured display name wins for either audience", () => {
  assert.equal(titleFor("Riverside College", "staff"), "Riverside College");
  assert.equal(titleFor("Riverside College", "student"), "Riverside College");
});

test("titleFor: an unbranded college falls back per audience, never to the other audience's product name", () => {
  // Staff falls back to the literal this function replaced, so an unbranded
  // college's staff pushes read exactly as they did before this change.
  assert.equal(titleFor(null, "staff"), "Staff Hub");
  assert.equal(titleFor(undefined, "staff"), "Staff Hub");
  assert.equal(titleFor("", "staff"), "Staff Hub");
  // Students never see "Staff Hub" — that names a screen they've never opened.
  assert.equal(titleFor(null, "student"), "ClassAura");
  assert.equal(titleFor(undefined, "student"), "ClassAura");
  assert.equal(titleFor("", "student"), "ClassAura");
});

test("titleFor: an unrecognised audience is treated as staff, matching every caller in this file", () => {
  // notify.js only ever passes "staff" or "student", but a third value should not
  // silently look like a student fallback — the safer default (this codebase's
  // existing product name) is what an unexpected caller should get.
  assert.equal(titleFor(null, "unknown"), "Staff Hub");
});

/* ============================================================================
 * REAL-PATH COVERAGE — final-review fix.
 *
 * Every test above calls titleFor() directly with a hand-picked string, which is
 * correct as far as it goes but never proved the bug the final review actually
 * found: pushToStudentDevices used to resolve that string from
 * `(await branding.get()).displayName`, and get() bakes its OWN "Staff Hub"
 * fallback in before returning — so on an unbranded college, titleFor was handed
 * the literal string "Staff Hub", not a falsy value, and its "fall back to
 * ClassAura" branch could never fire. The unit tests above passed the whole time;
 * they were testing titleFor correctly, on an input notify.js never actually
 * produced. This is the exact shape testing.md warns about ("a test passed while
 * discriminating nothing").
 *
 * These tests call notifyStudent() — the real function, exported by notify.js — and
 * inspect the title actually handed to (fake) sendPush(), through the real
 * pushToStudentDevices -> branding.rawDisplayName() path.
 *
 * PROVEN ABLE TO FAIL: reverting pushToStudentDevices to read
 * `(await branding.get()).displayName` instead of `branding.rawDisplayName()` makes
 * the first test below observe title === "Staff Hub" instead of "ClassAura" — the
 * exact regression this fixes.
 * ============================================================================ */

test("real path: an unbranded college's student push falls back to ClassAura, never Staff Hub", async () => {
  brandingRow = null; tenantRow = null;
  sent.length = 0;
  await notifyStudent("s1", { type: "info", message: "A test notification", link: "query" });
  assert.equal(sent.length, 1, "sendPush should have been called once, for the one registered device");
  assert.equal(sent[0].title, "ClassAura");
});

test("real path: no branding row, but the institution has a name — that name wins, not ClassAura", async () => {
  // The Tenant row's own `name` is a real, meaningful fallback (branding.js's own
  // comment: "what was typed when the deployment was set up") and get() reads it
  // BEFORE its "Staff Hub" literal — rawDisplayName() must agree.
  brandingRow = null; tenantRow = { name: "Riverside College" };
  sent.length = 0;
  await notifyStudent("s1", { type: "info", message: "A test notification", link: "query" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, "Riverside College");
});

test("real path: an explicitly configured display name wins over the institution's own name", async () => {
  brandingRow = { displayName: "Branded Display Name" };
  tenantRow = { name: "Riverside College" };
  sent.length = 0;
  await notifyStudent("s1", { type: "info", message: "A test notification", link: "query" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, "Branded Display Name");
});
