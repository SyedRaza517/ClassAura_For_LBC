#!/usr/bin/env node
//
// Proposing links between the finance/admissions records and the students they are
// about — and, by default, writing nothing at all.
//
// WHY THIS IS DRY-RUN BY DEFAULT AND WHY THAT IS NOT TIMIDITY.
//
// A WRONG MATCH IS WORSE THAN NO MATCH. Attaching one student's declined loan or
// identity-document expiry to another person is not a defect you correct next sprint.
// It is inaccurate personal data about an identified individual, it concerns finance
// and immigration status, and the moment it drives a risk level staff act on it becomes
// an incorrect decision ABOUT A PERSON — visible to the wrong data subject on a screen.
// An unlinked row, by contrast, loses nothing it has today. It simply does not gain a
// signal.
//
// So the default answer is NULL, and every automatic rule requires TWO INDEPENDENT
// IDENTIFIERS THAT AGREE. One identifier is never enough however strong it looks,
// because the single-identifier failure mode is precisely a typo landing on another
// real person.
//
// HOW TO USE IT
//
//   node tools/backfill-student-links.js            # dry run, writes a CSV, changes nothing
//   node tools/backfill-student-links.js --apply    # writes ONLY the tier-A rows
//
// Read the CSV before ever passing --apply. And read it SEPARATELY for each database:
// staging and production drift, the same cuid does not identify the same person, and a
// mapping produced against one is a mass mis-linking event against the other. That is a
// refusal, not a caution.
//
// WHAT MAKES IT REVERSIBLE
//
// Every row written carries studentLinkSource = "backfill:<rule>". Undoing the whole
// operation is therefore one statement that cannot touch a link a human made:
//
//   UPDATE "SlcApplication" SET "studentId" = NULL, "studentLinkSource" = NULL
//    WHERE "studentLinkSource" LIKE 'backfill:%';
//
// Without that column, "undo the backfill" and "delete everyone's links" are the same
// statement.
const fs = require("node:fs");
const path = require("node:path");
const prisma = require("../src/db");
const { withoutAcademicScope } = require("../src/academicScope");
// The rules live in a PURE module with tests beside them, because deciding whether one
// person is another is the most dangerous arithmetic here and nearly every test of it
// is a refusal. This script is the plumbing; src/linkRules.js is the judgement.
const { proposeSlcLink, proposeAdmissionLink } = require("../src/linkRules");

const APPLY = process.argv.includes("--apply");
const OUT_DIR = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : process.cwd();

const csvCell = (v) => {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// tier -> what this script does about it. Only "auto" is ever written, and only with
// --apply. Everything else lands in the CSV for a person to decide.
const DECISION = { auto: () => (APPLY ? "APPLIED" : "would apply"), review: () => "review by hand", none: () => "left null" };

async function propose(rows) {
  const students = await prisma.student.findMany({
    select: { id: true, studentRef: true, lastName: true, email: true, dob: true },
  });

  const push = (table, id, p) =>
    rows.push([table, id, p.tier, p.studentId || "", p.why, DECISION[p.tier]()]);

  /* ---- finance records --------------------------------------------------- */

  const slc = await prisma.slcApplication.findMany({
    where: { studentId: null },
    select: { id: true, studentRef: true, studentName: true },
  });

  for (const row of slc) {
    // The judgement is in src/linkRules.js, which has tests beside it and where nearly
    // every one of them is a refusal. This file is plumbing only — duplicating the
    // rules here would mean two copies of the most dangerous arithmetic in the
    // codebase and only one of them under test.
    const p = proposeSlcLink(row, students);
    push("SlcApplication", row.id, p);
    if (p.tier === "auto" && APPLY) {
      await prisma.slcApplication.update({
        where: { id: row.id },
        data: { studentId: p.studentId, studentLinkSource: `backfill:${p.rule}`, studentLinkedAt: new Date() },
      });
    }
  }

  /* ---- admissions records ------------------------------------------------ */

  const adms = await prisma.admission.findMany({
    where: { linkedStudentId: null },
    select: { id: true, studentId: true, surname: true, email: true, dob: true, enrollStatus: true },
  });

  for (const a of adms) {
    const p = proposeAdmissionLink(a, students);
    push("Admission", a.id, p);
    if (p.tier === "auto" && APPLY) {
      await prisma.admission.update({
        where: { id: a.id },
        data: { linkedStudentId: p.studentId, studentLinkSource: `backfill:${p.rule}`, studentLinkedAt: new Date() },
      });
    }
  }
}

// AN OPERATOR CLI HAS NO CALLER AND THEREFORE NO DEPARTMENT.
//
// It is run from a shell by somebody with database access, over the whole institution by
// definition. Without this declaration the academic scope guard throws on its first query
// against Student, Course, Enrolment or AttendanceMark -- which is what happened to all
// seven tools in this directory when the guard went live, because prisma/seed.js was
// wrapped and these were forgotten.
withoutAcademicScope("backfill-student-links: an operator CLI that repairs links college-wide", async () => {
  // One deployment, one institution, one database — so there is nothing to iterate
  // over and no tenant column in the CSV. The database named by DATABASE_URL IS the
  // scope, which is exactly why the header comment above refuses to reuse a mapping
  // produced against one database when running against the other: it is now the only
  // thing telling the two apart.
  const rows = [];
  await propose(rows);

  const counts = rows.reduce((acc, r) => { acc[r[2]] = (acc[r[2]] || 0) + 1; return acc; }, {});
  const file = path.join(OUT_DIR, `student-link-proposals-${APPLY ? "applied" : "dryrun"}.csv`);
  fs.writeFileSync(file,
    "table,rowId,tier,candidateStudentId,evidence,decision\n" +
    rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n");

  console.log(APPLY ? "APPLIED tier-A links." : "DRY RUN — nothing was written.");
  console.log("auto   (two identifiers agree):", counts.auto || 0);
  console.log("review (needs a human):       ", counts.review || 0);
  console.log("none   (no candidate at all): ", counts.none || 0);
  console.log("CSV:", file);
  // A LOW TIER-A SHARE IS THE HONEST OUTCOME, not a failed run. It is not something to
  // fix by loosening a rule — every loosening trades a correct null for a possible
  // wrong link, and the wrong link is the incident.

  // The post-apply check that every written link stayed inside one institution is
  // GONE, and deliberately not replaced with something shaped like it. It compared
  // Student."tenantId" against SlcApplication."tenantId" — columns the
  // remove-multi-tenancy migration dropped. A cross-institution link is no longer
  // expressible: one institution per database means a link landing on the wrong row
  // is the wrong PERSON, not the wrong college, and no query distinguishes that from
  // a correct one. The CSV, read before --apply, is what catches it, and it is now
  // the only thing that does.

  await prisma.$disconnect();
}).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
