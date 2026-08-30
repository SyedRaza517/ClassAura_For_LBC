// The sidebar's collapsible groups, and the one thing that must never happen: a parent
// tab surviving after permissions have emptied it.
//
// Run by scripts/test.mjs alongside timetableView.test.js. client/package.json is
// "type": "module", so node runs this directly.
import test from "node:test";
import assert from "node:assert/strict";
import { groupNav } from "./navGroups.js";

const GROUPS = { "assessments-record": { label: "Assessments Record" } };
const keysOf = (tree) => tree.map((n) => (n.kind === "item" ? n.item.key : `[${n.id}]`));

test("ungrouped entries pass through in order, untouched", () => {
  const tree = groupNav([{ key: "overview" }, { key: "staff" }], GROUPS);
  assert.deepEqual(keysOf(tree), ["overview", "staff"]);
  assert.equal(tree.every((n) => n.kind === "item"), true);
});

test("grouped entries collapse into one parent carrying its metadata", () => {
  const tree = groupNav([
    { key: "slc" },
    { key: "assessments", group: "assessments-record" },
    { key: "assessment-tracker", group: "assessments-record" },
    { key: "assessment-tracker-setup", group: "assessments-record" },
    { key: "staff" },
  ], GROUPS);
  assert.deepEqual(keysOf(tree), ["slc", "[assessments-record]", "staff"]);
  const g = tree[1];
  assert.equal(g.label, "Assessments Record");
  assert.deepEqual(g.children.map((c) => c.key), ["assessments", "assessment-tracker", "assessment-tracker-setup"]);
});

test("the group sits where its FIRST child sat, so the sidebar does not shuffle", () => {
  // "staff" preceded the assessment screens in the flat list and must still precede
  // the parent that replaced them.
  const tree = groupNav([
    { key: "staff" },
    { key: "assessments", group: "assessments-record" },
    { key: "settings" },
  ], GROUPS);
  assert.deepEqual(keysOf(tree), ["staff", "[assessments-record]", "settings"]);
});

test("A GROUP WITH NO PERMITTED CHILDREN DOES NOT RENDER AT ALL", () => {
  // The invariant this file exists for. `items` arrives already filtered by
  // permission, so an admin holding neither "assessments" nor "assessment-tracker"
  // passes none of the group's children — and must be shown no parent tab. A surviving
  // parent would expand to nothing AND advertise screens they were never granted.
  const tree = groupNav([{ key: "overview" }, { key: "staff" }], GROUPS);
  assert.equal(tree.some((n) => n.kind === "group"), false);
  assert.deepEqual(keysOf(tree), ["overview", "staff"]);
});

test("one permitted child is enough to keep the parent", () => {
  // An admin granted "assessments" but not "assessment-tracker" still gets the parent,
  // holding only the screen they hold.
  const tree = groupNav([{ key: "assessments", group: "assessments-record" }], GROUPS);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].kind, "group");
  assert.deepEqual(tree[0].children.map((c) => c.key), ["assessments"]);
});

test("grouping never invents, drops or reorders a child", () => {
  // Whatever permission allowed through must come out the other side exactly once.
  const items = [
    { key: "a" },
    { key: "b", group: "assessments-record" },
    { key: "c" },
    { key: "d", group: "assessments-record" },
  ];
  const tree = groupNav(items, GROUPS);
  const flattened = tree.flatMap((n) => (n.kind === "item" ? [n.item.key] : n.children.map((c) => c.key)));
  assert.deepEqual(flattened.sort(), ["a", "b", "c", "d"]);
});

test("an unknown group id still renders, labelled by its id", () => {
  // A typo in one nav entry must not silently hide a screen.
  const tree = groupNav([{ key: "x", group: "typo-here" }], GROUPS);
  assert.equal(tree[0].kind, "group");
  assert.equal(tree[0].label, "typo-here");
  assert.deepEqual(tree[0].children.map((c) => c.key), ["x"]);
});

test("an empty or missing list is an empty tree, not a crash", () => {
  // An admin granted no pages at all has an empty nav; StaffHub renders its own empty
  // state for that, and this must not throw on the way there.
  assert.deepEqual(groupNav([], GROUPS), []);
  assert.deepEqual(groupNav(undefined, GROUPS), []);
});
