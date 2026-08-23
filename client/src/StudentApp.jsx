import React, { useState, useEffect, useCallback, useRef } from "react";
import useReveal from "./RevealButton";
import PhoneShell from "./PhoneShell";
import { BrandMark } from "./Brand";
import ConfirmDialog from "./ConfirmDialog";
import { useBackHandler } from "./backButton";
import { api, setToken } from "./api";
// The same Face ID / fingerprint control the staff app uses, so both halves behave
// identically and there is one implementation to keep correct.
import { BiometricSetting } from "./StaffHub";
import {
  Percent, Award, MessageSquare, LogOut, ChevronLeft, ChevronRight,
  Loader2, Send, CheckCircle2, Info, ArrowRight, RefreshCw,
  Settings, KeyRound, Lock, Trash2, AlertTriangle, Home as HomeIcon,
  Clock3, CalendarCheck, CalendarDays, Sparkles, User, MapPin,
} from "lucide-react";

import { NAVY, NAVY_DARK, MAROON } from "./branding";
// Section accents. Checked as an adjacent colour-blind-safe set (worst pair ΔE 16.4),
// so the four areas stay tellable apart for every reader — and each still carries its
// own icon and label, so colour is never the only signal.
const ACCENT = { attendance: "#4f46e5", results: "#0891b2", ask: "#be123c", timetable: "#0d7a5f", more: "#7c3aed" };
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

// Five is the ceiling here: a sixth tab drops each target below the 44px it needs on a
// 320px phone. Reviews are reached from the home screen and from More instead.
const TABS = [
  { key: "home", label: "Home", Icon: HomeIcon },
  { key: "attendance", label: "Attendance", Icon: Percent },
  { key: "assessments", label: "Results", Icon: Award },
  { key: "query", label: "Ask", Icon: MessageSquare },
  { key: "more", label: "More", Icon: Settings },
];

