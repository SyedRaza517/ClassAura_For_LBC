import { RefreshCw, CalendarDays, Clock3, User, MapPin, Video } from "lucide-react";
import { Screen, LoadingScreen, Card } from "../ui";
import { ACCENT, ACCENT_TONE, toneVars } from "../ui/tokens";
import { NAVY_DARK } from "../../branding";
import { openExternalLink } from "../utils";

// 1 = Monday … 7 = Sunday (matches the server). Weekend days appear only if a slot
// actually lands on one.
const TT_DAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
// The period label the college's own timetable uses ("Evening 18:00 – 21:00").
const periodOf = (start) => { const h = Number(String(start).slice(0, 2)); return h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening"; };

// A STABLE COLOUR PER MODULE, when the college has not chosen one.
//
// The college's Event Category colour wins where it exists, so a student and their
// lecturer look at the same coded timetable rather than two unrelated palettes. This is
// the fallback, hashed from the module CODE rather than assigned in order, so a module
// keeps its colour when a class is added and between the phone and the web.
const TT_COLOURS = ["#1a3a8f", "#0d7a5f", "#9e1b32", "#6d28d9", "#b45309", "#0e7490", "#be123c", "#4338ca"];
const ttColour = (ev) =>
  ev.colour || TT_COLOURS[Math.abs(String(ev.unitCode || ev.title || "").split("").reduce((a, c) => a + c.charCodeAt(0), 0)) % TT_COLOURS.length];

// "2026-09-14" → "14/09/2026", the form the college's own week-structure sheet uses.
const ttDMY = (d) => { const [y, m, dd] = String(d || "").split("-"); return y ? `${dd}/${m}/${y}` : ""; };

// What the student was marked, as they should read it.
//
// "Not marked" is SLATE and is its own state, never red. A class nobody has taken a
// register for is a fact about the CLASS; being absent is a fact about the STUDENT, and a
// screen that paints them alike starts a support conversation from a false premise. Only
// shown once a class has happened — an unmarked future class is not missing anything.
const TT_MARK = {
  P: { label: "Present", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800" },
  L: { label: "Late", cls: "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800" },
  E: { label: "Excused", cls: "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-800" },
  A: { label: "Absent", cls: "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-800" },
};

// The Monday of a date's week, and the number of whole weeks between two dates.
//
// WEEK NUMBER COMES FROM THE CALENDAR, NOT FROM THE ROW INDEX. Numbering rows made two
// classes on the SAME DAY -- a 09:00-12:00 morning and a 14:00-17:00 afternoon, which is
// an ordinary shape here -- read as week 1 and week 2, so a module taught twice a day
// appeared to run for twice as many weeks as it does. Reported exactly that way.
//
// Monday-anchored so a Friday and the following Monday are different weeks while a
// Monday and the Friday after it are the same one, which is what "week 3 of the module"
// means to everybody who says it.
const ttWeekStart = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
};
const ttWeeksBetween = (a, b) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 604800000);

/**
 * The timetable, MODULE BY MODULE.
 *
 * Two earlier shapes were rejected against this one, and the reasons are the design.
 *
 * A FLAT LIST OF EVERY DATE repeated the module name, room and lecturer on all twelve
 * copies of a weekly class — the same noise as the college's own sheet writing
 * "TEACHING" eight times down a column.
 *
 * A WEEK AT A TIME fixed the repetition and lost the thing a student opens this for:
 * "when is Financial Analysis on", which is a question about a module, not about a
 * Tuesday. It also put a fifth of the screen behind a next-week button.
 *
 * So: one block per module, its name and colour said ONCE, then its dates. Constant
 * facts are hoisted into the header — a module taught by one person in one room says so
 * at the top and drops both columns entirely, which is most modules and is the whole
 * reason this reads as a timetable rather than a spreadsheet. What varies stays in the
 * table, because that is what the table is for.
 */
