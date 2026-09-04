# Academic departments, spec 2: closing the boundary

*Written 4 Sep 2026, against `main` at `0643ac4`.*

Spec 1 (`2026-09-04-academic-departments-design.md`) landed the model, the guard and the
configuration screens, and then **refused to let anybody be narrowed to a department**.
This document says what has to be true before that refusal can be lifted, and it is written
against measurements rather than reasoning — every claim in §2 was executed.

---

## 1. Why spec 1 refuses

`academicScopeGuard.js` rewrites the **top-level** query. A Prisma client extension cannot
reach a nested `include`, so a scoped account reads other departments' rows through any
parent that is itself unscoped.

Measured 4 Sep 2026 against `edtech_dev`, with a scope owning no department:

```
CONTROL  student.findMany()                          ->   0
CONTROL  attendanceMark.findMany()                   ->   0
CONTROL  enrolment.findMany()                        ->   0
LEAK     hndSession.findMany include marks           -> 194 attendance marks
LEAK     unit.findMany include enrolments            ->  34 enrolments
```

Six audit agents found this on 4 Sep. The spec 1 design predicted it in its own §9.2 —
"a claim to be tested, not assumed" — and it was not tested before the Access control
shipped. `PUT /academic-departments/staff/:staffId` now returns 400 for any request that
would narrow an account, and the client's college-wide toggle is disabled.

---

## 2. The correction that makes this tractable

When spec 1's refusal was written, the conclusion recorded was that closing this meant
auditing nine route families by hand. **That was wrong, and the correction is the whole
reason this document is short.**

### 2.1 Scoping the PARENT closes the nested read

Re-run of the same probe with `Unit` declared `{ via: "course" }`:

```
unit.findMany include enrolments            ->   0 enrolments   (was 34)
```

The child query is still not rewritten — but it no longer matters, because the only rows it
can hang off are rows the caller was already allowed to see. **A leak is specifically an
UNSCOPED parent reaching a SCOPED child**, and declaring the parent scoped is the fix.

### 2.2 `via` supports ONE hop, and that is the real blocker

The same probe with `HndSession` declared `{ via: "unit" }` did not filter — it **threw**:

```
hndSession -> PrismaClientValidationError: Unknown argument `academicDepartmentId`
              in where.unit
```

`scopePredicateFor` emits `{ [via]: { academicDepartmentId: { in: [...] } } }`, which
requires the related model to carry the column itself. `Unit` does not. So every model whose
shortest path to a department is two hops is currently unreachable.

This is what spec 1's §8 already anticipated: *"`Cohort` and `Unit` follow in spec 2, where
they are first read."* It turns out not to be an optimisation — it is the enabling change.

---

## 3. The inventory

29 models hold a foreign key to scoped data. 26 are still `UNSCOPED`. Generated from
`schema.prisma` cross-referenced against `academicScopeModels.js`:

| Model | Path to a department | Spec | Note |
|---|---|---|---|
| `Unit` | **own column**, from `courseId` | 2 | enabling change |
| `Cohort` | **own column**, from `courseId` | 2 | enabling change |
| `HndSession` | `via: unit` | 2 | needs `Unit` column first |
| `Assessment` | `via: unit` | 2 | needs `Unit` column first |
| `Term` | `via: cohort` | 2 | needs `Cohort` column first |
| `TimetableEventGroup` | `via: cohort` | 2 | needs `Cohort` column first |
| `TermCalendar` | `via: course` | 2 | `Course` already has it |
| `TimetableSlot` | `via: course` | 2 | `courseId` **nullable** — see §5 |
| `TimetableEvent` | `via: course` | 2 | `courseId` **nullable** |
| `AssessmentGrade` | `via: student` | 2 | |
| `AssessmentSubmission` | `via: student` | 2 | |
| `Interaction` | `via: student` | 2 | |
| `Intervention` | `via: student` | 2 | |
| `MitigatingCircumstance` | `via: student` | 2 | **Article 9 health data** |
| `StudentOutcome` | `via: student` | 2 | |
| `StudentPredictionCurrent` | `via: student` | 2 | |
| `StudentPredictionHistory` | `via: student` | 2 | |
| `StudentQuery` | `via: student` | 2 | |
| `StudentReview` | `via: student` | 2 | |
| `VleEngagement` | `via: student` | 2 | |
| `TagTap` | `via: student` | 2 | `studentId` **nullable** — see §5 |
| `Admission` | `via: linkedStudent` | 3 | relation EXISTS — see §6 |
| `SlcApplication` | `via: student` | 3 | relation EXISTS — see §6 |
| `TimesheetEntry` | HR | 4 | |
| `Referral` | — | **never** | rides `supportDepartments`; see §7 |
| `SignupRequest` | — | **never** | pre-authentication by nature |

Twenty-one models move in spec 2. Two are unblocked for spec 3 and two stay unscoped
permanently.

---

## 4. The work

**4.1 `Unit.academicDepartmentId` and `Cohort.academicDepartmentId`.** Denormalised from
`Course`, nullable, `onDelete: SetNull`. Maintained by extending
`academicDepartments.assignCourses()` — which is already the one implementation of "move
courses and the students on them" — to move units and cohorts in the same transaction. It is
already shared by the two writers of `Course.academicDepartmentId`, so there is one place to
change and both callers inherit it.

