// Develop App — which functions this college offers, on each of its two app surfaces.
//
// IN ITS OWN FILE, and that is deliberate rather than incidental. StaffHub.jsx is about
// 17,800 lines; every screen added to it makes the next edit to any of them harder, and
// this one has no reason to be in there — it shares no state with the dashboard beyond
// the signed-in user, which arrives as a prop. BrandingSettings, DocumentSettings and
// IntegrationSettings are the precedent.
//
// WHAT IT CAN AND CANNOT DO, stated here because the screen's title invites a wider
// reading. It can switch an existing function off for the whole college, rename it, and
// reorder it. It cannot add new behaviour: that needs code and, because this app ships
// through the stores as a Capacitor binary with no live-update plugin, a release. The
// screen says so in as many words, under "What this can't do", so that nobody goes
// looking for a feature that was never there.
//
// THREE ACCESS QUESTIONS, NOT ONE. This screen answers the third:
//
//   Access tab (per person)   — may THIS COLLEAGUE use this page?
//   requireCollegeWide        — may they do it to the whole college?
//   here (per institution)    — does this function exist in this deployment at all?
//
// They combine with AND on the server, so switching a page off here refuses a Super
// Admin too. It deliberately does NOT touch anybody's page grants: switching a function
// off leaves every grant intact and simply stops offering it, so switching it back on
// restores exactly the access that existed before. Stripping the grants instead would
// lose the information — nobody would know who used to hold it.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import {
  Loader2, AlertTriangle, Save, RotateCcw, Lock, GraduationCap, Users,
  ArrowUp, ArrowDown, Check, X, Pencil, Info,
} from "lucide-react";

const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200";

const TABS = [
  { key: "staff", label: "Staff", I: Users, blurb: "Pages in the staff dashboard and the staff app." },
  { key: "student", label: "Student", I: GraduationCap, blurb: "Screens in the student app." },
];

/* ======================================================================= one row === */

// A single function: its name, whether it is offered, and where it sits.
//
// `onMove` is given null at the ends of the list rather than the buttons being hidden,
// so the row's height never changes between the middle of a list and its edges — a
// column of rows that reflows as you reorder it is hard to aim at on a trackpad.
function FunctionRow({ fn, first, last, onToggle, onRename, onMove }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fn.label);

  // Re-seed the box whenever the stored label changes underneath it — a Reset, or a
  // reload — so an open editor does not keep showing the previous wording.
  useEffect(() => { setDraft(fn.label); }, [fn.label]);

  const commit = () => { onRename(draft); setEditing(false); };
  const renamed = fn.label !== fn.defaultLabel;

  return (
    <div className={`flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3 last:border-0 ${fn.enabled ? "" : "bg-slate-50/80"}`}>
      {/* THE TOGGLE. A checkbox rather than a switch: a switch's state is read from its
          position alone, and a column of 34 of them is genuinely ambiguous at a glance
          about which way is on. The row also dims when off, so the state is carried
          twice. */}
      <label className="flex flex-none cursor-pointer items-center gap-2" title={fn.locked ? "This one can't be switched off" : undefined}>
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-slate-300 accent-slate-700 disabled:opacity-40"
          checked={fn.enabled}
          disabled={fn.locked}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span className="sr-only">{fn.enabled ? "Switch off" : "Switch on"} {fn.label}</span>
      </label>

      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={inputCls + " max-w-xs"}
              value={draft}
              maxLength={40}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                // Escape ABANDONS rather than saving the half-typed value, which is
                // what every other text field in this app does.
                if (e.key === "Escape") { setDraft(fn.label); setEditing(false); }
              }}
            />
            <button onClick={commit} className="rounded-lg bg-slate-800 px-2.5 py-1.5 text-white" title="Save this name"><Check size={14} /></button>
            <button onClick={() => { setDraft(fn.label); setEditing(false); }} className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-slate-600" title="Cancel"><X size={14} /></button>
          </div>
        ) : (
          <div className="flex flex-wrap items-baseline gap-2">
            <p className={`font-semibold ${fn.enabled ? "text-slate-800" : "text-slate-400 line-through decoration-slate-300"}`}>{fn.label}</p>
            {/* The name we shipped, shown only once it differs — so an administrator
                can see what a renamed function was originally called without having to
                clear the rename to find out. */}
            {renamed && <span className="text-[11px] text-slate-400">was &ldquo;{fn.defaultLabel}&rdquo;</span>}
            {fn.locked && (
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                <Lock size={10} /> always on
              </span>
            )}
          </div>
        )}
        {/* WHY A LOCKED ROW IS LOCKED, in place rather than in a tooltip. "Why can't I
            switch this off" is the first question the padlock provokes, and an answer
            that needs a hover is no answer on a touch screen. */}
        {fn.locked && !editing && (
          <p className="mt-0.5 text-[11px] text-slate-500">
            {fn.surface === "student"
              ? (fn.key === "more" ? "Holds Sign out and appearance — students could not leave their session without it." : "The app's home screen; every Back gesture ends here.")
              : "Holds the detail behind branding, integrations, attendance and letters, which this screen deliberately does not duplicate."}
          </p>
        )}
      </div>

      <div className="flex flex-none items-center gap-1">
        {!editing && (
          <button onClick={() => setEditing(true)} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700" title={`Rename ${fn.label}`}>
            <Pencil size={14} />
          </button>
        )}
        <button onClick={() => onMove(-1)} disabled={first} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-25 disabled:hover:bg-transparent" title="Move up">
          <ArrowUp size={14} />
        </button>
        <button onClick={() => onMove(1)} disabled={last} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-25 disabled:hover:bg-transparent" title="Move down">
          <ArrowDown size={14} />
        </button>
      </div>
    </div>
  );
}

