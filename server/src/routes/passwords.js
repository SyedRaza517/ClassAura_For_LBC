// Admin password reset.
//
// Lets an administrator set a new password for a member of staff or a student
// directly, for the case the self-service flow cannot cover: someone who has lost
// access to their college email, or a student standing at the office desk.
//
// This is a powerful endpoint — it grants access to somebody else's account — so it
// carries the same protections as the rest of the staff routes and one more:
//
//   * gated on its own "passwords" page, so it can be granted or withheld on its own
//     rather than riding along with a broader permission
//   * a Super Admin's password can only be changed by a Super Admin, matching
//     PUT /staff/:id — otherwise this route would be a way around that rule
//   * tokenVersion is bumped, so every existing session for that person is dropped.
//     A reset that left the old sessions alive would be worse than useless if the
//     reason for the reset was that somebody else had the account.
//   * the target is told by in-app notification, and the admin who did it is recorded
//     in that message, so a reset can never be silent.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth, requirePage, hashPassword, blockedByRank } = require("../auth");
const { notifyStaff } = require("../notify");
const audit = require("../audit");

const MIN_LENGTH = 8;
const str = (v) => (typeof v === "string" ? v : "");

router.use(requireAuth, requirePage("passwords"));

// GET /api/passwords/people — everyone whose password can be reset, in one list, so
// the admin picks a person rather than first choosing "staff" or "student".
router.get("/people", async (_req, res) => {
  const [staff, students] = await Promise.all([
    prisma.staff.findMany({
      select: { id: true, name: true, email: true, jobTitle: true, dept: true, initials: true, colour: true, isSuperAdmin: true, pendingActivation: true },
      orderBy: { name: "asc" },
    }),
    prisma.student.findMany({
      select: { id: true, firstName: true, lastName: true, studentRef: true, email: true, initials: true, colour: true, passwordHash: true },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    }),
  ]);
  res.json([
    ...staff.map((s) => ({
      kind: "staff", id: s.id, name: s.name, email: s.email,
      detail: [s.jobTitle, s.dept].filter(Boolean).join(" · "),
      initials: s.initials, colour: s.colour,
      isSuperAdmin: s.isSuperAdmin,
      // A staff account that has never been activated has a random password; resetting
      // it here is how an admin gets someone in when the invitation email never landed.
      note: s.pendingActivation ? "Invitation not yet accepted" : null,
    })),
    ...students.map((s) => ({
      kind: "student", id: s.id, name: `${s.firstName} ${s.lastName}`.trim(), email: s.email,
      detail: s.studentRef ? `Student · ${s.studentRef}` : "Student",
      initials: s.initials, colour: s.colour,
      isSuperAdmin: false,
      // Without a password the student has never claimed their account; setting one
      // here claims it for them, which is a legitimate thing to do at the desk.
      note: s.passwordHash ? null : "Has not set a password yet",
    })),
  ]);
});

// PUT /api/passwords/:kind/:id — set a new password.
router.put("/:kind/:id", async (req, res) => {
  const { kind, id } = req.params;
  if (!["staff", "student"].includes(kind)) return res.status(400).json({ error: "Unknown account type" });

  const password = str(req.body?.password);
  const confirm = str(req.body?.confirm);
  if (password.length < MIN_LENGTH) return res.status(400).json({ error: `The password must be at least ${MIN_LENGTH} characters` });
  if (password !== confirm) return res.status(400).json({ error: "The two passwords don't match" });

  const passwordHash = await hashPassword(password);

  if (kind === "staff") {
    const target = await prisma.staff.findUnique({ where: { id }, select: { id: true, name: true, email: true, isSuperAdmin: true, accountRole: true, adminPages: true } });
    if (!target) return res.status(404).json({ error: "Staff member not found" });
    // A RANK check, not a Super-Admin-only one. Setting someone's password IS taking
    // over their account, so this was the shortest path in the whole app to a
    // privilege escalation: an admin granted only this page could reset any OTHER
    // administrator and inherit every section they held, in a single request.
    const blocked = blockedByRank(req.user, target);
    if (blocked) return res.status(403).json({ error: blocked });
    await prisma.$transaction([
      prisma.staff.update({
        where: { id: target.id },
        // mustChangePassword stays false: the admin has just told this person their new
        // password in person, and forcing an immediate change would only confuse them.
        // pendingActivation clears, because a set password IS an activated account.
        data: { passwordHash, tokenVersion: { increment: 1 }, pendingActivation: false },
      }),
      // Retire every outstanding link. This was the one password-setting path that
      // didn't, so a 7-day invitation sent to a mistyped address stayed live against
      // an account the admin had since activated by hand — and whoever held that
      // mailbox could set their own password on it.
      prisma.passwordReset.updateMany({ where: { staffId: target.id, usedAt: null }, data: { usedAt: new Date() } }),
    ]);
    notifyStaff(target.id, {
      type: "warning",
      message: `Your password was reset by ${req.user?.name || "an administrator"}. If this wasn't expected, tell the college office straight away.`,
    }).catch(() => {});
    // Setting someone else's password IS taking over their account, however
    // legitimate the reason. The notification tells the account holder; this is the
    // record that survives them leaving, and the one an investigation starts from.
    // The password itself is never passed here — only the fact that it changed.
    audit.record(req, {
      action: "staff.password.reset.byAdmin", entity: "Staff", entityId: target.id,
      summary: `Password for ${target.name} (${target.email}) set by an administrator — all their sessions ended and any outstanding invitation or reset link retired`,
      after: { sessionsEnded: true, pendingActivation: false, outstandingLinksRetired: true },
    });
    return res.json({ ok: true, name: target.name, kind });
  }

  const target = await prisma.student.findUnique({ where: { id }, select: { id: true, firstName: true, lastName: true } });
  if (!target) return res.status(404).json({ error: "Student not found" });
  await prisma.student.update({
    where: { id: target.id },
    data: { passwordHash, tokenVersion: { increment: 1 }, active: true },
  });
  audit.record(req, {
    action: "student.password.reset.byAdmin", entity: "Student", entityId: target.id,
    summary: `Password for student ${target.firstName} ${target.lastName} set by an administrator — all their sessions ended and the account re-activated`,
    after: { sessionsEnded: true, active: true },
  });
  res.json({ ok: true, name: `${target.firstName} ${target.lastName}`.trim(), kind });
});

module.exports = router;
