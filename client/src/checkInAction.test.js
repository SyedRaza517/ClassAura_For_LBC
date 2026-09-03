// Which action, if any, a session row on the Registers page offers for the live view.
//
// The rule these pin: no dead-end buttons. A "QR code" action on a college that has
// switched nothing on leads only to a screen saying so, every time, for every session.
import test from "node:test";
import assert from "node:assert/strict";
import { liveAction } from "./checkInAction.js";

test("nothing is offered when neither check-in method is on", () => {
  assert.equal(liveAction({ qrEnabled: false, tapEnabled: false }), null);
  assert.equal(liveAction({}), null);
  assert.equal(liveAction(undefined), null);
});

test("the action is named for the code when QR check-in is on", () => {
  assert.deepEqual(liveAction({ qrEnabled: true, tapEnabled: false }), { kind: "qr", label: "QR code" });
  // Both on: the code is still the thing a lecturer is looking for on the screen.
  assert.deepEqual(liveAction({ qrEnabled: true, tapEnabled: true }), { kind: "qr", label: "QR code" });
});

test("with only stickers on, the live register is offered under its own name", () => {
  assert.deepEqual(liveAction({ qrEnabled: false, tapEnabled: true }), { kind: "live", label: "Live register" });
});
