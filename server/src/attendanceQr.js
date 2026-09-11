// The rotating QR code a lecturer puts on screen, and what verifying one will accept.
//
// Pure: no database, no clock, no tenant. The caller reads the clock through clock.js and
// passes seconds in, and hands the signing key in as an argument. The same seam
// attendanceTap.js keeps, and for the same reason — this decides whether somebody is
// marked present, so every boundary has to be an ordinary unit test rather than something
// that only reproduces in a real classroom at 09:15 on a Tuesday.
//
// ============================================================================
// WHY THE CODE ROTATES, WHICH IS THE WHOLE DESIGN
// ============================================================================
//
// AttendanceTag.code — the NFC sticker's secret — is permanent, and its schema comment
// explains at length why it is deliberately not a URL: "a readable link is one a student
// can read off the wall with any phone and replay from home". That reasoning is right, and
// it is fatal to the obvious version of this feature. Printing the permanent tag code as a
// QR square would mean one student photographs the wall once and checks in from the bus
// for the rest of the term — a register full of fabricated presents, which is harder to
// challenge at an audit than an empty one and worse than having no feature at all.
//
// NFC is safe from that because reading a tag needs physical proximity. A printed square
// has no such property. So the code has to expire, and everything below follows from that.
//
// ============================================================================
// DERIVED, NEVER STORED
// ============================================================================
//
// The code is an HMAC over (sessionId, windowIndex). Nothing is written down. There is no
// table of live codes to clean up, no row that can go stale, no sweep job, and no way for
// a restart mid-lecture to invalidate a screen somebody is already scanning. Two servers
// behind a load balancer derive the same code from the same key without coordinating,
// which the in-process rate limiters elsewhere in this codebase cannot claim.
//
// The window index is the clock divided by the rotation period. That means a code is a
// pure function of (key, session, minute-ish), and verification is recomputation.
//
// ============================================================================
// WHY THE SESSION ID IS IN THE URL AND IS NOT A SECRET
// ============================================================================
//
// The link carries the session id in the clear alongside the signature. That is safe and
// it is load-bearing: knowing which register is on screen grants nothing without a current
// signature, and naming the session deletes an entire branch. The NFC path resolves
// candidates from Enrolment plus the clock and then has to ask a student which of two
// overlapping classes they meant; a code that names its own register has no ambiguity to
// resolve.
//
// What naming the session does NOT do is prove anything about who scanned it. The route
// still has to check enrolment, the session's own window, and the term lock. This module
// answers one question only: was this code minted, by us, for this session, just now.
const crypto = require("crypto");

// How long the code that has JUST rotated off screen keeps verifying.
//
// This was a whole extra window — the code before the current one verified for the whole
// of the current one — and it was too much of a good thing. That rule made a code live for
// up to TWICE the rotation period: mint it at the start of its window and it still works
// two full periods later. The rotation period is the single number this feature's honesty
// rests on, because it is literally how long a photographed screen keeps working, and
// doubling it behind a constant nobody reads gave away half of what the setting promised.
//
// The tolerance it was BUYING is real and is kept: a student who raised their phone at
// 19.8 seconds into a 20-second window must not be refused by their own network round
// trip, and "scan again" twice in a row is how a feature gets abandoned in week one. But
// that student needs a few seconds, not another twenty. So the old code is accepted only
// while we are within GRACE_SECONDS of the boundary it crossed.
//
// The difference is the whole point: a code's maximum life goes from rotate × 2 to
// rotate + GRACE. At the new 20-second default that is 27 seconds rather than 40, and the
// student with the slow phone is no worse off.
//
// Seven seconds covers a phone camera resolving a square and a mobile round trip on a
// congested lecture-hall network, with room to spare. It is a named constant with a test
// on it so that widening it is a deliberate edit somebody has to justify, rather than an
// off-by-one in a loop nobody reads — every second here is a second in which a
// photographed screen still works.
const GRACE_SECONDS = 7;

// How many windows are CONSIDERED at all. Two: the current one, and the one before it
// (which only verifies inside the grace above). Kept as its own constant because the
// diagnostic loop below starts where this one stops.
const ACCEPTED_WINDOWS = 2;

// How far back we keep CLAIMING TO RECOGNISE a code, purely to tell a student the truth
// about why it failed.
//
// "That code has expired — scan the new one" and "that code was never one of ours" are
// different sentences with different next steps, and the tap log an administrator reads is
// most useful precisely on the refusals. But the claim has to be bounded: past this, we
// stop asserting that a string was ever ours, because telling somebody to scan again is
// the wrong advice for a code we never issued. Twenty windows is ten minutes at the
// default rotation — long enough to cover a student who walked in, sat down and then
// scanned a screen that had moved on, and short enough that the loop stays trivial.
const DIAGNOSED_WINDOWS = 20;

// Base64url characters of the digest that actually travel in the link.
//
// A full HMAC-SHA256 is 43 base64url characters. Twenty-two is about 132 bits, which is
// vastly more than a code living for thirty seconds needs, and the difference is not
// cosmetic: a shorter payload is a less dense QR square, and a less dense square is one a
// phone at the back of a lecture hall can actually resolve. Scannability at distance is
// the real constraint here, not brute force.
const CODE_LENGTH = 22;

/**
 * Which rotation window an instant falls in.
 *
 * @param seconds  epoch seconds, from the caller's clock
 * @param rotateSeconds  the college's rotation period
 */
