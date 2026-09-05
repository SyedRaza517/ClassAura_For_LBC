// Public application-form submit — behind a shareable link, NO auth. An applicant is
// not a logged-in user, so this creates an Admission row from a self-submitted form
// exactly like the admin create, but open to anyone with the link. Only the known
// writable fields are copied (via pick), so nothing extra can be smuggled into Prisma.
const router = require("express").Router();
const prisma = require("../db");
const { withoutAcademicScope } = require("../academicScope");
const { pick, str } = require("../admissionFields");

// GET /api/admission-apply/courses — the course list for the application form's course
// dropdown. PUBLIC (the form is open) and only exposes course names, nothing sensitive.
// Sourced from the admissions-managed AdmissionCourse list (NOT the Moodle Course table),
// so admissions decides what an applicant can apply for. Only active courses are shown.
router.get("/courses", async (_req, res) => {
  try {
    const rows = await prisma.admissionCourse.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { name: true },
    });
    res.json(rows.map((r) => r.name));
  } catch (_) { res.json([]); }
});

// GET /api/admission-apply/intakes — the intake list ("September 2026", …) for the
// application form's intake dropdown. PUBLIC; only active intakes, admin-ordered.
router.get("/intakes", async (_req, res) => {
  try {
    const rows = await prisma.admissionIntake.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { label: true },
    });
    res.json(rows.map((r) => r.label));
  } catch (_) { res.json([]); }
});

// POST /api/admission-apply — create an application from the public form.
router.post("/", async (req, res) => {
  // req.body is undefined for a non-JSON POST — guard so a malformed request 400s cleanly
  // instead of throwing a TypeError (500) on the public endpoint.
  const b = req.body || {};
  // Light anti-spam: a hidden honeypot field only bots fill in. Pretend success so the
  // bot moves on, but create nothing.
  if (str(b._hp)) return res.status(200).json({ ok: true });

  const data = pick(b);
  if (!data.firstName && !data.surname) {
    return res.status(400).json({ error: "Please enter at least your first name or surname." });
  }

  // One email = one account. If this email already belongs to a login (staff, student, or
  // an applicant portal account), reject it so we don't create a duplicate — tell them to
  // use a different email or sign in to the Student Portal instead.
  if (data.email) {
    const emailLc = String(data.email).toLowerCase();
    // FAILS CLOSED, like the identical check in routes/applicant.js. Each of these three
    // carried `.catch(() => null)`, which answered "no clash" whenever the database did
    // not answer at all — on a PUBLIC, unauthenticated endpoint that then writes a row
    // holding criminal-conviction, medical and ethnicity declarations. A transient error
    // was enough to attach an application to an email that already belongs to a staff or
    // student login, and login is shared across all three kinds.
    //
    // The catches predate de-tenanting, when an unauthenticated query threw inside the
    // scoping extension and swallowing it kept the form working. That extension is gone;
    // `withoutAcademicScope` covers the one exemption still needed. An error now reaches
    // wrapAsync and the applicant sees a 500, which is true, instead of a duplicate
    // identity, which is not.
    const [staff, student, appl] = await Promise.all([
      prisma.staff.findFirst({ where: { email: emailLc } }),
      // WRAPPED, because this runs UNAUTHENTICATED. A person applying has no account, let
      // alone a department, so there is no scope -- and the duplicate check must see the
      // WHOLE college anyway: a student already enrolled is a clash whichever department
      // they are in.
      withoutAcademicScope(
        "applicant email check: unauthenticated, and a clash is a clash in any department",
        () => prisma.student.findFirst({ where: { email: emailLc } }),
      ),
      prisma.admission.findFirst({ where: { email: { equals: emailLc, mode: "insensitive" }, passwordHash: { not: null } } }),
    ]);
    if (staff || student || appl) {
      return res.status(409).json({ error: "This email is already in use. Please use a different email, or sign in to the Student Portal to continue your application." });
    }
    data.email = emailLc;
  }

  const row = await prisma.admission.create({ data: { ...data, source: "apply" } });
  // A public caller needs nothing back beyond confirmation and the new id.
  res.status(201).json({ ok: true, id: row.id });
});

module.exports = router;
