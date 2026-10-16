// The staff timetable, in the STUDENT app's clothes — the user's ruling, in their
// words: "it should be like the student app, like how students are seeing, but the
// details are different." So this is student/screens/Timetable.jsx's module-by-module
// presentation restated for a lecturer: one colour-banded card per module, constant
// facts hoisted into the band, the dates below — and the details that differ are
// exactly the ones a lecturer needs where a student needed others:
//
//   * WHO is the class, not who teaches it — the GROUPS column replaces the student
//     screen's lecturer column (the lecturer is the person holding the phone), with
//     co-teachers shown only when an event names more than just the viewer;
//   * no attendance mark pill — staff are not marked; the Join button stays, because
//     a lecturer opens their own online class from the same place a student does;
//   * the footer points at Scheduling rather than "Ask the College".
//
// The rest — week numbers from the calendar not the row index, first-of-day printing,
// hoist-only-when-every-class-agrees, wrapped-never-truncated facts — is inherited
// deliberately, comments and all, so the two screens cannot drift into answering the
// same question differently. No dark: classes: the staff shell has no dark mode by
// ruling (student/theme.js owns .dark).
import React, { useState, useEffect } from "react";
import { RefreshCw, CalendarDays, Video } from "lucide-react";
import { api } from "./api";
import { NAVY } from "./branding";

const TT_COLOURS = ["#1a3a8f", "#0d7a5f", "#9e1b32", "#6d28d9", "#b45309", "#0e7490", "#be123c", "#4338ca"];
const ttColour = (ev) =>
  ev.categoryColour || TT_COLOURS[Math.abs(String(ev.unitCode || ev.title || "").split("").reduce((a, c) => a + c.charCodeAt(0), 0)) % TT_COLOURS.length];

const ttDMY = (d) => { const [y, m, dd] = String(d || "").split("-"); return y ? `${dd}/${m}/${y}` : ""; };

// Monday-anchored week arithmetic — see the student screen for why the week number
// comes from the calendar and never from the row index.
const ttWeekStart = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
};
const ttWeeksBetween = (a, b) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 604800000);

const isoShift = (days) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

const roomOf = (e) => [e.room || null, e.campus].filter(Boolean).join(" · ");
const groupsOf = (e) => (e.groups || []).map((g) => g.name).filter(Boolean).join(", ");

