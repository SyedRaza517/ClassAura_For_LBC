/** @type {import('tailwindcss').Config} */
// Real Tailwind build, replacing the Play CDN. The CDN compiles styles in the
// browser at runtime, which needs an internet connection on every launch — fine
// for a local demo, fatal inside a packaged mobile app that must work offline.
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  // "media" rather than "class": there is no in-app toggle anywhere in this product —
  // dark mode has always meant "the OS/browser asked for it", via prefers-color-scheme.
  // A "class" strategy would need a switch to flip a root class, plus somewhere to
  // remember the choice, for a preference the OS already tracks. Task 6 (the student
  // app's visual kit) is what actually renders any dark:* variant this produces; staff
  // screens carry none yet, so this is a no-op for them until they do.
  darkMode: "media",
  theme: {
    extend: {
      colors: {
        navy: { DEFAULT: "#1a3a8f", dark: "#14306f" },
        maroon: "#9e1b32",
      },
      // Lets utilities respect the notch and home indicator, e.g. pt-safe.
      spacing: {
        "safe-top": "env(safe-area-inset-top)",
        "safe-bottom": "env(safe-area-inset-bottom)",
      },
    },
  },
  plugins: [],
};
