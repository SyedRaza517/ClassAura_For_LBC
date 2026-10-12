// A security audit of the rotating QR code, as tests.
//
// attendanceQr.test.js beside this file already covers the SHAPE of the feature: what a
// code is, that it rotates, that the grace exists and is bounded. This file is the
// adversarial half, and it is deliberately a separate file rather than more tests in
// that one, for two reasons.
//
// The first is that these tests are written from the attacker's side of the glass. They
// do not ask "does the happy path work"; they take a valid code and try every way of
// changing it, every way of moving the clock, and every way of handing the verifier
// something that is not a code at all. Mixed in with the design tests, that intent gets
// lost and somebody later "tidies" a hostile input out of a loop because it looks
// redundant next to the one above it.
//
// The second is that an audit file is allowed to assert things about the IMPLEMENTATION
// that a design test should not — that the comparison goes through
// crypto.timingSafeEqual rather than ===, for instance. That is a white-box assertion
// and it would be wrong in a behaviour test, because behaviour cannot see it. It is
// exactly right here, because the whole value of a constant-time compare is invisible
// from the outside: a === comparison passes every behavioural test this feature has.
//
// WHAT IS DELIBERATELY NOT HERE. Nothing in this file touches a database, a clock or a
// request. attendanceQr.js takes `nowSeconds` as an argument precisely so every boundary
// is an ordinary unit test, and that seam is used rather than sleeping: a test that
// sleeps 27 seconds to prove a code died is a test somebody will delete when the suite
// gets slow. The HTTP behaviour of the scan route — which status code, which reason, what
// lands in the log — belongs in scripts/smoke-qr-checkin.mjs and is asserted there.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  windowIndexFor,
  deriveCode,
  verifyCode,
  graceFor,
  GRACE_SECONDS,
  DIAGNOSED_WINDOWS,
  CODE_LENGTH,
} = require("./attendanceQr");

const SECRET = Buffer.from("a-signing-key-32-bytes-long-ok!!", "utf8");
const OTHER_SECRET = Buffer.from("a-DIFFERENT-signing-key-32-bytes", "utf8");
const SESSION = "ckqrsess0000audit0000aaaa";
const OTHER_SESSION = "ckqrsess0000audit0000bbbb";
const ROTATE = 20;
// A round number of rotations past the epoch, so the instant sits exactly on a window
// boundary and every offset below is unambiguous. Chosen rather than Date.now() because a
// boundary test whose starting point drifts with the wall clock is a test that passes most
// of the time, which is the worst kind.
const NOW = 1_800_000_000;

/** The code on screen for a session at an instant, at a given rotation period. */
const codeAt = (seconds, { rotate = ROTATE, session = SESSION, secret = SECRET } = {}) =>
  deriveCode({ secret, sessionId: session, windowIndex: windowIndexFor(seconds, rotate) });

/** Shorthand for "would the server accept this code at this instant". */
const accepts = (code, nowSeconds, { rotate = ROTATE, session = SESSION, secret = SECRET } = {}) =>
  verifyCode({ secret, sessionId: session, code, nowSeconds, rotateSeconds: rotate });

/* ========================================================================== *
 * 1. TAMPERING — the code is a signature, so prove it behaves like one
 * ========================================================================== */

test("AUDIT: every single-character mutation of a live code is refused", () => {
  // The whole-string tests next door ("refuses a code signed with another key") prove the
  // verifier rejects something obviously different. They do not prove it rejects something
  // ALMOST right, and "almost right" is what a tamperer produces: the code off the screen
  // with one character changed, because the attacker is guessing at a checksum or probing
  // for a truncating comparison. A verifier that compared only a prefix, or that had been
  // "optimised" to compare the first n characters, would pass every existing test in this
  // feature and fail here.
  //
  // Exhaustive over positions, and over a small alphabet per position rather than all 64
  // base64url characters — 22 positions x 4 substitutes is 88 recomputations, which is
  // instant, and a comparison that is wrong is wrong at every position, so widening the
  // alphabet buys nothing.
  const good = codeAt(NOW);
  assert.equal(good.length, CODE_LENGTH, "the fixture must be a real, full-length code");
  assert.equal(accepts(good, NOW).valid, true, "the unmutated fixture must be accepted");

  const substitutes = ["A", "z", "0", "_"];
  let checked = 0;
  for (let i = 0; i < good.length; i += 1) {
    for (const ch of substitutes) {
      if (good[i] === ch) continue;
      const mutated = good.slice(0, i) + ch + good.slice(i + 1);
      const out = accepts(mutated, NOW);
      assert.equal(out.valid, false, `mutating position ${i} to "${ch}" was accepted: ${mutated}`);
      // And it must read as a forgery, not as an expiry. "That code has expired, scan the
      // new one" is advice; telling a tamperer to try again is the wrong sentence, and in
      // the log it would bury a forgery attempt among the ordinary late arrivals.
      assert.equal(out.reason, "bad_signature", `mutating position ${i} to "${ch}" read as ${out.reason}`);
      checked += 1;
    }
  }
  // Guard against the loop silently doing nothing — the failure mode testing.md records
  // twice in recent work.
  assert.ok(checked >= CODE_LENGTH * 3, `expected ~66+ mutations, made ${checked}`);
});

