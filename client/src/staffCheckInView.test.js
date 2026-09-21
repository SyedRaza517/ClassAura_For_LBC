// The staff check-in screen's two decisions, without a browser: what the button says and
// whether it is live, and what a refused clock-in is told.
//
// Run with: node --test src/staffCheckInView.test.js   (from client/)
import test from "node:test";
import assert from "node:assert/strict";
import { checkInButton, staffPlaceRefusal } from "./staffCheckInView.js";

test("nothing chosen means a dead button", () => {
  // The whole point of the two-tab layout: the button is visibly not ready until a
  // decision has been made, rather than defaulting to one of the two answers.
  const b = checkInButton({ site: null, tapRequired: false, busy: false });
  assert.equal(b.enabled, false);
});

test("choosing Online arms the button", () => {
  const b = checkInButton({ site: "Online", tapRequired: false, busy: false });
  assert.equal(b.enabled, true);
  assert.equal(b.label, "Check in");
});

test("Onsite at a college with no stickers is an ordinary button", () => {
  // staffTapEnabled ships OFF and a college may never switch it on. There is then no
  // sticker to tap, so Onsite is a plain press — which still runs the network and
  // geofence checks server-side. A college can require proof of presence without buying
  // a single sticker.
  const b = checkInButton({ site: "Onsite", tapRequired: false, busy: false });
  assert.equal(b.enabled, true);
  assert.equal(b.label, "Check in");
});

test("Onsite where a sticker is required says so, and reopens the popup", () => {
  // Dismissing the popup must never strand somebody on a selected tab with an inert
  // button. The button becomes the way back in.
  const b = checkInButton({ site: "Onsite", tapRequired: true, busy: false });
  assert.equal(b.enabled, true);
  assert.equal(b.label, "Tap the sticker");
});

test("a clock-in in flight cannot be pressed twice", () => {
  const b = checkInButton({ site: "Online", tapRequired: false, busy: true });
  assert.equal(b.enabled, false);
});

test("busy beats the sticker branch, so nothing on the screen is live twice", () => {
  // Added with the fix for two submissions running at once: the tabs are disabled while
  // `busy`, and this pins the other half of that guard — an in-flight clock-in makes the
  // button dead even in the state where it would otherwise REOPEN THE POPUP. Were the
  // order of the two checks ever swapped, an Onsite-with-sticker press during a running
  // Online submission would arm a second, independent one, and the loser's refusal would
  // land under a choice the person had already moved away from.
  const b = checkInButton({ site: "Onsite", tapRequired: true, busy: true });
  assert.equal(b.enabled, false);
  assert.equal(b.label, "Checking you in…");
});

test("every refusal a member of staff can be given offers them Online", () => {
  // The difference from the student vocabulary, and the reason the two cannot be shared:
  // a member of staff always has an honest alternative and a student does not.
  for (const reason of ["off_network", "network_not_configured", "off_campus", "campus_not_located"]) {
    const r = staffPlaceRefusal(reason);
    assert.match(`${r.heading} ${r.advice}`, /Online/, `${reason} should point at Online`);
  }
});

test("a location refusal tells them to fix the phone, not to give up", () => {
  const r = staffPlaceRefusal("position_missing");
  assert.match(r.advice, /location/i);
});

test("a reason this build has never heard of still says something true", () => {
  // A newer server, an older app. Silence here renders an empty red box.
  const r = staffPlaceRefusal("something_new_entirely");
  assert.ok(r.heading);
  assert.ok(r.advice);
});
