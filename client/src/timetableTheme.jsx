// The CELCAT look, in one place.
//
// TWO KINDS OF COLOUR LIVE IN THIS FILE, AND THE DIFFERENCE IS THE WHOLE POINT
//
// The grid colours — `cell`, `cellAlt`, `cellNow`, `grid`, `todayText`, `strip`,
// `rule` — are literal values read off the reference screenshots. They are not the
// college's identity; they are the *shape* of a CELCAT week. The pale blue wash with
// white gridlines is what makes an empty week read as a grid rather than as blank
// paper, and the blue "today" heading is a wayfinding cue, not a brand statement.
// Repainting those in an institution's colours would give a college with a red brand
// a red timetable grid, which is unreadable and was never what "match our colours"
// meant. They stay literal, deliberately.
//
// The CHROME — the application bar, the modal header bars, the primary action in
// them, the "today" dot in the mini month — is the opposite case. It used to be
// hardcoded too: a maroon bar (#7b2d56) and a dark green (#1b5e3a), read off the same
// screenshots, which were University of Westminster's CELCAT. That meant every
// college's timetable wore Westminster's colours while the rest of this client
// painted itself from `var(--brand-primary)`, so the timetable was the one screen
// where Settings → Branding did nothing. The old comment here called swapping them
// for the brand tokens "a five-line change that touches no layout". This is that
// change.
//
// WHY CSS VARIABLES RATHER THAN READING THE BRANDING STORE
//
// `branding.js` writes the college's colours onto `:root` as custom properties, so a
// string like "var(--brand-primary)" is a colour that is *already* correct in every
// style object, and re-resolves in the same frame when an administrator saves a new
// palette — no re-render, no subscription, no prop threaded through four components.
// The rejected alternative was to read `getBranding()` here and export real hex
// values: that snapshots the palette at module load, so the timetable would keep the
// old colour until a full reload, and every component importing `TT` would need an
// `onBranding` subscription to fix it. A CSS variable is the same fix for free.
//
// TEXT ON TOP OF IT IS DERIVED, NOT ASSUMED WHITE
//
// `barText` is `var(--brand-on-primary)`, which `branding.js` computes by luminance.
// A college may legitimately pick a pale primary, and white-on-pale-yellow is
// unreadable — the bar would be branded and illegible, which is worse than branded
// and wrong. `greenText` is the same value under the name the modal chrome wants; it
// exists so that `text-white` in the timetable modals has something correct to be
// replaced with.
export const TT = {
  // The application bar across the top. The same colour as every other header in the
  // app, because it IS the same kind of surface.
  bar: "var(--brand-primary)",
  barText: "var(--brand-on-primary)",
  // Modal header bars and the primary action in them. `--brand-primary-dark` is a
  // gentle 12% step rather than a different colour, so a hover still reads as the
  // college's colour; see the note on it in branding.js.
  green: "var(--brand-primary)",
  greenHover: "var(--brand-primary-dark)",
  greenText: "var(--brand-on-primary)",
  // Today, in the mini month calendar.
  todayRing: "var(--brand-primary)",
  // The event grid. Cells are a pale blue wash with white gridlines, which is what
  // makes an empty CELCAT week read as a grid rather than as blank paper. Literal on
  // purpose — see the header.
  cell: "#e4eef8",
  cellAlt: "#edf4fb",
  cellNow: "#bcd9f2",
  grid: "#c9d8e8",
  // Today's column heading.
  todayText: "#1976d2",
  // The sidebar and the toolbar strip.
  sidebar: "#ffffff",
  strip: "#eceff1",
  rule: "#dfe3e8",
};

export const OUTLINE =
  "w-full rounded border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none";
