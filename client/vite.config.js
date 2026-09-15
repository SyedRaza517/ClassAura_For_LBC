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

// The only hosts a build may be pointed at: the two APIs above, and nothing else.
//
// AN ALLOWLIST, AND IT REPLACED A LIST THAT NAMED THE WRONG HOSTS INSTEAD.
//
// The guard exists because client/.env.production once named an API built from a
// DIFFERENT repository, with its own database — so every production build of this
// client, and every packaged mobile app, called another product's server for days.
// Nothing written in this repo could ever appear there, which is exactly what "I
// deployed it and nothing changed" looks like from the outside. It was found by probing
// for a route only the new code had: /api/tags answered 404 on that host while
// /api/staff answered 401, so the API was alive and simply was not ours.
//
// The first version of this guard listed the two offending hosts BY NAME. That was
// worse in two ways. It wrote another project's identity into this repository, which is
// a link to something this codebase has nothing to do with; and it only ever caught the
// two mistakes already made, so a third wrong host would have sailed through. Derived
// from API above, the rule is "not one of ours" — which needs no maintenance and cannot
// go stale when a service is renamed.
//
// A build is the right place to catch this, because by the time a person notices they
// are usually holding a phone and blaming the feature.
const OUR_HOSTS = Object.values(API).map((u) => new URL(u).host);

/**
 * Is this URL one of this project's own APIs?
 *
 * COMPARES THE PARSED HOST, and that is the whole point of it. This was
 * `OUR_HOSTS.some((h) => url.includes(h))` — a substring test, which passes for any URL
 * that merely CONTAINS one of our hostnames anywhere in it:
 *
 *   https://edtech-xr8g.onrender.com.attacker.net/api   ← a different host entirely
 *   https://attacker.net/?x=edtech-xr8g.onrender.com    ← ours only in the query string
 *
 * Both would have built a client, and every packaged mobile app from it, pointing at
 * somebody else's server. This guard exists BECAUSE a build once shipped aimed at
 * another product's API for days; a check that can be walked past by appending a domain
 * suffix is not the guard the comment below claims it is.
 *
 * An unparseable URL is not ours either — `new URL` throws on one, and a build with a
 * malformed API URL is broken whatever was intended by it.
 */
function isOurApi(url) {
  try {
    return OUR_HOSTS.includes(new URL(url).host);
  } catch {
    return false;
  }
}

/**
 * Where a deployed build should point when nobody has said explicitly.
 *
 * Vercel sets VERCEL_GIT_COMMIT_REF to the branch being built, and this repo's two front
 * ends build from two branches — so the branch is the honest signal.
 *
 * An explicit VITE_API_URL wins, with ONE exception: a value that is not one of
 * OUR_HOSTS is overridden, because such a value cannot be an intention. It names a
 * server this repository does not build, so a build using it is broken whatever anybody
 * meant by it. See the reasoning in config() below.
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
      // is right here is that the value cannot be the intention: a host that is not one
      // of ours does not serve this product, so a build using it cannot work, and both
      // Vercel projects once carried the SAME wrong value. The alternatives were both
      // worse. Failing the build stops two deployments dead until someone edits a
      // dashboard. Honouring it ships a client that talks to another system and looks
      // broken rather than erroring — which is exactly how this went unnoticed for days.
      //
      // So: correct it, and say so loudly enough that the log makes the cause obvious.
      if (current && !isOurApi(current) && derived) {
        console.warn(
          `\n[api-url] VITE_API_URL is ${current}\n` +
          `[api-url]   that is not one of this project's APIs, so this build would not reach ours.\n` +
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

      // Still not one of ours at this point means config() could not substitute anything
      // — no VERCEL_GIT_COMMIT_REF, so this is a local or non-Vercel build and there is
      // no branch to infer from. Nothing correct is available to fall back to, so
      // failing is the only honest answer left.
      if (!isOurApi(url)) {
        throw new Error(
          `\n\nVITE_API_URL is ${url}, which is not one of this project's APIs.\n\n` +
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
  build: {
    rollupOptions: {
      output: {
        // Two named vendor chunks, and only two — this is a cache split, not a size
        // split. The size work is done by React.lazy in App.jsx (StaffHub, StudentApp)
        // and by on-demand imports (qrcode, pdfjs, jsQR); carving the app itself up
        // here would fight those boundaries rather than help them.
        //
        //   vendor-react   react + react-dom + scheduler. Needed before first paint
        //                  anyway, but it changes only when React is upgraded, so as
        //                  its own chunk it stays cached across every app deploy —
        //                  a returning user re-downloads our code, not React.
        //
        //   vendor-charts  recharts and the tree it drags in (victory-vendor's d3-*,
        //                  lodash, react-smooth…). Charts are used by two LAZY screens
        //                  (StaffHub and AdmissionTrackerPanels); without a name of
        //                  its own, rollup would duplicate-or-hoist this ~400 KB into
        //                  whichever chunk loads first. Named, it is fetched once, on
        //                  demand, by whichever of the two needs it first — and never
        //                  by the login screen, which is the regression this guards
        //                  against. Only async chunks reference it, so it stays async.
        //
        // Everything else in node_modules is left to rollup's own judgement: lucide
        // icons tree-shake to just the icons imported, and the capacitor plugins are
        // tiny — pinning them by hand is maintenance with no payoff.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "vendor-react";
          if (/[\\/]node_modules[\\/](recharts|victory-vendor|d3-[^\\/]+|lodash|react-smooth|fast-equals|recharts-scale|internmap|decimal\.js-light)[\\/]/.test(id)) return "vendor-charts";
        },
      },
    },
  },
});
