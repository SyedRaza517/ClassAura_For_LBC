// The student app's visual kit: section accents, the ONE attendance-band ladder, the
// (deliberately separate) grade ladder, attendance-status colours, and motion durations.
//
// Task 3 moved this file out of the old top-level StudentApp.jsx VERBATIM ("a later
// task rewrites the VALUES here"). This is that task. What changed and why:
//
//   FOUR SCALES BECAME TWO. The pre-refresh app had pctTone (90/75/60), gradeTone
//   (70/60/50), progressTone (its own On Track/Monitor/At Risk colours) and a fourth,
//   uncatalogued one: Home.jsx hand-rolled an inline 85/70 split for its "how are you
//   doing" banner. Three of those four were all answering the same question — "is this
//   student's ATTENDANCE good, middling or bad" — with three different cut-offs and
//   three different palettes that could (and did: see gradeTone's own comment below)
//   silently drift apart. They are now ONE ladder, attendanceTone(), fed by the
//   college's own configured bands rather than a number this file invented.
//
//   GRADES STAYED SEPARATE, on purpose. A 55% mark and a 55% attendance figure mean
//   opposite things — a bare pass, versus missing nearly half of teaching — and a
//   college's Distinction/Merit/Pass/Fail boundaries are not something Settings exposes
//   the way attendance bands are. Unifying them would make a change to one silently
//   repaint the other. gradeTone() is kept, fixed, and used by the Results screen only.
//
//   COLOURS ARE NOW ARBITRARY, so AA HAD TO BECOME ARITHMETIC. The old four scales were
//   hand-picked from Tailwind's own 50/700 pairs (bg-emerald-50 + text-emerald-700),
//   which are known to clear WCAG AA by construction. attendanceTone() draws its colour
//   from GET /student/me/attendance-bands — a hex a college typed into a form — so this
//   file can no longer trust a colour to be legible by eye. ensureContrast() below nudges
//   every colour this module hands out until it actually clears 4.5:1 against the surface
//   it will sit on, in BOTH colour schemes, rather than assuming any specific hex is safe.

import { readableOn } from "../../branding";

/* ============================== motion, as tokens ============================== */
// Named once so "fade in, press down, count up" reads as one language instead of four
// screens each inventing their own number. CSS (index.css's @layer utilities) and JS
// (useCountUp, Ring's stroke transition, the progress-bar fills below) both read these
// — CSS cannot `import` a JS module, so its keyframe durations are literal numbers kept
// in lockstep with this object by comment rather than by the compiler; JS callers import
// the constants directly, which is the half that can actually enforce it.
export const MOTION_MS = {
  entrance: 420,   // fade-up / slide-in — a card or row arriving on screen (index.css: edtech-fade-up/-slide-in)
  scaleIn: 360,    // scale-in — modals, rings, hero numbers (index.css: edtech-scale-in)
  pop: 340,        // pop — badges and counters (index.css: edtech-pop)
  bounce: 550,     // bounce-in — success ticks (index.css: edtech-bounce-in)
  press: 120,      // press — the tactile scale-down on tap (index.css: .press)
  countUp: 700,    // a headline number counting up to its value (useCountUp's default)
  ringFill: 1100,  // the attendance ring's stroke animating in (Ring.jsx)
  barFill: 1000,   // a progress bar's width animating in (Attendance.jsx, Results.jsx)
};

/* ============================== WCAG contrast helpers ============================== */
// A college's attendance-band colour is a hex this app has never seen before, so "does
// this text clear AA on this background" cannot be answered by eye the way it could for
// six literal Tailwind classes. These implement the same relative-luminance formula
// branding.js#readableOn uses (restated rather than imported: readableOn only returns a
// binary black/white choice for solid-fill button text, and this needs the numeric
// ratio itself, plus a colour NUDGED toward a target rather than replaced by it — the
// whole point is that the reader can still tell it is the college's green, just a green
// that reads on the surface behind it).
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return { r: 148, g: 163, b: 184 }; // slate-400 — a neutral fallback for a malformed colour
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function toHex({ r, g, b }) {
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}
function relLuminance({ r, g, b }) {
  const [R, G, B] = [r, g, b].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}
