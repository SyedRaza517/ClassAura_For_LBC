// The one secret this deployment signs things with, resolved in exactly one place.
//
// It used to live only in auth.js. It now has a second reader — the QR check-in signing
// key derives from it — and two copies of a rule like this is the hazard 08-conventions.md
// spends its length on: the copies do not drift loudly, they drift into a deployment where
// logins work and codes do not, or worse, where a fallback nobody meant to ship is signing
// something real.
//
// THE FALLBACK IS DEV-ONLY AND MUST STAY THAT WAY. It is a publicly-known string; anything
// signed with it can be forged by anyone reading this file. Production is required to
// provide a real secret and the process refuses to start without one, which is the
// behaviour auth.js has always had and this module preserves exactly.
const DEV_FALLBACK = "dev-only-change-me";

/** The secret, or a thrown error in production when none is configured. */
function sessionSecret() {
  const raw = process.env.JWT_SECRET;
  if (raw) return raw;
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET environment variable must be set in production");
  }
  return DEV_FALLBACK;
}

/** True when the above handed back the public development string. */
function usingDevSecret() {
  return !process.env.JWT_SECRET && process.env.NODE_ENV !== "production";
}

module.exports = { sessionSecret, usingDevSecret, DEV_FALLBACK };