function windowIndexFor(seconds, rotateSeconds) {
  // A settings blob can be edited by hand in a console and a rotation of 0 is reachable.
  // Dividing by it yields Infinity, and an Infinity index makes every code in the
  // institution verify against every other one — a silent, total failure of the feature
  // that presents as everything working. Floor at one second.
  const period = Number.isFinite(Number(rotateSeconds)) && Number(rotateSeconds) >= 1
    ? Math.floor(Number(rotateSeconds))
    : 1;
  const t = Number.isFinite(Number(seconds)) ? Math.floor(Number(seconds)) : 0;
  return Math.floor(t / period);
}

/**
 * The code on screen for one session in one window.
 *
 * @param secret       the HMAC key, derived by the caller — see secrets.js. Deliberately
 *                     NOT the AES key used for integration credentials: signing with an
 *                     encryption key is a key-separation failure, and this module cannot
 *                     enforce that, so it takes the key as an argument and the resolver
 *                     is responsible for handing it the right one.
 * @param sessionId    HndSession.id
 * @param windowIndex  from windowIndexFor
 */
function deriveCode({ secret, sessionId, windowIndex }) {
  const id = typeof sessionId === "string" ? sessionId : "";
  // Length-prefixed rather than joined on a separator. A cuid is [a-z0-9] today, but the
  // canonical string must not be ambiguous for an id it does not control the shape of:
  // without the prefix, ("ab", 1) and ("a", "b1") could be made to collide, and a
  // collision here is one lecture's code opening another's register.
  const message = `${id.length}:${id}:${windowIndex}`;
  return crypto
    .createHmac("sha256", secret)
    .update(message, "utf8")
    .digest("base64url")
    .slice(0, CODE_LENGTH);
}

/** Constant-time string compare that tolerates a length mismatch instead of throwing. */
function sameCode(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  // timingSafeEqual THROWS when the buffers differ in length, and a truncated code is a
  // completely ordinary thing for a link handler to produce. Letting that throw would turn
  // a mangled URL into a 500 on the check-in route. Comparing lengths first leaks only the
  // length, which is a fixed constant of this module and therefore not a secret.
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Was this code minted by us, for this session, recently enough to accept?
 *
 * @returns { valid: true }
 *        | { valid: false, reason: "expired" }        — ours, but the screen has moved on
 *        | { valid: false, reason: "bad_signature" }  — not ours, or not for this session
 */
function verifyCode({ secret, sessionId, code, nowSeconds, rotateSeconds }) {
  // A route that forgot to pass one of these must mark nobody. Degrading into "verifies
  // whatever it is handed" is the failure mode worth being paranoid about, because it
  // would present as the feature working perfectly.
  if (typeof code !== "string" || code.length === 0) return { valid: false, reason: "bad_signature" };
  if (typeof sessionId !== "string" || sessionId.length === 0) return { valid: false, reason: "bad_signature" };
  if (!secret) return { valid: false, reason: "bad_signature" };

  const current = windowIndexFor(nowSeconds, rotateSeconds);

  // The code on screen right now always verifies.
  if (sameCode(code, deriveCode({ secret, sessionId, windowIndex: current }))) return { valid: true };

  // The one that just rotated off verifies ONLY for a few seconds after it did so.
  //
  // Recomputed here rather than taken from windowIndexFor, which returns the index and
  // discards the remainder — and the remainder is the whole question. `intoWindow` is how
  // far into the current window we are, so it is also exactly how long ago the previous
  // code left the screen.
  //
  // Backwards only, and there is deliberately no forward tolerance: a code that verifies
  // before it is displayed is a replay window with extra steps, and clock skew between our
  // own processes is not something this feature has to absorb — the same server derived
  // the code the lecturer is showing.
  const period = Number.isFinite(Number(rotateSeconds)) && Number(rotateSeconds) >= 1
    ? Math.floor(Number(rotateSeconds))
    : 1;
  const t = Number.isFinite(Number(nowSeconds)) ? Math.floor(Number(nowSeconds)) : 0;
  const intoWindow = t - current * period;
  if (intoWindow < GRACE_SECONDS) {
    if (sameCode(code, deriveCode({ secret, sessionId, windowIndex: current - 1 }))) return { valid: true };
  }

  // FROM ONE, NOT FROM ACCEPTED_WINDOWS. This started at 2 while the previous window was
  // accepted outright, which was correct then and became wrong the moment the grace was
  // bounded: the previous window's code is now REFUSED once the grace passes, and it is
  // the commonest refusal there is — a student a few seconds late. Starting the diagnosis
  // at 2 skipped straight past it, so the one refusal everybody meets reported itself as
  // "that code was never one of ours" instead of "that code has expired, scan the new
  // one". The wrong sentence, with the wrong next step, on the most frequent failure.
  //
  // Starting at 1 costs one extra HMAC on a path that has already failed, and it cannot
  // wrongly ACCEPT anything: this loop only ever returns { valid: false }.
  for (let back = 1; back < DIAGNOSED_WINDOWS; back += 1) {
    if (sameCode(code, deriveCode({ secret, sessionId, windowIndex: current - back }))) {
      return { valid: false, reason: "expired" };
    }
  }

  return { valid: false, reason: "bad_signature" };
}

module.exports = {
  windowIndexFor,
  deriveCode,
  verifyCode,
  ACCEPTED_WINDOWS,
  GRACE_SECONDS,
  DIAGNOSED_WINDOWS,
  CODE_LENGTH,
};
