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

## Pre-launch checklist (before it's public)

- [ ] Change admin + staff passwords off the test values (in-app **Change password**, ≥8 chars).
- [ ] `NODE_ENV=production` on the API (set by `render.yaml`).
- [ ] `CORS_ORIGINS` locked to the real dashboard + capacitor origins.
- [ ] Privacy policy URL (both stores require it; in-app account deletion already exists).
- [ ] App icons + splash screens in the Capacitor `android/` and `ios/` projects.
- [ ] Rotate the Supabase DB password if it was ever shared.
