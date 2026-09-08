// The timetable grid itself — Day, Week, Month, Timeline and List.
//
// PRESENTATIONAL ONLY. It takes events and settings and draws them; it fetches
// nothing and owns no data. That is what lets the same component serve the staff
// screen and the administrator's planner without either growing a copy of the other's
// loading, error and refresh logic — and it is why the two containers can differ in
// everything except how a timetable looks.
//
// IT IS ALSO MEASURED RATHER THAN GUESSED, and that is the second reason it is one
// component. The same grid is drawn into a ~1040px pane on a laptop, a ~550px pane on
// a tablet beside the admin console's nav, and the full 390px of a phone inside the
// Capacitor shell. A tile cannot decide what to print from a media query, because the
// viewport is not what it is being drawn into — the pane is, and the pane's width
// depends on a sidebar this file knows nothing about. So each grid measures its own
// scroller (`useScrollBox`) and hands every tile the pixels it actually has. A media
// query would have been wrong in exactly the case that matters: the tablet, where the
// viewport is roomy and the pane is not.
//
// NOTHING HERE CHANGES WHAT A VIEW MEANS. The half-open overlap rule, layoutDay's
// lanes, the "now" line and placeEvent's clipping are untouched; what changed is how
// much of a tile's text survives the space it was given, and whether the reader can
// tell there is more grid off the right-hand edge.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, Clock3, MoveHorizontal } from "lucide-react";
import {
  windowFor, datesIn, isoDay, placeEvent, colourOf, annotationLines, changedWithin, minutes, layoutDay,
} from "./timetableView";
import { NAVY, alpha } from "./branding";
import { TT } from "./timetableTheme";
import { useIsHandset } from "./PhoneShell";

const DAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const dayLabel = (d) => {
  const dt = new Date(`${d}T00:00:00Z`);
  return `${DAY_SHORT[isoDay(d)]} ${dt.getUTCDate()} ${dt.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}`;
};

// The hour gutter, in pixels. Named rather than left as `w-14` in two places because
// the minimum grid width is arithmetic that includes it, and a gutter that is 56px in
// the layout and 64px in the sum is a grid that scrolls by eight pixels for ever.
const GUTTER = 56;

/**
 * The width a scroller HAS, and how far along it is, kept in state.
 *
 * WHY MEASURED AND NOT A BREAKPOINT: see the file header. The number that decides
 * whether a tile can carry five lines is the width of the pane, and the pane is
 * narrowed by a sidebar, an admin nav rail and a phone frame that this component
 * cannot see from a media query.
 *
 * The identity check on the way into setState is load-bearing: a ResizeObserver that
 * fires on every paint with an equal-but-new object re-renders the whole grid for
 * ever, and a grid that re-renders for ever is one that cannot be dragged on.
 */
function useScrollBox(ref) {
  const [box, setBox] = useState({ client: 0, scroll: 0, left: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => setBox((prev) => {
      const next = { client: el.clientWidth, scroll: el.scrollWidth, left: el.scrollLeft };
      return prev.client === next.client && prev.scroll === next.scroll && prev.left === next.left ? prev : next;
    });
    read();
    el.addEventListener("scroll", read, { passive: true });
    // ResizeObserver is in every browser this ships to (and in the Capacitor WebView),
    // but the guard costs a line and a missing observer must degrade to "measured once"
    // rather than to a blank grid.
    let ro;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(read);
      ro.observe(el);
      // The CONTENT too, not only the box: switching Day → Week changes scrollWidth
      // without changing clientWidth, and the "there is more to the right" hint has to
      // appear for that.
      if (el.firstElementChild) ro.observe(el.firstElementChild);
    }
    return () => { if (ro) ro.disconnect(); el.removeEventListener("scroll", read); };
  }, [ref]);
  return box;
}

/**
 * A horizontal scroller whose overflow is ANNOUNCED rather than discovered.
 *
 * A seven-day week genuinely does not fit a phone, and squeezing it until it does
 * produces columns narrower than a word — so the columns keep a floor and the grid
 * scrolls. That decision is fine; the failure was that nothing on screen said so. A
 * reader looking at Monday to Wednesday with no scrollbar in sight (iOS draws none
 * until you move) concludes the week has three days in it.
 *
 * Two affordances, because neither alone is enough: a line of text naming the
 * direction, which a screen reader also gets, and a fade at the edge that still has
 * content behind it, which is what makes it look scrollable at a glance. Both appear
 * only when there IS more — a permanent "scroll sideways" on a grid that fits is
 * noise, and noise is how a real hint gets ignored.
 *
 * `children` is a function of the measured client width: the caller needs it to size
 * tiles, and passing the measurement down beats every child measuring separately.
 */
