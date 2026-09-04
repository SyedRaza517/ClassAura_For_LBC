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
  const already = r.alreadyMarked === true;
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

  const late = status === "L";
  return {
    tone: late ? "late" : "present",
    good: true,
    heading: already ? "Already checked in" : at ? `Checked in at ${at}` : "Checked in",
    chip: late ? "Late" : null,
    // On a repeat scan the ORIGINAL time is the point: it is the answer to "did my first
    // scan work", which is the only reason anyone scans twice.
    detail: already && at ? `${name} · ${at}` : name,
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
