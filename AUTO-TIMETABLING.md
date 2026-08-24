# Automatic Timetable Generation — Research & Proposal

*Written 24 Aug 2026 against `main`. This is a design document, not an implementation
report. No code was written and no existing file was changed to produce it.*

This answers one question: **can Staff Hub generate a college timetable automatically,
with a human always able to override it afterwards — and if so, how?**

Short answer: yes. It is a well-studied problem with known-good algorithms at this
scale. But the hard part is not the algorithm. The hard part is that **almost none of
the data a scheduler needs exists in the database yet.** On the plan in §3(e), roughly
70% of the effort is modelling, admin screens and data entry. The solver is the small
part.

Three caveats before anything else.

1. **Nothing here has been prototyped.** Every performance claim is either cited from
   published work or reasoned from problem size. §2.6 says where the reasoning is thin.
2. **The college's real numbers are unknown.** How many tutors, rooms, cohorts and
   sessions per week is exactly what §3(a) exists to ask for. The recommendation in
   §3(c) holds comfortably to a few hundred sessions and would need re-examining above
   about a thousand.
3. **A fully automatic timetable nobody may edit is the wrong product.** Every serious
   tool in this space, commercial and free, is semi-automatic. §3(d) is not a
   nice-to-have section; it is most of the value.

---

## 1. What exists today

### 1.1 The feature, exactly

`server/src/routes/timetable.js` is 281 lines and eight endpoints, all behind
`requireAuth` + `requirePage("timetable")`:

| Endpoint | What it does |
|---|---|
| `GET /api/timetable/courses` | Courses that have units, each with the `(year, termNumber)` stages its units cover — drives the picker |
| `GET /api/timetable?courseId=&year=&termNumber=` | The `TimetableSlot` rows in one scope, plus the units in it (so the screen can flag units with no rows), a term window derived from unit dates, and the stored `TermCalendar` |
| `POST /api/timetable/autofill` | Builds slots from units' generated registers |
| `POST /api/timetable/publish` | Flips `published` on every row in the scope, and on the `TermCalendar` with it |
| `PUT /api/timetable/calendar` | Upserts the week-by-week academic calendar for one exact stage |
| `POST /api/timetable/slots` | Add one row by hand |
| `PUT /api/timetable/slots/:id` | Edit a row's day, times, title, lecturer, room |
| `DELETE /api/timetable/slots/:id` | Remove a row |

**"Auto-fill" does not schedule anything.** This is worth stating plainly, because the
button says "Auto-fill from units" and an owner could reasonably read that as "the
system works out the timetable". It does not.

`scheduleOf()` (`routes/timetable.js:26`) reads a unit's existing `HndSession` register
rows, reduces them to the distinct `(weekday, start, end, kind)` tuples they contain,
and writes one `TimetableSlot` per tuple. A session whose `kind` is `"seminar"` gets
`" Tutorial"` appended to its title. The lecturer defaults to
`tutorStaff.name || tutor || ""`; the room is set to the empty string. It is idempotent
— a unit that already has slots is skipped — which is why re-running never duplicates,
and also why it can never *revise* anything.

So where do the day and time actually come from? From `server/src/routes/hnd.js:879`,
`POST /units/:id/sessions/generate`:

- The weekday is **the weekday of the unit's `startDate`**; the generator steps forward
  in 7-day increments to `endDate` (cap: 60 weeks).
- The times come from a hardcoded ladder of four three-hour blocks — `10:00–13:00`,
  `14:00–17:00`, `17:00–20:00`, `20:00–23:00` — and how many are used is
  `round(hours / 3)`, capped at four.
- On a multi-block day the kinds alternate `Teaching`, `Seminar`, `Teaching`, `Seminar`.

In other words: **an administrator's choice of a unit's start date is the timetable.**
Auto-fill replays that choice into a second table. There is no allocation, no
optimisation, and no notion that two things might collide.

### 1.2 What the admin screen does

The `AdminTimetable` component in `client/src/StaffHub.jsx` is about 330 lines. (That
file is 12,596 lines and was being edited by other work while this was written, so it is
cited by function name rather than line number — the number moved twice during the
review.) Course picker → year → term. Above the grid, a list of units in scope showing "Registers suggest: Tue
10:00–13:00" with an "Add to timetable" button that opens a prefilled modal
(`openUnit`). Below it, a **flat table grouped by day** — Day / Time /
Session / Lecturer / Venue / Actions — not a week grid. A publish bar with three states
(`draft`, `partial`, `published`) and an amber panel listing units with no rows yet.
Underneath, the term dates and the week-by-week calendar editor with a "Generate weeks"
button.

`periodOf()` in the same file derives a Morning / Afternoon / Evening label from the
start hour. Presentational only.

Room and lecturer are free-text inputs. There is no drag-and-drop, no week grid, and no
conflict highlighting.

### 1.3 The single most important gap

**Nothing anywhere checks for a clash.** `parseSlot()` (`routes/timetable.js:46`)
validates that `day` is 1–7, that times are `HH:MM`, that `end > start`, and that a
title is present. That is all. Grepping `server/src` for clash, overlap or
double-booking finds only semester date ranges (`hnd.js:67–92`) and attendance bands.

A tutor can be given two rooms at 18:00 on a Tuesday and the system will save it,
publish it, and show it to students on both courses.

### 1.4 What data a scheduler could already use

This part is genuinely encouraging — a lot of the skeleton is there.

| Model | Line | What a scheduler gets from it |
|---|---|---|
| `Course` | `schema.prisma:717` | The programme. Already the scope key for a timetable |
| `Cohort` | `:815` | An intake — **the natural "student group"** a scheduler assigns to. Size is a count of `Student` rows |
| `Term` | `:839` | Dated teaching term per cohort (`year`, `index`, `start`, `end`) |
| `Unit` | `:862` | `code`, `name`, `year`, `termNumber`, `startDate`, `endDate`, `courseId`, `cohortId`, `termId`, and `tutorStaffId` → `Staff`. **The unit-to-tutor link already exists as a real relation** |
| `Staff` | `:416` | `name`, `dept`, `site` (`HND` / `FE` / `Online`, nullable) |
| `Enrolment` | `:1091` | `(studentId, unitId)` — the true student-to-unit mapping, which is what makes a *student* clash detectable rather than only a cohort clash |
| `HndSession` | `:1109` | Dated sessions with times and `kind`, unique on `(unitId, date, startTime)`. What a generated timetable must ultimately produce, so registers keep working |
| `Semester` | `:701` | Non-overlapping dated ranges, already enforced |
| `TermCalendar` | `:790` | Term start/end and a per-week activity (`Teaching`, `Assessment`, `Reading Week`…) — **already enough to exclude non-teaching weeks** |
| `Leave` | `:626` | Approved absence per staff member. The only staff-unavailability data that exists |
| `AuditLog` | `:118` | `actorType`, `action`, `entity`, `entityId`, `before`/`after` JSON. Ready-made for recording what a solver did and what a human changed afterwards |
| `bankHolidays.js` | — | England & Wales statutory holidays, Easter computed, one-off royal days hardcoded and verified against gov.uk. **Currently used only by `routes/leave.js`** — the register generator does not consult it, so registers are generated on Easter Monday |

