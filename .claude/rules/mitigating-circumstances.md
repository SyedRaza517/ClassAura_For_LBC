---
paths:
  - "server/src/prediction/**"
  - "server/src/routes/mitigations.js"
  - "server/src/routes/adjustments.js"
  - "scripts/smoke-mitigation*.mjs"
---

## Mitigating circumstances: the engine knows THAT, never WHY

**A claim is Article 9 health data and the schema is split around that.** `status`,
`coversFrom`, `coversTo`, `coversAttendance` and the adjustments say WHAT the college
decided; `category` and `detail` say WHY. The prediction pipeline selects the first group
and nothing else. `schema-contract.test.js` reads `metrics.js` as text and fails if
`category` or `detail` appear in that select, because the rule lives in exactly one place
and that is the kind of rule a later reader widens for a screen they are building. Same
reason the audit summary names the student and the decision but never the reason — the
audit log is read on Settings by admins never granted this page.

**A suppressed assessment leaves BOTH sides of every fraction.** Never counted as
submitted, never as on time, never as missing. This is null-is-not-zero pointed the other
way, and getting it backwards is the MIRROR of the bug the feature fixes: counting an
extended assessment as handed in on time inflates the score of a student in real
difficulty and quietly removes them from the register. Excluded work must leave a list
entirely rather than arrive with a null date — a null `dueDate` reads as "nothing to be
late against", which counts the piece as on time.

**Attendance cover keeps two lists.** Covered sessions leave the percentages. They stay in
`lastAttendedOn`, the absence streak, the weekly pattern and every pastoral code: a student
on approved mitigating circumstances is one the college should be speaking to MORE, and a
sponsoring provider still has to evidence engagement.

**An undecided claim suppresses, and that is a setting rather than a constant.**
`pendingClaimSuppresses`. With a claim pending, "did this student fail to hand work in" is
not a question about the student — the answer depends on a decision the institution has not
taken, and counting it against them punishes the student for the length of the college's
own decision queue. But a college whose regulations say otherwise is entitled to say so,
and hardcoding one reading of somebody else's regulations is the worse failure.

