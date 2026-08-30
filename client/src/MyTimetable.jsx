// My Timetable — what a member of staff reads, on the website and in the phone app.
//
// ONE COMPONENT SERVES BOTH. StaffApp already renders through PhoneShell on a
// desktop and a handset alike, so there is no second implementation to keep in step;
// TimetableCalendar decides for itself when a grid should become a list.
//
// It calls /api/my-timetable, which needs no admin page. With no resource selected
// the server answers with THIS PERSON'S teaching, found by a join on their id — not
// a match on their name, which is the entire reason this module exists.
import React, { useCallback, useEffect, useState } from "react";
import {
  CalendarDays, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
  Settings as SettingsIcon, Search, Printer, Loader2, AlertTriangle, X, MapPin, Users, BookOpen, Clock3,
} from "lucide-react";
import { api } from "./api";
import TimetableCalendar from "./TimetableCalendar";
import SelectTimetablesModal from "./SelectTimetablesModal";
import TimetableSettingsModal from "./TimetableSettingsModal";
import { windowFor, shiftAnchor, RANGE_LABEL } from "./timetableView";
import { NAVY, alpha } from "./branding";

// The app's own idea of today, taken once per mount. Not recomputed on every render:
// a component that re-reads the clock mid-render can highlight two different days in
// one paint.
const todayISO = () => new Date().toISOString().slice(0, 10);

