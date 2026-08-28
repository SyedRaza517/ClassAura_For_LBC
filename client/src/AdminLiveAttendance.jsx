// Live Attendance — the register as it fills, during the class.
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
import {
  Radio, Loader2, AlertTriangle, RefreshCw, CheckCircle2, Clock3, UserX,
  Nfc, Lock, CalendarX, ChevronRight,
} from "lucide-react";
import { api } from "./api";
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

export default function AdminLiveAttendance({ store }) {
  const [today, setToday] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(true);

  const loadToday = useCallback(async () => {
    setBusy(true); setErr("");
    try { setToday(await api.mySessionsToday()); }
    catch (e) { setErr(e?.message || "Could not load today's classes."); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { loadToday(); }, [loadToday]);

  if (busy && !today) return <div className="flex justify-center p-12"><Loader2 className="animate-spin text-slate-300" size={28} /></div>;

  if (chosen) return <LiveSession sessionId={chosen} onBack={() => { setChosen(null); loadToday(); }} />;

  const sessions = today?.sessions || [];

  return (
    <div className="space-y-4 p-4 md:p-6">
      <header>
        <h2 className="flex items-center gap-2 text-lg font-bold text-slate-800"><Radio size={18} style={{ color: NAVY }} />Live Attendance</h2>
        <p className="mt-0.5 text-[13px] text-slate-500">Your classes today, and the registers as they fill.</p>
      </header>

      {err && <Banner tone="rose" Icon={AlertTriangle}>{err}</Banner>}

      {today && !today.tapEnabled && (
        <Banner tone="amber" Icon={Nfc}>
          Tap check-in is switched off for this college, so nothing will appear here on its own.
          Registers can still be taken in the usual way. An administrator can switch it on under <strong>NFC Tags</strong>.
        </Banner>
      )}

      {!sessions.length ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center">
          <CalendarX size={26} className="mx-auto mb-3 text-slate-300" />
          <p className="text-sm font-semibold text-slate-700">No classes of yours today</p>
          {/* Said plainly, because the alternative reading — "the screen is broken" — is
              the one a lecturer will otherwise reach for. */}
          <p className="mx-auto mt-1 max-w-sm text-[13px] leading-relaxed text-slate-500">
            This lists sessions on units where you are recorded as the tutor. If you teach a unit
            that is not here, ask an administrator to set you as its tutor on the Registers page.
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
                    {s.startTime}–{s.endTime}
                    {s.description ? ` · ${s.description}` : ""}
                    {` · ${s.marked} marked`}
                  </p>
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

function LiveSession({ sessionId, onBack }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [closing, setClosing] = useState(false);
  const [note, setNote] = useState("");
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
      <button onClick={onBack} className="press text-[13px] font-semibold" style={{ color: NAVY }}>← Today's classes</button>

      <header className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="text-base font-bold text-slate-800">{data?.unit?.name || data?.unit?.code || "Register"}</h2>
        <p className="mt-0.5 text-[13px] tabular-nums text-slate-500">
          {data?.session?.date} · {data?.session?.startTime}–{data?.session?.endTime}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {data?.acceptingTaps ? (
            <span className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-[12px] font-bold text-emerald-700 ring-1 ring-emerald-200">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />Accepting taps · refreshing every {POLL_MS / 1000}s
            </span>
          ) : (
            <span className="flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-[12px] font-bold text-slate-600 ring-1 ring-slate-200">
              <Clock3 size={12} />Not accepting taps
            </span>
          )}
          {data?.termLocked && (
            <span className="flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-[12px] font-bold text-amber-700 ring-1 ring-amber-200">
              <Lock size={12} />Term closed
            </span>
          )}
          <button onClick={load} className="press ml-auto rounded-lg p-1.5 text-slate-400 hover:bg-slate-50" title="Refresh now"><RefreshCw size={15} /></button>
        </div>
      </header>

      {err && <Banner tone="rose" Icon={AlertTriangle}>{err}</Banner>}
      {note && <Banner tone="slate" Icon={CheckCircle2}>{note}</Banner>}

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Tally n={counts.P} label="Present" colour="#059669" />
        <Tally n={counts.L} label="Late" colour="#d97706" />
        <Tally n={counts.A} label="Absent" colour="#e11d48" />
        <Tally n={counts.notMarked} label="Not tapped" colour="#94a3b8" />
      </div>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <ul className="divide-y divide-slate-100">
          {rows.map((r) => {
            const st = r.status ? STATUS[r.status] : null;
            return (
              <li key={r.student.id} className="flex flex-wrap items-center gap-2.5 px-5 py-3">
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                  style={{ background: r.student.colour || "#94a3b8" }}
                >{r.student.initials}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-slate-800">{r.student.name}</p>
                  <p className="text-[11px] text-slate-500">
                    {r.student.studentRef}
                    {!r.enrolled && <span className="ml-1.5 text-amber-600">· no longer enrolled</span>}
                  </p>
                </div>
                {r.checkedInAt && (
                  <span className="shrink-0 text-[12px] tabular-nums text-slate-500" title="When they tapped in">{r.checkedInAt}</span>
                )}
                {/* A self-marked row is visibly different from one the lecturer took.
                    takenBy carries that already, so no extra column was needed. */}
                {r.selfMarked && <Nfc size={13} className="shrink-0 text-slate-400" title="Tapped in on their phone" />}
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ${st ? st.cls : "bg-slate-50 text-slate-400 ring-slate-200"}`}>
                  {st ? st.label : "Not tapped"}
                </span>
              </li>
            );
          })}
          {!rows.length && <li className="px-5 py-10 text-center text-sm text-slate-400">Nobody is enrolled on this unit yet.</li>}
        </ul>

        {counts.notMarked > 0 && (
          <div className="border-t border-slate-100 bg-slate-50 p-4">
            <button
              onClick={closeOff} disabled={closing}
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
    </div>
  );
}

function Tally({ n, label, colour }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <p className="text-2xl font-extrabold tabular-nums leading-none" style={{ color: colour }}>{n}</p>
      <p className="mt-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
    </div>
  );
}
