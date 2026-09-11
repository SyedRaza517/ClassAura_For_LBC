// The rotating QR code: how it is derived, and what verification will and will not accept.
//
// No database, no clock. The caller reads the clock through clock.js and passes seconds
// in, so every boundary — the instant a window turns over, a code one rotation stale, a
// code signed for somebody else's lecture — is an ordinary assertion here rather than
// something that only reproduces in a real classroom at 09:15 on a Tuesday.
//
// Run with: node --test src/attendanceQr.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  windowIndexFor,
  deriveCode,
  verifyCode,
  ACCEPTED_WINDOWS,
  GRACE_SECONDS,
} = require("./attendanceQr");

// A signing key of the shape hkdf gives us. Fixed, so codes in this file are stable.
const SECRET = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const OTHER_SECRET = Buffer.from("fedcba9876543210fedcba9876543210", "utf8");

const SESSION = "ckqr0000000000000000session";
const ROTATE = 30;

// An arbitrary instant that is NOT on a window boundary, so a test that accidentally
// depends on alignment shows up rather than passing by luck.
const NOW = 1_756_400_017;

// ---------------------------------------------------------------------------
// windowIndexFor
// ---------------------------------------------------------------------------

// A real window boundary, written out rather than computed: 58_546_667 × 30. Computing it
// with the same floor-divide the module uses would make these two tests agree with the
// implementation by construction and discriminate nothing.
const BOUNDARY = 1_756_400_010;

test("windowIndexFor: two instants inside one rotation share an index", () => {
  const a = windowIndexFor(BOUNDARY, ROTATE);
  const b = windowIndexFor(BOUNDARY + ROTATE - 1, ROTATE);
  assert.equal(a, b);
});

test("windowIndexFor: crossing the rotation boundary increments the index", () => {
  const a = windowIndexFor(BOUNDARY + ROTATE - 1, ROTATE);
  const b = windowIndexFor(BOUNDARY + ROTATE, ROTATE);
  assert.equal(b, a + 1);
});

test("windowIndexFor: a rotation period of zero does not divide by zero", () => {
  // A settings blob edited by hand can carry a 0. An Infinity index would make every
  // code in the institution verify against every other one.
  const i = windowIndexFor(NOW, 0);
  assert.ok(Number.isFinite(i), `expected a finite index, got ${i}`);
});

// ---------------------------------------------------------------------------
// deriveCode
// ---------------------------------------------------------------------------

test("deriveCode: the same session in the same window gives the same code", () => {
  const w = windowIndexFor(NOW, ROTATE);
  assert.equal(
    deriveCode({ secret: SECRET, sessionId: SESSION, windowIndex: w }),
    deriveCode({ secret: SECRET, sessionId: SESSION, windowIndex: w }),
  );
});

test("deriveCode: a different session in the same window gives a different code", () => {
  const w = windowIndexFor(NOW, ROTATE);
  assert.notEqual(
    deriveCode({ secret: SECRET, sessionId: SESSION, windowIndex: w }),
    deriveCode({ secret: SECRET, sessionId: "a-different-session", windowIndex: w }),
  );
});

test("deriveCode: the same session in the next window gives a different code", () => {
  const w = windowIndexFor(NOW, ROTATE);
  assert.notEqual(
    deriveCode({ secret: SECRET, sessionId: SESSION, windowIndex: w }),
    deriveCode({ secret: SECRET, sessionId: SESSION, windowIndex: w + 1 }),
  );
});

test("deriveCode: a different signing key gives a different code", () => {
  // Key separation is the whole reason this does not sign with the AES key. If the
  // secret did not reach the digest, one college's code would verify at another.
  const w = windowIndexFor(NOW, ROTATE);
  assert.notEqual(
    deriveCode({ secret: SECRET, sessionId: SESSION, windowIndex: w }),
    deriveCode({ secret: OTHER_SECRET, sessionId: SESSION, windowIndex: w }),
  );
});

test("deriveCode: the code carries no readable trace of the session id", () => {
  const w = windowIndexFor(NOW, ROTATE);
  const code = deriveCode({ secret: SECRET, sessionId: SESSION, windowIndex: w });
  assert.ok(!code.includes(SESSION), "the session id must not be recoverable from the code");
});

test("deriveCode: the code is URL-safe", () => {
  // It travels in a query string. A '+' or '/' from ordinary base64 would be mangled by
  // one link handler in ten and produce a refusal nobody can reproduce.
  const w = windowIndexFor(NOW, ROTATE);
  const code = deriveCode({ secret: SECRET, sessionId: SESSION, windowIndex: w });
  assert.match(code, /^[A-Za-z0-9_-]+$/);
});

// ---------------------------------------------------------------------------
// verifyCode — what it accepts
// ---------------------------------------------------------------------------

