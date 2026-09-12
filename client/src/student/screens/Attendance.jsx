import { CalendarCheck } from "lucide-react";
import { Screen, LoadingScreen, ErrBox, SectionTitle, Card, Ring, StatusBar, Empty } from "../ui";
import { ACCENT, pctTone, ATT } from "../ui/tokens";
import { fmtPct, fmtDate, unitOf } from "../utils";
import { NAVY, NAVY_DARK } from "../../branding";

function UnitAtt({ mr, ended }) {
  const s = mr.summary || {}; const t = pctTone(s.pct); const u = unitOf(mr);
  return (
    <div className="border-t border-slate-100 px-3.5 py-3 first:border-t-0">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-12 shrink-0 items-center justify-center rounded-xl text-[10px] font-extrabold text-white" style={{ background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` }}>{(u.code || "?").slice(0, 5)}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-bold text-slate-700" title={u.name}>{u.name}</p>
          <p className="mt-0.5 text-[10px] font-medium text-slate-400">
            {ended ? `Ended ${fmtDate(mr.endDate)}` : `${s.marked ?? 0} session${(s.marked ?? 0) === 1 ? "" : "s"} marked`}
          </p>
        </div>
        <span className={`shrink-0 rounded-xl px-2.5 py-1.5 text-sm font-extrabold tabular-nums ring-1 ${t.bg} ${t.text} ${t.ring}`}>{fmtPct(s.pct)}</span>
      </div>
      {!ended && (
        <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full" style={{ width: `${s.pct ?? 0}%`, background: t.colour, transition: "width 1s cubic-bezier(.4,0,.2,1)" }} />
        </div>
      )}
    </div>
  );
}

export function AttendanceScreen({ attendance, busy, err }) {
  // The screen's OWN data decides; a failure elsewhere shows as text in its place.
  if (!attendance) return busy ? <LoadingScreen /> : <Screen><ErrBox>{err || "Could not load attendance."}</ErrBox></Screen>;
  const cur = attendance.current || {};
  const curUnits = cur.units || cur.modules || [];
  const o = cur.overall || {};
  const previous = attendance.previous || [];

  return (
    <div className="space-y-3.5 px-4 pb-8 pt-5">
      <div className="fade-up rounded-3xl p-5 shadow-card-lg ring-1" style={{ background: pctTone(o.pct).soft, "--tw-ring-color": pctTone(o.pct).colour + "2e" }}>
        <div className="flex flex-col items-center">
          <Ring pct={o.pct ?? null} label="current units" />
          <p className="mt-2 text-[11px] font-semibold text-slate-400">{o.marked ?? 0} marked session{(o.marked ?? 0) === 1 ? "" : "s"} across {curUnits.length} unit{curUnits.length === 1 ? "" : "s"}</p>
        </div>
        <div className="mt-4"><StatusBar counts={o} /></div>
      </div>

      <SectionTitle colour={ACCENT.attendance}>Current units</SectionTitle>
      <Card className="!p-0 overflow-hidden">
        {curUnits.map(mr => <UnitAtt key={unitOf(mr).id} mr={mr} />)}
        {curUnits.length === 0 && <Empty icon={CalendarCheck} title="No current units" msg="Units you're enrolled on will appear here once teaching starts." />}
      </Card>

      {previous.length > 0 && (
        <>
          <SectionTitle colour="#94a3b8">Previous units · {previous.length}</SectionTitle>
          <Card className="!p-0 overflow-hidden">{previous.map(mr => <UnitAtt key={unitOf(mr).id} mr={mr} ended />)}</Card>
        </>
      )}

      <div className="fade-up rounded-3xl bg-white p-4 shadow-card ring-1 ring-slate-200/60">
        <p className="mb-2.5 text-[10px] font-extrabold uppercase tracking-widest text-slate-400">How it's counted</p>
        <div className="grid grid-cols-2 gap-y-1.5">
          {ATT.map(a => (
            <div key={a.key} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: a.colour }} />
              <span className="text-[11px] font-semibold text-slate-600">{a.key} — {a.label}</span>
            </div>
          ))}
        </div>
        <p className="mt-2.5 text-[10px] leading-relaxed text-slate-400">Present scores 2, Late and Excused score 1, Absent scores 0. Only sessions that have been marked are counted.</p>
      </div>
    </div>
  );
}

export default AttendanceScreen;
