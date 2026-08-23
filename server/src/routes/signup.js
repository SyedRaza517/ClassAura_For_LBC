// Self-service sign-up from the staff mobile app, gated on admin approval.
//
// An applicant is NOT a staff member: their details sit in SignupRequest until an
// admin approves, so they never appear in the staff list, calendars or registers,
// and they cannot sign in. Approval copies the row into Staff — password hash
// included, so the applicant keeps the password they chose. (Authenticator/2FA
// enrolment is currently switched off — see the commented-out branches in auth.js.)
const router = require("express").Router();
const prisma = require("../db");
const { sSignup, sStaff, sStudent } = require("../serializers");
const { requireAuth, requirePage, hashPassword } = require("../auth");
const { notifyStaff, notifyAdmins } = require("../notify");
const { isInt32, MAX_ALLOWANCE_DAYS, isHomeSite } = require("../validate");
const { notifyExistingAccount } = require("../invite");
const { localDate } = require("../clock");
const audit = require("../audit");

const PALETTE = ["#1a3a8f", "#9e1b32", "#0d7a5f", "#b45309", "#6d28d9", "#0e7490", "#be123c"];
const initialsOf = (name) => name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const colourFor = (email) => { let h = 0; for (const ch of String(email)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; };
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const today = () => localDate();
const str = (v) => (typeof v === "string" ? v.trim() : "");

// POST /api/signup — public. Creates a pending request and tells the admins.
// `kind` is "staff" (default) or "student". Student requests carry only name/email/
// password; they match an existing Student by email when one exists, and always
// wait for admin approval.
// Sign-up is public and does real work per call: a synchronous bcrypt hash (which
// blocks the single Node thread) plus a notification, an email and a push to EVERY
// admin. Unlimited, a loop both stalls the API and mailbombs the administrators, so
// each address gets a small burst allowance.
const SIGNUP_HITS = new Map();
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
// A whole college shares one address behind NAT, so this has to accommodate a real
// enrolment session — 128 students registering from campus wifi in the same hour is
// normal, not abuse. The point is to stop a script, not to ration genuine sign-ups.
const SIGNUP_MAX = 60;

// Whether this address may make ANOTHER request. Read-only: a request is only counted
// once it has passed validation, so somebody mistyping the form five times does not
// spend their quota — that turned a fumbled sign-up into an hour-long lockout.
function signupAllowed(ip) {
  const now = Date.now();
  const hits = (SIGNUP_HITS.get(ip) || []).filter((t) => now - t < SIGNUP_WINDOW_MS);
  if (hits.length) SIGNUP_HITS.set(ip, hits); else SIGNUP_HITS.delete(ip);
  // Sweep here rather than on the record path, so a blocked address can't stop the
  // map being tidied.
  if (SIGNUP_HITS.size > 5000) {
    for (const [k, v] of SIGNUP_HITS) if (!v.some((t) => now - t < SIGNUP_WINDOW_MS)) SIGNUP_HITS.delete(k);
  }
  return hits.length < SIGNUP_MAX;
}
function recordSignup(ip) {
  const now = Date.now();
  const hits = (SIGNUP_HITS.get(ip) || []).filter((t) => now - t < SIGNUP_WINDOW_MS);
  hits.push(now);
  SIGNUP_HITS.set(ip, hits);
}

router.post("/", async (req, res) => {
  if (!signupAllowed(req.ip)) {
    return res.status(429).json({ error: "Too many sign-up attempts from this connection. Please try again later." });
  }
  const kind = str(req.body?.kind) === "student" ? "student" : "staff";
  const name = str(req.body?.name);
  const email = str(req.body?.email).toLowerCase();
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const confirmPassword = typeof req.body?.confirmPassword === "string" ? req.body.confirmPassword : "";

  // Shared validation.
  if (!name) return res.status(400).json({ error: "Full name is required" });
  if (!EMAIL_REGEX.test(email)) return res.status(400).json({ error: "Enter a valid email address" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
  if (confirmPassword && password !== confirmPassword) return res.status(400).json({ error: "Passwords do not match" });

  const genericOk = () => res.status(202).json({ ok: true, status: "pending", message: "Thanks — your request has been sent to the college administrator for approval." });

  // ---- Student sign-up ----
  if (kind === "student") {
    const collegeId = str(req.body?.collegeId);
    if (!collegeId) return res.status(400).json({ error: "Your college ID is required" });

    const [staffClash, byRef, byEmail, existingRequest] = await Promise.all([
      prisma.staff.findFirst({ where: { email } }),
      prisma.student.findFirst({ where: { studentRef: collegeId } }),
      prisma.student.findFirst({ where: { email } }),
      prisma.signupRequest.findFirst({ where: { email } }),
    ]);
    // Link the request to an existing student record ONLY when the college ID and the
    // email point at the SAME person. Trusting the college ID alone meant a mistyped
    // ID silently attached the request to somebody else's record — and approving it
    // then overwrote that student's password and activated their account.
    let student = null, matchNote = " — no matching record";
    if (byRef && byEmail && byRef.id === byEmail.id) {
      student = byRef; matchNote = " — matches an existing student record";
    } else if (byRef && !byEmail) {
      // The ID belongs to a record with a different email on file: could be a typo of
      // another student's ID, so never auto-link. An admin resolves it by hand.
      matchNote = ` — WARNING: college ID ${collegeId} is on file under a different email; check before approving`;
    } else if (!byRef && byEmail) {
      // NEVER auto-link on the email alone. Nothing in this flow proves the applicant
      // controls that mailbox, and every student email here is the college number at a
      // known domain — so trusting it let anyone claim any unclaimed account simply by
      // guessing the address. The admin is shown the candidate and must link it
      // deliberately; the request itself stays unlinked.
      matchNote = ` — WARNING: this email is on a student record whose college ID is not ${collegeId}; confirm identity before approving`;
    } else if (byRef && byEmail) {
      // Both exist but are different people — definitely do not link either.
      matchNote = ` — WARNING: college ID ${collegeId} and this email belong to two different student records; check before approving`;
    }
    // Same generic reply if the email is a staff account, an already-claimed student
    // account, or already has a live request — never reveal which. Both candidate
    // records are checked so a claimed account can't be re-claimed via the other key.
    const alreadyClaimed = (byRef && byRef.passwordHash) || (byEmail && byEmail.passwordHash);
    // An "approved" request whose student record has since been deleted is stale and
    // must not bar a fresh application (see the staff branch for the full reasoning).
    const staleApproved = existingRequest && existingRequest.status === "approved" && !byRef && !byEmail;
    const liveRequest = existingRequest && existingRequest.status !== "rejected" && !staleApproved;
    if (staffClash || alreadyClaimed || liveRequest) return genericOk();

    const data = { kind: "student", studentId: student?.id || null, collegeId, name, email, passwordHash: hashPassword(password), jobTitle: "", dept: "", site: null, status: "pending", note: null, decidedBy: null, decidedAt: null };
    if (existingRequest) await prisma.signupRequest.update({ where: { id: existingRequest.id }, data });
    else await prisma.signupRequest.create({ data });
    notifyAdmins({ type: "info", message: `New STUDENT sign-up from ${name} (ID ${collegeId})${matchNote} — awaiting approval`, link: "signups" });
    return genericOk();
  }

  // ---- Staff sign-up (unchanged) ----
  const jobTitle = str(req.body?.position) || str(req.body?.role);
  const dept = str(req.body?.dept);
  const site = str(req.body?.site) || null;
  if (!jobTitle) return res.status(400).json({ error: "Position is required" });
  if (!dept) return res.status(400).json({ error: "Department is required" });
  if (!isHomeSite(site)) return res.status(400).json({ error: "Site must be HND, FE or SL" });

  // Deliberately the same reply whether the email belongs to a staff member, a
  // pending request or a rejected one — otherwise this endpoint becomes a public
  // "does this person work here?" oracle.
  const [existingStaff, existingRequest] = await Promise.all([
    prisma.staff.findFirst({ where: { email } }),
    prisma.signupRequest.findFirst({ where: { email } }),
  ]);

  // A request only blocks a re-application while it is still live. An "approved" one
  // whose Staff account no longer exists is STALE — the account was deleted — and must
  // not bar the same person from signing up again. (Deleting a staff member now clears
  // their request as well; this is the belt-and-braces half of that fix, and it also
  // repairs accounts deleted before it shipped.)
  const staleApproved = existingRequest && existingRequest.status === "approved" && !existingStaff;
  const liveRequest = existingRequest && existingRequest.status !== "rejected" && !staleApproved;

  if (existingStaff || liveRequest) {
    // The on-screen answer stays identical, but the real account holder is told —
    // otherwise a genuine applicant who already has an account waits forever for
    // an approval that was never created, and the owner never learns someone tried.
    if (existingStaff) notifyExistingAccount(existingStaff).catch(() => {});
    return res.status(202).json({ ok: true, status: "pending", message: "Thanks — your request has been sent to the college administrator for approval." });
  }

  // A previously rejected applicant — or one whose account has since been deleted —
  // may apply again: overwrite the old row so the unique email constraint doesn't
  // permanently bar them.
  const data = { name, email, passwordHash: hashPassword(password), jobTitle, dept, site, status: "pending", note: null, decidedBy: null, decidedAt: null };
  if (existingRequest) await prisma.signupRequest.update({ where: { id: existingRequest.id }, data });
  else await prisma.signupRequest.create({ data });

  notifyAdmins({ type: "info", message: `New staff sign-up request from ${name} (${jobTitle}, ${dept}) — awaiting approval`, link: "signups" });

  res.status(202).json({ ok: true, status: "pending", message: "Thanks — your request has been sent to the college administrator for approval." });
});

// GET /api/signup — admin. Optional ?status=pending|approved|rejected
router.get("/", requireAuth, requirePage("signups"), async (req, res) => {
  // Case-insensitive, and an unrecognised value is an ERROR rather than "no filter".
  // Failing open meant ?status=PENDING or a typo returned every request, including
  // approved ones — a "pending" queue quietly showing already-handled applications.
  const status = str(req.query?.status).toLowerCase();
  const ALLOWED = ["pending", "approved", "rejected"];
  if (status && !ALLOWED.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${ALLOWED.join(", ")}` });
  }
  const where = status ? { status } : {};
  const rows = await prisma.signupRequest.findMany({ where, orderBy: { createdAt: "desc" } });
  res.json(rows.map(sSignup));
});

// PUT /api/signup/:id/decision — admin approves or declines.
// Approving creates the Staff account; declining leaves the request for the record.
// Corrections an admin may make to what the applicant typed, at the moment of
// approving. People mistype their own name and department, and until now the only
// remedy was to approve the request and then fix the account afterwards — or reject
// it and make them start again.
//
// The password is deliberately NOT here. It is only ever stored hashed, so it cannot
// be shown or edited, and the applicant must still be able to sign in with what they
// chose.
const EDITABLE = ["name", "email", "jobTitle", "dept", "site", "collegeId"];

async function readEdits(body, row) {
  const patch = {};
  for (const k of EDITABLE) {
    if (body?.[k] === undefined) continue;
    const v = str(body[k]);
    if (v !== (row[k] || "")) patch[k] = v;
  }
  if (!Object.keys(patch).length) return { patch };

  if ("name" in patch && !patch.name) return { error: "Name can't be empty" };
  if ("email" in patch) {
    if (!EMAIL_REGEX.test(patch.email)) return { error: "Enter a valid email address" };
    patch.email = patch.email.toLowerCase();
    const clash = await prisma.signupRequest.findFirst({ where: { email: patch.email } });
    if (clash && clash.id !== row.id) return { error: "Another sign-up request already uses that email" };
  }
  if ("site" in patch && patch.site && !isHomeSite(patch.site)) return { error: "Unknown site" };
  if ("jobTitle" in patch && row.kind === "staff" && !patch.jobTitle) return { error: "Position can't be empty" };
  return { patch };
}


// PUT /api/signup/:id — correct a pending request WITHOUT deciding it.
//
// The decision endpoint already accepts corrections, but only at the moment of
// approving. An admin who spots a typo while working through the queue, and is not
// yet ready to approve, had nowhere to put it.
router.put("/:id", requireAuth, requirePage("signups"), async (req, res) => {
  const row = await prisma.signupRequest.findUnique({ where: { id: req.params.id } });
  if (!row) return res.status(404).json({ error: "Sign-up request not found" });
  // A decided request is part of the audit trail and stays as it was.
  if (row.status !== "pending") return res.status(409).json({ error: "This request has already been decided, so it can no longer be edited" });

  const edits = await readEdits(req.body, row);
  if (edits.error) return res.status(400).json({ error: edits.error });
  if (!Object.keys(edits.patch).length) return res.json(sSignup(row));

  const updated = await prisma.signupRequest.update({ where: { id: row.id }, data: edits.patch });
  res.json(sSignup(updated));
});

router.put("/:id/decision", requireAuth, requirePage("signups"), async (req, res) => {
  const { status, note, allowance } = req.body || {};
  if (!["approved", "rejected"].includes(status)) return res.status(400).json({ error: "status must be approved or rejected" });

  let reqRow = await prisma.signupRequest.findUnique({ where: { id: req.params.id } });
  if (!reqRow) return res.status(404).json({ error: "Sign-up request not found" });
  // Decide once only — mirrors the leave-decision rule and protects the audit trail.
  if (reqRow.status !== "pending") return res.status(409).json({ error: "This request has already been decided" });

  // Apply corrections BEFORE anything else reads the row. The student-matching rules
  // below resolve an account from the college ID and the email, so they must see what
  // the admin corrected — checking the old values would defeat the very protection
  // that stops a request claiming somebody else's record.
  const edits = await readEdits(req.body, reqRow);
  if (edits.error) return res.status(400).json({ error: edits.error });
  const patch = edits.patch;

  const decided = { ...patch, status, note: str(note) || null, decidedBy: req.user.name, decidedAt: today() };
  // Keep the in-memory copy in step, since the rest of this handler reads reqRow.
  reqRow = { ...reqRow, ...patch };

  if (status === "rejected") {
    const updated = await prisma.signupRequest.update({ where: { id: reqRow.id }, data: decided });
    audit.record(req, {
      action: "signup.rejected", entity: "SignupRequest", entityId: updated.id,
      summary: `Sign-up request from ${reqRow.name} (${reqRow.email}) rejected by ${req.user.name}` + (updated.note ? ` — "${updated.note}"` : ""),
      before: { status: "pending" },
      after: { status: "rejected", kind: reqRow.kind, note: updated.note },
    });
    return res.json({ request: sSignup(updated), staff: null });
  }

  // Approving a STUDENT request: activate the matched student record (or create a
  // fresh one if there was no match) with the password they chose at sign-up. No 2FA.
  if (reqRow.kind === "student") {
    let student = reqRow.studentId ? await prisma.student.findUnique({ where: { id: reqRow.studentId } }) : null;
    // Re-resolve for records an admin created between sign-up and approval — but ONLY
    // when the college ID and the email name the same person, exactly as sign-up
    // requires. Resolving on either key alone is what let an applicant claim an
    // account they had merely guessed the address of: every student email here is the
    // college number at a known domain, so email is a public identifier, not proof.
    if (!student) {
      const [byEmail, byRef] = await Promise.all([
        prisma.student.findFirst({ where: { email: reqRow.email } }),
        reqRow.collegeId ? prisma.student.findFirst({ where: { studentRef: reqRow.collegeId } }) : Promise.resolve(null),
      ]);
      if (byRef && byEmail && byRef.id === byEmail.id) {
        student = byRef;                        // both agree — safe to link
      } else if (byRef || byEmail) {
        const which = byRef && byEmail
          ? `College ID ${reqRow.collegeId} and this email belong to two different student records.`
          : byRef
            ? `College ID ${reqRow.collegeId} is on file under a different email (${byRef.email}).`
            : `This email is on a student record whose college ID is not ${reqRow.collegeId || "(none given)"}.`;
        return res.status(409).json({
          error: `${which} Approving would overwrite the wrong account. Confirm the applicant's identity, correct the student record so its college ID and email agree, then approve.`,
        });
      }
    }
    // Never re-claim an account that already has a password — a second request for the
    // same person (via a different email) would otherwise overwrite their credentials
    // and sign them out. The admin must resolve that by hand.
    if (student && student.passwordHash) {
      return res.status(409).json({ error: "That student account has already been claimed. Reject this request, or reset the student's password instead." });
    }
    try {
      const ops = student
        ? [prisma.student.update({ where: { id: student.id }, data: { passwordHash: reqRow.passwordHash, active: true, tokenVersion: { increment: 1 } } }),
           prisma.signupRequest.update({ where: { id: reqRow.id }, data: decided })]
        : (() => { const parts = reqRow.name.trim().split(/\s+/); return [
            prisma.student.create({ data: { firstName: parts[0] || reqRow.name, lastName: parts.slice(1).join(" ") || "", studentRef: reqRow.collegeId || ("S" + Date.now()), email: reqRow.email, initials: initialsOf(reqRow.name), colour: colourFor(reqRow.email), active: true, passwordHash: reqRow.passwordHash } }),
            prisma.signupRequest.update({ where: { id: reqRow.id }, data: decided })]; })();
      const [savedStudent, updatedReq] = await prisma.$transaction(ops);
      audit.record(req, {
        action: "signup.approved", entity: "Student", entityId: savedStudent.id,
        summary: `Student sign-up from ${reqRow.name} (${reqRow.email}) approved by ${req.user.name} — ` + (student ? "existing record claimed" : "a new student record was created"),
        before: { status: "pending", existingRecord: !!student },
        after: { status: "approved", studentRef: savedStudent.studentRef, email: savedStudent.email, active: true, allSessionsEnded: !!student },
      });
      return res.status(201).json({ request: sSignup(updatedReq), student: sStudent(savedStudent) });
    } catch (e) {
      // P2002 can fire on either unique key, so name both rather than guessing email.
      if (e.code === "P2002") return res.status(409).json({ error: "A student record already exists with that email or college ID" });
      return res.status(500).json({ error: "Could not activate the student account" });
    }
  }

  // Approval. Someone may have been added manually with this email in the meantime.
  const clash = await prisma.staff.findFirst({ where: { email: reqRow.email } });
  if (clash) return res.status(409).json({ error: "A staff account with that email already exists" });

  let days = 28;
  if (allowance != null) {
    // Bounded for the same reason as PUT /staff/:id — an out-of-range Int would be
    // written by SQLite and then break every read of the Staff table.
    if (!isInt32(allowance) || Number(allowance) < 0 || Number(allowance) > MAX_ALLOWANCE_DAYS) {
      return res.status(400).json({ error: `Allowance must be a whole number between 0 and ${MAX_ALLOWANCE_DAYS}` });
    }
    days = Number(allowance);
  }

  try {
    // One transaction: never create the account without closing the request, and
    // never close the request without creating the account.
    const [staff, updated] = await prisma.$transaction([
      prisma.staff.create({
        data: {
          name: reqRow.name, jobTitle: reqRow.jobTitle, dept: reqRow.dept, email: reqRow.email,
          site: reqRow.site || null, // home site the applicant picked at sign-up
          passwordHash: reqRow.passwordHash, // they keep the password they chose at sign-up
          accountRole: "STAFF", allowance: days,
          initials: initialsOf(reqRow.name), colour: colourFor(reqRow.email),
          mustChangePassword: false,
          // Authenticator (2FA) temporarily DISABLED — new staff are NOT required to
          // enrol on first sign-in. Restore `true` to make it compulsory again.
          mustSetupTotp: false,
        },
      }),
      prisma.signupRequest.update({ where: { id: reqRow.id }, data: decided }),
    ]);

    notifyStaff(staff.id, {
      type: "success",
      message: `Your Staff Hub account has been approved. You can now sign in with your email and password.`,
      link: "home",
    });

    // An outsider becoming a member of staff with a working login. The approval is
    // the decision that matters, so it is recorded against the account it created
    // rather than against the request that asked for it.
    audit.record(req, {
      action: "signup.approved", entity: "Staff", entityId: staff.id,
      summary: `Staff sign-up from ${staff.name} (${staff.email}) approved by ${req.user.name} — account created with ${days} days' allowance`,
      before: { status: "pending" },
      after: { status: "approved", name: staff.name, email: staff.email, jobTitle: staff.jobTitle, dept: staff.dept, site: staff.site, allowance: days, accountRole: staff.accountRole },
    });

    res.status(201).json({ request: sSignup(updated), staff: sStaff(staff) });
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "A staff account with that email already exists" });
    res.status(500).json({ error: "Could not create the staff account" });
  }
});

module.exports = router;
