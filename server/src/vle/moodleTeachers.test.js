// Naming a module's lecturer from Moodle — and refusing to when it would be a guess.
const test = require("node:test");
const assert = require("node:assert/strict");
const { soleEditingTeacher } = require("./moodleTeachers");

const teacher = (email, fullname = "A Teacher") => ({ email, fullname, roles: [{ shortname: "editingteacher" }] });
const student = (email) => ({ email, fullname: "A Student", roles: [{ shortname: "student" }] });

test("one editing teacher on a course is the answer", () => {
  const r = soleEditingTeacher([student("s@x.ac.uk"), teacher("t@x.ac.uk", "Dana Okoye")]);
  assert.deepEqual(r, { email: "t@x.ac.uk", fullname: "Dana Okoye" });
});

test("TWO EDITING TEACHERS IS AMBIGUOUS, AND AMBIGUOUS MEANS NOBODY", () => {
  // Moodle assigns roles per COURSE, not per unit. A course with two teachers cannot
  // say which of them teaches which unit, and naming the wrong lecturer is worse than
  // naming none — "not set" prompts somebody to fix it, a wrong name does not.
  assert.equal(soleEditingTeacher([teacher("a@x.ac.uk"), teacher("b@x.ac.uk")]), null);
});

test("no editing teacher is unknown, not an error", () => {
  assert.equal(soleEditingTeacher([student("s@x.ac.uk")]), null);
  assert.equal(soleEditingTeacher([]), null);
  assert.equal(soleEditingTeacher(undefined), null);
});

test("the non-editing 'teacher' role does not count", () => {
  // Moodle's plain `teacher` is the non-editing role — visiting lecturers, teaching
  // assistants, observers. Treating it as ownership would name a support tutor as a
  // module's leader.
  const assistant = { email: "ta@x.ac.uk", fullname: "TA", roles: [{ shortname: "teacher" }] };
  assert.equal(soleEditingTeacher([assistant]), null);
  // ...and it does not create ambiguity beside a real editing teacher either.
  assert.deepEqual(soleEditingTeacher([assistant, teacher("t@x.ac.uk", "Real")]), { email: "t@x.ac.uk", fullname: "Real" });
});

test("a manager is not a teaching relationship", () => {
  const manager = { email: "m@x.ac.uk", fullname: "Admin", roles: [{ shortname: "manager" }] };
  assert.equal(soleEditingTeacher([manager]), null);
});

test("the same teacher enrolled twice is still one teacher", () => {
  // Moodle lists a user once per enrolment method, so a teacher enrolled manually and
  // by cohort sync appears twice. Counting that as two would make every such course
  // ambiguous and fill in nothing anywhere.
  const r = soleEditingTeacher([teacher("t@x.ac.uk", "Dana"), teacher("t@x.ac.uk", "Dana")]);
  assert.deepEqual(r, { email: "t@x.ac.uk", fullname: "Dana" });
});

test("case and whitespace in the email do not split one person into two", () => {
  const r = soleEditingTeacher([teacher("T@X.ac.uk"), teacher("  t@x.ac.uk  ")]);
  assert.deepEqual(r, { email: "t@x.ac.uk", fullname: "A Teacher" });
});

test("a teacher with no email yields nothing, because there is nothing to match on", () => {
  assert.equal(soleEditingTeacher([teacher("")]), null);
});

test("an unmatchable teacher still makes a course ambiguous", () => {
  // One teacher we could link and one we could not is NOT a course with one teacher.
  // Silently ignoring the second would name the first as sole lecturer of a course
  // somebody else also teaches.
  assert.equal(soleEditingTeacher([teacher("t@x.ac.uk"), teacher("")]), null);
});

test("a role list that is missing or malformed does not throw", () => {
  assert.equal(soleEditingTeacher([{ email: "x@x.ac.uk" }]), null);
  assert.equal(soleEditingTeacher([{ email: "x@x.ac.uk", roles: null }]), null);
  assert.equal(soleEditingTeacher([null, undefined]), null);
});

test("the role name is matched case-insensitively", () => {
  const shouty = { email: "t@x.ac.uk", fullname: "T", roles: [{ shortname: "EditingTeacher" }] };
  assert.deepEqual(soleEditingTeacher([shouty]), { email: "t@x.ac.uk", fullname: "T" });
});