test("AUDIT: a flipped BIT, not merely a flipped character, is refused", () => {
  // The same property stated at the level the attacker actually works at. A base64url
  // character carries six bits; flipping one of them yields a neighbouring character, so
  // this is the narrowest possible change to the digest that travels in the link.
  const good = codeAt(NOW);
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let checked = 0;
  for (let i = 0; i < good.length; i += 1) {
    const value = ALPHABET.indexOf(good[i]);
    assert.ok(value >= 0, `code character "${good[i]}" is outside base64url — the link is not URL-safe`);
    for (let bit = 0; bit < 6; bit += 1) {
      const flipped = ALPHABET[value ^ (1 << bit)];
      const mutated = good.slice(0, i) + flipped + good.slice(i + 1);
      assert.equal(accepts(mutated, NOW).valid, false, `flipping bit ${bit} of position ${i} was accepted`);
      checked += 1;
    }
  }
  assert.equal(checked, CODE_LENGTH * 6, "every bit of every character must have been flipped");
});

test("AUDIT: truncating or extending a code by one character is refused, not compared short", () => {
  // The length path through sameCode. It exists because timingSafeEqual THROWS on a length
  // mismatch, and a truncated code is an entirely ordinary thing for a mangled URL to
  // produce — so the guard is load-bearing for availability as well as for correctness.
  // What must never happen is the OTHER resolution of the same problem: padding or
  // slicing one side to match, which turns a 1-character code into a prefix comparison.
  const good = codeAt(NOW);
  const shorter = good.slice(0, -1);
  const longer = `${good}A`;
  const prefix = good.slice(0, 1);

  for (const [label, candidate] of [["one short", shorter], ["one long", longer], ["first character only", prefix]]) {
    const out = accepts(candidate, NOW);
    assert.equal(out.valid, false, `a code ${label} was accepted`);
    assert.equal(out.reason, "bad_signature", `a code ${label} read as ${out.reason}`);
  }
});

test("AUDIT: a code replayed into a DIFFERENT session is refused at the same instant", () => {
  // The session id is in the link in the clear, so an attacker holding a live code also
  // holds the id of the register it was minted for, and swapping it for the register they
  // actually want is the obvious attack. It fails because the id is INSIDE the HMAC, and
  // this asserts it in both directions — a code for A refused against B, and a code for B
  // refused against A — because a one-directional test would pass against a verifier that
  // had collapsed both sessions to the same canonical message.
  const forA = codeAt(NOW, { session: SESSION });
  const forB = codeAt(NOW, { session: OTHER_SESSION });
  assert.notEqual(forA, forB, "two sessions must not share a code in the same window");

  assert.equal(accepts(forB, NOW, { session: SESSION }).valid, false, "B's code opened A's register");
  assert.equal(accepts(forA, NOW, { session: OTHER_SESSION }).valid, false, "A's code opened B's register");
  // And both read as forgeries rather than expiries: the code was never ours FOR THIS
  // SESSION, which is the only question this module answers.
  assert.equal(accepts(forB, NOW, { session: SESSION }).reason, "bad_signature");
});

test("AUDIT: the length prefix makes the signed message unambiguous for adjacent session ids", () => {
  // deriveCode's comment says a separator-joined message could be made to collide:
  // without the length prefix, ("ab", 1) and ("a", "b1") are the same string, and a
  // collision here is one lecture's code opening another's register. A cuid is [a-z0-9]
  // today, so the collision is not reachable through real ids — which is exactly why this
  // needs a test rather than a reader's confidence. The ids below are the shapes the
  // prefix exists to separate.
  const pairs = [
    ["ab", "a"],
    ["session1", "session"],
    ["12", "1"],
  ];
  for (const [long, short] of pairs) {
    // The window index is appended to the message, so the pairing being defended against
    // is (long, w) against (short, <last char of long><w>) — unreachable with a numeric
    // index, but the assertion that matters is simply that no two distinct ids share a
    // code in the same window.
    const w = windowIndexFor(NOW, ROTATE);
    assert.notEqual(
      deriveCode({ secret: SECRET, sessionId: long, windowIndex: w }),
      deriveCode({ secret: SECRET, sessionId: short, windowIndex: w }),
      `"${long}" and "${short}" collided`
    );
  }
});

test("AUDIT: the window index is the SERVER'S arithmetic, not a value in the link", () => {
  // There is no timestamp and no window number in the payload — the link is the session id
  // plus a signature, and the index is recomputed from the server's own clock. So "a
  // modified timestamp" is not an attack that exists against this design, and this test
  // records WHY by showing the only two ways an index can move, and that both are refused:
  // a code from a window that has not arrived, and a code from one that has gone.
  const current = windowIndexFor(NOW, ROTATE);
  for (const shift of [-3, -2, 2, 3, 10, 50]) {
    const code = deriveCode({ secret: SECRET, sessionId: SESSION, windowIndex: current + shift });
    assert.equal(accepts(code, NOW).valid, false, `a code from window ${shift >= 0 ? "+" : ""}${shift} was accepted`);
  }
  // And the only index accepted besides the current one is current - 1, inside the grace.
  // Asserted here as the complete list, so adding a third would fail this test rather than
  // quietly widening what the feature promises.
  const accepted = [];
  for (let shift = -5; shift <= 5; shift += 1) {
    const code = deriveCode({ secret: SECRET, sessionId: SESSION, windowIndex: current + shift });
    if (accepts(code, NOW).valid) accepted.push(shift);
  }
  assert.deepEqual(accepted, [-1, 0], `exactly the current window and the one before it may verify, got ${accepted}`);
});