const codeAt = (seconds, over = {}) => deriveCode({
  secret: SECRET,
  sessionId: SESSION,
  windowIndex: windowIndexFor(seconds, ROTATE),
  ...over,
});

test("verifyCode: accepts the code showing on screen right now", () => {
  const out = verifyCode({
    secret: SECRET, sessionId: SESSION, code: codeAt(NOW), nowSeconds: NOW, rotateSeconds: ROTATE,
  });
  assert.equal(out.valid, true);
});

// The instant a window begins, so the tests below can sit an exact number of seconds
// after a rotation rather than wherever NOW happens to fall inside its window.
const startOfWindow = (seconds) => windowIndexFor(seconds, ROTATE) * ROTATE;

test("verifyCode: accepts the code that just rotated off, for a few seconds", () => {
  // A student who raised their phone at 29.8 seconds must not be refused by their own
  // network round trip. Two seconds past the boundary, the old code still works.
  const justAfter = startOfWindow(NOW) + 2;
  const out = verifyCode({
    secret: SECRET, sessionId: SESSION, code: codeAt(justAfter - ROTATE), nowSeconds: justAfter, rotateSeconds: ROTATE,
  });
  assert.equal(out.valid, true);
});

test("verifyCode: ...and STOPS accepting it once the grace has passed", () => {
  // THE CHANGE THIS BLOCK EXISTS FOR, and it is a tightening rather than a fix to a crash.
  //
  // The previous code used to verify for the WHOLE of the current window, which made a
  // code live for up to twice the rotation period — mint it at the start of its window and
  // it still worked two full periods later. The rotation period is the one number this
  // feature's honesty rests on, because it is literally how long a photographed screen
  // keeps working, and doubling it behind a constant nobody reads gave away half of what
  // the setting promised.
  const wellAfter = startOfWindow(NOW) + GRACE_SECONDS + 1;
  const out = verifyCode({
    secret: SECRET, sessionId: SESSION, code: codeAt(wellAfter - ROTATE), nowSeconds: wellAfter, rotateSeconds: ROTATE,
  });
  assert.equal(out.valid, false);
  assert.equal(out.reason, "expired", "and it is still recognised as ours, so the student is told to scan again");
});

test("verifyCode: the grace boundary is exact, not approximate", () => {
  // One second either side of it, asserted directly: a tolerance that is "about seven
  // seconds" is one nobody can reason about when a student says the code did not work.
  const at = (offset) => {
    const when = startOfWindow(NOW) + offset;
    return verifyCode({ secret: SECRET, sessionId: SESSION, code: codeAt(when - ROTATE), nowSeconds: when, rotateSeconds: ROTATE }).valid;
  };
  assert.equal(at(0), true, "the instant of rotation");
  assert.equal(at(GRACE_SECONDS - 1), true, "the last second inside the grace");
  assert.equal(at(GRACE_SECONDS), false, "the first second outside it");
});

test("A CODE NEVER LIVES LONGER THAN ONE ROTATION PLUS THE GRACE", () => {
  // The property the whole design rests on, asserted as a property rather than at one
  // sampled instant: a code minted at the start of its window is dead by rotate + GRACE,
  // and alive at every second before that. This is the assertion that fails if somebody
  // widens the tolerance back to a whole window.
  const minted = startOfWindow(NOW);
  const alive = (elapsed) => verifyCode({
    secret: SECRET, sessionId: SESSION, code: codeAt(minted), nowSeconds: minted + elapsed, rotateSeconds: ROTATE,
  }).valid;
  for (let elapsed = 0; elapsed < ROTATE + GRACE_SECONDS; elapsed += 1) {
    assert.equal(alive(elapsed), true, `should still verify ${elapsed}s after it was minted`);
  }
  assert.equal(alive(ROTATE + GRACE_SECONDS), false, "and must be dead the second after");
  assert.equal(alive(ROTATE * 2 - 1), false, "nowhere near a second full rotation");
});

test("GRACE_SECONDS is a named, bounded tolerance", () => {
  // Named so that widening it is a deliberate edit to a constant with a test on it, rather
  // than an off-by-one in a loop nobody reads. Every second here is a second in which a
  // photographed screen still works.
  assert.equal(GRACE_SECONDS, 7);
  assert.ok(GRACE_SECONDS < ROTATE, "a grace as long as the rotation is not a grace");
  assert.equal(ACCEPTED_WINDOWS, 2, "the current window, and the one before it within the grace");
});

// ---------------------------------------------------------------------------
// verifyCode — what it refuses
// ---------------------------------------------------------------------------

