// The institution's colours and identity, for the whole client.
//
// WHY THESE ARE CSS VARIABLES AND NOT VALUES
//
// The brand colour appeared as the literal #1a3a8f in seventy-six places across
// nineteen files. Threading a colour from an API through nineteen files of props, or
// re-rendering all of them when it loads, is a great deal of machinery for something
// the browser already does: a CSS custom property set once on :root is seen by every
// element, in every component, including ones rendered inside a portal or a print
// stylesheet, with no React involved at all.
//
// So NAVY is no longer "#1a3a8f". It is "var(--brand-primary)" — a string that works
// unchanged everywhere a colour already worked: style objects, gradients, SVG fills.
// The files that used it need no other change, and applyBranding() below is the only
// place a real colour is ever written.
//
// WHAT IS DELIBERATELY *NOT* HERE
//
// Semantic colours. Sick leave, an "Absent" mark and a Fail grade are red because of
// what they MEAN, not because of who the college is. If an institution picks green as
// its accent, absence must not turn green — that would make the app lie about its own
// data to match a palette. Those stay as fixed literals where they are, and this file
// governs identity only: headers, primary buttons, links, gradients, the wordmark.

// --- the tokens every component uses ---
export const NAVY = "var(--brand-primary)";
export const NAVY_DARK = "var(--brand-primary-dark)";
export const MAROON = "var(--brand-accent)";
// Kept under their old names too, since Brand.jsx exported these.
export const BRAND_BLUE = "var(--brand-primary)";
export const BRAND_NAVY = "var(--brand-primary)";
export const BRAND_MAROON = "var(--brand-accent)";

// Neutral fallbacks, matching server/src/branding.js. Used only until the API answers,
// and on the rare path where it never does — an unbranded app is better than a
// colourless one, and better than one wearing another institution's colours.
const FALLBACK = { primaryColor: "#334155", accentColor: "#475569" };

/** Darken a hex colour by `amount` (0-1). Used for the gradient's deep end, which was
 *  a separately-hardcoded navy and is now derived, so a college sets ONE colour and
 *  the gradients follow rather than clashing. */
function darken(hex, amount = 0.28) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return FALLBACK.primaryColor;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  const f = (shift) => Math.max(0, Math.round(((n >> shift) & 255) * (1 - amount)));
  return "#" + [16, 8, 0].map((s) => f(s).toString(16).padStart(2, "0")).join("");
}

/** Readable text on a given background — white or near-black, by luminance.
 *  A college may legitimately pick a pale primary, and white-on-yellow is unreadable. */
export function readableOn(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return "#ffffff";
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.45 ? "#0f172a" : "#ffffff";
}

/**
 * Write an institution's colours onto :root. Everything styled with the tokens above
 * changes in the same frame, with no re-render.
 */
export function applyBranding(b) {
  if (typeof document === "undefined") return;
  const primary = b?.primaryColor || FALLBACK.primaryColor;
  const accent = b?.accentColor || FALLBACK.accentColor;
  const root = document.documentElement.style;
  root.setProperty("--brand-primary", primary);
  root.setProperty("--brand-primary-dark", darken(primary));
  root.setProperty("--brand-accent", accent);
  root.setProperty("--brand-accent-dark", darken(accent));
  root.setProperty("--brand-on-primary", readableOn(primary));
  root.setProperty("--brand-on-accent", readableOn(accent));
  // The browser tab colour on mobile, so the chrome matches the header.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", primary);
}

// --- the current institution's identity, for components that show it ---
//
// A plain module-level store rather than context: it is written once, read from
// nineteen files, and never changes during a session. Context here would mean
// wrapping the tree and re-rendering it for a value that has already settled.
let current = { ...FALLBACK, displayName: null, shortName: null, wordmarkTop: null, wordmarkSub: null, logoDataUri: null };
const listeners = new Set();

export const getBranding = () => current;

export function setBranding(b) {
  current = { ...current, ...(b || {}) };
  applyBranding(current);
  if (typeof document !== "undefined" && current.displayName) {
    document.title = current.displayName;
  }
  listeners.forEach((fn) => { try { fn(current); } catch { /* a bad listener must not stop the rest */ } });
}

export function onBranding(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Fetch this institution's branding and apply it.
 *
 * Failure is deliberately silent. Branding is decoration; if it cannot be loaded the
 * app must still start, sign people in and show their data — in the neutral palette.
 * An app that refuses to open because it does not know its own colours is worse than
 * an app that opens looking plain.
 */
export async function loadBranding(apiBase) {
  try {
    const res = await fetch(apiBase.replace(/\/$/, "") + "/branding", {
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return current;
    setBranding(await res.json());
  } catch {
    /* offline, or the endpoint is not deployed yet — keep the fallbacks */
  }
  return current;
}