function ModuleTimetable({ events, today }) {
  const groups = [];
  const byKey = new Map();
  for (const ev of events) {
    const key = ev.unitCode || ev.title;
    if (!byKey.has(key)) { const g = { key, items: [], colour: ttColour(ev), title: ev.unitName || ev.title, code: ev.unitCode }; byKey.set(key, g); groups.push(g); }
    byKey.get(key).items.push(ev);
  }

  const one = (list, pick) => { const set = new Set(list.map(pick).filter(Boolean)); return set.size === 1 ? [...set][0] : null; };

  return (
    <>
      {groups.map((g, gi) => {
        // Hoisted only when EVERY class agrees. One room for eleven weeks and a different
        // room for the twelfth is exactly the week somebody turns up to the wrong door,
        // so a single exception keeps the column and shows it on every row.
        const room = one(g.items, (e) => [e.room ? `Room ${e.room}` : null, e.floor, e.campus].filter(Boolean).join(" · "));
        const staff = one(g.items, (e) => (e.staff || []).join(", "));
        const time = one(g.items, (e) => `${e.start}–${e.end}`);
        // The course and the school do not vary within a module and never belong in a
        // row. They answer a question the rest of this card does not: not "where do I go"
        // but "what is this hour FOR" — which qualification it counts towards and who
        // runs it. A student chasing a mark needs the school's name to know who to ask.
        const course = one(g.items, (e) => e.course);
        const school = one(g.items, (e) => e.school);
        return (
          // fade-up + a stagger was missing here — every other card on this app
          // arrives with the same entrance, and a module block that just appeared
          // fully-formed while its neighbours on Home and Attendance eased in read as
          // a different, less finished screen. Capped like Reviews' own stagger so a
          // long timetable doesn't leave the last module waiting seconds to animate.
          <div key={g.key} className="fade-up mb-3 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70 dark:bg-slate-800 dark:ring-slate-700/60" style={{ animationDelay: `${Math.min(gi, 6) * 55}ms` }}>
            <div className="px-3.5 py-3 text-white" style={{ background: g.colour }}>
              <p className="text-[15px] font-extrabold leading-tight">{g.title}</p>
              {/* WRAPPED, NOT TRUNCATED, and that is the width fix.
                  These lines were `truncate` inside a single flex row, so on a phone the
                  room and the lecturer were cut to an ellipsis and the course and school
                  would have had nowhere to go at all. A timetable that hides the room is
                  not narrower, it is wrong — so the facts wrap onto as many lines as they
                  need and the card grows instead. */}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] leading-snug text-white/90">
                {g.code && <span className="rounded bg-white/20 px-1.5 py-0.5 font-bold tabular-nums">{g.code}</span>}
                {time && <span className="tabular-nums font-semibold">{time}</span>}
                {room && <span>{room}</span>}
                {staff && <span>{staff}</span>}
              </div>
              {(course || school) && (
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-snug text-white/70">
                  {course && <span>{course}</span>}
                  {course && school && <span aria-hidden="true">·</span>}
                  {school && <span>{school}</span>}
                </div>
              )}
              <p className="mt-1.5 text-[11px] tabular-nums text-white/70">
                {/* How much of this module is behind them. A term of dates says when to
                    turn up; "3 of 12" is the sentence that tells them where they are in
                    it, which is the question the college's own emails are about. */}
                {g.items.filter((e) => e.date < today).length} of {g.items.length} so far
              </p>
            </div>
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="bg-slate-50 text-[10px] font-bold uppercase tracking-wide text-slate-400 dark:bg-slate-900/50 dark:text-slate-500">
                  <th scope="col" className="px-3 py-1.5">Wk</th>
                  <th scope="col" className="px-2 py-1.5">Date</th>
                  {!time && <th scope="col" className="px-2 py-1.5">Time</th>}
                  {!room && <th scope="col" className="px-2 py-1.5">Room</th>}
                  {!staff && <th scope="col" className="px-2 py-1.5">Lecturer</th>}
                  <th scope="col" className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {g.items.map((ev, i) => {
                  const isToday = ev.date === today;
                  const past = ev.date < today;
                  const firstOfDay = i === 0 || g.items[i - 1].date !== ev.date;
                  const weekNo = ttWeeksBetween(ttWeekStart(g.items[0].date), ttWeekStart(ev.date)) + 1;
                  // THE TIMETABLE DOES NOT CHECK ANYBODY IN, and that is a deliberate
                  // reversal of a day-old change.
                  //
                  // Rows were briefly tappable, opening the scanner. It conflated two
                  // screens that answer different questions: this one is "when and where
                  // am I this term", read across twelve weeks and mostly about days that
                  // are not today, while checking in is a thing you do once, standing in a
                  // room, about now. Putting the action here put a live control on a
                  // reference document — and on eleven rows out of twelve it had to be
                  // inert, which is its own kind of broken.
                  //
                  // Check In is the screen with the action. What this column shows instead
                  // is what HAPPENED: the mark, or that nobody took the register.
                  return (
                    <tr key={ev.id} className={isToday ? "bg-slate-50 dark:bg-slate-700/40" : ""}>
                      {/* Numbered within the MODULE and FROM THE DATE, so "week 3" is the
                          third week this module runs — the way a student and a brief both
                          say it — and two classes on one day share a number instead of
                          inventing a week.

                          The number and the date are printed only on the FIRST row of a
                          day. A module with a morning and an afternoon session used to
                          print the same date twice, one under the other, which is the
                          repetition this screen was rebuilt to remove. */}
                      <td className={`px-3 py-2 text-[12px] tabular-nums ${past ? "text-slate-300 dark:text-slate-600" : "text-slate-500 dark:text-slate-400"}`}>
                        {firstOfDay ? weekNo : ""}
                      </td>
                      <td className={`whitespace-nowrap px-2 py-2 text-[12px] font-semibold tabular-nums ${past ? "text-slate-400 dark:text-slate-600" : "text-slate-700 dark:text-slate-200"}`}>
                        {firstOfDay ? ttDMY(ev.date) : ""}
                      </td>
                      {!time && <td className="whitespace-nowrap px-2 py-2 text-[12px] tabular-nums text-slate-500 dark:text-slate-400">{ev.start}–{ev.end}</td>}
                      {!room && <td className="px-2 py-2 text-[12px] leading-snug text-slate-500 dark:text-slate-400">{[ev.room ? `Room ${ev.room}` : null, ev.floor, ev.campus].filter(Boolean).join(" · ") || "—"}</td>}
                      {!staff && <td className="px-2 py-2 text-[12px] leading-snug text-slate-500 dark:text-slate-400">{(ev.staff || []).join(", ") || "—"}</td>}
                      <td className="px-2 py-2 text-right">
                        {/* Both can appear together — a class already marked can
                            still be one a student wants to open again (a recording,
                            or checking they have the right link before it starts),
                            so this is never an either/or with the mark pill below
                            it. Shown for EVERY date carrying a link, past or future:
                            a term of dates is a reference document (Timetable.jsx's
                            own file header), and a rescheduled class that dropped
                            the link on just one date must be able to show that by
                            simply not rendering the button on that one row, which a
                            module-wide "does this module have online classes" switch
                            could not do. */}
                        <div className="flex flex-col items-end gap-1">
                          {ev.teamsJoinUrl && (
                            <button onClick={() => openExternalLink(ev.teamsJoinUrl)}
                              className="tone-soft press inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold"
                              style={toneVars(ACCENT_TONE.timetable)}>
                              <Video size={10} aria-hidden="true" /> Join
                            </button>
                          )}
                          {ev.status
                            ? <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${TT_MARK[ev.status].cls}`}>{TT_MARK[ev.status].label}</span>
                            : past || isToday
                              ? <span className="text-[10px] text-slate-300 dark:text-slate-600">Not marked</span>
                              : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}

export function TimetableScreen({ timetable, busy, reload }) {
  if (busy && !timetable) return <LoadingScreen />;
  const stages = timetable?.stages || [];
  const events = timetable?.events || [];
  const today = timetable?.today || "";

  // THE CALENDAR WINS WHERE THERE IS ONE. `stages` is the older weekly grid built from
  // TimetableSlot, which nothing writes any more; `events` are the dated classes the
  // college actually scheduled. Both are rendered rather than one replacing the other,
  // because a college with historic TimetableSlot data should keep seeing it — but the
  // real classes go first, since they are the ones with a room, a date and a register.
  if (events.length) {
    // `stages` is DELIBERATELY NOT RENDERED HERE. It is the college's week-structure
    // sheet — "Week 1 TEACHING, Week 2 TEACHING, Week 3 TEACHING" — which says the same
    // word eight times and carries no room, no time and no lecturer. Printed under the
    // real timetable it read as the timetable repeating itself, which is what was
    // reported. Where there are real classes, they ARE the timetable.
    return (
      <Screen>
        <ModuleTimetable events={events} today={today} />
        <p className="mt-1 px-1 text-center text-[11px] text-slate-400 dark:text-slate-500">
          Times and rooms are set by the college. If something looks wrong, message us from &ldquo;Ask the College&rdquo;.
        </p>
      </Screen>
    );
  }

  if (!stages.length) {
    return (
      <Screen>
        <Card className="text-center">
          <div className="tone-soft mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-2xl" style={toneVars(ACCENT_TONE.timetable)}><CalendarDays size={26} /></div>
          <p className="text-base font-extrabold text-slate-800 dark:text-slate-100">No timetable yet</p>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Your timetable will appear here once the college publishes it for your course. Pull to refresh, or check back soon.</p>
          <button onClick={reload} className="press mx-auto mt-3 flex items-center gap-1.5 rounded-xl bg-slate-100 px-3 py-2 text-xs font-bold text-slate-600 dark:bg-slate-700 dark:text-slate-300"><RefreshCw size={13} /> Refresh</button>
        </Card>
      </Screen>
    );
  }
  return (
    <Screen>
      {stages.map((st, i) => <TimetableBlock key={`${st.courseId}|${st.year}|${st.termNumber}`} stage={st} i={i} />)}
      <p className="px-1 text-center text-[11px] text-slate-400 dark:text-slate-500">Times and rooms are set by the college. If something looks wrong, message us from “Ask the College”.</p>
    </Screen>
  );
}

// "2026-06-01" → "1 Jun 2026" for the term header and week-commencing column.
const ttFmtDate = (d, withYear) => { if (!d) return ""; const dt = new Date(d + "T00:00:00"); return isNaN(dt.getTime()) ? d : dt.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) }); };
// Colour the academic-calendar activities the way the college does: assessment stands
// out most, formative feedback next, teaching is the calm default.
const activityStyle = (a) => {
  const s = String(a || "").toLowerCase();
  if (s.includes("assessment") || s.includes("exam")) return "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300";
  if (s.includes("feedback") || s.includes("formative")) return "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
  if (s.includes("break") || s.includes("reading") || s.includes("extra")) return "bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400";
  return "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
};

function TimetableBlock({ stage, i }) {
  const accent = stage.colour || ACCENT.timetable;
  // Group the rows by weekday, in Mon→Sun order, each sorted by start time.
  const byDay = {};
  for (const r of stage.rows) (byDay[r.day] = byDay[r.day] || []).push(r);
  for (const d of Object.keys(byDay)) byDay[d].sort((a, b) => a.start.localeCompare(b.start));
  const days = [1, 2, 3, 4, 5, 6, 7].filter(d => byDay[d]?.length);
  const td = stage.termDates || {};
  const weeks = stage.calendar?.weeks || [];

  return (
    <Card i={i} className="!p-0 overflow-hidden">
      {/* Header band — the intake / course / stage / term dates, like the emailed timetable. */}
      <div className="px-4 py-3.5 text-white" style={{ background: `linear-gradient(135deg, ${accent}, ${NAVY_DARK})` }}>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-white/70">Weekly timetable</p>
        <p className="mt-0.5 text-sm font-extrabold leading-tight">{stage.courseName || "My course"}</p>
        {(stage.year != null || stage.termNumber != null) && (
          <p className="mt-0.5 text-[12px] font-semibold text-white/85">{[stage.year != null ? `Year ${stage.year}` : null, stage.termNumber != null ? `Term ${stage.termNumber}` : null].filter(Boolean).join(" · ")}</p>
        )}
        {(td.start || td.end) && (
          <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-bold"><CalendarDays size={12} /> {ttFmtDate(td.start, true)}{td.start && td.end ? " – " : ""}{ttFmtDate(td.end, true)}</p>
        )}
      </div>

      {days.length > 0 && (
        <div className="divide-y divide-slate-100 dark:divide-slate-700">
          {days.map(d => (
            <div key={d} className="px-4 py-3">
              <p className="mb-2 text-[11px] font-extrabold uppercase tracking-widest" style={{ color: accent }}>{TT_DAYS[d]}</p>
              <div className="space-y-2">
                {byDay[d].map(r => (
                  <div key={r.id} className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70 dark:bg-slate-700/40 dark:ring-slate-700/60">
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 break-words text-sm font-bold text-slate-800 dark:text-slate-100">{r.title}</p>
                      <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-slate-500 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700">{periodOf(r.start)}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-slate-500 dark:text-slate-400">
                      <span className="flex items-center gap-1 font-semibold text-slate-600 dark:text-slate-300"><Clock3 size={12} /> {r.start} – {r.end}</span>
                      {r.lecturer && <span className="flex items-center gap-1"><User size={12} /> {r.lecturer}</span>}
                      {r.room && <span className="flex items-center gap-1"><MapPin size={12} /> {r.room}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Academic calendar — the term's weekly structure (Week / Commencing / Activity). */}
      {weeks.length > 0 && (
        <div className="border-t-4 border-slate-100 px-4 py-3 dark:border-slate-700">
          <p className="mb-2 text-[11px] font-extrabold uppercase tracking-widest" style={{ color: accent }}>Academic calendar</p>
          <div className="overflow-x-auto rounded-xl ring-1 ring-slate-200 dark:ring-slate-700">
            <table className="w-full text-[12px]">
              <thead><tr className="bg-slate-50 text-left text-[10px] font-bold uppercase tracking-wide text-slate-400 dark:bg-slate-900/50 dark:text-slate-500"><th className="px-3 py-2">Wk</th><th className="px-3 py-2">Commencing</th><th className="px-3 py-2">Activity</th></tr></thead>
              <tbody>
                {weeks.map((w, k) => (
                  <tr key={k} className="border-t border-slate-100 dark:border-slate-700">
                    <td className="px-3 py-2 font-bold text-slate-600 dark:text-slate-300">{w.n}</td>
                    <td className="px-3 py-2 text-slate-500 dark:text-slate-400">{ttFmtDate(w.wc)}</td>
                    <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${activityStyle(w.activity)}`}>{w.activity || "Teaching"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}

export default TimetableScreen;
