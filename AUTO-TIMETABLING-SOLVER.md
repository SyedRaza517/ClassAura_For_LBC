# Automatic timetabling — solver internals

Companion to `AUTO-TIMETABLING.md`. That document covers *what* to build and what data it
needs; this one specifies the inside of the solver. It takes DSATUR-then-LAHC-in-a-Worker as
settled and does not re-argue it.

Researched 24 August 2026. Sources at the end. **Every performance number here is an
operation count, not a measurement** — see §11.

---

## 0. The thing that changes the sizing

At our scale — ~600 sessions, 40 periods, 60 rooms, 80 tutors — the instance is **loose**.
600/40 = 15 sessions running concurrently against 60 rooms is 25% room utilisation.

**Rooms are not the binding resource. Cohorts are** (~40 cohorts × 15 sessions = 37.5%
occupancy of each cohort's week), with tutors second.

Three consequences run through everything below:

1. Feasibility will be easy; the constructive pass will rarely fail.
2. The real work is soft quality across a large flat landscape.
3. The "why couldn't this be placed" report will nearly always name a **cohort or a tutor**,
   not a room.

### The highest-leverage decision is not an algorithm

**Decompose the instance into connected components before solving.** Build a graph over
sessions with an edge wherever two share a tutor, a cohort, or a contended room-eligibility
set. Courses that share no staff and no specialist room are genuinely independent
subproblems.

Solving 8 components of 75 sessions instead of one of 600 is a superlinear win that no
metaheuristic tuning will match. It parallelises across Workers trivially, and it makes the
unplaced report local and comprehensible. It is roughly 60 lines of union-find.

---

## 1. Data structures

### 1.1 Shape

Flat typed arrays. No objects, no `Map`, no closures inside the loop. Identity is a dense
integer index assigned once at load; database cuids live in a lookup array used only at load
and report time.

Let `W = ceil(P / 32)`. Mon–Fri at 8 periods/day gives `P = 40`, `W = 2`. A six-day week with
evening teaching (72 periods) gives `W = 3`. **W is 2 or 3 for any real college** — which is
what makes the scheme work: a whole week's occupancy is two machine words.

```js
// mutable — the current solution
sessionPeriod : Int16Array(S)        // -1 = unplaced
sessionRoom   : Int16Array(S)

// mutable — occupancy, period-major
tutorBusy     : Uint32Array(T * W)   // bit p set => busy at period p
cohortBusy    : Uint32Array(C * W)
roomBusy      : Uint32Array(R * W)

// mutable — occupancy, ROOM-major (the second orientation)
roomFreeAtP   : Uint32Array(P * Wr)  // Wr = ceil(R/32)

// immutable, precomputed
sessionTutor  : Int16Array(S)
sessionCohort : Int16Array(S)
sessionUnit   : Int16Array(S)
allowedP      : Uint32Array(S * W)   // legal start periods
eligibleRoom  : Uint32Array(S * Wr)  // right type & capacity
```

### 1.2 The O(1) free test

```js
const w0 = p >> 5, bit = 1 << (p & 31);
const free =
  ((tutorBusy [sessionTutor [s] * W + w0] |
    cohortBusy[sessionCohort[s] * W + w0] |
    roomBusy  [r                * W + w0]) & bit) === 0;
```

Three L1 reads, two ORs, an AND, a compare — about six instructions.

The more useful primitive is the **whole-week** version, which is why a bitset beats a
boolean matrix:

```js
const t = sessionTutor[s] * W, c = sessionCohort[s] * W, a = s * W;
free0 = ~(tutorBusy[t]   | cohortBusy[c])   & allowedP[a];
free1 = ~(tutorBusy[t+1] | cohortBusy[c+1]) & allowedP[a+1];
```

Two words hold the session's entire period domain. `popcount(free0)+popcount(free1)` is the
DSATUR key. Iterate set bits with `31 - Math.clz32(x & -x)`, clearing as you go.

**Both orientations of room occupancy are needed** — "is room r free at p" (room-major) and
"is *any* eligible room free at p" (period-major, for domain sizing without looping 60
rooms):

```js
const pr = p * Wr, sr = s * Wr;
const any = (eligibleRoom[sr]   & roomFreeAtP[pr]) |
            (eligibleRoom[sr+1] & roomFreeAtP[pr+1]);
```

Keeping both in sync costs two extra bit flips per assignment. Without the second, every
domain-size computation becomes a 60-iteration loop and construction gets ~30× slower. This
is the single most defensible structural decision here.

### 1.3 Sessions longer than one period

Precompute a per-session footprint mask for each legal start; do not loop over periods. A
zero mask means "illegal start", so the day-boundary check is free.

**For v1, skip this entirely.** The existing system already uses four fixed 3-hour blocks
(10–13, 14–17, 17–20, 20–23). If a period *is* a block, every session is one period, duration
masks disappear, and the grid is 5×4 = 20 periods = `W = 1` — the whole week in one word.
Adopt the block model, ship it, add duration masks only when a college proves it needs a
finer grid. The cost of the general case is not memory, it is that every bug becomes two.

### 1.4 KNOWN LIMITATION — teaching weeks

A weekly grid assumes every session runs in every teaching week. **That is false the moment
two units share a room in non-overlapping weeks** — we will report a clash that isn't one and
refuse a placement that was fine, plausibly.

The fix is a one-line change of representation: replace bit-per-period with word-per-period
holding a **week mask**.

```js
tutorBusy : Uint32Array(T * P)   // [t*P+p] = bitmask of WEEKS busy at period p
free = (tutorBusy[t*P + p] & sessionWeeks[s]) === 0;   // still O(1)
```

A term is ≤ 15 teaching weeks, so one Uint32 covers it. Memory: 80×40 + 60×40 + 40×40 =
7,200 words = **28.8 KB**. Nothing.

What is lost is the word-parallel domain scan — 40 iterations instead of 2 ANDs, roughly 20×
on the hottest operation.

**Recommendation: ship v1 with period bitsets plus a hard validation rule that all sessions in
one solve share a week pattern**, which the `Term`/`TermCalendar` model already assumes.
Refuse to solve if violated rather than solving wrongly. Write the occupancy accessors as
four inlined helpers from day one so the upgrade is contained.

This is why the data request asks the department whether all units in a cohort run in the
same weeks. Day-release and roll-on/roll-off intakes are the usual cause.

### 1.5 Memory

| Structure | Bytes |
|---|---|
| `sessionPeriod`, `sessionRoom` | 2,400 |
| `tutorBusy` / `cohortBusy` / `roomBusy` / `roomFreeAtP` | 1,760 |
| Day aggregates (§3) | ~1,000 |
| **Total mutable state** | **~5 KB** |

**The entire mutable state fits in L1 cache (32 KB).** That is the whole performance story —
not the algorithm, the working set. Read-only tables (positional cost 96 KB, room cost 144 KB,
domains 9.6 KB) sit in L2 at ~250 KB. The LAHC history at `L = 50,000` is 200 KB, the largest
single allocation. **Under 1 MB per solve.**

### 1.6 JavaScript rules that matter

Not micro-optimisation — ignoring these costs an order of magnitude.

- **Zero allocation in the loop.** No object literals, no destructuring, no `{period, room}`
  move records, no per-iteration closures. A move is four Int32 locals. Every allocation is a
  future GC pause, and GC in a Worker turns "60 second budget" into "80, sometimes".
- **Monomorphic access only.** One plain object in the loop sends V8's inline caches
  megamorphic and property access becomes a hash lookup.
- **Integer scores, `Int32Array`, never floats.** Float deltas drift, the corruption assert
  (§3.4) fails spuriously, and LAHC's comparisons get noise in the last bits.
- **Batch the clock.** `Date.now()` every iteration shows up in a profile. Check every 1,024.
- **Transfer, don't serialise.** Ship into the Worker as `ArrayBuffer` via `transferList`.
  Forces the model flat, which is what makes "swap in CP-SAT later" credible.

---

## 2. The constructive pass

### 2.1 Ordering heuristics

Brélaz's DSATUR picks the vertex with the highest saturation degree. That does not transfer
directly — a session needs a period *and* a room, and rooms have their own constraints.

Rhyd Lewis generalises it for exactly this setting: order by **the fewest feasible
(period, room) places remaining in the current partial timetable**, which he notes "is
somewhat akin to the rule for selecting which node to colour next in Brélaz's classical
Dsatur algorithm... although this particular heuristic also takes the issue of room allocation
into account."

| | Session ordering |
|---|---|
| H1 | Fewest feasible places remaining *(primary)* |
| H2 | Conflicts with the most other sessions *(tie-break)* |
| H3 | Random *(final tie-break)* |

| | Place selection |
|---|---|
| H4 | The place fewest *other unplaced* sessions could use *(least-constraining-value)* |
| H5 | The place in the timeslot with the most sessions already in it *(packs the grid)* |
| H6 | Random |

H1 is **dynamic** — recomputed against the current partial solution. That is what makes it
DSATUR rather than Welsh–Powell, and it is where the cost is. H3/H6 being random is
deliberate: it is what makes restarts from different seeds useful.

### 2.2 The loop

```
construct(pinned, unplaced):
  # pinned sessions are already in the occupancy structures — input, not output
  domain[s] = domainSize(s) for each s in unplaced

  while unplaced not empty:
    s = argmin over unplaced of ( domain[s], -conflictDegree[s], rng() )   # H1,H2,H3
    if domain[s] == 0: handleDeadEnd(s); continue

    best = null
    for p in setBits(freeMask(s)):
      for r in setBits(eligibleRoom[s] & roomFreeAtP[p]):
        k = ( futureDamage(p, r),                      # H4
              -sessionsAtPeriod[p],                    # H5
              positionalCost[s][p] + roomCost[s][r],   # DEVIATION — see below
              rng() )                                  # H6
        if k < best.key: best = (p, r, k)

    assign(s, best.p, best.r)
    for each t in unplaced sharing a resource with s:  # incremental, not a full rescan
      domain[t] = domainSize(t)
```

**One deviation from Lewis.** He chases only feasibility, so his place selection ignores soft
cost. Add positional cost as a *third* key after H4 and H5. One table lookup, and the
constructive solution handed to LAHC is already reasonable rather than merely legal — which
matters because LAHC's convergence is dominated by how far it must travel and we are
time-boxed. **Do not promote it above H4.** Feasibility first, always: a pretty partial
timetable that strands the last twelve sessions is worthless.

**The incremental domain update is load-bearing.** Recomputing all 600 domains after every
placement is 360,000 domain computations. Only sessions sharing a tutor, cohort or contended
room can have changed — a few dozen. Keep a precomputed session list per resource. This turns
construction from ~30M operations into ~2M.

### 2.3 Domain size

```
domainSize(s):
  f0 = ~(tutorBusy[t]   | cohortBusy[c])   & allowedP[a]
  f1 = ~(tutorBusy[t+1] | cohortBusy[c+1]) & allowedP[a+1]
  n = 0
  for p in setBits(f0, f1):
    if (eligibleRoom[s*Wr] & roomFreeAtP[p*Wr]) | (eligibleRoom[s*Wr+1] & roomFreeAtP[p*Wr+1]): n++
  return n
```

This counts **periods with at least one room**, not (period, room) pairs. That is the right
key — 3 periods × 40 rooms is far more constrained than 20 periods × 2 rooms, and pair
counting gets it backwards. Use total pairs as an extra tie-break if wanted.

### 2.4 When nothing is feasible

This is where the "name the binding resource" promise is kept or broken. Four tiers:

**Tier 1 — bounded ejection chain.** For each feasible-but-occupied place, find the sessions
that would have to move. If exactly one, and it has somewhere else to go, swap. A depth-1
chain resolves the large majority of dead ends in a loose instance.

```
repair(s, maxDepth=2, budget=200):
  for (p, r) in placesBlockedOnlyBy(s):
    blockers = sessionsOccupying(p, r, s)
    if |blockers| == 1:
      b = blockers[0]; unassign(b); assign(s, p, r)
      if domainSize(b) > 0: assign(b, bestPlace(b)); return SUCCESS
      if maxDepth > 1 and repair(b, maxDepth-1, budget): return SUCCESS
      undo()
  return FAIL
```

**The budget is not optional** — without a cap this recursion will spend the entire time
budget on the last two sessions. Cap it **globally across the whole construction**, not per
session.

**Tier 2 — record and continue.** Never abort the run because one session failed. 597 of 600
placed with three explained failures is a good day's output; a bare "infeasible" is a lost
customer.

**Tier 3 — soften and retry, once.** If more than ~5% fail, the likely cause is an
over-declared hard constraint. Re-run with the configurable-hard constraints demoted to
heavily-weighted soft, and present it as a negotiation: *"Placing everything required
relaxing room capacity in 4 cases and one tutor's daily hour limit. Here is where."*

**Tier 4 — restart with a different seed.** Cheap (construction is sub-second) and effective,
because H3/H6 randomness means a different tie-break order can succeed. Three restarts, keep
the fewest unplaced. **Do this before Tier 3, not after.**

---

## 3. Score function and incremental evaluation

### 3.1 Weights

Start from ITC-2007 curriculum-based track — the only weights in this field calibrated against
a competition and then reused for fifteen years:

| ITC-2007 soft constraint | Weight |
|---|---|
| RoomCapacity | 1 (per student over) |
| MinimumWorkingDays | 5 (per day below minimum) |
| CurriculumCompactness | 2 (per isolated lecture) |
| RoomStability | 1 (per extra distinct room) |

Note the *ratios*. Our S1=10, S2=8, S6=4 is a 10:8:4 against ITC's 5:2:1 — we weight
compactness roughly 4× more heavily relative to spread. That is probably right for an FE
college with commuting students, but it is **a deliberate departure and recorded as one**.

Starting table:

| # | Constraint | Weight | Counted per |
|---|---|---|---|
| S1 | Unit's sessions on different days | 10 | day below minimum |
| S2 | Cohort day compact | 8 | **gap period**, not gap event |
| S3 | Lunch window not taught across | 8 | session |
| S4 | No single-session day for a cohort | 6 | day |
| S5 | No single-session day for a tutor | 5 | day |
| S6 | Room stability | 4 | distinct room beyond first |
| S7 | Tutor's preferred part of day | 3 | session |
| S8 | Tutor's preferred day off | 4 | day violated |
| S9 | Tutor gaps | 3 | gap period |
| S10 | Tutor on fewest days | 3 | day above minimum |
| S11 | Consecutive-hours cap | 5 | period above cap |
| S12 | Room capacity waste | 1 | **per 10 empty seats, capped** |
| S13 | Minimise change from published | 6 | moved session |
| S14 | Load spread across week | 2 | session above daily mean |

Two changes matter more than they look. **S2 per gap-period** rather than per gap-event is the
difference between treating a one-hour hole and a five-hour hole the same. **S12 bucketed**
stops a low-priority nicety dominating by sheer magnitude — per-seat at weight 1 makes a
60-seat room for 8 people cost 52, outranking a real gap. That is the classic weighted-sum
failure; guard every low-weight-high-count term this way.

Add a guard the table lacks: **cap any single constraint's contribution at ~25% of the running
score**, or one misconfigured constraint silently drives the whole search.

**Be clear-eyed: these weights are wrong.** Not approximately — wrong in ways that surface only
when a human looks at output. Their value is that they are adjustable and per-tenant. Expect
three rounds of "that looks awful, why?" and build the explanation tooling (§6) specifically
so those rounds are diagnosable.

### 3.2 The split that makes incremental evaluation easy

**Every soft constraint is either positional or aggregate.**

**Positional** — a pure function of `(session, period)` or `(session, room)`. S3, S7, S8, S12,
S13. Precompute into flat tables at load:

```js
posCost  : Int32Array(S * P)   // 96 KB
roomCost : Int32Array(S * R)   // 144 KB
```

Their contribution to any delta is **four reads and two subtractions**. Roughly half the
constraint list leaves the hot loop entirely.

**Aggregate** — S1, S2, S4, S5, S6, S9, S10, S11, S14. These need counters keyed so a move
touches very few:

```js
cohortDayMask : Uint16Array(C * D)   // periods used by cohort c on day d
tutorDayMask  : Uint16Array(T * D)
unitDayMask   : Uint8Array (U)
unitRoomCount : Uint8Array (U * R)
unitRoomDistinct : Uint8Array(U)
```

`cohortDayMask` holds one day, so a **whole day's compactness is one word, no loop**:

```js
function dayCost(mask) {
  if (mask === 0) return 0;
  const lo = 31 - Math.clz32(mask & -mask);
  const hi = 31 - Math.clz32(mask);
  return (hi - lo + 1) - popcount(mask);   // empty periods inside the span
}
```

Five operations total for the day. That is what makes S2 and S9 free.

### 3.3 The delta

Moving `s` from `(p1,r1)` to `(p2,r2)` affects: cohort on day(p1), cohort on day(p2), tutor on
day(p1), tutor on day(p2), unit's day mask, unit's room multiset. **Six aggregates regardless
of instance size.** That is the scalability claim.

**Do not hand-derive the closed form. Derive it by measurement:**

```
tryMove(s, p2, r2):
  dPos = posCost[s*P+p2] - posCost[s*P+p1] + roomCost[s*R+r2] - roomCost[s*R+r1]
  before = localScore(s, p1, p2)      # the 6 affected aggregates only
  applyMove(s, p1, r1, p2, r2)
  after  = localScore(s, p1, p2)
  delta = dPos + (after - before)
  if accept(delta): return delta
  undoMove(s, p1, r1, p2, r2)
  return null
```

Apply-measure-undo is slightly slower and dramatically less bug-prone, because before and
after go through identical code. The closed form for S2-across-a-day-boundary alone is the
kind of expression that is wrong for eight months.

**Cost:** full rescore ~10,000–50,000 operations; incremental move ~50. Roughly **500–1000×**,
and it scales with n. This is the difference between a solver that finishes and one that
doesn't.

### 3.4 The corruption guard — build this on day one

Incremental scoring is the largest source of silent solver bugs and the failure mode is
vicious: the delta drifts from truth, the search optimises a fantasy, and **there is no error
anywhere**. You get a plausible-looking bad timetable. You notice six weeks later when someone
asks why the solver "prefers" gaps.

```
if (ASSERT_MODE && (k & 0xFF) === 0) {
  const truth = fullRescore();
  if (truth !== runningScore)
    throw new ScoreCorruption(k, truth, runningScore, lastMove);
}
```

Gate on an env var, run it in every test, make the exception carry the breaking move. **This
one check will find more bugs than every other test combined.** Leave a cheap sampled version
(every 100,000th iteration) enabled *in production* and log a warning — the cost is nil and
the alternative is finding out from a customer.

Keep the score as two integers, `[hardViolations, softScore]`, compared lexicographically.
Hard stays zero in Phase 2 but carrying the field is what lets Tier 3 exist.

---

## 4. Late-acceptance hill climbing

### 4.1 Use the 2017 version, not the 2008 one

```
1  Initialise S, compute F
2  forall l in [0,L):  PHI[l] <- F
3  k <- 0;  S* <- S;  F* <- F
4  while not terminated:
5     S^ <- move(S);  compute F^
6     l <- k mod L
7     if F^ <= F  or  F^ < PHI[l]:  S <- S^;  F <- F^     # TWO clauses
8     if F < F*:  S* <- S;  F* <- F
9     if F < PHI[l]:  PHI[l] <- F                          # CONDITIONAL
10    k <- k + 1
11 return S*, F*
```

Four things people get wrong:

- **Line 7 has two clauses.** `F^ <= F` (hill climbing) **or** `F^ < PHI[l]` (late
  acceptance). Dropping the first is a common bug that cripples intensification.
- **Line 9 is conditional.** The 2008 version wrote unconditionally; the refinement stops the
  array degrading monotonically.
- **PHI is a circular buffer** indexed `k mod L` — no shifting. Unlike a tabu list, **large L
  costs nothing per iteration.** Make L a power of two and use `k & (L-1)`.
- **S\* is not S.** LAHC's current solution at termination is generally worse than its best.
  Track and return S\*. `.set()` into a preallocated pair of buffers — 2.4 KB memcpy, and
  improvements get rare fast.

### 4.2 Choosing L

**Runtime to convergence is roughly proportional to L.** `L = 1` is greedy hill climbing.

Burke and Bykov's own numbers: `L = 500` general-purpose across thirteen Toronto instances;
per-instance tuned, `L = 100` (Pur93) to `L = 120,000` (Hec92I) — a **1200× spread within one
problem class**, at 450–900 second runtimes.

So the "one scale-independent parameter" claim is about *the objective's magnitude*, not
instance difficulty. That is genuinely why it beats SA for a multi-tenant product where nobody
tunes anything. It is **not** independent of run length. Do not read "L around 5,000" as
instance-independent.

**Derive L from the time budget:**

```
run 200ms of LAHC with L = 1000, count moves -> rate
budget = timeCapMs - constructionMs - explainMs - 20% safety
L = clamp((rate * budget / 1000) / 25, 1000, 100000)
L = nextPowerOfTwo(L)
```

The divisor 25 is **extrapolated from Burke & Bykov's tuned pairs (ratios span ~20–50), not a
published rule.** Measure the knee: one instance at L in {1k, 5k, 20k, 100k} for a fixed 60
seconds, plot final score, calibrate once, hardcode.

Safe default while building: **L = 5,000.** It converges comfortably inside 60 seconds and
leaves quality on the table. That is the correct way to be wrong.

### 4.3 Moves

All moves must **preserve hard feasibility by construction** — reject at generation, never
propose-then-score. The bitsets make the check six instructions.

| Move | Cost | Build |
|---|---|---|
| **Relocate** — new (period, room) | 1 delta | 1st |
| **Room-only** — new room, same period | 1 delta, no day aggregates | 1st — nearly free, and the *only* move that improves S6/S12 without disturbing anything |
| **Swap** — exchange two sessions' places | 2 deltas | 2nd |
| **Kempe chain** | many | last, or never |

Starting mix — **these ratios have nothing behind them; instrument acceptance rate per type
and retune.** Expect room-only to accept far more often than this assumes.

```
45% relocate   25% room-only   25% swap   5% Kempe
```

**Biasing move selection is worth more than tuning the ratio.** Uniform session selection
wastes most iterations on sessions that are already fine. Weight by each session's current
cost contribution (Timefold's "indictment"): keep `sessionCost : Int32Array(S)`, sample by
prefix-sum + binary search. Two benefits — the search concentrates where the damage is, and
**the same array is the §6.1 explanation data, maintained for free.**

Keep 10–15% uniform-random regardless, or a zero-cost session will never move to let something
else in.

### 4.4 Kempe chains — defer them

The theory is clean: swapping a maximal alternating component between two periods cannot
create a pairwise conflict. **But we have rooms, and that breaks it.** A Kempe swap can leave
more sessions at p2 than eligible rooms, or a session with no room of its type. So the chain
must be followed by a bipartite matching at both periods — small but not free, and it fights
S6 (room stability), which is precisely a cross-period constraint that per-period matching
cannot see.

Build relocate, room-only and swap first, measure, and add Kempe only if the search visibly
stalls. At our utilisation it probably won't. If built, cap chain length at ~15 — unbounded
chains rewrite half the timetable in one move, which is slow and terrible for S13.

### 4.5 Where LAHC will disappoint us

Namazi et al. document a real failure mode: **LAHC can silently degenerate into plain hill
climbing.** When a new best is held for L consecutive iterations, conditional replacement
fills PHI entirely with that value, "thereby reducing diversity", and no worsening move is
ever accepted again. Small L is "quickly trapped"; large L avoids it but "the solution quality
can be poor if not enough time is allotted. This characteristic of LAHC makes it less useful
for applications in time-constrained systems where a high-quality solution must be found
quickly."

**We are a time-constrained system. That sentence is about us.**

Mitigations, in order:

1. **Log `distinct(PHI)` periodically.** If it collapses toward 1, we have the pathology and
   know it rather than guessing. Five lines, and it is the difference between tuning and
   superstition.
2. **Adopt DLAS's replacement rule** if it does collapse — track `max(PHI)` and a count N,
   replace on `F^ > PHI[l]` as well, recompute max when N hits zero.
3. **Restart from best-ever** with a fresh PHI after 3L idle iterations. Crude, cheap, works.

---

## 5. Termination, reproducibility, budget

### 5.1 Stopping

```
terminated =
     (now - start > timeCapMs)                      # safety net
  or (k > maxIterations)                            # reproducible cap
  or (idle > max(5*L, 0.02*k) and k > 10*L)         # convergence
```

The convergence rule follows Burke & Bykov's own retrospective: they used 50,000 idle moves
and admitted it wasn't enough — "sometimes 50000 idle moves were not sufficient for the
recognition of 'true' convergence. This number should probably be calculated as a percentage
of the total number of moves." So scale with both L and k. Check the clock every 1,024
iterations.

### 5.2 Reproducibility — and the trap

`Math.random()` cannot be seeded in V8. Use `sfc32` or `mulberry32`. Store the seed on the
`TimetableRun` row with a hash of the input snapshot and the solver version.

**Seeding is the easy half.** Determinism also requires:

- **Deterministic iteration order everywhere.** Never iterate an object keyed by cuid and rely
  on order. Sort by explicit id at load, assign dense indices, use only indices after.
  **Postgres does not guarantee row order without `ORDER BY`** — this is the most likely
  source of "same seed, different answer", and it presents as a solver bug.
- **Comparators returning 0 on genuine ties** leave order input-dependent even with a stable
  sort. Always terminate with an id tie-break.
- **Wall-clock termination destroys reproducibility.** Provide two modes: `maxMillis` for
  production, `maxIterations` for replay. Record the k actually reached, so support becomes
  "replay run 4471 with maxIterations = 3,918,442" and reproduces exactly.
- **Never use `Math.random()` anywhere in the module.** Lint for it.

### 5.3 Keeping a background job honest on a small host

- **Time caps:** 60s single course, 300s whole-college, hard ceiling 600s. Never unbounded.
- **The Worker must be killable.** Run id → Worker handle; `worker.terminate()` on cancel.
  It is abrupt and runs no cleanup, so **the parent owns the DB row** and writes the terminal
  status. Never trust the Worker to record its own death.
- **Watchdog on the parent:** `setTimeout(() => worker.terminate(), timeCap * 1.5)`. Both, not
  either — the parent's is what saves us when a bug puts the termination check in an
  unreachable branch.
- **Progress via throttled `postMessage`**, ~500ms. Per-iteration will dominate the profile.
- **Checkpoint the best solution every ~10s.** If the process dies at second 58 of 60 we still
  have something.
- **One run per tenant, and a global cap** — on the current single Render instance, one or
  two. A queue with a visible position. Otherwise four tenants clicking Generate saturate the
  box and every tenant's *web requests* slow down: Workers compete for CPU with the main
  thread.
- **Render's shared CPU:** a Worker does not get a free core, it is timesliced against request
  handlers. Throughput will be **worse and more variable than any local benchmark**.
  Calibrate on the deployment target or every published time estimate is optimistic.

---

## 6. Explainability

### 6.1 "Why is this session here?"

**Do not instrument the search. Explain the answer.**

Logging in a loop running millions of iterations is both a large slowdown and an enormous
volume of data describing a random walk. The user is not asking "what path did you take" —
they are asking **"is this a good place, and what else could it have been?"** That is a
property of the final solution, answerable by a deterministic post-pass.

```
explain(best):
  for each session s:
    terms[s] = s's contribution per constraint   # remove, rescore, reinstate — §3.3 reused
    alts = for each (p,r) free for s: (p, r, tryMove delta)   # apply, measure, undo
    keep best 3
```

Cost: 600 × 40 × ~30 ≈ 720,000 delta evaluations at ~50 ops ≈ 36M operations. **Under a
second, once, at the end of a 60-second run.** And it produces a *better* sentence than search
instrumentation would, because "next best was Mon 14:00, +8 for a two-hour gap" is a real
counterfactual rather than an artefact of visit order.

**Caveat that belongs in the UI:** alternatives are computed *ceteris paribus*. Moving this
session changes what is best for others. The explanation is locally exact and globally
approximate. Phrase it "moving this alone would cost…", not "this is the only option".
Users forgive a stated approximation and never forgive an unstated one.

### 6.2 "Why could this not be placed?"

**(a) Domain-elimination accounting — primary.** Walk every (period, room) pair and record why
each was rejected; the largest bucket is the binding resource by definition. 40 × 60 = 2,400
checks. **Microseconds.**

> **Business Analytics seminar (cohort of 28) could not be placed.**
> Of its 2,400 possible (time, room) combinations:
> - 1,900 — the cohort is already in another session
> - 480 — no IT suite seating 28+ is free
> - 20 — Amina Khan is unavailable
>
> The binding constraint is the cohort's own timetable, which is full in 33 of its 40 periods.

Note the two levels: count the pairs, **and** report the resource in its own terms, because
"1,900 pairs" means nothing to a curriculum manager. Record *all* failing constraints per
pair, not just the first, or the buckets are an artefact of check order.

**(b) Conflict-Based Statistics — supplement.** Domain accounting names the resource; CBS names
the specific competing sessions, ranked by persistence. Müller, Barták and Rudová's structure
is a hash table of counters: `CBS[Va=va -> Vb=vb] = c`, "the assignment Va=va caused c times a
hard conflict with the assignment Vb=vb in the past". It models no constraints at all, which
is what makes it cheap and general, and it stays sparse.

Populate during Tier 1 ejection repairs. Cap the table (evict low counters above ~50k) so a
pathological instance can't grow it unbounded. UniTime surfaces this two ways — by the
constraint causing problems and by the unassigned class, both naming "the class that caused
the unassignment", with a percentage threshold so the biggest problems come first. Copy that
two-view structure and the threshold.

### 6.3 Near-miss — the most valuable output

It is the only output that tells someone what to *do*, and it falls out of the domain
accounting almost free:

```
nearMisses(s):
  for each (p,r) failing ONLY on occupancy:
    blockers = conflicting sessions at (p,r)
    if |blockers| == 1 and blockers[0] has an alternative place:
      emit { free: blockers[0], from: (p,r), to: alt, cost: delta }
  sort by cost, take 3
```

Two properties make it good: it is **one step**, so it is comprehensible; and it only reports
moves it has **verified are possible**, because it checks the blocker's own domain.

> Freeing Wed 14:00 would place it — Room 12 currently holds Digital Skills, a cohort of 9,
> which would fit in Room 4.

Rank by the *soft* cost of the displacement. Offer it as a **one-click action**, not prose —
"Apply this fix" is worth ten paragraphs. Extend to two-blocker cases marked "two changes
needed". When nothing can be freed, say so: "no combination of moves places this; the cohort's
week is genuinely full" is a legitimate answer that points at the data, not the solver.

---

## 7. Re-running without destroying human edits

This is the **Minimal Perturbation Problem** (Müller, Rudová & Barták, PATAT 2005). Their
definitions transfer directly: a perturbation is a variable with a different value in the new
solution; an **input perturbation** is one forced by the changed problem. The objective is the
number of **additional** perturbations — "subtraction of the final number of perturbations and
the number of input perturbations."

That distinction is the useful one for the UI: changes forced by new data (a room closed, a
tutor left) are input perturbations and not the solver's fault; everything else is, and is
what we count and report.

| Tier | In move set? | Occupies resources? | Scored? | Use |
|---|---|---|---|---|
| **Hard-pinned** | No | Yes | Yes | Manual edits; genuinely fixed sessions |
| **Soft-pinned** | Yes | Yes | Yes + S13 | Everything from the previous published version |
| **Free** | Yes | Yes | Yes | New sessions |

**Pinning is a filter on move *generation*, not a constraint check.** Keep
`movable : Uint8Array(S)`, build a dense `movableIds` once, sample only from it. Generating
freely and rejecting during evaluation is invisible with 12 of 600 pinned — but a re-run
commonly has 400 of 600 pinned, and then two-thirds of the budget is wasted.

Hard-pinned sessions **still occupy resources and still contribute to the score**. Load them
into the bitsets and aggregates *before* construction. Their gaps still count against the
cohort; the solver just can't fix them by moving them.

Three additions to the re-run dialog:

1. **Classify before asking.** Distinguish manual edits, forced changes (room deleted, tutor
   left, hours changed) and unchanged. Forced changes cannot be preserved — say so rather than
   offering an option that will silently fail: "3 of your 12 manual edits can't be kept:
   Room 12 has been deleted."
2. **S13 applies to everything on a re-run**, not just edited sessions. Consider raising its
   weight (6 → 12) on re-runs, exposed as *"Prefer a familiar timetable / Prefer the best
   timetable"*. That single control is probably worth more user trust than any score
   improvement.
3. **Report perturbations in MPP vocabulary:** "41 unchanged, 12 pinned, 7 moved (3 forced by
   data changes, 4 chosen by the scheduler)." The four *chosen* are what a human will inspect,
   and each should carry its §6.1 explanation.

---

## 8. Testing a stochastic solver

Ranked by bugs-caught-per-hour.

1. **Score corruption assert** (§3.4). Every test with `ASSERT_MODE=1`. **Finds more bugs than
   everything below combined.** If only one thing gets built, build this.
2. **Move/undo round-trip, property-based** (`fast-check`). Apply, undo, assert state is
   **byte-identical** — hash over all buffers, not just the score. An asymmetric undo is the
   nastiest bug class here: it corrupts silently and only for *rejected* moves, so it presents
   as "the solver gets worse the longer it runs." One hour, category eliminated.
3. **Hard-constraint invariants, property-based.** No double-booking; every session placed
   exactly once or unplaced, never both, never neither; placements inside `allowedP` and
   `eligibleRoom`; pins honoured. **Also assert derived structures agree with ground truth** —
   recompute every bitset from `sessionPeriod`/`sessionRoom` and compare. Drift between the
   assignment arrays and the bitsets is the second-nastiest bug class.
4. **Determinism.** Same seed + input + version → identical solution hash, 20 times in CI,
   under `maxIterations` never `maxMillis`. This catches the §5.2 ordering traps.
5. **Constructed-optimum instances.** Generate a valid timetable, derive the instance, shuffle,
   solve. A zero-cost solution is known to exist. This catches what every invariant test
   misses: **the score function rewarding the wrong thing.** A solver can be perfectly correct
   and optimise beautifully toward a badly-specified objective.
6. **Provably-infeasible instances.** 11 sessions, one room, 10 periods. Assert one unplaced,
   run completes, and the diagnostic names the *room*.
7. **Golden instances with a score ratchet.** `score <= recorded * 1.02`. A ratchet, not
   equality — equality assertions on a stochastic solver are flaky by construction and get
   disabled within a month.
8. **Statistical quality — nightly, not per-commit.** 20 seeds × 5 instances, assert median and
   variance. Rising variance is an excellent early warning that the search has destabilised.
9. **Budget compliance.** A 5s cap returns under 7s. Catches unreachable termination checks and
   unbounded repair recursion.
10. **Instrumentation as a test artefact.** Emit moves/sec, acceptance per move type,
    `distinct(PHI)`, and the iteration the best was found at. If best-found-at is consistently
    in the first 5% of iterations, the time budget is wasted and **no correctness test would
    have told us.**

Use a **fixed arithmetic progression of seeds** (0, 1000, 2000…), not random ones — keeps
coverage, prevents cherry-picking, makes failures reproducible from the CI log alone.

---

## 9. Build order

| | What | Why here | Size |
|---|---|---|---|
| 1 | **Decomposition into connected components** | Superlinear win, ~60 lines, makes everything downstream smaller | S |
| 2 | **Data structures + full rescore + hard-constraint checker** | The checker IS Phase 0 clash detection — ships value with no solver | M |
| 3 | **Corruption assert + move/undo property test** | Before the incremental code exists, not after | S |
| 4 | **Constructive pass, H1–H6, no repair** | First real output. Feasible draft in under a second | M |
| 5 | **Domain diagnostics + near-miss** | Microseconds of compute; makes the constructive-only version *usable* | S |
| 6 | **Worker plumbing: run row, cancel, watchdog, progress, checkpoint** | Before runs get long | M |
| 7 | **Pinning, three tiers** | Before optimisation — it changes the move generator's shape | S |
| 8 | **Positional tables + aggregates + incremental delta** | The performance heart, guarded by #3 from line one | L |
| 9 | **LAHC, relocate + room-only, fixed L = 5000** | ~40 lines given #8 | S |
| 10 | **Ejection repair + restarts** | Only now — measure how often construction actually fails first | M |
| 11 | **Swap moves + cost-biased selection** | Biggest quality-per-hour win in the optimiser | S |
| 12 | **Post-hoc explanation pass** | Needs a good solution to be worth explaining | M |
| 13 | **L calibration + distinct(PHI) monitoring** | Requires real throughput from #9–11 | S |
| 14 | **CBS + golden instances + statistical CI** | Hardening | M |
| 15 | **Kempe, constraint softening, DLAS** | **Only on evidence.** Do not build speculatively | L |

**Items 1–7 give a genuinely useful product** — feasible drafts, honest failure reports,
pinning, and clash detection — **with no optimiser at all.** Everything from #8 is quality
improvement on something that already works.

---

## 10. Where this will disappoint us

1. **The weights will be wrong, and the score won't be the problem.** The first three
   timetables will be rejected for reasons not in §3.1 at all — "you can't put that cohort in
   the annexe on a Friday". A weighted sum of incommensurable objectives has no principled
   scale. *The §6.1 explanation is not a nice-to-have, it is the weight-debugging tool.*
2. **Incremental scoring will drift, silently.** §3.4 from the first commit, non-negotiable.
3. **LAHC degenerating to hill climbing** in a time-boxed run. Be prepared for the answer to be
   "our timetables are 6% worse than they could be" — and for it to be unclear whether that is
   LAHC's fault or the weights'.
4. **The weekly-grid lie about teaching weeks** (§1.4). Validate at load and *refuse to solve*
   rather than solving wrongly.
5. **Construction spending its whole budget on the last two sessions.** Global ejection budget;
   Tier 4 restart before Tier 1 deepening.
6. **Kempe chains and rooms do not compose.** Don't build it until forced.
7. **The explanation is locally true, globally approximate.** Say so in the UI.
8. **Shared-CPU Render throughput** is worse and more variable than anything measured locally,
   so the calibrated L is wrong in production. Calibrate at runtime, per run, from the 200ms
   burst. Never hardcode a laptop number.

---

## 11. What is unverified

- **Every throughput number here is an operation count, not a measurement.** "Under a second",
  "500–1000×", "millions of moves per minute" are arithmetic on instruction counts and cache
  behaviour. JavaScript has a way of being 5× slower than the arithmetic suggests, for reasons
  that only appear in a profile. **The spike must measure: moves/sec for relocate; moves/sec
  with the corruption assert on; construction wall-time on the college's real data.**
- **`L = expectedMoves / 25` is extrapolated** from ratios computed off Burke & Bykov's tuned
  pairs (span ~20–50), not something they state. Measure the knee.
- **The move-type ratios (45/25/25/5) have nothing behind them.**
- **DLAS is validated on TSP and QAP, not timetabling.** Its *diagnosis* of LAHC's failure mode
  is convincing and general; its *fix* being better for our problem is an inference.
- **UniTime's specific MPP quality-vs-perturbation figures were not verified** — the paper's
  structure and definitions were read, the results tables were not. Do not quote a ratio.
- Confidence is **highest on section 1** (mechanical, defensible line by line) and **lowest on
  section 3's weights** (honestly, a starting configuration dressed up as a design).
- **The whole design assumes the data in `AUTO-TIMETABLING.md` §3(a) arrives.** The algorithm
  is about 15% of this project, and none of the above matters if room capacities are guesses.

---

## Sources

- Burke & Bykov, *A Late Acceptance Strategy in Hill-Climbing for Exam Timetabling Problems*,
  PATAT 2008 — https://patatconference.org/patat2008/proceedings/Bykov-HC2a.pdf
- Burke & Bykov, *The late acceptance Hill-Climbing heuristic*, EJOR 258(1), 2017 (paywalled;
  pseudocode via DLAS below)
- Namazi, Sanderson, Newton, Polash & Sattar, *Diversified Late Acceptance Search*,
  arXiv:1806.09328 — https://arxiv.org/pdf/1806.09328 — LAHC 2017 pseudocode (Fig. 1), the
  degeneration failure mode, DLAS
- Bazargani & Lobo, *Parameter-less late acceptance hill-climbing*, GECCO 2017 —
  https://dl.acm.org/doi/10.1145/3071178.3071225
- Brélaz, *New methods to color the vertices of a graph*, CACM 22(4), 1979 — via
  https://en.wikipedia.org/wiki/DSatur
- Lewis, *Finding Feasible Timetables Using Graph-Based Techniques* —
  https://rhydlewis.eu/papers/FINDING_FEAS_USING_G_BASED.pdf — H1–H6, DSATUR with rooms
- Müller, Barták & Rudová, *Conflict-based Statistics*, EU/ME 2004 —
  https://www.unitime.org/papers/eume04.pdf
- UniTime help: Conflict-Based Statistics — https://help.unitime.org/conflict-based-statistics
- Müller, Rudová & Barták, *Minimal Perturbation Problem in Course Timetabling*, PATAT 2005 —
  https://www.unitime.org/papers/patat05.pdf
- Bettinelli, Cacchiani, Roberti & Toth, *An overview of curriculum-based course timetabling*,
  TOP 23, 2015 — https://link.springer.com/article/10.1007/s11750-015-0366-z
- Bonutti, De Cesco, Di Gaspero & Schaerf, *Benchmarking Curriculum-Based Course Timetabling*,
  PATAT 2008 — https://www.patatconference.org/patat2008/proceedings/Schaerf-WC1a.pdf — the
  ITC-2007 penalty weights (1/5/2/1)
- Timefold: score calculation performance —
  https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/performance
- Timefold: understanding the score —
  https://docs.timefold.ai/timefold-solver/latest/constraints-and-score/understanding-the-score
- Timefold: responding to change —
  https://docs.timefold.ai/timefold-solver/latest/responding-to-change/responding-to-change
