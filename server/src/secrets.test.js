// The QR signing key: derived from CREDENTIALS_KEY, and provably not CREDENTIALS_KEY.
//
// secrets.js holds one 32-byte secret for AES-256-GCM. Signing with an encryption key
// is a key-separation failure — a mistake in one use compromises the other — so the QR
// feature derives a DISTINCT HMAC key from the same secret via HKDF under a fixed
// label. These tests pin the three properties that make that safe: the derived key is
// the right shape for HMAC-SHA256, it is stable (a code minted by one process must
// verify in another), and it is not the AES key wearing a different name.
//
// CREDENTIALS_KEY is resolved per call in secrets.js, so each test sets the env var
// itself and restores whatever was there before — the suite must not depend on, or
// damage, the environment it runs in.
//
// Run with: node --test src/secrets.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { describeCheckInCodes, qrSigningKey, SecretsNotConfigured } = require("./secrets");

// A fixed 32-byte key, as a person would paste it out of the generator command the
// error message suggests. Written out so the "distinct from the AES key" assertion
// compares against known bytes rather than re-running the code under test.
const RAW = Buffer.alloc(32, 7);
const RAW_B64 = RAW.toString("base64");
const OTHER_B64 = Buffer.alloc(32, 9).toString("base64");

function withKey(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, "CREDENTIALS_KEY");
  const prev = process.env.CREDENTIALS_KEY;
  if (value === undefined) delete process.env.CREDENTIALS_KEY;
  else process.env.CREDENTIALS_KEY = value;
  try {
    return fn();
  } finally {
    if (had) process.env.CREDENTIALS_KEY = prev;
    else delete process.env.CREDENTIALS_KEY;
  }
}

// The signing key's parent is the SESSION secret, not the credentials key.
//
// It used to be CREDENTIALS_KEY, whose own comment argued — correctly — that deriving
// beats adding "a second thing to forget on exactly one environment". It just named the
// wrong parent. CREDENTIALS_KEY is OPTIONAL: it exists to encrypt stored integration
// credentials, and a deployment with no integrations configured never sets it, which is
// exactly the state of this product's live server. So the one feature that must work in
// front of a room was hung off the one secret nobody had a reason to set.
//
// JWT_SECRET is mandatory: auth.js throws at start-up without it in production, so a
// deployment that can sign a check-in code is precisely a deployment that can log anybody
// in. There is nothing left to forget, and nothing to add before a deploy.
function withJwt(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, "JWT_SECRET");
  const prev = process.env.JWT_SECRET;
  if (value === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = value;
  try { return fn(); } finally {
    if (had) process.env.JWT_SECRET = prev; else delete process.env.JWT_SECRET;
  }
}
const JWT_A = "a-long-random-session-secret-for-tests-0000";
const JWT_B = "a-different-long-random-session-secret-1111";

test("qrSigningKey: 32 bytes, the size HMAC-SHA256 wants", () => {
  withJwt(JWT_A, () => {
    const k = qrSigningKey();
    assert.ok(Buffer.isBuffer(k), "expected a Buffer");
    assert.equal(k.length, 32);
  });
});

test("qrSigningKey: deterministic — a code minted by one process verifies in another", () => {
  withJwt(JWT_A, () => assert.deepEqual(qrSigningKey(), qrSigningKey()));
});

test("qrSigningKey: is NOT the session secret — key separation is why this function exists", () => {
  // A code on a projector is public. If it were signed with the session secret itself,
  // every wall in the building would be leaking material related to the key that signs
  // logins. The HKDF label is what keeps the two domains apart.
  withJwt(JWT_A, () => assert.notDeepEqual(qrSigningKey(), Buffer.from(JWT_A, "utf8")));
});

test("qrSigningKey: a different session secret yields a different signing key", () => {
  // Must bind to the deployment's own secret, not collapse to a constant — a constant
  // would let a code minted on staging verify on production.
  assert.notDeepEqual(withJwt(JWT_A, qrSigningKey), withJwt(JWT_B, qrSigningKey));
});

// THE POINT OF THE CHANGE. This is the case that used to throw a 503 at every scan.
test("qrSigningKey: works on a deployment with NO credentials key at all", () => {
  withKey(undefined, () => withJwt(JWT_A, () => {
    const k = qrSigningKey();
    assert.equal(k.length, 32, "a deployment with no integrations configured must still sign codes");
  }));
});

test("the signing key is derived from the very secret auth signs sessions with", () => {
  // Pinned, because these are separate modules and a later edit to either fallback rule
  // would quietly give the codes a different parent than the tokens — a deployment where
  // people can log in and no code verifies, with nothing failing to say so.
  // auth.js resolves its secret at import, so both are read under the ambient environment.
  const { sessionSecret } = require("./sessionSecret");
  const { SECRET } = require("./auth");
  assert.equal(SECRET, sessionSecret(),
    "auth.js and the check-in codes must resolve the SAME session secret; they have diverged.");
});

/* -------------------------------------------------------------------------- */
/* The boot banner line                                                        */
/* -------------------------------------------------------------------------- */

// A missing CREDENTIALS_KEY refuses every code mint and every scan with a 503, and the
// server used to start up saying nothing about it. The four integrations beside it
// (email, push, files, SharePoint) each announce whether they are configured, precisely
// so a stubbed deployment does not look healthy; check-in codes were the one credential
// consumer with no such line, and the one whose absence is invisible until a lecturer is
// standing in front of a room.
test("the boot banner reports codes as ready on any deployment that can log people in", () => {
  const line = withKey(undefined, () => withJwt(JWT_A, () => describeCheckInCodes()));
  assert.doesNotMatch(line, /not configured/i,
    "no credentials key is set here, and that must no longer stop codes being signed");
  assert.doesNotMatch(line, new RegExp(JWT_A.slice(0, 16)),
    "the banner must never echo any part of the secret");
});
