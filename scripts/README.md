# Tests

```bash
npm test                      # everything
npm test -- smoke-invite      # one suite (matches on name)
```

`npm test` applies migrations to `DATABASE_URL`, seeds the fixtures, starts its own
API on port 4010, runs every suite against it, and stops it again. Exit code is 0
only if every suite passed.

**`DATABASE_URL` must point at a throwaway database.** These suites are not
read-only — they create staff, submit leave, plant password-reset tokens and delete
accounts. Never point them at production. CI uses a per-run Postgres container.

Locally:

```bash
# one-off: create a scratch database
echo "CREATE DATABASE edtech_test;" | server/node_modules/.bin/prisma db execute \
  --url "postgresql://postgres:postgres@localhost:5432/postgres" --stdin

DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_test" npm test
```

To test a **deployed** API instead, set `API_URL` — the runner then skips starting
one. Only do that against a staging deployment, for the reason above.

## Results

`PASS` / `FAIL` are what they look like. `SKIP` means a suite found the feature it
covers switched off in this build and reported exit code 2, rather than failing or
quietly passing.

Currently skipped: **`smoke-signup-2fa`** (~35 of its assertions). Mandatory
two-factor enrolment is deliberately off — `TOTP_ENFORCED = false` in
`server/src/routes/auth.js`, and sign-up approval sets `mustSetupTotp: false`.
Setting `TOTP_ENFORCED = true` reactivates the whole suite with no changes to it.
That is a Critical item in the SaaS readiness plan (§2, MFA for privileged users),
so this skip is deferred work, not a decision to leave it off.

## The suites

| Suite | Covers |
|---|---|
| `smoke-account-deletion` | Self-service deletion: password, 2FA, typed confirmation, dependent records |
| `smoke-fixes` | Role scoping on `/staff`, adjustment/allowance validation, re-decision guard |
| `smoke-int-overflow` | Oversized numbers can't crash the API; the database refuses out-of-range values |
| `smoke-invite` | Admin-created accounts are unusable until activated |
| `smoke-password-reset` | Hashed single-use links, expiry, revocation, 2FA gating |
| `smoke-push` | Device registration and scoping |
| `smoke-push-transport` | The FCM transport, standing in for Google — no API or network needed |
| `smoke-security-regressions` | The defects found in the July 2026 sweep stay fixed |
| `smoke-signup-2fa` | Sign-up → approval → enrolment → verification → admin reset |

## Adding a suite

Drop `smoke-<name>.mjs` in this folder — the runner finds it automatically. It must:

- read its base URL from `process.env.API_URL`
- read the seeded accounts' password from `process.env.SEED_PASSWORD`
- take its database URL from `process.env.DATABASE_URL` if it touches Prisma directly
- `process.exit(1)` on failure, `2` to report itself skipped
- clean up what it creates, so it can run twice against the same database
