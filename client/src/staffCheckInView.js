// The staff check-in screen's two decisions, pure.
//
// StaffHub.jsx is over fourteen thousand lines, and logic added inline there is
// untestable in practice — which is how a screen ends up with a button whose enabled
// state nobody can reason about. Same split as qrResultView.js and checkInAction.js.

/**
 * What the Check in button says, and whether it is live.
 *
 * THREE STATES, and the middle one is the one worth explaining. With no site chosen the
 * button is deliberately dead: the two-tab layout exists so that a clock-in is a decision
 * somebody made rather than whichever button their thumb landed on, and a button that
 * worked before a choice was made would undo that.
 *
 * When a sticker is required the button does NOT submit — it reopens the popup. Without
 * that, dismissing the popup left a selected tab and an inert button, with no way forward
 * and nothing on screen saying so.
 */
export function checkInButton({ site, tapRequired, busy }) {
  if (busy) return { label: "Checking you in…", enabled: false };
  if (site !== "Onsite" && site !== "Online") return { label: "Check in", enabled: false };
  if (site === "Onsite" && tapRequired) return { label: "Tap the sticker", enabled: true };
  return { label: "Check in", enabled: true };
}

// Keyed on the server's `reason`, never on its prose. The message is wording that changes
// for product reasons; the reason is an identifier that does not.
//
// EVERY ENTRY ENDS AT ONLINE except the location ones, and that is the difference from
// the student vocabulary in qrResultView.js: a member of staff refused for being off the
// network has an honest thing to record instead, and a student does not. Sharing one map
// would mean either telling students about an option they do not have, or leaving staff
// with a dead end they could have walked out of.
//
// The two CONFIGURATION failures read identically to the ordinary ones on purpose. A
// member of staff cannot tell "the college has not saved its IP ranges" from "you are not
// on the college network", and there is nothing they could do differently if they could.
const REFUSALS = {
  off_network: { heading: "You're not on the college network", advice: "Connect to the college WiFi and try again, or choose Online if you're working remotely." },
  network_not_configured: { heading: "You're not on the college network", advice: "Connect to the college WiFi and try again, or choose Online if you're working remotely." },
  off_campus: { heading: "You're not at a campus", advice: "Try again once you're on site, or choose Online if you're working remotely." },
  campus_not_located: { heading: "You're not at a campus", advice: "Try again once you're on site, or choose Online if you're working remotely." },
  position_missing: { heading: "Location is switched off", advice: "Turn location on for this app, then try again." },
  accuracy_unknown: { heading: "We couldn't pin down your location", advice: "Try again near a window, or choose Online if you're working remotely." },
  accuracy_too_poor: { heading: "We couldn't pin down your location", advice: "Try again near a window, or choose Online if you're working remotely." },
  tap_required: { heading: "Onsite clock-in is by sticker here", advice: "Tap the sticker in your building, or choose Online if you're working remotely." },
};

/**
 * A refused clock-in, in words.
 *
 * An unknown reason still answers something TRUE rather than nothing: a newer server and
 * an older app is an ordinary state of affairs for a packaged app that updates through a
 * store, and the alternative renders an empty red box.
 */
export function staffPlaceRefusal(reason) {
  return REFUSALS[reason] || {
    heading: "We couldn't check you're at the college",
    advice: "Try again, or choose Online if you're working remotely.",
  };
}
