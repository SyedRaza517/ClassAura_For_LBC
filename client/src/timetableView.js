// The timetable's arithmetic: which dates a view covers, where an event sits in the
// grid, what colour it is and what it says.
//
// Pure, and separate from the components for one reason above all: this is the code
// that goes wrong. The server half of this feature produced a clock-change bug in
// exactly this shape of arithmetic, and this module repeats it. Everything here is
// therefore in UTC, takes strings and returns strings, and has tests — which no
// other file in the client does.

/** A YYYY-MM-DD string as a UTC Date. */
const utc = (d) => new Date(`${d}T00:00:00Z`);
/** A UTC Date back to YYYY-MM-DD. */
const iso = (dt) => dt.toISOString().slice(0, 10);

/** ISO weekday: 1 = Monday … 7 = Sunday. JS gives 0 for Sunday. */
export function isoDay(date) {
  const d = utc(date).getUTCDay();
  return d === 0 ? 7 : d;
}

/** `date` moved by n days, in UTC. */
export function addDays(date, n) {
  const dt = utc(date);
  dt.setUTCDate(dt.getUTCDate() + n);
  return iso(dt);
}

/**
 * `date` moved by n months, clamped to the last day of the target month.
 *
 * Without the clamp, 31 January + 1 month is "31 February", which JS silently rolls
 * into March — so a reader pressing "next month" on the 31st would jump from January
 * to March and never see February.
 */
export function addMonths(date, n) {
  const dt = utc(date);
  const day = dt.getUTCDate();
  dt.setUTCDate(1);
  dt.setUTCMonth(dt.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(day, lastDay));
  return iso(dt);
}

/** The Monday of the week containing `date`. Weeks start Monday, as ISO 1-7 does. */
export const mondayOf = (date) => addDays(date, -(isoDay(date) - 1));

/**
 * The date range one view covers.
 *
 * Month covers WHOLE WEEKS rather than the 1st to the 30th, so the grid is a
 * rectangle. September 2026 begins on a Tuesday; a window starting on the 1st would
 * leave a ragged first row with a hole where Monday should be.
 */
export function windowFor(view, anchor) {
  switch (view) {
    case "day":
      return { from: anchor, to: anchor };
    case "month": {
      const first = `${anchor.slice(0, 7)}-01`;
      const lastDay = new Date(Date.UTC(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)), 0)).getUTCDate();
      const last = `${anchor.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`;
      return { from: mondayOf(first), to: addDays(mondayOf(last), 6) };
    }
    case "timeline":
      // Two weeks. One is a Week view laid sideways and adds nothing; a term is
      // unreadable at any zoom that still shows a room name.
      return { from: mondayOf(anchor), to: addDays(mondayOf(anchor), 13) };
    case "week":
    default:
      return { from: mondayOf(anchor), to: addDays(mondayOf(anchor), 6) };
  }
}

/**
 * The anchor moved one step. `big` is the ⟪ ⟫ pair, which moves further.
 *
 * The unit is the view's own: pressing "next" in Week means next week, not next day.
 * A single shared "+7" would make the arrows mean different amounts of travel
 * depending on a setting the reader cannot see.
 */
export function shiftAnchor(view, anchor, delta, big = false) {
  if (view === "month") return addMonths(anchor, big ? delta * 12 : delta);
  if (big) return addMonths(anchor, delta);
  if (view === "day") return addDays(anchor, delta);
  if (view === "timeline") return addDays(anchor, delta * 14);
  return addDays(anchor, delta * 7);
}

/**
 * Every date from `from` to `to` whose weekday the reader has switched on.
 *
 * An empty `days` returns nothing, deliberately. It can only come from a broken
 * settings blob, and quietly showing the whole week instead would hide the fault;
 * an empty grid is visibly wrong and gets reported.
 */
export function datesIn(from, to, days, view) {
  // A DAY VIEW IS AN EXPLICIT NAVIGATION AND OUTRANKS THE WEEKDAY LIST. The list
  // says which columns a week or month grid should carry; applying it to a single
  // requested date deletes the only thing on screen, which is what a reader opening
  // their timetable on a Sunday actually saw.
  if (view === "day") return from <= to ? [from] : [];
  const allowed = new Set(days || []);
  const out = [];
  if (!allowed.size || to < from) return out;
  // A year of days is the widest any view asks for, and the guard stops a bad
  // window spinning the browser.
  for (let d = from, guard = 0; d <= to && guard < 400; d = addDays(d, 1), guard++) {
    if (allowed.has(isoDay(d))) out.push(d);
  }
  return out;
}

