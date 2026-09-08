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
// THAT WAS TRUE OF A PHONE AND WRONG ABOUT EVERYTHING BETWEEN. The sidebar was hidden
// on a handset (≤640px) and inline everywhere else, so a tablet at 820 — or a laptop
// window dragged to half the screen — put a 330px fixed sidebar beside the admin
// console's own 240px nav rail and left the timetable about 250px, in which a week is
// two and a half columns. Neither surface is a handset and the sidebar fitted neither,
// so the breakpoint that matters is not "is this a phone" but "is there room for a
// column beside the grid" (`useInlineSidebar` below, which MEASURES rather than asks
// the viewport), and below it the sidebar becomes a drawer over the grid instead of a
// column beside it. The bar's hamburger already toggled `sidebar`; it now opens that
// drawer, so there is still exactly one
// control for this and it is the one that was already there. On a handset it used to
// toggle a piece of state nothing rendered — a button that did nothing at all.
//
// It calls /api/my-timetable, which needs no admin page. With no resource selected
// the server answers with THIS PERSON'S teaching, found by a join on their id — not
// a match on their name, which is the entire reason this module exists.
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ChevronDown, ChevronUp,
  Menu, Info, Settings as SettingsIcon, Share2, Printer, Search, MoreVertical,
  List, LayoutGrid, Loader2, AlertTriangle, X, MapPin, Users, BookOpen, Clock3, CalendarDays, Building2,
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

// IS THERE ROOM FOR A 330px COLUMN BESIDE THE GRID?
//
// Not the same question as useIsHandset(), and the two are deliberately separate. That
// one answers "is this a phone", which is right for deciding that a week grid becomes
// a list and is measured partly from `pointer: coarse`, because a phone in landscape
// is still a phone. This one is arithmetic about a layout, and the answer is 330 for
// the sidebar plus the ~640 a seven-day week needs before it starts scrolling.
//
// Rejected: reusing useIsHandset() with a wider query. It is read by TimetableCalendar
// to decide that a week becomes a LIST, and widening it there would turn a tablet's
// perfectly good week grid into a list — a change to what a view means, made as a side
// effect of a sidebar decision.
//
// Rejected too, and this is the more tempting one: a plain `(min-width: 1100px)` media
// query. The viewport is not what this component gets. The admin console keeps a
// ~240px nav rail beside it — which the reader can collapse — so the same 1100px
// window is 860px of usable room, or 1100, depending on a control in a file this one
// cannot see. A query tuned for the rail is wrong when it is collapsed and a query
// tuned for the staff app is wrong in the console; the number that is right in every
// host is the width this component was handed. Measured, therefore, not queried.
//
// Safe against oscillation because the sidebar is a CHILD of the box being measured:
// showing or hiding it does not change the box's width, so there is no configuration
// in which the measurement flips the decision that produced it.
const SIDEBAR_W = 330;
const GRID_COMFORTABLE = 640;
const INLINE_MIN = SIDEBAR_W + GRID_COMFORTABLE;

