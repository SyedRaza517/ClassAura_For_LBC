// The link inside the QR code, and whether this screen is entitled to draw one at all.
//
// A code is only useful if the phone reading it can reach the address inside it. The link
// is built from the page's own address, which is correct in a browser and wrong inside the
// packaged app: there, the page's address is the DEVICE. A lecturer presenting from the
// installed Staff Hub app would fill a projector with a code that every phone in the room
// fails to open, and nothing on either side would say why — the students would report that
// check-in is broken, and the register would show a room of absences.
//
// So the rule is refuse rather than mislead, which is the same rule the mint endpoint
// already follows outside a class's hours: no code, and a line saying what to do instead.
// Presenting from a browser is the normal case and is unaffected.
//
// Pure, and native is passed in rather than read here, so both branches are testable
// without a device. See scanLink.test.js.

/** Addresses a student's phone could actually open. */
function isReachableOrigin(origin) {
  if (!origin) return false;
  // Only the web schemes. A capacitor:// or file:// address means the page is being served
  // from inside an app bundle, and nothing outside that device can resolve it.
  return /^https?:\/\/[^/]+$/i.test(origin) && !/^https?:\/\/localhost$/i.test(origin);
}

/**
 * May this screen put a code on the wall?
 *
 * `localhost` WITH a port is a developer's browser and the link genuinely works there, so
 * it stays allowed — that is how this is tested without a phone. Bare `localhost` with no
 * port is what the Android WebView reports, and is refused for the same reason native is.
 */
export function canPresentCode({ native, origin }) {
  if (native === true) return false;
  return isReachableOrigin(origin);
}

/**
 * The link the code encodes, or null when this screen must not draw one.
 *
 * The code rides in the FRAGMENT. Everything after # never leaves the phone, whereas a
 * query string would write every live code into the web host's access logs and into the
 * student's browser history — the two places the server side is careful never to record one.
 */
export function scanLinkFor({ native, origin, sessionId, code }) {
  if (!canPresentCode({ native, origin })) return null;
  return `${origin}/#checkin=${sessionId}.${code}`;
}
