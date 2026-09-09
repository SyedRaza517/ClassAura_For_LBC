// Live Attendance — the register as it fills, during the class.
//
// Reached only by staff who hold an admin account with the live-attendance or
// registers page: /api/hnd is admin-only by design (DEF-01 in server/src/routes/
// hnd.js). A tutor without that grant sees no tab and could not load it if they
// did, so a college that wants every tutor watching their own class has to grant
// them the page deliberately.
//
// Who is in, who is late, who has not appeared, and the minute each of them tapped. It
// polls while a class is running and stops when it is not, because a screen left open on
// a lecturer's desk overnight should not keep asking the server a question whose answer
// cannot change.
//
// WHAT THIS SCREEN WILL NOT DO
//
// "Not tapped" is a display state, never a mark. Nothing is written for those students
// until somebody presses "Mark the rest absent", and that button says how many people it
// is about to affect before it does it. Automatic absence would turn a flat battery, a
// forgotten phone or a handset with no NFC into a permanent academic record — most often
// for the students least able to argue about it.
import React, { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import {
  Radio, Loader2, AlertTriangle, RefreshCw, CheckCircle2, Clock3, UserX,
  Nfc, Lock, CalendarX, ChevronRight, QrCode, X, CalendarDays, Search,
} from "lucide-react";
import QRCode from "qrcode";
import { api } from "./api";
import { scanLinkFor, isLocalOnlyOrigin } from "./scanLink";
import ConfirmDialog from "./ConfirmDialog";
import { NAVY } from "./branding";

// How often the live view re-reads while a class is running. Slow enough not to hammer a
// free-tier API with a lecture theatre's worth of open laptops, fast enough that a
// student who taps sees their name appear before they have sat down.
const POLL_MS = 10_000;

const STATUS = {
  P: { label: "Present", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  L: { label: "Late", cls: "bg-amber-50 text-amber-700 ring-amber-200" },
  E: { label: "Excused", cls: "bg-sky-50 text-sky-700 ring-sky-200" },
  A: { label: "Absent", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
};

// Attendance banding. The thresholds are the ones the rest of the platform already uses
// for its RAG bands, restated here rather than imported because this screen colours a
// number and the band config colours a decision -- a college that moves its intervention
// threshold has not asked for its register to change colour.
//
// Null never reaches this: a student with no marks has no percentage, and the caller
// renders an em dash instead of asking for a colour for a fact that does not exist.
const pctColour = (pct) => (pct >= 85 ? "#059669" : pct >= 75 ? "#d97706" : "#e11d48");

// THE REGISTER'S COLUMNS, in the order a lecturer reads them: the good outcome, the
// qualified ones, the bad one, then the one that means nobody has decided.
//
// Colours come from STATUS above rather than being restated, so a column and the pill
// for the same outcome can never disagree. "N/A" has no STATUS entry because it is NOT
// a status — nothing is ever written for it — and giving it one here would be the first
// step toward somebody storing it.
const MARK_COLUMNS = [
  { key: "P", label: "Present", mark: "P", cls: STATUS.P.cls },
  { key: "L", label: "Late", mark: "L", cls: STATUS.L.cls },
  { key: "E", label: "Excused", mark: "E", cls: STATUS.E.cls },
  { key: "A", label: "Absent", mark: "A", cls: STATUS.A.cls },
  { key: "NA", label: "N/A", mark: "—", cls: "bg-slate-100 text-slate-500 ring-slate-300" },
];

// The summary panel's tiles, in the order a lecturer reads them.
//
// EXCUSED IS HERE even though it is the least interesting of the four, because the four
// letters plus "not marked" are the whole register and a tile missing from the row is a
// column of students who silently stop adding up. `notMarked` reuses the slate ring the
// rest of this file gives to "nothing has happened yet" rather than borrowing the rose
// one: it is not an absence, it looks nothing like one, and colouring it as one is the
// first step to somebody treating it as one.
const TILES = [
  { key: "P", label: "Present", cls: STATUS.P.cls },
  { key: "L", label: "Late", cls: STATUS.L.cls },
  { key: "E", label: "Excused", cls: STATUS.E.cls },
  { key: "A", label: "Absent", cls: STATUS.A.cls },
  { key: "notMarked", label: "Not marked", cls: "bg-slate-50 text-slate-600 ring-slate-200" },
];

// NULL IS NOT ZERO, on the screen as much as in the database. `notMarked` is null when
// the register has no roster to measure against — a Moodle import that never synced
// enrolments — and printing 0 there would tell a lecturer everybody is accounted for on
// a class nobody can size. An em dash, with the reason on hover.
const NOT_MEASURED = "Not recorded — this class has no roster to count against.";
const shown = (v) => (v === null || v === undefined ? "—" : v);

// `settingsHref` is where "switch it on" should send an administrator who holds the
// settings page, or null for everyone else (the staff app, a watch-only admin), who are
// told to ask instead. The link is a fragment because the console routes on the hash.
export default function AdminLiveAttendance({ settingsHref = null }) {
  // "mine" is the default because a lecturer opening this wants their own class, and
  // making the whole college the default would bury it. Remembered per browser so an
  // administrator who lives on the college-wide view is not re-choosing it every day.
  const [scope, setScope] = useState(() => {
    try { return localStorage.getItem("edtech.liveAttendanceScope") === "all" ? "all" : "mine"; }
    catch { return "mine"; }
  });
  const [today, setToday] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(true);
  // WHICH DAY IS BEING LOOKED AT. Empty string means "today", and it stays empty rather
  // than being filled in with a computed date: the college's today is the SERVER's, in
  // APP_TIMEZONE, and a browser in another timezone that helpfully filled this in would
  // ask about the wrong day and be answered accurately about it.
  //
  // This exists because a screen that can only show today is blank — and looks broken —
  // on every day the college is not teaching, including the whole week before term.
  const [date, setDate] = useState("");
  // The END of a range, or "" for a single day. Separate from `date` rather than a
  // {from,to} pair so the common case -- one day -- needs no second field filled in and
  // the control can stay hidden until asked for.
  const [to, setTo] = useState("");
  const [ranged, setRanged] = useState(false);

  const loadToday = useCallback(async () => {
    setBusy(true); setErr("");
    try { setToday(await api.mySessionsToday(scope, date, ranged ? to : "")); }
    catch (e) { setErr(e?.message || "Could not load those classes."); }
    finally { setBusy(false); }
  }, [scope, date, to, ranged]);
  useEffect(() => { loadToday(); }, [loadToday]);

  if (busy && !today) return <div className="flex justify-center p-12"><Loader2 className="animate-spin text-slate-300" size={28} /></div>;

  if (chosen) return <LiveSession sessionId={chosen} settingsHref={settingsHref} onBack={() => { setChosen(null); loadToday(); }} />;

  const sessions = today?.sessions || [];
  const chooseScope = (next) => {
    setScope(next);
    try { localStorage.setItem("edtech.liveAttendanceScope", next); } catch { /* private mode */ }
  };

  return (
    <div className="space-y-4 p-4 md:p-6">
      <header>
        <h2 className="flex items-center gap-2 text-lg font-bold text-slate-800"><Radio size={18} style={{ color: NAVY }} />Live Attendance</h2>
        <p className="mt-0.5 text-[13px] text-slate-500">
          {today?.isToday === false
            ? (today?.to
                ? `${scope === "all" ? "Every class" : "Your classes"} from ${today.date} to ${today.to}.`
                : (scope === "all" ? "Every class on the day you have chosen." : "Your classes on the day you have chosen."))
            : (scope === "all" ? "Every class running today, and the registers as they fill." : "Your classes today, and the registers as they fill.")}
        </p>
      </header>

      {/* THE DAY PICKER. Not a nicety: this screen answers "what is happening" for one
          date, and before this it could only ever be asked about the current one. On the
          Wednesday before a term that starts on the Tuesday, an administrator checking
          that the registers exist saw an empty page and no way to tell a correctly-quiet
          Wednesday from a term that had failed to save.

          "Today" is a separate button rather than a date typed back in, because the
          college's today lives on the server: clearing the field asks for "today" and
          lets the server answer, where filling in the browser's date would ask about
          whatever day the reader's laptop thinks it is. */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
          <CalendarDays size={15} className="text-slate-400" />
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Day</span>
          <input type="date" value={date || today?.date || ""} onChange={(e) => setDate(e.target.value)}
            className="bg-transparent text-[13px] font-semibold text-slate-700 outline-none" />
        </label>
        {/* The range half, hidden until asked for. A second date box standing open on a
            screen almost always used for one day is a field people feel obliged to fill
            in, and a wrong end date silently changes what they are reading. */}
        {ranged ? (
          <>
            <span className="text-[13px] text-slate-400">to</span>
            <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
              <input type="date" value={to} min={date || today?.date || undefined}
                onChange={(e) => setTo(e.target.value)}
                className="bg-transparent text-[13px] font-semibold text-slate-700 outline-none" />
            </label>
            <button onClick={() => { setRanged(false); setTo(""); }}
              className="press rounded-xl px-3 py-2 text-[13px] font-semibold text-slate-500 hover:bg-slate-100">
              One day
            </button>
          </>
        ) : (
          <button
            onClick={() => {
              // Seeded to the day already on screen, so pressing this shows the same
              // classes rather than an empty list the reader then has to explain.
              const from = date || today?.date || "";
              setTo(from);
              setDate(from);
              setRanged(true);
            }}
            className="press rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] font-semibold text-slate-600 hover:bg-slate-50">
            Date range
          </button>
        )}
        {(today?.isToday === false || ranged) && (
          <button onClick={() => { setDate(""); setTo(""); setRanged(false); }}
            className="press rounded-xl px-3 py-2 text-[13px] font-semibold text-white" style={{ background: NAVY }}>
            Back to today
          </button>
        )}
      </div>

      {/* Offered only when the server says this account may ask for it. A control that
          always answers 403 is worse than no control. */}
      {today?.canSeeAll && (
        <div role="group" aria-label="Which classes to show" className="inline-flex rounded-xl border border-slate-200 bg-white p-1">
          {[
            { key: "mine", label: "My classes" },
            { key: "all", label: "All classes" },
          ].map((o) => (
            <button
              key={o.key} onClick={() => chooseScope(o.key)}
              aria-pressed={scope === o.key}
              className="press rounded-lg px-3.5 py-2 text-[13px] font-semibold transition-colors"
              style={scope === o.key ? { background: NAVY, color: "#fff" } : { color: "#475569" }}
            >{o.label}</button>
          ))}
        </div>
      )}

      {err && <Banner tone="rose" Icon={AlertTriangle}>{err}</Banner>}

      {/* Only when BOTH capture methods are off. A QR-only college's registers fill on
          their own perfectly well, and this warning would call the feature broken. */}
      {today && !today.tapEnabled && !today.qrEnabled && (
        <Banner tone="amber" Icon={Nfc}>
          Self check-in is switched off for this college, so nothing will appear here on its own.
          Registers can still be taken in the usual way.{" "}
          <SwitchOnHint href={settingsHref} />
        </Banner>
      )}

      {/* The day, added up — but only when there is a day to add up. On an empty list the
          panel would be five zeroes above a "no classes today" card, which reads as data
          rather than as the absence of any. */}
      {sessions.length > 0 && <TodayTotals totals={today?.totals} classes={sessions.length} />}

      {!sessions.length ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center">
          <CalendarX size={26} className="mx-auto mb-3 text-slate-300" />
          <p className="text-sm font-semibold text-slate-700">
            {scope === "all" ? "No classes anywhere today" : "No classes of yours today"}
          </p>
          {/* Said plainly, because the alternative reading — "the screen is broken" — is
              the one a lecturer will otherwise reach for. The two scopes have genuinely
              different causes, so they get genuinely different explanations. */}
          <p className="mx-auto mt-1 max-w-sm text-[13px] leading-relaxed text-slate-500">
            {scope === "all"
              ? "Nothing is timetabled for today at all. Registers are generated from a unit's teaching dates on the Registers page."
              : "This lists the classes you are recorded as teaching — either as the tutor of the unit, or by being named on the timetabled class itself. If you teach something that is not here, ask an administrator to add you to it."}
          </p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {sessions.map((s) => (
            <li key={s.id}>
              <button onClick={() => setChosen(s.id)} className="press flex w-full items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-left hover:border-slate-300">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-slate-800">
                    {s.unit?.name || s.unit?.code || "Session"}
                    {s.acceptingTaps && (
                      <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700 ring-1 ring-emerald-200">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />Open now
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-[12px] tabular-nums text-slate-500">
                    {/* THE DATE, only when the list spans more than one. On a single day
                        every row shares it and repeating it thirty times is noise; across
                        a range its absence makes two Tuesdays indistinguishable, which is
                        the whole reason somebody asked for a range. */}
                    {today?.to && s.date ? `${s.date} · ` : ""}
                    {s.startTime}–{s.endTime}
                    {s.description ? ` · ${s.description}` : ""}
                    {/* Only in the college-wide view: in your own list every row is
                        yours, and repeating your name on each one is noise. */}
                    {scope === "all" && s.tutor ? ` · ${s.tutor}` : ""}
                  </p>
                  {/* The class's own register, broken out. It replaces the bare "N
                      marked" that used to sit on the line above — the same fact, said in
                      the terms a lecturer glancing at a phone actually wants. */}
                  <CountPills counts={s.counts} />
                </div>
                <ChevronRight size={17} className="shrink-0 text-slate-300" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Where the day's registers stand, across every class on the list beneath it.
//
// A COUNT OF MARKS, not of people: a student on two registers today is counted twice,
// and should be, because the question this answers is "how much of today's attendance is
// taken" rather than "how many students are in the building". Said on the card, because
// the other reading is the one an inspector will otherwise take.
function TodayTotals({ totals, classes }) {
  if (!totals) return null;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Today so far</p>
      <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {TILES.map((t) => (
          <div
            key={t.key}
            title={totals[t.key] === null && t.key === "notMarked" ? NOT_MEASURED : undefined}
            className={`rounded-xl px-3 py-2.5 text-center ring-1 ${t.cls}`}
          >
            <p className="text-xl font-bold tabular-nums leading-none">{shown(totals[t.key])}</p>
            <p className="mt-1 text-[11px] font-semibold opacity-80">{t.label}</p>
          </div>
        ))}
      </div>
      <p className="mt-2.5 text-[12px] leading-relaxed text-slate-500">
        Across {classes} class{classes === 1 ? "" : "es"}, counting each register separately.{" "}
        <strong className="font-semibold text-slate-600">Not marked</strong> is students on a register
        who have no mark yet. It is not an absence, and nothing on this screen writes one.
      </p>
    </div>
  );
}

// The same five figures beside one class. Rendered inside the button that opens the
// register, so it is a plain span row rather than anything focusable — a control inside
// a control is not reachable by keyboard and lies to a screen reader about both.
function CountPills({ counts }) {
  if (!counts) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {TILES.map((t) => (
        <span
          key={t.key}
          title={counts[t.key] === null && t.key === "notMarked" ? NOT_MEASURED : undefined}
          className={`rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ring-1 ${t.cls}`}
        >
          {shown(counts[t.key])} <span className="font-semibold opacity-80">{t.label}</span>
        </span>
      ))}
    </div>
  );
}

// One sentence, two audiences: the administrator who can act gets the link, everybody
// else gets the name of the page to ask about.
function SwitchOnHint({ href }) {
  return href
    ? <a href={href} className="font-bold underline underline-offset-2">Switch on QR or tap check-in</a>
    : <span>An administrator can switch on QR or tap check-in under <strong>Check-in: QR &amp; NFC</strong>.</span>;
}

function Banner({ tone, Icon, children }) {
  const tones = {
    rose: "bg-rose-50 text-rose-800 ring-rose-200",
    amber: "bg-amber-50 text-amber-800 ring-amber-200",
    slate: "bg-slate-50 text-slate-700 ring-slate-200",
  };
  return (
    <div className={`flex gap-2.5 rounded-xl p-3.5 ring-1 ${tones[tone]}`}>
      <Icon size={17} className="mt-0.5 shrink-0" />
      <div className="text-[13px] leading-relaxed">{children}</div>
    </div>
  );
}

// Exported: the Registers page opens this same view for any session (from a session row
// or from the paper register), so the code, the projector and the close button exist
// once. `backLabel` names where "back" goes from there.
export function LiveSession({ sessionId, onBack, backLabel = "Today's classes", settingsHref = null }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [closing, setClosing] = useState(false);
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [controlling, setControlling] = useState(false);
  // Which row is mid-save, so only that dropdown locks. Locking the whole table would
  // stop a lecturer working down a class of thirty at the speed they call the names.
  const [saving, setSaving] = useState(null);
  // Filtering the register itself. Above the early return with every other hook -- the
  // rule is positional, and putting one below `if (!data) return` is exactly the mistake
  // that blanked this screen once already.
  const [rowFilter, setRowFilter] = useState("");   // "" | "NA" | "A"
  const [rowQuery, setRowQuery] = useState("");
  const alive = useRef(true);
  // Reset on mount, not only cleared on unmount: StrictMode double-mounts in development,
  // and a ref only ever set false leaves every guarded setState skipped for the
  // component's real life — the screen would spin forever with data it had already
  // fetched.
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    try {
      const d = await api.sessionLive(sessionId);
      if (alive.current) { setData(d); setErr(""); }
    } catch (e) {
      if (alive.current) setErr(e?.message || "Could not load the register.");
    }
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  // Poll ONLY while taps are actually being accepted. Once the class is over the answer
  // cannot change on its own, and a screen left open on a desk overnight would otherwise
  // ask a question every ten seconds until morning.
  useEffect(() => {
    if (!data?.acceptingTaps) return undefined;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [data?.acceptingTaps, load]);

  if (!data && !err) return <div className="flex justify-center p-12"><Loader2 className="animate-spin text-slate-300" size={28} /></div>;

  const counts = data?.counts || { P: 0, L: 0, E: 0, A: 0, notMarked: 0 };
  const rows = data?.rows || [];
  const canMark = data?.canMark === true;
  // What the table actually draws. Kept separate from `rows` so the counts in the filter
  // buttons and the "N students" heading describe the WHOLE register -- a filter that
  // also renumbered its own labels would make it impossible to tell how much is left.
  const rowQ = rowQuery.trim().toLowerCase();
  const shownRows = rows.filter((r) => {
    if (rowFilter === "NA" && r.status) return false;
    if (rowFilter === "A" && r.status !== "A") return false;
    if (!rowQ) return true;
    return `${r.student.name} ${r.student.studentRef || ""}`.toLowerCase().includes(rowQ);
  });

  /**
   * Set (or clear) one student's mark.
   *
   * OPTIMISTIC, then reconciled from the server's answer. A register is taken by calling
   * names down a list, and a control that freezes for a round trip on every name is one
   * a lecturer stops using by the fourth student. The refetch afterwards is what keeps
   * the summary tiles honest -- they are computed server-side from the same marks, so
   * updating the row alone would leave the panel above it stale.
   *
   * A 423 is the term lock and is the one refusal worth its own sentence: the mark was
   * not written because the term is closed, which is a decision somebody made, not a
   * fault. Anything else reverts the row and says so, because a dropdown that silently
   * snaps back is indistinguishable from one that did not register the click.
   */
  const setMark = async (studentId, next) => {
    if (!canMark) return;
    const before = rows.find((r) => r.student.id === studentId)?.status ?? null;
    setSaving(studentId);
    setErr("");
    setData((d) => (d ? { ...d, rows: d.rows.map((r) => (r.student.id === studentId ? { ...r, status: next || null } : r)) } : d));
    try {
      await api.saveRegister(sessionId, [{ studentId, status: next || null }]);
      await load();
    } catch (e) {
      setData((d) => (d ? { ...d, rows: d.rows.map((r) => (r.student.id === studentId ? { ...r, status: before } : r)) } : d));
      setErr(e?.status === 423
        ? (e.message || "That term is closed, so this register cannot be changed.")
        : (e?.message || "Could not save that mark."));
    } finally {
      setSaving(null);
    }
  };

  // The lecturer's hand on the window. Both go through one call and one reload, so
  // the badge, the code and the roster all move together. (Its state hook is declared
  // with the others above the early return; a hook after it changes the hook order
  // between the loading render and the loaded one, which React rejects as a crash.)
  const control = async (action, minutes) => {
    setControlling(true); setErr(""); setNote("");
    try {
      const r = await api.sessionCheckInWindow(sessionId, action, minutes);
      setNote(action === "close"
        ? "Check-in has ended for this class. Scans and taps are no longer accepted."
        : `Check-in is open until ${r.closesAt || r.checkInOpenUntil}.`);
      await load();
    } catch (e) {
      setErr(e?.message || "Could not change check-in for this class.");
    } finally { setControlling(false); }
  };

  const closeOff = async () => {
    setClosing(true); setErr(""); setNote("");
    try {
      const r = await api.markRemainingAbsent(sessionId);
      setNote(r.marked ? `${r.marked} student${r.marked === 1 ? "" : "s"} marked absent.` : (r.message || "Nothing to mark."));
      await load();
    } catch (e) {
      setErr(e?.message || "Could not close the register.");
    } finally { setClosing(false); }
  };

  return (
    <div className="space-y-4 p-4 md:p-6">
      <button onClick={onBack} className="press -ml-1 rounded-lg px-2 py-2 text-[13px] font-semibold" style={{ color: NAVY }}>← {backLabel}</button>

      <header className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="text-base font-bold text-slate-800">{data?.unit?.name || data?.unit?.code || "Register"}</h2>
        {/* sSession serialises the times as `start` and `end`. This line read
            startTime/endTime from the day it was written and rendered a bare dash —
            invisible precisely because nobody tests the client beyond building it. */}
        <p className="mt-0.5 text-[13px] tabular-nums text-slate-500">
          {data?.session?.date} · {data?.session?.start}–{data?.session?.end}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {data?.acceptingTaps ? (
            <span className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-[12px] font-bold text-emerald-700 ring-1 ring-emerald-200">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />Accepting check-ins
            </span>
          ) : (
            <span className="flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-[12px] font-bold text-slate-600 ring-1 ring-slate-200">
              <Clock3 size={12} />Check-in closed
            </span>
          )}
          {data?.termLocked && (
            <span className="flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-[12px] font-bold text-amber-700 ring-1 ring-amber-200">
              <Lock size={12} />Term closed
            </span>
          )}
          <button onClick={load} aria-label="Refresh the register now" className="press ml-auto rounded-lg p-2.5 text-slate-500 hover:bg-slate-50" title="Refresh now"><RefreshCw size={15} /></button>
        </div>
      </header>

      <div role="status" aria-live="polite">
        {err && <Banner tone="rose" Icon={AlertTriangle}>{err}</Banner>}
        {note && <Banner tone="slate" Icon={CheckCircle2}>{note}</Banner>}
      </div>

      {/* Reached from the Registers page, this screen can be the first place somebody
          learns the college has switched nothing on. Only when BOTH are off: a QR-only
          register fills on its own perfectly well. Older servers do not send tapEnabled,
          and undefined must not read as "off". */}
      {data && data.qrEnabled === false && data.tapEnabled === false && (
        <Banner tone="amber" Icon={Nfc}>
          Self check-in is switched off, so this register will only fill when you mark it.{" "}
          <SwitchOnHint href={settingsHref} />
        </Banner>
      )}

      {data?.qrEnabled && (
        <QrCard
          sessionId={sessionId}
          unitName={data?.unit?.name || data?.unit?.code || "Register"}
          times={`${data?.session?.start}–${data?.session?.end}`}
          counts={counts}
          phase={data?.phase}
        />
      )}

      {/* End early, or hold open for late arrivals. Only for today's class, only for
          somebody the server will let change it, and only in the two phases where
          the button does something: "open" can be ended, "over"/"ended" can be
          reopened. Before the class starts there is nothing to press. */}
      {data?.canClose && data?.today && data?.session?.date === data.today
        && (data?.qrEnabled || data?.tapEnabled) && (data.phase === "open" || data.phase === "over" || data.phase === "ended") && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4">
          {data.phase === "open" ? (
            <>
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-800">Check-in is open until {data.closesAt || data.session?.end}</p>
                <p className="text-[12px] leading-relaxed text-slate-500">Ending it now stops scans and taps for this class. You can reopen it for late arrivals.</p>
              </div>
              <button onClick={() => control("close")} disabled={controlling}
                className="press rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-[13px] font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-60">
                {controlling ? <Loader2 size={15} className="animate-spin" /> : "End check-in now"}
              </button>
            </>
          ) : (
            <>
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-800">Reopen for late arrivals</p>
                <p className="text-[12px] leading-relaxed text-slate-500">Accepts scans and taps for ten more minutes. Press again to keep it open longer.</p>
              </div>
              <button onClick={() => control("reopen", 10)} disabled={controlling}
                className="press rounded-xl px-4 py-2.5 text-[13px] font-bold text-white disabled:opacity-60" style={{ background: NAVY }}>
                {controlling ? <Loader2 size={15} className="animate-spin" /> : "Reopen for 10 minutes"}
              </button>
            </>
          )}
        </section>
      )}

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Tally n={counts.P} label="Present" colour="#059669" />
        <Tally n={counts.L} label="Late" colour="#d97706" />
        <Tally n={counts.A} label="Absent" colour="#e11d48" />
        <Tally n={counts.notMarked} label="No mark yet" colour="#94a3b8" />
      </div>
      {/* THE REGISTER.
          Design notes, because "make it nicer" is not a specification and the next
          person needs to know which parts are decisions.

          A DATA TABLE, not cards or a list. Six facts per person and thirty people is a
          grid, and the whole value of a grid is that a column can be read down: "who is
          under 75%" should be one eye movement, not thirty.

          NO ZEBRA STRIPES. They were invented for paper reports read across a metre of
          desk; on screen a hairline divider plus a hover row does the same work without
          painting half the table a second colour and fighting the attendance bars for
          attention.

          THE NAME COLUMN IS STICKY. Six columns do not fit a laptop half-screen, and a
          horizontally scrolled register whose names have slid off is unusable — you are
          reading a row to find a person, so the person must stay.

          NUMBERS ARE TABULAR AND RIGHT-ALIGNED, so 7 and 100 line up on the decimal and
          a column of percentages can be scanned rather than read.

          The header is sticky within the table's own scroll box, so column meanings
          survive a long class. */}
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
          <p className="text-[13px] font-bold text-slate-700">
            {rows.length} student{rows.length === 1 ? "" : "s"}
          </p>
          {/* A FILTER, NOT A SEARCH BOX ONLY. Calling a register of forty is the case
              this screen exists for, and "show me the ones nobody has marked" is the
              question at the end of it. Counts live in the labels so the filter says how
              much work is left before you press it. */}
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {[
              { k: "", label: "All", n: rows.length },
              { k: "NA", label: "Not marked", n: rows.filter((r) => !r.status).length },
              { k: "A", label: "Absent", n: rows.filter((r) => r.status === "A").length },
            ].map((f) => (
              <button key={f.k || "all"} onClick={() => setRowFilter(f.k)}
                aria-pressed={rowFilter === f.k}
                className={`press rounded-lg px-2.5 py-1 text-[12px] font-semibold transition-colors ${
                  rowFilter === f.k ? "text-white" : "text-slate-500 hover:bg-slate-100"}`}
                style={rowFilter === f.k ? { background: NAVY } : undefined}>
                {f.label} <span className="tabular-nums opacity-70">{f.n}</span>
              </button>
            ))}
            <label className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1 focus-within:ring-2 focus-within:ring-blue-300">
              <Search size={13} className="text-slate-400" />
              <input value={rowQuery} onChange={(e) => setRowQuery(e.target.value)}
                placeholder="Find a student…" aria-label="Find a student"
                className="w-32 bg-transparent text-[12px] outline-none sm:w-44" />
            </label>
          </div>
        </div>

        <div className="max-h-[60vh] overflow-auto">
          <table className="w-full min-w-[54rem] border-collapse text-left">
            <thead className="sticky top-0 z-10">
              <tr className="bg-slate-50 text-[10px] font-bold uppercase tracking-wide text-slate-500 shadow-[inset_0_-1px_0_0_#e2e8f0]">
                <th scope="col" className="sticky left-0 z-20 bg-slate-50 px-4 py-2.5">Full name</th>
                <th scope="col" className="px-3 py-2.5">Student number</th>
                <th scope="col" className="px-3 py-2.5">Course</th>
                <th scope="col" className="px-3 py-2.5">School</th>
                <th scope="col" className="px-3 py-2.5 text-right">Attendance</th>
                <th scope="col" className="px-3 py-2.5 text-right">Mark</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {shownRows.map((r) => (
                <tr key={r.student.id} className="group align-middle transition-colors hover:bg-slate-50/80">
                  <td className="sticky left-0 z-10 bg-white px-4 py-2.5 transition-colors group-hover:bg-slate-50/80">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                        style={{ background: r.student.colour || "#94a3b8" }}>{r.student.initials}</span>
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-semibold text-slate-800">{r.student.name}</p>
                        <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
                          {r.checkedInAt && <span className="tabular-nums" title="When they checked in">{r.checkedInAt}</span>}
                          {r.selfMarked && (() => {
                            const viaQr = r.takenBy === "Self check-in (QR)";
                            const words = viaQr ? "Scanned the code on screen" : "Tapped in on their phone";
                            const Icon = viaQr ? QrCode : Nfc;
                            return (
                              <span className="flex items-center" title={words}>
                                <Icon size={12} aria-hidden="true" />
                                <span className="sr-only">{words}</span>
                              </span>
                            );
                          })()}
                          {!r.enrolled && (
                            <span className="text-amber-600" title="On this register through their group, with no enrolment on the module">via group</span>
                          )}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-[12px] tabular-nums text-slate-600">{r.student.studentRef || "—"}</td>
                  <td className="max-w-[16rem] px-3 py-2.5 text-[12px] text-slate-600">
                    <span className="block truncate" title={r.course || ""}>{r.course || "—"}</span>
                    {r.group && <span className="block truncate text-[11px] text-slate-400">{r.group}</span>}
                  </td>
                  <td className="max-w-[14rem] px-3 py-2.5 text-[12px] text-slate-600">
                    <span className="block truncate" title={r.school || ""}>{r.school || "—"}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    {/* NULL IS AN EM DASH, NOT 0%. A student nobody has ever marked on
                        this module has no percentage, and printing 0 would put them at
                        the bottom of a list for something never measured. The bar is
                        drawn only where there is a figure to draw. */}
                    {r.attendancePct == null ? (
                      <p className="text-right text-[12px] text-slate-400" title="No marks on this module yet">—</p>
                    ) : (
                      <div className="flex items-center justify-end gap-2">
                        <span className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
                          <span className="block h-full rounded-full"
                            style={{ width: `${Math.max(2, Math.min(100, r.attendancePct))}%`, background: pctColour(r.attendancePct) }} />
                        </span>
                        <span className="w-12 text-right text-[12px] font-bold tabular-nums"
                          style={{ color: pctColour(r.attendancePct) }}
                          title={`${r.attendanceMarked} register${r.attendanceMarked === 1 ? "" : "s"} counted on this module`}>
                          {r.attendancePct}%
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <select
                      value={r.status || ""}
                      disabled={!canMark || saving === r.student.id}
                      onChange={(e) => setMark(r.student.id, e.target.value)}
                      aria-label={`Attendance for ${r.student.name}`}
                      title={canMark ? undefined : "You can see this register but not change it."}
                      className={`rounded-lg px-2.5 py-1.5 text-[12px] font-bold ring-1 outline-none transition disabled:opacity-60 ${
                        r.status ? STATUS[r.status].cls : "bg-slate-50 text-slate-500 ring-slate-200"}`}
                    >
                      <option value="">N/A — no mark</option>
                      {["P", "L", "E", "A"].map((k) => (
                        <option key={k} value={k}>{STATUS[k].label}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
              {!shownRows.length && (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-sm text-slate-400">
                    {rows.length
                      ? "No student matches that filter."
                      : "Nobody is on this register yet — no student is enrolled on the module and no group is timetabled for it."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Offered only to somebody the server will let close it. An administrator
            granted the watching page alone used to see this button and get a 403.
            Undefined (an older server) keeps the old behaviour. */}
        {counts.notMarked > 0 && data?.canClose !== false && (
          <div className="border-t border-slate-100 bg-slate-50 p-4">
            <button
              onClick={() => setConfirming(true)} disabled={closing}
              className="press flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold text-white disabled:opacity-60"
              style={{ background: "#be123c" }}
            >
              {closing ? <Loader2 size={15} className="animate-spin" /> : <UserX size={15} />}
              Mark the {counts.notMarked} remaining absent
            </button>
            <p className="mt-2 text-center text-[11px] leading-relaxed text-slate-500">
              Writes <strong>A</strong> for everyone still without a mark. Students who have already tapped
              are untouched. This is the only thing here that records an absence, and it is recorded
              against your name.
            </p>
          </div>
        )}
      </section>

      {/* Behind a confirmation because it is the one irreversible thing on this screen.
          The count is in the question, not only on the button: "mark 5 absent" read at a
          glance is a very different decision from "mark 24 absent", and a mis-tap here
          writes an academic record for every one of them. */}
      {confirming && (
        <ConfirmDialog
          open
          title={`Mark ${counts.notMarked} student${counts.notMarked === 1 ? "" : "s"} absent?`}
          message={`This records an absence for everyone on this register who still has no mark. Students who already tapped in are untouched. It is recorded against your name and can be corrected on the full register afterwards.`}
          confirmLabel={`Mark ${counts.notMarked} absent`}
          danger
          onConfirm={() => { setConfirming(false); closeOff(); }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

function Tally({ n, label, colour }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <p className="text-2xl font-extrabold tabular-nums leading-none" style={{ color: colour }}>{n}</p>
      <p className="mt-1 text-[11px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
    </div>
  );
}

/* ------------------------------ the rotating code ------------------------------ */

// The lecturer's half of QR check-in: the code itself, and a full-screen mode sized for
// a projector. Rendered only when the college has switched QR check-in on.
//
// One request per rotation, not a poll. The server says how many seconds the current
// code has left, and the card asks again just after that moment — so the QR on screen
// is never stale and a broken timer cannot turn one projector into a request loop
// (the server rate-limits minting as well, belt and braces).
//
// Displaying this opens nothing and closing it closes nothing: the code is only valid
// inside the session's own timetabled window, enforced where it matters — at the scan.
// `phase` is the live view's word for where the class sits. The card only re-asks the
// server when the code turns over, so without this a code stayed on the projector for
// up to a rotation after the lecturer pressed "End check-in now" — refused at every
// scan, but on the wall contradicting the button. A phase change refetches at once.
function QrCard({ sessionId, unitName, times, counts, phase }) {
  const [mint, setMint] = useState(null);   // the last /qr-code answer
  const [img, setImg] = useState("");       // the current code, rendered
  const [err, setErr] = useState("");
  // Whether the failure is one the card's own retry can outlive. A dropped connection or
  // a server error, yes; a refusal (switched off, closed, not found) is an answer, and
  // "trying again automatically" after an answer reads as two systems talking.
  const [transient, setTransient] = useState(false);
  // Counts failures rather than just holding one, because it is the retry TRIGGER: two
  // identical failures in a row set the same err string, React skips the no-op state
  // update, and an effect keyed on err would never re-arm the timer — the exact
  // stuck-banner failure the retry exists to remove, one level down.
  const [fails, setFails] = useState(0);
  const [presenting, setPresenting] = useState(false);
  // True when this screen cannot produce a link a student's phone could open — the
  // packaged app, where the screen's own address is the device. Held separately from
  // `err` because it is not a failure to retry: retrying changes nothing, and the
  // lecturer needs one instruction rather than an error that keeps coming back.
  const [unreachable, setUnreachable] = useState(false);
  // The code works, but it points at this computer, so no phone in the room can open it.
  // Development only (see scanLink.js). A note beside the code, never on the projector.
  const [localOnly, setLocalOnly] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const fetchCode = useCallback(async () => {
    try {
      const r = await api.sessionQr(sessionId);
      if (!alive.current) return;
      setErr("");
      setMint(r);
      if (r.code) {
        // The deep link is composed HERE, from the screen's own origin: staff and
        // students use the same deployment, so the code carries whichever host the
        // lecturer is on and staging can never mint production links or vice versa.
        // The server never learns a hostname.
        //
        // A FRAGMENT, not a query string. The code is a bearer credential for a mark,
        // and everything after # never leaves the phone — a ?checkin= query would land
        // every live code in the SPA host's access logs and the student's browser
        // history, the two places the server side is careful never to write it.
        //
        // Null when this screen is not somewhere a student's phone can reach, which is
        // the packaged app: there the screen's own origin IS the device. Drawing it
        // anyway fills a projector with a code the whole room fails to open. See
        // scanLink.js — the rule is refuse rather than mislead, the same one the mint
        // route follows outside a class's hours.
        const url = scanLinkFor({
          native: typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.() === true,
          origin: window.location.origin,
          sessionId,
          code: r.code,
        });
        if (!url) { if (alive.current) { setImg(""); setUnreachable(true); } return; }
        if (alive.current) { setUnreachable(false); setLocalOnly(isLocalOnlyOrigin(window.location.origin)); }
        const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 640, color: { dark: "#0f172a", light: "#ffffff" } });
        if (alive.current) setImg(dataUrl);
      } else {
        setImg("");
      }
    } catch (e) {
      if (!alive.current) return;
      // Includes "switched off" (the parent's poll will drop qrEnabled and unmount this
      // card within a cycle) and the loud missing-key 503, which an administrator can
      // actually act on — so the message is shown, not swallowed.
      setErr(e?.message || "Could not fetch the check-in code.");
      setTransient(!e?.status || e?.status >= 500 || Boolean(e?.timeout));
      setMint(null); setImg("");
      setFails((n) => n + 1);
    }
  }, [sessionId]);

  useEffect(() => { fetchCode(); }, [fetchCode, phase]);

  // Ask again just after the code turns over — or, after a failure, in five seconds.
  // The retry matters more than it looks: without it one dropped request or a single
  // 429 was terminal, because nothing else ever calls fetchCode again, and the
  // projector sat on an error banner for the rest of a two-hour class. Five seconds is
  // twelve requests a minute at worst, well inside the mint route's own budget.
  // The extra 400ms on the rotation path keeps the request on the new window's side of
  // the boundary even with a slightly fast local clock.
  useEffect(() => {
    if (!mint && fails === 0) return undefined;
    const t = setTimeout(fetchCode, mint ? (mint.secondsLeft ?? 30) * 1000 + 400 : 5000);
    return () => clearTimeout(t);
  }, [mint, fails, fetchCode]);

  // Escape leaves full screen, matching every other overlay on the platform.
  useEffect(() => {
    if (!presenting) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setPresenting(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presenting]);

  // Only before the FIRST answer arrives. After that there is always something truthful
  // to show — the code, the phase, or the error — and returning null on error would
  // unmount the projector overlay mid-blip, kicking the lecturer out of full screen for
  // a failure the retry above repairs on its own.
  if (!mint && !err) return null;

  const open = Boolean(mint?.acceptingTaps && img);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      {unreachable ? (
        // Not an error and not worth retrying: the app cannot produce a link a phone in
        // the room could open, and the fix is a different screen, not a fresh request.
        <Banner tone="amber" Icon={QrCode}>
          Open this register in a web browser to show the code. A code shown from the
          installed app points at this device, so nobody else can scan it.
        </Banner>
      ) : err ? (
        <Banner tone="amber" Icon={QrCode}>{err}{transient ? " Trying again automatically." : ""}</Banner>
      ) : open ? (
        <div className="flex flex-col items-center gap-4 sm:flex-row">
          <img src={img} alt="Check-in code" className="h-32 w-32 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 text-center sm:text-left">
            <h3 className="flex items-center justify-center gap-2 text-sm font-bold text-slate-800 sm:justify-start">
              <QrCode size={16} style={{ color: NAVY }} />Scan to check in
            </h3>
            <p className="mt-1 text-[13px] leading-relaxed text-slate-500">
              Students scan it with their phone camera to check in.
            </p>
            {/* No countdown, no "new code in" line, on the card as well as the projector
                (owner, 3 Sep 2026): the code turns over on its own and nobody in the
                room, lecturer included, has to think about when. */}
            <button
              onClick={() => setPresenting(true)}
              className="press mt-3 rounded-xl px-4 py-2.5 text-[13px] font-bold text-white"
              style={{ background: NAVY }}
            >Show full screen</button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <Clock3 size={18} className="shrink-0 text-slate-400" />
          {mint.phase === "before" ? (
            <div>
              <p className="text-sm font-semibold text-slate-700">Check-in opens at {mint.opensAt}</p>
              <p className="text-[12px] text-slate-500">The code will appear here automatically.</p>
            </div>
          ) : mint.phase === "ended" ? (
            <div>
              <p className="text-sm font-semibold text-slate-700">Check-in was ended for this class</p>
              <p className="text-[12px] text-slate-500">Scans are refused until it is reopened.</p>
            </div>
          ) : mint.phase === "closed" ? (
            // The term the unit sits in is shut, so the register itself is locked —
            // different from "the class ran earlier today", and saying "opens at 09:00"
            // here would promise a code that is never coming.
            <div>
              <p className="text-sm font-semibold text-slate-700">This register is closed</p>
              <p className="text-[12px] text-slate-500">The class is outside its teaching term. Reopen the term to take registers.</p>
            </div>
          ) : (
            <div>
              <p className="text-sm font-semibold text-slate-700">Check-in has closed for this class</p>
              <p className="text-[12px] text-slate-500">It ran until {mint.closesAt}.</p>
            </div>
          )}
        </div>
      )}

      {/* BELOW the code and its instruction, spanning the card, rather than in the column
          beside the image where a phone-width shell squeezes it into a ribbon. Only ever on
          a developer's machine (see scanLink.js), and never on the projector: the room
          cannot act on it. */}
      {open && localOnly && (
        <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2.5 text-[12px] leading-relaxed text-amber-800 ring-1 ring-amber-200">
          This code points at this computer, so a phone cannot open it. Open the app on this
          machine&rsquo;s network address instead, then show the code again.
        </p>
      )}

      {presenting && (
        <Projector
          unitName={unitName} times={times} img={err ? "" : img} reconnecting={Boolean(err)}
          counts={counts} onClose={() => setPresenting(false)}
        />
      )}
    </section>
  );
}


// Full screen, for the projector at the front of the room. White on purpose — a lecture
// theatre's projector at full brightness is the one place the platform's quiet palette
// would fight legibility, so this is the register reduced to the three things a room
// needs: the code, one instruction, and how many people are in.
function Projector({ unitName, times, img, reconnecting, counts, onClose }) {
  // Portalled to <body>: position:fixed measures against the nearest TRANSFORMED
  // ancestor, not the viewport, and anything animated above this card would quietly
  // turn "full screen" into "full page" — the overlay laid out against the scroll
  // height and the tallies pushed past the projector's bottom edge.
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Check-in code, full screen" className="fixed inset-0 z-[95] flex flex-col bg-white">
      <div className="flex items-start justify-between gap-4 p-5 md:p-8">
        <div className="min-w-0">
          <p className="truncate text-2xl font-extrabold text-slate-900 md:text-4xl">{unitName}</p>
          <p className="mt-1 text-lg tabular-nums text-slate-500 md:text-2xl">{times}</p>
        </div>
        <button onClick={onClose} aria-label="Leave full screen" className="press shrink-0 rounded-xl p-3 text-slate-500 hover:bg-slate-100"><X size={28} /></button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6">
        {img ? (
          <>
            {/* The code takes exactly the height the header, bar, instruction and
                tallies leave over — sized by flexbox, not viewport arithmetic. A code
                sized only by vmin pushed the instruction and the counts below the fold
                on ordinary laptop screens, the exact screen a lecturer plugs into the
                projector; and everything on this screen is pointless if the counts and
                the instruction are not on it. */}
            <div className="flex min-h-0 w-full flex-1 items-center justify-center">
              <img
                src={img} alt="Check-in code"
                className="h-full w-auto"
                style={{ maxHeight: "540px", maxWidth: "min(90vw, 540px)" }}
              />
            </div>
            {/* No countdown and no "new code" moment on THIS surface, deliberately. The
                projector is the student-facing face of the feature; the room only needs
                the code and the instruction, and the code swapping silently underneath
                is not something anybody scanning it should have to think about. The
                lecturer's own card keeps its countdown — that one is a staff diagnostic. */}
            <p className="text-center text-xl font-semibold leading-snug text-slate-800 md:text-3xl">
              Point your phone camera at the code to check in
            </p>
          </>
        ) : reconnecting ? (
          // A fetch failed and the retry is running. Saying "closed" here would tell a
          // room mid-class that check-in is over because of one dropped request.
          <p className="text-center text-2xl font-semibold text-slate-600 md:text-4xl">Getting a fresh code…</p>
        ) : (
          // The class window closed while this was on the wall. Say so in projector-size
          // type rather than leaving a dead code up for people to scan at.
          <p className="text-center text-2xl font-semibold text-slate-600 md:text-4xl">Check-in has closed for this class</p>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3 p-5 md:gap-4 md:p-8">
        <BigTally n={counts.P} label="Present" colour="#059669" />
        <BigTally n={counts.L} label="Late" colour="#d97706" />
        <BigTally n={counts.notMarked} label="Not yet" colour="#94a3b8" />
      </div>
    </div>,
    document.body
  );
}

function BigTally({ n, label, colour }) {
  return (
    <div className="rounded-2xl border border-slate-200 px-4 py-4 text-center md:py-5">
      <p className="text-4xl font-extrabold tabular-nums leading-none md:text-6xl" style={{ color: colour }}>{n}</p>
      <p className="mt-2 text-[11px] font-bold uppercase tracking-wider text-slate-500 md:text-sm">{label}</p>
    </div>
  );
}
