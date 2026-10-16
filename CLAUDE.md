# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A college management platform, sold as **one deployment per institution**: one server,
one database, one college. Three identity kinds exist and are enforced separately:
**staff**, **student** and **applicant**.

It was multi-tenant until 30 Aug 2026, and that matters more than a removed feature
usually would — see `.claude/rules/single-tenant-history.md`, because that history is
the reason for several conventions that otherwise look like overkill.

npm workspaces monorepo: `server/` (Express + Prisma + PostgreSQL), `client/` (React 18
+ Vite SPA, wrapped by Capacitor for iOS/Android), `scripts/` (test runner and suites).

Read `STATUS.md` first for what is actually built and what is not — it is maintained as
the honest map and is explicit about which claims are demonstrated versus code-read.
`API.md` is the endpoint reference.

## Commands

```bash
npm run dev                        # server + client together
npm test                           # unit tests, then every smoke suite (see below)
npm test -- smoke-invite           # one suite, matched on name

npm run --workspace client build   # the client build; also what Vercel runs
npm --workspace server run migrate:deploy   # forward-only migrations
npm --workspace server run generate         # prisma generate
```

Unit tests, from `server/`:

```bash
node --test "src/**/*.test.js"          # all of them
node --test src/prediction/engine.test.js  # one file
```

**Use the glob, not `node --test src/`.** Given a bare directory the runner walks into
`src/index.js`, which binds a port and starts the schedulers, and the run never
terminates.

`npm test` applies migrations, seeds fixtures, boots its own API on port 4010, runs
every `scripts/smoke-*.mjs` against it, and exits non-zero if any failed. `SKIP` reads
differently from `PASS` on purpose, so a switched-off feature stays visible instead of
counting as coverage.

Read `database-safety.md` before running any of the above: `npm test` seeds and mutates
whatever `DATABASE_URL` points at, and that has historically been a live database.

## Where the rest of this lives

The remaining guidance is in `.claude/rules/`, one file per topic. Rules **without**
`paths:` frontmatter load every session, the same as this file; the rest load when a
file matching their globs is read, so working in `server/src/prediction/` pulls in the
prediction rules and nothing else pulls them in.

| Rule | Loads |
| --- | --- |
| `database-safety.md` — DATABASE_URL is live; use the local Postgres | always |
| `conventions.md` — null≠zero, allowlist serialisers, in-process locks, dates are strings | always |
| `deployment.md` — main→staging, production→production; how to prove a deploy landed | always |
| `migrations.md` | `server/prisma/**`, `server/tools/**` |
| `single-tenant-history.md` — why the code still shows the tenancy that was removed | `server/src/**`, `client/src/**`, `scripts/**` |
| `access-control.md` — `requirePage`, the derived + hand-synced `ADMIN_PAGES`, `FUNCTION_DISABLED` | auth, validate, routes, `StaffHub.jsx` |
| `configuration.md` — the `default("singleton")` config-table pattern | schema, `*Config*.js`, settings routes |
| `prediction-tripwires.md` — `TRIP_*` codes, institution-wide probes, stored dates | `server/src/prediction/**` |
| `mitigating-circumstances.md` — the engine knows THAT, never WHY | prediction, mitigations, adjustments |
| `cohort-and-coverage.md` — hoisted probes, `registerCoverage`, figures vs codes | prediction, `attendance.js` |
| `workload-funding-vle.md` — the twelve `TRIP_` vocabularies, funding absence rules | prediction, `vle/**`, `moodle.js`, `slc.js` |
| `testing.md` — pure logic beside its tests, smoke suites weighted negative | `*.test.js`, `scripts/**` |

## Two things rules cannot do

**`.claude/hooks/guard-database.js` refuses, at the tool layer, any command that could
destroy a database nobody meant to touch.** Rules are context — the model reads them and
tries to comply, and there is no guarantee. The hook runs before the tool call and can
say no, which is why the database rule is enforced there and merely explained here. It
imports `prisma/assertDisposable.js` rather than restating its policy, extends that
policy to the routes assertDisposable never sees (`migrate dev`, `db push`, `studio`,
`psql`, the Supabase MCP tools), and additionally refuses any DB command that does not
carry `DATABASE_URL` inline. `node .claude/hooks/guard-database.test.js` proves both
halves: what it blocks, and what it must not block.

**`.claude/skills/` holds the procedures**, which load on demand rather than every
session: `run-tests` (safe runs, first-time setup, port collisions), `add-config-table`
(the singleton pattern end to end), `diagnose-deploy` (did it land, and which of the two
environments are you looking at). Longer reference material stays in `DEPLOY.md`,
`API.md` and `STATUS.md`; the skills route to it rather than restating it.

The house style described in `conventions.md` — explain WHY, at length, including why an
alternative was rejected — applies to these rule files too. When a rule stops being true,
correct it in place and say what it used to say; several of them already do, and that is
deliberate rather than stale text to tidy away.
