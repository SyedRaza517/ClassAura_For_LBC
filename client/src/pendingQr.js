// The one-shot handoff between a scanned check-in QR and the signed-in student app.
//
// The projector QR encodes `#checkin=<sessionId>.<code>`. A FRAGMENT, deliberately: the
// code is a bearer credential for an attendance mark, and everything after # never
// leaves the phone — a ?checkin= query string would put every live code in the SPA
// host's access logs and the student's browser history, the two places the server side
// is careful never to write one.
//
// A fragment also never survives navigation, so the app stashes it here the moment it
// loads and strips the address bar. sessionStorage rather than localStorage on purpose:
// the stash should die with the tab, and it must never sync across a student's devices
// the way localStorage-backed state can.
//
// TEN MINUTES of shelf life — not to extend the code's validity (the server refuses an
// old code within a rotation or two regardless) but to survive the sign-in a student may
// have to do between scanning and landing in the app. A stale stash is dropped silently;
// the card's expired state already tells them to scan again, signed in this time.
const KEY = "edtech.pendingQr";
const MAX_AGE_MS = 10 * 60 * 1000;

function captureOnce() {
  // sessionId is a cuid and the code is base64url — neither contains a dot, which is
  // why a dot is the separator. Anything shaped differently is not ours; leave it.
  const m = /^#checkin=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(window.location.hash || "");
  if (!m) return false;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ sessionId: m[1], code: m[2], at: Date.now() }));
  } catch (_) {
    // Storage blocked (some private modes). Nothing to do: the student scans the code
    // again once signed in, which the check-in screen explains anyway.
  }
  window.history.replaceState({}, "", window.location.pathname + window.location.search);
  return true;
}

/**
 * Runs once at app load: capture a `#checkin=` fragment and strip it from the bar —
 * and keep listening. A camera app usually opens the link in a fresh tab, where the
 * load-time capture is enough; but a link that lands in an ALREADY-RUNNING app arrives
 * as a same-document navigation — no reload, no module re-evaluation — and without the
 * hashchange listener a second scan would sit in the address bar doing nothing. The
 * event tells a mounted StudentApp to pick the new scan up (see its listener).
 */
export function capturePendingQr() {
  if (typeof window === "undefined") return;
  captureOnce();
  window.addEventListener("hashchange", () => {
    if (captureOnce()) window.dispatchEvent(new CustomEvent("edtech:pending-qr"));
  });
}

/**
 * A code read by the in-app scanner takes the same road as a scanned link: stashed
 * here, announced the same way, consumed by the same card. One path from "the app
 * holds a code" to "the mark is written", however the code arrived.
 */
export function stashScan({ sessionId, code }) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ sessionId: String(sessionId), code: String(code), at: Date.now() }));
  } catch (_) {
    return false;
  }
  window.dispatchEvent(new CustomEvent("edtech:pending-qr"));
  return true;
}

/** A fresh scan is waiting — used to steer a signed-out visitor to the sign-in. */
export function hasPendingQr() {
  return read() !== null;
}

/**
 * Read WITHOUT removing. This is what a state initializer may call: React's dev-mode
 * StrictMode invokes initializers twice to surface impurity, and a read-and-remove in
 * one meant the first call swallowed the stash and the second — the one whose result
 * was kept — found nothing. The student signed in off a scan and landed on Home with
 * no mark. The consumer clears the stash at SUBMIT time instead, where a ref guards
 * against double-firing.
 */
export function peekPendingQr() {
  return read();
}

/** A non-student session must not carry a scan around — see App.jsx. */
export function clearPendingQr() {
  try { sessionStorage.removeItem(KEY); } catch (_) {}
}

// The classes this TAB has already checked into. It is the guard that survives a code
// rotation and a card remount, which the card's own `fired` ref cannot.
//
// THE BUG THIS CLOSES. One scan was turning into a burst of submissions: the projector
// code rotates every few seconds, and every fresh capture — a native camera app
// re-opening the same deep link through the hashchange listener above, or the card
// remounting because `key={pendingQr.code}` changed to the new code — starts with a fresh
// `fired` ref and fires another POST. The first is "marked"; the next lands "already
// marked"; once the code turns over they read "that code has expired, scan again" — a red
// error painted over a check-in that already worked — and enough of them trip the ten-a-
// minute limiter into "too many attempts". Recording the SESSION (not the code) is what
// makes the guard hold across rotations: the code changes, the class does not.
//
// sessionStorage and per tab, the same lifetime and blocked-storage tolerance as the
// pending scan above: the mark is the server's record, this is only "this tab already
// did that class, don't ask again". A genuine retry after a REFUSAL still works — only a
// scan that actually resulted in a mark is remembered, so a student refused for a stale
// code (and not yet marked) can still scan the new one.
const DONE_KEY = "edtech.qrCheckedIn";
const DONE_MAX = 50; // a long-lived tab that scanned many classes cannot grow unbounded

function readDone() {
  try {
    const raw = sessionStorage.getItem(DONE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.map(String) : [];
  } catch (_) {
    return [];
  }
}

/** Remember that this tab has a mark for `sessionId`, so a re-fired scan does not resubmit. */
export function noteCheckedIn(sessionId) {
  if (!sessionId) return;
  try {
    const list = readDone();
    if (list.includes(String(sessionId))) return;
    list.push(String(sessionId));
    while (list.length > DONE_MAX) list.shift();
    sessionStorage.setItem(DONE_KEY, JSON.stringify(list));
  } catch (_) {
    // Storage blocked — the card's `fired` ref still guards a single instance, and the
    // server answers a duplicate idempotently. Degrade, never throw.
  }
}

/** Has this tab already checked into `sessionId`? */
export function hasCheckedIn(sessionId) {
  if (!sessionId) return false;
  return readDone().includes(String(sessionId));
}

function read() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p?.sessionId || !p?.code) return null;
    if (Date.now() - (p.at || 0) > MAX_AGE_MS) return null;
    return { sessionId: String(p.sessionId), code: String(p.code) };
  } catch (_) {
    return null;
  }
}
