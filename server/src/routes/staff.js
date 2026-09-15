const router = require("express").Router();
const prisma = require("../db");
const audit = require("../audit");
const { sStaff } = require("../serializers");
const { requireAuth, requireAdmin, requireSuperAdmin, requireAnyPage, hasPage, hashPassword, blockedByRank, EXPLICIT_ONLY } = require("../auth");
const { notifyStaff } = require("../notify");
// The college's support-department list, so membership can be validated against the
// departments that actually exist rather than stored as free text.
const supportDepartments = require("../supportDepartments");
const { sendEmail } = require("../email");
const { isInt32, MAX_ALLOWANCE_DAYS, isString, isNonEmptyString, isHomeSite, isRealDate, ADMIN_PAGES } = require("../validate");
const { sendInvite, unguessablePassword } = require("../invite");
const branding = require("../branding");

// allowance is a 32-bit Int column. An out-of-range value would be stored by SQLite
// but unreadable by Prisma afterwards, which would break GET /staff — and therefore
// sign-in itself — for every user. Bound it here.
const isValidAllowance = (v) => isInt32(v) && Number(v) >= 0 && Number(v) <= MAX_ALLOWANCE_DAYS;

const PALETTE = ["#1a3a8f", "#9e1b32", "#0d7a5f", "#b45309", "#6d28d9", "#0e7490", "#be123c"];
const initialsOf = (name) => name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Pick a palette colour deterministically from the email. Using a stable hash (rather
// than the live staff count) avoids a race where two concurrent creates read the same
// count and get the same colour.
const colourFor = (email) => { let h = 0; for (const ch of String(email)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; };

// GET /api/staff  — any authenticated user (needed for calendars / who's-off)
router.get("/", requireAuth, async (req, res) => {
  // THE ACADEMIC DEPARTMENT MEMBERSHIPS ARE INCLUDED, and leaving them out was a real
  // bug rather than a missing nicety. sStaff emits `academicDepartmentIds` only when the
  // relation is loaded, and ABSENT is deliberately different from EMPTY there -- "nobody
  // asked" is not "belongs to none". This is the query behind store.staff, which is what
  // the Access screen reads, so without the include every member of staff rendered with
  // no departments ticked under a warning saying they could see nothing. An administrator
  // correcting that by pressing Save sent an empty list, and the handler's
  // deleteMany-then-create destroyed the real membership. The screen then agreed with
  // itself for the first time.
  //
  // Only the full shape below carries it. The reduced shape is a hand-built literal and
  // is unaffected.
  const staff = await prisma.staff.findMany({
    orderBy: { name: "asc" },
    include: { academicDepartments: { select: { academicDepartmentId: true } } },
  });
  // Full shape (email / allowance / account role / access) goes only to those who
  // manage staff: the Super Admin, or an admin with the staff/settings page. Every
  // other admin gets the same reduced public shape as regular staff — so a restricted
  // admin can't harvest colleagues' PII through the API, only the names/colours other
  // tabs (calendars, check-in, timesheets) need. Everyone still sees their OWN record.
  const u = req.user;
  const pages = u.adminPages; // null = full access
  const canManageStaff = u.accountRole === "ADMIN" && (u.isSuperAdmin || pages == null || pages.includes("staff") || pages.includes("settings"));
  if (canManageStaff) return res.json(staff.map(sStaff));
  // A leave admin needs each person's ALLOWANCE to show a balance or book on their
  // behalf — without it the client computed 0 for everyone, showed negative remaining
  // days, and disabled the booking button entirely. It is an entitlement figure, not
  // the personal data (email, 2FA state, admin pages) this shape exists to withhold.
  // "overview" and "kpi" belong here too. Both already receive everyone's leave
  // (leave.js LEAVE_READ_PAGES) and everyone's adjustments (adjustments.js), but were
  // left off this list — so the client got `allowance: undefined`, coerced it to 0,
  // and the KPI table read "12/0d", the drill-down "12 of 0 days", the CSV "12/0",
  // and the Balances screen showed −12 days remaining in green.
  const leaveAdmin = hasPage(u, ["balances", "calendar", "requests", "approvals", "overview", "kpi"]);
  res.json(staff.map((s) => s.id === u.id
    ? sStaff(s)
    : {
        id: s.id, name: s.name, role: s.jobTitle, dept: s.dept, initials: s.initials, colour: s.colour,
        ...(leaveAdmin ? { allowance: s.allowance } : {}),
      }));
});

// POST /api/staff  (admin)
router.post("/", requireAuth, requireAnyPage(["staff", "settings"]), async (req, res) => {
  const { name, role, dept, email, allowance, password, site, dob } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: "Name and email required" });
  // Type-check before anything touches initialsOf() or Prisma: a number here threw
  // outside the try block and surfaced as a 500. A whitespace-only name passed the
  // truthiness check and stored a nameless staff row with blank initials.
  if (!isNonEmptyString(name)) return res.status(400).json({ error: "Name must be text" });
  if (!isString(email)) return res.status(400).json({ error: "Email must be text" });
  if (role != null && !isString(role)) return res.status(400).json({ error: "Role must be text" });
  if (dept != null && !isString(dept)) return res.status(400).json({ error: "Department must be text" });
  if (!isHomeSite(site)) return res.status(400).json({ error: "Site must be HND, FE or SL" });
  if (!EMAIL_REGEX.test(String(email))) return res.status(400).json({ error: "Invalid email format" });
  // Reject a bad allowance instead of silently substituting 28 — an admin who typed
  // 27.5 or 280 was told the staff member was added and never learned the value was
  // discarded. PUT already rejects these, so this also makes the two consistent.
  if (allowance != null && !isValidAllowance(allowance)) {
    return res.status(400).json({ error: `Allowance must be a whole number between 0 and ${MAX_ALLOWANCE_DAYS}` });
  }
  // Optional date of birth (powers birthday emails). Empty → null; otherwise a real
  // YYYY-MM-DD calendar date.
  const dobClean = typeof dob === "string" ? dob.trim() : "";
  if (dobClean && !isRealDate(dobClean)) return res.status(400).json({ error: "Date of birth must be a valid date (YYYY-MM-DD)" });
  // No shared default password. The account is created inactive with a password
  // nobody knows, and the person activates it from an emailed link. Previously
  // every admin-created account carried "password123", so anyone who guessed the
  // email address could sign straight in as them.
  const invited = !password;
  try {
    const staff = await prisma.staff.create({
      data: {
        name, jobTitle: role || "Staff", dept: dept || "General",
        site: site || null,
        email: String(email).toLowerCase(),
        passwordHash: await hashPassword(password || unguessablePassword()),
        accountRole: "STAFF", allowance: allowance == null ? 28 : Number(allowance),
        dob: dobClean || null,
        initials: initialsOf(name), colour: colourFor(String(email).toLowerCase()),
        // An explicitly-supplied password means the caller has chosen one and the
        // account is usable at once; otherwise it waits for activation.
        pendingActivation: invited,
        mustChangePassword: !invited,
      },
    });
    if (invited) await sendInvite(staff, { invitedBy: req.user.name });
    // A new person with a login to the college's systems. Recorded with the details
    // that decide what they can see — never the password hash, which the redactor
    // would strip anyway but which is not passed here in the first place.
    audit.record(req, {
      action: "staff.created", entity: "Staff", entityId: staff.id,
      summary: `Staff account created for ${staff.name} (${staff.email})` + (invited ? " — invitation sent, awaiting activation" : " — password set by the administrator"),
      after: { name: staff.name, email: staff.email, jobTitle: staff.jobTitle, dept: staff.dept, site: staff.site, allowance: staff.allowance, accountRole: staff.accountRole, pendingActivation: staff.pendingActivation },
    });
    res.status(201).json({ ...sStaff(staff), invited });
  } catch (e) {
    if (e.code === "P2002") return res.status(400).json({ error: "Email already in use" });
    res.status(500).json({ error: "Could not create staff" });
  }
});

