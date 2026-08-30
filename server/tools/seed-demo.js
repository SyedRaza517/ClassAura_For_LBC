// Demo seed for the renamed (Course / Unit) schema.
// Creates: a super-admin + staff, 3 Courses, 12 Units, 6 Cohorts, 500 Students,
// enrolments, ~9 months of Sessions, Attendance marks, Assessments + Grades, and
// some staff leave / check-ins — so every tab and both dashboards have data.
//
//   cd server
//   npx prisma generate        # regenerate the client for the new Course/Unit models
//   node seed-demo.js
//
// Login afterwards:  raza@edtech.co.uk / 123456789  (super admin)
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const crypto = require("crypto");
const { hashPassword } = require("../src/auth");
// THIS SCRIPT PERFORMS FOURTEEN UNFILTERED deleteMany() CALLS, and nothing narrows
// them any more. While the product was multi-tenant the isolation extension scoped
// every one of them to a single institution, which meant a demo seed pointed at the
// wrong database wiped one college rather than all of them. With one deployment per
// college that scoping is gone — correctly, there is only one institution here — but
// so is the accident-limiter, so the same guard prisma/seed.js uses stands in its
// place: an allowlist of databases that are obviously disposable, with a typed
// confirmation as the only way past. See prisma/assertDisposable.js.
require("../prisma/assertDisposable").assertDisposable(
  "tools/seed-demo.js DELETES this institution's students, courses, registers, attendance, leave and check-ins before reseeding"
);
const prisma = require("../src/db");

const uid = () => crypto.randomUUID();
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isoOf = (d) => d.toISOString().slice(0, 10);
const addDays = (base, n) => { const x = new Date(base); x.setUTCDate(x.getUTCDate() + n); return x; };
async function insertMany(model, rows, chunk = 5000) {
  for (let i = 0; i < rows.length; i += chunk) {
    await model.createMany({ data: rows.slice(i, i + chunk), skipDuplicates: true });
  }
}

const COLOURS = ["#1a3a8f", "#9e1b32", "#0d7a5f", "#d97706", "#6d28d9", "#0891b2", "#be123c", "#4d7c0f", "#b45309", "#0369a1"];
const FIRST = ["James", "Aisha", "Daniel", "Sofia", "Priya", "Liam", "Emma", "Noah", "Olivia", "Muhammad", "Amelia", "Harry", "Isla", "Chloe", "Zara", "Omar", "Grace", "Leo", "Maya", "Ethan", "Fatima", "Jack", "Ava", "Ibrahim", "Ruby", "Oscar", "Lily", "Yusuf", "Freya", "Adam"];
const LAST = ["Whitfield", "Rahman", "Okoye", "Marin", "Nair", "Khan", "Patel", "Smith", "Jones", "Ahmed", "Brown", "Wilson", "Evans", "Roberts", "Hughes", "Ali", "Begum", "Clarke", "Cole", "Dixon", "Ellis", "Ford", "Green", "Hall", "Iqbal", "Jenkins"];

