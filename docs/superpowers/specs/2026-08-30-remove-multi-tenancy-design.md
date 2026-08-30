# Removing multi-tenancy — design

**Date:** 2026-08-30
**Status:** approved to implement
**Decision:** every college gets its own deployment and its own database. The
platform stops being multi-tenant.

## Why, and what was rejected

The product is now sold as a separate deployment per institution. Three routes to
that were considered:

1. **Keep the schema, hide the tenant surface.** No migration, no data risk, the
   `db.js` guard stays. Rejected by the owner: the ongoing `runInTenant` tax on
   every scheduler, script and future feature is real, and the concept has to be
   learned by anyone reading the code.
2. **Remove `Tenant` entirely; move configuration to env vars and a new Settings
   table.** Rejected: it means rewriting all five per-tenant config modules to
   arrive at a singleton, which is what one `Tenant` row already is. More work,
   more risk, no functional difference.
3. **Leave the columns, delete only the enforcement.** Rejected: the columns are
   NOT NULL, so every `create` must still supply `tenantId`. Keeps the tax, loses
   the guard.

**Chosen: keep `Tenant` as the institution's settings row; drop `tenantId` from
the other 61 models.**

## The pre-flight fact this rests on

`tenantId` is half of **18 unique constraints** — `[tenantId, studentRef]`,
`[tenantId, email]` on both Student and Staff, `[tenantId, moodleUserId]`,
`[tenantId, name]`, and `@@unique([tenantId])` on the config tables. Dropping the
column turns each into a plain unique.

With more than one institution holding data, that is not merely risky:

* the migration **fails** wherever two colleges share a student number or email,
  and
* where it succeeds it **merges** them — every student, register and pastoral note
  from every institution lands in one pile, with the only record of who belonged to
  whom being the column just dropped.

The owner states this database has only ever held one college, and its contents are
test data. **The migration verifies that rather than trusting it**: it raises before
any destructive statement if `Tenant` holds more than one row. Postgres runs the
migration in a transaction, so a failure leaves nothing half-applied. The remedy is
to delete the surplus tenants and re-run — never to weaken the guard.

## What `Tenant` becomes

It stops being a registry of institutions and becomes the single settings row for
*this* institution: branding, mail-from addresses, attendance bands, prediction
thresholds and AES-encrypted integration credentials. Every consumer —
`branding.js`, `integrationConfig.js`, `attendanceBandConfig.js`,
`prediction/settings.js`, `secrets.js` — keeps working unchanged, because a single
tenant row *is* a singleton settings table. This is the whole reason option 1 is
cheaper than option 2.

## Scope

### Spine (must be one coherent change; not parallelisable)

* `server/prisma/schema.prisma` — remove `tenantId` / `tenant` relation and
  `@@index([tenantId])` from 61 models; rewrite 18 compound uniques as plain
  uniques; remove `Tenant`'s back-relations. `Tenant` itself stays.
* One **new** migration directory. Existing directories are never renamed — a
  rename makes an applied migration look new, it re-runs, fails, and Prisma then
  refuses every later migration with P3009, which breaks the deploy build command.
* `server/src/db.js` — delete the `tenant-isolation` extension, `UNSCOPED_MODELS`,
  `TenantScopeError`, `runInTenant`, `crossTenant`; export a plain client.
* `server/src/tenant.js` (middleware), `server/src/eachTenant.js` — deleted; their
  callers call directly.
* `server/src/index.js` — remove `tenantMiddleware` and the mount ordering that
  existed only to place `/api/platform` and `/api/registrations` above it.
* `server/src/auth.js` — stop issuing and checking the `tid` claim. Tokens already
  in the wild keep working: the claim is ignored, not rejected, so nobody is
  logged out by the deploy.

### The platform-operator tier and college registration — removed

`PlatformAdmin` carries no `tenantId`, so the migration does not force this. It is
removed anyway because a tier defined as *above every institution* is incoherent
when there is one institution, and a second login kind is a security surface with
no remaining purpose. Deleted: `routes/platform.js`, `routes/registrations.js`,
`platformAuth.js`, the `PlatformAdmin` model, `client/src/PlatformDashboard.jsx`,
`client/src/platformApi.js`, `client/src/CollegeRegistration.jsx`, and the
`?platform` / `?register` entry points in `App.jsx`. Recoverable from git history
if a supplier-support login is wanted later.

### Downstream (parallelisable, disjoint file sets)

* **Call sites (12 files):** `audit.js`, `branding.js`, `integrationConfig.js`,
  `prediction/settings.js`, `routes/tags.js`, `usage.js` and the schedulers.
* **Smoke suites (21 files):** strip tenant setup and the `X-Tenant` header.
* **Client:** `api.js` (drop the `X-Tenant` header), `branding.js`, `Login.jsx`,
  `main.jsx` (`currentTenant`), `IntegrationSettings.jsx`, `StaffHub.jsx`,
  `AdminTimetablePlanner.jsx`, plus the deletions listed above.
* **Docs:** the tenancy sections of `CLAUDE.md`, `STATUS.md`, `API.md`.

## Tests that are deleted, and the coverage given up

`smoke-tenant-isolation.mjs`, `smoke-platform.mjs` and `smoke-registrations.mjs`
are **deleted, not adapted**. With no tenancy their assertions would pass while
discriminating nothing, which is the failure mode this repo has hit twice before
and which reads as coverage on the summary line.

Recorded honestly: this removes the only automated proof that one institution
cannot read another's data. That proof is no longer meaningful — but it is no
longer *available* either, and if the product ever becomes multi-tenant again,
these suites are the thing that has to come back first.

## Verification

1. The full suite runs green against local `edtech_dev` **before** the change, as a
   baseline. `DATABASE_URL` is always passed on the command line, never inherited
   from `server/.env`, which points at a live Supabase database.
2. After the change: `node --test "src/**/*.test.js"` from `server/`, then the full
   `npm test` against `edtech_dev`, then a client build.
3. Staging deploy, then probe a route only the new code has — 401 means mounted,
   404 means not deployed. `/api/health` answers 200 on any build and proves
   nothing.
4. Production only after staging is confirmed, and behind its own go-ahead.

## Order of work

The spine lands first because everything downstream depends on the API it
produces. Referral/department work — brainstormed separately and parked — waits
for this, so that its new table is not built with a `tenantId` that is removed a
week later.
