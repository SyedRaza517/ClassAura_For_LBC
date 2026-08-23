import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import {
  Clock, Check, Calendar, Plus, FileText, ThumbsUp, UserPlus, ArrowRight,
  LogIn, LogOut, ChevronLeft, ChevronRight, X, Bell, BellRing, Search, CalendarClock,
  LayoutDashboard, Users, CalendarDays, Inbox, BarChart3, Settings, Download,
  CheckCircle2, XCircle, Clock3, MapPin, Mail, Briefcase, AlertCircle,
  Smartphone, Monitor, Coffee, Plane, Heart, Stethoscope, GraduationCap,
  Edit3, Trash2, PlusCircle, MinusCircle, Wifi, BatteryFull, SlidersHorizontal,
  ClipboardList, Save, History, Building2, FileUp, Sparkles,
  Sun, Sunrise, Sunset, TrendingUp, Timer, Info, Phone,
  CalendarCheck, UserCheck, Layers, Activity, Award, ShieldCheck,
  BookOpen, Percent, PlayCircle, RefreshCw, MoreHorizontal, MessageSquare, ChevronDown, Loader2, KeyRound, Send, Wallet,
  Fingerprint, ScanFace, ExternalLink, Copy, PanelLeftClose, PanelLeftOpen
} from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  LineChart, Line, RadialBarChart, RadialBar
} from "recharts";
import { downloadCSV } from "./csv";
import { BrandMark, BrandLockup } from "./Brand";
import ConfirmDialog from "./ConfirmDialog";
import { useBackHandler } from "./backButton";
import PhoneShell, { useIsHandset } from "./PhoneShell";
import DeleteAccount from "./DeleteAccount";
import { biometricStatus, biometryLabel, isBiometricEnabled, enableBiometric, disableBiometric, BIOMETRICS_ENABLED } from "./biometric";
import { api } from "./api";
import useReveal from "./RevealButton";
import IntegrationSettings from "./IntegrationSettings";
import BrandingSettings from "./BrandingSettings";
import DocumentSettings from "./DocumentSettings";

/* ============================================================
   EDTECH — STAFF HUB
   Connected system: Staff Mobile App  <->  Admin Dashboard
   Every app tab has a matching dashboard page that handles its data.
   Brand: the institution's own, via CSS variables - see src/branding.js.
   The palettes below are CATEGORICAL (charts, course colours, document types) and stay
   fixed: they must stay distinguishable from each other, which a college's chosen
   colour cannot guarantee, and they carry no brand meaning.
   ============================================================ */

import { NAVY, NAVY_DARK, MAROON } from "./branding";
// The brand royal blue (matches the new fanlight logo). Used for vibrant gradients
// across the admin dashboard.
const BLUE = "#1e40af";
const BLUE_LT = "#3b82f6";
// A tone's soft gradient (for icon badges, accents) and a translucent tint.
const grad = (c) => `linear-gradient(135deg, ${c}, ${c}cc)`;

// Today as YYYY-MM-DD in the college's own timezone (Europe/London), matching the
// server's localDate(). Using the browser's UTC date instead put the client a day
// behind between midnight and 01:00 BST, so a register the UI showed as open was
// rejected as out-of-term, and a same-day booking was refused as a past date.
const todayISO = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
// Combine several per-unit attendance summaries into one overall (P/L/E/A + %),
// re-deriving the percentage from summed earned/possible so it stays weighted by
// sessions, not a naive average of percentages.
const aggregateStats = (list) => {
  const acc = { P: 0, L: 0, E: 0, A: 0, marked: 0, earned: 0, possible: 0 };
  (list || []).forEach(s => { acc.P += s.P || 0; acc.L += s.L || 0; acc.E += s.E || 0; acc.A += s.A || 0; acc.marked += s.marked || 0; acc.earned += s.earned || 0; acc.possible += s.possible || 0; });
  acc.pct = acc.possible > 0 ? Math.round((acc.earned / acc.possible) * 1000) / 10 : null;
  return acc;
};
const fmtDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const fmtDay  = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const nowTime = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
function daysBetween(a, b) { const d1 = new Date(a), d2 = new Date(b); if (isNaN(d1) || isNaN(d2)) return 0; return Math.max(1, Math.round((d2 - d1) / 86400000) + 1); }

/* ---------- read-only display helpers (pure, safe fallbacks) ---------- */
const firstNameOf = (name) => (name ? String(name).split(" ")[0] : "there");
function greetingFor(d = new Date()) {
  const h = d.getHours();
  if (h < 12) return { word: "Good morning", Icon: Sunrise };
  if (h < 17) return { word: "Good afternoon", Icon: Sun };
  return { word: "Good evening", Icon: Sunset };
}
// Minutes between two "HH:MM" strings; safe fallback to 0 if missing/invalid.
function minutesBetweenTimes(a, b) {
  if (!a || !b) return 0;
  const pa = String(a).split(":").map(Number), pb = String(b).split(":").map(Number);
  if (pa.length < 2 || pb.length < 2 || pa.some(isNaN) || pb.some(isNaN)) return 0;
  const m = (pb[0] * 60 + pb[1]) - (pa[0] * 60 + pa[1]);
  return m > 0 ? m : 0;
}
const fmtDuration = (mins) => { const m = Math.max(0, Math.round(mins || 0)); const h = Math.floor(m / 60); const r = m % 60; return h > 0 ? `${h}h ${r}m` : `${r}m`; };
// Minutes since a "HH:MM" today; safe fallback to 0.
function minutesSinceTime(a) {
  if (!a) return 0;
  const pa = String(a).split(":").map(Number);
  if (pa.length < 2 || pa.some(isNaN)) return 0;
  const now = new Date();
  const m = (now.getHours() * 60 + now.getMinutes()) - (pa[0] * 60 + pa[1]);
  return m > 0 ? m : 0;
}
// The Monday (YYYY-MM-DD) of the week containing an ISO date. UTC arithmetic so it
// doesn't drift across a BST boundary.
const mondayOf = (iso) => {
  const d = new Date(iso + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
};

// Total worked minutes (in→out) for one staff member in a "YYYY-MM" month, plus a
// per-week breakdown. Only days with BOTH a check-in and check-out can be measured;
// days still "in" (no check-out) are counted separately so the total stays honest.
function monthlyHoursFor(checkins, staffId, month) {
  const rows = (checkins || []).filter(c => c.staffId === staffId && c.in && String(c.date).slice(0, 7) === month);
  const weeks = new Map(); // mondayISO -> minutes
  let totalMin = 0, openDays = 0, countedDays = 0;
  for (const c of rows) {
    if (!c.out) { openDays++; continue; }
    const min = minutesBetweenTimes(c.in, c.out);
    if (!(min > 0)) continue;
    totalMin += min; countedDays++;
    const monday = mondayOf(c.date);
    weeks.set(monday, (weeks.get(monday) || 0) + min);
  }
  const weekList = Array.from(weeks.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([monday, min]) => ({ monday, min }));
  return { totalMin, openDays, countedDays, weekList };
}

// Average check-in clock time across records with a real `in`; null if none.
function avgCheckInTime(checkins) {
  const ins = (checkins || []).filter(c => c && c.in).map(c => { const p = String(c.in).split(":").map(Number); return p.length >= 2 && !p.some(isNaN) ? p[0] * 60 + p[1] : null; }).filter(v => v !== null);
  if (ins.length === 0) return null;
  const avg = Math.round(ins.reduce((a, b) => a + b, 0) / ins.length);
  return `${String(Math.floor(avg / 60)).padStart(2, "0")}:${String(avg % 60).padStart(2, "0")}`;
}
const leaveTypeMeta = (key) => LEAVE_TYPES.find(x => x.key === key) || { key, label: key, icon: FileText, colour: NAVY };

function useCountUp(target, dur = 700) {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf; const start = performance.now();
    const tick = (t) => { const p = Math.min(1, (t - start) / dur); setV(Math.round(target * (1 - Math.pow(1 - p, 3)))); if (p < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [target, dur]);
  return v;
}

const LEAVE_TYPES = [
  { key: "annual",   label: "Annual Leave",  icon: Plane,         colour: "#1a3a8f" },
  { key: "sick",     label: "Sick Leave",    icon: Stethoscope,   colour: "#9e1b32" },
  { key: "personal", label: "Personal Day",  icon: Heart,         colour: "#b45309" },
  { key: "training", label: "Training / CPD",icon: GraduationCap, colour: "#0d7a5f" },
  { key: "unpaid",   label: "Unpaid Leave",  icon: Wallet,        colour: "#6d28d9" },
];
// Unpaid leave does NOT draw down the paid holiday allowance — that's the point of
// it. Keep this set in sync with the server's UNPAID_TYPES so both sides agree on
// which types are free of the allowance.
const NON_ALLOWANCE_TYPES = ["unpaid"];
/* ---------- HND attendance registers ---------- */
// The four marks a student can be given on a register, matching the college's
// existing Moodle register (P / L / E / A).
const ATT_STATUSES = [
  { key: "P", label: "Present", colour: "#059669" },
  { key: "L", label: "Late",    colour: "#b45309" },
  { key: "E", label: "Excused", colour: "#6d28d9" },
  { key: "A", label: "Absent",  colour: "#9e1b32" },
];
// Points each mark earns. Mirrors server/src/attendance.js — the server is the
// authority for the stored percentages; these are for live on-screen previews.
const ATT_POINTS = { P: 2, L: 1, E: 1, A: 0 };
const ATT_MAX = 2;
const attMeta = (key) => ATT_STATUSES.find(s => s.key === key) || null;
// The Pass boundary for GRADES (not attendance). Every pass rate and every band in
// the client must derive from this one value — the server holds the same constant in
// routes/assessments.js. Three separate literals had already drifted apart once.
const PASS_MARK = 50;
// A mark as a percentage of its maximum, clamped 0–100 — the same shape as the
// server's pctOf in routes/assessments.js. The clamp is the safety net for a historic
// mark that exceeds its assessment's current maximum; without it the client printed
// >100% for a grade the API reported as 100%.
const clampPct = (marks, max) => (max > 0 ? Math.min(100, Math.max(0, Math.round((marks / max) * 1000) / 10)) : null);
// Traffic-light tone for an attendance percentage. Thresholds match the college's
// attendance-rating bands (see riskBand): under 40% is High Risk, 40–50 Monitor,
// 50–70 Good, 70+ on track. Keeping one set of cut-offs stops the same figure from
// showing a green rating badge next to an amber percentage.
function pctTone(pct) {
  if (pct === null || pct === undefined) return { text: "text-slate-400", bg: "bg-slate-100", ring: "ring-slate-200", colour: "#94a3b8" };
  if (pct >= 90) return { text: "text-violet-700", bg: "bg-violet-50", ring: "ring-violet-200", colour: "#6d28d9" };
  if (pct >= 70) return { text: "text-green-700", bg: "bg-green-50", ring: "ring-green-200", colour: "#16a34a" };
  if (pct >= 50) return { text: "text-yellow-700", bg: "bg-yellow-50", ring: "ring-yellow-200", colour: "#ca8a04" };
  if (pct >= 40) return { text: "text-orange-700", bg: "bg-orange-50", ring: "ring-orange-200", colour: "#ea580c" };
  return { text: "text-rose-700", bg: "bg-rose-50", ring: "ring-rose-200", colour: "#dc2626" };
}
const fmtPct = (pct) => (pct === null || pct === undefined ? "—" : `${pct}%`);

// Where a unit sits in the course structure. This is the curriculum position that
// comes from Moodle ("Year 1 - Term 1" sections) — not the dated teaching term that
// drives register locking, which is `unit.termId`.
//
// Terms are numbered 1-6 straight through the two years, because the college calls
// Year 2's first term "Term 4"; the labels therefore print the number as given.
const YEARS = [1, 2];
const TERMS = [1, 2, 3, 4, 5, 6];
const isPlaced = (u) => u?.year != null && u?.termNumber != null;
const placeLabel = (u) => (isPlaced(u) ? `Year ${u.year} · Term ${u.termNumber}` : "");
const placeShort = (u) => (isPlaced(u) ? `Y${u.year}·T${u.termNumber}` : "");
// A stable sort key so units read in teaching order: year, then term, then unit
// number. Unplaced units sort last rather than jumbling in among the placed ones.
const placeKey = (u) => (isPlaced(u) ? u.year * 100 + u.termNumber : 9999);
// Does a unit match the year/term filter? "" means "any".
const matchesPlace = (u, year, term) => {
  if (year === "none") return !isPlaced(u);
  if (year && Number(year) !== u?.year) return false;
  if (term && Number(term) !== u?.termNumber) return false;
  return true;
};

// Is the unit being taught right now, already finished, or still to come?
//
// Derived purely from its teaching window, so a unit with no dates is "unscheduled"
// rather than being lumped in with either — guessing would put made-up units into
// the "current attendance" figure, which is the one people act on.
// The unit's own end date wins; its last register is the fallback. Both the server
// and the student app use exactly this rule, so omitting the fallback here made the
// Registers tab read "No dates set" for a unit the student app had already moved to
// "Previous units" and dropped from their current attendance.
const unitStatus = (u, today) => {
  const end = u?.endDate || u?.lastSessionDate || null;
  if (!u?.startDate && !end) return "unscheduled";
  if (end && today > end) return "past";
  if (u?.startDate && today < u.startDate) return "future";
  // Running, or running-by-implication because it has registers but no dates.
  return u?.startDate && u?.endDate ? "current" : (end ? "current" : "unscheduled");
};
const STATUS_META = {
  current:     { label: "Running now", short: "Running",   bg: "bg-emerald-100", text: "text-emerald-700", colour: "#059669" },
  past:        { label: "Finished",    short: "Finished",  bg: "bg-slate-200",   text: "text-slate-600",   colour: "#64748b" },
  future:      { label: "Not started", short: "Upcoming",  bg: "bg-amber-100",   text: "text-amber-700",   colour: "#b45309" },
  unscheduled: { label: "No dates set", short: "No dates", bg: "bg-rose-50",     text: "text-rose-600",    colour: "#e11d48" },
};
// Human-readable teaching window, e.g. "22 Sep – 31 Oct 2025".
const fmtWindow = (u) => {
  if (!u?.startDate || !u?.endDate) return "";
  const f = (d, withYear) => new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) });
  const sameYear = u.startDate.slice(0, 4) === u.endDate.slice(0, 4);
  return `${f(u.startDate, !sameYear)} – ${f(u.endDate, true)}`;
};

// Status filter over units. Mirrors PlaceFilter so both bars behave the same.
function StatusFilter({ units, value, setValue, today, className = "" }) {
  const counts = units.reduce((a, u) => { const s = unitStatus(u, today); a[s] = (a[s] || 0) + 1; return a; }, {});
  const shown = ["current", "past", "future", "unscheduled"].filter(s => counts[s]);
  if (shown.length < 2) return null;   // nothing to choose between
  const pill = (on) => `press rounded-full px-3 py-1.5 text-xs font-bold shadow-sm ring-1 transition-all ${on ? "text-white ring-transparent" : "bg-white text-slate-500 ring-slate-200 hover:bg-slate-50"}`;
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      <span className="mr-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">Status</span>
      <button onClick={() => setValue("")} className={pill(!value)} style={!value ? { background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` } : {}}>All</button>
      {shown.map(s => (
        <button key={s} onClick={() => setValue(s)} className={pill(value === s)} style={value === s ? { background: STATUS_META[s].colour } : {}}>
          {STATUS_META[s].short} <span className="opacity-60">{counts[s]}</span>
        </button>
      ))}
    </div>
  );
}

// The year/term filter bar. Shown wherever units are listed so the same control
// behaves identically everywhere. Terms offered are only those actually in use, so
// a one-year course never shows empty Year 2 terms.
function PlaceFilter({ units, year, setYear, term, setTerm, className = "" }) {
  const inScope = year && year !== "none" ? units.filter(u => u.year === Number(year)) : units;
  const terms = Array.from(new Set(inScope.filter(isPlaced).map(u => u.termNumber))).sort((a, b) => a - b);
  const years = Array.from(new Set(units.filter(isPlaced).map(u => u.year))).sort((a, b) => a - b);
  const anyUnplaced = units.some(u => !isPlaced(u));
  if (!years.length) return null;
  const pill = (active, on) => `press rounded-full px-3 py-1.5 text-xs font-bold shadow-sm ring-1 transition-all ${active ? "text-white ring-transparent" : "bg-white text-slate-500 ring-slate-200 hover:bg-slate-50"}`;
  const activeStyle = { background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` };
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      <span className="mr-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">Year</span>
      <button onClick={() => { setYear(""); setTerm(""); }} className={pill(!year)} style={!year ? activeStyle : {}}>All</button>
      {years.map(y => (
        // Changing year clears the term — a term from the old year may not exist in
        // the new one, which would otherwise leave an empty list and no way back.
        <button key={y} onClick={() => { setYear(String(y)); setTerm(""); }} className={pill(year === String(y))} style={year === String(y) ? activeStyle : {}}>Year {y}</button>
      ))}
      {anyUnplaced && <button onClick={() => { setYear("none"); setTerm(""); }} className={pill(year === "none")} style={year === "none" ? activeStyle : {}}>Not set</button>}
      {year !== "none" && terms.length > 1 && (
        <>
          <span className="ml-2 mr-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">Term</span>
          <button onClick={() => setTerm("")} className={pill(!term)} style={!term ? activeStyle : {}}>All</button>
          {terms.map(t => (
            <button key={t} onClick={() => setTerm(String(t))} className={pill(term === String(t))} style={term === String(t) ? activeStyle : {}}>Term {t}</button>
          ))}
        </>
      )}
    </div>
  );
}

// The year/term pair as form fields. Both or neither — the API rejects a half-set
// placement, so the control clears its partner rather than letting that be sent.
function PlaceFields({ form, setForm }) {
  const set = (k, v) => setForm(f => ({ ...f, [k]: v, ...(k === "year" && !v ? { termNumber: "" } : {}) }));
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Year">
        <select value={form.year ?? ""} onChange={e => set("year", e.target.value)} className={inputCls}>
          <option value="">Not set</option>
          {YEARS.map(y => <option key={y} value={y}>Year {y}</option>)}
        </select>
      </Field>
      <Field label="Term">
        <select value={form.termNumber ?? ""} onChange={e => set("termNumber", e.target.value)} disabled={!form.year} className={`${inputCls} disabled:bg-slate-50 disabled:text-slate-400`}>
          <option value="">{form.year ? "Choose a term" : "Pick a year first"}</option>
          {TERMS.map(t => <option key={t} value={t}>Term {t}</option>)}
        </select>
      </Field>
    </div>
  );
}
// Which semester a date falls in (ranges never overlap), or null if none does.
const semesterOf = (date, semesters) => (semesters || []).find(s => date >= s.start && date <= s.end) || null;
// Narrow a session list to the selected scope: "" = all, "unassigned" = outside
// every semester, otherwise the semester's own date range.
function scopeSessions(sessions, semesterId, semesters) {
  if (!semesterId) return sessions;
  if (semesterId === "unassigned") return sessions.filter(s => !semesterOf(s.date, semesters));
  const sem = (semesters || []).find(s => s.id === semesterId);
  return sem ? sessions.filter(s => s.date >= sem.start && s.date <= sem.end) : sessions;
}
const semesterLabel = (semesterId, semesters) => {
  if (!semesterId) return "All semesters";
  if (semesterId === "unassigned") return "Outside any semester";
  return (semesters || []).find(s => s.id === semesterId)?.name || "All semesters";
};
// Summarise draft marks the same way the server does, for the live tally.
function summariseDraft(values) {
  const counts = { P: 0, L: 0, E: 0, A: 0 };
  let earned = 0;
  for (const v of values) { if (!ATT_POINTS.hasOwnProperty(v)) continue; counts[v] += 1; earned += ATT_POINTS[v]; }
  const marked = counts.P + counts.L + counts.E + counts.A;
  const possible = marked * ATT_MAX;
  return { ...counts, marked, earned, possible, pct: possible > 0 ? Math.round((earned / possible) * 1000) / 10 : null };
}

const DOC_TYPES = ["Policy", "Payroll", "HR", "Calendar", "Form"];
// Mirrors server/src/storage.js MAX_BYTES, so an oversized file is refused in the
// browser with a clear message instead of after a pointless 10MB round-trip.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const fmtBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const DOC_TYPE_COLOUR = { Policy: "#1a3a8f", Payroll: "#0d7a5f", HR: "#6d28d9", Calendar: "#b45309", Form: "#9e1b32" };
const docTypeColour = (t) => DOC_TYPE_COLOUR[t] || "#475569";
const PALETTE = ["#1a3a8f", "#9e1b32", "#0d7a5f", "#b45309", "#6d28d9", "#0e7490", "#be123c"];
const initialsOf = (name) => name.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();

/* ---------- shared UI ---------- */
function Card({ children, className = "", style }) { return <div style={style} className={`rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/70 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md hover:ring-slate-300/80 ${className}`}>{children}</div>; }
const inputCls = "w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100";
function Field({ label, children }) { return <div><label className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</label><div className="mt-1">{children}</div></div>; }
function PrimaryBtn({ children, onClick, disabled, colour = NAVY, className = "" }) {
  return <button onClick={onClick} disabled={disabled} className={`shine press flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold text-white shadow-md shadow-slate-900/10 transition-all duration-200 hover:opacity-95 hover:shadow-lg hover:shadow-slate-900/15 active:scale-95 disabled:opacity-40 disabled:shadow-none ${className}`} style={{ background: `linear-gradient(135deg, ${colour} 0%, ${colour}e6 100%)` }}>{children}</button>;
}
function Modal({ open, onClose, title, children, width = 460 }) {
  // Android back closes an open modal instead of leaving the screen.
  useBackHandler(open, () => { onClose?.(); return true; });
  if (!open) return null;
  const dialog = (
    // 100dvh, and centred by the flex parent rather than by translate, so a tall
    // dialog on a short screen pins to the top and scrolls instead of overflowing
    // equally in both directions — which used to push the title and the warning
    // text off the top of an iPhone SE.
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto p-4 sm:items-center"
      style={{
        height: "100dvh",
        paddingTop: "max(env(safe-area-inset-top), 1rem)",
        paddingBottom: "max(env(safe-area-inset-bottom), 1rem)",
      }}
    >
      <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm slide-down" onClick={onClose} />
      <div
        className="relative my-auto w-full overflow-hidden rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-slate-200/60 pop"
        style={{ maxWidth: width }}
      >
        <div className="absolute inset-x-0 top-0 h-1" style={{ background: `linear-gradient(90deg, ${NAVY}, ${MAROON})` }} />
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-extrabold" style={{ color: NAVY_DARK }}>{title}</h3>
          <button onClick={onClose} aria-label="Close" className="press flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
  // Rendered into <body>. A `position: fixed` element resolves against the nearest
  // TRANSFORMED ancestor, not the viewport — and every screen here sits inside a
  // `fade-up` animation, so the dialog was being positioned against that instead.
  // On short iPhones that put its title, close button and the "cannot be undone"
  // warning above the top of the screen.
  return typeof document !== "undefined" ? createPortal(dialog, document.body) : dialog;
}
// The EdTech logo. In tight boxes (`small`) we show just the arch
// emblem; elsewhere the full emblem + wordmark lockup. Both come from ./Brand.
function Logo({ small }) {
  return small ? <BrandMark size={30} /> : <BrandLockup />;
}
const statusBadge = (s) => ({ pending: "bg-amber-100 text-amber-700", approved: "bg-emerald-100 text-emerald-700", rejected: "bg-rose-100 text-rose-700" }[s]);

// Two-step verification state for a staff row.
//   On       — enrolled, a code is required at every sign-in
//   Setup due — required for this account but not yet enrolled (or just reset)
//   Off      — password only (seeded staff and admins)
const twoStepBadge = (s) => {
  // An account waiting for its invitation to be accepted can't be signed into at
  // all, so say that rather than reporting on a second factor it will never reach.
  if (s.pendingActivation) return <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-700"><Mail size={10} /> Invited</span>;
  if (s.totpEnabled) return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700"><ShieldCheck size={10} /> On</span>;
  if (s.totpRequired) return <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700"><AlertCircle size={10} /> Setup due</span>;
  return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-400">Off</span>;
};

/* ---------- search + pagination helpers (presentational / local state only) ---------- */
// Clamp a 1-based page to the available range given a total count and page size.
function usePaged(items, pageSize, resetKey) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  // Reset to page 1 whenever the dependency key (e.g. search term / filter) changes.
  useEffect(() => { setPage(1); }, [resetKey]);
  // Keep the current page within bounds if the list shrinks beneath it.
  useEffect(() => { setPage(p => Math.min(p, totalPages)); }, [totalPages]);
  const current = Math.min(page, totalPages);
  const start = (current - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);
  return { page: current, setPage, totalPages, slice, total: items.length };
}
function Pagination({ page, setPage, totalPages, total, className = "" }) {
  if (total === 0) return null;
  return (
    <div className={`flex flex-wrap items-center justify-between gap-2 ${className}`}>
      <p className="text-xs font-semibold text-slate-400">Page {page} of {totalPages} · {total} result{total === 1 ? "" : "s"}</p>
      <div className="flex items-center gap-1.5">
        <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} className="press flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-white"><ChevronLeft size={14} /> Prev</button>
        <span className="rounded-lg px-2.5 py-1.5 text-xs font-bold text-white" style={{ background: NAVY }}>{page}</span>
        <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="press flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-white">Next <ChevronRight size={14} /></button>
      </div>
    </div>
  );
}
// Consistent small export button used across admin pages.
function ExportBtn({ onClick, label = "Export", className = "" }) {
  return <button onClick={onClick} className={`press flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-white transition hover:opacity-95 ${className}`} style={{ background: NAVY }}><Download size={14} /> {label}</button>;
}

/* ============================================================ STAFF MOBILE APP ============================================================ */
export function StaffApp({ store, currentStaffId, setCurrentStaffId, logout, onChangePassword, onSwitchToAdmin }) {
  const { staff } = store;
  const [screen, setScreen] = useState("home");
  const [showNotes, setShowNotes] = useState(false);

  // Android back: close the notifications panel first, else a sub-screen returns home.
  useBackHandler(showNotes, () => { setShowNotes(false); return true; });
  useBackHandler(!showNotes && screen !== "home", () => { setScreen("home"); return true; });

  // Tapping a push notification opens the screen it refers to — the `link` the
  // server attached (e.g. "balance" for a leave decision, "approvals" for admins).
  useEffect(() => {
    const KNOWN = ["home", "checkin", "balance", "calendar", "request", "documents", "approval", "summary", "timesheet", "reflection", "studentreview", "more"];
    const onOpen = (e) => {
      const link = e.detail === "approvals" ? "approval" : e.detail;
      setScreen(KNOWN.includes(link) ? link : "home");
    };
    window.addEventListener("push:open", onOpen);
    return () => window.removeEventListener("push:open", onOpen);
  }, []);

  // Strictly the signed-in user. There used to be a `|| staff[0]` fallback, which
  // meant that if the staff list ever came back without this user, the app rendered
  // a COLLEAGUE's profile, balance and check-ins as though they were the user's own.
  // Better to wait (or fall back to the token's own user) than to show someone else.
  const me = staff.find(s => s.id === currentStaffId) || (store.currentUser?.id === currentStaffId ? store.currentUser : null);
  if (!me) return <div className="flex justify-center py-20 text-slate-400">Loading…</div>;

  return (
    <PhoneShell
      header={<AppHeader me={me} staff={staff} setCurrentStaffId={setCurrentStaffId} screen={screen} setScreen={setScreen} store={store} showNotes={showNotes} setShowNotes={setShowNotes} />}
    >
      {screen === "home" && <HomeGrid setScreen={setScreen} store={store} me={me} />}
      {screen === "checkin" && <CheckInScreen store={store} me={me} />}
      {screen === "balance" && <BalanceScreen store={store} me={me} />}
      {screen === "calendar" && <CalendarScreen store={store} me={me} />}
      {screen === "request" && <RequestLeaveScreen store={store} me={me} setScreen={setScreen} />}
      {screen === "documents" && <DocumentsScreen store={store} me={me} />}
      {screen === "approval" && <ApprovalScreen store={store} me={me} />}
      {screen === "summary" && <SummaryScreen store={store} me={me} />}
      {screen === "onsite" && <StaffOnSiteScreen store={store} me={me} />}
      {screen === "timesheet" && <TimesheetScreen store={store} me={me} />}
      {screen === "reflection" && <SelfReflectionScreen store={store} me={me} />}
      {screen === "studentreview" && <StudentReviewScreen store={store} me={me} />}
      {screen === "more" && <MoreScreen store={store} me={me} logout={logout} onChangePassword={onChangePassword} onSwitchToAdmin={onSwitchToAdmin} />}

      {showNotes && <NotePanel store={store} onClose={() => setShowNotes(false)} />}
    </PhoneShell>
  );
}

// The simulated status bar belongs to the desktop demo only. A real handset draws
// its own clock and battery, so showing ours would put a second, wrong clock right
// next to the real one.
function StatusBar() {
  const handset = useIsHandset();
  const [t, setT] = useState(nowTime());
  useEffect(() => { const i = setInterval(() => setT(nowTime()), 30000); return () => clearInterval(i); }, []);
  if (handset) return null;
  return (
    <div className="flex items-center justify-between px-6 pt-1.5 text-[11px] font-semibold text-white/90">
      <span>{t}</span>
      <span className="flex items-center gap-1"><Wifi size={12} /><BatteryFull size={14} /></span>
    </div>
  );
}

function AppHeader({ me, staff, setCurrentStaffId, screen, setScreen, store, showNotes, setShowNotes }) {
  const title = { home: "Staff Hub", checkin: "Daily Check-In", balance: "Holiday Balance", calendar: "Holiday Calendar", request: "Request Leave", documents: "Documents", approval: "Manager Approval", summary: "Daily Summary", onsite: "Staff on Site", timesheet: "My Timesheet", reflection: "Self-Reflection", studentreview: "Student Review", more: "More" }[screen];
  const unread = store.notes.length;
  const greet = greetingFor();
  const Greet = greet.Icon;
  const handset = useIsHandset();
  return (
    <div
      className={`relative z-20 ${handset ? "pt-2" : "pt-7"}`}
      style={{ background: `linear-gradient(160deg, ${NAVY} 0%, ${NAVY_DARK} 100%)` }}
    >
      {/* No safe-area padding here. This header sits BELOW the app's top bar,
          which already clears the notch — applying the inset again reserved the
          notch height a second time and wasted ~49px on every notched iPhone. */}
      <StatusBar />
      {/* The back arrow and the bell are the two persistent navigation controls, so
          both are sized to Apple's 44pt / Android's 48dp minimum touch target. They
          were 30-32px, about a third under, which produces mis-taps. */}
      <div className="flex items-center gap-2 px-3 pb-2 pt-1">
        {screen !== "home" ? (
          <button onClick={() => setScreen("home")} aria-label="Back to Staff Hub" className="press flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition hover:bg-white/25"><ChevronLeft size={22} /></button>
        ) : (
          <div className="flex h-11 w-12 shrink-0 items-center justify-center rounded-md bg-white px-1"><Logo small /></div>
        )}
        <div className="min-w-0 flex-1 text-center"><h1 className="truncate text-lg font-extrabold tracking-wide text-white">{title}</h1></div>
        <button
          onClick={() => setShowNotes(v => !v)}
          aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
          className={`press relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition hover:bg-white/25 ${unread ? "glow-pulse" : ""}`}
        >
          {unread ? <BellRing size={20} /> : <Bell size={20} />}
          {unread > 0 && <span className="pop absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[9px] font-bold text-slate-900 ring-2" style={{ "--tw-ring-color": "var(--brand-primary-dark)" }}>{unread}</span>}
        </button>
      </div>
      {screen === "home" && (
        <div className="px-4 pb-5 fade-up">
          <div className="flex items-center gap-3 rounded-2xl bg-white/10 p-3 ring-1 ring-white/10 backdrop-blur transition-all hover:bg-white/15">
            <div className="float flex h-12 w-12 items-center justify-center rounded-xl text-base font-bold text-white shadow-lg ring-2 ring-white/20" style={{ background: me.colour }}>{me.initials}</div>
            <div className="flex-1">
              <p className="flex items-center gap-1 text-[11px] font-medium text-white/70"><Greet size={12} className="text-amber-300" /> {greet.word}, {firstNameOf(me.name)}</p>
              <p className="text-[15px] font-bold text-white">{me.name}</p>
              <p className="text-[11px] text-white/60">{me.role}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NotePanel({ store, onClose }) {
  return (
    <div className="absolute inset-0 z-40">
      <div className="absolute inset-0 bg-slate-900/30" onClick={onClose} />
      <div className="slide-down absolute left-3 right-3 top-3 max-h-[70%] overflow-y-auto rounded-2xl bg-white p-3 shadow-2xl">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-extrabold" style={{ color: NAVY }}>Notifications</p>
          <div className="flex gap-2">
            {store.notes.length > 0 && <button onClick={() => store.setNotes([])} className="text-[11px] font-semibold text-slate-400 hover:text-slate-600">Clear</button>}
            <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"><X size={16} /></button>
          </div>
        </div>
        {store.notes.length === 0 && <p className="py-6 text-center text-xs text-slate-400">No notifications yet.</p>}
        <div className="space-y-1.5">
          {store.notes.map(n => (
            <div key={n.id} className="flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2">
              <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full" style={{ background: n.type === "success" ? "#059669" : n.type === "error" ? MAROON : NAVY }} />
              <div><p className="text-xs font-medium text-slate-700">{n.msg}</p><p className="text-[10px] text-slate-400">{n.at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</p></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const TILES = [
  { key: "checkin", label: "Daily Check-In", Icon: Clock, sub: "Clock in & out" },
  { key: "balance", label: "Holiday Balance", Icon: Check, sub: "Days remaining" },
  { key: "calendar", label: "Holiday Calendar", Icon: Calendar, sub: "Who's off & when" },
  { key: "request", label: "Request Leave", Icon: Plus, sub: "Book time off" },
  { key: "documents", label: "Documents", Icon: FileText, sub: "Policies & forms" },
  { key: "approval", label: "Manager Approval", Icon: ThumbsUp, sub: "Review requests" },
  { key: "summary", label: "Staff Daily Summary", Icon: UserPlus, sub: "Log your day" },
  { key: "onsite", label: "Staff on Site", Icon: Users, sub: "Who's in today" },
  { key: "timesheet", label: "Send Timesheet", Icon: ClipboardList, sub: "Log hours & submit" },
  { key: "reflection", label: "Self-Reflection", Icon: Award, sub: "Strategic lecturer review" },
  { key: "studentreview", label: "Student Review", Icon: MessageSquare, sub: "Review a student's progress" },
  { key: "more", label: "More", Icon: ArrowRight, sub: "Profile & settings" },
];
const STAFF_TIPS = [
  "Check in each morning so your team knows you're on site.",
  "Book annual leave early — it helps your manager plan cover.",
  "Add a daily summary to keep a record of your work.",
  "Find every policy and payroll form under Documents.",
  "Your holiday balance updates the moment a request is approved.",
];

// Can this user actually decide leave? Mirrors the server's requireAnyPage over the
// leave-management pages, so the Manager Approval tile and screen only appear for an
// admin who can really act — not for any admin (a timesheets-only admin would just
// hit a 403). Used by HomeGrid and ApprovalScreen.
const canDecideLeaveFor = (user) => ["requests", "approvals", "calendar"].some(p => canAccessPage(user, p));

function HomeGrid({ setScreen, store, me }) {
  const today = todayISO();
  const canDecideLeave = canDecideLeaveFor(store.currentUser);
  const myToday = store.checkins.find(c => c.staffId === me.id && c.date === today && c.in);
  const pending = store.leave.filter(l => l.staffId === me.id && l.status === "pending").length;
  const left = store.remaining(me.id);
  // Read-only display values for the hero band.
  const heroStatus = myToday ? (myToday.out ? "Day complete — see you tomorrow" : "You're checked in") : "Not checked in yet";
  const heroIcon = myToday ? (myToday.out ? CheckCircle2 : UserCheck) : Clock;
  const HeroIcon = heroIcon;
  const tip = STAFF_TIPS[new Date().getDate() % STAFF_TIPS.length];
  return (
    <div className="p-4">
      {/* Hero / summary band */}
      <div className="animated-gradient relative mb-4 overflow-hidden rounded-2xl p-4 text-white shadow-md fade-up" style={{ background: `linear-gradient(135deg, ${NAVY} 0%, ${NAVY_DARK} 55%, ${MAROON} 140%)`, backgroundSize: "200% 200%" }}>
        <Sparkles size={56} className="float-slow absolute -right-2 -top-2 text-white/10" />
        <p className="relative text-[11px] font-semibold uppercase tracking-wide text-white/60">{fmtDay(today)}</p>
        <p className="relative mt-1 flex items-center gap-1.5 text-base font-extrabold"><HeroIcon size={17} className="text-amber-300" /> {heroStatus}</p>
        <p className="relative mt-0.5 text-[12px] text-white/70">{left > 0 ? `${left} day${left === 1 ? "" : "s"} of holiday left` : "No holiday remaining"}{pending > 0 ? ` · ${pending} request${pending === 1 ? "" : "s"} pending` : ""}</p>
      </div>
      <div className="mb-4 grid grid-cols-3 gap-2 fade-up">
        <MiniStat label="Status" value={myToday ? (myToday.out ? "Done" : "In") : "Out"} tone={myToday && !myToday.out ? "green" : "grey"} Icon={myToday && !myToday.out ? UserCheck : Clock} />
        <MiniStat label="Holiday left" value={`${left}d`} tone="navy" Icon={Plane} />
        <MiniStat label="Pending" value={pending} tone={pending ? "amber" : "grey"} Icon={Inbox} />
      </div>
      <p className="mb-3 text-center text-sm font-semibold italic text-slate-500" style={{ fontFamily: "'Lora', serif" }}>Please select one of the buttons below</p>
      <div className="grid grid-cols-2 gap-3">
        {/* The Manager Approval tile needs a LEAVE page, not merely being an admin.
            Gated on store.isAdmin, a page-scoped admin (e.g. finance, timesheets-only)
            saw the tile, opened an empty/misleading queue, and every Approve/Decline
            tap 403'd — a dead-end button. canDecideLeave mirrors the server guard. */}
        {TILES.filter(t => t.key !== "approval" || canDecideLeave).map((t, i) => {
          const badge = t.key === "approval" ? store.leave.filter(l => l.status === "pending").length : t.key === "request" ? pending : 0;
          return (
            <button key={t.key} onClick={() => setScreen(t.key)} className="shine hover-lift group relative flex flex-col items-center justify-center gap-2.5 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/70 transition-all duration-300 hover:shadow-xl hover:ring-blue-200 active:scale-95 pop" style={{ animationDelay: `${i * 60}ms` }}>
              {badge > 0 && <span className="pop absolute right-2.5 top-2.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-bold text-slate-900 shadow-sm ring-2 ring-amber-200">{badge}</span>}
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl shadow-sm transition-all duration-300 group-hover:scale-110 group-hover:-rotate-6 group-active:scale-95" style={{ background: "linear-gradient(135deg, rgba(26,58,143,0.12), rgba(158,27,50,0.07))" }}>
                <t.Icon size={26} style={{ color: NAVY }} strokeWidth={2.2} />
              </span>
              <span className="text-center text-[13px] font-bold leading-tight" style={{ color: NAVY }}>{t.label}</span>
              <span className="text-center text-[10px] font-medium leading-tight text-slate-400">{t.sub}</span>
            </button>
          );
        })}
      </div>
      {/* Tip of the day */}
      <div className="mt-4 flex items-start gap-2.5 rounded-2xl bg-blue-50/70 p-3 ring-1 ring-blue-100 fade-up">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white shadow-sm"><Info size={15} style={{ color: NAVY }} /></span>
        <div><p className="text-[11px] font-bold uppercase tracking-wide text-blue-800/70">Tip of the day</p><p className="text-[12px] text-slate-600">{tip}</p></div>
      </div>
    </div>
  );
}
function MiniStat({ label, value, tone, Icon }) {
  const tones = { green: "bg-emerald-50 text-emerald-700 ring-emerald-200", amber: "bg-amber-50 text-amber-700 ring-amber-200", navy: "bg-blue-50 text-blue-800 ring-blue-200", grey: "bg-slate-50 text-slate-600 ring-slate-200" }[tone];
  return (
    <div className={`rounded-xl px-2 py-2.5 text-center ring-1 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-sm ${tones}`}>
      {Icon && <Icon size={14} className="mx-auto mb-1 opacity-70" />}
      <p className="text-[15px] font-extrabold leading-none">{value}</p>
      <p className="mt-1 text-[10px] font-medium opacity-80">{label}</p>
    </div>
  );
}
function Screen({ children }) { return <div className="p-4 fade-up">{children}</div>; }
function EmptyState({ Icon = Inbox, title = "Nothing here yet", msg = "", className = "", tone = BLUE }) {
  return (
    <div className={`flex flex-col items-center justify-center px-4 py-10 text-center fade-up ${className}`}>
      <span className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl shadow-sm" style={{ background: tone + "12", color: tone, boxShadow: `inset 0 0 0 1px ${tone}22` }}><Icon size={26} /></span>
      <p className="text-sm font-bold text-slate-600">{title}</p>
      {msg && <p className="mt-1 max-w-[240px] text-xs text-slate-400">{msg}</p>}
    </div>
  );
}
// Small read-only legend chip list for leave types.
function LeaveLegend({ types = LEAVE_TYPES, className = "" }) {
  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {types.map(t => <span key={t.key} className="flex items-center gap-1.5 rounded-full bg-white px-2 py-1 text-[10px] font-bold ring-1 ring-slate-200" style={{ color: t.colour }}><span className="h-2 w-2 rounded-full" style={{ background: t.colour }} />{t.label}</span>)}
    </div>
  );
}

/* ----- Check-In ----- */
// How a check-in happened: Onsite (in a campus) or Online (remote). Kept in sync
// with the server's validate.js SITES.
const SITES = ["Onsite", "Online"];
// A staff member's HOME site — HND, FE or SL, chosen at sign-up. Used by the
// Staff-tab filter and the Add/Edit Staff form. Matches validate.js HOME_SITES.
const HOME_SITES = ["HND", "FE", "SL"];

function CheckInScreen({ store, me }) {
  const today = todayISO();
  const rec = store.checkins.find(c => c.staffId === me.id && c.date === today);
  // A summary-first row has an empty `in` — that is NOT a real check-in, so treat it as
  // "not checked in" (offer the Check In button, which fills the time server-side).
  const checkedIn = rec && rec.in;
  const [clock, setClock] = useState(new Date());
  // Which site they're clocking in from today. Must be chosen before the button
  // enables, so every check-in carries a site.
  const [site, setSite] = useState(null);
  useEffect(() => { const i = setInterval(() => setClock(new Date()), 1000); return () => clearInterval(i); }, []);
  const checkIn = () => store.checkIn(site);
  const checkOut = () => store.checkOut(rec.id);
  return (
    <Screen>
      <Card className="text-center">
        <div className={`mx-auto mb-3 flex h-20 w-20 items-center justify-center rounded-full ring-4 ring-white shadow-inner bounce-in ${checkedIn && !rec.out ? "glow-pulse" : ""}`} style={{ background: checkedIn ? (rec.out ? "#e2e8f0" : "rgba(16,185,129,.12)") : "rgba(26,58,143,.08)" }}>
          <Clock size={40} className="float-slow" style={{ color: checkedIn && !rec.out ? "#059669" : NAVY }} />
        </div>
        <p className="text-2xl font-extrabold tabular-nums" style={{ color: NAVY }}>{clock.toLocaleTimeString("en-GB")}</p>
        <p className="text-sm text-slate-500">{fmtDay(today)}</p>
        <p className="mb-1 mt-2 text-lg font-bold" style={{ color: checkedIn && !rec.out ? "#059669" : "#475569" }}>{checkedIn ? (rec.out ? "✓ Checked Out" : "● Checked In") : "Not Checked In"}</p>
        {checkedIn && <p className="text-xs text-slate-500">In at {rec.in}{rec.out && ` · Out at ${rec.out}`}{rec.site && ` · ${rec.site}`}</p>}
        {checkedIn && (() => {
          // Read-only "hours on site": from in→out if checked out, else in→now. Safe fallback to 0.
          const mins = rec.out ? minutesBetweenTimes(rec.in, rec.out) : minutesSinceTime(rec.in);
          const pct = Math.max(0, Math.min(100, Math.round((mins / 480) * 100))); // of a nominal 8h day
          return (
            <div className="mx-auto mt-4 max-w-[240px]">
              <div className="mb-1.5 flex items-center justify-center gap-1.5 text-xs font-semibold" style={{ color: rec.out ? "#475569" : "#059669" }}>
                <Timer size={14} /> {fmtDuration(mins)} on site{!rec.out ? " so far" : ""}
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-100 shadow-inner">
                <div className="h-full rounded-full" style={{ width: `${pct}%`, background: rec.out ? "linear-gradient(90deg,#94a3b8,#cbd5e1)" : "linear-gradient(90deg,#059669,#34d399)", transition: "width .8s cubic-bezier(.4,0,.2,1)" }} />
              </div>
            </div>
          );
        })()}
        {!checkedIn && (
          <div className="mt-5 text-left">
            <p className="mb-2 text-center text-xs font-bold uppercase tracking-wide text-slate-400">Where are you working today?</p>
            <div className="grid grid-cols-2 gap-2">
              {SITES.map(s => {
                const active = site === s;
                return (
                  <button
                    key={s}
                    onClick={() => setSite(s)}
                    className={`press rounded-xl py-2.5 text-sm font-bold ring-1 transition-all ${active ? "text-white ring-transparent shadow-md" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50"}`}
                    style={active ? { background: NAVY } : {}}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="mt-5">
          {!checkedIn && <PrimaryBtn onClick={checkIn} disabled={!site} className="w-full !py-3.5 text-base"><LogIn size={20} /> {site ? `Check In · ${site}` : "Choose onsite or online"}</PrimaryBtn>}
          {checkedIn && !rec.out && <PrimaryBtn onClick={checkOut} colour={MAROON} className="w-full !py-3.5 text-base"><LogOut size={20} /> Check Out</PrimaryBtn>}
          {checkedIn && rec.out && <div className="rounded-xl bg-emerald-50 py-3 text-sm font-semibold text-emerald-700">✓ Your day is complete. Have a great evening!</div>}
        </div>
      </Card>
      <p className="mb-2 mt-5 px-1 text-xs font-bold uppercase tracking-wide text-slate-400">Recent activity</p>
      <Card className="p-0">
        {store.checkins.filter(c => c.staffId === me.id && c.in).length === 0 && (
          <EmptyState Icon={History} title="No activity yet" msg="Your check-ins will appear here once you clock in." />
        )}
        {store.checkins.filter(c => c.staffId === me.id && c.in).slice(0, 6).map((c, i, a) => (
          <div key={c.id} className={`flex items-center justify-between px-4 py-3 transition-colors hover:bg-slate-50/70 fade-up ${i < a.length - 1 ? "border-b border-slate-100" : ""}`} style={{ animationDelay: `${i * 50}ms` }}>
            <div><p className="text-sm font-semibold text-slate-700">{fmtDay(c.date)}{c.site && <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500 align-middle">{c.site}</span>}</p><p className="text-xs text-slate-400">In {c.in}{c.out ? ` · Out ${c.out}` : " · still in"}</p></div>
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${c.out ? "bg-slate-100 text-slate-500" : "bg-emerald-100 text-emerald-700"}`}>{c.out ? "Complete" : "Active"}</span>
          </div>
        ))}
      </Card>
    </Screen>
  );
}

/* ----- Holiday Balance ----- */
function BalanceScreen({ store, me }) {
  // Two separate pots: the bookable Holiday Allowance (e.g. 20) and the fixed Bank
  // Holidays (e.g. 8). Bank holidays are never bookable and never touch the 20.
  const bookable = store.bookableAllowance(me.id);   // total entitlement − 8 bank holidays
  const used = store.usedDays(me.id);                // working days booked (weekends/BH excluded)
  const left = store.remaining(me.id);               // bookable − used
  const bankTotal = store.bankHolidayTotal;          // 8
  const bankUsed = store.bankHolidayDaysUsed();       // bank holidays passed so far
  const myLeave = store.leave.filter(l => l.staffId === me.id);
  const myAdj = store.adjustments.filter(a => a.staffId === me.id);
  const animLeft = useCountUp(left);
  // Read-only counts of this user's leave by type (any status), summed as WORKING days
  // (weekends + bank holidays excluded — matches what is actually charged).
  // Scoped to THIS leave year, like the ring and the two pots above — mixing a
  // lifetime total in underneath them read as a contradiction.
  const leaveYear = todayISO().slice(0, 4);
  const byType = LEAVE_TYPES.map(t => {
    const rows = myLeave.filter(l => l.type === t.key && store.chargeableDays(l.start, l.end, leaveYear) > 0);
    const days = rows.reduce((sum, l) => sum + store.chargeableDays(l.start, l.end, leaveYear), 0);
    return { ...t, count: rows.length, days };
  }).filter(x => x.count > 0);
  const usedPct = bookable > 0 ? Math.round((used / bookable) * 100) : 0;
  return (
    <Screen>
      <Card>
        <div className="flex items-center justify-center">
          <div className="relative h-40 w-40">
            <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
              <circle cx="60" cy="60" r="52" fill="none" stroke="#eef1f6" strokeWidth="14" />
              <circle cx="60" cy="60" r="52" fill="none" stroke={NAVY} strokeWidth="14" strokeLinecap="round" strokeDasharray={`${2 * Math.PI * 52}`} strokeDashoffset={`${2 * Math.PI * 52 * (1 - (bookable > 0 ? left / bookable : 0))}`} style={{ transition: "stroke-dashoffset 1s ease" }} />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center scale-in"><span className="text-4xl font-extrabold tabular-nums" style={{ color: NAVY }}>{animLeft}</span><span className="text-xs font-medium text-slate-400">days left</span></div>
          </div>
        </div>
        <p className="mt-2 text-center text-[11px] font-semibold text-slate-400">{used} of {bookable} days booked · {usedPct}% used</p>
        {/* The two pots, matching the design — each shows "taken — total". */}
        <div className="mt-4 grid grid-cols-2 gap-3 text-center">
          <div className="rounded-2xl border border-slate-100 bg-slate-50 py-3">
            <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Holiday Allowance</p>
            <p className="mt-1 text-2xl font-extrabold tabular-nums" style={{ color: NAVY }}>{used}<span className="mx-1.5 text-slate-300">—</span>{bookable}</p>
            <p className="text-[11px] text-slate-400">taken · total</p>
          </div>
          <div className="rounded-2xl border border-amber-100 bg-amber-50 py-3">
            <p className="text-[11px] font-bold uppercase tracking-wide text-amber-500">Bank Holidays</p>
            <p className="mt-1 text-2xl font-extrabold tabular-nums text-amber-600">{bankUsed}<span className="mx-1.5 text-amber-300">—</span>{bankTotal}</p>
            <p className="text-[11px] text-amber-500/80">passed · total</p>
          </div>
        </div>
        <div className="mt-2 rounded-xl bg-emerald-50 py-2 text-center"><span className="text-lg font-extrabold text-emerald-600">{left}</span> <span className="text-[11px] text-slate-400">days remaining to book</span></div>
        {myAdj.length > 0 && <p className="mt-3 text-center text-[11px] text-slate-400">Includes {store.adjDays(me.id) >= 0 ? "+" : ""}{store.adjDays(me.id)}d HR adjustment</p>}
      </Card>
      {byType.length > 0 && (
        <Card className="mt-3">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">Your leave by type</p>
          <div className="space-y-2">
            {byType.map(t => { const T = t.icon; return (
              <div key={t.key} className="flex items-center gap-2.5">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ background: t.colour + "1a" }}><T size={14} style={{ color: t.colour }} /></span>
                <span className="flex-1 text-sm font-semibold text-slate-600">{t.label}</span>
                <span className="text-xs font-bold text-slate-400">{t.count} req · {t.days}d</span>
              </div>
            ); })}
          </div>
        </Card>
      )}
      <p className="mb-2 mt-5 px-1 text-xs font-bold uppercase tracking-wide text-slate-400">Leave history</p>
      <div className="space-y-2">
        {myLeave.length === 0 && <Card><EmptyState Icon={Plane} title="No leave records yet" msg="Requests you submit will show up here." /></Card>}
        {myLeave.slice().reverse().map((l, i) => <LeaveRow key={l.id} l={l} i={i} store={store} />)}
      </div>
    </Screen>
  );
}
function LeaveRow({ l, i = 0, store }) {
  const t = leaveTypeMeta(l.type); const T = t.icon;
  const [busy, setBusy] = useState(false);
  // Staff may withdraw a request that is still pending and still in the future. An
  // approved booking needs an administrator — the server enforces both rules; this
  // only decides whether to offer the button.
  const canWithdraw = l.status === "pending" && l.end >= todayISO();
  const withdraw = async () => {
    const days = store.chargeableDays(l.start, l.end);
    if (!window.confirm(`Withdraw your ${t.label.toLowerCase()} request for ${fmtDate(l.start)}${l.end !== l.start ? ` → ${fmtDate(l.end)}` : ""}?\n\n${days} day${days === 1 ? "" : "s"} will go back into your allowance.`)) return;
    setBusy(true);
    try { await store.cancelLeave(l.id); } catch (_) { /* the store toasts the error */ }
    setBusy(false);
  };
  return (
    <Card className="!p-3 fade-up" style={{ animationDelay: `${i * 50}ms` }}>
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl transition-transform duration-300 hover:scale-110" style={{ background: t.colour + "1a" }}><T size={18} style={{ color: t.colour }} /></span>
        <div className="flex-1"><p className="text-sm font-semibold text-slate-700">{t.label}</p><p className="text-xs text-slate-400">{fmtDate(l.start)}{l.end !== l.start && ` → ${fmtDate(l.end)}`} · {store.chargeableDays(l.start, l.end)}d</p></div>
        {canWithdraw && (
          <button onClick={withdraw} disabled={busy} title="Withdraw this request"
            className="press rounded-lg p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500 disabled:opacity-40">
            {busy ? <Loader size={15} /> : <Trash2 size={15} />}
          </button>
        )}
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold capitalize ${statusBadge(l.status)}`}>{l.status}</span>
      </div>
      {l.note && l.status !== "pending" && <p className="mt-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] italic text-slate-500">Manager: "{l.note}"</p>}
    </Card>
  );
}

/* ----- Staff on Site ----- */
// Who is in the building today. Open to every member of staff, not just admins —
// the point is that a lecturer arriving can see who else is around.
//
// "Building" is the site recorded when someone signed up (HND / FE / SL), which is
// what the college means by it. A check-in can also record where that particular
// clock-in happened; where the two differ, the row says so rather than quietly
// filing someone under the wrong building.
const ON_SITE_FILTERS = [
  { key: "", label: "All" },
  { key: "HND", label: "HND" },
  { key: "FE", label: "FE" },
  { key: "SL", label: "SL" },
];

function StaffOnSiteScreen({ store, me }) {
  const [data, setData] = useState(null);   // null = loading
  const [site, setSite] = useState("");
  const [err, setErr] = useState("");

  // Refresh on mount and every 60s while the screen is visible: people arrive
  // through the morning, and a stale list is worse than no list.
  useEffect(() => {
    let cancelled = false;
    const load = () => store.staffOnSite()
      .then(d => { if (!cancelled) { setData(d); setErr(""); } })
      .catch(e => { if (!cancelled) { setData(prev => prev || { people: [] }); setErr(e.message || "Could not load who's in today."); } });
    load();
    const id = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") load();
    }, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const all = data?.people || [];
  const shown = site ? all.filter(p => p.site === site) : all;
  // Counts per building, so the filter says how many are behind each one before
  // you tap it.
  const countFor = (k) => (k ? all.filter(p => p.site === k).length : all.length);
  const noSite = all.filter(p => !p.site).length;

  return (
    <Screen>
      <div className="mb-3 flex gap-1.5 overflow-x-auto pb-0.5">
        {ON_SITE_FILTERS.map(s => (
          <button key={s.key} type="button" onClick={() => setSite(s.key)}
            className={`press flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-bold ring-1 transition ${site === s.key ? "text-white ring-transparent shadow-sm" : "bg-white text-slate-500 ring-slate-200"}`}
            style={site === s.key ? { background: NAVY } : {}}>
            {s.label}
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${site === s.key ? "bg-white/25" : "bg-slate-100 text-slate-500"}`}>{countFor(s.key)}</span>
          </button>
        ))}
      </div>

      {err && <Card className="mb-3 !p-3"><p className="text-xs font-semibold text-rose-600">{err}</p></Card>}

      {data === null ? (
        <div className="flex flex-col items-center gap-2 py-12 text-slate-400"><Loader2 size={22} className="animate-spin" /><p className="text-xs font-semibold">Loading who's in…</p></div>
      ) : shown.length === 0 ? (
        <Card><EmptyState Icon={Users} title={site ? `Nobody from ${site} yet` : "Nobody has checked in yet"}
          msg={site ? "Try another building, or All." : "Check-ins appear here as people arrive."} /></Card>
      ) : (
        <div className="space-y-2">
          {shown.map((p, i) => (
            <Card key={p.id} className="flex items-center gap-3 !p-3 fade-up" style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white shadow-sm" style={{ background: p.colour || NAVY }}>{p.initials}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-slate-700">
                  {p.name}{p.staffId === me?.id && <span className="ml-1.5 text-[10px] font-bold text-slate-400">(you)</span>}
                </p>
                <p className="truncate text-[11px] text-slate-400">{[p.jobTitle, p.dept].filter(Boolean).join(" · ") || "Staff"}</p>
                {/* The check-in records Onsite/Online, which is a different question
                    from which building someone belongs to. Only "Online" is worth
                    saying — it means they are not in the building at all. */}
                {/Online/i.test(p.checkedInAt || "") && (
                  <p className="truncate text-[10px] font-semibold text-emerald-600">Working online</p>
                )}
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-extrabold tabular-nums" style={{ color: NAVY }}>{p.timeIn}</p>
                {p.site
                  ? <span className="mt-0.5 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">{p.site}</span>
                  : <span className="mt-0.5 inline-block rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-600">No site</span>}
                {p.timeOut && <p className="mt-0.5 text-[10px] text-slate-400">Left {p.timeOut}</p>}
              </div>
            </Card>
          ))}
        </div>
      )}

      {data !== null && (
        <Card className="mt-3 !p-3 text-center">
          <p className="text-sm font-bold text-slate-600">
            Checked in today{site ? ` (${site})` : ""}: <span style={{ color: NAVY }}>{shown.length}</span>
          </p>
          {!site && noSite > 0 && (
            <p className="mt-1 text-[11px] text-slate-400">
              {noSite} {noSite === 1 ? "person has" : "people have"} no building on their record — set it on their staff profile.
            </p>
          )}
        </Card>
      )}
    </Screen>
  );
}

/* ----- Calendar ----- */
// First name plus a last initial. The month cell is ~130px wide, so a full name would
// be cut mid-word; this keeps the person recognisable at a glance, and the tooltip and
// the day popup both carry the whole thing.
const shortName = (full) => {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
};

// Everything about one day, opened by clicking its cell. The grid can only ever show
// initials and a colour, which answers "is anyone off?" but not "who, and why?" —
// this answers the second question without making the admin cross-reference the
// requests list by hand.
function DayDetail({ store, iso, onClose, showPending }) {
  if (!iso) return null;
  const bh = store.bankHolidaySet.get(iso);
  const onDay = (l) => iso >= l.start && iso <= l.end;
  const approved = store.leave.filter(l => l.status === "approved" && onDay(l));
  // Pending sits on the admin calendar only. A pending request is a decision waiting
  // to be made, so an admin looking at a day needs to see what might land on it;
  // it isn't the whole college's business until it's approved.
  const pending = showPending ? store.leave.filter(l => l.status === "pending" && onDay(l)) : [];

  const heading = new Date(iso + "T12:00:00").toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  const Person = ({ l }) => {
    const p = store.staff.find(x => x.id === l.staffId);
    const t = leaveTypeMeta(l.type);
    const T = t.icon;
    const span = daysBetween(l.start, l.end);           // calendar length of the leave
    const charged = store.chargeableDays(l.start, l.end); // working days actually taken
    // Which day of their leave this one is — "day 2 of 5" tells you whether they are
    // just off or midway through a fortnight, which the date range alone doesn't.
    const nth = daysBetween(l.start, iso);
    return (
      <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white shadow-sm" style={{ background: p?.colour || NAVY }}>{p?.initials}</span>
          {/* Wraps rather than truncates: the whole point of the popup is the full
              name and the full address, and a long one would be cut on a phone. */}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-extrabold leading-snug" style={{ color: NAVY }}>{p?.name || "Unknown staff member"}</p>
            {(p?.role || p?.dept) && <p className="text-[11px] leading-snug text-slate-500">{[p.role, p.dept].filter(Boolean).join(" · ")}</p>}
            {p?.email && <p className="break-all text-[11px] leading-snug text-slate-400">{p.email}</p>}
          </div>
          <span className="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: t.colour + "1a", color: t.colour }}><T size={11} /> {t.label}</span>
        </div>
        <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-slate-100 pt-2.5 text-[11px]">
          <div><span className="text-slate-400">Away</span><p className="font-semibold text-slate-600">{fmtDate(l.start)}{l.end !== l.start && ` → ${fmtDate(l.end)}`}</p></div>
          <div><span className="text-slate-400">This day</span><p className="font-semibold text-slate-600">{span === 1 ? "Single day" : `Day ${nth} of ${span}`}</p></div>
          <div><span className="text-slate-400">Working days charged</span><p className="font-semibold text-slate-600">{NON_ALLOWANCE_TYPES.includes(l.type) ? `${charged} (unpaid — no allowance used)` : `${charged} day${charged === 1 ? "" : "s"}`}</p></div>
          <div><span className="text-slate-400">Status</span><p className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold capitalize ${statusBadge(l.status)}`}>{l.status}</p></div>
        </div>
        {l.reason && <p className="mt-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-500"><span className="font-semibold text-slate-400">Reason: </span>{l.reason}</p>}
        {l.note && <p className="mt-1.5 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] italic text-slate-500">Manager: "{l.note}"</p>}
      </div>
    );
  };

  return (
    <Modal open onClose={onClose} title={heading} width={540}>
      <div className="space-y-3">
        {bh && (
          <div className="flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-xs font-bold text-amber-800 ring-1 ring-amber-200">
            <span className="text-base leading-none">🏛</span>
            <span>{bh} — a bank holiday. Nobody's allowance is charged for this day.</span>
          </div>
        )}

        <div>
          <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-slate-400">
            {approved.length === 0 ? "Nobody on leave" : `On leave · ${approved.length}`}
          </p>
          {approved.length === 0
            ? <p className="rounded-xl bg-slate-50 px-3 py-4 text-center text-xs text-slate-400">{bh ? "The college is closed, and no leave is booked on top of it." : "Everyone is in on this day."}</p>
            : <div className="space-y-2">{approved.map(l => <Person key={l.id} l={l} />)}</div>}
        </div>

        {pending.length > 0 && (
          <div className="border-t border-slate-100 pt-3">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-slate-400">Awaiting a decision · {pending.length}</p>
            <div className="space-y-2">{pending.map(l => <Person key={l.id} l={l} />)}</div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function MonthGrid({ store, big, showPending }) {
  const [cursor, setCursor] = useState(new Date());
  // Which day's popup is open, as an ISO date. Null when none is.
  const [dayOpen, setDayOpen] = useState(null);
  const year = cursor.getFullYear(), month = cursor.getMonth();
  const startPad = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const approved = store.leave.filter(l => l.status === "approved");
  return (
    <div>
      <div className={`mb-3 flex items-center justify-between ${big ? "" : ""}`}>
        <button onClick={() => setCursor(new Date(year, month - 1, 1))} className="rounded-lg p-1.5 transition hover:bg-slate-100 active:scale-90"><ChevronLeft size={18} /></button>
        <p className={`font-extrabold ${big ? "text-lg" : "text-base"}`} style={{ color: NAVY }}>{cursor.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</p>
        <button onClick={() => setCursor(new Date(year, month + 1, 1))} className="rounded-lg p-1.5 transition hover:bg-slate-100 active:scale-90"><ChevronRight size={18} /></button>
      </div>
      <div className={`grid grid-cols-7 ${big ? "gap-1.5" : "gap-1"} text-center text-[10px] font-bold text-slate-400`}>
        {(big ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] : ["M", "T", "W", "T", "F", "S", "S"]).map((d, i) => <div key={i} className="py-1">{d}</div>)}
      </div>
      <div className={`grid grid-cols-7 ${big ? "gap-1.5" : "gap-1"}`}>
        {Array.from({ length: startPad }).map((_, i) => <div key={"p" + i} />)}
        {Array.from({ length: days }).map((_, i) => {
          const d = i + 1; const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const isToday = iso === todayISO(); const evts = approved.filter(l => iso >= l.start && iso <= l.end);
          const bh = store.bankHolidaySet.get(iso); // bank holiday name, or undefined
          // The whole cell is the hit target, so a day can be opened without aiming at
          // one of the name chips inside it.
          const dayLabel = `${fmtDate(iso)}${bh ? ` — ${bh}` : ""}${evts.length ? ` — ${evts.length} on leave` : ""}`;
          if (big) return (
            <button key={d} type="button" onClick={() => setDayOpen(iso)} title={dayLabel} aria-label={dayLabel}
              className={`press min-h-[78px] rounded-xl border p-1.5 text-left transition-all duration-200 hover:shadow-sm ${bh ? "border-amber-300 bg-amber-50 hover:border-amber-400" : isToday ? "border-blue-300 bg-blue-50/40 glow-pulse" : "border-slate-100 hover:border-blue-200 hover:bg-blue-50/30"}`}>
              {/* spans, not p/div: a <button> may only contain phrasing content, and
                  the cell itself is the hit target. */}
              <span className={`block text-xs font-bold ${isToday ? "text-blue-700" : bh ? "text-amber-700" : "text-slate-400"}`}>{d}</span>
              {bh && <span className="mt-0.5 block truncate rounded bg-amber-400 px-1 py-0.5 text-[8px] font-bold text-white">🏛 {bh}</span>}
              <span className="mt-1 block space-y-0.5">{evts.slice(0, 3).map(e => { const p = store.staff.find(s => s.id === e.staffId); const t = leaveTypeMeta(e.type); /* safe fallback so an unknown type can't crash the calendar */ return <span key={e.id} title={`${p?.name || "Unknown"} — ${t.label}`} className="block truncate rounded px-1 py-0.5 text-[9px] font-bold text-white" style={{ background: t.colour }}>{shortName(p?.name) || p?.initials}</span>; })}{evts.length > 3 && <span className="block text-[9px] font-semibold text-slate-400">+{evts.length - 3} more</span>}</span>
            </button>
          );
          return (
            <button key={d} type="button" onClick={() => setDayOpen(iso)} title={dayLabel} aria-label={dayLabel} className={`press relative flex h-9 flex-col items-center justify-center rounded-lg text-[13px] transition-all duration-200 ${isToday ? "font-bold text-white glow-pulse" : bh ? "bg-amber-100 font-semibold text-amber-700" : "text-slate-600 hover:bg-slate-100"}`} style={isToday ? { background: NAVY } : {}}>
              {d}{(evts.length > 0 || bh) && <span className="absolute bottom-1 flex gap-0.5">{bh && <span className="h-1 w-1 rounded-full bg-amber-500" />}{evts.slice(0, 2).map((e, k) => <span key={k} className="h-1 w-1 rounded-full" style={{ background: leaveTypeMeta(e.type).colour }} />)}</span>}
            </button>
          );
        })}
      </div>
      <DayDetail store={store} iso={dayOpen} onClose={() => setDayOpen(null)} showPending={showPending} />
    </div>
  );
}
// A compact list of the current calendar year's bank holidays, flagging which have
// already passed. Bank holidays are a fixed pot of days off, separate from and never
// drawn from the bookable holiday allowance.
function BankHolidayList({ store }) {
  // London year (matches the balance card), not the device's local year.
  const year = Number(todayISO().slice(0, 4));
  const today = todayISO();
  const list = store.bankHolidays.filter(h => h.date.slice(0, 4) === String(year));
  if (list.length === 0) return null;
  const passed = list.filter(h => h.date <= today).length;
  return (
    <div className="mt-5">
      <p className="mb-2 px-1 text-xs font-bold uppercase tracking-wide text-slate-400">Bank holidays {year} · {passed} of {list.length} passed</p>
      <Card className="p-0">
        {list.map((h, i, a) => { const done = h.date <= today; return (
          <div key={h.date} className={`flex items-center gap-3 px-4 py-2.5 ${i < a.length - 1 ? "border-b border-slate-100" : ""}`}>
            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm ${done ? "bg-amber-100" : "bg-slate-100"}`}>🏛</span>
            <div className="flex-1"><p className="text-sm font-semibold text-slate-700">{h.name}</p><p className="text-[11px] text-slate-400">{fmtDate(h.date)}</p></div>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${done ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-400"}`}>{done ? "Passed" : "Upcoming"}</span>
          </div>
        ); })}
      </Card>
    </div>
  );
}

function CalendarScreen({ store }) {
  const approved = store.leave.filter(l => l.status === "approved");
  return (
    <Screen>
      <Card>
        <MonthGrid store={store} />
        <div className="mt-3 border-t border-slate-100 pt-3">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-slate-400">Leave types</p>
          <LeaveLegend />
          <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-500"><span className="h-2.5 w-2.5 shrink-0 rounded-full bg-amber-400" /> Bank holiday — a fixed day off for everyone, separate from your bookable allowance</div>
        </div>
      </Card>
      <BankHolidayList store={store} />
      <p className="mb-2 mt-5 px-1 text-xs font-bold uppercase tracking-wide text-slate-400">Who's off (approved)</p>
      <div className="space-y-2">
        {approved.length === 0 && <Card><EmptyState Icon={CalendarCheck} title="No approved leave" msg="Approved absences across the college will appear here." /></Card>}
        {approved.map((l, i) => { const p = store.staff.find(s => s.id === l.staffId); const t = leaveTypeMeta(l.type); return (
          <Card key={l.id} className="flex items-center gap-3 !p-3 fade-up" style={{ animationDelay: `${i * 50}ms` }}>
            <span className="flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold text-white shadow-sm" style={{ background: p?.colour }}>{p?.initials}</span>
            <div className="flex-1"><p className="text-sm font-semibold text-slate-700">{p?.name}</p><p className="text-xs text-slate-400">{fmtDate(l.start)}{l.end !== l.start && ` → ${fmtDate(l.end)}`}</p></div>
            <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: t.colour + "1a", color: t.colour }}>{t.label}</span>
          </Card>
        ); })}
      </div>
    </Screen>
  );
}

/* ----- Request Leave ----- */
function RequestLeaveScreen({ store, me, setScreen }) {
  const [type, setType] = useState("annual");
  const [start, setStart] = useState(todayISO());
  const [end, setEnd] = useState(todayISO());
  const [reason, setReason] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const spanDays = daysBetween(start, end);                  // calendar length of the range
  const charged = store.chargeableDays(start, end);          // working days actually deducted
  const bankInRange = store.bankHolidaysBetween(start, end);  // bank holidays inside the range
  const weekendInRange = Math.max(0, spanDays - charged - bankInRange); // Sat/Sun in the range
  const left = store.remaining(me.id);
  // The allowance is per leave year, so check the year(s) this booking falls in — not
  // just the current one. Otherwise January leave booked in December was refused
  // against a December pot that has nothing to do with it.
  const overflow = NON_ALLOWANCE_TYPES.includes(type) ? null : store.overflowYear(me.id, start, end);
  const isUnpaid = type === "unpaid";
  // Leave can't be booked for a date that has already passed.
  const inPast = start < todayISO();
  // A range made up entirely of weekends and/or bank holidays has no working day to
  // book — the app blocks it (bank holidays aren't bookable; weekends are days off).
  const nothingToBook = charged === 0;
  // Paid leave can't exceed the remaining bookable days; unpaid never charges.
  const overAllowance = !!overflow;
  const blocked = inPast || nothingToBook || overAllowance;
  // A ref, not just state: two taps in the same tick would both read the old
  // state value, but both see the ref. The whole round trip is a window in which
  // the button is otherwise still live, and a double-tap booked the leave twice.
  const sending = useRef(false);
  const submit = async () => {
    if (sending.current || blocked) return;
    sending.current = true;
    setBusy(true);
    try { await store.requestLeave({ type, start, end, reason }); setDone(true); }
    catch (e) {}
    finally { sending.current = false; setBusy(false); }
  };
  if (done) return (
    <Screen>
      <Card className="text-center">
        <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 ring-4 ring-emerald-50 bounce-in"><CheckCircle2 size={36} className="text-emerald-600" /></div>
        <p className="text-xl font-extrabold" style={{ color: NAVY }}>Request Submitted</p>
        <p className="mt-1 text-sm text-slate-500">Your manager has been notified. Track it under Holiday Balance.</p>
        <div className="mt-5 flex gap-2"><PrimaryBtn onClick={() => setScreen("home")} className="flex-1">Back to Hub</PrimaryBtn><button onClick={() => { setDone(false); setReason(""); }} className="flex-1 rounded-xl border-2 border-slate-200 py-2.5 text-sm font-bold text-slate-600">New request</button></div>
      </Card>
    </Screen>
  );
  return (
    <Screen>
      <Card>
        <label className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Leave type</label>
        <div className="mb-4 mt-2 grid grid-cols-2 gap-2">
          {LEAVE_TYPES.map((t, i) => { const T = t.icon; const on = type === t.key; return (
            <button key={t.key} onClick={() => setType(t.key)} className={`flex items-center gap-2 rounded-xl border-2 p-2.5 text-left transition-all duration-200 hover:-translate-y-0.5 active:scale-95 pop ${on ? "border-transparent shadow-sm" : "border-slate-200 bg-white"}`} style={on ? { background: t.colour + "12", borderColor: t.colour, animationDelay: `${i * 50}ms` } : { animationDelay: `${i * 50}ms` }}>
              <T size={18} className="transition-transform" style={{ color: t.colour }} /><span className="text-[12px] font-bold" style={{ color: on ? t.colour : "#475569" }}>{t.label}</span>
            </button>
          ); })}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From"><input type="date" value={start} min={todayISO()} onChange={e => { setStart(e.target.value); if (e.target.value > end) setEnd(e.target.value); }} className={inputCls} /></Field>
          <Field label="To"><input type="date" value={end} min={start > todayISO() ? start : todayISO()} onChange={e => setEnd(e.target.value)} className={inputCls} /></Field>
        </div>
        <div className="mt-4"><Field label="Reason (optional)"><textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} placeholder="Add a short note for your manager…" className={inputCls + " resize-none"} /></Field></div>
        <div className="mt-4 flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5 text-sm"><span className="text-slate-500">Working days charged</span><span className="font-bold" style={{ color: NAVY }}>{charged} day{charged === 1 ? "" : "s"}{spanDays !== charged ? ` · ${spanDays} selected` : ""}</span></div>
        {/* Explain what was skipped, then block anything that can't be booked. */}
        {(bankInRange > 0 || weekendInRange > 0) && !nothingToBook && !inPast && (
          <div className="mt-2 flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700"><Info size={15} /> Not counted: {[weekendInRange > 0 && `${weekendInRange} weekend day${weekendInRange === 1 ? "" : "s"}`, bankInRange > 0 && `${bankInRange} bank holiday${bankInRange === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}.</div>
        )}
        {inPast
          ? <div className="mt-2 flex items-center gap-2 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600"><AlertCircle size={15} /> You can't book leave for a past date — choose today or later.</div>
          : nothingToBook
          ? <div className="mt-2 flex items-center gap-2 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600"><AlertCircle size={15} /> These dates are all weekends and/or bank holidays — there are no working days to book.</div>
          : overAllowance && <div className="mt-2 flex items-center gap-2 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600"><AlertCircle size={15} /> Exceeds your {overflow.year} allowance — {overflow.cost} day{overflow.cost === 1 ? "" : "s"} needed but {overflow.left} left. Choose Unpaid Leave or a shorter period.</div>}
        <PrimaryBtn onClick={submit} disabled={busy || blocked} className="mt-5 w-full !py-3.5">
          {busy ? <><Loader2 size={18} className="animate-spin" /> Submitting…</> : <><Plus size={18} /> Submit Request</>}
        </PrimaryBtn>
      </Card>
    </Screen>
  );
}

/* ----- Documents ----- */
function DocumentsScreen({ store, me }) {
  const [filter, setFilter] = useState("All");
  const [q, setQ] = useState("");
  const visible = store.docs.filter(d => d.scope === "all" || d.assignedTo === me.id);
  const filtered = visible.filter(d => (filter === "All" || d.type === filter) && d.name.toLowerCase().includes(q.toLowerCase()));
  const iconFor = (t) => ({ Policy: FileText, Payroll: Briefcase, Calendar: CalendarDays, HR: Users, Form: ClipboardList }[t] || FileText);
  const types = ["All", ...Array.from(new Set(visible.map(d => d.type)))];
  // The link is signed on demand and expires in minutes, so it is fetched at the
  // moment of tapping rather than held in the list.
  const openDoc = async (d) => {
    try {
      const { url } = await store.documentDownloadUrl(d.id);
      // "_system" on native hands the signed URL to the OS browser/downloader instead
      // of loading it inside the Capacitor WebView — matches TwoFactor.jsx's convention.
      const native = typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.() === true;
      window.open(url, native ? "_system" : "_blank", "noopener,noreferrer");
    } catch (e) { store.notify(e.message || "Could not open that document", "error"); }
  };
  return (
    <Screen>
      <div className="mb-3 flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200"><Search size={16} className="text-slate-400" /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search documents…" className="w-full bg-transparent text-sm outline-none" /></div>
      <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
        {types.map(t => <button key={t} onClick={() => setFilter(t)} className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold transition-all duration-200 active:scale-95 ${filter === t ? "text-white shadow-sm" : "bg-white text-slate-500 ring-1 ring-slate-200 hover:ring-slate-300"}`} style={filter === t ? { background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` } : {}}>{t}</button>)}
      </div>
      <div className="mb-2 flex items-center justify-between px-1 text-[11px] font-semibold text-slate-400">
        <span>{filtered.length} document{filtered.length === 1 ? "" : "s"}{filter !== "All" ? ` · ${filter}` : ""}</span>
        {visible.some(d => d.scope === "personal" && d.assignedTo === me.id) && <span className="flex items-center gap-1"><ShieldCheck size={12} /> includes private</span>}
      </div>
      <div className="space-y-2">
        {filtered.length === 0 && <Card><EmptyState Icon={FileText} title="No documents found" msg="Try a different filter or search term." /></Card>}
        {filtered.map((d, i) => { const I = iconFor(d.type); const dc = docTypeColour(d.type); return (
          <Card key={d.id} className="group flex items-center gap-3 !p-3.5 fade-up" style={{ animationDelay: `${i * 45}ms` }}>
            <span className="flex h-11 w-11 items-center justify-center rounded-xl transition-transform duration-300 group-hover:scale-110" style={{ background: dc + "14" }}><I size={20} style={{ color: dc }} /></span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-slate-700">{d.name}</p>
              <div className="mt-0.5 flex items-center gap-1.5">
                <span className="rounded-full px-1.5 py-0.5 text-[9px] font-bold" style={{ background: dc + "1a", color: dc }}>{d.type}</span>
                <span className="text-xs text-slate-400">{fmtDate(d.date)}{d.scope === "personal" ? " · Private" : ""}</span>
              </div>
            </div>
            {/* A real download. This used to toast "Downloading…" and do nothing —
                the file didn't exist to fetch. Disabled, with a reason, when a
                document has no file attached, rather than failing on tap. */}
            <button
              onClick={() => openDoc(d)}
              disabled={!d.hasFile}
              title={d.hasFile ? `Open ${d.fileName || d.name}` : "No file has been attached to this document yet"}
              className="rounded-lg p-2 text-slate-400 transition hover:bg-blue-50 hover:text-blue-600 active:scale-90 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-400"
            ><Download size={18} /></button>
          </Card>
        ); })}
      </div>
    </Screen>
  );
}

/* ----- Manager Approval (in app) ----- */
function ApprovalScreen({ store, me }) {
  // A leave page, not merely being an admin — matches the tile gate and the server.
  if (!canDecideLeaveFor(store.currentUser)) return <div className="p-4 text-slate-400">Access denied</div>;
  const pending = store.leave.filter(l => l.status === "pending");
  const act = (l, status) => store.decideLeave(l.id, status);
  return (
    <Screen>
      <div className="mb-3 flex items-center gap-2 rounded-xl bg-blue-50 px-3 py-2.5 text-xs font-medium text-blue-800"><ThumbsUp size={15} /> {pending.length} request{pending.length === 1 ? "" : "s"} awaiting your approval</div>
      {pending.length === 0 && <Card><EmptyState Icon={CheckCircle2} title="All caught up" msg="There are no pending requests to review right now." /></Card>}
      <div className="space-y-3">
        {pending.map((l, i) => { const p = store.staff.find(s => s.id === l.staffId); const t = leaveTypeMeta(l.type); return (
          <Card key={l.id} className="fade-up" style={{ animationDelay: `${i * 60}ms` }}>
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-full text-xs font-bold text-white shadow-sm" style={{ background: p?.colour }}>{p?.initials}</span>
              <div className="flex-1"><p className="text-sm font-bold text-slate-700">{p?.name}</p><p className="text-xs text-slate-400">{p?.role}</p></div>
              <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: t.colour + "1a", color: t.colour }}>{t.label}</span>
            </div>
            <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600"><p><b>{fmtDate(l.start)}</b>{l.end !== l.start && <> → <b>{fmtDate(l.end)}</b></>} · {store.chargeableDays(l.start, l.end)} day(s)</p><p className="mt-1 italic text-slate-500">"{l.reason}"</p></div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button onClick={() => act(l, "rejected")} className="flex items-center justify-center gap-1.5 rounded-xl border-2 border-rose-200 py-2.5 text-sm font-bold text-rose-600 transition hover:bg-rose-50 active:scale-95"><XCircle size={16} /> Decline</button>
              <PrimaryBtn onClick={() => act(l, "approved")} colour="#059669" className="!py-2.5"><CheckCircle2 size={16} /> Approve</PrimaryBtn>
            </div>
          </Card>
        ); })}
      </div>
    </Screen>
  );
}

/* ----- Daily Summary ----- */
function SummaryScreen({ store, me }) {
  const today = todayISO();
  const rec = store.checkins.find(c => c.staffId === me.id && c.date === today);
  const [text, setText] = useState(rec?.summary || "");
  const [touched, setTouched] = useState(false);
  // Seed the box once check-ins have loaded. Opening this screen before the initial
  // load finished left an existing summary showing as an empty box (useState ran with
  // no data). Only sync while the user hasn't started typing, so it can't clobber an
  // unsaved edit.
  useEffect(() => { if (!touched && rec?.summary) setText(rec.summary); }, [rec?.summary, rec?.id, touched]);
  const [saved, setSaved] = useState(false);
  const save = async () => {
    await store.saveSummary(today, text);
    setSaved(true); setTimeout(() => setSaved(false), 1800);
  };
  return (
    <Screen>
      <Card>
        <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{fmtDay(today)}</p>
        <p className="mb-3 text-lg font-extrabold" style={{ color: NAVY }}>What did you work on today?</p>
        <textarea value={text} onChange={e => { setTouched(true); setText(e.target.value); }} rows={6} placeholder="e.g. Taught Y12 Maths, marked mock papers, met admissions about September intake…" className={inputCls + " resize-none"} />
        <PrimaryBtn onClick={save} colour={saved ? "#059669" : NAVY} className="mt-3 w-full !py-3">{saved ? <><Check size={18} /> Saved & shared</> : "Save Daily Summary"}</PrimaryBtn>
      </Card>
      <p className="mb-2 mt-5 px-1 text-xs font-bold uppercase tracking-wide text-slate-400">Recent summaries</p>
      <div className="space-y-2">
        {store.checkins.filter(c => c.staffId === me.id && c.summary).length === 0 && <Card><EmptyState Icon={ClipboardList} title="No summaries yet" msg="Save a daily summary above and it will appear here." /></Card>}
        {store.checkins.filter(c => c.staffId === me.id && c.summary).slice(0, 4).map((c, i) => <Card key={c.id} className="!p-3 fade-up" style={{ animationDelay: `${i * 50}ms` }}><p className="text-xs font-bold text-slate-400">{fmtDay(c.date)}</p><p className="mt-1 text-sm text-slate-600">{c.summary}</p></Card>)}
      </div>
    </Screen>
  );
}

// App-lock toggle. Renders nothing on the web (no sensor), and explains itself when
// the device has biometrics but the user hasn't enrolled any.
// The app-lock toggle. Shared verbatim by the staff "More" screen and the student
// "More" screen, so both sides behave identically and there is one implementation
// to keep correct.
export function BiometricSetting({ owner = "" }) {
  // Feature parked — see BIOMETRICS_ENABLED in biometric.js. Returned before any hook
  // so the component does nothing at all: no device probe, no timer, no row. It is a
  // literal constant, so the bundler drops the rest of this component's work too.
  if (!BIOMETRICS_ENABLED) return null;
  const [status, setStatus] = useState(null);
  const [on, setOn] = useState(isBiometricEnabled());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [showWhy, setShowWhy] = useState(false);

  const check = useCallback(async () => {
    setBusy(true);
    try {
      setStatus(await biometricStatus());
    } catch (e) {
      // A THROW is caught here. A promise that never settles is not a throw, so
      // biometricStatus races every platform call against its own deadline — and the
      // effect below adds a last-resort timer in case anything new ever doesn't.
      setStatus({ state: "error", available: false, label: "biometric unlock", detail: String(e?.message || e), reason: "Couldn't check this device. Tap Check again." });
    }
    setBusy(false);
  }, []);

  useEffect(() => {
    check();
    // Belt and braces. "Checking this device…" must never be the final state: if
    // nothing has answered in 10s, stop waiting and show something actionable. This
    // component has now failed silently three ways — blank, then blank-with-reason,
    // then a spinner that never stopped — so the rule is that every path ends in
    // words plus a button.
    const t = setTimeout(() => {
      setStatus((s) => s || {
        state: "error", available: false, label: "biometric unlock",
        reason: "This device didn't answer. Tap Check again, or carry on — the app works without it.",
        detail: "The biometric check timed out.",
      });
      setBusy(false);
    }, 10000);
    return () => clearTimeout(t);
  }, [check]);

  // NEVER render nothing. Every hidden state this component has had — "not native",
  // "no plugin", "no sensor", "the check threw" — has been reported as "the feature
  // is missing", because an empty space cannot tell you it is empty on purpose.
  // Even the first paint, before the device has answered, says something.
  // Transient only — the effect above guarantees this resolves within 10 seconds,
  // one way or the other.
  if (!status) {
    return (
      <div className="flex items-center gap-2 px-4 py-3.5 text-sm font-semibold text-slate-400">
        <Loader2 size={15} className="animate-spin" /> Checking this device…
      </div>
    );
  }

  const label = status.label || biometryLabel(status.biometryType);
  const ready = status.state === "ready";
  // Whatever the device actually offers. The fallback keeps a single sensible entry
  // for a platform that reports no specific type (a browser, mainly).
  const methods = status.methods?.length ? status.methods : [{ key: "platform", label }];
  const errNote = note ? <p className="mt-2 rounded-lg bg-rose-50 px-2 py-1 text-[11px] font-semibold text-rose-600">{note}</p> : null;

  const turnOn = async () => {
    setBusy(true); setNote("");
    // The owner binds the credential and the remembered session to this account, so a
    // shared device can't unlock one person's session with another's face.
    const res = await enableBiometric({ owner });
    setBusy(false);
    if (res.ok) { setOn(true); return; }
    // A cancel is a choice, not a fault.
    if (res.reason !== "cancelled") setNote(res.reason || "Could not turn this on.");
  };
  const turnOff = async () => {
    setBusy(true); setNote("");
    const res = await disableBiometric();
    setBusy(false);
    if (res.ok) { setOn(false); return; }
    if (res.reason !== "cancelled") setNote(res.reason || "Could not turn this off.");
  };

  /* --- Unavailable: say why, and offer a way to re-check --- */
  if (!ready) {
    return (
      <div className="px-4 py-3.5">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
          <Fingerprint size={15} className="text-slate-400" /> {label}
        </span>
        <span className="mt-0.5 block text-[11px] leading-snug text-slate-400">{status.reason}</span>
        {/* Enrolling a face or finger happens in the DEVICE's settings, outside this
            app, so there has to be a way back in that isn't force-quitting. */}
        <div className="mt-2 flex items-center gap-3">
          <button onClick={check} disabled={busy}
            className="press flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-[11px] font-bold text-slate-600 transition hover:bg-slate-200 disabled:opacity-50">
            {busy ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} Check again
          </button>
          {status.detail && (
            <button onClick={() => setShowWhy(v => !v)} className="text-[11px] font-semibold text-slate-400 underline transition hover:text-slate-600">
              {showWhy ? "Hide details" : "Why?"}
            </button>
          )}
        </div>
        {showWhy && status.detail && (
          <p className="mt-2 rounded-lg bg-slate-50 px-2 py-1.5 text-[11px] leading-snug text-slate-500 ring-1 ring-slate-200">
            Device reported: {status.detail}
          </p>
        )}
        {errNote}
      </div>
    );
  }

  /* --- Already on: confirm it, and offer to switch it off --- */
  if (on) {
    return (
      <div className="px-4 py-3.5">
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2">
            <ShieldCheck size={16} className="shrink-0 text-emerald-600" />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-slate-700">App lock is on</span>
              <span className="block text-[11px] leading-snug text-slate-400">
                You'll be asked for {methods.map(m => m.label).join(" or ")} when the app opens
              </span>
            </span>
          </span>
          <button onClick={turnOff} disabled={busy}
            className="press shrink-0 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50">
            {busy ? <Loader2 size={12} className="animate-spin" /> : "Turn off"}
          </button>
        </div>
        {errNote}
      </div>
    );
  }

  /* --- Off: one tappable option per method the device offers --- */
  return (
    <div className="px-4 py-3.5">
      <p className="text-sm font-semibold text-slate-700">Open the app with</p>
      <p className="mt-0.5 text-[11px] leading-snug text-slate-400">Tap one to switch the app lock on.</p>
      <div className="mt-2.5 space-y-2">
        {methods.map((m) => {
          const Icon = m.key === "face" || m.key === "iris" ? ScanFace : Fingerprint;
          return (
            <button key={m.key} onClick={turnOn} disabled={busy}
              className="press group flex w-full items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left transition hover:border-slate-300 hover:bg-slate-50 disabled:opacity-60">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: "rgba(26,58,143,0.08)" }}>
                <Icon size={17} style={{ color: NAVY }} />
              </span>
              <span className="flex-1 text-sm font-semibold text-slate-700">Open with {m.label}</span>
              {busy ? <Loader2 size={15} className="animate-spin text-slate-400" /> : <ChevronRight size={16} className="text-slate-300 transition-transform group-hover:translate-x-0.5" />}
            </button>
          );
        })}
      </div>
      {/* Said plainly, because the options above cannot control this: the OS owns the
          choice of sensor once more than one is enrolled. */}
      {methods.length > 1 && (
        <p className="mt-2 text-[11px] leading-snug text-slate-400">
          If you've set up more than one, your device chooses which to ask for.
        </p>
      )}
      {errNote}
    </div>
  );
}

/* ----- Timesheet ----- */
// Whole/half hour formatting for minutes.
const fmtHours = (mins) => { const h = mins / 60; return (Math.round(h * 10) / 10).toString().replace(/\.0$/, ""); };
const monthOf = (iso) => iso.slice(0, 7);
const monthLabel = (m) => new Date(m + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" });
// Shift a "YYYY-MM" string by whole months, TIMEZONE-SAFELY. Doing this via a local
// Date + toISOString() drifts a month under BST (local midnight = 23:00 UTC the day
// before), which made the forward/back buttons land on the wrong month. Pure UTC
// arithmetic on the year/month numbers avoids that entirely.
const shiftMonthStr = (m, delta) => { const [y, mo] = m.split("-").map(Number); const d = new Date(Date.UTC(y, mo - 1 + delta, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
const lastDayOfMonth = (m) => { const [y, mo] = m.split("-").map(Number); return new Date(y, mo, 0).getDate(); };
const prettyDay = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

function TimesheetForm({ store, me, month, entry, onDone }) {
  const cur = monthOf(todayISO());
  const [date, setDate] = useState(entry?.date || (month === cur ? todayISO() : `${month}-01`));
  const [start, setStart] = useState(entry?.start || "09:00");
  const [end, setEnd] = useState(entry?.end || "10:00");
  const [mode, setMode] = useState(entry?.mode || "campus");
  const [title, setTitle] = useState(entry?.title || "");
  const [note, setNote] = useState(entry?.note || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const mins = (() => { const [sh, sm] = start.split(":").map(Number); const [eh, em] = end.split(":").map(Number); return (eh * 60 + em) - (sh * 60 + sm); })();

  const save = async () => {
    setError("");
    if (!title.trim()) { setError("Add what the session was (e.g. the class name)."); return; }
    if (mins <= 0) { setError("End time must be after the start time."); return; }
    setBusy(true);
    try {
      const data = { date, start, end, mode, title: title.trim(), note: note.trim() };
      if (entry) await store.updateTimesheet(entry.id, data);
      else await store.addTimesheet(data);
      onDone();
    } catch (e) { setError(e.message || "Could not save."); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <Field label="Date">
        <input type="date" value={date} min={`${month}-01`} max={`${month}-${String(lastDayOfMonth(month)).padStart(2, "0")}`} onChange={e => setDate(e.target.value)} className={inputCls} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="From"><input type="time" value={start} onChange={e => setStart(e.target.value)} className={inputCls} /></Field>
        <Field label="To"><input type="time" value={end} onChange={e => setEnd(e.target.value)} className={inputCls} /></Field>
      </div>
      <div>
        <label className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-400">Delivery</label>
        <div className="grid grid-cols-2 gap-2">
          {[{ k: "campus", label: "On campus", I: Building2 }, { k: "online", label: "Online", I: Wifi }].map(o => {
            const on = mode === o.k; const O = o.I;
            return (
              <button key={o.k} type="button" onClick={() => setMode(o.k)} className={`flex items-center justify-center gap-2 rounded-xl border-2 py-2.5 text-sm font-bold transition ${on ? "border-transparent text-white shadow-sm" : "border-slate-200 bg-white text-slate-500"}`} style={on ? { background: o.k === "campus" ? NAVY : "#0d7a5f" } : {}}>
                <O size={16} /> {o.label}
              </button>
            );
          })}
        </div>
      </div>
      <Field label="Class / activity"><input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Unit 4 — Database Design (Group A)" className={inputCls} /></Field>
      <Field label="Note (optional)"><textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="Anything worth recording…" className={inputCls + " resize-none"} /></Field>
      <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5 text-sm"><span className="text-slate-500">Duration</span><span className="font-bold" style={{ color: mins > 0 ? NAVY : MAROON }}>{mins > 0 ? `${fmtHours(mins)} h` : "—"}</span></div>
      {error && <div className="flex items-center gap-2 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600"><AlertCircle size={15} /> {error}</div>}
      <PrimaryBtn onClick={save} disabled={busy} className="w-full">{busy ? <><Loader2 size={16} className="animate-spin" /> Saving…</> : <><Save size={16} /> {entry ? "Update session" : "Add session"}</>}</PrimaryBtn>
    </div>
  );
}

/* ----- Timesheet: month grid + day editor ----- */
// The paper timesheet the college already uses is a month calendar with "Present" and
// the hours written in each day. This is that, made editable: tap a day, pick the shift
// you worked, save. The session list underneath is unchanged — it stays the place to
// see and delete individual entries.

// The shifts that actually recur on the paper sheets, so a normal day is two taps.
const SHIFT_PRESETS = [
  { label: "10:00 – 17:00", shifts: [["10:00", "17:00"]] },
  { label: "09:00 – 17:00", shifts: [["09:00", "17:00"]] },
  { label: "18:00 – 21:00", shifts: [["18:00", "21:00"]] },
  { label: "09:00 – 15:00 + 18:00 – 21:00", shifts: [["09:00", "15:00"], ["18:00", "21:00"]] },
];

const minutesBetween = (a, b) => {
  const [sh, sm] = String(a).split(":").map(Number);
  const [eh, em] = String(b).split(":").map(Number);
  return (eh * 60 + em) - (sh * 60 + sm);
};
// "09:00" -> "9", "09:30" -> "9:30". The paper sheet writes "10 to 5", not "10:00".
const shortTime = (t) => {
  const [h, m] = String(t).split(":");
  return m === "00" ? String(Number(h)) : `${Number(h)}:${m}`;
};

function TimesheetMonthGrid({ month, byDate, onPick }) {
  const [y, m] = month.split("-").map(Number);
  const startPad = (new Date(y, m - 1, 1).getDay() + 6) % 7;   // Monday-first, like the holiday calendar
  const days = lastDayOfMonth(month);
  const today = todayISO();

  return (
    <Card className="!p-3">
      <div className="grid grid-cols-7 gap-1 text-center text-[9px] font-bold uppercase text-slate-400">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <div key={i} className="py-0.5">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: startPad }).map((_, i) => <div key={"p" + i} />)}
        {Array.from({ length: days }).map((_, i) => {
          const d = i + 1;
          const iso = `${month}-${String(d).padStart(2, "0")}`;
          const list = (byDate[iso] || []).slice().sort((a, b) => a.start.localeCompare(b.start));
          const mins = list.reduce((t, e) => t + e.minutes, 0);
          const isToday = iso === today;
          // A day holding anything already sent or approved cannot be edited here —
          // the same rule the per-entry buttons follow.
          const locked = list.some(e => e.status !== "draft" && e.status !== "changes_requested");
          const label = list.length
            ? `${fmtDate(iso)} — ${list.map(e => `${e.start}–${e.end}`).join(", ")}`
            : `${fmtDate(iso)} — nothing logged`;
          return (
            <button key={d} type="button" onClick={() => onPick(iso)} title={label} aria-label={label}
              className={`press min-h-[62px] rounded-lg border p-1 text-left transition ${
                list.length ? "border-transparent" : isToday ? "border-blue-300 bg-blue-50/50" : "border-slate-100 hover:border-blue-200 hover:bg-blue-50/30"}`}
              style={list.length ? { background: locked ? "#f1f5f9" : "#eef2ff" } : {}}>
              <span className={`block text-[10px] font-bold ${isToday ? "text-blue-700" : "text-slate-400"}`}>{d}</span>
              {list.length > 0 && (
                <>
                  <span className={`block text-[8px] font-bold uppercase ${locked ? "text-slate-500" : "text-indigo-600"}`}>Present</span>
                  {list.slice(0, 2).map(e => (
                    <span key={e.id} className="block truncate text-[8px] font-semibold leading-tight text-slate-500">{shortTime(e.start)}–{shortTime(e.end)}</span>
                  ))}
                  {list.length > 2 && <span className="block text-[8px] text-slate-400">+{list.length - 2}</span>}
                  <span className="block text-[8px] font-bold text-slate-400">{fmtHours(mins)}h</span>
                </>
              )}
            </button>
          );
        })}
      </div>
      <p className="mt-2 px-0.5 text-[10px] text-slate-400">Tap any day to record the hours you worked.</p>
    </Card>
  );
}

function TimesheetDayModal({ store, date, entries, onClose, onSaved }) {
  // Only entries the staff still holds can be changed; anything sent or approved is
  // shown but left alone, so saving a day can never rewrite an approved record.
  const editable = entries.filter(e => e.status === "draft" || e.status === "changes_requested");
  const frozen = entries.filter(e => e.status !== "draft" && e.status !== "changes_requested");

  const [shifts, setShifts] = useState(() =>
    editable.length
      ? editable.slice().sort((a, b) => a.start.localeCompare(b.start)).map(e => ({ start: e.start, end: e.end, title: e.title, mode: e.mode, note: e.note || "" }))
      : []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const setShift = (i, patch) => setShifts(list => list.map((sh, k) => (k === i ? { ...sh, ...patch } : sh)));
  const addShift = () => setShifts(list => [...list, { start: list.length ? "18:00" : "09:00", end: list.length ? "21:00" : "17:00", title: "", mode: "campus", note: "" }]);
  const removeShift = (i) => setShifts(list => list.filter((_, k) => k !== i));
  const applyPreset = (pre) => setShifts(pre.shifts.map(([a, b]) => ({ start: a, end: b, title: "", mode: "campus", note: "" })));

  const total = shifts.reduce((t, sh) => t + Math.max(0, minutesBetween(sh.start, sh.end)), 0);
  const bad = shifts.find(sh => minutesBetween(sh.start, sh.end) <= 0);

  const sig = (rows) => rows.map(r => `${r.start}-${r.end}`).sort().join("|");
  const unchanged = sig(shifts) === sig(editable);

  const save = async () => {
    if (bad) { setErr("Each shift must end after it starts."); return; }
    if (unchanged) { onClose(); return; }
    setBusy(true); setErr("");
    try {
      // Replace the day wholesale: the shifts on screen ARE the day. Simpler than
      // matching rows up, and every entry involved is still a draft.
      for (const e of editable) await store.removeTimesheet(e.id);
      for (const sh of shifts) {
        await store.addTimesheet({
          date, start: sh.start, end: sh.end, mode: sh.mode || "campus",
          // The paper sheet records presence, not what was taught. Keep whatever a
          // previous entry said; otherwise a plain default, so nothing must be typed.
          title: (sh.title || "").trim() || "Teaching",
          note: sh.note || "",
        });
      }
      onSaved();
    } catch (e) { setErr(e.message || "Could not save this day."); }
    finally { setBusy(false); }
  };

  return (
    <Modal open onClose={() => !busy && onClose()} title={prettyDay(date)}>
      <div className="space-y-3">
        {frozen.length > 0 && (
          <div className="rounded-xl bg-slate-50 px-3 py-2 text-[11px] text-slate-500 ring-1 ring-slate-200">
            {frozen.length} {frozen.length === 1 ? "entry has" : "entries have"} already been sent and can't be changed here:
            {" "}{frozen.map(e => `${e.start}–${e.end}`).join(", ")}.
          </div>
        )}

        {/* The presets are the point — a normal day is one tap here and Save. They show
            straight away rather than behind a "Present" toggle, because opening a blank
            day already says the day is blank. */}
        <div>
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400">Common shifts</p>
          <div className="grid grid-cols-2 gap-1.5">
            {SHIFT_PRESETS.map(pre => {
              const on = sig(pre.shifts.map(([a, b]) => ({ start: a, end: b }))) === sig(shifts);
              return (
                <button key={pre.label} type="button" onClick={() => applyPreset(pre)}
                  className={`press rounded-xl px-2 py-2.5 text-[11px] font-bold ring-1 transition ${on ? "text-white ring-transparent" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50"}`}
                  style={on ? { background: NAVY } : {}}>
                  {pre.label}
                </button>
              );
            })}
          </div>
        </div>

        {shifts.length > 0 && (
          <>
            <div className="space-y-2">
              {shifts.map((sh, i) => (
                <div key={i} className="rounded-xl bg-slate-50 p-2.5 ring-1 ring-slate-200">
                  <div className="flex items-center gap-2">
                    <input type="time" value={sh.start} onChange={e => setShift(i, { start: e.target.value })} className={inputCls + " !py-2"} />
                    <span className="shrink-0 text-xs font-bold text-slate-400">to</span>
                    <input type="time" value={sh.end} onChange={e => setShift(i, { end: e.target.value })} className={inputCls + " !py-2"} />
                    <button type="button" onClick={() => removeShift(i)} aria-label="Remove this shift"
                      className="press flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-rose-400 hover:bg-rose-50 hover:text-rose-600">
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <p className={`mt-1 text-[10px] font-semibold ${minutesBetween(sh.start, sh.end) <= 0 ? "text-rose-500" : "text-slate-400"}`}>
                    {minutesBetween(sh.start, sh.end) <= 0 ? "The end time must be after the start." : `${fmtHours(minutesBetween(sh.start, sh.end))}h`}
                  </p>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-slate-200">
              <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Total</span>
              <span className="text-sm font-extrabold" style={{ color: NAVY }}>{fmtHours(total)}h</span>
            </div>
          </>
        )}

        <div className="grid grid-cols-2 gap-2">
          {shifts.length < 4 && (
            <button type="button" onClick={addShift}
              className="press flex items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-slate-300 py-2.5 text-xs font-bold text-slate-500 hover:border-slate-400">
              <Plus size={14} /> {shifts.length ? "Add another shift" : "Custom times"}
            </button>
          )}
          {shifts.length > 0 && (
            <button type="button" onClick={() => setShifts([])}
              className="press rounded-xl border-2 border-slate-200 py-2.5 text-xs font-bold text-slate-500 transition hover:bg-slate-50">
              Not working
            </button>
          )}
        </div>

        {shifts.length === 0 && editable.length > 0 && (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200">
            Saving will remove the {editable.length} {editable.length === 1 ? "entry" : "entries"} logged on this day.
          </p>
        )}
        {err && <p className="rounded-lg bg-rose-50 px-3 py-2 text-[11px] font-semibold text-rose-600">{err}</p>}

        <PrimaryBtn onClick={save} disabled={busy || !!bad} className="w-full">
          {busy ? <><Loader size={16} /> Saving…</> : <><Save size={16} /> Save day</>}
        </PrimaryBtn>
      </div>
    </Modal>
  );
}

function TimesheetScreen({ store, me }) {
  const [month, setMonth] = useState(() => monthOf(todayISO()));
  const [entries, setEntries] = useState(null); // null = loading
  const [reloadKey, setReloadKey] = useState(0);
  const [modal, setModal] = useState(null);      // {} = add, { entry } = edit, null = closed
  const [confirmSend, setConfirmSend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dayOpen, setDayOpen] = useState(null);   // ISO date whose editor is open

  // Blank to the loading state ONLY when the month changes (a deliberate switch),
  // never on a background refresh.
  useEffect(() => { setEntries(null); }, [month]);
  // Fetch on month change / after a write / on a gentle 20s background poll — but
  // always swap the rows IN PLACE (keep the old list until the new one arrives), so
  // nothing flickers to zero. `store` is deliberately NOT a dependency: it's a fresh
  // object every render, and depending on it refetched (and blanked) the list on
  // every re-render — that was the "loads every second, drops to 0" bug.
  useEffect(() => {
    let cancelled = false;
    const fetchNow = () => store.listTimesheets({ month })
      .then(d => { if (!cancelled) setEntries(d); })
      .catch(() => { if (!cancelled) setEntries(prev => prev || []); });
    fetchNow();
    const id = setInterval(() => { if (typeof document === "undefined" || document.visibilityState === "visible") fetchNow(); }, 20000);
    return () => { cancelled = true; clearInterval(id); };
  }, [month, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const reload = () => setReloadKey(k => k + 1);

  const shiftMonth = (delta) => setMonth(shiftMonthStr(month, delta));

  const list = entries || [];
  const totalMin = list.reduce((s, e) => s + e.minutes, 0);
  const campusMin = list.filter(e => e.mode === "campus").reduce((s, e) => s + e.minutes, 0);
  const onlineMin = list.filter(e => e.mode === "online").reduce((s, e) => s + e.minutes, 0);
  // Entries the staff still holds and can send: fresh drafts + any bounced back.
  const sendable = list.filter(e => e.status === "draft" || e.status === "changes_requested");
  const hasApproved = list.some(e => e.status === "approved");
  const hasSubmitted = list.some(e => e.status === "submitted");
  const changesEntry = list.find(e => e.status === "changes_requested");
  // The month's headline status, most-actionable first.
  const monthStatus = changesEntry ? "changes"
    : hasSubmitted ? "submitted"
    : (hasApproved && sendable.length === 0) ? "approved"
    : sendable.length > 0 ? "draft" : "none";

  const byDate = {};
  for (const e of list) (byDate[e.date] = byDate[e.date] || []).push(e);
  const days = Object.keys(byDate).sort((a, b) => b.localeCompare(a));

  const del = async (id) => {
    const e = list.find(x => x.id === id);
    // e.start / e.end — the serializer renames startTime/endTime, so the DB names
    // read undefined and the confirmation said "undefined–undefined", giving no way
    // to tell WHICH of the day's sessions was about to be irreversibly deleted.
    if (!window.confirm(`Delete this timesheet entry?${e ? `\n\n${fmtDate(e.date)} · ${e.start}–${e.end} · ${e.title}` : ""}\n\nThis cannot be undone.`)) return;
    try { await store.removeTimesheet(id); reload(); } catch (_) {}
  };
  const send = async () => { setBusy(true); try { await store.submitTimesheet(month); setConfirmSend(false); reload(); } catch (_) {} finally { setBusy(false); } };

  return (
    <Screen>
      {/* Month selector */}
      <div className="mb-3 flex items-center justify-between rounded-2xl bg-white px-2 py-2 shadow-sm ring-1 ring-slate-100">
        <button onClick={() => shiftMonth(-1)} className="press flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100"><ChevronLeft size={18} /></button>
        <p className="text-sm font-extrabold text-slate-700">{monthLabel(month)}</p>
        <button onClick={() => shiftMonth(1)} className="press flex h-9 w-9 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100"><ChevronRight size={18} /></button>
      </div>

      {/* Summary */}
      <div className="animated-gradient relative mb-3 overflow-hidden rounded-2xl p-4 text-white shadow-md" style={{ background: `linear-gradient(135deg, ${NAVY} 0%, ${NAVY_DARK} 60%, ${MAROON} 150%)`, backgroundSize: "200% 200%" }}>
        <ClipboardList size={64} className="float-slow absolute -right-3 -top-3 text-white/10" />
        <p className="relative text-[11px] font-semibold uppercase tracking-wide text-white/60">Hours this month</p>
        <p className="relative text-3xl font-extrabold">{fmtHours(totalMin)}<span className="text-lg font-bold text-white/70"> h</span></p>
        <div className="relative mt-3 flex gap-2">
          <span className="flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-semibold ring-1 ring-white/15"><Building2 size={12} /> Campus {fmtHours(campusMin)}h</span>
          <span className="flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-semibold ring-1 ring-white/15"><Wifi size={12} /> Online {fmtHours(onlineMin)}h</span>
          <span className="ml-auto flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-semibold ring-1 ring-white/15">{list.length} session{list.length === 1 ? "" : "s"}</span>
        </div>
        {monthStatus === "submitted" && <span className="relative mt-3 inline-flex items-center gap-1.5 rounded-full bg-white/90 px-2.5 py-1 text-[11px] font-bold text-slate-700"><Clock size={12} /> Awaiting approval</span>}
        {monthStatus === "approved" && <span className="relative mt-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-400/90 px-2.5 py-1 text-[11px] font-bold text-emerald-950"><CheckCircle2 size={12} /> Approved{list.find(e => e.status === "approved")?.reviewedBy ? ` by ${list.find(e => e.status === "approved").reviewedBy}` : ""}</span>}
        {monthStatus === "changes" && <span className="relative mt-3 inline-flex items-center gap-1.5 rounded-full bg-amber-400/95 px-2.5 py-1 text-[11px] font-bold text-amber-950"><AlertCircle size={12} /> Changes requested</span>}
      </div>

      {/* Finance feedback when the month was bounced back — shown prominently so the
          staff member knows exactly what to fix before re-sending. */}
      {monthStatus === "changes" && changesEntry?.reviewNote && (
        <div className="mb-3 rounded-2xl bg-amber-50 p-3.5 ring-1 ring-amber-200">
          <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-amber-700"><MessageSquare size={13} /> Note from the office{changesEntry.reviewedBy ? ` · ${changesEntry.reviewedBy}` : ""}</p>
          <p className="mt-1 text-sm font-medium text-amber-900">{changesEntry.reviewNote}</p>
          <p className="mt-1.5 text-[11px] text-amber-600">Fix the entries below, then send your timesheet again.</p>
        </div>
      )}

      {/* The month at a glance, matching the paper sheet, and the quickest way in. */}
      <div className="mb-3">
        <TimesheetMonthGrid month={month} byDate={byDate} onPick={setDayOpen} />
      </div>

      <button onClick={() => setModal({})} className="press shine mb-3 flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 bg-white py-3 text-sm font-bold text-slate-600 transition hover:border-slate-400 hover:text-slate-800"><Plus size={16} /> Add a session</button>

      {/* Entries grouped by day */}
      {entries === null ? (
        <div className="flex flex-col items-center gap-2 py-12 text-slate-400"><Loader2 size={22} className="animate-spin" /><p className="text-xs font-semibold">Loading your timesheet…</p></div>
      ) : days.length === 0 ? (
        <Card className="text-center"><ClipboardList size={30} className="mx-auto mb-2 text-slate-300" /><p className="text-sm font-semibold text-slate-500">No sessions logged for {monthLabel(month)}.</p><p className="mt-0.5 text-xs text-slate-400">Tap “Add a session” to record the classes you taught.</p></Card>
      ) : (
        days.map(day => {
          const dayEntries = byDate[day].sort((a, b) => a.start.localeCompare(b.start));
          const dayMin = dayEntries.reduce((s, e) => s + e.minutes, 0);
          return (
            <div key={day} className="mb-3">
              <div className="mb-1.5 flex items-center justify-between px-1"><p className="text-xs font-bold text-slate-500">{prettyDay(day)}</p><p className="text-[11px] font-bold text-slate-400">{fmtHours(dayMin)}h</p></div>
              <Card className="!p-0">
                {dayEntries.map((e, i) => (
                  <div key={e.id} className={`flex items-center gap-3 px-3.5 py-3 ${i < dayEntries.length - 1 ? "border-b border-slate-100" : ""}`}>
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white" style={{ background: e.mode === "campus" ? NAVY : "#0d7a5f" }}>{e.mode === "campus" ? <Building2 size={17} /> : <Wifi size={17} />}</div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-slate-700">{e.title}</p>
                      <p className="text-[11px] text-slate-400">{e.start}–{e.end} · {fmtHours(e.minutes)}h · {e.mode === "campus" ? "On campus" : "Online"}</p>
                    </div>
                    {(e.status === "draft" || e.status === "changes_requested") ? (
                      <div className="flex shrink-0 gap-1">
                        <button onClick={() => setModal({ entry: e })} className="press flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"><Edit3 size={15} /></button>
                        <button onClick={() => del(e.id)} className="press flex h-8 w-8 items-center justify-center rounded-lg text-rose-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 size={15} /></button>
                      </div>
                    ) : e.status === "approved" ? (
                      <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-bold text-emerald-600 ring-1 ring-emerald-200">Approved</span>
                    ) : (
                      <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-500 ring-1 ring-slate-200">Sent</span>
                    )}
                  </div>
                ))}
              </Card>
            </div>
          );
        })
      )}

      {/* Send / re-send */}
      {sendable.length > 0 && (
        <button onClick={() => setConfirmSend(true)} className="press shine mt-2 flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-bold text-white shadow-lg" style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}>
          <Send size={17} /> {monthStatus === "changes" ? "Re-send" : "Send"} timesheet — {sendable.length} session{sendable.length === 1 ? "" : "s"}, {fmtHours(sendable.reduce((s, e) => s + e.minutes, 0))}h
        </button>
      )}

      {dayOpen && (
        <TimesheetDayModal store={store} date={dayOpen} entries={byDate[dayOpen] || []}
          onClose={() => setDayOpen(null)} onSaved={() => { setDayOpen(null); reload(); }} />
      )}

      <Modal open={!!modal} onClose={() => setModal(null)} title={modal?.entry ? "Edit session" : "Add session"}>
        {modal && <TimesheetForm store={store} me={me} month={month} entry={modal.entry} onDone={() => { setModal(null); reload(); }} />}
      </Modal>

      <Modal open={confirmSend} onClose={() => setConfirmSend(false)} title="Send this timesheet?">
        <div className="space-y-3">
          <p className="text-sm text-slate-600">You're about to send your <b>{monthLabel(month)}</b> timesheet — <b>{sendable.length}</b> session{sendable.length === 1 ? "" : "s"}, <b>{fmtHours(sendable.reduce((s, e) => s + e.minutes, 0))} hours</b> — to the finance team for approval.</p>
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700 ring-1 ring-amber-200">Once sent, these entries are locked until the finance team approves them or asks for changes.</p>
          <div className="flex gap-2">
            <button onClick={() => setConfirmSend(false)} className="flex-1 rounded-xl border-2 border-slate-200 py-2.5 text-sm font-bold text-slate-600">Not yet</button>
            <PrimaryBtn onClick={send} disabled={busy} className="flex-1">{busy ? <><Loader2 size={16} className="animate-spin" /> Sending…</> : <><Send size={16} /> Send now</>}</PrimaryBtn>
          </div>
        </div>
      </Modal>
    </Screen>
  );
}

/* ----- More ----- */
function MoreScreen({ store, me, logout, onChangePassword, onSwitchToAdmin }) {
  const [toggles, setToggles] = useState({ notif: true, reminders: true, biometric: false });
  const [showDelete, setShowDelete] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const items = [{ I: Users, label: "My Profile" }, { I: MapPin, label: "Campus Map" }, { I: Coffee, label: "Staff Room Booking" }, { I: Mail, label: "Contact HR" }];
  // Read-only profile stats, all safe.
  const myLeaveCount = store.leave.filter(l => l.staffId === me.id).length;
  const myCheckins = store.checkins.filter(c => c.staffId === me.id && c.in).length;
  const left = store.remaining(me.id);
  return (
    <Screen>
      <Card className="mb-3 overflow-hidden !p-0">
        <div className="flex items-center gap-3 p-4" style={{ background: "linear-gradient(135deg, rgba(26,58,143,.07), rgba(158,27,50,.05))" }}>
          <span className="float flex h-14 w-14 items-center justify-center rounded-2xl text-lg font-bold text-white shadow-lg ring-2 ring-white" style={{ background: me.colour }}>{me.initials}</span>
          <div className="min-w-0 flex-1"><p className="truncate font-bold text-slate-800">{me.name}</p><p className="truncate text-xs text-slate-500">{me.role} · {me.dept}</p><p className="truncate text-xs text-slate-400">{me.email}</p></div>
          {store.isAdmin && <span className="flex items-center gap-1 rounded-full bg-white px-2 py-1 text-[10px] font-bold shadow-sm ring-1 ring-slate-200" style={{ color: MAROON }}><ShieldCheck size={12} /> Admin</span>}
        </div>
        <div className="grid grid-cols-3 divide-x divide-slate-100 border-t border-slate-100 text-center">
          <div className="py-2.5"><p className="text-base font-extrabold" style={{ color: NAVY }}>{left}d</p><p className="text-[10px] text-slate-400">Holiday left</p></div>
          <div className="py-2.5"><p className="text-base font-extrabold text-slate-700">{myLeaveCount}</p><p className="text-[10px] text-slate-400">Leave records</p></div>
          <div className="py-2.5"><p className="text-base font-extrabold text-emerald-600">{myCheckins}</p><p className="text-[10px] text-slate-400">Check-ins</p></div>
        </div>
      </Card>
      <p className="mb-2 px-1 text-xs font-bold uppercase tracking-wide text-slate-400">Preferences</p>
      <Card className="!p-0 mb-3">
        {[["notif", "Push notifications"], ["reminders", "Check-in reminders"]].map(([k, label], i) => (
          <div key={k} className="flex items-center justify-between border-b border-slate-100 px-4 py-3.5">
            <span className="text-sm font-semibold text-slate-700">{label}</span>
            <button onClick={() => setToggles(t => ({ ...t, [k]: !t[k] }))} className={`relative h-6 w-11 rounded-full transition ${toggles[k] ? "" : "bg-slate-200"}`} style={toggles[k] ? { background: NAVY } : {}}>
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${toggles[k] ? "left-[22px]" : "left-0.5"}`} />
            </button>
          </div>
        ))}
        {/* A real setting, unlike the two above: it drives the app lock. Always
            renders something — the options, or why they aren't available. */}
        <BiometricSetting owner={me.email} />
      </Card>
      <Card className="!p-0">
        {items.map((it, i) => <button key={it.label} onClick={() => store.notify(`Opening ${it.label}…`)} className={`group flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-slate-50 active:scale-[0.99] ${i < items.length - 1 ? "border-b border-slate-100" : ""}`}><it.I size={18} className="transition-transform group-hover:scale-110" style={{ color: NAVY }} /><span className="flex-1 text-sm font-semibold text-slate-700">{it.label}</span><ChevronRight size={16} className="text-slate-300 transition-transform group-hover:translate-x-1 group-hover:text-slate-400" /></button>)}
      </Card>
      <p className="mb-2 mt-4 px-1 text-xs font-bold uppercase tracking-wide text-slate-400">App info</p>
      <div className="animated-gradient relative overflow-hidden rounded-2xl p-4 text-white shadow-md fade-up" style={{ background: `linear-gradient(135deg, ${NAVY} 0%, ${NAVY_DARK} 50%, ${MAROON} 140%)`, backgroundSize: "200% 200%" }}>
        <Building2 size={56} className="float-slow absolute -right-2 -top-2 text-white/10" />
        <div className="relative mb-2 flex h-9 w-12 items-center justify-center rounded-md bg-white"><Logo small /></div>
        <p className="relative text-sm font-bold">EdTech</p>
        <p className="relative mt-0.5 flex items-center gap-1.5 text-[11px] text-white/70"><MapPin size={11} /> 42 The Burroughs, London NW4 4AP</p>
        <p className="relative flex items-center gap-1.5 text-[11px] text-white/70"><Phone size={11} /> 020 8202 2007</p>
        <p className="relative mt-2 text-[10px] text-white/50">Staff Hub · v2.0</p>
      </div>
      {/* Account deletion. Both app stores require this to be reachable from
          inside the app, not only by emailing an administrator. */}
      <p className="mb-2 mt-5 px-1 text-xs font-bold uppercase tracking-wide text-slate-400">Account</p>
      <Card className="!p-0">
        {/* Change password — moved here from the top bar so the mobile app has a
            clean header. Triggers the shared change-password modal in the shell. */}
        {onChangePassword && (
          <button onClick={onChangePassword} className="group flex w-full items-center gap-3 border-b border-slate-100 px-4 py-3.5 text-left transition-colors hover:bg-slate-50 active:scale-[0.99]">
            <KeyRound size={18} className="transition-transform group-hover:scale-110" style={{ color: NAVY }} />
            <span className="flex-1 text-sm font-semibold text-slate-700">Change password</span>
            <ChevronRight size={16} className="text-slate-300 transition-transform group-hover:translate-x-1" />
          </button>
        )}
        {/* Admins reach their dashboard from here since the top view-toggle is gone. */}
        {onSwitchToAdmin && (
          <button onClick={onSwitchToAdmin} className="group flex w-full items-center gap-3 border-b border-slate-100 px-4 py-3.5 text-left transition-colors hover:bg-slate-50 active:scale-[0.99]">
            <Monitor size={18} className="transition-transform group-hover:scale-110" style={{ color: NAVY }} />
            <span className="flex-1 text-sm font-semibold text-slate-700">Switch to Admin Dashboard</span>
            <ChevronRight size={16} className="text-slate-300 transition-transform group-hover:translate-x-1" />
          </button>
        )}
        <button
          onClick={() => setShowDelete(true)}
          className="group flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-rose-50/60 active:scale-[0.99]"
        >
          <Trash2 size={18} className="transition-transform group-hover:scale-110" style={{ color: MAROON }} />
          <span className="flex-1">
            <span className="block text-sm font-semibold" style={{ color: MAROON }}>Delete my account</span>
            <span className="block text-[11px] text-slate-400">Permanently remove your account and personal data</span>
          </span>
          <ChevronRight size={16} className="text-slate-300 transition-transform group-hover:translate-x-1" />
        </button>
      </Card>

      {/* Sign out — moved here from the top bar; full-width and clearly separated. */}
      {logout && (
        <button onClick={() => setConfirmOut(true)} className="press mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-slate-200 bg-white py-3 text-sm font-bold text-slate-600 transition hover:border-slate-300 hover:text-slate-800">
          <LogOut size={16} /> Sign out
        </button>
      )}
      <ConfirmDialog open={confirmOut} title="Sign out?" message="You'll need to sign in again to get back in." confirmLabel="Sign out" cancelLabel="Stay" danger onConfirm={logout} onCancel={() => setConfirmOut(false)} />

      <p className="mt-4 text-center text-[11px] text-slate-400">EdTech · Staff Hub</p>
      <p className="text-center text-[11px] text-slate-400">© {new Date().getFullYear()} Syed Muhammad Raza</p>

      <Modal open={showDelete} onClose={() => setShowDelete(false)} title="Delete my account">
        <DeleteAccount user={me} onCancel={() => setShowDelete(false)} />
      </Modal>
    </Screen>
  );
}

/* ============================================================ ADMIN DASHBOARD ============================================================ */
// The assignable admin pages, in nav order. "access" is intentionally excluded —
// it is Super-Admin-only and never granted. Keep in sync with server validate.js.
const ADMIN_PAGES = ["executive", "overview", "kpi", "checkin", "balances", "calendar", "requests", "documents", "approvals", "signups", "summaries", "registers", "students", "attendance-emails", "assessments", "pat", "staffreviews", "studentreviews", "studentqueries", "staff", "timesheets", "timetable", "admissions", "ism", "slc", "passwords", "settings"];
const PAGE_LABELS = { executive: "Executive Dashboard", overview: "Overview", kpi: "KPIs", checkin: "Check-In", balances: "Holiday Balances", calendar: "Holiday Calendar", requests: "Leave Requests", documents: "Documents", approvals: "Approvals", signups: "Sign-Up Requests", summaries: "Daily Summaries", registers: "Registers — HND", students: "Students", "attendance-emails": "Attendance Emails", assessments: "Assessments", pat: "PAT", staffreviews: "Staff Reviews", studentreviews: "Student Reviews", studentqueries: "Student Queries", staff: "Staff", timesheets: "Timesheets", timetable: "Timetable", admissions: "Admissions", ism: "ISM (Interviews)", slc: "SLC — Student Loans", passwords: "Reset Passwords", settings: "Settings" };

// Can this user see/use a given admin page? The Super Admin gets everything,
// including the Super-Admin-only Access tab. A page-scoped admin gets only their
// granted pages (null adminPages = unrestricted, so existing admins keep full
// access). Anyone who isn't an admin gets nothing.
const canAccessPage = (user, key) => {
  if (!user) return false;
  // No student holds any admin page — stated first, mirroring the server's hasPage,
  // so the isSuperAdmin short-circuit below can never be reached with a student.
  if (user.kind === "student" || user.isStudent) return false;
  if (key === "access") return !!user.isSuperAdmin;   // never assignable to others
  if (user.isSuperAdmin) return true;
  if (user.accountRole !== "ADMIN") return false;
  const pages = user.adminPages;
  return pages == null || (Array.isArray(pages) && pages.includes(key));
};

/* ============================ Dashboard shared bits ============================ */
const fmtMonth = (ym) => { const [y, m] = String(ym || "").split("-"); if (!y || !m) return ym; return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" }); };
// Colour for a percentage, taken from the same rating bands used everywhere else
// (see riskBand) so one figure never gets two different colours on one screen.
const pctColour = (v) => riskBand(v).colour;
const kNum = (n) => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "")}K` : String(n);

function FilterSelect({ label, value, onChange, options }) {
  return (
    <label className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-xs ring-1 ring-slate-200">
      <span className="font-semibold text-slate-400">{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)} className="max-w-[180px] bg-transparent text-sm font-medium text-slate-700 outline-none">
        {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </label>
  );
}
// ---- Chart chrome -----------------------------------------------------------
// Shared so every chart in the console reads as one system rather than as whatever
// Recharts does by default.

// Course names are the qualification title in full — "Pearson BTEC Level 5 Higher
// National Diploma in Business (October 2025)". On a category axis that wraps to
// three lines of 9px text and becomes unreadable, so strip the boilerplate every
// course shares and keep what actually tells them apart: the subject and the intake.
function shortCourse(name) {
  let s = String(name || "")
    .replace(/^pearson\s+/i, "")
    .replace(/btec\s+level\s+\d+\s+/i, "")
    .replace(/higher\s+national\s+diploma\s+in\s+/i, "")
    .replace(/^hnd\s+/i, "")
    .trim();
  const intake = s.match(/\(([^)]+)\)/);
  s = s.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/ and /gi, " & ").replace(/Management/gi, "Mgmt");
  if (intake) {
    const m = intake[1].match(/([A-Za-z]+)\s*(\d{4})/);
    s += m ? ` · ${m[1].slice(0, 3)} ${m[2]}` : ` · ${intake[1]}`;
  }
  return s || String(name || "");
}

// Recharts' default tooltip is an unstyled bordered box. This matches the cards.
function ChartTip({ active, payload, label, unit = "%", name }) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="rounded-xl bg-white/95 px-3 py-2 text-xs shadow-lg ring-1 ring-slate-200 backdrop-blur">
      <p className="font-bold text-slate-700">{p.payload?.full || label}</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-slate-500">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: p.color || p.fill }} />
        {name || p.name} <b className="text-slate-800">{p.value}{unit}</b>
      </p>
    </div>
  );
}

// Solid hairlines, one shade off the surface. Dashed gridlines read as a threshold
// or a projection when they are only a grid.
const GRID = "#eef1f6";
const AXIS_TICK = { fontSize: 11, fill: "#94a3b8" };

// "7 Aug, 11:15" — date AND time, because several marks can arrive in one sync and a
// marker needs to tell this morning's import from one entered weeks ago. Falls back to
// Moodle's own grading date when the row has never been touched here.
// Who teaches a unit and when its work is due — the two facts people were opening the
// unit to find. Renders nothing when neither is set, so an unassigned unit stays clean.
function UnitFacts({ unit, className = "" }) {
  const tutor = unit?.tutorName || unit?.tutor || "";
  const due = unit?.submissionDate;
  if (!tutor && !due) return null;
  return (
    <p className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 ${className}`}>
      {tutor && <span className="inline-flex items-center gap-1"><UserCheck size={11} className="text-slate-400" /> {tutor}</span>}
      {due && <span className="inline-flex items-center gap-1"><CalendarClock size={11} className="text-slate-400" /> Due {fmtDate(due)}</span>}
    </p>
  );
}

function markStamp(gradedAt, gradedOn) {
  const raw = gradedAt || gradedOn;
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d)) return null;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString("en-GB", {
    day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }),
    hour: "2-digit", minute: "2-digit",
  }).replace(",", "");
}

function ChartCard({ title, children, className = "", accent = NAVY }) {
  return (
    <div className={`group relative overflow-hidden rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/70 transition-shadow duration-300 hover:shadow-md fade-up ${className}`}>
      {title && (
        <div className="mb-3 flex items-center gap-2">
          {/* A short bar of the chart's own colour, so the title and the marks below
              it are visibly the same thing. */}
          <span className="h-4 w-1 rounded-full" style={{ background: accent }} />
          <p className="text-sm font-bold text-slate-700">{title}</p>
        </div>
      )}
      {children}
    </div>
  );
}
// The three figures a principal actually opens this page for, on the brand gradient
// so the eye lands on them before the grid of eight tiles below. Same treatment as the
// mobile app's home card, so the two halves of the product look like one product.
function ExecHero({ attPct, passRate, students, courses, marks }) {
  const Stat = ({ label, value, sub }) => (
    <div className="min-w-0 flex-1">
      <p className="text-[11px] font-bold uppercase tracking-widest text-white/60">{label}</p>
      <p className="mt-0.5 text-3xl font-extrabold leading-none tracking-tight text-white sm:text-4xl">{value}</p>
      {sub && <p className="mt-1 text-[11px] text-white/60">{sub}</p>}
    </div>
  );
  return (
    <div className="animated-gradient relative mb-4 overflow-hidden rounded-2xl p-5 shadow-md fade-up"
      style={{ background: `linear-gradient(135deg, ${NAVY} 0%, ${NAVY_DARK} 55%, ${MAROON} 140%)`, backgroundSize: "200% 200%" }}>
      <GraduationCap size={150} className="pointer-events-none absolute -right-6 -top-8 text-white/[0.06]" />
      <div className="relative flex flex-wrap items-end gap-6">
        <Stat label="Attendance" value={attPct == null ? "—" : `${attPct}%`} sub={marks == null ? undefined : `${kNum(marks)} marks recorded`} />
        <span className="hidden h-12 w-px bg-white/15 sm:block" />
        <Stat label="Student pass rate" value={passRate == null ? "—" : `${passRate}%`} />
        <span className="hidden h-12 w-px bg-white/15 sm:block" />
        <Stat label="Students" value={students ?? "—"} sub={courses ? `across ${courses} course${courses === 1 ? "" : "s"}` : undefined} />
      </div>
    </div>
  );
}

function ExecKpi({ label, value, tone = NAVY, sub, Icon }) {
  return (
    <div className="group relative overflow-hidden rounded-2xl p-4 shadow-sm ring-1 ring-slate-200/70 transition-all duration-300 hover:-translate-y-1 hover:shadow-lg hover:ring-transparent fade-up"
      style={{ background: `linear-gradient(150deg, #ffffff 0%, #ffffff 55%, ${tone}0f 100%)` }}>
      {/* A wash of the tile's own colour in the corner, and a watermark of its icon.
          Enough colour to make a row of tiles scannable at a glance without turning
          the number into decoration. */}
      <span className="pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full opacity-[0.07] transition-transform duration-500 group-hover:scale-125" style={{ background: tone }} />
      {Icon && <Icon size={72} className="pointer-events-none absolute -bottom-3 -right-2 opacity-[0.05] transition-transform duration-500 group-hover:rotate-6" style={{ color: tone }} />}
      <span className="absolute inset-x-0 top-0 h-1" style={{ background: `linear-gradient(90deg, ${tone}, ${tone}55)` }} />

      <div className="relative flex items-start justify-between gap-2">
        <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
        {Icon && (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-white shadow-sm transition-transform duration-300 group-hover:scale-110"
            style={{ background: `linear-gradient(135deg, ${tone}, ${tone}bb)` }}>
            <Icon size={15} />
          </span>
        )}
      </div>
      <p className="relative mt-1.5 text-[32px] font-extrabold leading-none tracking-tight" style={{ color: tone }}>{value}</p>
      {sub && <p className="relative mt-1.5 text-[11px] font-medium text-slate-400">{sub}</p>}
    </div>
  );
}
function MiniKpi({ label, value, tone = NAVY }) {
  return (
    <div className="rounded-xl bg-white p-2.5 text-center shadow-sm ring-1 ring-slate-200/70">
      <p className="text-lg font-extrabold tabular-nums" style={{ color: tone }}>{value}</p>
      <p className="text-[10px] font-medium text-slate-400">{label}</p>
    </div>
  );
}
// Distinct segment colours for the donut charts.
const DONUT_COLOURS = ["#1a3a8f", "#9e1b32", "#0d7a5f", "#d97706", "#6d28d9", "#0891b2", "#be123c", "#4d7c0f", "#7c3aed", "#0369a1", "#b45309", "#0f766e"];
// Attendance rating bands: <40 High Risk, 40–50 Monitor, 50–70 Good,
// 70–90 Excellent, 90+ Perfect. Upper bound is exclusive (70 → Excellent).
const riskBand = (pct) => pct == null ? { label: "No data", colour: "#94a3b8", bg: "#f1f5f9" }
  : pct < 40 ? { label: "High Risk", colour: "#dc2626", bg: "#fef2f2" }
  : pct < 50 ? { label: "Monitor", colour: "#ea580c", bg: "#fff7ed" }
  : pct < 70 ? { label: "Good", colour: "#ca8a04", bg: "#fefce8" }
  : pct < 90 ? { label: "Excellent", colour: "#16a34a", bg: "#f0fdf4" }
  : { label: "Perfect", colour: "#6d28d9", bg: "#f5f3ff" };

/* ----- Executive Dashboard (admin) ----- */
function ExecutiveDashboard({ store }) {
  const { refreshHnd, refreshAssessments } = store;
  useEffect(() => { refreshHnd(); refreshAssessments(); }, [refreshHnd, refreshAssessments]);
  const [exec, setExec] = useState(null);
  const [monthly, setMonthly] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshed, setRefreshed] = useState(null);
  const [year, setYear] = useState("all");
  const [course, setCourse] = useState("all");
  const [unit, setUnit] = useState("all");
  // Curriculum stage — which year and term of the course. "all" = the whole course.
  const [stage, setStage] = useState("all");   // "all" | "1-2" (year-term)

  const [err, setErr] = useState("");
  // exec-summary loads once; monthly attendance re-scopes to the Course/Unit filters.
  // Only the NEWEST request may write state. Switching course twice quickly could
  // otherwise let the first response land last, painting course A's attendance under
  // course B's name — the same stale-numbers symptom by a different route.
  const loadSeq = useRef(0);
  const load = useCallback(async (scope, withExec) => {
    const seq = ++loadSeq.current;
    setLoading(true); setErr("");
    try {
      // Fetched INDEPENDENTLY: /assessments/exec-summary needs the assessments or
      // executive page while /hnd/attendance/monthly needs registers/students or
      // executive, so one 403 must not blank the other half of the page.
      const results = await Promise.allSettled([
        withExec ? api.execSummary() : Promise.resolve(null),
        api.attendanceMonthly(scope || {}),
      ]);
      if (seq !== loadSeq.current) return;   // a newer request has already answered
      const [execRes, monthlyRes] = results;
      if (withExec && execRes.status === "fulfilled") setExec(execRes.value);
      if (monthlyRes.status === "fulfilled") setMonthly(monthlyRes.value);
      // A failed reload must DROP the old attendance, not keep it. Leaving it in place
      // showed the previous course's percentage, sessions and month chart under the
      // new course's name — worse than showing nothing, because it looked right.
      else setMonthly(null);
      const failed = results.filter((r) => r.status === "rejected").map((r) => r.reason);
      if (failed.length) {
        const denied = failed.some((e) => e?.status === 403);
        setErr(denied
          ? "Some figures are hidden — your account doesn't have access to all of this data."
          : `${failed[0]?.message || "Could not load some dashboard data"}${monthlyRes.status === "rejected" ? " — the attendance figures below are unavailable, not zero." : ""}`);
      }
      // Do not stamp a fresh time over numbers that failed to refresh.
      if (!failed.length) setRefreshed(new Date());
    } catch (e) {
      if (seq === loadSeq.current) setErr(e?.message || "Could not load dashboard data");
    } finally { if (seq === loadSeq.current) setLoading(false); }
  }, []);
  useEffect(() => { load({}, true); }, [load]);
  // Defensive on the argument: a missing stage previously threw inside the Refresh
  // handler, where nothing catches it, so the button silently did nothing at all.
  const stageParts = (s) => (!s || s === "all" ? {} : { year: s.split("-")[0], termNumber: s.split("-")[1] });
  const scopeOf = (c, u, s) => ({ ...(c !== "all" ? { courseId: c } : {}), ...(u !== "all" ? { unitId: u } : {}), ...stageParts(s) });
  // Units are listed per course, so changing the course must clear a unit that isn't
  // in it — otherwise the two filters AND together into an impossible scope and every
  // attendance tile silently reads zero while the student tiles show real numbers.
  const coursesUnits = course === "all" ? store.units : store.units.filter(u => u.courseId === course);
  // Stages present in the current course, so the dropdown never offers a term this
  // course doesn't teach.
  const stages = Array.from(new Set(coursesUnits.filter(isPlaced).map(u => `${u.year}-${u.termNumber}`)))
    .sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0]) || Number(a.split("-")[1]) - Number(b.split("-")[1]));
  // The Unit dropdown follows the stage as well as the course, for the same reason.
  const unitsForCourse = stage === "all" ? coursesUnits
    : coursesUnits.filter(u => `${u.year}-${u.termNumber}` === stage);
  const onCourse = (c) => {
    const keep = c === "all" || store.units.some(u => u.id === unit && u.courseId === c);
    const nextUnit = keep ? unit : "all";
    // Reset the Year too: the new scope may have no data in the selected year, which
    // left the dropdown showing a year that no longer exists and every attendance
    // figure blank — the same impossible-filter trap the unit reset fixes. The stage
    // resets for the same reason — courses don't share term structures.
    setCourse(c); setUnit(nextUnit); setStage("all"); setYear("all"); load(scopeOf(c, nextUnit, "all"), false);
  };
  const onUnit = (u) => { setUnit(u); setYear("all"); load(scopeOf(course, u, stage), false); };
  // Changing the stage clears the unit — the chosen unit may not be taught then.
  const onStage = (s) => {
    const keep = s === "all" || coursesUnits.some(u => u.id === unit && `${u.year}-${u.termNumber}` === s);
    const nextUnit = keep ? unit : "all";
    setStage(s); setUnit(nextUnit); setYear("all"); load(scopeOf(course, nextUnit, s), false);
  };

  const months = monthly?.months || [];
  // Plain calendar years, from 2025 onwards (the college's first year on the system).
  const years = [...new Set(months.map(m => m.month.slice(0, 4)))].filter(y => Number(y) >= 2025).sort();
  const inYear = (m) => year === "all" || m.month.slice(0, 4) === year;
  const monthData = months.filter(inYear).map(m => ({ label: fmtMonth(m.month), pct: m.pct }));
  // Attendance % recomputed (points-weighted) over the months the Year filter shows.
  const win = months.filter(inYear);
  const earned = win.reduce((a, m) => a + m.P * 2 + m.L + m.E, 0);
  const possible = win.reduce((a, m) => a + (m.P + m.L + m.E + m.A) * 2, 0);
  const attPct = possible ? Math.round(earned / possible * 1000) / 10 : null;
  // null when the attendance request failed — 0 would read as "nobody attended".
  const totalMarks = monthly ? win.reduce((a, m) => a + m.P + m.L + m.E + m.A, 0) : null;
  // Sessions in the selected Year, derived from the months actually in scope, so this
  // tile tracks the Year filter like the other attendance figures. (monthly.sessions
  // is the course/unit-scoped all-time count, used only when no year is selected.)
  // null (not 0) when the attendance request failed, so a fetch error shows "—"
  // rather than claiming the college has no sessions at all.
  const totalSessions = year === "all" ? (monthly ? monthly.sessions ?? 0 : null) : null;

  const allCourses = exec?.courses || [];
  const courses = allCourses.filter(c => course === "all" || c.courseId === course);
  // Only plot courses that actually have a measurable pass rate.
  const courseData = courses.filter(c => c.passRate != null).map(c => ({ code: c.code, short: shortCourse(c.code), full: c.code, passRate: c.passRate }));
  const shownStudents = course === "all" ? (exec?.totals?.students ?? store.students.length) : courses.reduce((a, c) => a + c.studentCount, 0);
  // Same rule for the exec-summary figures: a failed load shows "—", not a
  // confident zero beside a Pass Rate that correctly shows "—".
  const shownPassed = course === "all" ? (exec ? exec?.totals?.studentsPassed ?? 0 : null) : courses.reduce((a, c) => a + c.studentsPassed, 0);
  // Pass rate counts only ASSESSED students; null (—) until someone has been graded.
  const shownGraded = course === "all" ? (exec?.totals?.graded ?? 0) : courses.reduce((a, c) => a + (c.graded || 0), 0);
  const shownPassRate = shownGraded ? Math.round(shownPassed / shownGraded * 1000) / 10 : null;
  const totalCourses = course === "all" ? (exec?.totals?.courses ?? store.courses.length) : 1;
  const assessmentsCount = course === "all" ? (exec ? exec?.totals?.assessments ?? store.assessments.length : (store.assessments.length || null)) : courses.reduce((a, c) => a + (c.assessments || 0), 0);
  // A Unit filter narrows attendance only — say so rather than mixing scopes silently.
  // Both the Unit and Year/Term filters narrow the attendance query only — the
  // student and results figures come from exec-summary, which is course-wide.
  const unitScoped = unit !== "all" || stage !== "all";

  return (
    <>
      <AdminHeader title="Executive Dashboard" subtitle="College-wide attendance & results at a glance" Icon={BarChart3}
        action={<div className="flex items-center gap-2 text-[11px] text-slate-400">{refreshed && <span className="hidden sm:inline">Last refreshed {refreshed.toLocaleString("en-GB")}</span>}<button onClick={() => load(scopeOf(course, unit, stage), true)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" title="Refresh"><RefreshCw size={15} className={loading ? "animate-spin" : ""} /></button></div>} />
      <div className="mb-4 flex flex-wrap gap-2">
        <FilterSelect label="Year" value={year} onChange={setYear} options={[{ v: "all", l: "All years" }, ...years.map(y => ({ v: y, l: y }))]} />
        {/* "__none__" is a synthetic bucket for students with no course, not a real
            course — selecting it would filter attendance by a courseId no unit has. */}
        <FilterSelect label="Course" value={course} onChange={onCourse} options={[{ v: "all", l: "All courses" }, ...allCourses.filter(c => c.courseId !== "__none__").map(c => ({ v: c.courseId, l: c.code }))]} />
        {stages.length > 0 && (
          <FilterSelect label="Year / Term" value={stage} onChange={onStage}
            options={[{ v: "all", l: "Whole course" }, ...stages.map(s => ({ v: s, l: `Year ${s.split("-")[0]} · Term ${s.split("-")[1]}` }))]} />
        )}
        <FilterSelect label="Unit" value={unit} onChange={onUnit} options={[{ v: "all", l: "All units" }, ...unitsForCourse.map(m => ({ v: m.id, l: course === "all" ? `${m.code} — ${m.name} · ${courses.find(c => c.courseId === m.courseId)?.code || "unassigned"}` : `${m.code} — ${m.name}` }))]} />
      </div>
      {err && <div className="mb-3 flex items-center gap-2 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600 ring-1 ring-rose-200"><AlertCircle size={15} /> {err}</div>}
      {unitScoped && <p className="mb-3 text-[11px] text-slate-400">The {unit !== "all" && stage !== "all" ? "Year / Term and Unit filters apply" : unit !== "all" ? "Unit filter applies" : "Year / Term filter applies"} to the attendance figures; student and results figures cover the whole {course === "all" ? "college" : "course"}.</p>}
      <ExecHero attPct={attPct} passRate={shownPassRate} students={exec ? shownStudents : null}
        courses={exec ? totalCourses : null} marks={totalMarks} />
      {/* Five tiles, so five columns on a wide screen — at four they wrapped to a
          lone orphan on a second row. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <ExecKpi label="Total Courses" value={exec ? totalCourses : "—"} Icon={BookOpen} />
        <ExecKpi label="Assessments" value={assessmentsCount == null ? "—" : assessmentsCount} Icon={Award} />
        <ExecKpi label="Students Passed" value={shownPassed == null ? "—" : shownPassed} tone="#0d7a5f" Icon={CheckCircle2} />
        <ExecKpi label="Total Sessions" value={totalSessions == null ? "—" : totalSessions} sub={totalSessions == null ? "all years only" : undefined} Icon={ClipboardList} />
        <ExecKpi label="Total Attendance" value={totalMarks == null ? "—" : kNum(totalMarks)} sub="marks recorded" Icon={TrendingUp} />
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <ChartCard title="Attendance % by Year and Month" accent={NAVY}>
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={monthData} margin={{ top: 10, right: 14, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="attFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={NAVY} stopOpacity={0.16} />
                  <stop offset="100%" stopColor={NAVY} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="label" tick={AXIS_TICK} interval="preserveStartEnd" tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis domain={[0, 100]} tick={AXIS_TICK} tickFormatter={v => `${v}%`} tickLine={false} axisLine={false} width={46} />
              <Tooltip content={<ChartTip name="Attendance" />} cursor={{ stroke: "#cbd5e1", strokeWidth: 1 }} />
              {/* No dot on every month — 12 markers is chrome, not information. The
                  hover dot is 8px so it is a real touch target. */}
              <Area type="monotone" dataKey="pct" stroke={NAVY} strokeWidth={2} fill="url(#attFill)"
                dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff" }} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
        {/* "Unweighted" said out loud, because Assessment.weight IS stored, validated
            and shown on the assessment itself — so a reader could reasonably assume
            this figure honours it. It does not: it is a plain mean of graded
            percentages, and whether it SHOULD be weighted is an academic policy
            decision for the college, not one to change quietly in a chart. */}
        <ChartCard title="Students passing (unweighted average ≥ 50%) by course" accent={MAROON}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={courseData} layout="vertical" margin={{ top: 4, right: 44, left: 8, bottom: 0 }} barCategoryGap="28%">
              <CartesianGrid stroke={GRID} horizontal={false} />
              <XAxis type="number" domain={[0, 100]} tick={AXIS_TICK} tickFormatter={v => `${v}%`} tickLine={false} axisLine={{ stroke: GRID }} />
              {/* Short labels on one line. The full course name is in the tooltip. */}
              <YAxis type="category" dataKey="short" width={132} tick={{ fontSize: 11, fill: "#475569" }} tickLine={false} axisLine={false} />
              <Tooltip content={<ChartTip name="Pass rate" />} cursor={{ fill: "rgba(148,163,184,.10)" }} />
              {/* Four bars at most, so labelling each end is selective, not noise. */}
              <Bar dataKey="passRate" fill={MAROON} radius={[0, 6, 6, 0]} barSize={18}
                label={{ position: "right", formatter: v => `${v}%`, fontSize: 11, fill: "#64748b", fontWeight: 700 }} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
      <ChartCard title="Results by Course" className="mt-3">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs font-bold uppercase tracking-wide text-slate-400"><tr><th className="py-2 pr-4">Course</th><th className="px-2 py-2 text-right">Students</th><th className="px-2 py-2 text-right">Assessed</th><th className="px-2 py-2 text-right">Passed</th><th className="py-2 pl-2 text-right">Pass Rate</th></tr></thead>
            <tbody>
              {courses.map(c => (
                <tr key={c.courseId} className="border-t border-slate-100">
                  <td className="py-2 pr-4 font-medium text-slate-700">{c.code}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-slate-600">{c.studentCount}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-slate-500">{c.graded ?? 0}</td>
                  <td className="px-2 py-2 text-right font-semibold tabular-nums text-emerald-600">{c.studentsPassed}</td>
                  <td className="py-2 pl-2 text-right font-bold tabular-nums" style={{ color: pctColour(c.passRate) }}>{c.passRate == null ? "—" : `${c.passRate}%`}</td>
                </tr>
              ))}
              {courses.length > 0 && (
                <tr className="border-t-2 border-slate-200 font-bold text-slate-800">
                  <td className="py-2 pr-4">Total</td>
                  <td className="px-2 py-2 text-right tabular-nums">{shownStudents}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{shownGraded}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{shownPassed}</td>
                  <td className="py-2 pl-2 text-right tabular-nums" style={{ color: pctColour(shownPassRate) }}>{shownPassRate == null ? "—" : `${shownPassRate}%`}</td>
                </tr>
              )}
              {courses.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-slate-400">{loading ? "Loading…" : "No course data yet."}</td></tr>}
            </tbody>
          </table>
        </div>
      </ChartCard>
    </>
  );
}

export function AdminDashboard({ store, onExitToStaffApp }) {
  const me = store.currentUser;
  // Collapsible sidebar (desktop) so an admin can reclaim full width; remembered across
  // sessions. On mobile the sidebar is already a horizontal chip bar, so this is desktop-only.
  const [sidebarOpen, setSidebarOpen] = useState(() => { try { return localStorage.getItem("edtech.sidebar") !== "0"; } catch { return true; } });
  const toggleSidebar = (v) => { setSidebarOpen(v); try { localStorage.setItem("edtech.sidebar", v ? "1" : "0"); } catch { /* ignore */ } };
  // NOTE: the isAdmin guard is deliberately below the hooks (see the return further
  // down). Returning before them would change the hook count if the flag ever flipped
  // while mounted, which React rejects and turns into an app-wide crash.
  const allNav = [
    { key: "executive", label: "Executive Dashboard", I: BarChart3 },
    { key: "overview", label: "Overview", I: LayoutDashboard },
    { key: "kpi", label: "KPIs", I: Activity },
    { key: "checkin", label: "Check-In", I: Clock3 },
    { key: "balances", label: "Holiday Balances", I: Check },
    { key: "calendar", label: "Holiday Calendar", I: CalendarDays },
    { key: "requests", label: "Leave Requests", I: Inbox },
    { key: "documents", label: "Documents", I: FileText },
    { key: "approvals", label: "Approvals", I: ThumbsUp },
    { key: "signups", label: "Sign-Up Requests", I: UserCheck },
    { key: "summaries", label: "Daily Summaries", I: UserPlus },
    { key: "registers", label: "Registers — HND", I: ClipboardList },
    { key: "students", label: "Students", I: GraduationCap },
    { key: "attendance-emails", label: "Attendance Emails", I: Mail },
    { key: "admissions", label: "Admissions", I: ClipboardList },
    { key: "ism", label: "ISM", I: MessageSquare },
    { key: "slc", label: "SLC", I: Wallet },
    { key: "assessments", label: "Assessments", I: Award },
    { key: "pat", label: "PAT", I: MessageSquare },
    { key: "staffreviews", label: "Staff Reviews", I: ClipboardList },
    { key: "studentreviews", label: "Student Reviews", I: MessageSquare },
    { key: "studentqueries", label: "Student Queries", I: Inbox },
    { key: "staff", label: "Staff", I: Users },
    { key: "timesheets", label: "Timesheets", I: Timer },
    { key: "timetable", label: "Timetable", I: CalendarClock },
    { key: "passwords", label: "Reset Passwords", I: KeyRound },
    { key: "settings", label: "Settings", I: Settings },
    { key: "audit", label: "Audit Trail", I: History },
    { key: "access", label: "Access", I: ShieldCheck },
  ];
  // Only the pages this admin may see. Super Admin sees all + the Access tab.
  //
  // "audit" is not a grantable page and so is not in ADMIN_PAGES: it is derived from
  // the pages someone already holds, exactly as the API derives it (routes/audit.js
  // gates on the same three). Giving it its own key would let a Super Admin grant
  // somebody the trail WITHOUT the administrative authority the trail describes, and
  // withhold it from the administrators it is a record of — neither of which is a
  // sensible thing to be able to configure.
  const nav = allNav.filter(n => n.key === "audit"
    ? AUDIT_READER_PAGES.some(p => canAccessPage(me, p))
    : canAccessPage(me, n.key));
  const [tab, setTab] = useState(() => nav[0]?.key || "overview");
  // If the current tab isn't in the allowed set (e.g. access was changed mid-session),
  // fall back to the first one they can see, so no forbidden page ever renders.
  const activeKey = nav.some(n => n.key === tab) ? tab : (nav[0]?.key || null);
  const handset = useIsHandset();
  // Android back (mobile dashboard): return to the first tab, then out to the staff app.
  useBackHandler(handset, () => {
    // Guard nav[0]: an admin granted no pages has an empty nav, so nav[0].key would throw.
    if (nav[0] && activeKey !== nav[0].key) { setTab(nav[0].key); return true; }
    if (onExitToStaffApp) { onExitToStaffApp(); return true; }
    return false;
  });
  const pendingCount = store.leave.filter(l => l.status === "pending").length;
  const pendingSignups = (store.signups || []).filter(s => s.status === "pending").length;
  const openQueries = (store.studentQueries || []).filter(q => q.status === "open").length;
  const timesheetsPending = store.timesheetsPending || 0;
  // Guard placed after every hook above, for the reason noted at the top.
  //
  // The student check is explicit and FIRST. App.jsx already routes a student to
  // StudentApp and never renders this component for them, and the server refuses a
  // student token on every router but /api/student — so this is the third
  // independent barrier, not the only one. It is here because "the dashboard is
  // unreachable for students" should be true of this component on its own, not only
  // true of the two things that happen to sit in front of it.
  if (me?.kind === "student" || me?.isStudent) return <div className="p-4 text-slate-400">Access denied</div>;
  if (!store.isAdmin) return <div className="p-4 text-slate-400">Access denied</div>;
  return (
    <div className="flex min-h-[calc(100vh-40px)] w-full overflow-x-hidden">
      <aside className={`hidden w-60 shrink-0 flex-col bg-white px-4 py-5 ring-1 ring-slate-200 ${sidebarOpen ? "md:flex" : ""}`}>
        <div className="mb-6 flex items-center gap-2 px-1">
          <div className="flex h-10 w-14 shrink-0 items-center justify-center rounded-md ring-1 ring-slate-200"><Logo small /></div>
          <div className="min-w-0"><p className="text-[13px] font-extrabold leading-tight" style={{ color: NAVY }}>Staff Hub</p><p className="text-[10px] font-semibold text-slate-400">ADMIN CONSOLE</p></div>
          <button onClick={() => toggleSidebar(false)} title="Hide menu" aria-label="Hide menu" className="press ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"><PanelLeftClose size={18} /></button>
        </div>
        <nav className="flex-1 space-y-1">
          {nav.map((n, i) => (
            <button key={n.key} onClick={() => setTab(n.key)} className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-all duration-200 active:scale-[0.98] slide-in ${activeKey === n.key ? "text-white shadow-md" : "text-slate-500 hover:translate-x-1 hover:bg-blue-50 hover:text-blue-700"}`} style={activeKey === n.key ? { background: `linear-gradient(135deg, ${BLUE}, ${NAVY_DARK})`, boxShadow: `0 8px 20px -6px ${BLUE}99`, animationDelay: `${i * 35}ms` } : { animationDelay: `${i * 35}ms` }}>
              <n.I size={18} className="transition-transform duration-200 group-hover:scale-110" /><span className="flex-1 text-left">{n.label}</span>
              {(n.key === "requests" || n.key === "approvals") && pendingCount > 0 && <span className="pop rounded-full bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold text-slate-900 shadow-sm">{pendingCount}</span>}
              {n.key === "signups" && pendingSignups > 0 && <span className="pop rounded-full bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold text-slate-900 shadow-sm">{pendingSignups}</span>}
              {n.key === "studentqueries" && openQueries > 0 && <span className="pop rounded-full bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold text-slate-900 shadow-sm">{openQueries}</span>}
              {n.key === "timesheets" && timesheetsPending > 0 && <span className="pop rounded-full bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold text-slate-900 shadow-sm">{timesheetsPending}</span>}
            </button>
          ))}
        </nav>
        <div className="rounded-xl bg-slate-50 p-3 text-center"><p className="text-[11px] text-slate-400">Logged in as</p><p className="text-sm font-bold text-slate-700">{me?.name || "Administrator"}</p>{me?.isSuperAdmin && <p className="mt-0.5 text-[10px] font-bold uppercase tracking-wide" style={{ color: MAROON }}>Super Admin</p>}</div>
      </aside>
      <main className="min-w-0 flex-1 overflow-x-hidden bg-slate-100 p-5 md:p-7">
        {!sidebarOpen && (
          <button onClick={() => toggleSidebar(true)} title="Show menu" className="press mb-4 hidden items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50 md:inline-flex"><PanelLeftOpen size={16} /> Menu</button>
        )}
        <div className="mb-4 flex gap-1.5 overflow-x-auto md:hidden">
          {/* On a phone, a way back to the staff app — admins (incl. limited admins
              who registered on the app) keep both their staff view and the console. */}
          {onExitToStaffApp && <button onClick={onExitToStaffApp} className="flex shrink-0 items-center gap-1.5 rounded-full border-2 border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 active:scale-95"><ChevronLeft size={14} /> Staff App</button>}
          {nav.map(n => <button key={n.key} onClick={() => setTab(n.key)} className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold shadow-sm transition-all active:scale-95 ${activeKey === n.key ? "text-white" : "bg-white text-slate-500 hover:bg-blue-50 hover:text-blue-700"}`} style={activeKey === n.key ? { background: `linear-gradient(135deg, ${BLUE}, ${NAVY_DARK})`, boxShadow: `0 6px 16px -6px ${BLUE}99` } : {}}><n.I size={14} /> {n.label}</button>)}
        </div>
        {/* An admin granted no pages: show a friendly note rather than an empty console. */}
        {nav.length === 0 && <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/70"><EmptyState Icon={ShieldCheck} title="No admin pages yet" msg="You don't have access to any admin pages — ask a super admin to grant access." /></div>}
        {activeKey === "executive" && <ExecutiveDashboard store={store} />}
        {activeKey === "overview" && <AdminOverview store={store} setTab={setTab} />}
        {activeKey === "kpi" && <AdminKPI store={store} />}
        {activeKey === "checkin" && <AdminCheckin store={store} />}
        {activeKey === "balances" && <AdminBalances store={store} />}
        {activeKey === "calendar" && <AdminCalendar store={store} />}
        {activeKey === "requests" && <AdminRequests store={store} />}
        {activeKey === "documents" && <AdminDocuments store={store} />}
        {activeKey === "approvals" && <AdminApprovals store={store} />}
        {activeKey === "signups" && <AdminSignups store={store} />}
        {activeKey === "summaries" && <AdminSummaries store={store} />}
        {activeKey === "registers" && <AdminHndRegisters store={store} />}
        {activeKey === "students" && <AdminStudents store={store} />}
        {activeKey === "attendance-emails" && <AdminAttendanceEmails store={store} />}
        {activeKey === "assessments" && <AdminAssessments store={store} />}
        {activeKey === "pat" && <AdminPAT store={store} />}
        {activeKey === "staffreviews" && <AdminStaffReviews store={store} />}
        {activeKey === "studentreviews" && <AdminStudentReviews store={store} />}
        {activeKey === "passwords" && <AdminPasswords />}
        {activeKey === "studentqueries" && <AdminStudentQueries store={store} />}
        {activeKey === "staff" && <AdminStaff store={store} />}
        {activeKey === "timesheets" && <AdminTimesheets store={store} />}
        {activeKey === "timetable" && <AdminTimetable store={store} />}
        {activeKey === "admissions" && <AdminAdmissions store={store} />}
        {activeKey === "ism" && <AdminIsm store={store} />}
        {activeKey === "slc" && <AdminSlc store={store} />}
        {activeKey === "settings" && <AdminSettings store={store} />}
        {activeKey === "audit" && <AuditTrail />}
        {activeKey === "access" && <AdminAccess store={store} />}
      </main>
    </div>
  );
}

/* ----- Dashboard: Access control (Super Admin only) ----- */
function AdminAccess({ store }) {
  const [selId, setSelId] = useState(null);
  const [pages, setPages] = useState([]);   // working selection for the picked person
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");

  // The pages a person currently has: super admin & unrestricted admin = all;
  // a scoped admin = their list; anyone else = none.
  const grantOf = (p) => p.isSuperAdmin ? ADMIN_PAGES.slice()
    : p.accountRole === "ADMIN" ? (p.adminPages == null ? ADMIN_PAGES.slice() : p.adminPages)
    : (Array.isArray(p.adminPages) ? p.adminPages : []);
  const roleLabel = (p) => p.isSuperAdmin ? "Super Admin"
    : p.accountRole === "ADMIN" ? (p.adminPages == null ? "Full admin" : `${p.adminPages.length} page${p.adminPages.length === 1 ? "" : "s"}`)
    : "No access";

  const people = [...store.staff].sort((a, b) => {
    const rank = (p) => p.isSuperAdmin ? 0 : p.accountRole === "ADMIN" ? 1 : 2;
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  const ql = q.trim().toLowerCase();
  const list = people.filter(p => !ql || p.name.toLowerCase().includes(ql) || (p.email || "").toLowerCase().includes(ql));

  const sel = people.find(p => p.id === selId) || null;
  const pick = (p) => { setSelId(p.id); setPages(grantOf(p)); };
  const toggle = (k) => setPages(ps => ps.includes(k) ? ps.filter(x => x !== k) : [...ps, k]);
  const allOn = ADMIN_PAGES.every(k => pages.includes(k));
  const toggleAll = () => setPages(allOn ? [] : ADMIN_PAGES.slice());

  const save = async () => {
    if (!sel) return;
    setBusy(true);
    try { await store.updateAccess(sel.id, pages); } catch (_) {} finally { setBusy(false); }
  };

  return (
    <>
      <AdminHeader title="Access" subtitle="Choose a person, then tick the admin pages they can open" Icon={ShieldCheck} />
      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        {/* People */}
        <div className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200/70">
          <div className="mb-2 flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-slate-200"><Search size={15} className="text-slate-400" /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search people…" className="w-full bg-transparent text-sm outline-none" /></div>
          <div className="max-h-[60vh] space-y-1 overflow-y-auto">
            {list.map(p => (
              <button key={p.id} onClick={() => pick(p)} className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition ${selId === p.id ? "bg-blue-50 ring-1 ring-blue-200" : "hover:bg-slate-50"}`}>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white" style={{ background: p.colour }}>{p.initials}</span>
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-700">{p.name}</span><span className="block truncate text-[11px] text-slate-400">{p.email}</span></span>
                <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold" style={p.isSuperAdmin ? { background: MAROON, color: "white" } : p.accountRole === "ADMIN" ? { background: "#e0e7ff", color: "#4338ca" } : { background: "#f1f5f9", color: "#64748b" }}>{roleLabel(p)}</span>
              </button>
            ))}
            {list.length === 0 && <p className="px-2 py-6 text-center text-xs text-slate-400">No people match.</p>}
          </div>
        </div>

        {/* Editor */}
        <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70">
          {!sel && <EmptyState Icon={ShieldCheck} title="Pick a person" msg="Choose someone on the left to set which admin pages they can access." />}
          {sel && sel.isSuperAdmin && (
            <div className="flex items-center gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 ring-1 ring-amber-200">
              <ShieldCheck size={18} className="shrink-0" /> {sel.name} is the Super Admin and always has full access.
            </div>
          )}
          {sel && !sel.isSuperAdmin && (
            <>
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full text-xs font-bold text-white" style={{ background: sel.colour }}>{sel.initials}</span>
                  <div><p className="font-bold text-slate-800">{sel.name}</p><p className="text-[11px] text-slate-400">{pages.length === 0 ? "No admin access" : allOn ? "Full admin access" : `${pages.length} of ${ADMIN_PAGES.length} pages`}</p></div>
                </div>
                <button onClick={toggleAll} className="text-xs font-bold text-blue-600 hover:underline">{allOn ? "Clear all" : "Select all"}</button>
              </div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {ADMIN_PAGES.map(k => {
                  const on = pages.includes(k);
                  return (
                    <button key={k} onClick={() => toggle(k)} className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm font-semibold ring-1 transition ${on ? "bg-blue-50 text-slate-800 ring-blue-200" : "bg-white text-slate-500 ring-slate-200 hover:bg-slate-50"}`}>
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md ring-1" style={on ? { background: NAVY, borderColor: "transparent" } : { boxShadow: "inset 0 0 0 1px #cbd5e1" }}>{on && <Check size={13} className="text-white" />}</span>
                      {PAGE_LABELS[k]}
                    </button>
                  );
                })}
              </div>
              <p className="mt-4 flex items-start gap-1.5 rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500 ring-1 ring-slate-100">
                <AlertCircle size={13} className="mt-px shrink-0" /> Granting at least one page makes this person an admin for those pages. Clearing all removes their admin access entirely. Changes take effect the next time they open the app.
              </p>
              <PrimaryBtn onClick={save} disabled={busy} className="mt-4 w-full"><Save size={16} /> {busy ? "Saving…" : "Save access"}</PrimaryBtn>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/* ----- Admin / Finance: review & approve timesheets ----- */
const TS_STATUS = {
  pending:  { label: "Awaiting approval", cls: "bg-amber-50 text-amber-700 ring-amber-200",  I: Clock3 },
  changes:  { label: "Changes requested", cls: "bg-rose-50 text-rose-600 ring-rose-200",     I: AlertCircle },
  approved: { label: "Approved",          cls: "bg-emerald-50 text-emerald-600 ring-emerald-200", I: CheckCircle2 },
};
const groupStatus = (entries) => entries.some(e => e.status === "submitted") ? "pending"
  : entries.some(e => e.status === "changes_requested") ? "changes" : "approved";

function AdminTimesheets({ store }) {
  const [month, setMonth] = useState(() => monthOf(todayISO()));
  const [entries, setEntries] = useState(null);
  const [open, setOpen] = useState({});
  const [reloadKey, setReloadKey] = useState(0);
  const [reviewModal, setReviewModal] = useState(null); // { staffId, name } when requesting changes
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const reload = () => setReloadKey(k => k + 1);

  // Loading state only on a deliberate month switch — not on the background poll.
  useEffect(() => { setEntries(null); }, [month]);
  // scope:"all" → every non-draft entry for the month (submitted/approved/changes).
  // It has to be asked for explicitly now: "no staffId" used to mean "everyone", which
  // also caught the staff app's own My Timesheet screen and showed a finance admin the
  // whole college's hours in place of their own. Refresh every 20s so newly-sent
  // timesheets appear, swapping IN PLACE (no flicker to 0). `store` is intentionally
  // not a dependency (fresh object each render → would refetch and blank the list).
  useEffect(() => {
    let cancelled = false;
    const fetchNow = () => store.listTimesheets({ month, scope: "all" })
      .then(d => { if (!cancelled) setEntries(d); })
      .catch(() => { if (!cancelled) setEntries(prev => prev || []); });
    fetchNow();
    const id = setInterval(() => { if (typeof document === "undefined" || document.visibilityState === "visible") fetchNow(); }, 20000);
    return () => { cancelled = true; clearInterval(id); };
  }, [month, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const approve = async (staffId) => { setBusy(true); try { await store.reviewTimesheet(staffId, month, "approved"); reload(); } catch (_) {} finally { setBusy(false); } };
  const requestChanges = async () => {
    if (!note.trim()) return;
    setBusy(true);
    try { await store.reviewTimesheet(reviewModal.staffId, month, "changes_requested", note.trim()); setReviewModal(null); setNote(""); reload(); }
    catch (_) {} finally { setBusy(false); }
  };

  const shiftMonth = (delta) => setMonth(shiftMonthStr(month, delta));
  const list = entries || [];
  const byStaff = {};
  for (const e of list) (byStaff[e.staffId] = byStaff[e.staffId] || { staffId: e.staffId, name: e.staffName, dept: e.staffDept, initials: e.staffInitials, colour: e.staffColour, entries: [] }).entries.push(e);
  const people = Object.values(byStaff).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const totalMin = list.reduce((s, e) => s + e.minutes, 0);
  const campusMin = list.filter(e => e.mode === "campus").reduce((s, e) => s + e.minutes, 0);
  const onlineMin = list.filter(e => e.mode === "online").reduce((s, e) => s + e.minutes, 0);
  const pendingCount = people.filter(p => groupStatus(p.entries) === "pending").length;

  const exportCsv = () => {
    downloadCSV(`timesheets-${month}.csv`, [
      { key: "staff", label: "Staff" }, { key: "dept", label: "Dept" }, { key: "date", label: "Date" }, { key: "start", label: "Start" }, { key: "end", label: "End" }, { key: "hours", label: "Hours" }, { key: "mode", label: "Mode" }, { key: "title", label: "Class/Activity" }, { key: "submittedAt", label: "Sent" },
    ], list.map(e => ({ staff: e.staffName, dept: e.staffDept, date: e.date, start: e.start, end: e.end, hours: e.hours, mode: e.mode, title: e.title, submittedAt: e.submittedAt })));
    store.notify("Exported timesheets CSV");
  };

  return (
    <>
      <AdminHeader title="Timesheets" subtitle="Timesheets staff have sent, by month" Icon={Timer} action={
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-xl bg-white px-1 py-1 shadow-sm ring-1 ring-slate-200">
            <button onClick={() => shiftMonth(-1)} className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"><ChevronLeft size={16} /></button>
            <span className="min-w-[120px] text-center text-xs font-bold text-slate-600">{monthLabel(month)}</span>
            <button onClick={() => shiftMonth(1)} className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"><ChevronRight size={16} /></button>
          </div>
          <button onClick={exportCsv} disabled={!list.length} className="flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-xs font-bold text-slate-600 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-50 disabled:opacity-50"><Download size={14} /> Export</button>
        </div>
      } />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {/* No `animate` on these — the count-up animation does Number(value), which
            is NaN for a string like "9.1h". animate stays only on numeric cards. */}
        <StatCard label="Total hours" value={`${fmtHours(totalMin)}h`} sub={`${monthLabel(month)}`} Icon={Clock3} tone={NAVY} delay={0} />
        <StatCard label="On campus" value={`${fmtHours(campusMin)}h`} sub="in person" Icon={Building2} tone="var(--brand-primary)" delay={60} />
        <StatCard label="Online" value={`${fmtHours(onlineMin)}h`} sub="remote" Icon={Wifi} tone="#0d7a5f" delay={120} />
        <StatCard label="Awaiting review" value={pendingCount} sub={`of ${people.length} sent`} Icon={Inbox} tone="#b45309" delay={180} animate />
      </div>

      {entries === null ? (
        <div className="flex flex-col items-center gap-2 py-16 text-slate-400"><Loader2 size={24} className="animate-spin" /><p className="text-sm font-semibold">Loading timesheets…</p></div>
      ) : people.length === 0 ? (
        <div className="rounded-2xl bg-white py-16 text-center shadow-sm ring-1 ring-slate-100"><Timer size={34} className="mx-auto mb-2 text-slate-300" /><p className="text-sm font-semibold text-slate-500">No timesheets sent for {monthLabel(month)} yet.</p></div>
      ) : (
        <div className="space-y-3">
          {people.map(p => {
            const pMin = p.entries.reduce((s, e) => s + e.minutes, 0);
            const pCampus = p.entries.filter(e => e.mode === "campus").reduce((s, e) => s + e.minutes, 0);
            const isOpen = open[p.staffId];
            const gs = groupStatus(p.entries);           // pending | changes | approved
            const badge = TS_STATUS[gs];
            const reviewed = p.entries.find(e => e.reviewedBy);
            return (
              <div key={p.staffId} className={`overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ${gs === "pending" ? "ring-amber-200" : "ring-slate-100"}`}>
                <button onClick={() => setOpen(o => ({ ...o, [p.staffId]: !o[p.staffId] }))} className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-slate-50">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white" style={{ background: p.colour || NAVY }}>{p.initials}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-slate-700">{p.name}</p>
                    <p className="truncate text-[11px] text-slate-400">{p.dept} · {p.entries.length} session{p.entries.length === 1 ? "" : "s"}</p>
                  </div>
                  <span className={`hidden shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold ring-1 sm:inline-flex ${badge.cls}`}><badge.I size={11} /> {badge.label}</span>
                  <div className="shrink-0 text-right"><p className="text-base font-extrabold" style={{ color: NAVY }}>{fmtHours(pMin)}h</p><p className="text-[10px] text-slate-400">{fmtHours(pCampus)}h campus</p></div>
                  <ChevronDown size={18} className={`shrink-0 text-slate-300 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                </button>
                {isOpen && (
                  <div className="border-t border-slate-100 bg-slate-50/50 px-2 py-2">
                    <span className={`mx-1.5 mb-1 inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold ring-1 sm:hidden ${badge.cls}`}><badge.I size={11} /> {badge.label}</span>
                    {p.entries.slice().sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start)).map(e => (
                      <div key={e.id} className="flex items-center gap-3 rounded-xl px-2.5 py-2">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white" style={{ background: e.mode === "campus" ? NAVY : "#0d7a5f" }}>{e.mode === "campus" ? <Building2 size={14} /> : <Wifi size={14} />}</span>
                        <div className="min-w-0 flex-1"><p className="truncate text-[13px] font-semibold text-slate-700">{e.title}</p><p className="text-[10px] text-slate-400">{prettyDay(e.date)} · {e.start}–{e.end} · {e.mode === "campus" ? "Campus" : "Online"}</p></div>
                        <span className="shrink-0 text-xs font-bold text-slate-500">{fmtHours(e.minutes)}h</span>
                      </div>
                    ))}
                    {/* Prior decision, if any */}
                    {gs !== "pending" && reviewed?.reviewNote && (
                      <p className="mx-1.5 mt-1 rounded-lg bg-white px-2.5 py-1.5 text-[11px] text-slate-500 ring-1 ring-slate-200"><b>{gs === "changes" ? "Change note" : "Note"}:</b> {reviewed.reviewNote}{reviewed.reviewedBy ? ` — ${reviewed.reviewedBy}` : ""}</p>
                    )}
                    {/* Finance actions — only while awaiting approval */}
                    {gs === "pending" && (
                      <div className="mt-1.5 flex gap-2 px-1.5 pb-1">
                        <button onClick={() => approve(p.staffId)} disabled={busy} className="press flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 text-xs font-bold text-white shadow-sm transition disabled:opacity-60" style={{ background: "#059669" }}><CheckCircle2 size={15} /> Approve</button>
                        <button onClick={() => { setReviewModal({ staffId: p.staffId, name: p.name }); setNote(""); }} disabled={busy} className="press flex flex-1 items-center justify-center gap-1.5 rounded-xl border-2 border-amber-300 bg-white py-2.5 text-xs font-bold text-amber-700 transition hover:bg-amber-50 disabled:opacity-60"><MessageSquare size={15} /> Request changes</button>
                      </div>
                    )}
                    {gs === "approved" && <p className="px-1.5 pb-1 pt-0.5 text-center text-[11px] font-semibold text-emerald-600">✓ Approved{reviewed?.reviewedAt ? ` on ${reviewed.reviewedAt}` : ""}</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Request-changes comment modal */}
      <Modal open={!!reviewModal} onClose={() => setReviewModal(null)} title={`Request changes — ${reviewModal?.name || ""}`}>
        <div className="space-y-3">
          <p className="text-sm text-slate-600">Tell {reviewModal?.name?.split(" ")[0] || "the staff member"} what needs correcting on their <b>{monthLabel(month)}</b> timesheet. They'll be notified and can fix it and re-send.</p>
          <Field label="Comment"><textarea value={note} onChange={e => setNote(e.target.value)} rows={4} placeholder="e.g. The Tuesday session should be online, not campus." className={inputCls + " resize-none"} autoFocus /></Field>
          <div className="flex gap-2">
            <button onClick={() => setReviewModal(null)} className="flex-1 rounded-xl border-2 border-slate-200 py-2.5 text-sm font-bold text-slate-600">Cancel</button>
            <button onClick={requestChanges} disabled={busy || !note.trim()} className="press flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold text-white shadow-sm transition disabled:opacity-60" style={{ background: "#b45309" }}>{busy ? <><Loader2 size={16} className="animate-spin" /> Sending…</> : <><MessageSquare size={16} /> Send back</>}</button>
          </div>
        </div>
      </Modal>
    </>
  );
}

// A vibrant welcome banner for the main dashboards: greeting, first name, date, and an
// optional right-hand slot (a refresh button, a headline figure, filters…).
function DashboardHero({ name, subtitle, right, tone = BLUE }) {
  const greet = greetingFor();
  const G = greet.Icon;
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return (
    <div className="relative mb-5 overflow-hidden rounded-3xl p-5 text-white shadow-xl fade-up sm:p-6" style={{ background: `linear-gradient(120deg, ${tone} 0%, ${NAVY_DARK} 100%)`, boxShadow: `0 22px 44px -20px ${tone}` }}>
      <div className="pointer-events-none absolute -right-10 -top-16 h-56 w-56 rounded-full bg-white/10 blur-2xl" />
      <div className="pointer-events-none absolute -bottom-24 right-28 h-56 w-56 rounded-full bg-white/5 blur-2xl" />
      <div className="relative flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/15 ring-1 ring-white/25 backdrop-blur"><G size={24} /></span>
          <div>
            <p className="text-xl font-extrabold leading-tight sm:text-2xl">{greet.word}{name ? `, ${String(name).split(" ")[0]}` : ""}</p>
            <p className="mt-0.5 text-[13px] font-medium text-white/75">{subtitle || today}</p>
          </div>
        </div>
        {right && <div className="relative">{right}</div>}
      </div>
    </div>
  );
}
function AdminHeader({ title, subtitle, action, Icon, tone = BLUE }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3 fade-up">
      <div className="flex items-center gap-3">
        <span className="h-10 w-1.5 shrink-0 rounded-full" style={{ background: `linear-gradient(180deg, ${tone}, ${NAVY_DARK})` }} />
        {Icon && <span className="hidden h-12 w-12 items-center justify-center rounded-2xl text-white shadow-lg transition-transform duration-300 hover:scale-105 hover:-rotate-3 sm:flex" style={{ background: grad(tone), boxShadow: `0 10px 22px -8px ${tone}90` }}><Icon size={24} /></span>}
        <div>
          <h2 className="text-2xl font-extrabold tracking-tight" style={{ color: NAVY_DARK }}>{title}</h2>
          {subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}
function StatCard({ label, value, sub, Icon, tone = NAVY, delay = 0, animate, trend }) {
  // Only count-up real numbers. Some cards pass a formatted string ("28d", "85%"),
  // and animating that multiplied a string by a number → NaN, which rendered
  // literally as "NaN". Strings (and non-finite numbers) now render as-is.
  const canAnimate = animate && typeof value === "number" && Number.isFinite(value);
  const av = useCountUp(canAnimate ? value : 0);
  // Optional trend chip: { up: bool, text: "+12", tone?: "#..." }. Up is green, down rose.
  const tc = trend ? (trend.tone || (trend.up ? "#059669" : "#e11d48")) : null;
  return (
    <div className="hover-lift group relative overflow-hidden rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70 transition-all duration-300 hover:-translate-y-1 hover:shadow-xl hover:ring-slate-300/80 fade-up" style={{ animationDelay: `${delay}ms` }}>
      <div className="absolute inset-x-0 top-0 h-1" style={{ background: grad(tone) }} />
      <div className="absolute -right-6 -top-6 h-24 w-24 rounded-full opacity-60 transition-transform duration-500 group-hover:scale-150" style={{ background: tone + "12" }} />
      <div className="relative flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
          <p className="mt-1 text-3xl font-extrabold tabular-nums" style={{ color: tone }}>{canAnimate ? av : value}</p>
          {sub && <p className="mt-0.5 text-xs text-slate-400">{sub}</p>}
          {trend && <span className="mt-1.5 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-extrabold" style={{ background: tc + "1a", color: tc }}>{trend.up ? "▲" : "▼"} {trend.text}</span>}
        </div>
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl text-white shadow-md transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6" style={{ background: grad(tone), boxShadow: `0 8px 18px -6px ${tone}80` }}><Icon size={22} /></span>
      </div>
    </div>
  );
}

function AdminOverview({ store, setTab }) {
  const today = todayISO();
  const inToday = store.checkins.filter(c => c.date === today && c.in);
  const onLeave = store.leave.filter(l => l.status === "approved" && today >= l.start && today <= l.end);
  const pending = store.leave.filter(l => l.status === "pending");
  const present = new Set(inToday.map(c => c.staffId)).size;
  const total = store.staff.length;
  const trend = useMemo(() => { const arr = []; for (let i = 6; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); arr.push({ day: new Date(d + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short" }), present: new Set(store.checkins.filter(c => c.date === d && c.in).map(c => c.staffId)).size }); } return arr; }, [store.checkins]);
  const deptData = useMemo(() => { const m = {}; store.staff.forEach(s => m[s.dept] = (m[s.dept] || 0) + 1); return Object.entries(m).map(([name, value]) => ({ name, value })); }, [store.staff]);
  // Extra read-only KPIs — all safe-guarded against empty data.
  const attendancePct = total > 0 ? Math.round((present / total) * 100) : 0;
  const avgIn = avgCheckInTime(inToday) || "—";
  const approvedThisPeriod = store.leave.filter(l => l.status === "approved").length;
  // Day-over-day change in how many were present, for the trend chip.
  const presentDelta = trend.length >= 2 ? present - trend[trend.length - 2].present : 0;
  return (
    <>
      <DashboardHero name={store.currentUser?.name} subtitle={`${fmtDay(today)} · live across all departments`} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Present today" value={present} sub={`of ${total} staff`} Icon={CheckCircle2} tone="#059669" delay={0} animate trend={{ up: presentDelta >= 0, text: `${presentDelta >= 0 ? "+" : ""}${presentDelta} vs yesterday` }} />
        <StatCard label="On leave" value={onLeave.length} sub="approved absences" Icon={Plane} tone="#e11d48" delay={60} animate />
        <StatCard label="Pending requests" value={pending.length} sub="awaiting approval" Icon={Inbox} tone="#b45309" delay={120} animate />
        <StatCard label="Total staff" value={total} sub="active members" Icon={Users} tone={BLUE} delay={180} animate />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Attendance" value={attendancePct} sub="of staff present" Icon={TrendingUp} tone="#0d7a5f" delay={0} />
        <StatCard label="Avg check-in" value={avgIn} sub="across today" Icon={Clock3} tone={NAVY} delay={60} />
        <StatCard label="Documents" value={store.docs.length} sub="published & private" Icon={FileText} tone="#6d28d9" delay={120} animate />
        <StatCard label="Approved leave" value={approvedThisPeriod} sub="total on record" Icon={CalendarCheck} tone="#0e7490" delay={180} animate />
      </div>
      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <div className="hover-glow rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70 transition-all duration-300 lg:col-span-2 fade-up" style={{ animationDelay: "60ms" }}>
          <p className="mb-3 text-sm font-bold text-slate-700">Attendance — last 7 days</p>
          <ResponsiveContainer width="100%" height={230}>
            <AreaChart data={trend}>
              <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={NAVY} stopOpacity={0.35} /><stop offset="100%" stopColor={NAVY} stopOpacity={0} /></linearGradient></defs>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 12, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 13 }} />
              <Area type="monotone" dataKey="present" stroke={NAVY} strokeWidth={3} fill="url(#g)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="hover-glow rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70 transition-all duration-300 fade-up" style={{ animationDelay: "120ms" }}>
          <p className="mb-3 text-sm font-bold text-slate-700">Staff by department</p>
          <ResponsiveContainer width="100%" height={230}>
            <PieChart><Pie data={deptData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={75} paddingAngle={3}>{deptData.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}</Pie><Tooltip contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 13 }} /><Legend wrapperStyle={{ fontSize: 11 }} /></PieChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70 fade-up lg:col-span-2" style={{ animationDelay: "180ms" }}>
          <div className="mb-3 flex items-center justify-between"><p className="flex items-center gap-1.5 text-sm font-bold text-slate-700"><UserCheck size={15} style={{ color: NAVY }} /> Checked in today</p><span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600"><span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" /> Live</span></div>
          <div className="grid gap-2 sm:grid-cols-2">
            {inToday.length === 0 && <div className="sm:col-span-2"><EmptyState Icon={Clock3} title="No check-ins yet" msg="Staff who clock in today will appear here." /></div>}
            {inToday.map((c, i) => { const p = store.staff.find(s => s.id === c.staffId); return (
              <div key={c.id} className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2.5 transition-all duration-200 hover:-translate-y-0.5 hover:bg-slate-100 hover:shadow-sm pop" style={{ animationDelay: `${i * 40}ms` }}><span className="flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold text-white shadow-sm" style={{ background: p?.colour }}>{p?.initials}</span><div className="flex-1"><p className="text-sm font-semibold text-slate-700">{p?.name}</p><p className="text-xs text-slate-400">In {c.in}{c.out ? ` · Out ${c.out}` : ""}</p></div><span className={`h-2.5 w-2.5 rounded-full ${c.out ? "bg-slate-300" : "bg-emerald-500"}`} /></div>
            ); })}
          </div>
        </div>
        <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70 fade-up" style={{ animationDelay: "220ms" }}>
          <div className="mb-3 flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-sm font-bold text-slate-700"><AlertCircle size={15} style={{ color: "#b45309" }} /> Needs attention</p>
            {pending.length > 0 && <button onClick={() => setTab && setTab("approvals")} className="text-xs font-bold text-blue-600 hover:underline">Review</button>}
          </div>
          {pending.length === 0 && <EmptyState Icon={CheckCircle2} title="All clear" msg="No requests are waiting." />}
          <div className="space-y-2">
            {pending.slice(0, 5).map((l, i) => { const p = store.staff.find(s => s.id === l.staffId); const t = leaveTypeMeta(l.type); return (
              <div key={l.id} className="flex items-center gap-2.5 rounded-xl bg-amber-50/60 px-3 py-2 ring-1 ring-amber-100 pop" style={{ animationDelay: `${i * 40}ms` }}>
                <span className="flex h-8 w-8 items-center justify-center rounded-full text-[10px] font-bold text-white shadow-sm" style={{ background: p?.colour }}>{p?.initials}</span>
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-slate-700">{p?.name}</p><p className="truncate text-xs text-slate-400">{t.label} · {store.chargeableDays(l.start, l.end)}d</p></div>
              </div>
            ); })}
            {pending.length > 5 && <p className="text-center text-[11px] font-semibold text-slate-400">+{pending.length - 5} more</p>}
          </div>
        </div>
      </div>
    </>
  );
}

/* ----- Dashboard: Check-In ----- */
function AdminCheckin({ store }) {
  const [day, setDay] = useState(todayISO());
  const [modal, setModal] = useState(false);
  // No demo "s1" default — the dropdown would show the first real person while the
  // form still held an id the server doesn't know.
  const [form, setForm] = useState({ staffId: "", in: "09:00", out: "", site: "" });
  const [query, setQuery] = useState("");
  const recs = store.checkins.filter(c => c.date === day);
  // Only real clock-ins count as present — a summary-first row has an empty `in`.
  const present = new Set(recs.filter(r => r.in).map(r => r.staffId));
  const ql = query.trim().toLowerCase();
  const filteredStaff = store.staff.filter(s => !ql || s.name.toLowerCase().includes(ql) || (s.dept || "").toLowerCase().includes(ql));
  const paged = usePaged(filteredStaff, 12, ql);
  const addCheckin = async () => {
    if (!form.staffId) return;
    await store.upsertCheckin({ staffId: form.staffId, date: day, in: form.in, out: form.out || null, site: form.site || null }); setModal(false);
  };
  const setOut = (rec) => store.checkOut(rec.id);
  return (
    <>
      <AdminHeader title="Check-In & Attendance" subtitle="Daily check-in / out log — add or correct records" Icon={Clock3} action={<PrimaryBtn onClick={() => setModal(true)}><Plus size={16} /> Add record</PrimaryBtn>} />
      {(() => {
        // Read-only attendance snapshot for the selected day.
        const presentCount = present.size; const totalStaff = store.staff.length;
        const pct = totalStaff > 0 ? Math.round((presentCount / totalStaff) * 100) : 0;
        const out = recs.filter(r => r.in && r.out).length;
        return (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <input type="date" value={day} onChange={e => setDay(e.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium outline-none" />
            <div className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200"><Search size={15} className="text-slate-400" /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name or dept…" className="bg-transparent text-sm outline-none" /></div>
            <span className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700 ring-1 ring-emerald-200"><UserCheck size={13} /> {presentCount} present</span>
            <span className="flex items-center gap-1.5 rounded-full bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-600 ring-1 ring-slate-200"><Users size={13} /> {totalStaff} staff</span>
            <span className="flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1.5 text-xs font-bold text-blue-700 ring-1 ring-blue-200"><TrendingUp size={13} /> {pct}% in</span>
            <span className="flex items-center gap-1.5 rounded-full bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-500 ring-1 ring-slate-200"><LogOut size={13} /> {out} done</span>
          </div>
        );
      })()}
      <div className="overflow-x-auto overflow-y-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 fade-up [-webkit-overflow-scrolling:touch] md:overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3">Staff</th><th className="px-5 py-3">Dept</th><th className="px-5 py-3">Site</th><th className="px-5 py-3">In</th><th className="px-5 py-3">Out</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Action</th></tr></thead>
          <tbody>
            {paged.slice.map(s => { const r = recs.find(c => c.staffId === s.id); const checkedIn = r && r.in; return (
              <tr key={s.id} className="border-t border-slate-100 transition-colors duration-150 hover:bg-blue-50/40">
                <td className="px-5 py-3"><div className="flex items-center gap-2.5"><span className="flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-sm" style={{ background: s.colour }}>{s.initials}</span><span className="font-semibold text-slate-700">{s.name}</span></div></td>
                <td className="px-5 py-3 text-slate-500">{s.dept}</td>
                <td className="px-5 py-3">{r?.site ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600">{r.site}</span> : <span className="text-slate-300">—</span>}</td>
                <td className="px-5 py-3 font-medium text-slate-600">{r?.in || "—"}</td><td className="px-5 py-3 font-medium text-slate-600">{r?.out || (checkedIn ? "in" : "—")}</td>
                <td className="px-5 py-3"><span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${checkedIn ? (r.out ? "bg-slate-100 text-slate-500" : "bg-emerald-100 text-emerald-700") : "bg-rose-100 text-rose-600"}`}>{checkedIn ? (r.out ? "Complete" : "Present") : "Absent"}</span></td>
                <td className="px-5 py-3">{checkedIn && !r.out ? <button onClick={() => setOut(r)} className="text-xs font-bold text-blue-600 hover:underline">Check out</button> : <button onClick={() => { setForm({ staffId: s.id, in: r?.in || "09:00", out: r?.out || "", site: r?.site || "" }); setModal(true); }} className="text-xs font-bold text-slate-400 hover:text-slate-600">Edit</button>}</td>
              </tr>
            ); })}
            {paged.slice.length === 0 && <tr><td colSpan={7} className="px-5 py-10"><EmptyState Icon={Search} title="No staff match" msg="Try a different name or department." /></td></tr>}
          </tbody>
        </table>
      </div>
      <Pagination className="mt-4" page={paged.page} setPage={paged.setPage} totalPages={paged.totalPages} total={paged.total} />
      <Modal open={modal} onClose={() => setModal(false)} title="Add / edit check-in">
        <div className="space-y-3">
          <Field label="Staff member"><select value={form.staffId} onChange={e => setForm(f => ({ ...f, staffId: e.target.value }))} className={inputCls}><option value="">Choose…</option>{store.staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Time in"><input type="time" value={form.in} onChange={e => setForm(f => ({ ...f, in: e.target.value }))} className={inputCls} /></Field><Field label="Time out (optional)"><input type="time" value={form.out} onChange={e => setForm(f => ({ ...f, out: e.target.value }))} className={inputCls} /></Field></div>
          <Field label="Site (optional)"><select value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))} className={inputCls}><option value="">—</option>{SITES.map(s => <option key={s} value={s}>{s}</option>)}</select></Field>
          <p className="text-xs text-slate-400">Date: {fmtDate(day)}</p>
          <PrimaryBtn onClick={addCheckin} className="w-full"><Save size={16} /> Save record</PrimaryBtn>
        </div>
      </Modal>
    </>
  );
}

/* ----- Dashboard: Holiday Balances ----- */
function AdminBalances({ store }) {
  const [adjModal, setAdjModal] = useState(null); // staff obj
  const [editModal, setEditModal] = useState(null);
  const [adj, setAdj] = useState({ days: 1, note: "", date: "" });
  const [alw, setAlw] = useState(28);
  const [query, setQuery] = useState("");
  const applyAdj = async () => { await store.adjustBalance(adjModal.id, Number(adj.days), adj.note, adj.date || undefined); setAdjModal(null); setAdj({ days: 1, note: "", date: "" }); };
  // Undo an adjustment filed in error, with a confirm.
  const removeAdj = async (a) => { if (!window.confirm(`Delete this ${a.days >= 0 ? "+" : ""}${a.days}d adjustment${a.note ? ` — "${a.note}"` : ""}? This cannot be undone.`)) return; await store.removeAdjustment(a.id); };
  const saveAlw = async () => { await store.setAllowance(editModal.id, Number(alw)); setEditModal(null); };
  const ql = query.trim().toLowerCase();
  const filteredStaff = store.staff.filter(s => !ql || s.name.toLowerCase().includes(ql) || (s.dept || "").toLowerCase().includes(ql));
  const paged = usePaged(filteredStaff, 12, ql);
  const exportBalances = () => {
    // The bank-holiday ENTITLEMENT (8), not how many have elapsed. The elapsed
    // count made the row fail to add up (Base - Used - Bank != Remaining) and
    // drifted upward all year, so two exports never agreed.
    const bank = store.bankHolidayTotal;
    const rows = store.staff.map(s => { const base = s.allowance; const adjv = store.adjDays(s.id); const used = store.usedDays(s.id); const remaining = store.remaining(s.id); return { staff: s.name, dept: s.dept, base, adj: adjv, used, bank, remaining }; });
    downloadCSV("holiday-balances.csv", [
      { key: "staff", label: "Staff" }, { key: "dept", label: "Dept" }, { key: "base", label: "Base allowance" }, { key: "adj", label: "Adjustments" }, { key: "used", label: "Leave used" }, { key: "bank", label: "Bank holidays" }, { key: "remaining", label: "Remaining" },
    ], rows);
    store.notify("Exported holiday balances CSV");
  };
  return (
    <>
      <AdminHeader title="Holiday Balances" subtitle="Set allowances and apply adjustments — staff see changes instantly" Icon={Check} action={(() => {
        // Read-only org-wide totals over the BOOKABLE pot (bank holidays excluded).
        const totalAllow = store.staff.reduce((a, s) => a + store.bookableAllowance(s.id), 0);
        const totalConsumed = store.staff.reduce((a, s) => a + store.usedDays(s.id), 0);
        const pct = totalAllow > 0 ? Math.round((totalConsumed / totalAllow) * 100) : 0;
        return <div className="flex flex-wrap items-center gap-2"><span className="flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1.5 text-xs font-bold text-blue-700 ring-1 ring-blue-200"><Layers size={13} /> {totalConsumed}/{totalAllow}d used</span><span className="flex items-center gap-1.5 rounded-full bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-600 ring-1 ring-slate-200"><Activity size={13} /> {pct}% org</span><ExportBtn onClick={exportBalances} /></div>;
      })()} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200"><Search size={15} className="text-slate-400" /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name or dept…" className="bg-transparent text-sm outline-none" /></div>
      </div>
      <div className="overflow-x-auto overflow-y-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 fade-up [-webkit-overflow-scrolling:touch] md:overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3">Staff</th><th className="px-5 py-3">Base</th><th className="px-5 py-3">Adj</th><th className="px-5 py-3">Used</th><th className="px-5 py-3">Bank</th><th className="px-5 py-3">Remaining</th><th className="px-5 py-3 w-40">Usage</th><th className="px-5 py-3">Actions</th></tr></thead>
          <tbody>
            {paged.slice.map(s => { const bookable = store.bookableAllowance(s.id); const used = store.usedDays(s.id); const bank = store.bankHolidayTotal; const left = store.remaining(s.id); const adjv = store.adjDays(s.id); const pct = bookable > 0 ? Math.round(used / bookable * 100) : 0; return (
              <tr key={s.id} className="border-t border-slate-100 transition-colors duration-150 hover:bg-blue-50/40">
                <td className="px-5 py-3"><div className="flex items-center gap-2.5"><span className="flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-sm" style={{ background: s.colour }}>{s.initials}</span><div><p className="font-semibold text-slate-700">{s.name}</p><p className="text-[11px] text-slate-400">{s.dept}</p></div></div></td>
                <td className="px-5 py-3 font-medium text-slate-600">{s.allowance}d</td>
                <td className="px-5 py-3 font-medium" style={{ color: adjv > 0 ? "#059669" : adjv < 0 ? MAROON : "#94a3b8" }}>{adjv > 0 ? "+" : ""}{adjv}d</td>
                <td className="px-5 py-3 font-medium" style={{ color: MAROON }}>{used}d</td>
                <td className="px-5 py-3 font-medium" style={{ color: NAVY }}>{bank}d</td>
                <td className="px-5 py-3 font-bold text-emerald-600">{left}d</td>
                <td className="px-5 py-3"><div className="h-2 overflow-hidden rounded-full bg-slate-100 shadow-inner"><div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct > 80 ? `linear-gradient(90deg, ${MAROON}, #c2334d)` : `linear-gradient(90deg, ${NAVY}, #2c54b8)`, transition: "width .8s cubic-bezier(.4,0,.2,1)" }} /></div></td>
                <td className="px-5 py-3"><div className="flex gap-1"><button onClick={() => { setEditModal(s); setAlw(s.allowance); }} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" title="Edit allowance"><Edit3 size={15} /></button><button onClick={() => setAdjModal(s)} className="rounded-lg p-1.5 text-blue-500 hover:bg-blue-50" title="Adjust days"><SlidersHorizontal size={15} /></button></div></td>
              </tr>
            ); })}
            {paged.slice.length === 0 && <tr><td colSpan={8} className="px-5 py-10"><EmptyState Icon={Search} title="No staff match" msg="Try a different name or department." /></td></tr>}
          </tbody>
        </table>
      </div>
      <Pagination className="mt-4" page={paged.page} setPage={paged.setPage} totalPages={paged.totalPages} total={paged.total} />
      {store.adjustments.length > 0 && <div className="mt-5 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70 fade-up"><p className="mb-3 text-sm font-bold text-slate-700">Adjustment history</p><div className="space-y-2">{store.adjustments.slice().reverse().map(a => { const s = store.staff.find(x => x.id === a.staffId); return <div key={a.id} className="flex items-center gap-3 text-sm"><span className="font-semibold" style={{ color: a.days >= 0 ? "#059669" : MAROON }}>{a.days >= 0 ? "+" : ""}{a.days}d</span><span className="text-slate-700">{s?.name}</span><span className="text-slate-400">— {a.note}</span><span className="ml-auto text-xs text-slate-400">{fmtDate(a.date)}</span><button onClick={() => removeAdj(a)} title="Delete adjustment" className="rounded-lg p-1 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"><Trash2 size={14} /></button></div>; })}</div></div>}
      <Modal open={!!adjModal} onClose={() => setAdjModal(null)} title={`Adjust days — ${adjModal?.name || ""}`}>
        <div className="space-y-3">
          <Field label="Days (use negative to deduct)"><div className="flex items-center gap-2"><button onClick={() => setAdj(a => ({ ...a, days: a.days - 1 }))} className="rounded-lg bg-slate-100 p-2 hover:bg-slate-200"><MinusCircle size={18} /></button><input type="number" value={adj.days} onChange={e => setAdj(a => ({ ...a, days: e.target.value }))} className={inputCls + " text-center"} /><button onClick={() => setAdj(a => ({ ...a, days: Number(a.days) + 1 }))} className="rounded-lg bg-slate-100 p-2 hover:bg-slate-200"><PlusCircle size={18} /></button></div></Field>
          <Field label="Reason"><input value={adj.note} onChange={e => setAdj(a => ({ ...a, note: e.target.value }))} placeholder="e.g. Long-service bonus day" className={inputCls} /></Field>
          {/* Optional: file the adjustment against a specific leave year; blank = today. */}
          <Field label="Date (optional)"><input type="date" value={adj.date} onChange={e => setAdj(a => ({ ...a, date: e.target.value }))} className={inputCls} /></Field>
          <PrimaryBtn onClick={applyAdj} className="w-full"><Check size={16} /> Apply adjustment</PrimaryBtn>
        </div>
      </Modal>
      <Modal open={!!editModal} onClose={() => setEditModal(null)} title={`Edit allowance — ${editModal?.name || ""}`}>
        <div className="space-y-3"><Field label="Annual allowance (days)"><input type="number" value={alw} onChange={e => setAlw(e.target.value)} className={inputCls} /></Field><PrimaryBtn onClick={saveAlw} className="w-full"><Save size={16} /> Save</PrimaryBtn></div>
      </Modal>
    </>
  );
}

/* ----- Dashboard: Calendar ----- */
function AdminCalendar({ store }) {
  const [modal, setModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ staffId: "", type: "annual", start: todayISO(), end: todayISO(), reason: "" });

  // No pre-selected staff member: the dropdown starts on "Choose…" so an admin can't
  // book an approved absence onto whoever happens to be first in the list.
  const openAdd = () => { setForm({ staffId: "", type: "annual", start: todayISO(), end: todayISO(), reason: "" }); setModal(true); };
  const spanDays = daysBetween(form.start, form.end);          // calendar length
  const days = store.chargeableDays(form.start, form.end);     // working days actually charged
  const staff = store.staff.find(s => s.id === form.staffId);
  const remaining = form.staffId ? store.remaining(form.staffId) : 0;
  // A range that's all weekends/bank holidays has no working day to book — block it.
  const nothingToBook = !!form.staffId && days === 0;
  // Paid types draw down the allowance; unpaid does not. Block over-allowance before
  // creating anything, so a rejected approval never leaves a dangling pending request.
  const overflow = form.type !== "unpaid" && form.staffId ? store.overflowYear(form.staffId, form.start, form.end) : null;
  const overAllowance = !!overflow;
  const blocked = !form.staffId || nothingToBook || overAllowance;

  // A ref, not just `busy` state: two taps in the same tick both read the old state,
  // but both see the ref — and each tap creates a separate approved booking.
  const addingRef = useRef(false);
  const addHoliday = async () => {
    if (blocked || addingRef.current) return;
    addingRef.current = true;
    setBusy(true);
    try {
      await store.addApprovedLeave({ staffId: form.staffId, type: form.type, start: form.start, end: form.end, reason: form.reason.trim() || "Added by admin" });
      setModal(false);
    } catch (_) { /* store toasts the error and refetches; keep the modal open */ }
    finally { addingRef.current = false; setBusy(false); }
  };

  return (
    <>
      <AdminHeader title="Holiday Calendar" subtitle="Organisation-wide view of approved absences — click any day to see who is off" Icon={CalendarDays}
        action={<PrimaryBtn onClick={openAdd}><Plus size={16} /> Add holiday</PrimaryBtn>} />
      <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70 fade-up">
        <MonthGrid store={store} big showPending />
        <div className="mt-4 border-t border-slate-100 pt-4"><p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-slate-400">Leave types</p><LeaveLegend />
          <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-500"><span className="h-2.5 w-2.5 shrink-0 rounded-full bg-amber-400" /> Bank holiday — a fixed day off for all staff, separate from the bookable allowance</div>
        </div>
      </div>
      <BankHolidayList store={store} />

      <Modal open={modal} onClose={() => setModal(false)} title="Add holiday">
        <div className="space-y-3">
          <Field label="Staff member"><select value={form.staffId} onChange={e => setForm(f => ({ ...f, staffId: e.target.value }))} className={inputCls}><option value="">Choose…</option>{store.staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="Type"><select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} className={inputCls}>{LEAVE_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}</select></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="From"><input type="date" value={form.start} onChange={e => setForm(f => ({ ...f, start: e.target.value, end: e.target.value > f.end ? e.target.value : f.end }))} className={inputCls} /></Field>
            <Field label="To"><input type="date" value={form.end} min={form.start} onChange={e => setForm(f => ({ ...f, end: e.target.value }))} className={inputCls} /></Field>
          </div>
          <Field label="Reason"><input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} placeholder="Optional" className={inputCls} /></Field>
          <div className="rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500 ring-1 ring-slate-100">
            Added as an <b>approved</b> absence — it appears on the calendar straight away. Weekends and bank holidays in the range aren't charged.{" "}
            {form.type === "unpaid" ? "Unpaid leave doesn't use the holiday allowance." : staff ? `${days} working day${days === 1 ? "" : "s"} charged${spanDays !== days ? ` (of ${spanDays} selected)` : ""} · ${remaining}d allowance left.` : ""}
          </div>
          {nothingToBook
            ? <p className="rounded-lg bg-rose-50 px-3 py-2 text-[11px] font-semibold text-rose-600">Those dates are all weekends and/or bank holidays — there are no working days to book.</p>
            : overAllowance && <p className="rounded-lg bg-rose-50 px-3 py-2 text-[11px] font-semibold text-rose-600">Not enough {overflow.year} allowance: {overflow.left}d left but {overflow.cost}d needed. Choose Unpaid Leave, or a shorter period.</p>}
          <PrimaryBtn onClick={addHoliday} disabled={busy || blocked} className="w-full"><Plus size={16} /> {busy ? "Adding…" : "Add holiday"}</PrimaryBtn>
        </div>
      </Modal>
    </>
  );
}

/* ----- Dashboard: Leave Requests ----- */
function AdminRequests({ store }) {
  const [filter, setFilter] = useState("all");
  const [modal, setModal] = useState(false);
  // The row currently being approved/declined, so a double-click can't fire a second
  // decideLeave (which 409s on an already-decided request and toasts an error).
  const [decidingId, setDecidingId] = useState(null);
  // No hard-coded staff id: "s1" was a leftover demo id, so the dropdown showed the
  // first real person while the form still held "s1" and the server rejected it as an
  // unknown staff member. Default to nothing and require an explicit choice.
  const [form, setForm] = useState({ staffId: "", type: "annual", start: todayISO(), end: todayISO(), reason: "" });
  const reqDays = store.chargeableDays(form.start, form.end);
  const reqRemaining = form.staffId ? store.remaining(form.staffId) : 0;
  const reqNothing = !!form.staffId && reqDays === 0;
  const reqOverflow = form.type !== "unpaid" && form.staffId ? store.overflowYear(form.staffId, form.start, form.end) : null;
  const reqOver = !!reqOverflow;
  const reqBlocked = !form.staffId || reqNothing || reqOver;
  const create = async () => {
    if (reqBlocked) return;
    try { await store.requestLeave({ staffId: form.staffId, type: form.type, start: form.start, end: form.end, reason: form.reason }); setModal(false); }
    catch (_) { /* store toasts; keep the modal open so the admin can adjust */ }
  };
  const decide = async (l, status) => {
    if (decidingId) return;              // a request is already in flight
    setDecidingId(l.id);
    try { await store.decideLeave(l.id, status); }
    catch (_) { /* store toasts the failure */ }
    finally { setDecidingId(null); }
  };
  const list = store.leave.filter(l => filter === "all" ? true : l.status === filter).slice().reverse();
  const counts = { all: store.leave.length, pending: store.leave.filter(l => l.status === "pending").length, approved: store.leave.filter(l => l.status === "approved").length, rejected: store.leave.filter(l => l.status === "rejected").length };
  const paged = usePaged(list, 10, filter);
  const exportRequests = () => {
    const rows = list.map(l => { const p = store.staff.find(s => s.id === l.staffId); const t = leaveTypeMeta(l.type); return { staff: p?.name || "Unknown", type: t.label, start: l.start, end: l.end, days: store.chargeableDays(l.start, l.end), status: l.status, reason: l.reason }; });
    downloadCSV("leave-requests.csv", [
      { key: "staff", label: "Staff name" }, { key: "type", label: "Type" }, { key: "start", label: "Start" }, { key: "end", label: "End" }, { key: "days", label: "Days" }, { key: "status", label: "Status" }, { key: "reason", label: "Reason" },
    ], rows);
    store.notify("Exported leave requests CSV");
  };
  return (
    <>
      <AdminHeader title="Leave Requests" subtitle="Full register — create on behalf of staff or review existing" Icon={Inbox} action={<div className="flex flex-wrap items-center gap-2"><ExportBtn onClick={exportRequests} /><PrimaryBtn onClick={() => setModal(true)}><Plus size={16} /> New request</PrimaryBtn></div>} />
      <div className="mb-4 flex flex-wrap gap-2">{["all", "pending", "approved", "rejected"].map(f => <button key={f} onClick={() => setFilter(f)} className={`rounded-full px-3.5 py-1.5 text-xs font-bold capitalize transition-all duration-200 hover:-translate-y-0.5 active:scale-95 ${filter === f ? "text-white shadow-md" : "bg-white text-slate-500 ring-1 ring-slate-200 hover:ring-slate-300"}`} style={filter === f ? { background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` } : {}}>{f} <span className="opacity-70">({counts[f]})</span></button>)}</div>
      <div className="space-y-3">
        {list.length === 0 && <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200"><EmptyState Icon={Inbox} title="No requests here" msg={filter === "all" ? "Leave requests will appear here." : `No ${filter} requests right now.`} /></div>}
        {paged.slice.map((l, i) => { const p = store.staff.find(s => s.id === l.staffId); const t = leaveTypeMeta(l.type); const T = t.icon; return (
          <div key={l.id} className="flex flex-col gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/70 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md hover:ring-slate-300/80 sm:flex-row sm:items-center fade-up" style={{ animationDelay: `${i * 45}ms` }}>
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white shadow-sm" style={{ background: p?.colour }}>{p?.initials}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><p className="font-bold text-slate-700">{p?.name}</p><span className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: t.colour + "1a", color: t.colour }}><T size={11} /> {t.label}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold capitalize ${statusBadge(l.status)}`}>{l.status}</span></div>
              <p className="mt-1 text-sm text-slate-500">{fmtDate(l.start)}{l.end !== l.start && ` → ${fmtDate(l.end)}`} · <b>{store.chargeableDays(l.start, l.end)}d</b> · <span className="italic">"{l.reason}"</span></p>
            </div>
            {l.status === "pending" && <div className="flex gap-2"><button disabled={decidingId === l.id} onClick={() => decide(l, "rejected")} className="flex items-center gap-1 rounded-xl border-2 border-rose-200 px-3 py-2 text-sm font-bold text-rose-600 hover:bg-rose-50 disabled:opacity-50"><XCircle size={15} /> Decline</button><PrimaryBtn colour="#059669" disabled={decidingId === l.id} onClick={() => decide(l, "approved")} className="!py-2"><CheckCircle2 size={15} /> Approve</PrimaryBtn></div>}
          </div>
        ); })}
      </div>
      <Pagination className="mt-4" page={paged.page} setPage={paged.setPage} totalPages={paged.totalPages} total={paged.total} />
      <Modal open={modal} onClose={() => setModal(false)} title="New leave request">
        <div className="space-y-3">
          <Field label="Staff member"><select value={form.staffId} onChange={e => setForm(f => ({ ...f, staffId: e.target.value }))} className={inputCls}><option value="">Choose…</option>{store.staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="Type"><select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} className={inputCls}>{LEAVE_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}</select></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="From"><input type="date" value={form.start} onChange={e => setForm(f => ({ ...f, start: e.target.value, end: e.target.value > f.end ? e.target.value : f.end }))} className={inputCls} /></Field><Field label="To"><input type="date" value={form.end} min={form.start} onChange={e => setForm(f => ({ ...f, end: e.target.value }))} className={inputCls} /></Field></div>
          <Field label="Reason"><input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} className={inputCls} /></Field>
          {/* Same pre-checks as the staff app, so the admin sees the cost and any
              problem before the server rejects the request. */}
          <div className="rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500 ring-1 ring-slate-100">
            Created as a <b>pending</b> request for approval. Weekends and bank holidays aren't charged.{" "}
            {form.type === "unpaid" ? "Unpaid leave doesn't use the holiday allowance." : form.staffId ? `${reqDays} working day${reqDays === 1 ? "" : "s"} · ${reqRemaining}d allowance left.` : "Choose a staff member."}
          </div>
          {reqNothing && <p className="rounded-lg bg-rose-50 px-3 py-2 text-[11px] font-semibold text-rose-600">Those dates are all weekends and/or bank holidays — there are no working days to book.</p>}
          {reqOver && <p className="rounded-lg bg-rose-50 px-3 py-2 text-[11px] font-semibold text-rose-600">Not enough {reqOverflow.year} allowance: {reqOverflow.left}d left but {reqOverflow.cost}d needed. Choose Unpaid Leave, or a shorter period.</p>}
          <PrimaryBtn onClick={create} disabled={reqBlocked} className="w-full"><Plus size={16} /> Create request</PrimaryBtn>
        </div>
      </Modal>
    </>
  );
}

/* ----- Dashboard: Documents ----- */
function AdminDocuments({ store }) {
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ name: "", type: "Policy", scope: "all", assignedTo: "" });
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState("");
  // The document created on this modal's first Publish click. Held so a retry after a
  // failed upload re-uploads against it instead of creating a duplicate record.
  const [publishedId, setPublishedId] = useState(null);
  // Create the record, then upload the file against it. Two steps because the file is
  // stored under the document's id — so the record has to exist first — and because a
  // document without a file is still a valid record (that is how every existing one
  // works), so a failed upload must not lose the document the admin just described.
  const add = async () => {
    if (!form.name.trim()) return;
    setUploading(true); setUploadErr("");
    try {
      // If the record was already created on a previous attempt (the file upload failed
      // and the modal stayed open to retry), do NOT create a second one — re-upload
      // against the existing id. Creating on every click left a duplicate: doc #1 with
      // no file, doc #2 with the file.
      let docId = publishedId;
      if (!docId) {
        const doc = await store.addDoc({ name: form.name, type: form.type, scope: form.scope, assignedTo: form.assignedTo });
        docId = doc?.id;
        if (docId) setPublishedId(docId);
      }
      if (file && docId) {
        try { await store.uploadDocumentFile(docId, file); }
        catch (e) {
          // The document exists; only the file failed. Say exactly that and leave the
          // modal open — the next click retries the UPLOAD (publishedId is set), it
          // does not publish a second document.
          setUploadErr(`"${form.name}" was published, but the file didn't upload: ${e.message}. Tap Publish again to retry the upload.`);
          setUploading(false);
          return;
        }
      }
      setModal(false);
      setForm({ name: "", type: "Policy", scope: "all", assignedTo: "" });
      setFile(null); setPublishedId(null);
    } finally { setUploading(false); }
  };
  const openDoc = async (d) => {
    try {
      const { url } = await store.documentDownloadUrl(d.id);
      // "_system" on native so the OS browser/downloader gets the signed URL, rather
      // than it loading inside the Capacitor WebView — matches the app's own
      // external-open convention (see TwoFactor.jsx).
      const native = typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.() === true;
      window.open(url, native ? "_system" : "_blank", "noopener,noreferrer");
    } catch (e) { store.notify(e.message || "Could not open that document", "error"); }
  };
  // Attach (or replace) a file on an EXISTING document, from its card. Without this the
  // only way to give a fileless document a file was delete-and-recreate.
  const attachFile = async (d, f) => {
    if (!f) return;
    if (f.size > MAX_UPLOAD_BYTES) { store.notify(`That file is ${fmtBytes(f.size)} — the limit is ${fmtBytes(MAX_UPLOAD_BYTES)}.`, "error"); return; }
    try { await store.uploadDocumentFile(d.id, f); store.notify(`File attached to "${d.name}"`, "success"); }
    catch (e) { store.notify(e.message || "Could not attach the file", "error"); }
  };
  const del = (d) => {
    const who = d.scope === "personal" ? "a personal document" : "shared with all staff";
    if (!window.confirm(`Delete "${d.name}"?\n\nThis is ${who} and will be removed for everyone who can see it. This cannot be undone.`)) return;
    return store.deleteDoc(d.id);
  };
  const iconFor = (t) => ({ Policy: FileText, Payroll: Briefcase, Calendar: CalendarDays, HR: Users, Form: ClipboardList }[t] || FileText);
  return (
    <>
      <AdminHeader title="Documents" subtitle="Publish documents to all staff or assign privately" Icon={FileText} action={<PrimaryBtn onClick={() => { setForm({ name: "", type: "Policy", scope: "all", assignedTo: "" }); setFile(null); setPublishedId(null); setUploadErr(""); setModal(true); }}><FileUp size={16} /> Upload</PrimaryBtn>} />
      <div className="mb-4 flex flex-wrap gap-2">
        <span className="flex items-center gap-1.5 rounded-full bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-600 ring-1 ring-slate-200"><Layers size={13} /> {store.docs.length} total</span>
        <span className="flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1.5 text-xs font-bold text-blue-700 ring-1 ring-blue-200"><Users size={13} /> {store.docs.filter(d => d.scope === "all").length} all-staff</span>
        <span className="flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-700 ring-1 ring-amber-200"><ShieldCheck size={13} /> {store.docs.filter(d => d.scope !== "all").length} private</span>
      </div>
      {store.docs.length === 0 && <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200"><EmptyState Icon={FileUp} title="No documents yet" msg="Upload a policy, form or payslip to share with staff." /></div>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {store.docs.map((d, i) => { const I = iconFor(d.type); const dc = docTypeColour(d.type); const assignee = d.assignedTo ? store.staff.find(s => s.id === d.assignedTo) : null; return (
          <div key={d.id} className="hover-lift group rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/70 transition-all duration-300 hover:shadow-lg hover:ring-slate-300/80 fade-up" style={{ animationDelay: `${i * 40}ms` }}>
            <div className="flex items-start gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-xl shadow-sm transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6" style={{ background: dc + "14" }}><I size={20} style={{ color: dc }} /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-slate-700">{d.name}</p><p className="text-xs text-slate-400">{fmtDate(d.date)}{d.hasFile && d.sizeBytes ? ` · ${fmtBytes(d.sizeBytes)}` : ""}</p></div><button onClick={() => del(d)} className="rounded-lg p-1.5 text-slate-300 opacity-0 transition hover:bg-rose-50 hover:text-rose-500 group-hover:opacity-100"><Trash2 size={15} /></button></div>
            <div className="mt-3 flex flex-wrap gap-1.5"><span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: dc + "1a", color: dc }}>{d.type}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${d.scope === "all" ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700"}`}>{d.scope === "all" ? "All staff" : assignee ? `Private · ${assignee.name.split(" ")[0]}` : "Personal template"}</span></div>
            {/* A file-bearing document opens; a fileless one (created before uploads
                existed, or whose upload failed) can now have a file ATTACHED from here
                rather than only by delete-and-recreate. */}
            {d.hasFile ? (
              <div className="mt-3 flex gap-2">
                <button onClick={() => openDoc(d)} className="press flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-slate-200 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50"><Download size={14} /> Open file</button>
                <label className="press flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-slate-200 px-2.5 py-2 text-xs font-bold text-slate-500 transition hover:bg-slate-50" title="Replace the file">
                  <FileUp size={14} />
                  <input type="file" className="hidden" onChange={(e) => attachFile(d, e.target.files?.[0])} />
                </label>
              </div>
            ) : (
              <label className="press mt-3 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-300 py-2 text-xs font-bold text-slate-500 transition hover:bg-slate-50">
                <FileUp size={14} /> Attach a file
                <input type="file" className="hidden" onChange={(e) => attachFile(d, e.target.files?.[0])} />
              </label>
            )}
          </div>
        ); })}
      </div>
      <Modal open={modal} onClose={() => { setModal(false); setPublishedId(null); setFile(null); setUploadErr(""); }} title="Upload document">
        <div className="space-y-3">
          <Field label="Document name"><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Fire Safety Policy 2026" className={inputCls} /></Field>
          <Field label="Type"><select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} className={inputCls}>{DOC_TYPES.map(t => <option key={t}>{t}</option>)}</select></Field>
          <Field label="Visibility"><select value={form.scope} onChange={e => setForm(f => ({ ...f, scope: e.target.value }))} className={inputCls}><option value="all">All staff</option><option value="personal">Private (one person)</option></select></Field>
          {form.scope === "personal" && <Field label="Assign to"><select value={form.assignedTo} onChange={e => setForm(f => ({ ...f, assignedTo: e.target.value }))} className={inputCls}><option value="">Select staff…</option>{store.staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
          <Field label="File (optional)">
            <label className={`flex cursor-pointer flex-col items-center gap-1 rounded-xl border-2 border-dashed py-5 text-center text-xs transition ${file ? "border-emerald-300 bg-emerald-50/50 text-emerald-700" : "border-slate-200 text-slate-400 hover:border-slate-300 hover:bg-slate-50"}`}>
              <input
                type="file" className="hidden" disabled={uploading}
                onChange={(e) => { const f = e.target.files?.[0] || null; setUploadErr(""); if (f && f.size > MAX_UPLOAD_BYTES) { setUploadErr(`That file is ${fmtBytes(f.size)} — the limit is ${fmtBytes(MAX_UPLOAD_BYTES)}.`); setFile(null); } else setFile(f); }}
              />
              {file
                ? <><Check size={20} className="text-emerald-600" /><span className="max-w-full truncate px-3 font-semibold">{file.name}</span><span className="text-[10px] opacity-70">{fmtBytes(file.size)} · click to change</span></>
                : <><FileUp size={20} className="text-slate-300" /><span>Choose a file to upload</span><span className="text-[10px]">PDF, Word, Excel or image · up to {fmtBytes(MAX_UPLOAD_BYTES)}</span></>}
            </label>
          </Field>
          {uploadErr && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600">{uploadErr}</p>}
          <PrimaryBtn onClick={add} disabled={!form.name.trim() || uploading} className="w-full">
            {uploading ? <><Loader size={16} /> {file ? "Uploading…" : "Publishing…"}</> : <><Check size={16} /> Publish document</>}
          </PrimaryBtn>
        </div>
      </Modal>
    </>
  );
}

/* ----- Dashboard: Approvals ----- */
function AdminApprovals({ store }) {
  const [noteModal, setNoteModal] = useState(null); // {leave, action}
  const [note, setNote] = useState("");
  const pending = store.leave.filter(l => l.status === "pending");
  const history = store.leave.filter(l => l.status !== "pending").slice().reverse();
  const confirm = async () => { await store.decideLeave(noteModal.leave.id, noteModal.action, note); setNoteModal(null); setNote(""); };
  return (
    <>
      <AdminHeader title="Approvals" subtitle="Approve or decline with a note — decisions sync to the staff app" Icon={ThumbsUp} />
      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-sm font-bold text-slate-700">Pending ({pending.length})</p>
          <div className="space-y-3">
            {pending.length === 0 && <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200"><EmptyState Icon={CheckCircle2} title="Nothing to approve" msg="You're all caught up." /></div>}
            {pending.map((l, i) => { const p = store.staff.find(s => s.id === l.staffId); const t = leaveTypeMeta(l.type); const T = t.icon; return (
              <div key={l.id} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/70 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md hover:ring-slate-300/80 fade-up" style={{ animationDelay: `${i * 50}ms` }}>
                <div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-full text-xs font-bold text-white shadow-sm" style={{ background: p?.colour }}>{p?.initials}</span><div className="flex-1"><p className="text-sm font-bold text-slate-700">{p?.name}</p><p className="text-xs text-slate-400">{p?.role}</p></div><span className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: t.colour + "1a", color: t.colour }}><T size={11} /> {t.label}</span></div>
                <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600"><p><b>{fmtDate(l.start)}</b>{l.end !== l.start && <> → <b>{fmtDate(l.end)}</b></>} · {store.chargeableDays(l.start, l.end)}d</p><p className="mt-1 italic text-slate-500">"{l.reason}"</p></div>
                <div className="mt-3 grid grid-cols-2 gap-2"><button onClick={() => { setNoteModal({ leave: l, action: "rejected" }); setNote(""); }} className="flex items-center justify-center gap-1.5 rounded-xl border-2 border-rose-200 py-2.5 text-sm font-bold text-rose-600 hover:bg-rose-50"><XCircle size={16} /> Decline</button><PrimaryBtn colour="#059669" onClick={() => { setNoteModal({ leave: l, action: "approved" }); setNote(""); }} className="!py-2.5"><CheckCircle2 size={16} /> Approve</PrimaryBtn></div>
              </div>
            ); })}
          </div>
        </div>
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-sm font-bold text-slate-700"><History size={15} /> Decision history</p>
          <div className="space-y-2">
            {history.length === 0 && <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200"><EmptyState Icon={History} title="No decisions yet" msg="Approved and declined requests will be logged here." /></div>}
            {history.map((l, i) => { const p = store.staff.find(s => s.id === l.staffId); const t = leaveTypeMeta(l.type); return (
              <div key={l.id} className="rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200/70 transition-colors duration-200 hover:bg-slate-50/60 fade-up" style={{ animationDelay: `${i * 35}ms` }}>
                <div className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ background: p?.colour }}>{p?.initials}</span><span className="text-sm font-semibold text-slate-700">{p?.name}</span><span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold capitalize ${statusBadge(l.status)}`}>{l.status}</span></div>
                <p className="mt-1.5 text-xs text-slate-500">{t.label} · {fmtDate(l.start)}{l.end !== l.start && ` → ${fmtDate(l.end)}`}{l.note && <> · <span className="italic">"{l.note}"</span></>}</p>
              </div>
            ); })}
          </div>
        </div>
      </div>
      <Modal open={!!noteModal} onClose={() => setNoteModal(null)} title={noteModal?.action === "approved" ? "Approve request" : "Decline request"}>
        <div className="space-y-3"><Field label="Note to staff member (optional)"><textarea value={note} onChange={e => setNote(e.target.value)} rows={3} placeholder={noteModal?.action === "approved" ? "e.g. Enjoy your time off!" : "e.g. Clashes with exam week — please rebook."} className={inputCls + " resize-none"} /></Field><PrimaryBtn colour={noteModal?.action === "approved" ? "#059669" : MAROON} onClick={confirm} className="w-full">{noteModal?.action === "approved" ? <><CheckCircle2 size={16} /> Confirm approval</> : <><XCircle size={16} /> Confirm decline</>}</PrimaryBtn></div>
      </Modal>
    </>
  );
}

/* ----- Dashboard: Sign-Up Requests ----- */
// Self-service sign-ups from the staff mobile app. Approving here is what
// actually creates the staff account — until then the applicant has no login.
function AdminSignups({ store }) {
  const [modal, setModal] = useState(null); // { req, action }
  const [note, setNote] = useState("");
  const [allowance, setAllowance] = useState(28);
  const [busy, setBusy] = useState(false);
  // What the applicant typed, editable before approving. People mistype their own
  // name, department and college ID, and the only remedy used to be approving and
  // then correcting the account — or rejecting and making them start over.
  const [edit, setEdit] = useState(null);

  const rows = store.signups || [];
  const pending = rows.filter(r => r.status === "pending");
  const history = rows.filter(r => r.status !== "pending");

  const open = (req, action) => {
    setModal({ req, action });
    setNote("");
    setAllowance(28);
    setEdit({
      name: req.name || "", email: req.email || "",
      jobTitle: req.role || "", dept: req.dept || "",
      site: req.site || "", collegeId: req.collegeId || "",
    });
  };

  // Keep the corrections on the request and leave it pending.
  const saveEditsOnly = async () => {
    const changed = {};
    for (const [k, v] of Object.entries(edit || {})) {
      const was = k === "jobTitle" ? (modal.req.role || "") : (modal.req[k] || "");
      if (v.trim() !== was) changed[k] = v.trim();
    }
    if (!Object.keys(changed).length) { store.notify("Nothing changed"); setModal(null); return; }
    setBusy(true);
    try {
      // store.updateSignup refetches the queue and toasts on its own.
      await store.updateSignup(modal.req.id, changed);
      setModal(null);
    } catch (_) {
      // The store already showed the error and refetched, so the list is accurate.
    } finally { setBusy(false); }
  };

  const confirm = async () => {
    setBusy(true);
    try {
      // Send only what actually changed, so an untouched request is decided exactly
      // as it was and the audit trail does not show phantom edits.
      const changed = {};
      for (const [k, v] of Object.entries(edit || {})) {
        const was = k === "jobTitle" ? (modal.req.role || "") : (modal.req[k] || "");
        if (v.trim() !== was) changed[k] = v.trim();
      }
      await store.decideSignup(
        modal.req.id, modal.action, note,
        modal.action === "approved" && modal.req.kind !== "student" ? Number(allowance) : undefined,
        changed,
      );
      setModal(null);
    } catch (_) {
      // The store already surfaced the error as a toast and refetched, so the
      // list is accurate; keep the modal open so the admin can see what happened.
    } finally {
      setBusy(false);
    }
  };

  // Student requests have no position/department/site, so without the kind and college
  // ID columns their rows exported as blanks with nothing to identify them.
  const exportCsv = () => downloadCSV("signup-requests.csv", [
    { key: "kind", label: "Type" }, { key: "name", label: "Name" }, { key: "email", label: "Email" },
    { key: "collegeId", label: "College ID" }, { key: "role", label: "Position" },
    { key: "dept", label: "Department" }, { key: "site", label: "Site" }, { key: "status", label: "Status" },
    { key: "decidedBy", label: "Decided by" }, { key: "decidedAt", label: "Decided on" },
  ], rows.map(r => ({
    ...r,
    kind: r.kind === "student" ? "Student" : "Staff",
    collegeId: r.collegeId || "",
    site: r.site || "", decidedBy: r.decidedBy || "", decidedAt: r.decidedAt || "",
  })));

  return (
    <>
      <AdminHeader
        title="Sign-Up Requests"
        subtitle="People who signed up in the staff app — approving one creates their account"
        Icon={UserCheck}
        action={rows.length > 0 && <ExportBtn onClick={exportCsv} label="Export CSV" />}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-sm font-bold text-slate-700">Awaiting approval ({pending.length})</p>
          <div className="space-y-3">
            {pending.length === 0 && (
              <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
                <EmptyState Icon={CheckCircle2} title="No requests waiting" msg="New sign-ups from the staff app appear here." />
              </div>
            )}
            {pending.map((r, i) => (
              <div key={r.id} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/70 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md fade-up" style={{ animationDelay: `${i * 50}ms` }}>
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full text-xs font-bold text-white shadow-sm" style={{ background: NAVY }}>
                    {initialsOf(r.name)}
                  </span>
                  <div className="flex-1">
                    <p className="text-sm font-bold text-slate-700">{r.name}</p>
                    <p className="text-xs text-slate-400">{r.kind === "student" ? "Student" : `${r.role} · ${r.dept}`}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${r.kind === "student" ? "bg-violet-100 text-violet-700" : "bg-blue-100 text-blue-700"}`}>{r.kind === "student" ? <><GraduationCap size={10} /> Student</> : <><Briefcase size={10} /> Staff</>}</span>
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">Pending</span>
                  </div>
                </div>
                <div className="mt-3 space-y-1 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <p className="flex items-center gap-1.5"><Mail size={12} className="text-slate-400" /> {r.email}</p>
                  {r.kind === "student"
                    ? <>
                        <p className="flex items-center gap-1.5"><GraduationCap size={12} className="text-slate-400" /> Student{r.collegeId ? ` · College ID ${r.collegeId}` : ""}</p>
                        <p className="flex items-center gap-1.5 text-slate-400">{r.studentId ? "Matches an existing student record" : "No matching record — a new one will be created on approval"}</p>
                      </>
                    : <>
                        <p className="flex items-center gap-1.5"><Briefcase size={12} className="text-slate-400" /> {r.role}</p>
                        <p className="flex items-center gap-1.5"><Building2 size={12} className="text-slate-400" /> {r.dept}</p>
                        {r.site && <p className="flex items-center gap-1.5"><MapPin size={12} className="text-slate-400" /> {r.site}</p>}
                      </>}
                  <p className="flex items-center gap-1.5 text-slate-400"><Clock3 size={12} /> Requested {fmtDate(String(r.requestedAt).slice(0, 10))}</p>
                </div>
                <button onClick={() => open(r, "edit")}
                  className="press mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border-2 border-slate-200 bg-white py-2.5 text-sm font-bold text-slate-600 transition hover:bg-slate-50">
                  <Edit3 size={15} /> Edit details
                </button>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button onClick={() => open(r, "rejected")} className="press flex items-center justify-center gap-1.5 rounded-xl border-2 border-rose-200 py-2.5 text-sm font-bold text-rose-600 transition hover:bg-rose-50">
                    <XCircle size={16} /> Decline
                  </button>
                  <PrimaryBtn colour="#059669" onClick={() => open(r, "approved")} className="!py-2.5">
                    <CheckCircle2 size={16} /> Approve
                  </PrimaryBtn>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-2 flex items-center gap-1.5 text-sm font-bold text-slate-700"><History size={15} /> Decision history</p>
          <div className="space-y-2">
            {history.length === 0 && (
              <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
                <EmptyState Icon={History} title="No decisions yet" msg="Approved and declined sign-ups are logged here." />
              </div>
            )}
            {history.map((r, i) => (
              <div key={r.id} className="rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200/70 transition-colors duration-200 hover:bg-slate-50/60 fade-up" style={{ animationDelay: `${i * 35}ms` }}>
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ background: r.status === "approved" ? "#059669" : MAROON }}>
                    {initialsOf(r.name)}
                  </span>
                  <span className="text-sm font-semibold text-slate-700">{r.name}</span>
                  <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold capitalize ${r.status === "approved" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>{r.status}</span>
                </div>
                <p className="mt-1.5 text-xs text-slate-500">
                  {r.kind === "student" ? "Student" : `${r.role} · ${r.dept}`}
                  {r.decidedBy && <> · by {r.decidedBy}</>}
                  {r.decidedAt && <> on {fmtDate(r.decidedAt)}</>}
                  {r.note && <> · <span className="italic">"{r.note}"</span></>}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <Modal open={!!modal} onClose={() => !busy && setModal(null)} title={modal?.action === "edit" ? "Edit sign-up request" : modal?.action === "approved" ? "Approve sign-up" : "Decline sign-up"}>
        <div className="space-y-3">
          {modal?.action !== "rejected" ? (
            <div className="space-y-2.5 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
                {modal?.action === "edit" ? "What they submitted — correct anything and save" : "What they submitted — correct anything before approving"}
              </p>
              <Field label="Full name">
                <input value={edit?.name || ""} onChange={e => setEdit(v => ({ ...v, name: e.target.value }))} className={inputCls} />
              </Field>
              <Field label="Email">
                <input type="email" value={edit?.email || ""} onChange={e => setEdit(v => ({ ...v, email: e.target.value }))} className={inputCls} />
              </Field>
              {modal?.req.kind === "student" ? (
                <Field label="College ID / student reference">
                  <input value={edit?.collegeId || ""} onChange={e => setEdit(v => ({ ...v, collegeId: e.target.value }))} className={inputCls} />
                </Field>
              ) : (
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <Field label="Position">
                    <input value={edit?.jobTitle || ""} onChange={e => setEdit(v => ({ ...v, jobTitle: e.target.value }))} className={inputCls} />
                  </Field>
                  <Field label="Department">
                    <input value={edit?.dept || ""} onChange={e => setEdit(v => ({ ...v, dept: e.target.value }))} className={inputCls} />
                  </Field>
                  <Field label="Home site">
                    <select value={edit?.site || ""} onChange={e => setEdit(v => ({ ...v, site: e.target.value }))} className={inputCls}>
                      <option value="">— none —</option>
                      <option value="HND">HND</option>
                      <option value="FE">FE</option>
                      <option value="SL">SL</option>
                    </select>
                  </Field>
                </div>
              )}
              {/* The password is stored hashed and is never shown or changed here — the
                  applicant must still be able to sign in with the one they chose. */}
              <p className="text-[11px] text-slate-400">
                Their password is not shown and cannot be changed — they keep the one they chose.
              </p>
            </div>
          ) : (
            <div className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200">
              <p className="text-sm font-bold text-slate-700">{modal?.req.name}</p>
              <p>{modal?.req.email}</p>
              <p>{modal?.req.kind === "student" ? `Student${modal?.req.collegeId ? ` · College ID ${modal.req.collegeId}` : ""}` : `${modal?.req.role} · ${modal?.req.dept}`}</p>
            </div>
          )}

          {modal?.action === "edit" ? null : modal?.action === "approved" ? (
            modal?.req.kind === "student" ? (
              <p className="flex items-start gap-1.5 rounded-xl bg-violet-50 px-3 py-2 text-[11px] text-violet-700 ring-1 ring-violet-100">
                <GraduationCap size={13} className="mt-px shrink-0" />
                {modal?.req.studentId
                  ? "This links their existing student record and lets them sign in with the password they chose."
                  : "No matching student record was found — approving saves a new student in the Students table."}
                {" "}No holiday allowance is needed for a student.
              </p>
            ) : (
            <>
              <Field label="Holiday allowance (days per year)">
                <input type="number" min={0} value={allowance} onChange={e => setAllowance(e.target.value)} className={inputCls} />
              </Field>
              <p className="flex items-start gap-1.5 rounded-xl bg-blue-50 px-3 py-2 text-[11px] text-blue-700 ring-1 ring-blue-100">
                <ShieldCheck size={13} className="mt-px shrink-0" />
                This creates their staff account. They sign in with the password they chose.
              </p>
            </>
            )
          ) : (
            <Field label="Reason (optional, kept for your records)">
              <textarea value={note} onChange={e => setNote(e.target.value)} rows={3} placeholder="e.g. Not a current member of staff." className={inputCls + " resize-none"} />
            </Field>
          )}

          {modal?.action === "edit" && (
            <p className="flex items-start gap-1.5 rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500 ring-1 ring-slate-200">
              <Info size={13} className="mt-px shrink-0" />
              Saving leaves the request pending — you can still approve or decline it afterwards.
            </p>
          )}
          {modal?.action === "approved" && (
            <button onClick={saveEditsOnly} disabled={busy}
              className="press w-full rounded-xl border-2 border-slate-200 bg-white py-2.5 text-sm font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40">
              <Save size={15} className="mr-1.5 inline" /> Save changes without deciding
            </button>
          )}
          <PrimaryBtn colour={modal?.action === "edit" ? NAVY : modal?.action === "approved" ? "#059669" : MAROON}
            onClick={modal?.action === "edit" ? saveEditsOnly : confirm} disabled={busy} className="w-full">
            {modal?.action === "edit" ? <><Save size={16} /> {busy ? "Saving…" : "Save changes"}</>
              : modal?.action === "approved" ? <><CheckCircle2 size={16} /> {modal?.req.kind === "student" ? "Approve & activate student" : "Approve & create account"}</>
              : <><XCircle size={16} /> Confirm decline</>}
          </PrimaryBtn>
        </div>
      </Modal>
    </>
  );
}

/* ----- Dashboard: Reset Passwords ----- */
// Setting someone else's password directly, for the cases self-service cannot reach:
// a member of staff who has lost access to their college email, or a student standing
// at the office desk. The server drops all of that person's existing sessions and tells
// them it happened, so a reset can never be silent.
function AdminPasswords() {
  const [people, setPeople] = useState(null);
  const [err, setErr] = useState("");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState(null);
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const reveal = useReveal();
  const reveal2 = useReveal();

  const load = useCallback(async () => {
    setErr("");
    try { setPeople(await api.passwordPeople()); }
    catch (e) { setErr(e.message || "Could not load the list of people"); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = (people || []).filter(p => {
    if (!terms.length) return true;
    const hay = [p.name, p.email, p.detail].filter(Boolean).join(" ").toLowerCase();
    return terms.every(t => hay.includes(t));
  });

  const tooShort = pw.length > 0 && pw.length < 8;
  const mismatch = confirm.length > 0 && pw !== confirm;
  const canSave = !!picked && pw.length >= 8 && pw === confirm && !busy;
  const isPicked = (p) => picked && picked.id === p.id && picked.kind === p.kind;

  const save = async () => {
    if (!canSave) return;
    setBusy(true); setErr(""); setDone("");
    try {
      const r = await api.setPassword(picked.kind, picked.id, pw, confirm);
      setDone(r.name + " has a new password. They have been signed out everywhere and told it happened.");
      setPw(""); setConfirm(""); setPicked(null);
      load();
    } catch (e) { setErr(e.message || "Could not change that password"); }
    finally { setBusy(false); }
  };

  return (
    <>
      <AdminHeader title="Reset Passwords" subtitle="Set a new password for a member of staff or a student" Icon={KeyRound} />

      {err && <div className="mb-3 flex items-center gap-2 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600 ring-1 ring-rose-200"><AlertCircle size={15} /> {err}</div>}
      {done && <div className="mb-3 flex items-start gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200"><CheckCircle2 size={15} className="mt-px shrink-0" /> {done}</div>}

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/70">
          <div className="relative mb-3">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={query} onChange={e => setQuery(e.target.value)} type="search"
              placeholder="Search staff or students by name, email or ID"
              className="w-full rounded-xl border border-slate-200 bg-slate-50/60 py-2.5 pl-9 pr-3 text-sm outline-none transition focus:border-blue-400 focus:bg-white focus:ring-4 focus:ring-blue-100" />
          </div>
          {!people && <div className="skeleton h-40 rounded-xl" />}
          {people && (
            <div className="max-h-96 space-y-1.5 overflow-y-auto pr-1">
              {list.map(p => (
                <button key={p.kind + ":" + p.id} onClick={() => { setPicked(p); setPw(""); setConfirm(""); setDone(""); }}
                  className={"flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition " + (isPicked(p) ? "text-white ring-transparent" : "bg-white ring-1 ring-slate-200 hover:bg-slate-50")}
                  style={isPicked(p) ? { background: NAVY } : {}}>
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white" style={{ background: p.colour || NAVY }}>{p.initials}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className={"truncate text-sm font-bold " + (isPicked(p) ? "text-white" : "text-slate-700")}>{p.name}</span>
                      {p.isSuperAdmin && <span className="shrink-0 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-bold text-amber-700">SUPER ADMIN</span>}
                    </span>
                    <span className={"block truncate text-[11px] " + (isPicked(p) ? "text-white/70" : "text-slate-400")}>{p.detail} - {p.email}</span>
                    {p.note && <span className={"block truncate text-[10px] " + (isPicked(p) ? "text-white/60" : "text-amber-600")}>{p.note}</span>}
                  </span>
                </button>
              ))}
              {list.length === 0 && <p className="px-1 py-8 text-center text-xs text-slate-400">Nobody matches that search.</p>}
            </div>
          )}
        </div>

        <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/70">
          {!picked ? (
            <EmptyState Icon={KeyRound} title="Choose a person" msg="Pick a member of staff or a student on the left, then set their new password." />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2.5 rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white" style={{ background: picked.colour || NAVY }}>{picked.initials}</span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-extrabold" style={{ color: NAVY }}>{picked.name}</p>
                  <p className="truncate text-[11px] text-slate-400">{picked.detail} - {picked.email}</p>
                </div>
              </div>

              <Field label="New password">
                <div className="relative">
                  <input type={reveal.type} value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" className={inputCls + " pr-11"} />
                  {reveal.button}
                </div>
                {tooShort && <p className="mt-1 text-[11px] font-semibold text-rose-600">At least 8 characters.</p>}
              </Field>

              <Field label="Confirm password">
                <div className="relative">
                  <input type={reveal2.type} value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" className={inputCls + " pr-11"} />
                  {reveal2.button}
                </div>
                {mismatch && <p className="mt-1 text-[11px] font-semibold text-rose-600">The two passwords do not match.</p>}
              </Field>

              <p className="flex items-start gap-1.5 rounded-xl bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800 ring-1 ring-amber-200">
                <AlertCircle size={13} className="mt-px shrink-0" />
                {picked.name} will be signed out on every device and told that you reset it. Give them the new password directly - it is not emailed.
              </p>

              <PrimaryBtn onClick={save} disabled={!canSave} colour={canSave ? NAVY : "#94a3b8"} className="w-full">
                {busy ? <><Loader size={16} /> Saving...</> : <><KeyRound size={16} /> Set new password</>}
              </PrimaryBtn>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* ----- Dashboard: Student Queries ----- */
function AdminStudentQueries({ store }) {
  const [filter, setFilter] = useState("all"); // all | open | answered
  const [modal, setModal] = useState(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");

  const all = store.studentQueries || [];
  const ql = query.trim().toLowerCase();
  const rows = all
    .filter(q => filter === "all" || q.status === filter)
    .filter(q => !ql || (q.studentName || "").toLowerCase().includes(ql) || (q.subject || "").toLowerCase().includes(ql) || (q.message || "").toLowerCase().includes(ql));
  const open = all.filter(q => q.status === "open").length;

  const openReply = (q) => { setModal(q); setReply(q.response || ""); };
  const send = async () => {
    if (!reply.trim()) return;
    setBusy(true);
    try { await store.respondStudentQuery(modal.id, reply.trim()); setModal(null); setReply(""); }
    catch (e) {} finally { setBusy(false); }
  };

  return (
    <>
      <AdminHeader title="Student Queries" subtitle="Questions from students — reply and they'll see it in their app" Icon={Inbox}
        action={<span className="flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-700 ring-1 ring-amber-200"><MessageSquare size={13} /> {open} open</span>} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200"><Search size={15} className="text-slate-400" /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search student, subject or text…" className="bg-transparent text-sm outline-none" /></div>
        <div className="flex gap-1 rounded-xl bg-white p-1 ring-1 ring-slate-200">
          {["all", "open", "answered"].map(f => <button key={f} onClick={() => setFilter(f)} className={`rounded-lg px-3 py-1.5 text-xs font-bold capitalize transition ${filter === f ? "text-white" : "text-slate-500 hover:bg-slate-100"}`} style={filter === f ? { background: NAVY } : {}}>{f}</button>)}
        </div>
      </div>

      <div className="space-y-3">
        {rows.length === 0 && <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200"><EmptyState Icon={Inbox} title="No queries" msg="Questions students send from their app appear here." /></div>}
        {rows.map((q, i) => (
          <div key={q.id} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/70 fade-up" style={{ animationDelay: `${i * 40}ms` }}>
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-full text-xs font-bold text-white shadow-sm" style={{ background: q.studentColour || NAVY }}>{q.studentInitials || "S"}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-slate-700">{q.studentName || "Student"} <span className="text-[11px] font-medium text-slate-400">{q.studentRef ? `· ${q.studentRef}` : ""}</span></p>
                <p className="truncate text-xs text-slate-400">{q.subject}</p>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${q.status === "open" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>{q.status === "open" ? "Open" : "Answered"}</span>
            </div>
            <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">{q.message}</p>
            {q.response && <div className="mt-2 rounded-xl bg-blue-50 px-3 py-2 text-sm text-blue-800 ring-1 ring-blue-100"><p className="mb-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-500">Your reply{q.respondedBy ? ` · ${q.respondedBy}` : ""}{q.respondedAt ? ` · ${fmtDate(q.respondedAt)}` : ""}</p>{q.response}</div>}
            <div className="mt-3 flex items-center justify-between">
              <p className="text-[11px] text-slate-400">Sent {fmtDate(String(q.createdAt).slice(0, 10))}</p>
              <PrimaryBtn onClick={() => openReply(q)} className="!py-2 !px-3 text-xs">{q.status === "open" ? <><Send size={14} /> Reply</> : <><Edit3 size={14} /> Edit reply</>}</PrimaryBtn>
            </div>
          </div>
        ))}
      </div>

      <Modal open={!!modal} onClose={() => !busy && setModal(null)} title="Reply to student">
        <div className="space-y-3">
          <div className="rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-slate-200">
            <p className="text-sm font-bold text-slate-700">{modal?.studentName}</p>
            <p className="text-[11px] text-slate-400">{modal?.subject}</p>
            <p className="mt-1.5 text-sm text-slate-600">{modal?.message}</p>
          </div>
          <Field label="Your acknowledgement / feedback">
            <textarea value={reply} onChange={e => setReply(e.target.value)} rows={4} placeholder="Write a reply the student will see in their app…" className={inputCls + " resize-none"} />
          </Field>
          <PrimaryBtn onClick={send} disabled={busy || !reply.trim()} className="w-full">{busy ? <><Loader2 size={16} className="animate-spin" /> Sending…</> : <><Send size={16} /> Send reply</>}</PrimaryBtn>
        </div>
      </Modal>
    </>
  );
}

/* ----- Dashboard: Daily Summaries ----- */
function AdminSummaries({ store }) {
  const [day, setDay] = useState(todayISO());
  const [q, setQ] = useState("");
  const dayRecs = store.staff.map(s => ({ s, rec: store.checkins.find(c => c.staffId === s.id && c.date === day) })).filter(({ s }) => (s.name).toLowerCase().includes(q.toLowerCase()));
  const withSummary = dayRecs.filter(r => r.rec?.summary).length;
  const paged = usePaged(dayRecs, 10, day + "|" + q);
  const exportSummaries = () => {
    const rows = dayRecs.map(({ s, rec }) => ({ name: s.name, dept: s.dept, in: (rec && rec.in) ? rec.in : "", out: rec?.out || "", summary: rec?.summary || "" }));
    downloadCSV(`summaries-${day}.csv`, [
      { key: "name", label: "Name" }, { key: "dept", label: "Dept" }, { key: "in", label: "In" }, { key: "out", label: "Out" }, { key: "summary", label: "Summary" },
    ], rows);
    store.notify("Exported summaries CSV");
  };
  return (
    <>
      <AdminHeader title="Daily Summaries" subtitle="What each staff member reported working on" Icon={ClipboardList} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input type="date" value={day} onChange={e => setDay(e.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium outline-none" />
        <div className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200"><Search size={15} className="text-slate-400" /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search staff…" className="bg-transparent text-sm outline-none" /></div>
        <span className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700 ring-1 ring-emerald-200"><Check size={13} /> {withSummary} submitted</span>
        {store.staff.length > 0 && <span className="flex items-center gap-1.5 rounded-full bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-600 ring-1 ring-slate-200"><Activity size={13} /> {Math.round((withSummary / store.staff.length) * 100)}% of staff</span>}
        <ExportBtn onClick={exportSummaries} className="ml-auto" />
      </div>
      {dayRecs.length === 0 && <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200"><EmptyState Icon={Search} title="No staff match" msg="Try a different name or date." /></div>}
      <div className="grid gap-3 md:grid-cols-2">
        {paged.slice.map(({ s, rec }, i) => (
          <div key={s.id} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/70 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md hover:ring-slate-300/80 fade-up" style={{ animationDelay: `${i * 35}ms` }}>
            <div className="mb-2 flex items-center gap-2.5"><span className="flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold text-white shadow-sm" style={{ background: s.colour }}>{s.initials}</span><div><p className="text-sm font-bold text-slate-700">{s.name}</p><p className="text-[11px] text-slate-400">{s.dept}{rec && rec.in ? ` · In ${rec.in}${rec.out ? ` · Out ${rec.out}` : ""}` : ""}</p></div></div>
            {rec?.summary ? <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-600">{rec.summary}</p> : <p className="rounded-xl border border-dashed border-slate-200 px-3 py-2.5 text-sm italic text-slate-400">No summary submitted</p>}
          </div>
        ))}
      </div>
      <Pagination className="mt-4" page={paged.page} setPage={paged.setPage} totalPages={paged.totalPages} total={paged.total} />
    </>
  );
}

/* ============================================================
   Dashboard: Attendance Registers — HND
   Sessions per unit -> take the register (P/L/E/A + remarks)
   -> per-unit and overall attendance percentages.
   ============================================================ */
function AdminHndRegisters({ store }) {
  const { refreshHnd, hndLoaded, units, students, attendance, semesters, semesterId } = store;
  // Opens on Courses — the top of the hierarchy. From a course you drill
  // into its Courses, and from a course into its sessions and registers.
  const [view, setView] = useState("courses"); // courses | units | sessions | percentages | students | semesters
  const [unitId, setUnitId] = useState("");
  // Which course the Courses gallery is filtered to ("" = all courses).
  const [courseCourse, setCourseCourse] = useState("");
  const [openRegister, setOpenRegister] = useState(null); // session id being marked

  // Loads on first open, and again whenever the semester picker changes
  // (refreshHnd depends on semesterId).
  useEffect(() => { refreshHnd(); }, [refreshHnd]);
  // Default to the first unit as soon as they arrive, and recover if the
  // selected unit is deleted underneath us.
  useEffect(() => {
    if (!units.length) { setUnitId(""); return; }
    if (!unitId || !units.some(m => m.id === unitId)) setUnitId(units[0].id);
  }, [units, unitId]);
  // Fall back to "All semesters" if the scoped semester is deleted, or if the
  // last semester goes and leaves us stuck on "unassigned" with no picker.
  useEffect(() => {
    if (!semesterId) return;
    const orphaned = semesterId === "unassigned" ? semesters.length === 0 : !semesters.some(s => s.id === semesterId);
    if (orphaned) store.setSemesterId("");
  }, [semesters, semesterId, store]);

  const selected = units.find(m => m.id === unitId) || null;

  if (!hndLoaded) {
    return (
      <>
        <AdminHeader title="Attendance Registers — HND" subtitle="Loading units, students and registers…" Icon={ClipboardList} />
        <div className="space-y-3">{[0, 1, 2].map(i => <div key={i} className="skeleton h-20 rounded-2xl" />)}</div>
      </>
    );
  }

  // Taking a register replaces the page body — it's a focused, full-width task.
  if (openRegister) {
    return <HndRegister store={store} sessionId={openRegister} onBack={() => setOpenRegister(null)} />;
  }

  const tabs = [
    { key: "courses", label: "Courses", I: Layers },
    { key: "units", label: "Units", I: GraduationCap },
    { key: "sessions", label: "Sessions & registers", I: ClipboardList },
    { key: "percentages", label: "Attendance %", I: Percent },
    { key: "students", label: "Students", I: Users },
    { key: "semesters", label: "Semesters", I: CalendarDays },
  ];
  // Everything on the page reads from the same scoped session list.
  const scoped = scopeSessions(store.sessions, semesterId, semesters);

  return (
    <>
      <AdminHeader
        title="Attendance Registers — HND"
        subtitle="Take unit registers and track attendance across the course"
        Icon={ClipboardList}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <HndSemesterPicker store={store} />
            <button onClick={() => refreshHnd()} className="press flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50">
              <RefreshCw size={14} /> Refresh
            </button>
          </div>
        }
      />
      <HndOverviewStats store={store} attendance={attendance} units={units} students={students} sessions={scoped} />
      <div className="mb-4 mt-5 flex flex-wrap gap-1.5">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setView(t.key)}
            className={`press flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-bold shadow-sm transition-all ${view === t.key ? "text-white" : "bg-white text-slate-500 hover:bg-slate-50"}`}
            style={view === t.key ? { background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` } : {}}>
            <t.I size={14} /> {t.label}
            {/* Only a warning once semesters exist — before that, everything is "unassigned" by definition. */}
            {t.key === "semesters" && semesters.length > 0 && store.unassignedSessions > 0 && <span className="rounded-full bg-amber-400 px-1.5 py-0.5 text-[9px] font-bold text-slate-900">{store.unassignedSessions}</span>}
          </button>
        ))}
      </div>
      {view === "courses" && <HndCourses store={store} onOpen={(pid) => { setCourseCourse(pid); setView("units"); }} />}
      {view === "units" && <>
        {courseCourse && <BackTo label="courses" onClick={() => { setCourseCourse(""); setView("courses"); }} />}
        <Units store={store} courseFilter={courseCourse} setCourseFilter={setCourseCourse} onView={(id) => { setUnitId(id); setView("sessions"); }} />
      </>}
      {view === "sessions" && <>
        <BackTo label="units" onClick={() => setView("units")} />
        <HndSessions store={store} unitId={unitId} setUnitId={setUnitId} selected={selected} onTake={setOpenRegister} scoped={scoped} />
      </>}
      {view === "percentages" && <HndPercentages store={store} />}
      {view === "students" && <HndStudents store={store} />}
      {view === "semesters" && <HndSemesters store={store} />}
    </>
  );
}

// Returns from a drilled-into view to the one above it.
//
// The admin sections are tab bars, and a tab click is not "back": opening a course to
// see its units, then a unit to see its sessions, leaves you three levels in with the
// tab row still showing the LEAF tab. Clicking another tab abandons the trail rather
// than retracing it, and the context you drilled through (which course, which unit) is
// silently kept. This walks one step up and clears that step's context.
function BackTo({ label, onClick }) {
  return (
    <button onClick={onClick} aria-label={`Back to ${label}`}
      className="press mb-3 flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900">
      <ChevronLeft size={15} /> Back to {label}
    </button>
  );
}

// Scopes the whole page to one teaching period. Hidden entirely until a semester
// exists — with none defined, every session is "unassigned" and the picker would
// only offer two ways to say "everything".
function HndSemesterPicker({ store }) {
  const { semesters, semesterId, setSemesterId, unassignedSessions } = store;
  if (!semesters.length) return null;
  return (
    <label className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 ring-1 ring-slate-200">
      <CalendarDays size={14} className="text-slate-400" />
      <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Semester</span>
      <select value={semesterId} onChange={e => setSemesterId(e.target.value)} className="bg-transparent text-xs font-bold outline-none" style={{ color: NAVY }}>
        <option value="">All semesters</option>
        {semesters.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        {unassignedSessions > 0 && <option value="unassigned">Outside any semester ({unassignedSessions})</option>}
      </select>
    </label>
  );
}

// The two headline figures the college cares about, plus supporting counts.
// `sessions` arrives already scoped to the selected semester.
function HndOverviewStats({ store, attendance, units, students, sessions }) {
  const overall = attendance?.overall;
  const untaken = sessions.filter(s => s.markedCount === 0 && s.date <= todayISO()).length;
  const tone = pctTone(overall?.pct ?? null);
  const scopeNote = store.semesterId ? semesterLabel(store.semesterId, store.semesters) : "all units combined";
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard label="Overall attendance" value={fmtPct(overall?.pct ?? null)} sub={scopeNote} Icon={Percent} tone={tone.colour} delay={0} />
      <StatCard label="Students" value={students.length} sub="on the HND course" Icon={Users} tone={NAVY} delay={60} animate />
      <StatCard label="Units" value={units.length} sub="running this year" Icon={BookOpen} tone="#6d28d9" delay={120} animate />
      <StatCard label="Registers to take" value={untaken} sub={untaken === 1 ? "session not yet marked" : "sessions not yet marked"} Icon={AlertCircle} tone={untaken > 0 ? "#b45309" : "#059669"} delay={180} animate />
    </div>
  );
}

/* ----- Sessions list (per unit) ----- */
// 24h "HH:MM" → compact 12h, e.g. "10:00" → "10AM", "13:30" → "1:30PM".
const fmt12 = (t) => { if (!t) return ""; const [h, m] = String(t).split(":").map(Number); const ap = h >= 12 ? "PM" : "AM"; const hh = h % 12 || 12; return m ? `${hh}:${String(m).padStart(2, "0")}${ap}` : `${hh}${ap}`; };

function HndSessions({ store, unitId, setUnitId, selected, onTake, scoped }) {
  const [filter, setFilter] = useState("all"); // all | past | upcoming
  const [modal, setModal] = useState(false);
  const [edit, setEdit] = useState(null);
  const [form, setForm] = useState({ date: todayISO(), start: "10:00", end: "13:00", description: "", audience: "All students", kind: "Teaching" });

  const today = todayISO();
  const mine = scoped.filter(s => s.unitId === unitId);
  // Number the registers that fall on the same day (a 6-hour day has two), so they
  // stay distinguishable now the time column is gone.
  const byDate = {};
  mine.forEach(s => { (byDate[s.date] = byDate[s.date] || []).push(s); });
  Object.values(byDate).forEach(arr => arr.sort((a, b) => (a.start || "").localeCompare(b.start || "")));
  const regInfo = (s) => { const arr = byDate[s.date] || [s]; return { idx: arr.findIndex(x => x.id === s.id) + 1, total: arr.length }; };
  // Always list in order from the start date (ascending), regardless of server order.
  const filtered = mine
    .filter(s => filter === "all" || (filter === "past" ? s.date <= today : s.date > today))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.start || "").localeCompare(b.start || ""));
  const paged = usePaged(filtered, 10, `${unitId}|${filter}|${store.semesterId}`);
  // Warn before a session is filed outside the semester currently being viewed —
  // it would save fine but immediately disappear from this list.
  const formSemester = semesterOf(form.date, store.semesters);
  const outOfScope = store.semesterId && (store.semesterId === "unassigned" ? !!formSemester : formSemester?.id !== store.semesterId);

  const openAdd = () => { setEdit(null); setForm({ date: today, start: "10:00", end: "13:00", description: selected?.code || "", audience: "All students", kind: "Teaching" }); setModal(true); };
  const openEdit = (s) => { setEdit(s); setForm({ date: s.date, start: s.start, end: s.end, description: s.description, audience: s.audience, kind: s.kind || "Teaching" }); setModal(true); };
  const save = async () => {
    try {
      if (edit) await store.updateSession(edit.id, form);
      else await store.addSession({ ...form, unitId });
      setModal(false);
    } catch (_e) { /* toast shown by the store; keep the modal open */ }
  };
  const remove = async (s) => {
    // Always confirm — an unmarked session used to disappear on a single tap.
    const marks = s.markedCount > 0
      ? `\n\nIt has ${s.markedCount} mark${s.markedCount === 1 ? "" : "s"} recorded; deleting it removes those marks and changes attendance percentages.`
      : "\n\nNo attendance has been marked on it yet.";
    // s.start / s.end — the serializer renames startTime/endTime. Reading the old
    // names printed "undefined–undefined", so the two registers that share a date were
    // indistinguishable and it was easy to delete the marked one by mistake.
    if (!window.confirm(`Delete the ${s.kind || "session"} on ${fmtDate(s.date)} at ${s.start}–${s.end}?${marks}\n\nThis cannot be undone.`)) return;
    try {
      await store.removeSession(s.id);
    } catch (err) {
      // 423 = the register's term is locked. Offer an explicit override rather than failing.
      if (err?.status === 423) {
        if (window.confirm(`${err.message}\n\nDelete it anyway? This overrides the term lock and cannot be undone.`)) {
          await store.removeSession(s.id, true);
        }
      }
      // Any other error was already toasted by the store.
    }
  };
  const exportSessions = () => {
    downloadCSV(`sessions-${selected?.code || "hnd"}.csv`,
      [{ key: "date", label: "Date" }, { key: "time", label: "Time" }, { key: "audience", label: "Type" }, { key: "description", label: "Description" }, { key: "marked", label: "Marked" }],
      filtered.map(s => ({ date: s.date, time: `${s.start}–${s.end}`, audience: s.audience, description: s.description, marked: s.markedCount })));
    store.notify("Exported sessions CSV");
  };

  if (!store.units.length) {
    return <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200/70"><EmptyState Icon={BookOpen} title="No units yet" msg="Add a unit on the Units tab, then you can timetable sessions and take registers." /></div>;
  }

  return (
    <>
      {/* Unit picker */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {store.units.map(m => {
          // Session count for the semester in view, not the unit's all-time total.
          const count = store.attendance?.unitTotals?.[m.id]?.sessionCount ?? m.sessionCount;
          return (
            <button key={m.id} onClick={() => setUnitId(m.id)}
              className={`press rounded-xl px-3.5 py-2 text-left text-xs font-bold shadow-sm ring-1 transition-all ${unitId === m.id ? "text-white ring-transparent" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50"}`}
              style={unitId === m.id ? { background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` } : {}}>
              <span className="block">{m.code}</span>
              <span className={`block text-[10px] font-medium ${unitId === m.id ? "text-white/60" : "text-slate-400"}`}>{m.studentCount} students · {count} session{count === 1 ? "" : "s"}</span>
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-lg font-extrabold" style={{ color: NAVY_DARK }}>{selected.name}</p>
            <p className="text-xs text-slate-400">
              {selected.code}{selected.tutor ? ` · Tutor: ${selected.tutor}` : ""}
              {store.semesterId ? ` · ${semesterLabel(store.semesterId, store.semesters)}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1 rounded-xl bg-white p-1 ring-1 ring-slate-200">
              {[{ k: "all", l: "All" }, { k: "past", l: "All past" }, { k: "upcoming", l: "Upcoming" }].map(f => (
                <button key={f.k} onClick={() => setFilter(f.k)} className={`press rounded-lg px-2.5 py-1.5 text-xs font-bold transition ${filter === f.k ? "text-white" : "text-slate-500 hover:bg-slate-100"}`} style={filter === f.k ? { background: NAVY } : {}}>{f.l}</button>
              ))}
            </div>
            <ExportBtn onClick={exportSessions} label="Export" />
            <PrimaryBtn onClick={openAdd}><Plus size={16} /> Add session</PrimaryBtn>
          </div>
        </div>
      )}

      <div className="overflow-x-auto overflow-y-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 fade-up [-webkit-overflow-scrolling:touch] md:overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-400">
              <tr><th className="px-5 py-3">Date</th><th className="px-5 py-3">Time</th><th className="px-5 py-3">Type</th><th className="px-5 py-3">Description</th><th className="px-5 py-3">Register</th><th className="px-5 py-3 text-right">Actions</th></tr>
            </thead>
            <tbody>
              {paged.slice.map(s => {
                const future = s.date > today;
                const done = s.markedCount > 0;
                const sem = semesterOf(s.date, store.semesters);
                return (
                  <tr key={s.id} className="border-t border-slate-100 transition-colors duration-150 hover:bg-blue-50/40">
                    <td className="px-5 py-3">
                      <button onClick={() => onTake(s.id)} className="text-left font-semibold transition hover:underline" style={{ color: NAVY }}>{fmtDay(s.date)}</button>
                      {s.date === today && <span className="ml-2 rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] font-bold text-blue-700">TODAY</span>}
                      {/* Only worth showing when it isn't already implied by the picker. */}
                      {!store.semesterId && store.semesters.length > 0 && (
                        <p className={`mt-0.5 text-[10px] font-semibold ${sem ? "text-slate-400" : "text-amber-600"}`}>{sem ? sem.name : "Outside any semester"}</p>
                      )}
                    </td>
                    <td className="px-5 py-3 font-medium text-slate-600 whitespace-nowrap tabular-nums">{fmt12(s.start)} – {fmt12(s.end)}</td>
                    <td className="px-5 py-3 text-slate-500">{s.audience}</td>
                    <td className="px-5 py-3">
                      {(() => {
                        // Prefer the register's saved type; otherwise derive it from its
                        // position that day — 1st = Teaching, 2nd = Seminar — so registers
                        // created before the type existed still read correctly.
                        const ri = regInfo(s);
                        const label = s.kind || (ri.total > 1 ? (ri.idx === 1 ? "Teaching" : ri.idx === 2 ? "Seminar" : `Register ${ri.idx}`) : "");
                        return label
                          ? <span className="rounded-full px-2.5 py-1 text-[11px] font-bold" style={label === "Teaching" ? { background: "#e0e7ff", color: "#4338ca" } : label === "Seminar" ? { background: "#f3e8ff", color: "#7e22ce" } : { background: "#f1f5f9", color: "#475569" }}>{label}</span>
                          : <span className="font-medium text-slate-600">{s.description || "—"}</span>;
                      })()}
                    </td>
                    <td className="px-5 py-3">
                      {done
                        ? <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-bold text-emerald-700">Taken · {s.markedCount}</span>
                        : future
                          ? <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-500">Scheduled</span>
                          : <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-bold text-amber-700">Not taken</span>}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => onTake(s.id)} title={done ? "Edit register" : "Take register"} className="press flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-bold text-white transition hover:opacity-90" style={{ background: done ? "#0d7a5f" : NAVY }}>
                          <PlayCircle size={13} /> {done ? "Edit" : "Take"}
                        </button>
                        <button onClick={() => openEdit(s)} title="Edit session" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"><Settings size={15} /></button>
                        <button onClick={() => remove(s)} title="Delete session" className="rounded-lg p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"><Trash2 size={15} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {paged.slice.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-10">
                  <EmptyState Icon={CalendarDays} title="No sessions"
                    msg={store.semesterId
                      ? `No sessions for this unit in ${semesterLabel(store.semesterId, store.semesters)}. Switch the semester picker to "All semesters" to see the rest.`
                      : filter === "all" ? "Add a session to start taking registers for this unit." : "Try a different filter."} />
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <Pagination className="mt-4" page={paged.page} setPage={paged.setPage} totalPages={paged.totalPages} total={paged.total} />

      <Modal open={modal} onClose={() => setModal(false)} title={edit ? "Edit session" : "Add session"}>
        <div className="space-y-3">
          <Field label="Date"><input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} className={inputCls} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start time"><input type="time" value={form.start} onChange={e => setForm(f => ({ ...f, start: e.target.value }))} className={inputCls} /></Field>
            <Field label="End time"><input type="time" value={form.end} onChange={e => setForm(f => ({ ...f, end: e.target.value }))} className={inputCls} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Audience"><select value={form.audience} onChange={e => setForm(f => ({ ...f, audience: e.target.value }))} className={inputCls}><option>All students</option><option>Group A</option><option>Group B</option></select></Field>
            <Field label="Session type"><select value={form.kind} onChange={e => setForm(f => ({ ...f, kind: e.target.value }))} className={inputCls}>{["Teaching", "Seminar", "Workshop", "Lecture", "Lab", "Tutorial"].map(k => <option key={k} value={k}>{k}</option>)}</select></Field>
          </div>
          <Field label="Description (optional)"><input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder={selected?.code || "e.g. Workshop"} className={inputCls} /></Field>
          {outOfScope && (
            <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>
                {formSemester ? `${fmtDate(form.date)} falls in ${formSemester.name}` : `${fmtDate(form.date)} falls outside every semester`},
                but you're viewing {semesterLabel(store.semesterId, store.semesters)}. The session will save — it just won't appear in this list.
              </span>
            </div>
          )}
          <p className="text-xs text-slate-400">Unit: {selected?.code} — {selected?.name}</p>
          <PrimaryBtn onClick={save} className="w-full"><Save size={16} /> {edit ? "Save changes" : "Add session"}</PrimaryBtn>
        </div>
      </Modal>
    </>
  );
}

/* ----- Taking the register for one session ----- */
function HndRegister({ store, sessionId, onBack }) {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({});   // studentId -> { status, remark }
  const [saved, setSaved] = useState({});   // last-saved snapshot, for the dirty check
  const [saving, setSaving] = useState(false);
  const [bulk, setBulk] = useState("");
  const [query, setQuery] = useState("");
  const [reopened, setReopened] = useState(false);  // admin unlocked a paused (past/future term) register to correct it

  const load = useCallback(async () => {
    try {
      const d = await store.getRegister(sessionId);
      const snapshot = Object.fromEntries(d.rows.map(r => [r.student.id, { status: r.status, remark: r.remark }]));
      setData(d); setDraft(snapshot); setSaved(snapshot);
    } catch (e) { store.notify?.(e.message || "Could not load the register", "error"); }
    // store.getRegister/notify are stable across renders; sessionId is the real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
  useEffect(() => { load(); }, [load]);

  if (!data) return <><AdminHeader title="Register" subtitle="Loading…" Icon={ClipboardList} /><div className="skeleton h-64 rounded-2xl" /></>;

  const { session, unit: mod, rows } = data;
  // Term gate: a unit assigned to a term only accepts marks during that term's dates.
  // Outside it (past or not-yet-started) the register is read-only — "paused" — until
  // an admin reopens it for a correction. Units with no term are always editable.
  const fullMod = store.units.find(m => m.id === mod.id) || mod;
  const term = fullMod.termId ? (store.terms || []).find(t => t.id === fullMod.termId) : null;
  const today = todayISO();
  const termState = !term ? "none" : (today >= term.start && today <= term.end) ? "current" : (today > term.end ? "past" : "future");
  const locked = termState === "past" || termState === "future";
  const readOnly = locked && !reopened;
  const setStatus = (studentId, status) => { if (readOnly) return; setDraft(d => ({ ...d, [studentId]: { ...d[studentId], status: d[studentId]?.status === status ? null : status } })); };
  const setRemark = (studentId, remark) => { if (readOnly) return; setDraft(d => ({ ...d, [studentId]: { ...d[studentId], remark } })); };
  const applyBulk = (status) => {
    if (readOnly) return;
    // Marking a whole cohort Absent is one click, it lands straight in the attendance
    // denominator, and every student is now enrolled on every unit of their course —
    // including units that start next year. Confirm before writing a zero-percent day
    // onto a register whose teaching hasn't begun.
    if (status === "A" && session?.date && session.date > today) {
      const n = rows.length;
      if (!window.confirm(`Mark all ${n} student${n === 1 ? "" : "s"} ABSENT for ${fmtDate(session.date)}?\n\nThat date is in the future, so this counts ${n === 1 ? "them" : "them all"} as having missed a class that hasn't happened yet, and it will pull their attendance percentage down.`)) return;
    }
    setBulk(status);
    if (!status) return;
    setDraft(d => Object.fromEntries(rows.map(r => [r.student.id, { ...d[r.student.id], status }])));
  };

  // Rows this screen has actually changed since it loaded. Sending ONLY these is what
  // makes concurrent register-taking safe: the server reads a null status as "clear
  // this mark", so sending every row meant a tab that loaded before a colleague saved
  // would carry nulls for their 29 marks and delete them all, reporting success.
  const changedRows = rows.filter(r => {
    const a = draft[r.student.id] || {}, b = saved[r.student.id] || {};
    return (a.status || null) !== (b.status || null) || (a.remark || "") !== (b.remark || "");
  });
  const dirty = changedRows.length > 0;
  const tally = summariseDraft(rows.map(r => draft[r.student.id]?.status).filter(Boolean));
  const unmarked = rows.length - tally.marked;

  const save = async () => {
    setSaving(true);
    try {
      // `locked` term → send the admin override so the server accepts the correction.
      // `reopened`, not `locked`. Sending the override whenever the register HAPPENED
      // to be locked meant the server's 423 could never fire from the app and the
      // "Reopen for corrections" button was decorative — every out-of-term save went
      // through silently. Now the override is only sent when a person has explicitly
      // reopened the register, which is what makes it an auditable act.
      await store.saveRegister(sessionId, changedRows.map(r => ({ studentId: r.student.id, status: draft[r.student.id]?.status || null, remark: draft[r.student.id]?.remark || "" })), reopened);
      await load();
      setReopened(false);
    } catch (_e) { /* the store already surfaced the error as a toast */ }
    setSaving(false);
  };

  const ql = query.trim().toLowerCase();
  const visible = rows.filter(r => !ql || r.student.name.toLowerCase().includes(ql) || (r.student.email || "").toLowerCase().includes(ql) || r.student.studentRef.includes(ql));

  // Export this week's register to CSV — every student with their mark and remark,
  // plus the session's own date/time so the file stands alone.
  const exportRegister = () => {
    const label = Object.fromEntries(ATT_STATUSES.map(s => [s.key, s.label]));
    downloadCSV(
      `register-${mod.code}-${session.date}.csv`,
      [
        { key: "date", label: "Date" }, { key: "time", label: "Time" }, { key: "unit", label: "Unit" },
        { key: "name", label: "Student" }, { key: "ref", label: "Student number" }, { key: "email", label: "Email" },
        { key: "status", label: "Status" }, { key: "meaning", label: "Status meaning" }, { key: "remark", label: "Remarks" },
      ],
      rows.map(r => {
        const st = draft[r.student.id]?.status || "";
        return {
          date: session.date, time: `${session.start}–${session.end}`, unit: mod.code,
          name: r.student.name, ref: r.student.studentRef, email: r.student.email,
          status: st, meaning: st ? label[st] : "Unmarked", remark: draft[r.student.id]?.remark || "",
        };
      }),
    );
    store.notify?.("Exported this week's register");
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 fade-up">
        <button onClick={onBack} className="press flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50">
          <ChevronLeft size={15} /> Back to sessions
        </button>
        {dirty && <span className="pop flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-700 ring-1 ring-amber-200"><AlertCircle size={13} /> Unsaved changes</span>}
      </div>
      <AdminHeader
        title={`${mod.code} — ${fmtDay(session.date)}`}
        subtitle={`${mod.name} · ${session.start}–${session.end} · ${session.audience}${session.description ? ` · ${session.description}` : ""}`}
        Icon={ClipboardList}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ExportBtn onClick={exportRegister} label="Export" />
            <PrimaryBtn onClick={save} disabled={!dirty || saving || readOnly} colour={dirty && !readOnly ? NAVY : "#94a3b8"}>{saving ? <><Loader size={16} /> Saving…</> : <><Save size={16} /> Save register</>}</PrimaryBtn>
          </div>
        }
      />

      {/* Term status: paused registers are read-only until an admin reopens them. */}
      {term && (
        <div className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3 ring-1 fade-up ${termState === "current" ? "bg-emerald-50 ring-emerald-200" : "bg-amber-50 ring-amber-200"}`}>
          <div className="flex items-center gap-2 text-sm font-semibold">
            {termState === "current"
              ? <span className="flex items-center gap-1.5 text-emerald-700"><CheckCircle2 size={16} /> {term.name} is current — attendance is open.</span>
              : <span className="flex items-center gap-1.5 text-amber-700"><AlertCircle size={16} /> {term.name} {termState === "past" ? "has ended" : "hasn't started"} — this register is paused{reopened ? " (reopened for corrections)" : ""}.</span>}
          </div>
          {locked && !reopened && (
            <button onClick={() => setReopened(true)} className="press flex items-center gap-1.5 rounded-xl bg-white px-3 py-1.5 text-xs font-bold text-amber-700 ring-1 ring-amber-300 transition hover:bg-amber-100">
              <Edit3 size={14} /> Reopen for corrections
            </button>
          )}
        </div>
      )}

      {/* Live tally for this session */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {ATT_STATUSES.map(s => (
          <span key={s.key} className="flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-bold shadow-sm ring-1 ring-slate-200" style={{ color: s.colour }}>
            <span className="flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-extrabold text-white" style={{ background: s.colour }}>{s.key}</span>
            {s.label} · {tally[s.key]}
          </span>
        ))}
        {unmarked > 0 && <span className="flex items-center gap-1.5 rounded-full bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-500 ring-1 ring-slate-200">Unmarked · {unmarked}</span>}
        <span className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold ring-1" style={{ background: pctTone(tally.pct).colour + "12", color: pctTone(tally.pct).colour }}>
          <Percent size={13} /> Session attendance {fmtPct(tally.pct)}
        </span>
        <div className="ml-auto flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
          <Search size={15} className="text-slate-400" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search student…" className="bg-transparent text-sm outline-none" />
        </div>
      </div>

      <div className="overflow-x-auto overflow-y-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 fade-up [-webkit-overflow-scrolling:touch] md:overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-5 py-3">Student</th>
                <th className="px-5 py-3">Email address</th>
                {ATT_STATUSES.map(s => <th key={s.key} className="px-3 py-3 text-center" title={s.label}><span style={{ color: s.colour }}>{s.key}</span></th>)}
                <th className="px-5 py-3">Remarks</th>
              </tr>
            </thead>
            <tbody>
              {/* Bulk-apply row — mirrors the "Set status for" control in Moodle. */}
              <tr className="border-t border-slate-100 bg-slate-50/60">
                <td className="px-5 py-3" colSpan={2}>
                  <div className="flex items-center justify-end gap-2">
                    <span className="text-xs font-bold text-slate-500">Set status for all {rows.length} students</span>
                    <select value={bulk} onChange={e => applyBulk(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold outline-none">
                      <option value="">unselected</option>
                      {ATT_STATUSES.map(s => <option key={s.key} value={s.key}>{s.key} — {s.label}</option>)}
                    </select>
                  </div>
                </td>
                {ATT_STATUSES.map(s => (
                  <td key={s.key} className="px-3 py-3 text-center">
                    <button onClick={() => applyBulk(s.key)} title={`Mark everyone ${s.label}`} aria-label={`Mark everyone ${s.label}`}
                      className="press mx-auto flex h-5 w-5 items-center justify-center rounded-full border-2 transition hover:scale-110"
                      style={{ borderColor: bulk === s.key ? s.colour : "#cbd5e1", background: bulk === s.key ? s.colour : "transparent" }}>
                      {bulk === s.key && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                    </button>
                  </td>
                ))}
                <td />
              </tr>
              {visible.map(r => {
                const cur = draft[r.student.id] || {};
                return (
                  <tr key={r.student.id} className="border-t border-slate-100 transition-colors duration-150 hover:bg-blue-50/30">
                    <td className="px-5 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-sm" style={{ background: r.student.colour }}>{r.student.initials}</span>
                        <div>
                          <p className="font-semibold" style={{ color: NAVY }}>{r.student.name}</p>
                          <p className="text-[11px] text-slate-400">
                            {r.student.studentRef}
                            {!r.enrolled && <span className="ml-1.5 rounded bg-slate-100 px-1 py-0.5 text-[9px] font-bold text-slate-500">NO LONGER ENROLLED</span>}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-2.5 text-slate-500">{r.student.email}</td>
                    {ATT_STATUSES.map(s => (
                      <td key={s.key} className="px-3 py-2.5 text-center">
                        <button onClick={() => setStatus(r.student.id, s.key)} title={s.label} aria-label={`${r.student.name}: ${s.label}`} aria-pressed={cur.status === s.key}
                          className="press mx-auto flex h-5 w-5 items-center justify-center rounded-full border-2 transition hover:scale-110"
                          style={{ borderColor: cur.status === s.key ? s.colour : "#cbd5e1", background: cur.status === s.key ? s.colour : "transparent" }}>
                          {cur.status === s.key && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                        </button>
                      </td>
                    ))}
                    <td className="px-5 py-2.5">
                      <input value={cur.remark || ""} onChange={e => setRemark(r.student.id, e.target.value)} placeholder="Add a comment…" maxLength={500}
                        className="w-full min-w-[180px] rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100" />
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 && <tr><td colSpan={7} className="px-5 py-10"><EmptyState Icon={Users} title={rows.length === 0 ? "No students enrolled" : "No students match"} msg={rows.length === 0 ? "Enrol students onto this unit before taking a register." : "Try a different search term."} /></td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-400">
          P = Present (2 pts) · L = Late (1) · E = Excused (1) · A = Absent (0). Click a selected mark again to clear it.
          {data.taken && rows.some(r => r.takenBy) && ` Last taken by ${rows.find(r => r.takenBy)?.takenBy}.`}
        </p>
        <PrimaryBtn onClick={save} disabled={!dirty || saving} colour={dirty ? NAVY : "#94a3b8"}>{saving ? <><Loader size={16} /> Saving…</> : <><Save size={16} /> Save register</>}</PrimaryBtn>
      </div>
    </>
  );
}
// Small spinner used inside buttons (lucide's Loader2 with the shared spin class).
function Loader({ size = 16 }) { return <RefreshCw size={size} className="animate-spin" />; }

/* ----- Attendance percentages: per unit + overall ----- */
function HndPercentages({ store }) {
  const { attendance } = store;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("name"); // name | overall
  const [courseId, setCourseId] = useState("");   // "" = every course
  const [showTutorial, setShowTutorial] = useState(false);
  // Everything derived here runs BEFORE the loading guard below, because usePaged is a
  // hook: skipping it on the first (attendance === null) render and calling it once the
  // data arrived changed the hook count between renders, which React rejects outright
  // ("Rendered more hooks than during the previous render") and crashes the whole app.
  const { units = [], rows = [], unitTotals = {}, overall = {} } = attendance || {};
  const ql = query.trim().toLowerCase();
  let list = rows.filter(r => !ql || r.student.name.toLowerCase().includes(ql) || r.student.studentRef.includes(ql) || (r.student.email || "").toLowerCase().includes(ql));

  // Every unit in the college as a column made this table unreadable: a row was mostly
  // "not enrolled", and the one figure that mattered was somewhere off to the right.
  //
  // Columns are now the units that the people ON SCREEN are actually enrolled on,
  // within the chosen course. Searching for one student therefore narrows the table to
  // that student's own units, which is the "as per course and student" the register is
  // for. The synthetic TUTORIAL units — one per course, holding imported tutorial and
  // seminar attendance — stay hidden unless asked for; four identical "TUTORIAL"
  // headings told nobody anything.
  const enrolledUnitIds = useMemo(() => {
    const seen = new Set();
    list.forEach(r => Object.keys(r.units || {}).forEach(id => { if (r.units[id]?.possible > 0) seen.add(id); }));
    return seen;
  }, [list]);

  const visibleUnits = useMemo(() => {
    const notTutorial = (m) => showTutorial || m.code !== "TUTORIAL";
    const pick = (useCourse) => units.filter(m => {
      if (!notTutorial(m)) return false;
      if (useCourse && courseId && m.courseId !== courseId) return false;
      // With a search running, keep only the columns those students actually sit.
      if (ql && !enrolledUnitIds.has(m.id)) return false;
      return true;
    });
    const scoped = pick(true);
    // Searching a student who isn't on the chosen course left the table with no unit
    // columns at all, which reads as "no data" rather than "wrong filter". The student
    // is the narrower, more deliberate choice, so their own units win.
    return (ql && scoped.length === 0) ? pick(false) : scoped;
  }, [units, courseId, showTutorial, ql, enrolledUnitIds]);
  list = sort === "overall"
    ? [...list].sort((a, b) => (a.overall.pct ?? 101) - (b.overall.pct ?? 101)) // lowest first — those needing chasing
    : list;
  const paged = usePaged(list, 12, `${ql}|${sort}`);
  if (!attendance) return <div className="skeleton h-64 rounded-2xl" />;

  const atRisk = rows.filter(r => r.overall.pct !== null && r.overall.pct < 70).length;
  const scopeName = semesterLabel(store.semesterId, store.semesters);
  const slug = scopeName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const exportCSV = () => {
    downloadCSV(`hnd-attendance-${slug}.csv`, [
      { key: "name", label: "Student" }, { key: "ref", label: "Student number" }, { key: "email", label: "Email" },
      ...visibleUnits.map(m => ({ key: m.id, label: `${m.code} %` })),
      { key: "overall", label: "Overall %" }, { key: "present", label: "Present" }, { key: "late", label: "Late" }, { key: "excused", label: "Excused" }, { key: "absent", label: "Absent" },
    ], rows.map(r => ({
      name: r.student.name, ref: r.student.studentRef, email: r.student.email,
      ...Object.fromEntries(visibleUnits.map(m => [m.id, r.units[m.id] ? r.units[m.id].pct : ""])),
      overall: r.overall.pct ?? "", present: r.overall.P, late: r.overall.L, excused: r.overall.E, absent: r.overall.A,
    })));
    store.notify(`Exported attendance CSV — ${scopeName}`);
  };

  // Nothing marked in this scope: say why rather than showing a table of dashes.
  if (attendance.scope?.sessionCount === 0 && store.semesterId) {
    return (
      <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200/70">
        <EmptyState Icon={CalendarDays} title={`No sessions in ${scopeName}`}
          msg="No registers fall inside this semester's dates, so there's nothing to calculate. Check the semester's start and end dates, or switch to All semesters." />
      </div>
    );
  }

  return (
    <>
      {store.semesterId && (
        <div className="mb-4 flex items-center gap-2 rounded-xl bg-blue-50/70 px-3.5 py-2.5 text-xs font-semibold text-blue-900 ring-1 ring-blue-100 fade-up">
          <CalendarDays size={14} />
          Showing <span className="font-extrabold">{scopeName}</span> only — {attendance.scope.sessionCount} session{attendance.scope.sessionCount === 1 ? "" : "s"} counted. Every percentage below is for this semester.
        </div>
      )}
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70 fade-up lg:col-span-2">
          <p className="mb-3 text-sm font-bold text-slate-700">Attendance by unit</p>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={visibleUnits.map(m => ({ code: m.code, pct: unitTotals[m.id]?.pct ?? 0 }))}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="code" tick={{ fontSize: 12, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
              <YAxis domain={[0, 100]} unit="%" tick={{ fontSize: 12, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 13 }} formatter={(v) => [`${v}%`, "Attendance"]} />
              <Bar dataKey="pct" radius={[6, 6, 0, 0]}>
                {visibleUnits.map(m => <Cell key={m.id} fill={pctTone(unitTotals[m.id]?.pct ?? null).colour} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70 fade-up">
          <p className="mb-3 text-sm font-bold text-slate-700">Across all units{store.semesterId ? ` · ${scopeName}` : ""}</p>
          <div className="flex items-center justify-center">
            <div className="relative h-36 w-36">
              <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
                <circle cx="60" cy="60" r="52" fill="none" stroke="#eef1f6" strokeWidth="14" />
                <circle cx="60" cy="60" r="52" fill="none" stroke={pctTone(overall.pct).colour} strokeWidth="14" strokeLinecap="round"
                  strokeDasharray={`${2 * Math.PI * 52}`} strokeDashoffset={`${2 * Math.PI * 52 * (1 - (overall.pct ?? 0) / 100)}`} style={{ transition: "stroke-dashoffset 1s ease" }} />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center scale-in">
                <span className="text-3xl font-extrabold tabular-nums" style={{ color: pctTone(overall.pct).colour }}>{fmtPct(overall.pct)}</span>
                <span className="text-[11px] font-medium text-slate-400">overall</span>
              </div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-4 gap-1.5 text-center">
            {ATT_STATUSES.map(s => (
              <div key={s.key} className="rounded-lg py-1.5" style={{ background: s.colour + "12" }}>
                <p className="text-sm font-extrabold" style={{ color: s.colour }}>{overall[s.key]}</p>
                <p className="text-[9px] font-medium text-slate-400">{s.label}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-center text-[11px] text-slate-400">{overall.earned} of {overall.possible} points across {overall.marked} marks</p>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
          <Search size={15} className="text-slate-400" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search student…" className="bg-transparent text-sm outline-none" />
        </div>
        <div className="flex gap-1 rounded-xl bg-white p-1 ring-1 ring-slate-200">
          {[{ k: "name", l: "A–Z" }, { k: "overall", l: "Lowest first" }].map(s => (
            <button key={s.k} onClick={() => setSort(s.k)} className={`press rounded-lg px-2.5 py-1.5 text-xs font-bold transition ${sort === s.k ? "text-white" : "text-slate-500 hover:bg-slate-100"}`} style={sort === s.k ? { background: NAVY } : {}}>{s.l}</button>
          ))}
        </div>
        {atRisk > 0 && <span className="flex items-center gap-1.5 rounded-full bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-700 ring-1 ring-rose-200"><AlertCircle size={13} /> {atRisk} below 70%</span>}
        <select value={courseId} onChange={e => setCourseId(e.target.value)}
          className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 outline-none focus:border-blue-400">
          <option value="">All courses</option>
          {(store.courses || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button type="button" onClick={() => setShowTutorial(v => !v)}
          title="Tutorial and seminar attendance imported from Moodle, held on a synthetic unit per course"
          className={`press rounded-xl px-3 py-1.5 text-xs font-bold ring-1 transition ${showTutorial ? "text-white ring-transparent" : "bg-white text-slate-500 ring-slate-200 hover:bg-slate-50"}`}
          style={showTutorial ? { background: NAVY } : {}}>
          Tutorials
        </button>
        <ExportBtn className="ml-auto" onClick={exportCSV} label="Export attendance" />
      </div>

      <div className="overflow-x-auto overflow-y-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 fade-up [-webkit-overflow-scrolling:touch] md:overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-5 py-3">Student</th>
                {visibleUnits.map(m => <th key={m.id} className="px-4 py-3 text-center" title={m.name}>{m.code}</th>)}
                <th className="px-5 py-3 text-center">Overall</th>
              </tr>
            </thead>
            <tbody>
              {paged.slice.map(r => (
                <tr key={r.student.id} className="border-t border-slate-100 transition-colors duration-150 hover:bg-blue-50/30">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-sm" style={{ background: r.student.colour }}>{r.student.initials}</span>
                      <div><p className="font-semibold text-slate-700">{r.student.name}</p><p className="text-[11px] text-slate-400">{r.student.studentRef}</p></div>
                    </div>
                  </td>
                  {visibleUnits.map(m => {
                    const cell = r.units[m.id];
                    if (!cell) return <td key={m.id} className="px-4 py-3 text-center text-xs text-slate-300">not enrolled</td>;
                    const tone = pctTone(cell.pct);
                    return (
                      <td key={m.id} className="px-4 py-3 text-center">
                        <span className={`inline-block rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ${tone.bg} ${tone.text} ${tone.ring}`} title={`${cell.P} present · ${cell.L} late · ${cell.E} excused · ${cell.A} absent (${cell.earned}/${cell.possible} pts)`}>
                          {fmtPct(cell.pct)}
                        </span>
                        <p className="mt-0.5 text-[9px] text-slate-400">{cell.marked} session{cell.marked === 1 ? "" : "s"}</p>
                      </td>
                    );
                  })}
                  <td className="px-5 py-3 text-center">
                    <span className={`inline-block rounded-lg px-3 py-1.5 text-xs font-extrabold ring-1 ${pctTone(r.overall.pct).bg} ${pctTone(r.overall.pct).text} ${pctTone(r.overall.pct).ring}`} title={`${r.overall.earned}/${r.overall.possible} points`}>
                      {fmtPct(r.overall.pct)}
                    </span>
                  </td>
                </tr>
              ))}
              {paged.slice.length === 0 && <tr><td colSpan={visibleUnits.length + 2} className="px-5 py-10"><EmptyState Icon={Percent} title="Nothing to show" msg="No students match, or no registers have been taken yet." /></td></tr>}
            </tbody>
            {paged.slice.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-slate-200 bg-slate-50">
                  <td className="px-5 py-3 text-xs font-extrabold uppercase tracking-wide text-slate-500">Cohort average</td>
                  {/* visibleUnits, not units — the header and every body row iterate
                      the filtered list, so iterating the unfiltered one here shifted
                      the whole footer sideways: with TUTORIAL units present (they sort
                      before UNIT01) the figure under UNIT01 was TUTORIAL's average, and
                      the last unit's average plus the real Overall fell off the end of
                      the table. Picking any course in the dropdown did the same. */}
                  {visibleUnits.map(m => (
                    <td key={m.id} className="px-4 py-3 text-center">
                      <span className="text-xs font-extrabold" style={{ color: pctTone(unitTotals[m.id]?.pct ?? null).colour }}>{fmtPct(unitTotals[m.id]?.pct ?? null)}</span>
                    </td>
                  ))}
                  <td className="px-5 py-3 text-center"><span className="text-sm font-extrabold" style={{ color: pctTone(overall.pct).colour }}>{fmtPct(overall.pct)}</span></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
      <Pagination className="mt-4" page={paged.page} setPage={paged.setPage} totalPages={paged.totalPages} total={paged.total} />
    </>
  );
}

/* ----- Students + enrolments ----- */
function HndStudents({ store }) {
  const [modal, setModal] = useState(false);
  const [edit, setEdit] = useState(null);
  const [form, setForm] = useState({ firstName: "", lastName: "", studentRef: "", email: "", cohortId: "", unitIds: [] });
  // Which course's units the picker shows. Only 4 of 136 students have a cohort, so
  // the course is worked out from the units they are ALREADY enrolled on, which is
  // unambiguous for almost all of them; the dropdown lets an admin set or change it.
  const [courseId, setCourseId] = useState("");
  const [query, setQuery] = useState("");

  // The course a student belongs to: their cohort if one is set, else the course
  // their existing units all belong to. Returns "" when it genuinely cannot be told.
  const courseOf = (s) => {
    const viaCohort = store.cohorts.find(c => c.id === s?.cohortId)?.courseId;
    if (viaCohort) return viaCohort;
    const ids = new Set((s?.unitIds || []).map(id => store.units.find(u => u.id === id)?.courseId).filter(Boolean));
    return ids.size === 1 ? [...ids][0] : "";
  };

  const openAdd = () => { setEdit(null); setForm({ firstName: "", lastName: "", studentRef: "", email: "", dob: "", cohortId: "", unitIds: [] }); setCourseId(""); setModal(true); };
  const openEdit = (s) => { setEdit(s); setForm({ firstName: s.firstName, lastName: s.lastName, studentRef: s.studentRef, email: s.email, dob: s.dob || "", cohortId: s.cohortId || "", unitIds: s.unitIds || [] }); setCourseId(courseOf(s)); setModal(true); };
  const toggleUnit = (id) => setForm(f => ({ ...f, unitIds: f.unitIds.includes(id) ? f.unitIds.filter(x => x !== id) : [...f.unitIds, id] }));

  // What the picker offers: this course's units only, and never the synthetic
  // "Tutorial / Seminar" units. Those exist to hold tutorial and seminar attendance
  // imported from Moodle, not as units a student is enrolled on one at a time — and
  // with one per course they appeared four times over as identical "TUTORIAL" rows.
  //
  // A unit the student is ALREADY on always stays listed even if it sits outside the
  // chosen course, so narrowing the course can never silently drop an enrolment the
  // admin cannot see to keep.
  const byCode = (a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true });
  const pickableUnits = useMemo(() => {
    const keep = store.units.filter(u => u.code !== "TUTORIAL");
    return (courseId ? keep.filter(u => u.courseId === courseId) : keep).slice().sort(byCode);
  }, [store.units, courseId]);
  // Units the student is already on that sit OUTSIDE the chosen course. They are kept
  // — narrowing the course must never silently drop an enrolment the admin cannot see
  // to keep — but listed apart and named by their course. Merged into one grid they
  // rendered as a second identical "UNIT 1" chip next to the course's own, with
  // nothing to tell the two apart.
  const otherCourseUnits = useMemo(() => {
    if (!courseId) return [];
    const shown = new Set(pickableUnits.map(u => u.id));
    return store.units
      .filter(u => form.unitIds.includes(u.id) && !shown.has(u.id) && u.code !== "TUTORIAL")
      .slice().sort(byCode);
  }, [store.units, courseId, form.unitIds, pickableUnits]);
  const save = async () => {
    try {
      if (edit) {
        await store.updateStudent(edit.id, { firstName: form.firstName, lastName: form.lastName, studentRef: form.studentRef, email: form.email, dob: form.dob || null, cohortId: form.cohortId || null });
        await store.setEnrolments(edit.id, form.unitIds);
      } else {
        await store.addStudent(form);
      }
      setModal(false);
    } catch (_e) { /* toast shown by the store; keep the modal open */ }
  };
  const remove = async (s) => {
    if (!window.confirm(`Remove ${s.name}?\n\nTheir enrolments, attendance marks, assessment grades, progress reviews and sign-up record will be deleted too, so the same email can register again.\n\nThis cannot be undone.`)) return;
    await store.removeStudent(s.id);
  };

  const ql = query.trim().toLowerCase();
  const filtered = store.students.filter(s => !ql || s.name.toLowerCase().includes(ql) || (s.email || "").toLowerCase().includes(ql) || s.studentRef.includes(ql));
  const paged = usePaged(filtered, 12, ql);
  // The email defaults to the student number, matching the college convention.
  const emailPreview = form.email || (form.studentRef ? `${form.studentRef}@edtech.co.uk` : "");

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
          <Search size={15} className="text-slate-400" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name, number or email…" className="w-full bg-transparent text-sm outline-none" />
        </div>
        <PrimaryBtn className="ml-auto" onClick={openAdd}><UserPlus size={16} /> Add student</PrimaryBtn>
      </div>
      <div className="overflow-x-auto overflow-y-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 fade-up [-webkit-overflow-scrolling:touch] md:overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-400">
              <tr><th className="px-5 py-3">Student</th><th className="px-5 py-3">Number</th><th className="px-5 py-3">Email address</th><th className="px-5 py-3">Units</th><th className="px-5 py-3 text-right">Actions</th></tr>
            </thead>
            <tbody>
              {paged.slice.map(s => (
                <tr key={s.id} className="border-t border-slate-100 transition-colors duration-150 hover:bg-blue-50/30">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-sm" style={{ background: s.colour }}>{s.initials}</span>
                      <span className="font-semibold text-slate-700">{s.name}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3 font-medium tabular-nums text-slate-600">{s.studentRef}</td>
                  <td className="px-5 py-3 text-slate-500">{s.email}</td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(s.unitIds || []).map(id => { const m = store.units.find(x => x.id === id); return m ? <span key={id} className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">{m.code}</span> : null; })}
                      {(s.unitIds || []).length === 0 && <span className="text-[11px] text-slate-300">none</span>}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => openEdit(s)} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"><Edit3 size={15} /></button>
                      <button onClick={() => remove(s)} className="rounded-lg p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"><Trash2 size={15} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {paged.slice.length === 0 && <tr><td colSpan={5} className="px-5 py-10"><EmptyState Icon={Users} title="No students" msg="Add a student to start building your registers." /></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <Pagination className="mt-4" page={paged.page} setPage={paged.setPage} totalPages={paged.totalPages} total={paged.total} />

      <Modal open={modal} onClose={() => setModal(false)} title={edit ? "Edit student" : "Add student"}>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name"><input value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} className={inputCls} /></Field>
            <Field label="Last name"><input value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} className={inputCls} /></Field>
          </div>
          <Field label="Student number"><input value={form.studentRef} onChange={e => setForm(f => ({ ...f, studentRef: e.target.value }))} placeholder="e.g. 100121" className={inputCls} /></Field>
          <Field label="Email address"><input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder={emailPreview || "100121@edtech.co.uk"} className={inputCls} /></Field>
          {!form.email && emailPreview && <p className="-mt-1 text-[11px] text-slate-400">Leave blank to use <span className="font-semibold">{emailPreview}</span></p>}
          <Field label="Cohort (intake)">
            <select value={form.cohortId} onChange={e => setForm(f => ({ ...f, cohortId: e.target.value }))} className={inputCls}>
              <option value="">— none —</option>
              {store.cohorts.map(c => { const p = store.courses.find(x => x.id === c.courseId); return <option key={c.id} value={c.id}>{p ? `${p.name} — ${c.name}` : c.name}</option>; })}
            </select>
          </Field>
          <Field label="Date of birth"><input type="date" value={form.dob} onChange={e => setForm(f => ({ ...f, dob: e.target.value }))} className={inputCls} /></Field>
          <Field label="Course">
            <select value={courseId} onChange={e => setCourseId(e.target.value)} className={inputCls}>
              <option value="">— all courses —</option>
              {store.courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <p className="mt-1 text-[11px] text-slate-400">
              {courseId ? "Only this course's units are listed below." : "Pick a course to narrow the list — every unit in the college is shown."}
            </p>
          </Field>
          <Field label="Units">
            <div className="grid grid-cols-2 gap-1.5">
              {pickableUnits.map(m => (
                <button key={m.id} onClick={() => toggleUnit(m.id)} type="button"
                  className={`press flex items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs font-bold ring-1 transition ${form.unitIds.includes(m.id) ? "text-white ring-transparent" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50"}`}
                  style={form.unitIds.includes(m.id) ? { background: NAVY } : {}}>
                  <span className={`flex h-4 w-4 items-center justify-center rounded border-2 ${form.unitIds.includes(m.id) ? "border-white bg-white/20" : "border-slate-300"}`}>
                    {form.unitIds.includes(m.id) && <Check size={10} className="text-white" />}
                  </span>
                  {m.code}
                </button>
              ))}
              {pickableUnits.length === 0 && <p className="col-span-2 text-xs text-slate-400">{store.units.length === 0 ? "No units yet — add one on the Units tab." : "This course has no units yet."}</p>}
            </div>
            {otherCourseUnits.length > 0 && (
              <div className="mt-2.5 rounded-xl bg-amber-50/60 p-2.5 ring-1 ring-amber-200">
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-amber-700">Also enrolled on · from another course</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {otherCourseUnits.map(m => { const c = store.courses.find(x => x.id === m.courseId); return (
                    <button key={m.id} onClick={() => toggleUnit(m.id)} type="button" title={`${m.name}${c ? ` — ${c.name}` : ""}`}
                      className={`press flex items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs font-bold ring-1 transition ${form.unitIds.includes(m.id) ? "text-white ring-transparent" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50"}`}
                      style={form.unitIds.includes(m.id) ? { background: NAVY } : {}}>
                      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border-2 ${form.unitIds.includes(m.id) ? "border-white bg-white/20" : "border-slate-300"}`}>
                        {form.unitIds.includes(m.id) && <Check size={10} className="text-white" />}
                      </span>
                      <span className="min-w-0"><span className="block">{m.code}</span><span className={`block truncate text-[9px] font-semibold ${form.unitIds.includes(m.id) ? "text-white/70" : "text-slate-400"}`}>{shortCourse(c?.name) || "Other course"}</span></span>
                    </button>
                  ); })}
                </div>
                <p className="mt-1.5 text-[10px] text-amber-700">Untick to remove one — otherwise these stay as they are.</p>
              </div>
            )}
          </Field>
          <PrimaryBtn onClick={save} disabled={!form.firstName.trim() || !form.lastName.trim() || !form.studentRef.trim()} className="w-full">
            <Save size={16} /> {edit ? "Save changes" : "Add student"}
          </PrimaryBtn>
        </div>
      </Modal>
    </>
  );
}

/* ============================================================
   Dashboard: Students — a full directory of every HND student
   with all their details and complete CRUD. Its own top-level
   admin tab (the Registers section keeps a lighter copy).
   ============================================================ */
function AdminStudents({ store }) {
  const { refreshHnd, hndLoaded } = store;
  const [modal, setModal] = useState(false);
  const [edit, setEdit] = useState(null);
  const [form, setForm] = useState({ firstName: "", lastName: "", studentRef: "", email: "", active: true, cohortId: "", unitIds: [] });
  const [query, setQuery] = useState("");
  const [unitFilter, setUnitFilter] = useState("");     // "" = any unit
  const [statusFilter, setStatusFilter] = useState("all");  // all | active | inactive
  const [riskFilter, setRiskFilter] = useState("all");  // all | High Risk | Monitor | Good | Excellent | Perfect
  const [attnFor, setAttnFor] = useState(null);             // student whose breakdown is open
  // Which course's units the picker shows. Only 4 of 136 students have a cohort, so
  // the course is worked out from the units they are ALREADY enrolled on, which is
  // unambiguous for almost all of them; the dropdown lets an admin set or change it.
  const [courseId, setCourseId] = useState("");

  // The course a student belongs to: their cohort if one is set, else the course
  // their existing units all belong to. Returns "" when it genuinely cannot be told.
  const courseOf = (s) => {
    const viaCohort = store.cohorts.find(c => c.id === s?.cohortId)?.courseId;
    if (viaCohort) return viaCohort;
    const ids = new Set((s?.unitIds || []).map(id => store.units.find(u => u.id === id)?.courseId).filter(Boolean));
    return ids.size === 1 ? [...ids][0] : "";
  };

  // The Students tab can be opened without visiting Registers first, so pull the
  // HND collections in on mount (refreshHnd is a no-op cost if already loaded).
  useEffect(() => { refreshHnd(); }, [refreshHnd]);

  // Each student's overall attendance %, plus the full per-unit row, from the
  // same scoped figures the registers page shows.
  const attnRowById = Object.fromEntries((store.attendance?.rows || []).map(r => [r.student.id, r]));
  const unitById = Object.fromEntries(store.units.map(m => [m.id, m]));

  // Each student's overall % counts only their CURRENT, still-enrolled units. A unit
  // finishes once its last session (endDate) has passed, so the figure rolls over
  // automatically. We iterate the student's ENROLMENTS (s.unitIds) — not every unit
  // in row.units — so leftover marks from units the student was un-enrolled from
  // don't count. This matches the per-student breakdown modal exactly.
  const attnToday = todayISO();
  const unitEndById = {};
  (store.sessions || []).forEach(se => { const cur = unitEndById[se.unitId]; if (!cur || se.date > cur) unitEndById[se.unitId] = se.date; });
  // Same rule as unitStatus and the server: the unit's own end date wins, with the
  // last session as the fallback. Using sessions alone made this drawer call a unit
  // finished days before the Registers tab and the student's own app did.
  const isCurrentUnit = (mid) => { const end = unitById[mid]?.endDate || unitEndById[mid]; return !end || end >= attnToday; };
  const currentPctOf = (s) => {
    const row = attnRowById[s.id];
    if (!row) return null;
    let earned = 0, possible = 0;
    (s.unitIds || []).forEach(mid => { if (isCurrentUnit(mid)) { const st = row.units[mid]; if (st) { earned += st.earned || 0; possible += st.possible || 0; } } });
    return possible > 0 ? Math.round((earned / possible) * 1000) / 10 : null;
  };
  // Lifetime % across EVERY unit the student has been enrolled on. The Attendance-Risk
  // badge and its filter use this, so the list agrees with the rating shown inside the
  // student dashboard — those two used to read different figures, so a red "High Risk"
  // row could open onto a green "Excellent" rating.
  const allPctOf = (s) => {
    const row = attnRowById[s.id];
    if (!row) return null;
    let earned = 0, possible = 0;
    (s.unitIds || []).forEach(mid => { const st = row.units[mid]; if (st) { earned += st.earned || 0; possible += st.possible || 0; } });
    return possible > 0 ? Math.round((earned / possible) * 1000) / 10 : null;
  };

  const openAdd = () => { setEdit(null); setForm({ firstName: "", lastName: "", studentRef: "", email: "", dob: "", active: true, cohortId: "", unitIds: [] }); setCourseId(""); setModal(true); };
  const openEdit = (s) => { setEdit(s); setForm({ firstName: s.firstName, lastName: s.lastName, studentRef: s.studentRef, email: s.email, dob: s.dob || "", active: s.active !== false, cohortId: s.cohortId || "", unitIds: s.unitIds || [] }); setCourseId(courseOf(s)); setModal(true); };
  const toggleUnit = (id) => setForm(f => ({ ...f, unitIds: f.unitIds.includes(id) ? f.unitIds.filter(x => x !== id) : [...f.unitIds, id] }));

  // What the picker offers: this course's units only, and never the synthetic
  // "Tutorial / Seminar" units. Those exist to hold tutorial and seminar attendance
  // imported from Moodle, not as units a student is enrolled on one at a time — and
  // with one per course they appeared four times over as identical "TUTORIAL" rows.
  //
  // A unit the student is ALREADY on always stays listed even if it sits outside the
  // chosen course, so narrowing the course can never silently drop an enrolment the
  // admin cannot see to keep.
  const byCode = (a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true });
  const pickableUnits = useMemo(() => {
    const keep = store.units.filter(u => u.code !== "TUTORIAL");
    return (courseId ? keep.filter(u => u.courseId === courseId) : keep).slice().sort(byCode);
  }, [store.units, courseId]);
  // Units the student is already on that sit OUTSIDE the chosen course. They are kept
  // — narrowing the course must never silently drop an enrolment the admin cannot see
  // to keep — but listed apart and named by their course. Merged into one grid they
  // rendered as a second identical "UNIT 1" chip next to the course's own, with
  // nothing to tell the two apart.
  const otherCourseUnits = useMemo(() => {
    if (!courseId) return [];
    const shown = new Set(pickableUnits.map(u => u.id));
    return store.units
      .filter(u => form.unitIds.includes(u.id) && !shown.has(u.id) && u.code !== "TUTORIAL")
      .slice().sort(byCode);
  }, [store.units, courseId, form.unitIds, pickableUnits]);
  const save = async () => {
    try {
      if (edit) {
        await store.updateStudent(edit.id, { firstName: form.firstName, lastName: form.lastName, studentRef: form.studentRef, email: form.email, dob: form.dob || null, active: form.active, cohortId: form.cohortId || null });
        await store.setEnrolments(edit.id, form.unitIds);
      } else {
        await store.addStudent({ firstName: form.firstName, lastName: form.lastName, studentRef: form.studentRef, email: form.email, dob: form.dob || null, cohortId: form.cohortId || null, unitIds: form.unitIds });
      }
      setModal(false);
    } catch (_e) { /* toast shown by the store; keep the modal open */ }
  };
  const remove = async (s) => {
    if (!window.confirm(`Remove ${s.name}?\n\nTheir enrolments, attendance marks, assessment grades, progress reviews and sign-up record will be deleted too, so the same email can register again.\n\nThis cannot be undone.`)) return;
    await store.removeStudent(s.id);
  };

  const ql = query.trim().toLowerCase();
  const filtered = store.students.filter(s => {
    if (statusFilter === "active" && s.active === false) return false;
    if (statusFilter === "inactive" && s.active !== false) return false;
    if (unitFilter && !(s.unitIds || []).includes(unitFilter)) return false;
    if (riskFilter !== "all" && riskBand(allPctOf(s)).label !== riskFilter) return false;
    return !ql || s.name.toLowerCase().includes(ql) || (s.email || "").toLowerCase().includes(ql) || s.studentRef.includes(ql);
  });
  const paged = usePaged(filtered, 12, `${ql}|${unitFilter}|${statusFilter}|${riskFilter}`);
  const emailPreview = form.email || (form.studentRef ? `${form.studentRef}@edtech.co.uk` : "");

  // Headline figures.
  const total = store.students.length;
  const activeCount = store.students.filter(s => s.active !== false).length;
  const enrolledCount = store.students.filter(s => (s.unitIds || []).length > 0).length;
  // Weighted by sessions, not a mean of percentages. Averaging the percentages let a
  // student marked once (0%) count as much as one marked fifty times (100%), so this
  // tile could read 50% while the Registers tab's donut — computed properly — read
  // 98% for the same population.
  const avgAtt = (() => {
    let earned = 0, possible = 0;
    store.students.forEach(s => {
      const row = attnRowById[s.id];
      if (!row) return;
      (s.unitIds || []).forEach(mid => { if (isCurrentUnit(mid)) { const st = row.units[mid]; if (st) { earned += st.earned || 0; possible += st.possible || 0; } } });
    });
    return possible > 0 ? Math.round((earned / possible) * 1000) / 10 : null;
  })();

  const exportStudents = () => {
    downloadCSV(
      "students.csv",
      [
        { key: "firstName", label: "First name" }, { key: "lastName", label: "Last name" },
        { key: "studentRef", label: "Student number" }, { key: "email", label: "Email" },
        { key: "status", label: "Status" }, { key: "units", label: "Units" },
        { key: "attendance", label: "Current-unit attendance" },
        { key: "lifetime", label: "All-unit attendance" }, { key: "risk", label: "Attendance risk" },
      ],
      filtered.map(s => ({
        firstName: s.firstName, lastName: s.lastName, studentRef: s.studentRef, email: s.email,
        status: s.active === false ? "Inactive" : "Active",
        units: (s.unitIds || []).map(id => unitById[id]?.code).filter(Boolean).join(" "),
        attendance: currentPctOf(s) == null ? "" : `${currentPctOf(s)}%`,
        lifetime: allPctOf(s) == null ? "" : `${allPctOf(s)}%`,
        risk: riskBand(allPctOf(s)).label,
      })),
    );
    store.notify?.("Exported students CSV");
  };

  if (!hndLoaded) {
    return (
      <>
        <AdminHeader title="Students" subtitle="Loading the student directory…" Icon={GraduationCap} />
        <div className="space-y-3">{[0, 1, 2].map(i => <div key={i} className="skeleton h-16 rounded-2xl" />)}</div>
      </>
    );
  }

  return (
    <>
      <AdminHeader
        title="Students"
        subtitle="Every HND student on record — full details and management"
        Icon={GraduationCap}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ExportBtn onClick={exportStudents} label="Export" />
            <PrimaryBtn onClick={openAdd}><UserPlus size={16} /> Add student</PrimaryBtn>
          </div>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Total students" value={total} sub="on the HND course" Icon={Users} tone={NAVY} delay={0} animate />
        <StatCard label="Active" value={activeCount} sub={`${total - activeCount} inactive`} Icon={UserCheck} tone="#0d7a5f" delay={60} animate />
        <StatCard label="On a course" value={enrolledCount} sub="enrolled on ≥1 unit" Icon={BookOpen} tone="#6d28d9" delay={120} animate />
        <StatCard label="Avg attendance" value={fmtPct(avgAtt)} sub="across all students" Icon={Percent} tone={pctTone(avgAtt).colour} delay={180} animate />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
          <Search size={15} className="text-slate-400" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name, number or email…" className="w-48 bg-transparent text-sm outline-none sm:w-64" />
        </div>
        <div className="flex gap-1 rounded-xl bg-white p-1 ring-1 ring-slate-200">
          {[{ k: "all", l: "All" }, { k: "active", l: "Active" }, { k: "inactive", l: "Inactive" }].map(f => (
            <button key={f.k} onClick={() => setStatusFilter(f.k)} className={`press rounded-lg px-2.5 py-1.5 text-xs font-bold transition ${statusFilter === f.k ? "text-white" : "text-slate-500 hover:bg-slate-100"}`} style={statusFilter === f.k ? { background: NAVY } : {}}>{f.l}</button>
          ))}
        </div>
        {store.units.length > 0 && (
          <select value={unitFilter} onChange={e => setUnitFilter(e.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 outline-none">
            <option value="">All units</option>
            {store.units.map(m => <option key={m.id} value={m.id}>{m.code} — {m.name}</option>)}
          </select>
        )}
        {/* Filter by attendance-risk flag (red = High Risk). */}
        <select value={riskFilter} onChange={e => setRiskFilter(e.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 outline-none">
          <option value="all">All risk levels</option>
          <option value="High Risk">🔴 High Risk</option>
          <option value="Monitor">🟠 Monitor</option>
          <option value="Good">🟡 Good</option>
          <option value="Excellent">🟢 Excellent</option>
          <option value="Perfect">🟣 Perfect</option>
          <option value="No data">⚪ No data</option>
        </select>
        {riskFilter === "High Risk" && <span className="rounded-full bg-rose-50 px-2 py-1 text-[11px] font-bold text-rose-600 ring-1 ring-rose-200">Showing red flags</span>}
        <span className="ml-auto text-xs font-semibold text-slate-400">{filtered.length} of {total}</span>
      </div>

      <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 fade-up">
        <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
          <table className="w-full min-w-[680px] text-sm">
            <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-400">
              <tr><th className="px-5 py-3">Student</th><th className="px-5 py-3">Email address</th><th className="px-5 py-3 whitespace-nowrap" title="Based on attendance across ALL units">Attendance risk</th><th className="px-5 py-3">Units</th><th className="px-5 py-3 text-center whitespace-nowrap" title="Current units only">Current %</th><th className="px-5 py-3 text-right">Actions</th></tr>
            </thead>
            <tbody>
              {paged.slice.map(s => {
                const pct = currentPctOf(s);      // current units (the % pill)
                const lifetimePct = allPctOf(s);   // all units (the risk badge + filter)
                const tone = pctTone(pct ?? null);
                return (
                  <tr key={s.id} className="border-t border-slate-100 transition-colors duration-150 hover:bg-blue-50/30">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-sm" style={{ background: s.colour }}>{s.initials}</span>
                        <div className="min-w-0">
                          <p className="font-semibold text-slate-700">{s.name}</p>
                          <p className="text-[11px] tabular-nums text-slate-400">{s.studentRef}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-slate-500"><span className="block max-w-[220px] truncate" title={s.email}>{s.email}</span></td>
                    <td className="px-5 py-3">
                      {(() => { const b = riskBand(lifetimePct); return <span className="inline-block rounded-full px-2.5 py-1 text-[11px] font-bold" style={{ background: b.bg, color: b.colour }} title={lifetimePct == null ? "No attendance data" : `${lifetimePct}% attendance across all units`}>{b.label}</span>; })()}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex max-w-[200px] flex-wrap gap-1">
                        {(s.unitIds || []).map(id => { const m = unitById[id]; return m ? <span key={id} className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-600" title={m.name}>{m.code}</span> : null; })}
                        {(s.unitIds || []).length === 0 && <span className="text-[11px] text-slate-300">none</span>}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-center">
                      <button onClick={() => setAttnFor(s)} title="View attendance breakdown" className={`press rounded-lg px-2 py-1 text-xs font-extrabold tabular-nums transition hover:ring-2 hover:ring-inset hover:ring-slate-300 ${tone.bg} ${tone.text}`}>{fmtPct(pct ?? null)}</button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1 whitespace-nowrap">
                        <button onClick={() => setAttnFor(s)} title="Attendance breakdown" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-blue-50 hover:text-blue-600"><BarChart3 size={15} /></button>
                        <button onClick={() => openEdit(s)} title="Edit student" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"><Edit3 size={15} /></button>
                        <button onClick={() => remove(s)} title="Delete student" className="rounded-lg p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"><Trash2 size={15} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {paged.slice.length === 0 && <tr><td colSpan={6} className="px-5 py-10"><EmptyState Icon={Users} title={total === 0 ? "No students yet" : "No students match"} msg={total === 0 ? "Add your first student to start building registers." : "Try a different search or filter."} /></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <Pagination className="mt-4" page={paged.page} setPage={paged.setPage} totalPages={paged.totalPages} total={paged.total} />

      <Modal open={modal} onClose={() => setModal(false)} title={edit ? "Edit student" : "Add student"} width={520}>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name"><input value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} className={inputCls} /></Field>
            <Field label="Last name"><input value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} className={inputCls} /></Field>
          </div>
          <Field label="Student number"><input value={form.studentRef} onChange={e => setForm(f => ({ ...f, studentRef: e.target.value }))} placeholder="e.g. 100121" className={inputCls} /></Field>
          <Field label="Email address"><input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder={emailPreview || "100121@edtech.co.uk"} className={inputCls} /></Field>
          {!form.email && emailPreview && <p className="-mt-1 text-[11px] text-slate-400">Leave blank to use <span className="font-semibold">{emailPreview}</span></p>}
          <Field label="Cohort (intake)">
            <select value={form.cohortId} onChange={e => setForm(f => ({ ...f, cohortId: e.target.value }))} className={inputCls}>
              <option value="">— none —</option>
              {store.cohorts.map(c => { const p = store.courses.find(x => x.id === c.courseId); return <option key={c.id} value={c.id}>{p ? `${p.name} — ${c.name}` : c.name}</option>; })}
            </select>
          </Field>
          <Field label="Date of birth"><input type="date" value={form.dob} onChange={e => setForm(f => ({ ...f, dob: e.target.value }))} className={inputCls} /></Field>
          {edit && (
            <Field label="Status">
              <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
                {[{ v: true, l: "Active" }, { v: false, l: "Inactive" }].map(o => (
                  <button key={String(o.v)} type="button" onClick={() => setForm(f => ({ ...f, active: o.v }))} className={`press flex-1 rounded-lg py-2 text-xs font-bold transition ${form.active === o.v ? "bg-white text-slate-700 shadow-sm" : "text-slate-400"}`}>{o.l}</button>
                ))}
              </div>
            </Field>
          )}
          <Field label="Course">
            <select value={courseId} onChange={e => setCourseId(e.target.value)} className={inputCls}>
              <option value="">— all courses —</option>
              {store.courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <p className="mt-1 text-[11px] text-slate-400">
              {courseId ? "Only this course's units are listed below." : "Pick a course to narrow the list — every unit in the college is shown."}
            </p>
          </Field>
          <Field label={`Units${form.unitIds.length ? ` · ${form.unitIds.length} selected` : ""}`}>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {pickableUnits.map(m => (
                <button key={m.id} onClick={() => toggleUnit(m.id)} type="button"
                  className={`press flex items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs font-bold ring-1 transition ${form.unitIds.includes(m.id) ? "text-white ring-transparent" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50"}`}
                  style={form.unitIds.includes(m.id) ? { background: NAVY } : {}} title={m.name}>
                  <span className={`flex h-4 w-4 items-center justify-center rounded border-2 ${form.unitIds.includes(m.id) ? "border-white bg-white/20" : "border-slate-300"}`}>
                    {form.unitIds.includes(m.id) && <Check size={10} className="text-white" />}
                  </span>
                  {m.code}
                </button>
              ))}
              {pickableUnits.length === 0 && <p className="col-span-2 text-xs text-slate-400 sm:col-span-3">{store.units.length === 0 ? "No units yet — add one on the Units tab." : "This course has no units yet."}</p>}
            </div>
            {otherCourseUnits.length > 0 && (
              <div className="mt-2.5 rounded-xl bg-amber-50/60 p-2.5 ring-1 ring-amber-200">
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-amber-700">Also enrolled on · from another course</p>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                  {otherCourseUnits.map(m => { const c = store.courses.find(x => x.id === m.courseId); return (
                    <button key={m.id} onClick={() => toggleUnit(m.id)} type="button" title={`${m.name}${c ? ` — ${c.name}` : ""}`}
                      className={`press flex items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs font-bold ring-1 transition ${form.unitIds.includes(m.id) ? "text-white ring-transparent" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50"}`}
                      style={form.unitIds.includes(m.id) ? { background: NAVY } : {}}>
                      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border-2 ${form.unitIds.includes(m.id) ? "border-white bg-white/20" : "border-slate-300"}`}>
                        {form.unitIds.includes(m.id) && <Check size={10} className="text-white" />}
                      </span>
                      <span className="min-w-0"><span className="block">{m.code}</span><span className={`block truncate text-[9px] font-semibold ${form.unitIds.includes(m.id) ? "text-white/70" : "text-slate-400"}`}>{shortCourse(c?.name) || "Other course"}</span></span>
                    </button>
                  ); })}
                </div>
                <p className="mt-1.5 text-[10px] text-amber-700">Untick to remove one — otherwise these stay as they are.</p>
              </div>
            )}
          </Field>
          <PrimaryBtn onClick={save} disabled={!form.firstName.trim() || !form.lastName.trim() || !form.studentRef.trim()} className="w-full">
            <Save size={16} /> {edit ? "Save changes" : "Add student"}
          </PrimaryBtn>
        </div>
      </Modal>

      <Modal open={!!attnFor} onClose={() => setAttnFor(null)} title="Student dashboard" width={560}>
        {attnFor && <StudentAttendanceDetail student={attnFor} store={store} />}
      </Modal>
    </>
  );
}

// One student's attendance, broken down per unit and overall. Reads the same
// scoped figures as the registers page (row comes from store.attendance.rows).
// Per-student attendance grouped BY TERM: the current (active) term's overall +
// units, then each previous term as its own collapsible record. The overall is
// scoped to the current term only, so it resets each term.
function StudentAttendanceDetail({ student, store }) {
  const R = 42, CIRC = 2 * Math.PI * R;

  // Assessment results + month-by-month attendance for this student (dashboard).
  const [assess, setAssess] = useState(null);
  const [monthly, setMonthly] = useState(null);
  // Results come from the gradebook, which is gated on the "assessments" page. An
  // admin with Students but not Assessments gets a 403 — we record that so the UI can
  // say "no permission" instead of silently implying the student has no marks.
  const [assessDenied, setAssessDenied] = useState(false);
  useEffect(() => {
    let alive = true; setAssess(null); setMonthly(null); setAssessDenied(false);
    // Fetch independently: a 403 on results must not also blank the attendance chart.
    api.adminStudentAssessments(student.id)
      .then(a => { if (alive) setAssess(a); })
      .catch(e => { if (alive && e?.status === 403) setAssessDenied(true); });
    api.attendanceMonthly({ studentId: student.id })
      .then(m => { if (alive) setMonthly(m); })
      .catch(() => { /* chart just stays hidden */ });
    return () => { alive = false; };
  }, [student.id]);

  // Computed entirely from data the Students tab already loads — no extra request,
  // so it works instantly and doesn't depend on the API being redeployed.
  //
  // A unit is FINISHED when its own teaching window (unit.endDate) has passed; its
  // last session date is only the fallback for a unit nobody has scheduled. That is
  // the rule the server (/students/:id/attendance-terms) and the student's own app
  // both use. This screen used the last-session date ALONE, so a unit whose registers
  // were generated one term at a time read "current" on the student's phone and
  // "previous" here — 78% against 90% for the same student on the same day, with the
  // at-risk unit tucked out of sight under Previous.
  const today = todayISO();
  const row = (store.attendance?.rows || []).find(r => r.student.id === student.id) || null;
  const unitById = Object.fromEntries((store.units || []).map(m => [m.id, m]));
  const endByUnit = {};
  (store.sessions || []).forEach(se => { const cur = endByUnit[se.unitId]; if (!cur || se.date > cur) endByUnit[se.unitId] = se.date; });
  const emptyStats = { P: 0, L: 0, E: 0, A: 0, marked: 0, earned: 0, possible: 0, pct: null };
  const unitRows = (student.unitIds || []).map(mid => {
    const mod = unitById[mid] || { id: mid, code: "?", name: "Unknown unit" };
    // The unit's own end date wins; its last register is only the fallback.
    const endDate = mod.endDate || endByUnit[mid] || null;
    return { unit: { id: mod.id, code: mod.code, name: mod.name }, summary: row?.units?.[mid] || emptyStats, endDate, finished: !!(endDate && endDate < today) };
  });
  const currentUnits = unitRows.filter(r => !r.finished).sort((a, b) => (a.endDate || "9999").localeCompare(b.endDate || "9999"));
  const previous = unitRows.filter(r => r.finished).sort((a, b) => (b.endDate || "").localeCompare(a.endDate || ""));
  const overall = aggregateStats(currentUnits.map(r => r.summary));
  const current = { units: currentUnits, overall };
  // Lifetime attendance across every unit the student has studied (current + previous).
  const allOverall = aggregateStats(unitRows.map(r => r.summary));

  // ---- Dashboard metrics (results + attendance rating + charts) ----
  const gradedItems = (assess?.assessments || []).filter(a => a.pct != null);
  const avgMark = assess?.averagePct ?? null;                       // average graded %
    // 50 is the Pass boundary (see bandOf). A literal 40 here disagreed with every
  // other pass figure in the app, and with the Fail badges rendered directly below.
  const passRate = gradedItems.length ? Math.round(gradedItems.filter(a => a.pct >= PASS_MARK).length / gradedItems.length * 1000) / 10 : null;
  const enrolledCount = (student.unitIds || []).length;
  const unitsWithMark = new Set(gradedItems.map(a => a.unitId)).size; // "completed" = has a final mark
  // Final mark by unit code = the student's average % per unit (donut).
  const byUnit = (() => {
    const m = new Map();
    for (const a of gradedItems) { const g = m.get(a.unitCode) || { sum: 0, n: 0 }; g.sum += a.pct; g.n++; m.set(a.unitCode, g); }
    return [...m.entries()].map(([code, g]) => ({ code, mark: Math.round(g.sum / g.n) }));
  })();
  // Attendance rating uses lifetime attendance across all units.
  const rating = riskBand(allOverall.pct);
  const monthData = (monthly?.months || []).map(m => ({ label: fmtMonth(m.month), pct: m.pct }));
  const firstCourse = (() => { const c = (store.cohorts || []).find(c => c.id === student.cohortId); return c?.name || unitRows[0]?.unit.code || "—"; })();

  const header = (
    <div className="flex items-center gap-3">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white shadow-sm" style={{ background: student.colour }}>{student.initials}</span>
      <div className="min-w-0">
        <p className="truncate text-base font-extrabold" style={{ color: NAVY_DARK }}>{student.name}</p>
        <p className="truncate text-xs text-slate-400">{student.studentRef} · {student.email}</p>
      </div>
    </div>
  );

  const fmtDate = (iso) => { if (!iso) return null; const [y, m, d] = iso.split("-"); const mm = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1] || m; return `${Number(d)} ${mm} ${y}`; };

  const UnitRow = ({ mod, stats, i, end, ended }) => {
    const t = pctTone(stats.pct ?? null);
    return (
      <div className={`flex items-center gap-3 px-3.5 py-2.5 ${i ? "border-t border-slate-100" : ""}`}>
        <span className="flex h-8 w-11 shrink-0 items-center justify-center rounded-lg text-[10px] font-extrabold text-white" style={{ background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` }}>{mod.code.slice(0, 5)}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-bold text-slate-700" title={mod.name}>{mod.name}</p>
          {end
            ? <p className="mt-0.5 text-[10px] font-medium text-slate-400">{ended ? "Ended" : "Ends"} {fmtDate(end)}</p>
            : <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full" style={{ width: `${stats.pct ?? 0}%`, background: t.colour }} /></div>}
        </div>
        <div className="shrink-0 text-right text-[10px] font-semibold tabular-nums text-slate-400">
          <span style={{ color: ATT_STATUSES[0].colour }}>P{stats.P}</span> <span style={{ color: ATT_STATUSES[1].colour }}>L{stats.L}</span> <span style={{ color: ATT_STATUSES[2].colour }}>E{stats.E}</span> <span style={{ color: ATT_STATUSES[3].colour }}>A{stats.A}</span>
          <span className="ml-1 text-slate-300">· {stats.marked} marked</span>
        </div>
        <span className={`shrink-0 rounded-lg px-2 py-1 text-xs font-extrabold tabular-nums ${t.bg} ${t.text}`}>{fmtPct(stats.pct ?? null)}</span>
      </div>
    );
  };

  if (!store.attendance) return <div className="space-y-4">{header}<div className="skeleton h-48 rounded-2xl" /></div>;

  const oTone = pctTone(current.overall.pct ?? null);

  const allTone = pctTone(allOverall.pct ?? null);

  return (
    <div className="space-y-4">
      {header}

      {/* Two headline figures: current units only, and lifetime across all units. */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl bg-white p-4 text-center shadow-sm ring-1 ring-slate-200/70">
          <p className="text-3xl font-extrabold tabular-nums" style={{ color: oTone.colour }}>{fmtPct(current.overall.pct ?? null)}</p>
          <p className="mt-0.5 text-xs font-bold text-slate-600">Current units</p>
          <p className="text-[10px] text-slate-400">{current.overall.marked} marked · {current.units.length} running</p>
        </div>
        <div className="rounded-2xl bg-white p-4 text-center shadow-sm ring-1 ring-slate-200/70">
          <p className="text-3xl font-extrabold tabular-nums" style={{ color: allTone.colour }}>{fmtPct(allOverall.pct ?? null)}</p>
          <p className="mt-0.5 text-xs font-bold text-slate-600">All units</p>
          <p className="text-[10px] text-slate-400">{allOverall.marked} marked · {unitRows.length} total</p>
        </div>
      </div>

      {/* ---- Student dashboard: course, rating, results, charts ---- */}
      <div className="flex items-center justify-between gap-2 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200/70">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Cohort</p>
          <p className="truncate text-sm font-bold text-slate-700">{firstCourse}</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Attendance rating</p>
          <span className="mt-0.5 inline-block rounded-lg px-3 py-1 text-sm font-extrabold" style={{ background: rating.bg, color: rating.colour }}>{rating.label}</span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <MiniKpi label="Avg mark" value={assessDenied ? "🔒" : avgMark == null ? "—" : Math.round(avgMark)} tone={pctColour(avgMark)} />
        <MiniKpi label="Marks 50%+" value={assessDenied ? "🔒" : passRate == null ? "—" : `${Math.round(passRate)}%`} tone={pctColour(passRate)} />
        <MiniKpi label="Units done" value={assessDenied ? "🔒" : `${unitsWithMark}/${enrolledCount}`} tone={NAVY} />
        <MiniKpi label="Present" value={allOverall.P} tone="#0d7a5f" />
        <MiniKpi label="Absent" value={allOverall.A} tone={MAROON} />
        <MiniKpi label="Attendance" value={fmtPct(allOverall.pct ?? null)} tone={pctColour(allOverall.pct)} />
      </div>
      {assessDenied && <p className="rounded-xl bg-slate-50 px-3 py-2 text-[11px] text-slate-500 ring-1 ring-slate-100">Results are hidden — your account doesn't have access to the Assessments section.</p>}

      {monthData.length > 0 && (
        <ChartCard title="Attendance % by Year and Month">
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={monthData} margin={{ top: 6, right: 10, left: -14, bottom: 0 }}>
              <CartesianGrid stroke={GRID} />
              <XAxis dataKey="label" tick={AXIS_TICK} interval="preserveStartEnd" />
              <YAxis domain={[0, 100]} tick={AXIS_TICK} tickFormatter={v => `${v}%`} />
              <Tooltip formatter={v => [`${v}%`, "Attendance"]} />
              <Line type="monotone" dataKey="pct" stroke={MAROON} strokeWidth={2.5} dot={{ r: 2 }} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      )}
      {byUnit.length > 0 && (
        <ChartCard title="Final Mark by Unit Code">
          <ResponsiveContainer width="100%" height={230}>
            <PieChart>
              <Pie data={byUnit} dataKey="mark" nameKey="code" innerRadius={45} outerRadius={82} paddingAngle={2} label={({ code, mark }) => `${code} ${mark}`} labelLine={false} style={{ fontSize: 10 }}>
                {byUnit.map((u, i) => <Cell key={u.code} fill={DONUT_COLOURS[i % DONUT_COLOURS.length]} />)}
              </Pie>
              <Tooltip formatter={(v, n) => [`${v}%`, n]} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* Current units — the live overall that rolls over as units finish */}
      <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-emerald-200">
        <div className="mb-3 flex items-center gap-2">
          <p className="text-sm font-extrabold text-slate-800">Current units</p>
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">{current.units.length} running</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <div className="grid grid-cols-4 gap-1.5 text-center">
              {ATT_STATUSES.map(s => (
                <div key={s.key} className="rounded-lg py-1.5" style={{ background: s.colour + "12" }}>
                  <p className="text-sm font-extrabold tabular-nums" style={{ color: s.colour }}>{current.overall[s.key] ?? 0}</p>
                  <p className="text-[9px] font-medium text-slate-400">{s.label}</p>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-slate-400">{current.overall.marked ?? 0} session{(current.overall.marked ?? 0) === 1 ? "" : "s"} marked across current units</p>
          </div>
        </div>
        <div className="mt-3 overflow-hidden rounded-2xl bg-white ring-1 ring-slate-200/70">
          {current.units.map((mr, i) => <UnitRow key={mr.unit.id} mod={mr.unit} stats={mr.summary} i={i} end={mr.endDate} ended={false} />)}
          {current.units.length === 0 && <div className="px-4 py-6"><EmptyState Icon={Percent} title="No current units" msg="Every assigned unit has finished, or none are assigned yet. Assign units via Edit student → Units." /></div>}
        </div>
      </div>

      {/* Previous assigned units — finished ones, moved here automatically */}
      {previous.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400">Previous assigned units · {previous.length}</p>
          <div className="overflow-hidden rounded-2xl bg-white ring-1 ring-slate-200/70">
            {previous.map((mr, i) => <UnitRow key={mr.unit.id} mod={mr.unit} stats={mr.summary} i={i} end={mr.endDate} ended={true} />)}
          </div>
        </div>
      )}

      <p className="text-[11px] text-slate-400">A unit moves to “previous” automatically once its last session date has passed. “Current units” counts only running units; “All units” is across everything the student has studied. P = Present (2) · L = Late (1) · E = Excused (1) · A = Absent (0). Only marked sessions count.</p>
    </div>
  );
}

/* ----- Units ----- */
// A deterministic seed from a string, so a course keeps the same banner colour
// and pattern every time the gallery renders.
const hashStr = (s) => { let h = 0; for (const c of String(s || "")) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
const COURSE_COLOURS = ["#0d7a5f", "#5b6472", "#6d28d9", "#1a3a8f", "#b45309", "#0e7490", "#9e1b32", "#2563eb"];
const courseColour = (seed) => COURSE_COLOURS[seed % COURSE_COLOURS.length];

// The decorative banner on a course card — one of four repeating patterns keyed
// off the course code, tinted with that course's colour. Purely cosmetic.
function CoursePattern({ seed, colour }) {
  const kind = seed % 4;
  const pid = `cp-${seed}-${kind}`;
  const cover = { position: "absolute", inset: 0, width: "100%", height: "100%" };
  let cell;
  if (kind === 0) { // plaid — the green tartan look
    cell = (
      <pattern id={pid} width="46" height="46" patternUnits="userSpaceOnUse">
        <rect width="46" height="46" fill={colour} />
        <rect width="46" height="23" fill="#fff" opacity="0.05" />
        <rect width="23" height="46" fill="#fff" opacity="0.05" />
        <rect x="21" width="4" height="46" fill="#fff" opacity="0.13" />
        <rect y="21" width="46" height="4" fill="#fff" opacity="0.13" />
      </pattern>
    );
  } else if (kind === 1) { // soft mosaic squares
    cell = (
      <pattern id={pid} width="52" height="52" patternUnits="userSpaceOnUse">
        <rect width="52" height="52" fill={colour} />
        {[[0, 0, 0.10], [26, 0, 0.05], [0, 26, 0.06], [26, 26, 0.12], [13, 13, 0.08], [39, 39, 0.05]].map(([x, y, o], k) => (
          <rect key={k} x={x} y={y} width="24" height="24" fill="#fff" opacity={o} />
        ))}
      </pattern>
    );
  } else if (kind === 2) { // overlapping rings
    cell = (
      <pattern id={pid} width="58" height="58" patternUnits="userSpaceOnUse">
        <rect width="58" height="58" fill={colour} />
        {[[29, 29], [0, 0], [58, 0], [0, 58], [58, 58]].map(([cx, cy], k) => (
          <circle key={k} cx={cx} cy={cy} r="20" fill="none" stroke="#fff" strokeWidth="8" opacity="0.13" />
        ))}
      </pattern>
    );
  } else { // triangles
    cell = (
      <pattern id={pid} width="44" height="44" patternUnits="userSpaceOnUse">
        <rect width="44" height="44" fill={colour} />
        <path d="M0 44 L22 0 L44 44 Z" fill="#fff" opacity="0.06" />
        <path d="M-22 44 L0 0 L22 44 Z" fill="#fff" opacity="0.11" />
        <path d="M22 44 L44 0 L66 44 Z" fill="#fff" opacity="0.11" />
      </pattern>
    );
  }
  return (
    <svg style={cover} aria-hidden="true">
      <defs>{cell}</defs>
      <rect width="100%" height="100%" fill={`url(#${pid})`} />
    </svg>
  );
}

// The "⋯" overflow menu on each course card — Edit / Delete, matching the
// three-dot control in the reference design. Closes on outside click.
function CourseMenu({ onEdit, onDelete, onCohorts, onSchedule, editLabel = "Edit course", deleteLabel = "Delete course" }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)} aria-label="Course options" aria-haspopup="menu" aria-expanded={open}
        className="press flex h-8 w-8 items-center justify-center rounded-lg bg-white/95 text-slate-600 shadow-sm ring-1 ring-black/5 transition hover:bg-white">
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div role="menu" className="pop absolute right-0 top-10 z-40 w-44 overflow-hidden rounded-xl bg-white py-1 shadow-lg ring-1 ring-slate-200">
            {onCohorts && (
              <button role="menuitem" onClick={() => { setOpen(false); onCohorts(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-slate-600 transition hover:bg-slate-50">
                <Layers size={14} /> Manage cohorts
              </button>
            )}
            <button role="menuitem" onClick={() => { setOpen(false); onEdit(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-slate-600 transition hover:bg-slate-50">
              <Edit3 size={14} /> {editLabel}
            </button>
            {onSchedule && (
              <button role="menuitem" onClick={() => { setOpen(false); onSchedule(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-slate-600 transition hover:bg-slate-50">
                <CalendarDays size={14} /> Create registers
              </button>
            )}
            <button role="menuitem" onClick={() => { setOpen(false); onDelete(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-rose-600 transition hover:bg-rose-50">
              <Trash2 size={14} /> {deleteLabel}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ----- Staff app: my own Strategic Self-Reflection ----- */
// Required questions on `list` that the user hasn't answered yet. Mirrors the server's
// own required check in reviewForms.validateAnswers, including its treatment of a
// partially-filled grid and an empty checkbox array as "not answered".
function srMissing(list, answers) {
  return (list || []).filter(q => {
    if (!q.required) return false;
    const v = answers[q.id];
    if (q.kind === "grid") return !v || q.rows.some(r => !v[r.key]);
    if (q.kind === "checkbox") return !Array.isArray(v) || v.length === 0;
    return v == null || String(v).trim() === "";
  });
}

// The lecturer fills this in about their own term. It saves to the same table the
// admin console reads, so a submission appears in Staff Reviews immediately.
//
// Reuses ReviewField / ReviewAnswers / srVisibleSections from the admin side — one
// renderer, so a change to a question shows up identically in both places.
function SelfReflectionScreen({ store, me }) {
  const [forms, setForms] = useState([]);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState("list");     // list | fill | view
  const [current, setCurrent] = useState(null); // the row being viewed/edited
  const [answers, setAnswers] = useState({});
  const [step, setStep] = useState(0);
  const [pageErr, setPageErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const [f, r] = await Promise.all([api.myReviewForms(), api.listMyReviews()]);
      setForms(f); setRows(r);
    } catch (e) { setErr(e.message || "Could not load your reflections"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  // The form belonging to the review being viewed or resumed; forms[0] only for a new
  // one. This said forms[0] unconditionally — which is right while there is exactly one
  // self-service form and silently wrong the moment there are two: opening a review of
  // type B would render type A's questions against B's answers and re-save it as A.
  const form = (current && forms.find(f => f.type === current.type)) || forms[0] || null;
  const pages = srVisibleSections(form, answers);
  useEffect(() => { setStep(s => Math.min(s, Math.max(0, pages.length - 1))); }, [pages.length]);

  // Android back: leave the form rather than the whole screen.
  useBackHandler(mode !== "list", () => { setMode("list"); return true; });

  const startNew = () => {
    setCurrent(null);
    // The name is theirs and the app already knows it.
    setAnswers({ fullName: me.name });
    setStep(0); setPageErr(""); setMode("fill");
  };
  const resume = (r) => { setCurrent(r); setAnswers(r.answers || {}); setStep(0); setPageErr(""); setMode("fill"); };
  const view = (r) => { setCurrent(r); setMode("view"); };

  const setAnswer = (id, v) => setAnswers(a => ({ ...a, [id]: v }));

  const next = () => {
    const missing = srMissing(pages[step]?.questions, answers);
    if (missing.length) { setPageErr(`Please answer: ${missing.map(q => q.label).join(" · ")}`); return; }
    setPageErr(""); setStep(s => Math.min(s + 1, pages.length - 1));
  };
  const back = () => { setPageErr(""); setStep(s => Math.max(0, s - 1)); };

  const save = async (status) => {
    if (status !== "draft") {
      const missing = srMissing(pages.flatMap(p => p.questions), answers);
      if (missing.length) { setPageErr(`Please answer: ${missing.map(q => q.label).join(" · ")}`); return; }
    }
    setBusy(true); setPageErr("");
    try {
      const body = { type: form.type, answers, status };
      if (current) await api.updateMyReview(current.id, body);
      else await api.addMyReview(body);
      store.notify(status === "draft" ? "Saved as a draft" : "Reflection submitted — thank you");
      setMode("list");
      await load();
    } catch (e) {
      setPageErr(e.message || "Could not save your reflection");
    }
    setBusy(false);
  };

  const discard = async () => {
    setBusy(true);
    try { await api.removeMyReview(confirmDiscard.id); setConfirmDiscard(null); await load(); store.notify("Draft discarded", "error"); }
    catch (e) { store.notify(e.message || "Could not discard the draft", "error"); }
    setBusy(false);
  };

  /* ---------------------------------------------------------------- list ---- */
  if (mode === "list") {
    return (
      <Screen>
        {err && <Card className="!bg-rose-50 !ring-rose-200 text-sm font-semibold text-rose-600">{err}</Card>}
        {loading ? <><div className="skeleton h-24 rounded-2xl" /><div className="skeleton h-20 rounded-2xl" /></> : (
          <>
            <div className="animated-gradient relative overflow-hidden rounded-2xl p-4 text-white shadow-md fade-up" style={{ background: `linear-gradient(135deg, ${NAVY} 0%, ${NAVY_DARK} 55%, ${MAROON} 140%)`, backgroundSize: "200% 200%" }}>
              <Sparkles size={56} className="float-slow absolute -right-2 -top-2 text-white/10" />
              <p className="relative text-base font-extrabold">{form?.title || "Self-Reflection"}</p>
              <p className="relative mt-1 text-[12px] text-white/75">{form?.blurb}</p>
            </div>

            {form
              ? <button onClick={startNew} className="press flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-3.5 text-sm font-bold text-white shadow-md" style={{ background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` }}>
                  <Plus size={17} /> Start a new reflection
                </button>
              : <Card className="text-sm text-slate-500">No self-reflection form is available yet.</Card>}

            <p className="px-1 pt-1 text-[11px] font-extrabold uppercase tracking-widest text-slate-400">My reflections</p>
            {rows.length === 0 && <Card className="text-sm text-slate-400">You haven't completed one yet. Tap “Start a new reflection” above.</Card>}
            {rows.map((r, i) => (
              <Card key={r.id} className="!p-3.5 fade-up" style={{ animationDelay: `${i * 55}ms` }}>
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: (r.status === "draft" ? "#b4530922" : "#0d7a5f22") }}>
                    <ClipboardList size={18} style={{ color: r.status === "draft" ? "#b45309" : "#0d7a5f" }} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-slate-700">{r.formTitle}</p>
                    <p className="text-[11px] text-slate-400">
                      {[r.term, r.academicYear].filter(Boolean).join(" · ") || "Not yet dated"}
                      {r.dateCompleted ? ` · ${fmtDate(r.dateCompleted)}` : ""}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold ${r.status === "draft" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>
                    {r.status === "draft" ? "Draft" : "Submitted"}
                  </span>
                </div>
                <div className="mt-2.5 flex gap-2">
                  <button onClick={() => view(r)} className="press flex-1 rounded-xl bg-slate-100 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-200">View</button>
                  {r.status === "draft" && <>
                    <button onClick={() => resume(r)} className="press flex-1 rounded-xl py-2 text-xs font-bold text-white" style={{ background: NAVY }}>Continue</button>
                    <button onClick={() => setConfirmDiscard(r)} title="Discard draft" className="press rounded-xl bg-rose-50 px-3 py-2 text-rose-500 transition hover:bg-rose-100"><Trash2 size={15} /></button>
                  </>}
                </div>
              </Card>
            ))}
            <p className="px-1 pb-2 text-center text-[10px] leading-relaxed text-slate-400">
              Once submitted, your reflection goes to the college and can no longer be edited here.
            </p>
          </>
        )}

        <ConfirmDialog
          open={!!confirmDiscard}
          title="Discard this draft?"
          message="Everything you have typed into this draft will be deleted. This cannot be undone."
          confirmLabel={busy ? "Discarding…" : "Discard draft"}
          danger
          onConfirm={discard}
          onCancel={() => !busy && setConfirmDiscard(null)}
        />
      </Screen>
    );
  }

  /* ---------------------------------------------------------------- view ---- */
  if (mode === "view") {
    return (
      <Screen>
        <button onClick={() => setMode("list")} className="press flex items-center gap-1.5 text-sm font-bold text-slate-500"><ChevronLeft size={16} /> Back to my reflections</button>
        <Card>
          <p className="text-sm font-extrabold text-slate-700">{current?.formTitle}</p>
          <p className="mt-0.5 text-[11px] text-slate-400">
            {[current?.term, current?.academicYear].filter(Boolean).join(" · ") || "—"}
            {current?.dateCompleted ? ` · ${fmtDate(current.dateCompleted)}` : ""}
            {" · "}{current?.status === "draft" ? "Draft" : "Submitted"}
          </p>
        </Card>
        <Card><ReviewAnswers form={form} answers={current?.answers || {}} /></Card>
      </Screen>
    );
  }

  /* ---------------------------------------------------------------- fill ---- */
  const page = pages[step];
  const isLast = step === pages.length - 1;
  return (
    <Screen>
      <div>
        <div className="mb-1.5 flex items-center justify-between text-[11px] font-bold text-slate-400">
          <span className="truncate pr-2">{page?.title}</span>
          <span className="shrink-0">Page {step + 1} of {pages.length}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full transition-all duration-300" style={{ width: `${((step + 1) / Math.max(1, pages.length)) * 100}%`, background: `linear-gradient(90deg, ${NAVY}, ${NAVY_DARK})` }} />
        </div>
      </div>

      <Card>
        <div className="space-y-4">
          {(page?.questions || []).map(q => (
            <ReviewField key={q.id} q={q} value={answers[q.id]} onChange={setAnswer} disabled={busy} />
          ))}
        </div>
      </Card>

      {pageErr && <Card className="!bg-rose-50 !ring-rose-200 text-[12px] font-semibold text-rose-600">{pageErr}</Card>}

      <div className="flex items-center gap-2">
        <button onClick={step === 0 ? () => setMode("list") : back} disabled={busy}
          className="press rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-slate-600 ring-1 ring-slate-200 transition hover:bg-slate-50 disabled:opacity-40">
          {step === 0 ? "Cancel" : "Back"}
        </button>
        <button onClick={() => save("draft")} disabled={busy}
          className="press rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-bold text-slate-600 transition hover:bg-slate-200 disabled:opacity-40">
          Save draft
        </button>
        <div className="flex-1" />
        {isLast
          ? <button onClick={() => save("submitted")} disabled={busy}
              className="press flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold text-white shadow-md disabled:opacity-40" style={{ background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` }}>
              {busy ? <Loader size={16} /> : <Check size={16} />} Submit
            </button>
          : <button onClick={next} disabled={busy}
              className="press flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold text-white shadow-md disabled:opacity-40" style={{ background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` }}>
              Next <ArrowRight size={16} />
            </button>}
      </div>
      <p className="pb-2 text-center text-[10px] text-slate-400">“Save draft” keeps your answers without submitting, so you can finish later.</p>
    </Screen>
  );
}

/* ----- Staff Reviews: Strategic Self-Reflection & Monthly Performance ----- */
// --- Staff review helpers: conditional questions, and the two export formats -----

// Mirrors the server's isVisible(). A question with `showIf` is only asked when its
// trigger matches, so "describe the concern" appears only once a risk is flagged.
const srVisible = (q, answers) => !q?.showIf || String((answers || {})[q.showIf.q] ?? "") === String(q.showIf.is);
// A section is skipped entirely when nothing in it is currently being asked.
const srVisibleSections = (form, answers) =>
  (form?.sections || [])
    .map(sec => ({ ...sec, questions: sec.questions.filter(q => srVisible(q, answers)) }))
    .filter(sec => sec.questions.length > 0);

// One answer as plain text, for both exports.
function srAnswerText(q, v) {
  if (v == null || v === "") return "";
  if (q.kind === "grid") {
    return (q.rows || []).filter(r => v[r.key]).map(r => `${r.label}: ${v[r.key]}`).join("\n");
  }
  // "Select all that apply" — one line per choice, so a spreadsheet cell wraps
  // readably rather than running into one comma-separated string.
  if (q.kind === "checkbox") return (Array.isArray(v) ? v : [v]).join("\n");
  return String(v);
}

// EXCEL — one row per question, which is what makes it useful in a spreadsheet:
// filter by section, sort by question, paste a column into a report. Written as CSV
// because that is the format Excel opens natively with no warning and no dependency.
function srExportExcel(review, form) {
  const rows = [];
  (form?.sections || []).forEach(sec => {
    sec.questions.forEach(q => {
      if (!srVisible(q, review.answers)) return;
      rows.push({
        staff: review.staff?.name || "",
        review: review.formTitle || "",
        period: [review.term, review.academicYear].filter(Boolean).join(" "),
        completed: review.dateCompleted || "",
        status: review.status === "draft" ? "Draft" : "Submitted",
        section: sec.title,
        question: q.label,
        answer: srAnswerText(q, review.answers?.[q.id]),
      });
    });
  });
  const safe = (review.staff?.name || "review").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  downloadCSV(`${safe}-${review.type}-review.csv`, [
    { key: "staff", label: "Staff member" }, { key: "review", label: "Review" },
    { key: "period", label: "Period" }, { key: "completed", label: "Date completed" },
    { key: "status", label: "Status" }, { key: "section", label: "Section" },
    { key: "question", label: "Question" }, { key: "answer", label: "Answer" },
  ], rows);
}

// PDF — rendered as a clean printable document in a new window and handed to the
// browser's print dialog, where "Save as PDF" is the default destination. No PDF
// library is bundled, and this produces a properly paginated, selectable document
// rather than a screenshot.
function srExportPdf(review, form) {
  const esc = (s) => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const body = (form?.sections || []).map(sec => {
    const qs = sec.questions.filter(q => srVisible(q, review.answers));
    if (!qs.length) return "";
    return `<section><h2>${esc(sec.title)}</h2>${qs.map(q => {
      const v = review.answers?.[q.id];
      const empty = v == null || v === ""
        || (q.kind === "grid" && !Object.keys(v || {}).length)
        || (q.kind === "checkbox" && Array.isArray(v) && !v.length);
      const ans = empty
        ? `<p class="empty">Not answered</p>`
        : q.kind === "checkbox"
          ? `<ul>${(Array.isArray(v) ? v : [v]).map(x => `<li>${esc(x)}</li>`).join("")}</ul>`
        : q.kind === "grid"
          ? `<table>${(q.rows || []).filter(r => v[r.key]).map(r => `<tr><th>${esc(r.label)}</th><td>${esc(v[r.key])}</td></tr>`).join("")}</table>`
          : `<p class="a">${esc(String(v)).replace(/\n/g, "<br>")}</p>`;
      return `<div class="q"><p class="l">${esc(q.label)}</p>${ans}</div>`;
    }).join("")}</section>`;
  }).join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(review.formTitle)} — ${esc(review.staff?.name || "")}</title>
<style>
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font: 11pt/1.5 "Segoe UI", system-ui, sans-serif; color: #1e293b; margin: 0; }
  header { border-bottom: 3px solid var(--brand-primary); padding-bottom: 10px; margin-bottom: 18px; }
  h1 { font-size: 17pt; color: var(--brand-primary); margin: 0 0 4px; }
  .meta { font-size: 9.5pt; color: #64748b; }
  .meta b { color: #1e293b; }
  /* Keep a section together where it fits, so a heading never ends a page alone. */
  section { break-inside: avoid; margin-bottom: 14px; }
  h2 { font-size: 10pt; text-transform: uppercase; letter-spacing: .08em; color: var(--brand-primary);
       border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; margin: 0 0 8px; }
  .q { break-inside: avoid; margin-bottom: 9px; }
  .l { font-size: 9pt; color: #64748b; margin: 0 0 2px; }
  .a { margin: 0; white-space: pre-wrap; }
  .empty { margin: 0; color: #94a3b8; font-style: italic; }
  table { border-collapse: collapse; width: 100%; margin-top: 3px; }
  th, td { border: 1px solid #e2e8f0; padding: 4px 7px; text-align: left; font-size: 10pt; }
  th { background: #f8fafc; font-weight: 600; width: 62%; }
  footer { margin-top: 20px; border-top: 1px solid #e2e8f0; padding-top: 7px; font-size: 8.5pt; color: #94a3b8; }
</style></head><body>
<header>
  <h1>${esc(review.formTitle)}</h1>
  <p class="meta"><b>${esc(review.staff?.name || "—")}</b>${review.staff?.role ? ` · ${esc(review.staff.role)}` : ""}${review.staff?.dept ? ` · ${esc(review.staff.dept)}` : ""}</p>
  <p class="meta">${[review.term, review.academicYear].filter(Boolean).map(esc).join(" · ") || "—"}${review.dateCompleted ? ` · Completed ${esc(review.dateCompleted)}` : ""} · ${review.status === "draft" ? "DRAFT" : "Submitted"}</p>
</header>
${body}
<footer>EdTech · ${esc(review.formTitle)}${review.completedBy ? ` · recorded by ${esc(review.completedBy)}` : ""} · generated ${new Date().toLocaleDateString("en-GB")}</footer>
</body></html>`;

  const w = window.open("", "_blank", "width=900,height=1000");
  if (!w) return false;   // pop-up blocked — the caller tells the user
  w.document.write(html);
  w.document.close();
  // Wait for layout before printing, or the dialog can open on a blank page.
  w.onload = () => { w.focus(); w.print(); };
  setTimeout(() => { try { w.focus(); w.print(); } catch (_) { /* already printed */ } }, 400);
  return true;
}

// The questions are NOT written here. They come from GET /staff-reviews/forms, and
// this renders whatever it is handed — so a new review type, or a reworded question,
// is a server-side change with no front-end release.

// One question, rendered according to its `kind`.
function ReviewField({ q, value, onChange, disabled }) {
  const set = (v) => onChange(q.id, v);
  const label = (
    <p className="mb-1.5 text-sm font-semibold text-slate-700">
      {q.label}{q.required && <span className="ml-1 text-rose-500">*</span>}
    </p>
  );
  if (q.kind === "textarea") return (
    <div>{label}<textarea rows={3} value={value || ""} disabled={disabled} onChange={e => set(e.target.value)} placeholder="Enter your answer" className={`${inputCls} resize-y`} /></div>
  );
  if (q.kind === "date") return (
    <div>{label}<input type="date" value={value || ""} disabled={disabled} onChange={e => set(e.target.value)} className={inputCls} /></div>
  );
  if (q.kind === "select") return (
    <div>{label}
      <select value={value || ""} disabled={disabled} onChange={e => set(e.target.value)} className={inputCls}>
        <option value="">Select your answer</option>
        {q.options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
  if (q.kind === "checkbox") {
    const chosen = Array.isArray(value) ? value : [];
    const toggle = (o) => set(chosen.includes(o) ? chosen.filter(x => x !== o) : [...chosen, o]);
    return (
      <div>{label}
        <div className="space-y-1.5">
          {q.options.map(o => {
            const on = chosen.includes(o);
            return (
              <label key={o} className={`flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-sm ring-1 transition ${on ? "bg-blue-50 font-semibold text-slate-800 ring-blue-300" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50"} ${disabled ? "pointer-events-none opacity-60" : ""}`}>
                <input type="checkbox" checked={on} disabled={disabled} onChange={() => toggle(o)} className="h-4 w-4 rounded accent-blue-700" />
                {o}
              </label>
            );
          })}
        </div>
        {chosen.length > 0 && <p className="mt-1.5 text-[11px] font-semibold text-slate-400">{chosen.length} selected</p>}
      </div>
    );
  }
  if (q.kind === "radio" || q.kind === "confirm") return (
    <div>{label}
      <div className="space-y-1.5">
        {q.options.map(o => (
          <label key={o} className={`flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-sm ring-1 transition ${value === o ? "bg-blue-50 font-semibold text-slate-800 ring-blue-300" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50"} ${disabled ? "pointer-events-none opacity-60" : ""}`}>
            <input type="radio" name={q.id} checked={value === o} disabled={disabled} onChange={() => set(o)} className="h-4 w-4 accent-blue-700" />
            {o}
          </label>
        ))}
      </div>
    </div>
  );
  if (q.kind === "grid") {
    const cell = value || {};
    return (
      <div>{label}
        {/* Scrolls inside its own container so a wide matrix never makes the page
            scroll sideways on a laptop. */}
        <div className="overflow-x-auto rounded-xl ring-1 ring-slate-200">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-slate-50 text-[11px] font-bold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-3 py-2.5 text-left">&nbsp;</th>
                {q.options.map(o => <th key={o} className="px-2 py-2.5 text-center font-bold normal-case leading-tight">{o}</th>)}
              </tr>
            </thead>
            <tbody>
              {q.rows.map((r, i) => (
                <tr key={r.key} className={i % 2 ? "bg-slate-50/60" : ""}>
                  <td className="px-3 py-2.5 font-medium text-slate-600">{r.label}</td>
                  {q.options.map(o => (
                    <td key={o} className="px-2 py-2.5 text-center">
                      <input type="radio" name={`${q.id}.${r.key}`} checked={cell[r.key] === o} disabled={disabled}
                        onChange={() => set({ ...cell, [r.key]: o })} className="h-4 w-4 accent-blue-700" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  return <div>{label}<input value={value || ""} disabled={disabled} onChange={e => set(e.target.value)} placeholder={q.placeholder || "Enter your answer"} className={inputCls} /></div>;
}

// Read-only rendering of a saved review.
function ReviewAnswers({ form, answers }) {
  if (!form) return null;
  return (
    <div className="space-y-4">
      {srVisibleSections(form, answers).map(sec => (
        <div key={sec.title}>
          <p className="mb-2 border-b border-slate-100 pb-1 text-[11px] font-extrabold uppercase tracking-widest" style={{ color: NAVY }}>{sec.title}</p>
          <div className="space-y-2.5">
            {sec.questions.filter(q => srVisible(q, answers)).map(q => {
              const v = answers[q.id];
              const empty = v == null || v === ""
                || (q.kind === "grid" && !Object.keys(v || {}).length)
                || (q.kind === "checkbox" && Array.isArray(v) && !v.length);
              return (
                <div key={q.id}>
                  <p className="text-[11px] font-semibold text-slate-400">{q.label}</p>
                  {empty
                    ? <p className="text-sm text-slate-300">— not answered</p>
                    : q.kind === "checkbox"
                      ? <ul className="mt-0.5 space-y-0.5">{(Array.isArray(v) ? v : [v]).map(x => <li key={x} className="text-sm text-slate-700">· {x}</li>)}</ul>
                    : q.kind === "grid"
                      ? <ul className="mt-0.5 space-y-0.5">
                          {q.rows.map(r => v[r.key] ? <li key={r.key} className="text-sm text-slate-700"><span className="text-slate-400">{r.label}:</span> <b>{v[r.key]}</b></li> : null)}
                        </ul>
                      : <p className="whitespace-pre-wrap text-sm text-slate-700">{String(v)}</p>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function AdminStaffReviews({ store }) {
  const [forms, setForms] = useState([]);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [query, setQuery] = useState("");
  // Wizard state: pick a type → fill it in.
  const [modal, setModal] = useState(false);
  const [pickedType, setPickedType] = useState("");
  const [staffId, setStaffId] = useState("");
  const [answers, setAnswers] = useState({});
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  // Wizard paging: step 0 picks the staff member, then one page per visible section.
  const [step, setStep] = useState(0);
  const [pageErr, setPageErr] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const [f, r] = await Promise.all([api.reviewForms(), api.listStaffReviews()]);
      setForms(f); setRows(r);
    } catch (e) { setErr(e.message || "Could not load staff reviews"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const formOf = (type) => forms.find(f => f.type === type) || null;
  const activeForm = formOf(pickedType);

  // Pages recomputed from the CURRENT answers, so answering "No" to a trigger drops
  // its follow-up page entirely rather than showing an empty one.
  const pages = srVisibleSections(activeForm, answers);
  // Clamp when a page disappears from under us — otherwise `step` can point past the
  // end and the modal renders blank with no way forward.
  useEffect(() => { setStep(s => Math.min(s, pages.length)); }, [pages.length]);

  const openAdd = () => { setEditing(null); setPickedType(""); setStaffId(""); setAnswers({}); setStep(0); setPageErr(""); setModal(true); };
  const openEdit = (r) => {
    setEditing(r); setPickedType(r.type); setStaffId(r.staffId);
    setAnswers(r.answers || {}); setStep(0); setPageErr(""); setModal(true);
  };

  // Check only THIS page before moving on, so a mistake is caught next to the field
  // that caused it rather than after twelve pages of typing.
  const next = () => {
    if (step === 0) {
      if (!staffId) { setPageErr("Choose the staff member this review is for."); return; }
    } else {
      const missing = srMissing(pages[step - 1]?.questions, answers);
      if (missing.length) { setPageErr(`Please answer: ${missing.map(q => q.label).join(" · ")}`); return; }
    }
    setPageErr(""); setStep(s => Math.min(s + 1, pages.length));
  };
  const back = () => { setPageErr(""); setStep(s => Math.max(0, s - 1)); };
  const setAnswer = (id, v) => setAnswers(a => ({ ...a, [id]: v }));

  // Pre-fill the lecturer's name from the chosen staff member — it is the first
  // question on the form and the admin has just picked it from the dropdown.
  const chooseStaff = (id) => {
    setStaffId(id);
    const person = store.staff.find(s => s.id === id);
    if (!person) return;
    const nameQ = (activeForm?.sections || [])
      .flatMap(sec => sec.questions)
      .find(q => q.id === "fullName" || q.id === "lecturerName");
    if (nameQ && !answers[nameQ.id]) setAnswers(a => ({ ...a, [nameQ.id]: person.name }));
  };

  const save = async (status) => {
    if (status !== "draft") {
      const missing = srMissing(pages.flatMap(p => p.questions), answers);
      if (missing.length) { setPageErr(`Please answer: ${missing.map(q => q.label).join(" · ")}`); return; }
    }
    setBusy(true);
    try {
      const body = { type: pickedType, staffId, answers, status };
      if (editing) await store.updateStaffReview(editing.id, body);
      else await store.addStaffReview(body);
      setModal(false);
      await load();
    } catch (_e) { /* the store toasts the error and keeps the modal open */ }
    setBusy(false);
  };

  const confirmRemove = async () => {
    setBusy(true);
    try { await store.removeStaffReview(deleteTarget.id); setDeleteTarget(null); await load(); }
    catch (_e) { /* toasted by the store */ }
    setBusy(false);
  };

  // Every review currently in view, one row per question, so the whole set can be
  // pivoted or filtered in a spreadsheet.
  const exportAll = () => {
    const out = [];
    list.forEach(r => {
      const form = formOf(r.type);
      (form?.sections || []).forEach(sec => sec.questions.forEach(q => {
        if (!srVisible(q, r.answers)) return;
        out.push({
          staff: r.staff?.name || "", review: r.formTitle || "",
          period: [r.term, r.academicYear].filter(Boolean).join(" "),
          completed: r.dateCompleted || "", status: r.status === "draft" ? "Draft" : "Submitted",
          section: sec.title, question: q.label, answer: srAnswerText(q, r.answers?.[q.id]),
        });
      }));
    });
    if (!out.length) { store.notify("Nothing to export in the current view", "error"); return; }
    downloadCSV("staff-reviews.csv", [
      { key: "staff", label: "Staff member" }, { key: "review", label: "Review" },
      { key: "period", label: "Period" }, { key: "completed", label: "Date completed" },
      { key: "status", label: "Status" }, { key: "section", label: "Section" },
      { key: "question", label: "Question" }, { key: "answer", label: "Answer" },
    ], out);
    store.notify(`Exported ${list.length} review${list.length === 1 ? "" : "s"}`);
  };

  const ql = query.trim().toLowerCase();
  const list = rows
    .filter(r => typeFilter === "all" || r.type === typeFilter)
    .filter(r => !ql || (r.staff?.name || "").toLowerCase().includes(ql) || (r.formTitle || "").toLowerCase().includes(ql) || (r.term || "").toLowerCase().includes(ql));
  const paged = usePaged(list, 10, `${typeFilter}|${ql}`);

  const typeTone = (t) => ({
    strategic:          { bg: "bg-indigo-50",  text: "text-indigo-700",  colour: "#4f46e5" },
    monthly:            { bg: "bg-cyan-50",    text: "text-cyan-700",    colour: "#0891b2" },
    evaluation:         { bg: "bg-amber-50",   text: "text-amber-700",   colour: "#b45309" },
    "teaching-quality": { bg: "bg-emerald-50", text: "text-emerald-700", colour: "#0d7a5f" },
  }[t] || { bg: "bg-slate-100", text: "text-slate-600", colour: "#64748b" });

  return (
    <>
      <AdminHeader title="Staff Reviews" subtitle="Strategic self-reflections and monthly performance reviews"
        Icon={ClipboardList}
        action={<div className="flex flex-wrap items-center gap-2"><ExportBtn onClick={exportAll} label="Export all" /><PrimaryBtn onClick={openAdd}><Plus size={16} /> Add review</PrimaryBtn></div>} />

      {err && <div className="mb-4 flex items-start gap-2 rounded-xl bg-rose-50 px-3.5 py-3 text-sm font-semibold text-rose-700 ring-1 ring-rose-200"><AlertCircle size={16} className="mt-px shrink-0" />{err}</div>}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {[{ v: "all", l: "All types" }, ...forms.map(f => ({ v: f.type, l: f.title }))].map(o => (
          <button key={o.v} onClick={() => setTypeFilter(o.v)}
            className={`press rounded-full px-3 py-1.5 text-xs font-bold shadow-sm ring-1 transition ${typeFilter === o.v ? "text-white ring-transparent" : "bg-white text-slate-500 ring-slate-200 hover:bg-slate-50"}`}
            style={typeFilter === o.v ? { background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` } : {}}>{o.l}</button>
        ))}
        <div className="ml-auto flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
          <Search size={15} className="text-slate-400" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name, form or term…" className="w-56 bg-transparent text-sm outline-none" />
        </div>
      </div>

      {loading ? <div className="skeleton h-64 rounded-2xl" /> : (
        <>
          <div className="overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 fade-up">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-400">
                <tr><th className="px-5 py-3">Staff member</th><th className="px-5 py-3">Review</th><th className="px-5 py-3">Term</th><th className="px-5 py-3">Completed</th><th className="px-5 py-3">Status</th><th className="px-5 py-3"></th></tr>
              </thead>
              <tbody>
                {paged.slice.map(r => {
                  const t = typeTone(r.type);
                  return (
                    <tr key={r.id} className="border-t border-slate-100 transition-colors hover:bg-blue-50/40">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-sm" style={{ background: r.staff?.colour || NAVY }}>{r.staff?.initials || "?"}</span>
                          <div><p className="font-semibold text-slate-700">{r.staff?.name || "—"}</p><p className="text-[11px] text-slate-400">{r.staff?.role}</p></div>
                        </div>
                      </td>
                      <td className="px-5 py-3"><span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${t.bg} ${t.text}`}>{r.formTitle}</span></td>
                      <td className="px-5 py-3 text-slate-500">{r.term || "—"}{r.academicYear ? <span className="text-slate-300"> · {r.academicYear}</span> : null}</td>
                      <td className="px-5 py-3 text-slate-500">{r.dateCompleted ? fmtDate(r.dateCompleted) : "—"}</td>
                      <td className="px-5 py-3">
                        <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${r.status === "draft" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>{r.status === "draft" ? "Draft" : "Submitted"}</span>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex gap-1">
                          <button onClick={() => setViewing(r)} title="View" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><FileText size={15} /></button>
                          <button onClick={() => srExportExcel(r, formOf(r.type))} title="Download as Excel" className="rounded-lg p-1.5 text-slate-400 hover:bg-emerald-50 hover:text-emerald-600"><Download size={15} /></button>
                          <button onClick={() => openEdit(r)} title="Edit" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><Edit3 size={15} /></button>
                          <button onClick={() => setDeleteTarget(r)} title="Delete" className="rounded-lg p-1.5 text-slate-300 hover:bg-rose-50 hover:text-rose-500"><Trash2 size={15} /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {paged.slice.length === 0 && (
                  <tr><td colSpan={6} className="px-5 py-12">
                    <EmptyState Icon={ClipboardList} title={rows.length ? "No reviews match" : "No reviews yet"}
                      msg={rows.length ? "Try a different search or type filter." : "Use “Add review” to record a Strategic Self-Reflection or a Monthly Performance & Support Review."} />
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          <Pagination className="mt-4" page={paged.page} setPage={paged.setPage} totalPages={paged.totalPages} total={paged.total} />
        </>
      )}

      {/* Add / edit */}
      <Modal open={modal} onClose={() => !busy && setModal(false)} title={editing ? "Edit review" : "Add review"} width={720}>
        {!pickedType ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-500">Which review are you recording?</p>
            {forms.map(f => (
              <button key={f.type} onClick={() => { setPickedType(f.type); setStep(0); setPageErr(""); }} disabled={f.pending}
                className={`press w-full rounded-2xl p-4 text-left ring-1 transition ${f.pending ? "cursor-not-allowed bg-slate-50 opacity-70 ring-slate-200" : "bg-white ring-slate-200 hover:bg-blue-50/50 hover:ring-blue-300"}`}>
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl text-white" style={{ background: typeTone(f.type).colour }}><ClipboardList size={18} /></span>
                  <div className="flex-1">
                    <p className="text-sm font-bold text-slate-700">{f.title}</p>
                    <p className="text-[11px] text-slate-400">
                      {f.pending ? "Questions not set up yet" : `${f.sections.reduce((n, s) => n + s.questions.length, 0)} questions · ${f.sections.length} sections`}
                    </p>
                  </div>
                  {!f.pending && <ChevronRight size={16} className="text-slate-300" />}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200">
              <div>
                <p className="text-sm font-bold text-slate-700">{activeForm?.title}</p>
                <p className="text-[11px] text-slate-400">{activeForm?.blurb}</p>
              </div>
              {!editing && <button onClick={() => setPickedType("")} className="press text-[11px] font-bold text-slate-400 hover:text-slate-600">Change</button>}
            </div>

            {/* One section per page, as the original form does. 31 questions on a
                single scroll is unusable; this also means a conditional question can
                appear on the very next page rather than jumping the reader around. */}
            <div>
              <div className="mb-1.5 flex items-center justify-between text-[11px] font-bold text-slate-400">
                <span>{step === 0 ? "Who is this review for?" : pages[step - 1]?.title}</span>
                <span>Page {step + 1} of {pages.length + 1}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full transition-all duration-300" style={{ width: `${((step + 1) / (pages.length + 1)) * 100}%`, background: `linear-gradient(90deg, ${NAVY}, ${NAVY_DARK})` }} />
              </div>
            </div>

            <div className="min-h-[220px] space-y-3.5">
              {step === 0 ? (
                <Field label="Staff member *">
                  <select value={staffId} disabled={busy} onChange={e => chooseStaff(e.target.value)} className={inputCls}>
                    <option value="">Select a staff member</option>
                    {store.staff.map(s => <option key={s.id} value={s.id}>{s.name}{s.dept ? ` — ${s.dept}` : ""}</option>)}
                  </select>
                  <p className="mt-2 text-[11px] text-slate-400">The review is filed against this person. Their name pre-fills the first question.</p>
                </Field>
              ) : (
                pages[step - 1]?.questions.map(q => <ReviewField key={q.id} q={q} value={answers[q.id]} onChange={setAnswer} disabled={busy} />)
              )}
            </div>

            {pageErr && <p className="flex items-start gap-1.5 rounded-xl bg-rose-50 px-3 py-2 text-[11px] font-semibold text-rose-700 ring-1 ring-rose-200"><AlertCircle size={13} className="mt-px shrink-0" />{pageErr}</p>}

            <div className="flex items-center gap-2 border-t border-slate-100 pt-3">
              <button onClick={back} disabled={busy || step === 0}
                className="press rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-slate-600 ring-1 ring-slate-200 transition hover:bg-slate-50 disabled:opacity-30">
                Back
              </button>
              <button onClick={() => save("draft")} disabled={busy || !staffId}
                className="press rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-bold text-slate-600 transition hover:bg-slate-200 disabled:opacity-40">
                Save draft
              </button>
              <div className="flex-1" />
              {step < pages.length
                ? <PrimaryBtn onClick={next} disabled={busy}>Next <ArrowRight size={16} /></PrimaryBtn>
                : <PrimaryBtn onClick={() => save("submitted")} disabled={busy || !staffId}>
                    {busy ? <Loader size={16} /> : <Save size={16} />} {editing ? "Save changes" : "Submit review"}
                  </PrimaryBtn>}
            </div>
            <p className="text-center text-[10px] text-slate-400">“Save draft” works from any page and skips the required-field checks, so you can finish later.</p>
          </div>
        )}
      </Modal>

      {/* View */}
      <Modal open={!!viewing} onClose={() => setViewing(null)} title={viewing?.formTitle || "Review"} width={720}>
        {viewing && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200">
              <span className="flex h-9 w-9 items-center justify-center rounded-full text-[11px] font-bold text-white" style={{ background: viewing.staff?.colour || NAVY }}>{viewing.staff?.initials}</span>
              <div className="flex-1">
                <p className="text-sm font-bold text-slate-700">{viewing.staff?.name}</p>
                <p className="text-[11px] text-slate-400">
                  {viewing.term || "—"}{viewing.academicYear ? ` · ${viewing.academicYear}` : ""}
                  {viewing.completedBy ? ` · recorded by ${viewing.completedBy}` : ""}
                </p>
              </div>
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${viewing.status === "draft" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"}`}>{viewing.status === "draft" ? "Draft" : "Submitted"}</span>
            </div>
            <div className="flex gap-2">
              <button onClick={() => { if (!srExportPdf(viewing, formOf(viewing.type))) store.notify("Your browser blocked the print window — allow pop-ups for this site and try again.", "error"); }}
                className="press flex flex-1 items-center justify-center gap-2 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-bold text-slate-600 transition hover:bg-slate-200">
                <FileText size={16} /> Download PDF
              </button>
              <button onClick={() => srExportExcel(viewing, formOf(viewing.type))}
                className="press flex flex-1 items-center justify-center gap-2 rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-bold text-slate-600 transition hover:bg-slate-200">
                <Download size={16} /> Download Excel
              </button>
            </div>
            <ReviewAnswers form={formOf(viewing.type)} answers={viewing.answers || {}} />
          </div>
        )}
      </Modal>

      {/* Delete confirmation — every destructive action in this console asks first. */}
      <Modal open={!!deleteTarget} onClose={() => !busy && setDeleteTarget(null)} title="Delete review">
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            Delete the <b>{deleteTarget?.formTitle}</b> for <b>{deleteTarget?.staff?.name}</b>
            {deleteTarget?.term ? <> ({deleteTarget.term})</> : null}?
          </p>
          <p className="flex items-start gap-1.5 rounded-xl bg-rose-50 px-3 py-2 text-[11px] leading-relaxed text-rose-700 ring-1 ring-rose-200">
            <AlertCircle size={13} className="mt-px shrink-0" />
            Every answer is removed permanently. This cannot be undone.
          </p>
          <PrimaryBtn colour={MAROON} onClick={confirmRemove} disabled={busy} className="w-full">
            <Trash2 size={16} /> {busy ? "Deleting…" : "Delete review"}
          </PrimaryBtn>
          <button onClick={() => setDeleteTarget(null)} disabled={busy} className="press w-full text-center text-xs font-semibold text-slate-400 transition hover:text-slate-600">Cancel</button>
        </div>
      </Modal>
    </>
  );
}

/* ============================================================
   Student Reviews — a lecturer's record of a progress conversation.
   One dataset, two views: the lecturer's own on the app, and every
   review (with the name of whoever filed it) in the console.
   ============================================================ */

// The three progress bands, coloured identically in the app and the console so one
// word never reads differently in two places.
const PROGRESS_TONE = {
  "On Track": { bg: "bg-emerald-100", text: "text-emerald-700", colour: "#059669" },
  "Monitor":  { bg: "bg-amber-100",   text: "text-amber-700",   colour: "#b45309" },
  "At Risk":  { bg: "bg-rose-100",    text: "text-rose-700",    colour: MAROON },
};
const progressTone = (p) => PROGRESS_TONE[p] || { bg: "bg-slate-100", text: "text-slate-500", colour: "#64748b" };

// "No Concerns" states that there are none, so it cannot sit beside a specific
// concern — the server rejects that combination with a 400. Both clients toggle
// through here so neither can build a body the server will refuse.
const toggleConcern = (list, c) => {
  const has = (list || []).includes(c);
  if (c === "No Concerns") return has ? [] : ["No Concerns"];
  const next = has ? list.filter(x => x !== c) : [...list, c];
  return next.filter(x => x !== "No Concerns");
};

const blankStudentReview = () => ({ studentId: "", unitId: "", date: todayISO(), progress: "On Track", concerns: [], summary: "", agreedActions: "", followUp: false, followUpDate: "" });
// A saved review back onto the form shape — nulls become the empty strings the
// controlled inputs need, or React switches them to uncontrolled mid-edit.
const studentReviewForm = (r) => ({
  studentId: r.studentId, unitId: r.unitId || "", date: r.date, progress: r.progress,
  concerns: r.concerns || [], summary: r.summary || "", agreedActions: r.agreedActions || "",
  followUp: !!r.followUp, followUpDate: r.followUpDate || "",
});
// Mirrors the server's required fields, so a mistake is shown beside the field that
// caused it instead of coming back as a 400 after a round trip.
const studentReviewError = (f) => {
  if (!f.studentId) return "Choose the student this review is about.";
  if (!f.date) return "Enter the date of the conversation.";
  if (!f.progress) return "Choose how the student is progressing.";
  if (f.followUp && !f.followUpDate) return "Enter the date the follow-up is due.";
  return "";
};
// followUpDate only means anything alongside a follow-up; clearing it on "No" stops
// a stale date being sent back after someone changes their mind.
const studentReviewBody = (f) => ({ ...f, followUpDate: f.followUp ? f.followUpDate : "" });

/* ----- Student Review (in app) — the lecturer's own reviews ----- */
function StudentReviewScreen({ store, me }) {
  const [rows, setRows] = useState([]);
  const [options, setOptions] = useState({ progress: [], concerns: [] });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState("list");      // list | form | view
  const [editing, setEditing] = useState(null);  // the review being corrected; null = new
  const [current, setCurrent] = useState(null);  // the review being read
  const [form, setForm] = useState(blankStudentReview);
  const [formErr, setFormErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null);
  // The pickers' source data. store.students/units are only filled by the admin
  // registers pages, so on this screen they are normally empty.
  const [roster, setRoster] = useState({ students: [], units: [], courses: [] });
  const [rosterErr, setRosterErr] = useState("");
  // Which course the unit list is scoped to. Nothing is offered until one is chosen —
  // "UNIT 1" exists in four intakes, so an unscoped list invites the wrong pick.
  const [reviewCourse, setReviewCourse] = useState("");
  // What the lecturer has typed into the student search. A dropdown of 136 names is
  // unusable on a phone; typing two letters of a surname is not.
  const [studentQuery, setStudentQuery] = useState("");
  const [query, setQuery] = useState("");
  const [progressFilter, setProgressFilter] = useState("all");

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const [opts, mine] = await Promise.all([api.studentReviewOptions(), api.myStudentReviews()]);
      setOptions(opts); setRows(mine);
    } catch (e) { setErr(e.message || "Could not load your student reviews"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const haveStore = store.students.length > 0;
  useEffect(() => {
    if (haveStore) return;
    let alive = true;
    (async () => {
      try {
        // The review router's own roster, open to any staff member. The /hnd lists are
        // page-gated, so using them here left every ordinary lecturer — the people this
        // screen exists for — with an empty picker and a dead "New review" button.
        const { students: st, units: un, courses: co } = await api.studentReviewRoster();
        if (alive) setRoster({ students: st || [], units: un || [], courses: co || [] });
      } catch (e) {
        if (!alive) return;
        // They can still read, correct and delete reviews they have already written —
        // only the pickers are withdrawn, never the whole screen.
        setRosterErr(e.message || "Could not load the student list. Check your connection and try again.");
      }
    })();
    return () => { alive = false; };
  }, [haveStore]);

  // Android back: leave the form or the detail rather than the whole screen.
  useBackHandler(mode !== "list", () => { setMode("list"); return true; });

  const students = haveStore ? store.students : roster.students;
  const units = haveStore ? store.units : roster.units;
  // Course list from whichever source supplied the units.
  const reviewCourses = haveStore
    ? store.courses.map(c => ({ id: c.id, name: c.name }))
    : (roster.courses || []);
  // Tutorial/Seminar units hold imported attendance; a review is never "about" one.
  const unitsInCourse = reviewCourse
    ? units.filter(u => u.courseId === reviewCourse && u.code !== "TUTORIAL")
    : [];

  // The review being edited keeps its own student and unit in the lists even when
  // the roster is unavailable, so an existing review can always be corrected.
  const studentOptions = useMemo(() => {
    const list = students.map(s => ({ id: s.id, label: `${s.name} — ${s.studentRef}` }));
    if (editing?.student && !list.some(o => o.id === editing.student.id)) list.unshift({ id: editing.student.id, label: `${editing.student.name} — ${editing.student.studentRef}` });
    return list;
  }, [students, editing]);

  // Search on name, college ID and email — the three things a lecturer might know.
  // Capped, because a phone list that runs to 136 rows is no better than the dropdown
  // it replaced; typing another letter is the way to narrow it.
  const studentMatches = useMemo(() => {
    const terms = studentQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    return students.filter(s => {
      const hay = [s.name, s.studentRef, s.email].filter(Boolean).join(" ").toLowerCase();
      return terms.every(t => hay.includes(t));
    }).slice(0, 8);
  }, [students, studentQuery]);

  const chosenStudent = useMemo(
    () => students.find(s => s.id === form.studentId) || (editing?.student || null),
    [students, form.studentId, editing],
  );

  // Choosing the student settles the course, so the lecturer never picks it twice.
  // Falls back to leaving the course picker open when the student's course cannot be
  // told — a few students are enrolled across courses, and guessing would file the
  // review against the wrong unit.
  const pickStudent = (stu) => {
    set("studentId", stu.id);
    setStudentQuery("");
    const course = stu.courseId || "";
    if (course !== reviewCourse) { setReviewCourse(course); set("unitId", ""); }
  };
  const unitOptions = useMemo(() => {
    const list = units.map(u => ({ id: u.id, label: `${u.code} — ${u.name}` }));
    if (editing?.unit && !list.some(o => o.id === editing.unit.id)) list.unshift({ id: editing.unit.id, label: `${editing.unit.code} — ${editing.unit.name}` });
    return list;
  }, [units, editing]);

  // The server owns both lists; fall back to the known bands only so the radios are
  // never empty if /options is slow or fails.
  const progressChoices = options.progress?.length ? options.progress : Object.keys(PROGRESS_TONE);
  const concernChoices = options.concerns || [];

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const startNew = () => { setEditing(null); setForm(blankStudentReview()); setReviewCourse(""); setStudentQuery(""); setFormErr(""); setMode("form"); };
  const openEdit = (r) => {
    setEditing(r);
    setForm(studentReviewForm(r));
    // Pre-select the course of the unit already on the review, or its unit dropdown
    // opens disabled and empty and the unit looks as though it has been cleared.
    setReviewCourse(units.find(u => u.id === r.unitId)?.courseId || "");
    setStudentQuery("");
    setFormErr("");
    setMode("form");
  };
  const openView = (r) => { setCurrent(r); setMode("view"); };

  const save = async () => {
    const problem = studentReviewError(form);
    if (problem) { setFormErr(problem); return; }
    setBusy(true); setFormErr("");
    try {
      if (editing) await api.updateStudentReview(editing.id, studentReviewBody(form));
      else await api.addStudentReview(studentReviewBody(form));
      store.notify(editing ? "Review updated" : "Review saved");
      setMode("list");
      await load();
    } catch (e) { setFormErr(e.message || "Could not save the review"); }
    setBusy(false);
  };

  const remove = async () => {
    setBusy(true);
    try { await api.removeStudentReview(confirmDel.id); setConfirmDel(null); store.notify("Review deleted", "error"); await load(); }
    catch (e) { store.notify(e.message || "Could not delete the review", "error"); }
    setBusy(false);
  };

  // Search matches the three things a lecturer actually knows about a student: their
  // name, their college ID and their email. Whitespace-separated terms must ALL match
  // somewhere, so "sam 1001" narrows rather than widens.
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visibleRows = rows.filter(r => {
    if (progressFilter !== "all" && r.progress !== progressFilter) return false;
    if (!terms.length) return true;
    const hay = [r.student?.name, r.student?.studentRef, r.student?.email, r.unit?.code, r.unit?.name]
      .filter(Boolean).join(" ").toLowerCase();
    return terms.every(t => hay.includes(t));
  });
  const filtering = terms.length > 0 || progressFilter !== "all";

  /* ---------------------------------------------------------------- list ---- */
  if (mode === "list") {
    return (
      <Screen>
        <div className="space-y-3">
          {err && <Card className="!bg-rose-50 !ring-rose-200 text-sm font-semibold text-rose-600">{err}</Card>}
          {loading ? <><div className="skeleton h-24 rounded-2xl" /><div className="skeleton h-20 rounded-2xl" /></> : (
            <>
              <div className="animated-gradient relative overflow-hidden rounded-2xl p-4 text-white shadow-md fade-up" style={{ background: `linear-gradient(135deg, ${NAVY} 0%, ${NAVY_DARK} 55%, ${MAROON} 140%)`, backgroundSize: "200% 200%" }}>
                <MessageSquare size={56} className="float-slow absolute -right-2 -top-2 text-white/10" />
                <p className="relative text-base font-extrabold">Student Review</p>
                <p className="relative mt-1 text-[12px] text-white/75">Record a progress conversation — how the student is doing, what you agreed, and whether you need to see them again.</p>
              </div>

              {rosterErr && (
                <Card className="!bg-amber-50 !ring-amber-200">
                  <p className="flex items-start gap-1.5 text-[12px] font-semibold leading-relaxed text-amber-800"><AlertCircle size={14} className="mt-px shrink-0" />{rosterErr}</p>
                </Card>
              )}

              <button onClick={startNew} disabled={students.length === 0}
                className="press flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-3.5 text-sm font-bold text-white shadow-md disabled:opacity-40"
                style={{ background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` }}>
                <Plus size={17} /> New review
              </button>

              <p className="px-1 pt-1 text-[11px] font-extrabold uppercase tracking-widest text-slate-400">My reviews</p>

              {/* Only worth showing once there is enough to sift through. */}
              {rows.length > 3 && (
                <div className="space-y-2">
                  <div className="relative">
                    <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      value={query} onChange={e => setQuery(e.target.value)}
                      type="search" inputMode="search" autoComplete="off"
                      placeholder="Search name, college ID or email"
                      className="w-full rounded-2xl bg-white py-3 pl-9 pr-9 text-sm shadow-sm ring-1 ring-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2"
                      style={{ WebkitAppearance: "none" }}
                    />
                    {query && (
                      <button type="button" onClick={() => setQuery("")} aria-label="Clear search"
                        className="press absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100">
                        <X size={15} />
                      </button>
                    )}
                  </div>
                  <div className="flex gap-1.5 overflow-x-auto pb-0.5" style={{ scrollbarWidth: "none" }}>
                    {["all", ...(options.progress || [])].map(p => {
                      const on = progressFilter === p;
                      const t = p === "all" ? null : progressTone(p);
                      return (
                        <button key={p} type="button" onClick={() => setProgressFilter(p)}
                          className={`press shrink-0 rounded-full px-3 py-1.5 text-[12px] font-bold ring-1 transition ${on ? "text-white ring-transparent" : "bg-white text-slate-500 ring-slate-200"}`}
                          style={on ? { background: t?.colour || NAVY } : undefined}>
                          {p === "all" ? "All" : p}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {rows.length === 0 && <Card className="text-sm text-slate-400">You haven't recorded a student review yet. Tap “New review” above.</Card>}
              {rows.length > 0 && visibleRows.length === 0 && (
                <Card className="text-sm text-slate-400">
                  No reviews match{query ? <> “<b className="text-slate-500">{query}</b>”</> : null}.
                  <button type="button" onClick={() => { setQuery(""); setProgressFilter("all"); }} className="ml-1 font-bold text-slate-500 underline">Clear</button>
                </Card>
              )}
              {filtering && visibleRows.length > 0 && (
                <p className="px-1 text-[11px] font-semibold text-slate-400">{visibleRows.length} of {rows.length}</p>
              )}
              {visibleRows.map((r, i) => {
                const t = progressTone(r.progress);
                return (
                  <Card key={r.id} className="!p-3.5 fade-up" style={{ animationDelay: `${i * 55}ms` }}>
                    <div className="flex items-center gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-sm" style={{ background: r.student?.colour || NAVY }}>{r.student?.initials || "?"}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-slate-700">{r.student?.name || "—"}</p>
                        <p className="truncate text-[11px] text-slate-400">{fmtDate(r.date)}{r.unit ? ` · ${r.unit.code}` : ""}{r.student?.studentRef ? ` · ${r.student.studentRef}` : ""}</p>
                      </div>
                      <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold ${t.bg} ${t.text}`}>{r.progress}</span>
                    </div>
                    {((r.concerns || []).length > 0 || r.followUp) && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {(r.concerns || []).map(c => <span key={c} className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">{c}</span>)}
                        {r.followUp && <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700"><CalendarCheck size={10} /> Follow-up{r.followUpDate ? ` ${fmtDate(r.followUpDate)}` : ""}</span>}
                      </div>
                    )}
                    <div className="mt-2.5 flex gap-2">
                      <button onClick={() => openView(r)} className="press flex-1 rounded-xl bg-slate-100 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-200">View</button>
                      <button onClick={() => openEdit(r)} className="press flex-1 rounded-xl py-2 text-xs font-bold text-white" style={{ background: NAVY }}>Edit</button>
                      <button onClick={() => setConfirmDel(r)} title="Delete review" className="press rounded-xl bg-rose-50 px-3 py-2 text-rose-500 transition hover:bg-rose-100"><Trash2 size={15} /></button>
                    </div>
                  </Card>
                );
              })}
              <p className="px-1 pb-2 text-center text-[10px] leading-relaxed text-slate-400">
                Reviews you file are visible to the student they are about and to the college.
              </p>
            </>
          )}
        </div>

        <ConfirmDialog
          open={!!confirmDel}
          title="Delete this review?"
          message={`The review for ${confirmDel?.student?.name || "this student"}${confirmDel ? ` on ${fmtDate(confirmDel.date)}` : ""} will be removed permanently. This cannot be undone.`}
          confirmLabel={busy ? "Deleting…" : "Delete review"}
          danger
          onConfirm={remove}
          onCancel={() => !busy && setConfirmDel(null)}
        />
      </Screen>
    );
  }

  /* ---------------------------------------------------------------- form ---- */
  if (mode === "form") {
    return (
      <Screen>
        <div className="space-y-3">
          <button onClick={() => setMode("list")} className="press flex items-center gap-1.5 text-sm font-bold text-slate-500"><ChevronLeft size={16} /> Back to my reviews</button>

          <Card>
            <div className="space-y-3.5">
              <Field label="Student *">
                {chosenStudent ? (
                  <div className="flex items-center gap-2.5 rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white" style={{ background: chosenStudent.colour || NAVY }}>{chosenStudent.initials}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-slate-700">{chosenStudent.name}</p>
                      <p className="truncate text-[11px] text-slate-400">{chosenStudent.studentRef}</p>
                    </div>
                    <button type="button" disabled={busy}
                      onClick={() => { set("studentId", ""); set("unitId", ""); setReviewCourse(""); setStudentQuery(""); }}
                      className="press shrink-0 rounded-lg px-2.5 py-1.5 text-[11px] font-bold text-slate-500 ring-1 ring-slate-200 hover:bg-white">
                      Change
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="relative">
                      <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                      <input value={studentQuery} onChange={e => setStudentQuery(e.target.value)} disabled={busy}
                        type="search" inputMode="search" autoComplete="off"
                        placeholder="Search name, college ID or email"
                        className={inputCls + " pl-9"} style={{ "--tw-ring-color": NAVY }} />
                    </div>
                    {studentQuery.trim() && (
                      <div className="mt-1.5 space-y-1">
                        {studentMatches.map(stu => (
                          <button key={stu.id} type="button" onClick={() => pickStudent(stu)}
                            className="press flex w-full items-center gap-2.5 rounded-xl bg-white px-3 py-2 text-left ring-1 ring-slate-200 hover:bg-slate-50">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white" style={{ background: stu.colour || NAVY }}>{stu.initials}</span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-bold text-slate-700">{stu.name}</span>
                              <span className="block truncate text-[11px] text-slate-400">{stu.studentRef}</span>
                            </span>
                          </button>
                        ))}
                        {studentMatches.length === 0 && <p className="px-1 py-2 text-[11px] text-slate-400">No student matches that.</p>}
                      </div>
                    )}
                  </>
                )}
              </Field>

              <Field label="Course">
                <select value={reviewCourse} disabled={busy}
                  onChange={e => { setReviewCourse(e.target.value); set("unitId", ""); }} className={inputCls}>
                  <option value="">{chosenStudent ? "— choose a course —" : "— pick the student first —"}</option>
                  {reviewCourses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>

              <Field label="Unit">
                {/* Disabled until a course is chosen: several courses each have a
                    "UNIT 1", so one flat list of 39 makes the wrong pick easy and
                    invisible. Changing course clears the unit, so a review can never
                    keep a unit belonging to a course you have moved away from. */}
                <select value={form.unitId} disabled={busy || !reviewCourse}
                  onChange={e => set("unitId", e.target.value)}
                  className={`${inputCls} disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400`}>
                  <option value="">{reviewCourse ? "— not about a particular unit —" : "Choose a course first"}</option>
                  {unitsInCourse.map(u => <option key={u.id} value={u.id}>{u.code} — {u.name}</option>)}
                </select>
              </Field>

              <Field label="Date of conversation">
                <input type="date" value={form.date} disabled={busy} onChange={e => set("date", e.target.value)} className={inputCls} />
              </Field>

              <Field label="Progress">
                <div className="space-y-1.5">
                  {progressChoices.map(p => {
                    const t = progressTone(p); const on = form.progress === p;
                    return (
                      <button key={p} type="button" onClick={() => set("progress", p)} disabled={busy}
                        className={`press flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm font-bold ring-1 transition ${on ? `${t.bg} ${t.text} ring-transparent` : "bg-white text-slate-500 ring-slate-200"}`}>
                        <span className={`h-4 w-4 shrink-0 rounded-full ring-2 ${on ? "ring-transparent" : "ring-slate-300"}`} style={{ background: on ? t.colour : "transparent" }} />
                        {p}
                      </button>
                    );
                  })}
                </div>
              </Field>

              <Field label="Concerns">
                <div className="space-y-1.5">
                  {concernChoices.map(c => {
                    const on = form.concerns.includes(c);
                    return (
                      <button key={c} type="button" onClick={() => set("concerns", toggleConcern(form.concerns, c))} disabled={busy}
                        className={`press flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm font-semibold ring-1 transition ${on ? "bg-blue-50 text-blue-800 ring-blue-200" : "bg-white text-slate-500 ring-slate-200"}`}>
                        <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-md ring-2 ${on ? "text-white ring-transparent" : "ring-slate-300"}`} style={on ? { background: NAVY } : {}}>{on && <Check size={11} />}</span>
                        {c}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-[11px] text-slate-400">“No Concerns” can't be combined with a specific concern.</p>
              </Field>

              <Field label="Summary of discussion">
                <textarea rows={4} value={form.summary} disabled={busy} onChange={e => set("summary", e.target.value)} placeholder="What was discussed…" className={`${inputCls} resize-y`} />
              </Field>

              <Field label="Agreed actions">
                <textarea rows={3} value={form.agreedActions} disabled={busy} onChange={e => set("agreedActions", e.target.value)} placeholder="What the student and you agreed to do…" className={`${inputCls} resize-y`} />
              </Field>

              <Field label="Follow-up required?">
                <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
                  {[{ v: false, l: "No" }, { v: true, l: "Yes" }].map(o => (
                    <button key={String(o.v)} type="button" disabled={busy}
                      onClick={() => setForm(f => ({ ...f, followUp: o.v, followUpDate: o.v ? f.followUpDate : "" }))}
                      className={`press flex-1 rounded-lg py-2 text-xs font-bold transition ${form.followUp === o.v ? (o.v ? "bg-amber-500 text-white shadow-sm" : "bg-white text-slate-700 shadow-sm") : "text-slate-400"}`}>{o.l}</button>
                  ))}
                </div>
              </Field>

              {form.followUp && (
                <Field label="Follow-up date *">
                  <input type="date" value={form.followUpDate} disabled={busy} min={form.date} onChange={e => set("followUpDate", e.target.value)} className={inputCls} />
                </Field>
              )}
            </div>
          </Card>

          {formErr && <Card className="!bg-rose-50 !ring-rose-200 text-[12px] font-semibold text-rose-600">{formErr}</Card>}

          <div className="flex items-center gap-2">
            <button onClick={() => setMode("list")} disabled={busy}
              className="press rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-slate-600 ring-1 ring-slate-200 transition hover:bg-slate-50 disabled:opacity-40">Cancel</button>
            <div className="flex-1" />
            <button onClick={save} disabled={busy}
              className="press flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold text-white shadow-md disabled:opacity-40" style={{ background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` }}>
              {busy ? <Loader size={16} /> : <Save size={16} />} {editing ? "Save changes" : "Save review"}
            </button>
          </div>
          <p className="pb-2 text-center text-[10px] text-slate-400">Filed as {me.name}.</p>
        </div>
      </Screen>
    );
  }

  /* ---------------------------------------------------------------- view ---- */
  const t = progressTone(current?.progress);
  return (
    <Screen>
      <div className="space-y-3">
        <button onClick={() => setMode("list")} className="press flex items-center gap-1.5 text-sm font-bold text-slate-500"><ChevronLeft size={16} /> Back to my reviews</button>
        <Card>
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-sm" style={{ background: current?.student?.colour || NAVY }}>{current?.student?.initials || "?"}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-extrabold text-slate-700">{current?.student?.name || "—"}</p>
              <p className="truncate text-[11px] text-slate-400">{current?.student?.studentRef}{current?.unit ? ` · ${current.unit.code} — ${current.unit.name}` : ""}</p>
            </div>
            <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold ${t.bg} ${t.text}`}>{current?.progress}</span>
          </div>
        </Card>
        <Card>
          <StudentReviewDetail r={current} />
        </Card>
        <button onClick={() => openEdit(current)} className="press w-full rounded-xl py-2.5 text-sm font-bold text-white" style={{ background: NAVY }}>Edit this review</button>
      </div>
    </Screen>
  );
}

function DetailRow({ label, children }) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</p>
      <div className="mt-0.5 text-sm text-slate-600">{children}</div>
    </div>
  );
}
// Every field of one review, in full — shared by the app's detail view and the
// console's View modal so the two can never drift apart.
function StudentReviewDetail({ r }) {
  if (!r) return null;
  const t = progressTone(r.progress);
  return (
    <div className="space-y-3.5">
      <div className="grid grid-cols-2 gap-3.5">
        <DetailRow label="Student">{r.student?.name || "—"}<span className="block text-[11px] text-slate-400">{r.student?.studentRef}</span></DetailRow>
        <DetailRow label="Unit">{r.unit ? <>{r.unit.code}<span className="block text-[11px] text-slate-400">{r.unit.name}</span></> : <span className="text-slate-300">Not unit specific</span>}</DetailRow>
        <DetailRow label="Date">{fmtDate(r.date)}</DetailRow>
        <DetailRow label="Progress"><span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${t.bg} ${t.text}`}>{r.progress}</span></DetailRow>
      </div>
      <DetailRow label="Concerns">
        {(r.concerns || []).length === 0
          ? <span className="text-slate-300">None recorded</span>
          : <span className="flex flex-wrap gap-1.5">{r.concerns.map(c => <span key={c} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">{c}</span>)}</span>}
      </DetailRow>
      <DetailRow label="Summary of discussion"><p className="whitespace-pre-wrap leading-relaxed">{r.summary || <span className="text-slate-300">—</span>}</p></DetailRow>
      <DetailRow label="Agreed actions"><p className="whitespace-pre-wrap leading-relaxed">{r.agreedActions || <span className="text-slate-300">—</span>}</p></DetailRow>
      <div className="grid grid-cols-2 gap-3.5">
        <DetailRow label="Follow-up required">
          {r.followUp
            ? <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-bold text-amber-700">Yes</span>
            : <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-400">No</span>}
        </DetailRow>
        <DetailRow label="Follow-up date">{r.followUpDate ? fmtDate(r.followUpDate) : <span className="text-slate-300">—</span>}</DetailRow>
      </div>
      <DetailRow label="Submitted by">{r.staffName || <span className="text-slate-300">—</span>}</DetailRow>
    </div>
  );
}

/* ----- Dashboard: Student Reviews — every review, whoever filed it ----- */
function AdminStudentReviews({ store }) {
  const [rows, setRows] = useState([]);
  const [roster, setRoster] = useState({ students: [], units: [] });
  const [options, setOptions] = useState({ progress: [], concerns: [] });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [query, setQuery] = useState("");
  const [progressFilter, setProgressFilter] = useState("all");
  const [followFilter, setFollowFilter] = useState("all");   // all | required
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(blankStudentReview);
  const [formErr, setFormErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      // The roster comes from the review router, not the HND collections. refreshHnd()
      // needs a "registers"/"students"/"executive" grant, so an admin given only the
      // Student Reviews page saw an access-denied toast and empty pickers on the very
      // tab they were granted.
      const [opts, list, roster] = await Promise.all([
        api.studentReviewOptions(), api.listStudentReviews(), api.studentReviewRoster(),
      ]);
      setOptions(opts); setRows(list);
      setRoster({ students: roster.students || [], units: roster.units || [] });
    } catch (e) { setErr(e.message || "Could not load student reviews"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  // Prefer whatever the shared store already holds (richer rows, already loaded on the
  // HND pages) and fall back to the roster this tab fetches for itself.
  const rosterStudents = store.students.length ? store.students : roster.students;
  const rosterUnits = store.units.length ? store.units : roster.units;

  // A review's own student stays in the picker even if the list hasn't arrived, so an
  // existing review can always be corrected.
  const pickerStudents = useMemo(() => {
    const list = rosterStudents;
    if (editing?.student && !list.some(s => s.id === editing.student.id)) {
      return [{ ...editing.student, email: "" }, ...list];
    }
    return list;
  }, [rosterStudents, editing]);

  const progressChoices = options.progress?.length ? options.progress : Object.keys(PROGRESS_TONE);
  const concernChoices = options.concerns || [];

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const openAdd = () => { setEditing(null); setForm(blankStudentReview()); setFormErr(""); setModal(true); };
  const openEdit = (r) => { setEditing(r); setForm(studentReviewForm(r)); setFormErr(""); setModal(true); };

  const save = async () => {
    const problem = studentReviewError(form);
    if (problem) { setFormErr(problem); return; }
    setBusy(true); setFormErr("");
    try {
      if (editing) await api.updateStudentReview(editing.id, studentReviewBody(form));
      else await api.addStudentReview(studentReviewBody(form));
      store.notify(editing ? "Review updated" : "Review added");
      setModal(false);
      await load();
    } catch (e) { setFormErr(e.message || "Could not save the review"); }
    setBusy(false);
  };

  const confirmRemove = async () => {
    setBusy(true);
    try { await api.removeStudentReview(deleteTarget.id); setDeleteTarget(null); store.notify("Review deleted", "error"); await load(); }
    catch (e) { store.notify(e.message || "Could not delete the review", "error"); }
    setBusy(false);
  };

  const ql = query.trim().toLowerCase();
  const list = rows.filter(r => {
    if (progressFilter !== "all" && r.progress !== progressFilter) return false;
    if (followFilter === "required" && !r.followUp) return false;
    if (!ql) return true;
    return (r.student?.name || "").toLowerCase().includes(ql)
      || (r.student?.studentRef || "").toLowerCase().includes(ql)
      || (r.staffName || "").toLowerCase().includes(ql)
      || (r.unit?.code || "").toLowerCase().includes(ql)
      || (r.summary || "").toLowerCase().includes(ql);
  });
  const paged = usePaged(list, 10, `${ql}|${progressFilter}|${followFilter}`);

  const exportCsv = () => {
    if (!list.length) { store.notify("Nothing to export in the current view", "error"); return; }
    downloadCSV("student-reviews.csv", [
      { key: "ref", label: "Student reference" }, { key: "student", label: "Student" },
      { key: "unit", label: "Unit" }, { key: "date", label: "Date" }, { key: "progress", label: "Progress" },
      { key: "concerns", label: "Concerns" }, { key: "summary", label: "Summary of discussion" },
      { key: "actions", label: "Agreed actions" }, { key: "followUp", label: "Follow-up required" },
      { key: "followUpDate", label: "Follow-up date" }, { key: "staff", label: "Submitted by" },
    ], list.map(r => ({
      ref: r.student?.studentRef || "", student: r.student?.name || "",
      unit: r.unit ? `${r.unit.code} — ${r.unit.name}` : "", date: r.date, progress: r.progress,
      concerns: (r.concerns || []).join("; "), summary: r.summary || "", actions: r.agreedActions || "",
      followUp: r.followUp ? "Yes" : "No", followUpDate: r.followUpDate || "", staff: r.staffName || "",
    })));
    store.notify(`Exported ${list.length} review${list.length === 1 ? "" : "s"}`);
  };

  return (
    <>
      <AdminHeader title="Student Reviews" subtitle="Progress conversations recorded by lecturers, and the follow-ups they agreed"
        Icon={MessageSquare}
        action={<div className="flex flex-wrap items-center gap-2"><ExportBtn onClick={exportCsv} /><PrimaryBtn onClick={openAdd}><Plus size={16} /> Add review</PrimaryBtn></div>} />

      {err && <div className="mb-4 flex items-start gap-2 rounded-xl bg-rose-50 px-3.5 py-3 text-sm font-semibold text-rose-700 ring-1 ring-rose-200"><AlertCircle size={16} className="mt-px shrink-0" />{err}</div>}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {[{ v: "all", l: "All progress" }, ...progressChoices.map(p => ({ v: p, l: p }))].map(o => (
          <button key={o.v} onClick={() => setProgressFilter(o.v)}
            className={`press rounded-full px-3 py-1.5 text-xs font-bold shadow-sm ring-1 transition ${progressFilter === o.v ? "text-white ring-transparent" : "bg-white text-slate-500 ring-slate-200 hover:bg-slate-50"}`}
            style={progressFilter === o.v ? { background: o.v === "all" ? `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` : progressTone(o.v).colour } : {}}>{o.l}</button>
        ))}
        <div className="flex gap-1 rounded-xl bg-white p-1 ring-1 ring-slate-200">
          {[{ k: "all", l: "All" }, { k: "required", l: "Follow-up required" }].map(f => (
            <button key={f.k} onClick={() => setFollowFilter(f.k)} className={`press rounded-lg px-2.5 py-1.5 text-xs font-bold transition ${followFilter === f.k ? "text-white" : "text-slate-500 hover:bg-slate-100"}`} style={followFilter === f.k ? { background: NAVY } : {}}>{f.l}</button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
          <Search size={15} className="text-slate-400" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search student, lecturer, unit or summary…" className="w-56 bg-transparent text-sm outline-none" />
        </div>
      </div>

      {loading ? <div className="skeleton h-64 rounded-2xl" /> : (
        <>
          <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 fade-up">
            <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-5 py-3">Student</th><th className="px-5 py-3">Unit</th><th className="px-5 py-3 whitespace-nowrap">Date</th>
                    <th className="px-5 py-3">Progress</th><th className="px-5 py-3 text-center">Concerns</th><th className="px-5 py-3">Submitted by</th>
                    <th className="px-5 py-3 text-center whitespace-nowrap">Follow-up?</th><th className="px-5 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.slice.map(r => {
                    const t = progressTone(r.progress);
                    const n = (r.concerns || []).length;
                    return (
                      <tr key={r.id} onClick={() => setViewing(r)} className="cursor-pointer border-t border-slate-100 transition-colors duration-150 hover:bg-blue-50/40">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2.5">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-sm" style={{ background: r.student?.colour || "#94a3b8" }}>{r.student?.initials || "?"}</span>
                            <div className="min-w-0"><p className="font-semibold text-slate-700">{r.student?.name || "—"}</p><p className="text-[11px] tabular-nums text-slate-400">{r.student?.studentRef || ""}</p></div>
                          </div>
                        </td>
                        <td className="px-5 py-3">{r.unit ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">{r.unit.code}</span> : <span className="text-slate-300">—</span>}</td>
                        <td className="px-5 py-3 whitespace-nowrap text-slate-500">{fmtDate(r.date)}</td>
                        <td className="px-5 py-3"><span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${t.bg} ${t.text}`}>{r.progress}</span></td>
                        <td className="px-5 py-3 text-center">
                          {n === 0
                            ? <span className="text-slate-300">—</span>
                            : <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold tabular-nums ${r.concerns[0] === "No Concerns" ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-600"}`}>{r.concerns[0] === "No Concerns" ? "None" : n}</span>}
                        </td>
                        <td className="px-5 py-3 text-slate-500">{r.staffName || <span className="text-slate-300">—</span>}</td>
                        <td className="px-5 py-3 text-center">
                          {r.followUp
                            ? <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-bold text-amber-700">{r.followUpDate ? fmtDate(r.followUpDate) : "Yes"}</span>
                            : <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-400">No</span>}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-1 whitespace-nowrap">
                            <button onClick={(e) => { e.stopPropagation(); setViewing(r); }} title="View" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"><FileText size={15} /></button>
                            <button onClick={(e) => { e.stopPropagation(); openEdit(r); }} title="Edit" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"><Edit3 size={15} /></button>
                            <button onClick={(e) => { e.stopPropagation(); setDeleteTarget(r); }} title="Delete" className="rounded-lg p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"><Trash2 size={15} /></button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {paged.slice.length === 0 && (
                    <tr><td colSpan={8} className="px-5 py-12">
                      <EmptyState Icon={MessageSquare} title={rows.length ? "No reviews match" : "No student reviews yet"}
                        msg={rows.length ? "Try a different search or filter." : "Lecturers record these from the Student Review screen in the app."} />
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <Pagination className="mt-4" page={paged.page} setPage={paged.setPage} totalPages={paged.totalPages} total={paged.total} />
        </>
      )}

      {/* Add / edit */}
      <Modal open={modal} onClose={() => !busy && setModal(false)} title={editing ? "Edit student review" : "Add student review"} width={640}>
        <div className="space-y-3">
          <Field label="Student"><StudentCombo students={pickerStudents} value={form.studentId} onChange={id => set("studentId", id)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Unit (optional)">
              <select value={form.unitId} onChange={e => set("unitId", e.target.value)} className={inputCls}>
                <option value="">— not unit specific —</option>
                {rosterUnits.map(u => <option key={u.id} value={u.id}>{u.code} — {u.name}</option>)}
              </select>
            </Field>
            <Field label="Date of conversation"><input type="date" value={form.date} onChange={e => set("date", e.target.value)} className={inputCls} /></Field>
          </div>
          <Field label="Progress">
            <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
              {progressChoices.map(p => (
                <button key={p} type="button" onClick={() => set("progress", p)}
                  className={`press flex-1 rounded-lg py-2 text-xs font-bold transition ${form.progress === p ? "text-white shadow-sm" : "text-slate-400 hover:text-slate-600"}`}
                  style={form.progress === p ? { background: progressTone(p).colour } : {}}>{p}</button>
              ))}
            </div>
          </Field>
          <Field label="Concerns">
            <div className="grid grid-cols-2 gap-1.5">
              {concernChoices.map(c => {
                const on = form.concerns.includes(c);
                return (
                  <button key={c} type="button" onClick={() => set("concerns", toggleConcern(form.concerns, c))}
                    className={`press flex items-center gap-2 rounded-xl px-3 py-2 text-left text-xs font-bold ring-1 transition ${on ? "bg-blue-50 text-blue-800 ring-blue-200" : "bg-white text-slate-500 ring-slate-200 hover:bg-slate-50"}`}>
                    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-md ring-2 ${on ? "text-white ring-transparent" : "ring-slate-300"}`} style={on ? { background: NAVY } : {}}>{on && <Check size={11} />}</span>
                    {c}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400">“No Concerns” can't be combined with a specific concern.</p>
          </Field>
          <Field label="Summary of discussion"><textarea rows={4} value={form.summary} onChange={e => set("summary", e.target.value)} placeholder="What was discussed…" className={`${inputCls} resize-y`} /></Field>
          <Field label="Agreed actions"><textarea rows={3} value={form.agreedActions} onChange={e => set("agreedActions", e.target.value)} placeholder="Actions agreed with the student…" className={`${inputCls} resize-y`} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Follow-up required?">
              <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
                {[{ v: false, l: "No" }, { v: true, l: "Yes" }].map(o => (
                  <button key={String(o.v)} type="button" onClick={() => setForm(f => ({ ...f, followUp: o.v, followUpDate: o.v ? f.followUpDate : "" }))}
                    className={`press flex-1 rounded-lg py-2 text-xs font-bold transition ${form.followUp === o.v ? (o.v ? "bg-amber-500 text-white shadow-sm" : "bg-white text-slate-700 shadow-sm") : "text-slate-400"}`}>{o.l}</button>
                ))}
              </div>
            </Field>
            {form.followUp && <Field label="Follow-up date"><input type="date" value={form.followUpDate} min={form.date} onChange={e => set("followUpDate", e.target.value)} className={inputCls} /></Field>}
          </div>
          {formErr && <p className="flex items-start gap-1.5 rounded-xl bg-rose-50 px-3 py-2 text-[11px] font-semibold text-rose-700 ring-1 ring-rose-200"><AlertCircle size={13} className="mt-px shrink-0" />{formErr}</p>}
          {editing?.staffName && <p className="text-[11px] text-slate-400">Originally submitted by {editing.staffName}.</p>}
          <PrimaryBtn onClick={save} disabled={busy} className="w-full">{busy ? <><Loader size={16} /> Saving…</> : <><Save size={16} /> {editing ? "Save changes" : "Add review"}</>}</PrimaryBtn>
        </div>
      </Modal>

      {/* View */}
      <Modal open={!!viewing} onClose={() => setViewing(null)} title="Student review" width={640}>
        {viewing && <StudentReviewDetail r={viewing} />}
      </Modal>

      {/* Delete confirmation — every destructive action in this console asks first. */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete this review?"
        message={`The review for ${deleteTarget?.student?.name || "this student"}${deleteTarget ? ` on ${fmtDate(deleteTarget.date)}` : ""}, submitted by ${deleteTarget?.staffName || "a colleague"}, will be removed permanently. This cannot be undone.`}
        confirmLabel={busy ? "Deleting…" : "Delete review"}
        danger
        onConfirm={confirmRemove}
        onCancel={() => !busy && setDeleteTarget(null)}
      />
    </>
  );
}

/* ----- Courses: the top of the hierarchy — HND Business, HND Computing… ----- */
// Swatches offered when creating a course, so its cards and its courses share
// a colour. Kept in sync with the register palette for a coherent look.
const PROGRAMME_COLOURS = ["#1a3a8f", "#0d7a5f", "#6d28d9", "#b45309", "#0e7490", "#9e1b32", "#2563eb", "#5b6472"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function HndCourses({ store, onOpen }) {
  const [modal, setModal] = useState(false);
  const [edit, setEdit] = useState(null);
  const nowYear = new Date().getFullYear();
  // cohortMonth/cohortYear seed the course's FIRST intake when adding.
  const [form, setForm] = useState({ name: "", colour: PROGRAMME_COLOURS[0], cohortMonth: 9, cohortYear: nowYear });
  const [cohortProg, setCohortProg] = useState(null); // the course whose cohorts are being managed
  const YEARS = Array.from({ length: 7 }, (_, i) => nowYear - 2 + i);

  const [cohortBusy, setCohortBusy] = useState(false);

  const openAdd = () => { setEdit(null); setForm({ name: "", colour: PROGRAMME_COLOURS[0], cohortMonth: 9, cohortYear: nowYear }); setModal(true); };
  const openEdit = (p) => { setEdit(p); setForm({ name: p.name, colour: p.colour || PROGRAMME_COLOURS[0], cohortMonth: 9, cohortYear: nowYear }); setModal(true); };

  // Intakes belonging to the course being edited. Read from the store rather than
  // held in state, so one added here shows up the moment the store refreshes.
  const editCohorts = edit ? (store.cohorts || []).filter(c => c.courseId === edit.id) : [];
  const newCohortName = `${MONTHS[form.cohortMonth - 1]} ${form.cohortYear}`;
  // Intake names are unique per course, so adding a duplicate would be rejected by
  // the API — say so up front instead of letting them press it and get an error.
  const cohortExists = editCohorts.some(c => c.name.toLowerCase() === newCohortName.toLowerCase());
  const addCohortNow = async () => {
    if (!edit || cohortExists) return;
    setCohortBusy(true);
    try {
      await store.addCohort({
        courseId: edit.id,
        name: newCohortName,
        startDate: `${form.cohortYear}-${String(form.cohortMonth).padStart(2, "0")}-01`,
      });
    } catch (_e) { /* toast shown by the store */ }
    setCohortBusy(false);
  };
  const save = async () => {
    try {
      if (edit) {
        await store.updateCourse(edit.id, { name: form.name, colour: form.colour });
      } else {
        const prog = await store.addCourse({ name: form.name, colour: form.colour });
        // Seed the first cohort (intake) from the chosen month + year, e.g. "Sep 2025".
        if (prog?.id) {
          await store.addCohort({ courseId: prog.id, name: `${MONTHS[form.cohortMonth - 1]} ${form.cohortYear}`, startDate: `${form.cohortYear}-${String(form.cohortMonth).padStart(2, "0")}-01` });
        }
      }
      setModal(false);
    } catch (_e) { /* toast shown by the store; keep the modal open */ }
  };
  const remove = async (p) => {
    const n = p.unitCount || 0;
    // Cohorts and their terms cascade-delete with the course, and units lose their
    // cohort/term link — spell all of that out rather than only mentioning units.
    const myCohorts = (store.cohorts || []).filter(c => c.courseId === p.id);
    const nTerms = (store.terms || []).filter(t => myCohorts.some(c => c.id === t.cohortId)).length;
    const lines = [`Delete the course "${p.name}"?`, ""];
    lines.push(n ? `• Its ${n} unit${n === 1 ? "" : "s"} will be KEPT but left unassigned (no sessions or registers are deleted).` : "• It has no units.");
    if (myCohorts.length) lines.push(`• ${myCohorts.length} cohort${myCohorts.length === 1 ? "" : "s"}${nTerms ? ` and ${nTerms} term${nTerms === 1 ? "" : "s"}` : ""} under it will be PERMANENTLY DELETED.`);
    if (nTerms) lines.push("• Those units lose their term dates, so term-based attendance locking no longer applies to them.");
    lines.push("", "This cannot be undone.");
    if (!window.confirm(lines.join("\n"))) return;
    await store.removeCourse(p.id);
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-xs text-slate-500">
          A course groups the units taught under it — e.g. <span className="font-semibold">HND Business</span>.
          Add your courses here, then open one to add its units.
        </p>
        <PrimaryBtn onClick={openAdd}><Plus size={16} /> Add course</PrimaryBtn>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {store.courses.map((p, i) => {
          const colour = p.colour || NAVY;
          const seed = hashStr(p.name);
          return (
            <div key={p.id} className="fade-up flex flex-col overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md hover:ring-slate-300/80" style={{ animationDelay: `${i * 45}ms` }}>
              <div className="relative h-24">
                <CoursePattern seed={seed} colour={colour} />
                <div className="absolute right-3 top-3"><CourseMenu onEdit={() => openEdit(p)} onDelete={() => remove(p)} onCohorts={() => setCohortProg(p)} editLabel="Edit course" deleteLabel="Delete course" /></div>
                <span className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-md bg-white/95 px-2.5 py-1 text-xs font-extrabold text-slate-800 shadow-sm"><Layers size={12} /> Course</span>
              </div>
              <div className="flex flex-1 flex-col p-4">
                <h3 className="text-base font-extrabold leading-snug" style={{ color: NAVY_DARK }}>{p.name}</h3>
                <p className="mt-1 text-xs font-semibold text-slate-400">{p.unitCount || 0} unit{(p.unitCount || 0) === 1 ? "" : "s"}</p>
                {(() => {
                  const cs = (store.cohorts || []).filter(c => c.courseId === p.id);
                  return cs.length > 0
                    ? <div className="mt-1.5 flex flex-wrap gap-1">{cs.map(c => <span key={c.id} className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold text-indigo-700 ring-1 ring-indigo-100">{c.name}</span>)}</div>
                    : <p className="mt-1 text-[11px] font-semibold text-slate-300">No cohorts yet</p>;
                })()}
                <div className="mt-4 flex gap-2">
                  <button onClick={() => onOpen(p.id)} className="press flex flex-1 items-center justify-center gap-1.5 rounded-xl border-2 border-slate-200 py-2.5 text-sm font-bold transition hover:border-indigo-300 hover:bg-indigo-50" style={{ color: NAVY }}>
                    View units <ArrowRight size={15} />
                  </button>
                  <button onClick={() => setCohortProg(p)} title="Manage cohorts" className="press flex shrink-0 items-center justify-center gap-1.5 rounded-xl border-2 border-slate-200 px-3 py-2.5 text-sm font-bold text-slate-500 transition hover:border-indigo-300 hover:bg-indigo-50">
                    <Layers size={15} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        {store.courses.length === 0 && (
          <div className="sm:col-span-2 lg:col-span-3">
            <Card><EmptyState Icon={Layers} title="No courses yet" msg="Add your first course — e.g. HND Business — then add its units." /></Card>
          </div>
        )}
      </div>

      <Modal open={modal} onClose={() => setModal(false)} title={edit ? "Edit course" : "Add course"}>
        <div className="space-y-3">
          <Field label="Course name"><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. HND Business" className={inputCls} /></Field>
          <Field label="Colour">
            <div className="flex flex-wrap gap-2">
              {PROGRAMME_COLOURS.map(c => (
                <button key={c} type="button" onClick={() => setForm(f => ({ ...f, colour: c }))} aria-label={`Colour ${c}`}
                  className={`h-8 w-8 rounded-lg transition ${form.colour === c ? "ring-2 ring-offset-2 ring-slate-400" : "ring-1 ring-black/5"}`} style={{ background: c }} />
              ))}
            </div>
          </Field>
          {!edit ? (
            <Field label="First cohort (intake)">
              <div className="grid grid-cols-2 gap-2">
                <select value={form.cohortMonth} onChange={e => setForm(f => ({ ...f, cohortMonth: Number(e.target.value) }))} className={inputCls}>
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
                <select value={form.cohortYear} onChange={e => setForm(f => ({ ...f, cohortYear: Number(e.target.value) }))} className={inputCls}>
                  {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
              <p className="mt-1 text-[11px] text-slate-400">Creates the first intake — <b>{MONTHS[form.cohortMonth - 1]} {form.cohortYear}</b>. You can add more later via Manage cohorts.</p>
            </Field>
          ) : (
            /* Editing: intakes are managed here too, not only on the create screen —
               otherwise a course made earlier can never gain a second intake without
               hunting through the card menu. */
            <Field label="Cohorts (intakes)">
              <div className="rounded-xl border border-slate-200 p-2.5">
                {editCohorts.length
                  ? <div className="mb-2 flex flex-wrap gap-1.5">
                      {editCohorts.map(c => (
                        <span key={c.id} className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600">
                          {c.name}{c.startDate ? <span className="ml-1 font-medium text-slate-400">· {c.startDate}</span> : null}
                        </span>
                      ))}
                    </div>
                  : <p className="mb-2 text-[11px] text-slate-400">No intakes on this course yet.</p>}
                <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                  <select value={form.cohortMonth} onChange={e => setForm(f => ({ ...f, cohortMonth: Number(e.target.value) }))} className={inputCls}>
                    {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                  </select>
                  <select value={form.cohortYear} onChange={e => setForm(f => ({ ...f, cohortYear: Number(e.target.value) }))} className={inputCls}>
                    {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
                  </select>
                  <button type="button" onClick={addCohortNow} disabled={cohortBusy || cohortExists}
                    className="press flex items-center gap-1.5 rounded-xl px-3 text-xs font-bold text-white transition disabled:opacity-40"
                    style={{ background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` }}>
                    {cohortBusy ? <Loader size={14} /> : <Plus size={14} />} Add
                  </button>
                </div>
                <p className="mt-1.5 text-[10px] leading-relaxed text-slate-400">
                  {cohortExists
                    ? <><b>{newCohortName}</b> already exists on this course.</>
                    : <>Adds <b>{newCohortName}</b> straight away — no need to press Save. Use <b>Manage cohorts</b> for start dates and terms.</>}
                </p>
              </div>
            </Field>
          )}
          <PrimaryBtn onClick={save} disabled={!form.name.trim()} className="w-full"><Save size={16} /> {edit ? "Save changes" : "Add course"}</PrimaryBtn>
        </div>
      </Modal>

      {cohortProg && <CohortManager store={store} course={cohortProg} onClose={() => setCohortProg(null)} />}
    </>
  );
}

/* ----- Cohorts & terms: intakes (e.g. "SEP 2025") under one course ----- */
function CohortManager({ store, course, onClose }) {
  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  const [busy, setBusy] = useState(false);
  const [termCohort, setTermCohort] = useState(null); // cohort whose terms are being edited
  const list = (store.cohorts || []).filter(c => c.courseId === course.id);
  const termsOf = (cid) => (store.terms || []).filter(t => t.cohortId === cid).sort((a, b) => a.year - b.year || a.index - b.index);
  const today = todayISO();
  const isActiveTerm = (t) => today >= t.start && today <= t.end;

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { await store.addCohort({ courseId: course.id, name: name.trim(), startDate: start || null }); setName(""); setStart(""); }
    catch (_) { /* store toasts the error (e.g. duplicate name) */ }
    finally { setBusy(false); }
  };
  const remove = async (c) => { if (window.confirm(`Delete cohort "${c.name}"? Its terms are removed too.`)) await store.removeCohort(c.id); };
  const genTerms = async (c) => {
    if (!c.startDate) { store.notify?.("Set this cohort's start date first (it dates the terms).", "error"); return; }
    setBusy(true);
    try { await store.generateTerms(c.id, {}); } catch (_) {} finally { setBusy(false); }
  };
  // Saving a term date can leave a GAP between terms — days covered by no term at all,
  // which silently locks every register in that window. The server reports them; warn
  // rather than letting the admin discover it when attendance won't open.
  const setTermDate = async (t, field, value) => {
    if (!value) return;
    try {
      const res = await store.updateTerm(t.id, { [field]: value });
      const gaps = res?.gaps || [];
      if (gaps.length) store.notify?.(`Warning: no term covers ${gaps.map(g => `${fmtDate(g.from)} → ${fmtDate(g.to)}`).join(", ")} — registers are locked on those dates.`, "error");
    } catch (_) { /* store toasts the error (e.g. overlapping dates) */ }
  };
  const delTerm = async (t) => { if (window.confirm(`Delete ${t.name}?`)) await store.removeTerm(t.id); };

  // ---- Term editor for one cohort ----
  if (termCohort) {
    const ts = termsOf(termCohort.id);
    return (
      <Modal open onClose={onClose} title={`Terms — ${termCohort.name}`}>
        <div className="space-y-3">
          <button onClick={() => setTermCohort(null)} className="flex items-center gap-1 text-xs font-bold text-slate-500 transition hover:text-slate-700"><ChevronLeft size={14} /> Back to cohorts</button>
          <p className="text-[11px] text-slate-500">An HND runs <b>6 terms</b> — Year 1 &amp; Year 2, three each. The term whose dates contain today is the <b>current</b> one; that's what will open attendance later.</p>
          {ts.length === 0 && (
            <div className="rounded-xl bg-slate-50 p-4 text-center ring-1 ring-slate-100">
              <p className="text-sm text-slate-500">No terms set up yet.</p>
              {!termCohort.startDate && <p className="mt-1 text-[11px] font-semibold text-amber-600">Set this cohort's start date first so the terms get dated automatically.</p>}
              <PrimaryBtn onClick={() => genTerms(termCohort)} disabled={busy || !termCohort.startDate} className="mt-3"><Plus size={16} /> Generate 6 terms</PrimaryBtn>
            </div>
          )}
          {ts.map(t => (
            <div key={t.id} className={`rounded-xl p-3 ring-1 ${isActiveTerm(t) ? "bg-emerald-50/60 ring-emerald-200" : "bg-white ring-slate-200"}`}>
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold text-slate-700">{t.name}{isActiveTerm(t) && <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">Current</span>}</p>
                <button onClick={() => delTerm(t)} title="Delete term" className="rounded p-1 text-slate-300 transition hover:text-rose-500"><Trash2 size={14} /></button>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Field label="From"><input type="date" value={t.start} onChange={e => setTermDate(t, "start", e.target.value)} className={inputCls} /></Field>
                <Field label="To"><input type="date" value={t.end} min={t.start} onChange={e => setTermDate(t, "end", e.target.value)} className={inputCls} /></Field>
              </div>
            </div>
          ))}
        </div>
      </Modal>
    );
  }

  // ---- Cohort list ----
  return (
    <Modal open onClose={onClose} title={`Cohorts — ${course.name}`}>
      <div className="space-y-3">
        <p className="text-[11px] text-slate-500">An intake of students on this course — e.g. <b>SEP 2025</b>, <b>Jan 2024</b>. Each cohort runs its own 6 terms.</p>

        <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Cohort name, e.g. SEP 2025" className={inputCls} onKeyDown={e => { if (e.key === "Enter") add(); }} />
            <input type="date" value={start} onChange={e => setStart(e.target.value)} title="Start date" className={inputCls} />
          </div>
          <PrimaryBtn onClick={add} disabled={busy || !name.trim()} className="mt-2 w-full"><Plus size={16} /> {busy ? "Adding…" : "Add cohort"}</PrimaryBtn>
        </div>

        <div className="space-y-2">
          {list.length === 0 && <EmptyState Icon={Layers} title="No cohorts yet" msg="Add your first intake above." />}
          {list.map(c => {
            const n = termsOf(c.id).length;
            return (
              <div key={c.id} className="flex items-center justify-between rounded-xl bg-white px-3 py-2.5 ring-1 ring-slate-200">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-slate-700">{c.name}</p>
                  <p className="text-[11px] text-slate-400">{c.startDate ? `Starts ${fmtDate(c.startDate)}` : "No start date"} · {n} term{n === 1 ? "" : "s"}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button onClick={() => setTermCohort(c)} className="press flex items-center gap-1 rounded-lg border-2 border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50"><CalendarDays size={13} /> Terms</button>
                  <button onClick={() => remove(c)} title="Delete cohort" className="rounded-lg p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"><Trash2 size={16} /></button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

/* ----- Courses: the unit gallery, add / edit / delete + open registers ----- */
function Units({ store, onView, courseFilter = "", setCourseFilter }) {
  const [modal, setModal] = useState(false);
  const [step, setStep] = useState("details");       // details -> schedule (new courses only)
  const [edit, setEdit] = useState(null);
  const [form, setForm] = useState({ code: "", unitNumber: "", name: "", tutor: "", tutorStaffId: "", courseId: "", cohortId: "", termId: "", year: "", termNumber: "", startDate: "", endDate: "", submissionDate: "" });
  const [yearFilter, setYearFilter] = useState("");   // "" = any year, "none" = not classified
  const [termFilter, setTermFilter] = useState("");   // "" = any term
  const [statusFilter, setStatusFilter] = useState(""); // "" | current | past | future | unscheduled
  const [picked, setPicked] = useState([]);           // studentIds enrolled on this course
  const [pickQuery, setPickQuery] = useState("");     // search within the student picker
  const [sched, setSched] = useState({ start: todayISO(), end: "", hours: 3 });
  const [savedId, setSavedId] = useState(null);       // id of the course just created, for the schedule step
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");

  const courseById = Object.fromEntries(store.courses.map(p => [p.id, p]));
  const hasUnassigned = store.units.some(m => !m.courseId);

  // New courses default into the course currently being filtered, so opening a
  // course and hitting "Add course" files it in the right place automatically.
  const defaultCourse = courseFilter && courseFilter !== "none" ? courseFilter : "";
  const enrolledIds = (unitId) => store.students.filter(s => (s.unitIds || []).includes(unitId)).map(s => s.id);
  const openAdd = () => {
    setEdit(null); setStep("details"); setSavedId(null); setPicked([]); setPickQuery("");
    // A new unit lands in whichever year/term is being filtered, so adding one while
    // looking at "Year 1 · Term 2" files it there without re-picking.
    setForm({ code: "", unitNumber: "", name: "", tutor: "", tutorStaffId: "", submissionDate: "", courseId: defaultCourse, cohortId: "", termId: "",
      year: yearFilter && yearFilter !== "none" ? yearFilter : "", termNumber: yearFilter && yearFilter !== "none" ? termFilter : "", startDate: "", endDate: "" });
    setSched({ start: todayISO(), end: "", hours: 3 });
    setModal(true);
  };
  const openEdit = (m) => {
    setEdit(m); setStep("details"); setSavedId(m.id); setPicked(enrolledIds(m.id)); setPickQuery("");
    setForm({ code: m.code, unitNumber: m.unitNumber || "", name: m.name, tutor: m.tutor || "", tutorStaffId: m.tutorStaffId || "", submissionDate: m.submissionDate || "", courseId: m.courseId || "", cohortId: m.cohortId || "", termId: m.termId || "",
      year: m.year ?? "", termNumber: m.termNumber ?? "", startDate: m.startDate || "", endDate: m.endDate || "" });
    setModal(true);
  };
  // Generate registers for a unit that already exists — the imported units arrive
  // with no sessions at all, so this is the only way they get any. Pre-filled from
  // the unit's own teaching window.
  const openSchedule = (m) => {
    setEdit(m); setSavedId(m.id); setStep("schedule");
    setSched({ start: m.startDate || todayISO(), end: m.endDate || "", hours: 3 });
    setModal(true);
  };
  const togglePick = (id) => setPicked(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);

  // Step 1 — save the course details and its enrolled students. Editing stops
  // here; creating a new course advances to the weekly-schedule step.
  const saveDetails = async () => {
    setBusy(true);
    try {
      if (edit) {
        await store.updateUnit(edit.id, form);
        await store.setUnitEnrolments(edit.id, picked);
        setModal(false);
      } else {
        const created = await store.addUnit(form);
        if (picked.length) await store.setUnitEnrolments(created.id, picked);
        setSavedId(created.id);
        // Carry the teaching dates just entered into the schedule step. Without this
        // it opened on today's date, and the widen rule below then pushed the unit's
        // real start date back to today — losing what the admin had just typed.
        if (form.startDate) setSched(s => ({ ...s, start: form.startDate, end: form.endDate || s.end }));
        setStep("schedule");
      }
    } catch (_e) { /* toast shown by the store; keep the modal open */ }
    setBusy(false);
  };

  // Step 2 — turn the term start/end into one register per week.
  const createWeekly = async () => {
    setBusy(true);
    try {
      // The range you generate registers across IS the unit's teaching window, so
      // record it on the unit too. Without this the unit still read "No dates set"
      // after its registers had been created, which is what it looked like from the
      // outside: registers appeared, dates never did.
      //
      // Widened, never narrowed — generating a second, later batch should extend the
      // window rather than cut the earlier part of the unit off.
      const u = store.units.find(x => x.id === savedId);
      const start = u?.startDate && u.startDate < sched.start ? u.startDate : sched.start;
      const end = u?.endDate && u.endDate > sched.end ? u.endDate : sched.end;
      // Saved via the API directly rather than store.updateUnit, so this step does not
      // fire its own "Unit updated" toast on top of the register result below.
      if (start !== u?.startDate || end !== u?.endDate) await api.updateUnit(savedId, { startDate: start, endDate: end });
      await store.generateSessions(savedId, sched);
      setModal(false);
    } catch (_e) { /* toast shown by the store; keep the modal open */ }
    setBusy(false);
  };

  const remove = async (m) => {
    if (!window.confirm(`Delete ${m.code} — ${m.name}?\n\nIts ${m.sessionCount} session${m.sessionCount === 1 ? "" : "s"} and all their attendance marks will be deleted. This cannot be undone.`)) return;
    await store.removeUnit(m.id);
  };

  const ql = query.trim().toLowerCase();
  // Units in the chosen course, before the year/term filter — this is what the
  // year/term bar offers its options from, so it never lists a term that the
  // current course doesn't teach.
  const inCourse = store.units.filter(m => {
    if (courseFilter === "none" && m.courseId) return false;
    if (courseFilter && courseFilter !== "none" && m.courseId !== courseFilter) return false;
    return true;
  });
  const today = todayISO();
  const list = inCourse
    .filter(m => matchesPlace(m, yearFilter, termFilter))
    .filter(m => !statusFilter || unitStatus(m, today) === statusFilter)
    .filter(m => !ql || m.code.toLowerCase().includes(ql) || m.name.toLowerCase().includes(ql) || (m.tutor || "").toLowerCase().includes(ql))
    // Teaching order — year, then term, then unit number — so the gallery reads the
    // way the course is actually delivered.
    .sort((a, b) => placeKey(a) - placeKey(b) || (Number(a.unitNumber) || 999) - (Number(b.unitNumber) || 999) || a.code.localeCompare(b.code));

  // The course filter pills: All, each course, then "No course" if needed.
  const chips = [{ id: "", label: "All courses" },
    ...store.courses.map(p => ({ id: p.id, label: p.name, colour: p.colour })),
    ...(hasUnassigned ? [{ id: "none", label: "No course" }] : [])];

  return (
    <>
      {chips.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {chips.map(c => {
            const active = courseFilter === c.id;
            return (
              <button key={c.id || "all"} onClick={() => { setCourseFilter?.(c.id); setYearFilter(""); setTermFilter(""); setStatusFilter(""); }}
                className={`press flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold shadow-sm ring-1 transition-all ${active ? "text-white ring-transparent" : "bg-white text-slate-500 ring-slate-200 hover:bg-slate-50"}`}
                style={active ? { background: c.colour || NAVY } : {}}>
                {c.colour && !active && <span className="h-2 w-2 rounded-full" style={{ background: c.colour }} />}
                {c.label}
              </button>
            );
          })}
        </div>
      )}

      <PlaceFilter units={inCourse} year={yearFilter} setYear={setYearFilter} term={termFilter} setTerm={setTermFilter} className="mb-2.5" />
      <StatusFilter units={inCourse} value={statusFilter} setValue={setStatusFilter} today={today} className="mb-4" />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
          <Search size={15} className="text-slate-400" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search units…" className="w-40 bg-transparent text-sm outline-none sm:w-56" />
        </div>
        <PrimaryBtn onClick={openAdd}><Plus size={16} /> Add unit</PrimaryBtn>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {list.map((m, i) => {
          const seed = hashStr(m.code);
          const prog = m.courseId ? courseById[m.courseId] : null;
          // A course wears its course's colour, so the gallery reads as groups.
          const colour = prog?.colour || courseColour(seed);
          const totals = store.attendance?.unitTotals?.[m.id];
          const pct = totals?.pct ?? null;
          // Session count follows the semester picker; enrolment isn't dated, so
          // the student count is the unit's all-time total.
          const sessionCount = totals?.sessionCount ?? m.sessionCount;
          const tone = pctTone(pct);
          // Cohort/term this unit runs in, and whether that term is current (open),
          // ended (paused) or upcoming — the visible side of the pause/activate.
          const uTerm = m.termId ? (store.terms || []).find(t => t.id === m.termId) : null;
          const uCohort = m.cohortId ? (store.cohorts || []).find(c => c.id === m.cohortId) : null;
          const uToday = todayISO();
          const uState = !uTerm ? null : (uToday >= uTerm.start && uToday <= uTerm.end) ? "current" : (uToday > uTerm.end ? "past" : "future");
          return (
            <div key={m.id} className="fade-up group flex flex-col overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md hover:ring-slate-300/80" style={{ animationDelay: `${i * 45}ms` }}>
              {/* Patterned banner with the course code as a cohort-style badge */}
              <div className="relative h-32">
                <CoursePattern seed={seed} colour={colour} />
                <div className="absolute right-3 top-3"><CourseMenu onEdit={() => openEdit(m)} onSchedule={() => openSchedule(m)} onDelete={() => remove(m)} /></div>
                <span className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-md bg-white/95 px-2.5 py-1 text-xs font-extrabold text-slate-800 shadow-sm">{m.unitNumber ? <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-extrabold text-white">Unit {m.unitNumber}</span> : null}{m.code}</span>
              </div>

              <div className="flex flex-1 flex-col p-4">
                {prog
                  ? <p className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide" style={{ color: prog.colour }}><Layers size={11} /> {prog.name}</p>
                  : <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-300">No course</p>}
                {/* Always shown: every unit has a status, even if that status is
                    "no dates set" — which is the one people most need to see. */}
                <p className="mb-1 flex flex-wrap items-center gap-1 text-[10px] font-bold">
                    {/* Where the unit sits in the course structure — from Moodle. */}
                    {isPlaced(m) && <span className="rounded px-1.5 py-0.5" style={{ background: `${NAVY}14`, color: NAVY }}>{placeLabel(m)}</span>}
                    {/* Whether it is being taught now — from its own dates. */}
                    {(() => { const s = STATUS_META[unitStatus(m, today)]; return <span className={`rounded px-1.5 py-0.5 ${s.bg} ${s.text}`}>{s.label}</span>; })()}
                    {fmtWindow(m) && <span className="rounded bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-500">{fmtWindow(m)}</span>}
                    {uCohort && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">{uCohort.name}</span>}
                  {uTerm && <span className={`rounded px-1.5 py-0.5 ${uState === "current" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{uTerm.name.replace("Year ", "Y").replace(" · Term ", "T")}{uState === "current" ? " · Current" : uState === "past" ? " · Ended" : " · Upcoming"}</span>}
                </p>
                <h3 className="text-[15px] font-extrabold leading-snug" style={{ color: NAVY_DARK }} title={m.name}>{m.name}</h3>
                <UnitFacts unit={m} className="mt-1.5" />

                {/* Attendance figures kept — this is a register system, after all */}
                <div className="mt-3 grid grid-cols-3 gap-1.5 text-center">
                  <div className="rounded-lg bg-slate-50 py-1.5"><p className="text-sm font-extrabold text-slate-700 tabular-nums">{m.studentCount}</p><p className="text-[9px] uppercase tracking-wide text-slate-400">Students</p></div>
                  <div className="rounded-lg bg-slate-50 py-1.5"><p className="text-sm font-extrabold text-slate-700 tabular-nums">{sessionCount}</p><p className="text-[9px] uppercase tracking-wide text-slate-400">Sessions</p></div>
                  <div className={`rounded-lg py-1.5 ${tone.bg}`}><p className={`text-sm font-extrabold tabular-nums ${tone.text}`}>{fmtPct(pct)}</p><p className="text-[9px] uppercase tracking-wide text-slate-400">Attend.</p></div>
                </div>

                <button onClick={() => onView(m.id)} className="press mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl border-2 border-slate-200 py-2.5 text-sm font-bold transition hover:border-indigo-300 hover:bg-indigo-50" style={{ color: NAVY }}>
                  View course <ArrowRight size={15} />
                </button>
              </div>
            </div>
          );
        })}
        {store.units.length === 0 && (
          <div className="sm:col-span-2 lg:col-span-3 xl:col-span-4">
            <Card><EmptyState Icon={BookOpen} title="No units yet" msg="Add your first HND unit to start timetabling sessions and taking registers." /></Card>
          </div>
        )}
        {store.units.length > 0 && list.length === 0 && (
          <div className="sm:col-span-2 lg:col-span-3 xl:col-span-4">
            <Card><EmptyState Icon={Search} title="No matching units" msg={query ? `Nothing matches "${query}".` : "No units on this course yet — use “Add unit” to create one."} /></Card>
          </div>
        )}
      </div>

      <Modal open={modal} onClose={() => setModal(false)} title={step === "schedule" ? "Weekly registers" : edit ? "Edit unit" : "Add unit"} width={520}>
        {step === "details" ? (
          <div className="space-y-3">
            <Field label="Course">
              <select value={form.courseId} onChange={e => setForm(f => ({ ...f, courseId: e.target.value, cohortId: "", termId: "" }))} className={inputCls}>
                <option value="">— none —</option>
                {store.courses.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            {/* Where the unit sits in the course structure. Moodle fills this in for
                imported units; it is set by hand for the rest. Purely descriptive —
                it classifies and filters, and never affects registers. */}
            <div className="rounded-xl bg-slate-50 p-3">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">Where it sits in the course</p>
              <PlaceFields form={form} setForm={setForm} />
              <p className="mt-2 text-[10px] leading-relaxed text-slate-400">Used to group and filter units. Terms run 1-6 across the two years.</p>
            </div>
            {/* The teaching window. Decides whether the unit counts as running or
                finished, and pre-fills the register generator. */}
            <div className="rounded-xl bg-slate-50 p-3">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">When it is taught</p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Start date"><input type="date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} className={inputCls} /></Field>
                <Field label="End date"><input type="date" value={form.endDate} min={form.startDate || undefined} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} className={inputCls} /></Field>
                {/* Independent of the teaching window: work is usually due after
                    teaching ends, so this is not simply the end date. */}
                <Field label="Submission date"><input type="date" value={form.submissionDate} onChange={e => setForm(f => ({ ...f, submissionDate: e.target.value }))} className={inputCls} /></Field>
              </div>
              {form.startDate && form.endDate && form.endDate < form.startDate
                ? <p className="mt-2 flex items-center gap-1.5 text-[10px] font-semibold text-rose-600"><AlertCircle size={12} /> The end date is before the start date.</p>
                : <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
                    {form.startDate && form.endDate
                      ? <>Registers can be generated across this window, and the unit counts as {unitStatus({ startDate: form.startDate, endDate: form.endDate }, todayISO()) === "current" ? "running now" : unitStatus({ startDate: form.startDate, endDate: form.endDate }, todayISO()) === "past" ? "finished" : "not started yet"}.</>
                      : "Set both dates to mark this unit as running or finished, and to create its registers."}
                  </p>}
            </div>
            {/* Which intake + DATED term this unit runs in. Optional, but needed for
                the term-based attendance pause/activate. Term list follows the cohort. */}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Cohort">
                <select value={form.cohortId} onChange={e => setForm(f => ({ ...f, cohortId: e.target.value, termId: "" }))} disabled={!form.courseId} className={inputCls}>
                  <option value="">— none —</option>
                  {store.cohorts.filter(c => c.courseId === form.courseId).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              <Field label="Dated term (registers)">
                <select value={form.termId} onChange={e => setForm(f => ({ ...f, termId: e.target.value }))} disabled={!form.cohortId} className={inputCls}>
                  <option value="">— none —</option>
                  {store.terms.filter(t => t.cohortId === form.cohortId).sort((a, b) => a.year - b.year || a.index - b.index).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Unit number"><input value={form.unitNumber} onChange={e => setForm(f => ({ ...f, unitNumber: e.target.value }))} placeholder="e.g. 1" className={inputCls} /></Field>
              <Field label="Unit code"><input value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase() }))} placeholder="e.g. OBM" className={inputCls} /></Field>
              {/* Stores the staff id, not the name: a lecturer can then be shown their
                  own units, and renaming an account cannot silently break the link.
                  Units assigned before this still show their old free-text name. */}
              <Field label="Tutor"><select value={form.tutorStaffId} onChange={e => setForm(f => ({ ...f, tutorStaffId: e.target.value }))} className={inputCls}><option value="">— unassigned —</option>{store.staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
                {!form.tutorStaffId && form.tutor && <p className="mt-1 text-[11px] text-slate-400">Currently shown as "{form.tutor}" — pick a staff member to link it properly.</p>}
              </Field>
            </div>
            <Field label="Unit name"><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Organisational Behaviour Management" className={inputCls} /></Field>

            {/* Enrol students onto this unit, straight from the student list */}
            <Field label={`Students on this unit${picked.length ? ` · ${picked.length} selected` : ""}`}>
              <StudentPicker students={store.students} picked={picked} onToggle={togglePick} query={pickQuery} setQuery={setPickQuery}
                onAll={() => setPicked(store.students.map(s => s.id))} onNone={() => setPicked([])} />
            </Field>

            <PrimaryBtn onClick={saveDetails} disabled={busy || !form.code.trim() || !form.name.trim()} className="w-full">
              {busy ? <><Loader size={16} /> Saving…</> : <><Save size={16} /> {edit ? "Save changes" : "Next: schedule registers"}</>}
            </PrimaryBtn>
          </div>
        ) : (
          <ScheduleStep sched={sched} setSched={setSched} busy={busy} onCreate={createWeekly} onSkip={() => setModal(false)} unit={edit} />
        )}
      </Modal>
    </>
  );
}

// Searchable, scrollable checkbox list of students for enrolling onto a course.
function StudentPicker({ students, picked, onToggle, query, setQuery, onAll, onNone }) {
  const ql = (query || "").trim().toLowerCase();
  const shown = students.filter(s => !ql || s.name.toLowerCase().includes(ql) || (s.email || "").toLowerCase().includes(ql) || s.studentRef.includes(ql));
  return (
    <div className="rounded-xl border border-slate-200">
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
        <Search size={14} className="text-slate-400" />
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search students…" className="flex-1 bg-transparent text-sm outline-none" />
        <button type="button" onClick={onAll} className="text-[11px] font-bold text-slate-500 hover:text-slate-700">All</button>
        <span className="text-slate-300">·</span>
        <button type="button" onClick={onNone} className="text-[11px] font-bold text-slate-500 hover:text-slate-700">None</button>
      </div>
      <div className="max-h-52 overflow-y-auto p-1">
        {shown.map(s => {
          const on = picked.includes(s.id);
          return (
            <button type="button" key={s.id} onClick={() => onToggle(s.id)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition ${on ? "bg-blue-50" : "hover:bg-slate-50"}`}>
              <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border-2 transition ${on ? "border-transparent" : "border-slate-300"}`} style={on ? { background: NAVY } : {}}>
                {on && <Check size={11} className="text-white" />}
              </span>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ background: s.colour }}>{s.initials}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-slate-700">{s.name}</span>
                <span className="block truncate text-[11px] text-slate-400">{s.studentRef}</span>
              </span>
            </button>
          );
        })}
        {shown.length === 0 && <p className="px-2 py-6 text-center text-xs text-slate-400">{students.length === 0 ? "No students yet — add students on the Students tab first." : "No students match your search."}</p>}
      </div>
    </div>
  );
}

// Step 2 of course creation: pick the term's start/end and weekly time, and it
// creates one register per week. Shows a live count of what will be created.
function ScheduleStep({ sched, setSched, busy, onCreate, onSkip, unit = null }) {
  const perWeek = Math.max(1, Math.round((Number(sched.hours) || 3) / 3)); // 3h → 1, 6h → 2 …
  const valid = sched.start && sched.end && sched.end >= sched.start && Number(sched.hours) >= 3;
  // Count weeks the same way the server does — from the start, every 7 days.
  let weeks = 0;
  if (sched.start && sched.end && sched.end >= sched.start) {
    const cur = new Date(`${sched.start}T00:00:00Z`), last = new Date(`${sched.end}T00:00:00Z`);
    while (cur <= last && weeks < 60) { weeks++; cur.setUTCDate(cur.getUTCDate() + 7); }
  }
  const weekday = sched.start ? new Date(`${sched.start}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long" }) : "";
  const total = weeks * perWeek;
  return (
    <div className="space-y-3">
      {unit
        ? <div className="flex items-start gap-2.5 rounded-xl bg-slate-50 px-3.5 py-3 text-xs ring-1 ring-slate-200">
            <CalendarDays size={16} className="mt-0.5 shrink-0 text-slate-500" />
            <p className="font-semibold text-slate-700">
              Registers for <b>{unit.code}</b>{unit.sessionCount ? <> — it already has {unit.sessionCount} register{unit.sessionCount === 1 ? "" : "s"}, and only missing ones are added.</> : "."}
              {" "}One register per 3 taught hours, weekly on the same weekday as the start date.
              {" "}These dates also become the unit's teaching window.
            </p>
          </div>
        : <div className="flex items-start gap-2.5 rounded-xl bg-emerald-50 px-3.5 py-3 text-xs ring-1 ring-emerald-200">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-600" />
            <p className="font-semibold text-emerald-800">Unit saved. Set its dates and taught hours — one register is created per 3 hours, every week.</p>
          </div>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start date"><input type="date" value={sched.start} onChange={e => setSched(s => ({ ...s, start: e.target.value }))} className={inputCls} /></Field>
        <Field label="End date"><input type="date" value={sched.end} min={sched.start} onChange={e => setSched(s => ({ ...s, end: e.target.value }))} className={inputCls} /></Field>
      </div>
      <Field label="Hours per week">
        <select value={sched.hours} onChange={e => setSched(s => ({ ...s, hours: Number(e.target.value) }))} className={inputCls}>
          <option value={3}>3 hours — 1 register</option>
          <option value={6}>6 hours — 2 registers</option>
          <option value={9}>9 hours — 3 registers</option>
          <option value={12}>12 hours — 4 registers</option>
        </select>
      </Field>
      {sched.start && sched.end && sched.end < sched.start && <p className="text-[11px] font-semibold text-rose-600">The end date must be on or after the start date.</p>}
      {valid && (
        <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
          <CalendarDays size={15} className="text-slate-400" />
          Creates <span className="font-extrabold" style={{ color: NAVY }}>{total}</span> register{total === 1 ? "" : "s"} — <b>{weeks}</b> {weekday} week{weeks === 1 ? "" : "s"} × <b>{perWeek}</b> per week.
        </div>
      )}
      <div className="flex gap-2">
        <button onClick={onSkip} disabled={busy} className="press flex-1 rounded-xl border-2 border-slate-200 py-2.5 text-sm font-bold text-slate-500 transition hover:bg-slate-50 disabled:opacity-40">Skip for now</button>
        <PrimaryBtn onClick={onCreate} disabled={busy || !valid} colour="#0d7a5f" className="flex-1">
          {busy ? <><Loader size={16} /> Creating…</> : <><CalendarCheck size={16} /> Create {valid ? total : ""} register{total === 1 ? "" : "s"}</>}
        </PrimaryBtn>
      </div>
    </div>
  );
}

/* ----- Semesters (teaching periods) ----- */
function HndSemesters({ store }) {
  const [modal, setModal] = useState(false);
  const [edit, setEdit] = useState(null);
  const [form, setForm] = useState({ name: "", start: "", end: "" });

  const openAdd = () => { setEdit(null); setForm({ name: "", start: "", end: "" }); setModal(true); };
  const openEdit = (s) => { setEdit(s); setForm({ name: s.name, start: s.start, end: s.end }); setModal(true); };
  // On failure the store has already toasted the reason (e.g. overlapping dates),
  // so swallow the rejection and leave the modal open for another go.
  const save = async () => {
    try {
      if (edit) await store.updateSemester(edit.id, form);
      else await store.addSemester(form);
      setModal(false);
    } catch (_e) { /* toast shown by the store; keep the modal open */ }
  };
  const remove = async (s) => {
    if (!window.confirm(`Remove "${s.name}"? Sessions and registers are not deleted — they just stop being grouped under this semester.`)) return;
    // If the semester being deleted is the one in view, fall back to All.
    if (store.semesterId === s.id) store.setSemesterId("");
    await store.removeSemester(s.id);
  };

  const invalid = !form.name.trim() || !form.start || !form.end || form.end < form.start;
  const today = todayISO();

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-xs text-slate-500">
          A semester is just a date range. Any session dated inside it counts toward that semester automatically —
          there's nothing to tag by hand. Ranges can't overlap, so every session belongs to exactly one semester.
        </p>
        <PrimaryBtn onClick={openAdd}><Plus size={16} /> Add semester</PrimaryBtn>
      </div>

      {store.unassignedSessions > 0 && store.semesters.length > 0 && (
        <div className="mb-4 flex items-start gap-2.5 rounded-xl bg-amber-50 px-3.5 py-3 text-xs ring-1 ring-amber-200 fade-up">
          <AlertCircle size={15} className="mt-0.5 shrink-0 text-amber-600" />
          <div>
            <p className="font-bold text-amber-800">{store.unassignedSessions} session{store.unassignedSessions === 1 ? "" : "s"} fall outside every semester</p>
            <p className="mt-0.5 text-amber-700">
              They still count in the “All semesters” view, but they won't appear under any semester until a date range covers them.
              Pick <span className="font-semibold">Outside any semester</span> in the semester picker to see which ones.
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {store.semesters.map((s, i) => {
          const current = today >= s.start && today <= s.end;
          return (
            <Card key={s.id} className="fade-up" style={{ animationDelay: `${i * 50}ms` }}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl text-white shadow-sm" style={{ background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` }}><CalendarDays size={18} /></span>
                  <div>
                    <p className="flex items-center gap-1.5 text-sm font-extrabold" style={{ color: NAVY_DARK }}>
                      {s.name}
                      {current && <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700">CURRENT</span>}
                    </p>
                    <p className="text-[11px] text-slate-400">{fmtDate(s.start)} → {fmtDate(s.end)}</p>
                  </div>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => openEdit(s)} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"><Edit3 size={14} /></button>
                  <button onClick={() => remove(s)} className="rounded-lg p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"><Trash2 size={14} /></button>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                <span className="text-[11px] font-semibold text-slate-500">{s.sessionCount} session{s.sessionCount === 1 ? "" : "s"}</span>
                <button onClick={() => store.setSemesterId(s.id)} className="press text-[11px] font-bold transition hover:underline" style={{ color: NAVY }}>View attendance →</button>
              </div>
            </Card>
          );
        })}
        {store.semesters.length === 0 && (
          <div className="sm:col-span-2 lg:col-span-3">
            <Card><EmptyState Icon={CalendarDays} title="No semesters yet"
              msg="Add your first teaching period — e.g. “Semester 2” from 01 Feb to 30 Jun — and attendance can then be reported per semester." /></Card>
          </div>
        )}
      </div>

      <Modal open={modal} onClose={() => setModal(false)} title={edit ? "Edit semester" : "Add semester"}>
        <div className="space-y-3">
          <Field label="Name"><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Semester 2" className={inputCls} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start date"><input type="date" value={form.start} onChange={e => setForm(f => ({ ...f, start: e.target.value }))} className={inputCls} /></Field>
            <Field label="End date"><input type="date" value={form.end} onChange={e => setForm(f => ({ ...f, end: e.target.value }))} className={inputCls} /></Field>
          </div>
          {form.start && form.end && form.end < form.start && (
            <p className="text-[11px] font-semibold text-rose-600">The end date must be on or after the start date.</p>
          )}
          <p className="text-[11px] text-slate-400">Both dates are inclusive. Sessions dated inside this range count toward this semester automatically.</p>
          <PrimaryBtn onClick={save} disabled={invalid} className="w-full"><Save size={16} /> {edit ? "Save changes" : "Add semester"}</PrimaryBtn>
        </div>
      </Modal>
    </>
  );
}

/* ----- Dashboard: Settings (staff management) ----- */
/* ============================================================
   Dashboard: Assessments — a gradebook. Define assessments per
   course, enter student marks, and see grades & averages per
   course, per student and overall.
   ============================================================ */
const ASSESS_TYPES = ["Assignment", "Exam", "Presentation", "Project", "Portfolio"];
// The college's grade boundaries: 70+ Distinction, 60-69 Merit, 50-59 Pass, below
// 50 Fail. The same boundaries live in the server's routes/assessments.js and
// routes/student.js — a mark must never band differently on the two sides.
const bandOf = (pct) => (pct == null ? null : pct >= 70 ? "Distinction" : pct >= 60 ? "Merit" : pct >= PASS_MARK ? "Pass" : "Fail");
const gradeTone = (band) =>
  band === "Distinction" ? { bg: "bg-emerald-100", text: "text-emerald-700", colour: "#059669" }
    : band === "Merit" ? { bg: "bg-blue-100", text: "text-blue-700", colour: "#2563eb" }
      : band === "Pass" ? { bg: "bg-amber-100", text: "text-amber-700", colour: "#b45309" }
        : band === "Fail" ? { bg: "bg-rose-100", text: "text-rose-700", colour: MAROON }
          : { bg: "bg-slate-100", text: "text-slate-400", colour: "#94a3b8" };
const GRADE_BANDS = ["Distinction", "Merit", "Pass", "Fail"];

// A stacked distribution bar for Distinction/Merit/Pass/Fail counts.
function DistBar({ dist, className = "" }) {
  const total = GRADE_BANDS.reduce((a, b) => a + (dist?.[b] || 0), 0);
  if (!total) return <span className="text-[11px] text-slate-300">no grades</span>;
  return (
    <div className={`flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100 ${className}`} title={GRADE_BANDS.map(b => `${b}: ${dist[b] || 0}`).join(" · ")}>
      {GRADE_BANDS.map(b => (dist[b] ? <div key={b} style={{ width: `${(dist[b] / total) * 100}%`, background: gradeTone(b).colour }} /> : null))}
    </div>
  );
}

// Aggregates the gradebook overview (which is per UNIT) up to course level, so the
// Courses gallery can show assessment figures without another endpoint. Averages are
// re-derived from graded counts so a unit with 40 marks outweighs one with 2 — a plain
// mean of unit averages would misreport the course.
function courseAssessmentStats(store) {
  const perUnit = store.assessmentOverview?.units || [];
  const unitById = Object.fromEntries(store.units.map(u => [u.id, u]));
  const acc = new Map();
  for (const u of perUnit) {
    const courseId = unitById[u.id]?.courseId || "__none__";
    const a = acc.get(courseId) || { units: 0, assessments: 0, graded: 0, sum: 0, dist: { Distinction: 0, Merit: 0, Pass: 0, Fail: 0 } };
    a.units += 1;
    a.assessments += u.assessmentCount || 0;
    a.graded += u.gradedCount || 0;
    if (u.avgPct != null && u.gradedCount) a.sum += u.avgPct * u.gradedCount;
    for (const k of Object.keys(a.dist)) a.dist[k] += u.dist?.[k] || 0;
    acc.set(courseId, a);
  }
  const out = {};
  for (const [courseId, a] of acc) {
    const passed = a.dist.Distinction + a.dist.Merit + a.dist.Pass;
    out[courseId] = {
      ...a,
      avgPct: a.graded ? Math.round((a.sum / a.graded) * 10) / 10 : null,
      passRate: a.graded ? Math.round((passed / a.graded) * 1000) / 10 : null,
    };
  }
  return out;
}

function AdminAssessments({ store }) {
  const { refreshHnd, refreshAssessments, assessmentsLoaded } = store;
  // Mirrors the Registers section: Courses → Units → Marks, plus Results % and
  // Students. Courses, units and students are the SAME records the registers use —
  // create them once under Registers and they appear here automatically.
  const [view, setView] = useState("courses"); // courses | units | marks | results | students
  const [courseFilter, setCourseFilter] = useState("");  // "" = all courses
  const [unitId, setUnitId] = useState("");              // unit whose marks are open
  const [openGrades, setOpenGrades] = useState(null);    // assessment being graded
  useEffect(() => { refreshHnd(); refreshAssessments(); }, [refreshHnd, refreshAssessments]);

  if (!assessmentsLoaded) {
    return (<><AdminHeader title="Assessments" subtitle="Loading the gradebook…" Icon={Award} /><div className="space-y-3">{[0, 1, 2].map(i => <div key={i} className="skeleton h-16 rounded-2xl" />)}</div></>);
  }
  if (openGrades) return <GradeEntry store={store} assessment={openGrades} onBack={() => setOpenGrades(null)} />;

  const tabs = [
    { key: "courses", label: "Courses", I: Layers },
    { key: "units", label: "Units", I: GraduationCap },
    { key: "marks", label: "Marks", I: ClipboardList },
    { key: "results", label: "Results %", I: Percent },
    { key: "students", label: "Students", I: Users },
  ];
  const openUnit = (id) => { setUnitId(id); setView("marks"); };
  return (
    <>
      <AdminHeader title="Assessments" subtitle="Marks, grades and averages across every course and unit" Icon={Award}
        action={<button onClick={() => refreshAssessments()} className="press flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50"><RefreshCw size={14} /> Refresh</button>} />
      <div className="mb-4 flex flex-wrap gap-1.5">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setView(t.key)} className={`press flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-bold shadow-sm transition-all ${view === t.key ? "text-white" : "bg-white text-slate-500 hover:bg-slate-50"}`} style={view === t.key ? { background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` } : {}}><t.I size={14} /> {t.label}</button>
        ))}
      </div>
      {view === "courses" && <AssessmentCourses store={store} onView={(id) => { setCourseFilter(id); setView("units"); }} />}
      {view === "units" && <>
        {courseFilter && <BackTo label="courses" onClick={() => { setCourseFilter(""); setView("courses"); }} />}
        <AssessmentUnits store={store} courseFilter={courseFilter} setCourseFilter={setCourseFilter} onView={openUnit} />
      </>}
      {view === "marks" && <>
        <BackTo label="units" onClick={() => setView("units")} />
        <AssessmentsManage store={store} unitId={unitId} setUnitId={setUnitId} courseFilter={courseFilter} onGrade={setOpenGrades} />
      </>}
      {view === "results" && <AssessmentsOverview store={store} />}
      {view === "students" && <StudentAssessments store={store} />}
    </>
  );
}

/* ----- Assessments ▸ Courses: the same courses as Registers, read-only ----- */
// Courses are created and edited under Registers; this gallery only reads them, so
// there is one place they can be changed and the two sections can never drift apart.
function AssessmentCourses({ store, onView }) {
  const stats = courseAssessmentStats(store);
  const unitsOf = (id) => store.units.filter(u => u.courseId === id);
  if (!store.courses.length) {
    return <Card><EmptyState Icon={Layers} title="No courses yet" msg="Courses are set up under Registers — add one there and it appears here automatically." /></Card>;
  }
  return (
    <>
      <p className="mb-3 text-[11px] text-slate-500">These are the same courses as the Registers section — add or edit them there and they update here automatically. Open a course to mark its units.</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {store.courses.map((c, i) => {
          const st = stats[c.id] || { units: 0, assessments: 0, graded: 0, avgPct: null, passRate: null };
          const tone = pctTone(st.avgPct);
          const seed = hashStr(c.name);
          return (
            <div key={c.id} className="fade-up flex flex-col overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md" style={{ animationDelay: `${i * 45}ms` }}>
              <div className="relative h-24">
                <CoursePattern seed={seed} colour={c.colour || courseColour(seed)} />
                <span className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-md bg-white/95 px-2.5 py-1 text-xs font-extrabold text-slate-800 shadow-sm"><Layers size={12} /> Course</span>
              </div>
              <div className="p-4">
                <p className="truncate text-sm font-extrabold" style={{ color: NAVY_DARK }} title={c.name}>{c.name}</p>
                <p className="mt-0.5 text-xs font-semibold text-slate-400">{unitsOf(c.id).length} unit{unitsOf(c.id).length === 1 ? "" : "s"} · {st.assessments} assessment{st.assessments === 1 ? "" : "s"}</p>
                <div className="mt-3 grid grid-cols-3 gap-1.5 text-center">
                  <div className="rounded-lg bg-slate-50 py-1.5"><p className="text-sm font-extrabold tabular-nums text-slate-700">{st.graded}</p><p className="text-[9px] uppercase tracking-wide text-slate-400">Marks</p></div>
                  <div className={`rounded-lg py-1.5 ${tone.bg}`}><p className={`text-sm font-extrabold tabular-nums ${tone.text}`}>{fmtPct(st.avgPct)}</p><p className="text-[9px] uppercase tracking-wide text-slate-400">Average</p></div>
                  <div className="rounded-lg bg-slate-50 py-1.5"><p className="text-sm font-extrabold tabular-nums" style={{ color: pctColour(st.passRate) }}>{fmtPct(st.passRate)}</p><p className="text-[9px] uppercase tracking-wide text-slate-400">Marks 50%+</p></div>
                </div>
                <button onClick={() => onView(c.id)} className="press mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border-2 border-slate-200 py-2 text-xs font-bold transition hover:border-indigo-300 hover:bg-indigo-50" style={{ color: NAVY }}>View units <ArrowRight size={15} /></button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ----- Assessments ▸ Units: the same units as Registers, read-only ----- */
function AssessmentUnits({ store, courseFilter, setCourseFilter, onView }) {
  const [query, setQuery] = useState("");
  const [yearFilter, setYearFilter] = useState("");
  const [termFilter, setTermFilter] = useState("");
  const perUnit = Object.fromEntries((store.assessmentOverview?.units || []).map(u => [u.id, u]));
  const ql = query.trim().toLowerCase();
  const inCourse = store.units.filter(u => {
    if (courseFilter === "none" && u.courseId) return false;
    if (courseFilter && courseFilter !== "none" && u.courseId !== courseFilter) return false;
    return true;
  });
  const list = inCourse
    .filter(u => matchesPlace(u, yearFilter, termFilter))
    .filter(u => !ql || u.code.toLowerCase().includes(ql) || u.name.toLowerCase().includes(ql))
    .sort((a, b) => placeKey(a) - placeKey(b) || (Number(a.unitNumber) || 999) - (Number(b.unitNumber) || 999) || a.code.localeCompare(b.code));
  const courseById = Object.fromEntries(store.courses.map(c => [c.id, c]));
  const pills = [{ v: "", l: "All courses" }, ...store.courses.map(c => ({ v: c.id, l: c.name })), ...(store.units.some(u => !u.courseId) ? [{ v: "none", l: "No course" }] : [])];
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {pills.map(p => (
            <button key={p.v} onClick={() => { setCourseFilter(p.v); setYearFilter(""); setTermFilter(""); }} className={`press rounded-full px-3 py-1.5 text-xs font-bold shadow-sm transition ${courseFilter === p.v ? "text-white" : "bg-white text-slate-500 hover:bg-slate-50"}`} style={courseFilter === p.v ? { background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` } : {}}>{p.l}</button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200"><Search size={15} className="text-slate-400" /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search units…" className="w-40 bg-transparent text-sm outline-none sm:w-56" /></div>
      </div>
      <PlaceFilter units={inCourse} year={yearFilter} setYear={setYearFilter} term={termFilter} setTerm={setTermFilter} className="mb-4" />
      <p className="mb-3 text-[11px] text-slate-500">Units come from the Registers section — add or edit them there. Open one to define its assessments and enter marks.</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((u, i) => {
          const st = perUnit[u.id] || { assessmentCount: 0, gradedCount: 0, avgPct: null };
          const tone = pctTone(st.avgPct);
          const course = courseById[u.courseId];
          return (
            <Card key={u.id} className="fade-up" style={{ animationDelay: `${i * 40}ms` }}>
              <div className="flex items-start gap-2.5">
                <span className="flex h-9 w-12 shrink-0 items-center justify-center rounded-lg text-[10px] font-extrabold text-white" style={{ background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` }}>{u.code.slice(0, 5)}</span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-extrabold" style={{ color: NAVY_DARK }} title={u.name}>{u.name}</p>
                  <UnitFacts unit={u} className="mt-1" />
                  <p className="truncate text-[11px] text-slate-400">
                    {isPlaced(u) && <span className="mr-1 rounded px-1 py-0.5 text-[10px] font-bold" style={{ background: `${NAVY}14`, color: NAVY }}>{placeShort(u)}</span>}
                    {u.unitNumber ? `Unit ${u.unitNumber} · ` : ""}{course ? course.name : "No course"} · {u.studentCount ?? 0} students
                  </p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-1.5 text-center">
                <div className="rounded-lg bg-slate-50 py-1.5"><p className="text-sm font-extrabold tabular-nums text-slate-700">{st.assessmentCount || 0}</p><p className="text-[9px] uppercase tracking-wide text-slate-400">Assessments</p></div>
                <div className="rounded-lg bg-slate-50 py-1.5"><p className="text-sm font-extrabold tabular-nums text-slate-700">{st.gradedCount || 0}</p><p className="text-[9px] uppercase tracking-wide text-slate-400">Marks</p></div>
                <div className={`rounded-lg py-1.5 ${tone.bg}`}><p className={`text-sm font-extrabold tabular-nums ${tone.text}`}>{fmtPct(st.avgPct)}</p><p className="text-[9px] uppercase tracking-wide text-slate-400">Average</p></div>
              </div>
              <button onClick={() => onView(u.id)} className="press mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border-2 border-slate-200 py-2 text-xs font-bold transition hover:border-indigo-300 hover:bg-indigo-50" style={{ color: NAVY }}><ClipboardList size={14} /> Marks &amp; assessments</button>
            </Card>
          );
        })}
        {list.length === 0 && (
          <div className="sm:col-span-2 lg:col-span-3">
            <Card><EmptyState Icon={BookOpen} title={store.units.length === 0 ? "No units yet" : "No units match"} msg={store.units.length === 0 ? "Units are set up under Registers — add one there and it appears here." : "Try a different course or search."} /></Card>
          </div>
        )}
      </div>
    </>
  );
}

/* ----- Overview: cards + per-course averages & distribution ----- */
function AssessmentsOverview({ store }) {
  const ov = store.assessmentOverview;
  const [query, setQuery] = useState("");
  if (!ov) return <div className="skeleton h-64 rounded-2xl" />;
  const o = ov.overall;
  const ql = query.trim().toLowerCase();
  const rows = ov.units.filter(m => !ql || m.code.toLowerCase().includes(ql) || m.name.toLowerCase().includes(ql));
  const exportCSV = () => {
    downloadCSV("assessment-averages.csv", [
      { key: "code", label: "Unit code" }, { key: "name", label: "Unit" }, { key: "students", label: "Students" },
      { key: "assessments", label: "Assessments" }, { key: "graded", label: "Graded" }, { key: "avg", label: "Average %" },
      ...GRADE_BANDS.map(b => ({ key: b, label: b })),
    ], ov.units.map(m => ({ code: m.code, name: m.name, students: m.students, assessments: m.assessmentCount, graded: m.gradedCount, avg: m.avgPct ?? "", ...Object.fromEntries(GRADE_BANDS.map(b => [b, m.dist[b] || 0])) })));
    store.notify("Exported averages CSV");
  };
  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Assessments" value={o.assessments} sub="defined across units" Icon={ClipboardList} tone={NAVY} delay={0} animate />
        <StatCard label="Average mark" value={fmtPct(o.avgPct)} sub="across all grades" Icon={Percent} tone={pctTone(o.avgPct).colour} delay={60} animate />
        <StatCard label="Marks at 50%+" value={fmtPct(o.passRate)} sub="share of graded submissions" Icon={Award} tone={pctTone(o.passRate).colour} delay={120} animate />
        <StatCard label="Grades entered" value={o.gradedSubmissions} sub="marked submissions" Icon={CheckCircle2} tone="#0d7a5f" delay={180} animate />
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200"><Search size={15} className="text-slate-400" /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search course…" className="w-44 bg-transparent text-sm outline-none sm:w-56" /></div>
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden items-center gap-2 text-[11px] font-semibold text-slate-400 sm:flex">
            {GRADE_BANDS.map(b => <span key={b} className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: gradeTone(b).colour }} />{b}</span>)}
          </span>
          <ExportBtn onClick={exportCSV} label="Export" />
        </div>
      </div>
      <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 fade-up">
        <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-400">
              <tr><th className="px-5 py-3">Unit</th><th className="px-5 py-3 text-center whitespace-nowrap">Students</th><th className="px-5 py-3 text-center whitespace-nowrap">Assessments</th><th className="px-5 py-3 text-center whitespace-nowrap">Graded</th><th className="px-5 py-3 whitespace-nowrap">Grade spread</th><th className="px-5 py-3 text-center whitespace-nowrap">Average</th></tr>
            </thead>
            <tbody>
              {rows.map(m => (
                <tr key={m.id} className="border-t border-slate-100 transition-colors hover:bg-blue-50/30">
                  <td className="px-5 py-3"><div className="flex items-center gap-2.5"><span className="flex h-8 w-11 shrink-0 items-center justify-center rounded-lg text-[10px] font-extrabold text-white" style={{ background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` }}>{m.code.slice(0, 5)}</span><span className="min-w-0"><p className="truncate font-semibold text-slate-700" title={m.name}>{m.name}</p></span></div></td>
                  <td className="px-5 py-3 text-center tabular-nums text-slate-600">{m.students}</td>
                  <td className="px-5 py-3 text-center tabular-nums text-slate-600">{m.assessmentCount}</td>
                  <td className="px-5 py-3 text-center tabular-nums text-slate-500">{m.gradedCount}</td>
                  <td className="px-5 py-3"><div className="min-w-[120px]"><DistBar dist={m.dist} /></div></td>
                  <td className="px-5 py-3 text-center"><span className={`rounded-lg px-2 py-1 text-xs font-extrabold tabular-nums ${pctTone(m.avgPct).bg} ${pctTone(m.avgPct).text}`}>{fmtPct(m.avgPct)}</span></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} className="px-5 py-10"><EmptyState Icon={Award} title="No units" msg="Add units and assessments to see averages here." /></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ----- Manage assessments per course + open grade entry ----- */
function AssessmentsManage({ store, onGrade, unitId, setUnitId, courseFilter = "" }) {
  const [modal, setModal] = useState(false);
  const [edit, setEdit] = useState(null);
  const [form, setForm] = useState({ title: "", type: "Assignment", maxMarks: 100, weight: 0, dueDate: "" });
  // Switchable views for one unit: the assessment cards, the whole student × assessment
  // grid, or the flat searchable record list across every unit.
  const [mode, setMode] = useState("list"); // list | grid | records

  // The unit picker only offers units from the course drilled into (all units when no
  // course is selected), so this tab stays in step with Courses → Units.
  const pickable = courseFilter && courseFilter !== "none"
    ? store.units.filter(u => u.courseId === courseFilter)
    : courseFilter === "none" ? store.units.filter(u => !u.courseId) : store.units;

  useEffect(() => {
    if (!pickable.length) { if (unitId) setUnitId(""); return; }
    if (!unitId || !pickable.some(m => m.id === unitId)) setUnitId(pickable[0].id);
  }, [pickable, unitId, setUnitId]);

  const selected = store.units.find(m => m.id === unitId) || null;
  const list = store.assessments.filter(a => a.unitId === unitId);
  const courseOf = store.courses.find(c => c.id === selected?.courseId) || null;

  const openAdd = () => { setEdit(null); setForm({ title: "", type: "Assignment", maxMarks: 100, weight: 0, dueDate: "" }); setModal(true); };
  const openEdit = (a) => { setEdit(a); setForm({ title: a.title, type: a.type, maxMarks: a.maxMarks, weight: a.weight, dueDate: a.dueDate || "" }); setModal(true); };
  const save = async () => {
    try {
      const data = { ...form, maxMarks: Number(form.maxMarks), weight: Number(form.weight) };
      if (edit) await store.updateAssessment(edit.id, data);
      else await store.addAssessment({ ...data, unitId });
      setModal(false);
    } catch (_e) { /* toast shown by store */ }
  };
  const remove = async (a) => {
    if (!window.confirm(`Delete "${a.title}"?\n\n${a.gradedCount || 0} grade${(a.gradedCount || 0) === 1 ? "" : "s"} will be deleted too. This cannot be undone.`)) return;
    await store.removeAssessment(a.id);
  };

  if (!store.units.length) return <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200/70"><EmptyState Icon={BookOpen} title="No units yet" msg="Add a unit first, then define its assessments." /></div>;

  return (
    <>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {pickable.map(m => (
          <button key={m.id} onClick={() => setUnitId(m.id)} className={`press rounded-xl px-3.5 py-2 text-left text-xs font-bold shadow-sm ring-1 transition-all ${unitId === m.id ? "text-white ring-transparent" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50"}`} style={unitId === m.id ? { background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` } : {}}>{m.code}</button>
        ))}
      </div>
      {selected && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-lg font-extrabold" style={{ color: NAVY_DARK }}>{selected.name}</p>
            <p className="text-xs text-slate-400">{selected.unitNumber ? `Unit ${selected.unitNumber} · ` : ""}{selected.code}{courseOf ? ` · ${courseOf.name}` : ""} · {selected.studentCount ?? 0} students</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Switchable views for the same unit. */}
            <div className="flex gap-1 rounded-xl bg-white p-1 ring-1 ring-slate-200">
              {[{ k: "list", l: "Assessments" }, { k: "grid", l: "Grid" }, { k: "records", l: "All records" }].map(v => (
                <button key={v.k} onClick={() => setMode(v.k)} className={`press rounded-lg px-2.5 py-1.5 text-xs font-bold transition ${mode === v.k ? "text-white" : "text-slate-500 hover:bg-slate-100"}`} style={mode === v.k ? { background: NAVY } : {}}>{v.l}</button>
              ))}
            </div>
            {mode !== "records" && <PrimaryBtn onClick={openAdd}><Plus size={16} /> Add assessment</PrimaryBtn>}
          </div>
        </div>
      )}
      {mode === "records" && <AssessmentRecords store={store} />}
      {mode === "grid" && selected && <UnitGradeGrid store={store} unit={selected} assessments={list} />}
      <div className={`grid gap-3 sm:grid-cols-2 lg:grid-cols-3 ${mode === "list" ? "" : "hidden"}`}>
        {list.map((a, i) => {
          const tone = pctTone(a.avgPct);
          return (
            <Card key={a.id} className="fade-up" style={{ animationDelay: `${i * 40}ms` }}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0"><p className="truncate text-sm font-extrabold" style={{ color: NAVY_DARK }} title={a.title}>{a.title}</p><p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400"><span className="rounded bg-slate-100 px-1.5 py-0.5 font-bold text-slate-500">{a.type}</span>· out of {a.maxMarks}{a.weight ? ` · ${a.weight}%` : ""}{a.dueDate ? ` · due ${fmtDate(a.dueDate)}` : ""}</p></div>
                <div className="flex gap-1"><button onClick={() => openEdit(a)} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"><Edit3 size={14} /></button><button onClick={() => remove(a)} className="rounded-lg p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"><Trash2 size={14} /></button></div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-1.5 text-center">
                <div className="rounded-lg bg-slate-50 py-1.5"><p className="text-sm font-extrabold text-slate-700 tabular-nums">{a.gradedCount || 0}<span className="text-[10px] font-medium text-slate-400">/{selected?.studentCount ?? 0}</span></p><p className="text-[9px] uppercase tracking-wide text-slate-400">Graded</p></div>
                <div className={`rounded-lg py-1.5 ${tone.bg}`}><p className={`text-sm font-extrabold tabular-nums ${tone.text}`}>{fmtPct(a.avgPct)}</p><p className="text-[9px] uppercase tracking-wide text-slate-400">Average</p></div>
              </div>
              <button onClick={() => onGrade(a)} className="press mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border-2 border-slate-200 py-2 text-xs font-bold transition hover:border-indigo-300 hover:bg-indigo-50" style={{ color: NAVY }}><ClipboardList size={14} /> Enter grades</button>
            </Card>
          );
        })}
        {list.length === 0 && <div className="sm:col-span-2 lg:col-span-3"><Card><EmptyState Icon={ClipboardList} title="No assessments for this unit" msg="Add an assessment, then enter students' marks." /></Card></div>}
      </div>

      <Modal open={modal} onClose={() => setModal(false)} title={edit ? "Edit assessment" : "Add assessment"}>
        <div className="space-y-3">
          <Field label="Title"><input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="e.g. Assignment 1" className={inputCls} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type"><select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} className={inputCls}>{ASSESS_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></Field>
            <Field label="Max marks"><input type="number" min={1} max={1000} value={form.maxMarks} onChange={e => setForm(f => ({ ...f, maxMarks: e.target.value }))} className={inputCls} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Weight (%)"><input type="number" min={0} max={100} value={form.weight} onChange={e => setForm(f => ({ ...f, weight: e.target.value }))} className={inputCls} /></Field>
            <Field label="Due date"><input type="date" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))} className={inputCls} /></Field>
          </div>
          <PrimaryBtn onClick={save} disabled={!form.title.trim() || !(Number(form.maxMarks) >= 1)} className="w-full"><Save size={16} /> {edit ? "Save changes" : "Add assessment"}</PrimaryBtn>
        </div>
      </Modal>
    </>
  );
}

/* ----- One unit's whole gradebook as a student × assessment grid ----- */
// The alternative to marking one assessment at a time: every enrolled student down the
// side, every assessment across the top, marks editable in place. Edits are collected
// and saved per assessment (the API takes one assessment's grades at a time).
function UnitGradeGrid({ store, unit, assessments }) {
  const [rows, setRows] = useState(null);      // { [studentId]: { [assessmentId]: "marks" } }
  const [students, setStudents] = useState([]);
  const [dirty, setDirty] = useState({});      // { [assessmentId]: { [studentId]: "marks" } }
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setDirty({});
    try {
      const res = await api.listGrades({ unitId: unit.id });
      const byStudent = {};
      for (const r of res.records || []) {
        (byStudent[r.studentId] = byStudent[r.studentId] || {})[r.assessmentId] = String(r.marks);
      }
      setRows(byStudent);
      // Enrolled students, in the same order the registers use.
      setStudents(store.students.filter(s => (s.unitIds || []).includes(unit.id)));
    } catch (e) { store.notify?.(e.message || "Could not load the grid", "error"); }
    finally { setLoading(false); }
  }, [unit.id, store]);
  useEffect(() => { load(); }, [load]);

  const setCell = (studentId, a, v) => {
    if (v !== "" && !/^\d{1,4}$/.test(v)) return;          // whole numbers only, like the server
    setDirty(d => ({ ...d, [a.id]: { ...(d[a.id] || {}), [studentId]: v } }));
  };
  const valueOf = (studentId, a) => {
    const pending = dirty[a.id]?.[studentId];
    if (pending !== undefined) return pending;
    return rows?.[studentId]?.[a.id] ?? "";
  };
  const overMax = assessments.some(a => Object.values(dirty[a.id] || {}).some(v => v !== "" && Number(v) > a.maxMarks));
  const changeCount = Object.values(dirty).reduce((n, m) => n + Object.keys(m).length, 0);

  const save = async () => {
    setBusy(true);
    try {
      // One request per assessment, sending only the students actually edited — the
      // endpoint upserts/clears just those, so untouched marks are never disturbed.
      for (const [assessmentId, byStudent] of Object.entries(dirty)) {
        const grades = Object.entries(byStudent).map(([studentId, marks]) => ({ studentId, marks: marks === "" ? null : Number(marks) }));
        if (grades.length) await store.saveGrades(assessmentId, grades);
      }
      await load();
    } catch (_e) { /* store toasts; keep the edits so nothing is lost */ }
    finally { setBusy(false); }
  };

  if (loading) return <div className="skeleton h-64 rounded-2xl" />;
  if (!assessments.length) return <Card><EmptyState Icon={ClipboardList} title="No assessments for this unit" msg="Add an assessment first, then marks can be entered here." /></Card>;
  if (!students.length) return <Card><EmptyState Icon={Users} title="No students enrolled" msg="Enrol students onto this unit under Registers, then their marks appear here." /></Card>;

  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 fade-up">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <p className="text-xs font-bold text-slate-500">{students.length} student{students.length === 1 ? "" : "s"} × {assessments.length} assessment{assessments.length === 1 ? "" : "s"}</p>
        <div className="flex items-center gap-2">
          {overMax && <span className="text-[11px] font-semibold text-rose-600">A mark is above its maximum</span>}
          {changeCount > 0 && <span className="text-[11px] font-semibold text-amber-600">{changeCount} unsaved</span>}
          <PrimaryBtn onClick={save} disabled={busy || overMax || changeCount === 0}><Save size={15} /> {busy ? "Saving…" : "Save marks"}</PrimaryBtn>
        </div>
      </div>
      <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-400">
            <tr>
              <th className="sticky left-0 z-10 bg-slate-50 px-4 py-3">Student</th>
              {assessments.map(a => <th key={a.id} className="px-3 py-3 text-center whitespace-nowrap" title={`${a.type} · out of ${a.maxMarks}`}>{a.title}<span className="ml-1 font-normal text-slate-300">/{a.maxMarks}</span></th>)}
              <th className="px-3 py-3 text-center">Average</th>
            </tr>
          </thead>
          <tbody>
            {students.map(s => {
              // Live average across whatever is currently in the row, pending edits included.
              const pcts = assessments.map(a => { const v = valueOf(s.id, a); return v === "" ? null : Math.min(100, (Number(v) / a.maxMarks) * 100); }).filter(v => v !== null);
              const avg = pcts.length ? Math.round((pcts.reduce((x, y) => x + y, 0) / pcts.length) * 10) / 10 : null;
              const tone = pctTone(avg);
              return (
                <tr key={s.id} className="border-t border-slate-100 hover:bg-blue-50/30">
                  <td className="sticky left-0 z-10 bg-white px-4 py-2">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ background: s.colour }}>{s.initials}</span>
                      <div className="min-w-0"><p className="truncate text-xs font-semibold text-slate-700">{s.name}</p><p className="text-[10px] tabular-nums text-slate-400">{s.studentRef}</p></div>
                    </div>
                  </td>
                  {assessments.map(a => {
                    const v = valueOf(s.id, a);
                    const bad = v !== "" && Number(v) > a.maxMarks;
                    const edited = dirty[a.id]?.[s.id] !== undefined;
                    return (
                      <td key={a.id} className="px-3 py-2 text-center">
                        <input value={v} onChange={e => setCell(s.id, a, e.target.value)} inputMode="numeric" placeholder="—"
                          className={`w-16 rounded-lg border-2 px-2 py-1 text-center text-xs font-bold tabular-nums outline-none transition ${bad ? "border-rose-300 bg-rose-50 text-rose-700" : edited ? "border-amber-300 bg-amber-50" : "border-slate-200 focus:border-blue-400"}`} />
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-center"><span className={`rounded-lg px-2 py-1 text-xs font-extrabold tabular-nums ${tone.bg} ${tone.text}`}>{fmtPct(avg)}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-3 text-[11px] text-slate-400">Type a mark to change it, or clear the box to remove it. Nothing is saved until you press <b>Save marks</b>. Grades: 70%+ Distinction · 60–69 Merit · 50–59 Pass · below 50 Fail.</p>
    </div>
  );
}

/* ----- Grade entry for one assessment (all enrolled students) ----- */
function GradeEntry({ store, assessment, onBack }) {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({});
  const [saved, setSaved] = useState({});
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [loadError, setLoadError] = useState("");
  const load = useCallback(async () => {
    setLoadError("");
    try {
      const d = await store.getGrades(assessment.id);
      const snap = Object.fromEntries((d.rows || []).map(r => [r.student.id, r.marks == null ? "" : String(r.marks)]));
      setData(d); setDraft(snap); setSaved(snap);
    } catch (e) {
      setLoadError(e.message || "Could not load grades");
      store.notify?.(e.message || "Could not load grades", "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assessment.id]);
  useEffect(() => { load(); }, [load]);

  // EVERY hook must run on every render, so all of this is computed BEFORE the early
  // returns below. usePaged used to sit after them: on the first render `data` was null
  // so it never ran, then the fetch resolved and it did — React saw the hook count
  // change and threw "Rendered more hooks than during the previous render", which is
  // what crashed the whole app the moment this screen was opened.
  //
  // Response shapes are tolerated either way: `unit` is current, `module` is what an
  // older API build sends.
  const a = data?.assessment || assessment || {};
  const mod = data?.unit || data?.module || {};
  const rows = data?.rows || [];
  const max = a.maxMarks || assessment.maxMarks || 100;
  const ql = query.trim().toLowerCase();
  const visible = rows.filter(r => !ql || r.student.name.toLowerCase().includes(ql) || r.student.studentRef.includes(ql));
  const paged = usePaged(visible, 25, `${assessment.id}|${ql}`);

  const setMark = (id, v) => { if (v === "" || /^\d{1,4}$/.test(v)) setDraft(d => ({ ...d, [id]: v })); };
  const dirty = rows.some(r => (draft[r.student.id] ?? "") !== (saved[r.student.id] ?? ""));
  const marked = rows.map(r => draft[r.student.id]).filter(v => v !== "" && v != null && !isNaN(Number(v))).map(Number);
  const avgMarks = marked.length ? Math.round(marked.reduce((x, y) => x + y, 0) / marked.length * 10) / 10 : null;
  // Clamped 0–100, matching the server's pctOf. Unclamped, a historic mark above its
  // assessment's current maximum printed 156% here while the API reported 100% for
  // the same mark — two different numbers for one grade on two screens.
  const avgPct = avgMarks != null ? clampPct(avgMarks, max) : null;
  const dist = { Distinction: 0, Merit: 0, Pass: 0, Fail: 0 };
  marked.forEach(m => { const b = bandOf(clampPct(m, max)); if (b) dist[b]++; });
  const overMax = marked.some(m => m > max);

  const save = async () => {
    setSaving(true);
    // ONLY the rows this marker actually changed — the same rule HndRegister and
    // UnitGradeGrid already follow, and for the same two reasons:
    //
    //  1. A blank box is sent as null, and null means DELETE server-side. Sending
    //     every row meant a tab opened before a colleague entered 12 marks carried
    //     nulls for all 12 and deleted them, reporting "Grades saved" in green.
    //  2. Every write stamps source:"manual", which the Moodle sync then refuses to
    //     touch for ever. Correcting one mark out of 30 permanently deafened the whole
    //     assessment to the VLE, so an exam-board rescale could never arrive.
    const changed = rows.filter(r => (draft[r.student.id] ?? "") !== (saved[r.student.id] ?? ""));
    if (!changed.length) { setSaving(false); return; }
    try { await store.saveGrades(assessment.id, changed.map(r => ({ studentId: r.student.id, marks: (draft[r.student.id] === "" || draft[r.student.id] == null) ? null : Number(draft[r.student.id]) }))); await load(); }
    catch (_e) { /* store toasted */ }
    setSaving(false);
  };

  // A failed load used to leave the skeleton up for ever with no way back.
  if (loadError) return (
    <>
      <div className="mb-4"><button onClick={onBack} className="press flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50"><ChevronLeft size={15} /> Back to assessments</button></div>
      <Card><EmptyState Icon={AlertCircle} title="Couldn't load these grades" msg={loadError} /><PrimaryBtn onClick={load} className="mx-auto mt-3"><RefreshCw size={15} /> Try again</PrimaryBtn></Card>
    </>
  );
  if (!data) return <><AdminHeader title="Grades" subtitle="Loading…" Icon={Award} /><div className="skeleton h-64 rounded-2xl" /></>;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 fade-up">
        <button onClick={onBack} className="press flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50"><ChevronLeft size={15} /> Back to assessments</button>
        {dirty && <span className="pop flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-700 ring-1 ring-amber-200"><AlertCircle size={13} /> Unsaved changes</span>}
      </div>
      <AdminHeader title={`${mod.code ? mod.code + " — " : ""}${a.title || "Assessment"}`} subtitle={`${a.type} · out of ${max}${a.weight ? ` · ${a.weight}%` : ""}${a.dueDate ? ` · due ${fmtDate(a.dueDate)}` : ""}`} Icon={Award}
        action={<PrimaryBtn onClick={save} disabled={!dirty || saving || overMax} colour={dirty && !overMax ? NAVY : "#94a3b8"}>{saving ? <><Loader size={16} /> Saving…</> : <><Save size={16} /> Save grades</>}</PrimaryBtn>} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-bold shadow-sm ring-1 ring-slate-200" style={{ color: pctTone(avgPct).colour }}><Percent size={13} /> Average {fmtPct(avgPct)}{avgMarks != null ? ` (${avgMarks}/${max})` : ""}</span>
        <span className="flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-bold text-slate-500 shadow-sm ring-1 ring-slate-200">{marked.length}/{rows.length} graded</span>
        {GRADE_BANDS.map(b => <span key={b} className="flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-bold shadow-sm ring-1 ring-slate-200" style={{ color: gradeTone(b).colour }}><span className="h-2 w-2 rounded-full" style={{ background: gradeTone(b).colour }} />{b} {dist[b]}</span>)}
        <div className="ml-auto flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200"><Search size={15} className="text-slate-400" /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search student…" className="bg-transparent text-sm outline-none" /></div>
      </div>
      {overMax && <div className="mb-3 flex items-center gap-2 rounded-xl bg-rose-50 px-3.5 py-2.5 text-xs font-semibold text-rose-700 ring-1 ring-rose-200"><AlertCircle size={14} /> Some marks exceed the maximum of {max}. Fix them before saving.</div>}

      <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 fade-up">
        <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3">Student</th><th className="px-5 py-3 whitespace-nowrap">Last updated</th><th className="px-5 py-3 whitespace-nowrap">Marks (/{max})</th><th className="px-5 py-3 text-center">%</th><th className="px-5 py-3 text-center">Grade</th></tr></thead>
            <tbody>
              {paged.slice.map(r => {
                const v = draft[r.student.id] ?? "";
                const num = v === "" ? null : Number(v);
                const pct = num == null ? null : clampPct(num, max);
                const band = bandOf(pct);
                const gt = gradeTone(band);
                const bad = num != null && num > max;
                return (
                  <tr key={r.student.id} className="border-t border-slate-100 transition-colors hover:bg-blue-50/30">
                    <td className="px-5 py-2.5"><div className="flex items-center gap-2.5"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-sm" style={{ background: r.student.colour }}>{r.student.initials}</span><div><p className="font-semibold" style={{ color: NAVY }}>{r.student.name}</p><p className="text-[11px] text-slate-400">{r.student.studentRef}{!r.enrolled && <span className="ml-1.5 rounded bg-slate-100 px-1 py-0.5 text-[9px] font-bold text-slate-500">NOT ENROLLED</span>}</p></div></div></td>
                    <td className="px-5 py-2.5 whitespace-nowrap">
                      {markStamp(r.gradedAt, r.gradedOn)
                        ? <><span className="text-[11px] font-semibold text-slate-500">{markStamp(r.gradedAt, r.gradedOn)}</span>
                            {r.source === "moodle" && <span className="ml-1.5 rounded bg-violet-50 px-1 py-0.5 text-[9px] font-bold text-violet-600 ring-1 ring-violet-100">MOODLE</span>}</>
                        : <span className="text-[11px] text-slate-300">—</span>}
                    </td>
                    <td className="px-5 py-2.5"><input inputMode="numeric" value={v} onChange={e => setMark(r.student.id, e.target.value)} placeholder="—" className={`w-24 rounded-lg border px-2.5 py-1.5 text-sm outline-none transition focus:ring-2 ${bad ? "border-rose-300 focus:border-rose-400 focus:ring-rose-100" : "border-slate-200 focus:border-blue-400 focus:ring-blue-100"}`} /></td>
                    <td className="px-5 py-2.5 text-center tabular-nums text-slate-500">{pct == null ? "—" : `${pct}%`}</td>
                    <td className="px-5 py-2.5 text-center">{band ? <span className={`rounded-lg px-2 py-1 text-[11px] font-extrabold ${gt.bg} ${gt.text}`}>{band}</span> : <span className="text-slate-300">—</span>}</td>
                  </tr>
                );
              })}
              {paged.slice.length === 0 && <tr><td colSpan={5} className="px-5 py-10"><EmptyState Icon={Users} title={rows.length === 0 ? "No students enrolled" : "No students match"} msg={rows.length === 0 ? "Enrol students onto this unit first." : "Try a different search."} /></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <Pagination className="mt-4" page={paged.page} setPage={paged.setPage} totalPages={paged.totalPages} total={paged.total} />
      <p className="mt-3 text-[11px] text-slate-400">Grades: 70%+ Distinction · 60–69 Merit · 50–59 Pass · below 50 Fail. Leave a mark blank to clear it.</p>
    </>
  );
}

/* ----- By student: a student's assessments, marks, grades & average ----- */
function StudentAssessments({ store }) {
  const [studentId, setStudentId] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!studentId) { setData(null); return; }
    let live = true; setLoading(true);
    store.studentAssessments(studentId).then(d => { if (live) setData(d); }).catch(e => store.notify?.(e.message || "Could not load", "error")).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [studentId, store]);

  const byUnit = {};
  (data?.assessments || []).forEach(a => { (byUnit[a.unitId] = byUnit[a.unitId] || { code: a.unitCode, name: a.unitName, items: [] }).items.push(a); });

  return (
    <>
      <div className="mb-4 max-w-md"><Field label="Choose a student"><StudentCombo students={store.students} value={studentId} onChange={setStudentId} /></Field></div>
      {!studentId && <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200/70"><EmptyState Icon={GraduationCap} title="Pick a student" msg="Search for a student above to see their assessments, marks, grades and average." /></div>}
      {studentId && loading && <div className="skeleton h-48 rounded-2xl" />}
      {studentId && data && !loading && (
        <>
          <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Assessments" value={data.count} sub="on their units" Icon={ClipboardList} tone={NAVY} delay={0} animate />
            <StatCard label="Graded" value={data.graded} sub={`${data.count - data.graded} outstanding`} Icon={CheckCircle2} tone="#0d7a5f" delay={60} animate />
            <StatCard label="Average mark" value={fmtPct(data.averagePct)} sub="across graded work" Icon={Percent} tone={pctTone(data.averagePct).colour} delay={120} animate />
            <StatCard label="Overall grade" value={data.averageGrade || "—"} sub="based on average" Icon={Award} tone={gradeTone(data.averageGrade).colour} delay={180} animate />
          </div>
          {Object.entries(byUnit).map(([mid, m]) => (
            <div key={mid} className="mb-4">
              <p className="mb-1.5 flex items-center gap-2 text-sm font-bold text-slate-700"><span className="flex h-6 w-9 items-center justify-center rounded text-[10px] font-extrabold text-white" style={{ background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` }}>{m.code.slice(0, 5)}</span>{m.name}</p>
              <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70">
                <table className="w-full text-sm">
                  <tbody>
                    {m.items.map((a, i) => { const gt = gradeTone(a.grade); return (
                      <tr key={a.id} className={`${i ? "border-t border-slate-100" : ""}`}>
                        <td className="px-5 py-2.5"><p className="font-semibold text-slate-700">{a.title}</p><p className="text-[11px] text-slate-400">{a.type}{a.weight ? ` · ${a.weight}%` : ""}</p></td>
                        <td className="px-5 py-2.5 text-right tabular-nums text-slate-600">{a.marks == null ? <span className="text-slate-300">not graded</span> : `${a.marks}/${a.maxMarks}`}</td>
                        <td className="px-5 py-2.5 text-right tabular-nums text-slate-500">{a.pct == null ? "" : `${a.pct}%`}</td>
                        <td className="px-5 py-2.5 text-right">{a.grade ? <span className={`rounded-lg px-2 py-1 text-[11px] font-extrabold ${gt.bg} ${gt.text}`}>{a.grade}</span> : <span className="text-slate-300">—</span>}</td>
                      </tr>
                    ); })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          {data.count === 0 && <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200/70"><EmptyState Icon={ClipboardList} title="No assessments" msg="This student's units don't have any assessments defined yet." /></div>}
        </>
      )}
    </>
  );
}

/* ----- Grade records: record-level CRUD (course → course → assessment → student → marks) ----- */
function AssessmentRecords({ store }) {
  const courseById = useMemo(() => Object.fromEntries(store.courses.map(p => [p.id, p])), [store.courses]);
  const [fCourse, setFCourse] = useState("");
  const [fUnit, setFUnit] = useState("");
  const [query, setQuery] = useState("");
  const [records, setRecords] = useState([]);
  const [meta, setMeta] = useState({ total: 0, capped: false });
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState(false);
  const [edit, setEdit] = useState(null);
  const [form, setForm] = useState({ courseId: "", unitId: "", assessmentId: "", studentId: "", marks: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!fCourse && store.courses.length) setFCourse(store.courses[0].id); }, [store.courses, fCourse]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = fUnit ? { unitId: fUnit } : fCourse ? { courseId: fCourse } : {};
      const res = await store.listGrades(params);
      // Endpoint returns { records, total, capped }. Tolerate an array too, for safety.
      const rows = Array.isArray(res) ? res : (res.records || []);
      setRecords(rows);
      setMeta({ total: Array.isArray(res) ? rows.length : (res.total ?? rows.length), capped: !Array.isArray(res) && !!res.capped });
    } catch (e) { store.notify?.(e.message || "Could not load records", "error"); }
    setLoading(false);
  }, [fCourse, fUnit, store]);
  useEffect(() => { load(); }, [load]);

  const coursesInProg = (pid) => store.units.filter(m => m.courseId === pid);
  const assessmentsInCourse = (mid) => store.assessments.filter(a => a.unitId === mid);
  const studentsInCourse = (mid) => store.students.filter(s => (s.unitIds || []).includes(mid));
  const selectedAssessment = store.assessments.find(a => a.id === form.assessmentId);
  const maxMarks = selectedAssessment?.maxMarks ?? 100;

  const openAdd = () => { setEdit(null); setForm({ courseId: fCourse || "", unitId: fUnit || "", assessmentId: "", studentId: "", marks: "" }); setModal(true); };
  const openEdit = (r) => { setEdit(r); setForm({ courseId: r.unit.courseId || "", unitId: r.unit.id, assessmentId: r.assessmentId, studentId: r.studentId, marks: String(r.marks) }); setModal(true); };
  const save = async () => {
    setBusy(true);
    try { await store.saveGrade(form.assessmentId, form.studentId, form.marks === "" ? null : Number(form.marks)); setModal(false); await load(); }
    catch (_e) { /* store toasted */ }
    setBusy(false);
  };
  const remove = async (r) => {
    if (!window.confirm(`Delete ${r.student.name}'s mark for ${r.unit.code} — ${r.assessment.title}? This cannot be undone.`)) return;
    await store.saveGrade(r.assessmentId, r.studentId, null); await load();
  };

  const ql = query.trim().toLowerCase();
  const list = records.filter(r => !ql || r.student.name.toLowerCase().includes(ql) || r.student.studentRef.includes(ql) || r.assessment.title.toLowerCase().includes(ql));
  const paged = usePaged(list, 15, `${fCourse}|${fUnit}|${ql}`);
  const editStudent = edit ? store.students.find(s => s.id === edit.studentId) || edit.student : null;
  const formValid = form.courseId && form.unitId && form.assessmentId && form.studentId && form.marks !== "" && Number(form.marks) >= 0 && Number(form.marks) <= maxMarks;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select value={fCourse} onChange={e => { setFCourse(e.target.value); setFUnit(""); }} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 outline-none">
          <option value="">All courses</option>
          {store.courses.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={fUnit} onChange={e => setFUnit(e.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 outline-none">
          <option value="">All units{fCourse ? " in course" : ""}</option>
          {(fCourse ? coursesInProg(fCourse) : store.units).map(m => <option key={m.id} value={m.id}>{m.code} — {m.name}</option>)}
        </select>
        <div className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200"><Search size={15} className="text-slate-400" /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search student or assessment…" className="w-40 bg-transparent text-sm outline-none sm:w-52" /></div>
        <PrimaryBtn className="ml-auto" onClick={openAdd}><Plus size={16} /> Add grade record</PrimaryBtn>
      </div>

      {meta.capped && (
        <div className="mb-3 flex items-start gap-2 rounded-xl bg-amber-50 px-3.5 py-2.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
          <AlertCircle size={15} className="mt-0.5 shrink-0 text-amber-600" />
          Showing the most recent <b>{records.length.toLocaleString()}</b> of <b>{meta.total.toLocaleString()}</b> records. Filter by course or unit to see the rest.
        </div>
      )}

      <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 fade-up">
        <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-400">
              <tr><th className="px-5 py-3">Student</th><th className="px-5 py-3">Course</th><th className="px-5 py-3">Unit</th><th className="px-5 py-3">Assessment</th><th className="px-5 py-3 whitespace-nowrap">Marks</th><th className="px-5 py-3 text-center">%</th><th className="px-5 py-3 text-center">Grade</th><th className="px-5 py-3 text-right">Actions</th></tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={8} className="px-5 py-10 text-center text-sm text-slate-400">Loading…</td></tr>}
              {!loading && paged.slice.map(r => { const gt = gradeTone(r.grade); const prog = courseById[r.unit.courseId]; return (
                <tr key={r.id} className="border-t border-slate-100 transition-colors hover:bg-blue-50/30">
                  <td className="px-5 py-3"><div className="flex items-center gap-2.5"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-sm" style={{ background: r.student.colour }}>{r.student.initials}</span><div className="min-w-0"><p className="font-semibold text-slate-700">{r.student.name}</p><p className="text-[11px] tabular-nums text-slate-400">{r.student.studentRef}</p></div></div></td>
                  <td className="px-5 py-3"><span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: (prog?.colour || "#64748b") + "1a", color: prog?.colour || "#64748b" }}>{prog?.name || "—"}</span></td>
                  <td className="px-5 py-3"><span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold text-slate-600" title={r.unit.name}>{r.unit.code}</span></td>
                  <td className="px-5 py-3 text-slate-600"><p className="font-medium">{r.assessment.title}</p><p className="text-[11px] text-slate-400">{r.assessment.type}</p></td>
                  <td className="px-5 py-3 font-bold tabular-nums text-slate-700">{r.marks}<span className="text-slate-300">/{r.assessment.maxMarks}</span></td>
                  <td className="px-5 py-3 text-center tabular-nums text-slate-500">{r.pct == null ? "—" : `${r.pct}%`}</td>
                  <td className="px-5 py-3 text-center">{r.grade ? <span className={`rounded-lg px-2 py-1 text-[11px] font-extrabold ${gt.bg} ${gt.text}`}>{r.grade}</span> : <span className="text-slate-300">—</span>}</td>
                  <td className="px-4 py-3"><div className="flex justify-end gap-1 whitespace-nowrap"><button onClick={() => openEdit(r)} title="Edit marks" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"><Edit3 size={15} /></button><button onClick={() => remove(r)} title="Delete record" className="rounded-lg p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"><Trash2 size={15} /></button></div></td>
                </tr>
              ); })}
              {!loading && paged.slice.length === 0 && <tr><td colSpan={8} className="px-5 py-10"><EmptyState Icon={ClipboardList} title="No grade records" msg="No marks recorded for this filter yet. Use “Add grade record” to enter one." /></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <Pagination className="mt-4" page={paged.page} setPage={paged.setPage} totalPages={paged.totalPages} total={paged.total} />
      <p className="mt-3 text-[11px] text-slate-400">{list.length.toLocaleString()} record{list.length === 1 ? "" : "s"}{query ? " matching" : ""}{fUnit ? " for this unit" : fCourse ? " for this course" : ""}{meta.capped ? ` (of ${meta.total.toLocaleString()} total — narrow the filter to load all)` : ""}. Grades: 70%+ Distinction · 60–69 Merit · 50–59 Pass · below 50 Fail.</p>

      <Modal open={modal} onClose={() => !busy && setModal(false)} title={edit ? "Edit grade record" : "Add grade record"} width={520}>
        <div className="space-y-3">
          {edit ? (
            <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
              <div className="flex items-center gap-2.5"><span className="flex h-9 w-9 items-center justify-center rounded-full text-[11px] font-bold text-white" style={{ background: editStudent?.colour }}>{editStudent?.initials}</span><div><p className="text-sm font-bold text-slate-700">{editStudent?.name}</p><p className="text-[11px] text-slate-400">{edit.unit.code} · {edit.assessment.title} · {courseById[edit.unit.courseId]?.name || ""}</p></div></div>
            </div>
          ) : (
            <>
              <Field label="Course"><select value={form.courseId} onChange={e => setForm(f => ({ ...f, courseId: e.target.value, unitId: "", assessmentId: "", studentId: "" }))} className={inputCls}><option value="">Choose…</option>{store.courses.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
              <Field label="Unit"><select value={form.unitId} onChange={e => setForm(f => ({ ...f, unitId: e.target.value, assessmentId: "", studentId: "" }))} disabled={!form.courseId} className={inputCls}><option value="">Choose…</option>{coursesInProg(form.courseId).map(m => <option key={m.id} value={m.id}>{m.code} — {m.name}</option>)}</select></Field>
              <Field label="Assessment"><select value={form.assessmentId} onChange={e => setForm(f => ({ ...f, assessmentId: e.target.value }))} disabled={!form.unitId} className={inputCls}><option value="">Choose…</option>{assessmentsInCourse(form.unitId).map(a => <option key={a.id} value={a.id}>{a.title} — out of {a.maxMarks}</option>)}</select>{form.unitId && assessmentsInCourse(form.unitId).length === 0 && <p className="mt-1 text-[11px] text-amber-600">This unit has no assessments — add one on the “Assessments &amp; grades” tab first.</p>}</Field>
              <Field label="Student"><StudentCombo students={studentsInCourse(form.unitId)} value={form.studentId} onChange={id => setForm(f => ({ ...f, studentId: id }))} /></Field>
            </>
          )}
          <Field label={`Total marks (out of ${maxMarks})`}><input type="text" inputMode="numeric" value={form.marks} onChange={e => { const v = e.target.value; if (v === "" || /^\d{1,4}$/.test(v)) setForm(f => ({ ...f, marks: v })); }} placeholder={`0–${maxMarks}`} className={inputCls} /></Field>
          {form.marks !== "" && Number(form.marks) >= 0 && Number(form.marks) <= maxMarks && (
            <p className="text-[11px] text-slate-400">= {Math.round(Number(form.marks) / maxMarks * 1000) / 10}% · <span className="font-bold" style={{ color: gradeTone(bandOf(Math.round(Number(form.marks) / maxMarks * 1000) / 10)).colour }}>{bandOf(Math.round(Number(form.marks) / maxMarks * 1000) / 10)}</span></p>
          )}
          {form.marks !== "" && Number(form.marks) > maxMarks && <p className="text-[11px] font-semibold text-rose-600">Marks can't exceed the maximum of {maxMarks}.</p>}
          <PrimaryBtn onClick={save} disabled={busy || !formValid} className="w-full">{busy ? <><Loader size={16} /> Saving…</> : <><Save size={16} /> {edit ? "Save marks" : "Add record"}</>}</PrimaryBtn>
        </div>
      </Modal>
    </>
  );
}

/* ============================================================
   Dashboard: PAT — Personal Academic Tutor interactions.
   Log a meeting/contact with a student (query type, summary,
   follow-up actions, whether a follow-up is required) and keep a
   searchable log with follow-up tracking.
   ============================================================ */
const QUERY_TYPES = [
  "1 to 1 Meeting", "No Show", "Academic Query", "Assessment Queries",
  "Stage 2 - Absence Concern Meeting", "Progression Concerns",
  "Personal Wellbeing", "Feedback on Assignments", "Other",
];
const QT_TONE = {
  "No Show": { bg: "bg-rose-100", text: "text-rose-700" },
  "Stage 2 - Absence Concern Meeting": { bg: "bg-amber-100", text: "text-amber-700" },
  "Progression Concerns": { bg: "bg-amber-100", text: "text-amber-700" },
  "Personal Wellbeing": { bg: "bg-violet-100", text: "text-violet-700" },
  "Academic Query": { bg: "bg-blue-100", text: "text-blue-700" },
  "Assessment Queries": { bg: "bg-blue-100", text: "text-blue-700" },
  "Feedback on Assignments": { bg: "bg-emerald-100", text: "text-emerald-700" },
};
const qtTone = (t) => QT_TONE[t] || { bg: "bg-slate-100", text: "text-slate-600" };
const nowHM = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

// A searchable single-student selector (there can be 1000s of students).
function StudentCombo({ students, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const sel = students.find(s => s.id === value);
  const ql = q.trim().toLowerCase();
  // Guard every field. Students from the review roster deliberately carry NO email
  // (it's a contact detail the roster withholds), so an unguarded (s.email || "").toLowerCase()
  // white-screen-crashed the picker the moment a roster-fed admin typed anything.
  const matches = (ql ? students.filter(s => (s.name || "").toLowerCase().includes(ql) || (s.studentRef || "").includes(ql) || (s.email || "").toLowerCase().includes(ql)) : students);
  const shown = matches.slice(0, 40);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(o => !o)} className={`${inputCls} flex items-center justify-between text-left`}>
        {sel
          ? <span className="flex min-w-0 items-center gap-2"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white" style={{ background: sel.colour }}>{sel.initials}</span><span className="truncate">{sel.name}</span><span className="shrink-0 text-slate-400">{sel.studentRef}</span></span>
          : <span className="text-slate-400">Choose a student…</span>}
        <ChevronDown size={16} className="shrink-0 text-slate-400" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute z-40 mt-1 max-h-72 w-full overflow-hidden rounded-xl bg-white shadow-lg ring-1 ring-slate-200">
            <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
              <Search size={14} className="text-slate-400" />
              <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search name or number…" className="flex-1 bg-transparent text-sm outline-none" />
            </div>
            <div className="max-h-56 overflow-y-auto p-1">
              {shown.map(s => (
                <button type="button" key={s.id} onClick={() => { onChange(s.id); setOpen(false); setQ(""); }} className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition ${s.id === value ? "bg-blue-50" : "hover:bg-slate-50"}`}>
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ background: s.colour }}>{s.initials}</span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-700">{s.name}</span><span className="block truncate text-[11px] text-slate-400">{s.studentRef}</span></span>
                </button>
              ))}
              {shown.length === 0 && <p className="px-2 py-6 text-center text-xs text-slate-400">No students match.</p>}
              {matches.length > shown.length && <p className="px-2 py-2 text-center text-[11px] text-slate-400">Showing 40 of {matches.length} — keep typing to narrow.</p>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function AdminPAT({ store }) {
  const { refreshHnd, refreshInteractions, interactionsLoaded } = store;
  const blank = () => ({ studentId: "", date: todayISO(), time: nowHM(), queryType: "", summary: "", followUpActions: "", followUpRequired: false, followUpDate: "", tutor: "" });
  const [modal, setModal] = useState(false);
  const [edit, setEdit] = useState(null);
  const [form, setForm] = useState(blank());
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [followFilter, setFollowFilter] = useState("all"); // all | required | none
  const [busy, setBusy] = useState(false);

  // Needs students (for the picker) + interactions. Both load on open.
  useEffect(() => { refreshHnd(); refreshInteractions(); }, [refreshHnd, refreshInteractions]);

  // Roster fallback for a 'pat'-only admin. /hnd/students is gated on registers/
  // students/executive, so store.students 403s to empty for them and the picker was
  // permanently empty — no interaction could ever be logged. The student-reviews
  // roster (open to any authenticated staff) provides the same names, so fall back to
  // it, exactly as Student Reviews does.
  const [roster, setRoster] = useState([]);
  useEffect(() => {
    if (store.students.length) return;
    let cancelled = false;
    api.studentReviewRoster().then(r => { if (!cancelled) setRoster(r.students || []); }).catch(() => {});
    return () => { cancelled = true; };
  }, [store.students.length]);
  const pickerStudents = store.students.length ? store.students : roster;

  const studentsById = useMemo(() => Object.fromEntries(pickerStudents.map(s => [s.id, s])), [pickerStudents]);
  const courseById = useMemo(() => Object.fromEntries(store.courses.map(p => [p.id, p])), [store.courses]);
  const unitById = useMemo(() => Object.fromEntries(store.units.map(m => [m.id, m])), [store.units]);
  const courseOf = (studentId) => {
    const s = studentsById[studentId];
    const modId = (s?.unitIds || [])[0];
    const prog = modId ? courseById[unitById[modId]?.courseId] : null;
    return prog?.name || "—";
  };

  const openAdd = () => { setEdit(null); setForm(blank()); setModal(true); };
  const openEdit = (it) => { setEdit(it); setForm({ studentId: it.studentId, date: it.date, time: it.time, queryType: it.queryType, summary: it.summary || "", followUpActions: it.followUpActions || "", followUpRequired: !!it.followUpRequired, followUpDate: it.followUpDate || "", tutor: it.tutor || "" }); setModal(true); };
  const save = async () => {
    setBusy(true);
    try {
      if (edit) await store.updateInteraction(edit.id, form);
      else await store.addInteraction(form);
      setModal(false);
    } catch (_e) { /* toast shown by the store; keep the modal open */ }
    setBusy(false);
  };
  const remove = async (it) => {
    if (!window.confirm(`Delete this ${it.queryType} interaction for ${it.student?.name || "this student"}? This cannot be undone.`)) return;
    await store.removeInteraction(it.id);
  };

  const ql = query.trim().toLowerCase();
  const list = store.interactions.filter(it => {
    if (typeFilter && it.queryType !== typeFilter) return false;
    if (followFilter === "required" && !it.followUpRequired) return false;
    if (followFilter === "none" && it.followUpRequired) return false;
    if (!ql) return true;
    return (it.student?.name || "").toLowerCase().includes(ql) || (it.student?.studentRef || "").includes(ql) || (it.summary || "").toLowerCase().includes(ql) || it.queryType.toLowerCase().includes(ql);
  });
  const paged = usePaged(list, 12, `${ql}|${typeFilter}|${followFilter}`);

  // Stats
  const total = store.interactions.length;
  const openFollowUps = store.interactions.filter(i => i.followUpRequired).length;
  const noShows = store.interactions.filter(i => i.queryType === "No Show").length;
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const thisWeek = store.interactions.filter(i => i.date >= weekAgo).length;

  const exportCSV = () => {
    downloadCSV("pat-interactions.csv", [
      { key: "ref", label: "Student reference" }, { key: "name", label: "Student name" }, { key: "course", label: "Course" },
      { key: "date", label: "Interaction date" }, { key: "time", label: "Time" }, { key: "type", label: "Query type" },
      { key: "summary", label: "Interaction summary" }, { key: "actions", label: "Follow up actions" },
      { key: "followUp", label: "Follow up required" }, { key: "followUpDate", label: "Follow up date" },
      { key: "tutor", label: "Tutor" }, { key: "loggedBy", label: "Logged by" },
    ], list.map(it => ({
      ref: it.student?.studentRef || "", name: it.student?.name || "", course: courseOf(it.studentId),
      date: it.date, time: it.time, type: it.queryType, summary: it.summary, actions: it.followUpActions,
      followUp: it.followUpRequired ? "Yes" : "No", followUpDate: it.followUpRequired ? (it.followUpDate || "") : "",
      tutor: it.tutor || "", loggedBy: it.loggedBy || "",
    })));
    store.notify("Exported interactions CSV");
  };

  // A follow-up with no date is the thing that goes missing, so it is required.
  const formValid = form.studentId && form.date && form.time && form.queryType
    && (!form.followUpRequired || !!form.followUpDate);

  if (!interactionsLoaded) {
    return (<><AdminHeader title="PAT — Student Interactions" subtitle="Loading the interaction log…" Icon={MessageSquare} /><div className="space-y-3">{[0, 1, 2].map(i => <div key={i} className="skeleton h-16 rounded-2xl" />)}</div></>);
  }

  return (
    <>
      <AdminHeader
        title="PAT — Student Interactions"
        subtitle="Log tutor meetings & contacts, and track follow-ups"
        Icon={MessageSquare}
        action={<div className="flex flex-wrap items-center gap-2"><ExportBtn onClick={exportCSV} label="Export" /><PrimaryBtn onClick={openAdd}><Plus size={16} /> Log interaction</PrimaryBtn></div>}
      />

      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Interactions" value={total} sub="logged in total" Icon={MessageSquare} tone={NAVY} delay={0} animate />
        <StatCard label="Follow-ups open" value={openFollowUps} sub="need action" Icon={AlertCircle} tone={openFollowUps > 0 ? "#b45309" : "#059669"} delay={60} animate />
        <StatCard label="This week" value={thisWeek} sub="last 7 days" Icon={CalendarDays} tone="#6d28d9" delay={120} animate />
        <StatCard label="No-shows" value={noShows} sub="missed meetings" Icon={XCircle} tone={MAROON} delay={180} animate />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
          <Search size={15} className="text-slate-400" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search student, summary or type…" className="w-44 bg-transparent text-sm outline-none sm:w-60" />
        </div>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 outline-none">
          <option value="">All query types</option>
          {QUERY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <div className="flex gap-1 rounded-xl bg-white p-1 ring-1 ring-slate-200">
          {[{ k: "all", l: "All" }, { k: "required", l: "Follow-up" }, { k: "none", l: "No follow-up" }].map(f => (
            <button key={f.k} onClick={() => setFollowFilter(f.k)} className={`press rounded-lg px-2.5 py-1.5 text-xs font-bold transition ${followFilter === f.k ? "text-white" : "text-slate-500 hover:bg-slate-100"}`} style={followFilter === f.k ? { background: NAVY } : {}}>{f.l}</button>
          ))}
        </div>
        <span className="ml-auto text-xs font-semibold text-slate-400">{list.length} of {total}</span>
      </div>

      <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 fade-up">
        <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
          <table className="w-full min-w-[960px] text-sm">
            <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-5 py-3">Student</th><th className="px-5 py-3">Course</th><th className="px-5 py-3 whitespace-nowrap">Date / time</th>
                <th className="px-5 py-3">Query type</th><th className="px-5 py-3">Summary</th><th className="px-5 py-3">Follow-up actions</th>
                <th className="px-5 py-3 text-center whitespace-nowrap">Follow-up?</th>
                <th className="px-5 py-3 whitespace-nowrap">Follow-up date</th><th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {paged.slice.map(it => {
                const t = qtTone(it.queryType);
                return (
                  <tr key={it.id} onClick={() => openEdit(it)} className="cursor-pointer border-t border-slate-100 align-top transition-colors duration-150 hover:bg-blue-50/40">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-sm" style={{ background: it.student?.colour || "#94a3b8" }}>{it.student?.initials || "?"}</span>
                        <div className="min-w-0"><p className="font-semibold text-slate-700">{it.student?.name || "—"}</p><p className="text-[11px] tabular-nums text-slate-400">{it.student?.studentRef || ""}</p></div>
                      </div>
                    </td>
                    <td className="px-5 py-3"><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">{courseOf(it.studentId)}</span></td>
                    <td className="px-5 py-3 whitespace-nowrap text-slate-500"><p className="font-medium text-slate-600">{fmtDate(it.date)}</p><p className="text-[11px] tabular-nums text-slate-400">{it.time}</p></td>
                    <td className="px-5 py-3"><span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${t.bg} ${t.text}`}>{it.queryType}</span></td>
                    <td className="px-5 py-3"><p className="line-clamp-2 max-w-[240px] text-[13px] text-slate-600">{it.summary || <span className="text-slate-300">—</span>}</p></td>
                    <td className="px-5 py-3"><p className="line-clamp-2 max-w-[240px] text-[13px] text-slate-600">{it.followUpActions || <span className="text-slate-300">—</span>}</p></td>
                    <td className="px-5 py-3 text-center">
                      {it.followUpRequired
                        ? <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-bold text-amber-700">Yes</span>
                        : <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-400">No</span>}
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap">
                      {it.followUpRequired && it.followUpDate ? (
                        // A follow-up whose date has passed is the one worth seeing.
                        <span className={`text-[13px] font-semibold ${it.followUpDate < todayISO() ? "text-rose-600" : "text-slate-600"}`}>
                          {fmtDate(it.followUpDate)}
                          {it.followUpDate < todayISO() && <span className="ml-1.5 rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-600">Overdue</span>}
                        </span>
                      ) : it.followUpRequired ? (
                        <span className="text-[11px] font-semibold text-amber-600">No date set</span>
                      ) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1 whitespace-nowrap">
                        <button onClick={(e) => { e.stopPropagation(); openEdit(it); }} title="Edit / view" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"><Edit3 size={15} /></button>
                        <button onClick={(e) => { e.stopPropagation(); remove(it); }} title="Delete" className="rounded-lg p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"><Trash2 size={15} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {paged.slice.length === 0 && <tr><td colSpan={9} className="px-5 py-10"><EmptyState Icon={MessageSquare} title={total === 0 ? "No interactions yet" : "No interactions match"} msg={total === 0 ? "Log your first student interaction with “Log interaction”." : "Try a different search or filter."} /></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <Pagination className="mt-4" page={paged.page} setPage={paged.setPage} totalPages={paged.totalPages} total={paged.total} />

      <Modal open={modal} onClose={() => !busy && setModal(false)} title={edit ? "Student interaction" : "Log new interaction"} width={560}>
        <div className="space-y-3">
          <Field label="Student"><StudentCombo students={pickerStudents} value={form.studentId} onChange={id => setForm(f => ({ ...f, studentId: id }))} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Interaction date"><input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} className={inputCls} /></Field>
            <Field label="Interaction time"><input type="time" value={form.time} onChange={e => setForm(f => ({ ...f, time: e.target.value }))} className={inputCls} /></Field>
          </div>
          <Field label="Query type">
            <select value={form.queryType} onChange={e => setForm(f => ({ ...f, queryType: e.target.value }))} className={inputCls}>
              <option value="">Choose…</option>
              {QUERY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Tutor (who met the student)">
            <select value={form.tutor} onChange={e => setForm(f => ({ ...f, tutor: e.target.value }))} className={inputCls}>
              <option value="">— not specified —</option>
              {store.staff.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Interaction summary"><textarea rows={4} value={form.summary} onChange={e => setForm(f => ({ ...f, summary: e.target.value }))} placeholder="What was discussed…" className={`${inputCls} resize-y`} /></Field>
          <Field label="Follow up actions"><textarea rows={3} value={form.followUpActions} onChange={e => setForm(f => ({ ...f, followUpActions: e.target.value }))} placeholder="Actions agreed / to take…" className={`${inputCls} resize-y`} /></Field>
          <Field label="Follow up required?">
            <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
              {[{ v: false, l: "No" }, { v: true, l: "Yes" }].map(o => (
                <button key={String(o.v)} type="button"
                  onClick={() => setForm(f => ({ ...f, followUpRequired: o.v, followUpDate: o.v ? f.followUpDate : "" }))}
                  className={`press flex-1 rounded-lg py-2 text-xs font-bold transition ${form.followUpRequired === o.v ? (o.v ? "bg-amber-500 text-white shadow-sm" : "bg-white text-slate-700 shadow-sm") : "text-slate-400"}`}>{o.l}</button>
              ))}
            </div>
          </Field>
          {/* Only asked for when a follow-up is required — a date on an interaction
              that needs no follow-up would be noise in the log and the export. */}
          {form.followUpRequired && (
            <Field label="Follow up date *">
              <input type="date" value={form.followUpDate} min={form.date}
                onChange={e => setForm(f => ({ ...f, followUpDate: e.target.value }))} className={inputCls} />
              {!form.followUpDate && <p className="mt-1 text-[11px] font-semibold text-amber-600">Set the date the follow-up is due.</p>}
            </Field>
          )}
          {edit?.loggedBy && <p className="text-[11px] text-slate-400">Logged by {edit.loggedBy}.</p>}
          <PrimaryBtn onClick={save} disabled={busy || !formValid} className="w-full">{busy ? <><Loader size={16} /> Saving…</> : <><Save size={16} /> {edit ? "Save changes" : "Log interaction"}</>}</PrimaryBtn>
        </div>
      </Modal>
    </>
  );
}

/* ============================================================
   Dashboard: KPIs — a performance dashboard, one row per staff.
   Blends their own attendance (check-ins), teaching load, register
   submission (registers actually taken for their classes), the
   student attendance they achieve, and leave use — into a single
   RAG-rated score. All computed live from real data.
   ============================================================ */
const ON_TIME_BY = "09:00"; // check-in at/before this counts as on time

function computeStaffKpis(store) {
  const today = todayISO();
  const unitTotals = store.attendance?.unitTotals || {};
  return store.staff.map(s => {
    // 1) Own attendance — from their check-in log
    const cis = store.checkins.filter(c => c.staffId === s.id);
    const days = cis.length;
    const onTime = cis.filter(c => c.in && c.in <= ON_TIME_BY).length;
    const punctuality = days ? Math.round((onTime / days) * 100) : null;

    // 2) Teaching load — courses this person tutors. Match on tutorStaffId (the linked
    // staff id) when present, falling back to the legacy free-text name for old units.
    const mods = store.units.filter(m => m.tutorStaffId ? m.tutorStaffId === s.id : (m.tutor && m.tutor === s.name));
    const courses = mods.length;
    const studentsTaught = mods.reduce((a, m) => a + (m.studentCount || 0), 0);

    // 3) Register submission — past sessions in their courses that have a register taken
    const due = store.sessions.filter(x => x.date <= today && mods.some(m => m.id === x.unitId));
    const taken = due.filter(x => (x.markedCount || 0) > 0).length;
    const submission = due.length ? Math.round((taken / due.length) * 100) : null;

    // 4) Student attendance they achieve — mean cohort % across their courses
    const pcts = mods.map(m => unitTotals[m.id]?.pct).filter(v => v != null);
    const cohort = pcts.length ? Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 10) / 10 : null;

    // 5) Leave use
    const used = store.usedDays(s.id);
    const allowance = store.bookableAllowance(s.id);

    // Composite score — mean of the metrics that apply to this person
    const parts = [punctuality, submission, cohort].filter(v => v != null);
    const score = parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : null;

    return { s, days, punctuality, courses, studentsTaught, due: due.length, taken, submission, cohort, used, allowance, score, mods };
  });
}

// A compact metric cell: a coloured pill + a thin bar. null shows a muted dash.
function KpiCell({ value, suffix = "%" }) {
  if (value == null) return <span className="text-slate-300">—</span>;
  const t = pctTone(value);
  return (
    <div className="min-w-[92px]">
      <span className={`rounded-lg px-2 py-0.5 text-xs font-extrabold tabular-nums ${t.bg} ${t.text}`}>{value}{suffix}</span>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full" style={{ width: `${Math.min(100, value)}%`, background: t.colour }} /></div>
    </div>
  );
}

function AdminKPI({ store }) {
  const { refreshHnd, hndLoaded } = store;
  const [detail, setDetail] = useState(null);
  const [sort, setSort] = useState("score");   // score | submission | cohort | punctuality | name
  useEffect(() => { refreshHnd(); }, [refreshHnd]);

  const kpis = useMemo(() => computeStaffKpis(store), [store.staff, store.checkins, store.units, store.sessions, store.attendance, store.leave, store.adjustments]);

  const avg = (key) => { const v = kpis.map(k => k[key]).filter(x => x != null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };
  const tutors = kpis.filter(k => k.courses > 0);
  const orgSubmission = avg("submission");
  const orgCohort = avg("cohort");
  const orgPunctuality = avg("punctuality");
  const orgScore = avg("score");

  const sorted = [...kpis].sort((a, b) => {
    if (sort === "name") return a.s.name.localeCompare(b.s.name);
    return (b[sort] ?? -1) - (a[sort] ?? -1);
  });
  const chartData = tutors.map(k => ({ name: k.s.initials, full: k.s.name, score: k.score ?? 0 })).slice(0, 12);

  const exportKpis = () => {
    downloadCSV("staff-kpis.csv", [
      { key: "name", label: "Staff" }, { key: "dept", label: "Department" }, { key: "courses", label: "Courses tutored" },
      { key: "students", label: "Students taught" }, { key: "submission", label: "Register submission %" },
      { key: "cohort", label: "Student attendance %" }, { key: "punctuality", label: "Own punctuality %" },
      { key: "leave", label: "Leave used" }, { key: "score", label: "KPI score" },
    ], kpis.map(k => ({
      name: k.s.name, dept: k.s.dept, courses: k.courses, students: k.studentsTaught,
      submission: k.submission ?? "", cohort: k.cohort ?? "", punctuality: k.punctuality ?? "",
      leave: `${k.used}/${k.allowance}`, score: k.score ?? "",
    })));
    store.notify("Exported KPI CSV");
  };

  if (!hndLoaded) {
    return (<><AdminHeader title="KPI Dashboard" subtitle="Crunching staff performance…" Icon={Activity} /><div className="space-y-3">{[0, 1, 2].map(i => <div key={i} className="skeleton h-16 rounded-2xl" />)}</div></>);
  }

  return (
    <>
      <AdminHeader
        title="KPI Dashboard"
        subtitle="Staff performance at a glance — attendance, register submission & student outcomes"
        Icon={Activity}
        action={<ExportBtn onClick={exportKpis} label="Export KPIs" />}
      />

      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Avg KPI score" value={fmtPct(orgScore)} sub="across all staff" Icon={Award} tone={pctTone(orgScore).colour} delay={0} animate />
        <StatCard label="Register submission" value={fmtPct(orgSubmission)} sub="registers taken on time" Icon={ClipboardList} tone={pctTone(orgSubmission).colour} delay={60} animate />
        <StatCard label="Student attendance" value={fmtPct(orgCohort)} sub="across taught classes" Icon={Percent} tone={pctTone(orgCohort).colour} delay={120} animate />
        <StatCard label="Staff punctuality" value={fmtPct(orgPunctuality)} sub={`on-time by ${ON_TIME_BY}`} Icon={Clock3} tone={pctTone(orgPunctuality).colour} delay={180} animate />
      </div>

      {/* KPI score by tutor */}
      <div className="mb-5 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70 fade-up">
        <p className="mb-3 flex items-center gap-1.5 text-sm font-bold text-slate-700"><BarChart3 size={15} /> KPI score by staff {tutors.length > 12 && <span className="text-[11px] font-medium text-slate-400">(top 12)</span>}</p>
        {chartData.length ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 12, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
              <YAxis domain={[0, 100]} unit="%" tick={{ fontSize: 12, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 13 }} formatter={(v) => [`${v}%`, "KPI score"]} labelFormatter={(l) => chartData.find(d => d.name === l)?.full || l} />
              <Bar dataKey="score" radius={[6, 6, 0, 0]}>{chartData.map((d, i) => <Cell key={i} fill={pctTone(d.score).colour} />)}</Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <EmptyState Icon={BarChart3} title="No teaching KPIs yet" msg="Assign staff as course tutors (Courses → Edit) and take some registers — each tutor's score will appear here." />
        )}
      </div>

      {/* Per-staff KPI table */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <p className="text-sm font-bold text-slate-700">Per-staff breakdown</p>
        <div className="ml-auto flex items-center gap-1 rounded-xl bg-white p-1 ring-1 ring-slate-200">
          <span className="px-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">Sort</span>
          {[{ k: "score", l: "Score" }, { k: "submission", l: "Registers" }, { k: "cohort", l: "Attendance" }, { k: "name", l: "Name" }].map(o => (
            <button key={o.k} onClick={() => setSort(o.k)} className={`press rounded-lg px-2.5 py-1.5 text-xs font-bold transition ${sort === o.k ? "text-white" : "text-slate-500 hover:bg-slate-100"}`} style={sort === o.k ? { background: NAVY } : {}}>{o.l}</button>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 fade-up">
        <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-5 py-3">Staff</th>
                <th className="px-5 py-3 text-center whitespace-nowrap">Courses</th>
                <th className="px-5 py-3 text-center whitespace-nowrap">Students</th>
                <th className="px-5 py-3 whitespace-nowrap">Register submission</th>
                <th className="px-5 py-3 whitespace-nowrap">Student attendance</th>
                <th className="px-5 py-3 whitespace-nowrap">Own punctuality</th>
                <th className="px-5 py-3 whitespace-nowrap">Leave</th>
                <th className="px-5 py-3 text-center whitespace-nowrap">KPI score</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(k => (
                <tr key={k.s.id} onClick={() => setDetail(k)} className="cursor-pointer border-t border-slate-100 transition-colors duration-150 hover:bg-blue-50/40">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-sm" style={{ background: k.s.colour }}>{k.s.initials}</span>
                      <div className="min-w-0"><p className="font-semibold text-slate-700">{k.s.name}</p><p className="text-[11px] text-slate-400">{k.s.dept}</p></div>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-center font-bold tabular-nums text-slate-600">{k.courses || <span className="text-slate-300">0</span>}</td>
                  <td className="px-5 py-3 text-center font-bold tabular-nums text-slate-600">{k.studentsTaught || <span className="text-slate-300">0</span>}</td>
                  <td className="px-5 py-3"><KpiCell value={k.submission} /></td>
                  <td className="px-5 py-3"><KpiCell value={k.cohort} /></td>
                  <td className="px-5 py-3"><KpiCell value={k.punctuality} /></td>
                  <td className="px-5 py-3 tabular-nums text-slate-600">{k.used}<span className="text-slate-300">/{k.allowance}d</span></td>
                  <td className="px-5 py-3 text-center">
                    {k.score == null ? <span className="text-slate-300">—</span> : <span className="inline-flex h-9 w-9 items-center justify-center rounded-full text-xs font-extrabold text-white shadow-sm tabular-nums" style={{ background: pctTone(k.score).colour }}>{k.score}</span>}
                  </td>
                </tr>
              ))}
              {sorted.length === 0 && <tr><td colSpan={8} className="px-5 py-10"><EmptyState Icon={Users} title="No staff yet" msg="Add staff members and assign them as course tutors to see KPIs." /></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-3 text-[11px] text-slate-400">
        <b>KPI score</b> is the mean of register submission, student attendance and own punctuality (whichever apply). Green 70%+ · amber 50–70% · orange 40–50% · red below 40% (90%+ shows violet). Click a row for the full breakdown.
      </p>

      <Modal open={!!detail} onClose={() => setDetail(null)} title="Staff KPI breakdown" width={560}>
        {detail && <StaffKpiDetail k={detail} store={store} />}
      </Modal>
    </>
  );
}

function StaffKpiDetail({ k, store }) {
  const today = todayISO();
  const unitTotals = store.attendance?.unitTotals || {};
  const metrics = [
    { label: "Register submission", value: k.submission, hint: `${k.taken}/${k.due} past registers taken` },
    { label: "Student attendance", value: k.cohort, hint: "mean across taught classes" },
    { label: "Own punctuality", value: k.punctuality, hint: `${k.days} check-in day${k.days === 1 ? "" : "s"} logged` },
  ];
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white shadow-sm" style={{ background: k.s.colour }}>{k.s.initials}</span>
        <div className="min-w-0 flex-1"><p className="truncate text-base font-extrabold" style={{ color: NAVY_DARK }}>{k.s.name}</p><p className="truncate text-xs text-slate-400">{k.s.role} · {k.s.dept}</p></div>
        {k.score != null && <span className="flex h-12 w-12 items-center justify-center rounded-full text-sm font-extrabold text-white shadow" style={{ background: pctTone(k.score).colour }}>{k.score}</span>}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {metrics.map(m => (
          <div key={m.label} className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{m.label}</p>
            <p className="text-lg font-extrabold tabular-nums" style={{ color: pctTone(m.value ?? null).colour }}>{fmtPct(m.value ?? null)}</p>
            <p className="mt-0.5 text-[10px] text-slate-400">{m.hint}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70"><p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Teaching load</p><p className="text-sm font-bold text-slate-700">{k.courses} course{k.courses === 1 ? "" : "s"} · {k.studentsTaught} students</p></div>
        <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70"><p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Leave used</p><p className="text-sm font-bold text-slate-700">{k.used} of {k.allowance} days</p></div>
      </div>

      {k.mods.length > 0 ? (
        <div>
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400">Courses tutored</p>
          <div className="rounded-2xl ring-1 ring-slate-200/70">
            {k.mods.map((m, i) => {
              const mt = unitTotals[m.id];
              const due = store.sessions.filter(x => x.unitId === m.id && x.date <= today);
              const taken = due.filter(x => (x.markedCount || 0) > 0).length;
              const subPct = due.length ? Math.round((taken / due.length) * 100) : null;
              return (
                <div key={m.id} className={`flex items-center gap-3 px-3.5 py-2.5 ${i ? "border-t border-slate-100" : ""}`}>
                  <span className="flex h-8 w-11 shrink-0 items-center justify-center rounded-lg text-[10px] font-extrabold text-white" style={{ background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` }}>{m.code.slice(0, 5)}</span>
                  <div className="min-w-0 flex-1"><p className="truncate text-xs font-bold text-slate-700" title={m.name}>{m.name}</p><p className="text-[10px] text-slate-400">{m.studentCount} students · {taken}/{due.length} registers taken</p></div>
                  <span className={`shrink-0 rounded-lg px-2 py-1 text-[11px] font-extrabold tabular-nums ${pctTone(subPct).bg} ${pctTone(subPct).text}`}>{fmtPct(subPct)}</span>
                  <span className={`shrink-0 rounded-lg px-2 py-1 text-[11px] font-extrabold tabular-nums ${pctTone(mt?.pct ?? null).bg} ${pctTone(mt?.pct ?? null).text}`}>{fmtPct(mt?.pct ?? null)}</span>
                </div>
              );
            })}
          </div>
          <p className="mt-1.5 text-[10px] text-slate-400">Per course: register submission % · student attendance %.</p>
        </div>
      ) : (
        <div className="rounded-xl bg-slate-50 px-4 py-6 text-center text-xs text-slate-400">Not assigned as a tutor on any course. Assign them on <b>Courses → Edit</b> to track teaching KPIs.</div>
      )}
    </div>
  );
}

/* ============================================================
   Dashboard: Staff — a directory of every staff member with a
   department filter, stats and full CRUD. Its own top-level tab.
   ============================================================ */
// The teaching mirror of the student dashboard: what this lecturer teaches, how
// attendance is running, and what marking and registers are still owed. Opened from
// the Staff list, alongside Edit.
function StaffTeachingModal({ staffMember, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    if (!staffMember) return;
    setData(null); setErr("");
    api.staffTeaching(staffMember.id)
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) setErr(e.message || "Could not load this teaching summary"); });
    return () => { alive = false; };
  }, [staffMember]);

  const t = data?.totals;
  const Tile = ({ label, value, sub, tone = NAVY }) => (
    <div className="rounded-xl bg-white p-3 text-center shadow-sm ring-1 ring-slate-200/70">
      <p className="text-xl font-extrabold leading-none" style={{ color: tone }}>{value}</p>
      <p className="mt-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</p>
      {sub && <p className="text-[10px] text-slate-400">{sub}</p>}
    </div>
  );

  return (
    <Modal open={!!staffMember} onClose={onClose} title="Staff dashboard">
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white shadow-sm" style={{ background: staffMember?.colour || NAVY }}>{staffMember?.initials}</span>
          <div className="min-w-0">
            <p className="truncate text-base font-extrabold" style={{ color: NAVY }}>{staffMember?.name}</p>
            <p className="truncate text-[11px] text-slate-400">{staffMember?.role}{staffMember?.dept ? ` · ${staffMember.dept}` : ""}</p>
          </div>
        </div>

        {err && <div className="rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600 ring-1 ring-rose-200">{err}</div>}
        {!data && !err && <div className="skeleton h-24 rounded-xl" />}

        {data && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Tile label="Units taught" value={t.units} />
              <Tile label="Students" value={t.students} />
              <Tile label="Attendance" value={t.attendance?.pct == null ? "—" : `${t.attendance.pct}%`} tone={pctColour(t.attendance?.pct)} />
              {/* The number that prompts action, so it is red only when there is one. */}
              <Tile label="Registers due" value={t.registersDue} tone={t.registersDue ? MAROON : "#0d7a5f"} />
            </div>

            {data.units.length === 0 ? (
              <div className="rounded-xl bg-slate-50 px-3 py-6 text-center text-xs text-slate-400 ring-1 ring-slate-200">
                No units are assigned to {staffMember?.name} yet.
                <span className="mt-1 block">Assign one in <b>Registers → Units → Edit → Tutor</b>.</span>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Units taught</p>
                {data.units.map(u => {
                  const tone = pctTone(u.attendance?.pct);
                  return (
                    <div key={u.id} className="rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200/70">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-extrabold" style={{ color: NAVY_DARK }}>{u.code} — {u.name}</p>
                          <p className="truncate text-[11px] text-slate-400">{u.course?.name || "No course"}</p>
                        </div>
                        <span className={`shrink-0 rounded-lg px-2 py-1 text-[11px] font-extrabold ${tone.bg} ${tone.text}`}>{u.attendance?.pct == null ? "—" : `${u.attendance.pct}%`}</span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
                        <span>{u.students} students</span>
                        <span>Registers {u.registersTaken}/{u.sessions}{u.registersDue ? <b className="ml-1" style={{ color: MAROON }}>· {u.registersDue} due</b> : null}</span>
                        <span>Marks {u.graded}/{u.expectedGrades}</span>
                        {u.endDate && <span>Ends {fmtDate(u.endDate)}</span>}
                        {u.submissionDate && <span className="font-semibold text-slate-600">Due {fmtDate(u.submissionDate)}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function AdminStaff({ store }) {
  // Which staff member's teaching dashboard is open, mirroring the Students tab.
  const [teachingFor, setTeachingFor] = useState(null);
  const [modal, setModal] = useState(false);
  const [edit, setEdit] = useState(null);
  const [form, setForm] = useState({ name: "", role: "", dept: "", email: "", allowance: 28, site: "", dob: "" });
  // Recovery actions, reachable from the Staff page too (not only Settings).
  const [resetTarget, setResetTarget] = useState(null);
  const [resetBusy, setResetBusy] = useState(false);
  const resendInvite = async (s) => {
    try { const r = await api.resendInvite(s.id); store.notify(r?.message || `Invitation re-sent to ${s.email}`); }
    catch (e) { store.notify(e.message || "Could not re-send the invitation", "error"); }
  };
  const confirmReset = async () => {
    setResetBusy(true);
    try { await store.resetStaffTotp(resetTarget.id); setResetTarget(null); }
    catch (_) { /* store toasted + refetched */ }
    finally { setResetBusy(false); }
  };
  const [query, setQuery] = useState("");
  const [deptFilter, setDeptFilter] = useState("");     // "" = all departments
  const [siteFilter, setSiteFilter] = useState("");     // "" = all sites
  const [hoursStaff, setHoursStaff] = useState(null);   // staff whose monthly-hours breakdown is open
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const month = monthOf(todayISO());                    // current "YYYY-MM" for the hours column

  const depts = Array.from(new Set(store.staff.map(s => s.dept).filter(Boolean))).sort();
  const deptOptions = Array.from(new Set([...depts, "Sixth Form", "Tuition Centre", "Exam Centre", "Administration", "Higher Education"])).sort();

  const openAdd = () => { setEdit(null); setForm({ name: "", role: "", dept: (deptFilter || depts[0] || "Sixth Form"), email: "", allowance: 28, site: (siteFilter || ""), dob: "" }); setModal(true); };
  const openEdit = (s) => { setEdit(s); setForm({ name: s.name, role: s.role || "", dept: s.dept || "", email: s.email, allowance: s.allowance, site: s.site || "", dob: s.dob || "" }); setModal(true); };
  const save = async () => {
    if (!form.name.trim()) return;
    try {
      if (edit) await store.updateStaff(edit.id, { name: form.name, role: form.role, dept: form.dept, email: form.email, allowance: Number(form.allowance), site: form.site || null, dob: form.dob || null });
      else await store.addStaff({ name: form.name, role: form.role, dept: form.dept, email: form.email, allowance: Number(form.allowance), site: form.site || null, dob: form.dob || null });
      setModal(false);
    } catch (_e) { /* toast shown by the store; keep the modal open */ }
  };
  const confirmRemove = async () => {
    setDeleteBusy(true);
    try { await store.removeStaff(deleteTarget.id); setDeleteTarget(null); }
    catch (_) { /* store already toasted and refetched */ }
    finally { setDeleteBusy(false); }
  };

  const ql = query.trim().toLowerCase();
  const filtered = store.staff.filter(s => {
    if (deptFilter && s.dept !== deptFilter) return false;
    if (siteFilter && s.site !== siteFilter) return false;
    return !ql || s.name.toLowerCase().includes(ql) || (s.email || "").toLowerCase().includes(ql) || (s.role || "").toLowerCase().includes(ql) || (s.dept || "").toLowerCase().includes(ql);
  });
  const paged = usePaged(filtered, 12, `${ql}|${deptFilter}|${siteFilter}`);

  const total = store.staff.length;
  const adminCount = store.staff.filter(s => s.accountRole === "ADMIN").length;
  const avgAllowance = total ? Math.round(store.staff.reduce((a, s) => a + (s.allowance || 0), 0) / total) : 0;
  const deptCount = (d) => store.staff.filter(s => s.dept === d).length;

  const exportStaff = () => {
    downloadCSV("staff.csv", [
      { key: "name", label: "Name" }, { key: "email", label: "Email" }, { key: "role", label: "Role" },
      { key: "dept", label: "Department" }, { key: "site", label: "Site" }, { key: "hours", label: `Hours (${monthLabel(month)})` },
      { key: "account", label: "Account role" }, { key: "allowance", label: "Allowance (days)" },
      { key: "twoStep", label: "2-step verification" },
    ], filtered.map(s => ({
      name: s.name, email: s.email, role: s.role, dept: s.dept, site: s.site || "",
      account: s.isSuperAdmin ? "Super Admin" : s.accountRole === "ADMIN" ? (s.adminPages == null ? "Admin (full access)" : `Admin (${s.adminPages.length} pages)`) : "Staff",
      hours: fmtDuration(monthlyHoursFor(store.checkins, s.id, month).totalMin),
      allowance: s.allowance, twoStep: s.totpEnabled ? "On" : s.totpRequired ? "Setup due" : "Off",
    })));
    store.notify(`Exported staff CSV${deptFilter ? ` — ${deptFilter}` : ""}`);
  };

  // The department filter pills: All + each department (with its count).
  const chips = [{ id: "", label: "All departments", n: total }, ...depts.map(d => ({ id: d, label: d, n: deptCount(d) }))];

  return (
    <>
      <AdminHeader
        title="Staff"
        subtitle="Everyone on the team — filter by department"
        Icon={Users}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ExportBtn onClick={exportStaff} label="Export" />
            <PrimaryBtn onClick={openAdd}><UserPlus size={16} /> Add staff</PrimaryBtn>
          </div>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Total staff" value={total} sub="on the team" Icon={Users} tone={NAVY} delay={0} animate />
        <StatCard label="Departments" value={depts.length} sub="across the college" Icon={Building2} tone="#0d7a5f" delay={60} animate />
        <StatCard label="Administrators" value={adminCount} sub={`${total - adminCount} standard staff`} Icon={ShieldCheck} tone="#6d28d9" delay={120} animate />
        <StatCard label="Avg allowance" value={`${avgAllowance}d`} sub="holiday per person" Icon={Award} tone="#b45309" delay={180} animate />
      </div>

      {/* Department filter */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {chips.map(c => {
          const active = deptFilter === c.id;
          return (
            <button key={c.id || "all"} onClick={() => setDeptFilter(c.id)}
              className={`press flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold shadow-sm ring-1 transition-all ${active ? "text-white ring-transparent" : "bg-white text-slate-500 ring-slate-200 hover:bg-slate-50"}`}
              style={active ? { background: NAVY } : {}}>
              {c.label}
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${active ? "bg-white/25 text-white" : "bg-slate-100 text-slate-500"}`}>{c.n}</span>
            </button>
          );
        })}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
          <Search size={15} className="text-slate-400" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name, email or role…" className="w-48 bg-transparent text-sm outline-none sm:w-64" />
        </div>
        {/* Site filter — HND / FE / Online (staff pick their home site at sign-up). */}
        <div className="flex items-center gap-1.5 rounded-xl bg-white px-2.5 py-1.5 ring-1 ring-slate-200">
          <MapPin size={15} className="text-slate-400" />
          <select value={siteFilter} onChange={e => setSiteFilter(e.target.value)} className="bg-transparent text-sm font-medium text-slate-600 outline-none">
            <option value="">All sites</option>
            {HOME_SITES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <span className="ml-auto text-xs font-semibold text-slate-400">{filtered.length} of {total}</span>
      </div>

      <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 fade-up">
        <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-400">
              <tr><th className="px-5 py-3">Name</th><th className="px-5 py-3">Role</th><th className="px-5 py-3">Department</th><th className="px-5 py-3">Site</th><th className="px-5 py-3 whitespace-nowrap">Hours ({monthLabel(month).split(" ")[0]})</th><th className="px-5 py-3 whitespace-nowrap">Account</th><th className="px-5 py-3 whitespace-nowrap">Allowance</th><th className="px-5 py-3 text-right">Actions</th></tr>
            </thead>
            <tbody>
              {paged.slice.map(s => (
                <tr key={s.id} className="border-t border-slate-100 transition-colors duration-150 hover:bg-blue-50/30">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-sm" style={{ background: s.colour }}>{s.initials}</span>
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-700">{s.name}</p>
                        <p className="max-w-[200px] truncate text-[11px] text-slate-400" title={s.email}>{s.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-slate-500">{s.role || "—"}</td>
                  <td className="px-5 py-3">
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600">{s.dept || "—"}</span>
                  </td>
                  <td className="px-5 py-3">
                    {s.site
                      ? <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-bold text-blue-700 ring-1 ring-blue-100">{s.site}</span>
                      : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-5 py-3">
                    {(() => {
                      const h = monthlyHoursFor(store.checkins, s.id, month);
                      if (h.totalMin <= 0) return <span className="text-slate-300">—</span>;
                      return (
                        <button onClick={() => setHoursStaff(s)} title="See the weekly breakdown" className="press inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1 text-[12px] font-bold text-emerald-700 ring-1 ring-emerald-100 transition hover:bg-emerald-100">
                          <Timer size={12} /> {fmtDuration(h.totalMin)}
                        </button>
                      );
                    })()}
                  </td>
                  <td className="px-5 py-3">
                    {s.isSuperAdmin
                      ? <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold text-white" style={{ background: MAROON }}><ShieldCheck size={11} /> Super Admin</span>
                      : s.accountRole === "ADMIN"
                        ? <span className="rounded-full bg-indigo-100 px-2.5 py-1 text-[11px] font-bold text-indigo-700">Admin · {s.adminPages == null ? "full access" : `${s.adminPages.length} page${s.adminPages.length === 1 ? "" : "s"}`}</span>
                        : <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-500">Staff</span>}
                  </td>
                  <td className="px-5 py-3 font-medium tabular-nums text-slate-600">{s.allowance}d</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1 whitespace-nowrap">
                      <button onClick={() => setTeachingFor(s)} title="Teaching dashboard" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-blue-50 hover:text-blue-600"><BarChart3 size={15} /></button>
                      {/* Recovery actions — the server permits them for a staff-page
                          admin, but they only existed on the Settings page, so a
                          staff-only admin had no way to resend an invite or reset a
                          lost-phone 2FA despite holding the permission. */}
                      {s.pendingActivation && <button onClick={() => resendInvite(s)} title="Re-send the invitation email" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-blue-50 hover:text-blue-600"><Mail size={15} /></button>}
                      {s.totpEnabled && <button onClick={() => setResetTarget(s)} title="Reset two-step verification" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-amber-50 hover:text-amber-600"><ShieldCheck size={15} /></button>}
                      <button onClick={() => openEdit(s)} title="Edit staff" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"><Edit3 size={15} /></button>
                      <button onClick={() => setDeleteTarget(s)} title="Remove staff" className="rounded-lg p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"><Trash2 size={15} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {paged.slice.length === 0 && <tr><td colSpan={8} className="px-5 py-10"><EmptyState Icon={Users} title={total === 0 ? "No staff yet" : "No staff match"} msg={total === 0 ? "Add your first staff member." : (deptFilter || siteFilter) ? `No staff match this filter. Try another.` : "Try a different search."} /></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <Pagination className="mt-4" page={paged.page} setPage={paged.setPage} totalPages={paged.totalPages} total={paged.total} />

      <StaffTeachingModal staffMember={teachingFor} onClose={() => setTeachingFor(null)} />
      <ConfirmDialog
        open={!!resetTarget}
        title="Reset two-step verification?"
        message={resetTarget ? `${resetTarget.name} will need to set up their authenticator app again next time it's required. Their old codes stop working immediately and their password is unchanged. They'll be notified.` : ""}
        confirmLabel={resetBusy ? "Resetting…" : "Reset 2FA"}
        cancelLabel="Cancel"
        onConfirm={confirmReset}
        onCancel={() => setResetTarget(null)}
      />
      <Modal open={modal} onClose={() => setModal(false)} title={edit ? "Edit staff" : "Add staff"}>
        <div className="space-y-3">
          <Field label="Full name"><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Jane Doe" className={inputCls} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Role / job title"><input value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))} placeholder="e.g. Lecturer" className={inputCls} /></Field>
            <Field label="Department">
              <select value={form.dept} onChange={e => setForm(f => ({ ...f, dept: e.target.value }))} className={inputCls}>
                {deptOptions.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Email address"><input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="name@edtech.co.uk" className={inputCls} /></Field>
          <Field label="Date of birth"><input type="date" value={form.dob} onChange={e => setForm(f => ({ ...f, dob: e.target.value }))} className={inputCls} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Site"><select value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))} className={inputCls}><option value="">Not set</option>{HOME_SITES.map(s => <option key={s} value={s}>{s}</option>)}</select></Field>
            <Field label="Holiday allowance (days)"><input type="number" min={0} value={form.allowance} onChange={e => setForm(f => ({ ...f, allowance: e.target.value }))} className={inputCls} /></Field>
          </div>
          {!edit && <p className="text-[11px] text-slate-400">The new account is created inactive — they get an email invitation to set their own password before they can sign in.</p>}
          <PrimaryBtn onClick={save} disabled={!form.name.trim() || !form.email.trim()} className="w-full"><Save size={16} /> {edit ? "Save changes" : "Add staff"}</PrimaryBtn>
        </div>
      </Modal>

      <Modal open={!!deleteTarget} onClose={() => !deleteBusy && setDeleteTarget(null)} title="Remove staff member">
        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200">
            <span className="flex h-9 w-9 items-center justify-center rounded-full text-[11px] font-bold text-white" style={{ background: deleteTarget?.colour }}>{deleteTarget?.initials}</span>
            <div><p className="text-sm font-bold text-slate-700">{deleteTarget?.name}</p><p className="text-[11px] text-slate-400">{deleteTarget?.role} · {deleteTarget?.dept}</p></div>
          </div>
          <p className="flex items-start gap-1.5 rounded-xl bg-rose-50 px-3 py-2 text-[11px] leading-relaxed text-rose-700 ring-1 ring-rose-200">
            <AlertCircle size={13} className="mt-px shrink-0" />
            This permanently deletes their account <b>and their entire history</b> — leave, check-ins,
            balance adjustments, timesheets, notifications, documents assigned only to them, and their
            original sign-up record (so the same email can register again). It cannot be undone.
          </p>
          <PrimaryBtn colour={MAROON} onClick={confirmRemove} disabled={deleteBusy} className="w-full"><Trash2 size={16} /> {deleteBusy ? "Removing…" : `Remove ${deleteTarget?.name || ""}`}</PrimaryBtn>
          <button onClick={() => setDeleteTarget(null)} disabled={deleteBusy} className="press w-full text-center text-xs font-semibold text-slate-400 transition hover:text-slate-600">Cancel</button>
        </div>
      </Modal>

      {/* Monthly hours breakdown — opened by clicking a staff member's hours pill. */}
      <Modal open={!!hoursStaff} onClose={() => setHoursStaff(null)} title={`Hours worked — ${hoursStaff?.name || ""}`}>
        {hoursStaff && (() => {
          const h = monthlyHoursFor(store.checkins, hoursStaff.id, month);
          const fmtWk = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
          const weekEnd = (iso) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 6); return d.toISOString().slice(0, 10); };
          return (
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-xl bg-emerald-50 px-3.5 py-3 ring-1 ring-emerald-100">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-emerald-600">{monthLabel(month)}</p>
                  <p className="text-[11px] text-emerald-700/70">{h.countedDays} day{h.countedDays === 1 ? "" : "s"} counted</p>
                </div>
                <span className="text-xl font-extrabold text-emerald-700">{fmtDuration(h.totalMin)}</span>
              </div>
              <p className="px-1 text-xs font-bold uppercase tracking-wide text-slate-400">Per week (from check-in → check-out)</p>
              {h.weekList.length === 0 && <EmptyState Icon={Timer} title="Nothing to show yet" msg="Hours appear once a check-in has a matching check-out this month." />}
              {h.weekList.map(w => (
                <div key={w.monday} className="flex items-center justify-between rounded-xl bg-slate-50 px-3.5 py-2.5 ring-1 ring-slate-100">
                  <span className="text-sm font-semibold text-slate-600">{fmtWk(w.monday)} – {fmtWk(weekEnd(w.monday))}</span>
                  <span className="text-sm font-bold tabular-nums text-slate-700">{fmtDuration(w.min)}</span>
                </div>
              ))}
              {h.openDays > 0 && (
                <p className="flex items-start gap-1.5 rounded-xl bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-700 ring-1 ring-amber-100">
                  <AlertCircle size={13} className="mt-px shrink-0" />
                  {h.openDays} day{h.openDays === 1 ? "" : "s"} this month {h.openDays === 1 ? "has" : "have"} a check-in but no check-out, so {h.openDays === 1 ? "it is" : "they are"} not included in these hours.
                </p>
              )}
            </div>
          );
        })()}
      </Modal>
    </>
  );
}

// The counters a sync reports, in the order they read naturally: what came in, then
// what was already here. Only non-zero rows are shown, so a quiet run stays quiet.
const MOODLE_COUNTS = [
  ["coursesCreated", "Courses added"], ["unitsCreated", "Units added"],
  ["assessmentsCreated", "Assessments added"], ["studentsCreated", "Students added"],
  ["enrolmentsCreated", "Enrolments added"], ["gradesCreated", "Marks imported"],
  ["gradesUpdated", "Marks updated"], ["coursesUpdated", "Courses updated"],
  ["unitsUpdated", "Units updated"], ["assessmentsUpdated", "Assessments updated"],
  ["studentsMatched", "Students matched"], ["gradesSkippedManual", "Marks left alone"],
  ["attendanceSessionsCreated", "Registers imported"], ["attendanceMarksCreated", "Attendance marks imported"],
  ["attendanceSkippedConflict", "Attendance left alone"], ["attendanceSkippedNoStudent", "Attendance skipped — student not matched"],
];
const moodleTotal = (s) => MOODLE_COUNTS.reduce((n, [k]) => n + (Number(s?.[k]) || 0), 0);

// Moodle (VLE) import. Reads the college's Moodle and creates the matching courses,
// units, assessments, students and marks here — one way, never writing back.
function MoodleCard({ store }) {
  // Only registers/students admins may actually run a sync (server SYNC_PAGES).
  const canSync = canAccessPage(store.currentUser, "registers") || canAccessPage(store.currentUser, "students");
  const [status, setStatus] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState("");        // "" | "preview" | "sync"
  const [showIssues, setShowIssues] = useState(false);

  const load = useCallback(async () => {
    try { setStatus(await api.moodleStatus()); }
    catch (e) { setStatus({ failed: e.message }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // A sync outlives the request that starts it, so polling is the only way to learn
  // how it went — and it means closing this tab doesn't abandon the run.
  //
  // Polls whenever a run is in flight, NOT only in the tab that started it. Gating on
  // `busy` alone meant switching tabs and back remounted the card with busy === "",
  // so it fetched status once, saw running: true, and never polled again — leaving a
  // permanent spinner and two disabled buttons until a full page reload. A second
  // admin opening Settings mid-sync saw exactly the same.
  const polling = busy === "sync" || status?.running === true;
  useEffect(() => {
    if (!polling) return;
    let live = true;
    let failures = 0;
    const tick = async () => {
      try {
        const s = await api.moodleStatus();
        if (!live) return;
        failures = 0;
        setStatus(s);
        if (s.running) return;
        setBusy("");
        if (s.last?.status === "ok") {
          const n = moodleTotal(s.last.summary);
          store.notify(n ? `Moodle sync finished — ${n} record${n === 1 ? "" : "s"} imported or updated.` : "Moodle sync finished — everything was already up to date.");
          // Pull the new courses, units, students and marks into the app so they
          // appear without a reload.
          store.refreshHnd?.().catch(() => {});
          store.refreshAssessments?.().catch(() => {});
        } else {
          store.notify(s.last?.error || "The Moodle sync failed.", "error");
        }
      } catch (_) {
        // A dropped poll is harmless, but give up eventually rather than spinning for
        // ever against a server that has gone away or a token that has expired.
        if (!live) return;
        if (++failures >= 10) {
          setBusy("");
          setStatus(s => ({ ...(s || {}), running: false }));
          store.notify("Lost contact with the server while the sync was running. Reopen Settings to see how it finished.", "error");
        }
      }
    };
    const id = setInterval(tick, 2000);
    return () => { live = false; clearInterval(id); };
    // `store` is deliberately not a dependency: useApiStore returns a fresh object on
    // every render, so listing it tore this interval down and rebuilt it continuously.
    // The closure only calls store methods, which are stable enough for that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling]);

  const runPreview = async () => {
    setBusy("preview"); setPreview(null); setShowIssues(false);
    try { setPreview(await api.moodlePreview()); }
    catch (e) { store.notify(e.message || "Could not read Moodle", "error"); }
    finally { setBusy(""); }
  };
  const runSync = async () => {
    setPreview(null); setShowIssues(false);
    try { await api.moodleSync(); setBusy("sync"); setStatus(s => ({ ...(s || {}), running: true })); }
    catch (e) { store.notify(e.message || "Could not start the sync", "error"); }
  };

  const result = preview || (busy !== "sync" ? status?.last : null);
  const counts = MOODLE_COUNTS.filter(([k]) => Number(result?.summary?.[k]) > 0);
  const issues = result?.issues || [];
  const when = status?.last?.finishedAt ? new Date(status.last.finishedAt) : null;

  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70 fade-up">
      <div className="mb-3 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm font-bold text-slate-700"><GraduationCap size={15} style={{ color: NAVY }} /> Moodle (VLE)</p>
        {status && !status.failed && (
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${status.configured ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600"}`}>
            {status.configured ? "Connected" : "Not set up"}
          </span>
        )}
      </div>

      {!status && <div className="skeleton h-20 rounded-xl" />}

      {status?.failed && (
        <p className="flex items-start gap-1.5 rounded-xl bg-rose-50 px-3 py-2 text-[11px] leading-relaxed text-rose-700 ring-1 ring-rose-200">
          <AlertCircle size={13} className="mt-px shrink-0" />{status.failed}
        </p>
      )}

      {status && !status.failed && !status.configured && (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800 ring-1 ring-amber-200">
          Add <b>MOODLE_URL</b> and <b>MOODLE_TOKEN</b> to the server's environment variables,
          then restart it. The token stays on the server and is never sent to this page.
        </p>
      )}

      {status?.configured && (
        <>
          <p className="mb-3 truncate text-[11px] text-slate-400" title={status.url}>{status.url.replace(/^https?:\/\//, "")}</p>
          <p className="mb-3 text-[11px] text-slate-500">
            {status.running || busy === "sync"
              ? <span className="flex items-center gap-1.5 font-semibold text-blue-600"><Loader2 size={12} className="animate-spin" /> Importing from Moodle…</span>
              : when ? <>Last run {when.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} — <b className={status.last.status === "ok" ? "text-emerald-600" : "text-rose-600"}>{status.last.status === "ok" ? "succeeded" : "failed"}</b></>
              : "Never run."}
          </p>

          <div className="mb-3 flex flex-wrap gap-2">
            <button onClick={runPreview} disabled={!!busy || status.running}
              className="press inline-flex items-center gap-1.5 rounded-xl bg-slate-100 px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-200 disabled:opacity-50">
              {busy === "preview" ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Preview
            </button>
            {/* Running a sync needs the registers/students page (server SYNC_PAGES),
                but this card lives on Settings. Without this guard a settings-only
                admin saw an enabled button that 403'd. Preview stays available to all
                (it only reads). */}
            {canSync && (
              <PrimaryBtn onClick={runSync} disabled={!!busy || status.running} className="!px-3 !py-2 !text-xs">
                {busy === "sync" || status.running ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Sync now
              </PrimaryBtn>
            )}
          </div>
          {!canSync && <p className="mb-3 rounded-lg bg-slate-50 px-2.5 py-1.5 text-[11px] font-semibold text-slate-500">You can preview changes here. Running a sync needs the Registers or Students permission.</p>}

          {preview && <p className="mb-2 rounded-lg bg-blue-50 px-2.5 py-1.5 text-[11px] font-semibold text-blue-700">Preview only — nothing has been saved.</p>}

          {result && (counts.length > 0
            ? <div className="grid grid-cols-2 gap-1.5">
                {counts.map(([k, label]) => (
                  <div key={k} className="rounded-xl bg-slate-50 px-2.5 py-2">
                    <p className="text-base font-extrabold leading-none" style={{ color: k === "gradesSkippedManual" ? "#b45309" : NAVY }}>{result.summary[k]}</p>
                    <p className="mt-1 text-[10px] leading-tight text-slate-400">{label}</p>
                  </div>
                ))}
              </div>
            : <p className="rounded-xl bg-slate-50 px-3 py-2 text-[11px] text-slate-500">Nothing to change — Staff Hub already matches Moodle.</p>
          )}

          {issues.length > 0 && (
            <div className="mt-2">
              <button onClick={() => setShowIssues(v => !v)} className="press flex w-full items-center justify-between rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800 ring-1 ring-amber-200">
                <span className="flex items-center gap-1.5"><AlertCircle size={13} /> {issues.length} thing{issues.length === 1 ? "" : "s"} needed a person</span>
                <ChevronDown size={13} className={`transition-transform ${showIssues ? "rotate-180" : ""}`} />
              </button>
              {showIssues && (
                <ul className="mt-1.5 max-h-52 space-y-1 overflow-y-auto rounded-xl bg-slate-50 p-2">
                  {issues.map((m, i) => <li key={i} className="text-[11px] leading-relaxed text-slate-600">• {m}</li>)}
                </ul>
              )}
            </div>
          )}

          <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-relaxed text-slate-400">
            <Info size={12} className="mt-px shrink-0" />
            Reads Moodle only — it never writes back, never deletes anything here, and
            never overwrites a mark someone typed in by hand.
          </p>
        </>
      )}
    </div>
  );
}

/* ----- Dashboard: Timetable (weekly schedule, per course/year/term) ----- */
// 1 = Monday … 7 = Sunday (ISO). The server stores the same.
const TT_DAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const TT_DAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// The period label the college's timetable uses, derived from the start hour.
const periodOf = (start) => { const h = Number(String(start).slice(0, 2)); return h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening"; };
const fmtSlotTime = (s) => `${periodOf(s.start)} ${s.start} – ${s.end}`;

/* ============================================================ ADMISSIONS ============================================================ */
// The college's HND application form, rebuilt as one long entry form an admin fills in.
// The sections and field order mirror the paper/online form so an admin can copy it
// top-to-bottom. Every field is stored as free text on the Admission model; `type`
// only changes the input widget (a date picker, an email keyboard, a Yes/No dropdown).
// `span: 2` makes a field take the full width of the two-column grid (used for the long
// "if yes, give details" answers). Adding a question here + on the Prisma model is all
// it takes to extend the form — the server copies fields off a fixed whitelist.
const YES_NO = ["Yes", "No"];
// The four intake months, and a rolling range of years (this year − 1 … + 5) for the
// intake-year picker.
const INTAKE_MONTHS = ["January", "April", "June", "September"];
// Fallback for the application form's intake dropdown — the real options come from the
// admin-managed AdmissionIntake list (the "Courses & intakes" manager). Until an admin
// adds their own, offer the four standard months across the current and next year.
const INTAKE_FALLBACK = (() => { const y = new Date().getFullYear(); return [y, y + 1].flatMap((yr) => INTAKE_MONTHS.map((m) => `${m} ${yr}`)); })();
// Transcribed verbatim from the college's "EdTech HND Application Form"
// (Microsoft Forms, 61 questions across 9 pages). Question text, option lists, required
// flags and the page/section help notes match the original one-for-one so an admin can
// copy a paper/online application straight down the screen. Fields expecting "N/A" as an
// answer stay as text (a date picker can't hold "N/A"). The "course" field's options are
// replaced at render time with the live courses table (fallback below if it can't load).
export const ADMISSION_SECTIONS = [
  { title: "Course Details", fields: [
    { key: "course", label: "Which course are you applying for", type: "select", required: true, options: ["HND - Business", "HND - Sustainable Business Management", "HND - Leadership and Management"] },
    { key: "intake", label: "Which intake are you applying for?", type: "select", required: true, options: INTAKE_FALLBACK },
    { key: "foundVia", label: "How did you find out about EdTech?", type: "select", required: true, options: ["College Website/Social Media", "Agent", "Family Member", "Friend", "Other"] },
    { key: "classOption", label: "Select the class option you would prefer:", type: "select", hint: "You are required to complete 12hrs of onsite study.", options: ["Two days per week - 10 a.m.-5 p.m (12hrs)", "Two evenings online - 6 p.m.-9 p.m. (6hrs) plus One day In-Campus 10 a.m. - 5 p.m. (6hrs)"] },
    { key: "firstName", label: "First Name", type: "text", required: true },
    { key: "middleName", label: "Middle Name (if any)", type: "text" },
    { key: "surname", label: "Surname", type: "text", required: true },
    { key: "dob", label: "Date of Birth", type: "date", required: true },
    { key: "gender", label: "Gender", type: "select", required: true, options: ["Woman", "Man", "Non-binary", "Prefer not to say"] },
    { key: "email", label: "Email Address", type: "email", required: true },
    { key: "phone", label: "Primary telephone/Mobile Phone", type: "tel", required: true },
    { key: "countryOfBirth", label: "Country of Birth", type: "text", required: true },
    { key: "countryOfCitizenship", label: "Country of citizenship", type: "text", required: true },
    { key: "idDocNo", label: "ID Document (Passport/ID/Driving Licence Etc.) No.", type: "text", required: true },
    { key: "idDateOfIssue", label: "Date of Issue", type: "date", required: true },
    { key: "idDateOfExpiry", label: "Date of Expiry", type: "date", required: true },
    { key: "idIssuingCountry", label: "ID issuing country", type: "text", required: true },
    { key: "niNumber", label: "National Insurance Number (NI Number) (if not held, explain the reason)", type: "text", required: true, span: 2 },
  ] },
  { title: "Home Address", fields: [
    { key: "houseNo", label: "House/Flat No", type: "text", required: true },
    { key: "street", label: "Street", type: "text", required: true },
    { key: "city", label: "City", type: "text", required: true },
    { key: "postCode", label: "Post Code", type: "text", required: true },
    { key: "mailingAddress", label: "Mailing Address (if different from Home address)", type: "textarea", span: 2 },
    { key: "emergencyName", label: "Emergency Contact Name", type: "text", required: true },
    { key: "emergencyPhone", label: "Emergency Contact Phone/Mobile Number", type: "tel", required: true },
    { key: "emergencyRelationship", label: "Emergency Contact Relationship", type: "text", required: true },
    { key: "emergencyEmail", label: "Emergency Contact Email Address", type: "email", required: true },
  ] },
  { title: "Declaration of a criminal record rehabilitation of offender's acts.",
    note: "You are required to state whether you have any criminal convictions, excluding spent sentences (as defined by the Rehabilitation of Offenders Act 1974).",
    fields: [
    { key: "criminalConviction", label: "Have you ever had a criminal conviction?", type: "select", required: true, options: YES_NO },
    { key: "criminalDetails", label: "If yes, please provide further details, including date(s), nature of conviction and punishment imposed. If no, then please write N/A.", type: "textarea", required: true, span: 2 },
  ] },
  { title: "Disabilities",
    note: "The information you provide will be kept confidential and used to support our equal opportunities monitoring, routine academic and administration processes. It may be shared with statutory bodies such as the Higher Education Statistics Agency and the Office for Students in line with data protection laws. EdTech is committed to ensuring that every student is as comfortable as possible during their time with us.",
    fields: [
    { key: "medicalConditions", label: "Do you have any medical conditions that may require special adjustments or arrangements?", type: "select", required: true, options: YES_NO },
    { key: "medicalDetails", label: "If yes, please describe your condition(s) and adjustments/arrangements that EdTech would need to make to support your studies. If no, please write N/A.", type: "textarea", required: true, span: 2 },
    { key: "learningDifficulty", label: "Do you have any learning difficulty?", type: "select", required: true, options: YES_NO },
    { key: "learningDetails", label: "If yes, give details of learning difficulty? (If NO, enter N/A).", type: "textarea", required: true, span: 2 },
  ] },
  { title: "Education and Employment", fields: [
    { key: "englishFirstLanguage", label: "Is English your first language?", type: "select", required: true, options: YES_NO },
    { key: "englishProof", label: "If no, how will you provide proof of your English language proficiency?", type: "select", required: true, options: ["IELTS", "B2 level English or Equivalent", "Functional Skills or level 2", "Other"] },
    { key: "englishProofOther", label: "If you have selected others please specify, otherwise enter N/A.", type: "text", required: true, span: 2 },
    { key: "highestEducation", label: "What is the Highest level of education that you have completed?", type: "select", required: true, options: ["Level 3", "Level 2", "High School", "GCSE/ A levels", "Other"] },
    { key: "overseasQualification", label: "If overseas, please provide details of the qualification; otherwise, write N/A.", type: "textarea", required: true, span: 2 },
    { key: "appliedElsewhere", label: "Have you applied for HND business in any other College/University?", type: "select", required: true, options: YES_NO },
    { key: "previousStudentFinance", label: "Have you previously received student finance for any higher education course?", type: "select", required: true, options: YES_NO },
    { key: "previousFinanceDetails", label: "If Yes to above question, please provide details: Course Name, Institution, and Admission Year. Note: Full disclosure is mandatory. Previous study may affect your future student finance entitlement (Tuition and Maintenance Loans). Non-disclosure will result in the revocation of your admission. (If you said No to previous question, just put N/A)", type: "textarea", required: true, span: 2 },
    { key: "fundingIntent", label: "Please let us know how you intend to fund (£6185 per year)", type: "select", required: true, options: ["Student Loans Company", "Other"] },
    { key: "fundingOther", label: "If you have selected other, please specify; Otherwise enter N/A.", type: "text", required: true, span: 2 },
    { key: "employmentStatus", label: "What is your current employment status", type: "select", required: true, options: ["Employed", "Unemployed", "Self-Employed"] },
    { key: "employmentDetails", label: "If you are currently working, give details of your employment. (If you are not working put N/A)", type: "textarea", required: true, span: 2 },
    { key: "jobTitle", label: "Job title (If you are not working put N/A)", type: "text", required: true },
    { key: "companyName", label: "Company Name (If you are not working put N/A)", type: "text", required: true },
    { key: "dateStarted", label: "Date Started (If not working put N/A)", type: "text", required: true },
    { key: "workedPast", label: "Have you worked as employed or self employed person in past?", type: "select", required: true, options: YES_NO },
    { key: "workedPastDetails", label: "If you have been employed or self employed in past, (you may include voluntary work) give details here:", type: "textarea", span: 2 },
  ] },
  { title: "Reference 1", fields: [
    { key: "ref1Name", label: "Name", type: "text", required: true },
    { key: "ref1Contact", label: "Contact No", type: "tel", required: true },
    { key: "ref1Email", label: "Email", type: "email", required: true },
    { key: "ref1Relationship", label: "Relationship to you (Family, Friend, brother, sister, etc.)", type: "text", required: true, span: 2 },
  ] },
  { title: "Reference 2", fields: [
    { key: "ref2Name", label: "Name", type: "text", required: true },
    { key: "ref2Role", label: "Role", type: "text", required: true },
    { key: "ref2Organisation", label: "Institution/Organisation", type: "text", required: true },
    { key: "ref2Relationship", label: "Relationship to you (Manager, Supervisor, Colleague, owner)", type: "text", required: true, span: 2 },
  ] },
  { title: "EDI",
    note: "The data in the EDI section is being collected to meet legal/statutory duties and improve support to students. All data collected will be handled securely in line with GDPR.",
    fields: [
    { key: "ethnicity", label: "Ethnicity", type: "select", required: true, options: ["White British", "European", "White other", "Asian, British Asian", "Black, Black British", "Mixed", "Other", "Prefer not to say"] },
    { key: "religion", label: "Religion", type: "select", required: true, options: ["Christianity", "Hinduism", "Islam", "Buddhism", "Sikhism", "Judaism", "Other", "Prefer not to say"] },
  ] },
  { title: "Declaration",
    note: "I, the undersigned, hereby declare that the information provided in this application form is true and accurate to the best of my knowledge. I understand that any false or incorrect information may result in the rejection of my application for admission and/or the withdrawal of my registration at EdTech. Furthermore, I authorise EdTech to carry out any necessary checks to verify the information provided, including contacting previous employers, educational institutions, referees, and any other organisations listed in my application. I also confirm that I have been informed of and understand the following requirements of EdTech: (1) A minimum attendance of 85% is required. (2) If I have been referred by an agent, I confirm that all the above information has been clearly explained to me. (3) All assignments must be submitted by the stated deadlines in order to progress to the second year and successfully complete the course. By signing this application form, I confirm that I have read, understood, and agree to the above declaration.",
    fields: [
    { key: "signature", label: "Signature — write down your full name here", type: "text", required: true, span: 2 },
    { key: "declarationDate", label: "Date", type: "date", required: true },
  ] },
];
// The keys the form requires (asterisked in the original). Used to block save until filled.
export const ADMISSION_REQUIRED = ADMISSION_SECTIONS.flatMap(s => s.fields.filter(f => f.required).map(f => f.key));
// Every field key, flattened — used to build a blank form and to map a saved row back.
// `intakeYear` is appended even though it's no longer a form field: legacy rows (created
// before intake became a single combined label) still carry a separate year, so including
// the key lets an edit round-trip it instead of silently nulling it — which would also
// wrongly move the applicant's SharePoint folder on the next save.
const ADMISSION_KEYS = [...ADMISSION_SECTIONS.flatMap(s => s.fields.map(f => f.key)), "intakeYear"];
const blankAdmission = () => Object.fromEntries(ADMISSION_KEYS.map(k => [k, ""]));
// A saved row (nulls) → a form (empty strings), so inputs stay controlled.
const admissionForm = (r) => Object.fromEntries(ADMISSION_KEYS.map(k => [k, r[k] ?? ""]));
const admissionName = (r) => `${r.firstName || ""} ${r.surname || ""}`.trim();

/* ============================================================ SLC (student loans) ============================================================ */
// Student Loans Company tracking — which students have applied for a student loan and the
// current status of each application. Standalone records the admin adds/edits; a form can
// be pre-filled by picking an applicant from Admissions.
const SLC_STATUSES = ["Not applied", "Applied", "Awaiting evidence", "Approved", "In payment", "Paid", "Declined", "Cancelled"];
const SLC_LOAN_TYPES = ["Tuition Fee Loan", "Maintenance Loan", "Both", "Other"];
const SLC_STATUS_STYLE = {
  "Not applied": "bg-slate-100 text-slate-500",
  "Applied": "bg-sky-50 text-sky-700",
  "Awaiting evidence": "bg-amber-50 text-amber-700",
  "Approved": "bg-emerald-50 text-emerald-700",
  "In payment": "bg-indigo-50 text-indigo-700",
  "Paid": "bg-green-50 text-green-700",
  "Declined": "bg-rose-50 text-rose-700",
  "Cancelled": "bg-slate-100 text-slate-400",
};
const blankSlc = () => ({ studentName: "", studentRef: "", course: "", intake: "", status: "Not applied", loanType: "", crn: "", applicationDate: "", decisionDate: "", amount: "", notes: "", admissionId: "" });

function AdminSlc({ store }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [modal, setModal] = useState(false);   // false | "add" | <id> (editing)
  const [form, setForm] = useState(blankSlc);
  const [saving, setSaving] = useState(false);
  const [del, setDel] = useState(null);
  const [applicants, setApplicants] = useState([]);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try { setRows(await api.slcList()); }
    catch (e) { setErr(e.message || "Could not load SLC records"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.admissions().then(setApplicants).catch(() => {}); }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const openAdd = () => { setForm(blankSlc()); setModal("add"); };
  const openEdit = (r) => { setForm({ studentName: r.studentName || "", studentRef: r.studentRef || "", course: r.course || "", intake: r.intake || "", status: r.status || "Not applied", loanType: r.loanType || "", crn: r.crn || "", applicationDate: r.applicationDate || "", decisionDate: r.decisionDate || "", amount: r.amount || "", notes: r.notes || "", admissionId: r.admissionId || "" }); setModal(r.id); };

  // Picking an applicant fills name/ID/course/intake but leaves them editable.
  const pickApplicant = (id) => {
    const a = applicants.find(x => x.id === id);
    if (!a) { set("admissionId", ""); return; }
    setForm(f => ({ ...f, admissionId: a.id,
      studentName: [a.firstName, a.surname].filter(Boolean).join(" ") || f.studentName,
      studentRef: a.studentId || f.studentRef,
      course: a.course || f.course,
      intake: [a.intake, a.intakeYear].filter(Boolean).join(" ") || f.intake }));
  };

  const save = async () => {
    if (!form.studentName.trim()) { store.notify("Enter the student's name", "error"); return; }
    setSaving(true);
    try {
      if (modal === "add") await api.addSlc(form); else await api.updateSlc(modal, form);
      store.notify(modal === "add" ? "SLC record added" : "SLC record updated", "success");
      setModal(false); await load();
    } catch (e) { store.notify(e.message || "Could not save the record", "error"); }
    setSaving(false);
  };
  const remove = async () => {
    const r = del; setDel(null); if (!r) return;
    try { await api.removeSlc(r.id); store.notify("Record deleted"); await load(); }
    catch (e) { store.notify(e.message || "Could not delete", "error"); }
  };

  const counts = {}; rows.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const applied = rows.filter(r => r.status !== "Not applied").length;
  const q = query.trim().toLowerCase();
  const filtered = rows.filter(r => (!statusFilter || r.status === statusFilter) && (!q || `${r.studentName} ${r.studentRef} ${r.course} ${r.crn}`.toLowerCase().includes(q)));

  const exportCsv = () => {
    const cols = ["studentName", "studentRef", "course", "intake", "status", "loanType", "crn", "applicationDate", "decisionDate", "amount", "notes", "updatedBy"];
    const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const csv = [cols.join(","), ...filtered.map(r => cols.map(c => esc(r[c])).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = "slc-records.csv"; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const badge = (s) => <span className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-bold ${SLC_STATUS_STYLE[s] || "bg-slate-100 text-slate-500"}`}>{s}</span>;

  return (
    <>
      <AdminHeader title="SLC — Student Loans" subtitle="Student Loans Company applications & status"
        Icon={Wallet}
        action={<div className="flex items-center gap-2"><ExportBtn onClick={exportCsv} /><PrimaryBtn onClick={openAdd}><Plus size={16} /> New record</PrimaryBtn></div>} />

      {err && <div className="mb-4 flex items-start gap-2 rounded-xl bg-rose-50 px-3.5 py-3 text-sm font-semibold text-rose-700 ring-1 ring-rose-200"><AlertCircle size={16} className="mt-px shrink-0" />{err}</div>}

      {loading ? <div className="skeleton h-64 rounded-2xl" /> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
            {SLC_STATUSES.map(s => (
              <button key={s} onClick={() => setStatusFilter(f => f === s ? "" : s)} className={`rounded-xl p-3 text-left ring-1 transition ${statusFilter === s ? "ring-2" : "ring-slate-200"} ${SLC_STATUS_STYLE[s] || "bg-slate-50 text-slate-600"}`}>
                <p className="text-xl font-extrabold leading-none">{counts[s] || 0}</p>
                <p className="mt-1 text-[10px] font-bold leading-tight">{s}</p>
              </button>
            ))}
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="text-sm text-slate-500"><b className="text-slate-700">{applied}</b> of {rows.length} have applied</span>
            <div className="ml-auto flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200"><Search size={15} className="text-slate-400" /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name, ID, course, CRN…" className="w-56 bg-transparent text-sm outline-none" /></div>
            {statusFilter && <button onClick={() => setStatusFilter("")} className="text-xs font-semibold text-blue-600">Clear filter</button>}
          </div>

          <div className="overflow-hidden rounded-2xl bg-white ring-1 ring-slate-200">
            <div className="overflow-x-auto max-w-full">
              <table className="w-full min-w-[900px] text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2">Student</th><th className="px-3 py-2">Course / Intake</th><th className="px-3 py-2">Loan type</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">CRN</th><th className="px-3 py-2">Applied</th><th className="px-3 py-2">Decision</th><th className="px-3 py-2">Amount</th><th className="px-3 py-2 text-right">Actions</th>
                </tr></thead>
                <tbody>
                  {filtered.map(r => (
                    <tr key={r.id} className="border-t border-slate-50 align-top hover:bg-slate-50/60">
                      <td className="px-3 py-2"><p className="font-semibold text-slate-700">{r.studentName}</p>{r.studentRef && <p className="text-[11px] text-slate-400">{r.studentRef}</p>}</td>
                      <td className="px-3 py-2 text-slate-500">{r.course || "—"}{r.intake ? ` · ${r.intake}` : ""}</td>
                      <td className="px-3 py-2 text-slate-500">{r.loanType || "—"}</td>
                      <td className="px-3 py-2">{badge(r.status)}</td>
                      <td className="px-3 py-2 text-slate-500">{r.crn || "—"}</td>
                      <td className="px-3 py-2 text-slate-500">{r.applicationDate ? fmtDate(r.applicationDate) : "—"}</td>
                      <td className="px-3 py-2 text-slate-500">{r.decisionDate ? fmtDate(r.decisionDate) : "—"}</td>
                      <td className="px-3 py-2 text-slate-500">{r.amount || "—"}</td>
                      <td className="px-3 py-2 text-right"><div className="flex justify-end gap-1"><button onClick={() => openEdit(r)} title="Edit" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><Edit3 size={15} /></button><button onClick={() => setDel(r)} title="Delete" className="rounded-lg p-1.5 text-rose-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 size={15} /></button></div></td>
                    </tr>
                  ))}
                  {filtered.length === 0 && <tr><td colSpan={9} className="px-3 py-10 text-center text-sm text-slate-400">No SLC records{statusFilter || q ? " match your filter" : " yet — add one with “New record”"}.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <Modal open={!!modal} onClose={() => setModal(false)} title={modal === "add" ? "New SLC record" : "Edit SLC record"} width={640}>
        {applicants.length > 0 && (
          <Field label="Pick an applicant (optional — fills the details below)">
            <select value={form.admissionId} onChange={e => pickApplicant(e.target.value)} className={inputCls}>
              <option value="">— none —</option>
              {applicants.map(a => <option key={a.id} value={a.id}>{[a.firstName, a.surname].filter(Boolean).join(" ")}{a.course ? ` — ${a.course}` : ""}</option>)}
            </select>
          </Field>
        )}
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Student name *"><input value={form.studentName} onChange={e => set("studentName", e.target.value)} className={inputCls} /></Field>
          <Field label="Student / College ID"><input value={form.studentRef} onChange={e => set("studentRef", e.target.value)} className={inputCls} /></Field>
          <Field label="Course"><input value={form.course} onChange={e => set("course", e.target.value)} className={inputCls} /></Field>
          <Field label="Intake"><input value={form.intake} onChange={e => set("intake", e.target.value)} className={inputCls} /></Field>
          <Field label="Application status"><select value={form.status} onChange={e => set("status", e.target.value)} className={inputCls}>{SLC_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}</select></Field>
          <Field label="Loan type"><select value={form.loanType} onChange={e => set("loanType", e.target.value)} className={inputCls}><option value="">—</option>{SLC_LOAN_TYPES.map(s => <option key={s} value={s}>{s}</option>)}</select></Field>
          <Field label="SLC reference (CRN)"><input value={form.crn} onChange={e => set("crn", e.target.value)} className={inputCls} /></Field>
          <Field label="Amount"><input value={form.amount} onChange={e => set("amount", e.target.value)} placeholder="e.g. £9,250" className={inputCls} /></Field>
          <Field label="Application date"><input type="date" value={form.applicationDate} onChange={e => set("applicationDate", e.target.value)} className={inputCls} /></Field>
          <Field label="Decision date"><input type="date" value={form.decisionDate} onChange={e => set("decisionDate", e.target.value)} className={inputCls} /></Field>
        </div>
        <div className="mt-3"><Field label="Notes"><textarea rows={3} value={form.notes} onChange={e => set("notes", e.target.value)} className={`${inputCls} resize-y`} /></Field></div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={() => setModal(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-50">Cancel</button>
          <PrimaryBtn onClick={save} disabled={saving} colour={NAVY}>{saving ? <><Loader2 size={16} className="animate-spin" /> Saving…</> : <><Save size={16} /> Save record</>}</PrimaryBtn>
        </div>
      </Modal>

      <Modal open={!!del} onClose={() => setDel(null)} title="Delete SLC record?">
        <p className="text-sm leading-relaxed text-slate-600">Delete the SLC record for <b>{del?.studentName}</b>? This can't be undone.</p>
        <div className="mt-5 flex gap-2"><button onClick={() => setDel(null)} className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-50">Cancel</button><PrimaryBtn colour={MAROON} onClick={remove} className="flex-1"><Trash2 size={16} /> Delete</PrimaryBtn></div>
      </Modal>
    </>
  );
}

/* ============================================================ ATTENDANCE EMAILS ============================================================ */
// Automated month-end attendance emails. Students are banded by their attendance % for the
// CURRENT semester; each band has its own editable template. The admin reviews the bands,
// edits the templates + signature/contacts, turns automation on (sends on the last day of
// each month), and can also send this month's emails immediately. Overall % and per-module
// figures are computed and re-verified on the server.
const BAND_STYLE = {
  excellent: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  great: "bg-green-50 text-green-700 ring-green-200",
  good: "bg-sky-50 text-sky-700 ring-sky-200",
  average: "bg-amber-50 text-amber-700 ring-amber-200",
  risk: "bg-orange-50 text-orange-700 ring-orange-200",
  highrisk: "bg-rose-50 text-rose-700 ring-rose-200",
};
// The institution/tutor placeholders the admin fills once (used to build the Settings form).
const ATTENDANCE_VALUE_FIELDS = [
  { key: "tutorName", label: "Tutor / sender name" },
  { key: "jobTitle", label: "Job title" },
  { key: "department", label: "Department / Programme" },
  { key: "institution", label: "Institution" },
  { key: "vle", label: "VLE (e.g. Moodle)" },
  { key: "officeHours", label: "Office hours / drop-in" },
  { key: "patContact", label: "Personal Academic Tutor contact" },
  { key: "wellbeingContact", label: "Wellbeing contact" },
  { key: "academicSkillsContact", label: "Academic skills contact" },
  { key: "financeContact", label: "Financial guidance contact" },
  { key: "internationalContact", label: "International student advice" },
  { key: "suContact", label: "Students' Union advice" },
  { key: "escalationContact", label: "Escalates to (name / role)" },
  { key: "directNumber", label: "Direct contact number" },
  { key: "ecProcess", label: "Extenuating Circumstances name" },
];
// Client-side placeholder fill for the live preview (the server does the real fill on send).
const previewAttendance = (t, vals, s, period) => String(t || "").replace(/\{(\w+)\}/g, (_, k) => {
  if (k === "modules") return s?.modules?.length ? "Your attendance by module this term:\n" + s.modules.map(m => `• ${m.code} ${m.name} — ${m.pct}%`).join("\n") : "";
  const dyn = {
    firstName: s?.firstName, lastName: s?.lastName, name: s?.name, pct: s?.pct == null ? "" : s?.pct,
    period, programme: s?.programme, missedRate: s?.pct == null ? "" : Math.max(0, Math.round((100 - s.pct) / 10)),
    respondByDate: "(the reply-by date)",
  };
  const v = dyn[k] != null && dyn[k] !== "" ? dyn[k] : vals?.[k];
  return v == null ? "" : String(v);
});

function AdminAttendanceEmails({ store }) {
  const [data, setData] = useState(null);       // { semester, period, bands[], students[] }
  const [config, setConfig] = useState(null);   // { autoEnabled, respondDays, sendHour, values, templates, lastRunPeriod }
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [bandFilter, setBandFilter] = useState("");
  const [query, setQuery] = useState("");
  const [showConfig, setShowConfig] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmRun, setConfirmRun] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState(null);
  const [sendingId, setSendingId] = useState(null);
  const [range, setRange] = useState({ from: "", to: "" });  // custom reporting period; both blank = auto current term

  const load = useCallback(async (r) => {
    setLoading(true); setErr("");
    try {
      const useR = r && r.from && r.to ? r : null;
      const [d, c] = await Promise.all([api.attendanceEmailData(useR?.from, useR?.to), api.attendanceEmailConfig()]);
      setData(d); setConfig(c);
    } catch (e) { setErr(e.message || "Could not load attendance data"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const applyRange = () => { if (range.from && range.to) load(range); };
  const resetRange = () => { setRange({ from: "", to: "" }); load({ from: "", to: "" }); };

  const setCfg = (patch) => setConfig(c => ({ ...c, ...patch }));
  const setValue = (k, v) => setConfig(c => ({ ...c, values: { ...c.values, [k]: v } }));
  const setTemplate = (band, field, v) => setConfig(c => ({ ...c, templates: { ...c.templates, [band]: { ...c.templates[band], [field]: v } } }));

  const saveConfig = async () => {
    setSaving(true);
    try {
      const saved = await api.saveAttendanceEmailConfig({
        autoEnabled: config.autoEnabled, respondDays: config.respondDays, sendHour: config.sendHour,
        values: config.values, templates: config.templates,
      });
      setConfig(saved);
      store.notify("Attendance email settings saved", "success");
    } catch (e) { store.notify(e.message || "Could not save settings", "error"); }
    setSaving(false);
  };

  const runNow = async () => {
    setConfirmRun(false); setRunning(true); setRunResult(null);
    try {
      const res = await api.runAttendanceEmails({ force: true, from: range.from || undefined, to: range.to || undefined });
      setRunResult(res);
      if (res.ok) { store.notify(`Sent ${res.sent} · failed ${res.failed} · skipped ${res.skipped}`, res.failed ? "error" : "success"); await load(range); }
      else store.notify(res.reason === "no-current-term" ? "No current term" : "Nothing to send", "info");
    } catch (e) { store.notify(e.message || "Could not send", "error"); }
    setRunning(false);
  };

  // Send ONE student their band email now (the per-student send, alongside the bulk run).
  const sendOne = async (s) => {
    setSendingId(s.id);
    try {
      const res = await api.sendAttendanceEmailToStudent(s.id, { from: range.from || undefined, to: range.to || undefined });
      store.notify(`Emailed ${res.student || s.name} — ${res.band || s.bandLabel}`, "success");
    } catch (e) { store.notify(e.message || "Could not send the email", "error"); }
    setSendingId(null);
  };

  if (loading && !data) return (<><AdminHeader title="Attendance Emails" subtitle="Automated month-end attendance emails" Icon={Mail} /><div className="skeleton h-64 rounded-2xl" /></>);

  const term = data?.term;
  const students = data?.students || [];
  const bandsArr = data?.bands || [];
  const bandLabel = (k) => (bandsArr.find(b => b.key === k) || {}).label || k;
  const withData = students.filter(s => s.bandKey);
  const noData = students.length - withData.length;
  const qq = query.trim().toLowerCase();
  const shown = students.filter(s => s.bandKey && (!bandFilter || s.bandKey === bandFilter) && (!qq || `${s.name} ${s.email} ${s.programme}`.toLowerCase().includes(qq)));

  return (
    <>
      <AdminHeader title="Attendance Emails" subtitle="Automated month-end attendance emails — banded by attendance"
        Icon={Mail}
        action={<div className="flex items-center gap-2">
          <button onClick={() => setShowConfig(v => !v)} className="press flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"><Settings size={14} /> Settings</button>
          <PrimaryBtn onClick={() => setConfirmRun(true)} disabled={!term || running}>{running ? <><Loader2 size={16} className="animate-spin" /> Sending…</> : <><Send size={16} /> {data?.custom ? "Send for this range now" : "Send this month now"}</>}</PrimaryBtn>
        </div>} />

      {err && <div className="mb-4 flex items-start gap-2 rounded-xl bg-rose-50 px-3.5 py-3 text-sm font-semibold text-rose-700 ring-1 ring-rose-200"><AlertCircle size={16} className="mt-px shrink-0" />{err}</div>}

      {/* Reporting period — leave blank for the auto current term, or pick a From–To range to
          recalculate the %, bands and email period over any month. */}
      <div className="mb-4 flex flex-wrap items-end gap-x-4 gap-y-3 rounded-2xl bg-white p-4 ring-1 ring-slate-200">
        <div className="mr-auto">
          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Reporting period</p>
          <p className="max-w-xs text-xs text-slate-400">Leave blank to use the current term, or pick a date range to send for any month.</p>
        </div>
        <div><label className="block text-[10px] font-bold uppercase tracking-wide text-slate-400">From</label><input type="date" value={range.from} onChange={e => setRange(r => ({ ...r, from: e.target.value }))} className={`${inputCls} mt-1`} /></div>
        <div><label className="block text-[10px] font-bold uppercase tracking-wide text-slate-400">To</label><input type="date" value={range.to} onChange={e => setRange(r => ({ ...r, to: e.target.value }))} className={`${inputCls} mt-1`} /></div>
        <button onClick={applyRange} disabled={!range.from || !range.to || loading} className="press h-[38px] rounded-lg px-3.5 text-xs font-bold text-white transition disabled:opacity-40" style={{ background: NAVY }}>Apply range</button>
        {(data?.custom || range.from || range.to) && <button onClick={resetRange} disabled={loading} className="press h-[38px] rounded-lg border border-slate-200 px-3.5 text-xs font-bold text-slate-600 hover:bg-slate-50">Current term</button>}
        {data?.custom && <span className="inline-flex items-center rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700 ring-1 ring-blue-200">Custom · {term?.start} → {term?.end}</span>}
      </div>

      {!term ? (
        <div className="rounded-2xl bg-amber-50 p-6 text-center ring-1 ring-amber-200">
          <CalendarClock size={28} className="mx-auto mb-2 text-amber-500" />
          <p className="font-bold text-amber-800">No current term</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-amber-700">The current term is taken from the units running now on your registers. Set the teaching <b>start &amp; end dates</b> on the current units (Registers) so this term is detected — or pick a <b>From–To date range</b> above to send for a specific period right now.</p>
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl bg-white p-4 ring-1 ring-slate-200">
            <div><p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{data?.custom ? "Reporting period" : "Current term"}</p><p className="text-sm font-bold text-slate-700">{term.name || "—"}</p><p className="text-xs text-slate-400">{term.start} → {term.end}</p></div>
            <div><p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Students with data</p><p className="text-sm font-bold text-slate-700">{withData.length}{noData ? <span className="font-normal text-slate-400"> · {noData} no marks yet</span> : null}</p></div>
            <div className="ml-auto flex items-center gap-2">
              <span className={`rounded-full px-3 py-1 text-xs font-bold ${config?.autoEnabled ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{config?.autoEnabled ? "Automation ON" : "Automation OFF"}</span>
              {config?.lastRunPeriod && <span className="text-xs text-slate-400">last sent {config.lastRunPeriod}</span>}
            </div>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {bandsArr.map(b => (
              <button key={b.key} onClick={() => setBandFilter(f => f === b.key ? "" : b.key)} className={`rounded-xl p-3 text-left ring-1 transition ${bandFilter === b.key ? "ring-2" : "ring-slate-200"} ${BAND_STYLE[b.key] || "bg-slate-50 text-slate-600 ring-slate-200"}`}>
                <p className="text-2xl font-extrabold leading-none">{b.count}</p>
                <p className="mt-1 text-[11px] font-bold leading-tight">{b.label}</p>
                <p className="text-[10px] opacity-70">{b.min}–{b.max}%</p>
              </button>
            ))}
          </div>

          <div className="overflow-hidden rounded-2xl bg-white ring-1 ring-slate-200">
            <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
              <Search size={15} className="text-slate-400" />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name, email, programme…" className="w-full bg-transparent text-sm outline-none" />
              {bandFilter && <button onClick={() => setBandFilter("")} className="shrink-0 text-xs font-semibold text-blue-600">Clear filter</button>}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[780px] text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2">Student</th><th className="px-3 py-2">Programme</th><th className="px-3 py-2 text-right">Overall</th><th className="px-3 py-2">Band</th><th className="px-3 py-2">Modules (this term)</th><th className="px-3 py-2 text-right">Send</th>
                </tr></thead>
                <tbody>
                  {shown.map(s => (
                    <tr key={s.id} className="border-t border-slate-50 align-top hover:bg-slate-50/60">
                      <td className="px-3 py-2"><p className="font-semibold text-slate-700">{s.name}</p><p className="text-[11px] text-slate-400">{s.email}</p></td>
                      <td className="px-3 py-2 text-slate-500">{s.programme || "—"}</td>
                      <td className="px-3 py-2 text-right font-bold text-slate-700">{s.pct}%</td>
                      <td className="px-3 py-2"><span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${BAND_STYLE[s.bandKey] || ""}`}>{bandLabel(s.bandKey)}</span></td>
                      <td className="px-3 py-2 text-[11px] text-slate-500">{s.modules?.length ? s.modules.map(m => `${m.code} ${m.pct}%`).join(" · ") : "—"}</td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => sendOne(s)} disabled={sendingId === s.id || !s.email || !s.bandKey}
                          title={!s.email ? "No email on file" : !s.bandKey ? "No attendance yet" : "Email this student now"}
                          className="press inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-bold text-white transition disabled:opacity-40" style={{ background: NAVY }}>
                          {sendingId === s.id ? <Loader2 size={13} className="animate-spin" /> : <><Send size={13} /> Send</>}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {shown.length === 0 && <tr><td colSpan={6} className="px-3 py-10 text-center text-sm text-slate-400">No students match.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          {runResult && runResult.ok && (
            <div className="mt-4 rounded-2xl bg-white p-4 text-sm ring-1 ring-slate-200">
              <p className="font-bold text-slate-700">Last send · {runResult.term || runResult.period}</p>
              <p className="mt-1 text-slate-500">{runResult.sent} sent, {runResult.failed} failed, {runResult.skipped} skipped</p>
              {runResult.errors?.length > 0 && <ul className="mt-2 list-disc pl-4 text-xs text-rose-600">{runResult.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
            </div>
          )}
        </>
      )}

      {/* Settings modal — automation, signature/contacts, per-band templates + preview */}
      <Modal open={showConfig && !!config} onClose={() => setShowConfig(false)} title="Attendance email settings" width={860}>
        <div className="max-h-[68vh] overflow-y-auto pr-1">
          <div className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <label className="flex items-center gap-2 text-sm font-bold text-slate-700">
              <input type="checkbox" checked={!!config?.autoEnabled} onChange={e => setCfg({ autoEnabled: e.target.checked })} className="h-4 w-4 accent-blue-600" />
              Send automatically on the last day of each month
            </label>
            <div className="mt-3 flex flex-wrap gap-4">
              <div><label className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Send at hour (0–23)</label><input type="number" min={0} max={23} value={config?.sendHour ?? 9} onChange={e => setCfg({ sendHour: Number(e.target.value) })} className={`${inputCls} mt-1 w-24`} /></div>
              <div><label className="text-[11px] font-bold uppercase tracking-wide text-slate-400">"Respond by" working days</label><input type="number" min={1} max={30} value={config?.respondDays ?? 5} onChange={e => setCfg({ respondDays: Number(e.target.value) })} className={`${inputCls} mt-1 w-24`} /></div>
            </div>
            <p className="mt-2 text-[11px] text-slate-400">Scoped to the current semester and sent to every enrolled student, using the template for their attendance band.</p>
          </div>

          <p className="mb-2 mt-5 text-sm font-extrabold" style={{ color: NAVY_DARK }}>Signature &amp; contacts</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {ATTENDANCE_VALUE_FIELDS.map(f => (
              <Field key={f.key} label={f.label}><input value={config?.values?.[f.key] ?? ""} onChange={e => setValue(f.key, e.target.value)} className={inputCls} /></Field>
            ))}
          </div>

          <p className="mb-2 mt-5 text-sm font-extrabold" style={{ color: NAVY_DARK }}>Band templates</p>
          <p className="mb-3 text-[11px] leading-relaxed text-slate-400">Placeholders: <b>{"{firstName}"}</b> <b>{"{pct}"}</b> <b>{"{period}"}</b> <b>{"{programme}"}</b> <b>{"{missedRate}"}</b> <b>{"{modules}"}</b> plus the signature/contact fields above. <b>{"{modules}"}</b> becomes the per-module table.</p>
          <div className="flex flex-col gap-3">
            {bandsArr.map(b => {
              const sample = students.find(s => s.bandKey === b.key);
              return (
                <details key={b.key} className="rounded-xl ring-1 ring-slate-200">
                  <summary className="flex cursor-pointer items-center gap-2 px-4 py-2.5 text-sm font-bold text-slate-700"><span className={`rounded-full px-2 py-0.5 text-[10px] ring-1 ${BAND_STYLE[b.key]}`}>{b.min}–{b.max}%</span> {b.label} <span className="ml-auto text-[11px] font-normal text-slate-400">{b.count} student{b.count === 1 ? "" : "s"}</span></summary>
                  <div className="border-t border-slate-100 p-4">
                    <Field label="Subject"><input value={config?.templates?.[b.key]?.subject ?? ""} onChange={e => setTemplate(b.key, "subject", e.target.value)} className={inputCls} /></Field>
                    <div className="mt-3"><Field label="Body"><textarea rows={10} value={config?.templates?.[b.key]?.body ?? ""} onChange={e => setTemplate(b.key, "body", e.target.value)} className={`${inputCls} resize-y font-mono text-xs`} /></Field></div>
                    {sample && (
                      <div className="mt-3 rounded-lg bg-slate-50 p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Preview · {sample.name} ({sample.pct}%)</p>
                        <p className="mt-1 text-xs font-bold text-slate-600">{previewAttendance(config?.templates?.[b.key]?.subject, config?.values, sample, data?.period)}</p>
                        <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-slate-500">{previewAttendance(config?.templates?.[b.key]?.body, config?.values, sample, data?.period)}</p>
                      </div>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2 border-t border-slate-100 pt-4">
          <button onClick={() => setShowConfig(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-50">Close</button>
          <PrimaryBtn onClick={saveConfig} disabled={saving} colour={NAVY}>{saving ? <><Loader2 size={16} className="animate-spin" /> Saving…</> : <><Save size={16} /> Save settings</>}</PrimaryBtn>
        </div>
      </Modal>

      {/* Run-now confirm */}
      <Modal open={confirmRun} onClose={() => setConfirmRun(false)} title={data?.custom ? "Send attendance emails for this range?" : "Send this month's attendance emails?"}>
        <p className="text-sm leading-relaxed text-slate-600">This emails <b>every enrolled student</b> in <b>{term?.name}</b> their band's template, with their overall % and per-module breakdown. Students with no attendance marks yet are skipped.{data?.custom && <span className="mt-2 block text-[12px] font-semibold text-blue-700">Custom period: {term?.start} → {term?.end}. Figures are recalculated over these dates.</span>}</p>
        {!config?.values?.tutorName && <p className="mt-2 flex items-start gap-1.5 text-[12px] font-semibold text-amber-600"><AlertCircle size={13} className="mt-px shrink-0" /> Tip: fill the signature fields in Settings first, or the sign-off will be blank.</p>}
        <div className="mt-5 flex gap-2">
          <button onClick={() => setConfirmRun(false)} className="flex-1 rounded-xl border border-slate-200 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-50">Cancel</button>
          <PrimaryBtn colour={MAROON} onClick={runNow} className="flex-1"><Send size={16} /> Send now</PrimaryBtn>
        </div>
      </Modal>
    </>
  );
}

// The "Courses & intakes" manager — a modal on the Admissions page where an admin curates
// the course and intake lists that applicants pick from on the public application form.
// Independent of Moodle: what's here is exactly what a prospective student can choose.
function AdmissionConfigManager({ open, onClose, store, onSaved }) {
  const [courses, setCourses] = useState([]);
  const [intakes, setIntakes] = useState([]);
  const [newCourse, setNewCourse] = useState("");
  const [newIntake, setNewIntake] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, i] = await Promise.all([api.admissionCourseList(), api.admissionIntakeList()]);
      setCourses(Array.isArray(c) ? c : []); setIntakes(Array.isArray(i) ? i : []);
    } catch (e) { store.notify(e.message || "Could not load courses & intakes", "error"); }
    setLoading(false);
  }, [store]);
  useEffect(() => { if (open) load(); }, [open, load]);

  // Run a mutation, then reload the modal's lists and tell the parent to refresh its dropdowns.
  const run = async (fn) => { setBusy(true); try { await fn(); await load(); onSaved?.(); } catch (e) { store.notify(e.message || "Something went wrong", "error"); } setBusy(false); };
  const addCourse = () => { const name = newCourse.trim(); if (!name) return; run(async () => { await api.addAdmissionCourse(name); setNewCourse(""); }); };
  const addIntake = () => { const label = newIntake.trim(); if (!label) return; run(async () => { await api.addAdmissionIntake(label); setNewIntake(""); }); };

  const list = (rows, kind) => (
    rows.length === 0
      ? <p className="rounded-lg bg-slate-50 px-3 py-4 text-center text-xs text-slate-400 ring-1 ring-slate-200">None yet — add one above.</p>
      : <ul className="flex flex-col gap-1.5">
          {rows.map(r => (
            <li key={r.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${r.active ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50"}`}>
              <span className={`min-w-0 flex-1 truncate text-sm font-semibold ${r.active ? "text-slate-700" : "text-slate-400 line-through"}`} title={r.name || r.label}>{r.name || r.label}</span>
              <button title={r.active ? "Hide from the application form" : "Show on the application form"} disabled={busy}
                onClick={() => run(() => kind === "course" ? api.updateAdmissionCourse(r.id, { active: !r.active }) : api.updateAdmissionIntake(r.id, { active: !r.active }))}
                className={`rounded-md px-2 py-1 text-[10px] font-bold ${r.active ? "bg-emerald-50 text-emerald-600" : "bg-slate-200 text-slate-500"}`}>{r.active ? "Active" : "Hidden"}</button>
              <button title="Delete" disabled={busy}
                onClick={() => run(() => kind === "course" ? api.removeAdmissionCourse(r.id) : api.removeAdmissionIntake(r.id))}
                className="rounded-md p-1 text-slate-400 transition hover:bg-rose-50 hover:text-rose-500"><Trash2 size={15} /></button>
            </li>
          ))}
        </ul>
  );

  return (
    <Modal open={open} onClose={onClose} title="Courses & intakes" width={720}>
      <p className="mb-4 text-xs text-slate-500">These feed the application form's <b>Course</b> and <b>Intake</b> dropdowns — managed here, separate from Moodle. Hide an item to remove it from the form without deleting it.</p>
      {loading ? <div className="skeleton h-40 rounded-xl" /> : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-sm font-extrabold" style={{ color: NAVY_DARK }}><GraduationCap size={16} /> Courses</div>
            <div className="mb-3 flex gap-2">
              <input value={newCourse} onChange={e => setNewCourse(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addCourse(); }} placeholder="e.g. HND Business" className={inputCls} />
              <button onClick={addCourse} disabled={busy || !newCourse.trim()} className="press flex shrink-0 items-center rounded-xl px-3 text-sm font-bold text-white disabled:opacity-40" style={{ background: NAVY }}><Plus size={16} /></button>
            </div>
            {list(courses, "course")}
          </div>
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-sm font-extrabold" style={{ color: NAVY_DARK }}><CalendarDays size={16} /> Intakes</div>
            <div className="mb-3 flex gap-2">
              <input value={newIntake} onChange={e => setNewIntake(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addIntake(); }} placeholder="e.g. September 2026" className={inputCls} />
              <button onClick={addIntake} disabled={busy || !newIntake.trim()} className="press flex shrink-0 items-center rounded-xl px-3 text-sm font-bold text-white disabled:opacity-40" style={{ background: NAVY }}><Plus size={16} /></button>
            </div>
            {list(intakes, "intake")}
          </div>
        </div>
      )}
    </Modal>
  );
}

function AdmissionField({ f, value, onChange, missing }) {
  // Labels are full questions (not short field names), so they read in normal case; a
  // blank required field gets a rose ring when the admin tries to save without it.
  const cls = `${inputCls}${missing ? " border-rose-300 ring-2 ring-rose-100" : ""}`;
  const common = { value, onChange: (e) => onChange(f.key, e.target.value), className: cls };
  let control;
  if (f.type === "select") {
    control = <select {...common}><option value="">Select your answer</option>{f.options.map(o => <option key={o} value={o}>{o}</option>)}</select>;
  } else if (f.type === "textarea") {
    control = <textarea rows={3} {...common} className={`${cls} resize-y`} placeholder={f.placeholder || ""} />;
  } else {
    control = <input type={f.type || "text"} {...common} placeholder={f.placeholder || ""} />;
  }
  return (
    <div data-akey={f.key} className={f.span === 2 ? "sm:col-span-2" : ""}>
      <label className="text-[13px] font-semibold leading-snug text-slate-600">{f.label}{f.required && <span className="ml-0.5 text-rose-500">*</span>}</label>
      {f.hint && <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{f.hint}</p>}
      <div className="mt-1.5">{control}</div>
    </div>
  );
}

// Read-only view of one application — the same sections, but only the answered fields.
function AdmissionDetail({ r }) {
  return (
    <div className="space-y-4">
      {ADMISSION_SECTIONS.map(sec => {
        const answered = sec.fields.filter(f => (r[f.key] ?? "") !== "");
        if (!answered.length) return null;
        return (
          <div key={sec.title}>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wide" style={{ color: NAVY }}>{sec.title}</p>
            <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
              {answered.map(f => (
                <div key={f.key} className={f.type === "textarea" ? "sm:col-span-2" : ""}>
                  <dt className="text-[11px] font-semibold text-slate-400">{f.label}</dt>
                  <dd className="text-sm text-slate-700 whitespace-pre-wrap break-words">{f.type === "date" ? fmtDate(r[f.key]) : r[f.key]}</dd>
                </div>
              ))}
            </dl>
          </div>
        );
      })}
    </div>
  );
}

// The documents an applicant is asked to upload. MUST match server/src/admissionDocs.js.
const ADMISSION_DOC_TYPES = [
  { key: "photo", label: "Passport-size photo" },
  { key: "passport", label: "Passport / Driving Licence" },
  { key: "cv", label: "CV" },
  { key: "address", label: "Proof of address" },
  { key: "ni", label: "National Insurance number" },
  { key: "immigration", label: "Immigration share code" },
  { key: "personalStatement", label: "Personal statement" },
  { key: "english", label: "Proof of English" },
  { key: "qualifications", label: "Academic qualification" },
  { key: "employment", label: "Employment verification" },
];
const admDocLabel = (key) => (ADMISSION_DOC_TYPES.find(d => d.key === key) || {}).label || key;

// The documents panel inside an application's View modal: request the upload email,
// then track / view / verify each file. `r` is the admission (with its .documents);
// `onChanged` re-fetches so the panel reflects new uploads and verifications.
function AdmissionDocsPanel({ r, store, onChanged }) {
  const [busy, setBusy] = useState("");   // "" | "request" | a document id
  const [link, setLink] = useState("");    // the upload link, shown so it can be copied

  const byType = Object.fromEntries((r.documents || []).map(d => [d.docType, d]));
  const uploaded = (r.documents || []).length;
  const verified = (r.documents || []).filter(d => d.confirmed).length;
  const requested = !!r.docsRequestedAt;

  const request = async () => {
    setBusy("request");
    try {
      const res = await api.requestAdmissionDocuments(r.id);
      setLink(res.link || "");
      store.notify(res.emailed ? `Upload link emailed to ${r.email}` : "Email isn't set up on the server — copy the link below to send it", res.emailed ? "success" : "info");
      if (res.warning) store.notify(res.warning, "error");
      onChanged?.();
    } catch (e) { store.notify(e.message || "Could not send the request", "error"); }
    setBusy("");
  };
  const toggleConfirm = async (doc) => {
    setBusy(doc.id);
    try { await api.confirmAdmissionDocument(doc.id, !doc.confirmed); onChanged?.(); }
    catch (e) { store.notify(e.message || "Could not update", "error"); }
    setBusy("");
  };
  const removeDoc = async (doc) => {
    if (!window.confirm(`Delete the uploaded "${admDocLabel(doc.docType)}" file?\n\nThe applicant would need to upload it again. This cannot be undone.`)) return;
    setBusy(doc.id);
    try { await api.removeAdmissionDocument(doc.id); store.notify("Document deleted", "error"); onChanged?.(); }
    catch (e) { store.notify(e.message || "Could not delete", "error"); }
    setBusy("");
  };
  const viewDoc = async (doc) => {
    try { const { url } = await api.admissionDocumentUrl(doc.id); if (url) window.open(url, "_blank", "noopener"); }
    catch (e) { store.notify(e.message || "Could not open the file", "error"); }
  };
  const copyLink = async () => { try { await navigator.clipboard.writeText(link); store.notify("Link copied"); } catch { /* ignore */ } };

  return (
    <div className="mt-5 rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <FileUp size={16} style={{ color: NAVY }} />
        <p className="text-sm font-extrabold" style={{ color: NAVY_DARK }}>Documents</p>
        <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-bold text-slate-500 ring-1 ring-slate-200">{uploaded}/{ADMISSION_DOC_TYPES.length} uploaded{verified ? ` · ${verified} verified` : ""}</span>
        <div className="ml-auto flex items-center gap-2">
          {r.spFolderUrl && <a href={r.spFolderUrl} target="_blank" rel="noopener" className="press flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"><ExternalLink size={13} /> SharePoint folder</a>}
          <button onClick={request} disabled={busy === "request" || !r.email} title={!r.email ? "Add an email address to this application first" : ""} className="press flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-white transition hover:opacity-95 disabled:opacity-40" style={{ background: NAVY }}>
            {busy === "request" ? <Loader2 size={13} className="animate-spin" /> : requested ? <Send size={13} /> : <Mail size={13} />} {requested ? "Resend link" : "Request documents"}
          </button>
        </div>
      </div>

      {!r.email && <p className="mb-2 flex items-start gap-1.5 text-[11px] font-semibold text-amber-600"><AlertCircle size={12} className="mt-px shrink-0" /> This application has no email address — add one (Edit) before requesting documents.</p>}
      {requested && <p className="mb-2 text-[11px] text-slate-400">Requested {fmtDate(String(r.docsRequestedAt).slice(0, 10))}. The applicant can upload any time until the link expires (30 days).</p>}
      {link && (
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-white px-2.5 py-2 ring-1 ring-slate-200">
          <input readOnly value={link} className="min-w-0 flex-1 bg-transparent text-[11px] text-slate-500 outline-none" onFocus={e => e.target.select()} />
          <button onClick={copyLink} className="press flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-200"><Copy size={12} /> Copy</button>
        </div>
      )}

      <div className="space-y-1.5">
        {ADMISSION_DOC_TYPES.map(t => {
          const d = byType[t.key];
          const rowBusy = d && busy === d.id;
          return (
            <div key={t.key} className="flex flex-wrap items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200/70">
              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${d ? (d.confirmed ? "bg-emerald-100 text-emerald-600" : "bg-blue-100 text-blue-600") : "bg-slate-100 text-slate-300"}`}>
                {d ? (d.confirmed ? <ShieldCheck size={13} /> : <CheckCircle2 size={13} />) : <FileText size={13} />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-slate-700">{t.label}</p>
                {d ? <p className="truncate text-[11px] text-slate-400">{d.fileName}{d.confirmed ? ` · verified${d.confirmedBy ? ` by ${d.confirmedBy}` : ""}` : ""}</p> : <p className="text-[11px] text-slate-300">Not uploaded</p>}
              </div>
              {d && (
                <div className="flex items-center gap-1">
                  <button onClick={() => viewDoc(d)} title="View file" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"><ExternalLink size={14} /></button>
                  <button onClick={() => toggleConfirm(d)} disabled={rowBusy} className={`press rounded-lg px-2 py-1 text-[11px] font-bold transition ${d.confirmed ? "bg-slate-100 text-slate-500 hover:bg-slate-200" : "text-white"}`} style={d.confirmed ? {} : { background: "#059669" }}>
                    {rowBusy ? <Loader2 size={12} className="animate-spin" /> : d.confirmed ? "Unverify" : "Confirm"}
                  </button>
                  <button onClick={() => removeDoc(d)} disabled={rowBusy} title="Delete file" className="rounded-lg p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"><Trash2 size={14} /></button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Interview outcome options for the list dropdown (first = the "unset" default).
const INTERVIEW_OPTIONS = ["Not interviewed", "Passed", "Reject", "Refer"];
const interviewTone = (v) => v === "Passed" ? "text-emerald-700 bg-emerald-50" : v === "Reject" ? "text-rose-700 bg-rose-50" : v === "Refer" ? "text-amber-700 bg-amber-50" : "text-slate-500 bg-white";

// Inline, click-to-save student-ID cell — local state so typing isn't clobbered by a
// list refresh; commits on blur / Enter only when the value actually changed.
function StudentIdCell({ r, onSave }) {
  const [v, setV] = useState(r.studentId || "");
  useEffect(() => { setV(r.studentId || ""); }, [r.studentId]);
  const commit = () => { const t = v.trim(); if ((r.studentId || "") !== t) onSave(r.id, { studentId: t }); };
  return (
    <input value={v} onChange={e => setV(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} onClick={e => e.stopPropagation()}
      placeholder="Add ID" className="w-24 rounded-lg border border-slate-200 px-2 py-1 text-xs outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100" />
  );
}

// The offer-letter panel inside an application's View modal: pick the induction date,
// send the letter (PDF + Accept link) by email, and see whether it's been accepted.
function AdmissionOfferPanel({ r, store, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [inductionDate, setInductionDate] = useState("");
  const [senderName, setSenderName] = useState(store.currentUser?.name || "");
  const [link, setLink] = useState("");

  const sent = r.offerStatus === "sent";
  const accepted = r.offerStatus === "accepted";

  const send = async () => {
    if (!inductionDate) { store.notify("Please pick the induction (first) day.", "error"); return; }
    if (!senderName.trim()) { store.notify("Please enter your name — it signs the letter.", "error"); return; }
    setBusy(true);
    try {
      const res = await api.sendAdmissionOffer(r.id, { inductionDate, signatoryName: senderName.trim() });
      setLink(res.link || "");
      store.notify(res.emailed ? `Offer letter emailed to ${r.email}` : "Email isn't set up — copy the link below to send it", res.emailed ? "success" : "info");
      if (res.warning) store.notify(res.warning, "error");
      setDialog(false);
      onChanged?.();
    } catch (e) { store.notify(e.message || "Could not send the offer", "error"); }
    setBusy(false);
  };
  const copyLink = async () => { try { await navigator.clipboard.writeText(link); store.notify("Link copied"); } catch { /* ignore */ } };

  return (
    <div className="mt-4 rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
      <div className="flex flex-wrap items-center gap-2">
        <Award size={16} style={{ color: MAROON }} />
        <p className="text-sm font-extrabold" style={{ color: NAVY_DARK }}>Offer letter</p>
        {accepted
          ? <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-bold text-emerald-700">Accepted{r.offerAcceptedAt ? ` · ${fmtDate(String(r.offerAcceptedAt).slice(0, 10))}` : ""}</span>
          : sent
            ? <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-[11px] font-bold text-blue-700">Sent{r.offerSentAt ? ` · ${fmtDate(String(r.offerSentAt).slice(0, 10))}` : ""}</span>
            : <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-bold text-slate-400">Not sent</span>}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={async () => { try { await api.downloadAdmissionOfferLetterPdf(r.id, `Offer Letter - ${[r.firstName, r.surname].filter(Boolean).join(" ") || "Applicant"}.pdf`); } catch (e) { store.notify(e.message || "Could not download the offer letter", "error"); } }}
            className="press flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 transition hover:bg-slate-50">
            <Download size={13} /> Download offer letter
          </button>
          <button onClick={() => { setDialog(d => !d); setInductionDate(""); setSenderName(store.currentUser?.name || ""); }} disabled={!r.email} title={!r.email ? "Add an email address first" : ""}
            className="press flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-white transition hover:opacity-95 disabled:opacity-40" style={{ background: MAROON }}>
            <Send size={13} /> {sent || accepted ? "Resend offer" : "Send offer letter"}
          </button>
        </div>
      </div>
      {!r.email && <p className="mt-2 flex items-start gap-1.5 text-[11px] font-semibold text-amber-600"><AlertCircle size={12} className="mt-px shrink-0" /> This application has no email address — add one (Edit) before sending an offer.</p>}
      {accepted && <p className="mt-2 text-[11px] text-slate-400">The applicant accepted their place. Enrolment stays a manual decision in the Enroll column.</p>}

      {dialog && (
        <div className="mt-3 rounded-xl bg-white p-3 ring-1 ring-slate-200">
          <Field label="Induction / first day">
            <input type="date" value={inductionDate} onChange={e => setInductionDate(e.target.value)} className={inputCls} />
          </Field>
          <div className="mt-2">
            <Field label="Your name (signs the letter)">
              <input type="text" value={senderName} onChange={e => setSenderName(e.target.value)} placeholder="e.g. Swaroop Arja" className={inputCls} />
            </Field>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-400">Report time 09:45 am · session starts 10:00 am (as per the standard letter). The PDF is generated with the applicant's name and course, signed with your name (page 2), and emailed with an Accept link.</p>
          <PrimaryBtn colour={MAROON} onClick={send} disabled={busy} className="mt-3 w-full">{busy ? <><Loader2 size={16} className="animate-spin" /> Sending…</> : <><Send size={16} /> Generate & send offer letter</>}</PrimaryBtn>
        </div>
      )}
      {link && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-white px-2.5 py-2 ring-1 ring-slate-200">
          <input readOnly value={link} className="min-w-0 flex-1 bg-transparent text-[11px] text-slate-500 outline-none" onFocus={e => e.target.select()} />
          <button onClick={copyLink} className="press flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-200"><Copy size={12} /> Copy</button>
        </div>
      )}
    </div>
  );
}

// The interview-call panel inside an application's View modal: schedule an interview
// (date/time, online or in-person, link/location, note), email the applicant, and show it
// in their Student Portal. The interview OUTCOME is recorded separately via the ISM tab and
// shown here (r.ismOutcome).
function AdmissionInterviewPanel({ r, store, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ date: "", time: "", mode: "In person", location: "", link: "", note: "" });

  const invited = !!r.interviewInviteSentAt;
  const outcome = r.ismOutcome; // "Yes" | "No" | "May Be" | null
  const seed = () => setF({
    date: r.interviewInviteDate || "", time: r.interviewInviteTime || "",
    mode: r.interviewInviteMode || "In person", location: r.interviewInviteLocation || "",
    link: r.interviewInviteLink || "", note: r.interviewInviteNote || "",
  });

  const send = async () => {
    if (!f.date) { store.notify("Please pick an interview date.", "error"); return; }
    setBusy(true);
    try {
      const res = await api.sendAdmissionInterviewInvite(r.id, f);
      store.notify(res.emailed ? `Interview invitation emailed to ${r.email}` : "Saved — email isn't set up, so tell the applicant directly", res.emailed ? "success" : "info");
      if (res.warning) store.notify(res.warning, "error");
      setOpen(false);
      onChanged?.();
    } catch (e) { store.notify(e.message || "Could not send the invitation", "error"); }
    setBusy(false);
  };

  return (
    <div className="mt-4 rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
      <div className="flex flex-wrap items-center gap-2">
        <CalendarClock size={16} style={{ color: NAVY }} />
        <p className="text-sm font-extrabold" style={{ color: NAVY_DARK }}>Interview call</p>
        {invited
          ? <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-[11px] font-bold text-blue-700">Scheduled{r.interviewInviteDate ? ` · ${fmtDate(r.interviewInviteDate)}` : ""}</span>
          : <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-bold text-slate-400">Not scheduled</span>}
        {outcome && <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${outcome === "Yes" ? "bg-emerald-100 text-emerald-700" : outcome === "No" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"}`}>Outcome: {outcome}</span>}
        <div className="ml-auto">
          <button onClick={() => { setOpen(o => !o); if (!open) seed(); }} disabled={!r.email} title={!r.email ? "Add an email address first" : ""}
            className="press flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-white transition hover:opacity-95 disabled:opacity-40" style={{ background: NAVY }}>
            <Send size={13} /> {invited ? "Reschedule / resend" : "Schedule interview"}
          </button>
        </div>
      </div>
      {!r.email && <p className="mt-2 flex items-start gap-1.5 text-[11px] font-semibold text-amber-600"><AlertCircle size={12} className="mt-px shrink-0" /> This application has no email address — add one (Edit) before scheduling an interview.</p>}
      <p className="mt-2 text-[11px] text-slate-400">The applicant sees these details in the Student Portal and receives a branded email. The interview <b>outcome</b> is recorded separately in the Interviews (ISM) tab.</p>

      {open && (
        <div className="mt-3 rounded-xl bg-white p-3 ring-1 ring-slate-200">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Date"><input type="date" value={f.date} onChange={e => setF(s => ({ ...s, date: e.target.value }))} className={inputCls} /></Field>
            <Field label="Time"><input type="time" value={f.time} onChange={e => setF(s => ({ ...s, time: e.target.value }))} className={inputCls} /></Field>
          </div>
          <div className="mt-2"><Field label="Mode">
            <select value={f.mode} onChange={e => setF(s => ({ ...s, mode: e.target.value }))} className={inputCls}>
              <option>In person</option><option>Online</option>
            </select>
          </Field></div>
          {f.mode === "Online"
            ? <div className="mt-2"><Field label="Meeting link"><input type="url" value={f.link} onChange={e => setF(s => ({ ...s, link: e.target.value }))} placeholder="https://teams.microsoft.com/…" className={inputCls} /></Field></div>
            : <div className="mt-2"><Field label="Location"><input type="text" value={f.location} onChange={e => setF(s => ({ ...s, location: e.target.value }))} placeholder="e.g. EdTech, 42 The Burroughs, room 2" className={inputCls} /></Field></div>}
          <div className="mt-2"><Field label="Note (optional)"><textarea rows={2} value={f.note} onChange={e => setF(s => ({ ...s, note: e.target.value }))} placeholder="Anything the applicant should bring or know." className={`${inputCls} resize-y`} /></Field></div>
          <PrimaryBtn colour={NAVY} onClick={send} disabled={busy} className="mt-3 w-full">{busy ? <><Loader2 size={16} className="animate-spin" /> Sending…</> : <><Send size={16} /> Save & send interview call</>}</PrimaryBtn>
        </div>
      )}
    </div>
  );
}

/* ============================================================ ISM (interviews) ============================================================ */
// The Intention to Study Meeting — the admission interview, transcribed from the college's
// 12-question interview form. Each record links to an applicant; the "Admitted?" outcome
// mirrors onto that applicant's Admissions row.
const ISM_FIELDS = [
  { key: "courseUnderstanding", label: "What do you understand about this course?", type: "textarea", span: 2 },
  { key: "lastStudied", label: "When was the last time you studied? How many hours did you commit to self-study?", type: "textarea", span: 2 },
  { key: "independentLearning", label: "What is your understanding of independent learning?", type: "textarea", span: 2 },
  { key: "educationExperience", label: "What was your experience of education at school / college?", type: "textarea", span: 2 },
  { key: "strengthsWeaknesses", label: "Describe your key strengths and weaknesses that would enable you to study and complete the qualification.", type: "textarea", span: 2 },
  { key: "prioritiseWorkload", label: "How do you prioritise your workload? How do you decide what task is more important and should be completed first?", type: "textarea", span: 2 },
  { key: "working", label: "Are you working? Part-time / Full-time", type: "text" },
  { key: "teamworkExample", label: "Give an example of how you have worked successfully as part of a team — your role and its impact.", type: "textarea", span: 2 },
  { key: "wifiAccess", label: "Do you have access to WiFi?", type: "select", options: ["Yes", "No"] },
  { key: "officeSkills", label: "Do you know how to use Word / PowerPoint?", type: "select", options: ["Yes", "No"] },
  { key: "admitted", label: "Admitted?", type: "select", options: ["Yes", "No", "May Be"] },
];
const ISM_KEYS = ["name", ...ISM_FIELDS.map(f => f.key)];
const blankIsm = () => ({ admissionId: "", interviewDate: "", ...Object.fromEntries(ISM_KEYS.map(k => [k, ""])) });
const ismFormFrom = (r) => ({ admissionId: r.admissionId || "", interviewDate: r.interviewDate || "", ...Object.fromEntries(ISM_KEYS.map(k => [k, r[k] ?? ""])) });
const admittedTone = (v) => v === "Yes" ? "bg-emerald-100 text-emerald-700" : v === "No" ? "bg-rose-100 text-rose-700" : v === "May Be" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-400";

function AdminIsm({ store }) {
  const [rows, setRows] = useState([]);
  const [roster, setRoster] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(blankIsm);
  const [formErr, setFormErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try { const [list, ros] = await Promise.all([api.isms(), api.ismRoster()]); setRows(list); setRoster(ros || []); }
    catch (e) { setErr(e.message || "Could not load ISM records"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  // Picking an applicant links the record and prefills the name if it's blank.
  const pickApplicant = (id) => { const a = roster.find(x => x.id === id); setForm(f => ({ ...f, admissionId: id, name: (!f.name && a) ? a.name : f.name })); };
  const openAdd = () => { setEditing(null); setForm(blankIsm()); setFormErr(""); setModal(true); };
  const openEdit = (r) => { setEditing(r); setForm(ismFormFrom(r)); setFormErr(""); setModal(true); };

  const save = async () => {
    if (!form.admissionId && !form.name.trim()) { setFormErr("Pick an applicant or enter a name."); return; }
    setBusy(true); setFormErr("");
    try {
      if (editing) await api.updateIsm(editing.id, form); else await api.addIsm(form);
      store.notify(editing ? "ISM record updated" : "ISM record saved");
      setModal(false); await load();
    } catch (e) { setFormErr(e.message || "Could not save the ISM record"); }
    setBusy(false);
  };
  const confirmRemove = async () => {
    setBusy(true);
    try { await api.removeIsm(deleteTarget.id); setDeleteTarget(null); store.notify("ISM record deleted", "error"); await load(); }
    catch (e) { store.notify(e.message || "Could not delete", "error"); }
    setBusy(false);
  };

  const ismName = (r) => (r.applicant?.name || r.name || "—");
  const ql = query.trim().toLowerCase();
  const list = rows.filter(r => !ql || ismName(r).toLowerCase().includes(ql) || (r.applicant?.course || "").toLowerCase().includes(ql) || (r.interviewerName || "").toLowerCase().includes(ql));
  const paged = usePaged(list, 10, ql);

  return (
    <>
      <AdminHeader title="ISM — Intention to Study Meetings" subtitle="Admission interview records — the “Admitted?” outcome shows on the applicant in Admissions"
        Icon={MessageSquare} action={<PrimaryBtn onClick={openAdd}><Plus size={16} /> New ISM record</PrimaryBtn>} />

      {err && <div className="mb-4 flex items-start gap-2 rounded-xl bg-rose-50 px-3.5 py-3 text-sm font-semibold text-rose-700 ring-1 ring-rose-200"><AlertCircle size={16} className="mt-px shrink-0" />{err}</div>}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="ml-auto flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
          <Search size={15} className="text-slate-400" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name, course or interviewer…" className="w-60 bg-transparent text-sm outline-none" />
        </div>
      </div>

      {loading ? <div className="skeleton h-64 rounded-2xl" /> : (
        <>
          <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 fade-up">
            <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
              <table className="w-full min-w-[820px] text-sm">
                <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-5 py-3">Applicant</th><th className="px-5 py-3">Course</th>
                    <th className="px-5 py-3 whitespace-nowrap">Admitted?</th><th className="px-5 py-3">Interviewer</th>
                    <th className="px-5 py-3 whitespace-nowrap">Date</th><th className="px-5 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.slice.map(r => {
                    const nm = ismName(r);
                    const initials = (nm.split(" ").map(w => w[0]).join("").slice(0, 2) || "?").toUpperCase();
                    return (
                      <tr key={r.id} onClick={() => setViewing(r)} className="cursor-pointer border-t border-slate-100 transition-colors duration-150 hover:bg-blue-50/40">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2.5">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-sm" style={{ background: NAVY }}>{initials}</span>
                            <div className="min-w-0"><p className="font-semibold text-slate-700">{nm}</p>{r.applicant ? <p className="text-[11px] text-emerald-600">Linked</p> : <p className="text-[11px] text-slate-300">Not linked</p>}</div>
                          </div>
                        </td>
                        <td className="px-5 py-3 text-slate-500">{r.applicant?.course || <span className="text-slate-300">—</span>}</td>
                        <td className="px-5 py-3 whitespace-nowrap">{r.admitted ? <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${admittedTone(r.admitted)}`}>{r.admitted}</span> : <span className="text-slate-300">—</span>}</td>
                        <td className="px-5 py-3 text-slate-500">{r.interviewerName || <span className="text-slate-300">—</span>}</td>
                        <td className="px-5 py-3 whitespace-nowrap text-slate-500">{fmtDate(String(r.interviewDate || r.createdAt).slice(0, 10))}</td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-1 whitespace-nowrap">
                            <button onClick={(e) => { e.stopPropagation(); setViewing(r); }} title="View" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"><FileText size={15} /></button>
                            <button onClick={(e) => { e.stopPropagation(); openEdit(r); }} title="Edit" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"><Edit3 size={15} /></button>
                            <button onClick={(e) => { e.stopPropagation(); setDeleteTarget(r); }} title="Delete" className="rounded-lg p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"><Trash2 size={15} /></button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {paged.slice.length === 0 && (
                    <tr><td colSpan={6} className="px-5 py-12"><EmptyState Icon={MessageSquare} title={rows.length ? "No records match" : "No ISM records yet"} msg={rows.length ? "Try a different search." : "Press “New ISM record” to add an interview."} /></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <Pagination className="mt-4" page={paged.page} setPage={paged.setPage} totalPages={paged.totalPages} total={paged.total} />
        </>
      )}

      {/* Add / edit */}
      <Modal open={modal} onClose={() => !busy && setModal(false)} title={editing ? "Edit ISM record" : "New ISM record"} width={720}>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Applicant (from Admissions)">
              <select value={form.admissionId} onChange={e => pickApplicant(e.target.value)} className={inputCls}>
                <option value="">— not linked —</option>
                {roster.map(a => <option key={a.id} value={a.id}>{a.name}{a.course ? ` · ${a.course}` : ""}</option>)}
              </select>
            </Field>
            <Field label="Interview date"><input type="date" value={form.interviewDate} onChange={e => set("interviewDate", e.target.value)} className={inputCls} /></Field>
          </div>
          <div><Field label="Name"><input value={form.name} onChange={e => set("name", e.target.value)} placeholder="Applicant's name" className={inputCls} /></Field></div>
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            {ISM_FIELDS.map(f => <AdmissionField key={f.key} f={f} value={form[f.key]} onChange={set} />)}
          </div>
          {formErr && <p className="flex items-start gap-1.5 rounded-xl bg-rose-50 px-3 py-2 text-[11px] font-semibold text-rose-700 ring-1 ring-rose-200"><AlertCircle size={13} className="mt-px shrink-0" />{formErr}</p>}
          {editing?.interviewerName && <p className="text-[11px] text-slate-400">Recorded by {editing.interviewerName}.</p>}
          <PrimaryBtn onClick={save} disabled={busy} className="w-full">{busy ? <><Loader2 size={16} className="animate-spin" /> Saving…</> : <><Save size={16} /> {editing ? "Save changes" : "Save ISM record"}</>}</PrimaryBtn>
        </div>
      </Modal>

      {/* View */}
      <Modal open={!!viewing} onClose={() => setViewing(null)} title={viewing ? (ismName(viewing) || "ISM record") : "ISM record"} width={680}>
        {viewing && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2 text-[11px]">
              {viewing.applicant?.course && <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-600">{viewing.applicant.course}</span>}
              {viewing.admitted && <span className={`rounded-full px-2.5 py-1 font-bold ${admittedTone(viewing.admitted)}`}>Admitted: {viewing.admitted}</span>}
              {viewing.interviewerName && <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-600">By {viewing.interviewerName}</span>}
              {viewing.interviewDate && <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-600">{fmtDate(viewing.interviewDate)}</span>}
            </div>
            <dl className="space-y-2">
              {ISM_FIELDS.filter(f => (viewing[f.key] ?? "") !== "").map(f => (
                <div key={f.key}><dt className="text-[11px] font-semibold text-slate-400">{f.label}</dt><dd className="text-sm text-slate-700 whitespace-pre-wrap break-words">{viewing[f.key]}</dd></div>
              ))}
            </dl>
          </div>
        )}
      </Modal>

      <ConfirmDialog open={!!deleteTarget} title="Delete this ISM record?" message={`${deleteTarget ? ismName(deleteTarget) : "This"} interview record will be removed permanently. This cannot be undone.`} confirmLabel={busy ? "Deleting…" : "Delete record"} danger onConfirm={confirmRemove} onCancel={() => !busy && setDeleteTarget(null)} />
    </>
  );
}

function AdminAdmissions({ store }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(blankAdmission);
  const [formErr, setFormErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [missing, setMissing] = useState(() => new Set()); // required keys left blank on last save attempt
  const [selected, setSelected] = useState(() => new Set()); // ids ticked for bulk delete / export
  const [bulkDelete, setBulkDelete] = useState(false);
  const selectAllRef = useRef(null);

  const [courseOptions, setCourseOptions] = useState([]);
  const [intakeOptions, setIntakeOptions] = useState([]);
  const [configOpen, setConfigOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try { setRows(await api.admissions()); }
    catch (e) { setErr(e.message || "Could not load admissions"); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);
  // The course + intake dropdowns are populated from the admissions-managed lists (the
  // "Courses & intakes" manager), independent of Moodle. Re-fetched after the admin edits them.
  const loadOptions = useCallback(() => {
    api.applicationCourses().then(setCourseOptions).catch(() => {});
    api.applicationIntakes().then(setIntakeOptions).catch(() => {});
  }, []);
  useEffect(() => { loadOptions(); }, [loadOptions]);

  // Silent reload after a document action, keeping the open View modal in sync with the
  // fresh row (so a new upload / verification appears without closing the dialog).
  const refresh = useCallback(async () => {
    try {
      const fresh = await api.admissions();
      setRows(fresh);
      setViewing(v => v ? (fresh.find(x => x.id === v.id) || v) : v);
    } catch (_) { /* a transient failure shouldn't disturb the panel */ }
  }, []);

  // Save an inline decision field (enrol / student ID) from the list. Enrolling can rename
  // the SharePoint folder server-side; surface any warning it returns.
  const saveStatus = async (id, patch) => {
    try { const res = await api.updateAdmissionStatus(id, patch); if (res?.warning) store.notify(res.warning, "info"); await refresh(); }
    catch (e) { store.notify(e.message || "Could not save that change", "error"); }
  };

  // One reusable confirm dialog for the consequential list actions — the enrol decisions
  // and Edit. Each button opens it with a tailored message instead of acting immediately.
  const [confirmAction, setConfirmAction] = useState(null);
  // Enrolling opens a dialog for the induction date/time, then emails the student.
  const [enrollFor, setEnrollFor] = useState(null);
  const [enrollDate, setEnrollDate] = useState("");
  const [enrollTime, setEnrollTime] = useState("10:00");
  const [enrolling, setEnrolling] = useState(false);
  const doEnroll = async () => {
    if (!enrollDate) { store.notify("Please choose the induction date.", "error"); return; }
    setEnrolling(true);
    try {
      const res = await api.updateAdmissionStatus(enrollFor.id, { enrollStatus: "Enroll", inductionDate: enrollDate, inductionTime: enrollTime });
      if (res?.warning) store.notify(res.warning, "info");
      store.notify(
        res?.emailed ? `Enrolled — confirmation emailed to ${enrollFor.email}`
          : enrollFor.email ? "Enrolled — email isn't set up, so tell the student their induction directly"
            : "Enrolled — no email on file for this student",
        res?.emailed ? "success" : "info");
      setEnrollFor(null);
      await refresh();
    } catch (e) { store.notify(e.message || "Could not enrol", "error"); }
    setEnrolling(false);
  };
  const askEnroll = (r, status) => {
    const nm = admissionName(r) || "this applicant";
    const label = status === "Rejected" ? "Reject" : status;
    if (r.enrollStatus === status) { setConfirmAction({ title: `Clear "${label}"?`, message: `Remove the "${label}" decision from ${nm}?`, confirmLabel: "Clear", run: () => saveStatus(r.id, { enrollStatus: "" }) }); return; }
    if (status === "Enroll") {
      // Ask for the induction date/time; doEnroll enrols and emails the student.
      setEnrollFor(r);
      setEnrollDate(r.enrolInductionDate || "");
      setEnrollTime(r.enrolInductionTime || "10:00");
      return;
    }
    const msg = status === "Rejected" ? `Mark ${nm}'s application as rejected?` : `Mark ${nm} as withdrawn?`;
    setConfirmAction({ title: `${label} ${nm}?`, message: msg, confirmLabel: label, danger: true, run: () => saveStatus(r.id, { enrollStatus: status }) });
  };
  const askEdit = (r) => setConfirmAction({ title: "Edit this application?", message: `Open ${admissionName(r) || "this application"} for editing?`, confirmLabel: "Edit", run: () => openEdit(r) });

  // Editing a field clears its "missing" flag so the rose ring disappears as it's filled.
  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setMissing(m => { if (!m.has(k)) return m; const n = new Set(m); n.delete(k); return n; }); };
  const openAdd = () => { setEditing(null); setForm(blankAdmission()); setFormErr(""); setMissing(new Set()); setModal(true); };
  const openEdit = (r) => { setEditing(r); setForm(admissionForm(r)); setFormErr(""); setMissing(new Set()); setModal(true); };

  const save = async () => {
    // For a NEW entry, mirror the form's required questions (block until each asterisked
    // field is filled). For an EDIT, don't — an admin must be able to change one field
    // (e.g. course/intake) without back-filling every required answer; only a name is needed.
    if (editing) {
      if (!form.firstName.trim() && !form.surname.trim()) { setFormErr("Enter at least a first name or surname."); return; }
    } else {
      const blanks = ADMISSION_REQUIRED.filter(k => !String(form[k] || "").trim());
      if (blanks.length) {
        setMissing(new Set(blanks));
        setFormErr(`Please complete all required fields (marked *). ${blanks.length} still need${blanks.length === 1 ? "s" : ""} an answer.`);
        const el = typeof document !== "undefined" && document.querySelector(`[data-akey="${blanks[0]}"]`);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
    }
    setBusy(true); setFormErr("");
    try {
      if (editing) { const res = await api.updateAdmission(editing.id, form); if (res?.warning) store.notify(res.warning, "info"); }
      else await api.addAdmission(form);
      store.notify(editing ? "Application updated" : "Application saved");
      setModal(false);
      await load();
    } catch (e) { setFormErr(e.message || "Could not save the application"); }
    setBusy(false);
  };

  const confirmRemove = async () => {
    setBusy(true);
    try { await api.removeAdmission(deleteTarget.id); setDeleteTarget(null); store.notify("Application deleted", "error"); await load(); }
    catch (e) { store.notify(e.message || "Could not delete the application", "error"); }
    setBusy(false);
  };

  const ql = query.trim().toLowerCase();
  const list = rows.filter(r => {
    if (!ql) return true;
    return admissionName(r).toLowerCase().includes(ql)
      || (r.email || "").toLowerCase().includes(ql)
      || (r.phone || "").toLowerCase().includes(ql)
      || (r.course || "").toLowerCase().includes(ql);
  });
  const paged = usePaged(list, 10, ql);

  // ---- selection (checkboxes) ----
  // "Select all" spans every application in the current (filtered) list, not just the
  // page in view, so one tick can select them all for a bulk delete.
  const allSelected = list.length > 0 && list.every(r => selected.has(r.id));
  const someSelected = !allSelected && list.some(r => selected.has(r.id));
  useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected; }, [someSelected]);
  const toggleAll = () => setSelected(prev => { const n = new Set(prev); list.forEach(r => allSelected ? n.delete(r.id) : n.add(r.id)); return n; });
  const toggleOne = (id) => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const clearSelection = () => setSelected(new Set());
  const selectedRows = rows.filter(r => selected.has(r.id));

  const exportSelectedCsv = () => {
    if (!selectedRows.length) return;
    downloadCSV("admissions-selected.csv",
      [{ key: "applied", label: "Applied" }, ...ADMISSION_SECTIONS.flatMap(s => s.fields.map(f => ({ key: f.key, label: f.label })))],
      selectedRows.map(r => ({ applied: fmtDate(String(r.createdAt).slice(0, 10)), ...Object.fromEntries(ADMISSION_KEYS.map(k => [k, r[k] || ""])) })));
    store.notify(`Exported ${selectedRows.length} application${selectedRows.length === 1 ? "" : "s"}`);
  };

  const confirmBulkRemove = async () => {
    setBusy(true);
    try {
      // allSettled, not all: one failed delete must not abort the rest or skip the refresh.
      const results = await Promise.allSettled(selectedRows.map(r => api.removeAdmission(r.id)));
      const failed = results.filter(r => r.status === "rejected").length;
      if (failed) store.notify(`Deleted ${selectedRows.length - failed} of ${selectedRows.length}; ${failed} could not be removed`, "error");
      else store.notify(`Deleted ${selectedRows.length} application${selectedRows.length === 1 ? "" : "s"}`, "error");
    } catch (e) { store.notify(e.message || "Could not delete the selected applications", "error"); }
    // Always refresh the list and clear the selection so no stale rows linger, even if
    // some deletes failed.
    finally { setBulkDelete(false); clearSelection(); await load(); setBusy(false); }
  };

  const exportCsv = () => {
    if (!list.length) { store.notify("Nothing to export in the current view", "error"); return; }
    downloadCSV("admissions.csv",
      [{ key: "applied", label: "Applied" }, ...ADMISSION_SECTIONS.flatMap(s => s.fields.map(f => ({ key: f.key, label: f.label })))],
      list.map(r => ({ applied: fmtDate(String(r.createdAt).slice(0, 10)), ...Object.fromEntries(ADMISSION_KEYS.map(k => [k, r[k] || ""])) })));
    store.notify(`Exported ${list.length} application${list.length === 1 ? "" : "s"}`);
  };

  // Export just the one application the admin has open — a single-row CSV.
  const exportOneCsv = (r) => {
    const slug = (admissionName(r) || "applicant").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    downloadCSV(`admission-${slug}.csv`,
      [{ key: "applied", label: "Applied" }, ...ADMISSION_SECTIONS.flatMap(s => s.fields.map(f => ({ key: f.key, label: f.label })))],
      [{ applied: fmtDate(String(r.createdAt).slice(0, 10)), ...Object.fromEntries(ADMISSION_KEYS.map(k => [k, r[k] || ""])) }]);
    store.notify("Exported application CSV");
  };

  // Export the open application as a PDF. The server builds the PDF (see
  // server/src/applicationPdf.js) and we download it as a file — this works uniformly
  // across Chrome, Firefox, Safari/Mac and Edge, unlike the old window.open()+print()
  // export which was defeated by pop-up blockers and Safari's print quirks.
  const exportPdf = async (r) => {
    try { await api.downloadAdmissionApplicationPdf(r.id, `Application Form - ${admissionName(r) || "Applicant"}.pdf`); }
    catch (e) { store.notify(e.message || "Could not download the PDF", "error"); }
  };

  return (
    <>
      <AdminHeader title="Admissions" subtitle="HND application entries — create, review, edit and remove"
        Icon={ClipboardList}
        action={<div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setConfigOpen(true)} className="press flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50"><Settings size={14} /> Courses &amp; intakes</button>
          <button onClick={async () => { const url = `${window.location.origin}/?apply`; try { await navigator.clipboard.writeText(url); store.notify("Application form link copied — share it with applicants"); } catch { store.notify(url, "info"); } }} className="press flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50"><Copy size={14} /> Application link</button>
          <ExportBtn onClick={exportCsv} /><PrimaryBtn onClick={openAdd}><Plus size={16} /> Create new entry</PrimaryBtn></div>} />

      <AdmissionConfigManager open={configOpen} onClose={() => setConfigOpen(false)} store={store} onSaved={loadOptions} />

      {err && <div className="mb-4 flex items-start gap-2 rounded-xl bg-rose-50 px-3.5 py-3 text-sm font-semibold text-rose-700 ring-1 ring-rose-200"><AlertCircle size={16} className="mt-px shrink-0" />{err}</div>}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="ml-auto flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
          <Search size={15} className="text-slate-400" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name, email, phone or course…" className="w-60 bg-transparent text-sm outline-none" />
        </div>
      </div>

      {/* Bulk action bar — shown only while one or more applications are ticked. */}
      {selected.size > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-blue-50 px-3.5 py-2.5 ring-1 ring-blue-100 fade-up">
          <span className="text-sm font-bold text-blue-800">{selected.size} selected</span>
          <button onClick={clearSelection} className="text-xs font-semibold text-blue-600 hover:underline">Clear</button>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={exportSelectedCsv} className="press flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50"><Download size={14} /> Export selected</button>
            <button onClick={() => setBulkDelete(true)} className="press flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold text-white transition hover:opacity-95" style={{ background: MAROON }}><Trash2 size={14} /> Delete selected</button>
          </div>
        </div>
      )}

      {loading ? <div className="skeleton h-64 rounded-2xl" /> : (
        <>
          <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 fade-up">
            <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
              <table className="w-full min-w-[1320px] text-sm">
                <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="w-10 px-4 py-3"><input ref={selectAllRef} type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all applications" className="h-4 w-4 cursor-pointer align-middle accent-blue-600" /></th>
                    <th className="px-5 py-3">Applicant</th><th className="px-5 py-3">Course</th>
                    <th className="px-5 py-3">Email</th><th className="px-5 py-3 whitespace-nowrap">Phone</th>
                    <th className="px-5 py-3 whitespace-nowrap">Applied</th><th className="px-5 py-3 whitespace-nowrap">Documents</th>
                    <th className="px-5 py-3 whitespace-nowrap" title="From the ISM (interview) outcome">Admitted</th><th className="px-5 py-3 whitespace-nowrap">Student ID</th>
                    <th className="px-5 py-3 whitespace-nowrap">Enroll</th><th className="px-5 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.slice.map(r => {
                    const name = admissionName(r) || "—";
                    const initials = ((r.firstName || " ")[0] + (r.surname || " ")[0]).trim().toUpperCase() || "?";
                    const dUp = (r.documents || []).length, dVer = (r.documents || []).filter(d => d.confirmed).length, dTot = ADMISSION_DOC_TYPES.length;
                    return (
                      <tr key={r.id} onClick={() => setViewing(r)} className={`cursor-pointer border-t border-slate-100 transition-colors duration-150 hover:bg-blue-50/40 ${selected.has(r.id) ? "bg-blue-50/60" : ""}`}>
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleOne(r.id)} aria-label={`Select ${name}`} className="h-4 w-4 cursor-pointer align-middle accent-blue-600" />
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2.5">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-sm" style={{ background: NAVY }}>{initials}</span>
                            <p className="font-semibold text-slate-700">{name}</p>
                          </div>
                        </td>
                        <td className="px-5 py-3 text-slate-500">{r.course || <span className="text-slate-300">—</span>}</td>
                        <td className="px-5 py-3 text-slate-500">{r.email || <span className="text-slate-300">—</span>}</td>
                        <td className="px-5 py-3 whitespace-nowrap text-slate-500">{r.phone || <span className="text-slate-300">—</span>}</td>
                        <td className="px-5 py-3 whitespace-nowrap text-slate-500">{fmtDate(String(r.createdAt).slice(0, 10))}</td>
                        <td className="px-5 py-3 whitespace-nowrap">
                          {!r.docsRequestedAt && dUp === 0
                            ? <span className="text-slate-300">—</span>
                            : <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold ${dUp === 0 ? "bg-slate-100 text-slate-400" : dUp === dTot ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{dUp === dTot && dVer === dTot && <ShieldCheck size={11} />}{dUp}/{dTot}</span>}
                        </td>
                        <td className="px-5 py-3 whitespace-nowrap">
                          {r.ismOutcome
                            ? <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${r.ismOutcome === "Yes" ? "bg-emerald-100 text-emerald-700" : r.ismOutcome === "No" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"}`}>{r.ismOutcome}</span>
                            : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-5 py-3 whitespace-nowrap"><StudentIdCell r={r} onSave={saveStatus} /></td>
                        <td className="px-5 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          <div className="flex gap-1">
                            <button onClick={() => askEnroll(r, "Enroll")}
                              className={`press rounded-lg px-2.5 py-1 text-[11px] font-bold transition ${r.enrollStatus === "Enroll" ? "text-white shadow-sm" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`} style={r.enrollStatus === "Enroll" ? { background: "#059669" } : {}}>Enroll</button>
                            <button onClick={() => askEnroll(r, "Rejected")}
                              className={`press rounded-lg px-2.5 py-1 text-[11px] font-bold transition ${r.enrollStatus === "Rejected" ? "text-white shadow-sm" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`} style={r.enrollStatus === "Rejected" ? { background: MAROON } : {}}>Reject</button>
                            <button onClick={() => askEnroll(r, "Withdraw")}
                              className={`press rounded-lg px-2.5 py-1 text-[11px] font-bold transition ${r.enrollStatus === "Withdraw" ? "text-white shadow-sm" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`} style={r.enrollStatus === "Withdraw" ? { background: "#d97706" } : {}}>Withdraw</button>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-1 whitespace-nowrap">
                            <button onClick={(e) => { e.stopPropagation(); setViewing(r); }} title="View" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"><FileText size={15} /></button>
                            <button onClick={(e) => { e.stopPropagation(); askEdit(r); }} title="Edit" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"><Edit3 size={15} /></button>
                            <button onClick={(e) => { e.stopPropagation(); setDeleteTarget(r); }} title="Delete" className="rounded-lg p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"><Trash2 size={15} /></button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {paged.slice.length === 0 && (
                    <tr><td colSpan={11} className="px-5 py-12">
                      <EmptyState Icon={ClipboardList} title={rows.length ? "No applications match" : "No applications yet"}
                        msg={rows.length ? "Try a different search." : "Press “Create new entry” to add the first application."} />
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <Pagination className="mt-4" page={paged.page} setPage={paged.setPage} totalPages={paged.totalPages} total={paged.total} />
        </>
      )}

      {/* Create / edit — the full application form, grouped into the same sections. */}
      <Modal open={modal} onClose={() => !busy && setModal(false)} title={editing ? "Edit application" : "New application"} width={760}>
        <div className="space-y-5">
          {ADMISSION_SECTIONS.map(sec => (
            <div key={sec.title}>
              <div className="mb-1.5 flex items-start gap-2">
                <span className="mt-0.5 h-4 w-1 shrink-0 rounded-full" style={{ background: `linear-gradient(${NAVY}, ${MAROON})` }} />
                <p className="text-xs font-bold uppercase tracking-wide" style={{ color: NAVY_DARK }}>{sec.title}</p>
              </div>
              {sec.note && <p className="mb-2.5 rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-snug text-slate-500 ring-1 ring-slate-100">{sec.note}</p>}
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                {sec.fields.map(f => { const ff = (f.key === "course" && courseOptions.length) ? { ...f, options: courseOptions } : (f.key === "intake" && intakeOptions.length) ? { ...f, options: intakeOptions } : f; return <AdmissionField key={f.key} f={ff} value={form[f.key]} onChange={set} missing={missing.has(f.key)} />; })}
              </div>
            </div>
          ))}
          {formErr && <p className="flex items-start gap-1.5 rounded-xl bg-rose-50 px-3 py-2 text-[11px] font-semibold text-rose-700 ring-1 ring-rose-200"><AlertCircle size={13} className="mt-px shrink-0" />{formErr}</p>}
          <PrimaryBtn onClick={save} disabled={busy} className="w-full">{busy ? <><Loader size={16} /> Saving…</> : <><Save size={16} /> {editing ? "Save changes" : "Save application"}</>}</PrimaryBtn>
        </div>
      </Modal>

      {/* View */}
      <Modal open={!!viewing} onClose={() => setViewing(null)} title={viewing ? (admissionName(viewing) || "Application") : "Application"} width={720}>
        {viewing && (
          <>
            <AdmissionDetail r={viewing} />
            <AdmissionDocsPanel r={viewing} store={store} onChanged={refresh} />
            <AdmissionInterviewPanel r={viewing} store={store} onChanged={refresh} />
            <AdmissionOfferPanel r={viewing} store={store} onChanged={refresh} />
            <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4">
              <button onClick={() => exportOneCsv(viewing)} className="press flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50"><Download size={14} /> Export CSV</button>
              <button onClick={() => exportPdf(viewing)} className="press flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold text-white transition hover:opacity-95" style={{ background: MAROON }}><FileText size={14} /> Export PDF</button>
            </div>
          </>
        )}
      </Modal>

      {/* Enrol — pick the induction date/time, then enrol + email the student. */}
      <Modal open={!!enrollFor} onClose={() => setEnrollFor(null)} title={enrollFor ? `Enrol ${admissionName(enrollFor) || "applicant"}` : "Enrol"} width={460}>
        {enrollFor && (
          <>
            <p className="text-sm leading-relaxed text-slate-600">Choose the <b>induction date and time</b>. We'll mark <b>{admissionName(enrollFor)}</b> as enrolled and email them a congratulations with these details.</p>
            {!enrollFor.email && <p className="mt-2 flex items-start gap-1.5 text-[12px] font-semibold text-amber-600"><AlertCircle size={13} className="mt-px shrink-0" /> No email on file — they'll be enrolled but won't receive the confirmation. Add an email (Edit) to send it.</p>}
            <div className="mt-4 grid grid-cols-2 gap-3">
              <Field label="Induction date"><input type="date" value={enrollDate} onChange={e => setEnrollDate(e.target.value)} className={inputCls} /></Field>
              <Field label="Induction time"><input type="time" value={enrollTime} onChange={e => setEnrollTime(e.target.value)} className={inputCls} /></Field>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">The email location is EdTech, 42 The Burroughs, Hendon, London NW4 4AP. On enrol, the applicant's SharePoint folder is renamed to "&lt;Student ID&gt; - {admissionName(enrollFor)}".</p>
            <div className="mt-5 flex justify-end gap-2 border-t border-slate-100 pt-4">
              <button onClick={() => setEnrollFor(null)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-bold text-slate-600 hover:bg-slate-50">Cancel</button>
              <PrimaryBtn colour="#059669" onClick={doEnroll} disabled={enrolling}>{enrolling ? <><Loader2 size={16} className="animate-spin" /> Enrolling…</> : <><CheckCircle2 size={16} /> Enrol &amp; send email</>}</PrimaryBtn>
            </div>
          </>
        )}
      </Modal>

      {/* Bulk delete confirmation — for the ticked applications. */}
      <ConfirmDialog
        open={bulkDelete}
        title={`Delete ${selected.size} application${selected.size === 1 ? "" : "s"}?`}
        message={`${selected.size} selected application${selected.size === 1 ? "" : "s"} will be removed permanently. This cannot be undone.`}
        confirmLabel={busy ? "Deleting…" : `Delete ${selected.size}`}
        danger
        onConfirm={confirmBulkRemove}
        onCancel={() => !busy && setBulkDelete(false)}
      />

      {/* Delete confirmation — asked before any application is removed. */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete this application?"
        message={`${deleteTarget ? (admissionName(deleteTarget) || "This applicant") : "This applicant"}'s application will be removed permanently. This cannot be undone.`}
        confirmLabel={busy ? "Deleting…" : "Delete application"}
        danger
        onConfirm={confirmRemove}
        onCancel={() => !busy && setDeleteTarget(null)}
      />

      {/* Confirmation for the enrol decisions (Enroll / Reject / Withdraw) and Edit. */}
      <ConfirmDialog
        open={!!confirmAction}
        title={confirmAction?.title}
        message={confirmAction?.message}
        confirmLabel={confirmAction?.confirmLabel || "Confirm"}
        danger={confirmAction?.danger}
        onConfirm={() => { confirmAction?.run?.(); setConfirmAction(null); }}
        onCancel={() => setConfirmAction(null)}
      />
    </>
  );
}

function AdminTimetable({ store }) {
  const { notify } = store;
  const [courses, setCourses] = useState([]);
  const [courseId, setCourseId] = useState("");
  const [year, setYear] = useState("");        // "" = all years
  const [term, setTerm] = useState("");        // "" = all terms
  const [data, setData] = useState({ slots: [], units: [] });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null);    // null | slot-being-edited | "new"
  const [form, setForm] = useState({ day: 2, start: "10:00", end: "13:00", title: "", lecturer: "", room: "", unitId: "" });
  const [cal, setCal] = useState({ startDate: "", endDate: "", weeks: [] });   // academic calendar editor

  useEffect(() => {
    api.timetableCourses().then(cs => {
      setCourses(cs);
      if (cs.length && !courseId) setCourseId(cs[0].id);
    }).catch(e => notify?.(e.message || "Couldn't load courses", "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    if (!courseId) { setData({ slots: [], units: [] }); return; }
    setLoading(true);
    try { setData(await api.timetable(courseId, year, term)); }
    catch (e) { notify?.(e.message || "Couldn't load the timetable", "error"); }
    setLoading(false);
  }, [courseId, year, term, notify]);
  useEffect(() => { load(); }, [load]);

  // Keep the calendar editor in step with the loaded scope: use the stored calendar if
  // there is one, otherwise seed the dates from the units so the admin starts from the
  // real term window rather than a blank form.
  useEffect(() => {
    const c = data.calendar, td = data.termDates || {};
    setCal({
      startDate: c?.startDate || td.start || "",
      endDate: c?.endDate || td.end || "",
      weeks: c?.weeks?.length ? c.weeks : [],
    });
  }, [data]);

  const course = courses.find(c => c.id === courseId);
  // The (year, term) stages this course actually has units in, for the pickers.
  const stages = course?.stages || [];
  const years = [...new Set(stages.map(s => s.year))].sort();
  const termsForYear = [...new Set(stages.filter(s => !year || s.year === Number(year)).map(s => s.termNumber))].sort();

  // On picking a course, jump to its first real stage (a specific year + term). What you
  // build there lands on the exact stage students are enrolled in, so it reaches them —
  // "All years / All terms" stays available, but as a wide view, not a build target.
  useEffect(() => {
    const st = (course?.stages || [])[0];
    setYear(st ? String(st.year) : "");
    setTerm(st ? String(st.termNumber) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  const scoped = { courseId, year: year || null, termNumber: term || null };
  const autofill = async () => {
    if (!courseId) return;
    setBusy(true);
    try {
      const r = await api.timetableAutofill(scoped);
      const skipped = (r.skipped || []).filter(s => s.reason.includes("register")).length;
      notify?.(`${r.created} row${r.created === 1 ? "" : "s"} added from ${r.unitsFilled} unit${r.unitsFilled === 1 ? "" : "s"}${skipped ? ` · ${skipped} unit(s) had no registers to read times from` : ""}`, r.created ? "success" : "info");
      await load();
    } catch (e) { notify?.(e.message || "Auto-fill failed", "error"); }
    setBusy(false);
  };
  const fmtDate = (d) => { if (!d) return ""; const dt = new Date(d + "T00:00:00"); return isNaN(dt.getTime()) ? d : dt.toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };
  // --- Academic calendar (weekly structure) ---
  const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const mondayOf = (dateStr) => { const d = new Date(dateStr + "T00:00:00"); const off = (d.getDay() + 6) % 7; d.setDate(d.getDate() - off); return d; };
  // Build one row per week (w.c. = the Monday) from the term start to end, defaulting to
  // "Teaching" and keeping any activity already set for that week number.
  const genWeeks = () => {
    if (!cal.startDate || !cal.endDate) { notify?.("Set the term start and end dates first", "error"); return; }
    if (cal.endDate < cal.startDate) { notify?.("End date must be after the start date", "error"); return; }
    const prev = new Map((cal.weeks || []).map(w => [w.n, w.activity]));
    const end = new Date(cal.endDate + "T00:00:00");
    const out = []; let d = mondayOf(cal.startDate); let n = 1;
    while (d <= end && n <= 52) { out.push({ n, wc: isoOf(d), activity: prev.get(n) || "Teaching" }); d = new Date(d); d.setDate(d.getDate() + 7); n++; }
    setCal(c => ({ ...c, weeks: out }));
  };
  const setWeek = (i, patch) => setCal(c => ({ ...c, weeks: c.weeks.map((w, j) => j === i ? { ...w, ...patch } : w) }));
  const removeWeek = (i) => setCal(c => ({ ...c, weeks: c.weeks.filter((_, j) => j !== i).map((w, j) => ({ ...w, n: j + 1 })) }));
  const saveCalendar = async () => {
    if (!year || !term) { notify?.("Pick a specific year and term first", "error"); return; }
    setBusy(true);
    try {
      await api.saveTimetableCalendar({ courseId, year, termNumber: term, startDate: cal.startDate || null, endDate: cal.endDate || null, weeks: cal.weeks });
      await load();
      notify?.("Term dates & calendar saved", "success");
    } catch (e) { notify?.(e.message || "Couldn't save the calendar", "error"); }
    setBusy(false);
  };
  // Best starting stage for a hand-added row: the specific year/term in view, else the
  // course's first real stage — so a row is student-reachable even from an "all" view.
  const firstStage = stages[0] || null;
  const targetYear = year || (firstStage ? String(firstStage.year) : null);
  const targetTerm = term || (firstStage ? String(firstStage.termNumber) : null);
  const openNew = () => { setForm({ day: 2, start: "10:00", end: "13:00", title: "", lecturer: "", room: "", unitId: "", year: targetYear, termNumber: targetTerm }); setModal("new"); };
  // Add a unit: open the form so the admin DECIDES the day/time and room, pre-filled with
  // the unit's name, its tutor, and the day/time suggested by its registers (all editable).
  // The row lands on the unit's own year+term, so students on that stage see it.
  const openUnit = (u) => {
    const s = (u.schedule || [])[0];
    setForm({
      day: s ? s.day : 2,
      start: s ? s.start : "09:00",
      end: s ? s.end : "12:00",
      title: u.name,
      lecturer: u.tutor || "",
      room: "",
      unitId: u.id,
      year: u.year ?? targetYear,
      termNumber: u.termNumber ?? targetTerm,
    });
    setModal("new");
  };
  const openEdit = (s) => { setForm({ day: s.day, start: s.start, end: s.end, title: s.title, lecturer: s.lecturer || "", room: s.room || "", unitId: s.unitId || "", year: s.year ?? targetYear, termNumber: s.termNumber ?? targetTerm }); setModal(s); };
  const saveSlot = async () => {
    if (!form.title.trim()) { notify?.("Give the session a title", "error"); return; }
    if (form.end <= form.start) { notify?.("End time must be after the start time", "error"); return; }
    setBusy(true);
    try {
      if (modal === "new") await api.addTimetableSlot({ courseId, year: form.year ?? null, termNumber: form.termNumber ?? null, day: Number(form.day), start: form.start, end: form.end, title: form.title, lecturer: form.lecturer, room: form.room, unitId: form.unitId || undefined });
      else await api.updateTimetableSlot(modal.id, { day: Number(form.day), start: form.start, end: form.end, title: form.title, lecturer: form.lecturer, room: form.room });
      setModal(null); await load();
      notify?.("Timetable saved", "success");
    } catch (e) { notify?.(e.message || "Couldn't save the row", "error"); }
    setBusy(false);
  };
  const delSlot = async (s) => {
    if (!window.confirm(`Remove "${s.title}" (${TT_DAY_SHORT[s.day]} ${s.start})?`)) return;
    try { await api.removeTimetableSlot(s.id); await load(); notify?.("Row removed", "info"); }
    catch (e) { notify?.(e.message || "Couldn't remove the row", "error"); }
  };
  const setPublished = async (published) => {
    setBusy(true);
    try {
      const r = await api.publishTimetable({ ...scoped, published });
      await load();
      notify?.(published ? `Published — students on this course now see ${r.count} row${r.count === 1 ? "" : "s"}` : "Unpublished — hidden from students while you edit", published ? "success" : "info");
    } catch (e) { notify?.(e.message || "Couldn't update publishing", "error"); }
    setBusy(false);
  };

  // Publish state across the rows currently in scope: none / draft / partly / published.
  const total = data.slots.length;
  const pubCount = data.slots.filter(s => s.published).length;
  const pubState = total === 0 ? "empty" : pubCount === 0 ? "draft" : pubCount === total ? "published" : "partial";

  const slotsByDay = useMemo(() => {
    const m = {};
    for (const s of data.slots) { (m[s.day] = m[s.day] || []).push(s); }
    for (const d of Object.keys(m)) m[d].sort((a, b) => a.start.localeCompare(b.start));
    return m;
  }, [data.slots]);
  const unitsNoSlot = data.units.filter(u => u.slotCount === 0);

  return (
    <>
      <AdminHeader title="Timetable" subtitle="Build the weekly timetable students see — per course, year and term" Icon={CalendarClock} />

      {/* Scope pickers */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Course"><select value={courseId} onChange={e => { setCourseId(e.target.value); setYear(""); setTerm(""); }} className={inputCls}>{courses.length === 0 && <option value="">No courses yet</option>}{courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Year"><select value={year} onChange={e => { setYear(e.target.value); setTerm(""); }} className={inputCls}><option value="">All years</option>{years.map(y => <option key={y} value={y}>Year {y}</option>)}</select></Field>
        <Field label="Term"><select value={term} onChange={e => setTerm(e.target.value)} className={inputCls}><option value="">All terms</option>{termsForYear.map(t => <option key={t} value={t}>Term {t}</option>)}</select></Field>
        <div className="ml-auto flex gap-2">
          <button onClick={autofill} disabled={busy || !courseId} className="press inline-flex items-center gap-1.5 rounded-xl bg-slate-100 px-3 py-2.5 text-xs font-bold text-slate-600 transition hover:bg-slate-200 disabled:opacity-50"><RefreshCw size={14} className={busy ? "animate-spin" : ""} /> Auto-fill from units</button>
          <PrimaryBtn onClick={openNew} disabled={!courseId}><Plus size={16} /> Add row</PrimaryBtn>
        </div>
      </div>

      <p className="mb-3 flex items-start gap-1.5 rounded-xl bg-blue-50 px-3 py-2 text-[11px] leading-snug text-blue-700 ring-1 ring-blue-100"><Info size={13} className="mt-px shrink-0" /> Auto-fill reads each unit's registers to place its lectures and tutorials on the right day and time, using the unit's tutor. Then edit any row's time, lecturer or room, and add workshops or study-support rows by hand. Nothing shows to students until you press <b>Publish</b>.</p>

      {/* Units in the chosen scope: their dates, the days/times read from their registers,
          and an inline lecturer box — so you pick course + term, see the units, type who
          teaches each, and add it in one tap. Day/time come from the unit's registers. */}
      {!loading && data.units.length > 0 && (
        <div className="mb-4 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-2.5">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Units in {term ? "this term" : year ? "this year" : "this course"} — add each, then set its day, time, room and lecturer</p>
          </div>
          <div className="divide-y divide-slate-100">
            {data.units.map(u => {
              const inTT = u.slotCount > 0;
              return (
                <div key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-[220px] flex-1">
                    <p className="text-sm font-semibold text-slate-800">{u.name} <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">{u.code}</span></p>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {u.year != null && `Year ${u.year} · `}{u.termNumber != null && `Term ${u.termNumber}`}
                      {(u.startDate || u.endDate) && <> · {fmtDate(u.startDate)}–{fmtDate(u.endDate)}</>}
                      {u.tutor && <> · {u.tutor}</>}
                    </p>
                    {u.schedule?.length > 0
                      ? <p className="mt-0.5 text-[11px] text-slate-400">Registers suggest: {u.schedule.map(s => `${TT_DAY_SHORT[s.day]} ${s.start}–${s.end}${String(s.kind || "").toLowerCase() === "seminar" ? " (Tutorial)" : ""}`).join(" · ")}</p>
                      : <p className="mt-0.5 text-[11px] text-slate-400">No registers — you set the day and time when you add it.</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    {inTT && <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700 ring-1 ring-emerald-200"><Check size={12} /> In timetable</span>}
                    <button onClick={() => openUnit(u)} disabled={busy} className="press inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3.5 py-2 text-xs font-bold text-white transition hover:bg-blue-700 disabled:opacity-50"><Plus size={14} /> {inTT ? "Add another" : "Add to timetable"}</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Publish state for the scope in view. Students only ever see published rows, so
          this bar is where a built timetable is released — or pulled back to draft. */}
      {pubState !== "empty" && (
        <div className={`mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl px-3.5 py-2.5 ring-1 ${pubState === "published" ? "bg-emerald-50 ring-emerald-200" : pubState === "partial" ? "bg-amber-50 ring-amber-200" : "bg-slate-50 ring-slate-200"}`}>
          <div className="flex items-center gap-2 text-sm">
            {pubState === "published" && <><span className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-bold text-white"><Check size={12} /> Live</span><span className="text-emerald-800">Students on this course/year/term see this timetable.</span></>}
            {pubState === "draft" && <><span className="inline-flex items-center gap-1 rounded-full bg-slate-400 px-2 py-0.5 text-[11px] font-bold text-white">Draft</span><span className="text-slate-600">Not visible to students yet — publish when it's ready.</span></>}
            {pubState === "partial" && <><span className="inline-flex items-center gap-1 rounded-full bg-amber-500 px-2 py-0.5 text-[11px] font-bold text-white">Partly live</span><span className="text-amber-800">{pubCount} of {total} rows live · {total - pubCount} new draft{total - pubCount === 1 ? "" : "s"} not shown yet.</span></>}
          </div>
          <div className="flex gap-2">
            {pubState !== "draft" && <button onClick={() => setPublished(false)} disabled={busy} className="press rounded-xl bg-white px-3 py-2 text-xs font-bold text-slate-600 ring-1 ring-slate-200 transition hover:bg-slate-50 disabled:opacity-50">Unpublish</button>}
            {pubState !== "published" && <PrimaryBtn onClick={() => setPublished(true)} disabled={busy}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {pubState === "partial" ? "Publish new rows" : "Publish to students"}</PrimaryBtn>}
          </div>
        </div>
      )}

      {loading ? <div className="skeleton h-64 rounded-2xl" /> : (
        <>
          {data.slots.length === 0 && (
            <Card><EmptyState Icon={CalendarClock} title="No timetable yet" msg={data.units.length ? "Use the units above — set the lecturer and tap Add — or add a row by hand. Then Publish so students see it." : "Add units (with registers) to this course/year/term first, or add rows by hand."} /></Card>
          )}

          {/* Weekly grid, grouped by day */}
          {data.slots.length > 0 && (
            <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 overflow-x-auto max-w-full">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-400">
                  <tr><th className="px-4 py-3">Day</th><th className="px-4 py-3">Time</th><th className="px-4 py-3">Session</th><th className="px-4 py-3">Lecturer</th><th className="px-4 py-3">Venue</th><th className="px-4 py-3 text-right">Actions</th></tr>
                </thead>
                <tbody>
                  {[1, 2, 3, 4, 5, 6, 7].filter(d => slotsByDay[d]?.length).map(d => (
                    slotsByDay[d].map((s, idx) => (
                      <tr key={s.id} className="border-t border-slate-100 hover:bg-blue-50/30">
                        <td className="px-4 py-3 font-bold text-slate-700">{idx === 0 ? TT_DAYS[d] : ""}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-slate-600"><span className="font-semibold text-slate-500">{periodOf(s.start)}</span> {s.start}–{s.end}</td>
                        <td className="px-4 py-3"><span className="font-semibold text-slate-700">{s.title}</span>{s.unitCode && <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">{s.unitCode}</span>}{!s.published && <span className="ml-1.5 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">Draft</span>}</td>
                        <td className="px-4 py-3 text-slate-500">{s.lecturer || "—"}</td>
                        <td className="px-4 py-3">{s.room ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">{s.room}</span> : <span className="text-slate-300">—</span>}</td>
                        <td className="px-4 py-3"><div className="flex justify-end gap-1"><button onClick={() => openEdit(s)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><Edit3 size={15} /></button><button onClick={() => delSlot(s)} className="rounded-lg p-1.5 text-slate-300 hover:bg-rose-50 hover:text-rose-500"><Trash2 size={15} /></button></div></td>
                      </tr>
                    ))
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Units in this scope that have no timetable rows yet */}
          {unitsNoSlot.length > 0 && (
            <div className="mt-4 rounded-2xl bg-amber-50 p-3 ring-1 ring-amber-200">
              <p className="mb-1 text-xs font-bold text-amber-800">{unitsNoSlot.length} unit{unitsNoSlot.length === 1 ? "" : "s"} not on the timetable yet</p>
              <p className="text-[11px] text-amber-700">{unitsNoSlot.map(u => `${u.code}${u.sessionCount === 0 ? " (no registers)" : ""}`).join(" · ")}</p>
            </div>
          )}
        </>
      )}

      {/* Term dates & academic calendar (the "weekly structure" from the college email).
          Per exact year+term, so it only shows once a specific stage is picked. */}
      {!loading && courseId && year && term && (
        <div className="mt-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/70">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Term dates & academic calendar</p>
          <p className="mt-0.5 mb-3 text-[11px] text-slate-400">The start/end dates and the week-by-week structure students see. Dates are pre-filled from the units — adjust if needed, tap “Generate weeks”, set each week’s activity, then Save.</p>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Term start"><input type="date" value={cal.startDate} onChange={e => setCal(c => ({ ...c, startDate: e.target.value }))} className={inputCls} /></Field>
            <Field label="Term end"><input type="date" value={cal.endDate} onChange={e => setCal(c => ({ ...c, endDate: e.target.value }))} className={inputCls} /></Field>
            <button onClick={genWeeks} className="press inline-flex items-center gap-1.5 rounded-xl bg-slate-100 px-3 py-2.5 text-xs font-bold text-slate-600 transition hover:bg-slate-200"><RefreshCw size={14} /> Generate weeks</button>
          </div>

          {cal.weeks.length > 0 && (
            <div className="mt-3 overflow-hidden rounded-xl ring-1 ring-slate-200 overflow-x-auto max-w-full">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="bg-slate-50 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400">
                  <tr><th className="px-3 py-2">Week</th><th className="px-3 py-2">Commencing</th><th className="px-3 py-2">Activity</th><th className="px-3 py-2"></th></tr>
                </thead>
                <tbody>
                  {cal.weeks.map((w, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-bold text-slate-600">{w.n}</td>
                      <td className="px-3 py-2"><input type="date" value={w.wc || ""} onChange={e => setWeek(i, { wc: e.target.value })} className={`${inputCls} !py-1.5`} /></td>
                      <td className="px-3 py-2"><input list="tt-activities" value={w.activity || ""} onChange={e => setWeek(i, { activity: e.target.value })} placeholder="Teaching" className={`${inputCls} !py-1.5`} /></td>
                      <td className="px-3 py-2 text-right"><button onClick={() => removeWeek(i)} className="rounded-lg p-1.5 text-slate-300 hover:bg-rose-50 hover:text-rose-500"><Trash2 size={14} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <datalist id="tt-activities"><option value="Teaching" /><option value="Formative Feedback" /><option value="Assessment" /><option value="Reading Week" /><option value="Break" /><option value="Extra-curricular activities" /></datalist>
            </div>
          )}

          <div className="mt-3 flex items-center gap-2">
            <PrimaryBtn onClick={saveCalendar} disabled={busy}>{busy ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} Save term dates & calendar</PrimaryBtn>
            {cal.weeks.length === 0 && <span className="text-[11px] text-slate-400">Set the dates and tap “Generate weeks” to build the calendar.</span>}
          </div>
        </div>
      )}

      {/* Add / edit row */}
      <Modal open={!!modal} onClose={() => setModal(null)} title={modal === "new" ? "Add timetable row" : "Edit timetable row"}>
        <div className="space-y-3">
          {modal === "new" && (form.year || form.termNumber) && (
            <p className="rounded-lg bg-blue-50 px-3 py-2 text-[11px] font-semibold text-blue-700">Adds to {[form.year ? `Year ${form.year}` : null, form.termNumber ? `Term ${form.termNumber}` : null].filter(Boolean).join(" · ")} — the stage students on it will see.</p>
          )}
          <p className="text-[11px] font-semibold text-slate-400">When it runs each week — pick the day and start/end time.</p>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Day"><select value={form.day} onChange={e => setForm(f => ({ ...f, day: e.target.value }))} className={inputCls}>{[1, 2, 3, 4, 5, 6, 7].map(d => <option key={d} value={d}>{TT_DAYS[d]}</option>)}</select></Field>
            <Field label="Start"><input type="time" value={form.start} onChange={e => setForm(f => ({ ...f, start: e.target.value }))} className={inputCls} /></Field>
            <Field label="End"><input type="time" value={form.end} onChange={e => setForm(f => ({ ...f, end: e.target.value }))} className={inputCls} /></Field>
          </div>
          <Field label="Session"><input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="e.g. Operational Planning and Management, or Study Support" className={inputCls} /></Field>
          <Field label="Lecturer"><input value={form.lecturer} onChange={e => setForm(f => ({ ...f, lecturer: e.target.value }))} placeholder="e.g. Dr Funke Ogunjimi" className={inputCls} /></Field>
          <Field label="Venue / room"><input value={form.room} onChange={e => setForm(f => ({ ...f, room: e.target.value }))} placeholder="e.g. Room 101, Online, Study Room 1st Floor" className={inputCls} /></Field>
          {modal === "new" && (
            <Field label="Link to a unit (optional)"><select value={form.unitId} onChange={e => { const u = data.units.find(x => x.id === e.target.value); setForm(f => ({ ...f, unitId: e.target.value, title: f.title || (u?.name || ""), lecturer: f.lecturer || (u?.tutor || ""), year: u ? (u.year ?? f.year) : f.year, termNumber: u ? (u.termNumber ?? f.termNumber) : f.termNumber })); }} className={inputCls}><option value="">Not a taught unit (workshop / support)</option>{data.units.map(u => <option key={u.id} value={u.id}>{u.code} — {u.name}</option>)}</select></Field>
          )}
          <PrimaryBtn onClick={saveSlot} disabled={busy || !form.title.trim()} className="w-full">{busy ? <><Loader2 size={16} className="animate-spin" /> Saving…</> : <><Check size={16} /> Save row</>}</PrimaryBtn>
        </div>
      </Modal>
    </>
  );
}

/* ============================== Audit trail ==============================
 *
 * Reading what the server recorded. There is no form on this page and no way to
 * edit or delete a row, matching the API: a log the people it records can change
 * is not evidence, and the reason a college asks for an audit trail is to be able
 * to answer "who changed this" to somebody who does not take the answer on trust.
 *
 * Who sees it: whoever holds Settings, Access or Staff — the pages that already
 * carry administrative authority. That list is the server's, in routes/audit.js;
 * AUDIT_READER_PAGES below mirrors it, and the two have to agree or the tab appears
 * for someone the API then refuses.
 */
const AUDIT_READER_PAGES = ["settings", "access", "staff"];

// Who acted, in a word. A platform operator is not a member of staff, and a failed
// sign-in has no account behind it at all — so the tier is shown, not inferred from
// the address.
const ACTOR_TONE = {
  platform: { label: "Platform", cls: "bg-purple-100 text-purple-700" },
  staff: { label: "Staff", cls: "bg-blue-100 text-blue-700" },
  student: { label: "Student", cls: "bg-emerald-100 text-emerald-700" },
  applicant: { label: "Applicant", cls: "bg-amber-100 text-amber-700" },
  anonymous: { label: "Not signed in", cls: "bg-rose-100 text-rose-700" },
  system: { label: "System", cls: "bg-slate-100 text-slate-600" },
};

const auditWhen = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso || "");
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

// One changed field, rendered as "was -> now". A null on either side is spelled out
// rather than left blank: "(none)" says a value was added or cleared, where an empty
// cell just looks like the page failed to render something.
function AuditDiff({ before, after }) {
  const keys = Array.from(new Set([...Object.keys(before || {}), ...Object.keys(after || {})]));
  if (!keys.length) return null;
  const show = (v) => {
    if (v === null || v === undefined) return <span className="text-slate-400">(none)</span>;
    if (typeof v === "object") return <code className="text-[11px]">{JSON.stringify(v)}</code>;
    if (v === "") return <span className="text-slate-400">(empty)</span>;
    return String(v);
  };
  return (
    <table className="w-full text-[12px]">
      <tbody>
        {keys.map(k => (
          <tr key={k} className="align-top">
            <td className="w-44 py-1 pr-3 font-semibold text-slate-500">{k}</td>
            <td className="py-1 pr-2 text-slate-500 line-through decoration-slate-300">{show(before ? before[k] : null)}</td>
            <td className="w-4 py-1 text-slate-400">&rarr;</td>
            <td className="py-1 font-medium text-slate-700">{show(after ? after[k] : null)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AuditTrail() {
  const [rows, setRows] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [actions, setActions] = useState([]);
  const [filters, setFilters] = useState({ action: "", from: "", to: "" });
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);

  // The distinct verbs, once. Read from the data rather than a list held here, so a
  // newly recorded action appears in the filter without a client release.
  useEffect(() => {
    let dead = false;
    api.auditActions().then(a => { if (!dead) setActions(a || []); }).catch(() => { /* the filter degrades to "all", which is fine */ });
    return () => { dead = true; };
  }, []);

  // Re-fetch from the top whenever a server-side filter changes. `query` is NOT in
  // here on purpose: it filters what is already loaded, so typing does not fire a
  // request per keystroke.
  useEffect(() => {
    let dead = false;
    setLoading(true); setError(null);
    api.audit({ ...filters, take: 50 })
      .then(r => { if (dead) return; setRows(r.entries || []); setCursor(r.nextCursor || null); })
      .catch(e => { if (!dead) setError(e.message || "Could not load the audit trail"); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [filters]);

  const loadMore = async () => {
    if (!cursor || more) return;
    setMore(true);
    try {
      const r = await api.audit({ ...filters, take: 50, cursor });
      setRows(prev => [...prev, ...(r.entries || [])]);
      setCursor(r.nextCursor || null);
    } catch (e) { setError(e.message || "Could not load any more"); }
    finally { setMore(false); }
  };

  const ql = query.trim().toLowerCase();
  const shown = ql
    ? rows.filter(r => [r.summary, r.actorEmail, r.action, r.entity, r.entityId].some(v => String(v || "").toLowerCase().includes(ql)))
    : rows;

  // Exports what is on screen, not the whole table — the filters above say what the
  // person actually asked for, and silently handing back everything instead would be
  // the wrong file to give to whoever requested it.
  const exportRows = () => {
    downloadCSV("audit-trail.csv", [
      { key: "at", label: "When" }, { key: "actorType", label: "Actor type" }, { key: "actorEmail", label: "Actor" },
      { key: "action", label: "Action" }, { key: "summary", label: "Summary" },
      { key: "entity", label: "Record" }, { key: "entityId", label: "Record id" }, { key: "ip", label: "IP" },
    ], shown.map(r => ({ ...r, at: auditWhen(r.at) })));
  };

  return (
    <>
      <AdminHeader
        title="Audit trail"
        subtitle="Who changed what, and when — recorded automatically and read-only"
        Icon={History}
        action={<ExportBtn onClick={exportRows} label="Export shown" />}
      />

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
          <Search size={15} className="text-slate-400" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search this page…" className="w-full bg-transparent text-sm outline-none" />
        </div>
        <select value={filters.action} onChange={e => setFilters(f => ({ ...f, action: e.target.value }))} className="rounded-xl bg-white px-3 py-2 text-sm ring-1 ring-slate-200 outline-none">
          <option value="">All actions</option>
          {actions.map(a => <option key={a.action} value={a.action}>{a.action} ({a.count})</option>)}
        </select>
        <label className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm ring-1 ring-slate-200">
          <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">From</span>
          <input type="date" value={filters.from} onChange={e => setFilters(f => ({ ...f, from: e.target.value }))} className="w-full bg-transparent outline-none" />
        </label>
        <label className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm ring-1 ring-slate-200">
          <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">To</span>
          <input type="date" value={filters.to} onChange={e => setFilters(f => ({ ...f, to: e.target.value }))} className="w-full bg-transparent outline-none" />
        </label>
      </div>

      {error && <div className="mb-3 flex items-center gap-2 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700 ring-1 ring-rose-200"><AlertCircle size={16} /> {error}</div>}

      <div className="overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 fade-up [-webkit-overflow-scrolling:touch]">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-400">
            <tr><th className="px-5 py-3">When</th><th className="px-5 py-3">Who</th><th className="px-5 py-3">What happened</th><th className="px-5 py-3">Action</th><th className="px-5 py-3"></th></tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={5} className="px-5 py-10 text-center text-slate-400"><Loader2 size={18} className="mx-auto animate-spin" /></td></tr>}
            {!loading && !shown.length && (
              <tr><td colSpan={5} className="px-5 py-10 text-center text-sm text-slate-400">
                {rows.length ? "Nothing on this page matches that search." : "No entries for these filters yet."}
              </td></tr>
            )}
            {!loading && shown.map(r => {
              const tone = ACTOR_TONE[r.actorType] || ACTOR_TONE.system;
              const hasDetail = (r.before && Object.keys(r.before).length) || (r.after && Object.keys(r.after).length);
              const isOpen = open === r.id;
              return (
                <React.Fragment key={r.id}>
                  <tr className="border-t border-slate-100 transition-colors duration-150 hover:bg-blue-50/40">
                    <td className="whitespace-nowrap px-5 py-3 text-[12px] text-slate-500">{auditWhen(r.at)}</td>
                    <td className="px-5 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${tone.cls}`}>{tone.label}</span>
                      <p className="mt-1 text-[12px] text-slate-600">{r.actorEmail || <span className="text-slate-400">&mdash;</span>}</p>
                    </td>
                    <td className="px-5 py-3 text-slate-700">{r.summary}</td>
                    <td className="px-5 py-3"><code className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">{r.action}</code></td>
                    <td className="px-5 py-3 text-right">
                      {hasDetail ? (
                        <button onClick={() => setOpen(isOpen ? null : r.id)} className="text-[12px] font-semibold text-blue-600 hover:underline">
                          {isOpen ? "Hide" : "Details"}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-t border-slate-100 bg-slate-50/60">
                      <td colSpan={5} className="px-5 py-3">
                        <AuditDiff before={r.before} after={r.after} />
                        <p className="mt-2 text-[11px] text-slate-400">
                          {r.entity ? `${r.entity} ${r.entityId || ""} · ` : ""}{r.ip ? `from ${r.ip}` : "no address recorded"}
                        </p>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {cursor && !loading && (
        <div className="mt-3 text-center">
          <button onClick={loadMore} disabled={more} className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-50">
            {more ? "Loading…" : "Load older entries"}
          </button>
        </div>
      )}
      <p className="mt-3 text-center text-[11px] text-slate-400">
        Entries are written automatically and cannot be edited or deleted from here.
      </p>
    </>
  );
}

function AdminSettings({ store }) {
  const [modal, setModal] = useState(false);
  const [edit, setEdit] = useState(null);
  const [form, setForm] = useState({ name: "", role: "", dept: "Sixth Form", email: "", allowance: 28, dob: "" });
  const depts = Array.from(new Set(store.staff.map(s => s.dept)));
  const deptOptions = Array.from(new Set([...depts, "Sixth Form", "Tuition Centre", "Exam Centre", "Administration", "Higher Education"])).sort();
  const openAdd = () => { setEdit(null); setForm({ name: "", role: "", dept: depts[0] || "Sixth Form", email: "", allowance: 28, dob: "" }); setModal(true); };
  const openEdit = (s) => { setEdit(s); setForm({ name: s.name, role: s.role, dept: s.dept, email: s.email, allowance: s.allowance, dob: s.dob || "" }); setModal(true); };
  const save = async () => {
    if (!form.name.trim()) return;
    if (edit) await store.updateStaff(edit.id, { name: form.name, role: form.role, dept: form.dept, email: form.email, allowance: Number(form.allowance), dob: form.dob || null });
    else await store.addStaff({ name: form.name, role: form.role, dept: form.dept, email: form.email, allowance: Number(form.allowance), dob: form.dob || null });
    setModal(false);
  };
  // Deleting a staff member cascades their entire history — leave, check-ins,
  // balance adjustments, notifications — with no undo. A single misclick in a
  // twelve-row table should not be able to do that, so confirm first.
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const resendInvite = async (s) => {
    try { const r = await api.resendInvite(s.id); store.notify(r?.message || `Invitation re-sent to ${s.email}`); }
    catch (e) { store.notify(e.message || "Could not re-send the invitation", "error"); }
  };
  const confirmRemove = async () => {
    setDeleteBusy(true);
    try { await store.removeStaff(deleteTarget.id); setDeleteTarget(null); }
    catch (_) { /* store already toasted and refetched */ }
    finally { setDeleteBusy(false); }
  };
  // Two-step verification reset — the recovery path for a lost or replaced phone.
  const [resetTarget, setResetTarget] = useState(null);
  const [resetBusy, setResetBusy] = useState(false);
  const confirmReset = async () => {
    setResetBusy(true);
    try { await store.resetStaffTotp(resetTarget.id); setResetTarget(null); }
    catch (_) { /* store already toasted the error and refetched */ }
    finally { setResetBusy(false); }
  };
  const [query, setQuery] = useState("");
  const ql = query.trim().toLowerCase();
  const filteredStaff = store.staff.filter(s => !ql || s.name.toLowerCase().includes(ql) || (s.email || "").toLowerCase().includes(ql) || (s.role || "").toLowerCase().includes(ql) || (s.dept || "").toLowerCase().includes(ql));
  const paged = usePaged(filteredStaff, 12, ql);
  const exportStaff = () => {
    const rows = store.staff.map(s => ({
      name: s.name, email: s.email, role: s.role, dept: s.dept, allowance: s.allowance,
      twoStep: s.totpEnabled ? "On" : s.totpRequired ? "Setup due" : "Off",
    }));
    downloadCSV("staff.csv", [
      { key: "name", label: "Name" }, { key: "email", label: "Email" }, { key: "role", label: "Role" }, { key: "dept", label: "Dept" }, { key: "allowance", label: "Allowance" },
      { key: "twoStep", label: "2-step verification" },
    ], rows);
    store.notify("Exported staff CSV");
  };
  return (
    <>
      <AdminHeader title="Settings" subtitle="Manage staff members and departments" Icon={Settings} action={<div className="flex flex-wrap items-center gap-2"><ExportBtn onClick={exportStaff} label="Export staff" /><PrimaryBtn onClick={openAdd}><UserPlus size={16} /> Add staff</PrimaryBtn></div>} />
      <div className="mb-4">
        <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">Your institution</p>
        {/* Name, colours and logo — this college's own, used across the app, its
            emails and its letters. Nothing here is shared with any other institution. */}
        <BrandingSettings />
      </div>
      <div className="mb-4">
        <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">Letters &amp; emails</p>
        {/* This college's own offer letter and application form, and its own wording for
            every email sent on its behalf. */}
        <DocumentSettings />
      </div>
      <div className="mb-4">
        <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">Connected systems</p>
        {/* This institution's OWN Moodle / SharePoint credentials — encrypted, and not
            readable by any other institution or by a platform operator. */}
        <IntegrationSettings />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="mb-3 flex items-center gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200"><Search size={15} className="text-slate-400" /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name, email, role or dept…" className="w-full bg-transparent text-sm outline-none" /></div>
          <div className="overflow-x-auto overflow-y-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 fade-up [-webkit-overflow-scrolling:touch] md:overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-400"><tr><th className="px-5 py-3">Name</th><th className="px-5 py-3">Role</th><th className="px-5 py-3">Dept</th><th className="px-5 py-3">Allowance</th><th className="px-5 py-3">2-Step</th><th className="px-5 py-3"></th></tr></thead>
              <tbody>
                {paged.slice.map(s => (
                  <tr key={s.id} className="border-t border-slate-100 transition-colors duration-150 hover:bg-blue-50/40">
                    <td className="px-5 py-3"><div className="flex items-center gap-2.5"><span className="flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-sm" style={{ background: s.colour }}>{s.initials}</span><div><p className="font-semibold text-slate-700">{s.name}</p><p className="text-[11px] text-slate-400">{s.email}</p></div></div></td>
                    <td className="px-5 py-3 text-slate-500">{s.role}</td><td className="px-5 py-3 text-slate-500">{s.dept}</td><td className="px-5 py-3 font-medium text-slate-600">{s.allowance}d</td>
                    <td className="px-5 py-3">{twoStepBadge(s)}</td>
                    <td className="px-5 py-3"><div className="flex gap-1">
                      {s.pendingActivation && <button onClick={() => resendInvite(s)} title="Re-send the invitation email" className="rounded-lg p-1.5 text-slate-400 hover:bg-blue-50 hover:text-blue-600"><Mail size={15} /></button>}
                      {s.totpEnabled && <button onClick={() => setResetTarget(s)} title="Reset two-step verification" className="rounded-lg p-1.5 text-slate-400 hover:bg-amber-50 hover:text-amber-600"><ShieldCheck size={15} /></button>}
                      <button onClick={() => openEdit(s)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><Edit3 size={15} /></button>
                      <button onClick={() => setDeleteTarget(s)} title="Remove staff member" className="rounded-lg p-1.5 text-slate-300 hover:bg-rose-50 hover:text-rose-500"><Trash2 size={15} /></button>
                    </div></td>
                  </tr>
                ))}
                {paged.slice.length === 0 && <tr><td colSpan={6} className="px-5 py-10"><EmptyState Icon={Search} title="No staff match" msg="Try a different search term." /></td></tr>}
              </tbody>
            </table>
          </div>
          <Pagination className="mt-4" page={paged.page} setPage={paged.setPage} totalPages={paged.totalPages} total={paged.total} />
        </div>
        <div className="space-y-4">
          <MoodleCard store={store} />
          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70 fade-up">
            <div className="mb-3 flex items-center justify-between"><p className="flex items-center gap-1.5 text-sm font-bold text-slate-700"><Building2 size={15} /> Departments</p><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">{depts.length}</span></div>
            <div className="space-y-2.5">{depts.map((d, i) => { const n = store.staff.filter(s => s.dept === d).length; const total = store.staff.length; const pct = total > 0 ? Math.round((n / total) * 100) : 0; const c = PALETTE[i % PALETTE.length]; return (
              <div key={d} className="rounded-xl bg-slate-50 px-3 py-2 transition-all duration-200 hover:translate-x-1 hover:bg-slate-100">
                <div className="flex items-center justify-between text-sm"><span className="flex items-center gap-2 font-semibold text-slate-700"><span className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />{d}</span><span className="rounded-full bg-white px-2 py-0.5 text-xs font-bold text-slate-500">{n}</span></div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white shadow-inner"><div className="h-full rounded-full" style={{ width: `${pct}%`, background: c, transition: "width .8s cubic-bezier(.4,0,.2,1)" }} /></div>
              </div>
            ); })}</div>
          </div>
          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70 fade-up">
            <p className="mb-3 flex items-center gap-1.5 text-sm font-bold text-slate-700"><Award size={15} style={{ color: MAROON }} /> At a glance</p>
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="rounded-xl bg-slate-50 py-2.5"><p className="text-lg font-extrabold" style={{ color: NAVY }}>{store.staff.length}</p><p className="text-[10px] text-slate-400">Staff</p></div>
              <div className="rounded-xl bg-slate-50 py-2.5"><p className="text-lg font-extrabold" style={{ color: NAVY }}>{depts.length}</p><p className="text-[10px] text-slate-400">Departments</p></div>
              <div className="rounded-xl bg-slate-50 py-2.5"><p className="text-lg font-extrabold" style={{ color: NAVY }}>{store.staff.length > 0 ? Math.round(store.staff.reduce((a, s) => a + (s.allowance || 0), 0) / store.staff.length) : 0}d</p><p className="text-[10px] text-slate-400">Avg allowance</p></div>
              <div className="rounded-xl bg-slate-50 py-2.5"><p className="text-lg font-extrabold" style={{ color: NAVY }}>{store.docs.length}</p><p className="text-[10px] text-slate-400">Documents</p></div>
            </div>
          </div>
          <div className="animated-gradient relative overflow-hidden rounded-2xl p-5 text-white shadow-md transition-all duration-300 hover:shadow-xl fade-up" style={{ background: `linear-gradient(135deg, ${NAVY} 0%, ${NAVY_DARK} 45%, ${MAROON} 130%)`, backgroundSize: "200% 200%" }}><Building2 size={64} className="float-slow absolute -right-3 -top-3 text-white/10" /><div className="relative mb-2 flex h-9 w-12 items-center justify-center rounded-md bg-white"><Logo small /></div><p className="relative text-sm font-bold">EdTech</p><p className="relative mt-1 flex items-center gap-1.5 text-xs text-white/70"><MapPin size={12} /> 42 The Burroughs, London NW4 4AP</p><p className="relative flex items-center gap-1.5 text-xs text-white/70"><Phone size={12} /> 020 8202 2007</p><p className="relative mt-3 text-[11px] text-white/50">Staff Hub Admin Console v2.0</p><p className="relative text-[11px] text-white/50">© 2026 Syed Muhammad Raza</p></div>
        </div>
      </div>
      <Modal open={!!deleteTarget} onClose={() => !deleteBusy && setDeleteTarget(null)} title="Remove staff member">
        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200">
            <span className="flex h-9 w-9 items-center justify-center rounded-full text-[11px] font-bold text-white" style={{ background: deleteTarget?.colour }}>{deleteTarget?.initials}</span>
            <div><p className="text-sm font-bold text-slate-700">{deleteTarget?.name}</p><p className="text-[11px] text-slate-400">{deleteTarget?.role} · {deleteTarget?.dept}</p></div>
          </div>
          <p className="flex items-start gap-1.5 rounded-xl bg-rose-50 px-3 py-2 text-[11px] leading-relaxed text-rose-700 ring-1 ring-rose-200">
            <AlertCircle size={13} className="mt-px shrink-0" />
            This permanently deletes their account <b>and their entire history</b> — leave requests,
            check-ins, balance adjustments and notifications. It cannot be undone.
          </p>
          <PrimaryBtn colour={MAROON} onClick={confirmRemove} disabled={deleteBusy} className="w-full">
            <Trash2 size={16} /> {deleteBusy ? "Removing…" : `Remove ${deleteTarget?.name || ""}`}
          </PrimaryBtn>
          <button onClick={() => setDeleteTarget(null)} disabled={deleteBusy} className="press w-full text-center text-xs font-semibold text-slate-400 transition hover:text-slate-600">Cancel</button>
        </div>
      </Modal>
      <Modal open={!!resetTarget} onClose={() => !resetBusy && setResetTarget(null)} title="Reset two-step verification">
        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200">
            <span className="flex h-9 w-9 items-center justify-center rounded-full text-[11px] font-bold text-white" style={{ background: resetTarget?.colour }}>{resetTarget?.initials}</span>
            <div><p className="text-sm font-bold text-slate-700">{resetTarget?.name}</p><p className="text-[11px] text-slate-400">{resetTarget?.email}</p></div>
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            Use this when someone has lost or replaced the phone holding their authenticator app.
            Their existing codes stop working immediately.
          </p>
          <p className="flex items-start gap-1.5 rounded-xl bg-blue-50 px-3 py-2 text-[11px] leading-relaxed text-blue-700 ring-1 ring-blue-100">
            <ShieldCheck size={13} className="mt-px shrink-0" />
            {resetTarget?.totpRequired
              ? "Two-step verification is required for this account, so they'll be asked to set up a new authenticator the next time they sign in."
              : "This account will sign in with just a password until they choose to turn two-step verification back on."}
          </p>
          <p className="text-[11px] text-slate-400">Their password is not changed, so this on its own doesn't let anyone in.</p>
          <PrimaryBtn colour="#b45309" onClick={confirmReset} disabled={resetBusy} className="w-full">
            <ShieldCheck size={16} /> {resetBusy ? "Resetting…" : "Reset two-step verification"}
          </PrimaryBtn>
        </div>
      </Modal>
      <Modal open={modal} onClose={() => setModal(false)} title={edit ? "Edit staff member" : "Add staff member"}>
        <div className="space-y-3">
          <Field label="Full name"><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Maria Gonzalez" className={inputCls} /></Field>
          <Field label="Role"><input value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))} placeholder="e.g. Physics Teacher" className={inputCls} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Department"><select value={form.dept} onChange={e => setForm(f => ({ ...f, dept: e.target.value }))} className={inputCls}>{deptOptions.map(d => <option key={d}>{d}</option>)}</select></Field><Field label="Allowance (days)"><input type="number" value={form.allowance} onChange={e => setForm(f => ({ ...f, allowance: e.target.value }))} className={inputCls} /></Field></div>
          <Field label="Email"><input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="name@edtech.co.uk" className={inputCls} /></Field>
          <Field label="Date of birth"><input type="date" value={form.dob} onChange={e => setForm(f => ({ ...f, dob: e.target.value }))} className={inputCls} /></Field>
          <PrimaryBtn onClick={save} disabled={!form.name.trim()} className="w-full"><Save size={16} /> {edit ? "Save changes" : "Add staff member"}</PrimaryBtn>
        </div>
      </Modal>
    </>
  );
}