/** "HH:MM" as minutes past midnight. */
export function minutes(hhmm) {
  const [h, m] = String(hhmm || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Where an event sits in the grid, as percentages of the visible span.
 *
 * Returns null when the event does not overlap the shown periods at all. NOT clamped
 * to the nearest edge: a 20:00 class drawn on the last row of a grid that stops at
 * 13:00 is a lie about when it happens, and the reader's own settings are what
 * excluded it. An event that only PARTLY overlaps is clipped and shown, because it
 * genuinely occurs during hours the reader is looking at.
 */
export function placeEvent(event, periods) {
  if (!periods?.length) return null;
  const gridStart = minutes(periods[0].start);
  const gridEnd = minutes(periods[periods.length - 1].end);
  const span = gridEnd - gridStart;
  if (span <= 0) return null;

  const start = Math.max(minutes(event.start), gridStart);
  const end = Math.min(minutes(event.end), gridEnd);
  if (end <= start) return null;

  return { topPct: ((start - gridStart) / span) * 100, heightPct: ((end - start) / span) * 100 };
}

// A fixed, deliberately unsaturated wheel for the dimensions that carry no colour of
// their own. Derived from the id so the same room is the same colour on every
// screen, every day, without anybody assigning one.
const WHEEL = ["#1f6f8b", "#7a4988", "#b06d2b", "#2f7a4f", "#8a3d52", "#3f5f9e", "#6b7a2b", "#8b4a2b"];
const hashOf = (s) => { let h = 0; for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0; return Math.abs(h); };

/**
 * The colour for an event under the reader's chosen dimension.
 *
 * Colour is a CHOSEN DIMENSION here, not a property of the event — the source
 * system's "Event colour key" is a question about what colour should mean. Never
 * returns undefined: an undefined colour renders as an invisible event.
 */
export function colourOf(event, colourBy) {
  const byId = (id) => WHEEL[hashOf(id || "none") % WHEEL.length];
  switch (colourBy) {
    case "category": return event?.categoryColour || byId(event?.categoryId);
    case "room":     return byId(event?.roomId);
    case "module":   return byId(event?.unitId);
    case "course":   return byId(event?.courseId);
    case "group":    return byId(event?.groups?.[0]?.id);
    default:         return event?.categoryColour || byId(event?.id);
  }
}

/**
 * What prints inside an event tile, in the reader's chosen order.
 *
 * The ORDER is the setting — it is what a lecturer sees first when a tile is too
 * small for everything. Fields the event lacks are skipped rather than printed
 * blank, so a tile never carries an empty line pushing the useful ones out of view.
 */
export function annotationLines(event, annotations) {
  const value = (key) => {
    switch (key) {
      case "title":    return event?.title || "";
      case "unit":     return event?.unitCode || event?.unitName || "";
      case "category": return event?.category || "";
      case "room":     return event?.room || "";
      case "staff":    return (event?.staff || []).map((s) => s.name).filter(Boolean).join(", ");
      case "group":    return (event?.groups || []).map((g) => g.name).filter(Boolean).join(", ");
      case "course":   return event?.courseName || "";
      case "eventId":  return event?.id || "";
      default:         return "";
    }
  };
  return (annotations || []).map(value).filter(Boolean);
}

/**
 * Has this event moved within the last `days` days?
 *
 * Computed here, at render time, from the timestamp — never read from a stored day
 * count, which would be wrong by the next morning with nothing to correct it.
 * `days === 0` means the highlight is switched off, which is not the same as
 * "changed today".
 */
export function changedWithin(event, days, today) {
  if (!days || days <= 0 || !event?.changedAt) return false;
  const changed = String(event.changedAt).slice(0, 10);
  return changed >= addDays(today, -days) && changed <= today;
}

const DMY = { day: "numeric", month: "short" };
/** The label between the navigation arrows: "24 - 30 Aug 26", "30 Aug 2026". */
export function RANGE_LABEL(view, from, to) {
  const f = utc(from), t = utc(to);
  const yr = t.getUTCFullYear();
  if (view === "day") return `${f.toLocaleDateString("en-GB", { ...DMY, year: "numeric", timeZone: "UTC" })}`;
  if (view === "month") return f.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  // Within one month the month name is printed once — "24 - 30 Aug 26", which is
  // what the reference shows. Repeating it ("24 Aug - 30 Aug 26") is longer and says
  // nothing extra; across a boundary both are needed and both are shown.
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  const left = sameMonth
    ? String(f.getUTCDate())
    : f.toLocaleDateString("en-GB", { ...DMY, timeZone: "UTC" });
  return `${left} - ${t.toLocaleDateString("en-GB", { ...DMY, timeZone: "UTC" })} ${String(yr).slice(2)}`;
}

/**
 * The dates a repeating class falls on: every day between `start` and `end` inclusive
 * whose ISO weekday is in `days`, minus `skip`.
 *
 * A MIRROR OF seriesDates() IN server/src/timetabling/recurrence.js, and it exists only
 * so the form can say "creates 42 classes" BEFORE the request rather than after it. The
 * server is authoritative; if the two ever disagree the server wins and the count was
 * merely wrong on screen. Kept deliberately identical in its two awkward rules so it
 * cannot mislead:
 *
 *   - empty `days` means the START DATE'S OWN WEEKDAY, not "no days". Returning nothing
 *     there would preview an empty series for the commonest case of all.
 *   - a skipped date is DROPPED, never shifted to the next occurrence, which would push
 *     the rest of the term along by a week.
 *
 * This is NOT datesIn() above: that one answers "which columns does this grid carry",
 * treats an empty list as empty, and overrides everything in day view.
 */
export function seriesPreviewDates(start, end, days = [], skip = []) {
  const out = [];
  if (!start || !end || end < start) return out;
  const wanted = new Set((days || []).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7));
  if (!wanted.size) wanted.add(isoDay(start));
  const skipSet = new Set(skip || []);
  for (let d = start, guard = 0; d <= end && guard < 400; d = addDays(d, 1), guard++) {
    if (wanted.has(isoDay(d)) && !skipSet.has(d)) out.push(d);
  }
  return out;
}
