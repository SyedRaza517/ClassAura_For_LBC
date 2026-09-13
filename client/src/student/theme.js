import { useEffect, useState } from "react";

// The student app's appearance setting — "system" | "light" | "dark" — and the ONE
// place that writes the `.dark` class on <html> that every Tailwind dark:* utility
// and every `.dark`-scoped rule in index.css now keys off (darkMode:"class",
// tailwind.config.js explains the switch away from "media").
//
// Why this lives in src/student/ rather than beside branding.js at the top level:
// dark mode is a STUDENT-APP feature by explicit ruling (see PhoneShell.jsx's
// darkCapable comment — StaffHub was never designed against a dark palette). Keeping
// the module here, and applying the class only while StudentApp is mounted
// (useApplyTheme below, with removal in its cleanup), is what keeps that ruling true
// on the shared web origin too: a staff member signing in after a student on the same
// browser never inherits a `.dark` root class the student left behind.
//
// The preference is stored in localStorage rather than @capacitor/preferences: it is
// a per-device cosmetic choice, exactly like the seen-replies sets StudentApp already
// keeps there, and it must be readable synchronously at first paint — an async
// Preferences.get() would guarantee one wrongly-themed frame on every launch.

const KEY = "edtech_theme";
const EVT = "edtech:theme";

export function getThemePref() {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch (_) {
    return "system";
  }
}

export function setThemePref(pref) {
  try {
    // "system" is stored as an ABSENCE, not a third value — the default needs no row,
    // and a student who has never touched the setting stays indistinguishable from one
    // who chose to follow their phone, which is the honest reading of both.
    if (pref === "light" || pref === "dark") localStorage.setItem(KEY, pref);
    else localStorage.removeItem(KEY);
  } catch (_) { /* private mode — the choice just won't survive a relaunch */ }
  // Same-document broadcast so useApplyTheme (in StudentApp) and useThemePref (the
  // More screen's control) stay in step without threading state between them.
  // localStorage's own "storage" event only fires in OTHER documents, so it cannot
  // do this job.
  window.dispatchEvent(new CustomEvent(EVT));
}

const systemPrefersDark = () =>
  typeof window !== "undefined" &&
  !!window.matchMedia &&
  window.matchMedia("(prefers-color-scheme: dark)").matches;

// The stored choice resolved to the yes/no the root class needs.
export const resolveDark = (pref) => pref === "dark" || (pref === "system" && systemPrefersDark());

// Mounted ONCE, by StudentApp. Applies the class now, re-applies on every toggle and
// on every OS scheme change (which only matters while the choice is "system"), and —
// deliberately — REMOVES the class on unmount: StudentApp unmounting means logout,
// and whatever renders next (the login screen, or a staff session on the web) is
// light-only by design.
export function useApplyTheme() {
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => root.classList.toggle("dark", resolveDark(getThemePref()));
    apply();
    let mq;
    window.addEventListener(EVT, apply);
    if (window.matchMedia) {
      mq = window.matchMedia("(prefers-color-scheme: dark)");
      // addEventListener is not available on older Safari's MediaQueryList — the same
      // fallback pair StudentApp's status-bar effect already carries.
      if (mq.addEventListener) mq.addEventListener("change", apply); else mq.addListener(apply);
    }
    return () => {
      window.removeEventListener(EVT, apply);
      if (mq) { if (mq.removeEventListener) mq.removeEventListener("change", apply); else mq.removeListener(apply); }
      root.classList.remove("dark");
    };
  }, []);
}

// The current preference as React state, for the Appearance control on the More
// screen. Setting goes through setThemePref so the class flips in the same tick.
export function useThemePref() {
  const [pref, setPref] = useState(getThemePref);
  useEffect(() => {
    const sync = () => setPref(getThemePref());
    window.addEventListener(EVT, sync);
    return () => window.removeEventListener(EVT, sync);
  }, []);
  return [pref, setThemePref];
}
