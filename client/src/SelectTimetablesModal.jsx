// "Select timetables" — whose timetable am I looking at?
//
// Five types, matching the system this reproduces: module offerings, rooms, teaching
// staff, students and groups. Resetting means "my own", which is the default the
// server applies when no type is sent — there is no separate "my timetable" mode to
// get out of sync with this one.
//
// STUDENTS ARE BEHIND A SEARCH BOX AND THE SERVER ENFORCES IT. An empty student
// search returns nothing with `needsQuery: true`, rather than the first 25 of
// several thousand named people, because a picker you can scroll is a directory.
import React, { useEffect, useState, useCallback } from "react";
import { X, Search, PlusCircle, MinusCircle, RotateCcw, BookOpen, DoorOpen, User, GraduationCap, Users } from "lucide-react";
import { api } from "./api";
import { NAVY } from "./branding";
import { TT } from "./timetableTheme";
import ModalPortal from "./ModalPortal";

const TYPES = [
  { key: "module",  label: "Module Offerings", I: BookOpen,       placeholder: "Name and code…" },
  { key: "room",    label: "Rooms",            I: DoorOpen,       placeholder: "Name and campus…" },
  { key: "staff",   label: "Teaching Staff",   I: User,           placeholder: "Name…" },
  { key: "student", label: "Students",         I: GraduationCap,  placeholder: "Student reference or name…" },
  { key: "group",   label: "Groups",           I: Users,          placeholder: "Name…" },
];

export default function SelectTimetablesModal({ open, initialType, initialSelected = [], onApply, onClose }) {
  const [type, setType] = useState(initialType || "");
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(0);
  const [needsQuery, setNeedsQuery] = useState(false);
  const [selected, setSelected] = useState(initialSelected);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Re-run when the type or the query changes. Debounced, because this searches
  // thousands of rows and a request per keystroke would both hammer the API and
  // deliver results out of order.
  useEffect(() => {
    if (!open || !type) { setResults([]); setTotal(0); setNeedsQuery(false); return; }
    let cancelled = false;
    setBusy(true); setErr("");
    const t = setTimeout(async () => {
      try {
        const r = await api.myTimetableResources(type, q, 25);
        if (cancelled) return;
        setResults(r.results || []); setTotal(r.total || 0); setNeedsQuery(!!r.needsQuery);
      } catch (e) {
        if (!cancelled) setErr(e?.message || "Could not search.");
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [open, type, q]);

  const add = useCallback((row) => setSelected((s) => (s.some((x) => x.id === row.id) ? s : [...s, row])), []);
  const drop = useCallback((id) => setSelected((s) => s.filter((x) => x.id !== id)), []);

  if (!open) return null;
  const meta = TYPES.find((t) => t.key === type);

  // PORTALLED — see ModalPortal.jsx. This picker is opened FROM the timetable
  // screen, so inline it inherited that view as its containing block and centred
  // itself in a box taller than the window.
  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-3">
        <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
          <div className="flex items-center justify-between px-4 py-3" style={{ background: TT.green, color: TT.greenText }}>
            <p className="text-base font-extrabold">Select timetables</p>
            <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 hover:bg-white/20"><X size={18} /></button>
          </div>

          <div className="flex flex-col gap-2 border-b border-slate-200 p-3 sm:flex-row">
            <select value={type} onChange={(e) => { setType(e.target.value); setQ(""); }}
              className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700 sm:w-56">
              <option value="">Choose Timetable Type</option>
              {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} disabled={!type}
                placeholder={meta?.placeholder || "Choose a type first…"}
                className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm disabled:bg-slate-50" />
            </div>
          </div>

          <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 sm:grid-cols-2">
            <div>
              <p className="mb-2 border-b border-slate-200 pb-1 text-sm font-bold text-slate-600">Result <span className="font-normal text-slate-500">({total})</span></p>
              {err && <p className="text-xs font-semibold text-rose-600">{err}</p>}
              {!type && <p className="py-6 text-center text-xs text-slate-500">Choose a timetable type to search.</p>}
              {/* The server says WHY the list is empty. "Search for a student by name or
                  reference" is a next step; a bare "no results" reads as "this college
                  has no students". */}
              {type && needsQuery && <p className="py-6 text-center text-xs text-slate-500">Search for a student by name or reference.</p>}
              {type && !needsQuery && !busy && !results.length && <p className="py-6 text-center text-xs text-slate-500">No timetables match your search criteria.</p>}
              <div className="space-y-0.5">
                {results.map((r) => (
                  <button key={r.id} type="button" onClick={() => add(r)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-slate-50">
                    <PlusCircle size={18} className="shrink-0 text-slate-400" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-slate-700">{r.label}</span>
                      {r.sub && <span className="block truncate text-[11px] text-slate-600">{r.sub}</span>}
                    </span>
                  </button>
                ))}
              </div>
              {total > results.length && (
                <p className="pt-2 text-[11px] text-slate-500">Showing {results.length} of {total} — narrow your search to see the rest.</p>
              )}
            </div>

            <div>
              <p className="mb-2 border-b border-slate-200 pb-1 text-sm font-bold text-slate-600">Selected <span className="font-normal text-slate-500">({selected.length})</span></p>
              {!selected.length && <p className="py-6 text-center text-xs text-slate-500">There are no selected timetables.</p>}
              <div className="space-y-0.5">
                {selected.map((r) => (
                  <button key={r.id} type="button" onClick={() => drop(r.id)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-rose-50">
                    <MinusCircle size={18} className="shrink-0 text-rose-400" />
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-700">{r.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-slate-200 p-3">
            {/* Reset means "back to my own timetable", not "clear the boxes" — that is
                what the server does with no type, so there is one meaning, not two. */}
            <button onClick={() => { setSelected([]); onApply?.({ type: null, ids: [], labels: [] }); }}
              className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-bold text-slate-500 hover:bg-slate-100">
              <RotateCcw size={15} /> Reset to my timetable
            </button>
            <button disabled={!selected.length}
              onClick={() => onApply?.({ type, ids: selected.map((s) => s.id), labels: selected })}
              className="rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-40" style={{ background: TT.green, color: TT.greenText }}>
              Apply
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