test("AUDIT: verification is recomputation — the key, and nothing the caller sends, decides", () => {
  // The failure mode worth being paranoid about is a verifier that has degraded into
  // "verifies whatever it is handed". Three separate ways of degrading, all refused:
  //
  //   a code signed with another key           — a forger with the algorithm but not the key
  //   a code verified with no key at all       — a route that lost its secret
  //   a code valid at ANOTHER rotation period  — the period is the college's setting, not
  //                                              a field the phone sends, and a verifier
  //                                              that took it from the request would let an
  //                                              attacker pick a 300-second window
  const forged = codeAt(NOW, { secret: OTHER_SECRET });
  assert.equal(accepts(forged, NOW).valid, false, "a code signed with another key verified");

  for (const noKey of [undefined, null, "", 0, false]) {
    const out = verifyCode({ secret: noKey, sessionId: SESSION, code: codeAt(NOW), nowSeconds: NOW, rotateSeconds: ROTATE });
    assert.equal(out.valid, false, `a missing secret (${JSON.stringify(noKey)}) still verified a real code`);
    assert.equal(out.reason, "bad_signature");
  }

  // Same instant, same session, same key — different period, so a different window index,
  // so a different code. Neither verifies against the other.
  const at20 = codeAt(NOW + 7, { rotate: 20 });
  const at300 = codeAt(NOW + 7, { rotate: 300 });
  assert.notEqual(at20, at300, "the period must change the code");
  assert.equal(accepts(at300, NOW + 7, { rotate: 20 }).valid, false, "a 300-second code verified on a 20-second college");
});

/* ========================================================================== *
 * 2. CONSTANT TIME — the one property no behaviour test can see
 * ========================================================================== */

test("AUDIT: the comparison goes through crypto.timingSafeEqual, not ===", () => {
  // WHITE BOX, ON PURPOSE. A === comparison passes every other test in this feature and
  // every assertion in the smoke suite, because the two are behaviourally identical. The
  // difference is a timing side channel: === on strings returns at the first differing
  // byte, so an attacker who can measure the verify can recover a code character by
  // character. The code lives 27 seconds, which makes the attack impractical rather than
  // impossible — and "impractical" is not the reason the constant-time compare is here.
  //
  // So this test asserts the mechanism rather than the outcome: it spies on
  // crypto.timingSafeEqual and insists the accept path actually called it. Replacing
  // sameCode's body with `a === b` fails this and nothing else, which is precisely the
  // regression worth owning a test.
  const real = crypto.timingSafeEqual;
  let calls = 0;
  let lengthMismatch = false;
  crypto.timingSafeEqual = (a, b) => {
    calls += 1;
    // timingSafeEqual throws on a length mismatch. sameCode compares lengths FIRST to
    // avoid that, so reaching here with unequal buffers would mean a mangled URL could
    // turn into a 500 on the check-in route.
    if (a.length !== b.length) lengthMismatch = true;
    return real(a, b);
  };
  try {
    const out = accepts(codeAt(NOW), NOW);
    assert.equal(out.valid, true, "the fixture must still verify while the spy is installed");
    assert.ok(calls > 0, "verifyCode accepted a code without going through crypto.timingSafeEqual");
    assert.equal(lengthMismatch, false, "timingSafeEqual was handed buffers of different lengths — it would throw");
  } finally {
    crypto.timingSafeEqual = real;
  }
});

test("AUDIT: a wrong-length code never reaches timingSafeEqual at all", () => {
  // The other half of the same guard, from the availability side. Every length in this
  // list is something a real client produces — a truncated URL, a query parameter that
  // picked up a trailing slash, an empty scan — and every one of them must be refused
  // WITHOUT the length-sensitive primitive being called.
  const real = crypto.timingSafeEqual;
  let calls = 0;
  crypto.timingSafeEqual = (a, b) => { calls += 1; return real(a, b); };
  try {
    for (const candidate of ["x", "short", `${codeAt(NOW)}/`, "a".repeat(CODE_LENGTH + 1), "a".repeat(200)]) {
      const out = verifyCode({ secret: SECRET, sessionId: SESSION, code: candidate, nowSeconds: NOW, rotateSeconds: ROTATE });
      assert.equal(out.valid, false, `"${candidate.slice(0, 30)}" was accepted`);
    }
    assert.equal(calls, 0, `a wrong-length code reached timingSafeEqual ${calls} time(s) — one day it will throw`);
  } finally {
    crypto.timingSafeEqual = real;
  }
});

/* ========================================================================== *
 * 3. LIFETIME — the exact second a code dies, at every setting a college can pick
 * ========================================================================== */