// The Super Admin is the only account that can grant or revoke admin pages, so it must
// not be editable, deletable or 2FA-strippable by the very admins it governs. Without
// this, an admin holding only the "staff" page could point the Super Admin's email at
// their own inbox, run a password reset, and take the account over — or simply delete
// it and freeze all access management for good. Only another Super Admin may act on one.
// Now a RANK check, not a Super-Admin-only one — see blockedByRank in ../auth.js for
// why protecting a single row was not enough.
function guardSuperAdmin(target, req) {
  return blockedByRank(req.user, target);
}

// PUT /api/staff/:id  (admin)
router.put("/:id", requireAuth, requireAnyPage(["staff", "settings"]), async (req, res) => {
  const target = await prisma.staff.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: "Staff not found" });
  const blocked = guardSuperAdmin(target, req);
  if (blocked) return res.status(403).json({ error: blocked });
  const { name, role, dept, email, allowance, site, dob } = req.body || {};
  const data = {};
  if (name != null) {
    if (!isNonEmptyString(name)) return res.status(400).json({ error: "Name must be text" });
    data.name = name; data.initials = initialsOf(name);
  }
  if (role != null && !isString(role)) return res.status(400).json({ error: "Role must be text" });
  if (dept != null && !isString(dept)) return res.status(400).json({ error: "Department must be text" });
  if (email != null && !isString(email)) return res.status(400).json({ error: "Email must be text" });
  if (!isHomeSite(site)) return res.status(400).json({ error: "Site must be HND, FE or SL" });
  if (role) data.jobTitle = role;
  if (dept) data.dept = dept;
  // site is a closed set incl. null — allow explicitly clearing it back to "unset".
  if (site !== undefined) data.site = site || null;
  if (email) {
    if (!EMAIL_REGEX.test(String(email))) return res.status(400).json({ error: "Invalid email format" });
    data.email = String(email).toLowerCase();
  }
  if (allowance != null) {
    if (!isValidAllowance(allowance)) return res.status(400).json({ error: `Allowance must be a whole number between 0 and ${MAX_ALLOWANCE_DAYS}` });
    data.allowance = Number(allowance);
  }
  // dob is optional and clearable: empty → null, otherwise a real YYYY-MM-DD date.
  if (dob !== undefined) {
    const dobClean = typeof dob === "string" ? dob.trim() : "";
    if (dobClean && !isRealDate(dobClean)) return res.status(400).json({ error: "Date of birth must be a valid date (YYYY-MM-DD)" });
    data.dob = dobClean || null;
  }
  // Changing someone's email points their password-reset link at a new mailbox, so it
  // is an account-transfer, not an edit. Treat it like one: end their sessions, kill
  // any reset link already in flight, and tell the OLD address — otherwise this was a
  // silent first step in taking an account over.
  const emailChanging = Boolean(data.email && data.email !== target.email);
  if (emailChanging) data.tokenVersion = { increment: 1 };
  try {
    const staff = await prisma.staff.update({ where: { id: req.params.id }, data });
    if (emailChanging) {
      await prisma.passwordReset.updateMany({ where: { staffId: staff.id, usedAt: null }, data: { usedAt: new Date() } });
      notifyStaff(staff.id, {
        type: "warning",
        message: `${req.user.name} changed the email address on your account from ${target.email} to ${staff.email}. If you weren't expecting this, tell the college office straight away.`,
      });
      // Resolved before the message is built so the warning names the college whose
      // account actually moved. The clause collapses to "your Staff Hub account" when
      // the institution has no display name — this mail exists to warn someone their
      // account is being taken over, so it must not name an institution that isn't theirs.
      const whose = (await branding.get()).displayName;
      const account = whose ? `your ${whose} Staff Hub account` : "your Staff Hub account";
      sendEmail(target.email, "Your Staff Hub email address was changed",
        `Hello ${target.name},\n\n${req.user.name} changed the email address on ${account} to ${staff.email}.\n\nIf you did not expect this, contact the college office immediately — whoever holds the new address can now request a password reset for your account.`
      ).catch(() => {});
    }
    // Employment details and holiday allowance are disputed months later, and the
    // email change above is an account transfer, not an edit. The diff carries only
    // the fields that actually moved, so a routine job-title correction does not read
    // like a rewrite of the whole record.
    audit.record(req, {
      action: emailChanging ? "staff.email.changed" : "staff.updated",
      entity: "Staff", entityId: staff.id,
      summary: emailChanging
        ? `Email on ${staff.name}'s account changed from ${target.email} to ${staff.email} — their sessions were ended and any reset link in flight was retired`
        : `${staff.name} (${staff.email}) updated`,
      before: { name: target.name, email: target.email, jobTitle: target.jobTitle, dept: target.dept, site: target.site, allowance: target.allowance, dob: target.dob },
      after: { name: staff.name, email: staff.email, jobTitle: staff.jobTitle, dept: staff.dept, site: staff.site, allowance: staff.allowance, dob: staff.dob },
    });
    res.json(sStaff(staff));
  } catch (e) {
    if (e.code === "P2002") return res.status(400).json({ error: "Email already in use" });
    res.status(404).json({ error: "Staff not found" });
  }
});

