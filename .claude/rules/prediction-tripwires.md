---
paths:
  - "server/src/prediction/**"
  - "server/src/routes/prediction.js"
---

## Tripwires: a second layer beside the progression score

**They cannot move the band, and that is structural.** `prediction/tripwires.js` appends
`TRIP_*` codes to `riskDriverCodes` — the same array carrying the engine's six RED
indicators. OVR-004 worsens a band on `redIndicatorCount`, which `engine.js` derives from
its own internal `reds` array; `riskDriverCodes` is a copy taken afterwards, so nothing
appended here can reach the override. The prefix keeps that visible: a code named
`RED_`-something would read as the engine's, and anyone later taking the count from the
copy silently wires tripwires into banding. Keep the prefix, and keep the count off the
copy.

**Store dates; derive day-counts at render time.** Nothing in this feature runs on a
schedule — `markStale()` fires on data events, and a day passing is not an event. "19 days
since last attended" written to a column is wrong by the next morning with nothing to
correct it, while `lastAttendedOn` is true forever. Columns hold dates; the screen
subtracts.

**"Does this college record this field at all" is an institution-wide question, and
computing it from the chunk is the most repeated bug in this area.** `gather()` runs on
chunks of 200, and the ordinary incremental path scores only the handful of students
`markStale` flagged — often one. One student with no late marks is ordinary; a college
whose Moodle plugin has no "L" acronym records no lateness at all, and only the second
makes `latenessRate` `null` ("not recorded") rather than `0.0` ("never late"). Five guards
share this shape — lateness, excused absence (no "E"), submission dates in the feed,
whether `AssessmentSubmission` is populated, and whether the pastoral module is used. That
last one, decided per chunk, suppressed `TRIP_NO_PASTORAL_CONTACT` for exactly the students
it exists to find, because a chunk of never-contacted students contains no contacts. Probe
once per run, unfiltered by student, hoisted out of the chunk loop. This has been got wrong
three times.

**Some signals exist to suppress.** `weeksIntoProgramme` mutes the disengagement codes
inside a settling-in period, because in week one nobody has attendance history, marks or a
pastoral record, and a caseload containing the whole intake is the same as no caseload. An
*unknown* programme age is deliberately not exempt — muting every code for a student the
calendar cannot place fails safe in the wrong direction.

**Some columns are dead ends, and the list changed — check before relying on it.**
Corrected 5 Sep 2026; the previous wording was wrong in both halves and load-bearing
decisions had been built on it.

`AssessmentSubmission` **is** written — `moodle.js` upserts it during the sync, for
*observed* activities only. The real qualification is narrower than "nothing writes it":
on an install with no Moodle the table is empty, and every reader guards on
`count() > 0` first, so it degrades honestly. A signal reading it measures the student
where the integration reports, and reports nothing where it does not.

`Admission.linkedStudentId` and `SlcApplication.studentId` are the actual dead ends, and
they are worse than a dead table because **the readers exist**. Both are real foreign
keys; neither is written by anything in `server/src` (only by dry-run backfill tools). So
every `entryProfile*` figure, `rightToStudyExpiresOn`, and every `funding*` column is
permanently null at every install — scored, tested, shipped, always empty. Editing an SLC
record also never rescores the student, because `markStale()` hangs off the link.

`Admission.studentId` — the *typed* college ID, a plain string beside the FK — is the
hazard to watch: it names the applicant's SharePoint folder, so one typo files a person's
identity documents under another student's number.

**"Outcome" means two different things and the collision has caused three bugs.** An
intervention's `outcome` is the response to something staff did; a `StudentOutcome` is what
became of the student. Two vocabularies (`OUTCOMES`, `STUDENT_OUTCOMES`), and a fix aimed
at one has twice landed on the other. Name the variable for which one you mean.

**Nullability is a contract enforced across two tables.** `schema-contract.test.js` parses
`schema.prisma` and fails if anything the engine can emit as `null` lands in a NOT NULL
column. A new figure must be nullable on **both** `StudentPredictionCurrent` and
`StudentPredictionHistory`, and identically so.

