---
name: add-config-table
description: Use when adding anything the college configures for itself — a new Settings screen, a threshold, branding, wording, an integration credential, an academic rule — or when adding a table that holds exactly one row per institution. Covers the singleton primary key, the atomic upsert, the allowlist and the cache.
---

# Adding a per-institution config table

## Decide this first: is it a setting, or a constant?

An administrator changes a setting from the Settings screen. **A value only changeable
by a deploy is not a setting** — so this does not become an environment variable, even
though there is now only one college. Configuration deliberately did not move to env
when multi-tenancy was removed.

If it genuinely is a platform constant, put it in code and stop here.

## The shape

> platform defaults in code → one JSON column merged over them → no row until the
> college edits something → an allowlist on the way out → a short cache invalidated on
> save.

`server/src/attendanceBandConfig.js` and `server/src/prediction/settings.js` are the
reference implementations. Read one before writing a new one.

## 1. Schema: the key is a constant, not a unique index

```prisma
model MyThingConfig {
  id        String   @id @default("singleton")
  data      Json?
  updatedBy String?
  updatedAt DateTime @updatedAt
}
```

There are nine tables of this shape already. `grep -c 'default("singleton")'
server/prisma/schema.prisma` is the count that is true; the prose in the rules has been
wrong about it before.

The constant key replaced `@@unique([tenantId])`, which used to be what stopped a second
row appearing. It is load-bearing, not decoration — see step 3.

## 2. Read with `findFirst`, never `findOrCreate`

```js
let row = null;
try {
  row = await prisma.myThingConfig.findFirst();
} catch {
  row = null; // table not migrated yet — the defaults are correct, not an error
}
```

A read that must not create a row should not be able to. The constant key is what
guarantees there is at most one row to find.

Re-validate on the way **out**, not only on the way in: a row can predate a rule or be
edited by hand in a console, and falling back to the defaults keeps the feature working
rather than failing on data nobody can see.

## 3. Save with `upsert` on the literal `"singleton"`

```js
await prisma.myThingConfig.upsert({
  where:  { id: "singleton" },
  update: data,
  create: { id: "singleton", ...data },
});
invalidate();
```

**Not find-then-create.** That is not atomic: two administrators saving at the same
moment both find nothing, both insert, and `findFirst` afterwards returns whichever row
the planner picks — the college's thresholds becoming a coin toss between two rows. The
constant key makes the second writer collide with the first instead.

For "reset to defaults", use `deleteMany({})` rather than `delete`: pressing Reset twice
is not an error (`delete` throws P2025 on a missing row), and the empty `where` also
catches a row created before the id became a constant.

## 4. Allowlist on the way out

```js
const PUBLIC_FIELDS = ["label", "threshold", "colour"];
```

Serialise through an allowlist, never a blocklist. `sAdmission` once stripped a fixed
list of secrets, so every column added afterwards shipped to the browser by default. A
column added tomorrow — an internal note, a "who last edited this" — stays private until
somebody publishes it deliberately.

If the value is a credential, encrypt at rest with `server/src/secrets.js` (AES-256-GCM)
and never return it to any client. `integrationConfig.js` holds the provider registry;
precedence is what the college saved through Settings, then `process.env`.

## 5. One cached slot, invalidated on save

```js
const TTL_MS = Number(process.env.MY_THING_CACHE_MS ?? 30_000);
let cached = null;                       // { value, at } | null — one slot, not a Map
const invalidate = () => { cached = null; };
```

Short, because an administrator who has just moved a threshold should see it take effect
while they are still looking at the screen. One slot rather than a `Map`: these were
keyed by tenant id when one process served every college, and a `Map` that only ever
holds one entry is not a `Map`.

The cache is in-process, like every rate limiter and lock in this codebase. Correct for
one Node process; a clustered deployment needs Redis. Say so in a comment — every other
one does.

## Before you finish

- If the feature emits figures into the prediction pipeline, they must be **nullable on
  both** `StudentPredictionCurrent` and `StudentPredictionHistory`, identically.
  `schema-contract.test.js` parses the schema and fails otherwise.
- Add a smoke suite in `scripts/`, weighted toward the negative assertions: who is
  refused, what never leaves the building. Prove it can fail before you keep it.
- If it needs an admin page, `ADMIN_PAGES` exists in **two** hand-maintained copies —
  `server/src/validate.js` and `client/src/StaffHub.jsx` — and they must stay in sync.
