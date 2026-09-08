// Ten computing modules, on the Computing school's course.
//
// Written to fill a school that had none, so the planner has something real to pick
// from. These are NOT DEMO-prefixed, because they are meant to sit in the college's own
// Computing school and be used — but --remove deletes exactly the ten codes below on
// exactly the course they were put on, so they are still reversible without a hand-
// written delete.
//
// Codes are unique WITHIN a course, not globally, so the same ten could be added to a
// second course later without collision. That is enforced by @@unique([courseId, code])
// rather than trusted here: this skips a code that already exists rather than upserting
// it, so re-running never overwrites a module somebody has since edited.
//
//   node tools/seed-computing-modules.js                  # dry run
//   node tools/seed-computing-modules.js --apply
//   node tools/seed-computing-modules.js --course "MSc. AI" --apply
//   node tools/seed-computing-modules.js --remove --apply
//
// ALWAYS pass DATABASE_URL explicitly. server/.env points at a live database.
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const REMOVE = process.argv.includes("--remove");
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
};

const MODULES = [
  ["CMP701", "Machine Learning Foundations"],
  ["CMP702", "Deep Learning and Neural Networks"],
  ["CMP703", "Natural Language Processing"],
  ["CMP704", "Computer Vision"],
  ["CMP705", "Data Engineering and Big Data"],
  ["CMP706", "Cloud and Distributed Systems"],
  ["CMP707", "AI Ethics, Law and Governance"],
  ["CMP708", "Reinforcement Learning"],
  ["CMP709", "Research Methods for Computing"],
  ["CMP710", "MSc Project and Dissertation"],
];

(async () => {
  const url = process.env.DATABASE_URL || "";
  if (!url) { console.error("FAILED: DATABASE_URL is not set. Pass it explicitly."); process.exit(1); }
  console.log(`Database: ${url.replace(/^.*@/, "").split("/")[0]}`);
  console.log(APPLY ? "MODE: APPLY\n" : "MODE: dry run. Nothing will be written. Add --apply.\n");

  try {
    // A REAL COMPUTING SCHOOL BEATS A DEMO ONE, and the sort is what decides it rather
    // than the order the database happens to return rows in. Staging and production have
    // drifted -- production carries a hand-made "Computing", staging only the seeded
    // "DEMO School of Computing" -- and a tool that silently picked whichever came first
    // would put a college's modules in the demo school on one of them.
    const schools = await prisma.academicDepartment.findMany({
      where: { name: { contains: "Computing", mode: "insensitive" } },
      select: { id: true, name: true },
    });
    if (!schools.length) { console.error("FAILED: no school with 'Computing' in its name."); process.exit(1); }
    schools.sort((a, b) => (a.name.startsWith("DEMO") ? 1 : 0) - (b.name.startsWith("DEMO") ? 1 : 0));
    const school = schools[0];
    console.log(`School: ${school.name}${schools.length > 1 ? `  (of ${schools.length} matching; DEMO ones deprioritised)` : ""}`);

    const wanted = argOf("--course");
    const courses = await prisma.course.findMany({
      where: { academicDepartmentId: school.id, ...(wanted ? { name: { contains: wanted, mode: "insensitive" } } : {}) },
      select: { id: true, name: true, _count: { select: { units: true } } },
      orderBy: { name: "asc" },
    });
    if (!courses.length) { console.error(`FAILED: no course in ${school.name}${wanted ? ` matching "${wanted}"` : ""}.`); process.exit(1); }
    // Fewest units first: the course a person is trying to fill is the empty one. Named
    // in the output either way, because guessing silently is how modules land on the
    // wrong programme.
    courses.sort((a, b) => a._count.units - b._count.units);
    const course = courses[0];
    console.log(`Course: ${course.name}  (${course._count.units} unit(s) now)`);
    if (courses.length > 1) console.log(`        of ${courses.length} in this school — pass --course "name" to choose another`);
    console.log("");

    if (REMOVE) {
      const codes = MODULES.map(([c]) => c);
      const present = await prisma.unit.findMany({ where: { courseId: course.id, code: { in: codes } }, select: { id: true, code: true } });
      if (!present.length) { console.log("None of these ten are on that course."); return; }
      if (!APPLY) { console.log(`Would delete ${present.length}: ${present.map((u) => u.code).join(", ")}`); return; }
      const gone = await prisma.unit.deleteMany({ where: { id: { in: present.map((u) => u.id) } } });
      console.log(`Deleted ${gone.count} module(s).`);
      return;
    }

    let made = 0, skipped = 0;
    for (const [i, [code, name]] of MODULES.entries()) {
      const exists = await prisma.unit.findFirst({ where: { courseId: course.id, code } });
      if (exists) { console.log(`  · ${code} ${name} (already there)`); skipped++; continue; }
      if (!APPLY) { console.log(`  would add ${code} — ${name}`); made++; continue; }
      await prisma.unit.create({
        data: {
          code, name, unitNumber: String(i + 1),
          courseId: course.id,
          // Denormalised alongside the course's own school, which is how every other
          // writer in this codebase does it — academicDepartments.assignCourses()
          // maintains the pair, and a unit created with a null one is invisible to
          // staff scoped to the school it plainly belongs to.
          academicDepartmentId: school.id,
        },
      });
      console.log(`  ✓ ${code} — ${name}`);
      made++;
    }
    console.log(`\n${APPLY ? `Added ${made}` : `Would add ${made}`}, skipped ${skipped} already present.`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
