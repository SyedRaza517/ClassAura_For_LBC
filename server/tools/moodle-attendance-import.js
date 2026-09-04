// Import historic attendance from Moodle into Staff Hub's per-unit registers.
//
// Moodle keeps ONE attendance register per intake, with the unit written into each
// session's description ("LM", "TCBE", "MoHR"). Staff Hub keeps one register per unit.
// So this fans a course-level register out into per-unit ones.
//
//   node tools/moodle-attendance-import.js            → dry run, writes nothing
//   node tools/moodle-attendance-import.js --apply    → actually writes
//   node tools/moodle-attendance-import.js --undo     → removes everything it imported
//
// Two rules make this safe to run, re-run and reverse:
//   * every register it creates carries moodleSessionId, and every mark it creates is
//     stamped takenBy "Moodle import" — so --undo can find them precisely and leave
//     hand-taken registers untouched.
//   * it NEVER overwrites an existing mark. Where Staff Hub already holds one, the
//     Moodle value is reported as a conflict and skipped.
require("dotenv").config();
const prisma = require("../src/db");
const { withoutAcademicScope } = require("../src/academicScope");

const URL = (process.env.MOODLE_URL || "").replace(/\/$/, "");
const TOKEN = process.env.MOODLE_TOKEN;
const APPLY = process.argv.includes("--apply");
const UNDO = process.argv.includes("--undo");
const STAMP = "Moodle import";