// PUT /api/staff/:id/access  (SUPER ADMIN) — set which admin-dashboard pages this
// person may access. Body { pages: string[] | null }.
//
// This is also how someone becomes (or stops being) an admin: granting at least one
// page makes them an ADMIN scoped to those pages; granting none demotes them back to
// a plain STAFF member with no dashboard access. Granting every page stores NULL
// (unrestricted full admin). Keeping account-role in lock-step with the grant means
// the rest of the app's "is this an admin?" logic needs no changes.
router.put("/:id/access", requireAuth, requireSuperAdmin, async (req, res) => {
  const { pages } = req.body || {};
  if (pages !== null && !Array.isArray(pages)) return res.status(400).json({ error: "pages must be an array or null" });
  if (Array.isArray(pages) && !pages.every((p) => isString(p))) return res.status(400).json({ error: "pages must be page-key strings" });

  // SUPPORT-DEPARTMENT MEMBERSHIP, alongside the page grant but NOT one of the pages.
  //
  // The "referrals" page opens the feature; this decides which queues within it a
  // person reads, and therefore who reads a student's disclosures to the wellbeing
  // team. It cannot be a page key because the department list is configuration the
  // college edits at runtime, and ADMIN_PAGES is hand-maintained in four files.
  //
  // Undefined means "not being changed", which matters because the access screen may
  // save pages without touching membership. Null or [] clears it.
  //
  // Deliberately NOT collapsed to null-means-everything the way adminPages is. Null
  // there is a convenience for the common case of a full administrator; null here
  // would mean the most senior accounts silently read every case note, which is the
  // outcome the whole confidentiality split exists to prevent. Membership is always
  // an explicit list.
  let departmentsData = {};
  if (req.body?.supportDepartments !== undefined) {
    const wanted = req.body.supportDepartments;
    if (wanted !== null && !Array.isArray(wanted)) {
      return res.status(400).json({ error: "supportDepartments must be an array or null" });
    }
    const known = new Set((await supportDepartments.all()).map((d) => d.key));
    // Filtered against the college's OWN list, so a key that names no department
    // cannot be stored and later resurrect if somebody creates that department.
    const cleanDepts = wanted == null ? [] : [...new Set(wanted.filter((k) => isString(k) && known.has(k)))];
    departmentsData = { supportDepartments: cleanDepts.length ? JSON.stringify(cleanDepts) : null };
  }
  const target = await prisma.staff.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: "Staff not found" });

  // THE SUPER ADMIN'S PAGES ARE FIXED. THEIR DEPARTMENT MEMBERSHIP IS NOT.
  //
  // Those are two different questions and this route used to refuse both, which left
  // the feature with no way in at all.
  //
  // canReadDepartment deliberately does NOT exempt a Super Admin: holding every admin
  // page is a claim about administrative authority, while being on the wellbeing team
  // is a claim about who reads a student's disclosures, and "the most senior account
  // sees every case note by default" is precisely what the confidentiality split
  // exists to prevent. supportDepartments.js says so, and says the way out is that a
  // Super Admin who needs the queue "can put themselves on the team — visibly, in a
  // column somebody can audit".
  //
  // That escape hatch did not exist. A blanket 400 here meant the one account that
  // sets a college up could hold the Referrals page, see the parent in the sidebar,
  // and find nothing under it but "Sent by me" — with no screen anywhere able to
  // change that. Reported as "I cannot see the Wellbeing and ASK tabs", which is
  // exactly what it looks like from the outside.
  //
  // So membership is editable and pages are not. A request that does not carry
  // supportDepartments is still refused, unchanged: it can only be an attempt to
  // change the pages, and that is the thing that must never happen here.
  if (target.isSuperAdmin) {
    if (req.body?.supportDepartments === undefined) {
      return res.status(400).json({ error: "The Super Admin always has full access" });
    }
    const staff = await prisma.staff.update({ where: { id: target.id }, data: departmentsData });
    audit.record(req, {
      action: "staff.access.changed", entity: "Staff", entityId: staff.id,
      // Named for what actually changed. Saying "access set to N pages" about an
      // account whose pages this route just declined to touch would put a false
      // statement in the one log read to answer who granted whom what.
      summary: `Support department membership for ${staff.name} (${staff.email}) — the Super Admin's pages are unchanged`,
      before: { supportDepartments: target.supportDepartments },
      after: { supportDepartments: staff.supportDepartments },
    });
    return res.json(sStaff(staff));
  }
  // Keep only recognised page keys, de-duplicated — junk can't grant or block anything.
  const clean = pages == null ? [] : [...new Set(pages.filter((p) => ADMIN_PAGES.includes(p)))];
  let data;
  if (clean.length === 0) {
    data = { accountRole: "STAFF", adminPages: null };           // no pages → not an admin
  } else {
    // "Unrestricted" is stored as null, and null now means EVERY PAGE EXCEPT the
    // explicit-grant-only ones (see EXPLICIT_ONLY in auth.js — `mitigations` holds
    // Article 9 health data and must never arrive by default).
    //
    // So a selection that INCLUDES an explicit-only page can never be collapsed to null:
    // doing so would silently drop the very page somebody had just deliberately ticked.
    // It is stored as an explicit list instead, and "all pages" is judged against the
    // pages null would actually grant.
    const grantsExplicitOnly = clean.some((p) => EXPLICIT_ONLY.has(p));
    const full = !grantsExplicitOnly
      && ADMIN_PAGES.filter((p) => !EXPLICIT_ONLY.has(p)).every((p) => clean.includes(p));
    data = { accountRole: "ADMIN", adminPages: full ? null : JSON.stringify(clean) };
  }
  const staff = await prisma.staff.update({ where: { id: req.params.id }, data: { ...data, ...departmentsData } });
  // The single most consequential change one colleague can make to another: it
  // decides which admin pages they can reach, and therefore what data they can see.
  audit.record(req, {
    action: "staff.access.changed", entity: "Staff", entityId: staff.id,
    summary: `Access for ${staff.name} (${staff.email}) set to ${clean.length === 0 ? "none — no longer an administrator" : clean.length + " page(s): " + clean.join(", ")}`,
    before: { accountRole: target.accountRole, adminPages: target.adminPages, supportDepartments: target.supportDepartments },
    after: { accountRole: staff.accountRole, adminPages: staff.adminPages, supportDepartments: staff.supportDepartments },
  });
  res.json(sStaff(staff));
});

