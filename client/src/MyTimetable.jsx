// My Timetable — what a member of staff reads, on the website and in the phone app.
//
// LAID OUT TO MATCH THE REFERENCE SCREENSHOTS: a coloured application bar, a left
// sidebar carrying the view picker, a mini month calendar and the collapsible
// resource lists, and a main pane with the Today/«/‹/›/» strip, the institution's
// notice, and the grid.
//
// ONE COMPONENT SERVES BOTH SURFACES. StaffApp already renders through PhoneShell on
// a desktop and a handset alike, so there is no second implementation to keep in
// step. The sidebar is the one thing that cannot survive a 390px screen — it is
// wider than the grid it sits beside — so on a handset it collapses behind the
// hamburger in the bar, which is exactly what the reference does.
//
// It calls /api/my-timetable, which needs no admin page. With no resource selected
// the server answers with THIS PERSON'S teaching, found by a join on their id — not
// a match on their name, which is the entire reason this module exists.
import React, { useCallback, useEffect, useState } from "react";
import {
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ChevronDown, ChevronUp,
  Menu, Info, Settings as SettingsIcon, Share2, Printer, Search, MoreVertical,
  List, LayoutGrid, Loader2, AlertTriangle, X, MapPin, Users, BookOpen, Clock3,
} from "lucide-react";
import { api } from "./api";
import TimetableCalendar from "./TimetableCalendar";
import SelectTimetablesModal from "./SelectTimetablesModal";
import TimetableSettingsModal from "./TimetableSettingsModal";
import MiniMonth from "./MiniMonth";
import { windowFor, shiftAnchor, RANGE_LABEL } from "./timetableView";
import { TT, OUTLINE } from "./timetableTheme";
import { alpha, NAVY } from "./branding";
import { useIsHandset } from "./PhoneShell";

// The app's own idea of today, taken once per mount. Not recomputed on every render:
// a component that re-reads the clock mid-render can highlight two different days in
// one paint.
const todayISO = () => new Date().toISOString().slice(0, 10);