### 1.5 What is missing

| Missing | Consequence |
|---|---|
| **No `Room` model at all** | `TimetableSlot.room` is a free-text `String` (`:768`). No capacity, no type, no equipment, no building, no site. A scheduler cannot allocate rooms it cannot enumerate |
| **`lecturer` is free text, not a relation** | `TimetableSlot.lecturer String @default("")`. You cannot reliably ask "what is Amina teaching on Tuesday". The source of truth is `Unit.tutorStaffId`, but the published slot carries a name that may have drifted from it |
| **No staff availability model** | No working days, no unavailable periods, no part-time pattern, no other-campus commitments |
| **No teaching-load limits** | No max hours per day, per week or per term on `Staff` |
| **No taught-hours-per-week on `Unit`** | Session count per week is inferred from a transient `hours` parameter passed to the register generator and then forgotten |
| **No lock/pin flag on `TimetableSlot`** | Nothing to tell a re-run "do not move this one" |
| **No draft/published versioning** | `published` is one boolean per row. There is no "draft version B alongside live version A" — which is exactly what previewing a generated timetable requires |
| **No room/equipment requirements on a unit** | Nothing says a unit needs an IT suite |
| **No sites or travel times** | `Staff.site` is a three-value string with no distances attached |
| **No test coverage** | `STATUS.md:320`: `/api/timetable` is reached only indirectly, through `/student/me/timetable` in `smoke-studentportal`. `API.md` does not document the module at all |

### 1.6 The deployment constraint that shapes §3(c)

`render.yaml` provisions **one** web service, `plan: free`, `rootDir: server`. No worker
service, no queue, no Redis. The three existing schedulers (`scheduler.js:145`,
`attendanceScheduler.js:49`, `notificationsScheduler.js:41`) are in-process
`setInterval` timers in the same Node process that serves requests. The free plan sleeps
the service after 15 minutes idle. Runtime is Node 24; `worker_threads` is available and
nothing currently uses it.

This matters more than it looks. A solver is CPU-bound. Run it on the main thread and it
blocks the event loop for every other user of every other tenant for its whole duration.
Any recommendation has to deal with this explicitly, and §3(c) does.

---

## 2. Research

### 2.1 The problem has a name and a literature