export default function StaffTimetable({ meId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const load = () => {
    setErr("");
    // A term-sized reference window: four weeks back for "what have I taught", ten
    // ahead for "what is coming" — the same reading posture as the student screen,
    // which shows the module's whole run rather than one week at a time.
    api.myTimetable(isoShift(-28), isoShift(70))
      .then(setData)
      .catch((e) => setErr(e?.message || "Could not load your timetable."));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <div className="p-4"><p className="rounded-2xl bg-rose-50 p-4 text-center text-sm font-semibold text-rose-700 ring-1 ring-rose-200">{err}</p></div>;
  if (!data) return <div className="flex justify-center py-16"><RefreshCw className="animate-spin text-slate-300" size={22} /></div>;

  const today = new Date().toISOString().slice(0, 10);
  const events = data.events || [];

  if (!events.length) {
    return (
      <div className="p-4 fade-up">
        <div className="rounded-3xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-200/70">
          <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50"><CalendarDays size={26} style={{ color: NAVY }} /></div>
          <p className="text-base font-extrabold text-slate-800">No classes scheduled</p>
          <p className="mt-1 text-sm text-slate-500">When Scheduling publishes classes that name you, they appear here.</p>
          <button onClick={load} className="press mx-auto mt-3 flex items-center gap-1.5 rounded-xl bg-slate-100 px-3 py-2 text-xs font-bold text-slate-600"><RefreshCw size={13} /> Refresh</button>
        </div>
      </div>
    );
  }

  // One block per module, the student screen's shape exactly.
  const groups = [];
  const byKey = new Map();
  for (const ev of events) {
    const key = ev.unitCode || ev.title;
    if (!byKey.has(key)) { const g = { key, items: [], colour: ttColour(ev), title: ev.unitName || ev.title, code: ev.unitCode }; byKey.set(key, g); groups.push(g); }
    byKey.get(key).items.push(ev);
  }
  const one = (list, pick) => { const set = new Set(list.map(pick).filter(Boolean)); return set.size === 1 ? [...set][0] : null; };

  return (
    <div className="p-4">
      {groups.map((g, gi) => {
        // Hoisted only when EVERY class agrees — one exception keeps the column, so
        // the week somebody is in a different room is the week the row says so.
        const room = one(g.items, roomOf);
        const time = one(g.items, (e) => `${e.start}–${e.end}`);
        const who = one(g.items, groupsOf);
        // Co-teachers, only when an event names someone besides the viewer — a
        // module the viewer teaches alone says nothing, which is most of them.
        const others = one(g.items, (e) => (e.staff || []).filter((s) => s.id !== meId).map((s) => s.name).join(", "));
        return (
          <div key={g.key} className="fade-up mb-3 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70" style={{ animationDelay: `${Math.min(gi, 6) * 55}ms` }}>
            <div className="px-3.5 py-3 text-white" style={{ background: g.colour }}>
              <p className="text-[15px] font-extrabold leading-tight">{g.title}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] leading-snug text-white/90">
                {g.code && <span className="rounded bg-white/20 px-1.5 py-0.5 font-bold tabular-nums">{g.code}</span>}
                {time && <span className="tabular-nums font-semibold">{time}</span>}
                {room && <span>{room}</span>}
                {who && <span>{who}</span>}
              </div>
              {others && <p className="mt-1 text-[11px] leading-snug text-white/70">with {others}</p>}
              <p className="mt-1.5 text-[11px] tabular-nums text-white/70">
                {g.items.filter((e) => e.date < today).length} of {g.items.length} taught so far
              </p>
            </div>
            {/* THE TABLE SCROLLS; THE CARD DOES NOT GROW, AND IT NO LONGER CLIPS.
                `w-full` only ever meant "fill the card", never "fit inside it": a table's
                width is its content's, and once the columns' min-content exceeds the card
                the table simply overhangs. On the widest row this draws — nothing hoisted
                into the band, so Wk, Date, Time, Room, Group and Join are all present —
                that min-content is around 380px against the 288px a 320px phone leaves
                after `p-4`. The card is `overflow-hidden` for its rounded corners, so the
                surplus was cut off rather than reachable, and the column it cut was the
                last one: the Join button, which is the only thing on this screen a
                lecturer actually presses.
                A scroller inside the card rather than a stacked card list under `sm:`,
                because the hoisting above already does the job a stacked list would. When
                the time, room and group agree across every week — the common case — they
                move into the coloured band and the table is three columns, which fits a
                320px screen with room to spare. It is only the module taught in a
                different room each week that needs the extra columns, and for that one a
                sideways nudge is a smaller surprise than a different presentation. */}
            <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="bg-slate-50 text-[10px] font-bold uppercase tracking-wide text-slate-600">
                  <th scope="col" className="px-3 py-1.5">Wk</th>
                  <th scope="col" className="px-2 py-1.5">Date</th>
                  {!time && <th scope="col" className="px-2 py-1.5">Time</th>}
                  {!room && <th scope="col" className="px-2 py-1.5">Room</th>}
                  {!who && <th scope="col" className="px-2 py-1.5">Group</th>}
                  <th scope="col" className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {g.items.map((ev, i) => {
                  const isToday = ev.date === today;
                  const past = ev.date < today;
                  const firstOfDay = i === 0 || g.items[i - 1].date !== ev.date;
                  const weekNo = ttWeeksBetween(ttWeekStart(g.items[0].date), ttWeekStart(ev.date)) + 1;
                  return (
                    <tr key={ev.id} className={isToday ? "bg-blue-50/60" : ""}>
                      <td className={`px-3 py-2 text-[12px] tabular-nums ${past ? "text-slate-300" : "text-slate-500"}`}>{firstOfDay ? weekNo : ""}</td>
                      <td className={`whitespace-nowrap px-2 py-2 text-[12px] font-semibold tabular-nums ${past ? "text-slate-500" : "text-slate-700"}`}>{firstOfDay ? ttDMY(ev.date) : ""}</td>
                      {!time && <td className="whitespace-nowrap px-2 py-2 text-[12px] tabular-nums text-slate-500">{ev.start}–{ev.end}</td>}
                      {!room && <td className="px-2 py-2 text-[12px] leading-snug text-slate-500">{roomOf(ev) || "—"}</td>}
                      {!who && <td className="px-2 py-2 text-[12px] leading-snug text-slate-500">{groupsOf(ev) || "—"}</td>}
                      <td className="px-2 py-2 text-right">
                        {ev.teamsJoinUrl && (
                          <a href={ev.teamsJoinUrl} target="_blank" rel="noreferrer"
                            className="press inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-bold ring-1 ring-blue-200" style={{ color: NAVY }}>
                            <Video size={10} aria-hidden="true" /> Join
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        );
      })}
      <p className="mt-1 px-1 text-center text-[11px] text-slate-500">
        Times, rooms and groups come from Scheduling. Spot something wrong? Tell whoever runs the timetable.
      </p>
    </div>
  );
}