test("AUDIT: a code's life is EXACTLY rotate + grace - 1 seconds, at every configurable period", () => {
  // The number this feature's honesty rests on, swept second by second rather than
  // sampled. attendanceQr.test.js asserts the bound at the default and at the floor; this
  // walks the whole range a college can set, including the awkward periods where
  // floor(period / 3) is not a round number, and asserts the boundary from BOTH sides at
  // each one: alive at the last second, refused at the next.
  //
  // Why both sides. A test that only asserts "refused eventually" passes against a
  // verifier with no grace at all, and a test that only asserts "alive at 25 seconds"
  // passes against one that accepts forever. An off-by-one at the boundary — >= where >
  // was meant, or grace counted from the wrong window — moves the answer by exactly one
  // second, and one second is the whole difference between the two mistakes.
  //
  // 10 and 300 are the floor and ceiling the settings merge clamps to; 11, 20, 21, 29, 30
  // and 59 are the periods where the integer division of the grace lands awkwardly.
  for (const period of [10, 11, 12, 20, 21, 29, 30, 59, 60, 121, 300]) {
    const grace = graceFor(period);
    // Minted at the very start of its window, which is the longest-lived case: a code
    // picked up later in its own window has correspondingly less life left.
    const mintedAt = NOW - (NOW % period);
    const code = codeAt(mintedAt, { rotate: period });
    const lastAlive = mintedAt + period + grace - 1;

    assert.equal(accepts(code, lastAlive, { rotate: period }).valid, true,
      `rotate=${period} grace=${grace}: the code died a second early, at +${lastAlive - mintedAt}`);
    const dead = accepts(code, lastAlive + 1, { rotate: period });
    assert.equal(dead.valid, false,
      `rotate=${period} grace=${grace}: the code outlived rotate+grace, still valid at +${lastAlive + 1 - mintedAt}`);
    // Once dead it must read as expired, not as a forgery — this is the commonest refusal
    // there is (a student a few seconds late) and it needs the sentence with a next step.
    assert.equal(dead.reason, "expired",
      `rotate=${period}: a just-expired code reported "${dead.reason}" instead of "expired"`);

    // And it is alive for EVERY second in between, not merely at the two ends. A verifier
    // with a hole in the middle — accepting the current window and the previous one but
    // mishandling the instant of the boundary itself — passes a two-point test.
    for (let t = mintedAt; t <= lastAlive; t += 1) {
      assert.equal(accepts(code, t, { rotate: period }).valid, true,
        `rotate=${period}: refused at +${t - mintedAt}, inside its own lifetime`);
    }
  }
});

test("AUDIT: the grace is counted from the BOUNDARY the code crossed, not from the code's own age", () => {
  // The subtle version of the same boundary, and the one an "optimisation" breaks.
  //
  // intoWindow is how far into the CURRENT window we are, which is also exactly how long
  // ago the previous code left the screen. A verifier that instead measured the code's own
  // age — "was this minted less than rotate + grace ago" — would behave identically for a
  // code minted at the start of its window and WRONGLY for one minted at the end of it,
  // handing the late-window code an extra lifetime it is not owed.
  //
  // So: take the instant just before a rotation, where the code on screen is seconds old.
  // Once the window turns, that code gets `grace` seconds and no more, however young it is.
  const period = 20;
  const grace = graceFor(period);
  const boundary = NOW - (NOW % period) + period;   // the instant the screen turns over
  const oldCode = codeAt(boundary - 1, { rotate: period });   // on screen for 19 of its 20 seconds

  assert.equal(accepts(oldCode, boundary - 1, { rotate: period }).valid, true, "it is the current code a second before the turn");
  assert.equal(accepts(oldCode, boundary + grace - 1, { rotate: period }).valid, true, "and it keeps the full grace after the turn");
  assert.equal(accepts(oldCode, boundary + grace, { rotate: period }).valid, false,
    "a code that was nearly new when the window turned still gets only the grace, never another window");
});

test("AUDIT: there is no forward tolerance at any second of any window", () => {
  // Stated as the absence it is. A code that verifies before it is displayed is a replay
  // window with extra steps: it would let somebody who has obtained the signing key — or
  // simply a screenshot taken a moment too early by a clock a second fast — check in for a
  // minute that has not happened. attendanceQr.js refuses it deliberately and says so; the
  // existing test checks one instant, and this checks every second of the window, because
  // a forward tolerance introduced as "within a second of the boundary" would only show
  // itself at the boundary.
  for (const period of [10, 20, 300]) {
    const start = NOW - (NOW % period);
    const nextCode = codeAt(start + period, { rotate: period });
    for (let t = start; t < start + period; t += 1) {
      assert.equal(accepts(nextCode, t, { rotate: period }).valid, false,
        `rotate=${period}: tomorrow's code verified at +${t - start}`);
    }
  }
});

test("AUDIT: GRACE_SECONDS is a ceiling the scaling never exceeds, at any period", () => {
  // graceFor is min(GRACE_SECONDS, floor(period / 3)) with a floor of 1, and the existing
  // tests check the three documented rows of its table. This asserts the invariant across
  // the whole range plus the hostile inputs, so widening the constant stays a deliberate
  // edit and a rewrite of the scaling cannot accidentally exceed it.
  for (let period = 1; period <= 400; period += 1) {
    const g = graceFor(period);
    assert.ok(g >= 1, `period ${period}: a zero grace is refusal-by-latency`);
    assert.ok(g <= GRACE_SECONDS, `period ${period}: grace ${g} exceeds the named ceiling ${GRACE_SECONDS}`);
    assert.ok(g <= Math.max(1, Math.floor(period / 3)), `period ${period}: grace ${g} is more than a third of the window`);
  }
  for (const nonsense of [0, -1, -1000, NaN, Infinity, -Infinity, null, undefined, "20", {}, []]) {
    const g = graceFor(nonsense);
    assert.ok(Number.isInteger(g) && g >= 1 && g <= GRACE_SECONDS,
      `graceFor(${JSON.stringify(nonsense)}) returned ${g}`);
  }
});

