const router = require("express").Router();
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const prisma = require("../db");
const { withoutAcademicScope } = require("../academicScope");
const { sStaff, sStudent, sApplicant } = require("../serializers");
const { verifyPassword, hashPassword, signToken, signStudentToken, signApplicantToken, requireAuth, isStudent, isApplicant, SECRET } = require("../auth");
// requireAuth serves the caller's row from a short-TTL in-process cache
// (identityCache.js explains the whole design). Every write in this file that
// changes a row's auth-relevant state — password, tokenVersion, totp, activation,
// deletion — must drop that row's cache entry the moment it commits, or a revoked
// session would stay honoured for up to the TTL. One process, so this is complete.
const { identityCache } = require("../identityCache");
// A fixed hash to compare against on the login miss path, so a non-existent account
// costs the same bcrypt time as a real one (see the /login handler). Computed once.
//
// hashSync, deliberately, and the only sync bcrypt left in src/. hashPassword is now
// async (it returns a Promise — see src/auth.js for why), so using it here would make
// DUMMY_HASH a Promise at require time and every module-level consumer would need an
// async init dance. This one hash is computed exactly once, at boot, before the server
// is listening — there is no event loop traffic to block yet, so the ~100ms is paid
// where nobody can notice it. The COMPARES against it stay async like every other.
const bcryptjs = require("bcryptjs");
const DUMMY_HASH = bcryptjs.hashSync("timing-equalizer-not-a-real-password", 10);
const { sendEmail } = require("../email");
const { notifyStaff, notifyAdmins } = require("../notify");
const totp = require("../totp");
const audit = require("../audit");
const branding = require("../branding");
const mailAssets = require("../mailAssets");

// --- Two-factor challenge tokens ---
// Between "password accepted" and "second factor accepted" the caller holds a
// short-lived token that is NOT a session token: it carries purpose "mfa" and is
// only accepted by the /totp/* endpoints below. That way a correct password alone
// can never be exchanged for API access.
const CHALLENGE_TTL = "10m";

// --- Two-factor enforcement flag ---
// The second factor is currently switched OFF at sign-in (see the commented-out
// branches in /login). Every other place that demanded a code — password reset and
// account deletion — must honour the same switch, or an account that still has
// totpEnabled=true signs in with a password alone yet can never reset its password
// or delete itself without a code it may no longer have. Flip this to true (and
// uncomment the /login branches) to turn 2FA back on everywhere at once.
// TOTP_ENFORCED controls whether 2FA is MANDATORY for everyone (which would push
// accounts into enrolment on next sign-in). It stays off.
const TOTP_ENFORCED = false;
// But an account that has DELIBERATELY enrolled is always challenged, regardless of
// the switch above. Previously this was gated on TOTP_ENFORCED too, so a user who
// turned two-step verification on signed in with a password alone while the API kept
// reporting totpEnabled: true — the app promised a protection it wasn't applying.
const totpRequiredFor = (staff) => !!staff?.totpEnabled;
// The challenge carries tokenVersion for the same reason a session does: a password
// reset must sever authentication that is already in flight, not just completed
// sessions. Without it, someone holding the OLD password could start a sign-in,
// wait out the victim's reset, and still exchange the stale challenge for a live
// session — and, on a mandatory-2FA account, enrol an authenticator of their own.
const signChallenge = (staff, mode) => jwt.sign({ sub: staff.id, purpose: "mfa", mode, ver: staff.tokenVersion ?? 0 }, SECRET, { expiresIn: CHALLENGE_TTL });

// True when a decoded token predates the account's most recent password change.
const isStaleVersion = (payload, staff) => (payload.ver ?? 0) !== (staff.tokenVersion ?? 0);

async function readChallenge(token) {
  try {
    const payload = jwt.verify(String(token || ""), SECRET);
    if (payload.purpose !== "mfa") return null;
    const staff = await prisma.staff.findUnique({ where: { id: payload.sub } });
    if (!staff || isStaleVersion(payload, staff)) return null;
    return { staff, mode: payload.mode };
  } catch (_) {
    return null;
  }
}

// Enrolment can be reached two ways: mid-sign-in with a challenge token (a new
// account that must set 2FA up), or from inside the app with a normal session (an
// existing user turning it on). Resolve whichever is present to a staff row.
//
// Returns { staff, viaChallenge } — viaChallenge distinguishes "the password was
// just proven at login" from "someone is holding a session", which decides whether
// we additionally demand the password (see requirePasswordForEnrolment below).
async function resolveEnroller(req) {
  const ch = await readChallenge(req.body?.challengeToken);
  if (ch) return { staff: ch.staff, viaChallenge: true };
  const header = req.headers.authorization || "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, SECRET);
    // A challenge token must not be usable as a session token here.
    if (payload.purpose === "mfa") return null;
    const staff = await prisma.staff.findUnique({ where: { id: payload.sub } });
    // This check is the whole point of tokenVersion. requireAuth performs it, but
    // these endpoints resolve their own token, so omitting it here let a REVOKED
    // session be traded for a brand-new valid one — defeating revocation entirely.
    if (!staff || isStaleVersion(payload, staff)) return null;
    return { staff, viaChallenge: false };
  } catch (_) {
    return null;
  }
}

// --- Simple in-memory login rate limiter (per IP + email) ---
// After MAX_ATTEMPTS failures inside WINDOW_MS, the key is locked for LOCK_MS.
// Good enough for a single-process demo; for multi-process use a shared store (Redis).
const ATTEMPTS = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const LOCK_MS = 15 * 60 * 1000;
const keyFor = (req, email) => `${req.ip}|${String(email || "").toLowerCase()}`;
// A second, address-independent key. The per-account counter is the floor that holds
// even if the address is forged; the per-address one still gives a single IP a tighter
// budget across different accounts. A lockout on either key refuses the attempt.
const accountKeyFor = (email) => `account|${String(email || "").toLowerCase()}`;
// Deliberately higher than MAX_ATTEMPTS: a whole office behind one NAT address shares
// nothing here (this key is per-account), but a real person fumbling their password on
// several devices should not lock themselves out sooner than the per-address rule does.
const MAX_ACCOUNT_ATTEMPTS = 20;
// Clear every lockout for an address, whatever IP produced it. Called after a
// successful password reset: forgetting your password and guessing a few times is
// exactly what drives someone into that flow, so leaving them locked out means the
// reset appears not to have worked ("you can now sign in" -> 429).
function clearLockoutsFor(email) {
  const suffix = `|${String(email || "").toLowerCase()}`;
  for (const key of [...ATTEMPTS.keys()]) if (key.endsWith(suffix)) ATTEMPTS.delete(key);
  ATTEMPTS.delete(accountKeyFor(email));
}

