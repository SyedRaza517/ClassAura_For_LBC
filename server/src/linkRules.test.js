// Tests for the matcher that decides whether a loan record or an admissions file
// belongs to a particular student.
//
// NEARLY EVERY TEST HERE IS A NEGATIVE ONE, deliberately. The failure that matters is
// not "we missed a link" — an unlinked row loses nothing it has today. It is "we
// attached one student's declined loan or expiring passport to another person", which
// is inaccurate personal data about an identified individual, concerning finance and
// immigration, driving a risk level staff act on.
//
// So the tests that earn their place are the ones proving the matcher REFUSES.
//
// Run with: node --test src/linkRules.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { proposeSlcLink, proposeAdmissionLink, isMintedEmail } = require("./linkRules");

const student = (over = {}) => ({
  id: "stu_1", studentRef: "HND-100", lastName: "Rahman",
  email: "a.rahman@example.ac.uk", dob: "2004-03-11", ...over,
});

/* -------------------------------------------------------------------------- */
/* Finance records                                                             */
/* -------------------------------------------------------------------------- */

test("a reference and a surname that agree is a link", () => {
  const r = proposeSlcLink({ studentRef: "HND-100", studentName: "Aisha Rahman" }, [student()]);
  assert.equal(r.tier, "auto");
  assert.equal(r.studentId, "stu_1");
});

test("a matching reference with the WRONG surname is refused", () => {
  // The whole point. A one-character typo in a free-text ID box that happens to land on
  // another real student's number is the incident this module exists to prevent, and
  // the surname is what makes it fail closed.
  const r = proposeSlcLink({ studentRef: "HND-100", studentName: "Aisha Khan" }, [student()]);
  assert.equal(r.tier, "review");
  assert.notEqual(r.tier, "auto");
});

test("a reference that is ambiguous once case-folded links to nobody", () => {
  // Student.studentRef is unique per tenant CASE-SENSITIVELY, so both of these exist.
  const r = proposeSlcLink({ studentRef: "hnd-100", studentName: "Aisha Rahman" },
    [student(), student({ id: "stu_2", studentRef: "hnd-100" })]);
  assert.equal(r.tier, "review");
  assert.equal(r.studentId, null);
});

test("an empty reference proposes nothing at all", () => {
  // studentRef defaults to "" on this table, so this is the common case, and null is
  // the correct value rather than a failure.
  const r = proposeSlcLink({ studentRef: "", studentName: "Aisha Rahman" }, [student()]);
  assert.equal(r.tier, "none");
  assert.equal(r.studentId, null);
});

test("a name alone never links, however exactly it matches", () => {
  const r = proposeSlcLink({ studentRef: "", studentName: "Aisha Rahman" }, [student()]);
  assert.equal(r.tier, "none");
});

test("surname matching is case-insensitive and tolerates a middle name", () => {
  const r = proposeSlcLink({ studentRef: "hnd-100", studentName: "AISHA BEGUM RAHMAN" }, [student()]);
  assert.equal(r.tier, "auto");
});

/* -------------------------------------------------------------------------- */
/* Admissions records                                                          */
/* -------------------------------------------------------------------------- */

test("an enrolled applicant whose typed college ID and surname agree is a link", () => {
  const r = proposeAdmissionLink(
    { enrollStatus: "Enroll", studentId: "HND-100", surname: "Rahman", email: "", dob: "" }, [student()]);
  assert.equal(r.tier, "auto");
  assert.equal(r.rule, "enrol-ref+surname");
});

test("an enrolled applicant whose surname disagrees is refused", () => {
  const r = proposeAdmissionLink(
    { enrollStatus: "Enroll", studentId: "HND-100", surname: "Khan", email: "", dob: "" }, [student()]);
  assert.equal(r.tier, "review");
});

test("email and date of birth agreeing is a link", () => {
  const r = proposeAdmissionLink(
    { enrollStatus: "Applied", email: "a.rahman@example.ac.uk", dob: "2004-03-11", surname: "Rahman" }, [student()]);
  assert.equal(r.tier, "auto");
  assert.equal(r.rule, "email+dob");
});

test("SIBLINGS ON ONE MAILBOX ARE REFUSED", () => {
  // The case the dob clause exists for, and the one that would attach a brother's
  // identity-document expiry to his sister. A shared family address is ordinary.
  const r = proposeAdmissionLink(
    { enrollStatus: "Applied", email: "a.rahman@example.ac.uk", dob: "2006-11-02", surname: "Rahman" }, [student()]);
  assert.equal(r.tier, "review");
  assert.match(r.why, /dob DISAGREES/);
});

test("an unparseable date of birth CANNOT CORROBORATE, and is not read as agreement", () => {
  // Admission.dob is free text with the same absent validation as idDateOfExpiry. The
  // null discipline the rest of this codebase runs on applies to the matcher too: not
  // comparable is neither agreement nor disagreement.
  const r = proposeAdmissionLink(
    { enrollStatus: "Applied", email: "a.rahman@example.ac.uk", dob: "11/03/2004", surname: "Rahman" }, [student()]);
  assert.equal(r.tier, "review");
  assert.match(r.why, /not comparable/);
});

test("a machine-minted student address is not independent evidence", () => {
  // The Moodle importer mints these. An address derived from the reference is the SAME
  // evidence counted twice, which is exactly what the two-identifier rule forbids.
  const r = proposeAdmissionLink(
    { enrollStatus: "Applied", email: "moodle-77@placeholder.invalid", dob: "2004-03-11", surname: "Rahman" },
    [student({ email: "moodle-77@placeholder.invalid" })]);
  assert.equal(r.tier, "review");
  assert.match(r.why, /machine-minted/);
});

test("an address built from the student number is also not independent", () => {
  const r = proposeAdmissionLink(
    { enrollStatus: "Applied", email: "hnd-100@college.ac.uk", dob: "2004-03-11", surname: "Rahman" },
    [student({ email: "HND-100@college.ac.uk" })]);
  assert.equal(r.tier, "review");
});

test("two students sharing an address link to neither", () => {
  const r = proposeAdmissionLink(
    { enrollStatus: "Applied", email: "family@example.com", dob: "2004-03-11", surname: "Rahman" },
    [student({ email: "family@example.com" }), student({ id: "stu_2", email: "family@example.com" })]);
  assert.equal(r.tier, "review");
  assert.equal(r.studentId, null);
});

test("an applicant who never enrolled and matches nothing proposes nothing", () => {
  // Most applicants never become students. Null is the correct value, not a miss.
  const r = proposeAdmissionLink(
    { enrollStatus: "Rejected", email: "someone@else.com", dob: "2004-03-11", surname: "Other" }, [student()]);
  assert.equal(r.tier, "none");
});

test("a typed college ID on a NON-enrolled application does not take the enrolled route", () => {
  // enrollStatus is half the evidence in that rule. Without it the typed ID is one
  // identifier standing alone.
  const r = proposeAdmissionLink(
    { enrollStatus: "Applied", studentId: "HND-100", surname: "Rahman", email: "", dob: "" }, [student()]);
  assert.notEqual(r.tier, "auto");
});

/* -------------------------------------------------------------------------- */
/* The minted-address helper                                                   */
/* -------------------------------------------------------------------------- */

test("a real college address IS independent evidence", () => {
  assert.equal(isMintedEmail("a.rahman@example.ac.uk", "HND-100"), false);
});

test("an empty address is treated as minted rather than as evidence", () => {
  // Failing towards "not independent" is the safe direction: it costs a review, where
  // the opposite costs a wrong link.
  assert.equal(isMintedEmail("", "HND-100"), true);
});