/* ========================================================================= screen === */

export default function DevelopApp() {
  const [data, setData] = useState(null);      // what the server last confirmed
  const [surface, setSurface] = useState("staff");
  const [rows, setRows] = useState({ staff: [], student: [] });   // the working copy
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const d = await api.developApp();
      setData(d);
      // The server already returns each surface in the college's chosen order, so the
      // working copy is simply what it sent. Re-sorting here would be a second opinion
      // about order, and the two would disagree the moment either changed.
      setRows({ staff: d.staff || [], student: d.student || [] });
    } catch (e) {
      setError(e?.message || "Could not load the app's functions.");
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // UNSAVED-CHANGE DETECTION BY COMPARISON, not by a dirty flag. A flag has to be set
  // at every mutation site and cleared on every save and reload, and the one site that
  // forgets leaves Save disabled over real changes — or enabled over none.
  const dirty = useMemo(() => {
    if (!data) return false;
    const same = (a, b) =>
      a.length === b.length &&
      a.every((f, i) => f.key === b[i].key && f.enabled === b[i].enabled && f.label === b[i].label);
    return !(same(rows.staff, data.staff || []) && same(rows.student, data.student || []));
  }, [rows, data]);

  const mutate = (key, fn) => {
    setNote("");
    setRows((r) => ({ ...r, [key]: fn(r[key]) }));
  };

  const onToggle = (key, enabled) =>
    mutate(surface, (list) => list.map((f) => (f.key === key ? { ...f, enabled } : f)));

  const onRename = (key, text) =>
    mutate(surface, (list) => list.map((f) => {
      if (f.key !== key) return f;
      const trimmed = (text || "").trim().slice(0, 40);
      // An empty box means "undo the rename", which is expressed by going back to the
      // name we shipped. Storing "" would render a nav entry with no words in it, and
      // the server refuses it for the same reason.
      return { ...f, label: trimmed || f.defaultLabel };
    }));

  const onMove = (key, delta) =>
    mutate(surface, (list) => {
      const i = list.findIndex((f) => f.key === key);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  // Fold the working copy back into the shape the server stores: only what DIFFERS from
  // the defaults travels. An explicit `true` per enabled function, or a label equal to
  // the one we shipped, would make the row grow a key per function the first time
  // anybody pressed Save without changing anything.
  const payloadFrom = (r) => {
    const functions = {}, labels = {}, order = {};
    for (const key of ["staff", "student"]) {
      order[key] = r[key].map((f) => f.key);
      for (const f of r[key]) {
        if (!f.enabled && !f.locked) functions[f.id] = false;
        if (f.label && f.label !== f.defaultLabel) labels[f.id] = f.label;
      }
    }
    return { functions, labels, order };
  };

  const save = async () => {
    setBusy(true); setError(""); setNote("");
    try {
      await api.saveDevelopApp(payloadFrom(rows));
      // Reloaded rather than trusting the local copy: the server drops what it will not
      // store (a locked function, an unknown key, a blank label), and the screen must
      // show what was actually kept rather than what was sent. A screen that reports a
      // change the server discarded is worse than one that shows an error.
      await load();
      setNote("Saved. The apps pick this up when somebody next opens or refocuses them.");
    } catch (e) {
      setError(e?.message || "Could not save.");
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true); setError(""); setNote("");
    try {
      await api.resetDevelopApp();
      await load();
      setNote("Every function is switched on again, under its original name.");
    } catch (e) {
      setError(e?.message || "Could not reset.");
    } finally {
      setBusy(false);
    }
  };

  if (!data && !error) {
    return <div className="flex justify-center py-10 text-slate-400"><Loader2 className="animate-spin" /></div>;
  }

  const list = rows[surface] || [];
  const offCount = list.filter((f) => !f.enabled).length;
  const active = TABS.find((t) => t.key === surface);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-extrabold text-slate-800">Develop App</h2>
        <p className="mt-1 max-w-3xl text-[13px] text-slate-500">
          Choose which parts of the app your college uses. Switching something off removes it for
          everybody — including Super Admins — and the server stops answering for it, so it is a real
          switch rather than a hidden menu. Nobody&rsquo;s individual access is changed: switch it back
          on and everyone has exactly what they had before.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
          <AlertTriangle size={15} /> {error}
        </div>
      )}
      {note && (
        <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
          <Check size={15} /> {note}
        </div>
      )}

      {/* THE TWO TABS. Staff and Student are separate because they are separate apps for
          separate audiences — and because three keys (Check-In, Assessments, Mitigating
          Circumstances) exist on BOTH, so a single merged list would show the same name
          twice with no way to tell which audience each row governed. */}
      <div className="flex flex-wrap gap-2">
        {TABS.map(({ key, label, I }) => {
          const on = surface === key;
          const off = (rows[key] || []).filter((f) => !f.enabled).length;
          return (
            <button
              key={key}
              onClick={() => setSurface(key)}
              className={`flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-bold transition ${on ? "bg-slate-800 text-white shadow-sm" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}
            >
              <I size={15} />
              {label}
              {/* The count of what is switched off, per tab, so an administrator can see
                  at a glance that the OTHER tab has changes without opening it. */}
              {off > 0 && (
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${on ? "bg-white/20" : "bg-slate-100 text-slate-500"}`}>
                  {off} off
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="rounded-xl bg-white ring-1 ring-slate-200">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4">
          <div className="min-w-0 flex-1">
            <p className="font-bold text-slate-800">{active?.label} — {list.length} functions</p>
            <p className="mt-0.5 text-[12px] text-slate-500">
              {active?.blurb} {offCount > 0 ? `${offCount} switched off.` : "All switched on."}
            </p>
          </div>
          <div className="flex flex-none gap-2">
            <button
              onClick={reset}
              disabled={busy || !data?.customised}
              className="flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-2 text-sm font-bold text-slate-700 transition hover:bg-slate-200 disabled:opacity-40"
              title={data?.customised ? "Switch everything back on, under its original name" : "Nothing has been changed yet"}
            >
              <RotateCcw size={14} /> Reset all
            </button>
            <button
              onClick={save}
              disabled={busy || !dirty}
              className="flex items-center gap-1.5 rounded-lg bg-slate-800 px-3.5 py-2 text-sm font-bold text-white transition hover:bg-slate-900 disabled:opacity-40"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {dirty ? "Save changes" : "Saved"}
            </button>
          </div>
        </div>

        {list.map((fn, i) => (
          <FunctionRow
            key={fn.id}
            fn={fn}
            first={i === 0}
            last={i === list.length - 1}
            onToggle={(v) => onToggle(fn.key, v)}
            onRename={(t) => onRename(fn.key, t)}
            onMove={(d) => onMove(fn.key, d)}
          />
        ))}
      </div>

      {/* SAYING PLAINLY WHAT THIS SCREEN IS NOT. "Develop App" reads like a place to
          build things, and an administrator who expects to add a feature here will go
          looking for the button until somebody tells them there isn't one. Writing it
          down is cheaper than that conversation, and honest about the constraint: the
          mobile apps ship as store binaries, so new behaviour needs a release. */}
      <div className="flex gap-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
        <Info size={16} className="mt-0.5 flex-none text-slate-400" />
        <div className="text-[12px] leading-relaxed text-slate-600">
          <p className="font-bold text-slate-700">What this can&rsquo;t do</p>
          <p className="mt-1">
            This screen switches existing parts of the app on and off, renames them and reorders them.
            It cannot create new behaviour — a new report, a different attendance rule — because that
            needs code, and the phone apps are installed from the App Store and Play Store, so a new
            feature arrives with an app release rather than a setting.
          </p>
          <p className="mt-1.5">
            Detailed settings stay where they live: check-in methods under Attendance, letter wording
            and colours under Settings. This screen deliberately doesn&rsquo;t duplicate them, because
            two places controlling one behaviour is how they come to disagree.
          </p>
        </div>
      </div>
    </div>
  );
}
