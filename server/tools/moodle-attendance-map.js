// READ ONLY — build the mapping from Moodle session descriptions to Staff Hub units,
// and print it for a human to check BEFORE anything is imported.
//
// A wrong mapping files attendance against the wrong unit, which is worse than
// importing nothing: it looks correct and quietly corrupts a register. So this prints
// every distinct description, what it matched, and HOW it matched, with anything
// uncertain called out.
//
// Run from server/:  node tools/moodle-attendance-map.js
require("dotenv").config();
const prisma = require("../src/db");
const { withoutAcademicScope } = require("../src/academicScope");

const URL = (process.env.MOODLE_URL || "").replace(/\/$/, "");
const TOKEN = process.env.MOODLE_TOKEN;

async function call(wsfunction, params = {}) {
  const body = new URLSearchParams({ wstoken: TOKEN, moodlewsrestformat: "json", wsfunction });
  for (const [k, v] of Object.entries(params)) body.append(k, v);
  const r = await fetch(`${URL}/webservice/rest/server.php`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  return r.json();
}

// Descriptions carry the delivery type as a suffix: "MPP (Lecture)", "TCBE - Lecture".
// Strip it so the unit code is left. Also note the type — useful later for deciding
// what a Tutorial session means.
const TYPE = /\s*[-–(]\s*(lecture|tutorial|workshop|seminar|lab|revision)\s*\)?\s*$/i;
function normalise(raw) {
  let d = String(raw || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").trim();
  let type = null;
  const m = d.match(TYPE);
  if (m) { type = m[1].toLowerCase(); d = d.replace(TYPE, "").trim(); }
  return { text: d.replace(/\s+/g, " ").trim(), type };
}

// Moodle's acronyms are inconsistent about small words: TCBE keeps "The", MoHR keeps
// "of", but MPP drops "and". So generate BOTH forms per unit and accept either.
const SMALL = /^(of|and|the|a|an|in|for|to|with|&)$/i;
const words = (name) => String(name).replace(/\(.*?\)/g, " ").split(/[\s\-/,.]+/).filter(Boolean);
function acronyms(name) {
  const w = words(name);
  const all = w.map((x) => x[0]).join("").toUpperCase();
  const big = w.filter((x) => !SMALL.test(x)).map((x) => x[0]).join("").toUpperCase();
  return new Set([all, big].filter((a) => a.length >= 2));
}

// Cheap fuzzy score for "Princples of Sustainability" vs "Principles of Sustainability".
const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, "");
function similar(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.92;
  let hits = 0;
  const pool = b.split("");
  for (const ch of a) { const i = pool.indexOf(ch); if (i >= 0) { pool.splice(i, 1); hits++; } }
  return hits / Math.max(a.length, b.length);
}

const NON_UNIT = /^(tutorial|workshop|seminar|regular class session|induction|revision|english|conflict|it tools|preparing)/i;

// AN OPERATOR CLI HAS NO CALLER AND THEREFORE NO DEPARTMENT.
//
// It is run from a shell by somebody with database access, over the whole institution by
// definition. Without this declaration the academic scope guard throws on its first query
// against Student, Course, Enrolment or AttendanceMark -- which is what happened to all
// seven tools in this directory when the guard went live, because prisma/seed.js was
// wrapped and these were forgotten.
withoutAcademicScope("moodle attendance map: an operator CLI covering every course", async () => {
  const courses = await call("core_course_get_courses");
  const acts = [];
  for (const c of courses) {
    if (!c.id) continue;
    const contents = await call("core_course_get_contents", { courseid: c.id });
    for (const sec of contents || []) for (const m of sec.modules || [])
      if (m.modname === "attendance") acts.push({ course: c.fullname, moodleCourseId: c.id, instance: m.instance ?? m.id });
  }
  const ourCourses = await prisma.course.findMany({ include: { units: true } });

  let mappedMarks = 0, unmappedMarks = 0, nonUnitMarks = 0;

  for (const a of acts) {
    const ours = ourCourses.find((c) => c.moodleCourseId === a.moodleCourseId)
      || ourCourses.find((c) => c.name.trim().toLowerCase() === a.course.trim().toLowerCase());
    if (!ours) continue;

    const sessions = await call("mod_attendance_get_sessions", { attendanceid: a.instance });
    if (!Array.isArray(sessions)) continue;

    // Tally each distinct description with its session and mark counts.
    const seen = new Map();
    for (const s of sessions) {
      const log = s.attendance_log || [];
      if (!log.length) continue;
      const { text, type } = normalise(s.description);
      const key = text || "(blank)";
      const e = seen.get(key) || { sessions: 0, marks: 0, types: new Set() };
      e.sessions++; e.marks += log.length; if (type) e.types.add(type);
      seen.set(key, e);
    }

    console.log("\n" + "=".repeat(92));
    console.log(a.course);
    console.log("=".repeat(92));
    console.log("  " + "MOODLE DESCRIPTION".padEnd(34) + "SESS".padStart(5) + "MARKS".padStart(7) + "  ->  STAFF HUB UNIT");
    console.log("  " + "-".repeat(88));

    const rows = [...seen.entries()].sort((x, y) => y[1].marks - x[1].marks);
    for (const [desc, info] of rows) {
      // 1. exact acronym match
      let unit = null, how = "";
      for (const u of ours.units) {
        if (acronyms(u.name).has(desc.toUpperCase())) { unit = u; how = "acronym"; break; }
      }
      // 2. fuzzy full-name match, for typos
      if (!unit) {
        let best = null, score = 0;
        for (const u of ours.units) { const s = similar(desc, u.name); if (s > score) { score = s; best = u; } }
        if (score >= 0.85) { unit = best; how = `name ~${Math.round(score * 100)}%`; }
      }
      // 3. several units in one session, e.g. "TCBE-MPP-MoHR"
      let multi = null;
      if (!unit && /[-/+]/.test(desc)) {
        const parts = desc.split(/[-/+]/).map((p) => p.trim()).filter(Boolean);
        const found = parts.map((p) => ours.units.find((u) => acronyms(u.name).has(p.toUpperCase()))).filter(Boolean);
        if (found.length > 1) { multi = found; how = "multi-unit"; }
      }

      const label = unit ? `${unit.code} — ${unit.name}`
        : multi ? multi.map((u) => u.code).join(" + ") + "  (one session, several units)"
        : NON_UNIT.test(desc) ? "— not a unit (tutorial/workshop/seminar)"
        : "??? UNMATCHED — needs your decision";

      if (unit) mappedMarks += info.marks;
      else if (multi) unmappedMarks += info.marks;
      else if (NON_UNIT.test(desc)) nonUnitMarks += info.marks;
      else unmappedMarks += info.marks;

      const flag = unit ? "  " : multi ? "~ " : NON_UNIT.test(desc) ? ". " : "! ";
      console.log(flag + desc.slice(0, 32).padEnd(34) + String(info.sessions).padStart(5) + String(info.marks).padStart(7)
        + "  ->  " + label + (how && unit ? `   [${how}]` : how ? `   [${how}]` : ""));
    }
  }

  console.log("\n" + "=".repeat(92));
  console.log("SUMMARY OF MARKS");
  console.log(`  map to one unit .................. ${mappedMarks}`);
  console.log(`  tutorial / workshop / seminar .... ${nonUnitMarks}   (your decision 1)`);
  console.log(`  multi-unit or unmatched ......... ${unmappedMarks}   (your decision 2)`);
  console.log("\n  legend:   (blank) mapped    ~ multi-unit    . not a unit    ! needs a decision");
  console.log("\nNothing was changed.");
  await prisma.$disconnect();
});
