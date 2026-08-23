// Seeds the database with an admin + sample staff and demo data.
// Run with: npm run seed
const bcrypt = require("bcryptjs");
// The EXTENDED client, deliberately — not a bare PrismaClient. Every create below
// then has its tenantId stamped on automatically by the isolation extension, so the
// seed did not need rewriting row by row when tenancy landed.
const prisma = require("../src/db");
const { runInTenant, crossTenant } = require("../src/db");

// Which institution this demo data belongs to. Defaults to the tenant the tenancy
// migration adopted every pre-existing row into.
const SEED_TENANT_SLUG = process.env.SEED_TENANT_SLUG || "default";

const hash = (pw) => bcrypt.hashSync(pw, 10);
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const yr = new Date().getFullYear();
// Demo passwords come from the environment. A literal here is a committed credential,
// and a seeded account that reaches a real database is a real way in — so refuse to
// run rather than ship one. Set SEED_PASSWORD before seeding a demo dataset.
const DEFAULT_PW = process.env.SEED_PASSWORD || "";
if (!DEFAULT_PW || DEFAULT_PW.length < 12) {
  console.error("\n✗ Set SEED_PASSWORD (12+ characters) before seeding. It is never hard-coded here.\n");
  process.exit(1);
}
const daysBetween = (a, b) => { const d1 = new Date(a + "T00:00:00Z"), d2 = new Date(b + "T00:00:00Z"); return Math.max(1, Math.round((d2 - d1) / 86400000) + 1); };

/* ---------- HND attendance registers ---------- */
const HND_UNITS = [
  { id: "m-obm",  code: "OBM",  name: "Organisational Behaviour Management",        tutor: "Aisha Rahman" },
  { id: "m-ws",   code: "WS",   name: "Professional Skills Workshop",               tutor: "Daniel Okoye" },
  { id: "m-bs",   code: "BS",   name: "Business Strategy",                          tutor: "James Whitfield" },
  { id: "m-dito", code: "DITO", name: "Digital Innovation & Technology in Organisations", tutor: "Priya Nair" },
];

// Student numbers double as the local part of the college email address.
const HND_STUDENTS = [
  { ref: "100121", firstName: "Mubarak",     lastName: "Ali" },
  { ref: "100122", firstName: "Saritha",     lastName: "Ananthan" },
  { ref: "100126", firstName: "Jonathan",    lastName: "Ani Ani" },
  { ref: "100133", firstName: "Raluca-Iulia", lastName: "Anton" },
  { ref: "100110", firstName: "Sentheeban",  lastName: "Ariyendiran" },
  { ref: "100123", firstName: "Nathiya",     lastName: "Arulkumaran" },
  { ref: "100118", firstName: "Adaeze",      lastName: "Balogun" },
  { ref: "100129", firstName: "Marek",       lastName: "Kowalski" },
  { ref: "100135", firstName: "Yasmin",      lastName: "Haddad" },
  { ref: "100140", firstName: "Tobias",      lastName: "Lindqvist" },
];

const PALETTE = ["#1a3a8f", "#9e1b32", "#0d7a5f", "#b45309", "#6d28d9", "#0e7490", "#be123c"];
const colourFor = (seed) => PALETTE[Math.abs(String(seed).split("").reduce((a, c) => a + c.charCodeAt(0), 0)) % PALETTE.length];
const iso = (offsetDays) => new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10);

// Deterministic 0..1 from a string — keeps the demo data identical on every
// reseed (no Math.random), so screenshots and percentages stay stable.
function seededUnit(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
}
// Weighted pick: mostly Present, some Late/Excused, a few Absent.
function markFor(studentRef, sessionId) {
  const u = seededUnit(studentRef + "|" + sessionId);
  if (u < 0.72) return { status: "P", remark: "" };
  if (u < 0.82) return { status: "L", remark: u < 0.77 ? "Arrived 15 minutes late" : "Late — travel delay" };
  if (u < 0.90) return { status: "E", remark: u < 0.86 ? "Medical appointment — evidence provided" : "Authorised absence" };
  return { status: "A", remark: u < 0.95 ? "" : "No contact from student" };
}