// POST /api/staff/:id/invite  (admin) — re-send the activation email.
// The link expires after 7 days and emails go astray, so an admin needs a way to
// issue a fresh one without deleting and re-creating the person.
router.post("/:id/invite", requireAuth, requireAnyPage(["staff", "settings"]), async (req, res) => {
  const staff = await prisma.staff.findUnique({ where: { id: req.params.id } });
  if (!staff) return res.status(404).json({ error: "Staff not found" });
  // The last staff-mutating route without the guard. Re-sending an invite emails a
  // link that sets a password, so it belongs behind the same protection as the rest.
  const blockedInvite = guardSuperAdmin(staff, req);
  if (blockedInvite) return res.status(403).json({ error: blockedInvite });
  if (!staff.pendingActivation) return res.status(400).json({ error: "This account is already active" });
  await sendInvite(staff, { invitedBy: req.user.name });
  // Issuing a link that sets a password on somebody else's account. Pairs with the
  // staff.invite.accepted row written when the link is used.
  audit.record(req, {
    action: "staff.invited", entity: "Staff", entityId: staff.id,
    summary: `Invitation re-sent to ${staff.name} (${staff.email})`,
  });
  res.json({ ok: true, message: `Invitation re-sent to ${staff.email}` });
});

// DELETE /api/staff/:id/totp  (admin) — reset someone's two-step verification.
// The recovery path for a lost or replaced phone: clears the stored secret so the
// authenticator that used to work no longer does, and the user enrols afresh.
//
// This does NOT weaken the account permanently: where 2FA is mandatory
// (mustSetupTotp, i.e. accounts created from an app sign-up) the next sign-in is
// forced straight back into enrolment. Their password is untouched, so a reset
// alone never grants anyone access.
router.delete("/:id/totp", requireAuth, requireAnyPage(["staff", "settings"]), async (req, res) => {
  const staff = await prisma.staff.findUnique({ where: { id: req.params.id } });
  if (!staff) return res.status(404).json({ error: "Staff not found" });
  const blockedTotp = guardSuperAdmin(staff, req);
  if (blockedTotp) return res.status(403).json({ error: blockedTotp });
  if (!staff.totpEnabled && !staff.totpSecret) return res.status(400).json({ error: "Two-step verification is not set up for this account" });

  const updated = await prisma.staff.update({
    where: { id: staff.id },
    data: { totpEnabled: false, totpSecret: null },
  });

  // Tell the account holder — a silent 2FA reset is exactly the kind of change
  // someone needs to notice if it wasn't them who asked for it.
  notifyStaff(staff.id, {
    type: "info",
    message: staff.mustSetupTotp
      ? `${req.user.name} reset your two-step verification. You'll set up your authenticator app again next time you sign in.`
      : `${req.user.name} reset your two-step verification. Your account now signs in with just your password — you can turn two-step verification back on at any time.`,
    link: "more",
  });

  // One colleague removing another's second factor. The notification tells the
  // account holder; this tells whoever asks later why the protection came off.
  audit.record(req, {
    action: "staff.totp.reset", entity: "Staff", entityId: updated.id,
    summary: `Two-step verification reset for ${staff.name} (${staff.email})` + (staff.mustSetupTotp ? " — they must enrol again at next sign-in" : " — the account now signs in with a password alone"),
    before: { totpEnabled: staff.totpEnabled, hadSecret: !!staff.totpSecret },
    after: { totpEnabled: false, hadSecret: false, mustSetupTotp: staff.mustSetupTotp },
  });

  res.json(sStaff(updated));
});

