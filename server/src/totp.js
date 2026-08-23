// TOTP (RFC 6238) — the authenticator-app second factor.
//
// Deliberately dependency-free: TOTP is just HMAC-SHA1 over a 30-second counter,
// which Node's built-in crypto already does. Compatible with Google Authenticator,
// Microsoft Authenticator, Authy, 1Password and anything else that reads an
// otpauth:// URL.

const crypto = require("crypto");

const STEP_SECONDS = 30; // how long one code is valid
const DIGITS = 6;
// Accept the previous and next step as well as the current one, so a slightly
// out-of-sync phone clock (or a code typed as it rolls over) still works.
const WINDOW = 1;

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// Random base32 secret. 20 bytes = 160 bits, the size RFC 4226 recommends for HMAC-SHA1.
function generateSecret(bytes = 20) {
  const buf = crypto.randomBytes(bytes);
  let bits = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

// Base32 -> Buffer. Tolerates lowercase, spaces and "=" padding, because users
// re-typing a secret by hand produce all three.
function base32Decode(secret) {
  const clean = String(secret || "").toUpperCase().replace(/[\s=]/g, "");
  let bits = "";
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32 character in secret");
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

// The 6-digit code for a given counter value (RFC 4226 dynamic truncation).
function hotp(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const digest = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(code % 10 ** DIGITS).padStart(DIGITS, "0");
}

// Current code — used by tests and the dev helper, not by the login path.
function generateCode(secret, at = Date.now()) {
  return hotp(secret, Math.floor(at / 1000 / STEP_SECONDS));
}

// Verify a user-supplied code against the secret, allowing +/- WINDOW steps.
// Comparison is constant-time so the check can't be timed character by character.
function verifyCode(secret, code, at = Date.now()) {
  const clean = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const counter = Math.floor(at / 1000 / STEP_SECONDS);
  for (let drift = -WINDOW; drift <= WINDOW; drift++) {
    let expected;
    try { expected = hotp(secret, counter + drift); } catch (_) { return false; }
    const a = Buffer.from(expected), b = Buffer.from(clean);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

// The otpauth:// URL an authenticator app expects behind a QR code.
// The label is "Issuer:account" by convention, and both parts must be encoded.
//
// The issuer is what the person sees in their authenticator app, so it has to be the
// name of the college they signed in to. This module is pure crypto and has no tenant
// context, so the caller resolves it from branding and passes it in; the default is the
// neutral product name rather than any one customer's, which is what it used to be.
function otpauthUrl(secret, account, issuer = "Staff Hub") {
  const label = encodeURIComponent(`${issuer}:${account}`);
  // Built by hand rather than with URLSearchParams: that encodes spaces as "+",
  // and some authenticator apps show the "+" literally in the issuer name.
  const params = [
    `secret=${secret}`,
    `issuer=${encodeURIComponent(issuer)}`,
    `algorithm=SHA1`,
    `digits=${DIGITS}`,
    `period=${STEP_SECONDS}`,
  ].join("&");
  return `otpauth://totp/${label}?${params}`;
}

// Group the secret into 4-character blocks — far easier to type by hand when
// someone can't scan the QR code.
const formatSecret = (secret) => String(secret).replace(/(.{4})/g, "$1 ").trim();

module.exports = { generateSecret, generateCode, verifyCode, otpauthUrl, formatSecret, STEP_SECONDS, DIGITS };
