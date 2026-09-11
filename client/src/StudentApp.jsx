import React, { useState, useEffect, useCallback, useRef } from "react";
// The scan outcome is a full-screen sheet, not a card in the page flow — see
// QrCheckInCard for why it has to escape this screen's scroll container.
import { createPortal } from "react-dom";
import useReveal from "./RevealButton";
import PhoneShell from "./PhoneShell";
import { BrandMark } from "./Brand";
import ConfirmDialog from "./ConfirmDialog";
import { useBackHandler } from "./backButton";
import { qrScanResult, qrScanRefusal, keepScanAfter } from "./qrResultView";
import { api, setToken } from "./api";
// The same Face ID / fingerprint control the staff app uses, so both halves behave
// identically and there is one implementation to keep correct.
import { BiometricSetting } from "./StaffHub";
import CheckInCard from "./CheckInCard";
import {
  Percent, Award, MessageSquare, LogOut, ChevronLeft, ChevronRight,
  Loader2, Send, CheckCircle2, Info, ArrowRight, RefreshCw,
  Settings, KeyRound, Lock, Trash2, AlertTriangle, Home as HomeIcon,
  Clock3, CalendarCheck, CalendarDays, Sparkles, User, MapPin, Nfc,
  HeartHandshake, QrCode, Camera,
  ScanLine,
} from "lucide-react";

import { NAVY, NAVY_DARK, MAROON } from "./branding";
import { peekPendingQr, clearPendingQr, stashScan } from "./pendingQr";
import QrScanner from "./QrScanner";
import { nfcStatus } from "./nfc";
// Section accents. Checked as an adjacent colour-blind-safe set (worst pair ΔE 16.4),
// so the four areas stay tellable apart for every reader — and each still carries its
// own icon and label, so colour is never the only signal.
const ACCENT = { checkin: "#1a3a8f", attendance: "#4f46e5", results: "#0891b2", ask: "#be123c", timetable: "#0d7a5f", more: "#7c3aed" };
const fmtPct = (p) => (p == null ? "—" : `${p}%`);
// Attendance/grade bands. Four steps rather than three, so "nearly there" reads
// differently from "needs attention" instead of both being flat red.
const pctTone = (p) => p == null ? { bg: "bg-slate-100", text: "text-slate-400", colour: "#94a3b8", ring: "ring-slate-200", soft: "#f1f5f9" }
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
const gradeTone = (p) => p == null ? { bg: "bg-slate-100", text: "text-slate-400", ring: "ring-slate-200", colour: "#94a3b8", soft: "#f1f5f9" }
  : p >= 70 ? { bg: "bg-emerald-50", text: "text-emerald-700", ring: "ring-emerald-200", colour: "#059669", soft: "#ecfdf5" }   // Distinction
    : p >= 60 ? { bg: "bg-blue-50", text: "text-blue-700", ring: "ring-blue-200", colour: "#2563eb", soft: "#eff6ff" }          // Merit
      : p >= 50 ? { bg: "bg-amber-50", text: "text-amber-800", ring: "ring-amber-200", colour: "#b45309", soft: "#fffbeb" }     // Pass
        : { bg: "bg-rose-50", text: "text-rose-800", ring: "ring-rose-200", colour: "#9e1b32", soft: "#fff1f2" };               // Fail
// Progress bands from a lecturer's review. Same keys as pctTone/gradeTone so the chip
// styles the same way, and an unknown or missing value lands on slate rather than
// rendering with three undefined class names.
const progressTone = (p) => p === "On Track" ? { bg: "bg-emerald-50", text: "text-emerald-700", ring: "ring-emerald-200", colour: "#059669", soft: "#ecfdf5" }
  : p === "Monitor" ? { bg: "bg-orange-50", text: "text-orange-700", ring: "ring-orange-200", colour: "#ea580c", soft: "#fff7ed" }
    : p === "At Risk" ? { bg: "bg-rose-50", text: "text-rose-800", ring: "ring-rose-200", colour: "#9e1b32", soft: "#fff1f2" }
      : { bg: "bg-slate-100", text: "text-slate-500", ring: "ring-slate-200", colour: "#94a3b8", soft: "#f1f5f9" };
const fmtDate = (iso) => { if (!iso) return null; const [y, m, d] = iso.split("-"); const mm = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1] || m; return `${Number(d)} ${mm} ${y}`; };

// Attendance statuses. These are STATUS colours, so they always ship with the letter
// and the word beside them — never colour alone. The four were checked for
// colour-blind separation as an adjacent set; "Late" is orange (not amber) because
// amber sat too close to the green of "Present" under protanopia.
const ATT = [
  { key: "P", label: "Present", colour: "#059669" },
  { key: "L", label: "Late", colour: "#ea580c" },
  { key: "E", label: "Excused", colour: "#7c3aed" },
  { key: "A", label: "Absent", colour: "#e11d48" },
];

const Screen = ({ children }) => <div className="space-y-3.5 px-4 pb-8 pt-4">{children}</div>;
// Rounder corners and layered shadows read as physical cards rather than boxes.
// `i` staggers a list's entrance so rows arrive one after another.
const Card = ({ children, className = "", i }) => (
  <div className={`fade-up rounded-3xl bg-white p-4 shadow-card ring-1 ring-slate-200/60 ${className}`} style={i != null ? { animationDelay: `${i * 55}ms` } : undefined}>{children}</div>
);
const ErrBox = ({ children }) => <Card className="!bg-rose-50 !ring-rose-200 text-sm font-semibold text-rose-600">{children}</Card>;
// A shaped placeholder beats a lone spinner: the screen keeps its layout while it
// loads, so nothing jumps around when the data lands.
const Skeleton = ({ className = "" }) => <div className={`skeleton rounded-3xl ${className}`} />;
const LoadingScreen = () => (
  <Screen>
    <div className="grid grid-cols-2 gap-3"><Skeleton className="h-44" /><Skeleton className="h-44" /></div>
    <Skeleton className="h-14" />
    <Skeleton className="h-20" />
    <Skeleton className="h-28" />
  </Screen>
);

// A soft section heading — small, wide-tracked, with a short accent rule.
const SectionTitle = ({ children, colour = NAVY }) => (
  <div className="flex items-center gap-2 px-1 pt-1">
    <span className="h-3.5 w-1 rounded-full" style={{ background: colour }} />
    <p className="text-[11px] font-extrabold uppercase tracking-widest text-slate-500">{children}</p>
  </div>
);

// Counts a number up when it first appears. Small touch, but it makes the headline
// figures feel alive rather than static text.
function useCountUp(target, ms = 700) {
  const [n, setN] = useState(0);
  const raf = useRef();
  useEffect(() => {
    const to = Number(target);
    if (!Number.isFinite(to)) { setN(0); return; }
    const start = performance.now();
    const tick = (t) => {
      const k = Math.min(1, (t - start) / ms);
      // ease-out so it decelerates into the final value
      setN(Math.round(to * (1 - Math.pow(1 - k, 3)) * 10) / 10);
      if (k < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, ms]);
  return n;
}

// The headline percentage, as a ring with the number inside it.
function Ring({ pct, size = 132, stroke = 13, label, colour }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const tone = colour || pctTone(pct).colour;
  const shown = useCountUp(pct ?? 0);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(15,23,42,.08)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - (pct ?? 0) / 100)}
          style={{ transition: "stroke-dashoffset 1.1s cubic-bezier(.4,0,.2,1)" }}
        />
      </svg>
      <div className="scale-in absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[27px] font-extrabold leading-none tracking-tight tabular-nums" style={{ color: tone }}>{pct == null ? "—" : `${Math.round(shown)}%`}</span>
        {label && <span className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>}
      </div>
    </div>
  );
}

