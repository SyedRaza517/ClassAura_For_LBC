// The CELCAT look, in one place.
//
// These are literal colours read off the reference screenshots, not the platform's
// brand tokens — the request was for the screens to match the pictures exactly.
//
// WHY THAT IS A TENSION WORTH KNOWING ABOUT
//
// Everything else in this client paints itself from `var(--brand-primary)` and
// friends, so a college that sets its own colours sees them everywhere. The maroon
// bar and green buttons below are ONE institution's palette (the reference
// screenshots are University of Westminster's CELCAT). Hardcoding them means every
// college's timetable looks like Westminster's.
//
// So they live here, named, in a single object rather than sprinkled through the
// components. Swapping this block for the brand tokens is then a five-line change
// that touches no layout — which is the difference between a decision that can be
// revisited and one that has to be excavated.
export const TT = {
  // The application bar across the top.
  bar: "#7b2d56",
  barText: "#ffffff",
  // Modal header bars and the primary action in them.
  green: "#1b5e3a",
  greenHover: "#164c30",
  // Today, in the mini month calendar.
  todayRing: "#14622f",
  // The event grid. Cells are a pale blue wash with white gridlines, which is what
  // makes an empty CELCAT week read as a grid rather than as blank paper.
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
