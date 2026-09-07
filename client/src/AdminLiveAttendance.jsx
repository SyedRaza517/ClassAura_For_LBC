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
  Nfc, Lock, CalendarX, ChevronRight, QrCode, X,
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

  const loadToday = useCallback(async () => {
    setBusy(true); setErr("");
    try { setToday(await api.mySessionsToday(scope)); }
    catch (e) { setErr(e?.message || "Could not load today's classes."); }
    finally { setBusy(false); }
  }, [scope]);
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
          {scope === "all" ? "Every class running today, and the registers as they fill." : "Your classes today, and the registers as they fill."}
        </p>
      </header>

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
              : "This lists sessions on units where you are recorded as the tutor. If you teach a unit that is not here, ask an administrator to set you as its tutor on the Registers page."}
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
                    {/* Only in the college-wide view: in your own list every row is
                        yours, and repeating your name on each one is noise. */}
                    {scope === "all" && s.tutor ? ` · ${s.tutor}` : ""}
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
                  <span className="shrink-0 text-[12px] tabular-nums text-slate-500" title="When they checked in">{r.checkedInAt}</span>
                )}
                {/* A self-marked row is visibly different from one the lecturer took.
                    takenBy carries that already, so no extra column was needed. */}
                {/* lucide spreads unknown props onto the <svg>, where `title` is an attribute
                    and renders neither a tooltip nor an accessible name — so the
                    tapped-vs-marked distinction was invisible to everybody. A real label
                    and a visually-hidden word instead. */}
                {r.selfMarked && (() => {
                  // Which way they marked themselves. The server's predicate decides
                  // selfMarked; takenBy just picks the picture — a sticker and a code on
                  // screen have different failure modes, and an administrator reading a
                  // disputed register needs to see which one this was.
                  const viaQr = r.takenBy === "Self check-in (QR)";
                  const words = viaQr ? "Scanned the code on screen" : "Tapped in on their phone";
                  const Icon = viaQr ? QrCode : Nfc;
                  return (
                    <span className="flex shrink-0 items-center" title={words}>
                      <Icon size={13} aria-hidden="true" className="text-slate-500" />
                      <span className="sr-only">{words}</span>
                    </span>
                  );
                })()}
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ${st ? st.cls : "bg-slate-100 text-slate-600 ring-slate-300"}`}>
                  {st ? st.label : "No mark yet"}
                </span>
              </li>
            );
          })}
          {!rows.length && <li className="px-5 py-10 text-center text-sm text-slate-400">Nobody is enrolled on this unit yet. An administrator can add students on the Registers page.</li>}
        </ul>

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