export default function StudentApp({ user, logout }) {
  const [screen, setScreen] = useState("home");
  const [queries, setQueries] = useState([]);
  const [attendance, setAttendance] = useState(null);
  const [results, setResults] = useState(null);
  const [reviews, setReviews] = useState(null);
  const [timetable, setTimetable] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(true);
  // Android back returns to the home screen from any other tab.
  useBackHandler(screen !== "home", () => { setScreen("home"); return true; });

  // Everything the app shows is loaded once, here, so the home screen can summarise
  // attendance and results without each tab refetching the same thing.
  const load = useCallback(async () => {
    setBusy(true); setErr("");
    const [a, r, q, v, tt] = await Promise.allSettled([
      api.studentAttendance(), api.studentAssessments(), api.studentQueries(), api.studentReviewsAboutMe(), api.studentTimetable(),
    ]);
    if (a.status === "fulfilled") setAttendance(a.value);
    if (r.status === "fulfilled") setResults(r.value);
    if (q.status === "fulfilled") setQueries(q.value);
    if (v.status === "fulfilled") setReviews(v.value);
    // The timetable is a bonus screen — a failure here shouldn't add to the error
    // banner that gates the core screens, so it's loaded but not counted in `failed`.
    if (tt.status === "fulfilled") setTimetable(tt.value);
    // ANY failure is reported, not only a total one. Requiring all of them to fail meant
    // a single broken call showed the student "Not graded yet" or "0 sessions" — an
    // answer, and a wrong one — instead of telling them something didn't load.
    const failed = [a, r, q, v].filter(x => x.status === "rejected");
    if (failed.length) {
      const which = [a.status === "rejected" && "attendance", r.status === "rejected" && "results", q.status === "rejected" && "messages", v.status === "rejected" && "reviews"].filter(Boolean);
      setErr(failed.length === 4
        ? (failed[0].reason?.message || "Could not load your information")
        : `Could not load your ${which.join(" or ")}. Tap the refresh icon at the top to try again — everything else here is up to date.`);
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

  const title = { home: "Student Hub", attendance: "My Attendance", assessments: "My Results", reviews: "My Reviews", query: "Ask the College", timetable: "My Timetable", more: "More" }[screen];
  const shared = { attendance, results, reviews, queries, timetable, busy, err, reload: load, setScreen };

  return (
    <PhoneShell header={<Header title={title} screen={screen} setScreen={setScreen} user={user} onRefresh={load} busy={busy} />}>
      <div className="flex min-h-full flex-col">
        <div className="flex-1" style={{ background: "linear-gradient(180deg,#f6f8fc 0%,#eef2f9 60%,#f6f8fc 100%)" }}>
          {screen === "home" && <Home user={user} {...shared} newReplies={newReplies} newReviews={newReviews} />}
          {screen === "attendance" && <AttendanceScreen {...shared} />}
          {screen === "assessments" && <ResultsScreen {...shared} />}
          {screen === "reviews" && <ReviewsScreen {...shared} />}
          {screen === "timetable" && <TimetableScreen timetable={timetable} busy={busy} reload={load} />}
          {screen === "query" && <QueryScreen queries={queries} reload={load} />}
          {screen === "more" && <MoreScreen user={user} logout={logout} setScreen={setScreen} />}
        </div>
        <TabBar screen={screen} setScreen={setScreen} newReplies={newReplies} />
      </div>
    </PhoneShell>
  );
}

// Persistent bottom navigation — the single biggest thing that makes this feel like
// an app rather than a website: every section is one thumb-tap away, always.
function TabBar({ screen, setScreen, newReplies }) {
  return (
    <nav className="sticky bottom-0 z-30 mt-2 flex border-t border-slate-200/80 bg-white/90 backdrop-blur-xl" style={{ paddingBottom: "env(safe-area-inset-bottom)", boxShadow: "0 -6px 20px -12px rgba(15,23,42,.25)" }}>
      {TABS.map(({ key, label, Icon }) => {
        const on = screen === key;
        return (
          <button key={key} onClick={() => setScreen(key)} aria-current={on ? "page" : undefined}
            className="press relative flex flex-1 flex-col items-center gap-1 py-2">
            <span className="relative flex h-8 w-14 items-center justify-center rounded-2xl transition-all duration-200"
              style={on ? { background: NAVY + "14" } : undefined}>
              <Icon size={20} strokeWidth={on ? 2.6 : 2} style={{ color: on ? NAVY : "#9aa5b8" }} />
              {key === "query" && newReplies > 0 && (
                <span className="pop absolute right-1.5 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[9px] font-extrabold text-slate-900 ring-2 ring-white">{newReplies}</span>
              )}
            </span>
            <span className="text-[10px] font-bold tracking-tight" style={{ color: on ? NAVY : "#9aa5b8" }}>{label}</span>
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

function Home({ user, attendance, results, queries, reviews, busy, err, setScreen, newReplies, newReviews }) {
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
        <Action onClick={() => setScreen("attendance")} Icon={Percent} label="My Attendance" sub="By unit" c={ACCENT.attendance} i={0} />
        <Action onClick={() => setScreen("assessments")} Icon={Award} label="My Results" sub="Marks & grades" c={ACCENT.results} i={1} />
        <Action onClick={() => setScreen("timetable")} Icon={CalendarDays} label="My Timetable" sub="Weekly classes" c={ACCENT.timetable} i={2} />
        <Action onClick={() => setScreen("query")} Icon={MessageSquare} label="Ask the College" sub={newReplies ? `${newReplies} new repl${newReplies === 1 ? "y" : "ies"}` : "Send a query"} c={ACCENT.ask} badge={newReplies} i={3} />
        <Action onClick={() => setScreen("more")} Icon={Settings} label="More" sub="Account & settings" c={ACCENT.more} i={4} />
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

function TimetableScreen({ timetable, busy, reload }) {
  if (busy && !timetable) return <LoadingScreen />;
  const stages = timetable?.stages || [];
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

function MoreScreen({ user, logout, setScreen }) {
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

      {/* The second way in. Home only shows a review card once one exists, so this row
          is what makes the screen findable — and it's here whether there are any or not. */}
      <Card className="!p-0 overflow-hidden">
        <Row Icon={CalendarDays} label="My timetable" sub="Your weekly classes" onClick={() => setScreen("timetable")} />
        <Row Icon={Info} label="My progress reviews" sub="What your lecturers have written" onClick={() => setScreen("reviews")} />
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
