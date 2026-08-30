// The little month calendar in the sidebar.
//
// The reference screenshots put one here and it does real work: it is how a reader
// jumps three weeks ahead without pressing "next" three times, and it is the only
// place the shape of the month is visible while you are looking at a single week.
//
// Monday-first (M T W T F S S), matching ISO weekdays and the rest of this feature.
// A Sunday-first grid would put the weekend either side of the working week and make
// "which column is Wednesday" a counting exercise.
import React, { useMemo } from "react";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { addMonths, addDays, mondayOf, isoDay } from "./timetableView";
import { TT } from "./timetableTheme";

const HEAD = ["M", "T", "W", "T", "F", "S", "S"];
const utc = (d) => new Date(`${d}T00:00:00Z`);

/**
 * Six rows of seven dates covering the month `anchor` falls in, padded out to whole
 * weeks so the grid is a rectangle. Days outside the month are rendered faintly
 * rather than blank — a hole in the grid reads as a missing day.
 */
function monthGrid(anchor) {
  const first = `${anchor.slice(0, 7)}-01`;
  const start = mondayOf(first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export default function MiniMonth({ anchor, today, weekFrom, weekTo, onPick }) {
  const days = useMemo(() => monthGrid(anchor), [anchor]);
  const month = anchor.slice(0, 7);
  const title = utc(anchor).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <div className="px-3 pb-3">
      <div className="mb-2 flex items-center gap-1">
        <button onClick={() => onPick(today)}
          className="rounded border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50">Today</button>
        <button onClick={() => onPick(addMonths(anchor, -1))} aria-label="Previous month"
          className="ml-auto rounded p-1 text-slate-500 hover:bg-slate-100"><ChevronsLeft size={16} /></button>
        <span className="px-1 text-sm font-semibold text-slate-700">{title}</span>
        <button onClick={() => onPick(addMonths(anchor, 1))} aria-label="Next month"
          className="rounded p-1 text-slate-500 hover:bg-slate-100"><ChevronsRight size={16} /></button>
      </div>

      <div className="grid grid-cols-7 text-center">
        {HEAD.map((h, i) => (
          <div key={i} className="py-1 text-[11px] font-semibold text-slate-400">{h}</div>
        ))}
        {days.map((d) => {
          const inMonth = d.slice(0, 7) === month;
          const isToday = d === today;
          // The week currently on screen is shaded, so the sidebar answers "where am
          // I" as well as "what date is it" — the reference does the same.
          const inWeek = weekFrom && weekTo && d >= weekFrom && d <= weekTo;
          const weekend = isoDay(d) >= 6;
          return (
            <button
              key={d}
              onClick={() => onPick(d)}
              className={`relative py-1.5 text-[13px] transition ${inMonth ? "" : "opacity-0 pointer-events-none"} ${inWeek && !isToday ? "bg-slate-200/70" : ""} ${weekend && inWeek && !isToday ? "bg-slate-300/60" : ""} hover:bg-slate-100`}
            >
              {isToday ? (
                <span className="mx-auto flex h-6 w-6 items-center justify-center rounded-full font-bold text-white"
                  style={{ background: TT.todayRing }}>{utc(d).getUTCDate()}</span>
              ) : (
                <span className={inMonth ? "text-slate-700" : "text-slate-300"}>{utc(d).getUTCDate()}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