/* ========================================================================== *
 * 4. THE DIAGNOSIS WINDOW — how far back we claim to recognise a code
 * ========================================================================== */

test("AUDIT: the diagnosis reaches back DIAGNOSED_WINDOWS - 1 windows and no further", () => {
  // The boundary of a claim rather than of a permission, so getting it wrong is not a
  // security hole — the loop only ever returns { valid: false }. It is still worth
  // pinning, because the two answers send a student somewhere different: "expired, scan
  // the new one" is advice, and "that code was never one of ours" is a reason to go and
  // find the lecturer. Drifting the bound changes which sentence the commonest refusal
  // gets, which is exactly the bug the FROM ONE, NOT FROM TWO comment records.
  //
  // The loop runs `back` from 1 to DIAGNOSED_WINDOWS - 1 inclusive, so the oldest code
  // still diagnosed is 19 windows back at the current constant of 20. Asserted against the
  // exported constant rather than against 19, so changing the constant moves the test with
  // it — but asserted from BOTH sides, so changing the loop bound without the constant
  // fails here.
  const current = windowIndexFor(NOW, ROTATE);

  const oldestDiagnosed = deriveCode({ secret: SECRET, sessionId: SESSION, windowIndex: current - (DIAGNOSED_WINDOWS - 1) });
  const beyond = deriveCode({ secret: SECRET, sessionId: SESSION, windowIndex: current - DIAGNOSED_WINDOWS });

  const inside = accepts(oldestDiagnosed, NOW);
  assert.equal(inside.valid, false, "a code 19 windows old must never be ACCEPTED");
  assert.equal(inside.reason, "expired",
    `the oldest diagnosed window read as "${inside.reason}" — the diagnosis loop is short by one`);

  const outside = accepts(beyond, NOW);
  assert.equal(outside.valid, false);
  assert.equal(outside.reason, "bad_signature",
    `a code ${DIAGNOSED_WINDOWS} windows old still claimed to be ours — we must stop asserting that`);

  // Every window in between is diagnosed, not just the last one.
  for (let back = 2; back <= DIAGNOSED_WINDOWS - 1; back += 1) {
    const code = deriveCode({ secret: SECRET, sessionId: SESSION, windowIndex: current - back });
    const out = accepts(code, NOW);
    assert.equal(out.valid, false, `a code ${back} windows old was ACCEPTED`);
    assert.equal(out.reason, "expired", `a code ${back} windows old read as ${out.reason}`);
  }
});

test("AUDIT: the diagnosis never upgrades a forgery into an expiry", () => {
  // The diagnosis loop is twenty extra HMACs on a path that has already failed, and the
  // thing to be sure of is that it cannot CHANGE the verdict. A code signed with another
  // key, or for another session, must read as a forgery however old its window is — never
  // as "expired, scan again", which would tell a forger to keep trying and would hide the
  // attempt in the log among the late arrivals.
  const current = windowIndexFor(NOW, ROTATE);
  for (let back = 0; back <= DIAGNOSED_WINDOWS + 2; back += 1) {
    const wrongKey = deriveCode({ secret: OTHER_SECRET, sessionId: SESSION, windowIndex: current - back });
    const wrongSession = deriveCode({ secret: SECRET, sessionId: OTHER_SESSION, windowIndex: current - back });
    for (const [label, code] of [["another key", wrongKey], ["another session", wrongSession]]) {
      const out = accepts(code, NOW);
      assert.equal(out.valid, false, `${label}, ${back} windows back, was accepted`);
      assert.equal(out.reason, "bad_signature", `${label}, ${back} windows back, read as ${out.reason}`);
    }
  }
});

/* ========================================================================== *
 * 5. REPLAY — what a code does and does not bind
 * ========================================================================== */

test("AUDIT: NOTHING IN A CODE NAMES A PERSON, A DEVICE OR A LOCATION", () => {
  // The single most important fact about this feature's threat model, asserted rather than
  // left to be inferred from the HMAC's arguments.
  //
  // A code is HMAC(key, sessionId, windowIndex). It is not bound to a student, a device, an
  // IP address or a position, and it CANNOT be: one square on a projector is read by a
  // room full of phones, so a code that named a person would have to be a code per person,
  // which is a different feature. The design is right, and the consequence is real and
  // belongs in writing: a student who photographs the square and sends it to an enrolled
  // friend off site has handed them a working check-in for as long as the code lives.
  //
  // So verification cannot be what stops a relay. What stops the obvious abuses is
  // everything the ROUTE adds afterwards — the roster check, the session's own window, the
  // term lock, the unique mark per (session, student), and the presence checks when a
  // college switches them on. This test nails down that the module itself offers no such
  // protection, so nobody reads the HMAC and assumes it does.
  const code = codeAt(NOW);

  // Extra fields handed to deriveCode are IGNORED, not mixed in. If a later change bound a
  // student into the code, this assertion would fail and whoever made the change would
  // have to look at the room-full-of-phones problem rather than discovering it in a
  // lecture theatre.
  const withStudent = deriveCode({
    secret: SECRET, sessionId: SESSION, windowIndex: windowIndexFor(NOW, ROTATE),
    studentId: "a-student", deviceId: "a-device", ip: "203.0.113.9",
  });
  assert.equal(withStudent, code, "deriveCode mixed in a field it does not document — see the comment above");

  // And verifyCode's verdict is identical however the request describes its sender, which
  // is the same statement from the other end: there is nothing about the scanner for the
  // signature to disagree with.
  const verdicts = new Set();
  for (const extra of [
    {},
    { studentId: "student-one" },
    { studentId: "student-two" },
    { deviceId: "phone-a" },
    { ip: "198.51.100.1" },
    { position: { latitude: 0, longitude: 0 } },
  ]) {
    const out = verifyCode({ secret: SECRET, sessionId: SESSION, code, nowSeconds: NOW, rotateSeconds: ROTATE, ...extra });
    verdicts.add(JSON.stringify(out));
  }
  assert.equal(verdicts.size, 1, "the verdict changed with who was asking — it cannot, and must not appear to");
  assert.deepEqual([...verdicts], ['{"valid":true}']);
});

