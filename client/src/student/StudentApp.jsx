import React, { useState, useEffect, useCallback } from "react";
import PhoneShell, { isNativeApp } from "../PhoneShell";
import { BrandMark } from "../Brand";
import { useBackHandler } from "../backButton";
import { peekPendingQr } from "../pendingQr";
import { api, API_BASE, getToken } from "../api";
// Aliased to StatusBarStyle so it never reads as this file's own ui/StatusBar.jsx
// (the attendance stacked-bar chart) — two completely different "StatusBar"s that
// happen to share a name.
import { StatusBar, Style as StatusBarStyle } from "@capacitor/status-bar";
import {
  Percent, Award, MessageSquare, ChevronLeft, RefreshCw,
  Settings, Home as HomeIcon, User, Nfc, QrCode,
} from "lucide-react";

import { NAVY, NAVY_DARK, MAROON, alpha } from "../branding";
import { DEFAULT_ATTENDANCE_BANDS } from "./ui/tokens";

import Home from "./screens/Home";
import CheckInScreen, { anyCheckInWay } from "./screens/CheckIn";
import AttendanceScreen from "./screens/Attendance";
import ResultsScreen from "./screens/Results";
import ReviewsScreen from "./screens/Reviews";
import TimetableScreen from "./screens/Timetable";
import QueryScreen from "./screens/Query";
import SupportScreen from "./screens/Support";
import MitigationsScreen from "./screens/Mitigations";
import MoreScreen from "./screens/More";

/* ============================== app shell ============================== */

