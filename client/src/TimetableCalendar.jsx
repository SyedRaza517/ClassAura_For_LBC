// The timetable grid itself — Day, Week, Month, Timeline and List.
//
// PRESENTATIONAL ONLY. It takes events and settings and draws them; it fetches
// nothing and owns no data. That is what lets the same component serve the staff
// screen and the administrator's planner without either growing a copy of the other's
// loading, error and refresh logic — and it is why the two containers can differ in
// everything except how a timetable looks.
import React, { useEffect, useMemo, useState } from "react";
import { CalendarDays, Clock3 } from "lucide-react";
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

/** One event, drawn as a coloured tile. Shared by every view so they cannot drift. */
function EventTile({ event, settings, today, onSelect, selected, style, compact }) {
  const colour = colourOf(event, settings.colourBy);
  const lines = annotationLines(event, settings.annotations);
  const recent = changedWithin(event, settings.highlightChangedDays, today);
  // "light" repaints the tile as a tint with dark text. On a dense week grid the
  // solid variant is a wall of colour that makes the text the hard part to read,
  // which is the whole reason the source system offers the choice.
  const light = settings.colourVariant === "light";
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
      className={`overflow-hidden rounded-md px-1.5 py-1 text-left transition hover:brightness-110 ${selected ? "ring-2 ring-offset-1" : ""}`}
      title={`${event.title}${event.room ? ` · ${event.room}` : ""} · ${event.start}-${event.end}`}
    >
      {settings.showEventTimes && !compact && (
        <p className="text-[10px] font-semibold opacity-80">{event.start}–{event.end}</p>
      )}
      {lines.map((l, i) => (
        <p key={i} className={`truncate ${i === 0 ? "text-[11px] font-bold leading-tight" : "text-[10px] leading-tight opacity-85"}`}>{l}</p>
      ))}
      {settings.showEventId && <p className="truncate text-[9px] opacity-60">{event.id}</p>}
      {!event.published && <p className="text-[9px] font-bold uppercase tracking-wide opacity-90">Draft</p>}
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

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">
        {/* Day headers */}
        <div className="flex border-b" style={{ borderColor: TT.grid }}>
          <div className="w-14 shrink-0" />
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
          {/* Hour gutter */}
          <div className="w-14 shrink-0">
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
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ month view -- */

function MonthGrid({ dates, events, settings, today, onSelectEvent, selectedId, anchor }) {
  const month = anchor.slice(0, 7);
  const byDate = useMemo(() => {
    const m = new Map();
    for (const e of events) { if (!m.has(e.date)) m.set(e.date, []); m.get(e.date).push(e); }
    return m;
  }, [events]);
  const cols = new Set(dates.map(isoDay)).size || 7;

  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[640px] gap-px" style={{ background: TT.grid, gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}>
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
                    onSelect={onSelectEvent} selected={selectedId === e.id} style={{ display: "block", width: "100%" }} />
                ))}
                {list.length > 3 && <p className="pl-1 text-[10px] font-semibold text-slate-400">+{list.length - 3} more</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- timeline view -- */

function TimelineGrid({ dates, events, settings, today, onSelectEvent, selectedId }) {
  const periods = settings.periods || [];
  const gridStart = periods.length ? minutes(periods[0].start) : 0;
  const gridEnd = periods.length ? minutes(periods[periods.length - 1].end) : 1440;
  const span = Math.max(gridEnd - gridStart, 1);
  const DAY_W = 260;

  const byDate = useMemo(() => {
    const m = new Map();
    for (const e of events) { if (!m.has(e.date)) m.set(e.date, []); m.get(e.date).push(e); }
    return m;
  }, [events]);

  // Time runs left to right and each day is a band. This is the view for "when is
  // this room free across a fortnight", which the day columns answer badly.
  return (
    <div className="overflow-x-auto">
      <div style={{ minWidth: dates.length * DAY_W }}>
        {dates.map((d) => (
          <div key={d} className="flex items-stretch border-b border-slate-100">
            <div className={`w-28 shrink-0 px-2 py-2 text-[11px] font-bold ${d === today ? "text-sky-600" : "text-slate-500"}`}>{dayLabel(d)}</div>
            <div className="relative h-11 flex-1 bg-white">
              {(byDate.get(d) || []).map((e) => {
                const s = Math.max(minutes(e.start), gridStart), en = Math.min(minutes(e.end), gridEnd);
                if (en <= s) return null;
                return (
                  <EventTile key={e.id} event={e} settings={settings} today={today} compact
                    onSelect={onSelectEvent} selected={selectedId === e.id}
                    style={{ position: "absolute", top: 3, bottom: 3, left: `${((s - gridStart) / span) * 100}%`, width: `${((en - s) / span) * 100}%` }} />
                );
              })}
            </div>
          </div>
        ))}
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
                <span className="flex-1 py-2 pr-2">
                  <span className="flex items-center gap-1 text-[11px] font-bold text-slate-400"><Clock3 size={11} /> {e.start}–{e.end}{e.room ? ` · ${e.room}` : ""}</span>
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
  const effective = settings.layout === "list" || (handset && (view === "week" || view === "timeline")) ? "list" : view;

  if (!dates.length) return <EmptyGrid msg="No days are switched on in your settings." />;

  switch (effective) {
    case "list":     return <ListView dates={dates} events={events} settings={settings} today={today} onSelectEvent={onSelectEvent} selectedId={selectedId} />;
    case "month":    return <MonthGrid dates={dates} events={events} settings={settings} today={today} anchor={anchor} onSelectEvent={onSelectEvent} selectedId={selectedId} />;
    case "timeline": return <TimelineGrid dates={dates} events={events} settings={settings} today={today} onSelectEvent={onSelectEvent} selectedId={selectedId} />;
    default:         return <ColumnGrid dates={dates} events={events} settings={settings} today={today} onSelectEvent={onSelectEvent} selectedId={selectedId} onCreateAt={onCreateAt} />;
  }
}