test("AUDIT: the same code verifies an unlimited number of times — there is no used-code memory", () => {
  // Derived, never stored, means there is no table of spent codes and no way for this
  // module to refuse a second use. Verifying the same code a thousand times returns
  // { valid: true } a thousand times, and that is by design.
  //
  // Recorded as a test because it is the fact a reviewer most often assumes away. Single
  // use would have to be enforced where the mark is written, not here — and it IS, by the
  // unique constraint on (sessionId, studentId): the second scan by the SAME student finds
  // a mark standing and reports it rather than writing another. What has no equivalent is
  // the second scan by a DIFFERENT enrolled student, which is a legitimate check-in when
  // they are in the room and an undetectable relay when they are not.
  const code = codeAt(NOW);
  for (let i = 0; i < 1000; i += 1) {
    assert.equal(accepts(code, NOW).valid, true, `the ${i}th verification of a live code was refused`);
  }
});

/* ========================================================================== *
 * 6. MALFORMED INPUT — a scan is a URL, and URLs arrive broken
 * ========================================================================== */

// Everything a scan route can plausibly be handed in place of a code, including the
// things no honest client sends. A table rather than a test each, because the ASSERTION is
// identical for all of them — refused, with a reason, without throwing — and what varies
// is only the input. Named so a failure says which one.
const HOSTILE = [
  ["an empty string", ""],
  ["a single space", " "],
  ["whitespace only", "   \t\n  "],
  ["a newline", "\n"],
  ["a NUL byte", "\0"],
  ["a code with a NUL in the middle", "AAAAAAAAAAA\0AAAAAAAAAA"],
  ["null", null],
  ["undefined", undefined],
  ["a number", 1234567890],
  ["a float", 1.5],
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["a boolean", true],
  ["an object", { code: "AAAAAAAAAAAAAAAAAAAAAA" }],
  ["an array", ["AAAAAAAAAAAAAAAAAAAAAA"]],
  ["an array of one character", ["A"]],
  ["a function", () => "AAAAAAAAAAAAAAAAAAAAAA"],
  ["a Buffer", Buffer.from("AAAAAAAAAAAAAAAAAAAAAA")],
  ["a Symbol", Symbol("code")],
  ["a BigInt", 10n],
  ["a Date", new Date(0)],
  ["a RegExp", /AAAAAAAAAAAAAAAAAAAAAA/],
  ["an object claiming to be a string", { toString: () => "AAAAAAAAAAAAAAAAAAAAAA" }],
  ["an object whose toString throws", { toString() { throw new Error("boom"); } }],
  ["a SQL fragment", "' OR 1=1 --"],
  ["a SQL fragment of code length", "' OR '1'='1' --       "],
  ["a DROP TABLE attempt", "'; DROP TABLE \"AttendanceMark\"; --"],
  ["a Prisma-flavoured injection", '{"equals":null}'],
  ["a NoSQL operator", "$ne"],
  ["a path traversal", "../../../../etc/passwd"],
  ["a template injection", "${process.env.JWT_SECRET}"],
  ["a script tag", "<script>alert(1)</script>"],
  ["__proto__", "__proto__"],
  ["constructor", "constructor"],
  ["a prototype-pollution shape", JSON.parse('{"__proto__":{"polluted":true}}')],
  ["unicode", "ＡＡＡＡＡＡＡＡＡＡＡＡＡＡＡＡＡＡＡＡＡＡ"],
  ["an emoji", "👩‍🎓👩‍🎓👩‍🎓👩‍🎓👩‍🎓👩‍🎓👩‍🎓👩‍🎓"],
  ["a right-to-left override", "‮AAAAAAAAAAAAAAAAAAAAA"],
  ["a zero-width joiner run", "​".repeat(22)],
  ["combining characters", "é".repeat(11)],
  ["a lone surrogate", "\ud800AAAAAAAAAAAAAAAAAAAAA"],
  ["base64 padding", "AAAAAAAAAAAAAAAAAAAA=="],
  ["standard base64 rather than base64url", "a+b/cAAAAAAAAAAAAAAAAA"],
  ["a URL", "https://example.test/qr?code=AAAAAAAAAAAAAAAAAAAAAA"],
  ["a whole JSON body", '{"sessionId":"x","code":"y"}'],
];