function contrastRatio(hexA, hexB) {
  const L1 = relLuminance(hexToRgb(hexA)), L2 = relLuminance(hexToRgb(hexB));
  const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}
function mixHex(hexA, hexB, t) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  return toHex({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
}
// Nudges `hex` toward black or white in small steps until it clears `minRatio` against
// `against`. Bottoms out at pure black/white, which always maximises contrast against
// any surface — so this can never fail to return a legible colour, only an increasingly
// desaturated one for a college that picked something pale.
function ensureContrast(hex, against, minRatio, dir) {
  if (contrastRatio(hex, against) >= minRatio) return hex;
  const target = dir === "darken" ? "#000000" : "#ffffff";
  for (let t = 0.05; t <= 1; t += 0.05) {
    const c = mixHex(hex, target, t);
    if (contrastRatio(c, against) >= minRatio) return c;
  }
  return target;
}

// The two card surfaces every primitive in this app actually paints text onto — a white
// card in light mode, a slate-800 card in dark mode (Card.jsx, ui/index.js consumers all
// carry `dark:bg-slate-800` after this task). Every AA check below is against ONE of
// these two, because that is genuinely where the text sits, not against the page
// background behind the card.
const LIGHT_SURFACE = "#ffffff";
const DARK_SURFACE = "#1e293b"; // slate-800

/**
 * Turn one arbitrary hex into a full light/dark tone pair, every value already proven
 * (not assumed) to clear 4.5:1 against the surface it is meant to sit on:
 *   colour    — the input, unchanged, for anything decorative (icons, rings, bars) that
 *               is not text and so is not held to a text contrast ratio.
 *   text      — `colour`, DARKENED only as far as needed to clear AA on a WHITE card.
 *   bg/soft/ring — light, low-alpha tints of `colour` for a white card's background,
 *               a big panel's background, and a ring border.
 *   textDark  — `colour`, LIGHTENED only as far as needed to clear AA on a slate-800
 *               card. This is the pair the AA spot-check below exists for: the SAME
 *               low-alpha tint that reads fine on white is close to invisible on a dark
 *               card, so dark mode needs both a richer tint and a lighter text colour.
 *   bgDark/softDark/ringDark — richer-alpha tints for the dark surface.
 *   on        — readable text for a SOLID fill of `colour` (white or near-black),
 *               reusing branding.js's own luminance test rather than a second one.
 */
export function toneFromColour(hex) {
  const c = hex || "#94a3b8"; // slate-400: the "not measurable / unknown" neutral
  return {
    colour: c,
    text: ensureContrast(c, LIGHT_SURFACE, 4.5, "darken"),
    bg: `${c}1f`,   // ~12% alpha
    soft: `${c}0f`, // ~6% alpha — behind a large Ring/panel
    ring: `${c}40`, // ~25% alpha
    textDark: ensureContrast(c, DARK_SURFACE, 4.5, "lighten"),
    bgDark: `${c}33`,   // ~20% alpha — a low-alpha tint this faint is the pair the worst-pair
    softDark: `${c}1f`, // ~12% alpha   spot check in the Task 6 report caught failing AA
    ringDark: `${c}59`, // ~35% alpha
    on: readableOn(c),
  };
}

/**
 * A `toneFromColour()` (or attendanceTone/gradeTone/progressTone, which all return the
 * same shape) result, spread into the CSS custom properties `.tone-soft`/`.tone-solid`
 * in index.css read. One helper rather than this seven-line object at every call site —
 * Action, HeroTile, Stat, StatusBar and the Attendance/Results/Reviews screens all need
 * the identical spread, and a hand-copied version in six places is six chances for one
 * of them to miss a property and silently fall back to the light-mode value in the dark.
 */
export function toneVars(tone) {
  return {
    "--tone": tone.colour,
    "--tone-bg": tone.bg,
    "--tone-bg-dark": tone.bgDark,
    // A second, paler alpha for a LARGE panel (HeroTile's card, the Attendance/Results
    // headline panel) — the same "soft" tint the old pctTone/gradeTone shape carried
    // alongside `bg`, for a background covering far more area than a small chip.
    "--tone-panel-bg": tone.soft,
    "--tone-panel-bg-dark": tone.softDark,
    "--tone-text": tone.text,
    "--tone-text-dark": tone.textDark,
    "--tone-ring": tone.ring,
    "--tone-ring-dark": tone.ringDark,
    "--tone-on": tone.on,
  };
}

/* ============================== section accents ============================== */
// Checked as an adjacent colour-blind-safe set (worst pair ΔE 16.4), so the four areas
// stay tellable apart for every reader — and each still carries its own icon and label,
// so colour is never the only signal. Values are UNCHANGED from the Task 3 move; only
// their dark-mode pair (ACCENT_TONE) is new.
export const ACCENT = { checkin: "#1a3a8f", attendance: "#4f46e5", results: "#0891b2", ask: "#be123c", timetable: "#0d7a5f", more: "#7c3aed" };
export const ACCENT_TONE = Object.fromEntries(Object.entries(ACCENT).map(([k, v]) => [k, toneFromColour(v)]));

/* ============================== the ONE attendance ladder ============================== */
// The starting bands EVERY college gets until it configures its own, mirrored from
// server/src/attendanceBands.js#DEFAULT_BANDS — mirrored rather than imported because
// that module is server-only CommonJS and cannot cross the client bundle boundary.
// scripts/smoke-attendance-bands.mjs is the seam that would catch the two drifting
// apart (it exercises the server copy directly); this comment is the client-side half
// of that guard. Kept minimal on purpose: the server's copy also carries `emailTrigger`,
// which the client never reads and so does not duplicate here.
export const DEFAULT_ATTENDANCE_BANDS = [
  { key: "excellent", label: "Excellent Attendance", min: 85, max: 100, colour: "#15803d" },
  { key: "great",     label: "Great Attendance",     min: 70, max: 84,  colour: "#0f766e" },
  { key: "good",      label: "Good Attendance",      min: 60, max: 69,  colour: "#2563eb" },
  { key: "average",   label: "Average / Monitor",    min: 50, max: 59,  colour: "#b45309" },
  { key: "risk",      label: "Risk Student",         min: 40, max: 49,  colour: "#c2410c" },
  { key: "highrisk",  label: "High Risk",            min: 0,  max: 39,  colour: "#b91c1c" },
];

/**
 * Resolve a percentage to its band, walking best -> worst and matching on the LOWER
 * bound only — the identical rule server/src/attendanceBands.js#bandForPct uses, and
 * for the identical reason: attendance percentages carry one decimal, so a student on
 * 69.5% satisfies neither `>= 70 && <= 84` nor `>= 60 && <= 69` under an inclusive test
 * and would silently land in no band at all.
 */
export function bandForPct(pct, bands) {
  if (pct == null) return null;
  const list = Array.isArray(bands) && bands.length ? bands : DEFAULT_ATTENDANCE_BANDS;
  return list.find((b) => pct >= b.min) || list[list.length - 1] || null;
}

/**
 * The ONE tone function for attendance percentages — replaces the old pctTone AND the
 * inline 85/70 split Home.jsx used to hand-roll for its own banner. `bands` is this
 * student's college's own configured ladder (GET /student/me/attendance-bands, fetched
 * once in the shell and defaulted to DEFAULT_ATTENDANCE_BANDS above until it answers);
 * every caller passes the same list down so the ring, the unit chips and the headline
 * banner can never disagree about where a boundary falls.
 */
export function attendanceTone(pct, bands) {
  if (pct == null) return { ...toneFromColour(null), label: null };
  const band = bandForPct(pct, bands);
  return { ...toneFromColour(band?.colour), label: band?.label ?? null };
}

/* ============================== grades (Results ONLY) ============================== */
// GRADE bands are NOT attendance bands, and this ladder is deliberately kept apart from
// attendanceTone above rather than folded into "the one ladder" — a 55% mark and a 55%
// attendance figure mean opposite things (a bare pass, versus missing nearly half of
// teaching), and unifying their colours would make a change to a college's attendance
// bands silently repaint every mark chip on the Results screen too. The 70/60/50
// boundaries are fixed program classification (Distinction/Merit/Pass/Fail), which this
// codebase does not expose in Settings the way attendance bands are — so, unlike
// attendanceTone, there is no `bands` argument here to be configurable with.
//
// This replaces the OLD gradeTone, whose own comment recorded the bug a narrower shape
// here caused ("a narrower shape here silently rendered `ring-1 undefined undefined
// undefined`"): toneFromColour's shape is now shared with attendanceTone by construction
// (both call the same function), so the two cannot drift apart the way pctTone and the
// old gradeTone once did.
const GRADE_BANDS = [
  { key: "distinction", label: "Distinction", min: 70, colour: "#059669" },
  { key: "merit",       label: "Merit",       min: 60, colour: "#2563eb" },
  { key: "pass",        label: "Pass",        min: 50, colour: "#b45309" },
  { key: "fail",        label: "Fail",        min: 0,  colour: "#9e1b32" },
];
export function gradeTone(p) {
  if (p == null) return { ...toneFromColour(null), label: null };
  const band = GRADE_BANDS.find((b) => p >= b.min) || GRADE_BANDS[GRADE_BANDS.length - 1];
  return { ...toneFromColour(band.colour), label: band.label };
}

/* ============================== a lecturer's progress review ============================== */
// Rebuilt on the SAME attendance ladder rather than its own hand-picked three colours —
// "On Track"/"Monitor"/"At Risk" is a qualitative call, not a percentage, so it cannot be
// resolved with bandForPct; instead it borrows the BEST, a MIDDLE, and the WORST band's
// colour from the college's own ladder by rank. This is what rule 2 means by "replaced by
// the one ladder": the review screen's "is this student doing okay" signal now comes from
// the exact same palette as the attendance screen's, instead of a fourth palette that
// could (and did) say something different about the same shade of amber.
export function progressTone(progress, bands) {
  const list = Array.isArray(bands) && bands.length ? bands : DEFAULT_ATTENDANCE_BANDS;
  const pick =
    progress === "On Track" ? list[0]
      : progress === "At Risk" ? list[list.length - 1]
        : progress === "Monitor" ? list[Math.min(list.length - 1, Math.floor(list.length / 2))]
          : null;
  return pick ? { ...toneFromColour(pick.colour), label: progress } : { ...toneFromColour(null), label: progress || null };
}

/* ============================== attendance statuses (P/L/E/A) ============================== */
// These are STATUS colours, not a ladder — always shown with the letter and the word
// beside them, never colour alone. The four were checked for colour-blind separation as
// an adjacent set; "Late" is orange (not amber) because amber sat too close to the green
// of "Present" under protanopia. UNCHANGED from the Task 3 move; `tone` is the new
// light/dark pair each caller now reads instead of building its own inline alpha string.
export const ATT = [
  { key: "P", label: "Present", colour: "#059669" },
  { key: "L", label: "Late", colour: "#ea580c" },
  { key: "E", label: "Excused", colour: "#7c3aed" },
  { key: "A", label: "Absent", colour: "#e11d48" },
].map((a) => ({ ...a, tone: toneFromColour(a.colour) }));