function useInlineSidebar(ref) {
  // The first paint has no measurement, so it starts from a guess at the viewport —
  // a desktop-width window nearly always has the room and a phone never does, and
  // being wrong for one frame is a flicker rather than a fault. The observer then
  // replaces the guess with the truth. Guessing `true` unconditionally would flash a
  // 330px sidebar across a phone on every open.
  const [fits, setFits] = useState(() => (typeof window === "undefined" ? true : window.innerWidth >= 1220));
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const read = () => { const w = el.clientWidth; if (w) setFits(w >= INLINE_MIN); };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return fits;
}

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
  // On a handset the panel stays a bottom sheet: anchoring a 320px card to a tile on a
  // 390px screen puts it half off the edge, and a phone has nowhere better for it to
  // be than the bottom. That is enforced where the panel is placed, NOT here — a tile
  // reports where it was drawn and that is simply true; whether a screen is wide
  // enough to use the fact is a different question, and putting the two together in
  // this setter is what previously left the phone's Day view anchoring anyway.
  const [anchorRect, setAnchorRect] = useState(null);
  // The group whose students are being shown inside the panel, and the roster itself.
  // Fetched on demand rather than with the timetable: a week holds thirty classes and
  // nobody opens thirty rosters.
  const [rosterFor, setRosterFor] = useState(null);
  const [roster, setRoster] = useState(null);
  const [noticeOpen, setNoticeOpen] = useState(true);
  const [shareOpen, setShareOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [openSections, setOpenSections] = useState({ timetables: false, categories: false });
  const handset = useIsHandset();
  // The box the sidebar and the grid share, measured — see useInlineSidebar.
  const bodyRef = useRef(null);
  const inlineSidebar = useInlineSidebar(bodyRef);
  // Open where it is a column, shut where it is a drawer over the grid — and reset on
  // every crossing rather than remembered across one. A drawer left open from a wide
  // window would cover the whole timetable the moment the window narrowed, and a
  // reader who closed the column at 1400 does not mean "and keep the drawer shut" at
  // 800, where it was never a column in the first place. One flag, two presentations,
  // and the width decides which; the hamburger flips it either way.
  const [sidebar, setSidebar] = useState(inlineSidebar);
  useEffect(() => { setSidebar(inlineSidebar); }, [inlineSidebar]);

  // WHERE THE NEAREST CLASS IS, when this window has none. `null` = we have not looked
  // or there is nothing to find; otherwise { date, direction }.
  //
  // AN EMPTY WEEK AND AN EMPTY TIMETABLE LOOK IDENTICAL, and that is the whole reason
  // this exists. A lecturer who has just entered a term, opened this screen on the
  // current week and found it blank has no way to tell "your classes start a week on
  // Tuesday" from "nothing saved". The reasonable conclusion is that the save failed,
  // and the reasonable next action is to enter it all again — which is how a term gets
  // created twice. Reported exactly that way.
  const [nearest, setNearest] = useState(null);

  /**
   * Look forward, then back, for the closest class outside [from, to].
   *
   * Forward first, and it is not arbitrary: somebody staring at an empty week has
   * almost always just entered a term that starts later, so "your next class" answers
   * the question they actually have. Looking back is the fallback for a term that has
   * finished, where "your last class was" is the true answer and "no classes" would
   * imply the record had been lost.
   *
   * Six months each way rather than the year the endpoint permits. A year is two
   * requests big enough to be felt on a handset to answer a question this small, and a
   * college with nothing scheduled within six months has a different problem than this
   * banner can help with.
   */
  const findNearest = useCallback(async (from, to) => {
    const addDays = (iso, n) => {
      const d = new Date(`${iso}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const PROBE = 180;
    try {
      // Rows come back ordered by date then start time, so the ends of the two lists
      // are the nearest class in each direction without sorting anything here.
      const ahead = await api.myTimetable(addDays(to, 1), addDays(to, PROBE), scope.type, scope.ids);
      const next = (ahead.events || [])[0];
      if (next) return setNearest({ date: next.date, direction: "next" });

      const behind = await api.myTimetable(addDays(from, -PROBE), addDays(from, -1), scope.type, scope.ids);
      const list = behind.events || [];
      if (list.length) setNearest({ date: list[list.length - 1].date, direction: "last" });
    } catch {
      // Deliberately silent, and this is the one place in this file where that is right.
      // The timetable itself has already loaded successfully; this is a hint ABOUT an
      // empty week. Turning a failed hint into an error banner would report a fault over
      // a screen that is working, which is worse than the hint simply not appearing.
      setNearest(null);
    }
  }, [scope.type, scope.ids]);

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      const { from, to } = windowFor(view, anchor);
      const r = await api.myTimetable(from, to, scope.type, scope.ids);
      setEvents(r.events || []);
      setSettings(r.settings || null);
      // ONLY WHEN THE WINDOW CAME BACK EMPTY. In the ordinary case this costs nothing:
      // no second request is made at all. The probe is deliberately not folded into the
      // first call as a wider range — that would page a year of events into the browser
      // on every navigation to answer a question almost nobody is asking.
      setNearest(null);
      if (!(r.events || []).length) findNearest(from, to);
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
  }, [view, anchor, scope.type, scope.ids, findNearest]);

  useEffect(() => { load(); }, [load]);

  const saveSettings = async (patch) => {
    const r = await api.saveMyTimetableSettings(patch);
    setSettings(r.settings);
    setPrefs(false);
  };

  const { from, to } = windowFor(view, anchor);
  // "all" carries no labels — it is the absence of a filter — so it needs its own
  // wording. Falling through to the join would print "Viewing:" followed by nothing,
  // which reads as a fault rather than as a college-wide view.
  const scopeLabel = scope.type === "all" ? "Every class in the college"
    : scope.type ? scope.labels.map((l) => l.label).join(", ")
    : "My timetable";
  // The grid draws with the reader's chosen layout unless they have set one in My
  // Settings, which wins — the toggle is a quick override, not a second setting.
  const effectiveSettings = settings ? { ...settings, layout } : null;

  // The sidebar's CONTENTS, separated from its frame, because the frame is the only
  // thing that changes with the width: a column at ≥1100, a drawer over the grid
  // below it. Written once so the two cannot drift — the View picker below is the
  // only way to leave Week, and on a handset it was previously not rendered at all,
  // which left a phone with no way to reach Day, Month or Timeline.
  const sidebarBody = (
    <>
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
        {scope.type === "all" ? (
          <div className="space-y-1">
            <p className="truncate rounded bg-slate-100 px-2 py-1 text-sm font-semibold text-slate-700">Every class in the college</p>
            <button onClick={() => setScope({ type: null, ids: [], labels: [] })} className="pt-1 text-xs font-semibold text-slate-500 hover:text-slate-700">Back to my timetable</button>
          </div>
        ) : !scope.ids.length ? (
          <>
            <p className="text-sm text-slate-400">Showing your own teaching. Use the magnifier to look up a room, group, module, colleague or student.</p>
            {/* THE ONE-CLICK ANSWER TO AN EMPTY OWN-TIMETABLE. Whoever builds the term
                is usually not teaching any of it, so their own view is blank and the
                screen reads as broken. Offering "every class" right where that
                explanation sits turns a dead end into the view they actually wanted,
                without making it the default — a lecturer opening this wants their own
                day first, and a college-wide grid is not that. */}
            <button onClick={() => setScope({ type: "all", ids: [], labels: [] })}
              className="mt-2 w-full rounded-lg px-2.5 py-1.5 text-xs font-bold text-white"
              style={{ background: NAVY }}>
              Show every class in the college
            </button>
          </>
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
    </>
  );

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

      {/* `relative` so the drawer below can be positioned against THIS box rather than
          the viewport. `position: fixed` was the obvious choice and is wrong here: the
          admin console animates its views with a transform, and a transformed ancestor
          becomes the containing block for fixed descendants — which is exactly how the
          event detail card ended up half off the left edge of a phone. Anchoring the
          drawer to the region it covers is also the more honest description: it hides
          the timetable, not the application bar above it. */}
      <div ref={bodyRef} className="relative flex min-h-0 flex-1">
        {/* ------------------------------------------------------ sidebar -- */}
        {sidebar && inlineSidebar && (
          <aside className="w-[330px] shrink-0 overflow-y-auto border-r" style={{ background: TT.sidebar, borderColor: TT.rule }}>
            {sidebarBody}
          </aside>
        )}

        {/* THE SAME SIDEBAR, OVER THE GRID INSTEAD OF BESIDE IT.
            One `sidebarBody` rendered in two frames rather than two copies of the
            markup: the View picker, the mini month and the magnifier are the only way
            to change the view or look up a room, and a second copy is how a control
            gets added to one of them and not the other. The reason it is a drawer
            rather than a narrower column is that there is no narrower column — a mini
            month calendar has seven columns and a floor of its own. */}
        {sidebar && !inlineSidebar && (
          <>
            <div className="absolute inset-0 z-40 bg-slate-900/40" onClick={() => setSidebar(false)} aria-hidden="true" />
            <aside className="absolute inset-y-0 left-0 z-50 w-[min(330px,86vw)] overflow-y-auto shadow-2xl" style={{ background: TT.sidebar }}>
              <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: TT.rule }}>
                <p className="flex-1 text-[13px] font-bold uppercase tracking-wide text-slate-500">Timetable options</p>
                <button onClick={() => setSidebar(false)} aria-label="Close sidebar" className="rounded p-1 text-slate-500 hover:bg-slate-100"><X size={18} /></button>
              </div>
              {sidebarBody}
            </aside>
          </>
        )}

        {/* --------------------------------------------------- main pane -- */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Navigation strip.
              FOLDS AS ONE PIECE, NOT SIX. Everything here was a direct child of one
              `flex-wrap` row, so a narrow pane wrapped it wherever it happened to run
              out: "Today ⟪ ‹ 8 Sept 2026 ›" on the first line and a lone "⟫" on the
              second, with the forward arrows separated from the date they move and
              from each other. The four arrows and the label they move are one control,
              so they now live in one non-wrapping group that folds intact and centres
              itself on its own line, and the label truncates (min-w-0) instead of
              forcing the fold in the first place. */}
          <div className="flex shrink-0 flex-wrap items-center gap-x-1 gap-y-1.5 px-3 py-2" style={{ background: TT.strip }}>
            <button onClick={() => setAnchor(today)}
              className="shrink-0 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-50">Today</button>
            <div className="flex min-w-0 flex-1 items-center justify-center gap-0.5">
              <button onClick={() => setAnchor((a) => shiftAnchor(view, a, -1, true))} aria-label="Jump back" className="shrink-0 rounded p-1.5 text-slate-600 hover:bg-slate-200"><ChevronsLeft size={18} /></button>
              <button onClick={() => setAnchor((a) => shiftAnchor(view, a, -1))} aria-label="Previous" className="shrink-0 rounded p-1.5 text-slate-600 hover:bg-slate-200"><ChevronLeft size={18} /></button>
              <p className="min-w-0 flex-1 truncate px-1 text-center text-[15px] font-medium text-slate-700" style={{ maxWidth: 220 }}>{RANGE_LABEL(view, from, to)}</p>
              <button onClick={() => setAnchor((a) => shiftAnchor(view, a, 1))} aria-label="Next" className="shrink-0 rounded p-1.5 text-slate-600 hover:bg-slate-200"><ChevronRight size={18} /></button>
              <button onClick={() => setAnchor((a) => shiftAnchor(view, a, 1, true))} aria-label="Jump forward" className="shrink-0 rounded p-1.5 text-slate-600 hover:bg-slate-200"><ChevronsRight size={18} /></button>
            </div>
            {/* The magnifier follows the sidebar rather than the device: wherever the
                sidebar is a drawer, the one inside it is behind a hamburger, and
                "look up a room" is the thing a reader most often wants without
                opening anything. Shown for the drawer, not only for a handset. */}
            {!inlineSidebar && (
              <button onClick={() => setPicker(true)} aria-label="Select timetables" className="shrink-0 rounded p-1.5 text-slate-600 hover:bg-slate-200"><Search size={18} /></button>
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

            {/* SAID ONLY WHEN THERE IS SOMEWHERE REAL TO SEND THEM.
                `nearest` is set only after a probe actually found a class, so this
                cannot become the banner that appears on every empty week and is
                therefore read by nobody. A reader with genuinely no classes at all
                still sees the plain empty grid, which is the honest answer for them. */}
            {!busy && !events.length && nearest && (
              <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900 ring-1 ring-sky-200">
                <CalendarDays size={16} className="shrink-0 text-sky-600" />
                <span className="font-semibold">Nothing in this {view}.</span>
                <span>
                  Your {nearest.direction === "next" ? "next" : "last"} class {nearest.direction === "next" ? "is" : "was"}{" "}
                  {new Date(`${nearest.date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}.
                </span>
                {/* The date is not merely stated, it is a way to get there. Telling
                    somebody where their class is and leaving them to find it with the
                    arrows is half an answer. */}
                <button onClick={() => setAnchor(nearest.date)}
                  className="ml-auto rounded-lg bg-sky-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-sky-700">
                  Go to it
                </button>
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
        // The panel is ~460 wide and ~340 tall. Placed naively to the right of and below
        // the tile it would fall off the screen for anything on Friday or after lunch, so
        // each axis independently chooses the side with room. Clamped as well, because a
        // tile near a corner can leave neither side comfortable.
        // A HANDSET GETS THE SHEET WHATEVER THE TILE REPORTED, and this is a fix
        // rather than a tidy-up. The comment on `anchorRect` said it was null on a
        // handset — true of the List view, whose rows call onSelectEvent with no rect,
        // and false of the Day and Month grids, which are still drawn as grids on a
        // phone and whose tiles always pass one. So tapping a class on a phone took the
        // anchored branch and placed a 320px card against a 390px screen; worse, the
        // admin console animates its views with a transform, and a transformed ancestor
        // becomes the containing block for `position: fixed`, so the clamp against
        // window.innerWidth was clamping to the wrong box entirely and the card landed
        // half off the left edge. The device decides this, not the caller.
        // ONE CONSTANT, used both to place the panel and to size it. 320 → 380 → 460.
        //
        // The panel is almost entirely names, and every row of it wraps rather than
        // truncates, so width is the only lever that puts a line back on one line. 460
        // is measured against the longest thing that actually appears rather than picked
        // for roundness: the module row carries "CODE — Full Module Name" (about 38
        // characters for a real one, e.g. CMP701 — Machine Learning Foundations) and the
        // room row carries "101 - First floor [Campus]". At 14px both clear the ~400px
        // of text width this leaves after the icon, the gap and px-4 either side.
        //
        // Not wider than that. The card is anchored BESIDE a tile, and every pixel of it
        // is a pixel of the grid it covers — past roughly a third of the viewport it
        // stops being a detail panel and starts being a dialog that happens to be
        // off-centre. Anything longer than the widths above still wraps, which is the
        // right failure: truncation would hide the end of a lecturer's name.
        //
        // It stays a single number because the flip-and-clamp maths below reserves room
        // for exactly this width. A card sized in the JSX and measured here would land
        // off-screen the moment the two drifted apart.
        const MAX_W = 460, H = 340, GAP = 10;
        const rect = handset ? null : anchorRect;
        let style = { position: "fixed", left: 16, right: 16, bottom: 0 };   // handset default
        if (rect) {
          const vw = window.innerWidth, vh = window.innerHeight;
          // CAPPED BY THE VIEWPORT, because the sheet does not catch every narrow case.
          // The handset query is max-width 640, so a 641px window takes THIS branch —
          // and a flat 460 there would be 72% of the screen with no way to clamp it back,
          // since the clamp below only moves the card, it never narrows it. Taking the
          // smaller of the two makes the ideal width an ideal rather than a promise.
          const W = Math.min(MAX_W, vw - 32);
          const left = rect.right + GAP + W < vw ? rect.right + GAP
                     : rect.left - GAP - W > 0 ? rect.left - GAP - W
                     : Math.max(8, Math.min(vw - W - 8, rect.left));
          const top = Math.max(8, Math.min(vh - H - 8, rect.top));
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
                {/* LOCATION IN THE ORDER SOMEBODY TRAVELS IT: site, then floor, then
                    door. roomLabel() reads "101 - First floor [Harrow]", which is the
                    reverse — the room number first and the building last, in brackets,
                    where it is least likely to be read. Somebody deciding whether they
                    can get there in ten minutes needs the campus first.

                    Two rows rather than one long string, so each fact is scannable on
                    its own. Each appears only if it is known: an event with no room has
                    no location to state, and inventing "—" for the floor of a room
                    nobody recorded one for would read as a fact. */}
                {selected.campus && <Row icon={Building2}>{selected.campus}</Row>}
                {(() => {
                  const parts = [
                    selected.roomFloor,
                    selected.roomName ? `Room ${selected.roomName}` : null,
                  ].filter(Boolean);
                  // Falls back to the whole label for an API not yet redeployed with the
                  // two new fields, so this degrades to what it showed before rather
                  // than to nothing at all.
                  const text = parts.length ? parts.join(" · ") : selected.room;
                  return text ? <Row icon={MapPin}>{text}</Row> : null;
                })()}
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