const STAFF = [
  { id: "admin", name: "HR Administrator", jobTitle: "HR & Operations", dept: "Administration", email: "admin@edtech.co.uk", accountRole: "ADMIN", allowance: 30, initials: "HR", colour: "#0f172a" },
  { id: "s1", name: "James Whitfield", jobTitle: "Mathematics Teacher", dept: "Sixth Form", email: "j.whitfield@edtech.co.uk", accountRole: "STAFF", allowance: 28, initials: "JW", colour: "#1a3a8f" },
  { id: "s2", name: "Aisha Rahman", jobTitle: "Head of Science", dept: "Sixth Form", email: "a.rahman@edtech.co.uk", accountRole: "STAFF", allowance: 30, initials: "AR", colour: "#9e1b32" },
  { id: "s3", name: "Daniel Okoye", jobTitle: "English Tutor", dept: "Tuition Centre", email: "d.okoye@edtech.co.uk", accountRole: "STAFF", allowance: 25, initials: "DO", colour: "#0d7a5f" },
  { id: "s4", name: "Sofia Marin", jobTitle: "Exams Officer", dept: "Exam Centre", email: "s.marin@edtech.co.uk", accountRole: "STAFF", allowance: 26, initials: "SM", colour: "#b45309" },
  { id: "s5", name: "Priya Nair", jobTitle: "Admissions Lead", dept: "Administration", email: "p.nair@edtech.co.uk", accountRole: "STAFF", allowance: 28, initials: "PN", colour: "#6d28d9" },
];

