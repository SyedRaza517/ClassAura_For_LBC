/** @type {import('tailwindcss').Config} */
// Real Tailwind build, replacing the Play CDN. The CDN compiles styles in the
// browser at runtime, which needs an internet connection on every launch — fine
// for a local demo, fatal inside a packaged mobile app that must work offline.
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  // "class" since 13 Sep 2026, reversing the "media" choice below — the reasoning that
  // justified "media" ("there is no in-app toggle anywhere in this product") stopped
  // being true the day the student app grew an Appearance setting (More → Appearance,
  // src/student/theme.js). "media" cannot express "the phone is dark but the student
  // chose light": prefers-color-scheme belongs to the OS and a media query cannot be
  // overridden from JavaScript. With "class", dark:* only ever applies under a `.dark`
  // class on <html>, and theme.js is the ONE writer of that class — it resolves the
  // student's stored choice (system/light/dark) against prefers-color-scheme itself.
  // A useful side effect: the staff app never sets the class, so the stray dark:*
  // utilities on staff-reachable screens (TwoFactor, AdminLiveAttendance) can no longer
  // half-darken a shell that was never designed for it when the OS asks for dark —
  // the exact bug PhoneShell's darkCapable prop was added to stop.
  darkMode: "class",
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
