import { Award } from "lucide-react";
import { Screen, LoadingScreen, ErrBox, SectionTitle, Card, Ring, Empty, toneFromColour } from "../ui";
import { ACCENT, gradeTone, MOTION_MS, toneVars } from "../ui/tokens";
import { fmtDate } from "../utils";
import { NAVY, NAVY_DARK } from "../../branding";

export function ResultsScreen({ results, busy, err }) {
  // Same here: missing results is what blanks this screen, not any error at all.
  if (!results) return busy ? <LoadingScreen /> : <Screen><ErrBox>{err || "Could not load results."}</ErrBox></Screen>;
  const list = results.assessments || [];
  const graded = list.filter(a => a.pct != null);
  const bands = { Distinction: 0, Merit: 0, Pass: 0, Fail: 0 };
  graded.forEach(a => { if (bands[a.grade] != null) bands[a.grade]++; });
  // Derived from gradeTone so the band tiles can never drift from the mark chips
  // below them — they disagreed once already.
  const BAND_TONE = { Distinction: gradeTone(75), Merit: gradeTone(65), Pass: gradeTone(55), Fail: gradeTone(20) };
  const avgTone = gradeTone(results.averagePct);

  return (
    <div className="space-y-3.5 px-4 pb-8 pt-5">
      <div className="tone-panel fade-up rounded-3xl p-5 shadow-card-lg ring-1" style={toneVars(avgTone)}>
        <div className="flex flex-col items-center">
          {/* "weighted average" only when it actually IS one — averageIsWeighted is
              true only when at least one GRADED item carries a real, college-set
              weight (see /me/assessments's own comment: 0/missing weight is the
              equal-weighting fallback wearing the same field name, never a true
              weight of zero). A college that has set no weights at all gets the
              plain "average" label it always has, rather than a word implying a
              maths it isn't doing. */}
          <Ring pct={results.averagePct ?? null} label={results.averageIsWeighted ? "weighted average" : "average"} tone={avgTone} />
          <span className="tone-soft mt-2 rounded-xl px-3 py-1 text-sm font-extrabold ring-1" style={toneVars(avgTone)}>
            {results.averageGrade || "Not graded yet"}
          </span>
          <p className="mt-1.5 text-[11px] font-semibold text-slate-400 dark:text-slate-400">{results.graded} of {results.count} assessment{results.count === 1 ? "" : "s"} marked</p>
        </div>
        {graded.length > 0 && (
          // min-w-0 + truncate, the same pair (and the same reasoning) as the
          // attendance legend in ui/StatusBar.jsx: a grid item will not go narrower
          // than its own longest word, and "Distinction" at 9px is within a few pixels
          // of the 57px a quarter of this panel leaves at 320px. Dropping to
          // `grid-cols-2 sm:grid-cols-4` was rejected — these four are a single ladder
          // and reading it as one row is the point, where the Quick-actions grid on
          // Home is a list that happens to be laid out in columns.
          <div className="mt-4 grid grid-cols-4 gap-1.5">
            {Object.entries(bands).map(([b, n]) => (
              <div key={b} className="tone-soft min-w-0 rounded-xl py-1.5 text-center" style={toneVars(BAND_TONE[b])}>
                <p className="tone-text text-sm font-extrabold tabular-nums" style={toneVars(BAND_TONE[b])}>{n}</p>
                <p className="truncate text-[9px] font-semibold text-slate-500 dark:text-slate-400">{b}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <SectionTitle colour={ACCENT.results}>Your assessments</SectionTitle>
      <div className="space-y-2.5">
        {list.map(a => {
          const t = gradeTone(a.pct);
          const done = a.marks != null;
          return (
            <Card key={a.id} className="!p-3.5">
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-8 w-12 shrink-0 items-center justify-center rounded-xl text-[10px] font-extrabold text-white" style={{ background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` }}>{(a.unitCode || a.moduleCode || "?").slice(0, 5)}</span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 break-words text-[13px] font-extrabold text-slate-700 dark:text-slate-200">
                    {a.title}
                    {/* HIDDEN AT 1% AND AT "NOT SET", judged rather than specified.
                        Assessment.weight is an Int that DEFAULTS TO 0 for "the
                        college has not set one" (schema.prisma), so 0 is never a
                        real 0% weighting — it is silence, and printing "0% weight"
                        would read as "this counts for nothing", which is false (it
                        falls back to equal weighting in the average, per
                        averageIsWeighted's own comment). A weight of exactly 1 is
                        kept out for the same reason on the other end: weights are
                        college-set percentages that are meant to describe a real
                        share of the unit (and typically sum to 100 across it), and
                        "1%" is far more likely a leftover default from an import
                        than a college's genuine choice — showing it would read as a
                        real, deliberately tiny weighting when it almost certainly
                        is not. Any other value, including small genuine ones like
                        5%, is shown as typed. */}
                    {a.weight != null && a.weight !== 0 && a.weight !== 1 && (
                      <span className="tone-soft rounded-full px-1.5 py-0.5 text-[9.5px] font-bold" style={toneVars(toneFromColour(ACCENT.results))}>{a.weight}% weight</span>
                    )}
                  </p>
                  <p className="truncate text-[11px] text-slate-400 dark:text-slate-500">{a.unitName || a.moduleName} · {a.type}{a.dueDate ? ` · due ${fmtDate(a.dueDate)}` : ""}</p>
                </div>
                {done
                  ? <span className="tone-soft shrink-0 rounded-xl px-2.5 py-1.5 text-center text-xs font-extrabold tabular-nums ring-1" style={toneVars(t)}>{a.marks}/{a.maxMarks}<span className="block text-[9px] font-bold">{a.grade}</span></span>
                  : <span className="shrink-0 rounded-xl bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold text-slate-400 dark:bg-slate-700 dark:text-slate-400">Pending</span>}
              </div>
              {done && (
                <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700">
                  <div className="h-full rounded-full" style={{ width: `${a.pct ?? 0}%`, background: t.colour, transition: `width ${MOTION_MS.barFill}ms cubic-bezier(.4,0,.2,1)` }} />
                </div>
              )}
              {a.feedback ? <p className="mt-2.5 break-words rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-slate-700/60 dark:text-slate-400"><span className="font-bold text-slate-600 dark:text-slate-300">Feedback: </span>{a.feedback}</p> : null}
            </Card>
          );
        })}
        {list.length === 0 && <Card className="!p-0"><Empty icon={Award} title="No assessments yet" msg="Assessments set for your units will show here, along with your marks and feedback." /></Card>}
      </div>
    </div>
  );
}

export default ResultsScreen;
