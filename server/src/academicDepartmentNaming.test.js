// The two department vocabularies must stay disjoint, and the schema is where that is
// enforced.
//
// WHY THIS TEST EXISTS. `Referral.department`, `ReferralTransfer.fromDepartment` and
// `Staff.supportDepartments` mean Wellbeing / ASK / Student Support — who may read a
// student's disclosure. `Course.academicDepartmentId` and `Student.academicDepartmentId`
// mean Business / Computing / Law — which students a member of staff may see at all.
// Both are access boundaries. CLAUDE.md records that the `outcome` collision (an
// intervention's outcome versus a StudentOutcome) caused three bugs, twice landing a fix
// on the wrong vocabulary. A mix-up here grants the wrong people the wrong records, so
// the rule is mechanical: an academic-department field is spelled `academicDepartment…`
// and nothing outside the support-referral models may be a bare `department…`.
//
// Run with: node --test src/academicDepartmentNaming.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const SCHEMA = readFileSync(join(__dirname, "..", "prisma", "schema.prisma"), "utf8");

test("the academic department model and its join table exist", () => {
  assert.match(SCHEMA, /model AcademicDepartment \{/);
  assert.match(SCHEMA, /model StaffAcademicDepartment \{/);
});

test("Course, Student and Staff carry the new columns, spelled exactly", () => {
  assert.match(SCHEMA, /academicDepartmentId\s+String\?/);
  // @default(TRUE), and that is load-bearing rather than incidental. The first migration
  // set the flag on accounts existing at the time; the DEFAULT is what governs every
  // account created afterwards, and a false one would hand a new tutor at a college with
  // no departments configured an empty screen and no explanation. Same shape as
  // adminPages: NULL means "never configured → full access". Narrowing is deliberate.
  assert.match(SCHEMA, /collegeWide\s+Boolean\s+@default\(true\)/);
  assert.match(SCHEMA, /vleCategoryExternalId\s+String\?/);
  assert.match(SCHEMA, /vleCategoryName\s+String\?/);
});

test("no model outside the support-referral family declares a bare `department` field", () => {
  // The support-referral models legitimately own the bare word — a referral's department
  // IS a wellbeing team, and renaming those columns would rewrite a shipped feature for
  // no gain. Everything else must qualify it. This is the assertion that stops a later
  // reader adding `Course.department` beside `Course.academicDepartmentId` and creating
  // exactly the ambiguity the prefix exists to prevent.
  const SUPPORT_MODELS = ["SupportDepartmentConfig", "Referral", "ReferralTransfer", "ReferralMessage"];
  const blocks = SCHEMA.split(/^model /m).slice(1);
  const offenders = [];
  for (const block of blocks) {
    const name = block.split(/\s/)[0];
    if (SUPPORT_MODELS.includes(name)) continue;
    for (const m of block.matchAll(/^\s{2}(department\w*)\s/gm)) {
      offenders.push(`${name}.${m[1]}`);
    }
  }
  assert.deepEqual(offenders, [], `bare department fields outside the referral models: ${offenders.join(", ")}`);
});

test("the academic department relations set null on delete, never cascade", () => {
  // Deleting a department must never delete courses, students or the registers hanging
  // off them. This is the choice Unit.courseId already makes, for the same reason.
  const refs = [...SCHEMA.matchAll(/academicDepartment\s+AcademicDepartment\?[^\n]*\n/g)].map((m) => m[0]);
  assert.ok(refs.length >= 2, `expected Course and Student to reference AcademicDepartment, found ${refs.length}`);
  for (const ref of refs) {
    assert.match(ref, /onDelete: SetNull/, `relation must SetNull, got: ${ref.trim()}`);
  }
});

test("the curriculum models carry their own academicDepartmentId", () => {
  // WHY A COLUMN AND NOT A `via` PATH. scopePredicateFor emits
  // { [via]: { academicDepartmentId: { in: [...] } } }, which requires the RELATED model to
  // carry the column itself. Unit does not, so HndSession declared { via: "unit" } does not
  // filter — it throws PrismaClientValidationError. Measured 4 Sep 2026. Every spec 2 path
  // is a single hop only because these four columns exist.
  for (const model of ["Unit", "Cohort", "TimetableSlot", "TimetableEvent"]) {
    const block = SCHEMA.split(/^model /m).find((b) => b.startsWith(model + " "));
    assert.ok(block, `model ${model} not found`);
    assert.match(block, /academicDepartmentId\s+String\?/, `${model} has no academicDepartmentId`);
    assert.match(block, /academicDepartment\s+AcademicDepartment\?[^\n]*onDelete: SetNull/,
      `${model} must SetNull — deleting a department cannot delete curriculum`);
  }
});
