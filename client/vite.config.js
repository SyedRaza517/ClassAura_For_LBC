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
 * ends build from two branches — so the branch is the honest signal.
 *
 * An explicit VITE_API_URL wins, with ONE exception: a value naming a host in
 * FOREIGN_HOSTS is overridden, because such a value cannot be an intention. Those hosts
 * belong to another product, so a build using one is broken whatever anybody meant by it.
 * See the reasoning in config() below.
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
      const derived = apiUrlForBranch();
      const current = process.env.VITE_API_URL || "";

      // Nothing set: supply the branch default, so a clean clone with no
      // .env.production still builds something that works rather than failing the
      // check below.
      if (!current && derived) {
        process.env.VITE_API_URL = derived;
        return {};
      }

      // Set, but set to an API that is not ours. OVERRIDE IT.
      //
      // This deliberately beats an explicit value, which is not a thing to do lightly —
      // a configured variable normally means somebody stated an intention. The reason it
      // is right here is that the value cannot be the intention: those hosts serve a
      // different product, so a build using one cannot work, and both Vercel projects
      // carried the SAME wrong value. The alternatives were both worse. Failing the
      // build stops two deployments dead until someone edits a dashboard. Honouring it
      // ships a client that talks to another system and looks broken rather than
      // erroring — which is exactly how this went unnoticed for days.
      //
      // So: correct it, and say so loudly enough that the log makes the cause obvious.
      const foreign = FOREIGN_HOSTS.find((f) => current.includes(f.host));
      if (foreign && derived) {
        console.warn(
          `\n[api-url] VITE_API_URL is ${current}\n` +
          `[api-url]   that host is ${foreign.belongsTo}, so this build would not reach our API.\n` +
          `[api-url]   Using ${derived} instead, chosen from branch "${process.env.VERCEL_GIT_COMMIT_REF}".\n` +
          `[api-url]   To silence this, remove VITE_API_URL from the Vercel project's\n` +
          `[api-url]   Environment Variables — the branch already decides correctly — or set it\n` +
          `[api-url]   to the URL above.\n`
        );
        process.env.VITE_API_URL = derived;
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

      // Still foreign at this point means config() could not substitute anything — no
      // VERCEL_GIT_COMMIT_REF, so this is a local or non-Vercel build and there is no
      // branch to infer from. Nothing correct is available to fall back to, so failing
      // is the only honest answer left.
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