// GET /student/me/attendance-bands — fetched DEFENSIVELY. The endpoint is being built
// in the same wave as this task, in a server routes/student.js this file must not
// touch, so an app built from THIS commit can reach a server that does not have the
// route yet (a plain 404, not carrying the `{error}` body api.js's `request()` uses to
// tell "route missing" apart from "record missing") or one still deploying it. Neither
// is a real failure: DEFAULT_ATTENDANCE_BANDS (ui/tokens.js, mirrored from the server's
// own DEFAULT_BANDS) is exactly what a college that has configured nothing gets back
// anyway, so a null here is silently absorbed by every screen's `bands` prop default.
//
// Written as a bare fetch rather than a new api.js method: this task's file allowlist
// does not include api.js (a concurrent agent's routes/student.js is the other half of
// this endpoint, and api.js is the one client file closest to that seam), so this reads
// api.js's own exported pieces (API_BASE, getToken) rather than adding to it.
async function fetchAttendanceBands() {
  try {
    const token = getToken();
    const res = await fetch(`${API_BASE}/student/me/attendance-bands`, {
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Defensive about the exact shape too — the concurrent route is not landed yet, so
    // this cannot assume `{ bands: [...] }` versus a bare array without ever having
    // seen the real response. Anything that is not a non-empty array of band-shaped
    // objects is treated the same as "not answered": DEFAULT_ATTENDANCE_BANDS covers it.
    const list = Array.isArray(data?.bands) ? data.bands : Array.isArray(data) ? data : null;
    const valid = Array.isArray(list) && list.length && list.every((b) => b && typeof b.min === "number" && typeof b.colour === "string");
    return valid ? list : null;
  } catch {
    return null; // offline, CORS, malformed JSON — the default ladder covers all of it
  }
}

// SIX, and the arithmetic rather than the habit.
//
// This said five was the ceiling because "a sixth tab drops each target below the 44px it
// needs on a 320px phone". That conflated two different measurements. The button is
// flex-1, so six of them on a 320px screen are 53.3px wide — comfortably above 44. What
// actually did not fit was the highlight PILL behind the icon at w-14 (56px): six of
// those need 336px. Narrowing it to w-12 (48px) needs 288px, and the target is untouched.
//
// Check In earns the place because it is the only thing in this app with a deadline. A
// register closes when the class does; an attendance percentage is still true tomorrow.
// It sits second, next to Home, because that is where a thumb already is.
//
// Reviews are still reached from the home screen and from More.
const TABS = [
  { key: "home", label: "Home", Icon: HomeIcon },
  { key: "checkin", label: "Check In", Icon: Nfc },
  { key: "attendance", label: "Attendance", Icon: Percent },
  { key: "assessments", label: "Results", Icon: Award },
  { key: "query", label: "Ask", Icon: MessageSquare },
  { key: "more", label: "More", Icon: Settings },
];

export default function StudentApp({ user, logout }) {
  // A scanned check-in code from the one-shot stash the deep link filled — see
  // pendingQr.js. PEEKED here, not taken: an initializer must be pure (StrictMode runs
  // it twice, and a read-and-remove made the scan vanish before it was used). The card
  // clears the stash at submit time, behind its own once-only guard.
  const [pendingQr, setPendingQr] = useState(() => peekPendingQr());
  // A student who arrives holding a scan is standing in a running class — land them on
  // the check-in screen the mark belongs to, not the home screen.
  const [screen, setScreen] = useState(pendingQr ? "checkin" : "home");
  const [queries, setQueries] = useState([]);
  const [attendance, setAttendance] = useState(null);
  const [results, setResults] = useState(null);
  const [reviews, setReviews] = useState(null);
  const [timetable, setTimetable] = useState(null);
  const [tapContext, setTapContext] = useState(null);
  // null until the first load answers. A student with none gets [], which is a real
  // answer and renders the empty state; null is "we have not been told yet".
  const [referrals, setReferrals] = useState(null);
  const [supportDepts, setSupportDepts] = useState([]);
  // Defaulted rather than null: attendanceTone/progressTone (ui/tokens.js) accept an
  // empty or missing list and fall back to DEFAULT_ATTENDANCE_BANDS themselves, but
  // starting the STATE at the same default means every screen paints its bands from
  // frame one instead of the neutral "unknown" grey flashing briefly before the fetch
  // resolves (or fails, which — see fetchAttendanceBands — is expected until the
  // concurrent server route lands).
  const [bands, setBands] = useState(DEFAULT_ATTENDANCE_BANDS);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(true);
  // Android back returns to the home screen from any other tab.
  useBackHandler(screen !== "home", () => { setScreen("home"); return true; });

  // The native status bar. Guarded on isNativeApp(): the staff app never runs inside
  // Capacitor (it is reached from a browser, same as every other non-student screen),
  // so this plugin call — which is otherwise harmless even on web, @capacitor/status-bar
  // ships a web stub — simply never fires there, which is what "unaffected" means for a
  // surface that has no status bar to control in the first place.
  //
  // overlaysWebView:true (capacitor.config.json) is what makes the status bar draw ON
  // TOP of this screen instead of pushing it down — Header's own paddingTop:
  // env(safe-area-inset-top) is the other half, keeping the greeting and refresh
  // button clear of the notch/clock now sitting over them.
  //
  // Style.Dark (light status-bar content) is used UNCONDITIONALLY rather than actually
  // switching on prefers-color-scheme, and that is a deliberate reading of "per scheme"
  // rather than a missed case: the surface the status bar overlays is Header's own
  // gradient (NAVY_DARK -> NAVY -> MAROON below), which is dark in BOTH colour schemes
  // by design — a student's Home banner does not turn white in light mode. Style.Light
  // (dark content) here would print black icons on a navy bar and be unreadable in
  // EVERY scheme, not just one. The scheme listener is kept anyway, wired through a
  // single `styleForScheme` so the one place that would need to change if the header
  // ever became scheme-dependent is a one-line edit here, not a rewrite.
  useEffect(() => {
    if (!isNativeApp()) return;
    let cancelled = false;
    let mq;
    const styleForScheme = () => StatusBarStyle.Dark; // see comment above — always Dark, on purpose
    const apply = () => { if (!cancelled) StatusBar.setStyle({ style: styleForScheme() }).catch(() => {}); };
    StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
    apply();
    if (typeof window !== "undefined" && window.matchMedia) {
      mq = window.matchMedia("(prefers-color-scheme: dark)");
      if (mq.addEventListener) mq.addEventListener("change", apply); else mq.addListener(apply);
    }
    return () => {
      cancelled = true;
      if (mq) { if (mq.removeEventListener) mq.removeEventListener("change", apply); else mq.removeListener(apply); }
    };
  }, []);

  // A scan can arrive while the app is already open — a same-document navigation that
  // never reloads the page (see pendingQr.js). Pick it up and land on the check-in
  // screen exactly as a fresh load would.
  useEffect(() => {
    const onScan = () => {
      const p = peekPendingQr();
      if (p) { setPendingQr(p); setScreen("checkin"); }
    };
    window.addEventListener("edtech:pending-qr", onScan);
    return () => window.removeEventListener("edtech:pending-qr", onScan);
  }, []);

  // Everything the app shows is loaded once, here, so the home screen can summarise
  // attendance and results without each tab refetching the same thing.
  const load = useCallback(async () => {
    setBusy(true); setErr("");
    const [a, r, q, v, tt, tap] = await Promise.allSettled([
      api.studentAttendance(), api.studentAssessments(), api.studentQueries(), api.studentReviewsAboutMe(), api.studentTimetable(),
      api.studentTapContext(),
    ]);
    const ref = await api.studentReferrals().then(v => ({ status: "fulfilled", value: v }), () => ({ status: "rejected" }));
    const sdep = await api.studentSupportDepartments().then(v => ({ status: "fulfilled", value: v }), () => ({ status: "rejected" }));
    // A bonus fetch like referrals/support departments above: never added to `failed`
    // below, and a null result is a silent no-op — `bands` state already starts at
    // DEFAULT_ATTENDANCE_BANDS, so there is nothing to reset it TO on a rejection.
    const bandList = await fetchAttendanceBands();
    if (bandList) setBands(bandList);
    if (a.status === "fulfilled") setAttendance(a.value);
    if (r.status === "fulfilled") setResults(r.value);
    if (q.status === "fulfilled") setQueries(q.value);
    if (v.status === "fulfilled") setReviews(v.value);
    // The timetable is a bonus screen — a failure here shouldn't add to the error
    // banner that gates the core screens, so it's loaded but not counted in `failed`.
    if (tt.status === "fulfilled") setTimetable(tt.value);
    // Tap check-in is a bonus like the timetable: a college that has not switched it on
    // returns { enabled: false }, and a failure here must not add to the error banner
    // that gates attendance, results and messages.
    if (tap.status === "fulfilled") setTapContext(tap.value);
    // A bonus screen like the timetable and tap check-in: this endpoint is new, so an
    // app talking to an older API 404s here, and that must not put an error banner over
    // attendance and results — which is why it is not counted in `failed` below.
    if (ref.status === "fulfilled") setReferrals(ref.value);
    // [] is a real answer — "this college runs no support desks" — and hides the form
    // rather than offering one with nothing to choose.
    if (sdep.status === "fulfilled") setSupportDepts(sdep.value);
    // ANY failure is reported, not only a total one. Requiring all of them to fail meant
    // a single broken call showed the student "Not graded yet" or "0 sessions" — an
    // answer, and a wrong one — instead of telling them something didn't load.
    const failed = [a, r, q, v].filter(x => x.status === "rejected");
    if (failed.length) {
      const which = [a.status === "rejected" && "attendance", r.status === "rejected" && "results", q.status === "rejected" && "messages", v.status === "rejected" && "reviews"].filter(Boolean);
      setErr(failed.length === 4
        ? (failed[0].reason?.message || "Could not load your information")
        : `Could not load your ${which.join(" or ")}. Tap the refresh icon at the top to try again. Everything else here is up to date.`);
    }
    setBusy(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  // "New reply" badge: answered queries this student hasn't opened yet. Seen-state is
  // kept per student in localStorage, so it's entirely personal to them.
  const seenKey = `edtech_seen_replies_${user.id}`;
  const answered = queries.filter(q => q.status === "answered");
  let seen = new Set();
  try { seen = new Set(JSON.parse(localStorage.getItem(seenKey) || "[]")); } catch (_) { /* ignore */ }
  const newReplies = answered.filter(q => !seen.has(q.id)).length;
  useEffect(() => {
    if (screen === "query" && answered.length) {
      try { localStorage.setItem(seenKey, JSON.stringify(answered.map(q => q.id))); } catch (_) { /* ignore */ }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, queries]);

  // The same seen-state trick for reviews a lecturer has filed but the student hasn't
  // opened. Separate key so clearing one badge never clears the other.
  const seenReviewKey = `edtech_seen_reviews_${user.id}`;
  const reviewList = reviews || [];
  let seenReviews = new Set();
  try { seenReviews = new Set(JSON.parse(localStorage.getItem(seenReviewKey) || "[]")); } catch (_) { /* ignore */ }
  const newReviews = reviewList.filter(r => !seenReviews.has(r.id)).length;
  useEffect(() => {
    if (screen === "reviews" && reviewList.length) {
      try { localStorage.setItem(seenReviewKey, JSON.stringify(reviewList.map(r => r.id))); } catch (_) { /* ignore */ }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, reviews]);

  const title = { home: "Student Hub", checkin: "Check In", attendance: "My Attendance", assessments: "My Results", reviews: "My Reviews", query: "Ask the College", timetable: "My Timetable", support: "Support", mitigations: "Mitigating Circumstances", more: "More" }[screen];
  const shared = { attendance, results, reviews, queries, timetable, tapContext, busy, err, reload: load, setScreen, bands };

  return (
    <PhoneShell
      header={<Header title={title} screen={screen} setScreen={setScreen} user={user} onRefresh={load} busy={busy} />}
      onRefresh={load} refreshing={busy}
    >
      <div className="flex min-h-full flex-col">
        {/* .student-bg (index.css) replaces an inline linear-gradient literal so dark
            mode has somewhere to redefine it — Tailwind's `dark:` variant only matches
            class names, and a gradient this specific was never going to become one
            without a named class to hang the override on. */}
        <div className="student-bg flex-1">
          {screen === "home" && <Home user={user} {...shared} newReplies={newReplies} newReviews={newReviews} />}
          {screen === "checkin" && <CheckInScreen tapContext={tapContext} reload={load} pendingQr={pendingQr} onQrDone={() => setPendingQr(null)} />}
          {screen === "attendance" && <AttendanceScreen {...shared} />}
          {screen === "assessments" && <ResultsScreen {...shared} />}
          {screen === "reviews" && <ReviewsScreen {...shared} />}
          {screen === "timetable" && <TimetableScreen timetable={timetable} busy={busy} reload={load} />}
          {screen === "query" && <QueryScreen queries={queries} reload={load} />}
          {screen === "support" && <SupportScreen referrals={referrals} busy={busy} departments={supportDepts} reload={load} />}
          {/* Self-contained, unlike the screens above it — its own data is not part of
              this shell's central load() (see Mitigations.jsx's own file comment for
              why), so it carries no props from `shared` at all. */}
          {screen === "mitigations" && <MitigationsScreen />}
          {screen === "more" && <MoreScreen user={user} logout={logout} setScreen={setScreen} tapContext={tapContext} />}
        </div>
        {/* `=== false` rather than `!`: anyCheckInWay is null until the first load
            answers, and treating "not told yet" as "off" would drop the tab out of
            the bar on every app open and put it back half a second later — a visible
            jump, on the majority of colleges, where the tab belongs. */}
        <TabBar screen={screen} setScreen={setScreen} newReplies={newReplies}
          codesOnly={Boolean(tapContext?.qrEnabled && !tapContext?.enabled)}
          hideCheckIn={anyCheckInWay(tapContext) === false} />
      </div>
    </PhoneShell>
  );
}

// Persistent bottom navigation — the single biggest thing that makes this feel like
// an app rather than a website: every section is one thumb-tap away, always.
// `codesOnly`: the Check In tab is drawn with the NFC wave glyph, which is wrong for a
// college that only shows codes on screen — the first thing a student reads on the bar
// would name the one technology their college does not use. The More screen already
// picks its glyph this way; the bar now agrees with it.
//
// `hideCheckIn`: the tab goes away entirely at a college that has switched every
// capture method off. THIS REVERSES A DELIBERATE EARLIER CHOICE and the reversal was
// asked for, so both halves are recorded. The tab used to be permanent on the reasoning
// that a student who cannot tell "switched off" from "never built" reports it as
// missing — which had happened twice — and that a destination explaining itself beats
// an absence to interpret. What that argument did not weigh is the administrator's side:
// somebody switching the feature off in Settings expects it to LEAVE the app, and a tab
// that stays put reads as a switch that did not work. A permanent tab also spends one
// of six bottom-bar slots on a screen with nothing in it.
//
// The honest answer survives where it was always kept: CheckInStatusRow on the More
// screen still renders, still says the college has not switched check-in on, and is now
// the one place that says it. Deliberately not removed alongside these two — take it out
// as well and "switched off" becomes indistinguishable from "never built" again, which
// is the exact defect the permanent tab was introduced to fix.
function TabBar({ screen, setScreen, newReplies, codesOnly = false, hideCheckIn = false }) {
  const tabs = hideCheckIn ? TABS.filter((t) => t.key !== "checkin") : TABS;
  return (
    <nav className="sticky bottom-0 z-30 mt-2 flex border-t border-slate-200/80 bg-white/90 backdrop-blur-xl dark:border-slate-700/80 dark:bg-slate-900/90" style={{ paddingBottom: "env(safe-area-inset-bottom)", boxShadow: "0 -6px 20px -12px rgba(15,23,42,.25)" }}>
      {tabs.map(({ key, label, Icon: TabIcon }) => {
        const on = screen === key;
        const Icon = key === "checkin" && codesOnly ? QrCode : TabIcon;
        // NAVY is a CSS var; `NAVY + "14"` built an invalid colour string once the
        // brand primary stopped being a literal hex (branding.js#alpha's own comment
        // names this exact break) — alpha() is the fix. The inactive grey stays a
        // literal hex; it is legible against both bg-white/90 and dark:bg-slate-900/90.
        return (
          <button key={key} onClick={() => setScreen(key)} aria-current={on ? "page" : undefined}
            className="press relative flex flex-1 flex-col items-center gap-1 py-2">
            <span className="relative flex h-8 w-12 items-center justify-center rounded-2xl transition-all duration-200"
              style={on ? { background: alpha(NAVY, 14) } : undefined}>
              <Icon size={20} strokeWidth={on ? 2.6 : 2} style={{ color: on ? NAVY : "#9aa5b8" }} />
              {key === "query" && newReplies > 0 && (
                <span className="pop absolute right-1.5 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[9px] font-extrabold text-slate-900 ring-2 ring-white dark:ring-slate-900">{newReplies}</span>
              )}
            </span>
            <span className="max-w-full truncate px-0.5 text-[10px] font-bold tracking-tight" style={{ color: on ? NAVY : "#9aa5b8" }}>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function Header({ title, screen, setScreen, user, onRefresh, busy }) {
  const hour = Number(new Date().toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/London" }));
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const first = String(user.name || "").trim().split(/\s+/)[0] || "there";
  const home = screen === "home";
  return (
    // A deep brand gradient that curves into the page below it. The curve plus the
    // negative margin on the content is what gives the app its sense of depth —
    // the screen reads as sitting *on* the header rather than under a flat bar.
    <div
      className="animated-gradient relative z-20 overflow-hidden"
      style={{
        background: `linear-gradient(135deg, ${NAVY_DARK} 0%, ${NAVY} 45%, #3730a3 78%, ${MAROON} 140%)`,
        backgroundSize: "220% 220%",
        borderBottomLeftRadius: home ? 30 : 22,
        borderBottomRightRadius: home ? 30 : 22,
        // env(safe-area-inset-top) is 0 on every browser and on a Capacitor app with
        // overlaysWebView:false — the calc() degrades to the old flat 0.5rem exactly.
        // It is only ever non-zero once capacitor.config.json's overlaysWebView:true
        // (this task) puts the system status bar/notch on TOP of this header instead
        // of pushing it down, at which point this is what stops the greeting and the
        // refresh button sitting under the clock and the notch.
        paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)",
      }}
    >
      {/* Decorative blooms — they give the flat gradient some light and depth. */}
      <div className="pointer-events-none absolute -right-12 -top-20 h-52 w-52 rounded-full bg-white/12 blur-3xl" />
      <div className="pointer-events-none absolute -left-16 bottom--10 h-40 w-40 rounded-full bg-white/8 blur-3xl" />

      <div className="relative flex items-center gap-2 px-3 pb-2 pt-1">
        {!home
          ? <button onClick={() => setScreen("home")} aria-label="Back" className="press flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/15 text-white ring-1 ring-white/20 hover:bg-white/25"><ChevronLeft size={22} /></button>
          : <div className="flex h-11 w-12 shrink-0 items-center justify-center rounded-2xl bg-white px-1 shadow-lg"><BrandMark size={26} /></div>}
        <div className="min-w-0 flex-1 text-center"><h1 className="truncate text-[17px] font-extrabold tracking-tight text-white">{title}</h1></div>
        <button onClick={onRefresh} aria-label="Refresh" className="press flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/15 text-white ring-1 ring-white/20 hover:bg-white/25">
          <RefreshCw size={17} className={busy ? "animate-spin" : ""} />
        </button>
      </div>

      {home && (
        <div className="relative px-4 pb-7">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl text-lg font-extrabold text-white shadow-xl ring-2 ring-white/30" style={{ background: user.colour || MAROON }}>{user.initials || "S"}</div>
              <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-emerald-400 ring-2 ring-white/90" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-medium text-white/75">{greeting},</p>
              <p className="truncate text-[19px] font-extrabold leading-tight tracking-tight text-white">{first}</p>
              <p className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-bold text-white/90 ring-1 ring-white/15">
                <User size={9} />{user.studentRef || "Student"}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
