---
name: diagnose-deploy
description: Use when a deploy may not have landed — new code is not appearing, a route 404s that should exist, migrate deploy fails with P3009, or someone asks "is this live yet?" or "did that deploy work?". Covers which of the two environments you are looking at and how to prove the answer rather than assume it.
---

# Did the deploy land?

## `/api/health` proves nothing

It answers 200 on *any* build. It tells you a server is up, not which code is running.
Do not use it to answer this question.

## Work out which environment first

There are two of everything, and they drift. `main` → staging, the `production` branch →
production. Two Render APIs, two Vercel frontends, **two databases in two Supabase
projects**. Staging and production are two environments, not two customers.

A fix applied by hand to one database is not applied to the other. If you fixed
something last week and the symptom is back, check whether you are looking at the other
environment.

## Then run the probe

`DEPLOY.md` §"First: prove whether the API actually deployed" has the commands. The
shape is:

- **401** — the route is mounted and asking for a token. The build is live.
- **404** — the route does not exist in the running build. It has not deployed.

Probe a route that **only the new code has**, and probe a known-existing route beside it
as a control. A 404 where you expect 401 is the whole diagnosis — do not read it as a
routing bug and start rewriting the router.

One caveat that has cost time before: under a guarded router the probe can answer 404
even when mounted, because the guard runs first. Pick a probe route that is not behind
a router allowlist, or accept the control comparison as the weaker evidence it is.

## If the deploy is failing rather than absent

Read `DEPLOY.md` §"When the API deploys but nothing changes" — it lists the three causes
in the order they actually occur. The first is the one that has happened twice:

**A renamed migration directory.** Prisma identifies a migration by directory name. Rename
one that has already been applied and it looks new, re-runs, hits "already exists", and
is recorded as failed — after which Prisma refuses *every* later migration with P3009.
Because `migrate:deploy` runs in the build command, every deploy then fails while the old
build keeps serving happily, so the only symptom is that new code never appears.

The remedy is `server/tools/resolve-failed-migration.js`, which reads the failed
migration's own SQL, checks every object it creates already exists, and only then marks
it applied — refusing otherwise. Read its header before running it. Do **not** reach
straight for `prisma migrate resolve --applied`: marking an un-applied migration as
applied leaves the database quietly short of a table, which surfaces days later as a
confusing runtime error.

Having fixed one database, **check the other one**. That is exactly how production was
left broken after staging was fixed on 25 Aug 2026.

## Things that look like a deploy problem and are not

- `render.yaml` only applies its settings when a service is **created**. Editing it does
  not move or reconfigure an existing service.
- A free-plan service asleep gives a slow first response, not a missing route.
- `migrate status` reports a known-noisy history drift warning on staging. Treat it as
  noise unless a migration actually fails.
