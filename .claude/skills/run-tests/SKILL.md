---
name: run-tests
description: Use when running this project's tests — the unit tests, one smoke suite, or the whole npm test run — or when setting up a machine to run them for the first time, or when a suite fails in a way that looks like the environment rather than the code (port already in use, database refuses, every suite SKIPs).
---

# Running the tests

## The one rule everything else follows from

`DATABASE_URL` on the command line, every time. Never let it fall through to
`server/.env` — that file has pointed at a live production database while `npm test`,
which seeds fixtures and deletes rows, sat one keystroke away.

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-nfc-tap
```

`.claude/hooks/guard-database.js` refuses these commands without an inline URL, so a
refusal here is the guard working, not a broken environment. It is the same policy
`server/prisma/assertDisposable.js` applies — `edtech_dev` passes on two counts at once:
`localhost` is in `LOCAL_HOSTS`, and `dev` matches the disposable-name pattern.

## First time on this machine

Two PostgreSQL services are installed (`postgresql-x64-16`, `postgresql-x64-18`);
16.13 answers on `127.0.0.1:5432` with the credentials in `server/.env.example`.

```bash
psql -U postgres -h localhost -c "CREATE DATABASE edtech_dev"
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npx prisma migrate deploy
```

Then the run above. `npm test` applies migrations, seeds fixtures, boots its own API on
port 4010, runs every `scripts/smoke-*.mjs` against it, and exits non-zero if any failed.

## Unit tests

From `server/`, and note the quotes:

```bash
node --test "src/**/*.test.js"           # all of them
node --test src/prediction/engine.test.js  # one file
```

**Never `node --test src/`.** Given a bare directory the runner walks into
`src/index.js`, which binds a port and starts the schedulers, and the run never
terminates. These need no database and no `DATABASE_URL`.

## Reading the result

`SKIP` is not `PASS`, and the difference is deliberate — a switched-off feature stays
visible instead of counting as coverage. A suite that SKIPs everything usually means a
missing integration credential, not a passing test.

## When it looks like the environment, not the code

**Two runs at once corrupt each other.** Both boot an API on port 4010 and seed the
same database; the symptom is unrelated suites failing in ways that do not reproduce.
`scripts/test.mjs` reads `TEST_PORT`, so give the second run its own port *and its own
database*:

```bash
TEST_PORT=4011 DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev2" npm test
```

**Before adding a regression test, prove it can fail.** Reintroduce the bug and confirm
the test catches it. Twice in recent work a test passed while discriminating nothing,
which is worse than no test — it reads as coverage on the summary line.
