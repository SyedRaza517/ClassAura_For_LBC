// What the in-app scanner accepts from a decoded QR.
//
// Two shapes and nothing else: the projector's own link (`…#checkin=<session>.<code>`,
// on whatever origin the lecturer's screen was on) and a bare `<session>.<code>` pair.
// The pattern is the one pendingQr.js captures from the address bar, so a code that
// arrives through the camera and one that arrives through a link are the same thing
// by the time the app holds them. A `?checkin=` query form is deliberately NOT read:
// the code is a bearer credential and must never be taught to travel where servers
// log it.
const PAIR = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

export function parseScan(text) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t) return null;
  const hash = t.indexOf("#checkin=");
  const pair = hash >= 0 ? t.slice(hash + "#checkin=".length) : t;
  if (hash < 0 && /[/?:]/.test(pair)) return null; // a URL of some other kind
  const m = PAIR.exec(pair);
  return m ? { sessionId: m[1], code: m[2] } : null;
}
