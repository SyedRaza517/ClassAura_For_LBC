// Scheduling — the planner half. An administrator places an event and ASSIGNS a
// room, staff and groups to it, from dropdowns backed by real foreign keys.
//
// This is a different page from "Timetable", which still serves the older weekly
// TimetableSlot screen and the student timetable. They are deliberately not merged:
// that one is scoped to a course/year/term and has free-text lecturer and room, and
// folding this into it would mean one screen where half the fields are relations and
// half are strings.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  DoorOpen, Tag, CalendarDays, Plus, Trash2, Loader2, AlertTriangle, X, Check,
  ChevronLeft, ChevronRight, Send, Repeat, Settings as SettingsIcon, Users, Building2, ChevronDown, Search,
  GraduationCap,
} from "lucide-react";
import { api } from "./api";
import { NAVY, alpha } from "./branding";
import TimetableCalendar from "./TimetableCalendar";
import TimetableSettingsModal from "./TimetableSettingsModal";
import ConfirmDialog from "./ConfirmDialog";
import { windowFor, shiftAnchor, RANGE_LABEL, seriesPreviewDates, mondayOf } from "./timetableView";
import { ukBankHolidaysRange } from "./bankHolidays";

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

// ISO order, Monday first, matching isoDay() and every other weekday list in this
// feature. A Sunday-first row would put the weekend either side of the working week.
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/* --------------------------------------------------------------- pickers -- */
//
// A <select> is fine for five options and unusable for four hundred. A college's staff
// list, module list and room list are all in the hundreds, and "scroll until you find
// L. Whitfield" is how a timetabler ends up entering the wrong lecturer.
//
// Both pickers filter a list ALREADY IN MEMORY rather than calling an endpoint per
// keystroke: staff, units, rooms and cohorts are loaded once by the store or the tab,
// they are small enough to filter client-side, and a debounce plus a spinner would be
// slower and more code for a worse result. Students would be different — 9,000 of them
// is a directory, not a list — which is why no picker here offers one.