test("AUDIT: every malformed code is refused with a reason, and nothing throws", () => {
  for (const [label, code] of HOSTILE) {
    let out;
    assert.doesNotThrow(() => {
      out = verifyCode({ secret: SECRET, sessionId: SESSION, code, nowSeconds: NOW, rotateSeconds: ROTATE });
    }, `${label} threw out of verifyCode — on the route that is a 500 on a check-in`);
    assert.equal(out.valid, false, `${label} was ACCEPTED`);
    // A reason is not decoration: the route branches on it, answering 409 "scan the new
    // one" for an expiry and 404 "not recognised" for a forgery. A verdict with no reason
    // would fall through to the forgery branch by accident rather than by decision.
    assert.equal(out.reason, "bad_signature", `${label} reported reason "${out.reason}"`);
  }
});

test("AUDIT: a malformed code does not pollute Object.prototype on its way through", () => {
  // The __proto__ entries in the table above are only half the check. The other half is
  // that nothing in the verifier uses the code as a KEY — no memo, no cache, no bare
  // object index — because a bare `{}` indexed by an attacker-controlled string is how a
  // "__proto__" code becomes a mutated prototype for the whole process.
  const before = Object.keys(Object.prototype).length;
  for (const [, code] of HOSTILE) {
    verifyCode({ secret: SECRET, sessionId: SESSION, code, nowSeconds: NOW, rotateSeconds: ROTATE });
  }
  assert.equal(Object.keys(Object.prototype).length, before, "something wrote to Object.prototype");
  assert.equal({}.polluted, undefined, "Object.prototype.polluted exists — the verifier used a code as a key");
  assert.equal({}.toString, Object.prototype.toString, "Object.prototype.toString was replaced");
});

test("AUDIT: the sessionId is defended identically, because a route can lose one", () => {
  // verifyCode checks the session id as carefully as the code, and the reason is in its
  // header: a route that forgot to pass one must mark NOBODY, never degrade into a
  // verifier that accepts whatever it is handed. The empty-string case is the sharp one —
  // deriveCode coerces a non-string id to "", so a correctly-signed code FOR the empty
  // session exists and must still be refused.
  const good = codeAt(NOW);
  for (const [label, sessionId] of [
    ["an empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an object", {}],
    ["an array", []],
    ["a Buffer", Buffer.from(SESSION)],
  ]) {
    const out = verifyCode({ secret: SECRET, sessionId, code: good, nowSeconds: NOW, rotateSeconds: ROTATE });
    assert.equal(out.valid, false, `a real code verified against ${label} as the session`);
    assert.equal(out.reason, "bad_signature");

    // And the code correctly signed FOR that degenerate session is refused too, so the
    // coercion cannot be turned into a universal key.
    const forDegenerate = deriveCode({ secret: SECRET, sessionId, windowIndex: windowIndexFor(NOW, ROTATE) });
    const out2 = verifyCode({ secret: SECRET, sessionId, code: forDegenerate, nowSeconds: NOW, rotateSeconds: ROTATE });
    assert.equal(out2.valid, false, `a code signed for ${label} as the session verified against it`);
  }
});