function HScroll({ minWidth, hint, children }) {
  const ref = useRef(null);
  const box = useScrollBox(ref);
  const more = box.scroll - box.client - box.left > 1;
  const back = box.left > 1;

  return (
    <div>
      {(more || back) && hint && (
        <p className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-slate-400">
          <MoveHorizontal size={12} /> {hint}
        </p>
      )}
      <div className="relative">
        <div ref={ref} className="overflow-x-auto">
          <div style={{ minWidth }}>{children(box.client)}</div>
        </div>
        {/* Pointer-events off, or the fade would eat clicks on the last column's
            tiles — which are exactly the tiles a reader has just scrolled to reach. */}
        {more && <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-white via-white/70 to-transparent" />}
        {back && <div className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-white via-white/60 to-transparent" />}
      </div>
    </div>
  );
}

/**
 * HOW MANY LINES A TILE MAY PRINT, from the space it was actually given.
 *
 * A tile at 85px was printing the time, the title, the module, the category, the room,
 * the staff and the group — seven lines, every one of them truncated to two or three
 * characters plus an ellipsis. That is not a denser view of the same information, it
 * is the absence of information taking up the room where information would go. Fewer
 * lines, each readable, is strictly better: the rest is one click away in the detail
 * panel, and the tooltip already carries the title, room and time in full.
 *
 * The width ladder is deliberately coarse. It exists to answer "roughly how many
 * words fit", and a continuous function of width would make a tile gain and lose its
 * fourth line as the window is dragged, which reads as a fault.
 *
 * Zero is a real answer. Below ~44px a tile cannot hold one legible word, and three
 * classes clashing at 09:00 in a narrow column produce exactly that. A bare coloured
 * bar there is honest — it still shows THAT the clash exists, which is the thing
 * somebody needs to see — where a column of single letters shows nothing at all and
 * looks like a rendering fault. The tooltip and the aria-label keep it reachable.
 */
function rowBudget(width, height) {
  const byWidth = width == null ? 99
    : width >= 140 ? 99
    : width >= 100 ? 3
    : width >= 72 ? 2
    : width >= 44 ? 1
    : 0;
  // 13px a line matches text-[10px]/text-[11px] at leading-tight; 8px is py-1 twice.
  const byHeight = height == null ? 99 : Math.max(0, Math.floor((height - 8) / 13));
  return Math.min(byWidth, byHeight);
}

/** One event, drawn as a coloured tile. Shared by every view so they cannot drift. */
function EventTile({ event, settings, today, onSelect, selected, style, compact, width, height }) {
  const colour = colourOf(event, settings.colourBy);
  const lines = annotationLines(event, settings.annotations);
  const recent = changedWithin(event, settings.highlightChangedDays, today);
  // "light" repaints the tile as a tint with dark text. On a dense week grid the
  // solid variant is a wall of colour that makes the text the hard part to read,
  // which is the whole reason the source system offers the choice.
  const light = settings.colourVariant === "light";

  // WHAT SURVIVES A SMALL TILE, chosen by priority and then drawn in the reference's
  // order. Two separate orders on purpose: the reader expects the time above the
  // title, but if only one row fits it is the TITLE that has to be it — a tile
  // reading "09:00–12:00" and nothing else says nothing the gutter has not already
  // said. Draft outranks the time and every annotation after the first, because on
  // the planner "this is not published yet" is the single fact a narrow tile most
  // has to carry; dropping it silently would have somebody publish a week believing
  // they already had.
  const budget = rowBudget(width, height);
  const candidates = [];
  if (settings.showEventTimes && !compact) candidates.push({ key: "time", rank: 2, node: <p className="text-[10px] font-semibold opacity-80">{event.start}–{event.end}</p> });
  lines.forEach((l, i) => candidates.push({
    key: `l${i}`, rank: i === 0 ? 0 : 3 + i,
    node: <p className={`truncate ${i === 0 ? "text-[11px] font-bold leading-tight" : "text-[10px] leading-tight opacity-85"}`}>{l}</p>,
  }));
  if (settings.showEventId) candidates.push({ key: "id", rank: 90, node: <p className="truncate text-[9px] opacity-60">{event.id}</p> });
  if (!event.published) candidates.push({ key: "draft", rank: 1, node: <p className="text-[9px] font-bold uppercase tracking-wide opacity-90">Draft</p> });

  const keep = new Set([...candidates].sort((a, b) => a.rank - b.rank).slice(0, budget).map((c) => c.key));
  const shown = candidates.filter((c) => keep.has(c.key));

  const description = `${event.title}${event.room ? ` · ${event.room}` : ""} · ${event.start}-${event.end}`;
  return (
    <button
      type="button"
      // THE TILE'S POSITION TRAVELS WITH THE EVENT, as a second argument.
      //
      // A reader needs the detail panel beside the thing they pressed. Without the
      // rect the only place a container can put it is a fixed corner of the screen,
      // which is what My Timetable was doing: click Monday morning, read the answer
      // in the bottom right, look back up to check you had the right class.
      //
      // Passed rather than looked up by id afterwards, because the tile is the only
      // thing that knows where it was drawn — layoutDay may have put it in any lane.
      // Callers that do not want it (the planner opens a modal) simply ignore it.
      onClick={(domEvent) => onSelect?.(event, domEvent.currentTarget.getBoundingClientRect())}
      style={{
        ...style,
        background: light ? alpha(colour, 14) : colour,
        color: light ? "#0f172a" : "#fff",
        borderLeft: `3px solid ${colour}`,
        // A changed event is ringed rather than recoloured: recolouring would fight
        // the colour key, which is answering a different question.
        boxShadow: recent ? "0 0 0 2px #f59e0b" : undefined,
      }}
      // `flex flex-col justify-start` only to defeat the user-agent stylesheet, which
      // vertically centres a button's content. Harmless while a tile printed six lines
      // and filled itself; now that a three-hour class prints two, those two lines sat
      // in the middle of a 156px block with the start time nowhere near the row it
      // starts on. A tile is a bar on a time axis and its text belongs at its top edge.
      // (The month view passes `display: block` inline, which wins over this and is
      // already top-aligned — block layout stacks from the top.)
      className={`flex flex-col justify-start overflow-hidden rounded-md px-1.5 py-1 text-left transition hover:brightness-110 ${selected ? "ring-2 ring-offset-1" : ""}`}
      title={description}
      // A tile too narrow to print anything is still a control that has to name
      // itself, and it is the ONLY thing naming that class on screen.
      aria-label={description}
    >
      {shown.map((c) => <React.Fragment key={c.key}>{c.node}</React.Fragment>)}
    </button>
  );
}

function EmptyGrid({ msg }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white/60 py-16 text-center">
      <CalendarDays size={28} className="mb-2 text-slate-300" />
      <p className="text-sm font-semibold text-slate-500">{msg}</p>
    </div>
  );
}

/* ------------------------------------------------------- day / week grid -- */

// THE NARROWEST A DAY COLUMN IS ALLOWED TO GET, and the number is a compromise that
// is worth stating rather than tuning.
//
// It used to be a flat `min-w-[640px]` on the whole grid, which is wrong at both ends.
// A DAY view — one column — was forced to 640px and therefore scrolled sideways on a
// phone for no reason at all: there was nothing off the edge to reach. A five-day week
// with the weekend switched off got the same 640 as a seven-day one. The floor belongs
// to the COLUMN, and the grid's minimum is arithmetic: gutter + columns.
//
// 80px is what a column needs to show "09:00–12:00" above a truncated title, and it is
// also, not by coincidence, the largest floor that lets a seven-day week fit the ~640px
// pane a 1280 laptop gives this grid beside the sidebar. A wider floor reads better in
// isolation and would put a horizontal scrollbar on the commonest desktop screen there
// is, which is the trade the other way round.
const MIN_COL = 80;

function ColumnGrid({ dates, events, settings, today, onSelectEvent, selectedId, onCreateAt }) {
  const periods = settings.periods || [];

  // WHAT THE POINTER IS DOING RIGHT NOW: { date, from, to } while a drag is in
  // progress, null otherwise. One piece of state rather than three, because a drag
  // that has a date but no rows is not a state this grid can be in.
  const [drag, setDrag] = useState(null);
  const byDate = useMemo(() => {
    const m = new Map();
    for (const e of events) { if (!m.has(e.date)) m.set(e.date, []); m.get(e.date).push(e); }
    return m;
  }, [events]);

  // A fixed pixel height per period, not a percentage of the viewport: an hour must
  // look like an hour whether the reader has four periods switched on or twelve.
  const ROW_H = 52;
  const bodyH = Math.max(periods.length * ROW_H, ROW_H);

  // WHERE "NOW" FALLS IN THE GRID, as a percentage — or null when the current time is
  // outside the periods this reader has switched on, in which case no line is drawn
  // rather than one pinned to an edge, which would be a lie about the time.
  //
  // Ticked once a minute. A value computed only at mount is right for sixty seconds and
  // then quietly wrong for the rest of the day, which is worse than not drawing it.
  const [nowMin, setNowMin] = useState(() => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); });
  useEffect(() => {
    const t = setInterval(() => { const n = new Date(); setNowMin(n.getHours() * 60 + n.getMinutes()); }, 60000);
    return () => clearInterval(t);
  }, []);
  const nowPct = (() => {
    if (!periods.length) return null;
    const from = minutes(periods[0].start);
    const to = minutes(periods[periods.length - 1].end);
    if (!(nowMin > from && nowMin < to)) return null;
    return ((nowMin - from) / (to - from)) * 100;
  })();

  const minWidth = GUTTER + dates.length * MIN_COL;

  return (
    <HScroll
      minWidth={minWidth}
      hint={dates.length > 1 ? "Scroll sideways for the other days" : "Scroll sideways to see the whole day"}
    >
      {(client) => {
        // The width one column actually gets, and from it the width of ONE TILE inside
        // it — which is what decides how much text survives. `lanes` divides it because
        // three classes clashing at 09:00 each get a third of the column, and a tile
        // that thinks it is 90px wide when it is 30 prints six lines of ellipses.
        const colW = Math.max(MIN_COL, (Math.max(client, minWidth) - GUTTER) / Math.max(dates.length, 1));
        return (
          <>
            {/* Day headers */}
            <div className="flex border-b" style={{ borderColor: TT.grid }}>
              {/* Sticky, and white, for the same reason the gutter below it is: it is
                  the corner of a fixed rail, and a transparent corner lets Friday's
                  heading slide underneath the hour labels. */}
              <div className="sticky left-0 z-20 shrink-0 bg-white" style={{ width: GUTTER }} />
              {dates.map((d) => (
                <div key={d} className="flex-1 border-l px-2 py-1.5 text-center text-[12px]" style={{ borderColor: TT.grid, color: d === today ? TT.todayText : "#64748b" }}>
                  {dayLabel(d)}
                </div>
              ))}
            </div>
            {/* The drag ends wherever the button comes up, including outside the column
                it started in — releasing over the gutter or off the grid would otherwise
                leave the selection stuck to the pointer for ever. */}
            <div
              className="flex"
              style={{ height: bodyH }}
              onMouseUp={() => {
                if (!drag || !onCreateAt) { setDrag(null); return; }
                const a = Math.min(drag.from, drag.to);
                const b = Math.max(drag.from, drag.to);
                setDrag(null);
                if (periods[a] && periods[b]) onCreateAt(drag.date, periods[a].start, periods[b].end);
              }}
              onMouseLeave={() => setDrag(null)}
            >
              {/* Hour gutter.
                  STICKY, BECAUSE A TIME COLUMN THAT SCROLLS AWAY IS NOT A TIME COLUMN.
                  Once a seven-day week is wider than its pane the reader scrolls to
                  Thursday and the hour labels go with Monday, leaving a wall of coloured
                  rectangles with nothing to read them against — the one thing a grid is
                  for. It is the axis, so it stays; the columns are what move past it.
                  Opaque and above the tiles (z-20) or the events slide under it in
                  ghostly halves. */}
              <div
                className="sticky left-0 z-20 shrink-0 bg-white"
                style={{ width: GUTTER, borderRight: `1px solid ${TT.grid}` }}
              >
                {periods.map((p) => (
                  <div key={p.start} style={{ height: ROW_H, borderColor: TT.grid }} className="border-b pr-1 text-right text-[11px] text-slate-500">
                    {p.start}
                  </div>
                ))}
              </div>
              {dates.map((d) => (
                <div key={d} className="relative flex-1 border-l" style={{ borderColor: TT.grid, background: d === today ? TT.cellNow : TT.cell }}>
                  {/* Uniform cells with a thin rule per period. An alternating band was tried and
                      removed: the reference draws one flat wash, and the stripes read as
                      meaning something when they mean nothing. */}
                  {/* EMPTY SPACE IS NOW THE PRIMARY WAY TO CREATE A CLASS.
                      Before this the only interaction on the grid was clicking an event
                      that already existed: to add one you left the calendar, pressed New
                      event, and typed the date and time you had just been looking at.
                      Every calendar a person has ever used lets them press the slot they
                      mean, so the grid read as a picture of a timetable rather than a
                      timetable. Click one row for that period; drag down for several. */}
                  {periods.map((p, pi) => {
                    const inDrag = drag && drag.date === d && pi >= Math.min(drag.from, drag.to) && pi <= Math.max(drag.from, drag.to);
                    return (
                      <div
                        key={p.start}
                        onMouseDown={() => onCreateAt && setDrag({ date: d, from: pi, to: pi })}
                        onMouseEnter={() => drag && drag.date === d && setDrag((x) => ({ ...x, to: pi }))}
                        style={{
                          height: ROW_H,
                          borderColor: TT.grid,
                          background: inDrag ? alpha(NAVY, 22) : undefined,
                          cursor: onCreateAt ? "cell" : undefined,
                        }}
                        className={`border-b transition-colors ${onCreateAt && !inDrag ? "hover:bg-white/45" : ""}`}
                      />
                    );
                  })}

                  {/* THE TIME NOW, on today only. A week grid with no marker makes
                      "what is on at the moment" a counting exercise against the gutter. */}
                  {d === today && nowPct !== null && (
                    <div className="pointer-events-none absolute left-0 right-0" style={{ top: `${nowPct}%` }}>
                      <div className="h-px w-full" style={{ background: "#e11d48" }} />
                      <div className="absolute -left-1 -top-1 h-2 w-2 rounded-full" style={{ background: "#e11d48" }} />
                    </div>
                  )}
                  {/* SIDE BY SIDE WHEN THEY SHARE AN HOUR.
                      Every tile used to be `left: 2, right: 2` — the full width of the
                      column — so a second class at the same time was drawn exactly over the
                      first and the two titles interleaved into doubled, unreadable text.
                      A merged class, a module taught to two groups, and a genuine
                      double-booking all produce that, and the double-booking is the one
                      somebody most needs to SEE rather than have hidden underneath.
                      layoutDay works out the lanes; back-to-back classes stay full width. */}
                  {layoutDay(byDate.get(d) || []).map(({ event: e, lane, lanes }) => {
                    const pos = placeEvent(e, periods);
                    // Null means the event falls entirely outside the periods this
                    // reader has switched on. Not drawn, and not clamped to the edge —
                    // see placeEvent.
                    if (!pos) return null;
                    // Percentages, so the columns hold at any width; the 2px inset is taken
                    // off each tile rather than off the column, so neighbours never touch.
                    const w = 100 / lanes;
                    return (
                      <EventTile
                        key={e.id} event={e} settings={settings} today={today}
                        onSelect={onSelectEvent} selected={selectedId === e.id}
                        // The same percentages, resolved to pixels, so the tile can
                        // decide what it has room to say. Positioning stays in
                        // percentages: the measurement is one frame behind a resize and
                        // a tile placed from it would visibly lag the column it is in.
                        width={colW / lanes - 4}
                        height={(bodyH * pos.heightPct) / 100}
                        style={{
                          position: "absolute",
                          top: `${pos.topPct}%`, height: `${pos.heightPct}%`,
                          left: `calc(${lane * w}% + 2px)`, width: `calc(${w}% - 4px)`,
                        }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </>
        );
      }}
    </HScroll>
  );
}

/* ------------------------------------------------------------ month view -- */

// A month cell holds a date number and a stack of tiles, so it can be narrower than a
// day column in the week grid before it stops meaning anything — but not much.
const MIN_MONTH_COL = 78;

function MonthGrid({ dates, events, settings, today, onSelectEvent, selectedId, anchor }) {
  const month = anchor.slice(0, 7);
  const byDate = useMemo(() => {
    const m = new Map();
    for (const e of events) { if (!m.has(e.date)) m.set(e.date, []); m.get(e.date).push(e); }
    return m;
  }, [events]);
  const cols = new Set(dates.map(isoDay)).size || 7;
  const minWidth = cols * MIN_MONTH_COL;

  // WHICH WEEKDAY EACH COLUMN IS, taken from the first row of real dates rather than
  // assumed to be Monday-first. The reader can switch weekdays off, so a fixed
  // Mon-Sun caption would mislabel every column of a five-day month.
  const heads = dates.slice(0, cols);

  return (
    <HScroll minWidth={minWidth} hint="Scroll sideways for the rest of the week">
      {(client) => {
        const cellW = Math.max(MIN_MONTH_COL, Math.max(client, minWidth) / cols);
        return (
          <div className="grid gap-px" style={{ background: TT.grid, gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}>
            {/* THE WEEKDAY CAPTION, which the month grid did not have at all.
                Tolerable while the whole month fitted on screen and the shape of the
                weeks gave it away; useless on a phone, where the grid is scrolled and
                the reader is looking at four unlabelled columns somewhere in the middle
                of a week with no way to tell Tuesday from Saturday. */}
            {heads.map((d) => (
              <div key={`h${d}`} className="px-1 py-1 text-center text-[10px] font-bold uppercase tracking-wide text-slate-500" style={{ background: TT.cellAlt }}>
                {DAY_SHORT[isoDay(d)]}
              </div>
            ))}
            {dates.map((d) => {
              const inMonth = d.slice(0, 7) === month;
              const list = byDate.get(d) || [];
              return (
                <div key={d} className={`min-h-[92px] p-1 ${d === today ? "ring-2 ring-inset ring-sky-400" : ""}`} style={{ background: inMonth ? TT.cell : TT.cellAlt }}>
                  {/* Days outside the anchored month are dimmed rather than blank — the
                      grid is whole weeks, and an empty cell reads as "no classes" when
                      it actually means "not this month". */}
                  <p className={`mb-1 text-[10px] font-bold ${inMonth ? "text-slate-500" : "text-slate-300"}`}>
                    {new Date(`${d}T00:00:00Z`).getUTCDate()}
                  </p>
                  <div className="space-y-0.5">
                    {list.slice(0, 3).map((e) => (
                      <EventTile key={e.id} event={e} settings={settings} today={today} compact
                        onSelect={onSelectEvent} selected={selectedId === e.id}
                        // Only the width is a constraint here: a month tile grows to fit
                        // whatever it prints, so a height budget would be inventing a
                        // limit that does not exist. The width is real, and at ~78px it
                        // is what stops six annotation lines of ellipses per class.
                        width={cellW - 10}
                        style={{ display: "block", width: "100%" }} />
                    ))}
                    {list.length > 3 && <p className="pl-1 text-[10px] font-semibold text-slate-400">+{list.length - 3} more</p>}
                  </div>
                </div>
              );
            })}
          </div>
        );
      }}
    </HScroll>
  );
}

/* --------------------------------------------------------- timeline view -- */

function TimelineGrid({ dates, events, settings, today, onSelectEvent, selectedId }) {
  const periods = settings.periods || [];
  const gridStart = periods.length ? minutes(periods[0].start) : 0;
  const gridEnd = periods.length ? minutes(periods[periods.length - 1].end) : 1440;
  const span = Math.max(gridEnd - gridStart, 1);

  const byDate = useMemo(() => {
    const m = new Map();
    for (const e of events) { if (!m.has(e.date)) m.set(e.date, []); m.get(e.date).push(e); }
    return m;
  }, [events]);

  // HOW WIDE THE TIMELINE IS, from the TIME it shows — not from the number of days.
  //
  // It used to be `dates.length * 260`, and days are ROWS here: a fortnight therefore
  // asked for 3,640px of horizontal space to draw a twelve-hour axis, so every reader
  // on every screen scrolled through nine screenfuls of a band that was mostly empty.
  // The axis is the horizontal thing, so the axis is what sizes it: about 48px an hour,
  // with a floor so a college with two periods switched on still gets a usable strip.
  const HOUR_W = 48;

  // Time runs left to right and each day is a band. This is the view for "when is
  // this room free across a fortnight", which the day columns answer badly.
  return (
    <TimelineBody
      span={span} gridStart={gridStart} gridEnd={gridEnd} hourWidth={HOUR_W}
      dates={dates} byDate={byDate} settings={settings} today={today}
      onSelectEvent={onSelectEvent} selectedId={selectedId}
    />
  );
}

/**
 * The timeline's body.
 *
 * Split out of TimelineGrid rather than wrapped in `HScroll` because this view's
 * minimum width depends on a measurement of ITSELF: the day-label column narrows on a
 * phone, and the minimum width is `label + hours`. A render-prop scroller cannot feed
 * a measurement back into the minWidth it was given, so this one owns its own scroller
 * and repeats the (small) hint and fade rather than pretending the dependency is not
 * circular.
 */
function TimelineBody({ span, gridStart, gridEnd, hourWidth, dates, byDate, settings, today, onSelectEvent, selectedId }) {
  // The day label column. Narrower on a phone, because 112px of "Mon 7 Sep" is 29% of
  // a 390px screen spent on a caption that reads perfectly well at 84.
  const ref = useRef(null);
  const box = useScrollBox(ref);
  const LABEL = box.client && box.client < 560 ? 84 : 112;
  const hours = span / 60;
  const minWidth = LABEL + Math.max(Math.round(hours * hourWidth), 360);
  const bandW = Math.max(box.client, minWidth) - LABEL;

  // AN HOUR AXIS, which this view did not have in any form. Time was the horizontal
  // dimension and nothing said what any horizontal position meant, so "is this room
  // free on Thursday afternoon" — the question the view exists for — could only be
  // answered by reading the times printed inside the tiles, which is the day grid's
  // job done worse. Ticks are thinned rather than crowded when the band is narrow: two
  // legible labels beat twelve overlapping ones.
  const step = bandW / Math.max(hours, 1) >= 34 ? 60 : bandW / Math.max(hours, 1) >= 18 ? 120 : 180;
  const ticks = [];
  for (let m = Math.ceil(gridStart / step) * step; m <= gridEnd; m += step) {
    ticks.push({ m, pct: ((m - gridStart) / span) * 100, label: `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}` });
  }

  const more = box.scroll - box.client - box.left > 1;
  const back = box.left > 1;

  return (
    <div>
      {(more || back) && (
        <p className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-slate-400">
          <MoveHorizontal size={12} /> Scroll sideways for later in the day
        </p>
      )}
      <div className="relative">
        <div ref={ref} className="overflow-x-auto">
          <div style={{ minWidth }}>
            {/* The axis. Its spacer is sticky for the same reason the day grid's hour
                gutter is: the labels down the left are the other axis, and an axis that
                slides away leaves coloured bars floating against nothing. */}
            <div className="flex items-stretch border-b" style={{ borderColor: TT.grid }}>
              <div className="sticky left-0 z-20 shrink-0 bg-white" style={{ width: LABEL }} />
              <div className="relative h-6 flex-1">
                {ticks.map((t) => (
                  // Centred on its rule, EXCEPT at the two ends, where half of a
                  // centred label falls outside the band and gets clipped by the
                  // scroller — the first label read "00" and the last one vanished,
                  // which are the two an axis can least afford to lose.
                  <span
                    key={t.m}
                    className="absolute top-1 text-[10px] tabular-nums text-slate-400"
                    style={{ left: `${t.pct}%`, transform: t.pct < 2 ? "none" : t.pct > 98 ? "translateX(-100%)" : "translateX(-50%)" }}
                  >
                    {t.label}
                  </span>
                ))}
              </div>
            </div>
            {dates.map((d) => (
              <div key={d} className="flex items-stretch border-b border-slate-100">
                <div
                  className={`sticky left-0 z-20 shrink-0 bg-white px-2 py-2 text-[11px] font-bold ${d === today ? "text-sky-600" : "text-slate-500"}`}
                  style={{ width: LABEL }}
                >
                  {dayLabel(d)}
                </div>
                <div className="relative h-11 flex-1 bg-white">
                  {/* The axis, repeated as faint rules. Without them a tile two-thirds of
                      the way along a 700px band cannot be read against a caption at the
                      top of the screen. */}
                  {ticks.map((t) => (
                    <div key={t.m} className="pointer-events-none absolute inset-y-0 w-px" style={{ left: `${t.pct}%`, background: TT.grid, opacity: 0.55 }} />
                  ))}
                  {(byDate.get(d) || []).map((e) => {
                    const s = Math.max(minutes(e.start), gridStart), en = Math.min(minutes(e.end), gridEnd);
                    if (en <= s) return null;
                    return (
                      <EventTile key={e.id} event={e} settings={settings} today={today} compact
                        onSelect={onSelectEvent} selected={selectedId === e.id}
                        // 38px is the band's 44 less the 3px inset top and bottom, which
                        // is two lines — so a timeline tile prints its title and at most
                        // one more thing rather than six clipped halves of lines.
                        width={((en - s) / span) * bandW - 4}
                        height={38}
                        style={{ position: "absolute", top: 3, bottom: 3, left: `${((s - gridStart) / span) * 100}%`, width: `${((en - s) / span) * 100}%` }} />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
        {more && <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-white via-white/70 to-transparent" />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- list view -- */

function ListView({ dates, events, settings, today, onSelectEvent, selectedId }) {
  const byDate = useMemo(() => {
    const m = new Map();
    for (const e of events) { if (!m.has(e.date)) m.set(e.date, []); m.get(e.date).push(e); }
    return m;
  }, [events]);
  const withAny = dates.filter((d) => (byDate.get(d) || []).length);
  if (!withAny.length) return <EmptyGrid msg="Nothing timetabled in this period." />;

  return (
    <div className="space-y-3">
      {withAny.map((d) => (
        <div key={d}>
          <p className={`mb-1 text-xs font-extrabold ${d === today ? "text-sky-600" : "text-slate-500"}`}>{dayLabel(d)}</p>
          <div className="space-y-1.5">
            {(byDate.get(d) || []).map((e) => (
              <button key={e.id} type="button" onClick={() => onSelectEvent?.(e)}
                className={`flex w-full items-stretch gap-2 overflow-hidden rounded-xl bg-white text-left shadow-sm ring-1 ring-slate-200 ${selectedId === e.id ? "ring-2" : ""}`}>
                <span className="w-1.5 shrink-0" style={{ background: colourOf(e, settings.colourBy) }} />
                {/* min-w-0 so the truncation below has something to truncate against —
                    a flex child defaults to min-content width, which on a 390px phone
                    lets a long room name push the whole row wider than the screen and
                    take the day's heading with it. The list is the phone's primary
                    view, so this is the one that had to hold. */}
                <span className="min-w-0 flex-1 py-2 pr-2">
                  <span className="flex items-center gap-1 truncate text-[11px] font-bold text-slate-400"><Clock3 size={11} className="shrink-0" /> {e.start}–{e.end}{e.room ? ` · ${e.room}` : ""}</span>
                  {annotationLines(e, settings.annotations).map((l, i) => (
                    <span key={i} className={`block truncate ${i === 0 ? "text-sm font-bold text-slate-800" : "text-xs text-slate-500"}`}>{l}</span>
                  ))}
                  {!e.published && <span className="text-[10px] font-bold uppercase tracking-wide text-amber-600">Draft</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ root -- */

export default function TimetableCalendar({ events = [], settings, view = "week", anchor, today, onSelectEvent, selectedId, onCreateAt }) {
  const handset = useIsHandset();
  const { from, to } = useMemo(() => windowFor(view, anchor), [view, anchor]);
  const dates = useMemo(() => datesIn(from, to, settings?.days, view), [from, to, settings?.days, view]);

  if (!settings) return null;

  // ON A HANDSET, THE COLUMN GRIDS BECOME A LIST. Seven columns of hour rows at
  // 390px is unreadable — the tiles are narrower than a word — and the source
  // system's own mobile presentation does the same. The reader's chosen view is not
  // overwritten, only how it draws, so rotating to a tablet restores the grid.
  //
  // Day and Month are deliberately still drawn as grids on a phone. A single day
  // column is 334px wide at 390 and reads perfectly; a month is the shape of the
  // month, and a list of five weeks is not that shape at all. Both scroll sideways
  // where they must, and say so.
  const effective = settings.layout === "list" || (handset && (view === "week" || view === "timeline")) ? "list" : view;

  if (!dates.length) return <EmptyGrid msg="No days are switched on in your settings." />;

  switch (effective) {
    case "list":     return <ListView dates={dates} events={events} settings={settings} today={today} onSelectEvent={onSelectEvent} selectedId={selectedId} />;
    case "month":    return <MonthGrid dates={dates} events={events} settings={settings} today={today} anchor={anchor} onSelectEvent={onSelectEvent} selectedId={selectedId} />;
    case "timeline": return <TimelineGrid dates={dates} events={events} settings={settings} today={today} onSelectEvent={onSelectEvent} selectedId={selectedId} />;
    default:         return <ColumnGrid dates={dates} events={events} settings={settings} today={today} onSelectEvent={onSelectEvent} selectedId={selectedId} onCreateAt={onCreateAt} />;
  }
}