async function call(wsfunction, params = {}) {
  const body = new URLSearchParams({ wstoken: TOKEN, moodlewsrestformat: "json", wsfunction });
  for (const [k, v] of Object.entries(params)) body.append(k, v);
  const r = await fetch(`${URL}/webservice/rest/server.php`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  return r.json();
}

/* ------------------------------------------------------------------ undo -- */
if (UNDO) {
  (async () => {
    const sessions = await prisma.hndSession.findMany({ where: { moodleSessionId: { not: null } }, select: { id: true } });
    const strayMarks = await prisma.attendanceMark.count({
      where: { takenBy: STAMP, session: { moodleSessionId: null } },
    });
    console.log(`Imported registers to remove: ${sessions.length}`);
    console.log(`Imported marks sitting on hand-made registers: ${strayMarks}`);
    if (!APPLY) { console.log("\nDry run — nothing removed. Add --apply to actually undo."); return prisma.$disconnect(); }
    // Marks on imported registers go with the register (cascade); marks this import
    // added to a register staff created themselves must be removed on their own.
    const m = await prisma.attendanceMark.deleteMany({ where: { takenBy: STAMP, session: { moodleSessionId: null } } });
    const s = await prisma.hndSession.deleteMany({ where: { moodleSessionId: { not: null } } });
    console.log(`\nRemoved ${s.count} imported registers and ${m.count} marks added to existing ones.`);
    console.log(`Remaining: ${await prisma.hndSession.count()} registers, ${await prisma.attendanceMark.count()} marks.`);
    await prisma.$disconnect();
  })();
} else {

/* ---------------------------------------------------------------- import -- */
// Moodle's acronyms are inconsistent about small words — TCBE keeps "The", MoHR keeps
// "of", MPP drops "and" — so accept either form.
const SMALL = /^(of|and|the|a|an|in|for|to|with|&)$/i;
const wordsOf = (n) => String(n).replace(/\(.*?\)/g, " ").split(/[\s\-/,.]+/).filter(Boolean);
const acronyms = (n) => {
  const w = wordsOf(n);
  return new Set([w.map((x) => x[0]).join(""), w.filter((x) => !SMALL.test(x)).map((x) => x[0]).join("")]
    .map((a) => a.toUpperCase()).filter((a) => a.length >= 2));
};
const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, "");
function similar(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.92;
  let hits = 0; const pool = b.split("");
  for (const ch of a) { const i = pool.indexOf(ch); if (i >= 0) { pool.splice(i, 1); hits++; } }
  return hits / Math.max(a.length, b.length);
}
const TYPE = /\s*[-–(]\s*(lecture|tutorial|workshop|seminar|lab|revision)\s*\)?\s*$/i;
function normalise(raw) {
  let d = String(raw || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").trim();
  const m = d.match(TYPE);
  if (m) d = d.replace(TYPE, "").trim();
  return d.replace(/\s+/g, " ").trim();
}

const STATUS = { P: "P", L: "L", E: "E", A: "A" };
const hhmm = (ts) => new Date(ts * 1000).toISOString().slice(11, 16);
const day = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
const addMin = (t, mins) => {
  const [h, m] = t.split(":").map(Number);
  const x = h * 60 + m + mins;
  return `${String(Math.floor(x / 60) % 24).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
};

// AN OPERATOR CLI HAS NO CALLER AND THEREFORE NO DEPARTMENT.
//
// Run from a shell by somebody with database access, over the whole institution by
// definition. Without this the academic scope guard throws on the first Student query
// below -- which is what happened to every tool in this directory when the guard went
// live, because prisma/seed.js was wrapped and these were forgotten.
withoutAcademicScope("moodle attendance import: an operator CLI covering every course", async () => {
  if (!URL || !TOKEN) { console.log("MOODLE_URL / MOODLE_TOKEN not set"); process.exit(1); }
  console.log(APPLY ? "APPLYING — this writes to the database.\n" : "DRY RUN — nothing will be written. Add --apply to import.\n");

  const students = await prisma.student.findMany({ select: { id: true, moodleUserId: true } });
  const byMoodleId = new Map(students.filter((s) => s.moodleUserId != null).map((s) => [s.moodleUserId, s.id]));

  const ourCourses = await prisma.course.findMany({ include: { units: true } });
  const moodleCourses = await call("core_course_get_courses");
  const acts = [];
  for (const c of moodleCourses) {
    if (!c.id) continue;
    const contents = await call("core_course_get_contents", { courseid: c.id });
    for (const sec of contents || []) for (const m of sec.modules || [])
      if (m.modname === "attendance") acts.push({ course: c.fullname, moodleCourseId: c.id, instance: m.instance ?? m.id });
  }

  const t = { registers: 0, reused: 0, marks: 0, conflicts: 0, noStudent: 0, tutorial: 0 };

  for (const a of acts) {
    const ours = ourCourses.find((c) => c.moodleCourseId === a.moodleCourseId)
      || ourCourses.find((c) => c.name.trim().toLowerCase() === a.course.trim().toLowerCase());
    if (!ours) { console.log(`SKIPPED (no matching course): ${a.course}`); continue; }

    const sessions = await call("mod_attendance_get_sessions", { attendanceid: a.instance });
    if (!Array.isArray(sessions)) { console.log(`SKIPPED (unreadable): ${a.course}`); continue; }

    // The home for sessions that belong to the course rather than to one unit —
    // tutorials, seminars, workshops. Without it, a third of the history would be
    // dropped; putting them on a real unit would inflate that unit's attendance.
    let tutorialUnit = ours.units.find((u) => u.code === "TUTORIAL");
    const needTutorial = sessions.some((s) => (s.attendance_log || []).length
      && !ours.units.some((u) => acronyms(u.name).has(normalise(s.description).toUpperCase())));

    if (!tutorialUnit && needTutorial) {
      if (APPLY) {
        tutorialUnit = await prisma.unit.create({
          data: { code: "TUTORIAL", name: "Tutorial / Seminar", unitNumber: "", courseId: ours.id, tutor: "" },
        });
      } else tutorialUnit = { id: "(would be created)", code: "TUTORIAL", name: "Tutorial / Seminar" };
      console.log(`  + "Tutorial / Seminar" unit for ${ours.name}`);
    }

    console.log(`\n${ours.name}`);
    for (const s of sessions) {
      const log = s.attendance_log || [];
      if (!log.length) continue;

      const desc = normalise(s.description);
      const unit = ours.units.find((u) => acronyms(u.name).has(desc.toUpperCase()))
        || ours.units.find((u) => similar(desc, u.name) >= 0.85)
        || tutorialUnit;
      if (!unit) continue;
      if (unit === tutorialUnit) t.tutorial++;

      const date = day(s.sessdate);
      const start = hhmm(s.sessdate);
      const end = addMin(start, Math.max(30, Math.round((s.duration || 3600) / 60)));

      // statusid -> P/L/E/A comes from the session's own status set, so a course that
      // renumbered its statuses still maps correctly.
      const statusById = new Map((s.statuses || []).map((st) => [String(st.id), STATUS[String(st.acronym).toUpperCase()] || null]));

      let session = await prisma.hndSession.findFirst({
        where: { OR: [{ moodleSessionId: Number(s.id) }, { unitId: unit.id, date, startTime: start }] },
      });
      const reused = !!session;
      if (reused) t.reused++;
      else if (APPLY) {
        session = await prisma.hndSession.create({
          data: {
            unitId: unit.id, date, startTime: start, endTime: end,
            description: desc || "Imported from Moodle", kind: unit === tutorialUnit ? "Seminar" : "Teaching",
            moodleSessionId: Number(s.id),
          },
        });
        t.registers++;
      } else { t.registers++; session = null; }

      // Collect first, write once. Inserting ~9,700 marks one at a time against a
      // remote database is thousands of round trips; createMany makes it one per
      // register. skipDuplicates covers the unique(sessionId, studentId) constraint.
      const rows = [];
      for (const l of log) {
        const studentId = byMoodleId.get(Number(l.studentid));
        if (!studentId) { t.noStudent++; continue; }
        const status = statusById.get(String(l.statusid));
        if (!status) continue;
        rows.push({ studentId, status, remark: String(l.remarks || "").slice(0, 500) });
      }

      if (session && reused) {
        // Only a register that already existed can hold a mark worth protecting, so
        // this is the one case where each mark is checked before being written.
        const have = await prisma.attendanceMark.findMany({
          where: { sessionId: session.id }, select: { studentId: true, status: true },
        });
        const byStudent = new Map(have.map((h) => [h.studentId, h.status]));
        const fresh = [];
        for (const r of rows) {
          const existing = byStudent.get(r.studentId);
          if (existing === undefined) fresh.push(r);
          else if (existing !== r.status) t.conflicts++;   // never overwritten
        }
        if (APPLY && fresh.length) {
          await prisma.attendanceMark.createMany({
            data: fresh.map((r) => ({ ...r, sessionId: session.id, takenBy: STAMP })),
            skipDuplicates: true,
          });
        }
        t.marks += fresh.length;
      } else {
        if (APPLY && session && rows.length) {
          await prisma.attendanceMark.createMany({
            data: rows.map((r) => ({ ...r, sessionId: session.id, takenBy: STAMP })),
            skipDuplicates: true,
          });
        }
        t.marks += rows.length;
      }
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(APPLY ? "IMPORTED" : "WOULD IMPORT");
  console.log(`  registers created ........ ${t.registers}`);
  console.log(`  registers already there .. ${t.reused}`);
  console.log(`  attendance marks ......... ${t.marks}`);
  console.log(`  of those, tutorial/seminar sessions: ${t.tutorial} registers`);
  console.log(`  skipped, student not linked ........ ${t.noStudent}`);
  console.log(`  skipped, Staff Hub already has a DIFFERENT mark: ${t.conflicts}`);
  if (!APPLY) console.log("\nNothing was written. Re-run with --apply to import.");
  else console.log(`\nTotals now: ${await prisma.hndSession.count()} registers, ${await prisma.attendanceMark.count()} marks.`);
  console.log("\nTo reverse:  node tools/moodle-attendance-import.js --undo --apply");
  await prisma.$disconnect();
});
}