/** A collapsible sidebar section — "Timetables (0)", "Event Categories (0)". */
function Section({ label, count, icon, open, onToggle, onAction, children }) {
  return (
    <div className="border-t" style={{ borderColor: TT.rule }}>
      <div className="flex items-center gap-1 px-3 py-3">
        <p className="flex-1 text-[15px] text-slate-700">
          {label} <span className="text-slate-400">({count})</span>
        </p>
        {icon}
        {onAction && (
          <button onClick={onAction} aria-label={`${label} options`} className="rounded p-1 text-slate-500 hover:bg-slate-100">
            <MoreVertical size={18} />
          </button>
        )}
        <button onClick={onToggle} aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
          className="rounded p-1 text-slate-500 hover:bg-slate-100">
          {open ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>
      </div>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

export default function MyTimetable({ onBack }) {
  const [today] = useState(todayISO);
  const [anchor, setAnchor] = useState(todayISO);
  const [view, setView] = useState("week");
  const [layout, setLayout] = useState("grid");
  const [scope, setScope] = useState({ type: null, ids: [], labels: [] });
  const [events, setEvents] = useState([]);
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [picker, setPicker] = useState(false);
  const [prefs, setPrefs] = useState(false);
  const [selected, setSelected] = useState(null);
  const [noticeOpen, setNoticeOpen] = useState(true);
  const [shareOpen, setShareOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [openSections, setOpenSections] = useState({ timetables: false, categories: false });
  const handset = useIsHandset();

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
  // The grid draws with the reader's chosen layout unless they have set one in My
  // Settings, which wins — the toggle is a quick override, not a second setting.
  const effectiveSettings = settings ? { ...settings, layout } : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      {/* ------------------------------------------------ application bar -- */}
      <div className="relative flex shrink-0 items-center gap-2 px-3 py-2.5" style={{ background: TT.bar, color: TT.barText }}>
        {onBack && (
          <button onClick={onBack} aria-label="Back to Staff Hub" className="rounded-full p-1.5 hover:bg-white/15">
            <ChevronLeft size={22} />
          </button>
        )}
        <button onClick={() => setSidebar((s) => !s)} aria-label="Toggle sidebar" className="rounded p-1.5 hover:bg-white/15">
          <Menu size={22} />
        </button>
        <p className="ml-1 text-[15px] font-semibold tracking-wide">My Timetable</p>
        <div className="flex-1" />
        <button onClick={() => setKeyOpen((v) => !v)} aria-label="Event colour key" className="rounded-full p-1.5 hover:bg-white/15"><Info size={20} /></button>
        <button onClick={() => setPrefs(true)} aria-label="My settings" className="rounded-full p-1.5 hover:bg-white/15"><SettingsIcon size={20} /></button>
        <div className="relative">
          <button onClick={() => setShareOpen((v) => !v)} aria-label="Share" className="rounded-full p-1.5 hover:bg-white/15"><Share2 size={20} /></button>
          {shareOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setShareOpen(false)} />
              <div className="absolute right-0 z-40 mt-2 w-40 overflow-hidden rounded bg-white py-1 text-slate-700 shadow-xl">
                <button onClick={() => { setShareOpen(false); window.print(); }}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-sm hover:bg-slate-50"><Printer size={18} className="text-slate-500" /> Print</button>
                {/* Share is deliberately absent from the menu's second slot: it needs a
                    server-side link anyone can open, and a button that copies a URL
                    only the signed-in reader can load looks like it worked and did
                    not. See the plan's "known gaps". */}
              </div>
            </>
          )}
        </div>
        <div className="ml-1 flex h-8 w-8 items-center justify-center rounded-full bg-white/25 text-sm font-semibold">S</div>

        {/* Event colour key — the reference shows it as a popover from the bar. It
            names the dimension colour is CARRYING, which is a question the reader
            answers for themselves in My Settings. */}
        {keyOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setKeyOpen(false)} />
            <div className="absolute right-24 top-12 z-40 w-64 rounded bg-white p-3 text-slate-700 shadow-xl">
              <p className="mb-2 text-base font-semibold">Event colour key</p>
              {[["Module Offering", "module"], ["Room", "room"], ["Group", "group"], ["Course Offering", "course"], ["Event Category", "category"]].map(([l, k]) => (
                <p key={k} className={`flex items-center gap-2 py-1.5 text-sm ${settings?.colourBy === k ? "font-bold text-slate-900" : ""}`}>
                  <span className="inline-block h-3 w-3 rounded-sm" style={{ background: settings?.colourBy === k ? NAVY : "#cbd5e1" }} />
                  {l}
                </p>
              ))}
              <p className="mt-2 border-t border-slate-100 pt-2 text-[11px] text-slate-400">Change this under the gear, on the Events tab.</p>
            </div>
          </>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* ------------------------------------------------------ sidebar -- */}
        {sidebar && !handset && (
          <aside className="w-[330px] shrink-0 overflow-y-auto border-r" style={{ background: TT.sidebar, borderColor: TT.rule }}>
            <div className="flex items-end gap-2 p-3">
              <label className="relative flex-1">
                <span className="absolute -top-2 left-2 bg-white px-1 text-[11px] text-slate-500">View</span>
                <select value={view} onChange={(e) => setView(e.target.value)} className={OUTLINE}>
                  {["day", "week", "month", "timeline"].map((v) => <option key={v} value={v}>{v[0].toUpperCase() + v.slice(1)}</option>)}
                </select>
              </label>
              <div className="flex rounded border" style={{ borderColor: TT.rule }}>
                <button onClick={() => setLayout("list")} aria-label="List view"
                  className={`p-2 ${layout === "list" ? "bg-slate-200" : "hover:bg-slate-50"}`}><List size={20} className="text-slate-600" /></button>
                <button onClick={() => setLayout("grid")} aria-label="Grid view"
                  className={`p-2 ${layout === "grid" ? "bg-slate-200" : "hover:bg-slate-50"}`}><LayoutGrid size={20} className="text-slate-600" /></button>
              </div>
            </div>

            <MiniMonth anchor={anchor} today={today} weekFrom={from} weekTo={to} onPick={setAnchor} />

            <Section
              label="Timetables" count={scope.ids.length}
              open={openSections.timetables}
              onToggle={() => setOpenSections((s) => ({ ...s, timetables: !s.timetables }))}
              icon={<button onClick={() => setPicker(true)} aria-label="Select timetables" className="rounded p-1 text-slate-500 hover:bg-slate-100"><Search size={18} /></button>}
            >
              {!scope.ids.length ? (
                <p className="text-sm text-slate-400">Showing your own teaching. Use the magnifier to look up a room, group, module, colleague or student.</p>
              ) : (
                <div className="space-y-1">
                  {scope.labels.map((l) => <p key={l.id} className="truncate rounded bg-slate-100 px-2 py-1 text-sm text-slate-700">{l.label}</p>)}
                  <button onClick={() => setScope({ type: null, ids: [], labels: [] })} className="pt-1 text-xs font-semibold text-slate-500 hover:text-slate-700">Back to my timetable</button>
                </div>
              )}
            </Section>

            <Section
              label="Event Categories" count={settings?.colourBy === "category" ? 1 : 0}
              open={openSections.categories}
              onToggle={() => setOpenSections((s) => ({ ...s, categories: !s.categories }))}
              onAction={() => setPrefs(true)}
            >
              <p className="text-sm text-slate-400">Colour is currently carrying <b className="text-slate-600">{settings?.colourBy || "category"}</b>. Change it under the gear.</p>
            </Section>
          </aside>
        )}

        {/* --------------------------------------------------- main pane -- */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Navigation strip */}
          <div className="flex shrink-0 flex-wrap items-center gap-1 px-3 py-2" style={{ background: TT.strip }}>
            <button onClick={() => setAnchor(today)}
              className="mr-1 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-50">Today</button>
            <button onClick={() => setAnchor((a) => shiftAnchor(view, a, -1, true))} aria-label="Jump back" className="rounded p-1.5 text-slate-600 hover:bg-slate-200"><ChevronsLeft size={18} /></button>
            <button onClick={() => setAnchor((a) => shiftAnchor(view, a, -1))} aria-label="Previous" className="rounded p-1.5 text-slate-600 hover:bg-slate-200"><ChevronLeft size={18} /></button>
            <p className="min-w-[150px] px-2 text-center text-[15px] font-medium text-slate-700">{RANGE_LABEL(view, from, to)}</p>
            <button onClick={() => setAnchor((a) => shiftAnchor(view, a, 1))} aria-label="Next" className="rounded p-1.5 text-slate-600 hover:bg-slate-200"><ChevronRight size={18} /></button>
            <button onClick={() => setAnchor((a) => shiftAnchor(view, a, 1, true))} aria-label="Jump forward" className="rounded p-1.5 text-slate-600 hover:bg-slate-200"><ChevronsRight size={18} /></button>
            {handset && (
              <button onClick={() => setPicker(true)} aria-label="Select timetables" className="ml-auto rounded p-1.5 text-slate-600 hover:bg-slate-200"><Search size={18} /></button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {scope.type && (
              <div className="mb-3 flex items-center gap-2 rounded bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">
                Viewing: {scopeLabel}
                <button onClick={() => setScope({ type: null, ids: [], labels: [] })} className="ml-auto rounded px-2 py-0.5 hover:bg-amber-100">Back to mine</button>
              </div>
            )}

            {/* The institution's notice, in the bordered card the reference uses. */}
            {settings?.notice?.enabled && settings.notice.text && noticeOpen && (
              <div className="mb-3 flex items-start gap-2 rounded border bg-white p-3" style={{ borderColor: TT.rule }}>
                <p className="flex-1 whitespace-pre-wrap text-[13px] leading-relaxed text-slate-700">{settings.notice.text}</p>
                <button onClick={() => setNoticeOpen(false)} aria-label="Hide notice" className="rounded p-1 text-slate-500 hover:bg-slate-100"><MoreVertical size={18} /></button>
              </div>
            )}

            {err && (
              <div className="mb-3 flex items-center gap-2 rounded bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700 ring-1 ring-rose-200">
                <AlertTriangle size={16} /> {err}
                <button onClick={load} className="ml-auto rounded px-2 py-0.5 text-xs font-bold hover:bg-rose-100">Retry</button>
              </div>
            )}

            {busy && !settings ? (
              <div className="flex justify-center py-20 text-slate-400"><Loader2 size={22} className="animate-spin" /></div>
            ) : (
              <TimetableCalendar
                events={events} settings={effectiveSettings} view={view} anchor={anchor} today={today}
                onSelectEvent={setSelected} selectedId={selected?.id}
              />
            )}
          </div>
        </main>
      </div>

      {/* Event detail. A panel rather than a tooltip: a tile is too small for the
          room, the group and the staff at once, and a lecturer checking where to be
          needs all three. */}
      {selected && (
        <div className="fixed inset-x-0 bottom-0 z-40 rounded-t-2xl bg-white p-4 shadow-2xl ring-1 ring-slate-200 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-80 sm:rounded-2xl">
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
