// The demo's check-in settings, pinned against the settings the product ships with.
//
// These are two DELIBERATELY DIFFERENT values and the whole point of this test is that
// they stay different.
//
//   The shipped default is OFF. A college that has never opened the settings screen must
//     not gain a second way of writing to its attendance record because somebody
//     deployed. attendanceTapSettings.js says this at length and its own unit test pins
//     DEFAULTS.qrEnabled to false.
//   The demo seed is ON. Every route into prisma/seed.js is guarded by assertDisposable,
//     so the only databases it can reach are throwaway ones — a developer's local copy,
//     CI, and the owner's demo. Nobody evaluating the feature should have to find a
//     settings screen before they can see it work.
//
// WHY THIS TEST EXISTS RATHER THAN A COMMENT SAYING THE SAME. The difference reads as an
// inconsistency to anyone meeting it cold, and there is an obvious "tidy-up" in both
// directions: delete the seed line so the demo matches the default, or flip the default
// so the product matches the demo. The first silently returns the demo to a blank screen;
// the second is a behaviour change to every live college. Neither breaks a build.
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

test("the demo seed switches QR check-in on", () => {
  const body = tapConfigUpsert();
  assert.notEqual(body, null,
    "prisma/seed.js no longer seeds attendanceTapConfig. The demo database then falls back " +
    "to the shipped defaults, where QR check-in is OFF, and anyone opening the demo sees a " +
    "live register with no code on it and no clue that a switch exists.");
  assert.match(body, /qrEnabled:\s*true/,
    "the seeded check-in settings must set qrEnabled: true — that is the only reason this " +
    "seed block exists.");
});

test("the seeded demo value is the OPPOSITE of what the product ships with", () => {
  assert.equal(DEFAULTS.qrEnabled, false,
    "DEFAULTS.qrEnabled flipped to true, so the feature now switches itself on for every " +
    "college that has never saved this setting. That is a product decision, not a tidy-up: " +
    "if it was intended, change it here deliberately and say so in the commit.");
  assert.match(tapConfigUpsert() || "", /qrEnabled:\s*true/);
});

// The sticker path is a separate switch and it is NOT part of this. Seeding it on would
// put a second capture method into the demo that has no hardware behind it, so every
// sticker instruction in the demo would describe something the evaluator cannot do.
test("the demo seed leaves sticker check-in alone", () => {
  const body = tapConfigUpsert();
  assert.notEqual(body, null);
  assert.doesNotMatch(body, /\benabled:\s*true/,
    "the seed must not switch sticker check-in on; only qrEnabled belongs in this block.");
});
