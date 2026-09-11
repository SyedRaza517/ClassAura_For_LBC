## The database is the sharpest edge here

**`DATABASE_URL` in `server/.env` points at a live database, not a scratch copy.** The
smoke suites create, mutate and delete real rows, and `npm test` seeds fixtures. Check
where it points before running anything that migrates, seeds or tests.

`prisma/assertDisposable.js` guards this, but read its rules before relying on it — it
allows any database whose *name* looks disposable, which has not always matched the
database that actually was.

There are **two databases, in two Supabase projects**: staging and production. They
drift. When you fix one by hand, check the other.

**There is a local PostgreSQL on the development machine, and the whole suite runs
against it.** Two services are installed (`postgresql-x64-16`, `postgresql-x64-18`) and
16.13 answers on `127.0.0.1:5432` with the credentials `server/.env.example` documents.
This is the route to use:

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-nfc-tap
```

Create it once with `CREATE DATABASE edtech_dev`, then `npx prisma migrate deploy` with
the same URL. `edtech_dev` is safe on two counts at once — `localhost` is in
`LOCAL_HOSTS`, and `dev` matches the disposable-name regex.

**Always pass `DATABASE_URL` on the command line. Never let it fall through to
`server/.env`.**

An isolated **schema** in the remote database was previously documented here as the safe
fallback. It is not, and the reason matters: **`assertDisposable` parses only the host
and the database name — it never looks at `?schema=`.** So
`…/postgres?schema=smoketest` fails the guard exactly as `public` does, and the only way
past is `DESTRUCTIVE_DB_CONFIRM=postgres@<supabase-host>` — a token which, because the
schema is not part of it, equally authorises seeding straight over `public`. One dropped
query parameter between typing the token and running the command is the whole live
database. Use the local one.