/** Single-choice search box. `value` is an id or "", `options` is [{ id, label, sub }]. */
function SearchOne({ value, options, onChange, placeholder, allowNone = true, noneLabel = "None" }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const chosen = options.find((o) => o.id === value);
  const term = q.trim().toLowerCase();
  // Capped at 50 so a blank search does not paint the whole list; typing narrows it.
  const shown = options
    .filter((o) => !term || `${o.label} ${o.sub || ""}`.toLowerCase().includes(term))
    .slice(0, 50);

  return (
    <div className="relative">
      {/* A MAGNIFIER, NOT JUST A CHEVRON, and the hint text says "search" too.
          With only a chevron this control is indistinguishable from a native <select>,
          so nobody discovers they can type — which is the whole reason it exists over
          one. The chevron stays because it still opens like a dropdown. */}
      <button type="button" onClick={() => { setOpen((v) => !v); setQ(""); }}
        className={`${inputCls} flex items-center justify-between gap-2 text-left transition hover:border-slate-400 ${chosen ? "text-slate-700" : "text-slate-400"}`}>
        <span className="flex min-w-0 items-center gap-2">
          <Search size={14} className="shrink-0 text-slate-400" />
          <span className="truncate">{chosen ? chosen.label : placeholder}</span>
        </span>
        <ChevronDown size={15} className="shrink-0 text-slate-400" />
      </button>
      {open && (
        <>
          {/* A click-away catcher. Without it the panel can only be dismissed by
              choosing something, so a reader who opened it to look ends up having to
              pick a value they did not want. */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 mt-1 w-full rounded-lg border border-slate-200 bg-white shadow-lg">
          <input autoFocus className="w-full border-b border-slate-200 px-2.5 py-2 text-sm outline-none"
            placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="max-h-56 overflow-y-auto py-1">
            {allowNone && (
              <li><button type="button" onClick={() => { onChange(""); setOpen(false); }}
                className="w-full px-2.5 py-1.5 text-left text-sm text-slate-400 hover:bg-slate-50">{noneLabel}</button></li>
            )}
            {!shown.length && <li className="px-2.5 py-3 text-center text-sm text-slate-400">Nothing matches.</li>}
            {shown.map((o) => (
              <li key={o.id}>
                <button type="button" onClick={() => { onChange(o.id); setOpen(false); }}
                  className={`w-full px-2.5 py-1.5 text-left text-sm hover:bg-slate-50 ${o.id === value ? "font-bold text-slate-800" : "text-slate-700"}`}>
                  {o.label}{o.sub ? <span className="ml-1 text-xs text-slate-400">{o.sub}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          </div>
        </>
      )}
    </div>
  );
}

/** Multi-choice search box. `value` is an array of ids; chosen ones show as chips. */
function SearchMany({ value = [], options, onChange, placeholder }) {
  const [q, setQ] = useState("");
  // SUGGESTIONS APPEAR ON FOCUS, NOT ONLY ONCE SOMETHING IS TYPED.
  //
  // The first version showed the list only while `term` was non-empty, so clicking the
  // box gave you an empty box: nothing indicated that typing would do anything, and
  // there was no way to see what was available without guessing a letter. A picker that
  // hides its options until you guess right is a worse dropdown, not a better one.
  const [focused, setFocused] = useState(false);
  const term = q.trim().toLowerCase();
  const chosen = options.filter((o) => value.includes(o.id));
  const shown = options
    .filter((o) => !value.includes(o.id))
    .filter((o) => !term || `${o.label} ${o.sub || ""}`.toLowerCase().includes(term))
    .slice(0, 50);

  return (
    <div className="rounded-lg border border-slate-300">
      {/* Chosen ones stay VISIBLE as chips rather than as highlighted rows in a
          scrolling list. With a multi-select, what you have picked scrolls out of
          sight the moment you look for the next one. */}
      {!!chosen.length && (
        <div className="flex flex-wrap gap-1 border-b border-slate-200 p-1.5">
          {chosen.map((o) => (
            <span key={o.id} className="flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-2 pr-1 text-xs font-bold text-slate-700">
              {o.label}
              <button type="button" aria-label={`Remove ${o.label}`} onClick={() => onChange(value.filter((v) => v !== o.id))}
                className="rounded-full p-0.5 hover:bg-slate-300"><X size={11} /></button>
            </span>
          ))}
        </div>
      )}
      <input className="w-full px-2.5 py-1.5 text-sm outline-none" placeholder={placeholder}
        value={q} onChange={(e) => setQ(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)} />
      {(focused || !!term) && (
        <ul className="max-h-40 overflow-y-auto border-t border-slate-200 py-1">
          {!shown.length && (
            <li className="px-2.5 py-2 text-center text-sm text-slate-400">
              {term ? "Nothing matches." : "Everything here is already chosen."}
            </li>
          )}
          {shown.map((o) => (
            <li key={o.id}>
              {/* onMouseDown, not onClick: the input's blur fires first and would close
                  the list before a click could land on it, so every selection would
                  need two attempts. preventDefault keeps the focus where it is so the
                  box stays open for the next one. */}
              <button type="button"
                onMouseDown={(e) => { e.preventDefault(); onChange([...value, o.id]); setQ(""); }}
                className="w-full px-2.5 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50">
                {o.label}{o.sub ? <span className="ml-1 text-xs text-slate-400">{o.sub}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ rooms -- */

function RoomsTab() {
  const [rooms, setRooms] = useState([]);
  const [campuses, setCampuses] = useState([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState({ name: "", floor: "", campusId: "", capacity: "", kind: "" });

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      const [rm, cp] = await Promise.all([api.ttRooms(), api.ttCampuses()]);
      setRooms(rm); setCampuses(cp);
    }
    catch (e) { setErr(e?.message || "Could not load rooms."); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setErr("");
    try {
      await api.ttCreateRoom(draft);
      setDraft({ name: "", floor: "", campusId: "", capacity: "", kind: "" });
      load();
    } catch (e) {
      // 409 is the duplicate case and it is worth saying precisely, because the
      // constraint is (name, campusId): the same room number on another campus is
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
        <Field label="Campus" hint={campuses.length ? undefined : "Add one on the Campuses tab"}>
          <select className={inputCls} value={draft.campusId} onChange={(e) => setDraft({ ...draft, campusId: e.target.value })}>
            <option value="">No campus</option>
            {campuses.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
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

/* --------------------------------------------------------------- campuses -- */

function CampusesTab() {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [name, setName] = useState("");

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try { setRows(await api.ttCampuses()); }
    catch (e) { setErr(e?.message || "Could not load campuses."); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const remove = async (c) => {
    setErr("");
    try {
      const res = await api.ttDeleteCampus(c.id);
      // Deleting a campus that still has rooms DEACTIVATES it instead, because the
      // alternative silently detaches every room on it. Saying which happened is the
      // difference between an administrator understanding the list and distrusting it.
      if (res?.deactivated) setErr(`"${c.name}" still has ${res.rooms} room(s), so it has been retired rather than deleted. Its rooms keep their campus.`);
      load();
    } catch (e) { setErr(e?.message || "Could not delete the campus."); }
  };

  return (
    <div>
      {err && <div className="mb-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 ring-1 ring-amber-200"><AlertTriangle size={15} /> {err}</div>}
      <p className="mb-3 text-xs text-slate-500">
        Your sites. Rooms belong to one, and the register dashboard filters by them — which is why this is a list rather than something typed onto each room, where “Ealing” and “ealing” would count separately.
      </p>
      <div className="mb-4 flex flex-wrap items-end gap-2 rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
        <Field label="Campus name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Harrow" /></Field>
        <button
          onClick={async () => { setErr(""); try { await api.ttCreateCampus({ name }); setName(""); load(); } catch (e) { setErr(e?.message || "Could not add the campus."); } }}
          disabled={!name.trim()} className="flex items-center gap-1 rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-40" style={{ background: NAVY }}><Plus size={15} /> Add</button>
      </div>

      {busy ? <div className="flex justify-center py-10 text-slate-400"><Loader2 className="animate-spin" size={20} /></div> : (
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-200 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400">
              <th className="px-3 py-2">Campus</th><th className="px-3 py-2">Status</th><th className="px-3 py-2" />
            </tr></thead>
            <tbody>
              {!rows.length && <tr><td colSpan={3} className="px-3 py-8 text-center text-slate-400">No campuses yet. Add the first one above.</td></tr>}
              {rows.map((c) => (
                <tr key={c.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2 font-semibold text-slate-700">{c.name}</td>
                  <td className="px-3 py-2 text-slate-500">{c.active ? "In use" : "Retired"}</td>
                  <td className="px-3 py-2 text-right">
                    {!c.active && (
                      <button onClick={async () => { try { await api.ttUpdateCampus(c.id, { active: true }); load(); } catch (e) { setErr(e?.message || "Could not restore."); } }}
                        className="mr-1 rounded px-2 py-1 text-xs font-bold text-slate-500 hover:bg-slate-100">Restore</button>
                    )}
                    <button onClick={() => remove(c)} aria-label={`Delete ${c.name}`} className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 size={15} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- schools -- */

// The college's academic departments — "School of Business", "School of Computing" —
// listed here so a timetabler can add one without holding Settings.
//
// CREATE ONLY, AND THE SCREEN SAYS SO RATHER THAN SHOWING BUTTONS THAT DO NOTHING.
// A department is not another lookup list like rooms or categories: it is an
// ACCESS-CONTROL BOUNDARY. Which staff belong to it decides which students they can
// see, so renaming one changes what a heading means on somebody else's screen and
// retiring one can silently widen or narrow a colleague's caseload. That editor lives
// on Settings, next to the membership it depends on, and duplicating half of it here
// would give the more dangerous half to the page with the weaker gate.
//
// Adding is different, and is the half that belongs here: a new school with nobody in
// it and no courses attached grants nothing to anybody, and the timetabler who has just
// been handed next term's structure is the person who knows it exists. Disabled Rename
// and Delete buttons were the rejected alternative — a control that is always greyed
// out teaches people the screen is broken rather than that the action is elsewhere.
function SchoolsTab() {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [name, setName] = useState("");
  // Which row is being renamed, and to what. One at a time: an inline editor per row all
  // open at once is a form nobody can tell has unsaved changes in it.
  const [editId, setEditId] = useState("");
  const [editName, setEditName] = useState("");
  const [ask, setAsk] = useState(null);

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try { setRows(await api.ttDepartments()); }
    catch (e) { setErr(e?.message || "Could not load the schools."); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setErr(""); setNote("");
    try { await api.ttCreateDepartment({ name }); setName(""); load(); }
    catch (e) {
      // THE SERVER'S OWN WORDS ARE SHOWN, not a message reworded here. Its 409 already
      // tells the two cases apart — a school that exists, and one that exists but has
      // been RETIRED — and the second needs restoring rather than adding again.
      setErr(e?.message || "Could not add the school.");
    }
  };

  const rename = async () => {
    setErr(""); setNote("");
    try { await api.ttUpdateDepartment(editId, { name: editName }); setEditId(""); load(); }
    catch (e) { setErr(e?.message || "Could not rename the school."); }
  };

  const setActive = async (d, active) => {
    setErr(""); setNote("");
    try { await api.ttUpdateDepartment(d.id, { active }); load(); }
    catch (e) { setErr(e?.message || "Could not update the school."); }
  };

  return (
    <div>
      {err && <div className="mb-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 ring-1 ring-amber-200"><AlertTriangle size={15} /> {err}</div>}
      {note && <div className="mb-3 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200"><Check size={15} /> {note}</div>}
      <p className="mb-3 text-xs text-slate-500">
        Your schools. A class belongs to one, and the school you pick when you create an event narrows the module and group lists to that school’s courses. A school also decides which staff can see which students — so <strong>who belongs to a school</strong>, and each school’s colour, are set on Settings.
      </p>
      <div className="mb-4 flex flex-wrap items-end gap-2 rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
        <Field label="School name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="School of Computing" /></Field>
        <button onClick={create} disabled={!name.trim()}
          className="flex items-center gap-1 rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-40" style={{ background: NAVY }}><Plus size={15} /> Add</button>
      </div>

      {busy ? <div className="flex justify-center py-10 text-slate-400"><Loader2 className="animate-spin" size={20} /></div> : (
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-200 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400">
              <th className="px-3 py-2">School</th><th className="px-3 py-2">Colour</th><th className="px-3 py-2">Status</th><th className="px-3 py-2" />
            </tr></thead>
            <tbody>
              {!rows.length && <tr><td colSpan={4} className="px-3 py-8 text-center text-slate-400">No schools yet. Add the first one above.</td></tr>}
              {rows.map((d) => (
                <tr key={d.id} className={`border-b border-slate-100 last:border-0 ${d.active === false ? "opacity-60" : ""}`}>
                  <td className="px-3 py-2 font-semibold text-slate-700">
                    {editId === d.id ? (
                      <div className="flex items-center gap-1">
                        <input autoFocus className={inputCls} value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter" && editName.trim()) rename(); if (e.key === "Escape") setEditId(""); }} />
                        <button onClick={rename} disabled={!editName.trim()} aria-label="Save name"
                          className="rounded p-1.5 text-emerald-600 hover:bg-emerald-50 disabled:opacity-40"><Check size={15} /></button>
                        <button onClick={() => setEditId("")} aria-label="Cancel rename"
                          className="rounded p-1.5 text-slate-400 hover:bg-slate-100"><X size={15} /></button>
                      </div>
                    ) : d.name}
                  </td>
                  {/* The colour is set on Settings, so it is shown and not edited. It is
                      the same swatch a reader sees elsewhere, which is the only way to
                      tell two similarly named schools apart at a glance. */}
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: alpha(d.colour || "#1a3a8f", 14), color: d.colour || "#1a3a8f" }}>
                      <span className="h-2 w-2 rounded-full" style={{ background: d.colour || "#1a3a8f" }} />
                      {d.colour || "—"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-500">{d.active === false ? "Retired" : "In use"}</td>
                  <td className="px-3 py-2 text-right">
                    {editId !== d.id && (
                      <>
                        {d.active === false ? (
                          <button onClick={() => setActive(d, true)}
                            className="mr-1 rounded px-2 py-1 text-xs font-bold text-slate-500 hover:bg-slate-100">Restore</button>
                        ) : (
                          <button onClick={() => { setEditId(d.id); setEditName(d.name); }} aria-label={`Rename ${d.name}`}
                            className="mr-1 rounded px-2 py-1 text-xs font-bold text-slate-500 hover:bg-slate-100">Rename</button>
                        )}
                        <button onClick={() => setAsk(d)} aria-label={`Delete ${d.name}`}
                          className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 size={15} /></button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* DELETING A SCHOOL IN USE RETIRES IT INSTEAD, and the wording says so before the
          click rather than reporting it afterwards. Every relation to a school is
          SetNull, so a hard delete would not remove its courses and students — it would
          set their school to NULL, and a row with no school is visible only to
          college-wide accounts. That would take every student in it out of the sight of
          every member of staff scoped to it, with nothing on screen to explain why. */}
      <ConfirmDialog
        open={!!ask}
        title="Delete this school?"
        message={`If anything still belongs to “${ask?.name || ""}” it will be retired instead of deleted — its courses, students and classes keep their school, and it stops appearing in the pickers. It is only removed outright if nothing has ever used it.`}
        confirmLabel="Delete" cancelLabel="Keep it" danger
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          const d = ask;
          setAsk(null); setErr(""); setNote("");
          try {
            const r = await api.ttDeleteDepartment(d.id);
            setNote(r.retired
              ? `“${d.name}” was retired — ${r.inUse} record(s) still belong to it, so it was not deleted.`
              : `“${d.name}” was deleted. Nothing belonged to it.`);
            load();
          } catch (e) { setErr(e?.message || "Could not delete the school."); }
        }}
      />
    </div>
  );
}

/* ----------------------------------------------------------------- groups -- */

// A named, reusable class list — "BSc Software Engineering SEP 25" — built once and
// then picked in one click when a class is timetabled, instead of naming forty
// students every time.
//
// ONE STUDENT IS IN ONE GROUP. Student.cohortId is a single column, so adding somebody
// here takes them out of wherever they were. The screen says so before the click and
// names who moved after it: an administrator adding forty people has no other way to
// notice they have just emptied another class.
function GroupsTab({ cohorts = [], courses = [], students = [], hndLoaded, refreshHnd }) {
  // Courses, cohorts and students load lazily — the store only fetches them when a
  // page that needs them is opened, and Scheduling was not one of them. Without this
  // an administrator who lands here first sees an empty group list and concludes the
  // feature is broken rather than unloaded.
  useEffect(() => { if (!hndLoaded && refreshHnd) refreshHnd().catch(() => {}); }, [hndLoaded, refreshHnd]);

  const [groupId, setGroupId] = useState(cohorts[0]?.id || "");
  const [members, setMembers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState([]);
  const [making, setMaking] = useState(false);
  const [draft, setDraft] = useState({ course: "", name: "", startDate: "" });

  const courseName = (id) => courses.find((c) => c.id === id)?.name || "";

  // The sentinel the course <select> uses for "I am going to type one". A literal rather
  // than an empty string, because empty already means "nothing chosen yet" and the
  // Create button has to be able to tell those apart.
  /** Existing course whose name matches what was typed, ignoring case and edge spaces. */
  const matchCourse = (typed, list = courses) => {
    const want = String(typed || "").trim().toLowerCase();
    return want ? list.find((c) => (c.name || "").trim().toLowerCase() === want) : undefined;
  };

  // Says which of the two things the button is about to do, WHILE TYPING.
  //
  // A free text box that silently either reuses or creates is the one thing worth
  // guarding against here: "BSc Software Engineering" and "BSc Software Engineerng" look
  // identical at a glance and produce two programmes, and the mistake is only visible
  // weeks later when half the students are on the wrong one. Naming the matched course
  // back makes a typo obvious before the click rather than after it.
  const typedCourse = matchCourse(draft.course);
  const courseHint = !draft.course.trim()
    ? "Type it — existing ones will suggest themselves"
    : typedCourse
      ? `Existing course — the group joins "${typedCourse.name}"`
      : "New course — created with the group";

  /**
   * The course this group will belong to, creating it if the name is a new one.
   *
   * A FREE TEXT BOX RATHER THAN A DROPDOWN, because most of the time the course is
   * already known to the person typing and making them hunt for it in a list of forty
   * is slower than typing it. The existing courses are offered as browser suggestions
   * (a <datalist>), so picking one is still a keystroke away.
   *
   * MATCHED CASE-INSENSITIVELY AGAINST WHAT ALREADY EXISTS FIRST, and that is the part
   * that matters. Course.name is unique, but Postgres compares it case-sensitively, so
   * "BSc Software Engineering" and "BSc software engineering" are two courses to the
   * database and one course to everybody else. A free text box makes that easy to do by
   * accident — which is exactly why the box has to resolve to the existing row rather
   * than create beside it. Otherwise a college accumulates three spellings of one
   * programme, each holding its own groups and its own share of the students. Same
   * failure the campus list exists to prevent, reached from the other direction.
   */
  const resolveCourseId = async () => {
    const wanted = draft.course.trim();
    const existing = matchCourse(wanted);
    if (existing) return existing.id;
    try {
      return (await api.addCourse({ name: wanted })).id;
    } catch (e) {
      // Someone else created it between the list loading and this click. Refetch and
      // use theirs rather than failing the group the administrator was actually making.
      if (!/already exists/i.test(e?.message || "")) throw e;
      const fresh = await api.listCourses().catch(() => []);
      const found = matchCourse(wanted, fresh);
      if (!found) throw e;
      return found.id;
    }
  };

  // Creating the group here rather than only on the Registers page: the whole point of
  // this tab is "build the class list once", and sending somebody to another screen to
  // make the empty group first breaks that in half.
  //
  // The COURSE IS REQUIRED because Cohort.courseId is NOT NULL — a group belongs to a
  // programme, and it is what makes "SEP 25" unambiguous when three courses each have
  // one. The name is unique per course for the same reason, so the 409 is worth saying
  // in full rather than as "could not create".
  const createGroup = async () => {
    setErr(""); setNote("");
    try {
      const courseId = await resolveCourseId();
      const made = await api.addCohort({
        courseId,
        name: draft.name.trim(),
        ...(draft.startDate ? { startDate: draft.startDate } : {}),
      });
      // The store owns both lists, so they have to be refetched before the new group can
      // be selected — selecting an id the <select> has no <option> for silently shows
      // nothing, and a course created a moment ago would not be in the picker either.
      if (refreshHnd) await refreshHnd().catch(() => {});
      setDraft({ course: "", name: "", startDate: "" });
      setMaking(false);
      setGroupId(made?.id || "");
      setNote(`"${made?.name || draft.name}" created. Add students to it below.`);
    } catch (e) {
      const m = e?.message || "";
      setErr(
        m.includes("already exists") ? `A group called "${draft.name.trim()}" already exists on that course. Names are unique per course.`
        : e?.status === 403 || m.includes("403") ? "You need the Registers page to create a group or a course. You can still add students to an existing group."
        : m || "Could not create the group.",
      );
    }
  };

  const load = useCallback(async (id) => {
    if (!id) { setMembers([]); return; }
    setBusy(true); setErr("");
    try { setMembers(await api.ttGroupStudents(id)); }
    catch (e) { setErr(e?.message || "Could not load the group."); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { load(groupId); }, [groupId, load]);

  const memberIds = new Set(members.map((m) => m.id));
  const term = q.trim().toLowerCase();
  const candidates = students
    .filter((s) => !memberIds.has(s.id))
    .filter((s) => !term || `${s.firstName || ""} ${s.lastName || ""} ${s.studentRef || ""}`.toLowerCase().includes(term))
    .slice(0, 50);

  const add = async () => {
    setErr(""); setNote("");
    try {
      const res = await api.ttAddToGroup(groupId, picked);
      setPicked([]); setQ("");
      // Naming who moved, not just how many were added. The move is the surprising
      // half and it is invisible on this screen otherwise.
      setNote(`${res.changed} student(s) added.` + (res.moved?.length ? ` ${res.moved.length} moved out of another group: ${res.moved.map((m) => m.name || m.studentRef).join(", ")}.` : ""));
      load(groupId);
    } catch (e) {
      setErr(e?.message?.includes("403") || e?.status === 403
        ? "You need the Students page to move students between groups — it changes which department can see them."
        : (e?.message || "Could not add those students."));
    }
  };

  const removeOne = async (s) => {
    setErr(""); setNote("");
    try { await api.ttRemoveFromGroup(groupId, [s.id]); load(groupId); }
    catch (e) { setErr(e?.message || "Could not remove that student."); }
  };

  return (
    <div>
      {err && <div className="mb-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 ring-1 ring-amber-200"><AlertTriangle size={15} /> {err}</div>}
      {note && <div className="mb-3 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200"><Check size={15} /> {note}</div>}

      <p className="mb-3 text-xs text-slate-500">
        Build a class list once and reuse it. When you timetable a class, pick the group instead of naming every student. A student belongs to <strong>one</strong> group — adding them here removes them from wherever they were.
      </p>

      <div className="mb-4 rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Field label="Group" hint={cohorts.length > 8 ? "Type to search" : undefined}>
              {/* Searchable rather than a bare <select>: a college running twenty
                  programmes has sixty or more intakes, and finding "SEP 25" by
                  scrolling is the same problem the event form's pickers exist to
                  solve. */}
              <SearchOne value={groupId}
                placeholder={cohorts.length ? "Choose a group…" : "No groups yet — create one"}
                allowNone={false}
                options={cohorts.map((c) => ({
                  id: c.id,
                  label: courseName(c.courseId) ? `${courseName(c.courseId)} · ${c.name}` : c.name,
                }))}
                onChange={(id) => { setGroupId(id); setPicked([]); setNote(""); }} />
            </Field>
          </div>
          <button onClick={() => { setMaking((v) => !v); setErr(""); setNote(""); }}
            className="flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">
            {making ? <><X size={15} /> Cancel</> : <><Plus size={15} /> New group</>}
          </button>
        </div>

        {making && (
          <div className="mt-3 grid gap-2 border-t border-slate-200 pt-3 sm:grid-cols-4">
            <Field label="Course" hint={courseHint}>
              {/* A plain text box, with the college's existing courses offered as
                  browser suggestions. Typing an existing name reuses that course;
                  anything new is created with the group. */}
              <input className={inputCls} list="tt-course-options" value={draft.course}
                onChange={(e) => setDraft({ ...draft, course: e.target.value })}
                placeholder="BSc Software Engineering" />
              <datalist id="tt-course-options">
                {courses.map((c) => <option key={c.id} value={c.name} />)}
              </datalist>
            </Field>
            <Field label="Group name" hint="The intake, e.g. SEP 25">
              <input className={inputCls} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="SEP 25" />
            </Field>
            <Field label="Starts" hint="Optional">
              <input type="date" className={inputCls} value={draft.startDate} onChange={(e) => setDraft({ ...draft, startDate: e.target.value })} />
            </Field>
            <div className="flex items-end">
              {/* Both required: the course because Cohort.courseId is NOT NULL, the name
                  because it is what anybody picking this group will read. */}
              {/* When "add a new course" is chosen the typed name is what stands in for
                  the course, so the button must wait for it — otherwise Create fires with
                  the sentinel as a courseId and the server rejects it as unknown. */}
              <button onClick={createGroup}
                disabled={!draft.name.trim() || !draft.course.trim()}
                className="flex w-full items-center justify-center gap-1 rounded-lg py-2 text-sm font-bold text-white disabled:opacity-40" style={{ background: NAVY }}>
                <Check size={15} /> Create group
              </button>
            </div>

          </div>
        )}
      </div>

      {!groupId ? (
        <p className="py-8 text-center text-sm text-slate-400">
          {cohorts.length ? "Choose a group to see and edit who is in it." : "Create your first group above, then pick students for it."}
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
            <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">In this group ({members.length})</h4>
            {busy ? <div className="flex justify-center py-8 text-slate-400"><Loader2 className="animate-spin" size={18} /></div> : (
              <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
                {!members.length && <li className="py-8 text-center text-sm text-slate-400">Nobody yet. Add students from the right.</li>}
                {members.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 py-1.5">
                    <span className="flex-1 truncate text-sm text-slate-700">{`${s.firstName || ""} ${s.lastName || ""}`.trim()}</span>
                    <span className="text-xs text-slate-400">{s.studentRef}</span>
                    <button onClick={() => removeOne(s)} aria-label={`Remove ${s.firstName} ${s.lastName}`} className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><X size={14} /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
            <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">Add students</h4>
            <input className={`${inputCls} mb-2`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or student number…" />
            <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
              {!candidates.length && <li className="py-8 text-center text-sm text-slate-400">{term ? "Nobody matches that." : "Everyone is already in this group."}</li>}
              {candidates.map((s) => {
                const on = picked.includes(s.id);
                return (
                  <li key={s.id}>
                    <label className="flex cursor-pointer items-center gap-2 py-1.5">
                      <input type="checkbox" checked={on} onChange={() => setPicked(on ? picked.filter((x) => x !== s.id) : [...picked, s.id])} />
                      <span className="flex-1 truncate text-sm text-slate-700">{`${s.firstName || ""} ${s.lastName || ""}`.trim()}</span>
                      <span className="text-xs text-slate-400">{s.studentRef}</span>
                      {/* Flagged BEFORE the click, not reported after it. */}
                      {s.cohortId && s.cohortId !== groupId && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">in another group</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
            <button onClick={add} disabled={!picked.length}
              className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg py-2 text-sm font-bold text-white disabled:opacity-40" style={{ background: NAVY }}>
              <Plus size={15} /> Add {picked.length || ""} to this group
            </button>
          </div>
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

export default function AdminTimetablePlanner({ store }) {
  const [tab, setTab] = useState("calendar");
  const TABS = [["calendar", "Calendar", CalendarDays], ["groups", "Groups", Users], ["schools", "Schools", GraduationCap], ["rooms", "Rooms", DoorOpen], ["campuses", "Campuses", Building2], ["categories", "Categories", Tag]];
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
      {/* The lists come from the store StaffHub already loads, not from new endpoints
          — store.staff, store.units, store.cohorts and store.courses are all already
          fetched for other pages, and adding an endpoint for them would be a second
          source of truth for the same rows. */}
      {tab === "calendar" && <PlannerCalendarTab staff={store?.staff || []} units={store?.units || []} cohorts={store?.cohorts || []} courses={store?.courses || []} hndLoaded={store?.hndLoaded} refreshHnd={store?.refreshHnd} />}
      {tab === "groups" && <GroupsTab cohorts={store?.cohorts || []} courses={store?.courses || []} students={store?.students || []} hndLoaded={store?.hndLoaded} refreshHnd={store?.refreshHnd} />}
      {tab === "schools" && <SchoolsTab />}
      {tab === "rooms" && <RoomsTab />}
      {tab === "campuses" && <CampusesTab />}
      {tab === "categories" && <CategoriesTab />}
    </div>
  );
}

/* ------------------------------------------------------- new-event blocks -- */

// A monotonic counter for React keys on the module blocks.
//
// THE ARRAY INDEX WOULD NOT DO. SearchOne and SearchMany hold their own open/search
// state, and the day buttons and time boxes are uncontrolled DOM. Keying on the index
// means removing block 1 renumbers block 2 to 1, React reuses the first block's DOM for
// it, and whatever was typed or open in one block appears attached to another. A
// counter that never repeats within the life of the page keeps each block's identity
// stable across an insert or a removal. Module-level rather than a ref because it only
// has to be unique among blocks rendered at the same time, and one form is open at once.
let blockSeq = 0;

/**
 * One module inside a new event: what is taught, by whom, where, when and how often.
 *
 * BOTH SESSION PAIRS ARE HELD EVEN WHILE ONLY ONE IS SHOWN. Somebody who sets two
 * sessions, types both, then flips back to one to check something would otherwise lose
 * the afternoon times on the way back. Only `sessions.slice(0, sessionCount)` is sent,
 * so the unshown pair costs nothing but is still there.
 */
const blankBlock = (date) => ({
  key: `blk${++blockSeq}`,
  title: "", unitId: "", staffIds: [], roomId: "", categoryId: "",
  date, endDate: "", days: [],
  sessionCount: 1,
  sessions: [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "16:00" }],
});

function PlannerCalendarTab({ staff = [], units = [], cohorts = [], courses = [], hndLoaded, refreshHnd }) {
  // Courses, units and cohorts load lazily — the store only fetches them when a page
  // that needs them is opened. GroupsTab already forces that; the calendar now needs it
  // too, and needs COURSES in particular: the school filter is unit → course → school,
  // so with the course list unloaded every module would look as though it belonged to no
  // school. An administrator who lands here first would find the School picker narrowing
  // the lists to nothing and conclude the filter was broken.
  useEffect(() => { if (!hndLoaded && refreshHnd) refreshHnd().catch(() => {}); }, [hndLoaded, refreshHnd]);

  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  const [anchor, setAnchor] = useState(today);
  const [view, setView] = useState("week");
  const [events, setEvents] = useState([]);
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(true);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [warnings, setWarnings] = useState([]);
  const [editing, setEditing] = useState(null);
  const [prefs, setPrefs] = useState(false);

  // WHAT THE SCREEN IS ASKING, instead of window.confirm and window.prompt.
  //
  // Three of them were browser dialogs: publish-the-period, delete-this-event and
  // repeat-until. A native dialog announces itself as "edtech-hub-tan.vercel.app says",
  // which reads as the browser interrupting rather than the app asking — and it is the
  // same chrome a phishing page produces, so it is exactly the prompt a careful person
  // has been taught to dismiss without reading. It also cannot be styled, cannot be
  // dismissed by Android's back button the way ConfirmDialog handles, and on a packaged
  // Capacitor build renders as a system alert bearing the WebView's own hostname.
  //
  // `null`, or { kind: "publish" | "delete" | "repeat", … }. One piece of state rather
  // than three booleans: they are mutually exclusive, and three flags invite the state
  // where two are true.
  const [ask, setAsk] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [cats, setCats] = useState([]);
  const [depts, setDepts] = useState([]);

  const { from, to } = windowFor(view, anchor);

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      // Drafts INCLUDED, deliberately: an administrator building next term must see
      // what they are building. That is the whole difference between this screen and
      // the staff one, which is published-only.
      const [ev, st, rm, ct, dp] = await Promise.all([
        api.ttEvents({ from, to }), api.ttSettings(), api.ttRooms(), api.ttCategories(),
        // Fetched here with the rest rather than in its own effect, so a school added on
        // the Schools tab is in the picker as soon as the calendar is looked at again.
        // Refetched on every window change like the rooms and categories beside it; it
        // is a handful of rows and a second code path to keep it fresh is not worth it.
        //
        // ITS FAILURE IS SWALLOWED, alone among the five. The other four are the
        // calendar — without them there is nothing to draw — but the school list only
        // fills one picker, and letting a 404 from an API that has not been redeployed
        // yet blank the whole timetable would be a far larger fault than an empty
        // School dropdown. An empty list reads as "no schools", which is also what an
        // institution that has not created any looks like.
        api.ttDepartments().catch(() => []),
      ]);
      setEvents(ev || []);
      setDepts(dp || []);
      // Drawn with the COLLEGE's settings over the platform defaults, never with this
      // administrator's personal ones. They are laying out a timetable other people
      // read, and their own hidden weekend would hide events they had scheduled on it.
      setSettings({ ...st.defaults, ...st.institution });
      setRooms(rm || []); setCats(ct || []);
    } catch (e) { setErr(e?.message || "Could not load the timetable."); }
    finally { setBusy(false); }
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  // A NEW EVENT IS A SHARED HEAD AND A LIST OF MODULE BLOCKS.
  //
  // School and groups are chosen ONCE, because they are the two facts that do not change
  // between the modules a group is taught: "the second-year Computing lot" is one answer,
  // and asking for it once per module is both slower and an invitation to enter it
  // differently the third time. Everything that legitimately differs per module — who
  // teaches it, where, on which days, between which dates, once or twice a day — lives on
  // its own block.
  //
  // `showAllSchools` is FORM STATE AND NOT PART OF THE EVENT. It never reaches the wire;
  // save() builds each body field by field rather than spreading this object, which is
  // what keeps it out.
  const blank = () => ({
    academicDepartmentId: "", showAllSchools: false,
    cohortIds: [], notes: "", published: false,
    blocks: [blankBlock(anchor)],
  });

  const setBlock = (i, patch) => setEditing((ev) => ({ ...ev, blocks: ev.blocks.map((b, j) => (j === i ? { ...b, ...patch } : b)) }));
  const setSession = (i, si, patch) => setEditing((ev) => ({
    ...ev,
    blocks: ev.blocks.map((b, j) => (j === i ? { ...b, sessions: b.sessions.map((s, k) => (k === si ? { ...s, ...patch } : s)) } : b)),
  }));

  // A cohort's own name is an intake label like "SEP 2025", which repeats across every
  // course in the college. Prefixing the course is how the rest of StaffHub already
  // renders these, and without it the Groups list is a wall of identical entries.
  const cohortLabel = (c) => {
    const course = courses.find((x) => x.id === c.courseId);
    return course ? `${course.name} — ${c.name}` : c.name;
  };
  const courseName = (id) => courses.find((x) => x.id === id)?.name || "";

  /* ------------------------------------------- the school narrows the lists -- */
  //
  // UNITS AND COHORTS DO NOT CARRY A SCHOOL OF THEIR OWN — not in what the browser is
  // given, at least: sUnit and sCohort ship `courseId` and nothing else, while sCourse
  // ships `academicDepartmentId`. So the path is unit → course → school, joined here in
  // memory out of three lists the store already holds. No endpoint, no server change, and
  // nothing to keep in step with a second implementation.
  const schoolOfCourse = (courseId) => courses.find((c) => c.id === courseId)?.academicDepartmentId || null;

  // NARROWING IS OFF WHILE EDITING, and only ever applies to a new event. The edit form
  // has no "show all" escape beside it, so filtering there could hide the module an
  // existing class is already on with no way back to it.
  //
  // It is also off when the course list is empty, which is the state a lazily-loaded
  // store starts in: with no courses, schoolOfCourse answers null for everything and a
  // strict filter would empty both pickers while looking exactly like "this school
  // teaches nothing".
  const schoolId = (!editing?.id && editing?.academicDepartmentId) || "";
  const narrowing = !!schoolId && !editing?.showAllSchools && courses.length > 0;

  /**
   * `rows` narrowed to the chosen school — but never dropping what is ALREADY CHOSEN.
   *
   * Without that second half the escape hatch is a trap in the other direction: pick a
   * module, then change the school, and SearchOne finds no option matching the id it
   * holds, so it silently reverts to "No module" on the screen while still sending the
   * module. The value and what the screen says about it must not be able to disagree.
   */
  const narrow = (rows, chosenIds = []) => (
    narrowing ? rows.filter((r) => schoolOfCourse(r.courseId) === schoolId || chosenIds.includes(r.id)) : rows
  );

  /* ---------------------------------------------------------- what it makes -- */
  //
  // What the blocks WOULD create, computed here so the count can be shown BEFORE the
  // request. Bank holidays are subtracted because the server subtracts them, and a
  // preview that disagreed with the result would be worse than no preview at all.
  const previewBlocks = useMemo(() => {
    if (!editing || editing.id || !Array.isArray(editing.blocks)) return [];
    return editing.blocks.map((b) => {
      const sessions = Math.max(1, Math.min(2, b.sessionCount || 1));
      if (!b.date) return { dates: [], sessions, classes: 0 };
      // NO END DATE IS ONE CLASS ON ONE DATE, and bank holidays are NOT subtracted from
      // it — the server's single-date path does not consult them either. A college that
      // deliberately schedules an open day on Easter Monday gets it; silently removing an
      // explicitly typed date would be the screen overruling the person using it.
      if (!b.endDate) return { dates: [b.date], sessions, classes: sessions };
      const y1 = Number(b.date.slice(0, 4));
      const y2 = Number(b.endDate.slice(0, 4));
      const skip = Number.isFinite(y1) && Number.isFinite(y2) ? (ukBankHolidaysRange(y1, y2) || []) : [];
      const dates = seriesPreviewDates(b.date, b.endDate, b.days || [], skip);
      return { dates, sessions, classes: dates.length * sessions };
    });
  }, [editing]);

  const previewTotals = useMemo(() => {
    const classes = previewBlocks.reduce((a, p) => a + p.classes, 0);
    const groups = (editing?.cohortIds || []).length;
    // WEEKS, counted as distinct Mondays across every block's dates rather than as
    // (end − start) / 7. A module taught on Tuesdays over a range that starts on a
    // Thursday spans fewer teaching weeks than the calendar between the two dates
    // suggests, and the figure people check a preview against is "how many weeks of
    // teaching is this".
    const weeks = new Set(previewBlocks.flatMap((p) => p.dates).map(mondayOf)).size;
    return {
      classes, groups, weeks,
      modules: previewBlocks.length,
      sessions: Math.max(1, ...previewBlocks.map((p) => p.sessions)),
      // REGISTERS ARE CLASSES × GROUPS, and with no group that is zero rather than
      // "classes". A class with nobody assigned to it produces no register at all, and a
      // preview that quietly counted one would be reassuring about the single thing an
      // administrator is here to produce.
      registers: classes * groups,
    };
  }, [previewBlocks, editing]);

  /* ------------------------------------------------------------------ save -- */

  const save = async () => {
    setErr(""); setNote(""); setWarnings([]);

    // EDITING KEEPS THE OLD SINGLE-EVENT PATH, untouched. Changing one occurrence must
    // never silently generate a term, so an edit sends one body and gets one event back.
    if (editing.id) {
      try {
        const body = { ...editing, staffIds: editing.staffIds || [], cohortIds: editing.cohortIds || [] };
        // The repeat fields belong to CREATE only. Sent on an update they would be
        // ignored, but leaving them on the object invites somebody to honour them later
        // and turn "fix this Tuesday's room" into a term of new classes. `blocks` and
        // `showAllSchools` never exist on an event loaded from the server; they are
        // deleted anyway so that a future path which reuses `blank()` here cannot post
        // form state to the API.
        delete body.endDate; delete body.days; delete body.blocks; delete body.showAllSchools;
        const r = await api.ttUpdateEvent(editing.id, body);
        // A CLASH IS A WARNING, NOT A FAILURE. The server saved it. Closing the editor
        // and showing the warnings above the grid is the honest reading — refusing to
        // close would imply the save had not happened, and an administrator would try
        // again and create a second copy.
        setWarnings(r.warnings || []);
        setEditing(null);
        load();
      } catch (e) { setErr(e?.message || "Could not save the event."); }
      return;
    }

    // ONE POST PER MODULE BLOCK. The endpoint already turns a start date, an end date and
    // a set of weekdays into a whole series under one seriesId, and the block is the right
    // unit of failure: three modules are three independent series, and one of them being
    // refused says nothing about the other two. A single request carrying all three would
    // have to choose between rolling back work the college wanted and reporting a partial
    // success it had no vocabulary for.
    const failures = [];
    const unsure = [];
    const madeWarnings = [];
    const savedKeys = new Set();
    let created = 0;

    for (const b of editing.blocks) {
      const name = (b.title || "").trim() || courseName(units.find((u) => u.id === b.unitId)?.courseId) || "Untitled module";
      const sessions = b.sessions.slice(0, Math.max(1, Math.min(2, b.sessionCount || 1)));
      const body = {
        academicDepartmentId: editing.academicDepartmentId || "",
        cohortIds: editing.cohortIds || [],
        notes: editing.notes || "",
        published: !!editing.published,
        title: (b.title || "").trim(),
        unitId: b.unitId || "",
        staffIds: b.staffIds || [],
        roomId: b.roomId || "",
        categoryId: b.categoryId || "",
        date: b.date,
        // `start` and `end` ARE STILL SENT beside `sessions`, and that is deliberate twice
        // over. The server validates the event before it looks at the session list, so the
        // single pair still has to be there and be valid; and an API not yet redeployed
        // with session support creates the first session rather than rejecting the whole
        // request. What came back is checked against the preview below, so the shortfall
        // on such a server is reported rather than hidden.
        start: sessions[0].start, end: sessions[0].end,
        sessions,
        ...(b.endDate ? { endDate: b.endDate, days: b.days || [] } : {}),
      };
      try {
        const r = await api.ttCreateEvent(body);
        created += r.created || 1;
        savedKeys.add(b.key);
        // Tagged with the module, because "week 4 clashes" out of one of three blocks is
        // only actionable if the reader knows which of the three it came from.
        for (const w of r.warnings || []) madeWarnings.push({ ...w, module: name });
      } catch (e) {
        // REFUSED IS NOT THE SAME AS UNKNOWN, and only one of the two is safe to retry.
        //
        // A 400 means the server read the request and declined it: nothing was written,
        // the block is unchanged, and pressing Save again is correct. Anything else — a
        // timeout, a 5xx, a dropped connection — means the request may have been carried
        // out anyway. The server writes a series row by row and has no unique constraint
        // to lean on, so a second Save after a timeout writes a SECOND complete series
        // and doubles the attendance denominator of every student in it.
        //
        // So an unknown outcome is reported differently and the block is marked, rather
        // than being quietly re-armed as though it had simply been rejected.
        const refused = e?.status === 400 || e?.status === 409;
        const partial = e?.body?.partial ? ` ${e.body.created} of ${e.body.expected} were created — series ${e.body.seriesId}.` : "";
        failures.push(refused
          ? `${name}: ${e?.message || "refused by the server"}`
          : `${name}: ${e?.message || "the server did not answer"} — THIS MAY HAVE SAVED.${partial} Check the calendar before saving it again.`);
        if (!refused) unsure.push(name);
      }
    }

    setWarnings(madeWarnings);

    if (!failures.length) {
      const expected = previewTotals.classes;
      setNote(
        `${created} class(es) created across ${editing.blocks.length} module(s).`
        // Saving writes the CLASSES. The registers are built by "Publish this period"
        // over a date range — syncEventRegisters is called from the publish handler and
        // from an event edit, never from create. Saying "will follow" implied they were
        // already on their way and left an administrator waiting for something that
        // needed a second action nobody had mentioned; these dates are usually months
        // outside the window they are looking at, so it would not have arrived.
        + (previewTotals.registers ? ` Publish these dates to create the ${previewTotals.registers} register(s).` : "")
        // Said ONLY when the two disagree. The preview is computed from the same dates and
        // the same bank holidays the server uses, so a mismatch means one of them is
        // wrong — most likely a server that does not expand two sessions yet — and
        // quietly printing the server's number instead would hide exactly that.
        + (expected && created !== expected ? ` (${expected} were expected — check the calendar.)` : ""),
      );
      setEditing(null);
      load();
      return;
    }

    // A PARTIAL SAVE KEEPS THE BLOCKS THAT FAILED AND DROPS THE ONES THAT WORKED.
    //
    // Closing the modal would lose the unsaved work; leaving every block in it would mean
    // that pressing Save again creates a second copy of everything that already
    // succeeded. Naming the failures is the rest of the point — one "could not save" in
    // front of three modules is three things to go and check by hand.
    setErr(`${failures.length} module(s) were not saved — ${failures.join("; ")}`
      + (unsure.length ? " Do not press Save again until you have checked the calendar — a repeat could create a second copy." : ""));
    if (created) {
      setNote(`${created} class(es) from the other module(s) were created. Only the modules still shown are left to fix.`);
      setEditing((ev) => ({ ...ev, blocks: ev.blocks.filter((b) => !savedKeys.has(b.key)) }));
      load();
    }
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button onClick={() => setAnchor(today)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50">Today</button>
        <button onClick={() => setAnchor((a) => shiftAnchor(view, a, -1))} aria-label="Previous" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><ChevronLeft size={16} /></button>
        <p className="min-w-[150px] text-center text-sm font-extrabold text-slate-700">{RANGE_LABEL(view, from, to)}</p>
        <button onClick={() => setAnchor((a) => shiftAnchor(view, a, 1))} aria-label="Next" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><ChevronRight size={16} /></button>
        <input type="date" value={anchor} onChange={(e) => e.target.value && setAnchor(e.target.value)} aria-label="Jump to date"
          className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-bold text-slate-600" />
        <select value={view} onChange={(e) => setView(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-bold text-slate-600">
          {["day", "week", "month", "timeline"].map((v) => <option key={v} value={v}>{v[0].toUpperCase() + v.slice(1)}</option>)}
        </select>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => setEditing(blank())} className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold text-white" style={{ background: NAVY }}><Plus size={14} /> New event</button>
          <button
            onClick={() => setAsk({ kind: "publish" })}
            className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"><Send size={14} /> Publish this period</button>
          <button onClick={() => setPrefs(true)} aria-label="Display settings" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><SettingsIcon size={16} /></button>
        </div>
      </div>

      {/* An outcome and a failure are different things and are told apart on purpose:
          "12 events published" in slate, "could not publish" in rose. One colour for
          both trains people to ignore the colour. */}
      {note && <div className="mb-3 rounded-lg bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700">{note}</div>}
      {err && <div className="mb-3 flex items-center gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700 ring-1 ring-rose-200"><AlertTriangle size={15} /> {err}</div>}

      {/* Clash warnings sit ABOVE the grid and stay until the next save. They are the
          only thing on this screen reporting a decision the administrator may want to
          undo, and burying them in a toast that vanishes is the same as not showing
          them at all. */}
      {!!warnings.length && (
        <div className="mb-3 rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200">
          <div className="mb-1 flex items-center gap-1.5 text-sm font-extrabold text-amber-800">
            <AlertTriangle size={15} /> Saved, but this clashes
            <button onClick={() => setWarnings([])} className="ml-auto rounded px-2 py-0.5 text-[11px] font-bold hover:bg-amber-100">Dismiss</button>
          </div>
          <ul className="space-y-0.5 text-xs text-amber-800">
            {warnings.map((w, i) => (
              <li key={i}>
                {/* The module first, because with three blocks saved at once "week 4
                    clashes" is only actionable if the reader knows which of the three. */}
                {w.module ? <b>{w.module} · </b> : null}
                {/* The session's own hours when the server sent them. With two sessions a
                    day, two warnings on one date are otherwise the same line twice and
                    there is no way to tell which half of the day to go and look at. */}
                {w.date ? <b>{w.date}{w.start ? ` ${w.start}–${w.end}` : ""}: </b> : null}
                {(w.clashes || [w]).map((c, j) => (
                  <span key={j}>
                    {c.kind === "room" ? "Room" : c.kind === "staff" ? "Staff" : "Group"} <b>{c.resource}</b> is already on “{c.event?.title}” {c.event?.start}–{c.event?.end}
                    {j < (w.clashes || [w]).length - 1 ? "; " : ""}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}

      {busy && !settings ? (
        <div className="flex justify-center py-16 text-slate-400"><Loader2 className="animate-spin" size={20} /></div>
      ) : (
        <TimetableCalendar events={events} settings={settings} view={view} anchor={anchor} today={today}
          onSelectEvent={(e) => setEditing({ ...e, staffIds: (e.staff || []).map((s) => s.id), cohortIds: (e.groups || []).map((g) => g.id) })}
          selectedId={editing?.id} />
      )}

      {editing && createPortal(
        // RENDERED INTO document.body, NOT WHERE IT SITS IN THE TREE, and this is a bug
        // fix rather than a preference.
        //
        // `.fade-up` — the admin console's entrance animation, applied to the whole view
        // — is declared `animation: … both`. The forwards half of that fill holds the
        // final keyframe for ever, and although that keyframe says `transform: none`, the
        // browser computes it as `matrix(1, 0, 0, 1, 0, 0)`. ANY computed transform other
        // than the keyword `none` makes an element the containing block for its
        // fixed-position descendants — so `fixed inset-0` here resolved against a
        // 1465px-tall view container instead of the viewport.
        //
        // The modal was therefore centred in 1465px and drawn from y=281 in an 1100px
        // window: its footer, and the Save button in it, sat 159px BELOW the bottom of
        // the screen with no way to reach them. Measured, not guessed.
        //
        // The root cause is that shared animation, and every modal in the console
        // inherits it — the others only look fine because they are short enough that
        // being centred in a taller box still lands them on screen. Fixing `.fade-up`
        // would fix all of them at once, but it is used in 110 places and this is not
        // the change to make blind. A portal takes this screen out of the containing
        // block entirely, which is also the right thing for a modal on its own merits.
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-3">
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between px-4 py-3 text-white" style={{ background: NAVY }}>
              <p className="text-base font-extrabold">{editing.id ? "Edit event" : "New event"}</p>
              <button onClick={() => setEditing(null)} aria-label="Close" className="rounded-full p-1.5 hover:bg-white/20"><X size={18} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
            {editing.id ? (
              /* ------------------------------------------------ EDITING ONE EVENT --
                 The single-event form, unchanged. An edit touches ONE occurrence, so it
                 shows no repeat controls, no session count and no module blocks: every
                 one of those turns "fix this Tuesday's room" into a term of new classes,
                 which is the one thing an edit must never be able to do by accident. */
              <div className="grid gap-3 sm:grid-cols-2">
                {/* THE SCHOOL APPEARS HERE ONLY IF THE SERVER REPORTED ONE.
                    sEvent has to name the field for this to render, and until it does an
                    empty picker would be a lie about a stored value: it would read as
                    "this class belongs to no school" for a class that belongs to one, and
                    invite somebody to "correct" it to the value it already had. An absent
                    key is left absent in the body too, and the update route treats an
                    absent key as "unchanged" — so nothing here can blank a school it
                    cannot see.

                    `depts.length` IS PART OF THE SAME GUARD, not a separate nicety. The
                    school list is the one fetch in load() whose failure is deliberately
                    swallowed, so it can legitimately be empty while the event holds a
                    school id — and SearchOne, finding no option matching that id, falls
                    back to its placeholder and renders "No school". That is precisely the
                    lie the paragraph above is about, arriving through the list rather than
                    through the field. */}
                {"academicDepartmentId" in editing && depts.length > 0 && (
                  <Field label="School" hint="Which school this class belongs to">
                    <SearchOne value={editing.academicDepartmentId || ""} placeholder="No school" noneLabel="No school"
                      options={depts.filter((d) => d.active !== false).map((d) => ({ id: d.id, label: d.name }))}
                      onChange={(id) => setEditing({ ...editing, academicDepartmentId: id })} />
                  </Field>
                )}
                <Field label="Title"><input className={inputCls} value={editing.title || ""} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></Field>
                <Field label="Date">
                  <input type="date" className={inputCls} value={editing.date || ""} onChange={(e) => setEditing({ ...editing, date: e.target.value })} />
                </Field>
                <Field label="Start"><input type="time" className={inputCls} value={editing.start || ""} onChange={(e) => setEditing({ ...editing, start: e.target.value })} /></Field>
                <Field label="End"><input type="time" className={inputCls} value={editing.end || ""} onChange={(e) => setEditing({ ...editing, end: e.target.value })} /></Field>
                <Field label="Room" hint="Type to search by number or campus">
                  <SearchOne value={editing.roomId || ""} placeholder="No room" noneLabel="No room"
                    options={rooms.filter((r) => r.active).map((r) => ({ id: r.id, label: r.label, sub: r.kind || "" }))}
                    onChange={(id) => setEditing({ ...editing, roomId: id })} />
                </Field>
                <Field label="Category" hint="Type to search">
                  <SearchOne value={editing.categoryId || ""} placeholder="No category" noneLabel="No category"
                    options={cats.filter((c) => c.active).map((c) => ({ id: c.id, label: c.name }))}
                    onChange={(id) => setEditing({ ...editing, categoryId: id })} />
                </Field>
                {/* Nullable on purpose. An exam, a workshop or a staff meeting belongs to
                    no module — which is exactly what HndSession.unitId being NOT NULL
                    cannot express, and the reason this feature has its own table. */}
                <Field label="Module" hint="Optional — exams and meetings have none">
                  <SearchOne value={editing.unitId || ""} placeholder="No module" noneLabel="No module"
                    options={units.map((u) => ({ id: u.id, label: u.code ? `${u.code} — ${u.name}` : u.name, sub: courseName(u.courseId) }))}
                    onChange={(id) => setEditing({ ...editing, unitId: id })} />
                </Field>
                <Field label="Teaching staff" hint="Type a name; add as many as teach it">
                  <SearchMany value={editing.staffIds || []} placeholder="Search staff…"
                    options={staff.map((s) => ({ id: s.id, label: s.name, sub: s.dept || "" }))}
                    onChange={(v) => setEditing({ ...editing, staffIds: v })} />
                </Field>
                <Field label="Groups" hint="Type a group name; each gets its own register">
                  <SearchMany value={editing.cohortIds || []} placeholder="Search groups…"
                    options={cohorts.map((c) => ({ id: c.id, label: cohortLabel(c) }))}
                    onChange={(v) => setEditing({ ...editing, cohortIds: v })} />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Notes"><textarea rows={2} className={inputCls} value={editing.notes || ""} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></Field>
                </div>
                <label className="flex items-center gap-2 text-sm font-semibold text-slate-600 sm:col-span-2">
                  <input type="checkbox" checked={!!editing.published} onChange={(e) => setEditing({ ...editing, published: e.target.checked })} className="h-4 w-4 rounded border-slate-300" />
                  Published — visible to staff
                </label>
              </div>
            ) : (
              /* --------------------------------------------------- A NEW EVENT --
                 School and groups once at the top, then one block per module. */
              <>
                {/* The shared head is TINTED and labelled, so the eye can tell at a glance
                    which two answers cover everything below from the per-module cards that
                    follow. Without the boundary the form reads as one long column of
                    equally-weighted fields, and the fact that School and Groups are asked
                    once — the whole point of the layout — is invisible. */}
                <div className="rounded-xl border p-4" style={{ background: alpha(NAVY, 4), borderColor: alpha(NAVY, 14) }}>
                  <p className="mb-3 text-[11px] font-extrabold uppercase tracking-wide" style={{ color: NAVY }}>
                    Applies to every module below
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                  {/* THE SCHOOL IS THE FIRST FIELD ON THE FORM, ahead of the title.
                      It is the question a timetabler answers first in their head — "this
                      is the Computing lot" — and asking it first is what lets everything
                      below be narrowed to that answer. A title typed before the school is
                      chosen is a title typed against the whole college's module list. */}
                  <div>
                    <Field label="School" hint="Pick this first — it narrows the modules and groups below">
                      <SearchOne value={editing.academicDepartmentId || ""} noneLabel="No school"
                        placeholder={depts.length ? "Choose a school…" : "No schools yet — add one on the Schools tab"}
                        options={depts.filter((d) => d.active !== false).map((d) => ({ id: d.id, label: d.name }))}
                        onChange={(id) => setEditing({ ...editing, academicDepartmentId: id })} />
                    </Field>
                    {/* THE ESCAPE, AND IT IS NOT OPTIONAL POLISH.
                        Some classes are genuinely shared — a maths unit taught to both
                        Engineering and Business, a joint induction. With strict filtering
                        and no way out, the only route to entering one is to pick a school
                        the class does not belong to, and the school column then holds a
                        lie that nobody can see is a lie. A visible override that somebody
                        chose is a record; a workaround is not. */}
                    <label className="mt-1.5 flex items-center gap-2 text-xs font-semibold text-slate-500">
                      <input type="checkbox" checked={!!editing.showAllSchools}
                        onChange={(e) => setEditing({ ...editing, showAllSchools: e.target.checked })}
                        className="h-3.5 w-3.5 rounded border-slate-300" />
                      Show all schools — for a class shared between two
                    </label>
                  </div>
                  <Field label="Groups" hint="Chosen once; every module below is taught to these groups, and each gets its own register">
                    <SearchMany value={editing.cohortIds || []} placeholder="Search groups…"
                      options={narrow(cohorts, editing.cohortIds || []).map((c) => ({ id: c.id, label: cohortLabel(c) }))}
                      onChange={(v) => setEditing({ ...editing, cohortIds: v })} />
                    {narrowing && !narrow(cohorts, editing.cohortIds || []).length && (
                      <span className="mt-1 block text-[11px] font-semibold text-amber-700">No groups belong to that school. Tick “Show all schools” to see the rest.</span>
                    )}
                  </Field>
                  </div>
                </div>

                {/* ONE BLOCK PER MODULE. Everything that legitimately differs between
                    the modules one group is taught — the lecturer, the room, the days,
                    the term dates, one session or two — is here rather than at the top,
                    because a form that shared them would be a form for one module wearing
                    a plural label. */}
                {editing.blocks.map((b, i) => {
                  const pv = previewBlocks[i];
                  const unitOpts = narrow(units, b.unitId ? [b.unitId] : []);
                  return (
                    <div key={b.key} className="mt-3 rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-extrabold text-white" style={{ background: NAVY }}>{i + 1}</span>
                        <p className="text-sm font-extrabold text-slate-700">{(b.title || "").trim() || "Module " + (i + 1)}</p>
                        {editing.blocks.length > 1 && (
                          <button type="button" onClick={() => setEditing({ ...editing, blocks: editing.blocks.filter((_, j) => j !== i) })}
                            className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-[11px] font-bold text-slate-400 hover:bg-rose-50 hover:text-rose-600">
                            <X size={12} /> Remove
                          </button>
                        )}
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {/* Nullable on purpose. An exam, a workshop or a staff meeting
                            belongs to no module — which is exactly what HndSession.unitId
                            being NOT NULL cannot express, and the reason this feature has
                            its own table. */}
                        <Field label="Module" hint={narrowing ? "Narrowed to the school above" : "Optional — exams and meetings have none"}>
                          <SearchOne value={b.unitId || ""} placeholder="No module" noneLabel="No module"
                            options={unitOpts.map((u) => ({ id: u.id, label: u.code ? `${u.code} — ${u.name}` : u.name, sub: courseName(u.courseId) }))}
                            onChange={(id) => {
                              // THE TITLE IS FILLED IN FROM THE MODULE ONLY WHILE IT IS
                              // STILL EMPTY. Overwriting on every change would throw away
                              // a title somebody had deliberately typed the moment they
                              // corrected the module beside it, and a required field that
                              // silently rewrites itself is worse than one left blank.
                              const u = units.find((x) => x.id === id);
                              const fill = u && !(b.title || "").trim() ? { title: u.code ? `${u.code} — ${u.name}` : u.name } : {};
                              setBlock(i, { unitId: id, ...fill });
                            }} />
                          {narrowing && !unitOpts.length && (
                            <span className="mt-1 block text-[11px] font-semibold text-amber-700">No modules belong to that school. Tick “Show all schools” to see the rest.</span>
                          )}
                        </Field>
                        <Field label="Title" hint="Taken from the module; change it if the class is called something else">
                          <input className={inputCls} value={b.title || ""} onChange={(e) => setBlock(i, { title: e.target.value })} />
                        </Field>
                        {/* STAFF ARE NOT NARROWED BY THE SCHOOL, and the department is
                            shown beside each name instead. Two reasons, and both matter:
                            a lecturer's departments only reach the browser when the query
                            asks for the relation, so filtering on what sStaff ships would
                            silently hide everybody; and lecturers routinely teach across
                            schools, so even a correct filter would hide the right answer.
                            The subtitle is what tells two people of the same name apart,
                            which is the question this list actually has to answer. */}
                        <Field label="Teaching staff" hint="Type a name — the school beside it tells two of the same name apart">
                          <SearchMany value={b.staffIds || []} placeholder="Search staff…"
                            options={staff.map((s) => ({ id: s.id, label: s.name, sub: s.dept || "" }))}
                            onChange={(v) => setBlock(i, { staffIds: v })} />
                        </Field>
                        <Field label="Room" hint="Type to search by number or campus">
                          <SearchOne value={b.roomId || ""} placeholder="No room" noneLabel="No room"
                            options={rooms.filter((r) => r.active).map((r) => ({ id: r.id, label: r.label, sub: r.kind || "" }))}
                            onChange={(id) => setBlock(i, { roomId: id })} />
                        </Field>
                        <Field label="Category" hint="Type to search">
                          <SearchOne value={b.categoryId || ""} placeholder="No category" noneLabel="No category"
                            options={cats.filter((c) => c.active).map((c) => ({ id: c.id, label: c.name }))}
                            onChange={(id) => setBlock(i, { categoryId: id })} />
                        </Field>
                        {/* THE MODULE'S TWO DATES SIT SIDE BY SIDE, IN THEIR OWN PANEL.
                            They were a grid apart — the start date in the right column
                            beside Category, the end date in the left column below it —
                            so the pair never read as a range, and the second was labelled
                            "Repeat until", which sounds like an optional repetition
                            setting rather than the date the module finishes. It was
                            reported as "there is no start and end date", which is
                            precisely what the layout was saying. */}
                        <div className="rounded-lg bg-white p-2.5 ring-1 ring-slate-200 sm:col-span-2">
                          <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">Module runs</p>
                          <div className="grid gap-2 sm:grid-cols-2">
                            <Field label="Start date" hint="The first class">
                              <input type="date" className={inputCls} value={b.date || ""} onChange={(e) => setBlock(i, { date: e.target.value })} />
                            </Field>
                            <Field label="End date" hint="Repeats weekly until then — blank for one class only">
                              <input type="date" className={inputCls} value={b.endDate || ""} min={b.date || undefined}
                                onChange={(e) => setBlock(i, { endDate: e.target.value })} />
                            </Field>
                          </div>
                        </div>
                        <Field label="On these days" hint={b.endDate ? "Which weekday(s) it falls on" : "Set an end date first"}>
                          <div className="flex flex-wrap gap-1 pt-1">
                            {DAY_LABELS.map((lbl, di) => {
                              const iso = di + 1;
                              const on = (b.days || []).includes(iso);
                              return (
                                <button key={iso} type="button" disabled={!b.endDate}
                                  onClick={() => setBlock(i, { days: on ? (b.days || []).filter((d) => d !== iso) : [...(b.days || []), iso] })}
                                  className={`h-8 w-9 rounded text-xs font-bold disabled:opacity-40 ${on ? "text-white" : "bg-white text-slate-500 ring-1 ring-slate-300"}`}
                                  style={on ? { background: NAVY } : undefined}>{lbl}</button>
                              );
                            })}
                          </div>
                        </Field>

                        {/* ONE OR TWO SESSIONS A DAY. Two is two separate classes on the
                            same date, not one long one with a gap drawn in it — which is
                            what makes each afternoon its own register. A morning somebody
                            attended and an afternoon they did not are two different facts,
                            and folding them into one block loses the second one. */}
                        <div className="rounded-lg bg-white p-2.5 ring-1 ring-slate-200 sm:col-span-2">
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">How many sessions a day?</span>
                            {[1, 2].map((n) => (
                              <button key={n} type="button" onClick={() => setBlock(i, { sessionCount: n })}
                                className={`rounded-lg px-3 py-1 text-xs font-bold ${b.sessionCount === n ? "text-white" : "bg-white text-slate-500 ring-1 ring-slate-300"}`}
                                style={b.sessionCount === n ? { background: NAVY } : undefined}>
                                {n === 1 ? "One" : "Two"}
                              </button>
                            ))}
                          </div>
                          {b.sessions.slice(0, b.sessionCount).map((s, si) => (
                            <div key={si} className="mb-2 grid gap-2 sm:grid-cols-2">
                              <Field label={b.sessionCount > 1 ? `Session ${si + 1} — start` : "Start"}>
                                <input type="time" className={inputCls} value={s.start} onChange={(e) => setSession(i, si, { start: e.target.value })} />
                              </Field>
                              <Field label={b.sessionCount > 1 ? `Session ${si + 1} — end` : "End"}>
                                <input type="time" className={inputCls} value={s.end} onChange={(e) => setSession(i, si, { end: e.target.value })} />
                              </Field>
                            </div>
                          ))}
                          {b.sessionCount > 1 && (
                            <p className="text-[11px] text-slate-400">
                              Two blocks on the same day, each with its own class and its own register. They may sit back to back; they may not overlap.
                            </p>
                          )}
                        </div>
                      </div>

                      {/* The count for THIS module, beside the module, as well as in the
                          total below. With three blocks open, a total that is wrong tells
                          nobody which of the three is wrong. */}
                      {b.date && (
                        <p className="mt-2 text-xs font-semibold text-slate-600">
                          {pv?.classes
                            ? <>{pv.dates.length} date{pv.dates.length === 1 ? "" : "s"} × {pv.sessions} session{pv.sessions === 1 ? "" : "s"} = <strong>{pv.classes}</strong> class{pv.classes === 1 ? "" : "es"}, {pv.dates[0]} to {pv.dates[pv.dates.length - 1]}{b.endDate ? ". UK bank holidays are skipped." : ""}</>
                            : <span className="text-amber-700">No dates fall on those days in that range.</span>}
                        </p>
                      )}
                    </div>
                  );
                })}

                <button type="button" onClick={() => setEditing({ ...editing, blocks: [...editing.blocks, blankBlock(editing.blocks[editing.blocks.length - 1]?.date || anchor)] })}
                  className="mt-3 flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-slate-300 py-2 text-sm font-bold text-slate-500 hover:bg-slate-50">
                  <Plus size={15} /> Add another module
                </button>

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <Field label="Notes" hint="Applied to every class created below">
                      <textarea rows={2} className={inputCls} value={editing.notes || ""} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
                    </Field>
                  </div>
                  <label className="flex items-center gap-2 text-sm font-semibold text-slate-600 sm:col-span-2">
                    <input type="checkbox" checked={!!editing.published} onChange={(e) => setEditing({ ...editing, published: e.target.checked })} className="h-4 w-4 rounded border-slate-300" />
                    Published — visible to staff
                  </label>
                </div>

                {/* THE WHOLE COUNT, IN FRONT OF THE BUTTON THAT MAKES IT.
                    Three modules across a 14-week term with two sessions a day and two
                    groups is 168 classes and 336 registers; that number belongs in front
                    of somebody before they press Save, not after. It multiplies the same
                    four things the loop below does, off the same dates and the same bank
                    holiday list the server uses. */}
                <div className="mt-3 rounded-xl bg-slate-100 p-3">
                  <p className="text-sm font-extrabold text-slate-700">
                    {previewTotals.modules} module{previewTotals.modules === 1 ? "" : "s"}
                    {" · "}{previewTotals.sessions} session{previewTotals.sessions === 1 ? "" : "s"} a day
                    {" · "}{previewTotals.weeks} week{previewTotals.weeks === 1 ? "" : "s"}
                    {" · "}{previewTotals.groups} group{previewTotals.groups === 1 ? "" : "s"}
                    {" = "}<span style={{ color: NAVY }}>{previewTotals.classes} class{previewTotals.classes === 1 ? "" : "es"}</span>
                    {previewTotals.registers ? <span className="text-slate-500">, then {previewTotals.registers} register{previewTotals.registers === 1 ? "" : "s"} once published</span> : null}
                  </p>
                  {/* Zero registers is a real outcome and is said out loud rather than
                      printed as a bare 0. A class with no group attached produces no
                      register at all, and somebody who came here to open registers would
                      otherwise find out weeks later. */}
                  {!previewTotals.groups && (
                    <p className="mt-1 text-xs font-semibold text-amber-700">No group chosen, so these classes will never produce a register. Add one above if they need attendance taking.</p>
                  )}
                </div>
              </>
            )}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 p-3">
              {editing.id && (
                <>
                  <button
                    onClick={() => setAsk({ kind: "repeat", id: editing.id, until: "" })}
                    className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50"><Repeat size={14} /> Repeat weekly</button>
                  <button
                    onClick={() => setAsk({ kind: "delete", id: editing.id, title: editing.title })}
                    className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-bold text-rose-600 hover:bg-rose-50"><Trash2 size={14} /> Delete</button>
                </>
              )}
              <button onClick={() => setEditing(null)} className="ml-auto rounded-lg px-4 py-2 text-sm font-bold text-slate-500 hover:bg-slate-100">Cancel</button>
              {/* EVERY block has to be complete, not just the first one. The loop in
                  save() posts them all, and a block missing its title would be one 400
                  in the middle of a run that had already created the classes before it —
                  a partial save to unpick rather than a button that stayed disabled. */}
              <button onClick={save}
                disabled={editing.id
                  ? (!editing.title?.trim() || !editing.date)
                  : !(editing.blocks?.length && editing.blocks.every((b) => (b.title || "").trim() && b.date))}
                className="flex items-center gap-1 rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-40" style={{ background: NAVY }}><Check size={15} /> Save</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {settings && (
        <TimetableSettingsModal open={prefs} settings={settings} scope="college" onClose={() => setPrefs(false)}
          onSave={async (patch) => { const r = await api.ttSaveSettings(patch); setSettings((s) => ({ ...s, ...r.institution })); setPrefs(false); }} />
      )}

      {/* The app's own confirmation, the same component the sign-out prompt uses. */}
      <ConfirmDialog
        open={ask?.kind === "delete"}
        title="Delete this class?"
        // NAMED, because the modal behind it is covered and "this event" is whichever one
        // the reader believes is open. Deleting a class does NOT delete a register that
        // has marks in it — the register survives, unlinked — and saying so here is what
        // stops somebody hesitating over a safe action or expecting attendance to vanish.
        message={`“${ask?.title || "Untitled"}” will be removed from the calendar. Any register already taken for it is kept.`}
        confirmLabel="Delete" cancelLabel="Keep it" danger
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          const id = ask.id;
          setAsk(null);
          try { await api.ttDeleteEvent(id); setEditing(null); load(); }
          catch (e) { setErr(e?.message || "Could not delete."); }
        }}
      />

      <ConfirmDialog
        open={ask?.kind === "publish"}
        title="Publish this period?"
        message={`Every class from ${from} to ${to} becomes visible to staff, and their registers are created. Drafts you are still working on will go out too.`}
        confirmLabel="Publish" cancelLabel="Not yet"
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          setAsk(null); setErr(""); setNote("");
          try { const r = await api.ttPublish({ from, to, published: true }); setNote(`${r.updated} event(s) published.`); load(); }
          catch (e) { setErr(e?.message || "Could not publish."); }
        }}
      />

      {/* REPEAT NEEDS A DATE, WHICH ConfirmDialog CANNOT CARRY, so this one is its own —
          built to match rather than reaching for window.prompt, which returns a free
          string a reader can typo into "next tuesday" and which offers no date picker at
          all on a phone. */}
      {ask?.kind === "repeat" && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4" style={{ background: "rgba(15,23,42,.45)", backdropFilter: "blur(2px)" }} onClick={() => setAsk(null)}>
          <div className="w-full max-w-xs rounded-2xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <p className="text-base font-extrabold text-slate-800">Repeat weekly</p>
            <p className="mt-1 text-sm leading-relaxed text-slate-500">A copy of this class on the same weekday, every week, up to and including the date you choose.</p>
            <input type="date" autoFocus className={`${inputCls} mt-3`} value={ask.until}
              min={editing?.date || undefined}
              onChange={(e) => setAsk({ ...ask, until: e.target.value })} />
            <p className="mt-1 text-[11px] text-slate-400">UK bank holidays are skipped.</p>
            <div className="mt-5 flex gap-2">
              <button onClick={() => setAsk(null)} className="flex-1 rounded-xl border-2 border-slate-200 py-2.5 text-sm font-bold text-slate-600 transition hover:bg-slate-50">Cancel</button>
              <button disabled={!ask.until}
                onClick={async () => {
                  const { id, until } = ask;
                  setAsk(null); setErr(""); setNote("");
                  try {
                    const r = await api.ttRepeatEvent(id, { until });
                    // Per-date, because "week 4 clashes" is actionable and "there
                    // were clashes" is not.
                    setWarnings(r.warnings || []);
                    setNote(`${r.created} weekly copies created.`);
                    setEditing(null); load();
                  } catch (e) { setErr(e?.message || "Could not repeat the event."); }
                }}
                className="flex-1 rounded-xl py-2.5 text-sm font-bold text-white shadow-md disabled:opacity-40" style={{ background: NAVY }}>Repeat</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