// --- Second-factor guessing limiter (per account) ---
// A 6-digit code with a +/-1 step window means 3 of 10^6 codes are live at any
// moment. Unlimited guesses reduce the second factor to a formality for anyone who
// already has the password, so cap them per account, not per challenge — otherwise
// an attacker just requests a fresh challenge.
const CODE_ATTEMPTS = new Map();
const CODE_MAX_ATTEMPTS = 10;
const CODE_WINDOW_MS = 15 * 60 * 1000;
const CODE_LOCK_MS = 15 * 60 * 1000;

function codeState(staffId) {
  const now = Date.now();
  let s = CODE_ATTEMPTS.get(staffId);
  // Same lock-before-window rule as rateState — see the note there.
  if (s && s.lockedUntil > now) return s;
  if (!s || now - s.first > CODE_WINDOW_MS) { s = { count: 0, first: now, lockedUntil: 0 }; CODE_ATTEMPTS.set(staffId, s); }
  sweep(CODE_ATTEMPTS, now, CODE_WINDOW_MS);
  return s;
}
// Returns a minutes-remaining number when locked, otherwise null.
function codeLockedFor(staffId) {
  const s = codeState(staffId);
  const now = Date.now();
  if (s.lockedUntil && now < s.lockedUntil) return Math.ceil((s.lockedUntil - now) / 60000);
  return null;
}
function recordCodeFailure(staffId) {
  const s = codeState(staffId);
  s.count += 1;
  if (s.count >= CODE_MAX_ATTEMPTS) s.lockedUntil = Date.now() + CODE_LOCK_MS;
}
const clearCodeAttempts = (staffId) => CODE_ATTEMPTS.delete(staffId);

function rateState(key) {
  const now = Date.now();
  let s = ATTEMPTS.get(key);
  // Check the LOCK before the window. `first` is stamped on the first attempt but
  // `lockedUntil` is set on the last, so resetting purely on the window threw the
  // lockout away with it: one failure at 09:00:00 and seven at 09:14:50 locked the
  // account until 09:29:50, and the very next attempt at 09:15:01 cleared the lock
  // 14 minutes early. It also allowed a 15-attempt burst across the boundary against
  // an advertised cap of 8, and made the "try again in N minutes" figure untrue.
  if (s && s.lockedUntil > now) return s;
  if (!s || now - s.first > WINDOW_MS) { s = { count: 0, first: now, lockedUntil: 0 }; ATTEMPTS.set(key, s); }
  sweep(ATTEMPTS, now, WINDOW_MS);
  return s;
}

