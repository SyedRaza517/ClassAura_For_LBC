// Small formatting helpers shared by more than one screen. Split out of the old
// top-level StudentApp.jsx (mechanical move, Task 3 — MARKUP UNCHANGED). Kept
// separate from ui/tokens.js because these are plain formatters, not the
// ACCENT/tone-table colour system that a later task rewrites.
import { isNativeApp } from "../PhoneShell";

export const fmtPct = (p) => (p == null ? "—" : `${p}%`);
export const fmtDate = (iso) => { if (!iso) return null; const [y, m, d] = iso.split("-"); const mm = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1] || m; return `${Number(d)} ${mm} ${y}`; };

export const unitOf = (mr) => mr.unit || mr.module || {};

// Every screen key a notification's `link` can actually name — see the grep across
// the trigger sites (studentQueries.js -> "query", studentReviews.js -> "reviews",
// assessments.js -> "assessments", timetabling.js -> "timetable", referrals.js ->
// "support", mitigations.js -> "mitigations"). Checked against an allowlist rather
// than handed to setScreen unconditionally: `link` is a plain string column with no
// foreign-key discipline behind it, and a future trigger that typos or repurposes it
// must not be able to route this screen to a screen key that no longer exists.
//
// MOVED HERE from Inbox.jsx (originally the only reader) so StudentApp.jsx's own
// `push:open` listener can share the same allowlist — a tapped push notification
// carries exactly the same `link` values a Notification row does (notify.js's
// `pushToStudentDevices` sends `data: { link }` straight off the row it just wrote),
// so validating a tapped push against a SECOND, hand-maintained list would have been
// the two-copies-drift bug this file's own house style warns against elsewhere.
export const KNOWN_LINKS = new Set(["query", "reviews", "assessments", "timetable", "support", "mitigations"]);

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

// The college's own wall-clock reading, right now — read through an EXPLICIT
// `timeZone: "Europe/London"`, the same trick StudentApp.jsx's Header greeting
// already uses for its "Good morning/afternoon/evening". This is not the host-clock
// rule conventions.md warns against ("never use the host clock for a user-facing
// date"): that rule is about a STORED calendar date/time being silently re-zoned by
// whatever timezone the device happens to be set to (attendance dates, term dates —
// values the server already decided). `Date.now()` itself is a correct, zone-agnostic
// instant; reinterpreting it in a fixed, explicit zone is the opposite of that bug —
// it is what stops a student's phone set to a different timezone (travelling, or
// simply misconfigured) from shifting what "next 48 hours" means for a college that
// is not in whatever zone the phone currently reports.
//
// Used by dueNext.js's caller (Home.jsx) rather than by dueNext.js itself, which
// stays pure and takes `now` as a plain argument (see that file's own comment).
export function londonNow() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

// Open a link WITHOUT navigating this page away from the app — matches the
// convention TwoFactor.jsx/StaffHub.jsx already use ("_system" hands it to the
// native OS on a packaged app; a new tab does the same on the web, where there is no
// "_system" to hand it to). Pulled out here because THREE places in the student app
// now open a Teams join link this same way (CheckIn's TodaysClasses, Timetable's
// module rows, Home's Due-next card) and a fourth copy of the native-platform check
// is exactly how these three drift apart.
//
// `isNativeApp()` is IMPORTED from `../PhoneShell` rather than re-sniffed here — an
// earlier version of this function re-tested `window.Capacitor?.isNativePlatform?.()`
// by hand, which is narrower than PhoneShell's own check (that one also treats the
// `capacitor://` protocol as native, for the case a WebView reports the platform API
// late) and could hand a genuinely native session `"_blank"` instead of `"_system"`.
// StudentApp.jsx already imports the same thing from the same place, so there is no
// cross-boundary dependency being created here that didn't already exist.
export function openExternalLink(url) {
  if (!url) return;
  try { window.open(url, isNativeApp() ? "_system" : "_blank", "noopener,noreferrer"); } catch (_) { /* no handler available — nothing else to do */ }
}