test("AUDIT: a hostile clock cannot make a code verify", () => {
  // nowSeconds is injected by the caller and the caller is the route, which reads
  // Date.now() — so this is not an attacker-controlled field today. It is tested because
  // the seam is the whole reason this module is testable, and a future caller that passed
  // something through from a request would be a complete bypass. Every unusable instant
  // must behave like a FIXED instant (zero), never like "whatever makes this code work".
  const code = codeAt(NOW);
  for (const [label, now] of [
    ["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity],
    ["null", null], ["undefined", undefined],
    ["an object", {}], ["an array", []], ["a negative instant", -NOW],
  ]) {
    const out = verifyCode({ secret: SECRET, sessionId: SESSION, code, nowSeconds: now, rotateSeconds: ROTATE });
    assert.equal(out.valid, false, `nowSeconds=${label} verified a code from ${NOW}`);
  }

  // A NUMERIC STRING IS NOT HOSTILE, and this is recorded rather than asserted away.
  // windowIndexFor runs the value through Number(), so "1800000000" IS the instant
  // 1800000000 and the verdict is identical to the number's. That was the author's first
  // guess at a bug here and it is not one: the coercion cannot WIDEN anything, because it
  // can only produce the one instant the string spells. Pinned both ways so that a future
  // change to tighten the seam has to notice it is a behaviour change, not a fix.
  assert.deepEqual(
    verifyCode({ secret: SECRET, sessionId: SESSION, code, nowSeconds: String(NOW), rotateSeconds: ROTATE }),
    verifyCode({ secret: SECRET, sessionId: SESSION, code, nowSeconds: NOW, rotateSeconds: ROTATE }),
    "a numeric string instant must mean the same instant, no more and no less"
  );
  assert.equal(
    verifyCode({ secret: SECRET, sessionId: SESSION, code, nowSeconds: String(NOW + 600), rotateSeconds: ROTATE }).valid,
    false,
    "and a numeric string cannot be used to reach forward or back to a window that is not ours"
  );
  // The same, for the rotation period: unusable means a one-second window, which is the
  // TIGHTEST reading, never the loosest. A period that fell back to something large would
  // silently hand every college the permanent code this design exists to avoid.
  for (const [label, rotate] of [
    ["zero", 0], ["negative", -20], ["NaN", NaN], ["Infinity", Infinity],
    ["null", null], ["undefined", undefined], ["a string", "20"], ["an object", {}],
  ]) {
    const out = verifyCode({ secret: SECRET, sessionId: SESSION, code, nowSeconds: NOW + 60, rotateSeconds: rotate });
    assert.equal(out.valid, false, `rotateSeconds=${label} verified a minute-old code`);
  }
});

test("AUDIT: an oversized payload cannot hang the verifier", () => {
  // The scan route is behind express.json({ limit: "1mb" }) (server/src/index.js), so one
  // megabyte is the largest code that can physically arrive. It must be refused promptly:
  // the route calls verifyCode BEFORE any database read, so a verifier that degraded
  // quadratically on a long input would be a cheap way for one authenticated student to
  // spend the event loop.
  //
  // The budget is deliberately loose — this is a hang detector, not a benchmark, and a
  // tight assertion on a shared CI machine is a test that fails for reasons nobody can
  // reproduce. What it catches is an order-of-magnitude regression: a per-character loop,
  // a regex with backtracking, or an HMAC over the candidate rather than over the message.
  for (const size of [1_000, 100_000, 1_048_576]) {
    const huge = "A".repeat(size);
    const started = process.hrtime.bigint();
    const out = verifyCode({ secret: SECRET, sessionId: SESSION, code: huge, nowSeconds: NOW, rotateSeconds: ROTATE });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(out.valid, false, `a ${size}-character code was accepted`);
    assert.equal(out.reason, "bad_signature");
    assert.ok(ms < 2_000, `a ${size}-character code took ${ms.toFixed(0)}ms to refuse`);
  }

  // And a megabyte of VALID code characters, so the refusal is not an artefact of the
  // single repeated letter.
  const realistic = crypto.randomBytes(786_432).toString("base64url");
  const started = process.hrtime.bigint();
  assert.equal(verifyCode({ secret: SECRET, sessionId: SESSION, code: realistic, nowSeconds: NOW, rotateSeconds: ROTATE }).valid, false);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 2_000, "a megabyte of base64url took too long to refuse");

  // The same for an oversized SESSION id, which travels in the same body and reaches
  // deriveCode's message rather than sameCode's buffer — a different path with the same
  // exposure.
  const hugeSession = "s".repeat(1_048_576);
  const started2 = process.hrtime.bigint();
  const out = verifyCode({ secret: SECRET, sessionId: hugeSession, code: codeAt(NOW), nowSeconds: NOW, rotateSeconds: ROTATE });
  assert.equal(out.valid, false, "a megabyte session id verified a real code");
  assert.ok(Number(process.hrtime.bigint() - started2) / 1e6 < 2_000, "a megabyte session id took too long to refuse");
});

test("AUDIT: a code of the right length but the wrong alphabet is refused", () => {
  // Exactly CODE_LENGTH characters, so the length guard does not catch it and the
  // comparison genuinely runs. This is the shape a hand-written forgery takes — somebody
  // who has read attendanceQr.js, knows the length, and is guessing at the digest.
  const wrongAlphabet = [
    "!".repeat(CODE_LENGTH),
    "=".repeat(CODE_LENGTH),
    "/".repeat(CODE_LENGTH),
    "+".repeat(CODE_LENGTH),
    " ".repeat(CODE_LENGTH),
    "\0".repeat(CODE_LENGTH),
    "ßßßßßßßßßßßßßßßßßßßßßß",
  ];
  for (const code of wrongAlphabet) {
    const out = verifyCode({ secret: SECRET, sessionId: SESSION, code, nowSeconds: NOW, rotateSeconds: ROTATE });
    assert.equal(out.valid, false, `"${code}" was accepted`);
    assert.equal(out.reason, "bad_signature");
  }

  // A thousand random full-length guesses, none of which may verify. 22 base64url
  // characters is about 132 bits, so this is not a brute-force test — it is a test that
  // the comparison is not accidentally permissive at the right length.
  for (let i = 0; i < 1000; i += 1) {
    const guess = crypto.randomBytes(24).toString("base64url").slice(0, CODE_LENGTH);
    if (guess === codeAt(NOW)) continue;   // one in 2^132; handled rather than ignored
    assert.equal(verifyCode({ secret: SECRET, sessionId: SESSION, code: guess, nowSeconds: NOW, rotateSeconds: ROTATE }).valid,
      false, `a random guess verified: ${guess}`);
  }
});

test("AUDIT: a code is always exactly CODE_LENGTH characters, whatever it is derived from", () => {
  // The length guard in sameCode is only safe to rely on because this is true: if some
  // input produced a shorter digest, the guard would refuse a legitimate code. Swept over
  // the shapes a session id can take, including the ones a hand-edited row produces.
  for (const sessionId of ["", "a", SESSION, "s".repeat(500), "ünïcödé-sessión", "with spaces", "0"]) {
    for (const windowIndex of [0, -1, 1, 90_000_000, -90_000_000, 1.5, NaN, Infinity]) {
      const code = deriveCode({ secret: SECRET, sessionId, windowIndex });
      assert.equal(code.length, CODE_LENGTH, `deriveCode(${JSON.stringify(sessionId)}, ${windowIndex}) gave ${code.length} characters`);
      assert.match(code, /^[A-Za-z0-9_-]+$/, `deriveCode(${JSON.stringify(sessionId)}, ${windowIndex}) is not URL-safe: ${code}`);
    }
  }
});
