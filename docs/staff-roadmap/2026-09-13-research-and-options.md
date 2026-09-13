# Staff-side roadmap — research findings and candidate task list

*13 Sep 2026. Produced by four parallel research passes (UK FE MIS competitors; teacher
daily-workflow apps; academic literature; timetabling/operations), with the load-bearing
claims independently re-verified against the cited pages before inclusion. Claims that
failed verification are corrected inline and marked ⚠️. Nothing here is a commitment —
it is the option list the next planning session chooses from.*

## How to read this

Every feature below is something we do **not** currently have (checked against
STATUS.md as of `3f9e6ea`). Tags:

- **[table-stakes]** — appears in 3+ competitor products, or is universal among UK FE MIS.
- **[differentiator]** — rare among competitors; would distinguish us.
- **[evidence: strong/weak/null]** — what the academic literature says about impact,
  where it says anything at all.

---

## 1. The four gaps that separate "college platform" from "UK FE MIS"

Every serious UK FE vendor (Tribal ebs, OneAdvanced ProSolution/ProMonitor, UNIT-e)
frames its product around these. We have none of them.

| # | Gap | Who has it | Sources |
|---|---|---|---|
| A | **ILR / ESFA funding returns** — learner-record fields mapping to ILR output, pre-submission validation, audit trail, year-on-year spec tracking. Funding-eligibility data (free meals, disadvantage, DLA, high-needs) on the learner record | ebs, ProSolution (also HESES), UNIT-e | [ebs ILR docs](https://docs.ebs.tribalgroup.com/content/ILR/Collecting%20Learner%20ILR%20Data/Learner%20Details%20Screen.htm), [ProSolution](https://www.oneadvanced.com/products/management-information-system/) ✅verified |
| B | **Exam management** — awarding-body basedata import, entries, clash-flagged candidate timetables, seating with access-arrangement codes, invigilation rosters, results import | ebs, Bromcom, iSAMS, UNIT-e, SIMS Exams Organiser | [ebs Exams](https://docs.ebs.tribalgroup.com/Content/Exams/Exams.htm), [Bromcom re-seating](https://docs.bromcom.com/knowledge-base/how-to-re-seat-an-exam-candidate/), [SIMS](https://www.ess-sims.co.uk/training/course/1374/exams-examinations-organiser) |
| C | **ILP — individual learning plans** — learner-owned plan object: targets, review points, evidence, hours logging. Our PAT log + at-risk engine is adjacent but there is no plan artefact | ProMonitor (the FE benchmark), ebs 4.35, Gibbon IEPs, Smart Assessor | [ProMonitor](https://www.oneadvanced.com/products/ilp-and-markbook/), [ebs 4.35](https://docs.ebs.tribalgroup.com/content/release%20notes/4.35/Executive%20Summary.htm) |
| D | **Safeguarding recording** with its own access model, stricter than RBAC: administrator configures but cannot read; manager sees all, locks records, closes/reopens cases; tutor has a concern inbox and sees only what they're permitted. Ofsted-critical | ebs ontrack, Bromcom, iSAMS Wellbeing | [ebs Safeguarding](https://docs.ebs.tribalgroup.com/Content/ontrack%20Hub/Use%20ontrack%20Hub%20as%20a%20Staff%20Member/Safeguarding/Safeguarding.htm) ✅verified role-by-role |

## 2. Staff daily-workflow layer (the "teacher app" gap)

The consistent market split: the **app is the in-lesson/in-corridor tool**, the web
stays the analysis surface. Bromcom's Teacher App module list ✅(verified) is the
ceiling of what schools put in one: register, seating plan, behaviour, assessment,
messages, announcements, safeguarding quick-report, fire-drill register, parents
evening, clubs/trips.

| # | Feature | Tag | Sources |
|---|---|---|---|
| E1 | **Staff "my day" view** — next lesson, register due now, task inbox at a glance | [table-stakes] | [IC Teaching Center](https://kb.infinitecampus.com/help/teaching-center), [Skyward Teacher Access](https://www.skyward.com/products/student-information-system/classroom-tools/teacher-access) |
| E2 | **One-tap mobile register** with pupil photos; SIMS auto-computes minutes-late from class start. Complements our QR/NFC self-check-in (teacher confirms/overrides) | [table-stakes] | [SIMS Teacher app](https://apps.apple.com/gb/app/sims-teacher/id875278561), [Bromcom](https://docs.bromcom.com/knowledge-base/teacher-app-new-ui-quick-guide/) ✅verified |
| E3 | **Seating plans** as the register + behaviour surface (tap a seat → mark, award, see flags) | [table-stakes] | [Arbor My Classroom](https://support.arbor-education.com/hc/en-us/articles/360012179858-My-Classroom-your-classroom-management-tool) |
| E4 | **Quick behaviour/merit points** with configurable vocabulary, two taps in class (distinct from written-up PAT meetings) | [table-stakes] | SIMS, Arbor, Bromcom, ClassDojo |
| E5 | **Task inbox / "missing registers"** — auto-refreshing list of registers not taken, marking due, referrals awaiting action | [table-stakes] | [Bromcom Missing Registers](https://docs.bromcom.com/knowledge-base/how-to-use-todays-missing-registers/) |
| E6 | **Staff-composed messaging** to students/groups + announcements/noticeboard | [table-stakes] | Skyward, Bromcom, Google Classroom, iSAMS Daily Bulletin |
| E7 | **Student alert flags at point of contact** (register/seating tile) — cheap for us, the at-risk engine already computes them | [table-stakes] | Skyward, Arbor, Bromcom |
| E8 | **Offline register with later sync** — no UK MIS teacher app advertises it | [differentiator] | [Additio](https://additioapp.com/en/attendance/), iDoceo |
| E9 | **Fire-drill register on mobile** — Bromcom only; striking fit with our NFC | [differentiator] | Bromcom ✅verified |
| E10 | **Staff directory + colleague timetables** ("where is X"; "which lesson should student Y be in") | [differentiator] | [SIMS features](https://www.ess-sims.co.uk/products-and-services/sims-teacher-app/sims-teacher-app-features-and-compatibility-for-ios-and) |

## 3. Timetabling and operations

Matches the already-parked plan: clash detection first. The market-unanimous v1 checks:

1. **Staff double-booking**, 2. **Room double-booking** (must also span ad-hoc room
bookings if those exist), 3. **Student-group double-booking** — all hard clashes.
4. **Availability-window violations** and 5. **room capacity** (nullable capacity;
null = not recorded, produces no warning — matches our null≠zero rule) as warnings.

Design rulings the market agrees on, ✅verified at source:
- **Overlap is computed against week patterns**, not day+period ([Celcat week sets](https://celcat.com/timetabler/features/interactive-timetabling/)).
- **Strict in auto-placement, advisory in manual** — EDT states it verbatim: "The time
  constraints are strictly complied with during an automatic placement. During a manual
  placement, they are indicated but the user can ignore them"
  ([EDT docs](https://doc.index-education.com/en/edt/T/Time_constraints_(teachers_classes).htm) ✅).
- **Severity levels from day one** (hard clash vs warning).
- Recurring data model: **activity** {groups, staff, subject, duration} distinct from its
  **placement** {day, start, room, week set}; the published timetable is immutable and
  absences/covers/room changes are a **dated overlay** (Edval Daily, Untis substitution).
- UniTime hard constraints incl. travel distance ✅verified ([model](https://www.unitime.org/uct_description.php));
  FET's "max building changes per day" is the adoptable travel formulation.

| # | Feature | Tag | Sources |
|---|---|---|---|
| F1 | **Clash detection v1** (the five checks above) | [table-stakes] | TimeTabler, Untis, Celcat, ProSolution ✅ |
| F2 | **Cover/substitution workflow**: leave request → lessons auto-flagged → ranked candidates (free, same subject, taught them before) → fairness by exposing per-teacher cover counts (Arbor's approach — cheapest credible v1) ✅verified categories. **Whitespace: nobody documents handing the cover teacher the lesson materials** | [table-stakes] | [Arbor Assign Cover](https://support.arbor-education.com/hc/en-us/articles/115004465089-How-to-assign-cover) ✅, [TimeTabler StaffCover](https://www.timetabler.com/staffcover/) |
| F3 | **Room booking** synced with the timetable — free-room search, per-room approval flag | [Tier 1] | [Celcat](https://celcat.com/timetabler/features/room-booking/), Bromcom Diary |
| F4 | **Staff workload view** — contracted vs timetabled hours incl. cover (composes with our timesheets) | [Tier 1] | [Untis value calculation](https://www.untis.at/en/products/untis-basic-software/lesson-planning-and-value-calculation-1) |
| F5 | Auto-generation, travel constraints, what-if copies, minimal-perturbation rescheduling | [advanced/later] | FET, UniTime papers |

## 4. Communication and outward-facing surfaces

| # | Feature | Tag | Sources |
|---|---|---|---|
| G1 | **Parent/guardian/employer portal** with per-audience permission groups (ProPortal serves parents, employers, head-teachers) | [table-stakes] | [ProPortal factsheet](https://www.oneadvanced.com/siteassets/resources/factsheet/advanced_factsheet_proportal.pdf) |
| G2 | **Bulk email/SMS + announcements** composed by staff | [table-stakes] | Bromcom, Arbor, iSAMS |
| G3 | **Report cards / termly reports** to parents & employers — compiled, proof-read, published | [table-stakes] | iSAMS School Reporting, Arbor |
| G4 | **Parents'-evening / progress-review booking** | [differentiator] | Bromcom, Arbor |
| G5 | **Behaviour & rewards tracking** (incidents, points, detentions, follow-up) | [table-stakes] | Bromcom, Arbor, iSAMS, Gibbon |

## 5. What the evidence says (verified, with one correction)

- **Prediction without a workflow is worthless.** MAAPS RCT (10,037 students, 11
  universities): null on graduation/persistence overall; Georgia State the only site
  with gains (+7pp graduation; +15pp for Black students), attributed to advising
  infrastructure, not the analytics — ✅verified at
  [Ithaka](https://sr.ithaka.org/publications/maaps-advising-experiment-evaluation-6-years/).
  Course Signals' famous retention claim collapsed under selection-bias analysis
  ([e-Literate](https://eliterate.us/purdue-course-signals-data-issue-explainer/)).
  **Implication: invest in alert → named owner → required disposition → recorded
  outcome (case management), not more dashboard.** Our intervention/outcome tables are
  already the right substrate; the missing piece is the enforced workflow and caseload
  queue. OU Analyse (Herodotou, BJET) is the best evidence that prediction + a teacher
  who acts beats prediction alone.
- ⚠️ **Correction to the research pass:** supporter/student **texting in UK FE was
  null at scale.** BIT's own pilot working paper claimed ~11% attendance gains, but the
  independent EEF evaluation ([Texting Students and Study
  Supporters](https://educationendowmentfoundation.org.uk/projects-and-evaluation/projects/texting-students-and-study-supporters))
  found **no evidence of impact** on attendance or GCSE resit pass rates. What still
  stands: **absence-total letters/texts to parents** (Rogers & Feller, Nature Human
  Behaviour 2018: ~11% reduction in chronic absenteeism at ~$6/student; EEF Texting
  Parents: small positive at ~£6/pupil). Design detail with evidence: say "**missed 5
  sessions**", never "90% attendance". Direct low-touch nudges to students themselves:
  precise nulls (Oreopoulos, NBER w25036).
- **Overview dashboards are the evidence-free genre** (Schwendimann 2017; Matcha 2020).
  What teachers actually use: question-shaped, per-class, in-flow views, blending data
  with their own knowledge — our figures-beside-codes convention already fits.
- **LLM-assisted lesson prep is the one AI feature with RCT backing**: EEF/NFER Teacher
  Choices trial, 259 teachers — 81.5→56.2 min/week (−25.3 min, −31%), no quality drop,
  ✅verified at [NFER](https://www.nfer.ac.uk/publications/chatgpt-in-lesson-preparation-a-teacher-choices-trial/).
  The guide + structured use was part of the treatment. DfE's stance: teacher-facing
  first, human accountable, no unsupervised decisions about learners, no AI summative
  marking.
- **Workload**: the three burdens worth attacking are planning/prep, marking/feedback,
  and duplicate data entry ([DfE 2019 survey](https://assets.publishing.service.gov.uk/media/5e12fcb7e5274a0f9e82e4fd/teacher_workload_survey_2019_main_report_amended.pdf);
  ["Making data work"](https://assets.publishing.service.gov.uk/government/uploads/system/uploads/attachment_data/file/754349/Workload_Advisory_Group-report.pdf):
  ≤2–3 data collections/year, never enter data twice). EEF marking review: reduce
  written marking, don't accelerate it.
- **Attendance escalation ladder** (DfE statutory guidance): same-day contact →
  barrier conversation → agreed actions → referral → formal, support-first. Encoding it
  doubles as compliance tooling. Our referrals module is the middle of this ladder.

## 6. Known traps (do not build)

- Overview/awareness dashboards with no attached action.
- Retention-gain marketing claims off before/after data (the Course Signals story).
- Low-touch study-nudge texts to students (null at scale) — and note the FE supporter-texting null above.
- Prediction features without funded human response capacity.
- Attendance shown as percentages in comms (use missed-session counts).
- AI summative marking or unsupervised AI decisions about learners (outside DfE guardrails).
- Accelerating written marking rather than reducing it.

## 7. Internal debts that compete for the same time (STATUS.md §6/§9)

- D2: mandatory 2FA — an unmade decision, not unmade work.
- D12: `/api/admission-apply` public write, honeypot only — needs rate limit.
- API.md/README.md badly stale; `StaffHub.jsx` at 14,256 lines, no code-splitting.
- NFC never proven on hardware; suites don't cover timetable/PAT/attendance-emails/Moodle/templates.

## 8. Candidate build directions (the decision to make)

1. **Timetabling v2** — clash detection (F1) → cover workflow (F2) → room booking (F3)
   → workload view (F4). Already the parked plan; composes with leave + timesheets +
   check-in we own. Cover-with-materials-handover is genuine whitespace.
2. **Staff "my day" mobile experience** — E1–E7 as a phased shell over data we already
   have (timetable, registers, at-risk flags, referrals). Highest daily-touch payoff;
   student app just proved the Capacitor path.
3. **Case-management upgrade to the at-risk engine** — named owner per alert, required
   disposition, follow-up dates, escalation on inaction, caseload queues. The
   evidence-backed way to make the prediction engine matter; small delta over existing
   intervention/referral tables.
4. **Comms layer** — staff-composed announcements/messaging (G2), parent/employer
   portal (G1), absence-total notifications to parents/guardians (evidence-backed
   design), report cards (G3).
5. **UK FE compliance spine** — ILR returns (A), exam management (B), ILP (C),
   safeguarding (D). Biggest sales-story gap vs. Tribal/OneAdvanced; also the largest
   and most spec-driven work. Safeguarding (D) is the most self-contained slice.
6. **AI staff assistant** — LLM lesson-prep/resource drafting with an in-product usage
   guide; first-draft formative feedback. RCT-backed, DfE-aligned; keep away from
   summative marking.

*Everything above is research, not commitment. Next step: pick direction(s), then a
proper design pass (brainstorming → spec → plan) per the house process.*
