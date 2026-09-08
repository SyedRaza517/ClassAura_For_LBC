// Scheduling — the planner half. An administrator places an event and ASSIGNS a
// room, staff and groups to it, from dropdowns backed by real foreign keys.
//
// This is a different page from "Timetable", which still serves the older weekly
// TimetableSlot screen and the student timetable. They are deliberately not merged:
// that one is scoped to a course/year/term and has free-text lecturer and room, and
// folding this into it would mean one screen where half the fields are relations and
// half are strings.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DoorOpen, Tag, CalendarDays, Plus, Trash2, Loader2, AlertTriangle, X, Check,
  ChevronLeft, ChevronRight, Send, Repeat, Settings as SettingsIcon, Users, Building2, ChevronDown, Search,
  GraduationCap, List,
} from "lucide-react";
import { api } from "./api";
import { NAVY, alpha } from "./branding";
import TimetableCalendar from "./TimetableCalendar";
import TimetableSettingsModal from "./TimetableSettingsModal";
import ConfirmDialog from "./ConfirmDialog";
import { windowFor, shiftAnchor, RANGE_LABEL, seriesPreviewDates, mondayOf } from "./timetableView";
import { ukBankHolidaysRange } from "./bankHolidays";

// A DIV, NOT A LABEL, AND THAT IS THE FIX FOR AN UNDISMISSABLE DROPDOWN.
//
// This wrapped its children in <label className="block"> for two years, which is
// correct for a caption over ONE native input and quietly catastrophic over a
// composite widget. A <label> forwards a click anywhere inside it to its labeled
// control — the first labelable descendant — and SearchOne's click-away backdrop is a
// plain <div> covering the whole viewport, rendered inside those children. So a click
// anywhere on screen ran the backdrop's onClick (setOpen(false)) and was then
// forwarded by the label to SearchOne's toggle button (setOpen(v => !v)), which put it
// straight back. The panel closed and reopened in the same tick, so it read as "clicking
// outside does nothing" and the only way out was to pick a value you may not have wanted.
// Reported exactly that way, twice.
//
// Choosing an option was never affected, which is why this survived: the HTML spec
// exempts clicks on interactive descendants from label forwarding, so the option
// buttons and the search input were always safe. Only the inert backdrop was not.
//
// role="group" + aria-label keeps the caption attached to the control for assistive
// technology. That is the RIGHT association here rather than a downgrade: a <label>
// names a single control, and over SearchMany it was naming the first chip's remove
// button. StaffHub's own Field already wraps in a div for the same reason.
function Field({ label, children, hint }) {
  return (
    <div className="block" role="group" aria-label={label}>
      <span className="mb-0.5 block text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[11px] text-slate-400">{hint}</span>}
    </div>
  );
}

/**
 * Close `onOutside` when a pointer goes down anywhere outside `ref`, while `active`.
 *
 * A LISTENER RATHER THAN A FULL-SCREEN DIV, and that is deliberate. The backdrop this
 * replaces had to be a viewport-covering element in the middle of the form, which made
 * it hostage to whatever it happened to be nested inside — a <label> that re-fired the
 * toggle, a transformed ancestor that shrank `fixed` to something smaller than the
 * screen, a stacking context that painted it under the thing it was meant to cover. A
 * document listener has no position, no z-index and no parent, so none of those can
 * reach it, and it works the same from inside the portalled modal as from the tab
 * behind it.
 *
 * `pointerdown`, not `click`: it fires before focus moves, so a picker closes on the
 * way down rather than waiting for a mouseup that may land somewhere else entirely.
 * Capture phase, so a child calling stopPropagation cannot strand a panel open.
 */
function useDismissOnOutside(ref, onOutside, active) {
  useEffect(() => {
    if (!active) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onOutside(); };
    // Escape belongs with it: the two are one behaviour ("let me out"), and splitting
    // them across components is how one of them comes back without the other.
    const onKey = (e) => { if (e.key === "Escape") onOutside(); };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [ref, onOutside, active]);
}
const inputCls = "w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm";

// ISO order, Monday first, matching isoDay() and every other weekday list in this
// feature. A Sunday-first row would put the weekend either side of the working week.
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * "Thu 24 September 2026" out of the stored "2026-09-24".
 *
 * PARSED AS UTC AND FORMATTED IN UTC, which is the same care RANGE_LABEL in
 * timetableView.js already takes. `new Date("2026-09-24")` is UTC midnight, and rendering
 * it in a timezone west of Greenwich prints the 23rd — so a class on the 24th would head
 * a group labelled with the day before it, on exactly the machines least likely to be the
 * ones this was tested on. Pinning both ends removes the question.
 *
 * The WEEKDAY is the reason this exists rather than printing the ISO string. A timetable
 * is read in weekdays — "the Thursday class" — and a heading of bare digits makes the
 * reader count.
 */
