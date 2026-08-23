// Authentication for PLATFORM operators — the tier above every institution.
//
// Kept entirely separate from src/auth.js on purpose. That file authenticates people
// who belong to a college: staff, students, applicants. This one authenticates people
// who run the platform and can see across colleges. Sharing a code path between the
// two is how "our support engineer" and "a customer's admin" end up one boolean apart.
//
// Three things keep the tiers apart:
//   • a PlatformAdmin is not a Staff row and has no tenantId
//   • its token carries kind:"platform", which requireAuth in auth.js does not accept
//     (it falls through to the staff branch, finds no Staff row, and 401s)
//   • its routes are mounted before the tenant middleware, so they never run inside a
//     tenant scope by accident
const jwt = require("jsonwebtoken");
const prisma = require("./db");
const { crossTenant } = require("./db");
const { SECRET } = require("./auth");

// Shorter than a tenant session (1 day). These accounts can read every customer's
// data, so a forgotten open laptop should cost less.
const EXPIRES = process.env.PLATFORM_JWT_EXPIRES || "8h";

const signPlatformToken = (admin) =>
  jwt.sign({ sub: admin.id, kind: "platform", purpose: "session", ver: admin.tokenVersion ?? 0 }, SECRET, { expiresIn: EXPIRES });

// --- the second factor -----------------------------------------------------------
//
// Between the password step and the authenticator step the caller holds a CHALLENGE
// token, not a session. It is signed with the same secret, so requirePlatformAdmin
// above must reject it — which it does, by demanding purpose "session". Without that
// check a correct password alone would reach every platform endpoint and the second
// factor would be decoration.
//
// It carries `ver` for the same reason the staff challenge does: a sign-in begun with
// the old password must not survive a password reset performed while it was in flight.
const CHALLENGE_TTL = "10m";

const signPlatformChallenge = (admin, mode) =>
  jwt.sign({ sub: admin.id, kind: "platform", purpose: "mfa", mode, ver: admin.tokenVersion ?? 0 }, SECRET, { expiresIn: CHALLENGE_TTL });

/** The operator a challenge token refers to, or null if it is not a live challenge. */
async function readPlatformChallenge(token) {
  try {
    const payload = jwt.verify(String(token || ""), SECRET);
    if (payload.kind !== "platform" || payload.purpose !== "mfa") return null;
    const admin = await crossTenant(() => prisma.platformAdmin.findUnique({ where: { id: payload.sub } }));
    if (!admin || admin.active === false) return null;
    // Stale challenge — the password changed after this sign-in began.
    if ((payload.ver ?? 0) !== (admin.tokenVersion ?? 0)) return null;
    return { admin, mode: payload.mode };
  } catch {
    return null;
  }
}

async function requirePlatformAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing token" });

    const payload = jwt.verify(token, SECRET);
    // A staff/student/applicant token must never be accepted here, however valid its
    // signature. This is the check that keeps a college admin out of the platform.
    if (payload.kind !== "platform") return res.status(403).json({ error: "Platform access required" });
    if (payload.purpose !== "session") return res.status(401).json({ error: "Invalid token" });

    // PlatformAdmin is unscoped, but crossTenant makes the intent explicit and keeps
    // this working if that ever changes.
    const admin = await crossTenant(() => prisma.platformAdmin.findUnique({ where: { id: payload.sub } }));
    if (!admin || admin.active === false) return res.status(401).json({ error: "Invalid token" });
    if ((payload.ver ?? 0) !== (admin.tokenVersion ?? 0)) {
      return res.status(401).json({ error: "Session expired — please sign in again" });
    }

    req.platformAdmin = { id: admin.id, email: admin.email, name: admin.name };
    next();
  } catch (e) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

module.exports = { signPlatformToken, requirePlatformAdmin, PLATFORM_EXPIRES: EXPIRES, signPlatformChallenge, readPlatformChallenge };
