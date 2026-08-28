// Deciding whether a finance or admissions record belongs to a particular student.
//
// PURE. No database, no clock, no tenant. Rows in, a proposal out. The seam exists
// because this is the most dangerous arithmetic in the codebase and it has to be
// checkable without fixtures — see linkRules.test.js, where nearly every case is a
// NEGATIVE one.
//
// THE GOVERNING RULE: A WRONG MATCH IS WORSE THAN NO MATCH.
//
// SlcApplication and Admission hold loan status, declared needs and identity-document
// expiry, and neither has ever had a reference to Student. Attaching one student's
// declined loan or expiring passport to another person is not a defect corrected next
// sprint. It is inaccurate personal data about an identified individual, concerning
// finance and immigration, driving a risk level staff act on — and it is visible to
// the wrong data subject on a screen.
//
// An UNLINKED row loses nothing it has today. It simply does not gain a signal. So the
// default answer is NO PROPOSAL, and every automatic rule requires TWO INDEPENDENT
// IDENTIFIERS THAT AGREE. One is never enough, however strong it looks, because the
// single-identifier failure mode is precisely a typo landing on another real person.
//
// Three tiers come out of this:
//   "auto"   two identifiers agree — safe to write
//   "review" a candidate exists but the evidence is incomplete or contradictory
//   "none"   nothing to propose, and null is the correct value
const norm = (v) => String(v == null ? "" : v).trim();
const fold = (v) => norm(v).toUpperCase();
const lower = (v) => norm(v).toLowerCase();

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is this address evidence about a person, or is it derived from their student number?
 *
 * The Moodle importer mints `moodle-<id>@placeholder.invalid` and the HND route mints
 * `<studentRef>@<college domain>`. An address derived from the reference is THE SAME
 * EVIDENCE as the reference, counted twice — and counting one fact twice is exactly
 * what the two-identifier rule exists to prevent. Treating it as corroboration would
 * turn every single-identifier match into a false "auto".
 */
function isMintedEmail(email, studentRef) {
  const e = lower(email);
  if (!e) return true;
  if (e.endsWith("@placeholder.invalid")) return true;
  const local = e.split("@")[0];
  return Boolean(local && studentRef && local === lower(studentRef));
}

/**
 * A finance record against the students of one college.
 *
 * @param {{studentRef, studentName}} row
 * @param {Array<{id, studentRef, lastName}>} students  the tenant's students
 */
function proposeSlcLink(row, students) {
  const key = fold(row && row.studentRef);
  if (!key) return { tier: "none", studentId: null, why: "no studentRef recorded" };

  // Student.studentRef is unique per tenant CASE-SENSITIVELY, so "HND-100" and
  // "hnd-100" can both exist. A reference that is ambiguous once folded is not an
  // identifier, and no amount of corroboration makes an ambiguous key safe.
  const matches = (students || []).filter((s) => fold(s.studentRef) === key);
  if (matches.length > 1) {
    return { tier: "review", studentId: null, why: `"${key}" matches ${matches.length} students once case-folded` };
  }
  if (!matches.length) return { tier: "none", studentId: null, why: `no student holds "${key}"` };

  const st = matches[0];
  const surname = lower(st.lastName);

  // THE SURNAME CLAUSE IS NOT OPTIONAL. studentRef on an SLC row is typed into a
  // free-text box with no picker and no validation, and a free-text ID field is
  // exactly the one that gets mistyped. A single-character typo landing on another
  // real student's number is THE incident this module is arranged around. Requiring
  // the surname to appear as well makes such a typo fail CLOSED — no link, rather
  // than a confident wrong one.
  //
  // Containment rather than equality: the SLC row holds one combined name while the
  // student row holds two fields, and middle names, initials and orderings vary.
  // Containment is the strongest test these shapes support without fuzzy matching,
  // and fuzzy matching is refused outright — "Mohammed" and "Muhammad" are different
  // people as often as they are the same one.
  if (!surname) return { tier: "review", studentId: st.id, why: "student has no surname to corroborate against" };
  if (!lower(row.studentName).includes(surname)) {
    return { tier: "review", studentId: st.id, why: `ref matches ${st.studentRef} but surname does not appear in the name on the finance record` };
  }

  return { tier: "auto", studentId: st.id, why: "ref + surname", rule: "ref+surname" };
}

/**
 * An admissions record against the students of one college.
 *
 * Two independent routes, in order of confidence.
 *
 * @param {{studentId, surname, email, dob, enrollStatus}} adm
 * @param {Array<{id, studentRef, lastName, email, dob}>} students
 */
function proposeAdmissionLink(adm, students) {
  const list = students || [];
  const a = adm || {};

  /* --- 1. enrolled, with a typed college ID that resolves ---------------- */

  // Not a new invention: admissionDocs.js already treats enrollStatus "Enroll" plus a
  // typed studentId as the enrolled identity when it names the SharePoint folder.
  // This formalises semantics the codebase already relies on.
  const typed = fold(a.studentId);
  if (a.enrollStatus === "Enroll" && typed) {
    const matches = list.filter((s) => fold(s.studentRef) === typed);
    if (matches.length > 1) {
      return { tier: "review", studentId: null, why: `"${typed}" is ambiguous once case-folded` };
    }
    if (matches.length === 1) {
      const st = matches[0];
      const sur = lower(st.lastName), asur = lower(a.surname);
      if (sur && asur && (sur === asur || sur.includes(asur) || asur.includes(sur))) {
        return { tier: "auto", studentId: st.id, why: "enrolled, ref + surname", rule: "enrol-ref+surname" };
      }
      return { tier: "review", studentId: st.id, why: "enrolled ref matches but surname disagrees" };
    }
  }

  /* --- 2. email agrees AND date of birth agrees -------------------------- */

  const e = lower(a.email);
  if (!e) return { tier: "none", studentId: null, why: "no email and no usable enrolled reference" };

  const byEmail = list.filter((s) => lower(s.email) === e);
  if (byEmail.length > 1) {
    return { tier: "review", studentId: null, why: "several students share that address" };
  }
  if (!byEmail.length) return { tier: "none", studentId: null, why: "no student with that address" };

  const st = byEmail[0];
  if (isMintedEmail(st.email, st.studentRef)) {
    return { tier: "review", studentId: st.id, why: "the student address is machine-minted, so it is not independent of the reference" };
  }

  // THE DOB CLAUSE IS MANDATORY, and the reason is specific rather than theoretical:
  // shared family mailboxes are ordinary, and siblings applying to one college from a
  // single household address is exactly the case where email-plus-name attaches a
  // brother's document expiry to his sister.
  //
  // An UNPARSEABLE dob means CANNOT CORROBORATE. It must never read as "dob agrees",
  // and equally never as "dob disagrees" — the same null discipline the rest of this
  // codebase runs on, applied to the matcher itself. Admission.dob is free text with
  // the same absent validation as idDateOfExpiry.
  const ad = norm(a.dob), sd = norm(st.dob);
  if (!ISO.test(ad) || !ISO.test(sd)) {
    return { tier: "review", studentId: st.id, why: `email matches; dob not comparable ("${ad}" vs "${sd}")` };
  }
  if (ad !== sd) {
    return { tier: "review", studentId: st.id, why: "email matches but dob DISAGREES — most likely siblings on one mailbox" };
  }

  return { tier: "auto", studentId: st.id, why: "email + dob", rule: "email+dob" };
}

module.exports = { proposeSlcLink, proposeAdmissionLink, isMintedEmail };