// Stacked attendance bar. Segments are separated by a 2px gap and each carries its
// own count + letter, so the four states never rely on colour alone to be told apart.
function StatusBar({ counts }) {
  const total = ATT.reduce((n, a) => n + (counts[a.key] || 0), 0);
  if (!total) return <div className="h-2.5 rounded-full bg-slate-100" />;
  return (
    <>
      <div className="flex h-2.5 gap-[2px] overflow-hidden">
        {ATT.map(a => {
          const v = counts[a.key] || 0;
          if (!v) return null;
          return <div key={a.key} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${(v / total) * 100}%`, background: a.colour, minWidth: 3 }} title={`${a.label}: ${v}`} />;
        })}
      </div>
      <div className="mt-2.5 grid grid-cols-4 gap-1.5">
        {ATT.map(a => (
          <div key={a.key} className="rounded-xl py-1.5 text-center" style={{ background: a.colour + "12" }}>
            <p className="text-sm font-extrabold tabular-nums" style={{ color: a.colour }}>{counts[a.key] ?? 0}</p>
            <p className="text-[9px] font-semibold text-slate-500">{a.label}</p>
          </div>
        ))}
      </div>
    </>
  );
}

const unitOf = (mr) => mr.unit || mr.module || {};

/* ============================== app shell ============================== */

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
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(true);
  // Android back returns to the home screen from any other tab.
  useBackHandler(screen !== "home", () => { setScreen("home"); return true; });

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

  const title = { home: "Student Hub", checkin: "Check In", attendance: "My Attendance", assessments: "My Results", reviews: "My Reviews", query: "Ask the College", timetable: "My Timetable", support: "Support", more: "More" }[screen];
  const shared = { attendance, results, reviews, queries, timetable, tapContext, busy, err, reload: load, setScreen };

  return (
    <PhoneShell header={<Header title={title} screen={screen} setScreen={setScreen} user={user} onRefresh={load} busy={busy} />}>
      <div className="flex min-h-full flex-col">
        <div className="flex-1" style={{ background: "linear-gradient(180deg,#f6f8fc 0%,#eef2f9 60%,#f6f8fc 100%)" }}>
          {screen === "home" && <Home user={user} {...shared} newReplies={newReplies} newReviews={newReviews} />}
          {screen === "checkin" && <CheckInScreen tapContext={tapContext} reload={load} pendingQr={pendingQr} onQrDone={() => setPendingQr(null)} />}
          {screen === "attendance" && <AttendanceScreen {...shared} />}
          {screen === "assessments" && <ResultsScreen {...shared} />}
          {screen === "reviews" && <ReviewsScreen {...shared} />}
          {screen === "timetable" && <TimetableScreen timetable={timetable} busy={busy} reload={load} />}
          {screen === "query" && <QueryScreen queries={queries} reload={load} />}
          {screen === "support" && <SupportScreen referrals={referrals} busy={busy} departments={supportDepts} reload={load} />}
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
    <nav className="sticky bottom-0 z-30 mt-2 flex border-t border-slate-200/80 bg-white/90 backdrop-blur-xl" style={{ paddingBottom: "env(safe-area-inset-bottom)", boxShadow: "0 -6px 20px -12px rgba(15,23,42,.25)" }}>
      {tabs.map(({ key, label, Icon: TabIcon }) => {
        const on = screen === key;
        const Icon = key === "checkin" && codesOnly ? QrCode : TabIcon;
        return (
          <button key={key} onClick={() => setScreen(key)} aria-current={on ? "page" : undefined}
            className="press relative flex flex-1 flex-col items-center gap-1 py-2">
            <span className="relative flex h-8 w-12 items-center justify-center rounded-2xl transition-all duration-200"
              style={on ? { background: NAVY + "14" } : undefined}>
              <Icon size={20} strokeWidth={on ? 2.6 : 2} style={{ color: on ? NAVY : "#9aa5b8" }} />
              {key === "query" && newReplies > 0 && (
                <span className="pop absolute right-1.5 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[9px] font-extrabold text-slate-900 ring-2 ring-white">{newReplies}</span>
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
      className="animated-gradient relative z-20 overflow-hidden pt-2"
      style={{
        background: `linear-gradient(135deg, ${NAVY_DARK} 0%, ${NAVY} 45%, #3730a3 78%, ${MAROON} 140%)`,
        backgroundSize: "220% 220%",
        borderBottomLeftRadius: home ? 30 : 22,
        borderBottomRightRadius: home ? 30 : 22,
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

/* ============================== home ============================== */

/* ============================== tap check-in ============================== */

/**
 * Is there ANY way for this student to check themselves in?
 *
 * `null` while the answer is unknown, which is not "no" — see the callers, which all
 * keep the entry point visible until told otherwise rather than popping it in half a
 * second after the app opens.
 *
 * THREE SWITCHES, and all three have to be read or this hides a working feature. A
 * college can run stickers (`enabled`), on-screen codes (`qrEnabled`), or the plain
 * "I'm here" declaration (`declareEnabled`) in any combination, and the three are
 * genuinely independent — `enabled` is the sticker switch alone, not a master. The
 * screen's own "Not switched on yet" card used to test only the first two, so a college
 * running declarations and nothing else told its students the feature did not exist
 * while the button to use it sat on the same screen. Everything that asks this question
 * now asks it here, so that cannot drift apart again.
 */
function anyCheckInWay(tapContext) {
  if (tapContext == null) return null;
  return tapContext.enabled === true || tapContext.qrEnabled === true || tapContext.declareEnabled === true;
}

/** One line for the Check In tile, honest in every state. */
function checkInSub(tapContext) {
  if (tapContext == null) return "Checking…";
  // TWO switches now, not one. "Not switched on" is only true when BOTH are off — a
  // QR-only college's students were being told check-in didn't exist while a live code
  // sat on the projector in front of them.
  if (!tapContext.enabled && !tapContext.qrEnabled) return "Not switched on yet";
  const running = (tapContext.now || []).length;
  if (running > 1) return "Choose your class";
  if (running === 1) return tapContext.enabled ? "Ready. Tap a sticker" : "Scan the code on screen";
  if (tapContext.next) return `Next at ${tapContext.next.startTime}`;
  return "No classes left today";
}

// Today's classes, in the order they run.
//
// The point of this list is that it answers the question a student actually has —
// "what have I got today and when" — whether or not the college taps stickers. It also
// makes the check-in card legible: a row marked NOW is the one the button will mark, and
// a row already carrying P or L is one nobody needs to think about again.
function TodaysClasses({ today, loading, canDeclare, onDeclared, canScan, onScan }) {
  // Which class is mid-request, and what the last attempt said. Above the early return
  // with every other hook: the rule is positional, and a hook below `if (loading)` runs a
  // different number of times on the render after the data lands.
  const [marking, setMarking] = useState(null);
  const [failed, setFailed] = useState("");

  /**
   * "I'm here" — mark this class without a sticker or a code.
   *
   * OPTIMISTIC IS WRONG HERE, and that is the one place this differs from the register
   * screen a lecturer uses. This writes a mark ON THE STUDENT'S OWN RECORD with nothing
   * standing behind it, so it must not appear to have succeeded until the server says it
   * has: a row that reads "Present" and was never written is exactly the claim somebody
   * brings to an appeal.
   */
  const declare = async (c) => {
    if (!canDeclare || marking) return;
    setMarking(c.id); setFailed("");
    try {
      await api.studentDeclareCheckIn(c.id);
      await onDeclared?.();
    } catch (e) {
      setFailed(e?.message || "Could not mark you in. Try again.");
    } finally {
      setMarking(null);
    }
  };

  if (loading) return null;

  // An empty day is a real answer and deserves saying, not an absence to interpret.
  if (!today || !today.length) {
    return (
      <div className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
        <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Today</p>
        <p className="mt-1.5 text-sm font-extrabold text-slate-800">No classes timetabled</p>
        <p className="mt-1 text-[13px] leading-relaxed text-slate-500">
          Nothing is scheduled for you today. If you think that&rsquo;s wrong, ask the college —
          registers are created from each unit&rsquo;s teaching dates.
        </p>
      </div>
    );
  }

  // P and L are the two a tap can produce; E and A come from a lecturer. Kept in one
  // place so the words and the colours cannot drift apart.
  const MARK = {
    P: { label: "Present", bg: "bg-emerald-50", text: "text-emerald-700", ring: "ring-emerald-200" },
    L: { label: "Late", bg: "bg-amber-50", text: "text-amber-700", ring: "ring-amber-200" },
    E: { label: "Excused", bg: "bg-sky-50", text: "text-sky-700", ring: "ring-sky-200" },
    A: { label: "Absent", bg: "bg-rose-50", text: "text-rose-700", ring: "ring-rose-200" },
  };

  return (
    <div className="space-y-2.5">
      <p className="px-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">
        Today &middot; {today.length} class{today.length === 1 ? "" : "es"}
      </p>
      {/* SAID, NOT SWALLOWED. The server refuses a declaration for good reasons — the
          class is not running, the term is closed, somebody has already marked them —
          and each is a different next step for the student. A button that simply did
          nothing would send them to the office to ask why. */}
      {failed && (
        <p className="rounded-xl bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-700 ring-1 ring-rose-200">
          {failed}
        </p>
      )}

      {/* ONE CARD PER CLASS, not rows in a shared box.
          The screen-level scanner bar is gone, so each class has to carry its own action
          — and an action inside a divided list row reads as an afterthought. Separate
          cards give the running class somewhere to be obviously different from the two
          that are not, which is the whole job of this screen. */}
      {today.map((c, i) => {
        const mark = c.status ? MARK[c.status] : null;
        const isNow = c.state === "now";
        const over = c.state === "over";
        const actionable = isNow && !mark && (canScan || canDeclare);
        const where = [c.room ? `Room ${c.room}` : null, c.floor, c.campus].filter(Boolean).join(" · ");
        const about = [c.unitCode, c.course, c.school].filter(Boolean).join(" · ");
        return (
          <div
            key={c.id}
            className={`fade-up overflow-hidden rounded-2xl bg-white transition ${
              isNow ? "shadow-card ring-2" : "shadow-sm ring-1 ring-slate-200"
            } ${over && !mark ? "opacity-70" : ""}`}
            style={{ ...(isNow ? { "--tw-ring-color": ACCENT.checkin } : null), animationDelay: `${i * 60}ms` }}
          >
            {/* The live strip. A student glancing at this screen between corridors is
                answering one question — which of these is happening NOW — and colour
                answers it before any word does. */}
            {isNow && <div className="h-1" style={{ background: ACCENT.checkin }} />}

            <div className="p-4">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className={`text-[15px] font-extrabold leading-tight ${over && !mark ? "text-slate-400" : "text-slate-800"}`}>
                    {c.unitName || c.unitCode}
                  </p>
                  <p className="mt-1 flex items-center gap-1.5 text-[12.5px] font-bold tabular-nums text-slate-600">
                    <Clock3 size={12.5} className="shrink-0 text-slate-400" aria-hidden="true" />
                    {c.startTime}&ndash;{c.endTime}
                    {c.checkedInAt && <span className="font-semibold text-emerald-600">&middot; in at {c.checkedInAt}</span>}
                    {!c.termOpen && <span className="font-semibold text-amber-600">&middot; term closed</span>}
                  </p>
                  {/* WRAPPED, NOT TRUNCATED. On a phone the campus and the lecturer used
                      to fall off the end of the line — which is precisely the half that
                      tells two classes at the same hour apart, and the reason the line is
                      here at all. Each part is omitted rather than dashed when the college
                      has not recorded it: an online class has no room, and "—" reads as a
                      room nobody knows. */}
                  {where && (
                    <p className="mt-1.5 flex items-start gap-1.5 text-[12px] leading-snug text-slate-500">
                      <MapPin size={12.5} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />
                      <span>{where}</span>
                    </p>
                  )}
                  {(c.staff || []).length > 0 && (
                    <p className="mt-1 flex items-start gap-1.5 text-[12px] leading-snug text-slate-500">
                      <User size={12.5} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />
                      <span>{(c.staff || []).join(", ")}</span>
                    </p>
                  )}
                  {about && <p className="mt-1.5 text-[11px] leading-snug text-slate-400">{about}</p>}
                </div>

                <span className="shrink-0">
                  {mark
                    ? <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ${mark.bg} ${mark.text} ${mark.ring}`}>{mark.label}</span>
                    : isNow
                      ? <span className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold text-white" style={{ background: ACCENT.checkin }}>
                          {/* A pulse, because "on now" is the only thing on this screen
                              that is true for the next hour and then stops being true. */}
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />On now
                        </span>
                      : <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-400">{over ? "Finished" : "Later"}</span>}
                </span>
              </div>

              {/* THE ACTION, ON THE CLASS IT MARKS. Offered only while the class is
                  running and only if nobody has marked them: a class that is over cannot
                  be claimed after the fact, and a mark that already stands is never
                  overwritten by a student — the same rule the sticker and the code obey.
                  Said here so a button is never offered for a request the server refuses. */}
              {actionable && (
                <div className="mt-3.5 flex gap-2">
                  {canScan && (
                    <button onClick={onScan}
                      className="press flex flex-1 items-center justify-center gap-2 rounded-xl py-3 text-[13px] font-bold text-white"
                      style={{ background: ACCENT.checkin }}>
                      <ScanLine size={15} aria-hidden="true" /> Scan the code
                    </button>
                  )}
                  {canDeclare && (
                    <button onClick={() => declare(c)} disabled={marking === c.id}
                      className={`press flex items-center justify-center gap-2 rounded-xl py-3 text-[13px] font-bold disabled:opacity-50 ${
                        canScan ? "px-4 bg-white text-slate-700 ring-1 ring-slate-200" : "flex-1 text-white"
                      }`}
                      style={canScan ? undefined : { background: ACCENT.checkin }}>
                      {marking === c.id ? "Marking…" : "I'm here"}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CheckInScreen({ tapContext, reload, pendingQr, onQrDone }) {
  const enabled = tapContext?.enabled;
  const qrEnabled = tapContext?.qrEnabled;
  const running = (tapContext?.now || []).length;
  // The in-app scanner. A decoded code is stashed exactly as a scanned link would be,
  // and the app's own listener turns it into the card above — one road for both.
  const [scanning, setScanning] = useState(false);
  const onScanned = useCallback((p) => { setScanning(false); stashScan(p); }, []);
  const closeScanner = useCallback(() => setScanning(false), []);

  // CAN THIS PHONE ACTUALLY TAP A STICKER? Asked here rather than left inside the sticker
  // card, because the answer decides whether two whole blocks belong on the screen at all.
  //
  // The card used to answer it privately and render "Use the app to check in — a browser
  // can't read a sticker" in its place. On a college where codes are also on, that banner
  // is an apology for a method the student does not need, sitting directly above the class
  // they can scan right now. It is still shown where it is the ONLY answer — a college
  // with stickers and nothing else has to tell somebody why the screen is empty.
  const tapReady = useCanTap();
  const canTap = enabled && tapReady === true;
  const tapIsOnlyMethod = enabled && !qrEnabled && tapContext?.declareEnabled !== true;

  const next = tapContext?.next;

  return (
    <div className="space-y-3.5 px-4 pb-8 pt-5">
      {/* A scanned code outranks everything else on the screen: the student is holding
          the result of an action they just took, and it answers first. It renders as a
          full-screen sheet over this whole screen rather than as the first card in it —
          its own comment explains why anything less went unseen. Left HERE in the tree,
          not lifted to the app root, because this screen owns the scan lifecycle and
          nothing about a portalled child cares where it was declared. */}
      {/* Keyed on the code so a SECOND scan remounts the card — its once-only submit
          guard is a ref, which must not survive from the previous scan's card. */}
      {pendingQr && <QrCheckInCard key={pendingQr.code} qr={pendingQr} reload={reload} onDone={onQrDone} />}

      {/* ONE LINE THAT ANSWERS THE WHOLE SCREEN, before any card.
          A student opens this in a corridor with one question — can I check in, now? —
          and previously had to read three cards to find out. The state is said once, at
          the top, in the words the answer actually takes. */}
      {tapContext && (
        <div className="overflow-hidden rounded-2xl" style={{ background: running ? ACCENT.checkin : "#ffffff" }}>
          <div className={`px-4 py-3.5 ${running ? "text-white" : "ring-1 ring-slate-200"}`}>
            <p className={`text-[11px] font-bold uppercase tracking-wider ${running ? "text-white/70" : "text-slate-400"}`}>
              {ttLongDate(tapContext.date)}
            </p>
            <p className={`mt-0.5 text-[17px] font-extrabold leading-tight ${running ? "text-white" : "text-slate-800"}`}>
              {running > 1 ? `${running} classes on now`
                : running === 1 ? `${(tapContext.now[0].unitName || tapContext.now[0].unitCode)} is on now`
                : next ? "No class on right now"
                : "That's you done for today"}
            </p>
            <p className={`mt-1 text-[12.5px] leading-snug ${running ? "text-white/85" : "text-slate-500"}`}>
              {running
                ? (canTap && qrEnabled ? "Scan the code on screen, or tap the sticker in your room."
                  : qrEnabled ? "Scan the code your lecturer has on screen."
                  : canTap ? "Hold your phone against the sticker in your room."
                  : "Use the button on your class below.")
                : next
                  ? <>Check-in opens when <strong className="font-semibold">{next.unitName || next.unitCode}</strong> starts at {next.startTime}.</>
                  : "You have no more classes today."}
            </p>
          </div>
        </div>
      )}

      {tapContext == null && (
        <div className="rounded-2xl bg-white p-5 text-center ring-1 ring-slate-200">
          <Loader2 size={20} className="mx-auto animate-spin text-slate-300" />
          <p className="mt-2 text-[13px] text-slate-500">Just a moment…</p>
        </div>
      )}

      {/* "Not switched on" is only true when EVERY capture method is off — asked of
          anyCheckInWay so this card, the bottom tab and the More row cannot disagree
          about the same college. This has been wrong in both directions: it keyed on the
          sticker switch alone, which told a QR-only college's students the feature didn't
          exist while a live code sat on their projector, and then on two switches of
          three, which said the same thing to a college running "I'm here" declarations.
          Reachable even with the tab hidden — a student who scans a projector code at a
          college that has since switched check-in off arrives straight here. */}
      {anyCheckInWay(tapContext) === false && (
        <div className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl" style={{ background: ACCENT.checkin + "14" }}>
            <Nfc size={19} style={{ color: ACCENT.checkin }} />
          </span>
          <p className="mt-3 text-sm font-extrabold text-slate-800">Not switched on yet</p>
          <p className="mt-1 text-[13px] leading-relaxed text-slate-500">
            Your college hasn&rsquo;t turned on self check-in. Your lecturer takes the register as usual.
          </p>
        </div>
      )}

      {/* The sticker card, only where a sticker is reachable — or where it is the only
          method a student has, in which case they need to be told why it will not work. */}
      <StudentCheckIn tapContext={tapContext} reload={reload} />

      {/* THE SCANNER IS NOT A SCREEN-LEVEL CONTROL. Two of them used to sit above the
          class list — a "Scan to check in" card and a "Scan the code on screen" bar — so a
          student had to hold two ideas at once: which class they are in, and a button
          elsewhere that did not name it. The action is on the class now. */}
      {scanning && <QrScanner onScan={onScanned} onClose={closeScanner} />}

      <TodaysClasses today={tapContext?.today} loading={tapContext == null}
        canDeclare={tapContext?.declareEnabled === true} onDeclared={reload}
        canScan={qrEnabled === true} onScan={() => setScanning(true)} />

      {/* The sticker flow has real steps (arm, wait for the button, press), so its
          walkthrough stays — but only for somebody who can actually follow it. Explaining
          how to tap a sticker to a browser that cannot read one is the same apology the
          banner above used to make, in three more lines. */}
      {canTap && (
        <div className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">How the sticker works</p>
          <ul className="mt-2 space-y-2 text-[13px] leading-relaxed text-slate-600">
            <li>1. Hold your phone against the sticker in your classroom.</li>
            <li>2. The button turns blue for about a minute.</li>
            <li>3. Press it, and you&rsquo;re marked present with the time.</li>
          </ul>
          <p className="mt-3 text-[12px] leading-relaxed text-slate-400">
            It only works while your class is actually running.
          </p>
        </div>
      )}
    </div>
  );
}


/* --------------------------- the scanned-code card --------------------------- */

// What a scan becomes once the app has hold of it. Renders at the very top of the
// check-in screen, submits the code exactly ONCE on mount, and then shows what the
// server decided — including every way it can say no, each with its own next step.
//
// A sibling of the NFC card, not a change to it: CheckInCard.jsx is deeply coupled to
// the sticker flow (arming windows, NFC availability, the blue button) and none of that
// applies to a code that has already been read. The two share nothing but the screen.
// The four answers a scan can end on, plus the refusal. Absent and refused are rose on
// purpose: before this, every outcome was emerald or amber, so "you are marked absent"
// and "you are checked in, late" were the same colour and differed only in wording.
const QR_TONES = {
  present: { bg: "bg-emerald-50", ring: "ring-emerald-200", text: "text-emerald-700", chip: "bg-emerald-100" },
  late:    { bg: "bg-amber-50",   ring: "ring-amber-200",   text: "text-amber-700",   chip: "bg-amber-100" },
  excused: { bg: "bg-sky-50",     ring: "ring-sky-200",     text: "text-sky-700",     chip: "bg-sky-100" },
  absent:  { bg: "bg-rose-50",    ring: "ring-rose-200",    text: "text-rose-700",    chip: "bg-rose-100" },
  refused: { bg: "bg-rose-50",    ring: "ring-rose-200",    text: "text-rose-700",    chip: "bg-rose-100" },
};

/**
 * What a scanned code turned into, shown as a FULL-SCREEN SHEET rather than a card in
 * the page flow.
 *
 * THIS IS A BUG FIX, and the bug was invisible in every way that matters. The outcome
 * used to render as the first child of the check-in screen — above the day's header
 * line, above the class list. But the button that opens the scanner is ON the running
 * class, which is usually the second or third card down, so a student had scrolled to
 * reach it. The camera closed the instant the code decoded (a few hundred milliseconds:
 * the code is right in front of them), the sheet-less card mounted somewhere above the
 * fold, and the screen they were looking at did not visibly change. Reported exactly as
 * it looked from the outside: "the camera closes in a millisecond and it doesn't put me
 * present." It very often HAD put them present.
 *
 * A sheet is the fix rather than scrolling the container to the top, because the scroll
 * would be a race — the card mounts in the same commit that the scanner unmounts, and
 * a scroll into a list whose height is changing lands wherever it lands. The outcome of
 * a check-in is also the one thing on this screen that must not be missed: the student
 * is standing in a lecture theatre deciding whether to put the phone away. It takes over
 * the screen the camera just gave back, which is where their eyes already are.
 *
 * Portalled to document.body deliberately. This screen is inside PhoneShell's
 * overflow-y-auto scrollport, and a `fixed` element inside a scrolling ancestor is only
 * as reliable as that ancestor's transforms — one `transform` anywhere up the tree makes
 * it the containing block, and "fixed" quietly becomes "absolute inside a box you have
 * scrolled past". The portal steps outside all of it.
 */
function QrCheckInCard({ qr, reload, onDone }) {
  // sending → done | failed. One object rather than separate flags so a render can
  // never see a half-updated pair.
  const [state, setState] = useState({ phase: "sending" });
  // The submit guard. The qr object is taken from storage exactly once, but React 18's
  // StrictMode double-runs effects in development, and one scan must never become two
  // submits — the server would answer alreadyMarked, which reads as a bug to a student
  // who scanned once.
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current || !qr) return;
    fired.current = true;
    // The stash dies the moment the submit fires — one scan, one attempt. A reload
    // that races the request simply resubmits and is answered alreadyMarked.
    clearPendingQr();
    (async () => {
      try {
        const r = await api.studentQrCheckIn(qr.sessionId, qr.code);
        setState({ phase: "done", result: r });
        // Refresh the day's list so the P or L pill appears under the card at once.
        reload();
      } catch (e) {
        // An expired session is the one refusal that never reached the register. The app
        // is about to show the sign-in; put the scan back so it submits itself afterwards
        // instead of sending the student back to the projector. See keepScanAfter.
        if (keepScanAfter(e)) stashScan(qr);
        setState({ phase: "failed", error: e });
      }
    })();
  }, [qr, reload]);

  // Escape closes it, but only once there is something to close. Dismissing mid-flight
  // would leave a request in the air with nowhere to report back to, and the student
  // believing they had cancelled something that had already been written.
  const settled = state.phase !== "sending";
  useEffect(() => {
    if (!settled) return;
    const onKey = (e) => { if (e.key === "Escape") onDone(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settled, onDone]);

  let body;
  if (state.phase === "sending") {
    body = (
      <div className="p-6 text-center">
        <Loader2 size={26} className="mx-auto animate-spin text-slate-300" />
        <p className="mt-3 text-sm font-bold text-slate-700">Checking you in…</p>
        <p className="mt-1 text-[12.5px] text-slate-500">Hold on a moment.</p>
      </div>
    );
  } else if (state.phase === "done") {
    const v = qrScanResult(state.result);
    const tone = QR_TONES[v.tone] || QR_TONES.present;
    const Icon = v.good ? CheckCircle2 : AlertTriangle;
    body = (
      <div className="p-5" role="status" aria-live="polite">
        {/* The icon is BIG and on its own line here, where the card had it beside the
            text at 44px. On a sheet that has the whole screen, the first thing to reach
            the student across a lecture theatre is the shape and the colour — they read
            the sentence second. */}
        <div className={`mx-auto flex h-16 w-16 items-center justify-center rounded-3xl ${tone.chip}`}>
          <Icon size={30} className={tone.text} />
        </div>
        <p className={`mt-3.5 flex items-center justify-center gap-2 text-center text-[17px] font-extrabold ${tone.text}`}>
          {v.heading}
          {v.chip && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10.5px] font-bold text-amber-700 ring-1 ring-amber-200">{v.chip}</span>}
        </p>
        <p className="mt-1.5 text-center text-[13px] leading-relaxed text-slate-600">{v.detail}</p>
        <button onClick={onDone} className="press mt-5 w-full rounded-xl py-3.5 text-[14px] font-bold text-white" style={{ background: ACCENT.checkin }}>Done</button>
      </div>
    );
  } else {
    // Refused. Rose, so a refusal is never mistaken at a glance for the amber of a Late
    // check-in — the two used to differ only by the words in them.
    const v = qrScanRefusal(state.error);
    const tone = QR_TONES.refused;
    body = (
      <div className="p-5" role="alert" aria-live="assertive">
        <div className={`mx-auto flex h-16 w-16 items-center justify-center rounded-3xl ${tone.chip}`}>
          <AlertTriangle size={28} className={tone.text} />
        </div>
        <p className={`mt-3.5 text-center text-[17px] font-extrabold ${tone.text}`}>{v.heading}</p>
        <p className="mt-1.5 text-center text-[13px] leading-relaxed text-slate-600">{v.advice}</p>
        <button onClick={onDone} className="press mt-5 w-full rounded-xl bg-white py-3.5 text-[14px] font-bold text-slate-700 ring-1 ring-slate-200">Dismiss</button>
      </div>
    );
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Check-in result"
      className="fixed inset-0 z-[96] flex items-end justify-center bg-slate-900/55 p-4 sm:items-center"
      // The scrim dismisses, once settled — the same rule as Escape, and never a way to
      // walk away from a request still in flight.
      onClick={settled ? onDone : undefined}
    >
      {/* z-[96]: one above the scanner's z-[95]. They are never on screen together —
          the scanner stops itself before handing the code over — but ordering them
          leaves nothing to a mount race if that ever stops being true. */}
      <div
        className="scale-in w-full max-w-sm overflow-hidden rounded-3xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {body}
      </div>
    </div>,
    document.body
  );
}
// The card at the top of the home screen. Renders nothing at all when the college has
// not switched tap check-in on, so a student at an institution that does not use it
// never sees a feature they cannot have.
//
// `now` from the server is the list of this student's classes running at this moment:
// empty when none is, one when it is unambiguous, several when two overlap. The picker
// only appears in that last case, which is rare enough that making it the default shape
// would put a menu in front of every student every day for the sake of a few.
/**
 * Whether this phone can actually read a sticker.
 *
 * A HOOK RATHER THAN A CHECK IN TWO PLACES. The sticker card renders on Home and again on
 * Check In, and the screen around it needs the same answer to decide its own wording and
 * whether the walkthrough belongs there at all. Three copies of an async probe is three
 * chances for the screens to disagree about the same phone.
 *
 * `null` while the answer is unknown, which is NOT "no": rendering the unavailable state
 * during the first tick would flash an apology at every student for a moment before the
 * probe comes back.
 */
function useCanTap() {
  const [nfc, setNfc] = useState(null);
  useEffect(() => {
    let live = true;
    nfcStatus().then((v) => live && setNfc(v)).catch(() => live && setNfc({ ok: false, reason: "error" }));
    return () => { live = false; };
  }, []);
  return nfc === null ? null : nfc.ok === true;
}

function StudentCheckIn({ tapContext, reload }) {
  const [picked, setPicked] = useState(null);
  // Every hook above the early returns. A hook below one runs a different number of times
  // on the render after the data lands, which is React error #310 and a blank screen.
  const canTap = useCanTap();
  // Hidden on the home screen when the college has not switched tap check-in on: a
  // student should not be shown a control their institution has not adopted. The row on
  // the More screen stays visible in that case and says so, because rendering NOTHING
  // anywhere made "switched off" and "never built" look identical — and that is how this
  // came to be reported as missing.
  if (!tapContext?.enabled) return null;
  // AND HIDDEN WHERE THE PHONE CANNOT TAP AND SOMETHING ELSE CAN. The card's own
  // unavailable state said "Use the app to check in — a browser can't read a sticker",
  // which on a college that also shows codes is an apology for a method the student does
  // not need, printed directly above the class they can scan right now. It renders on
  // Home and on Check In, so it said it twice.
  //
  // Still shown where tapping is the ONLY method: a college with stickers and nothing
  // else has to tell somebody why they cannot check in, or the screen is silently empty.
  const anotherWay = tapContext.qrEnabled === true || tapContext.declareEnabled === true;
  if (canTap === false && anotherWay) return null;

  const running = tapContext.now || [];
  const next = tapContext.next;
  const many = running.length > 1;
  const one = running.length === 1 ? running[0] : null;
  const target = many ? picked : one;

  const when = (s) => `${s.startTime}–${s.endTime}`;

  const subtitle = (
    <div className="mb-3">
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
        <Nfc size={13} /> Check in
      </p>
      {running.length === 0 ? (
        <p className="mt-1 text-sm leading-snug text-slate-600">
          {next
            ? <>No class on right now. Your next one is <span className="font-semibold text-slate-800">{next.unitName}</span> at {next.startTime}.</>
            : "You have no more classes today."}
        </p>
      ) : many && !picked ? (
        <>
          <p className="mt-1 text-sm leading-snug text-slate-600">Two of your classes are running. Which one are you in?</p>
          <div className="mt-2 space-y-1.5">
            {running.map((s) => (
              <button key={s.id} type="button" onClick={() => setPicked(s)}
                className="press w-full rounded-xl border border-slate-200 px-3 py-2 text-left">
                <p className="text-[13px] font-semibold text-slate-800">{s.unitName || s.unitCode}</p>
                <p className="text-[11px] text-slate-500">{when(s)}</p>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="mt-1 text-sm leading-snug text-slate-600">
          <span className="font-semibold text-slate-800">{target?.unitName || target?.unitCode}</span>
          <span className="text-slate-500"> · {target ? when(target) : ""}</span>
          {many && <button type="button" onClick={() => setPicked(null)} className="ml-2 text-[12px] font-semibold underline" style={{ color: NAVY }}>change</button>}
        </p>
      )}
    </div>
  );

  return (
    <CheckInCard
      armSeconds={tapContext.armSeconds || 60}
      subtitle={subtitle}
      actionLabel="Check in"
      disabled={running.length === 0 || (many && !picked)}
      disabledNote={running.length === 0
        ? (next ? `Check-in opens at ${next.startTime}.` : "Nothing to check in to today.")
        : "Choose which class you're in first."}
      onCheckIn={async (tagCode) => {
        const r = await api.studentTapCheckIn(tagCode, target?.id);
        // The mark changes this student's attendance percentage, so the screen behind
        // the card is now stale. Refreshing also re-reads tap-context, which is what
        // stops a second check-in being offered for a class already marked.
        reload();
        return r;
      }}
      renderResult={(r) => (
        r.alreadyMarked
          ? <>You were already marked <strong>{r.status === "L" ? "late" : "present"}</strong> for {r.session?.unitName || "this class"}.</>
          : <>Marked <strong>{r.status === "L" ? "late" : "present"}</strong> for {r.session?.unitName || "this class"} at <strong>{r.checkedInAt}</strong>.</>
      )}
    />
  );
}

function Home({ user, attendance, results, queries, reviews, tapContext, busy, err, reload, setScreen, newReplies, newReviews }) {
  // Only blank the screen when nothing at all arrived. One failed call must not
  // hide the data that did load — that was the old silent-wrong-data bug inverted.
  if (err && !attendance && !results) return <Screen><ErrBox>{err}</ErrBox></Screen>;
  if (busy && !attendance && !results) return <LoadingScreen />;

  const cur = attendance?.current || {};
  const curUnits = cur.units || cur.modules || [];
  const o = cur.overall || {};
  const attPct = o.pct ?? null;
  const avgPct = results?.averagePct ?? null;
  const graded = results?.graded ?? 0;
  const totalAssess = results?.count ?? 0;
  const pending = Math.max(0, totalAssess - graded);
  const latestReply = queries.filter(q => q.status === "answered" && q.response)[0];
  // The server returns reviews newest-first, so the first one is the latest.
  const latestReview = (reviews || [])[0];

  // One clear message about where they stand, in words rather than numbers.
  const band = attPct == null ? null : attPct >= 85 ? { t: "Excellent attendance — keep it up.", c: "#059669" }
    : attPct >= 70 ? { t: "Good, but there's room to improve.", c: "#d97706" }
      : { t: "Your attendance needs attention.", c: "#e11d48" };

  const attTone = pctTone(attPct);
  const avgTone = gradeTone(avgPct);

  return (
    <div className="space-y-3.5 px-4 pb-8 pt-5">
      {/* Check-in sits ABOVE the headline numbers on purpose: it is the one thing on
          this screen with a deadline attached. Attendance and results are still true in
          an hour; a register closes when the class does. */}
      <StudentCheckIn tapContext={tapContext} reload={reload} />

      {/* Headline pair: the two numbers a student actually cares about. */}
      <div className="grid grid-cols-2 gap-3">
        <HeroTile onClick={() => setScreen("attendance")} i={0}
          pct={attPct} label="Attendance" tone={attTone}
          foot={`${curUnits.length} current unit${curUnits.length === 1 ? "" : "s"}`} />
        <HeroTile onClick={() => setScreen("assessments")} i={1}
          pct={avgPct} label="Average" tone={avgTone}
          foot={results?.averageGrade || (graded ? "—" : "Not graded yet")} />
      </div>

      {band && (
        <div className="fade-up flex items-center gap-2.5 rounded-2xl px-3.5 py-3 ring-1" style={{ background: band.c + "12", "--tw-ring-color": band.c + "33", animationDelay: "110ms" }}>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl" style={{ background: band.c + "1f" }}><Sparkles size={14} style={{ color: band.c }} /></span>
          <p className="text-[12px] font-bold leading-snug" style={{ color: band.c }}>{band.t}</p>
        </div>
      )}

      {/* At a glance */}
      <div className="grid grid-cols-3 gap-2.5">
        <Stat icon={CheckCircle2} value={o.P ?? 0} label="Present" colour="#059669" i={2} />
        <Stat icon={Clock3} value={(o.L ?? 0) + (o.E ?? 0)} label="Late / Exc." colour="#ea580c" i={3} />
        <Stat icon={CalendarCheck} value={o.marked ?? 0} label="Sessions" colour={ACCENT.attendance} i={4} />
      </div>

      {/* Latest reply, surfaced so it isn't missed */}
      {latestReply && (
        <button onClick={() => setScreen("query")} className="press fade-up w-full rounded-3xl bg-white p-4 text-left shadow-card ring-1 ring-slate-200/60" style={{ animationDelay: "220ms" }}>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-xl" style={{ background: ACCENT.ask + "14" }}><MessageSquare size={14} style={{ color: ACCENT.ask }} /></span>
            <p className="flex-1 text-[10px] font-extrabold uppercase tracking-widest" style={{ color: ACCENT.ask }}>Reply from the college</p>
            {newReplies > 0 && <span className="pop rounded-full bg-amber-400 px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-slate-900">new</span>}
          </div>
          <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-slate-600">{latestReply.response}</p>
          <p className="mt-1.5 flex items-center gap-1 text-[11px] font-bold" style={{ color: ACCENT.ask }}>Read the conversation <ChevronRight size={12} /></p>
        </button>
      )}

      {/* A lecturer's review, surfaced the same way a college reply is. It carries the
          summary rather than the progress band: the band belongs on the screen that
          also gives it the context of what was discussed and agreed. */}
      {latestReview && (
        <button onClick={() => setScreen("reviews")} className="press fade-up w-full rounded-3xl bg-white p-4 text-left shadow-card ring-1 ring-slate-200/60" style={{ animationDelay: "245ms" }}>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl" style={{ background: NAVY + "14" }}><Info size={14} style={{ color: NAVY }} /></span>
            <p className="flex-1 text-[10px] font-extrabold uppercase tracking-widest" style={{ color: NAVY }}>From your lecturer</p>
            {newReviews > 0 && <span className="pop shrink-0 rounded-full bg-amber-400 px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-slate-900">{newReviews} new</span>}
          </div>
          <p className="mt-2 truncate text-[11px] font-bold text-slate-400">{latestReview.unit?.code ? `${latestReview.unit.code} · ` : ""}{fmtDate(latestReview.date)}{latestReview.staffName ? ` · ${latestReview.staffName}` : ""}</p>
          {latestReview.summary && <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-slate-600">{latestReview.summary}</p>}
          <p className="mt-1.5 flex items-center gap-1 text-[11px] font-bold" style={{ color: NAVY }}>Read your reviews <ChevronRight size={12} /></p>
        </button>
      )}

      {pending > 0 && (
        <button onClick={() => setScreen("assessments")} className="press fade-up flex w-full items-center gap-3 rounded-3xl bg-white p-3.5 text-left shadow-card ring-1 ring-slate-200/60" style={{ animationDelay: "265ms" }}>
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl" style={{ background: ACCENT.results + "14" }}><Award size={17} style={{ color: ACCENT.results }} /></span>
          <span className="flex-1">
            <span className="block text-[13px] font-extrabold text-slate-700">{pending} assessment{pending === 1 ? "" : "s"} awaiting marks</span>
            <span className="block text-[11px] text-slate-400">{graded} of {totalAssess} marked so far</span>
          </span>
          <ChevronRight size={17} className="shrink-0 text-slate-300" />
        </button>
      )}

      <SectionTitle colour={ACCENT.attendance}>Quick actions</SectionTitle>
      <div className="grid grid-cols-2 gap-2.5">
        {/* Rendered in every state EXCEPT one: a college that has switched all three
            capture methods off. It used to be rendered unconditionally, because showing
            it only when a class was checkable left nobody able to tell "switched off"
            from "not built" — reported as missing twice, which is why the tile explains
            itself in every state rather than disappearing between classes. That still
            holds and has not changed; what changed is that a college with the feature
            OFF is not a state to explain here. It matches the bottom tab, which is the
            point — a Check In tile linking to a tab that no longer exists is worse than
            either choice made consistently. TabBar carries the full reasoning and names
            where the "switched off" answer still lives. */}
        {anyCheckInWay(tapContext) !== false && (
          <Action onClick={() => setScreen("checkin")} Icon={Nfc} label="Check In"
            sub={checkInSub(tapContext)} c={ACCENT.checkin} i={0} />
        )}
        <Action onClick={() => setScreen("attendance")} Icon={Percent} label="My Attendance" sub="By unit" c={ACCENT.attendance} i={1} />
        <Action onClick={() => setScreen("assessments")} Icon={Award} label="My Results" sub="Marks & grades" c={ACCENT.results} i={2} />
        <Action onClick={() => setScreen("timetable")} Icon={CalendarDays} label="My Timetable" sub="Weekly classes" c={ACCENT.timetable} i={3} />
        <Action onClick={() => setScreen("query")} Icon={MessageSquare} label="Ask the College" sub={newReplies ? `${newReplies} new repl${newReplies === 1 ? "y" : "ies"}` : "Send a query"} c={ACCENT.ask} badge={newReplies} i={4} />
        <Action onClick={() => setScreen("more")} Icon={Settings} label="More" sub="Account & settings" c={ACCENT.more} i={5} />
      </div>
    </div>
  );
}

// The two headline figures. A tinted panel behind the ring ties the number to its
// band at a glance, before the number itself is even read.
function HeroTile({ onClick, pct, label, tone, foot, i }) {
  return (
    <button onClick={onClick} className="press fade-up rounded-3xl p-4 shadow-card ring-1"
      style={{ background: tone.soft, "--tw-ring-color": tone.colour + "2e", animationDelay: `${i * 70}ms` }}>
      <div className="flex flex-col items-center">
        <Ring pct={pct} size={112} stroke={11} colour={tone.colour} />
        <p className="mt-2.5 text-[11px] font-extrabold uppercase tracking-widest" style={{ color: tone.colour }}>{label}</p>
        <p className="mt-0.5 flex items-center gap-0.5 text-[11px] font-semibold text-slate-500">{foot}<ChevronRight size={12} className="text-slate-400" /></p>
      </div>
    </button>
  );
}

function Stat({ icon: Icon, value, label, colour, i = 0 }) {
  return (
    <div className="fade-up rounded-2xl bg-white p-3 text-center shadow-card ring-1 ring-slate-200/60" style={{ animationDelay: `${140 + i * 45}ms` }}>
      <span className="mx-auto flex h-7 w-7 items-center justify-center rounded-xl" style={{ background: colour + "14" }}><Icon size={14} style={{ color: colour }} /></span>
      <p className="mt-1.5 text-[19px] font-extrabold leading-none tabular-nums text-slate-800">{value}</p>
      <p className="mt-1 text-[10px] font-semibold text-slate-400">{label}</p>
    </div>
  );
}

function Action({ onClick, Icon, label, sub, c, badge, i = 0 }) {
  return (
    <button onClick={onClick} className="press fade-up relative flex flex-col items-start gap-2.5 rounded-3xl p-4 text-left shadow-card ring-1"
      style={{ background: c + "12", "--tw-ring-color": c + "2e", animationDelay: `${300 + i * 55}ms` }}>
      <span className="relative flex h-11 w-11 items-center justify-center rounded-2xl text-white shadow-md" style={{ background: c }}>
        <Icon size={19} />
        {badge > 0 && <span className="pop absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-extrabold text-slate-900 ring-2 ring-white">{badge}</span>}
      </span>
      <span>
        <span className="block text-[13px] font-extrabold leading-tight" style={{ color: c }}>{label}</span>
        <span className={`mt-0.5 block text-[11px] ${badge > 0 ? "font-bold text-amber-600" : "text-slate-500"}`}>{sub}</span>
      </span>
    </button>
  );
}

/* ============================== attendance ============================== */

function UnitAtt({ mr, ended }) {
  const s = mr.summary || {}; const t = pctTone(s.pct); const u = unitOf(mr);
  return (
    <div className="border-t border-slate-100 px-3.5 py-3 first:border-t-0">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-12 shrink-0 items-center justify-center rounded-xl text-[10px] font-extrabold text-white" style={{ background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` }}>{(u.code || "?").slice(0, 5)}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-bold text-slate-700" title={u.name}>{u.name}</p>
          <p className="mt-0.5 text-[10px] font-medium text-slate-400">
            {ended ? `Ended ${fmtDate(mr.endDate)}` : `${s.marked ?? 0} session${(s.marked ?? 0) === 1 ? "" : "s"} marked`}
          </p>
        </div>
        <span className={`shrink-0 rounded-xl px-2.5 py-1.5 text-sm font-extrabold tabular-nums ring-1 ${t.bg} ${t.text} ${t.ring}`}>{fmtPct(s.pct)}</span>
      </div>
      {!ended && (
        <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full" style={{ width: `${s.pct ?? 0}%`, background: t.colour, transition: "width 1s cubic-bezier(.4,0,.2,1)" }} />
        </div>
      )}
    </div>
  );
}

function AttendanceScreen({ attendance, busy, err }) {
  // The screen's OWN data decides; a failure elsewhere shows as text in its place.
  if (!attendance) return busy ? <LoadingScreen /> : <Screen><ErrBox>{err || "Could not load attendance."}</ErrBox></Screen>;
  const cur = attendance.current || {};
  const curUnits = cur.units || cur.modules || [];
  const o = cur.overall || {};
  const previous = attendance.previous || [];

  return (
    <div className="space-y-3.5 px-4 pb-8 pt-5">
      <div className="fade-up rounded-3xl p-5 shadow-card-lg ring-1" style={{ background: pctTone(o.pct).soft, "--tw-ring-color": pctTone(o.pct).colour + "2e" }}>
        <div className="flex flex-col items-center">
          <Ring pct={o.pct ?? null} label="current units" />
          <p className="mt-2 text-[11px] font-semibold text-slate-400">{o.marked ?? 0} marked session{(o.marked ?? 0) === 1 ? "" : "s"} across {curUnits.length} unit{curUnits.length === 1 ? "" : "s"}</p>
        </div>
        <div className="mt-4"><StatusBar counts={o} /></div>
      </div>

      <SectionTitle colour={ACCENT.attendance}>Current units</SectionTitle>
      <Card className="!p-0 overflow-hidden">
        {curUnits.map(mr => <UnitAtt key={unitOf(mr).id} mr={mr} />)}
        {curUnits.length === 0 && <Empty icon={CalendarCheck} title="No current units" msg="Units you're enrolled on will appear here once teaching starts." />}
      </Card>

      {previous.length > 0 && (
        <>
          <SectionTitle colour="#94a3b8">Previous units · {previous.length}</SectionTitle>
          <Card className="!p-0 overflow-hidden">{previous.map(mr => <UnitAtt key={unitOf(mr).id} mr={mr} ended />)}</Card>
        </>
      )}

      <div className="fade-up rounded-3xl bg-white p-4 shadow-card ring-1 ring-slate-200/60">
        <p className="mb-2.5 text-[10px] font-extrabold uppercase tracking-widest text-slate-400">How it's counted</p>
        <div className="grid grid-cols-2 gap-y-1.5">
          {ATT.map(a => (
            <div key={a.key} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: a.colour }} />
              <span className="text-[11px] font-semibold text-slate-600">{a.key} — {a.label}</span>
            </div>
          ))}
        </div>
        <p className="mt-2.5 text-[10px] leading-relaxed text-slate-400">Present scores 2, Late and Excused score 1, Absent scores 0. Only sessions that have been marked are counted.</p>
      </div>
    </div>
  );
}

function Empty({ icon: Icon, title, msg }) {
  return (
    <div className="px-4 py-8 text-center">
      <span className="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-100"><Icon size={19} className="text-slate-400" /></span>
      <p className="text-[13px] font-bold text-slate-600">{title}</p>
      <p className="mx-auto mt-1 max-w-[15rem] text-[11px] leading-relaxed text-slate-400">{msg}</p>
    </div>
  );
}

/* ============================== results ============================== */

function ResultsScreen({ results, busy, err }) {
  // Same here: missing results is what blanks this screen, not any error at all.
  if (!results) return busy ? <LoadingScreen /> : <Screen><ErrBox>{err || "Could not load results."}</ErrBox></Screen>;
  const list = results.assessments || [];
  const graded = list.filter(a => a.pct != null);
  const bands = { Distinction: 0, Merit: 0, Pass: 0, Fail: 0 };
  graded.forEach(a => { if (bands[a.grade] != null) bands[a.grade]++; });
  // Derived from gradeTone so the band tiles can never drift from the mark chips
  // below them — they disagreed once already.
  const BAND_C = { Distinction: gradeTone(75).colour, Merit: gradeTone(65).colour, Pass: gradeTone(55).colour, Fail: gradeTone(20).colour };

  return (
    <div className="space-y-3.5 px-4 pb-8 pt-5">
      <div className="fade-up rounded-3xl p-5 shadow-card-lg ring-1" style={{ background: gradeTone(results.averagePct).soft, "--tw-ring-color": gradeTone(results.averagePct).colour + "2e" }}>
        <div className="flex flex-col items-center">
          <Ring pct={results.averagePct ?? null} label="average" colour={gradeTone(results.averagePct).colour} />
          <span className="mt-2 rounded-xl px-3 py-1 text-sm font-extrabold ring-1" style={{ background: gradeTone(results.averagePct).colour + "14", color: gradeTone(results.averagePct).colour, "--tw-ring-color": gradeTone(results.averagePct).colour + "33" }}>
            {results.averageGrade || "Not graded yet"}
          </span>
          <p className="mt-1.5 text-[11px] font-semibold text-slate-400">{results.graded} of {results.count} assessment{results.count === 1 ? "" : "s"} marked</p>
        </div>
        {graded.length > 0 && (
          <div className="mt-4 grid grid-cols-4 gap-1.5">
            {Object.entries(bands).map(([b, n]) => (
              <div key={b} className="rounded-xl py-1.5 text-center" style={{ background: BAND_C[b] + "12" }}>
                <p className="text-sm font-extrabold tabular-nums" style={{ color: BAND_C[b] }}>{n}</p>
                <p className="text-[9px] font-semibold text-slate-500">{b}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <SectionTitle colour={ACCENT.results}>Your assessments</SectionTitle>
      <div className="space-y-2.5">
        {list.map(a => {
          const t = gradeTone(a.pct);
          const done = a.marks != null;
          return (
            <Card key={a.id} className="!p-3.5">
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-8 w-12 shrink-0 items-center justify-center rounded-xl text-[10px] font-extrabold text-white" style={{ background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` }}>{(a.unitCode || a.moduleCode || "?").slice(0, 5)}</span>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-[13px] font-extrabold text-slate-700">{a.title}</p>
                  <p className="truncate text-[11px] text-slate-400">{a.unitName || a.moduleName} · {a.type}{a.dueDate ? ` · due ${fmtDate(a.dueDate)}` : ""}</p>
                </div>
                {done
                  ? <span className={`shrink-0 rounded-xl px-2.5 py-1.5 text-center text-xs font-extrabold tabular-nums ring-1 ${t.bg} ${t.text} ${t.ring}`}>{a.marks}/{a.maxMarks}<span className="block text-[9px] font-bold">{a.grade}</span></span>
                  : <span className="shrink-0 rounded-xl bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-400">Pending</span>}
              </div>
              {done && (
                <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full" style={{ width: `${a.pct ?? 0}%`, background: t.colour, transition: "width 1s cubic-bezier(.4,0,.2,1)" }} />
                </div>
              )}
              {a.feedback ? <p className="mt-2.5 break-words rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500"><span className="font-bold text-slate-600">Feedback: </span>{a.feedback}</p> : null}
            </Card>
          );
        })}
        {list.length === 0 && <Card className="!p-0"><Empty icon={Award} title="No assessments yet" msg="Assessments set for your units will show here, along with your marks and feedback." /></Card>}
      </div>
    </div>
  );
}

/* ============================== progress reviews ============================== */

// The section keeps the brand navy rather than taking a fifth ACCENT: the only colour
// that should carry meaning on this screen is the progress band itself, and a coloured
// section rule beside an "At Risk" chip reads as a second, competing verdict.
function ReviewsScreen({ reviews, busy, err }) {
  // This screen's OWN data decides what it shows, as on attendance and results — a
  // failure in one of the other three calls must not blank it.
  if (!reviews) return busy ? <LoadingScreen /> : <Screen><ErrBox>{err || "Could not load your reviews."}</ErrBox></Screen>;

  return (
    <Screen>
      <p className="px-1 text-[12px] leading-relaxed text-slate-500">
        When you have a progress conversation with a lecturer, they write up what was discussed and what you both agreed. If anything here doesn't look right, ask the college.
      </p>

      {reviews.length === 0 ? (
        <Card className="!p-0"><Empty icon={Info} title="No reviews yet" msg="A lecturer's write-up of a progress conversation with you will appear here." /></Card>
      ) : (
        <>
          <SectionTitle>Your reviews · {reviews.length}</SectionTitle>
          {/* Stagger caps at the seventh card, so a long list doesn't leave the last
              rows waiting seconds to appear. */}
          {reviews.map((r, i) => <ReviewCard key={r.id} r={r} i={Math.min(i, 6)} />)}
        </>
      )}
    </Screen>
  );
}

function ReviewCard({ r, i }) {
  const t = progressTone(r.progress);
  const concerns = Array.isArray(r.concerns) ? r.concerns : [];
  return (
    <Card i={i} className="!p-3.5">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-8 w-12 shrink-0 items-center justify-center rounded-xl text-[10px] font-extrabold text-white" style={{ background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` }}>{(r.unit?.code || "—").slice(0, 5)}</span>
        <div className="min-w-0 flex-1">
          {/* The unit can be null — a unit may be reorganised away long after the
              conversation happened, and the record outlives it. */}
          <p className="text-[13px] font-extrabold leading-tight text-slate-700">{r.unit?.name || "General progress review"}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{fmtDate(r.date) || "—"}{r.staffName ? ` · ${r.staffName}` : ""}</p>
        </div>
        {r.progress && <span className={`shrink-0 whitespace-nowrap rounded-xl px-2.5 py-1.5 text-[11px] font-extrabold ring-1 ${t.bg} ${t.text} ${t.ring}`}>{r.progress}</span>}
      </div>

      {concerns.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {concerns.map(c => (
            <span key={c} className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${c === "No Concerns" ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" : "bg-slate-100 text-slate-600"}`}>{c}</span>
          ))}
        </div>
      )}

      {r.summary ? <ReviewText label="Summary of discussion" text={r.summary} /> : null}
      {r.agreedActions ? <ReviewText label="Agreed actions" text={r.agreedActions} /> : null}

      {r.followUp && (
        <p className="mt-2.5 flex items-center gap-1.5 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-700 ring-1 ring-amber-200">
          <CalendarCheck size={13} className="shrink-0" />
          {r.followUpDate ? `Follow-up on ${fmtDate(r.followUpDate)}` : "A follow-up was agreed"}
        </p>
      )}
    </Card>
  );
}

// Free text exactly as the lecturer typed it: line breaks kept, and long words broken
// rather than pushing the card wider than the phone.
function ReviewText({ label, text }) {
  return (
    <div className="mt-2.5 rounded-xl bg-slate-50 px-3 py-2.5">
      <p className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400">{label}</p>
      <p className="mt-1 whitespace-pre-line break-words text-[12px] leading-relaxed text-slate-600">{text}</p>
    </div>
  );
}

/* ============================== timetable ============================== */

// 1 = Monday … 7 = Sunday (matches the server). Weekend days appear only if a slot
// actually lands on one.
const TT_DAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
// The period label the college's own timetable uses ("Evening 18:00 – 21:00").
const periodOf = (start) => { const h = Number(String(start).slice(0, 2)); return h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening"; };

// A STABLE COLOUR PER MODULE, when the college has not chosen one.
//
// The college's Event Category colour wins where it exists, so a student and their
// lecturer look at the same coded timetable rather than two unrelated palettes. This is
// the fallback, hashed from the module CODE rather than assigned in order, so a module
// keeps its colour when a class is added and between the phone and the web.
const TT_COLOURS = ["#1a3a8f", "#0d7a5f", "#9e1b32", "#6d28d9", "#b45309", "#0e7490", "#be123c", "#4338ca"];
const ttColour = (ev) =>
  ev.colour || TT_COLOURS[Math.abs(String(ev.unitCode || ev.title || "").split("").reduce((a, c) => a + c.charCodeAt(0), 0)) % TT_COLOURS.length];

// "2026-09-14" → "14/09/2026", the form the college's own week-structure sheet uses.
const ttDMY = (d) => { const [y, m, dd] = String(d || "").split("-"); return y ? `${dd}/${m}/${y}` : ""; };
// "Thursday 11 September" — for the one place a date is a heading rather than a cell.
// Built from the date STRING, never from a Date the browser re-zones: the college's day is
// already decided by the server and re-deriving it locally is how a screen shows yesterday
// to somebody an hour ahead.
const ttLongDate = (d) => {
  const [y, m, dd] = String(d || "").split("-").map(Number);
  if (!y) return "";
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${DAYS[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]} ${dd} ${MONTHS[m - 1]}`;
};

// What the student was marked, as they should read it.
//
// "Not marked" is SLATE and is its own state, never red. A class nobody has taken a
// register for is a fact about the CLASS; being absent is a fact about the STUDENT, and a
// screen that paints them alike starts a support conversation from a false premise. Only
// shown once a class has happened — an unmarked future class is not missing anything.
const TT_MARK = {
  P: { label: "Present", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  L: { label: "Late", cls: "bg-amber-50 text-amber-700 ring-amber-200" },
  E: { label: "Excused", cls: "bg-sky-50 text-sky-700 ring-sky-200" },
  A: { label: "Absent", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
};

// The Monday of a date's week, and the number of whole weeks between two dates.
//
// WEEK NUMBER COMES FROM THE CALENDAR, NOT FROM THE ROW INDEX. Numbering rows made two
// classes on the SAME DAY -- a 09:00-12:00 morning and a 14:00-17:00 afternoon, which is
// an ordinary shape here -- read as week 1 and week 2, so a module taught twice a day
// appeared to run for twice as many weeks as it does. Reported exactly that way.
//
// Monday-anchored so a Friday and the following Monday are different weeks while a
// Monday and the Friday after it are the same one, which is what "week 3 of the module"
// means to everybody who says it.
const ttWeekStart = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
};
const ttWeeksBetween = (a, b) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 604800000);

/**
 * The timetable, MODULE BY MODULE.
 *
 * Two earlier shapes were rejected against this one, and the reasons are the design.
 *
 * A FLAT LIST OF EVERY DATE repeated the module name, room and lecturer on all twelve
 * copies of a weekly class — the same noise as the college's own sheet writing
 * "TEACHING" eight times down a column.
 *
 * A WEEK AT A TIME fixed the repetition and lost the thing a student opens this for:
 * "when is Financial Analysis on", which is a question about a module, not about a
 * Tuesday. It also put a fifth of the screen behind a next-week button.
 *
 * So: one block per module, its name and colour said ONCE, then its dates. Constant
 * facts are hoisted into the header — a module taught by one person in one room says so
 * at the top and drops both columns entirely, which is most modules and is the whole
 * reason this reads as a timetable rather than a spreadsheet. What varies stays in the
 * table, because that is what the table is for.
 */
function ModuleTimetable({ events, today }) {
  const groups = [];
  const byKey = new Map();
  for (const ev of events) {
    const key = ev.unitCode || ev.title;
    if (!byKey.has(key)) { const g = { key, items: [], colour: ttColour(ev), title: ev.unitName || ev.title, code: ev.unitCode }; byKey.set(key, g); groups.push(g); }
    byKey.get(key).items.push(ev);
  }

  const one = (list, pick) => { const set = new Set(list.map(pick).filter(Boolean)); return set.size === 1 ? [...set][0] : null; };

  return (
    <>
      {groups.map((g) => {
        // Hoisted only when EVERY class agrees. One room for eleven weeks and a different
        // room for the twelfth is exactly the week somebody turns up to the wrong door,
        // so a single exception keeps the column and shows it on every row.
        const room = one(g.items, (e) => [e.room ? `Room ${e.room}` : null, e.floor, e.campus].filter(Boolean).join(" · "));
        const staff = one(g.items, (e) => (e.staff || []).join(", "));
        const time = one(g.items, (e) => `${e.start}–${e.end}`);
        // The course and the school do not vary within a module and never belong in a
        // row. They answer a question the rest of this card does not: not "where do I go"
        // but "what is this hour FOR" — which qualification it counts towards and who
        // runs it. A student chasing a mark needs the school's name to know who to ask.
        const course = one(g.items, (e) => e.course);
        const school = one(g.items, (e) => e.school);
        return (
          <div key={g.key} className="mb-3 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70">
            <div className="px-3.5 py-3 text-white" style={{ background: g.colour }}>
              <p className="text-[15px] font-extrabold leading-tight">{g.title}</p>
              {/* WRAPPED, NOT TRUNCATED, and that is the width fix.
                  These lines were `truncate` inside a single flex row, so on a phone the
                  room and the lecturer were cut to an ellipsis and the course and school
                  would have had nowhere to go at all. A timetable that hides the room is
                  not narrower, it is wrong — so the facts wrap onto as many lines as they
                  need and the card grows instead. */}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] leading-snug text-white/90">
                {g.code && <span className="rounded bg-white/20 px-1.5 py-0.5 font-bold tabular-nums">{g.code}</span>}
                {time && <span className="tabular-nums font-semibold">{time}</span>}
                {room && <span>{room}</span>}
                {staff && <span>{staff}</span>}
              </div>
              {(course || school) && (
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-snug text-white/70">
                  {course && <span>{course}</span>}
                  {course && school && <span aria-hidden="true">·</span>}
                  {school && <span>{school}</span>}
                </div>
              )}
              <p className="mt-1.5 text-[11px] tabular-nums text-white/70">
                {/* How much of this module is behind them. A term of dates says when to
                    turn up; "3 of 12" is the sentence that tells them where they are in
                    it, which is the question the college's own emails are about. */}
                {g.items.filter((e) => e.date < today).length} of {g.items.length} so far
              </p>
            </div>
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="bg-slate-50 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                  <th scope="col" className="px-3 py-1.5">Wk</th>
                  <th scope="col" className="px-2 py-1.5">Date</th>
                  {!time && <th scope="col" className="px-2 py-1.5">Time</th>}
                  {!room && <th scope="col" className="px-2 py-1.5">Room</th>}
                  {!staff && <th scope="col" className="px-2 py-1.5">Lecturer</th>}
                  <th scope="col" className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {g.items.map((ev, i) => {
                  const isToday = ev.date === today;
                  const past = ev.date < today;
                  const firstOfDay = i === 0 || g.items[i - 1].date !== ev.date;
                  const weekNo = ttWeeksBetween(ttWeekStart(g.items[0].date), ttWeekStart(ev.date)) + 1;
                  // THE TIMETABLE DOES NOT CHECK ANYBODY IN, and that is a deliberate
                  // reversal of a day-old change.
                  //
                  // Rows were briefly tappable, opening the scanner. It conflated two
                  // screens that answer different questions: this one is "when and where
                  // am I this term", read across twelve weeks and mostly about days that
                  // are not today, while checking in is a thing you do once, standing in a
                  // room, about now. Putting the action here put a live control on a
                  // reference document — and on eleven rows out of twelve it had to be
                  // inert, which is its own kind of broken.
                  //
                  // Check In is the screen with the action. What this column shows instead
                  // is what HAPPENED: the mark, or that nobody took the register.
                  return (
                    <tr key={ev.id} className={isToday ? "bg-slate-50" : ""}>
                      {/* Numbered within the MODULE and FROM THE DATE, so "week 3" is the
                          third week this module runs — the way a student and a brief both
                          say it — and two classes on one day share a number instead of
                          inventing a week.

                          The number and the date are printed only on the FIRST row of a
                          day. A module with a morning and an afternoon session used to
                          print the same date twice, one under the other, which is the
                          repetition this screen was rebuilt to remove. */}
                      <td className={`px-3 py-2 text-[12px] tabular-nums ${past ? "text-slate-300" : "text-slate-500"}`}>
                        {firstOfDay ? weekNo : ""}
                      </td>
                      <td className={`whitespace-nowrap px-2 py-2 text-[12px] font-semibold tabular-nums ${past ? "text-slate-400" : "text-slate-700"}`}>
                        {firstOfDay ? ttDMY(ev.date) : ""}
                      </td>
                      {!time && <td className="whitespace-nowrap px-2 py-2 text-[12px] tabular-nums text-slate-500">{ev.start}–{ev.end}</td>}
                      {!room && <td className="px-2 py-2 text-[12px] leading-snug text-slate-500">{[ev.room ? `Room ${ev.room}` : null, ev.floor, ev.campus].filter(Boolean).join(" · ") || "—"}</td>}
                      {!staff && <td className="px-2 py-2 text-[12px] leading-snug text-slate-500">{(ev.staff || []).join(", ") || "—"}</td>}
                      <td className="px-2 py-2 text-right">
                        {ev.status
                          ? <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${TT_MARK[ev.status].cls}`}>{TT_MARK[ev.status].label}</span>
                          : past || isToday
                            ? <span className="text-[10px] text-slate-300">Not marked</span>
                            : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}
function TimetableScreen({ timetable, busy, reload }) {
  if (busy && !timetable) return <LoadingScreen />;
  const stages = timetable?.stages || [];
  const events = timetable?.events || [];
  const today = timetable?.today || "";

  // THE CALENDAR WINS WHERE THERE IS ONE. `stages` is the older weekly grid built from
  // TimetableSlot, which nothing writes any more; `events` are the dated classes the
  // college actually scheduled. Both are rendered rather than one replacing the other,
  // because a college with historic TimetableSlot data should keep seeing it — but the
  // real classes go first, since they are the ones with a room, a date and a register.
  if (events.length) {
    // `stages` is DELIBERATELY NOT RENDERED HERE. It is the college's week-structure
    // sheet — "Week 1 TEACHING, Week 2 TEACHING, Week 3 TEACHING" — which says the same
    // word eight times and carries no room, no time and no lecturer. Printed under the
    // real timetable it read as the timetable repeating itself, which is what was
    // reported. Where there are real classes, they ARE the timetable.
    return (
      <Screen>
        <ModuleTimetable events={events} today={today} />
        <p className="mt-1 px-1 text-center text-[11px] text-slate-400">
          Times and rooms are set by the college. If something looks wrong, message us from &ldquo;Ask the College&rdquo;.
        </p>
      </Screen>
    );
  }

  if (!stages.length) {
    return (
      <Screen>
        <Card className="text-center">
          <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: ACCENT.timetable + "18" }}><CalendarDays size={26} style={{ color: ACCENT.timetable }} /></div>
          <p className="text-base font-extrabold text-slate-800">No timetable yet</p>
          <p className="mt-1 text-sm text-slate-500">Your timetable will appear here once the college publishes it for your course. Pull to refresh, or check back soon.</p>
          <button onClick={reload} className="press mx-auto mt-3 flex items-center gap-1.5 rounded-xl bg-slate-100 px-3 py-2 text-xs font-bold text-slate-600"><RefreshCw size={13} /> Refresh</button>
        </Card>
      </Screen>
    );
  }
  return (
    <Screen>
      {stages.map((st, i) => <TimetableBlock key={`${st.courseId}|${st.year}|${st.termNumber}`} stage={st} i={i} />)}
      <p className="px-1 text-center text-[11px] text-slate-400">Times and rooms are set by the college. If something looks wrong, message us from “Ask the College”.</p>
    </Screen>
  );
}

// "2026-06-01" → "1 Jun 2026" for the term header and week-commencing column.
const ttFmtDate = (d, withYear) => { if (!d) return ""; const dt = new Date(d + "T00:00:00"); return isNaN(dt.getTime()) ? d : dt.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) }); };
// Colour the academic-calendar activities the way the college does: assessment stands
// out most, formative feedback next, teaching is the calm default.
const activityStyle = (a) => {
  const s = String(a || "").toLowerCase();
  if (s.includes("assessment") || s.includes("exam")) return "bg-rose-100 text-rose-700";
  if (s.includes("feedback") || s.includes("formative")) return "bg-amber-100 text-amber-700";
  if (s.includes("break") || s.includes("reading") || s.includes("extra")) return "bg-slate-100 text-slate-500";
  return "bg-emerald-50 text-emerald-700";
};

function TimetableBlock({ stage, i }) {
  const accent = stage.colour || ACCENT.timetable;
  // Group the rows by weekday, in Mon→Sun order, each sorted by start time.
  const byDay = {};
  for (const r of stage.rows) (byDay[r.day] = byDay[r.day] || []).push(r);
  for (const d of Object.keys(byDay)) byDay[d].sort((a, b) => a.start.localeCompare(b.start));
  const days = [1, 2, 3, 4, 5, 6, 7].filter(d => byDay[d]?.length);
  const td = stage.termDates || {};
  const weeks = stage.calendar?.weeks || [];

  return (
    <Card i={i} className="!p-0 overflow-hidden">
      {/* Header band — the intake / course / stage / term dates, like the emailed timetable. */}
      <div className="px-4 py-3.5 text-white" style={{ background: `linear-gradient(135deg, ${accent}, ${NAVY_DARK})` }}>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-white/70">Weekly timetable</p>
        <p className="mt-0.5 text-sm font-extrabold leading-tight">{stage.courseName || "My course"}</p>
        {(stage.year != null || stage.termNumber != null) && (
          <p className="mt-0.5 text-[12px] font-semibold text-white/85">{[stage.year != null ? `Year ${stage.year}` : null, stage.termNumber != null ? `Term ${stage.termNumber}` : null].filter(Boolean).join(" · ")}</p>
        )}
        {(td.start || td.end) && (
          <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-bold"><CalendarDays size={12} /> {ttFmtDate(td.start, true)}{td.start && td.end ? " – " : ""}{ttFmtDate(td.end, true)}</p>
        )}
      </div>

      {days.length > 0 && (
        <div className="divide-y divide-slate-100">
          {days.map(d => (
            <div key={d} className="px-4 py-3">
              <p className="mb-2 text-[11px] font-extrabold uppercase tracking-widest" style={{ color: accent }}>{TT_DAYS[d]}</p>
              <div className="space-y-2">
                {byDay[d].map(r => (
                  <div key={r.id} className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 break-words text-sm font-bold text-slate-800">{r.title}</p>
                      <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-slate-500 ring-1 ring-slate-200">{periodOf(r.start)}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-slate-500">
                      <span className="flex items-center gap-1 font-semibold text-slate-600"><Clock3 size={12} /> {r.start} – {r.end}</span>
                      {r.lecturer && <span className="flex items-center gap-1"><User size={12} /> {r.lecturer}</span>}
                      {r.room && <span className="flex items-center gap-1"><MapPin size={12} /> {r.room}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Academic calendar — the term's weekly structure (Week / Commencing / Activity). */}
      {weeks.length > 0 && (
        <div className="border-t-4 border-slate-100 px-4 py-3">
          <p className="mb-2 text-[11px] font-extrabold uppercase tracking-widest" style={{ color: accent }}>Academic calendar</p>
          <div className="overflow-x-auto rounded-xl ring-1 ring-slate-200">
            <table className="w-full text-[12px]">
              <thead><tr className="bg-slate-50 text-left text-[10px] font-bold uppercase tracking-wide text-slate-400"><th className="px-3 py-2">Wk</th><th className="px-3 py-2">Commencing</th><th className="px-3 py-2">Activity</th></tr></thead>
              <tbody>
                {weeks.map((w, k) => (
                  <tr key={k} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-bold text-slate-600">{w.n}</td>
                    <td className="px-3 py-2 text-slate-500">{ttFmtDate(w.wc)}</td>
                    <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${activityStyle(w.activity)}`}>{w.activity || "Teaching"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ============================== support referrals ============================== */

/*
 * What the student is told about being handed to Wellbeing, ASK or Student Support.
 *
 * THIS SCREEN IS DEFINED BY WHAT IT CANNOT SHOW, IN TWO DIFFERENT WAYS.
 *
 * First, WHICH referrals: only those the referrer ticked "tell the student" on. That
 * filter is a WHERE clause on the server, not a decision here — the tickbox defaults
 * off so a tutor raising a safeguarding concern does not have to remember to suppress
 * anything, and a screen that listed everything would defeat it completely.
 *
 * Second, HOW MUCH of one: the team, the dates, and where it got to. Never the tutor's
 * reason, which is their account of this student written for somebody else, and never
 * the department's case notes, which even the tutor cannot read.
 *
 * So the empty state must not say "you have never been referred" — it is also what a
 * student sees when they were referred and not told, and a portal that let them infer
 * the difference would leak the fact it exists to withhold.
 */

const REF_STATUS = {
  open: { label: "Waiting to be picked up", cls: "bg-amber-50 text-amber-700 ring-amber-200" },
  accepted: { label: "Being worked on", cls: "bg-blue-50 text-blue-700 ring-blue-200" },
  closed: { label: "Closed", cls: "bg-slate-100 text-slate-600 ring-slate-200" },
};

// The outcome CODE in the student's own terms. Codes, never the server's prose — the
// free text written at closure is department-only, and a label list here cannot
// accidentally carry it. An unknown code falls back to "Closed" rather than rendering
// a slug at somebody about their own wellbeing referral.
const REF_OUTCOME = {
  supported: "The team worked with you",
  referred_on: "Passed on to someone else",
  no_response: "The team could not reach you",
  not_appropriate: "Not something this team could help with",
  other: "Closed",
};

function SupportScreen({ referrals, busy, departments, reload }) {
  // Three states on one screen rather than three screens: the list, the form, and one
  // request's thread. A student arriving here is either checking on something or asking
  // for something, and a separate tab for each would put the form behind a tap nobody
  // makes when they are struggling.
  const [mode, setMode] = useState("list");
  const [openRef, setOpenRef] = useState(null);

  if (mode === "form") {
    return (
      <SupportRequestForm
        departments={departments || []}
        onCancel={() => setMode("list")}
        onSent={() => { setMode("list"); reload && reload(); }}
      />
    );
  }
  if (mode === "thread" && openRef) {
    // Re-read from the freshest list, so a status that changed while the thread was open
    // is not rendered from a stale copy.
    const live = (referrals || []).find((r) => r.id === openRef.id) || openRef;
    return <SupportThread referral={live} onClose={() => { setMode("list"); setOpenRef(null); reload && reload(); }} />;
  }
  return (
    <SupportList
      referrals={referrals} busy={busy} departments={departments}
      onNew={() => setMode("form")}
      onOpen={(r) => { setOpenRef(r); setMode("thread"); }}
    />
  );
}

function SupportList({ referrals, busy, departments, onNew, onOpen }) {
  if (referrals === null) return busy ? <LoadingScreen /> : (
    <Screen><ErrBox>Could not load your support referrals.</ErrBox></Screen>
  );

  return (
    <Screen>
      {/* The way IN, above the list, because that is what somebody has come to do. Shown
          only when the college actually runs a support desk — a button that opens a form
          with no teams on it is worse than no button. */}
      {(departments || []).length > 0 && (
        <button onClick={onNew}
          className="press flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-bold text-white shadow-lg"
          style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}>
          <HeartHandshake size={16} /> Ask for support
        </button>
      )}

      {referrals.length === 0 ? (
        <Card className="!p-0">
          <Empty
            icon={HeartHandshake}
            title="Nothing to show"
            msg="Ask a support team for help using the button above. Anything a tutor refers you for, and tells you about, appears here too."
          />
        </Card>
      ) : (
        <>
          <SectionTitle>Support referrals · {referrals.length}</SectionTitle>
          {referrals.map((r, i) => {
            const st = REF_STATUS[r.status] || REF_STATUS.closed;
            const mine = r.selfReferred === true;
            const Row = mine ? "button" : "div";
            return (
              <Card key={r.id} i={Math.min(i, 6)}>
                <Row {...(mine ? { onClick: () => onOpen(r), className: "w-full text-left" } : {})}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    {/* The NAME, resolved by the server. A slug is what the database
                        stores and is not something to show anybody about themselves. */}
                    <p className="text-sm font-extrabold text-slate-800">{r.departmentName}</p>
                    <p className="mt-0.5 text-[11px] text-slate-400">Referred {r.raisedOn}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold ring-1 ${st.cls}`}>{st.label}</span>
                </div>
                {/* Their own words, read back — present only on a request they made. */}
                {mine && r.reason && (
                  <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-slate-600">{r.reason}</p>
                )}
                <p className="mt-1 text-[11px] text-slate-400">
                  {mine ? "You asked for this" : "Your tutor referred you"}
                  {mine && r.status !== "closed" ? " · tap to add to it" : ""}
                </p>
                {r.status === "closed" && (
                  <p className="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-[12px] font-semibold text-slate-600 ring-1 ring-slate-100">
                    {REF_OUTCOME[r.outcome] || "Closed"}
                    {r.closedOn ? <span className="ml-1 font-normal text-slate-400">· {r.closedOn}</span> : null}
                  </p>
                )}
                </Row>
              </Card>
            );
          })}
        </>
      )}

      <Card className="!bg-blue-50/70 !ring-blue-100">
        <p className="flex items-start gap-2 text-[11px] leading-relaxed text-blue-800">
          <Info size={13} className="mt-px shrink-0" />
          This shows which team you were referred to and where it got to. What you talk to that team about
          stays between you and them — it is not shown here and it is not shown to your tutor.
        </p>
      </Card>
    </Screen>
  );
}

/*
 * Asking a support team for help — the Wellbeing and ASK forms.
 *
 * ONE FORM PER TEAM, GENERATED FROM THE COLLEGE'S OWN LIST, not two components with
 * "Wellbeing" and "ASK" typed into them. The department list is configuration an
 * administrator edits at runtime; a college that renames ASK, or runs Wellbeing and
 * Student Support as one desk, gets its own words with no code change — and a hardcoded
 * pair would quietly stop matching the queues these requests land in.
 *
 * WHAT THE STUDENT IS TOLD, AND WHY EACH SENTENCE IS THERE. Somebody opening a wellbeing
 * form is often not in a state to read carefully, so the screen answers the three
 * questions they actually have, in the order they have them: who reads this, what
 * happens next, and what to do if it is an emergency. The last one is not a legal
 * disclaimer — a support queue worked in office hours is the wrong place for a crisis,
 * and saying so plainly is safer than a form that implies somebody is watching it now.
 */
function SupportRequestForm({ departments, onSent, onCancel }) {
  const [dept, setDept] = useState("");
  const [reason, setReason] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const chosen = departments.find((d) => d.key === dept);
  const valid = !!dept && reason.trim().length >= 3;

  const send = async () => {
    if (!valid) return;
    setBusy(true); setErr("");
    try {
      await api.sendStudentReferral({ department: dept, reason: reason.trim(), urgency: urgent ? "urgent" : "routine" });
      onSent();
    } catch (e) {
      // A 409 is not a fault — it means an earlier request to the same team is still
      // open. The server's own words say so and name the team, which is more use than
      // anything this screen could invent.
      setErr(e.message || "Could not send your request.");
    } finally { setBusy(false); }
  };

  return (
    <Screen>
      <Card>
        <p className="text-sm font-extrabold text-slate-800">Ask for support</p>
        <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
          Your request goes straight to the team you choose. They will pick it up and get in touch —
          you can see where it has got to on this screen at any time.
        </p>

        <div className="mt-3">
          <label className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Which team</label>
          <div className="mt-1.5 space-y-2">
            {departments.map((d) => (
              <button
                key={d.key}
                onClick={() => setDept(d.key)}
                className={`press flex w-full items-center gap-2.5 rounded-xl px-3 py-3 text-left ring-1 transition ${dept === d.key ? "bg-blue-50 ring-blue-300" : "bg-white ring-slate-200"}`}
              >
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-1 ${dept === d.key ? "ring-transparent" : "ring-slate-300"}`} style={dept === d.key ? { background: NAVY } : {}}>
                  {dept === d.key && <CheckCircle2 size={13} className="text-white" />}
                </span>
                <span className="text-sm font-bold text-slate-700">{d.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3">
          <label className="text-[11px] font-bold uppercase tracking-wide text-slate-400">What do you need help with?</label>
          <textarea
            value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} rows={6}
            placeholder="In your own words. As much or as little as you want to say."
            className="mt-1 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:ring-2"
            style={{ "--tw-ring-color": NAVY }}
          />
          {/* Said explicitly, because the difference between this and the case notes is
              invisible from here: what they write IS shown back to them, and it is the
              one field both sides of a referral can read. */}
          <p className="mt-1 text-[11px] text-slate-400">
            {chosen ? `Only ${chosen.name} will see this.` : "Only the team you choose will see this."} You can read it back here afterwards.
          </p>
        </div>

        <button
          onClick={() => setUrgent((v) => !v)} disabled={busy}
          className={`press mt-3 flex w-full items-center gap-2.5 rounded-xl px-3 py-3 text-left ring-1 transition ${urgent ? "bg-rose-50 ring-rose-300" : "bg-white ring-slate-200"}`}
        >
          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ring-1 ${urgent ? "ring-transparent" : "ring-slate-300"}`} style={urgent ? { background: "#e11d48" } : {}}>
            {urgent && <CheckCircle2 size={13} className="text-white" />}
          </span>
          <span>
            <span className="block text-sm font-bold text-slate-700">This is urgent</span>
            <span className="block text-[11px] text-slate-400">Moves it to the top of their list.</span>
          </span>
        </button>

        {err && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600">{err}</p>}

        <div className="mt-4 flex gap-2">
          <button onClick={onCancel} disabled={busy} className="press flex-1 rounded-xl bg-slate-100 py-3 text-sm font-bold text-slate-500">Cancel</button>
          <button
            onClick={send} disabled={busy || !valid}
            className="press flex flex-[2] items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold text-white shadow disabled:opacity-50"
            style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}
          >
            {busy ? <><Loader2 size={15} className="animate-spin" /> Sending…</> : <><Send size={15} /> Send request</>}
          </button>
        </div>
      </Card>

      {/* NOT a legal disclaimer. A queue worked in office hours is the wrong place for a
          crisis, and a form that stays silent about that implies somebody is watching it
          right now. Last on the screen, so it is the thing still in view after they
          send. */}
      <Card className="!bg-amber-50/70 !ring-amber-200">
        <p className="flex items-start gap-2 text-[11px] leading-relaxed text-amber-900">
          <AlertTriangle size={13} className="mt-px shrink-0 text-amber-600" />
          <span>
            <b>If you need help right now</b>, do not wait for a reply here — this is checked during college
            hours. Contact the college directly, call <b>111</b>, or in an emergency call <b>999</b>.
          </span>
        </p>
      </Card>
    </Screen>
  );
}

/* The conversation on a request the student raised themselves. */
function SupportThread({ referral, onClose }) {
  const [messages, setMessages] = useState(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = () => api.studentReferralMessages(referral.id).then(setMessages).catch(() => setMessages([]));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [referral.id]);

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true); setErr("");
    try { await api.addStudentReferralMessage(referral.id, body); setDraft(""); await load(); }
    catch (e) { setErr(e.message || "Could not send."); }
    finally { setBusy(false); }
  };

  return (
    <Screen>
      <button onClick={onClose} className="press flex items-center gap-1 text-[12px] font-bold text-slate-500">
        <ChevronLeft size={14} /> Back
      </button>

      <Card>
        <p className="text-sm font-extrabold text-slate-800">{referral.departmentName}</p>
        <p className="mt-0.5 text-[11px] text-slate-400">You asked on {referral.raisedOn}</p>
        {/* Their own words, read back. sReferralForStudent sends `reason` only on a
            self-referral — on a tutor's referral it is that tutor's account of them and
            never crosses. */}
        {referral.reason && (
          <p className="mt-2 whitespace-pre-wrap rounded-xl bg-slate-50 px-3 py-2 text-[12px] leading-relaxed text-slate-600 ring-1 ring-slate-100">{referral.reason}</p>
        )}
      </Card>

      {messages === null && <Card><div className="flex justify-center py-6"><Loader2 size={20} className="animate-spin text-slate-300" /></div></Card>}
      {messages && messages.length === 0 && (
        <Card className="!p-0"><Empty icon={MessageSquare} title="Nothing yet" msg="Anything you or the team add will appear here." /></Card>
      )}
      {messages && messages.length > 0 && (
        <div className="space-y-2">
          {messages.map((m) => (
            <Card key={m.id} className={m.authorRole === "student" ? "!bg-blue-50 !ring-blue-100" : ""}>
              <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                {m.authorRole === "student" ? "You" : referral.departmentName}
              </p>
              <p className="mt-0.5 whitespace-pre-wrap text-[12px] leading-relaxed text-slate-700">{m.body}</p>
            </Card>
          ))}
        </div>
      )}

      {referral.status !== "closed" ? (
        <Card>
          <label className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Add to your request</label>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} disabled={busy} rows={4}
            placeholder="Anything else they should know."
            className="mt-1 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:ring-2"
            style={{ "--tw-ring-color": NAVY }} />
          {err && <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600">{err}</p>}
          <button onClick={send} disabled={busy || !draft.trim()}
            className="press mt-2 flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold text-white shadow disabled:opacity-50"
            style={{ background: NAVY }}>
            {busy ? <><Loader2 size={15} className="animate-spin" /> Sending…</> : <><Send size={15} /> Send</>}
          </button>
        </Card>
      ) : (
        <Card className="!bg-slate-50">
          <p className="text-[11px] leading-relaxed text-slate-500">
            This request has been closed. If you need something else, send a new one.
          </p>
        </Card>
      )}
    </Screen>
  );
}

/* ============================== ask the college ============================== */

function QueryScreen({ queries = [], reload }) {
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);   // compose panel

  const submit = async () => {
    setErr(""); setOk(false);
    if (message.trim().length < 3) { setErr("Please write your query."); return; }
    setBusy(true);
    try {
      await api.submitStudentQuery(subject.trim() || "Student query", message.trim());
      setSubject(""); setMessage(""); setOk(true); setOpen(false); reload && reload();
    } catch (e) { setErr(e.message || "Could not send your query."); }
    finally { setBusy(false); }
  };

  return (
    <Screen>
      {!open ? (
        <button onClick={() => { setOpen(true); setOk(false); }} className="press flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-bold text-white shadow-lg" style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}>
          <Send size={16} /> Ask a question
        </button>
      ) : (
        <Card>
          <p className="flex items-center gap-1.5 text-[11px] leading-relaxed text-slate-500"><Info size={13} className="shrink-0 text-blue-500" /> Your message goes to the college office. Their reply appears below.</p>
          <div className="mt-3">
            <label className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Subject</label>
            <input value={subject} onChange={e => setSubject(e.target.value)} disabled={busy} placeholder="e.g. Attendance query" className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:ring-2" style={{ "--tw-ring-color": NAVY }} />
          </div>
          <div className="mt-3">
            <label className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Your query</label>
            <textarea value={message} onChange={e => setMessage(e.target.value)} disabled={busy} rows={5} placeholder="Write your question or request here…" className="mt-1 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:ring-2" style={{ "--tw-ring-color": NAVY }} />
          </div>
          {err && <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600">{err}</p>}
          <div className="mt-3 flex gap-2">
            <button onClick={() => { setOpen(false); setErr(""); }} disabled={busy} className="press flex-1 rounded-xl border-2 border-slate-200 py-2.5 text-sm font-bold text-slate-500">Cancel</button>
            <button onClick={submit} disabled={busy} className="press flex flex-[2] items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold text-white shadow-lg disabled:opacity-60" style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}>
              {busy ? <><Loader2 size={16} className="animate-spin" /> Sending…</> : <><Send size={16} /> Send</>}
            </button>
          </div>
        </Card>
      )}

      {ok && <div className="flex items-center gap-2 rounded-2xl bg-emerald-50 px-3.5 py-3 text-xs font-bold text-emerald-700 ring-1 ring-emerald-200"><CheckCircle2 size={15} /> Sent — the college will reply here.</div>}

      <SectionTitle colour={ACCENT.ask}>Your conversations</SectionTitle>
      {queries.length === 0 && <Card className="!p-0"><Empty icon={MessageSquare} title="No questions yet" msg="Anything you ask the college will appear here, with their reply." /></Card>}

      {/* Conversation style: your message on the right, the college's reply on the left. */}
      {queries.map(q => (
        <div key={q.id} className="space-y-1.5">
          <div className="flex items-center gap-2 px-1">
            <p className="flex-1 truncate text-[12px] font-extrabold text-slate-600">{q.subject}</p>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${q.status === "open" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>{q.status === "open" ? "Awaiting reply" : "Answered"}</span>
          </div>
          <div className="flex justify-end">
            <div className="max-w-[85%] break-words rounded-2xl rounded-br-md px-3.5 py-2.5 text-sm leading-relaxed text-white shadow-sm" style={{ background: NAVY }}>
              {q.message}
              <p className="mt-1 text-[10px] text-white/60">{fmtDate(String(q.createdAt).slice(0, 10))}</p>
            </div>
          </div>
          {q.response ? (
            <div className="flex justify-start">
              <div className="max-w-[85%] break-words rounded-2xl rounded-bl-md bg-white px-3.5 py-2.5 text-sm leading-relaxed text-slate-700 shadow-sm ring-1 ring-slate-200/70">
                <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-blue-600">College{q.respondedBy ? ` · ${q.respondedBy}` : ""}</p>
                {q.response}
                {q.respondedAt && <p className="mt-1 text-[10px] text-slate-400">{fmtDate(q.respondedAt)}</p>}
              </div>
            </div>
          ) : (
            <p className="px-1 text-[11px] text-slate-400">Awaiting a reply from the college.</p>
          )}
        </div>
      ))}
    </Screen>
  );
}

/* ============================== more ============================== */

// What the More screen says about check-in, in every state. This exists so there is one
// place a student — or the person setting the college up — can always look and get a
// straight answer, rather than an absence they have to interpret.
function CheckInStatusRow({ tapContext, setScreen }) {
  const loading = tapContext == null;
  // BOTH switches, not just the sticker one. A college running codes only had this row
  // saying check-in was not switched on while the Check In tab, three taps away, said
  // "Scan to check in" — the same two switches the tab already reads.
  const stickers = !loading && tapContext.enabled;
  const codes = !loading && tapContext.qrEnabled;
  const off = !loading && !stickers && !codes;
  const running = (tapContext?.now || []).length;
  const next = tapContext?.next;

  // Named for what the student can actually do. "with a sticker" is only true where the
  // sticker is the only way in.
  const title = stickers && !codes ? "Check in with a sticker" : "Check in";
  const Glyph = codes ? QrCode : Nfc;

  const body = loading
    ? "Checking…"
    : off
      ? "Your college hasn't switched check-in on yet. When it does, the Check In tab will show you how."
      : running
        ? `${running > 1 ? "Your classes are running now" : `${tapContext.now[0].unitName || tapContext.now[0].unitCode} is running now`}. ${codes && !stickers ? "Open the Check In tab and scan the code on screen." : "Open the Check In tab."}`
        : next
          ? `Nothing to check in to yet. Your next class starts at ${next.startTime}.`
          : "No more classes today.";

  return (
    <button
      type="button"
      onClick={() => setScreen("checkin")}
      disabled={loading || off}
      className="press flex w-full items-start gap-3 rounded-2xl bg-white p-4 text-left ring-1 ring-slate-200 disabled:cursor-default"
    >
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ background: off ? "#f1f5f9" : NAVY + "14" }}>
        <Glyph size={17} style={{ color: off ? "#94a3b8" : NAVY }} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-bold text-slate-800">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-slate-500">{body}</span>
      </span>
    </button>
  );
}

function MoreScreen({ user, logout, setScreen, tapContext }) {
  const [cur, setCur] = useState(""); const [nw, setNw] = useState(""); const [cf, setCf] = useState("");
  const [pwBusy, setPwBusy] = useState(false); const [pwErr, setPwErr] = useState(""); const [pwOk, setPwOk] = useState(false);
  const [openPw, setOpenPw] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const [showDel, setShowDel] = useState(false);
  // Back collapses the delete-account form first (it holds a typed password), the
  // same way the sign-out ConfirmDialog cancels on back.
  useBackHandler(showDel, () => { setShowDel(false); return true; });
  const [delPw, setDelPw] = useState(""); const [delConfirm, setDelConfirm] = useState("");
  const [delBusy, setDelBusy] = useState(false); const [delErr, setDelErr] = useState("");

  const changePw = async () => {
    setPwErr(""); setPwOk(false);
    if (nw.length < 8) { setPwErr("New password must be at least 8 characters."); return; }
    if (nw !== cf) { setPwErr("New passwords do not match."); return; }
    setPwBusy(true);
    try { const res = await api.changePassword(cur, nw); if (res?.token) setToken(res.token); try { const m = await import("./rememberEmail"); m.forgetRememberedPassword(); } catch (_) {} setCur(""); setNw(""); setCf(""); setPwOk(true); setOpenPw(false); }
    catch (e) { setPwErr(e.message || "Could not change your password."); }
    finally { setPwBusy(false); }
  };

  const del = async () => {
    setDelErr("");
    if (delConfirm.trim().toUpperCase() !== "DELETE") { setDelErr('Type DELETE to confirm.'); return; }
    setDelBusy(true);
    try { await api.deleteAccount(delPw, delConfirm.trim().toUpperCase()); logout(); }
    catch (e) { setDelErr(e.message || "Could not delete your account."); setDelBusy(false); }
  };

  return (
    <Screen>
      <ConfirmDialog open={confirmOut} title="Sign out?" message="You'll need to sign in again to get back in." confirmLabel="Sign out" cancelLabel="Stay" danger onConfirm={logout} onCancel={() => setConfirmOut(false)} />

      {/* Profile */}
      <Card className="!p-5 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl text-xl font-bold text-white shadow-lg" style={{ background: user.colour || MAROON }}>{user.initials || "S"}</div>
        <p className="mt-2.5 text-base font-extrabold text-slate-800">{user.name}</p>
        <p className="text-xs text-slate-400">{user.email}</p>
        {user.studentRef && <span className="mt-2 inline-block rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-500">Student · {user.studentRef}</span>}
      </Card>

      {/* Always present, in every state. The home card only appears when a class is
          actually checkable, which is right for a student but left nobody able to tell
          "switched off" from "not built" — the reason this was reported missing. */}
      <CheckInStatusRow tapContext={tapContext} setScreen={setScreen} />

      {/* The second way in. Home only shows a review card once one exists, so this row
          is what makes the screen findable — and it's here whether there are any or not. */}
      <Card className="!p-0 overflow-hidden">
        <Row Icon={CalendarDays} label="My timetable" sub="Your weekly classes" onClick={() => setScreen("timetable")} />
        <Row Icon={Info} label="My progress reviews" sub="What your lecturers have written" onClick={() => setScreen("reviews")} />
        {/* Reached from More rather than the tab bar: six tabs is already the most a
            thumb can find, and this is a screen a student visits when something has
            happened rather than every day. */}
        <Row Icon={HeartHandshake} label="Support referrals" sub="Teams you have been referred to" onClick={() => setScreen("support")} />
      </Card>

      {pwOk && <div className="flex items-center gap-2 rounded-2xl bg-emerald-50 px-3.5 py-3 text-xs font-bold text-emerald-700 ring-1 ring-emerald-200"><CheckCircle2 size={15} /> Password changed.</div>}

      {/* Settings rows */}
      <Card className="!p-0 overflow-hidden">
        {/* Always renders something — the options, or why they aren't available. */}
        <BiometricSetting owner={user.email} />
        <Row Icon={KeyRound} label="Change password" sub="Update your sign-in password" onClick={() => setOpenPw(v => !v)} open={openPw} />
        {openPw && (
          <div className="space-y-2.5 border-t border-slate-100 bg-slate-50 p-3.5">
            <PwField label="Current password" value={cur} onChange={setCur} disabled={pwBusy} />
            <PwField label="New password" value={nw} onChange={setNw} disabled={pwBusy} />
            <PwField label="Confirm new password" value={cf} onChange={setCf} disabled={pwBusy} />
            {pwErr && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600">{pwErr}</p>}
            <button onClick={changePw} disabled={pwBusy || !cur || !nw} className="press flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold text-white shadow disabled:opacity-60" style={{ background: NAVY }}>
              {pwBusy ? <><Loader2 size={15} className="animate-spin" /> Saving…</> : <><Lock size={15} /> Update password</>}
            </button>
          </div>
        )}
        <Row Icon={LogOut} label="Sign out" sub="You'll need to sign in again" onClick={() => setConfirmOut(true)} />
      </Card>

      {/* Danger zone */}
      <Card className="!p-0 overflow-hidden !ring-rose-200">
        {!showDel ? (
          <Row Icon={Trash2} label="Delete my account" sub="Permanently remove your app access" danger onClick={() => setShowDel(true)} />
        ) : (
          <div className="space-y-2.5 p-3.5">
            <p className="flex items-start gap-1.5 rounded-xl bg-rose-50 px-3 py-2.5 text-[11px] leading-relaxed text-rose-700 ring-1 ring-rose-200">
              <AlertTriangle size={14} className="mt-px shrink-0" />
              This removes your sign-in access and personal login data. Your college records (attendance and results) are kept by the college. This cannot be undone.
            </p>
            <PwField label="Your password" value={delPw} onChange={setDelPw} disabled={delBusy} />
            <div>
              <label className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Type DELETE to confirm</label>
              <input value={delConfirm} onChange={e => setDelConfirm(e.target.value)} disabled={delBusy} placeholder="DELETE" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:ring-2" style={{ "--tw-ring-color": MAROON }} />
            </div>
            {delErr && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600">{delErr}</p>}
            <div className="flex gap-2">
              <button onClick={() => { setShowDel(false); setDelErr(""); }} disabled={delBusy} className="press flex-1 rounded-xl border-2 border-slate-200 py-2.5 text-sm font-bold text-slate-500">Cancel</button>
              <button onClick={del} disabled={delBusy || !delPw} className="press flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold text-white shadow disabled:opacity-60" style={{ background: MAROON }}>
                {delBusy ? <><Loader2 size={15} className="animate-spin" /> Deleting…</> : <><Trash2 size={15} /> Delete</>}
              </button>
            </div>
          </div>
        )}
      </Card>

      <p className="px-1 pb-2 text-center text-[10px] text-slate-400">EdTech · Student Hub</p>
    </Screen>
  );
}

function Row({ Icon, label, sub, onClick, danger, open }) {
  return (
    <button onClick={onClick} className="press flex w-full items-center gap-3 border-t border-slate-100 px-3.5 py-3.5 text-left first:border-t-0">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${danger ? "bg-rose-50" : "bg-slate-100"}`}>
        <Icon size={16} className={danger ? "text-rose-500" : "text-slate-500"} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-[13px] font-bold ${danger ? "text-rose-600" : "text-slate-700"}`}>{label}</span>
        <span className="block truncate text-[11px] text-slate-400">{sub}</span>
      </span>
      <ChevronRight size={16} className={`shrink-0 text-slate-300 transition-transform ${open ? "rotate-90" : ""}`} />
    </button>
  );
}

function PwField({ label, value, onChange, disabled }) {
  // One hook per instance, so each field on the change-password form reveals on its own.
  const pw = useReveal();
  return (
    <div>
      <label className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</label>
      <div className="relative mt-1">
        <input type={pw.type} value={value} onChange={e => onChange(e.target.value)} disabled={disabled} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 pr-11 text-sm outline-none focus:ring-2" style={{ "--tw-ring-color": NAVY }} />
        {pw.button}
      </div>
    </div>
  );
}