A migration backfills both from the course. It is the first migration in this feature that
touches many rows, and it is a plain `UPDATE … FROM` — no locks beyond the row locks.

**4.2 Declare the 21 models.** One line each in `academicScopeModels.js`. The completeness
test already fails on any model absent from the map, so nothing can be forgotten; what it
cannot check is whether a `via` path is *correct*, which is what 4.4 is for.

**4.3 Re-point the raw SQL.** `scopedCourseJoinFromUnit` currently joins `Unit → Course`
because `Unit` had no column. With 4.1 it collapses to a single join on `Unit`, which also
removes the redundant double-`Unit` join an audit found in
`GET /hnd/attendance/monthly`, and removes the two-definitions-of-department split between
the mark path and the session path on the same screen.

**4.4 One assertion per newly scoped model.** The completeness test proves a model is
*declared*; only a query proves it is *filtered*. The spec 1 suites are the pattern: a
refusal and a permission, so a server returning nothing cannot pass. This is the bulk of the
work and it is what spec 1 skipped.

**4.5 Lift the refusal.** Delete the 400 in `PUT /staff/:staffId`, re-enable the client
toggle, and only then is the Access screen telling the truth.

---

## 5. The traps, all measured or read

**Nullable foreign keys fail CLOSED, and that needs saying out loud.** `TimetableSlot.courseId`,
`TimetableEvent.courseId` and `TagTap.studentId` are all nullable. A `via` predicate on a null
relation matches nothing, so those rows become visible only to college-wide accounts. That is
the safe direction and it is consistent with an unassigned course — but it means a timetable
slot with no course (a workshop, a study-support session: exactly what
`TimetableSlot`'s own schema comment says the model exists to carry) **disappears from every
scoped account's timetable**. That is a real product regression, not a theoretical one, and
spec 2 must decide it deliberately rather than discover it.

**A scoped parent can still have children from another department.** A Business unit's
enrolments include a Computing student taking it as an elective, so a Business tutor sees
that student's marks for that unit. This is correct — they teach them — but it is the one
place where "one student, one department" and "scope through the parent" disagree, and it
should be stated rather than found.

**`MitigatingCircumstance` is Article 9 health data.** It moves in spec 2 like the others,
but its route already carries a confidentiality split that the departmental boundary must not
weaken or duplicate. Read `routes/mitigations.js`'s header before touching it.

**The prediction pipeline stays institution-wide.** It already runs under
`withoutAcademicScope`. Scoping `StudentPredictionCurrent` must not narrow the pipeline's own
reads — CLAUDE.md records that computing its institution-wide probes from a subset is the
most repeated bug in that area, got wrong three times. The declaration affects *routes*
reading predictions, not the runner writing them.

---

## 6. Two things spec 1 recorded that are no longer true

`academicScopeModels.js` says spec 3 is blocked because "Admission and SlcApplication hold
the student's name and typed college id as plain strings today". **The schema disagrees.**
`SlcApplication.student` and `Admission.linkedStudent` are both real relations with indexes,
added by migration `20260828T230000_link_finance_to_student` — a week before spec 1 was
written. Both can carry a `via` today. The stale comment would have deferred spec 3 for a
reason that was already fixed, and it is corrected as part of this work.

Spec 1's own §9.4 repeats the same stale claim and is corrected with it.

---

## 7. What never gets scoped, and why

`Referral`, `ReferralTransfer`, `ReferralMessage`, `SupportDepartmentConfig` are confined by
`Staff.supportDepartments` — a **different** boundary, deliberately. A wellbeing officer
works their queue across every teaching department, and narrowing it academically would hide
a disclosure from the team the student made it to. `SignupRequest` is pre-authentication: the
person has no account, let alone a department.

---

## 8. Definition of done

- Every model in §3 marked "spec 2" is declared, and each has an assertion pair proving it
  is filtered for a scoped account and visible for a college-wide one.
- The nested-read probe in §1 returns **0** for every case it currently leaks, run as a
  smoke assertion rather than by hand.
- `PUT /staff/:staffId` accepts `collegeWide: false`, and the client toggle is live.
- The §5 nullable-FK decision is made, recorded here, and covered by an assertion.
- Every existing suite still passes with a *scoped* account, not only a college-wide one —
  the gap that let spec 1 ship green.

---

## 9. Open questions

1. **The nullable-FK regression (§5).** Should a course-less timetable slot be visible to
   everyone, or only to college-wide accounts? "Everyone" fails open on a boundary; "college
   wide only" removes study-support sessions from a scoped tutor's timetable. My
   recommendation is to give `TimetableSlot` and `TimetableEvent` their own nullable
   `academicDepartmentId` so a college can place these rows deliberately, with null meaning
   "shown to everyone" — the one place fail-open is right, because a workshop is not a
   student record.
2. **Multi-hop `via`, or columns everywhere?** §4.1 adds columns to `Unit` and `Cohort`,
   which makes every spec 2 path single-hop. Supporting `via: "unit.course"` instead would
   avoid a migration but leaves the raw SQL still needing the two-table join. Recommendation:
   columns, as spec 1 §8 already planned.
3. **Does the college want scoping at all yet?** Spec 1 is useful on its own — departments
   exist, courses and students are assigned, the VLE mapping populates them, reporting can
   slice by department. Narrowing staff access is the part that carries this risk, and it is
   worth confirming it is wanted before spending spec 2 on it.
