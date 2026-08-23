import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Refuse to produce a release build that points at localhost.
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
    configResolved(config) {
      // Only a real release build. `npm run build` for local preview keeps working
      // because that is what SKIP_API_URL_CHECK is for.
      if (process.env.SKIP_API_URL_CHECK === "1") return;
      const url = config.env?.VITE_API_URL || process.env.VITE_API_URL || "";
      if (!url || /localhost|127\.0\.0\.1/.test(url)) {
        throw new Error(
          `\n\nVITE_API_URL is "${url || "(unset)"}" — a build with this cannot reach the API from a phone.\n` +
          `Set it in client/.env.production (or the CI environment) to the deployed API, e.g.\n` +
          `  VITE_API_URL="https://edtech-hub-api.onrender.com/api"\n\n` +
          `To build against a local server on purpose, run with SKIP_API_URL_CHECK=1.\n`
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), requireProductionApiUrl()],
  server: { port: 5173 },
});
