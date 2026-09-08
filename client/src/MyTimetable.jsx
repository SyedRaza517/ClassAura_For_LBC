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
  // WHERE the tile was, so the panel can sit beside it instead of in a fixed corner.
  // Null on a handset, where the panel stays a bottom sheet: anchoring a 320px card to
  // a tile on a 390px screen puts it half off the edge, and a phone has nowhere better
  // for it to be than the bottom.
  const [anchorRect, setAnchorRect] = useState(null);
  // The group whose students are being shown inside the panel, and the roster itself.
  // Fetched on demand rather than with the timetable: a week holds thirty classes and
  // nobody opens thirty rosters.
  const [rosterFor, setRosterFor] = useState(null);
  const [roster, setRoster] = useState(null);
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
                onSelectEvent={(e, rect) => { setSelected(e); setAnchorRect(rect || null); setRosterFor(null); setRoster(null); }}
                selectedId={selected?.id}
              />
            )}
          </div>
        </main>
      </div>

      {/* Event detail. A panel rather than a tooltip: a tile is too small for the
          room, the group and the staff at once, and a lecturer checking where to be
          needs all three. */}
      {selected && (() => {
        // ANCHORED TO THE TILE, and flipped rather than clipped.
        //
        // The panel is ~320 wide and ~340 tall. Placed naively to the right of and below
        // the tile it would fall off the screen for anything on Friday or after lunch, so
        // each axis independently chooses the side with room. Clamped as well, because a
        // tile near a corner can leave neither side comfortable.
        const W = 320, H = 340, GAP = 10;
        let style = { position: "fixed", left: 16, right: 16, bottom: 0 };   // handset default
        if (anchorRect) {
          const vw = window.innerWidth, vh = window.innerHeight;
          const left = anchorRect.right + GAP + W < vw ? anchorRect.right + GAP
                     : anchorRect.left - GAP - W > 0 ? anchorRect.left - GAP - W
                     : Math.max(8, Math.min(vw - W - 8, anchorRect.left));
          const top = Math.max(8, Math.min(vh - H - 8, anchorRect.top));
          style = { position: "fixed", left, top, width: W };
        }
        const colour = selected.categoryColour || NAVY;
        const Row = ({ icon: I, children }) => (
          <p className="flex items-start gap-2 py-1 text-sm text-slate-700">
            <I size={14} className="mt-0.5 shrink-0" style={{ color: colour }} /> <span className="min-w-0">{children}</span>
          </p>
        );
        return (
          <>
            {/* Click anywhere else to dismiss. Without this the panel could only be
                closed by its own X, which on a grid you are scanning is a click you
                should not have to aim for. */}
            <div className="fixed inset-0 z-30" onClick={() => { setSelected(null); setAnchorRect(null); }} />
            <div style={style}
              className="z-40 max-h-[80vh] overflow-y-auto rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200 max-sm:rounded-b-none">
              {/* The header carries the class's OWN colour, so the panel and the tile it
                  came from are visibly the same thing. A white card beside a coloured
                  grid reads as a different screen. */}
              <div className="flex items-start justify-between gap-2 rounded-t-2xl px-4 py-3 max-sm:rounded-t-2xl" style={{ background: colour }}>
                <div className="min-w-0">
                  <p className="truncate text-base font-extrabold text-white">{selected.title}</p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-xs font-semibold text-white/85">
                    <Clock3 size={12} /> {selected.date} · {selected.start}–{selected.end}
                  </p>
                </div>
                <button onClick={() => { setSelected(null); setAnchorRect(null); }} aria-label="Close"
                  className="shrink-0 rounded-full p-1 text-white/80 transition hover:bg-white/20 hover:text-white"><X size={16} /></button>
              </div>

              <div className="px-4 py-3">
                {selected.room && <Row icon={MapPin}>{selected.room}</Row>}
                {selected.unitCode && <Row icon={BookOpen}>{selected.unitCode}{selected.unitName ? ` — ${selected.unitName}` : ""}</Row>}
                {!!selected.staff?.length && <Row icon={Users}>{selected.staff.map((s) => s.name).join(", ")}</Row>}

                {!!selected.groups?.length && (
                  <div className="py-1">
                    <p className="mb-1 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide" style={{ color: colour }}>
                      <Users size={13} /> Groups
                    </p>
                    {/* EACH GROUP OPENS ITS OWN REGISTER LIST. The question a lecturer
                        actually has in front of a class is "who is in this", and the
                        group name was previously just text. Fetched on click. */}
                    <div className="flex flex-wrap gap-1">
                      {selected.groups.map((g) => (
                        <button key={g.id} type="button"
                          onClick={async () => {
                            if (rosterFor === g.id) { setRosterFor(null); setRoster(null); return; }
                            setRosterFor(g.id); setRoster(null);
                            try { setRoster(await api.ttGroupStudents(g.id)); }
                            catch (e) { setRoster({ error: e?.message || "Could not load that group." }); }
                          }}
                          className="rounded-full px-2.5 py-1 text-xs font-bold transition hover:brightness-95"
                          style={{ background: alpha(colour, rosterFor === g.id ? 26 : 14), color: colour }}>
                          {g.name}
                        </button>
                      ))}
                    </div>
                    {rosterFor && (
                      <div className="mt-2 rounded-lg p-2" style={{ background: alpha(colour, 8) }}>
                        {roster === null && <p className="text-xs text-slate-500">Loading…</p>}
                        {roster?.error && <p className="text-xs font-semibold text-amber-700">{roster.error}</p>}
                        {Array.isArray(roster) && !roster.length && (
                          <p className="text-xs text-slate-500">Nobody is in this group yet.</p>
                        )}
                        {Array.isArray(roster) && !!roster.length && (
                          <>
                            <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-500">{roster.length} student{roster.length === 1 ? "" : "s"}</p>
                            <ul className="max-h-40 space-y-0.5 overflow-y-auto">
                              {roster.map((st) => (
                                <li key={st.id} className="flex items-center justify-between gap-2 text-xs text-slate-700">
                                  <span className="truncate">{`${st.firstName || ""} ${st.lastName || ""}`.trim()}</span>
                                  <span className="shrink-0 text-slate-400">{st.studentRef}</span>
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {selected.notes && <p className="mt-2 whitespace-pre-wrap rounded-lg p-2 text-xs text-slate-600" style={{ background: alpha(colour, 8) }}>{selected.notes}</p>}
                {selected.category && (
                  <p className="mt-2 inline-block rounded-full px-2 py-0.5 text-[11px] font-bold"
                    style={{ background: alpha(colour, 16), color: colour }}>{selected.category}</p>
                )}
              </div>
            </div>
          </>
        );
      })()}

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
