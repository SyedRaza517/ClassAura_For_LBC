// The demo's check-in settings, pinned against the settings the product ships with.
//
// UNTIL 4 SEP 2026 these were deliberately DIFFERENT: the product shipped with QR check-in
// OFF and the demo seeded it ON, and this file existed to stop anyone "tidying" them into
// agreement. That is no longer the arrangement. The product now ships with QR check-in ON
// (attendanceTapSettings.js carries the reasoning at length), so the two AGREE, and what
// needs pinning has changed with them.
//
// What this file pins now:
//
//   1. The QR default is ON, and it is a decision rather than an accident. Flipping it back
//      makes the feature invisible to every college that has not found the settings screen,
//      which is how a shipped capability gets reported as missing.
//   2. The STICKER default stays OFF. It needs hardware somebody has to buy and place, and
//      a capture method nobody has installed must not appear to be running. This is the
//      switch whose default genuinely protects an attendance record.
//   3. The demo still seeds explicitly rather than leaning on the default, so the demo says
//      what it means and survives a future change to the defaults.
//
// Read as text rather than by running the seed, which is the technique
// adminPages-contract.test.js and the two schema-contract tests already use here: no unit
// test in this repo opens a database connection, and this one is not going to be first.
//
// Run with: node --test src/seedTapConfig-contract.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { DEFAULTS } = require("./attendanceTapSettings");
const SEED = fs.readFileSync(path.join(__dirname, "..", "prisma", "seed.js"), "utf8");

// The upsert body, so the assertions below cannot be satisfied by the word appearing in
// a comment somewhere else in a 200-line file.
function tapConfigUpsert() {
  const at = SEED.search(/attendanceTapConfig\.upsert\(/);
  if (at === -1) return null;
  return SEED.slice(at, at + 600);
}

test("the demo seed switches QR check-in on explicitly", () => {
  const body = tapConfigUpsert();
  assert.notEqual(body, null,
    "prisma/seed.js no longer seeds attendanceTapConfig. The demo would then lean on the " +
    "shipped defaults, which is fragile in both directions: it says nothing about what the " +
    "demo intends, and it changes silently the next time a default moves.");
  assert.match(body, /qrEnabled:\s*true/,
    "the seeded check-in settings must set qrEnabled: true explicitly, even though the " +
    "shipped default now agrees with it.");
});

test("the shipped default for QR check-in is ON, deliberately", () => {
  assert.equal(DEFAULTS.qrEnabled, true,
    "DEFAULTS.qrEnabled flipped back to false. That is a product decision, not a tidy-up: " +
    "it makes the code invisible to every college that has never opened the settings " +
    "screen. It was changed to true on 4 Sep 2026 on the owner's instruction; if it is " +
    "being changed back, say so in the commit and rewrite this test with the new reason.");
});

test("the shipped default for the STICKERS is OFF, and that one must not drift", () => {
  // The important half. QR needs nothing installed; stickers need hardware placed on
  // walls. A college whose stickers do not exist must not be told tap check-in is running,
  // and no amount of enthusiasm for the QR default should carry this one along with it.
  assert.equal(DEFAULTS.enabled, false,
    "DEFAULTS.enabled flipped to true, so every college is now advertising a sticker " +
    "check-in it may have no stickers for.");
});