This is the **University Course Timetabling Problem** (UCTP), a constraint satisfaction
and optimisation problem. The standard framing: assign every teaching event to a time
period and a room, subject to *hard* constraints that must hold for the timetable to be
usable at all, and *soft* constraints that express preferences and are scored rather
than enforced. A hard-constraint violation makes the timetable infeasible; soft
violations make it merely unpopular
([survey of approaches to UCTP, *Computers & Industrial Engineering*](https://www.sciencedirect.com/science/article/abs/pii/S0360835214003714);
[optimisation techniques in university timetabling — constraints, methodologies, benchmarks, open issues](https://www.sciencedirect.com/org/science/article/pii/S154622182200340X)).

The problem is **NP-hard**, so nobody is finding a guaranteed optimum for a real
instance in reasonable time. The literature divides approaches into *one-stage*
(satisfy hard and soft together), *two-stage* (reach feasibility first, then improve the
soft score), and *relaxation-based*. **Two-stage is the pragmatic mainstream** and is
what §3(c) recommends.

### 2.2 The benchmark scale is the same as ours

The most useful calibration is the **International Timetabling Competition 2007, Track 3
(curriculum-based course timetabling)** — 21 instances built from **real data at the
University of Udine**
([ITC-2007 Track 3 technical report](https://www.eeecs.qub.ac.uk/itc2007/curriculmcourse/report/curriculumtechreport.pdf)).
Across `comp01`–`comp14` the instances run:

| Dimension | Range |
|---|---|
| Teachers | 24 – 99 |
| Curricula (student groups) | 13 – 150 |
| Courses | 30 – 131 |
| **Lectures to place** | **152 – 434** |
| Periods per week | 25 – 45 |
| Rooms | 5 – 20 |

([dataset statistics as tabulated by Timefold](https://docs.timefold.ai/timefold-solver/0.8.x/use-cases-and-examples/course-timetabling/course-timetabling))

That is the same order of magnitude as an FE college's whole timetable, and it means the
published results transfer. The competition allowed each entrant roughly ten minutes per
instance, and the organisers' own commentary notes that since timetabling runs a few
times a year, "a running time much longer than the 10 minutes granted for the
competition would also be reasonable."

The ITC-2007 constraint set is also a good starting vocabulary, because it is small,
real, and battle-tested:

**Hard** — teacher conflict (no teacher in two lectures in the same period); curriculum
conflict (no student group in two lectures in the same period); room occupancy (no two
lectures in a room in the same period); unavailable period (a named lecture must not
land in a named period).

**Soft** — room capacity; minimum working days (a course's lectures spread across days);
curriculum compactness (a group's lectures adjacent, not scattered); room stability (a
course keeps the same room).
([constraint list](https://docs.timefold.ai/timefold-solver/0.8.x/use-cases-and-examples/course-timetabling/course-timetabling))

Note what is *soft* there that an FE college might insist is *hard* — room capacity, for
one. Where the line falls is a policy decision, not a technical one, and §3(b) returns
to it.

### 2.3 The algorithms, and what each is actually good for

| Approach | How it works | Good at | Bad at | Verdict here |
|---|---|---|---|---|
| **Graph colouring / constructive heuristics (DSATUR, Welsh-Powell)** | Model conflicts as a graph; colour vertices, colours = periods. DSATUR repeatedly picks the *most constrained* uncoloured vertex — the one with the most distinct colours already among its neighbours — and gives it the lowest legal colour ([Baeldung](https://www.baeldung.com/cs/graph-coloring-constructive-methods); [DSATUR in JGraphT](https://jgrapht.org/javadoc/org.jgrapht.core/org/jgrapht/alg/color/SaturationDegreeColoring.html)) | Getting to a *feasible* timetable fast. Milliseconds at our scale. Easy to explain | Ignores preferences entirely. Not optimal | **Use it — as phase one.** It is the standard way to build the starting solution |
| **Constraint propagation + backtracking (CP / CP-SAT)** | Prune domains, search, learn from conflicts | Proving infeasibility; hard combinatorial structure; modern CP-SAT is extremely strong | Explaining itself to a curriculum manager; needs a real solver library | Best solver available, but see §2.5 on getting one into Node. Keep as an escape hatch |
| **Simulated annealing** | Accept worsening moves with a temperature-decayed probability | Best-known results on ITC-style instances. Reliable quality | Needs a cooling schedule tuned per problem — awkward in a multi-tenant product where nobody will tune anything | Strong, but the tuning burden counts against it |
| **Tabu search** | Steepest-descent with a memory of recently-made moves, forbidden for a tenure | Reaches decent solutions *fast* — one comparison found tabu at 50 penalty points after 347s where SA was still at 1050 ([PATAT 2008](https://patatconference.org/patat2008/proceedings/Wilke-WD2c.pdf)) | The same study found SA better on best and average quality given more time. Needs neighbourhood and tenure tuning | Viable; loses to LAHC on tuning burden |
| **Late-acceptance hill climbing (LAHC)** | Hill climbing that compares a candidate against the solution from *L* iterations ago, kept in a circular buffer. Accepts worsening moves implicitly ([Burke & Bykov, *EJOR*](https://www.sciencedirect.com/science/article/abs/pii/S0377221716305495); [parameter-less variant, GECCO 2017](https://dl.acm.org/doi/10.1145/3071178.3071225)) | **One parameter**, and it is *scale-independent* — insensitive to the magnitude of the objective, so it does not need per-instance tuning. Proven on exam and high-school timetabling | Slightly behind a well-tuned SA at the very top end | **Recommended.** The no-tuning property is decisive for multi-tenant |
| **Genetic algorithms** | Population, crossover, mutation, selection | Exploring rugged landscapes; popular in student projects | *Feasibility.* Crossover routinely produces timetables that violate hard constraints, and you spend the project writing repair operators | **Reject.** See §2.5 for what the JS ecosystem offers here |
| **Integer programming** | Formulate as a MILP, hand to a commercial solver | Optimality guarantees; good when the model is naturally linear | Scale. A real small-college case study produced an IP with **~170,000 rows and columns**, solving to optimality in **4–24 hours** on a laptop with a commercial solver, with near-optimal solutions "often found in 4–12 hours" ([Automated timetabling for small colleges and high schools using huge integer programs](https://arxiv.org/abs/1612.08777)) | **Reject for v1.** Honest and useful evidence: pure IP is a day-long batch job, and needs a licence |

The consistent finding across the literature is that the **combination** wins: a
constructive heuristic to reach feasibility, then a local-search metaheuristic to
improve the soft score.

### 2.4 What real timetabling products do

| Product | Algorithm | Notable |
|---|---|---|
| **[FET](https://lalescu.ro/liviu/fet/)** (free, GPL, widely used in schools) | A bespoke heuristic — not a general solver. The site claims only "a fast and efficient timetabling algorithm" | **The most useful published figure in this whole document is its own runtime guidance**: simple timetables "under 5 minutes (in some cases, a matter of seconds)"; typical "maximum 5-20 minutes"; difficult ones "a matter of hours." Its constraint vocabulary is worth copying — the [FET manual](https://www.timetabling.de/manual/FET-manual.en.html) documents *max hours continuously*, *max hours daily*, and activity tags that let a constraint apply to a labelled subset of sessions |
| **[TimeTabler](https://www.timetabler.com/timetabler/)** (October Resolutions, UK schools) | Deliberately **semi-automatic** | Its whole pitch is that full automation is the wrong goal: it combines "sensible automated scheduling where it can save time" with "excellent tools for manual scheduling to let human judgment solve the unique problems that are an inevitable part of the scheduling process," showing recommended priorities at each stage while the user "can follow the program's advice or make their own decisions." That is a product decision made by people who have sold timetabling software for decades, and it is the single strongest argument for §3(d) |
| **Untis**, **aSc TimeTables** | Commercial, proprietary; algorithms not published | Both are conventional in shape: enter teachers, subjects, classes, rooms and constraints; run the generator; inspect and hand-adjust. Public material is largely marketing, so treat feature claims accordingly |
| **[Timefold Solver](https://github.com/TimefoldAI/timefold-solver)** (Apache-2.0, ex-OptaPlanner) | Construction heuristic + local search, with incremental score calculation | The best-documented open-source engine for this exact problem class, and school timetabling is a flagship use case. Its [school-timetabling quickstart](https://github.com/TimefoldAI/timefold-quickstarts/blob/stable/java/spring-boot-integration/README.md) is almost precisely our problem, and it runs solves on a **background thread pool** rather than the request thread, explicitly to avoid HTTP timeouts. Two features are worth stealing outright, described in §3(d): **pinning** (fix assignments the planner already trusts and let the solver plan around them) and **score analysis / indictments** ("which constraints are broken, how many times, and which entities are responsible") — see [Understanding the score](https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/understanding-the-score) and [Validating an optimized plan with Explainable AI](https://docs.timefold.ai/timefold-platform/latest/guides/validating-an-optimized-plan-with-explainable-ai) |

**iMIS was on the list to research and appears to be a false lead.** It is
[association and membership management software](https://www.imis.com/software/software/association-software.aspx)
— membership, dues, fundraising, events, billing — for associations, unions and
non-profits. Nothing in its own material describes course timetabling. If someone at the
college named it, it is worth checking what they actually meant before any time is spent
on it.

The common thread across the ones that *are* timetabling tools: **every one of them
expects to be corrected.** None ships as a black box that emits a final timetable.

### 2.5 What can actually run from Node

This was researched specifically, and the answer is blunter than one might hope.

**There is nothing credible for this problem in pure JavaScript.**

| Candidate | Status | Verdict |
|---|---|---|
| [`csps`](https://www.npmjs.com/package/csps) | v2.0.2, published May 2021, ~64 downloads/week, 8 stars | Textbook backtracking; a student project. No |
| [`js-csp`](https://www.npmjs.com/package/js-csp) | Last publish 2017 | **Naming trap** — CSP here is *Communicating Sequential Processes* (Go-style channels), not constraint satisfaction. Unrelated |
| [`kiwi.js`](https://www.npmjs.com/package/kiwi.js) | README says "NO LONGER MAINTAINED"; fork [`@lume/kiwi`](https://www.npmjs.com/package/@lume/kiwi) is alive | Cassowary — *continuous* linear constraints for UI layout. No integers, no all-different. Cannot express "no room double-booking". Wrong tool |
| [`logic-solver`](https://www.npmjs.com/package/logic-solver) | MiniSat via Emscripten, Meteor, last publish 2016 | Technically capable, but you hand-encode everything to CNF with no integer reasoning and only crude weighted minimisation. Reimplementing a fraction of CP-SAT badly on a 2016 build |
| [`javascript-lp-solver`](https://www.npmjs.com/package/javascript-lp-solver), [`yalps`](https://www.npmjs.com/package/yalps) | Both maintained | YALPS' own README disqualifies it: geared to small problems, integer variables "a few hundred at the most", "for very large and/or integral problems, a more professional solver is recommended." Our problem is *entirely* integer |
| [`glpk.js`](https://www.npmjs.com/package/glpk.js), [`highs`](https://www.npmjs.com/package/highs) | Real MILP solvers as WASM; `highs` (HiGHS) is the better of the two and current | Usable *if* you commit to a MILP formulation — which means big-M inequalities, weak relaxations, and no `NoOverlap`. CP-SAT exists because MILP struggles with exactly this problem class |
| [`timetabling-solver`](https://www.npmjs.com/package/timetabling-solver) | 15 downloads/week, 37 stars, last pushed Jul 2023 | A hand-rolled GA weekend project. Will not reliably produce a feasible timetable at our scale |
| **Google OR-Tools, official JS bindings** | [Requested in 2015](https://github.com/google/or-tools/issues/94), answered "Not really :-(", never delivered; [install docs](https://developers.google.com/optimization/install) list C++, Python, Java, C# only | Treat as permanently declined |
| [`node_or_tools`](https://www.npmjs.com/package/node_or_tools) | Last pushed Dec 2023; prebuilt binaries for Node 4 and 6 | Dead, and only wraps TSP/VRP routing anyway. Useless twice over |
| [`or-tools-wasm`](https://www.npmjs.com/package/or-tools-wasm) | **New and genuinely interesting.** First published 13 May 2026; exposes CP-SAT with an API mirroring the Python one, multithreaded WASM with configurable search workers | But: pre-1.0, ~55 stars, **one maintainer**, a fork of a 15,000-commit Google C++ repo. Not a dependency to put under a multi-tenant production platform in its first year. Revisit |
| [`minizinc`](https://www.npmjs.com/package/minizinc) | Official, first-party, actively maintained | **The WASM build is browser-only.** In Node it shells out to an installed `minizinc` binary. So it is a subprocess wrapper, not an in-process library — which removes its main advantage over a Python sidecar |
| **Timefold** | JVM only; no JS bindings of any kind. Its Python port is described by its own authors as beta and "significantly slower" than the JVM version | Would mean a JVM sidecar |

The mainstream architecture for "JS app, real solver" is a **Python sidecar running
`ortools` CP-SAT**, called over a spawn or an HTTP job API. That is the boring, proven
answer, and if this problem were larger it would be the recommendation.

### 2.6 Where the evidence is thin

Being explicit, because several of these are load-bearing:

- **No published runtime figures for a JS implementation at this scale.** The claim in
  §3(c) that a hand-written heuristic in Node handles a few hundred sessions in seconds
  is reasoned from the operation count, not measured. It needs a spike.
- **Untis and aSc's algorithms are not public.** Everything findable about them is
  marketing. Any claim about how they behave internally would be invention.
- **FET's algorithm is not documented in any detail** on its own site beyond "fast and
  efficient". Its *timings* are stated by the project and are the useful part.
- **Nobody publishes what a UK FE college's constraint mix actually looks like.**
  Searches for FE-specific timetabling (option blocks, day-release, guided learning
  hours) return HE material and vendor pages. §3(a) is therefore reasoned from the
  general problem plus what this codebase already implies about the college — evening
  teaching to 23:00, part-time staff, three sites — and needs the owner to correct it.
- **The soft-constraint weights suggested in §3(b) are a starting point, not a
  recommendation.** They will be wrong for this college until someone runs a timetable
  and complains.

---

## 3. The proposal

### (a) The data we must ask the college for

Grouped by what it describes. "Have?" says whether the field exists in the schema today.

#### Tutors

| Field | Why the scheduler needs it | Req? | Sensible default | Have? |
|---|---|---|---|---|
| Name, email | Identity on a slot and for notifying them | Required | — | ✅ `Staff` |
| Units they teach | The core assignment. Without it nothing can be placed | Required | — | ✅ `Unit.tutorStaffId` |
| Working days | The base availability window; a Monday-only tutor changes everything | Required | Mon–Fri | ❌ |
| Available hours per working day (start/end) | Part-time and evening staff are not available 09:00–21:00 | Required | 09:00–21:00 | ❌ |
| Recurring unavailable periods | "Never Wednesday afternoons — other campus" | Optional | none | ❌ |
| One-off unavailable dates | Training, conferences, known absence | Optional | none | ~ `Leave` gives approved absence only |
| Max teaching hours **per day** | A contract limit and a welfare limit. Left out, the solver will happily give someone 12 hours | Required | 6 | ❌ |
| Max teaching hours **per week** | Same, at the contract level | Required | **Must ask** — do not guess a number that ends up in a dispute | ❌ |
| Max consecutive teaching hours | Prevents a 9-hour unbroken block | Optional | 6 | ❌ |
| Preferred part of day | The owner asked for this explicitly. Soft — see §3(b) | Optional | none | ❌ |
| Preferred day off / preferred days on site | Soft. Very effective at making a timetable feel fair | Optional | none | ❌ |
| Max days on site per week | A part-timer would rather teach 3 days than 5 | Optional | none | ❌ |
| Home site | Travel-time constraints depend on it | Required if >1 site | the college's main site | ~ `Staff.site` is `HND`/`FE`/`Online`, not a real site list |
| Can teach online | Whether online delivery is an option for their units | Optional | yes | ❌ |

#### Units and teaching pattern

| Field | Why the scheduler needs it | Req? | Sensible default | Have? |
|---|---|---|---|---|
| Code, name, course, year, term, cohort | Scope and identity | Required | — | ✅ `Unit` |
| **Total taught hours per week** | The single most important missing number. Everything downstream is derived from it | Required | **Must ask** | ❌ |
| **Number of separate sessions per week** | 6 hours can be one 6-hour block or two 3-hour ones. Very different timetables | Required | `round(hours / 3)` — matches today's block ladder | ❌ |
| Length of each session | Determines how sessions tile the day | Required | 3 hours | ~ implied by the hardcoded blocks |
| Session kind (lecture / seminar / workshop / practical) | Different room types, different rules | Optional | first is Teaching, second is Seminar (today's behaviour) | ~ `HndSession.kind` |
| Room type required | An IT unit in a plain classroom is a failed session | Optional | Any general teaching room | ❌ |
| Equipment required | Projector, specialist software, lab kit | Optional | none | ❌ |
| Same room every week? | Room stability — students and tutors hate rooms that move | Optional | yes | ❌ |
| Sessions on different days? | Spread. A unit taught twice in one day is poor pedagogy | Optional | yes | ❌ |
| Delivery mode (on-site / online / hybrid) | Online sessions need no room and no travel time | Required | on-site | ~ `TimesheetEntry.mode` only |
| Teaching weeks within term | Excludes assessment and reading weeks | Required | every week marked `Teaching` in `TermCalendar` | ✅ `TermCalendar.weeks` |
| Fixed slot, if pre-agreed | Employer-linked or shared-with-another-college units genuinely cannot move | Optional | none | ❌ (this is the `locked` flag in §3(d)) |

#### Cohorts and students

| Field | Why the scheduler needs it | Req? | Sensible default | Have? |
|---|---|---|---|---|
| Cohort, course, year, term | Grouping | Required | — | ✅ `Cohort`, `Term` |
| **Expected size** | Drives room capacity, which is a hard constraint if you make it one | Required | count of `Student` rows in the cohort | ~ derivable |
| Days the cohort attends | Day-release and part-time cohorts do not attend five days | Required | Mon–Fri | ❌ |
| Earliest start / latest finish | An evening cohort of working adults cannot start at 10:00 | Required | 10:00 – 21:00 (today's block ladder) | ❌ |
| **Protected lunch/break window** | The owner asked for this. Left out, the solver will schedule straight through it | Required | 13:00–14:00, protected | ❌ |
| Max teaching hours per day for students | Welfare and attendance | Optional | 6 | ❌ |
| Do students choose optional units? | If yes, cohort-level clash checking is *not enough* and per-student checking is required | Required (yes/no) | no | ✅ `Enrolment` already holds the per-student truth if needed |

#### Rooms — none of this exists today

| Field | Why the scheduler needs it | Req? | Sensible default | Have? |
|---|---|---|---|---|
| Room name / code | Identity | Required | — | ❌ |
| Site / building | Travel time, and "don't move a cohort across town at lunchtime" | Required if >1 site | main site | ❌ |
| **Capacity** | Room-capacity constraint. Without it, rooms are interchangeable and the allocation is meaningless | Required | — | ❌ |
| Room type | Match to the unit's requirement | Required | General teaching | ❌ |
| Equipment / features | Specialist matching | Optional | none | ❌ |
| Availability windows | Rooms are not free all day; some are shared or hired out | Optional | always available in college hours | ❌ |
| Blocked periods (exams, events, external hire) | **A common cause of a timetable that is wrong the day it is published** | Optional | none | ❌ |
| Owning department | Some rooms are effectively reserved | Optional | none | ❌ |

#### Sites, calendar and policy

| Field | Why the scheduler needs it | Req? | Sensible default | Have? |
|---|---|---|---|---|
| List of sites | Everything site-related depends on it | Required if >1 | one site | ~ `Staff.site` is a proxy, not a list |
| **Travel time between each pair of sites** | A tutor cannot finish at 13:00 at one site and start at 13:00 at another | Required if >1 | 60 minutes | ❌ |
| Site opening hours | Nothing can be scheduled outside them | Optional | 08:00–21:30 | ❌ |
| Term start/end per cohort | The window everything sits in | Required | — | ✅ `Term`, `TermCalendar` |
| Week-by-week activity | Which weeks are teaching | Required | all `Teaching` | ✅ `TermCalendar.weeks` |
| Bank holidays | No teaching. Currently **not** excluded from generated registers | Required | computed | ✅ `bankHolidays.js`, unused here |
| **College closure days** (INSET, staff development, enrolment weeks) | Not derivable from anything. Must be asked for | Required | none | ❌ |
| The teaching-day grid the college actually uses | The set of legal start times. Everything is placed into it | Required | today's four 3-hour blocks: 10–13, 14–17, 17–20, 20–23 | ~ hardcoded in `hnd.js` |
| Does the college teach Saturdays? Evenings? | Changes the grid's size by 20–40% | Required | Mon–Fri only, evenings yes | ❌ |
| Soft-constraint weights | How to trade "tutor prefers mornings" against "cohort has a gap" | Optional | the table in §3(b) | ❌ |

**The honest summary of this section:** of about 45 fields, roughly 10 exist. Most of
the rest are one-off data-entry exercises that a curriculum manager has to sit down and
do. Anyone estimating this project by the difficulty of the algorithm will be wrong by a
large factor.

### (b) Hard constraints vs soft constraints

**Hard — the timetable is invalid if any is violated. The solver must never output one.**

| # | Constraint | Note |
|---|---|---|
| H1 | A tutor is in at most one session at a time | The canonical hard constraint |
| H2 | A room hosts at most one session at a time | |
| H3 | A cohort is in at most one session at a time | |
| H4 | **A student is in at most one session at a time** | Stronger than H3 and only needed if students choose optional units. `Enrolment` already supports it. Checking it is more expensive; make it switchable |
| H5 | A session falls inside the college's teaching grid, the site's opening hours, and the cohort's attendance days | |
| H6 | A session does not fall on a bank holiday, a closure day, or a non-teaching week | |
| H7 | A tutor is available at that time (declared unavailability is absolute) | Distinct from H1 |
| H8 | A room's capacity ≥ the cohort size | ITC-2007 treats this as *soft*. For an FE college with fire limits it should be hard. **Make it configurable and default to hard** |
| H9 | A room's type satisfies the unit's requirement | Only if the unit declares one |
| H10 | A tutor's max hours per day and per week are not exceeded | Arguably contractual, so hard. Configurable |
| H11 | A locked session does not move | See §3(d) |
| H12 | Every required session is scheduled exactly once | The completeness constraint |
| H13 | A tutor's consecutive sessions at different sites are separated by at least the travel time | Only with >1 site |

**Soft — scored, never enforced. The weights below are a starting point, not a
recommendation.**

| # | Constraint | Suggested weight | Note |
|---|---|---|---|
| S1 | A unit's weekly sessions fall on **different days** | 10 | ITC-2007's *minimum working days*. Almost always wanted |
| S2 | A cohort's day is **compact** — no gaps between its sessions | 8 per gap period | ITC-2007's *curriculum compactness*. Gaps are the main student complaint |
| S3 | Lunch/break window is not taught across | 8 | Promote to hard if the college insists |
| S4 | A cohort does not have a **single-session day** | 6 | The owner asked for this. Coming in for three hours is resented |
| S5 | A tutor does not have a single-session day | 5 | Same, from the other side |
| S6 | A unit keeps the **same room** every week | 4 | ITC-2007's *room stability* |
| S7 | A tutor's preferred part of day is honoured | 3 | The owner's example of a soft constraint. Deliberately low — it should lose to a student gap |
| S8 | A tutor's preferred day off is honoured | 4 | |
| S9 | A tutor's gaps are minimised | 3 | |
| S10 | A tutor teaches on as few days as possible | 3 | Matters most for part-time staff |
| S11 | No more than *N* consecutive teaching hours | 5 | FET calls this *max hours continuously* |
| S12 | Room capacity is not badly wasted (a group of 8 in a room for 60) | 1 | Low weight; utilisation reporting matters more than the score |
| S13 | **Minimise change from the currently published timetable** | 6 | Not in the textbooks and it matters enormously in practice — see §3(f) |
| S14 | Teaching load is spread evenly across the week | 2 | |

**The most important thing about this table is that the hard/soft split is a
configuration decision, not a technical one.** Over-declaring hard constraints is the
single most common reason a timetabling system reports "no solution" and loses the
room's confidence. H4, H8 and H10 should each be a switch, and the switch should be in
the admin UI with a plain-English explanation of what happens if you turn it on.

### (c) Recommended algorithm

**Recommendation: a two-phase heuristic written in plain JavaScript — a
saturation-degree-ordered constructive placement, then late-acceptance hill climbing
over the soft score — running in a `worker_threads` Worker as a background job.**

**Phase 1 — construct a feasible timetable.** Order the sessions still to place by "most
constrained first" (the DSATUR idea: the session with the fewest remaining legal
(period, room) pairs, breaking ties on the most conflicts). Place each into its
best-scoring legal pair. Allow limited backtracking — on failure, unplace the handful of
sessions blocking the current one and retry, with an iteration cap. Anything still
unplaced is *reported*, never silently dropped (§3(d)). At a few hundred sessions this
phase should complete in well under a second.

**Phase 2 — improve the soft score.** Repeatedly propose a move (relocate one session to
a different period/room; swap two sessions) that **preserves every hard constraint by
construction**, score it incrementally, and accept it under the LAHC rule: accept if it
is better than the current solution, or better than the solution from *L* iterations
ago. `L` around 5,000 is a reasonable start. Time-box the whole phase and keep the best
solution seen.

**Why this and not the alternatives:**

- **Why not integer programming.** The most relevant published case study — a real small
  college — produced an IP with ~170,000 rows and columns, needing **4–24 hours** with a
  commercial solver ([arXiv:1612.08777](https://arxiv.org/abs/1612.08777)). That is a
  licence cost and an overnight batch job for a timetable a curriculum manager wants to
  iterate on over a coffee.
- **Why not a genetic algorithm.** GAs are weak at *feasibility*, which is most of this
  problem: crossover routinely produces timetables with two lectures in one room, so the
  work moves into repair operators and fitness tuning. And the JS ecosystem offers
  nothing better than a 37-star weekend project (§2.5).
- **Why not CP-SAT via a Python sidecar — for version one.** It is the better solver and
  it is what I would choose for a bigger problem. It costs a second runtime, a second
  deploy target and a second failure mode on a platform that today runs one Node web
  service (§1.6). It also makes §3(d) harder: CP-SAT's answer to an over-constrained
  problem is "INFEASIBLE", which is not a sentence anyone can act on, and extracting a
  human-readable reason takes real extra work. **Keep it as the escape hatch** — see
  phase 4 in §3(e) — and keep the problem model serialisable from day one so switching
  is a swap, not a rewrite.
- **Why not [`or-tools-wasm`](https://www.npmjs.com/package/or-tools-wasm).** It would
  give CP-SAT in-process with no second runtime, which is genuinely attractive. But it
  was first published in **May 2026**, is pre-1.0, has ~55 stars and one maintainer, and
  is a fork of a 15,000-commit Google C++ project. That is not a dependency to put under
  a multi-tenant production platform this year.
- **Why not Timefold.** Best domain model in the field and its school-timetabling
  quickstart is almost exactly this problem — but it is a JVM sidecar, a heavier
  operational footprint than the Python one, for the same objection.
- **Why LAHC over simulated annealing or tabu search.** SA gets the best published
  results but needs a cooling schedule tuned to the instance; tabu needs neighbourhood
  and tenure tuning. **This is a multi-tenant product — nobody is going to tune a cooling
  schedule per college.** LAHC has one parameter, and it is *scale-independent*: it does
  not care about the magnitude of the objective, so it "does not need to be tuned on an
  instance-specific basis" ([Burke & Bykov](https://www.sciencedirect.com/science/article/abs/pii/S0377221716305495)),
  and there is a [parameter-less variant](https://dl.acm.org/doi/10.1145/3071178.3071225)
  if even one parameter is too many. It is also about thirty lines of code.
- **Why write it rather than buy it.** Because we own the scoring function, §3(d) becomes
  nearly free: "why was this slot chosen" is a read of the score terms, and "why could
  this not be placed" is a read of which resource was exhausted. With a third-party
  solver both of those are projects in themselves.

**This must be a background job. Say so plainly.**

- FET's own guidance for a comparable engine: seconds to 5 minutes for easy instances,
  **5–20 minutes typical**, hours for hard ones ([FET](https://lalescu.ro/liviu/fet/)).
- ITC-2007 gave entrants about ten minutes per instance, and the organisers noted longer
  would have been reasonable.
- Timefold's own school-timetabling quickstart runs solves on a background thread pool
  specifically to avoid HTTP timeouts.

Concretely:

- `POST /api/timetable/generate` creates a `TimetableRun` row (`queued`) and returns
  immediately with its id. It never holds the request open.
- A `worker_threads` Worker runs the solve. **Not the main thread** — a CPU-bound loop
  there blocks every request for every tenant for its whole duration (§1.6).
- The worker writes progress and a best-so-far score; the client polls.
- A hard time cap, default 60 seconds for a single course, configurable up to 10 minutes
  for a whole-college run. Always return the best solution found, never nothing.
- **The free Render plan is not adequate for this.** It sleeps after 15 minutes idle and
  gives one shared instance. This needs at least the `starter` plan, and if whole-college
  runs become routine, a separate worker service.

Rough budget, and it is a *budget*, not a measurement (§2.6): 400 sessions × 40 periods
× 20 rooms is a search space of the same order as ITC-2007's mid-sized instances. Each
LAHC move should touch fewer than a dozen constraint checks if scoring is incremental,
which puts JS in the range of a few million moves per minute. That should be ample.
**Verify with a spike before committing to phase 3.**

### (d) How humans stay in control

This section is not optional polish. [TimeTabler](https://www.timetabler.com/timetabler/)
has sold semi-automatic timetabling into 80+ countries on the explicit argument that
human judgment must "solve the unique problems that are an inevitable part of the
scheduling process". Build the black box and it will be rejected.

**1. Draft versions, not a boolean.** Today `published` is one flag per row. A generated
timetable needs to exist *alongside* the live one. Add a `TimetableVersion` (status
`draft` / `published` / `archived`, plus who generated it and from which run) and give
`TimetableSlot` a `versionId`. Publishing promotes a version and archives the previous
one, so rollback is a row update rather than a restore.

**2. Preview before publish.** A week-grid view of the draft — the current flat
day-grouped table is not enough to judge a timetable by. Beside it, a **diff against the
live version**: moved, added, removed, unchanged, colour-coded, with a count. Nobody
should publish without seeing "37 sessions unchanged, 9 moved, 2 new".

**3. Locking.** A `locked Boolean` on the slot. A locked session is **input, not output**:
it occupies its tutor, room and cohort, and the solver plans around it. This is
Timefold's *pinning*, and its own documentation describes exactly the migration path
we want — import the existing plan, "pin parts of it, so Timefold can score and optimize
around what the planner already trusts"
([Responding to change](https://docs.timefold.ai/timefold-solver/latest/responding-to-change/responding-to-change)).
Offer lock at three levels: one session, one tutor's whole timetable, one day.

**4. Show why a slot was chosen.** Because we own the scoring function this is a
by-product. For each placed session, store the soft-score terms it contributed to and
the best rejected alternative. Render it as a sentence:

> **Tue 10:00–13:00, Room 101 — Operational Planning (Amina Khan, cohort of 24)**
> Chosen because R101 is the smallest general teaching room seating 24 or more
> (2 seats spare). Amina's morning preference is met (−3). It follows the cohort's
> 09:00 session with no gap (−8 avoided).
> Next best was Mon 14:00, Room 203: +8 for a two-hour gap in the cohort's Monday,
> +4 for a second room for this unit.

Timefold formalises this as *constraint matches* and *indictments* — "which constraints
are broken and how many times, and which planning entities are responsible"
([Understanding the score](https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/understanding-the-score),
[Explainable AI guide](https://docs.timefold.ai/timefold-platform/latest/guides/validating-an-optimized-plan-with-explainable-ai)).
The same shape, produced from our own score terms.

**5. Report what could not be placed, and why.** Never a bare "infeasible". For each
unplaced session, record the *binding resource* and what would free it:

> **Business Analytics seminar (cohort of 28) could not be placed.**
> It needs an IT suite seating 28 or more. The only one is Room 12 (30 seats), which is
> occupied in all 12 periods the cohort attends.
> Freeing Wed 14:00 would place it — Room 12 currently holds Digital Skills, a cohort of
> 9, which would fit in Room 4.

That report is the difference between a tool people use and a tool people abandon.

**6. Re-running must not destroy manual edits.** Any hand edit to a generated slot sets
`manuallyEdited` and, by default, `locked`. On re-run, the dialog states the position
before doing anything:

> 12 sessions have been edited by hand since the last generation.
> ( • ) Keep them exactly as they are (recommended)
> (   ) Let the scheduler move them
> (   ) Show me the 12 first

Default: keep. Never silently overwrite; never silently preserve either — say which
happened.

**7. Everything through the audit log.** `AuditLog` (`schema.prisma:118`) already stores
`actorType`, `action`, `entity`, `entityId` and before/after JSON with secret redaction.
A generation run is `actorType: "system"`, a manual edit is the staff member. "Who moved
my Tuesday class" becomes answerable.

**8. Publishing stays deliberate.** The existing publish switch is the right shape and
should not change: build privately, review, release in one go. Add a "what changes for
students" summary on the publish confirmation — students already read these timetables
through `/api/student/me/timetable`, and a silent change to a published timetable is the
thing that generates complaints.

### (e) A phased plan

**Phase 0 — make the current feature honest.** *Days, not weeks. Do this regardless of
whether automatic generation ever happens.*

- Clash detection on save, and a conflict panel on the existing screen. Right now the
  system will cheerfully publish a tutor into two rooms at once (§1.3). This alone is
  worth more than most of what follows.
- Make the register generator skip bank holidays and non-teaching weeks —
  `bankHolidays.js` already exists and `TermCalendar.weeks` already marks the weeks.
- Add `staffId` to `TimetableSlot` alongside the free-text `lecturer`, so tutor clash
  detection is possible at all.
- Document `/api/timetable` in `API.md` and give it a smoke suite — `STATUS.md:320`
  records that it has neither.

**Phase 1 — the data model and manual allocation.** *Realistically 2–4 weeks, plus a
data-entry exercise by the college that nobody will enjoy.*

- `Room` (site, capacity, type, equipment, availability windows, blackout periods).
- `StaffAvailability` (recurring windows + one-off exceptions) and load limits on `Staff`.
- Teaching pattern on `Unit`: sessions per week, hours per session, room type required,
  delivery mode.
- `Cohort.expectedSize`, attendance days, earliest/latest, protected break.
- `Site` with a travel-time matrix. College closure days.
- Admin screens for all of it, and a **data-completeness screen** that lists what is
  missing and what the scheduler will assume in its place.
- Replace the free-text room and lecturer inputs with pickers.

Value on its own, with no solver: real clash detection across tutors, rooms *and*
cohorts; room utilisation reporting; an accurate answer to "what is Amina teaching this
week".

**Phase 2 — the scheduler, one course at a time.** *3–5 weeks.*

- `TimetableRun`, `TimetableVersion`, `locked` and `manuallyEdited` on the slot.
- The constructive phase only, in a `worker_threads` Worker. Hard constraints only,
  best-effort, with the full unplaced report from §3(d)(5).
- Preview, diff and publish-a-version.
- **The spike** from §2.6 belongs here: run it against the college's real data and
  measure before committing to phase 3.

This is the smallest genuinely useful version. A curriculum manager generates a feasible
draft for one course in seconds, sees what could not be placed and why, and fixes the
remainder by hand. That is a real day's work saved even with zero optimisation.

**Phase 3 — soft constraints and optimisation.** *2–4 weeks.*

- LAHC over the soft score, with per-tenant weights defaulting to §3(b).
- The "why this slot" explanation.
- Whole-college runs, longer time caps, and the paid Render plan they require.

**Phase 4 — only if the evidence demands it.** Swap the solver for CP-SAT (Python sidecar,
or `or-tools-wasm` if it has matured) behind the same model interface. Trigger: the
college's real constraint mix defeats the heuristic — persistent unplaced sessions that a
human can place by hand, which is the clearest signal that the search, not the data, is
the problem.

**Effort honesty.** Phase 0 is days. Phases 1–3 are realistically two to three months of
focused work for one developer, and phase 1 is the largest of the three. The solver is
perhaps 15% of the total. Anyone who estimates this from the algorithm will be badly out.

### (f) What will go wrong

**1. The data will not arrive, or will arrive wrong.** Room capacities will be
approximate, availability will be "ask me", and half the optional fields will be blank.
*What this design does:* every optional field has a stated default, and the
data-completeness screen names each assumption being made in the absence of real data.
The scheduler never silently guesses.

**2. "No solution" with no explanation.** The classic way these systems lose trust.
*What this design does:* the constructive phase places what it can and reports each
failure with its binding resource and a suggested fix (§3(d)(5)). And the hard/soft split
is configurable, because over-declaring hard constraints is the usual root cause — H4, H8
and H10 are switches for exactly this reason.

**3. People will not believe it.** A generated timetable that looks unfamiliar gets
rejected wholesale, even when it is better. *What this design does:* per-slot
explanations, a diff against the live timetable, and soft constraint S13 — minimise
change from what is currently published. Familiarity is a real requirement, not
sentimentality.

**4. It will be run too late to help.** Timetabling waits on curriculum decisions that
slip. Ellucian's account of UK institutions describes staff "re-entering the same
information into multiple systems", data fragmented across "module and course
information, staff availability, and room requirements", and decisions taken without
awareness of scheduling constraints, "forcing last-minute adjustments"
([Timetabling & curriculum planning in UK higher education](https://www.ellucian.com/en-gb/blog/timetabling-and-curriculum-planning-uk-higher-ed)).
*What this design does:* the data already lives in one system, and a run is cheap and
repeatable — so it can be run early against partial data and re-run as decisions land.

**5. The soft-constraint weights will be wrong for this college.** Weights tuned for a
daytime university are wrong for evening cohorts of working adults — and this college's
existing block ladder runs to 23:00, so that is the likely reality. *What this design
does:* weights are per-tenant configuration, expressed in the college's own words rather
than as numbers.

**6. Someone will edit the live timetable, re-run, and lose their work.** *What this
design does:* manual edits auto-lock, and the re-run dialog states the position before
acting (§3(d)(6)).

**7. Rooms are booked somewhere else too.** Events, exams, external hire. If the room
estate is managed in a second system, the scheduler will allocate rooms that are not
free. *What this design does:* room blackout windows in phase 1 — and an honest warning
that a two-system room estate will drift, and that the fix is one system, not better
software.

**8. Collecting tutor preferences creates an expectation of honouring them.** Ask
someone whether they prefer mornings and they will assume you meant it. *What this design
does:* show each tutor which of their preferences were met and which were not, and what
outranked them. An unmet preference with a reason is tolerable; an unmet preference with
silence is what generates a grievance.

**9. Gaps are the complaint you will actually receive.** Ellucian again, on the human
impact: "gaps between classes mean students often leave campus and don't attend", staff
scheduled into "distant buildings with no travel time", teaching "squeezed into
unsuitable rooms with the wrong equipment", and "an academic who doesn't work on a
Thursday but is scheduled for a full day". Every one of those is a specific constraint in
§3(b) — S2, H13, H9, H7 — and every one of them is a constraint that only works if
somebody entered the data in §3(a).

**10. The performance numbers in §3(c) are reasoned, not measured.** *What this design
does:* the spike sits in phase 2, before the optimisation work is committed to, and the
time cap means the worst case is a mediocre timetable rather than a hung server.

---

## 4. Bottom line

Build it in this order:

1. **Clash detection now**, with no solver at all. The system currently publishes
   double-bookings, and fixing that is days of work.
2. **The data model next**, and accept that it is the majority of the project.
3. **A constructive heuristic in a worker thread** that produces a feasible draft and a
   frank report of what it could not place.
4. **Optimisation last**, with LAHC and per-tenant weights.

Keep the problem model serialisable throughout, so that if the heuristic is out-argued by
the college's real constraints, moving to CP-SAT is a swap rather than a rewrite.

**The single biggest risk is not the algorithm — it is that the data in §3(a) never
arrives in usable form.** A scheduler with no room capacities, no staff availability and
no closure days will produce a confident, detailed, wrong timetable, and will be blamed
for it. Phase 1 exists to make that impossible: nothing is guessed silently, every
assumption is displayed, and the tool says what it does not know before it says what it
decided.
