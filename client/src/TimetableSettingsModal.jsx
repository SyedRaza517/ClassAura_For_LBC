// My Settings — the three tabs the source system offers, over the same merged blob
// the server resolves: platform defaults, then the college's, then this person's.
//
// `scope` decides which layer is being edited. At scope "me" the NOTICE BANNER IS NOT
// SHOWN AT ALL, because the server drops it from a user patch: it carries compliance
// wording and is an institutional statement. Offering a field that is silently
// discarded is worse than not offering it — the reader types, saves, and is told
// nothing.
import React, { useState } from "react";
import { X, ArrowUp, ArrowDown, Plus } from "lucide-react";
import { TT } from "./timetableTheme";
import ModalPortal from "./ModalPortal";

const DAYS = [[1, "Monday"], [2, "Tuesday"], [3, "Wednesday"], [4, "Thursday"], [5, "Friday"], [6, "Saturday"], [7, "Sunday"]];
const COLOUR_BY = [["category", "Event Category"], ["module", "Module Offering"], ["room", "Room"], ["group", "Group"], ["course", "Course Offering"]];
const ANNOTATIONS = [["title", "Event name"], ["unit", "Module Offering"], ["category", "Event Category"], ["room", "Room"], ["staff", "Teaching Staff"], ["group", "Group"], ["course", "Course Offering"], ["eventId", "Event ID"]];
const ALL_PERIODS = Array.from({ length: 15 }, (_, i) => {
  const h = 7 + i;
  return { start: `${String(h).padStart(2, "0")}:00`, end: `${String(h + 1).padStart(2, "0")}:00` };
});

/**
 * Only the keys whose value actually changed.
 *
 * SENDING THE WHOLE BLOB WOULD BREAK "INHERITED". The server stores a college's
 * settings as a patch merged over the platform defaults, and returns both so a screen
 * can show which values are the college's own and which are simply inherited. PUT the
 * entire merged object and every field becomes explicitly set the first time anybody
 * presses Save — after which "reset to default" has nothing to reset to, and a later
 * change to a platform default can never reach that college again.
 *
 * Compared by JSON rather than identity because periods, days and annotations are
 * arrays rebuilt on every edit, so a reference check would call all three changed
 * whenever any one of them was touched.
 */
function changedOnly(before, after) {
  const out = {};
  for (const k of Object.keys(after || {})) {
    if (JSON.stringify(before?.[k]) !== JSON.stringify(after[k])) out[k] = after[k];
  }
  return out;
}

function Check({ on, onChange, label }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-1 text-sm text-slate-700">
      <input type="checkbox" checked={!!on} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
      {label}
    </label>
  );
}