async function main() {
  console.log("Clearing old data…");
  await prisma.attendanceMark.deleteMany();
  await prisma.assessmentGrade.deleteMany();
  await prisma.assessment.deleteMany();
  await prisma.hndSession.deleteMany();
  await prisma.enrolment.deleteMany();
  await prisma.interaction.deleteMany().catch(() => {});
  await prisma.student.deleteMany();
  await prisma.term.deleteMany();
  await prisma.unit.deleteMany();
  await prisma.cohort.deleteMany();
  await prisma.course.deleteMany();
  await prisma.leave.deleteMany();
  await prisma.checkIn.deleteMany();
  await prisma.semester.deleteMany();

  // ---- Staff (admin + teachers) ----
  let pw = hashPassword("123456789");
  if (pw && typeof pw.then === "function") pw = await pw;
  const staffDefs = [
    { name: "Raza", jobTitle: "Principal", dept: "Leadership", email: "raza@edtech.co.uk", accountRole: "ADMIN", isSuperAdmin: true, adminPages: null, initials: "R", colour: "#6d28d9" },
    { name: "HR Administrator", jobTitle: "HR & Operations", dept: "Administration", email: "admin@edtech.co.uk", accountRole: "ADMIN", isSuperAdmin: false, adminPages: null, initials: "HR", colour: "#0f172a" },
    { name: "James Whitfield", jobTitle: "Business Lecturer", dept: "HND", email: "j.whitfield@edtech.co.uk", accountRole: "STAFF", initials: "JW", colour: "#1a3a8f" },
    { name: "Aisha Rahman", jobTitle: "Care Lecturer", dept: "HND", email: "a.rahman@edtech.co.uk", accountRole: "STAFF", initials: "AR", colour: "#9e1b32" },
    { name: "Daniel Okoye", jobTitle: "Digital Lecturer", dept: "HND", email: "d.okoye@edtech.co.uk", accountRole: "STAFF", initials: "DO", colour: "#0d7a5f" },
    { name: "Sofia Marin", jobTitle: "Exams Officer", dept: "Exams", email: "s.marin@edtech.co.uk", accountRole: "STAFF", initials: "SM", colour: "#b45309" },
  ];
  const staff = [];
  for (const s of staffDefs) {
    const row = await prisma.staff.create({ data: { ...s, passwordHash: pw, allowance: 28, pendingActivation: false } });
    staff.push(row);
  }
  const tutors = staff.filter((s) => s.dept === "HND");
  console.log(`Staff: ${staff.length}`);

  // ---- Courses (formerly Programmes) ----
  const courseDefs = [
    { name: "HND Business", colour: "#1a3a8f", prefix: "BUS", units: [["BUS-MAN", "Business Management"], ["BUS-MKT", "Marketing Essentials"], ["BUS-FIN", "Managing Finance"], ["BUS-OPS", "Operations Management"]] },
    { name: "HND Health & Social Care", colour: "#0d7a5f", prefix: "HSC", units: [["HSC-PRAC", "Care Practice"], ["HSC-SAFE", "Safeguarding"], ["HSC-DEV", "Human Development"], ["HSC-COMM", "Communication in Care"]] },
    { name: "HND Digital Technologies", colour: "#0891b2", prefix: "DT", units: [["DT-PROG", "Programming"], ["DT-NET", "Networking"], ["DT-DATA", "Data Analytics"], ["DT-SEC", "Cyber Security"]] },
  ];
  const today = new Date();
  const START = addDays(today, -270); // ~9 months of history

  const courses = [], cohorts = [], units = [];
  for (const c of courseDefs) {
    const courseId = uid();
    courses.push({ id: courseId, name: c.name, colour: c.colour });
    // two intakes per course
    for (const label of ["SEP 2025", "JAN 2026"]) {
      cohorts.push({ id: uid(), name: label, courseId, startDate: isoOf(START), _course: courseId });
    }
    for (const [code, name] of c.units) {
      units.push({ id: uid(), code, name, tutor: pick(tutors).name, courseId });
    }
  }
  await insertMany(prisma.course, courses.map(({ id, name, colour }) => ({ id, name, colour })));
  await insertMany(prisma.cohort, cohorts.map(({ id, name, courseId, startDate }) => ({ id, name, courseId, startDate })));
  await insertMany(prisma.unit, units.map(({ id, code, name, tutor, courseId }) => ({ id, code, name, tutor, courseId })));
  console.log(`Courses: ${courses.length} · Cohorts: ${cohorts.length} · Units: ${units.length}`);

  const unitsByCourse = {};
  for (const u of units) (unitsByCourse[u.courseId] ||= []).push(u);

  // ---- Semesters covering the history (so the registers page can scope) ----
  await insertMany(prisma.semester, [
    { name: "Autumn 2025", start: isoOf(START), end: isoOf(addDays(START, 120)) },
    { name: "Spring 2026", start: isoOf(addDays(START, 121)), end: isoOf(addDays(today, 30)) },
  ]);

  // ---- Students (500) ----
  const students = [], enrolments = [];
  const ability = new Map();   // studentId -> academic ability 0..1
  const reliability = new Map(); // studentId -> attendance rate 0..1
  for (let i = 0; i < 500; i++) {
    const id = uid();
    const fn = pick(FIRST), ln = pick(LAST);
    const ref = String(100001 + i);
    const cohort = pick(cohorts);
    students.push({
      id, firstName: fn, lastName: ln, studentRef: ref,
      email: `${ref}@student.edtech.co.uk`, initials: (fn[0] + ln[0]).toUpperCase(),
      colour: pick(COLOURS), active: Math.random() > 0.06, cohortId: cohort.id,
    });
    ability.set(id, clamp(0.32 + Math.random() * 0.6, 0.1, 0.98));
    reliability.set(id, clamp(0.35 + Math.random() * 0.6, 0.15, 0.99));
    for (const u of unitsByCourse[cohort._course]) enrolments.push({ id: uid(), studentId: id, unitId: u.id });
  }
  await insertMany(prisma.student, students);
  await insertMany(prisma.enrolment, enrolments);
  console.log(`Students: ${students.length} · Enrolments: ${enrolments.length}`);

  // enrolled students per unit
  const studentsByUnit = {};
  for (const e of enrolments) (studentsByUnit[e.unitId] ||= []).push(e.studentId);

  // ---- Sessions (~24 per unit over 9 months) + Attendance marks ----
  const sessions = [], marks = [];
  const SESSIONS_PER_UNIT = 24;
  const stepDays = Math.floor(270 / SESSIONS_PER_UNIT); // ~11 days apart
  for (const u of units) {
    for (let k = 0; k < SESSIONS_PER_UNIT; k++) {
      const d = addDays(START, k * stepDays + rnd(3));
      if (d > today) continue; // don't mark future sessions
      const sid = uid();
      sessions.push({ id: sid, unitId: u.id, date: isoOf(d), startTime: "10:00", endTime: "13:00" });
      for (const stId of (studentsByUnit[u.id] || [])) {
        const rate = reliability.get(stId);
        let status;
        const r = Math.random();
        if (r < rate) status = "P";
        else { const r2 = Math.random(); status = r2 < 0.4 ? "L" : r2 < 0.62 ? "E" : "A"; }
        marks.push({ id: uid(), sessionId: sid, studentId: stId, status });
      }
    }
  }
  await insertMany(prisma.hndSession, sessions);
  await insertMany(prisma.attendanceMark, marks, 8000);
  console.log(`Sessions: ${sessions.length} · Attendance marks: ${marks.length}`);

  // ---- Assessments (2 per unit) + Grades ----
  const assessments = [], grades = [];
  for (const u of units) {
    for (const [title, type] of [["Assignment 1", "Assignment"], ["Final Exam", "Exam"]]) {
      const aid = uid();
      assessments.push({ id: aid, unitId: u.id, title, type, maxMarks: 100, weight: 50 });
      for (const stId of (studentsByUnit[u.id] || [])) {
        const mark = clamp(Math.round(ability.get(stId) * 100 + (Math.random() * 30 - 15)), 0, 100);
        grades.push({ id: uid(), assessmentId: aid, studentId: stId, marks: mark });
      }
    }
  }
  await insertMany(prisma.assessment, assessments);
  await insertMany(prisma.assessmentGrade, grades, 8000);
  console.log(`Assessments: ${assessments.length} · Grades: ${grades.length}`);

  // ---- Staff leave + check-ins (so those tabs have data) ----
  const leaveRows = [], checkins = [];
  const types = ["annual", "sick", "personal", "training"];
  for (const s of staff) {
    for (let k = 0; k < 2 + rnd(2); k++) {
      const start = addDays(today, -rnd(120) - 1);
      const end = addDays(start, rnd(3));
      leaveRows.push({ id: uid(), staffId: s.id, type: pick(types), start: isoOf(start), end: isoOf(end), days: 1 + rnd(3), reason: "—", status: pick(["approved", "approved", "pending"]), requestedAt: isoOf(start) });
    }
    for (let k = 0; k < 5; k++) {
      const d = addDays(today, -k);
      checkins.push({ id: uid(), staffId: s.id, date: isoOf(d), timeIn: "08:5" + rnd(9), timeOut: "17:0" + rnd(9), summary: "On site" });
    }
  }
  await insertMany(prisma.leave, leaveRows);
  await insertMany(prisma.checkIn, checkins);
  console.log(`Leave: ${leaveRows.length} · Check-ins: ${checkins.length}`);

  console.log("\n✅  Seed complete. Login: raza@edtech.co.uk / 123456789 (super admin)\n");
}

// One deployment, one institution: there is no slug to look up and nothing to run
// "inside". The database named by DATABASE_URL is the institution.
(async () => {
  console.log("Seeding demo data (this DELETES the existing data in this database)");
  await main();
})().catch((e) => { console.error("Seed failed:", e); process.exit(1); }).finally(() => prisma.$disconnect());