// Reclaim expired entries.
//
// These maps were only ever pruned when the SAME key came back, so unauthenticated
// traffic with random addresses grew them without bound — two entries per login
// attempt, one per reset request, until the container hit its memory ceiling and
// restarted. The sign-up limiter already sweeps on a size trigger for exactly this
// reason; the auth limiters did not. Swept on read, so a blocked caller cannot stop
// the tidying by going quiet.
const SWEEP_ABOVE = 5000;
// windowMs is per-map: RESET_ATTEMPTS counts over an hour, the others over 15
// minutes. Sweeping them all on the shortest window would discard a reset counter
// 45 minutes early and let someone past the 5-per-hour cap — a sweep meant to bound
// memory must not quietly widen a rate limit.
function sweep(map, now, windowMs) {
  if (map.size <= SWEEP_ABOVE) return;
  for (const [k, v] of map) {
    const dead = (!v.lockedUntil || v.lockedUntil < now) && now - v.first > windowMs;
    if (dead) map.delete(k);
  }
}

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  // TYPE-check, not just truthiness. `{}` is truthy, and bcrypt's compare throws on a
  // non-string (the async variant rejects, which an await re-throws — same outcome)
  // — which produced a 500 when the account existed and a 401 when it
  // didn't. That is a clean account-existence oracle, and because the throw happened
  // before the counters below were incremented, NEITHER rate limiter ever fired: the
  // whole staff and student roster could be enumerated at full speed.
  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Email and password must be text" });
  }

  const key = keyFor(req, email);
  const s = rateState(key);
  const acctKey = accountKeyFor(email);
  const acct = rateState(acctKey);
  const now = Date.now();
  // Locked on EITHER key. The per-address counter is the tight one; the per-account
  // counter is the floor that still holds when the address can't be trusted.
  const lockedUntil = Math.max(s.lockedUntil || 0, acct.lockedUntil || 0);
  if (lockedUntil && now < lockedUntil) {
    const mins = Math.ceil((lockedUntil - now) / 60000);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.` });
  }

  const emailLc = String(email).toLowerCase();
  const staff = await prisma.staff.findFirst({ where: { email: emailLc } });
  // A pending-activation staff account cannot be signed into (its password is random
  // and unknown); treat it as a non-match so the generic error message applies.
  const staffOk = staff && !staff.pendingActivation && (await verifyPassword(password, staff.passwordHash));

  if (staffOk) {
    ATTEMPTS.delete(key); ATTEMPTS.delete(acctKey); // successful login clears both counters
    // An account that has enrolled an authenticator is always challenged — otherwise
    // the app shows "two-step verification: On" while letting a password alone in.
    if (totpRequiredFor(staff)) {
      return res.json({ mfaRequired: true, challengeToken: signChallenge(staff, "verify"), email: staff.email, name: staff.name });
    }
    // Forcing enrolment on accounts that never opted in stays off; flip TOTP_ENFORCED
    // and restore `mustSetupTotp: true` on sign-up approval to make 2FA mandatory.
    // if (TOTP_ENFORCED && staff.mustSetupTotp) {
    //   return res.json({ totpSetupRequired: true, challengeToken: signChallenge(staff, "setup"), email: staff.email, name: staff.name });
    // }
    // Recorded at the point a SESSION is issued, not at the point the password was
    // accepted — on a 2FA account those are different moments, and only the second
    // one means somebody got in.
    audit.record(req, {
      actor: audit.asActor(staff, "staff"),
      action: "auth.signin", entity: "Staff", entityId: staff.id,
      summary: `${staff.name} (${staff.email}) signed in`,
      after: { method: "password" },
    });
    return res.json({ token: signToken(staff), user: sStaff(staff) });
  }

  // Not a valid staff login — try a student account. This isolated branch is the
  // only place a student session is issued; a student with no passwordHash (never
  // approved) or a deactivated one cannot sign in.
  // AUTHENTICATION PRECEDES SCOPING, so this lookup declares itself institution-wide.
  //
  // Student is a departmental model, but "which student is this?" cannot be answered
  // within a department: resolving the account is what PRODUCES the scope, so requiring
  // one here would be circular. Exactly the reason Staff is declared UNSCOPED in
  // academicScopeModels.js, arriving at the same problem from the other side.
  //
  // Narrow on purpose -- one lookup by email, not the whole handler -- so nothing else
  // in this route inherits an institution-wide scope by accident.
  const student = await withoutAcademicScope(
    "login: resolving a student account, which is what produces the scope",
    () => prisma.student.findFirst({ where: { email: emailLc } }),
  );
  if (student && student.passwordHash && student.active !== false && (await verifyPassword(password, student.passwordHash))) {
    ATTEMPTS.delete(key); ATTEMPTS.delete(acctKey);
    audit.record(req, {
      actor: audit.asActor(student, "student"),
      action: "auth.signin", entity: "Student", entityId: student.id,
      summary: `Student ${student.firstName} ${student.lastName} (${student.studentRef}) signed in`,
      after: { method: "password" },
    });
    return res.json({ token: signStudentToken(student), user: { ...sStudent(student), kind: "student" } });
  }

  // Not staff or student — try an applicant (prospective-student portal) account: an
  // Admission row that has been given a passwordHash via /api/applicant/register. Matched
  // case-insensitively; a deactivated one cannot sign in.
  //
  // RAW SQL ON lower(email), NOT Prisma's mode:"insensitive" — and the reason is what
  // the query engine actually emits. Prisma 5.x compiles an insensitive `equals` to
  //   "email" ILIKE $1
  // (verified against the query log for this exact filter), and Postgres cannot answer
  // ILIKE from ANY btree index, functional or otherwise. Admission carries no email
  // index at all, so this lookup — which runs on EVERY failed staff/student login, not
  // just applicant sign-ins — sequential-scanned the whole Admission table every time.
  // lower(email) = <already-lowercased input> is the same case-insensitive equality,
  // but it is exactly the expression the "Admission_email_lower_idx" functional index
  // serves (see the migration of that name — a hand-written one, because the Prisma
  // schema language cannot express an index on an expression).
  //
  // It is also STRICTER in a way that only removes an accident: ILIKE treats % and _
  // in the caller's input as wildcards, so signing in as "j_hn@x.com" would have
  // pattern-matched "john@x.com"'s row. Underscores are legal in real addresses; a
  // login lookup was never meant to match by pattern. Plain equality can't.
  //
  // Only the id comes back raw; the row is re-read through the Prisma client so the
  // serialiser and the checks below see a normal client object rather than the raw
  // driver shape (Date columns, casing and null handling all differ on that path).
  const applicantIds = await prisma.$queryRaw`
    SELECT "id" FROM "Admission"
    WHERE lower("email") = ${emailLc} AND "passwordHash" IS NOT NULL
    LIMIT 1`;
  const applicant = applicantIds.length
    ? await prisma.admission.findUnique({ where: { id: applicantIds[0].id } })
    : null;
  if (applicant && applicant.active !== false && (await verifyPassword(password, applicant.passwordHash))) {
    ATTEMPTS.delete(key); ATTEMPTS.delete(acctKey);
    audit.record(req, {
      actor: audit.asActor(applicant, "applicant"),
      action: "auth.signin", entity: "Admission", entityId: applicant.id,
      summary: `Applicant ${applicant.email} signed in to the applicant portal`,
      after: { method: "password" },
    });
    return res.json({ token: signApplicantToken(applicant), user: { ...sApplicant(applicant), kind: "applicant" } });
  }

  // Neither a staff, student nor applicant match. Run one bcrypt against a fixed dummy hash so
  // a miss costs the same ~100ms as a real password check. Without this, an unknown
  // email returns in a few milliseconds (both findUnique calls short-circuit before
  // any bcrypt) while a real account pays for the compare — a timing oracle that tells
  // an attacker which addresses have activated accounts, defeating the generic error
  // message. The result is discarded; only the elapsed time matters — which is why the
  // await is load-bearing now that verifyPassword is async: fire-and-forget would
  // return the 401 immediately and hand the fast path straight back to the attacker.
  await verifyPassword(String(password), DUMMY_HASH);

  // count the failure and return generically.
  s.count += 1;
  if (s.count >= MAX_ATTEMPTS) s.lockedUntil = now + LOCK_MS;
  acct.count += 1;
  if (acct.count >= MAX_ACCOUNT_ATTEMPTS) acct.lockedUntil = now + LOCK_MS;
  // The failures are the half of the sign-in record that matters to a security
  // reviewer, and the address is written down even when no account holds it — an
  // attempt against an address that does not exist is itself the finding. Volume is
  // bounded by the two counters above, which lock the pair out after a handful.
  audit.record(req, {
    actor: audit.anonymous(emailLc),
    action: "auth.signin.failed",
    summary: `Failed sign-in for ${emailLc}` + (s.lockedUntil ? " — address now locked out for 15 minutes" : ` (attempt ${s.count})`),
    after: { attemptsFromAddress: s.count, attemptsAgainstAccount: acct.count, lockedOut: !!s.lockedUntil },
  });
  const left = Math.max(0, MAX_ATTEMPTS - s.count);
  return res.status(401).json({ error: s.lockedUntil ? "Too many failed attempts. Account locked for 15 minutes." : `Invalid email or password${left <= 3 ? ` (${left} attempt${left === 1 ? "" : "s"} left)` : ""}` });
});

// POST /api/auth/totp/setup — start enrolment. Returns the secret + otpauth URL so
// the client can render a QR code. The secret is stored but NOT enabled until a
// valid code proves the authenticator was actually added.
// Accepts either a login challenge token (new account) or a normal session
// (an existing user turning 2FA on from the app).
router.post("/totp/setup", async (req, res) => {
  const found = await resolveEnroller(req);
  if (!found) return res.status(401).json({ error: "Invalid or expired sign-in session" });
  const { staff, viaChallenge } = found;
  if (staff.totpEnabled) return res.status(400).json({ error: "Two-factor authentication is already set up" });
  // Turning 2FA ON is at least as damaging as turning it off if someone else does
  // it — they become the holder of the account's second factor and the real owner
  // is locked out. DELETE /totp already demands the password; so does this, unless
  // the caller just proved it at login (viaChallenge).
  if (!viaChallenge) {
    const { password } = req.body || {};
    if (!password || !(await verifyPassword(password, staff.passwordHash))) {
      return res.status(400).json({ error: "Enter your password to set up two-step verification" });
    }
  }

  // Idempotent while enrolment is pending. Generating a fresh secret on every call
  // silently invalidated the QR the user had ALREADY scanned — any re-mount of the
  // enrolment screen (a refresh, going back and returning, React StrictMode's
  // double-invoked effect, or a retry after a mistyped code) swapped the stored
  // secret and their authenticator could never produce an accepted code again.
  // Reuse the pending secret until 2FA is actually enabled; an admin reset
  // (DELETE /staff/:id/totp) clears it when a genuinely fresh start is wanted.
  let secret = staff.totpSecret;
  if (!secret) {
    // Conditional write, because two calls in the same tick (StrictMode fires the
    // effect twice) would otherwise both see null, both generate, and both write —
    // leaving the displayed QR and the stored secret out of step. Only the first
    // caller's write lands; everyone then re-reads and returns whatever actually
    // stuck, so every concurrent caller shows the same QR.
    await prisma.staff.updateMany({ where: { id: staff.id, totpSecret: null }, data: { totpSecret: totp.generateSecret() } });
    secret = (await prisma.staff.findUnique({ where: { id: staff.id } })).totpSecret;
    // The cached copy no longer matches the row (its totpSecret is stale). No check
    // in requireAuth reads the secret — every code verification re-reads the row —
    // so this is about keeping the cache honest, not about a live vulnerability.
    identityCache.invalidate("staff", staff.id);
  }
  // The issuer is the line the person reads in their authenticator app for the rest of
  // their employment, so it has to name the college they are enrolling against. A college
  // that has not set a display name gets the neutral product name — an entry called
  // "Staff Hub" is merely vague, one called by another college's name is wrong.
  const brand = await branding.get();
  const issuer = brand.displayName || "Staff Hub";
  res.json({
    secret,
    formattedSecret: totp.formatSecret(secret),
    otpauthUrl: totp.otpauthUrl(secret, staff.email, issuer),
    account: staff.email,
    issuer,
  });
});

// POST /api/auth/totp/enable — finish enrolment: the code proves the authenticator
// holds the same secret. Only now does 2FA become required for this account.
router.post("/totp/enable", async (req, res) => {
  const found = await resolveEnroller(req);
  if (!found) return res.status(401).json({ error: "Invalid or expired sign-in session" });
  const { staff, viaChallenge } = found;
  if (staff.totpEnabled) return res.status(400).json({ error: "Two-factor authentication is already set up" });
  if (!staff.totpSecret) return res.status(400).json({ error: "Start setup first" });
  if (!viaChallenge) {
    const { password } = req.body || {};
    if (!password || !(await verifyPassword(password, staff.passwordHash))) {
      return res.status(400).json({ error: "Enter your password to set up two-step verification" });
    }
  }
  const lockedMins = codeLockedFor(staff.id);
  if (lockedMins) return res.status(429).json({ error: `Too many incorrect codes. Try again in ${lockedMins} minute${lockedMins === 1 ? "" : "s"}.` });
  if (!totp.verifyCode(staff.totpSecret, req.body?.code)) {
    recordCodeFailure(staff.id);
    return res.status(400).json({ error: "That code isn't right. Check your authenticator app and try again." });
  }
  clearCodeAttempts(staff.id);

  // mustSetupTotp is deliberately left as-is: it means "2FA is mandatory for this
  // account", not "enrolment is outstanding". Clearing it here would let an
  // app-signup account drop its second factor again via DELETE /totp.
  const updated = await prisma.staff.update({ where: { id: staff.id }, data: { totpEnabled: true } });
  // totpEnabled feeds /me through the serialized cached row — a stale false would
  // tell the app 2FA is off for up to the TTL right after the user turned it on.
  identityCache.invalidate("staff", staff.id);
  audit.record(req, {
    actor: audit.asActor(updated, "staff"),
    action: "auth.totp.enabled", entity: "Staff", entityId: updated.id,
    summary: `${updated.name} (${updated.email}) turned two-step verification on`,
    before: { totpEnabled: false }, after: { totpEnabled: true },
  });
  res.json({ token: signToken(updated), user: sStaff(updated) });
});

// POST /api/auth/totp/verify — the second step of a normal sign-in.
router.post("/totp/verify", async (req, res) => {
  const { challengeToken, code } = req.body || {};
  const ch = await readChallenge(challengeToken);
  if (!ch || ch.mode !== "verify") return res.status(401).json({ error: "Your sign-in session expired — please enter your password again." });
  const { staff } = ch;
  if (!staff.totpEnabled || !staff.totpSecret) return res.status(400).json({ error: "Two-factor authentication is not set up for this account" });
  const lockedMins = codeLockedFor(staff.id);
  if (lockedMins) return res.status(429).json({ error: `Too many incorrect codes. Try again in ${lockedMins} minute${lockedMins === 1 ? "" : "s"}.` });
  if (!totp.verifyCode(staff.totpSecret, code)) {
    recordCodeFailure(staff.id);
    return res.status(400).json({ error: "That code isn't right. Check your authenticator app and try again." });
  }
  clearCodeAttempts(staff.id);
  audit.record(req, {
    actor: audit.asActor(staff, "staff"),
    action: "auth.signin", entity: "Staff", entityId: staff.id,
    summary: `${staff.name} (${staff.email}) signed in`,
    after: { method: "password + authenticator code" },
  });
  res.json({ token: signToken(staff), user: sStaff(staff) });
});

// DELETE /api/auth/totp — turn 2FA off for your own account (requires your password,
// so a borrowed unlocked session can't silently remove the second factor).
router.delete("/totp", requireAuth, async (req, res) => {
  const { password } = req.body || {};
  const staff = await prisma.staff.findUnique({ where: { id: req.user.id } });
  if (!staff?.totpEnabled) return res.status(400).json({ error: "Two-factor authentication is not enabled" });
  if (!password || !(await verifyPassword(password, staff.passwordHash))) return res.status(400).json({ error: "Password is incorrect" });
  // Honour the same enforcement flag as everywhere else — while 2FA is off this
  // must not hard-block an account from removing an authenticator it can't use.
  if (TOTP_ENFORCED && staff.mustSetupTotp) return res.status(400).json({ error: "Two-factor authentication is required for this account" });
  const updated = await prisma.staff.update({ where: { id: staff.id }, data: { totpEnabled: false, totpSecret: null } });
  identityCache.invalidate("staff", staff.id);
  // A privileged action even though it only affects the caller's own account: it
  // lowers the bar for getting into that account, and if it was not the account
  // holder who did it, this row is how anyone finds out.
  audit.record(req, {
    action: "auth.totp.disabled", entity: "Staff", entityId: updated.id,
    summary: `${updated.name} (${updated.email}) turned two-step verification off`,
    before: { totpEnabled: true }, after: { totpEnabled: false },
  });
  res.json({ ok: true, user: sStaff(updated) });
});

// PUT /api/auth/change-password — change your own password (also clears the
// "must change password" flag set on admin-created accounts).
router.put("/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: "Current and new password are required" });
  if (String(newPassword).length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });

  // Student accounts change their own password too (the student app "More" screen).
  if (req.user.kind === "student") {
    const student = await prisma.student.findUnique({ where: { id: req.user.id } });
    if (!student || !student.passwordHash || !(await verifyPassword(currentPassword, student.passwordHash))) return res.status(400).json({ error: "Current password is incorrect" });
    if (await verifyPassword(newPassword, student.passwordHash)) return res.status(400).json({ error: "New password must be different from your current one" });
    const updated = await prisma.student.update({ where: { id: student.id }, data: { passwordHash: await hashPassword(newPassword), tokenVersion: { increment: 1 } } });
    // The bump revoked every other device's token — the cached row must go NOW, or
    // those tokens would keep passing requireAuth's version check for up to the TTL.
    identityCache.invalidate("student", student.id);
    audit.record(req, {
      action: "auth.password.changed", entity: "Student", entityId: updated.id,
      summary: `Student ${updated.firstName} ${updated.lastName} (${updated.studentRef}) changed their own password`,
      after: { otherSessionsEnded: true },
    });
    return res.json({ ok: true, user: { ...sStudent(updated), kind: "student" }, token: signStudentToken(updated) });
  }

  // Applicant (prospective-student portal) accounts change their own password too.
  if (req.user.kind === "applicant") {
    const applicant = await prisma.admission.findUnique({ where: { id: req.user.id } });
    if (!applicant || !applicant.passwordHash || !(await verifyPassword(currentPassword, applicant.passwordHash))) return res.status(400).json({ error: "Current password is incorrect" });
    if (await verifyPassword(newPassword, applicant.passwordHash)) return res.status(400).json({ error: "New password must be different from your current one" });
    const updated = await prisma.admission.update({ where: { id: applicant.id }, data: { passwordHash: await hashPassword(newPassword), tokenVersion: { increment: 1 } } });
    // Same as the student branch above: the bump is the revocation, the invalidate
    // is what makes it immediate rather than TTL-late.
    identityCache.invalidate("applicant", applicant.id);
    audit.record(req, {
      action: "auth.password.changed", entity: "Admission", entityId: updated.id,
      summary: `Applicant ${updated.email} changed their own password`,
      after: { otherSessionsEnded: true },
    });
    return res.json({ ok: true, user: { ...sApplicant(updated), kind: "applicant" }, token: signApplicantToken(updated) });
  }

  const staff = await prisma.staff.findUnique({ where: { id: req.user.id } });
  if (!staff || !(await verifyPassword(currentPassword, staff.passwordHash))) return res.status(400).json({ error: "Current password is incorrect" });
  if (await verifyPassword(newPassword, staff.passwordHash)) return res.status(400).json({ error: "New password must be different from your current one" });
  const updated = await prisma.staff.update({
    where: { id: staff.id },
    // Bumping tokenVersion signs out every OTHER device. The caller gets a freshly
    // signed token below so their current session continues uninterrupted.
    data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false, tokenVersion: { increment: 1 } },
  });
  // Every OTHER device's token died with the bump; without this, the cached row
  // would keep them alive for up to the TTL. The caller's own fresh token (signed
  // below with the new version) is also served correctly either way — requireAuth
  // re-reads when a cached row would reject — but immediacy for the revoked ones
  // only comes from invalidating here.
  identityCache.invalidate("staff", staff.id);
  // Any outstanding "forgot password" link is now meaningless — retire it.
  await prisma.passwordReset.updateMany({ where: { staffId: updated.id, usedAt: null }, data: { usedAt: new Date() } });
  audit.record(req, {
    action: "auth.password.changed", entity: "Staff", entityId: updated.id,
    summary: `${updated.name} (${updated.email}) changed their own password`,
    after: { otherSessionsEnded: true, outstandingResetLinksRetired: true },
  });
  res.json({ ok: true, user: sStaff(updated), token: signToken(updated) });
});

/* ==================================================================== *
 *              Accepting an invitation (admin-created account)         *
 * ==================================================================== */

// Look up a live invitation. Shares the PasswordReset table with the forgotten-
// password flow, distinguished by purpose, so the hashing, expiry and single-use
// rules are identical and can't drift apart.
async function findLiveInvite(rawToken) {
  if (!rawToken || typeof rawToken !== "string") return null;
  const row = await prisma.passwordReset.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { staff: true },
  });
  if (!row || row.purpose !== "invite" || row.usedAt || row.expiresAt < new Date()) return null;
  return row;
}

const INVITE_DEAD = "This invitation link is invalid or has expired. Ask an administrator to send a new one.";

// POST /api/auth/invite/verify — is the link still good? Lets the page greet the
// person by name instead of failing after they've typed a password.
router.post("/invite/verify", async (req, res) => {
  const row = await findLiveInvite(req.body?.token);
  if (!row) return res.status(400).json({ error: INVITE_DEAD });
  res.json({ ok: true, name: row.staff.name, email: row.staff.email, role: row.staff.jobTitle, dept: row.staff.dept });
});

// POST /api/auth/invite/accept — set the first password and activate the account.
router.post("/invite/accept", async (req, res) => {
  const { token, newPassword } = req.body || {};
  const row = await findLiveInvite(token);
  if (!row) return res.status(400).json({ error: INVITE_DEAD });
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  // Claim the link atomically, so two simultaneous submissions can't both activate.
  const claimed = await prisma.passwordReset.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) return res.status(400).json({ error: INVITE_DEAD });

  // Hashed BEFORE the transaction array is built: hashPassword is async now, and a
  // pending Promise inside a Prisma data payload would be serialised as garbage
  // rather than awaited.
  const invitePasswordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.staff.update({
      where: { id: row.staffId },
      data: {
        passwordHash: invitePasswordHash,
        pendingActivation: false,
        mustChangePassword: false,
        tokenVersion: { increment: 1 },
      },
    }),
    // Retire any other outstanding invite for this person.
    prisma.passwordReset.updateMany({ where: { staffId: row.staffId, purpose: "invite", usedAt: null }, data: { usedAt: new Date() } }),
  ]);
  // The account just changed password, activation state and token version — any
  // cached copy (an admin may have probed the account minutes ago) predates all
  // three. AFTER the transaction, so a rollback leaves nothing to invalidate over.
  identityCache.invalidate("staff", row.staffId);

  // The moment a colleague's account becomes usable. Pairs with the staff.invited
  // row an administrator generated days earlier, so the gap between "an account was
  // created for this person" and "this person took it up" is visible.
  audit.record(req, {
    actor: audit.asActor(row.staff, "staff"),
    action: "staff.invite.accepted", entity: "Staff", entityId: row.staffId,
    summary: `${row.staff.name} (${row.staff.email}) accepted their invitation and activated their account`,
    before: { pendingActivation: true },
    after: { pendingActivation: false },
  });

  // No session is returned — they sign in fresh, exactly like a password reset.
  res.json({ ok: true, email: row.staff.email, message: "Your account is active. You can now sign in." });
});

/* ==================================================================== *
 *                        Delete your own account                       *
 * ==================================================================== */

// DELETE /api/auth/account — self-service account deletion.
//
// Required by the App Store (and expected by Google Play) for any app that lets
// people create an account. Deliberately guarded like the other destructive
// actions: the password must be re-entered, a second factor is demanded when the
// account has one, and the caller must type the confirmation phrase — a fat finger
// must not be able to erase someone's employment record.
router.delete("/account", requireAuth, async (req, res) => {
  const { password, code, confirm } = req.body || {};

  // A student "delete account" removes their LOGIN only. Their academic record
  // (attendance, assessments) is the college's data and is kept — clearing the
  // password just means they can no longer sign in. Admins are told.
  if (req.user.kind === "student") {
    const student = await prisma.student.findUnique({ where: { id: req.user.id } });
    if (!student) return res.status(404).json({ error: "Account not found" });
    if (String(confirm || "").trim().toUpperCase() !== "DELETE") return res.status(400).json({ error: 'Type DELETE to confirm' });
    if (!password || !student.passwordHash || !(await verifyPassword(password, student.passwordHash))) return res.status(400).json({ error: "Password is incorrect" });
    await prisma.student.update({ where: { id: student.id }, data: { passwordHash: null, tokenVersion: { increment: 1 } } });
    // Their login is gone. requireAuth refuses a student row without a passwordHash,
    // and this makes that refusal immediate instead of one TTL away.
    identityCache.invalidate("student", student.id);
    audit.record(req, {
      action: "student.account.removed", entity: "Student", entityId: student.id,
      summary: `Student ${student.firstName} ${student.lastName} (${student.studentRef}) removed their own app sign-in — college records kept`,
      after: { canSignIn: false, academicRecordRetained: true },
    });
    notifyAdmins({ type: "info", message: `Student ${student.firstName} ${student.lastName} (${student.studentRef}) removed their app account.` }).catch(() => {});
    return res.json({ ok: true, message: "Your app account has been removed. Your college records are unaffected." });
  }

  const staff = await prisma.staff.findUnique({ where: { id: req.user.id } });
  if (!staff) return res.status(404).json({ error: "Account not found" });

  if (String(confirm || "").trim().toUpperCase() !== "DELETE") {
    return res.status(400).json({ error: 'Type DELETE to confirm' });
  }
  if (!password || !(await verifyPassword(password, staff.passwordHash))) {
    return res.status(400).json({ error: "Password is incorrect" });
  }
  if (totpRequiredFor(staff)) {
    if (!code) return res.status(400).json({ error: "Enter the current code from your authenticator app" });
    const lockedMins = codeLockedFor(staff.id);
    if (lockedMins) return res.status(429).json({ error: `Too many incorrect codes. Try again in ${lockedMins} minute${lockedMins === 1 ? "" : "s"}.` });
    if (!totp.verifyCode(staff.totpSecret, code)) {
      recordCodeFailure(staff.id);
      return res.status(400).json({ error: "That code isn't right. Check your authenticator app and try again." });
    }
  }

  // Removing the only administrator would leave nobody able to approve leave,
  // take registers or manage staff, and no way to appoint a replacement.
  if (staff.accountRole === "ADMIN") {
    const admins = await prisma.staff.count({ where: { accountRole: "ADMIN" } });
    if (admins <= 1) {
      return res.status(400).json({ error: "You are the only administrator. Make someone else an administrator before deleting your account." });
    }
  }

  const { name, email } = staff;
  // Tell the remaining admins before the row disappears — a staff record vanishing
  // silently is exactly the kind of thing HR needs to know about.
  await notifyAdmins({ type: "info", message: `${name} (${email}) deleted their Staff Hub account.` });

  // Deleting the Staff row cascades to check-ins, leave, adjustments, notifications
  // and password-reset tokens; assigned documents are detached, not destroyed.
  // The sign-up request holds the same email and a password hash, so it goes too —
  // otherwise "delete my account" would leave personal data behind.
  // Recorded BEFORE the delete, while the row still exists to describe — and the
  // audit row survives it, which is the point: a staff record disappearing with no
  // trace of who removed it is the gap an audit trail exists to close. actorEmail is
  // denormalised on the log for exactly this case.
  audit.record(req, {
    action: "staff.account.deleted", entity: "Staff", entityId: staff.id,
    summary: `${name} (${email}) deleted their own account — check-ins, leave, adjustments and notifications went with it`,
    before: { name, email, jobTitle: staff.jobTitle, dept: staff.dept, accountRole: staff.accountRole },
    after: null,
  });

  await prisma.$transaction([
    prisma.signupRequest.deleteMany({ where: { email } }),
    prisma.staff.delete({ where: { id: staff.id } }),
  ]);
  // The row is gone; the cache must not remember it. A deleted account whose cached
  // row survived would keep authenticating until the TTL ran out — the one staleness
  // this feature is absolutely not allowed to have. (A cache MISS on a deleted
  // account already behaves exactly as before: the fresh read finds nothing, 401.)
  identityCache.invalidate("staff", staff.id);

  clearLockoutsFor(email);
  clearCodeAttempts(staff.id);
  res.json({ ok: true, message: "Your account and personal data have been deleted." });
});

/* ==================================================================== *
 *                          Forgotten password                          *
 * ==================================================================== */

const RESET_TTL_MS = 30 * 60 * 1000;   // link is valid for 30 minutes
const RESET_MAX_PER_WINDOW = 5;        // per IP+email, per window
const RESET_WINDOW_MS = 60 * 60 * 1000;
const CLIENT_URL = (process.env.CLIENT_URL || "http://localhost:5173").replace(/\/$/, "");

// Same generic answer whichever branch we take, so the endpoint can't be used to
// discover which email addresses have accounts.
const RESET_SENT_MESSAGE = "If that email belongs to a Staff Hub account, a reset link is on its way. The link expires in 30 minutes.";

// Only the hash is ever stored; the raw token lives only in the emailed link.
const hashToken = (raw) => crypto.createHash("sha256").update(String(raw)).digest("hex");

const RESET_ATTEMPTS = new Map();
function resetRateLimited(req, email) {
  const key = `${req.ip}|${String(email || "").toLowerCase()}`;
  const now = Date.now();
  let s = RESET_ATTEMPTS.get(key);
  if (!s || now - s.first > RESET_WINDOW_MS) { s = { count: 0, first: now, lockedUntil: 0 }; RESET_ATTEMPTS.set(key, s); }
  s.count += 1;
  sweep(RESET_ATTEMPTS, now, RESET_WINDOW_MS);
  return s.count > RESET_MAX_PER_WINDOW;
}

// POST /api/auth/forgot-password — request a reset link.
router.post("/forgot-password", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "Email is required" });

  // Rate limited, but still with the generic reply — telling a caller they've been
  // limited on a specific address would leak that the address is worth guessing.
  if (resetRateLimited(req, email)) return res.json({ ok: true, message: RESET_SENT_MESSAGE });

  const staff = await prisma.staff.findFirst({ where: { email } });
  if (staff) {
    // Any earlier outstanding RESET link for this account stops working now, so a
    // forwarded or intercepted old email can't be used later.
    //
    // Scoped to purpose "reset" deliberately. Without the filter this also burned the
    // 7-day INVITE link — so someone whose invitation email was slow, and who tapped
    // "Forgotten your password?" in the meantime, destroyed the only working way into
    // their account. (The other half of that bug is fixed in /reset-password below.)
    await prisma.passwordReset.updateMany({
      where: { staffId: staff.id, purpose: "reset", usedAt: null },
      data: { usedAt: new Date() },
    });

    const raw = crypto.randomBytes(32).toString("hex");
    await prisma.passwordReset.create({
      data: { staffId: staff.id, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
    });

    const link = `${CLIENT_URL}/?reset=${raw}`;
    const needsCode = totpRequiredFor(staff);
    const text =
      `Hello ${staff.name},\n\nUse this link to choose a new password. It expires in 30 minutes and can only be used once:\n\n${link}\n\n` +
      (needsCode ? "You will also need the current code from your authenticator app.\n\n" : "") +
      "If you didn't ask for this, you can ignore this email — your password has not changed.";

    // Hand-built HTML rather than the generic wrapper: this is the one message
    // where the whole point is a button the reader has to press.
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // Resolved here, before the template literal below, which is synchronous.
    const b = await branding.get();
    const html = `<div style="margin:0;padding:24px;background:#eef1f6;font-family:'Segoe UI',system-ui,-apple-system,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(15,23,42,.08)">
    <div style="background:linear-gradient(135deg,${b.primaryColor},${b.accentColor});padding:20px 24px">
      ${mailAssets.wordmark(b, { size: 16 })}
      <p style="margin:2px 0 0;color:rgba(255,255,255,.7);font-size:11px;letter-spacing:.18em">STAFF HUB</p>
    </div>
    <div style="padding:24px">
      <h1 style="margin:0 0 10px;font-size:17px;color:#0f172a">Reset your password</h1>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#334155">Hello ${esc(staff.name)}, choose a new password using the button below. This link expires in <strong>30 minutes</strong> and can only be used once.</p>
      <p style="margin:0 0 18px"><a href="${link}" style="display:inline-block;background:${b.primaryColor};color:#fff;text-decoration:none;padding:11px 22px;border-radius:10px;font-size:14px;font-weight:700">Choose a new password</a></p>
      ${needsCode ? `<p style="margin:0 0 14px;padding:10px 12px;background:#eff6ff;border-radius:10px;font-size:12px;line-height:1.5;color:#1d4ed8">Your account uses two-step verification, so you'll also need the current code from your authenticator app.</p>` : ""}
      <p style="margin:0 0 6px;font-size:11px;color:#94a3b8">If the button doesn't work, copy this address into your browser:</p>
      <p style="margin:0 0 18px;font-size:11px;word-break:break-all"><a href="${link}" style="color:${b.primaryColor}">${link}</a></p>
      <p style="margin:0;font-size:12px;line-height:1.6;color:#64748b">If you didn't ask for this you can ignore this email — your password has not changed.</p>
    </div>
    <div style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e2e8f0">
      <p style="margin:0;font-size:11px;color:#94a3b8">This is an automated message from the Staff Hub — please don't reply.</p>
    </div>
  </div>
</div>`;

    // Fire-and-forget: the reset token is already saved, and the reply is the same
    // generic message regardless. Never make the user wait on (or be affected by) mail.
    sendEmail(staff.email, "Reset your Staff Hub password", text, { html }).catch(() => {});

    // Only on the branch where an account exists. The endpoint's whole design is to
    // give the same answer either way, and writing a row for an address that has no
    // account would turn the audit trail into the enumeration oracle the generic
    // reply is there to prevent — a failed sign-in is already recorded above, which
    // is where attempts against unknown addresses belong.
    audit.record(req, {
      actor: audit.asActor(staff, "staff"),
      action: "auth.password.reset.requested", entity: "Staff", entityId: staff.id,
      summary: `Password reset link sent to ${staff.email} — valid for 30 minutes, single use`,
      after: { requiresAuthenticatorCode: needsCode },
    });
  }

  res.json({ ok: true, message: RESET_SENT_MESSAGE });
});

// Look up a live token. Returns null for missing, expired, or already-used ones —
// the caller must not learn which of those it was.
async function findLiveReset(rawToken) {
  if (!rawToken || typeof rawToken !== "string") return null;
  const row = await prisma.passwordReset.findUnique({ where: { tokenHash: hashToken(rawToken) }, include: { staff: true } });
  // purpose must be "reset": an invitation link lasts 7 days, so accepting one
  // here would hand a much longer-lived token the powers of a 30-minute one.
  if (!row || row.purpose !== "reset" || row.usedAt || row.expiresAt < new Date()) return null;
  return row;
}

// POST /api/auth/reset-password/verify — is this link still good, and does the
// account need an authenticator code as well? Lets the UI show the right form
// instead of failing after the user has typed a new password.
router.post("/reset-password/verify", async (req, res) => {
  const row = await findLiveReset(req.body?.token);
  if (!row) return res.status(400).json({ error: "This reset link is invalid or has expired. Please request a new one." });
  res.json({ ok: true, name: row.staff.name, email: row.staff.email, requiresCode: totpRequiredFor(row.staff) });
});

// POST /api/auth/reset-password — set the new password.
router.post("/reset-password", async (req, res) => {
  const { token, newPassword, code } = req.body || {};
  const row = await findLiveReset(token);
  if (!row) return res.status(400).json({ error: "This reset link is invalid or has expired. Please request a new one." });

  const staff = row.staff;

  // The whole point of two-factor auth is that the password is not sufficient on
  // its own. A reset link arrives by email, so accepting it alone would let anyone
  // who reaches the mailbox walk straight past the authenticator. Demand the code.
  if (totpRequiredFor(staff)) {
    if (!code) return res.status(400).json({ error: "Enter the current code from your authenticator app" });
    const lockedMins = codeLockedFor(staff.id);
    if (lockedMins) return res.status(429).json({ error: `Too many incorrect codes. Try again in ${lockedMins} minute${lockedMins === 1 ? "" : "s"}.` });
    if (!totp.verifyCode(staff.totpSecret, code)) {
      recordCodeFailure(staff.id);
      return res.status(400).json({ error: "That code isn't right. Check your authenticator app and try again." });
    }
  }

  if (typeof newPassword !== "string" || newPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });
  if (await verifyPassword(newPassword, staff.passwordHash)) return res.status(400).json({ error: "New password must be different from your current one" });

  // Claim the link before doing anything else. A conditional update is atomic, so
  // of two simultaneous submissions of the same link exactly one sees count === 1
  // — without this, both passed the usedAt===null read and both reset the password.
  const claimed = await prisma.passwordReset.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) return res.status(400).json({ error: "This reset link is invalid or has expired. Please request a new one." });

  // Hashed before the transaction array is built — same reason as /invite/accept:
  // a Promise dropped into a Prisma payload is not awaited, it is mangled.
  const resetPasswordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.staff.update({
      where: { id: staff.id },
      data: {
        passwordHash: resetPasswordHash,
        mustChangePassword: false,
        // Choosing a password IS activating the account. Without this an invited
        // member of staff who reset their password was told "you can now sign in",
        // and then rejected at login for ever — /login refuses pendingActivation
        // accounts, and nothing else in this flow cleared the flag. Their only
        // remaining route in (the invitation link) had just been burned above.
        pendingActivation: false,
        // Sign every existing session out. A reset is often prompted by a
        // suspected compromise, so leaving old sessions alive would defeat it.
        tokenVersion: { increment: 1 },
      },
    }),
    // Burn any sibling link still outstanding.
    prisma.passwordReset.updateMany({ where: { staffId: staff.id, usedAt: null }, data: { usedAt: new Date() } }),
  ]);
  // "Sign every existing session out" (the bump above) has to mean NOW. A reset is
  // often prompted by a suspected compromise; a cached row honouring the attacker's
  // token for another 30 seconds is precisely the window the reset was run to close.
  identityCache.invalidate("staff", staff.id);

  // Being locked out is the normal reason someone reaches this flow, so a reset
  // that leaves the lockout in place looks to the user like it silently failed.
  clearLockoutsFor(staff.email);
  clearCodeAttempts(staff.id);

  audit.record(req, {
    actor: audit.asActor(staff, "staff"),
    action: "auth.password.reset", entity: "Staff", entityId: staff.id,
    summary: `Password for ${staff.email} reset via emailed link` + (totpRequiredFor(staff) ? ", with an authenticator code" : ""),
    after: { allSessionsEnded: true, lockoutCleared: true, pendingActivation: false },
  });

  notifyStaff(staff.id, {
    type: "success",
    message: "Your password was reset. You've been signed out everywhere — sign in with your new password.",
    link: "home",
  });

  // Deliberately no session is returned: the user signs in fresh, which also puts
  // them back through two-step verification.
  res.json({ ok: true, message: "Your password has been reset. You can now sign in." });
});

// GET /api/auth/me
// WHO AM I, AND WHAT DOES THIS COLLEGE OFFER ME.
//
// Both apps call this on mount and again on every refocus, and it is the ONLY bootstrap
// either of them has — api.js#studentMe exists but nothing calls it, so the student
// shell arrives here too. That is why the Develop App payload is attached here rather
// than only on /student/me: a screen list delivered on a route nobody calls switches
// nothing off.
//
// BRANCHED ON IDENTITY KIND, so neither surface learns the other's configuration. A
// student being told which 34 staff pages the college switched off is a small leak, but
// it is a leak of the college's internal arrangements to an audience with no use for
// them, and an allowlist on the way out is the house rule (conventions.md).
//
// An applicant gets no payload at all. The applicant portal has no configurable
// surface — there is nothing in the registry for it — and inventing an empty one here
// would imply a third tab on the Develop App screen that does not exist.
//
// NEVER GATED, and it cannot be: this is what tells an app which of its screens the
// college offers. Gating it behind any one of them would sign out every student in the
// college the moment that screen was switched off.
//
// FAILS OPEN, like both guards. If the config cannot be read, the apps are told nothing
// and fall back to showing everything — which is exactly how they behaved before this
// feature existed. The alternative is an app that renders no navigation at all because
// an optional settings row was briefly unreadable.
router.get("/me", requireAuth, async (req, res) => {
  const surface = isStudent(req.user) ? "student" : isApplicant(req.user) ? null : "staff";
  if (!surface) return res.json(req.user);
  let app = null;
  try {
    app = await require("../appFunctionConfig").viewFor(surface);
  } catch {
    app = null; // fail open — the apps read a null payload as "no restrictions"
  }
  res.json({ ...req.user, app });
});

module.exports = router;