function dateHeading(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || "")) return d || "";
  return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

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
  const box = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissOnOutside(box, close, open);
  const chosen = options.find((o) => o.id === value);
  const term = q.trim().toLowerCase();
  // Capped at 50 so a blank search does not paint the whole list; typing narrows it.
  const shown = options
    .filter((o) => !term || `${o.label} ${o.sub || ""}`.toLowerCase().includes(term))
    .slice(0, 50);

  return (
    <div className="relative" ref={box}>
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
          {/* Dismissal is useDismissOnOutside above — pointer and Escape both. There is
              deliberately no click-away <div> here any more: see the note on Field for
              what a viewport-covering div nested in a <label> did to this control. */}
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
  // The same dismissal as SearchOne, rather than the onBlur this used to carry. Blur
  // closed on an outside click well enough, but it also closed on a click INSIDE this
  // control's own caption — and while the caption was a <label> that click bounced
  // straight back to the input and reopened the list. Two controls dismissing two
  // different ways is also how one of them silently regresses.
  const box = useRef(null);
  const close = useCallback(() => { setFocused(false); setQ(""); }, []);
  useDismissOnOutside(box, close, focused);
  const term = q.trim().toLowerCase();
  const chosen = options.filter((o) => value.includes(o.id));
  const shown = options
    .filter((o) => !value.includes(o.id))
    .filter((o) => !term || `${o.label} ${o.sub || ""}`.toLowerCase().includes(term))
    .slice(0, 50);

  return (
    <div className="rounded-lg border border-slate-300" ref={box}>
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
        value={q}
        // setFocused on CHANGE as well as on focus: Escape closes the list while leaving
        // the caret where it is, and without this, typing after that would filter a list
        // nobody could see.
        onChange={(e) => { setQ(e.target.value); setFocused(true); }}
        onFocus={() => setFocused(true)} />
      {/* OPEN WHILE FOCUSED, AND ONLY THAT.
          This was `focused || term`, so the moment anything had been typed the list
          stayed open however you left the box — clicking elsewhere on the page did
          nothing and the only way out was to choose something. That is not a dropdown,
          it is a trap, and it was reported as one. The term clause was never needed:
          options are taken on MOUSEDOWN with preventDefault, so focus survives a pick
          and the list stays open for the next one of its own accord.
          What clears `focused` is useDismissOnOutside, not a blur handler. */}
      {focused && (
        <ul className="max-h-40 overflow-y-auto border-t border-slate-200 py-1">
          {!shown.length && (
            <li className="px-2.5 py-2 text-center text-sm text-slate-400">
              {term ? "Nothing matches." : "Everything here is already chosen."}
            </li>
          )}
          {shown.map((o) => (
            <li key={o.id}>
              {/* onMouseDown with preventDefault keeps the caret in the search box, so
                  the list stays open and a timetabler can add four groups without
                  clicking back into it between each. The dismissal listener ignores
                  this: it is a pointerdown INSIDE the control, not outside it. */}
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
//
// THE LIST IS THE SCREEN, and the picker it replaced was the wrong shape for the job.
//
// A SearchOne showed one group at a time, so "what groups does this college have, and
// which of them is nearly empty" — the question an administrator opens this tab with —
// could only be answered by opening the dropdown and scrolling it. Rename and delete had
// nowhere to live at all: a dropdown row is a value, not a thing with actions on it.
// Every row now carries its own course, its own school and its own headcount, and
// selecting one is what opens the membership editor below.
//
// THE ROWS COME FROM /timetabling/groups, NOT from the store's `cohorts`. The store ships
// sCohort, which carries `courseId` and nothing else, so the course name would have to be
// joined here and the SCHOOL joined twice — cohort → course → department — out of two
// lazily-loaded lists. The endpoint already knows all three, and it is also what counts
// the students: `studentCount` is a database count, where a client-side one would need
// every student row in the college in memory to be right.
//
// Its failure is NOT swallowed, unlike the school list on the calendar tab. There the
// list filled one picker among many and an empty one still left a usable screen; here the
// list IS the screen, and quietly showing "no groups yet" to a college with sixty of them
// would invite somebody to create the sixty-first.
function GroupsTab({ courses = [], students = [], hndLoaded, refreshHnd }) {
  // Courses and students load lazily — the store only fetches them when a page that
  // needs them is opened, and Scheduling was not one of them. Without this an
  // administrator who lands here first finds an empty "Add students" list and concludes
  // the feature is broken rather than unloaded. The GROUPS no longer depend on it (they
  // have their own endpoint), but the student list and the cross-school course check
  // below still do.
  useEffect(() => { if (!hndLoaded && refreshHnd) refreshHnd().catch(() => {}); }, [hndLoaded, refreshHnd]);

  const [groups, setGroups] = useState([]);
  const [listBusy, setListBusy] = useState(true);
  const [groupId, setGroupId] = useState("");
  const [members, setMembers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [gq, setGq] = useState("");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState([]);
  const [making, setMaking] = useState(false);
  const [draft, setDraft] = useState({ schoolId: "", course: "", name: "", startDate: "" });
  const [schools, setSchools] = useState([]);
  // The chosen school's courses, from the server rather than filtered here. The endpoint
  // is the authority on which courses belong to a school, and a second implementation of
  // that join in the browser is one more thing to drift.
  const [schoolCourses, setSchoolCourses] = useState([]);
  const [coursesBusy, setCoursesBusy] = useState(false);
  // Which row is being renamed, and to what. One at a time, exactly as SchoolsTab does
  // it: an inline editor per row all open at once is a form nobody can tell has unsaved
  // changes in it.
  const [editId, setEditId] = useState("");
  const [editName, setEditName] = useState("");
  const [ask, setAsk] = useState(null);

  const loadGroups = useCallback(async () => {
    setListBusy(true);
    try { setGroups(await api.ttGroups()); }
    catch (e) { setErr(e?.message || "Could not load the groups."); }
    finally { setListBusy(false); }
  }, []);
  useEffect(() => { loadGroups(); }, [loadGroups]);

  // The school list fills the first field of the create form and nothing else, so its
  // failure is swallowed the way the calendar tab swallows the same call: an empty
  // School picker is a small fault, and letting it blank the group list would be a large
  // one. The form's own guard — Create stays disabled without a school — is what stops
  // an empty list turning into a group bound to nothing.
  useEffect(() => { api.ttDepartments().then((d) => setSchools(d || [])).catch(() => {}); }, []);

  // The course list follows the school, and a stale response must never land on a newer
  // one. Clicking through three schools quickly issues three requests that can answer in
  // any order, and without the flag the last list shown could belong to the first school
  // clicked — which would offer courses from a school nobody chose.
  useEffect(() => {
    if (!draft.schoolId) { setSchoolCourses([]); return undefined; }
    let cancelled = false;
    setCoursesBusy(true);
    api.ttCourses(draft.schoolId)
      .then((rows) => { if (!cancelled) setSchoolCourses(rows || []); })
      .catch(() => { if (!cancelled) setSchoolCourses([]); })
      .finally(() => { if (!cancelled) setCoursesBusy(false); });
    return () => { cancelled = true; };
  }, [draft.schoolId]);

  const schoolName = (id) => schools.find((s) => s.id === id)?.name || "";

  /** Existing course whose name matches what was typed, ignoring case and edge spaces. */
  const matchCourse = (typed, list) => {
    const want = String(typed || "").trim().toLowerCase();
    return want ? (list || []).find((c) => (c.name || "").trim().toLowerCase() === want) : undefined;
  };

  // THE SCHOOL BINDS THROUGH THE COURSE, AND IS NOT SENT WITH THE GROUP.
  //
  // Cohort.academicDepartmentId is DENORMALISED from the cohort's course — it is a copy
  // kept for querying, not an answer of its own. Posting one alongside the courseId would
  // make the browser a second source of truth for the same fact, and the first time a
  // course moved school every group created through this form would still claim the old
  // one, with nothing on any screen to show which of the two was believed.
  //
  // So the school here NARROWS THE COURSE LIST, and the course is what actually carries
  // it. That is also why the order of the fields is school → course → name and not the
  // other way round: the answer to "which school" is the one a timetabler already has in
  // their head, and it is what makes a list of forty courses a list of six.
  const typedInSchool = matchCourse(draft.course, schoolCourses);
  // A course of that name that belongs somewhere ELSE. Course.name is unique across the
  // whole college, so a name already taken by another school's course cannot be created
  // here — and the failure would otherwise be silent in the worst possible way: addCourse
  // 409s, the recovery below refetches and finds the existing row, and the group binds to
  // a school the form never showed. Caught before the click instead, and named.
  const typedElsewhere = !typedInSchool && draft.schoolId ? matchCourse(draft.course, courses) : undefined;
  const courseHint = !draft.schoolId
    ? "Choose a school first"
    : !draft.course.trim()
      ? (coursesBusy ? "Loading this school's courses…" : `Type it — ${schoolCourses.length} course(s) in this school will suggest themselves`)
      : typedInSchool
        ? `Existing course — the group joins "${typedInSchool.name}"`
        : typedElsewhere
          ? (typedElsewhere.academicDepartmentId
            ? `"${typedElsewhere.name}" belongs to ${schoolName(typedElsewhere.academicDepartmentId) || "another school"}. Choose that school above, or give this course a different name.`
            : `"${typedElsewhere.name}" belongs to no school. Give it one on the Registers page first, or type a different name.`)
          : `New course — created in ${schoolName(draft.schoolId) || "this school"} with the group`;

  /**
   * The course this group will belong to, creating it in the chosen school if the name
   * is a new one.
   *
   * A FREE TEXT BOX RATHER THAN A DROPDOWN, kept from the version before the school
   * existed: most of the time the course is already known to the person typing, and
   * making them hunt for it in a list is slower. The school did not cost that — the
   * existing courses are still offered as browser suggestions (a <datalist>), only now
   * the suggestions are the chosen school's rather than the whole college's.
   *
   * MATCHED CASE-INSENSITIVELY AGAINST WHAT ALREADY EXISTS FIRST, and that is the part
   * that matters. Course.name is unique, but Postgres compares it case-sensitively, so
   * "BSc Software Engineering" and "BSc software engineering" are two courses to the
   * database and one course to everybody else. A free text box makes that easy to do by
   * accident — which is exactly why the box has to resolve to the existing row rather
   * than create beside it. Otherwise a college accumulates three spellings of one
   * programme, each holding its own groups and its own share of the students.
   */
  const resolveCourseId = async () => {
    const wanted = draft.course.trim();
    const existing = matchCourse(wanted, schoolCourses);
    if (existing) return existing.id;
    try {
      // The school is sent HERE, on the course, because this is the row that holds it.
      return (await api.addCourse({ name: wanted, academicDepartmentId: draft.schoolId })).id;
    } catch (e) {
      // Someone else created it between the list loading and this click. Refetch and use
      // theirs rather than failing the group the administrator was actually making — but
      // only if it is in the school they chose. A course of that name in another school
      // is not the course they asked for, and binding the group to it would put the class
      // under a heading nobody on this form ever saw.
      if (!/already exists/i.test(e?.message || "")) throw e;
      const fresh = await api.ttCourses(draft.schoolId).catch(() => []);
      const found = matchCourse(wanted, fresh);
      if (!found) throw new Error(`A course called "${wanted}" already exists in another school. Choose that school above, or give this one a different name.`);
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
      // Both lists have to be refetched: this tab's own, so the new row appears and can
      // be selected, and the store's, because the calendar tab's Groups picker is built
      // from that one and would not otherwise offer the group just created.
      await loadGroups();
      if (refreshHnd) await refreshHnd().catch(() => {});
      setDraft({ schoolId: "", course: "", name: "", startDate: "" });
      setMaking(false);
      setGroupId(made?.id || "");
      setNote(`"${made?.name || draft.name}" created. Add students to it below.`);
    } catch (e) {
      const m = e?.message || "";
      // MATCHED ON THE COHORT'S 409 SPECIFICALLY — `"SEP 25" already exists on this
      // course` — and not on "already exists" alone. Two other things in this one
      // handler can say that: the course clash raised inside resolveCourseId, and the
      // cross-school refusal it throws in its place. Rewording either of those as "a
      // group called … already exists" would name the wrong object entirely and send
      // somebody looking for a group that does not exist. Anything else is shown in the
      // server's own words.
      setErr(
        /already exists on this course/i.test(m) ? `A group called "${draft.name.trim()}" already exists on that course. Names are unique per course.`
        : e?.status === 403 || m.includes("403") ? "You need the Registers page to create a group or a course. You can still add students to an existing group."
        : m || "Could not create the group.",
      );
    }
  };

  const rename = async () => {
    setErr(""); setNote("");
    try {
      await api.ttUpdateGroup(editId, { name: editName.trim() });
      setEditId("");
      await loadGroups();
      // The store holds the old name too, and the event form's Groups picker reads it.
      // Without this a group renamed here keeps its old label on the calendar tab until
      // the page is reloaded, which reads as the rename not having worked.
      if (refreshHnd) await refreshHnd().catch(() => {});
    } catch (e) {
      // THE SERVER'S OWN WORDS. Its 409 names the course the clash is on, which is the
      // half a reader needs: the same intake label on a different course is allowed.
      setErr(e?.message || "Could not rename the group.");
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

  const selected = groups.find((g) => g.id === groupId);

  // The list search covers the COURSE AND THE SCHOOL as well as the name, because the
  // name on its own is an intake label — "SEP 25" — that repeats across every course in
  // the college. Typing "computing" has to be able to find them.
  const gterm = gq.trim().toLowerCase();
  const shownGroups = groups.filter((g) => !gterm || `${g.name || ""} ${g.courseName || ""} ${g.schoolName || ""}`.toLowerCase().includes(gterm));

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
      // The headcounts on the rows above have just changed — for the group added to and
      // for whichever groups the movers came out of. Refetching the list is what keeps
      // the number beside a group from being a figure that was true when the tab opened.
      loadGroups();
    } catch (e) {
      setErr(e?.message?.includes("403") || e?.status === 403
        ? "You need the Students page to move students between groups — it changes which department can see them."
        : (e?.message || "Could not add those students."));
    }
  };

  const removeOne = async (s) => {
    setErr(""); setNote("");
    try { await api.ttRemoveFromGroup(groupId, [s.id]); load(groupId); loadGroups(); }
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
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[220px] flex-1">
            <Field label="Find a group" hint="Name, course or school">
              <div className="relative">
                <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input className={`${inputCls} pl-8`} value={gq} onChange={(e) => setGq(e.target.value)} placeholder="SEP 25, Computing…" />
              </div>
            </Field>
          </div>
          <button onClick={() => { setMaking((v) => !v); setErr(""); setNote(""); }}
            className="flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">
            {making ? <><X size={15} /> Cancel</> : <><Plus size={15} /> New group</>}
          </button>
        </div>

        {making && (
          <div className="mt-3 grid gap-2 border-t border-slate-200 pt-3 sm:grid-cols-4">
            {/* THE SCHOOL IS THE FIRST FIELD, and it is the one that makes the rest of
                the form short. It is asked before the course because it is what narrows
                the course list — a college running forty programmes across six schools
                offers six once the school is known. */}
            <Field label="School" hint="Pick this first — it narrows the courses">
              <SearchOne value={draft.schoolId} allowNone={false}
                placeholder={schools.length ? "Choose a school…" : "No schools yet — add one on the Schools tab"}
                options={schools.filter((d) => d.active !== false).map((d) => ({ id: d.id, label: d.name }))}
                onChange={(id) => setDraft({ ...draft, schoolId: id, course: "" })} />
            </Field>
            <Field label="Course" hint={courseHint}>
              {/* A plain text box, with the CHOSEN SCHOOL's courses offered as browser
                  suggestions. Typing an existing one reuses that course; anything new is
                  created in that school with the group. The school reaches the group
                  through this row and only through it. */}
              <input className={inputCls} list="tt-course-options" value={draft.course}
                disabled={!draft.schoolId}
                onChange={(e) => setDraft({ ...draft, course: e.target.value })}
                placeholder="BSc Software Engineering" />
              <datalist id="tt-course-options">
                {schoolCourses.map((c) => <option key={c.id} value={c.name} />)}
              </datalist>
            </Field>
            <Field label="Group name" hint="The intake, e.g. SEP 25">
              <input className={inputCls} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="SEP 25" />
            </Field>
            <Field label="Starts" hint="Optional">
              <input type="date" className={inputCls} value={draft.startDate} onChange={(e) => setDraft({ ...draft, startDate: e.target.value })} />
            </Field>
            <div className="flex items-end sm:col-span-4">
              {/* All three are required, and for three different reasons: the school
                  because it is what the course is created in, the course because
                  Cohort.courseId is NOT NULL, and the name because it is what anybody
                  picking this group will read. A name that belongs to another school's
                  course blocks it too — see typedElsewhere above; letting that through
                  would bind the group to a school this form never showed. */}
              <button onClick={createGroup}
                disabled={!draft.schoolId || !draft.name.trim() || !draft.course.trim() || !!typedElsewhere}
                className="flex items-center justify-center gap-1 rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-40" style={{ background: NAVY }}>
                <Check size={15} /> Create group
              </button>
            </div>
          </div>
        )}
      </div>

      {/* THE LIST. Selecting a row is what opens the membership editor below it, so the
          selected row is drawn as selected rather than merely remembered — with the
          editor two screens down on a laptop, an administrator who has scrolled has no
          other way to tell which group they are editing. */}
      {listBusy ? <div className="flex justify-center py-10 text-slate-400"><Loader2 className="animate-spin" size={20} /></div> : (
        <ul className="mb-4 divide-y divide-slate-100 overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
          {!groups.length && <li className="px-3 py-8 text-center text-sm text-slate-400">No groups yet. Create the first one above.</li>}
          {!!groups.length && !shownGroups.length && <li className="px-3 py-8 text-center text-sm text-slate-400">No group matches “{gq.trim()}”.</li>}
          {shownGroups.map((g) => (
            <li key={g.id} className={`flex flex-wrap items-center gap-2 px-3 py-2 ${g.id === groupId ? "bg-slate-50" : ""}`}
              style={g.id === groupId ? { boxShadow: `inset 3px 0 0 ${NAVY}` } : undefined}>
              {editId === g.id ? (
                <div className="flex flex-1 items-center gap-1">
                  <input autoFocus className={inputCls} value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && editName.trim()) rename(); if (e.key === "Escape") setEditId(""); }} />
                  <button onClick={rename} disabled={!editName.trim()} aria-label="Save name"
                    className="rounded p-1.5 text-emerald-600 hover:bg-emerald-50 disabled:opacity-40"><Check size={15} /></button>
                  <button onClick={() => setEditId("")} aria-label="Cancel rename"
                    className="rounded p-1.5 text-slate-400 hover:bg-slate-100"><X size={15} /></button>
                </div>
              ) : (
                <>
                  {/* The whole row is the selector, not a "Select" button beside the
                      others: the row IS the group, and a button would be a third thing
                      to aim at next to Rename and Delete — the two that are not
                      reversible. */}
                  <button type="button" onClick={() => { setGroupId(g.id); setPicked([]); setNote(""); setErr(""); }}
                    className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm font-bold text-slate-700">{g.name}</span>
                    {/* THE COURSE AND THE SCHOOL, UNDERNEATH. "SEP 25" is an intake label
                        that repeats across every course in the college, so the line below
                        it is what makes the row identify one group rather than twelve.
                        A missing school prints as "No school" rather than as nothing —
                        a group whose course has no school is only visible to
                        college-wide accounts, and a blank would read as an ordinary row. */}
                    <span className="block truncate text-xs text-slate-400">
                      {g.courseName || "No course"} · {g.schoolName || "No school"}
                    </span>
                  </button>
                  {/* ZERO IS A REAL ANSWER AND IS PRINTED AS 0 — an empty group is the
                      thing an administrator comes to this screen looking for, and hiding
                      it behind an em dash would hide exactly that. A MISSING count is a
                      different fact and gets the dash instead, the way the rooms table
                      prints an unrecorded capacity: sGroup emits `studentCount` as null
                      when the count is absent, and rendering that as "students" with a
                      blank in front of it would read as zero for a group that may be
                      full. */}
                  <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-500">
                    {g.studentCount == null ? "—" : `${g.studentCount} student${g.studentCount === 1 ? "" : "s"}`}
                  </span>
                  <button onClick={() => { setEditId(g.id); setEditName(g.name); setErr(""); setNote(""); }} aria-label={`Rename ${g.name}`}
                    className="shrink-0 rounded px-2 py-1 text-xs font-bold text-slate-500 hover:bg-slate-100">Rename</button>
                  <button onClick={() => setAsk(g)} aria-label={`Delete ${g.name}`}
                    className="shrink-0 rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 size={15} /></button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {!groupId ? (
        <p className="py-8 text-center text-sm text-slate-400">
          {groups.length ? "Choose a group above to see and edit who is in it." : "Create your first group above, then pick students for it."}
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
            <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">
              In {selected ? `“${selected.name}”` : "this group"} ({members.length})
            </h4>
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

      {/* ConfirmDialog RATHER THAN window.confirm, for the same reason the calendar tab
          stopped using it: a native dialog announces itself as "…vercel.app says", which
          is the chrome a phishing page produces and the prompt a careful person has been
          taught to dismiss unread. It also cannot be dismissed by Android's back button,
          which useBackHandler gives this one.

          THE WORDING PROMISES NOTHING ABOUT WHETHER IT WILL WORK. The server refuses a
          group that still has students, and it is the one that knows how many — so the
          dialog says what deleting an EMPTY group does, and the refusal, when it comes,
          is shown in the server's own words. Guessing the count here from `studentCount`
          would be a second answer to the same question, computed from a list that was
          fetched at some earlier moment. */}
      <ConfirmDialog
        open={!!ask}
        title="Delete this group?"
        message={`“${ask?.name || ""}” will be removed. A group that still has students in it cannot be deleted — take them out first, or move them to another group.`}
        confirmLabel="Delete" cancelLabel="Keep it" danger
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          const g = ask;
          setAsk(null); setErr(""); setNote("");
          try {
            await api.ttDeleteGroup(g.id);
            // Clearing the selection FIRST, because the membership editor below is
            // keyed on it: leaving it set would fire a fetch for a group that no
            // longer exists and report the 404 as though the delete had failed.
            if (groupId === g.id) { setGroupId(""); setMembers([]); }
            setNote(`“${g.name}” was deleted.`);
            await loadGroups();
            // The store still lists it, and the event form's Groups picker reads the
            // store — a deleted group left in that picker is one somebody can still
            // attach a class to.
            if (refreshHnd) await refreshHnd().catch(() => {});
          } catch (e) {
            // THE SERVER'S OWN WORDS, VERBATIM. Its 409 names how many students would
            // have been detached, and that number is the whole content of the refusal:
            // "could not delete" sends somebody looking for a fault, where "12 students
            // are still in it" tells them what to do next.
            setErr(e?.message || "Could not delete the group.");
          }
        }}
      />
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
  // EVENTS SITS BESIDE CALENDAR, second, because it answers the question the calendar
  // cannot: "how many classes have I created, and what are they". A grid is read a week
  // at a time, so counting a term in it means paging fourteen times and adding up — and
  // a class scheduled outside the window somebody happens to be looking at is, from the
  // grid alone, indistinguishable from a class that was never created. The two are the
  // same data seen at two altitudes, which is why they are adjacent rather than at
  // opposite ends of the row.
  const TABS = [["calendar", "Calendar", CalendarDays], ["events", "Events", List], ["groups", "Groups", Users], ["schools", "Schools", GraduationCap], ["rooms", "Rooms", DoorOpen], ["campuses", "Campuses", Building2], ["categories", "Categories", Tag]];
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
      {tab === "calendar" && <PlannerCalendarTab mode="calendar" staff={store?.staff || []} units={store?.units || []} cohorts={store?.cohorts || []} courses={store?.courses || []} hndLoaded={store?.hndLoaded} refreshHnd={store?.refreshHnd} />}
      {/* THE SAME COMPONENT, NOT A SECOND ONE, and that is the whole design of this tab.
          Clicking a row has to open the event editor — the single-event form with its
          school, module, room, staff and group pickers, its clash warnings, its delete
          and its Repeat weekly. That editor is four hundred lines of state living inside
          PlannerCalendarTab, and a list that rendered its own copy would be a second
          editor: two forms against one endpoint, drifting the first time a field is
          added to one of them. Passing a mode instead swaps only what the BODY draws —
          a grid or a list — and leaves every piece of editing behaviour identical by
          construction, because it is the same code running. */}
      {tab === "events" && <PlannerCalendarTab mode="events" staff={store?.staff || []} units={store?.units || []} cohorts={store?.cohorts || []} courses={store?.courses || []} hndLoaded={store?.hndLoaded} refreshHnd={store?.refreshHnd} />}
      {/* No `cohorts` here on purpose: the Groups tab reads its list from
          /timetabling/groups, which already carries each group's course, school and
          headcount. Passing the store's copy beside it would give the tab two answers to
          "what groups are there" and no rule for which one wins. */}
      {tab === "groups" && <GroupsTab courses={store?.courses || []} students={store?.students || []} hndLoaded={store?.hndLoaded} refreshHnd={store?.refreshHnd} />}
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

function PlannerCalendarTab({ mode = "calendar", staff = [], units = [], cohorts = [], courses = [], hndLoaded, refreshHnd }) {
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
        // THE WINDOW READ IS SKIPPED ON THE EVENTS TAB. That call answers "what is in
        // this week", which is a question the list is not asking — it has its own,
        // unwindowed read below. Leaving it in would fetch a week nobody is looking at
        // on every mount and on every anchor change, and worse, would leave `events`
        // holding a plausible-looking array that no longer has anything to do with what
        // the screen is showing. The other four ARE still needed: rooms, categories and
        // schools fill the edit modal's pickers, and the modal is shared.
        mode === "events" ? Promise.resolve([]) : api.ttEvents({ from, to }),
        api.ttSettings(), api.ttRooms(), api.ttCategories(),
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
  }, [from, to, mode]);
  useEffect(() => { load(); }, [load]);

  /* ------------------------------------------------------------ the LIST -- */
  //
  // Everything below this point to the next rule is the Events tab's own state. It sits
  // in this component rather than in one of its own because the tab's whole purpose is
  // to open the editor that lives here — see the comment at the call site.

  const [listQ, setListQ] = useState("");
  // The search box is DEBOUNCED into a second piece of state, and the request is keyed
  // off that one. Typing "Contract Law" is eleven keystrokes; without this it is eleven
  // requests, each one counting the table, and the answers race — the reply to "Contr"
  // can land after the reply to "Contract" and repaint the list with the wrong rows.
  // 300ms is long enough to swallow a burst of typing and short enough that nobody
  // notices they are waiting.
  const [listQApplied, setListQApplied] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setListQApplied(listQ), 300);
    return () => clearTimeout(t);
  }, [listQ]);

  const [listSchool, setListSchool] = useState("");
  const [listPublished, setListPublished] = useState("");
  const [listFrom, setListFrom] = useState("");
  const [listTo, setListTo] = useState("");
  const [list, setList] = useState(null);
  const [listBusy, setListBusy] = useState(false);
  const [listErr, setListErr] = useState("");

  // THE INSTITUTION'S TOTAL, HELD SEPARATELY FROM THE FILTERED ONE.
  //
  // "14 of 842" needs two numbers and only one of them comes back with the rows. Keeping
  // the second in its own slot — rather than remembering the last unfiltered response —
  // is what stops the denominator going stale: filter, then create three classes, and a
  // remembered 842 would keep being printed beside a filtered count that had moved. It
  // is refreshed on mount (the first read is unfiltered, so it costs nothing) and again
  // after anything that writes.
  //
  // Null, not 0, until it is known. Zero is a real and important answer here — a college
  // that has created nothing — and the empty state below says something quite different
  // for it than for "we have not counted yet".
  const [allTotal, setAllTotal] = useState(null);

  const listFiltered = !!(listQApplied.trim() || listSchool || listPublished || listFrom || listTo);

  const loadList = useCallback(async () => {
    setListBusy(true); setListErr("");
    try {
      const r = await api.ttEventList({
        q: listQApplied.trim(), academicDepartmentId: listSchool,
        published: listPublished, from: listFrom, to: listTo,
      });
      setList(r);
      // Only when nothing was narrowing it. A filtered total is not the college's total,
      // and writing it here would make "14 of 14" out of "14 of 842".
      if (!listFiltered) setAllTotal(r.total);
    } catch (e) { setListErr(e?.message || "Could not load the events."); }
    finally { setListBusy(false); }
  }, [listQApplied, listSchool, listPublished, listFrom, listTo, listFiltered]);

  useEffect(() => { if (mode === "events") loadList(); }, [mode, loadList]);

  /** The unfiltered count on its own, for when the list on screen is a narrowed one. */
  const loadAllTotal = useCallback(async () => {
    // Swallowed. This number decorates a count line; a failed decoration must not put an
    // error banner over a list that loaded perfectly well.
    try { const r = await api.ttEventList({}); setAllTotal(r.total); } catch { /* ignore */ }
  }, []);

  /**
   * Reload whatever this tab is actually showing, after something has been written.
   *
   * The calendar's `load()` is still called in both modes — it is what refreshes the
   * rooms, categories and schools the editor's pickers are built from, and on the
   * calendar it is what redraws the grid. On the Events tab the list is the thing that
   * has to move, and the unfiltered total with it: creating a class while filtered to
   * one school changes the college's total without changing the filtered count, and a
   * denominator that only updated when the filter was cleared would be wrong for as long
   * as somebody kept working.
   */
  const refresh = useCallback(() => {
    load();
    if (mode === "events") { loadList(); if (listFiltered) loadAllTotal(); }
  }, [load, loadList, loadAllTotal, mode, listFiltered]);

  /**
   * The rows, cut into one bucket per date.
   *
   * GROUPED IN THE BROWSER OFF AN ALREADY-SORTED ARRAY, not with a second query and not
   * with a sort of its own. The server returns the rows date-descending and, within a
   * date, ascending by start time; walking that list and starting a new bucket whenever
   * the date changes preserves both orders exactly, so the screen cannot disagree with
   * the endpoint about what order these are in. A `reduce` into an object would not:
   * object key order for non-numeric keys is insertion order, which happens to work here
   * and stops working the day somebody sorts the keys "to be safe".
   *
   * The point of it is that 200 rows in one undivided table is a wall. A date heading
   * every few rows is what makes it a timetable rather than a database dump, and it is
   * also the only thing that shows a gap — three classes on Monday and none until Friday
   * is a fact about the term that a flat list hides completely.
   */
  const listByDate = useMemo(() => {
    const out = [];
    for (const e of list?.events || []) {
      if (!out.length || out[out.length - 1].date !== e.date) out.push({ date: e.date, events: [] });
      out[out.length - 1].events.push(e);
    }
    return out;
  }, [list]);

  // Retired schools INCLUDED, unlike the picker inside the editor. A school switched off
  // on the Schools tab still has last term's classes filed under it, and a filter that
  // could not name it would make those classes findable only by scrolling — which is the
  // opposite of what this tab is for. Choosing a value for a NEW event is a different
  // act, and that picker is right to hide the retired ones.
  const schoolOptions = depts.map((d) => ({ id: d.id, label: d.name, sub: d.active === false ? "retired" : "" }));
  const schoolName = (id) => depts.find((d) => d.id === id)?.name || null;

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
  // Given a date and a pair of times, the form opens already describing the slot the
  // pointer landed on. Without arguments it is the old New-event behaviour exactly.
  const blank = (date, start, end) => {
    const b = blankBlock(date || anchor);
    if (start && end) b.sessions = [{ start, end }, b.sessions[1]];
    return {
      academicDepartmentId: "", showAllSchools: false,
      cohortIds: [], notes: "", published: false,
      blocks: [b],
    };
  };

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

  /* ------------------------------------- and then the GROUPS narrow further -- */
  //
  // ONCE THE GROUPS ARE CHOSEN, THE MODULE LIST IS THEIR COURSES' MODULES.
  //
  // A school is a coarse answer — "Computing" is six programmes and two hundred units —
  // and the groups are the fine one: the second-year Software Engineering lot are taught
  // the units on Software Engineering, and every other unit in the school is noise the
  // timetabler has to read past. Cohort.courseId and Unit.courseId are both already in
  // the browser (sCohort and sUnit each ship it), so this is one join in memory rather
  // than an endpoint.
  //
  // MODULES AND NOTHING ELSE. Rooms, categories and staff are deliberately untouched:
  // any room can hold any class, and a lecturer's departments only reach the browser when
  // the query asks for the relation — filtering staff on what sStaff ships would silently
  // hide everybody, and lecturers routinely teach across courses anyway. The Groups
  // picker is obviously not narrowed by its own value either.
  //
  // MULTIPLE GROUPS UNION, they do not intersect. Two groups on two courses being taught
  // one class together is a real thing — a shared induction, a joint lecture — and an
  // intersection would offer nothing at all for exactly that case.
  const chosenCohortIds = (!editing?.id && !editing?.showAllSchools && editing?.cohortIds) || [];
  const groupCourseIds = chosenCohortIds.length
    ? new Set(cohorts.filter((c) => chosenCohortIds.includes(c.id)).map((c) => c.courseId).filter(Boolean))
    : null;
  const groupNarrowing = !!groupCourseIds?.size;

  /**
   * The module list: narrowed by the school, then by the chosen groups' courses.
   *
   * `chosenIds` SURVIVES BOTH FILTERS, and that is the same rule `narrow` above exists
   * to keep — applied a second time because a second filter is a second chance to break
   * it. Pick a module, then add a group from another course, and without this SearchOne
   * would find no option matching the id it holds and quietly render "No module" while
   * still sending one. The value and what the screen says about it must not be able to
   * disagree.
   */
  const narrowUnits = (rows, chosenIds = []) => {
    const bySchool = narrow(rows, chosenIds);
    return groupNarrowing
      ? bySchool.filter((u) => groupCourseIds.has(u.courseId) || chosenIds.includes(u.id))
      : bySchool;
  };

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

  // WHAT THE SAVE BUTTON IS DOING RIGHT NOW, or null when it is doing nothing.
  //
  // A string rather than a boolean, because the two save paths take very different
  // lengths of time and the honest label differs between them. An edit is one request.
  // A create is one request PER MODULE BLOCK, each of which expands a start date, an end
  // date and a set of weekdays into a whole term server-side — seconds, not milliseconds,
  // and the button gave no sign of it. An administrator watching an unchanged "Save"
  // reasonably concludes nothing happened.
  //
  // The disable is the load-bearing half rather than the spinner. save() has no
  // idempotency key and the server writes a series row by row with no unique constraint
  // to collide against, so a second press during the first one writes a SECOND complete
  // term and doubles the attendance denominator of every student in it. The code below
  // already warns about that in prose after a timeout; this stops the ordinary case,
  // which is somebody clicking again because the screen looked dead.
  const [saving, setSaving] = useState(null);

  const save = async () => {
    // A GUARD, NOT AN ASSERTION. The button is disabled while `saving` is set, so this
    // should be unreachable — but "should be" is doing the same work here as a unique
    // constraint would, and there is no unique constraint. Enter is a submit path too.
    if (saving) return;
    setErr(""); setNote(""); setWarnings([]);

    // EDITING KEEPS THE OLD SINGLE-EVENT PATH, untouched. Changing one occurrence must
    // never silently generate a term, so an edit sends one body and gets one event back.
    if (editing.id) {
      setSaving("Saving…");
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
        refresh();
      } catch (e) { setErr(e?.message || "Could not save the event."); }
      // finally, not a line after the catch: an early return or a throw from setWarnings
      // would otherwise leave the button spinning for ever with no way back.
      finally { setSaving(null); }
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
    let madeRegisters = 0;
    const registerSkips = new Map();   // reason -> how many events gave it
    const total = editing.blocks.length;

    try {
    for (const [i, b] of editing.blocks.entries()) {
      // COUNTED IN MODULES, WHICH IS WHAT THE LOOP ACTUALLY ITERATES. The tempting label
      // is a class count, but the classes for a block are expanded server-side inside the
      // one request — the client cannot see them arrive and a bar that moved in class
      // units would be inventing the positions between blocks. One module is one request
      // is one step, and a step that only ever advances when something really finished is
      // worth more than a smoother lie.
      setSaving(total > 1 ? `Creating module ${i + 1} of ${total}…` : "Creating classes…");
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
        madeRegisters += r.registers?.created || 0;
        // A SKIP IS THE INTERESTING HALF and is kept per reason rather than counted.
        // "18 classes, 0 registers" is the report that sends somebody hunting; "18
        // classes, no registers — these have no module" is one they can act on.
        for (const s of r.registers?.skipped || []) {
          registerSkips.set(s.reason, (registerSkips.get(s.reason) || 0) + (s.events || 1));
        }
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
    } finally { setSaving(null); }

    setWarnings(madeWarnings);

    if (!failures.length) {
      const expected = previewTotals.classes;
      setNote(
        `${created} class(es) created across ${editing.blocks.length} module(s).`
        // SAVING NOW WRITES THE REGISTERS TOO, so this reports what was actually built
        // rather than instructing the reader to go and do it themselves. It used to say
        // "Publish these dates to create the N register(s)" — true at the time, because
        // syncEventRegisters ran only on publish and on edit, but a workflow held
        // together by a sentence in a toast. Somebody who missed it had a term of
        // classes with no attendance behind them and nothing on screen saying why.
        //
        // The server's number, not the preview's: this one is a count of rows written.
        + (madeRegisters ? ` ${madeRegisters} register(s) created.` : "")
        // WHY NONE, when the preview expected some. A bare "0 registers" is what sends
        // somebody hunting through settings; the reason is almost always mundane and
        // fixable — no module on the class, or a sheet already marked.
        + (!madeRegisters && registerSkips.size
          ? ` No registers: ${[...registerSkips.entries()].map(([reason, n]) => `${reason} (${n})`).join("; ")}`
          : "")
        // Said ONLY when the two disagree. The preview is computed from the same dates and
        // the same bank holidays the server uses, so a mismatch means one of them is
        // wrong — most likely a server that does not expand two sessions yet — and
        // quietly printing the server's number instead would hide exactly that.
        + (expected && created !== expected ? ` (${expected} were expected — check the calendar.)` : ""),
      );
      setEditing(null);
      refresh();
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
      refresh();
    }
  };

  return (
    <div>
      {mode === "calendar" && (
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
      )}

      {/* ------------------------------------------------- the EVENTS tab head --
          NO DATE ARROWS AND NO "PUBLISH THIS PERIOD" HERE, and both omissions are
          deliberate. The arrows move a window this list does not have. Publish acts on
          the window between `from` and `to` — the calendar's window, which on this tab
          is whatever the anchor happens to be rather than anything on screen — so the
          button would publish a fortnight nobody was looking at, which is the single
          most destructive thing on the screen doing something other than what it says. */}
      {mode === "events" && (
        <div className="mb-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[200px] flex-1">
              <Field label="Search">
                <div className="relative">
                  <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input className={`${inputCls} pl-8`} value={listQ} onChange={(e) => setListQ(e.target.value)}
                    placeholder="Title, module code or module name" />
                </div>
              </Field>
            </div>
            <div className="min-w-[170px]">
              {/* THE SAME SearchOne the editor uses, so "which school" is asked the same
                  way in both places. A college with forty schools makes a <select> a
                  scroll; the picker types. */}
              <Field label="School">
                <SearchOne value={listSchool} options={[{ id: "none", label: "No school", sub: "shown to everyone" }, ...schoolOptions]}
                  onChange={setListSchool} placeholder="Any school" noneLabel="Any school" />
              </Field>
            </div>
            <div className="min-w-[130px]">
              <Field label="Status">
                {/* Three states, and "Any" is the default on purpose: an administrator
                    building next term is working in drafts, and a list that quietly
                    showed only published classes would report a smaller number than the
                    college has with nothing on screen to explain the difference. */}
                <select className={inputCls} value={listPublished} onChange={(e) => setListPublished(e.target.value)}>
                  <option value="">Any</option>
                  <option value="true">Published</option>
                  <option value="false">Draft</option>
                </select>
              </Field>
            </div>
            <div className="min-w-[140px]">
              <Field label="From"><input type="date" className={inputCls} value={listFrom} onChange={(e) => setListFrom(e.target.value)} /></Field>
            </div>
            <div className="min-w-[140px]">
              {/* EACH END STANDS ALONE. "From September, no end" is how somebody looks at
                  the term they have just built, and demanding a closing date to express
                  it would put an invented value into the filter. */}
              <Field label="To"><input type="date" className={inputCls} value={listTo} onChange={(e) => setListTo(e.target.value)} /></Field>
            </div>
            {listFiltered && (
              <button onClick={() => { setListQ(""); setListSchool(""); setListPublished(""); setListFrom(""); setListTo(""); }}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50">Clear filters</button>
            )}
            <button onClick={() => setEditing(blank())} className="ml-auto flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold text-white" style={{ background: NAVY }}><Plus size={14} /> New event</button>
          </div>

          {/* THE COUNT, WHICH IS THE QUESTION THIS TAB WAS BUILT TO ANSWER.
              `total` is counted by the server BEFORE the page limit, so this is the
              number of classes that exist and not the number that were sent — the two
              differ by 642 at this college's current size, and printing the second would
              be the exact failure the endpoint's own comments describe.
              "N of M" only when something is narrowing it, because "842 of 842" reads as
              though a filter were applied and invites somebody to go looking for it. */}
          <div className="mt-2 flex flex-wrap items-baseline gap-2">
            <p className="text-sm font-extrabold text-slate-700">
              {listBusy && !list ? "Counting…" : (
                <>
                  {list?.total ?? 0} class{(list?.total ?? 0) === 1 ? "" : "es"}
                  {listFiltered && allTotal !== null && allTotal !== list?.total
                    ? <span className="font-semibold text-slate-500"> of {allTotal}</span> : null}
                </>
              )}
            </p>
            {/* SAID OUT LOUD, because a silent cap reads as "that is all of them" — which
                is a wrong answer to the only question on the screen. It names both
                numbers and what to do about it, rather than a bare "showing 200". */}
            {list?.truncated && (
              <p className="text-xs font-semibold text-amber-700">
                Showing the {list.limit} most recent. Narrow the dates or the search to see the other {list.total - list.limit}.
              </p>
            )}
          </div>
        </div>
      )}

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

      {mode === "events" && (
        listErr ? (
          <div className="flex items-center gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700 ring-1 ring-rose-200"><AlertTriangle size={15} /> {listErr}</div>
        ) : listBusy && !list ? (
          <div className="flex justify-center py-16 text-slate-400"><Loader2 className="animate-spin" size={20} /></div>
        ) : !listByDate.length ? (
          /* TWO EMPTY STATES, NOT ONE, AND THE DIFFERENCE IS THE WHOLE POINT.
             "Nothing here" in front of a college with 842 classes and a date filter set
             to last August is a screen telling somebody their term was not saved. The
             two are told apart by `allTotal`, which is the institution's count and is
             deliberately not the filtered one; the second offers the way out, because a
             filter somebody cannot see is a filter they cannot clear. */
          <div className="rounded-2xl border border-dashed border-slate-200 py-14 text-center">
            <p className="text-sm font-bold text-slate-500">
              {allTotal === 0 ? "No classes have been created yet." : "No classes match these filters."}
            </p>
            <p className="mt-1 text-xs text-slate-400">
              {allTotal === 0
                ? "Press New event to schedule the first one, or draw one on the Calendar tab."
                : `The college has ${allTotal ?? "some"} class${allTotal === 1 ? "" : "es"} in total.`}
            </p>
            {allTotal !== 0 && listFiltered && (
              <button onClick={() => { setListQ(""); setListSchool(""); setListPublished(""); setListFrom(""); setListTo(""); }}
                className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50">Clear filters</button>
            )}
          </div>
        ) : (
          <div className={`space-y-4 ${listBusy ? "opacity-60" : ""}`}>
            {listByDate.map((day) => (
              <div key={day.date}>
                {/* The heading carries the day's OWN count as well as the date. With 200
                    rows on screen "how many classes are on the Thursday" is a question
                    the reader would otherwise answer by counting rows. */}
                <div className="mb-1 flex items-baseline gap-2 border-b border-slate-200 pb-1">
                  <p className="text-sm font-extrabold text-slate-700">{dateHeading(day.date)}</p>
                  <p className="text-xs font-semibold text-slate-400">{day.events.length} class{day.events.length === 1 ? "" : "es"}</p>
                </div>
                <ul>
                  {day.events.map((e) => (
                    <li key={e.id}>
                      {/* A BUTTON, NOT A DIV WITH AN onClick. The row opens an editor, so
                          it has to be reachable by keyboard and announced as something
                          that can be pressed; a clickable div is neither.

                          EXACTLY THE SHAPE THE CALENDAR PASSES, character for character —
                          the event, plus staffIds and cohortIds flattened out of the
                          `staff` and `groups` arrays the server sends. The editor reads
                          those two id arrays and nothing else for its pickers, and a row
                          that opened the modal without them would present a class with no
                          lecturer and no group and then SAVE that back over the real
                          ones. Copied from onSelectEvent below rather than re-derived,
                          because there is only one correct answer and two places writing
                          it independently is how they come to differ. */}
                      <button type="button"
                        onClick={() => setEditing({ ...e, staffIds: (e.staff || []).map((x) => x.id), cohortIds: (e.groups || []).map((g) => g.id) })}
                        className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-slate-50">
                        {/* The category's own colour, as a bar down the left. The grid
                            already colours by it, so a list that ignored it would be the
                            same classes wearing different clothes. Slate when the class
                            has no category, rather than nothing at all — an absent bar
                            would make the rows below it hang half an inch to the left. */}
                        <span className="h-8 w-1 shrink-0 rounded-full" style={{ background: e.categoryColour || "#cbd5e1" }} />
                        <span className="w-[104px] shrink-0 text-xs font-bold tabular-nums text-slate-600">{e.start}–{e.end}</span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-sm font-bold text-slate-800">{e.title}</span>
                            {/* DRAFT IS BADGED; PUBLISHED IS NOT. Badging both would put a
                                chip on every row and train the eye past it, and it is
                                being invisible to staff that is the exceptional state
                                worth pointing at. */}
                            {!e.published && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-amber-700">Draft</span>}
                          </span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
                            {/* Each fact is DROPPED when it is absent rather than printed
                                as an empty column or a dash. A class with no room is a
                                real and ordinary thing — an online session, a trip — and
                                a row of dashes reads as missing data to chase. */}
                            {e.unitCode && <span className="font-semibold text-slate-600">{e.unitCode}{e.unitName ? ` ${e.unitName}` : ""}</span>}
                            {e.room && <span>{e.room}</span>}
                            {!!(e.groups || []).length && <span>{e.groups.map((g) => g.name).join(", ")}</span>}
                            {!!(e.staff || []).length && <span>{e.staff.map((x) => x.name).join(", ")}</span>}
                            {/* The SCHOOL, resolved from the id against the list this tab
                                already holds — sEvent ships the id only, on purpose, so
                                that a name is not repeated several hundred times per
                                response. An id the list cannot resolve prints nothing
                                rather than the raw cuid, which would be noise. */}
                            {schoolName(e.academicDepartmentId) && <span className="text-slate-400">{schoolName(e.academicDepartmentId)}</span>}
                            {/* Only that it IS one of a set. The id itself is a uuid and
                                means nothing to a reader; that this Tuesday is part of a
                                term rather than a one-off is what changes what they do
                                next. */}
                            {e.seriesId && <span className="text-slate-400">· part of a series</span>}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )
      )}

      {mode === "calendar" && (busy && !settings ? (
        <div className="flex justify-center py-16 text-slate-400"><Loader2 className="animate-spin" size={20} /></div>
      ) : (
        <TimetableCalendar events={events} settings={settings} view={view} anchor={anchor} today={today}
          onSelectEvent={(e) => setEditing({ ...e, staffIds: (e.staff || []).map((s) => s.id), cohortIds: (e.groups || []).map((g) => g.id) })}
          // Press or drag empty space to open the form for exactly that slot. This is
          // the interaction the grid was missing: previously the only way to add a
          // class was to leave the calendar, press New event, and retype the date and
          // time you had just been pointing at.
          onCreateAt={(date, start, end) => setEditing(blank(date, start, end))}
          selectedId={editing?.id} />
      ))}

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
              {/* Same reason as Cancel below: this is the other way out of the modal, and
                  leaving it live would make the lock on Cancel decorative. */}
              <button onClick={() => setEditing(null)} disabled={!!saving} aria-label="Close"
                className="rounded-full p-1.5 hover:bg-white/20 disabled:opacity-40 disabled:hover:bg-transparent"><X size={18} /></button>
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
                        chose is a record; a workaround is not.

                        IT ESCAPES THE GROUP FILTER TOO, not only the school one, and the
                        label says both. The chosen groups narrow the module list to their
                        own courses, so that maths unit would be just as unreachable
                        through the second half — an escape that only lifted the school
                        would leave the same trap standing behind it, and a checkbox that
                        lifts more than its label admits is worse than one lifting less. */}
                    <label className="mt-1.5 flex items-center gap-2 text-xs font-semibold text-slate-500">
                      <input type="checkbox" checked={!!editing.showAllSchools}
                        onChange={(e) => setEditing({ ...editing, showAllSchools: e.target.checked })}
                        className="h-3.5 w-3.5 rounded border-slate-300" />
                      Show every school and module — for a class shared between two
                    </label>
                  </div>
                  <Field label="Groups" hint="Chosen once; every module below is taught to these groups, narrowed to their courses, and each gets its own register">
                    <SearchMany value={editing.cohortIds || []} placeholder="Search groups…"
                      options={narrow(cohorts, editing.cohortIds || []).map((c) => ({ id: c.id, label: cohortLabel(c) }))}
                      onChange={(v) => setEditing({ ...editing, cohortIds: v })} />
                    {narrowing && !narrow(cohorts, editing.cohortIds || []).length && (
                      <span className="mt-1 block text-[11px] font-semibold text-amber-700">No groups belong to that school. Tick “Show every school and module” to see the rest.</span>
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
                  const unitOpts = narrowUnits(units, b.unitId ? [b.unitId] : []);
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
                        {/* The hint NAMES WHICH FILTER IS ACTIVE, because with two of
                            them a shortened list is otherwise an unexplained one: a
                            timetabler who cannot find a unit needs to know whether it is
                            the school or the groups that dropped it, since those are two
                            different things to change. */}
                        <Field label="Module" hint={groupNarrowing
                          ? "Narrowed to the courses the groups above are on"
                          : narrowing ? "Narrowed to the school above" : "Optional — exams and meetings have none"}>
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
                          {(narrowing || groupNarrowing) && !unitOpts.length && (
                            <span className="mt-1 block text-[11px] font-semibold text-amber-700">
                              {groupNarrowing
                                ? "No modules belong to those groups’ courses. Tick “Show every school and module” to see the rest."
                                : "No modules belong to that school. Tick “Show every school and module” to see the rest."}
                            </span>
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
              {/* Cancel is locked while a save runs, and it is not a courtesy. Closing the
                  modal does NOT abort the requests — the loop holds its own reference to
                  the blocks and carries on writing to the term. An administrator who
                  cancelled a half-written series and saw the editor vanish would have
                  every reason to believe nothing was created. */}
              <button onClick={() => setEditing(null)} disabled={!!saving}
                className="ml-auto rounded-lg px-4 py-2 text-sm font-bold text-slate-500 hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-transparent">Cancel</button>
              {/* EVERY block has to be complete, not just the first one. The loop in
                  save() posts them all, and a block missing its title would be one 400
                  in the middle of a run that had already created the classes before it —
                  a partial save to unpick rather than a button that stayed disabled. */}
              {/* THE LABEL CHANGES, AND SO DOES THE ICON. A spinner that replaces the tick
                  says "working" at a glance from across a desk; the words say which of the
                  several things it is working on. Both, because the button is the only
                  thing on screen that moves while a term is being written. */}
              <button onClick={save}
                disabled={!!saving || (editing.id
                  ? (!editing.title?.trim() || !editing.date)
                  : !(editing.blocks?.length && editing.blocks.every((b) => (b.title || "").trim() && b.date)))}
                aria-busy={!!saving}
                className="flex items-center gap-1 rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-40" style={{ background: NAVY }}>
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                {saving || "Save"}
              </button>
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
          try { await api.ttDeleteEvent(id); setEditing(null); refresh(); }
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
          try { const r = await api.ttPublish({ from, to, published: true }); setNote(`${r.updated} event(s) published.`); refresh(); }
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
                    setEditing(null); refresh();
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
