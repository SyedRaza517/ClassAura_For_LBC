// Small formatting helpers shared by more than one screen. Split out of the old
// top-level StudentApp.jsx (mechanical move, Task 3 — MARKUP UNCHANGED). Kept
// separate from ui/tokens.js because these are plain formatters, not the
// ACCENT/tone-table colour system that a later task rewrites.
export const fmtPct = (p) => (p == null ? "—" : `${p}%`);
export const fmtDate = (iso) => { if (!iso) return null; const [y, m, d] = iso.split("-"); const mm = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1] || m; return `${Number(d)} ${mm} ${y}`; };

export const unitOf = (mr) => mr.unit || mr.module || {};

// "Thursday 11 September" — for the one place a date is a heading rather than a cell.
// Built from the date STRING, never from a Date the browser re-zones: the college's day is
// already decided by the server and re-deriving it locally is how a screen shows yesterday
// to somebody an hour ahead.
//
// Defined alongside the timetable helpers in the original file, but used by the Check In
// screen too (the day-header line at the top of CheckInScreen) — so it lives here rather
// than inside screens/Timetable.jsx, where every other date helper it used to sit next to
// stayed put because nothing outside that screen needs them.
export const ttLongDate = (d) => {
  const [y, m, dd] = String(d || "").split("-").map(Number);
  if (!y) return "";
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${DAYS[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]} ${dd} ${MONTHS[m - 1]}`;
};
