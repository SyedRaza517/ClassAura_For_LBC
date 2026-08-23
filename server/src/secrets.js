// Encryption for integration credentials held per institution.
//
// A college's Moodle token reads their whole VLE, and their SharePoint client secret
// reads and writes their document store. Those cannot sit in the database as
// plaintext: anyone with a database backup, a read replica, a support query, or a
// screenshot of Prisma Studio would have them.
//
// AES-256-GCM, from Node's own crypto — authenticated, so a tampered ciphertext is
// rejected rather than silently decrypting to rubbish. No dependency, matching how
// totp.js was done.
//
// Stored as  v1.<iv>.<authTag>.<ciphertext>  , all base64url. The version prefix is
// there so the format can change later without guessing at what old rows contain.
const crypto = require("node:crypto");

const ALGO = "aes-256-gcm";
const VERSION = "v1";

class SecretsNotConfigured extends Error {
  constructor() {
    super(
      "CREDENTIALS_KEY is not set, so integration credentials cannot be stored. " +
      "Generate one with:  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
    this.name = "SecretsNotConfigured";
    this.status = 503;
  }
}

// Resolved per call rather than at import: a missing key must fail the ONE request
// that tries to save a credential, not prevent the server from starting and take
// every unrelated feature down with it.
function key() {
  const raw = process.env.CREDENTIALS_KEY;
  if (!raw) throw new SecretsNotConfigured();
  // Accept base64 or hex; both are what a person pastes out of a generator.
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error("CREDENTIALS_KEY must decode to exactly 32 bytes (got " + buf.length + ").");
  }
  return buf;
}

const isConfigured = () => {
  try { key(); return true; } catch { return false; }
};

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12); // 96-bit nonce, the size GCM is specified for
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const out = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), out.toString("base64url")].join(".");
}

function decrypt(stored) {
  const parts = String(stored || "").split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("Stored secret is not in the expected format");
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  // Throws if the ciphertext or tag was altered — which is the point of GCM.
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
}

/**
 * What a client is allowed to see of a secret: enough to recognise it, never enough
 * to use it. A Moodle token is 32 hex characters, so the last four identify which
 * token is in place without materially narrowing a guess.
 */
function hint(plaintext) {
  const s = String(plaintext || "");
  if (s.length <= 4) return "•".repeat(s.length);
  return "•".repeat(Math.min(12, s.length - 4)) + s.slice(-4);
}

module.exports = { encrypt, decrypt, hint, isConfigured, SecretsNotConfigured };