export default function TimetableSettingsModal({ open, settings, scope = "me", onSave, onClose }) {
  const [tab, setTab] = useState("calendar");
  const [draft, setDraft] = useState(settings || {});
  // What the modal was opened with, so Save can send only what actually changed.
  const [seeded] = useState(settings || {});
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));

  if (!open) return null;
  const periods = draft.periods || [];
  const annotations = draft.annotations || [];
  const hasPeriod = (p) => periods.some((x) => x.start === p.start && x.end === p.end);

  const togglePeriod = (p, on) => {
    const next = on ? [...periods, p] : periods.filter((x) => !(x.start === p.start && x.end === p.end));
    // Sorted here as well as on the server, so the list a reader sees while editing
    // matches the one they get back after saving.
    set("periods", next.sort((a, b) => a.start.localeCompare(b.start)));
  };
  const moveAnnotation = (i, by) => {
    const next = [...annotations];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    set("annotations", next);
  };

  // PORTALLED — see ModalPortal.jsx. Inline, this sized itself to the console view
  // rather than to the window, which put a 90vh panel somewhere other than the middle
  // of the screen and could leave its Save button below the fold.
  return (
    <ModalPortal>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-3">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3" style={{ background: TT.green, color: TT.greenText }}>
          <p className="text-base font-extrabold">{scope === "me" ? "My Settings" : "Timetable display — college defaults"}</p>
          <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 hover:bg-white/20"><X size={18} /></button>
        </div>

        <div className="flex gap-1 border-b border-slate-200 px-3 pt-2">
          {[["calendar", "Calendar view"], ["events", "Events"], ["annotations", "Annotations"]].map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`rounded-t-lg px-3 py-2 text-sm font-bold ${tab === k ? "border-b-2 text-slate-800" : "text-slate-500 hover:text-slate-600"}`}
              style={tab === k ? { borderColor: TT.green } : undefined}>{l}</button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {tab === "calendar" && (
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-sm font-bold text-slate-600">Periods</p>
                <p className="mb-2 text-[11px] text-slate-500">Hours to show on the grid. Switching one off hides that row entirely.</p>
                {ALL_PERIODS.map((p) => (
                  <Check key={p.start} on={hasPeriod(p)} onChange={(on) => togglePeriod(p, on)} label={`${p.start} – ${p.end}`} />
                ))}
              </div>
              <div>
                <p className="mb-1 text-sm font-bold text-slate-600">Days</p>
                <p className="mb-2 text-[11px] text-slate-500">Weekdays to show as columns.</p>
                {DAYS.map(([n, l]) => (
                  <Check key={n} on={(draft.days || []).includes(n)}
                    onChange={(on) => set("days", on ? [...(draft.days || []), n].sort((a, b) => a - b) : (draft.days || []).filter((d) => d !== n))}
                    label={l} />
                ))}
                <div className="mt-4 border-t border-slate-100 pt-3">
                  <Check on={draft.swapAxes} onChange={(v) => set("swapAxes", v)} label="Swap grid axes" />
                  <Check on={draft.showAvailability} onChange={(v) => set("showAvailability", v)} label="Show timetable availability on the event grid" />
                </div>
              </div>
            </div>
          )}

          {tab === "events" && (
            <div className="space-y-5">
              <div>
                <p className="mb-1 text-sm font-bold text-slate-600">Default view</p>
                <select value={draft.view || "week"} onChange={(e) => set("view", e.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
                  {["day", "week", "month", "timeline"].map((v) => <option key={v} value={v}>{v[0].toUpperCase() + v.slice(1)}</option>)}
                </select>
              </div>
              <div>
                <p className="mb-1 text-sm font-bold text-slate-600">Event colour key</p>
                <p className="mb-2 text-[11px] text-slate-500">What colour should mean.</p>
                <select value={draft.colourBy || "category"} onChange={(e) => set("colourBy", e.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
                  {COLOUR_BY.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
              <div>
                <p className="mb-1 text-sm font-bold text-slate-600">Event colour variant</p>
                {[["normal", "Normal"], ["light", "Light"]].map(([k, l]) => (
                  <label key={k} className="flex cursor-pointer items-center gap-2 py-1 text-sm text-slate-700">
                    <input type="radio" name="variant" checked={(draft.colourVariant || "normal") === k} onChange={() => set("colourVariant", k)} />
                    {l}
                  </label>
                ))}
              </div>
              {/* College scope only. See the file header: at "me" scope the server
                  drops this, so showing it would be a control that does nothing. */}
              {scope === "college" && (
                <div className="border-t border-slate-100 pt-4">
                  <p className="mb-1 text-sm font-bold text-slate-600">Notice banner</p>
                  <p className="mb-2 text-[11px] text-slate-500">Shown across the top of every timetable in this college. Staff cannot change it.</p>
                  <Check on={draft.notice?.enabled} onChange={(v) => set("notice", { ...(draft.notice || {}), enabled: v })} label="Show the notice" />
                  <textarea rows={4} value={draft.notice?.text || ""} onChange={(e) => set("notice", { ...(draft.notice || {}), text: e.target.value })}
                    className="mt-2 w-full rounded-lg border border-slate-300 p-2 text-sm" placeholder="e.g. attendance requirements for funding eligibility" />
                </div>
              )}
            </div>
          )}

          {tab === "annotations" && (
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <Check on={draft.showEventTimes} onChange={(v) => set("showEventTimes", v)} label="Show event times on grid view" />
                <Check on={draft.showEventId} onChange={(v) => set("showEventId", v)} label="Show Event ID" />
                <div className="mt-3">
                  <p className="text-sm text-slate-700">Highlight recently changed events</p>
                  <p className="mb-1 text-[11px] text-slate-500">Days to look back. 0 switches the highlight off.</p>
                  <input type="number" min={0} max={90} value={draft.highlightChangedDays ?? 0}
                    onChange={(e) => set("highlightChangedDays", Number(e.target.value))}
                    className="w-24 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
                </div>
              </div>
              <div>
                <p className="mb-1 text-sm font-bold text-slate-600">Event annotations</p>
                {/* The ORDER is the setting: it decides what a reader sees first when
                    a tile is too small for everything. */}
                <p className="mb-2 text-[11px] text-slate-500">What appears inside an event, top first.</p>
                <div className="space-y-1">
                  {annotations.map((a, i) => (
                    <div key={a} className="flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1.5">
                      <span className="flex-1 text-sm font-semibold text-slate-700">{(ANNOTATIONS.find(([k]) => k === a) || [a, a])[1]}</span>
                      <button onClick={() => moveAnnotation(i, -1)} aria-label="Move up" className="rounded p-1 text-slate-400 hover:bg-white"><ArrowUp size={14} /></button>
                      <button onClick={() => moveAnnotation(i, 1)} aria-label="Move down" className="rounded p-1 text-slate-400 hover:bg-white"><ArrowDown size={14} /></button>
                      <button onClick={() => set("annotations", annotations.filter((x) => x !== a))} aria-label="Remove" className="rounded p-1 text-slate-400 hover:bg-white"><X size={14} /></button>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {ANNOTATIONS.filter(([k]) => !annotations.includes(k)).map(([k, l]) => (
                    <button key={k} onClick={() => set("annotations", [...annotations, k])}
                      className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-500 hover:bg-slate-50">
                      <Plus size={12} /> {l}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 p-3">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-bold text-slate-500 hover:bg-slate-100">Cancel</button>
          <button disabled={saving}
            onClick={async () => { setSaving(true); try { await onSave?.(changedOnly(seeded, draft)); } finally { setSaving(false); } }}
            className="rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-50" style={{ background: TT.green, color: TT.greenText }}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}