export default function MyTimetable() {
  const [today] = useState(todayISO);
  const [anchor, setAnchor] = useState(todayISO);
  const [view, setView] = useState("week");
  const [scope, setScope] = useState({ type: null, ids: [], labels: [] });
  const [events, setEvents] = useState([]);
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [picker, setPicker] = useState(false);
  const [prefs, setPrefs] = useState(false);
  const [selected, setSelected] = useState(null);
  const [noticeOpen, setNoticeOpen] = useState(true);

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      const { from, to } = windowFor(view, anchor);
      const r = await api.myTimetable(from, to, scope.type, scope.ids);
      setEvents(r.events || []);
      setSettings(r.settings || null);
      // The saved default view applies on FIRST load only. Re-applying it on every
      // fetch would yank a reader out of Month the moment they pressed "next".
      setView((v) => (settings ? v : (r.settings?.view || v)));
    } catch (e) {
      setErr(e?.message || "Could not load your timetable.");
    } finally {
      setBusy(false);
    }
    // `settings` is deliberately not a dependency — it is written by this effect, and
    // including it would re-fetch on every settings change forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, anchor, scope.type, scope.ids]);

  useEffect(() => { load(); }, [load]);

  const saveSettings = async (patch) => {
    const r = await api.saveMyTimetableSettings(patch);
    setSettings(r.settings);
    setPrefs(false);
  };

  const { from, to } = windowFor(view, anchor);
  const scopeLabel = scope.type ? scope.labels.map((l) => l.label).join(", ") : "My timetable";

  return (
    <div className="p-3 sm:p-4">
      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button onClick={() => setAnchor(today)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50">Today</button>
        <div className="flex items-center gap-0.5">
          <button onClick={() => setAnchor((a) => shiftAnchor(view, a, -1, true))} aria-label="Jump back" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><ChevronsLeft size={16} /></button>
          <button onClick={() => setAnchor((a) => shiftAnchor(view, a, -1))} aria-label="Previous" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><ChevronLeft size={16} /></button>
          <p className="min-w-[150px] text-center text-sm font-extrabold text-slate-700">{RANGE_LABEL(view, from, to)}</p>
          <button onClick={() => setAnchor((a) => shiftAnchor(view, a, 1))} aria-label="Next" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><ChevronRight size={16} /></button>
          <button onClick={() => setAnchor((a) => shiftAnchor(view, a, 1, true))} aria-label="Jump forward" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><ChevronsRight size={16} /></button>
        </div>
        <select value={view} onChange={(e) => setView(e.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-bold text-slate-600">
          {["day", "week", "month", "timeline"].map((v) => <option key={v} value={v}>{v[0].toUpperCase() + v.slice(1)}</option>)}
        </select>
        {/* Jump to a date. The source system puts a small month calendar in a left
            sidebar; a native date field does the same job in one control, works with
            a thumb on a phone where a 7x6 grid of tap targets does not, and brings
            the platform's own picker with it. The sidebar calendar is recorded as a
            gap rather than half-built. */}
        <input type="date" value={anchor} onChange={(e) => e.target.value && setAnchor(e.target.value)}
          aria-label="Jump to date" className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-bold text-slate-600" />
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => setPicker(true)} className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"><Search size={14} /> Select timetables</button>
          {/* Print is the browser's own, which is all the source system's Print menu
              item does. Share is NOT offered: it would need a server-side shareable
              link, and a button that copies a URL only the signed-in reader can open
              is worse than no button. */}
          <button onClick={() => window.print()} aria-label="Print" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><Printer size={16} /></button>
          <button onClick={() => setPrefs(true)} aria-label="My settings" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><SettingsIcon size={16} /></button>
        </div>
      </div>

      {/* Whose timetable, when it is not the reader's own. Stated plainly, because a
          grid of somebody else's classes is indistinguishable from your own. */}
      {scope.type && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
          <CalendarDays size={14} /> Viewing: {scopeLabel}
          <button onClick={() => setScope({ type: null, ids: [], labels: [] })} className="ml-auto rounded px-2 py-0.5 font-bold hover:bg-amber-100">Back to mine</button>
        </div>
      )}

      {settings?.notice?.enabled && settings.notice.text && noticeOpen && (
        <div className="mb-3 flex items-start gap-2 rounded-xl bg-white p-3 text-[13px] leading-relaxed text-slate-600 shadow-sm ring-1 ring-slate-200">
          <p className="flex-1 whitespace-pre-wrap">{settings.notice.text}</p>
          <button onClick={() => setNoticeOpen(false)} aria-label="Hide notice" className="rounded p-1 text-slate-400 hover:bg-slate-100"><X size={14} /></button>
        </div>
      )}

      {err && (
        <div className="mb-3 flex items-center gap-2 rounded-xl bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700 ring-1 ring-rose-200">
          <AlertTriangle size={16} /> {err}
          <button onClick={load} className="ml-auto rounded px-2 py-0.5 text-xs font-bold hover:bg-rose-100">Retry</button>
        </div>
      )}

      {busy && !settings ? (
        <div className="flex justify-center py-20 text-slate-400"><Loader2 size={22} className="animate-spin" /></div>
      ) : (
        <TimetableCalendar
          events={events} settings={settings} view={view} anchor={anchor} today={today}
          onSelectEvent={setSelected} selectedId={selected?.id}
        />
      )}

      {/* Event detail. A panel rather than a tooltip: a tile is too small for the
          room, the group and the staff at once, and a lecturer checking where to be
          needs all three. */}
      {selected && (
        <div className="fixed inset-x-0 bottom-0 z-40 rounded-t-2xl bg-white p-4 shadow-2xl ring-1 ring-slate-200 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-80 sm:rounded-2xl">
          <div className="mb-2 flex items-start justify-between gap-2">
            <p className="text-base font-extrabold text-slate-800">{selected.title}</p>
            <button onClick={() => setSelected(null)} aria-label="Close" className="rounded-full p-1 text-slate-400 hover:bg-slate-100"><X size={16} /></button>
          </div>
          <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-500"><Clock3 size={14} /> {selected.date} · {selected.start}–{selected.end}</p>
          {selected.room && <p className="flex items-center gap-1.5 py-0.5 text-sm text-slate-600"><MapPin size={14} className="text-slate-400" /> {selected.room}</p>}
          {selected.unitCode && <p className="flex items-center gap-1.5 py-0.5 text-sm text-slate-600"><BookOpen size={14} className="text-slate-400" /> {selected.unitCode}{selected.unitName ? ` — ${selected.unitName}` : ""}</p>}
          {!!selected.staff?.length && <p className="flex items-center gap-1.5 py-0.5 text-sm text-slate-600"><Users size={14} className="text-slate-400" /> {selected.staff.map((s) => s.name).join(", ")}</p>}
          {!!selected.groups?.length && <p className="flex items-center gap-1.5 py-0.5 text-sm text-slate-600"><Users size={14} className="text-slate-400" /> {selected.groups.map((g) => g.name).join(", ")}</p>}
          {selected.notes && <p className="mt-2 whitespace-pre-wrap rounded-lg bg-slate-50 p-2 text-xs text-slate-600">{selected.notes}</p>}
          {selected.category && <p className="mt-2 inline-block rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ background: alpha(selected.categoryColour || NAVY, 14), color: selected.categoryColour || NAVY }}>{selected.category}</p>}
        </div>
      )}

      <SelectTimetablesModal
        open={picker} initialType={scope.type} initialSelected={scope.labels}
        onClose={() => setPicker(false)}
        onApply={(s) => { setScope({ type: s.type, ids: s.ids, labels: s.labels || [] }); setPicker(false); }}
      />
      {settings && (
        <TimetableSettingsModal open={prefs} settings={settings} scope="me" onClose={() => setPrefs(false)} onSave={saveSettings} />
      )}
    </div>
  );
}
