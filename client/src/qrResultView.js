// What a student sees after scanning, decided here rather than in the component.
//
// The card is only ever reached by a real scan against a real class, so a wrong branch
// here looks exactly like a working card and survives any amount of clicking about. Two
// did. See qrResultView.test.js for both, and for why this file exists at all.
//
// The rule this file enforces: the student is shown OUR words, chosen from the table
// below by the machine-readable `reason` the server sends. The server's own message text
// is never rendered. Those strings are written for whoever operates the deployment, and
// at least one of them is a configuration key's setup instructions.

/** The class, named the way a student would recognise it. */
function className(session) {
  return session?.unitName || session?.unitCode || "Your class";
}

/**
 * The card for a scan the server accepted.
 *
 * `good` is the tick. It is NOT the same question as "did the request succeed": a student
 * the lecturer already marked absent gets a perfectly successful response carrying the
 * worst news on the screen, and must not be shown a green tick over it.
 */
export function qrScanResult(result) {
  const r = result || {};
  const status = r.status || "P";
  const name = className(r.session);
  const at = r.checkedInAt || null;

  // A human set this, and it is the one answer worth interrupting for. The only move
  // open to the student is their lecturer, so the card says so instead of a next step
  // they cannot take.
  if (status === "A") {
    return {
      tone: "absent",
      good: false,
      heading: "You're marked absent for this class",
      chip: null,
      detail: `${name} · Your lecturer set this. Ask them if it's wrong.`,
    };
  }

  // Excused is not bad news and needs no action, but it is still not a check-in, so it
  // does not get the tick either.
  if (status === "E") {
    return { tone: "excused", good: false, heading: "You're marked excused for this class", chip: null, detail: name };
  }

  // P and L are both a successful check-in from the student's side — they are on the
  // register — so both read as success with the tick. We deliberately no longer split
  // the heading on `already`: a repeat scan (the projector code rotates and the camera
  // re-reads the same class) used to say "Already checked in", which students read as a
  // REJECTION of a check-in that had in fact worked. Now every accepted P/L scan says
  // "Checked in successfully"; the arrival time still travels in the detail, fresh or
  // repeat, as the proof their scan landed.
  const late = status === "L";
  return {
    tone: late ? "late" : "present",
    good: true,
    heading: "Checked in successfully",
    chip: late ? "Late" : null,
    detail: at ? `${name} · ${at}` : name,
  };
}

// One heading and at most one next step, per machine-readable reason. Every refusal the
// scan route can return is listed; anything not listed falls to the safe answer below,
// which is why an unmapped reason degrades to something useful rather than to whatever
// the server happened to say.
const REFUSALS = {
  qr_expired:     { heading: "That code has expired",              advice: "Scan the code on screen again." },
  qr_bad_code:    { heading: "That code isn't recognised",         advice: "Scan the code on screen again." },
  qr_missing:     { heading: "That code isn't recognised",         advice: "Scan the code on screen again." },
  no_session_now: { heading: "This class isn't running right now", advice: "Ask your lecturer to mark you in." },
  no_session:     { heading: "We can't find that class",           advice: "Ask your lecturer to mark you in." },
  term_locked:    { heading: "This register is closed",            advice: "Ask your lecturer to mark you in." },
  not_enrolled:   { heading: "You're not on the list for this class", advice: "Ask your lecturer to mark you in." },
  qr_off:         { heading: "Scanning isn't switched on",         advice: "Your lecturer will mark you in." },
  qr_unavailable: { heading: "Check-in isn't available right now",  advice: "Ask your lecturer to mark you in." },
  too_many:       { heading: "Too many tries",                     advice: "Wait a moment, then scan again." },

  // WHERE THE PHONE IS. These seven come from presence.js via refusedForPlace, and every
  // one of them was MISSING here until 11 Sep 2026 — a college that had switched the
  // network or geofence check on refused every scan with "That didn't work. Try scanning
  // again", which is the fallback below and is advice that cannot work. The student scans
  // again, is refused again for the same reason, and has been told nothing. That was the
  // whole of the defect: the server knew exactly why and the app threw the answer away.
  //
  // Each says WHAT IS WRONG AND WHAT TO DO, and the two failure kinds are kept apart —
  // "you are somewhere else" is a different action from "we cannot tell where you are".
  //
  // The two _not_configured / _not_located reasons are the college's misconfiguration,
  // not the student's: nobody entered the WiFi ranges, or nobody put coordinates on a
  // campus. The student is told the same thing as a genuine refusal ON PURPOSE, because
  // the alternative is telling them their college has set the product up wrong, which
  // they can do nothing with and which advertises the check to somebody working out how
  // to get past it. The distinction is kept where it is useful: the `reason` is logged
  // against every refusal, so an administrator looking at the tap log sees
  // `network_not_configured` and knows it is a settings screen, not a student.
  off_network:            { heading: "You're not on the college WiFi",     advice: "Join the college WiFi, then scan again." },
  network_not_configured: { heading: "You're not on the college WiFi",     advice: "Join the college WiFi, then scan again. If you already are, ask your lecturer to mark you in." },
  off_campus:             { heading: "You're too far from the college",    advice: "Check in from inside the building. If you're already there, ask your lecturer to mark you in." },
  campus_not_located:     { heading: "You're too far from the college",    advice: "Check in from inside the building. If you're already there, ask your lecturer to mark you in." },
  position_missing:       { heading: "Location is switched off",           advice: "Turn location on for this app, then scan again." },
  accuracy_unknown:       { heading: "We can't tell where you are",        advice: "Move near a window and scan again." },
  accuracy_too_poor:      { heading: "We can't tell where you are",        advice: "Move near a window and scan again." },
};

/** The card for a scan the server refused. Never renders the server's own wording. */
export function qrScanRefusal(error) {
  const known = REFUSALS[error?.body?.reason];
  if (known) return { ...known };
  // Covers a dropped connection, a 500, and any refusal added later without a reason.
  // "Try again, then ask a human" is the honest answer to all of them.
  return {
    heading: "That didn't work",
    advice: "Try scanning again. If it still won't work, ask your lecturer to mark you in.",
  };
}

/**
 * After a refused submit: should the scan be put back for after sign-in?
 *
 * The card clears the one-shot stash the moment it submits, so a reload cannot turn one
 * scan into two marks. A 401 is the one answer that means the request never reached the
 * register at all: the session had expired, the app is about to show the sign-in, and the
 * scan was the last thing the student did. Losing it sends them back to the projector for
 * no reason of their own. Every other refusal was a real answer to a real submit, and a
 * dropped connection is retried by scanning again — neither is resurrected.
 */
export function keepScanAfter(error) {
  return error?.status === 401;
}
