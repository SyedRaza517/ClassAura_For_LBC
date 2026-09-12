// Moved verbatim out of the old top-level StudentApp.jsx as part of the mechanical
// split (Task 3 of the student-app refresh) — MARKUP UNCHANGED, this is a pure file
// move. A later task rewrites the VALUES here; call sites keep importing from this
// module so that rewrite touches one file instead of every screen.

// Section accents. Checked as an adjacent colour-blind-safe set (worst pair ΔE 16.4),
// so the four areas stay tellable apart for every reader — and each still carries its
// own icon and label, so colour is never the only signal.
export const ACCENT = { checkin: "#1a3a8f", attendance: "#4f46e5", results: "#0891b2", ask: "#be123c", timetable: "#0d7a5f", more: "#7c3aed" };

// Attendance/grade bands. Four steps rather than three, so "nearly there" reads
// differently from "needs attention" instead of both being flat red.
export const pctTone = (p) => p == null ? { bg: "bg-slate-100", text: "text-slate-400", colour: "#94a3b8", ring: "ring-slate-200", soft: "#f1f5f9" }
  : p >= 90 ? { bg: "bg-emerald-50", text: "text-emerald-700", colour: "#059669", ring: "ring-emerald-200", soft: "#ecfdf5" }
    : p >= 75 ? { bg: "bg-teal-50", text: "text-teal-700", colour: "#0d9488", ring: "ring-teal-200", soft: "#f0fdfa" }
      : p >= 60 ? { bg: "bg-amber-50", text: "text-amber-700", colour: "#d97706", ring: "ring-amber-200", soft: "#fffbeb" }
        : { bg: "bg-rose-50", text: "text-rose-700", colour: "#e11d48", ring: "ring-rose-200", soft: "#fff1f2" };
// GRADE bands are not attendance bands. The college's boundaries are 70 Distinction /
// 60 Merit / 50 Pass / below 50 Fail, so a mark must never be coloured with the
// attendance scale above — that painted every 50% Pass in the same red as a Fail,
// contradicting the band tiles on the very same screen.
// Returns the SAME keys as pctTone. The two are used interchangeably at call sites,
// so a narrower shape here silently rendered `ring-1 undefined undefined undefined`
// on every mark chip — the class names vanish rather than erroring.
export const gradeTone = (p) => p == null ? { bg: "bg-slate-100", text: "text-slate-400", ring: "ring-slate-200", colour: "#94a3b8", soft: "#f1f5f9" }
  : p >= 70 ? { bg: "bg-emerald-50", text: "text-emerald-700", ring: "ring-emerald-200", colour: "#059669", soft: "#ecfdf5" }   // Distinction
    : p >= 60 ? { bg: "bg-blue-50", text: "text-blue-700", ring: "ring-blue-200", colour: "#2563eb", soft: "#eff6ff" }          // Merit
      : p >= 50 ? { bg: "bg-amber-50", text: "text-amber-800", ring: "ring-amber-200", colour: "#b45309", soft: "#fffbeb" }     // Pass
        : { bg: "bg-rose-50", text: "text-rose-800", ring: "ring-rose-200", colour: "#9e1b32", soft: "#fff1f2" };               // Fail
// Progress bands from a lecturer's review. Same keys as pctTone/gradeTone so the chip
// styles the same way, and an unknown or missing value lands on slate rather than
// rendering with three undefined class names.
export const progressTone = (p) => p === "On Track" ? { bg: "bg-emerald-50", text: "text-emerald-700", ring: "ring-emerald-200", colour: "#059669", soft: "#ecfdf5" }
  : p === "Monitor" ? { bg: "bg-orange-50", text: "text-orange-700", ring: "ring-orange-200", colour: "#ea580c", soft: "#fff7ed" }
    : p === "At Risk" ? { bg: "bg-rose-50", text: "text-rose-800", ring: "ring-rose-200", colour: "#9e1b32", soft: "#fff1f2" }
      : { bg: "bg-slate-100", text: "text-slate-500", ring: "ring-slate-200", colour: "#94a3b8", soft: "#f1f5f9" };

// Attendance statuses. These are STATUS colours, so they always ship with the letter
// and the word beside them — never colour alone. The four were checked for
// colour-blind separation as an adjacent set; "Late" is orange (not amber) because
// amber sat too close to the green of "Present" under protanopia.
export const ATT = [
  { key: "P", label: "Present", colour: "#059669" },
  { key: "L", label: "Late", colour: "#ea580c" },
  { key: "E", label: "Excused", colour: "#7c3aed" },
  { key: "A", label: "Absent", colour: "#e11d48" },
];
