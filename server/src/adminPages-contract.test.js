// ADMIN_PAGES is two hand-maintained copies. This is the test that pins them together.
//
// WHY IT DID NOT EXIST UNTIL NOW, AND WHY THAT WAS THE WRONG WAY ROUND. CLAUDE.md names
// this pair as a standing hazard, and two other contract tests in this repo —
// prediction/schema-contract.test.js and admissions/aggregates-contract.test.js — say in
// their own comments that they are imitating "the shape of problem CLAUDE.md documents
// for ADMIN_PAGES". So the pattern was borrowed from this pair repeatedly while the pair
// itself stayed unguarded. The only existing check, warnOnPageListDrift in StaffHub.jsx,
// is dev-only, gated on import.meta.env.DEV, and compares three CLIENT lists to each
// other — it cannot see the server's list at all, which is the one join that matters.
//
// WHAT DRIFT ACTUALLY COSTS, in the two directions:
//
//   In the server and not the client — a page the API will gate on, with no checkbox to
//     grant it. Nobody can be given it, and the screen behind it is unreachable forever.
//   In the client and not the server — a checkbox that stores a grant validate.js will
//     reject, so the save fails, or worse succeeds and gates nothing.
//
// Both are silent. Neither breaks a build, and the client has no test framework of its
// own, so this test on the server side is the only place the pair can be held together.
//
// Read AS TEXT rather than imported, the same technique the other two contract tests
// use: StaffHub.jsx is an ES module of ~15,800 lines that imports React and lucide, and
// requiring it from node would need a bundler for one array.
//
// Run with: node --test src/adminPages-contract.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { ADMIN_PAGES } = require("./validate");
const STAFFHUB = path.join(__dirname, "..", "..", "client", "src", "StaffHub.jsx");
const src = fs.readFileSync(STAFFHUB, "utf8");

// Pull a named const array of string literals out of the client source. Handles both
// `const X = [...]` and `const X = new Set([...])`, which is how these two are written.
function clientArray(name) {
  const at = src.search(new RegExp(`const ${name}\\s*=\\s*(new Set\\()?\\[`));
  assert.notEqual(at, -1,
    `client/src/StaffHub.jsx no longer declares "const ${name}". If it was renamed or ` +
    `moved, update this test deliberately — do not delete it, it is the only guard on this pair.`);
  const end = src.indexOf("]", at);
  return [...src.slice(at, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

test("the client's ADMIN_PAGES is identical to the server's, in the same order", () => {
  const client = clientArray("ADMIN_PAGES");

  // Reported as set differences first, because "expected 35 got 34" sends somebody
  // counting an array by eye, and the useful answer is which key moved.
  const missingInClient = ADMIN_PAGES.filter((p) => !client.includes(p));
  const missingInServer = client.filter((p) => !ADMIN_PAGES.includes(p));

  assert.deepEqual(missingInClient, [],
    `these pages exist in server/src/validate.js but NOT in client/src/StaffHub.jsx: ` +
    `${missingInClient.join(", ")} — the API will gate on them and no checkbox can grant them.`);
  assert.deepEqual(missingInServer, [],
    `these pages exist in client/src/StaffHub.jsx but NOT in server/src/validate.js: ` +
    `${missingInServer.join(", ")} — the checkbox stores a grant the server rejects.`);

  // Order last. It is cosmetic on its own, but the two lists being byte-identical is
  // what makes a future diff of either file readable beside the other.
  assert.deepEqual(client, ADMIN_PAGES, "same pages, different order");
});

test("every page has a label, and no label survives its page", () => {
  // A page with no PAGE_LABELS entry renders as an unlabelled checkbox on the Access
  // screen — a grant somebody must guess the meaning of. This has been a live defect
  // here before, so it is asserted rather than trusted.
  const at = src.indexOf("const PAGE_LABELS = {");
  assert.notEqual(at, -1, "client/src/StaffHub.jsx no longer declares PAGE_LABELS");
  const block = src.slice(at, src.indexOf("};", at));
  // Keys are written both bare (executive:) and quoted ("live-attendance":).
  const labelled = new Set([...block.matchAll(/(?:^|[{,]\s*)"?([a-zA-Z][\w-]*)"?\s*:/g)].map((m) => m[1]));

  const unlabelled = ADMIN_PAGES.filter((p) => !labelled.has(p));
  assert.deepEqual(unlabelled, [], `pages with no PAGE_LABELS entry: ${unlabelled.join(", ")}`);
});

test("the explicit-grant-only set matches on both sides", () => {
  // A page in the server's EXPLICIT_ONLY but not the client's appears in the nav for
  // every unconfigured admin and then 403s on every request behind it. The reverse
  // hides a page the server would have allowed. `mitigations` is in this set because it
  // holds Article 9 health data, so the failure is not cosmetic.
  const { EXPLICIT_ONLY } = require("./auth");
  const client = clientArray("EXPLICIT_ONLY_PAGES");
  assert.deepEqual(client.sort(), [...EXPLICIT_ONLY].sort());
});
