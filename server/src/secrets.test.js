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

const { qrSigningKey, SecretsNotConfigured } = require("./secrets");

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

test("qrSigningKey: 32 bytes, the size HMAC-SHA256 wants", () => {
  withKey(RAW_B64, () => {
    const k = qrSigningKey();
    assert.ok(Buffer.isBuffer(k), "expected a Buffer");
    assert.equal(k.length, 32);
  });
});

test("qrSigningKey: deterministic — a code minted by one process verifies in another", () => {
  withKey(RAW_B64, () => {
    assert.deepEqual(qrSigningKey(), qrSigningKey());
  });
});

test("qrSigningKey: is NOT the AES key — key separation is the reason this function exists", () => {
  withKey(RAW_B64, () => {
    assert.notDeepEqual(qrSigningKey(), RAW);
  });
});

test("qrSigningKey: a different CREDENTIALS_KEY yields a different signing key", () => {
  // The derivation must bind to the institution's secret, not collapse to a constant —
  // a constant would let a code minted on staging verify on production.
  const a = withKey(RAW_B64, () => qrSigningKey());
  const b = withKey(OTHER_B64, () => qrSigningKey());
  assert.notDeepEqual(a, b);
});

test("qrSigningKey: no CREDENTIALS_KEY throws SecretsNotConfigured, not a quiet default", () => {
  // A silently-defaulted key would not fail here — it would fail at the first scan of
  // the first lecture, as codes signed before a restart stop verifying after it.
  withKey(undefined, () => {
    assert.throws(() => qrSigningKey(), SecretsNotConfigured);
  });
});