async function main() {
  console.log("Clearing existing data…");
  await prisma.adjustment.deleteMany();
  await prisma.document.deleteMany();
  await prisma.leave.deleteMany();
  await prisma.checkIn.deleteMany();
  await prisma.staff.deleteMany();
  await prisma.attendanceMark.deleteMany();
  await prisma.hndSession.deleteMany();
  await prisma.enrolment.deleteMany();
  await prisma.student.deleteMany();
  await prisma.unit.deleteMany();

  console.log("Seeding staff…");
  for (const s of STAFF) {
    await prisma.staff.create({ data: { ...s, passwordHash: hash(DEFAULT_PW) } });
  }

  console.log("Seeding check-ins…");
  await prisma.checkIn.createMany({ data: [
    { staffId: "s2", date: today, timeIn: "08:12" },
    { staffId: "s5", date: today, timeIn: "08:31" },
    { staffId: "s3", date: today, timeIn: "08:45" },
    { staffId: "s1", date: yesterday, timeIn: "08:20", timeOut: "16:40", summary: "Marked Y12 mock papers, parent call at 3pm." },
    { staffId: "s2", date: yesterday, timeIn: "08:05", timeOut: "17:10", summary: "Department meeting + lab prep for practicals." },
  ]});

  console.log("Seeding leave…");
  await prisma.leave.createMany({ data: [
    { staffId: "s2", type: "annual", start: `${yr}-06-10`, end: `${yr}-06-13`, reason: "Family holiday", status: "approved", requestedAt: `${yr}-05-12`, decidedBy: "HR Administrator", decidedAt: `${yr}-05-13`, note: "Enjoy!" },
    { staffId: "s3", type: "training", start: `${yr}-06-05`, end: `${yr}-06-05`, reason: "Safeguarding CPD course", status: "pending", requestedAt: `${yr}-05-26` },
    { staffId: "s4", type: "sick", start: `${yr}-05-20`, end: `${yr}-05-21`, reason: "Flu", status: "approved", requestedAt: `${yr}-05-20`, decidedBy: "HR Administrator", decidedAt: `${yr}-05-20`, note: "Get well soon" },
    { staffId: "s1", type: "personal", start: `${yr}-06-18`, end: `${yr}-06-18`, reason: "Appointment", status: "pending", requestedAt: `${yr}-05-28` },
  ].map((l) => ({ ...l, days: daysBetween(l.start, l.end) }))});

  console.log("Seeding documents…");
  await prisma.document.createMany({ data: [
    { name: "Staff Handbook 2025-26", type: "Policy", date: `${yr}-01-15`, scope: "all" },
    { name: "Safeguarding Policy", type: "Policy", date: `${yr}-02-01`, scope: "all" },
    { name: "Payslip — Latest", type: "Payroll", date: today, scope: "personal" },
    { name: "Term Dates 2025-26", type: "Calendar", date: `${yr}-01-08`, scope: "all" },
    { name: "Annual Appraisal Form", type: "HR", date: `${yr}-03-20`, scope: "personal" },
  ]});

  console.log("Seeding HND modules…");
  for (const m of HND_UNITS) await prisma.unit.create({ data: m });

  console.log("Seeding HND students…");
  for (const s of HND_STUDENTS) {
    await prisma.student.create({ data: {
      id: `st-${s.ref}`,
      firstName: s.firstName, lastName: s.lastName, studentRef: s.ref,
      email: `${s.ref}@edtech.co.uk`,
      initials: `${s.firstName[0]}${s.lastName[0]}`.toUpperCase(),
      colour: colourFor(s.ref + s.lastName),
    }});
  }

  console.log("Seeding enrolments…");
  // Everyone takes the two core modules; the options are split so the register
  // sizes differ and the "overall across modules" figure has something to blend.
  const enrolMap = {
    "m-obm":  HND_STUDENTS,
    "m-ws":   HND_STUDENTS,
    "m-bs":   HND_STUDENTS.slice(0, 7),
    "m-dito": HND_STUDENTS.slice(3),
  };
  for (const [unitId, list] of Object.entries(enrolMap)) {
    await prisma.enrolment.createMany({ data: list.map((s) => ({ studentId: `st-${s.ref}`, unitId })) });
  }

  console.log("Seeding sessions + registers…");
  // Weekly timetable: each module runs on a fixed weekday at a fixed time.
  const TIMETABLE = {
    "m-obm":  { dow: 1, start: "10:00", end: "13:00", desc: "OBM" },
    "m-ws":   { dow: 1, start: "14:00", end: "17:00", desc: "Workshop" },
    "m-bs":   { dow: 4, start: "18:00", end: "21:00", desc: "BS" },
    "m-dito": { dow: 5, start: "18:00", end: "21:00", desc: "DITO" },
  };
  // Most recent date on or before today that falls on the given weekday.
  const lastWeekdayOffset = (dow) => (new Date().getDay() - dow + 7) % 7;

  for (const [unitId, t] of Object.entries(TIMETABLE)) {
    const base = lastWeekdayOffset(t.dow);
    // Six taught weeks behind us, two scheduled ahead (registers not yet taken).
    const offsets = [base + 35, base + 28, base + 21, base + 14, base + 7, base, base - 7, base - 14];
    for (const off of offsets) {
      const id = `ses-${unitId}-${off}`;
      const date = iso(off);
      await prisma.hndSession.create({ data: {
        id, unitId, date, startTime: t.start, endTime: t.end,
        description: t.desc, audience: "All students",
      }});

      // Only past/today sessions have a register taken. Today's Workshop is left
      // deliberately blank so there's an untaken register to try out.
      if (off < 0) continue;
      if (unitId === "m-ws" && off === base) continue;

      const cohort = enrolMap[unitId];
      await prisma.attendanceMark.createMany({ data: cohort.map((s) => {
        const m = markFor(s.ref, id);
        return { sessionId: id, studentId: `st-${s.ref}`, status: m.status, remark: m.remark, takenBy: "HR Administrator" };
      })});
    }
  }

  console.log("\nSeed complete. All demo accounts use the SEED_PASSWORD you supplied (not printed).");
  console.log("  ADMIN:  admin@edtech.co.uk");
  console.log("  STAFF:  j.whitfield@edtech.co.uk, a.rahman@edtech.co.uk, d.okoye@edtech.co.uk, s.marin@edtech.co.uk, p.nair@edtech.co.uk");
}

// Ensure the tenant exists, then run the whole seed inside it.
(async () => {
  const tenant = await crossTenant(() => prisma.tenant.upsert({
    where: { slug: SEED_TENANT_SLUG },
    create: { slug: SEED_TENANT_SLUG, name: "Default Institution" },
    update: {},
  }));
  console.log("Seeding into tenant: " + tenant.slug + " (" + tenant.id + ")");
  await runInTenant(tenant.id, () => main());
})().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
