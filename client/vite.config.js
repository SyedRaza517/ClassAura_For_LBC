import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The EdTech APIs, both built from THIS repository.
//
//   production  service "EdTech" on Render, deploys from branch `production`
//   staging     service "edtech-staging-api" on Render, deploys from branch `main`
//
// Kept here rather than only in .env files because .env.production is gitignored: a
// clean clone has no copy of it, so without these a fresh CI build has nothing to fall
// back to but the localhost URL in .env, which is the failure the guard below exists
// to catch.
const API = {
  production: "https://edtech-xr8g.onrender.com/api",
  staging: "https://edtech-staging-api.onrender.com/api",
};

// Hosts a build must NEVER be pointed at, and why each one is here.
//
// lbc-staff-hub-api belongs to a DIFFERENT repository — SyedRaza517/lbc_staff_hub —
// with its own database. client/.env.production named it until 29 Aug 2026, so every
// production build of this client, and every packaged mobile app, was calling another
// product's API. Nothing written in this repo could ever appear there, which is exactly
// what "I deployed it and nothing changed" looks like from the outside.
//
// It was found by probing for a route only the new code has: /api/tags answered 404 on
// that host while /api/staff answered 401, so the API was alive and simply was not ours.
// A build is the right place to catch it, because by the time a person notices they are
// usually holding a phone and blaming the feature.
const FOREIGN_HOSTS = [
  { host: "lbc-staff-hub-api.onrender.com", belongsTo: "the separate lbc_staff_hub project" },
  { host: "edtech-hub-api.onrender.com", belongsTo: "a service that does not exist — render.yaml describes it, but nothing by that name was ever created" },
];

/**
 * Where a deployed build should point when nobody has said explicitly.
 *
 * Vercel sets VERCEL_GIT_COMMIT_REF to the branch being built, and this repo's two front
 * ends build from two branches — so the branch is the honest signal. An explicit
 * VITE_API_URL still wins, because a dashboard variable or a one-off CI override is
 * somebody stating an intention and this is only a default.
 */
function apiUrlForBranch() {
  const branch = process.env.VERCEL_GIT_COMMIT_REF || "";
  if (!branch) return "";
  return branch === "production" ? API.production : API.staging;
}

// Refuse to produce a release build that cannot reach the right API.
//
// VITE_API_URL lives in .env.production, which is gitignored, so a build from a clean
// clone (Vercel, a fresh machine, an Android CI) silently inherited the localhost URL
// from .env — and a packaged app then failed every request with nothing but "Load
// failed". That has already happened once on iOS. Better to break the build than to
// ship a store binary that cannot reach the server.
function requireProductionApiUrl() {
  return {
    name: "require-production-api-url",
    apply: "build",
    config() {
      // Supply the branch default BEFORE Vite resolves env, so a clean clone with no
      // .env.production still produces a working build instead of failing the check
      // below. Never overrides an explicit value.
      if (!process.env.VITE_API_URL) {
        const derived = apiUrlForBranch();
        if (derived) process.env.VITE_API_URL = derived;
      }
      return {};
    },
    configResolved(config) {
      // Only a real release build. `npm run build` for local preview keeps working
      // because that is what SKIP_API_URL_CHECK is for.
      if (process.env.SKIP_API_URL_CHECK === "1") return;
      const url = config.env?.VITE_API_URL || process.env.VITE_API_URL || "";

      if (!url || /localhost|127\.0\.0\.1/.test(url)) {
        throw new Error(
          `\n\nVITE_API_URL is "${url || "(unset)"}" — a build with this cannot reach the API from a phone.\n` +
          `Set it in client/.env.production (or the CI environment) to one of:\n` +
          `  production  ${API.production}\n` +
          `  staging     ${API.staging}\n\n` +
          `To build against a local server on purpose, run with SKIP_API_URL_CHECK=1.\n`
        );
      }

      // Pointing at the right kind of URL is not the same as pointing at OUR API. This
      // is the check that would have caught the lbc_staff_hub misconfiguration on the
      // day it was introduced rather than four days later.
      const foreign = FOREIGN_HOSTS.find((f) => url.includes(f.host));
      if (foreign) {
        throw new Error(
          `\n\nVITE_API_URL points at ${foreign.host}, which is ${foreign.belongsTo}.\n\n` +
          `That API is not built from this repository, so nothing written here will ever\n` +
          `appear in it — the app will look broken rather than error.\n\n` +
          `Use one of:\n` +
          `  production  ${API.production}\n` +
          `  staging     ${API.staging}\n\n` +
          `On Vercel this value comes from the project's Environment Variables, not from\n` +
          `client/.env.production, which is gitignored and never reaches the build.\n`
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), requireProductionApiUrl()],
  server: { port: 5173 },
});
