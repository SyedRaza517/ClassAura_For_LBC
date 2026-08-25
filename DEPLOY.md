# Deployment guide — EdTech Hub

Four things ship: **API** (Render) → **Dashboard** (Vercel) → **Android** (Play) → **iOS** (App Store).
Database is already on **Supabase** (PostgreSQL, eu-north-1). Deploy in that order.

---

## 1. API — Render

The repo already contains **`render.yaml`** (a Blueprint) and Prisma is a runtime dependency, so:

1. Push this project to a **GitHub** repo.
2. Render → **New + → Blueprint** → pick the repo. It reads `render.yaml` and creates the service.
3. When prompted, paste these **secret** env vars (the non-secret ones are pre-filled):

   | Key | Value |
   |-----|-------|
   | `DATABASE_URL` | your Supabase **session-pooler** URL (from `server/.env`) |
   | `JWT_SECRET` | the long random secret from `server/.env` |
   | `CLIENT_URL` | your dashboard URL (fill after step 2), e.g. `https://edtech-hub.vercel.app` |
   | `CORS_ORIGINS` | `https://edtech-hub.vercel.app,capacitor://localhost,http://localhost` |
   | `SMTP_*`, `MAIL_FROM` | your email provider settings (optional) |

4. Deploy → note the URL, e.g. `https://edtech-hub-api.onrender.com`. That is your **API base**.
   - `NODE_ENV=production` and `JWT_EXPIRES=1d` are set for you.
   - Health check: `GET /api/health`.
   - Free plan sleeps after 15 min idle (cold start ~30s). Use **Starter ($7/mo)** for always-on.

> ⚠️ `CORS_ORIGINS` **must** include `capacitor://localhost` and `http://localhost` or the mobile apps can't call the API.

---

## 2. Dashboard — Vercel (serves admin + web staff app)

`client/vercel.json` is included (SPA rewrites).

1. Vercel → **Add New Project** → same repo.
2. **Root Directory** = `client` · Framework = **Vite** · Build = `npm run build` · Output = `dist`.
3. Env var: `VITE_API_URL = https://edtech-hub-api.onrender.com/api`  (API URL **+ `/api`**).
4. Deploy → e.g. `https://edtech-hub.vercel.app`.
5. Back in **Render**, set `CLIENT_URL` and `CORS_ORIGINS` to this URL → redeploy the API.

(Netlify alternative: base `client`, build `npm run build`, publish `dist`, add a `_redirects` file with `/*  /index.html  200`.)

---

## 3. Android — Google Play  (build on Windows ✅, $25 one-time)

1. `client/.env`: `VITE_API_URL=https://edtech-hub-api.onrender.com/api`
2. In `client/`:
   ```bash
   npm run build
   npx cap sync android
   npx cap open android
   ```
3. Android Studio → **Build → Generate Signed Bundle (.aab)** → create & **back up the keystore**.
4. Play Console → new app → upload `.aab` → listing + privacy + data-safety → submit.

## 4. iOS — App Store  (needs a **Mac + Xcode**, $99/yr)

1. Same `VITE_API_URL`, then in `client/`:
   ```bash
   npm run build
   npx cap sync ios
   npx cap open ios
   ```
2. Xcode → set Bundle ID + Team → **Product → Archive → Distribute → App Store Connect**.
3. App Store Connect → new app → screenshots + privacy → submit for review.

---

---

## When the API "deploys" but nothing changes

Both of the failures below are silent in the same way: the API keeps serving,
`/api/health` keeps answering `200`, and the only symptom is that new code never
appears. Between them they stopped every API deploy for a full day in August 2026
before anyone noticed.

### First: prove whether the API actually deployed

`/api/health` answers `200` on **any** build, so it tells you nothing about *which*
one. Probe a route that only the new code has, and compare it against one that has
always existed:

```bash
API=https://<your-api>.onrender.com/api
curl -s -o /dev/null -w '%{http_code}\n' $API/assessments      # control: expect 401
curl -s -o /dev/null -w '%{http_code}\n' $API/<new-route>      # expect 401 if deployed
```

- **401** — the route is mounted and asking for a token. The build is live.
- **404** — the route does not exist in the running build. It has not deployed.

A `404` where you expect `401` is the whole diagnosis. Do not read it as a routing bug.

### Cause 1 — a renamed migration directory

**Prisma identifies a migration by its DIRECTORY NAME.** Rename a directory that has
already been applied and Prisma sees an unfamiliar name, re-runs its SQL, hits
`already exists`, and records the migration as failed. From that point it refuses
**every** later migration. `render.yaml` runs `migrate:deploy` in `buildCommand`, and a
failing build command fails the build — correctly, because an API running against a
schema it does not match is worse. But the deploy silently stops happening.

Diagnose from the database, not the dashboard:

```sql
SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at;
```

One row with a null `finished_at` is the answer.

Before fixing it, **check that every object the failed migration creates already
exists** — table, columns, indexes, constraints. Marking a migration applied when it
was not skips a real schema change and leaves the database quietly short of a column,
which is a far worse problem than the one you are solving. Once verified:

```bash
cd server && npx prisma migrate resolve --applied <migration_name>
```

That writes one row in `_prisma_migrations`. It changes no schema and touches no
application data.

**The rule: never rename a migration directory once it has been applied anywhere.**
Tidy timestamp ordering is not worth a stopped pipeline. If two migrations need
reordering, leave them alone or write a new one.

### Cause 2 — the service is watching a different branch

This repo has two deploy branches: **`main`** (staging) and **`production`** (live).
`render.yaml` now names `branch: production` explicitly, but a Blueprint only applies
that when the service is **created** — editing this file does not move an existing
service. If pushes produce Vercel builds within seconds and no Render build at all,
check in the Render dashboard:

- **Settings → Build & Deploy → Branch** — is it the branch you are pushing?
- **Auto-Deploy** — is it still `Yes`?
- **Events** — did the last build fail, or was one never triggered?

A build that fails and a build that never starts look identical from outside.

### Cause 3 — the free plan is asleep

Render's free plan sleeps after 15 minutes idle and cold-starts in ~30s. That delays a
response; it does not prevent a deploy. If a route 404s consistently after several
minutes, it is one of the two causes above, not the cold start.

---

## Pre-launch checklist (before it's public)

- [ ] Change admin + staff passwords off the test values (in-app **Change password**, ≥8 chars).
- [ ] `NODE_ENV=production` on the API (set by `render.yaml`).
- [ ] `CORS_ORIGINS` locked to the real dashboard + capacitor origins.
- [ ] Privacy policy URL (both stores require it; in-app account deletion already exists).
- [ ] App icons + splash screens in the Capacitor `android/` and `ios/` projects.
- [ ] Rotate the Supabase DB password if it was ever shared.
