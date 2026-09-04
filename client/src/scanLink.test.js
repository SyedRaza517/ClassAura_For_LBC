// Whether this screen is allowed to put a code on the wall, and what the code says.
//
// A QR code is only useful if the phone reading it can reach the address inside. The link
// was built from the page's own address, which is right in a browser and wrong inside the
// packaged app, where that address is the device itself: a lecturer presenting from the
// installed app would fill a screen with a code every phone in the room fails to open,
// with nothing on either side saying why.
//
// Run with: node --test src/scanLink.test.js   (from client/)
import test from "node:test";
import assert from "node:assert/strict";
import { canPresentCode, scanLinkFor, isLocalOnlyOrigin } from "./scanLink.js";

const WEB = "https://staffhub.example.ac.uk";

test("a browser on a real address may present a code", () => {
  assert.equal(canPresentCode({ native: false, origin: WEB }), true);
});

// The dev machine is a real browser and the link genuinely works on it, so this must keep
// working — it is how the feature is tested without a phone.
test("a browser on localhost may still present, because that is how it is tested", () => {
  assert.equal(canPresentCode({ native: false, origin: "http://localhost:5173" }), true);
});

test("the packaged app may NOT present, whatever address it thinks it is on", () => {
  assert.equal(canPresentCode({ native: true, origin: "https://localhost" }), false);
  assert.equal(canPresentCode({ native: true, origin: WEB }), false,
    "native is decided by the platform, not by a plausible-looking address");
});

test("a non-web address may not present either", () => {
  assert.equal(canPresentCode({ native: false, origin: "capacitor://localhost" }), false);
  assert.equal(canPresentCode({ native: false, origin: "file://" }), false);
  assert.equal(canPresentCode({ native: false, origin: "" }), false);
});

test("the link carries the code after a #, never in the query string", () => {
  const link = scanLinkFor({ native: false, origin: WEB, sessionId: "ses-1", code: "abc123" });
  assert.equal(link, `${WEB}/#checkin=ses-1.abc123`);
  // Everything after # stays on the phone. A query string would write every live code into
  // the web host's access logs and the student's history, the two places the server side is
  // careful never to record one.
  assert.doesNotMatch(link, /\?/);
});

test("there is no link at all when the screen may not present", () => {
  assert.equal(scanLinkFor({ native: true, origin: WEB, sessionId: "ses-1", code: "abc" }), null,
    "returning a link the room cannot open is the bug this file exists to stop");
});

/* -------------------------------------------------------------------------- */
/* Is this code reachable from another device?                                 */
/* -------------------------------------------------------------------------- */
// localhost WITH a port stays allowed (see canPresentCode) because it is how the feature
// is tested without a phone. But the code then points at THIS computer, and a phone in
// the room cannot open it. The lecturer is entitled to know that before projecting it.

test("a code served from this computer is flagged as local only", () => {
  assert.equal(isLocalOnlyOrigin("http://localhost:5173"), true);
  assert.equal(isLocalOnlyOrigin("http://127.0.0.1:5173"), true);
  assert.equal(isLocalOnlyOrigin("https://localhost:3000"), true);
});

test("a real address, including one on the office wi-fi, is not flagged", () => {
  assert.equal(isLocalOnlyOrigin("https://college.example"), false);
  assert.equal(isLocalOnlyOrigin("http://192.168.0.68:5173"), false);
  assert.equal(isLocalOnlyOrigin("http://10.0.0.5:5173"), false);
});

test("a missing or unusable origin is not flagged, because there is nothing to say about it", () => {
  // canPresentCode already refuses these outright; a second, softer warning on top would
  // put two contradictory messages on one screen.
  assert.equal(isLocalOnlyOrigin(""), false);
  assert.equal(isLocalOnlyOrigin(null), false);
  assert.equal(isLocalOnlyOrigin(undefined), false);
});
