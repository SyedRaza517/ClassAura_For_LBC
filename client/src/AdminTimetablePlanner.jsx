// Scheduling — the planner half. An administrator places an event and ASSIGNS a
// room, staff and groups to it, from dropdowns backed by real foreign keys.
//
// This is a different page from "Timetable", which still serves the older weekly
// TimetableSlot screen and the student timetable. They are deliberately not merged:
// that one is scoped to a course/year/term and has free-text lecturer and room, and
// folding this into it would mean one screen where half the fields are relations and
// half are strings.
import React, { useCallback, useEffect, useState } from "react";
import {
  DoorOpen, Tag, CalendarDays, Plus, Trash2, Loader2, AlertTriangle, X, Check,
} from "lucide-react";
import { api } from "./api";
import { NAVY, alpha } from "./branding";

function Field({ label, children, hint }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}
const inputCls = "w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm";

/* ------------------------------------------------------------------ rooms -- */

function RoomsTab() {
  const [rooms, setRooms] = useState([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState({ name: "", floor: "", campus: "", capacity: "", kind: "" });

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try { setRooms(await api.ttRooms()); }
    catch (e) { setErr(e?.message || "Could not load rooms."); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setErr("");
    try {
      await api.ttCreateRoom(draft);
      setDraft({ name: "", floor: "", campus: "", capacity: "", kind: "" });
      load();
    } catch (e) {
      // 409 is the duplicate case and it is worth saying precisely, because the
      // constraint is (name, campus): the same room number on another campus is
      // allowed, and an administrator hitting this needs to know that.
      setErr(e?.message?.includes("already exists") ? "That room already exists on that campus. The same number on a different campus is fine." : (e?.message || "Could not add the room."));
    }
  };

  const remove = async (r) => {
    setErr("");
    try {
      const res = await api.ttDeleteRoom(r.id);
      // Deleting a room does NOT delete the classes that were in it — the events
      // survive with no room. Saying so is the difference between an administrator
      // fixing them and never knowing.
      if (res?.eventsLeftWithoutARoom > 0) setErr(`Room deleted. ${res.eventsLeftWithoutARoom} event(s) now have no room and need one.`);
      load();
    } catch (e) { setErr(e?.message || "Could not delete the room."); }
  };

  return (
    <div>
      {err && <div className="mb-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 ring-1 ring-amber-200"><AlertTriangle size={15} /> {err}</div>}
      <div className="mb-4 grid gap-2 rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200 sm:grid-cols-6">
        <Field label="Name"><input className={inputCls} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="101" /></Field>
        <Field label="Floor"><input className={inputCls} value={draft.floor} onChange={(e) => setDraft({ ...draft, floor: e.target.value })} placeholder="First floor" /></Field>
        <Field label="Campus"><input className={inputCls} value={draft.campus} onChange={(e) => setDraft({ ...draft, campus: e.target.value })} placeholder="Harrow" /></Field>
        <Field label="Seats" hint="Blank = not recorded"><input className={inputCls} type="number" min={0} value={draft.capacity} onChange={(e) => setDraft({ ...draft, capacity: e.target.value })} /></Field>
        <Field label="Kind"><input className={inputCls} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} placeholder="Lecture" /></Field>
        <div className="flex items-end">
          <button onClick={create} disabled={!draft.name.trim()} className="flex w-full items-center justify-center gap-1 rounded-lg py-2 text-sm font-bold text-white disabled:opacity-40" style={{ background: NAVY }}><Plus size={15} /> Add</button>
        </div>
      </div>

      {busy ? <div className="flex justify-center py-10 text-slate-400"><Loader2 className="animate-spin" size={20} /></div> : (
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-200 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400">
              <th className="px-3 py-2">Room</th><th className="px-3 py-2">Campus</th><th className="px-3 py-2">Seats</th><th className="px-3 py-2">Kind</th><th className="px-3 py-2" />
            </tr></thead>
            <tbody>
              {!rooms.length && <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-400">No rooms yet. Add the first one above.</td></tr>}
              {rooms.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2 font-semibold text-slate-700">{r.label}</td>
                  <td className="px-3 py-2 text-slate-500">{r.campus || "—"}</td>
                  {/* Null prints as an em dash, never as 0 — "not recorded" and
                      "seats nobody" are different facts. */}
                  <td className="px-3 py-2 text-slate-500">{r.capacity ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-500">{r.kind || "—"}</td>
                  <td className="px-3 py-2 text-right"><button onClick={() => remove(r)} aria-label={`Delete ${r.label}`} className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 size={15} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- categories -- */

function CategoriesTab() {
  const [cats, setCats] = useState([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState({ name: "", colour: "#1a3a8f" });

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try { setCats(await api.ttCategories()); }
    catch (e) { setErr(e?.message || "Could not load categories."); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      {err && <div className="mb-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 ring-1 ring-amber-200"><AlertTriangle size={15} /> {err}</div>}
      <p className="mb-3 text-xs text-slate-500">Categories are what an event <em>is</em> — Lecture, Seminar, Exam. The colour is used when a reader colours their timetable by category.</p>
      <div className="mb-4 flex flex-wrap items-end gap-2 rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
        <Field label="Name"><input className={inputCls} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Lecture" /></Field>
        <Field label="Colour"><input type="color" className="h-9 w-16 rounded border border-slate-300" value={draft.colour} onChange={(e) => setDraft({ ...draft, colour: e.target.value })} /></Field>
        <button
          onClick={async () => { setErr(""); try { await api.ttCreateCategory(draft); setDraft({ name: "", colour: "#1a3a8f" }); load(); } catch (e) { setErr(e?.message || "Could not add."); } }}
          disabled={!draft.name.trim()} className="flex items-center gap-1 rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-40" style={{ background: NAVY }}><Plus size={15} /> Add</button>
      </div>

      {busy ? <div className="flex justify-center py-10 text-slate-400"><Loader2 className="animate-spin" size={20} /></div> : (
        <div className="flex flex-wrap gap-2">
          {!cats.length && <p className="py-8 text-center text-sm text-slate-400">No categories yet.</p>}
          {cats.map((c) => (
            <span key={c.id} className="flex items-center gap-2 rounded-full py-1.5 pl-3 pr-1.5 text-sm font-bold" style={{ background: alpha(c.colour, 14), color: c.colour }}>
              {c.name}
              <button onClick={async () => { try { const r = await api.ttDeleteCategory(c.id); if (r?.eventsLeftWithoutACategory > 0) setErr(`Deleted. ${r.eventsLeftWithoutACategory} event(s) now have no category.`); load(); } catch (e) { setErr(e?.message || "Could not delete."); } }}
                aria-label={`Delete ${c.name}`} className="rounded-full p-1 hover:bg-white/60"><X size={13} /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- root -- */

export default function AdminTimetablePlanner() {
  const [tab, setTab] = useState("calendar");
  const TABS = [["calendar", "Calendar", CalendarDays], ["rooms", "Rooms", DoorOpen], ["categories", "Categories", Tag]];
  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-slate-200">
        {TABS.map(([k, l, I]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-bold ${tab === k ? "border-b-2 text-slate-800" : "text-slate-400 hover:text-slate-600"}`}
            style={tab === k ? { borderColor: NAVY } : undefined}>
            <I size={15} /> {l}
          </button>
        ))}
      </div>
      {/* Filled by Task 9. Left explicit rather than blank so a half-finished build
          says so instead of looking like a broken tab. */}
      {tab === "calendar" && <PlannerCalendarTab />}
      {tab === "rooms" && <RoomsTab />}
      {tab === "categories" && <CategoriesTab />}
    </div>
  );
}

function PlannerCalendarTab() {
  return <p className="py-10 text-center text-sm text-slate-400">The event planner lands in the next change.</p>;
}