// DELETE /api/staff/:id  (admin)
router.delete("/:id", requireAuth, requireAnyPage(["staff", "settings"]), async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You cannot delete your own account" });
  const existing = await prisma.staff.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Staff not found" });
  const blockedDel = guardSuperAdmin(existing, req);
  if (blockedDel) return res.status(403).json({ error: blockedDel });
  try {
    // Delete EVERYTHING tied to this person, in one transaction.
    //
    // The database cascades most of it (device tokens, password resets, notifications,
    // check-ins, leave, adjustments, timesheet entries), but two things are not linked
    // by a foreign key and used to survive:
    //
    //   • Their SignupRequest — matched only by email, which is @unique. A leftover
    //     "approved" request meant the same person could never sign up again: the
    //     sign-up endpoint saw a live request and returned its neutral "sent for
    //     approval" reply without creating anything, so the applicant waited for an
    //     approval that did not exist and no admin ever saw a request.
    //   • Documents privately assigned to them, which would otherwise linger as
    //     orphaned personal records nobody can open.
    const [, docs] = await prisma.$transaction([
      prisma.signupRequest.deleteMany({ where: { email: existing.email } }),
      prisma.document.deleteMany({ where: { scope: "personal", assignedToId: existing.id } }),
      prisma.staff.delete({ where: { id: existing.id } }),
    ]);
    // The most destructive thing one colleague can do to another's record, and it
    // takes their check-ins, leave and timesheets with it. Written after the
    // transaction commits, so a row that rolled back leaves no row claiming it did not.
    audit.record(req, {
      action: "staff.deleted", entity: "Staff", entityId: existing.id,
      summary: `${existing.name} (${existing.email}) deleted — check-ins, leave, adjustments and timesheets removed with the account, ${docs.count} personal document(s) destroyed`,
      before: { name: existing.name, email: existing.email, jobTitle: existing.jobTitle, dept: existing.dept, accountRole: existing.accountRole, site: existing.site },
      after: null,
    });
    res.json({ ok: true, documentsRemoved: docs.count });
  } catch (e) {
    res.status(400).json({ error: "Could not delete this staff member" });
  }
});

module.exports = router;
