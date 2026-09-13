import { CalendarCheck, Flame, Award, CalendarDays } from "lucide-react";
import { Screen, LoadingScreen, ErrBox, SectionTitle, Card, Ring, StatusBar, Empty, toneFromColour } from "../ui";
import { ACCENT, attendanceTone, ATT, MOTION_MS, toneVars } from "../ui/tokens";
import { fmtPct, fmtDate, unitOf } from "../utils";
import { NAVY, NAVY_DARK } from "../../branding";

// The six badges GET /me/streaks can hand back (studentStreaks.js's own module
// header names all six and the exact rule each one fires on). Worded here in plain
// language for a student who has never seen the words "trailing streak" or "closed
// ISO week" and never needs to — `desc` is what shows while a badge is UNEARNED; the
// server's own `earnedOn` date takes over once it is.
const BADGES = [
  { key: "streak5", label: "5-day streak", desc: "Attend 5 teaching days in a row.", Icon: Flame },
  { key: "streak10", label: "10-day streak", desc: "Attend 10 teaching days in a row.", Icon: Flame },
  { key: "streak25", label: "25-day streak", desc: "Attend 25 teaching days in a row.", Icon: Flame },
  { key: "perfectWeek", label: "Perfect week", desc: "A full week with no absences.", Icon: CalendarDays },
  { key: "perfectMonth", label: "Perfect month", desc: "A full month with no absences.", Icon: CalendarCheck },
  { key: "perfectUnit", label: "Perfect unit", desc: "Fully attend one of your units.", Icon: Award },
];

function UnitAtt({ mr, ended, bands }) {
  const s = mr.summary || {}; const t = attendanceTone(s.pct, bands); const u = unitOf(mr);
  return (
    <div className="border-t border-slate-100 px-3.5 py-3 first:border-t-0 dark:border-slate-700">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-12 shrink-0 items-center justify-center rounded-xl text-[10px] font-extrabold text-white" style={{ background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` }}>{(u.code || "?").slice(0, 5)}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-bold text-slate-700 dark:text-slate-200" title={u.name}>{u.name}</p>
          <p className="mt-0.5 text-[10px] font-medium text-slate-400 dark:text-slate-500">
            {ended ? `Ended ${fmtDate(mr.endDate)}` : `${s.marked ?? 0} session${(s.marked ?? 0) === 1 ? "" : "s"} marked`}
          </p>
        </div>
        <span className="tone-soft shrink-0 rounded-xl px-2.5 py-1.5 text-sm font-extrabold tabular-nums ring-1" style={toneVars(t)}>{fmtPct(s.pct)}</span>
      </div>
      {!ended && (
        <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700">
          <div className="h-full rounded-full" style={{ width: `${s.pct ?? 0}%`, background: t.colour, transition: `width ${MOTION_MS.barFill}ms cubic-bezier(.4,0,.2,1)` }} />
        </div>
      )}
    </div>
  );
}

export function AttendanceScreen({ attendance, busy, err, bands, streaks }) {
  // The screen's OWN data decides; a failure elsewhere shows as text in its place.
  if (!attendance) return busy ? <LoadingScreen /> : <Screen><ErrBox>{err || "Could not load attendance."}</ErrBox></Screen>;
  const cur = attendance.current || {};
  const curUnits = cur.units || cur.modules || [];
  const o = cur.overall || {};
  const previous = attendance.previous || [];
  const overallTone = attendanceTone(o.pct ?? null, bands);

  return (
    <div className="space-y-3.5 px-4 pb-8 pt-5">
      <div className="tone-panel fade-up rounded-3xl p-5 shadow-card-lg ring-1" style={toneVars(overallTone)}>
        <div className="flex flex-col items-center">
          <Ring pct={o.pct ?? null} label="current units" tone={overallTone} />
          <p className="mt-2 text-[11px] font-semibold text-slate-400 dark:text-slate-400">{o.marked ?? 0} marked session{(o.marked ?? 0) === 1 ? "" : "s"} across {curUnits.length} unit{curUnits.length === 1 ? "" : "s"}</p>
        </div>
        <div className="mt-4"><StatusBar counts={o} /></div>
      </div>

      <SectionTitle colour={ACCENT.attendance}>Current units</SectionTitle>
      <Card className="!p-0 overflow-hidden">
        {curUnits.map(mr => <UnitAtt key={unitOf(mr).id} mr={mr} bands={bands} />)}
        {curUnits.length === 0 && <Empty icon={CalendarCheck} title="No current units" msg="Units you're enrolled on will appear here once teaching starts." />}
      </Card>

      {previous.length > 0 && (
        <>
          <SectionTitle colour="#94a3b8">Previous units · {previous.length}</SectionTitle>
          <Card className="!p-0 overflow-hidden">{previous.map(mr => <UnitAtt key={unitOf(mr).id} mr={mr} ended bands={bands} />)}</Card>
        </>
      )}

      <div className="fade-up rounded-3xl bg-white p-4 shadow-card ring-1 ring-slate-200/60 dark:bg-slate-800 dark:ring-slate-700/60">
        <p className="mb-2.5 text-[10px] font-extrabold uppercase tracking-widest text-slate-400 dark:text-slate-500">How it's counted</p>
        <div className="grid grid-cols-2 gap-y-1.5">
          {ATT.map(a => (
            <div key={a.key} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: a.colour }} />
              <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">{a.key} — {a.label}</span>
            </div>
          ))}
        </div>
        <p className="mt-2.5 text-[10px] leading-relaxed text-slate-400 dark:text-slate-500">Present scores 2, Late and Excused score 1, Absent scores 0. Only sessions that have been marked are counted.</p>
      </div>

      {/* Badges — the full inventory, earned and not. Home's own streak card is the
          GLANCE (current + best); this is the RECORD, which is why it lives here
          rather than being duplicated onto Home. Rendered only once /me/streaks has
          actually answered (streaks starts null, never []) — an unearned badge is a
          real thing to show, an unknown one is not. */}
      {streaks && (
        <>
          <SectionTitle colour={ACCENT.attendance}>Badges</SectionTitle>
          <div className="grid grid-cols-2 gap-2.5">
            {BADGES.map((b) => {
              const earned = (streaks.badges || []).find((x) => x.key === b.key);
              const tone = toneFromColour(ACCENT.attendance);
              return (
                <div key={b.key} className={`rounded-2xl p-3.5 text-center ring-1 ${earned ? "tone-soft" : "bg-slate-50 ring-slate-200/70 dark:bg-slate-700/30 dark:ring-slate-700/60"}`} style={earned ? toneVars(tone) : undefined}>
                  {/* Unearned is GREYED, never hidden — a badge you cannot see is not
                      a goal, it is a secret. Opacity, not a different icon set: the
                      same glyph earned and not is what makes "not yet" read as a
                      step ahead rather than a different, lesser feature. */}
                  <span className={`mx-auto flex h-9 w-9 items-center justify-center rounded-xl ${earned ? "tone-soft" : "bg-slate-200/70 dark:bg-slate-600/40"}`} style={earned ? toneVars(tone) : undefined}>
                    <b.Icon size={16} className={earned ? undefined : "text-slate-400 dark:text-slate-500"} />
                  </span>
                  <p className={`mt-2 text-[11.5px] font-extrabold ${earned ? "tone-text" : "text-slate-400 dark:text-slate-500"}`} style={earned ? toneVars(tone) : undefined}>{b.label}</p>
                  <p className="mt-0.5 text-[10px] leading-snug text-slate-400 dark:text-slate-500">{earned ? `Earned ${fmtDate(earned.earnedOn)}` : b.desc}</p>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export default AttendanceScreen;
