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
const { sessionSecret, usingDevSecret } = require("./sessionSecret");

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

// The QR check-in signing key, derived from the SESSION secret under a fixed label.
//
// Signing with a secret used for something else is a key-separation failure, so this is a
// DISTINCT HMAC key via HKDF and never the session secret itself. A code on a projector is
// public; the label is what stops a wall full of codes being material related to the key
// that signs logins.
//
// WHY THE SESSION SECRET AND NOT THE CREDENTIALS KEY. This derived from CREDENTIALS_KEY
// first, on reasoning that was right in shape and wrong in target: deriving beats adding
// "a second thing to forget on exactly one environment". But CREDENTIALS_KEY is OPTIONAL.
// It encrypts stored integration credentials, and a deployment with no integrations never
// sets it — which is the actual state of this product's live server, where the start-up
// log reports email, files and SharePoint all unconfigured. So the one feature that has to
// work in front of a room was hung off the one secret nobody had a reason to set, and it
// failed as a 503 at the first scan of the first lecture.
//
// JWT_SECRET is mandatory: the process refuses to start without it in production. A
// deployment that can sign a check-in code is now exactly a deployment that can log
// somebody in, so there is nothing to add before a deploy and nothing left to forget.
// CREDENTIALS_KEY keeps its own job, encrypting credentials at rest, and is unaffected.
//
// The label is versioned so a future change of derivation can coexist with codes signed
// under the previous one for the length of a rotation window. v2 is this reparenting;
// codes signed under v1 stop verifying, which matters for at most one rotation window and
// this has never been deployed.
const QR_HKDF_INFO = "edtech:qr-checkin:v2";

/**
 * One line for the boot banner, beside email, push, files and SharePoint.
 *
 * Those four announce themselves precisely so a stubbed deployment does not look healthy
 * until somebody waits for an email that never arrives. Check-in codes were the one
 * credential consumer with no such line, and the worst one to leave silent: a missing key
 * refuses every mint and every scan with a 503, so the failure surfaces as a lecturer
 * standing in front of a room with no code on the wall, or a hall of students whose
 * scans are all rejected. Nothing before start-up said a thing.
 *
 * Never echoes the key or any part of it. This banner is printed to a log that gets
 * pasted into chats and screenshots.
 */
function describeCheckInCodes() {
  // No "not configured" case in production: the process would not have started. The one
  // thing worth announcing is a deployment running on the public development secret,
  // where every code on every wall is forgeable by anyone who has read the source.
  return usingDevSecret()
    ? "ready to sign, using the built-in development secret (fine locally; set JWT_SECRET for a real deployment)"
    : "ready to sign";
}

function qrSigningKey() {
  // hkdfSync returns an ArrayBuffer, not a Buffer; crypto.createHmac accepts both,
  // but the callers compare and slice, so normalise here once.
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(sessionSecret(), "utf8"), Buffer.alloc(0), QR_HKDF_INFO, 32));
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

module.exports = { encrypt, decrypt, hint, isConfigured, describeCheckInCodes, qrSigningKey, SecretsNotConfigured };