test("verifyCode: refuses a code two rotations old, and says it expired", () => {
  const out = verifyCode({
    secret: SECRET, sessionId: SESSION, code: codeAt(NOW - ROTATE * 2), nowSeconds: NOW, rotateSeconds: ROTATE,
  });
  assert.equal(out.valid, false);
  assert.equal(out.reason, "expired");
});

test("verifyCode: refuses a code from a FUTURE window", () => {
  // There is no forward tolerance and there must not be: a code valid before it is
  // displayed is a replay window with extra steps.
  const out = verifyCode({
    secret: SECRET, sessionId: SESSION, code: codeAt(NOW + ROTATE), nowSeconds: NOW, rotateSeconds: ROTATE,
  });
  assert.equal(out.valid, false);
});

test("verifyCode: refuses a code minted for a different session", () => {
  // The one that matters most. A student standing in the corridor scanning the screen of
  // a lecture they are not enrolled on presents exactly this: a perfectly current,
  // perfectly signed code for somebody else's register.
  const code = deriveCode({
    secret: SECRET, sessionId: "a-different-session", windowIndex: windowIndexFor(NOW, ROTATE),
  });
  const out = verifyCode({ secret: SECRET, sessionId: SESSION, code, nowSeconds: NOW, rotateSeconds: ROTATE });
  assert.equal(out.valid, false);
  assert.equal(out.reason, "bad_signature");
});

test("verifyCode: refuses a code signed with another key", () => {
  const code = deriveCode({
    secret: OTHER_SECRET, sessionId: SESSION, windowIndex: windowIndexFor(NOW, ROTATE),
  });
  const out = verifyCode({ secret: SECRET, sessionId: SESSION, code, nowSeconds: NOW, rotateSeconds: ROTATE });
  assert.equal(out.valid, false);
  assert.equal(out.reason, "bad_signature");
});

test("verifyCode: a long-dead code reads as forged, not merely expired", () => {
  // The diagnosis window is bounded. Past it we stop claiming to know that a string was
  // ever one of ours — "expired" tells a student to scan again, and that is the wrong
  // advice for a code we never issued.
  const out = verifyCode({
    secret: SECRET, sessionId: SESSION, code: codeAt(NOW - ROTATE * 500), nowSeconds: NOW, rotateSeconds: ROTATE,
  });
  assert.equal(out.valid, false);
  assert.equal(out.reason, "bad_signature");
});

test("verifyCode: refuses rubbish without throwing", () => {
  for (const code of ["", "not-a-code", "!!!!", "x".repeat(500)]) {
    const out = verifyCode({ secret: SECRET, sessionId: SESSION, code, nowSeconds: NOW, rotateSeconds: ROTATE });
    assert.equal(out.valid, false, `expected ${JSON.stringify(code)} to be refused`);
  }
});

test("verifyCode: refuses a missing or non-string code without throwing", () => {
  for (const code of [null, undefined, 42, {}, []]) {
    const out = verifyCode({ secret: SECRET, sessionId: SESSION, code, nowSeconds: NOW, rotateSeconds: ROTATE });
    assert.equal(out.valid, false, `expected ${JSON.stringify(code)} to be refused`);
  }
});

test("verifyCode: refuses a real code when no session is named", () => {
  const out = verifyCode({
    secret: SECRET, sessionId: "", code: codeAt(NOW), nowSeconds: NOW, rotateSeconds: ROTATE,
  });
  assert.equal(out.valid, false);
});

test("verifyCode: refuses a correctly-signed code FOR the empty session", () => {
  // The case the empty-sessionId guard actually exists for, and the one the test above
  // does not reach: a route that lost its sessionId calls deriveCode and verifyCode with
  // the same empty string, so the HMAC agrees with itself and everything else in this
  // module says yes. Without the guard this marks a student present against no register
  // at all. Checked for both "" and undefined, because a missing property and an empty
  // string arrive by different routes and deriveCode coerces both to the same message.
  for (const missing of ["", undefined]) {
    const code = deriveCode({
      secret: SECRET, sessionId: missing, windowIndex: windowIndexFor(NOW, ROTATE),
    });
    const out = verifyCode({
      secret: SECRET, sessionId: missing, code, nowSeconds: NOW, rotateSeconds: ROTATE,
    });
    assert.equal(out.valid, false, `expected a self-consistent empty-session code to be refused (${JSON.stringify(missing)})`);
  }
});

test("verifyCode: a code of the right shape but wrong length is refused, not compared", () => {
  // timingSafeEqual throws on a length mismatch. A truncated code is a completely
  // ordinary thing for a link handler to produce and must not 500 the check-in route.
  const full = codeAt(NOW);
  const out = verifyCode({
    secret: SECRET, sessionId: SESSION, code: full.slice(0, full.length - 2), nowSeconds: NOW, rotateSeconds: ROTATE,
  });
  assert.equal(out.valid, false);
});
