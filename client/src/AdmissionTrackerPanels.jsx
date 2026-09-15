// The Admission Tracker's panels. Presentational only: every one of these is a pure
// function of its props — no fetching, no state beyond a local view toggle, no
// knowledge of filters. AdmissionTracker.jsx owns all of that.
//
// The split is not ceremony. StaffHub.jsx is ~15,800 lines and is verified only by the
// build compiling; a screen of this size added to it is a screen nobody can read. Here,
// a panel can be understood without reading the fetch logic and the fetch logic without
// reading nine chart configurations.
//
// NULL IS NOT ZERO, ON SCREEN TOO. The server sends null for every figure it could not
// measure — a yield rate with no offers yet, a target nobody set, a revenue estimate
// with no course fee recorded. Every one of those renders as an em dash. This is the
// last place the distinction can be lost, and losing it here undoes the care taken
// everywhere else: a college that has sent no offers must not read "0% yield".
//
// COLOUR. The series palette below was validated with the dataviz skill's checker
// against this app's white card surface — lightness band, chroma floor, colourblind
// separation on every pair (not merely adjacent ones), and contrast. Two slots sit
// under 3:1 against white, which obliges visible labels rather than colour alone; every
// chart here carries a legend and direct labels, which is that relief. Do not add a
// ninth series by inventing a hue — fold it into "Other".
import React, { useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell, BarChart, Bar,
} from "recharts";

/* -------------------------------------------------------------------------- */
/* Palette and formatting                                                      */
/* -------------------------------------------------------------------------- */

// Fixed order, never cycled. A series keeps its colour when a filter changes the number
// of series, because colour follows the entity and not its rank.
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#4a3aa7", "#e87ba4", "#eda100"];

// One hue, stepping darker down the funnel. The WIDTH of each bar carries the
// magnitude; the ramp carries depth through the process, so the two encode different
// things rather than saying the same thing twice. No step is lighter than the 2:1
// contrast floor against white.
const FUNNEL_RAMP = ["#86b6ef", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95"];

// The bucket for data that could not be read is deliberately GREY, not a series colour.
// It is a caveat, not a category, and colouring it like one invites somebody to read
// "Unknown" as a place students come from.
const MUTED = "#94a3b8";

const INK = "#334155";      // slate-700 — figures and labels
const INK_SOFT = "#64748b"; // slate-500 — axes, secondary text
const GRID = "#e2e8f0";     // slate-200

// The em dash that means "we could not measure this". One helper, so no panel can
// quietly decide that a missing figure looks like a zero.
export const DASH = "—";
export const fmtNum = (n) => (n == null ? DASH : n.toLocaleString("en-GB"));
export const fmtPct = (n) => (n == null ? DASH : `${n}%`);
export const fmtMoney = (pence) =>
  pence == null ? DASH : `£${Math.round(pence / 100).toLocaleString("en-GB")}`;

/* -------------------------------------------------------------------------- */
/* Shared chrome                                                               */
/* -------------------------------------------------------------------------- */

export function Panel({ title, hint, right, children, className = "" }) {
  return (
    <section className={`rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200/70 ${className}`}>
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-slate-700">{title}</h3>
          {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

// Nothing to draw is a sentence, not an empty box. An empty chart area reads as a
// failed render, which sends somebody looking for a bug in the dashboard.
export const Empty = ({ children }) => (
  <p className="py-10 text-center text-sm text-slate-500">{children}</p>
);

// A small segmented control, for the panels that answer two questions.
export function Toggle({ options, value, onChange }) {
  return (
    <div className="flex rounded-lg bg-slate-100 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
            value === o.value ? "bg-white text-slate-700 shadow-sm" : "text-slate-500 hover:text-slate-700"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// One tooltip for every chart here, so a figure reads the same way whichever panel it
// is in — and so a null arrives as an em dash rather than as "null".
function ChartTip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg">
      {label != null && <p className="mb-1 font-bold text-slate-700">{label}</p>}
      {payload.map((p) => (
        <p key={p.dataKey ?? p.name} className="flex items-center gap-2 text-slate-600">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: p.color || p.payload?.fill }} />
          <span>{p.name}</span>
          <b className="ml-auto tabular-nums text-slate-800">
            {unit === "percent" ? fmtPct(p.value) : fmtNum(p.value)}
          </b>
        </p>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The funnel                                                                  */
/* -------------------------------------------------------------------------- */

export function Funnel({ funnel = [], overallConversion }) {
  if (!funnel.length) return <Empty>No applications in this scope yet.</Empty>;
  const top = funnel[0]?.count || 0;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-[11px] font-bold uppercase tracking-wide text-slate-500">
        <span>Stage</span>
        <span>Conversion</span>
      </div>
      <ol className="space-y-1.5">
        {funnel.map((s, i) => {
          // Width is the magnitude. A floor of 8% keeps a stage with one applicant wide
          // enough to hold its own label — a bar too narrow to read is a stage that
          // looks absent rather than small.
          const width = top > 0 ? Math.max(8, (s.count / top) * 100) : 8;
          return (
            <li key={s.key} className="flex items-center gap-3">
              <div className="w-32 shrink-0 text-right">
                <p className="text-xs font-semibold text-slate-600">{s.label}</p>
                <p className="text-xs tabular-nums text-slate-500">{fmtNum(s.count)}</p>
              </div>
              <div className="flex-1">
                <div
                  className="flex h-9 items-center justify-center rounded-md text-xs font-bold text-white transition-all duration-500"
                  style={{ width: `${width}%`, marginLeft: `${(100 - width) / 2}%`, background: FUNNEL_RAMP[i] || FUNNEL_RAMP.at(-1) }}
                >
                  {fmtNum(s.count)}
                </div>
              </div>
              <div className="w-14 shrink-0 text-right text-xs font-bold tabular-nums text-slate-500">
                {/* Null for the first stage, and whenever the stage above is empty. A
                    conversion out of nobody is unanswerable, not 0%. */}
                {fmtPct(s.conversionFromPrevious)}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="mt-4 flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
        <span className="text-xs font-semibold text-slate-500">Overall conversion (enquiry to enrolled)</span>
        <span className="text-sm font-extrabold tabular-nums" style={{ color: SERIES[0] }}>{fmtPct(overallConversion)}</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Trend over time                                                             */
/* -------------------------------------------------------------------------- */

const TREND_LINES = [
  { key: "enquiries", name: "Enquiries", color: SERIES[0] },
  { key: "applications", name: "Applications", color: SERIES[1] },
  { key: "offers", name: "Offers", color: SERIES[2] },
  { key: "enrolled", name: "Enrolled", color: SERIES[3] },
];

// "2026-01" → "Jan 26". Built from the string, never from a Date: parsing "2026-01" as
// a date and formatting it re-introduces exactly the timezone slip the server went to
// the trouble of avoiding when it bucketed these months.
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtPeriod = (p) => {
  const [y, m] = String(p).split("-");
  return `${MONTH_ABBR[Number(m) - 1] || m} ${String(y).slice(2)}`;
};

export function TrendChart({ trend = [] }) {
  if (!trend.length) return <Empty>Nothing to plot in this scope yet.</Empty>;
  const data = trend.map((p) => ({ ...p, label: fmtPeriod(p.period) }));
  return (
    <div style={{ height: 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: INK_SOFT }} tickLine={false} axisLine={{ stroke: GRID }} />
          <YAxis tick={{ fontSize: 11, fill: INK_SOFT }} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip content={<ChartTip />} />
          {/* A legend is not optional above one series: identity must never rest on
              colour alone, and two of these hues sit under 3:1 against white. */}
          <Legend iconType="circle" wrapperStyle={{ fontSize: 12, color: INK }} />
          {TREND_LINES.map((l) => (
            <Line
              key={l.key}
              type="monotone"
              dataKey={l.key}
              name={l.name}
              stroke={l.color}
              strokeWidth={2}
              dot={{ r: 2.5, strokeWidth: 0, fill: l.color }}
              activeDot={{ r: 5, strokeWidth: 2, stroke: "#fff" }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Applications by source                                                      */
/* -------------------------------------------------------------------------- */

export function SourcesDonut({ sources = [] }) {
  if (!sources.length) return <Empty>No applications in this scope yet.</Empty>;
  const total = sources.reduce((a, s) => a + s.count, 0);
  const colourOf = (s, i) => (s.source === "Not recorded" ? MUTED : SERIES[i % SERIES.length]);

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row">
      <div className="relative shrink-0" style={{ width: 168, height: 168 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={sources} dataKey="count" nameKey="source" innerRadius={52} outerRadius={80} paddingAngle={2} stroke="#fff" strokeWidth={2}>
              {sources.map((s, i) => <Cell key={s.source} fill={colourOf(s, i)} />)}
            </Pie>
            <Tooltip content={<ChartTip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-extrabold tabular-nums text-slate-800">{fmtNum(total)}</span>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Total</span>
        </div>
      </div>
      {/* The legend carries the figures, not just the names — that is the "visible
          labels" relief the contrast check requires, and it saves a hover. */}
      <ul className="w-full space-y-1.5">
        {sources.map((s, i) => (
          <li key={s.source} className="flex items-center gap-2 text-xs">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colourOf(s, i) }} />
            <span className={s.source === "Not recorded" ? "text-slate-500" : "text-slate-600"}>{s.source}</span>
            <span className="ml-auto tabular-nums font-bold text-slate-700">{fmtPct(s.pct)}</span>
            <span className="w-10 text-right tabular-nums text-slate-500">{fmtNum(s.count)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Horizontal bars — yield by course, and geography                            */
/* -------------------------------------------------------------------------- */

// One measure, one series, so one colour. A different hue per bar would encode
// identity that the axis labels already carry, and burn six categorical slots saying
// nothing.
function BarList({ rows, labelKey, valueKey, format = fmtNum, mutedWhen, scaleMax }) {
  if (!rows.length) return <Empty>Nothing to show in this scope yet.</Empty>;
  // A COUNT scales to the largest bar, because there is no natural ceiling and the
  // question is "which is biggest". A PERCENTAGE scales to 100, because there is one
  // and the question is "how high is this" — scaled to the max instead, a spread of
  // 63.6% to 67.6% draws the lowest bar at 94% of the longest, which reads as four
  // courses performing almost identically well rather than as four values in a narrow
  // band near two thirds. Callers pass scaleMax for anything with a fixed ceiling.
  const max = scaleMax ?? Math.max(...rows.map((r) => Number(r[valueKey]) || 0), 1);
  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const v = r[valueKey];
        const muted = mutedWhen?.(r);
        return (
          <li key={r[labelKey]} className="flex items-center gap-3 text-xs">
            <span className={`w-32 shrink-0 truncate ${muted ? "text-slate-500" : "text-slate-600"}`} title={r[labelKey]}>
              {r[labelKey]}
            </span>
            <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
              <span
                className="block h-full rounded-full transition-all duration-500"
                style={{ width: `${v == null ? 0 : (Number(v) / max) * 100}%`, background: muted ? MUTED : SERIES[0] }}
              />
            </span>
            <b className={`w-14 shrink-0 text-right tabular-nums ${muted ? "text-slate-500" : "text-slate-700"}`}>
              {format(v)}
            </b>
          </li>
        );
      })}
    </ul>
  );
}

export function YieldByCourse({ rows = [] }) {
  return (
    <BarList
      rows={rows}
      labelKey="course"
      valueKey="yieldRate"
      format={fmtPct}
      scaleMax={100}
      // A course with no offers yet has an unmeasurable yield. Greyed and dashed, not
      // ranked at the bottom on a 0% it never earned.
      mutedWhen={(r) => r.yieldRate == null}
    />
  );
}

export function Geography({ geography }) {
  const [view, setView] = useState("country");
  const c = geography?.citizenship || { uk: 0, eu: 0, other: 0, notRecorded: 0 };
  const split = [
    { label: "UK", value: c.uk },
    { label: "EU", value: c.eu },
    { label: "Rest of world", value: c.other },
    { label: "Not recorded", value: c.notRecorded, muted: true },
  ].filter((s) => s.value > 0);
  const splitTotal = split.reduce((a, s) => a + s.value, 0);

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Toggle
          value={view}
          onChange={setView}
          options={[{ value: "country", label: "Country" }, { value: "region", label: "UK region" }]}
        />
      </div>

      {view === "country" ? (
        <div className="space-y-4">
          {/* The fee-status and visa question, which is the one this split is for. */}
          <div>
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100">
              {split.map((s, i) => (
                <span
                  key={s.label}
                  // A 2px surface gap between adjacent fills, so two segments never
                  // read as one longer one.
                  className="h-full"
                  style={{
                    width: `${splitTotal ? (s.value / splitTotal) * 100 : 0}%`,
                    background: s.muted ? MUTED : SERIES[i % SERIES.length],
                    borderRight: i < split.length - 1 ? "2px solid #fff" : undefined,
                  }}
                />
              ))}
            </div>
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {split.map((s, i) => (
                <li key={s.label} className="flex items-center gap-1.5 text-xs">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.muted ? MUTED : SERIES[i % SERIES.length] }} />
                  <span className={s.muted ? "text-slate-500" : "text-slate-600"}>{s.label}</span>
                  <b className="tabular-nums text-slate-700">{fmtNum(s.value)}</b>
                </li>
              ))}
            </ul>
            {!splitTotal && <Empty>No citizenship recorded in this scope.</Empty>}
          </div>
          <div>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-500">Top countries</p>
            <BarList rows={(geography?.topCountries || []).slice(0, 8)} labelKey="country" valueKey="count" />
          </div>
        </div>
      ) : (
        <div>
          <BarList
            rows={geography?.regions || []}
            labelKey="region"
            valueKey="count"
            // "Unknown" is a postcode nobody could read, kept so a partial chart cannot
            // be mistaken for a complete one. Greyed so it reads as the caveat it is.
            mutedWhen={(r) => r.region === "Unknown"}
          />
          <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
            Regions come from the postcode area. Some areas straddle a boundary, so a small
            number of applicants sit one region out; “Unknown” is an address we could not read,
            not an address we do not have.
          </p>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Admission cycle progress                                                    */
/* -------------------------------------------------------------------------- */

// Derived from the funnel rather than fetched: a stage is "under way" once anybody has
// reached it, and "done" once nobody is left at the stage above waiting to. Presentation
// only, which is why it is computed here and not on the server.
export function CycleProgress({ funnel = [] }) {
  if (!funnel.length) return <Empty>No applications in this scope yet.</Empty>;
  return (
    <ol className="relative space-y-4 pl-6">
      <span className="absolute left-[7px] top-2 bottom-2 w-px bg-slate-200" aria-hidden />
      {funnel.map((s, i) => {
        const reached = s.count > 0;
        const next = funnel[i + 1];
        const complete = reached && next && next.count >= s.count;
        return (
          <li key={s.key} className="relative">
            <span
              className="absolute -left-6 top-0.5 flex h-4 w-4 items-center justify-center rounded-full ring-2 ring-white"
              style={{ background: reached ? SERIES[0] : "#e2e8f0" }}
              aria-hidden
            >
              {complete && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
            </span>
            <p className={`text-xs font-bold ${reached ? "text-slate-700" : "text-slate-500"}`}>{s.label}</p>
            <p className="text-xs tabular-nums text-slate-500">
              {/* The status is spelled out, never left to the colour of a dot. */}
              {reached ? `${fmtNum(s.count)} reached` : "not started"}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

/* -------------------------------------------------------------------------- */
/* Key metrics vs targets                                                      */
/* -------------------------------------------------------------------------- */

export function TargetsTable({ targets = [] }) {
  const fmtActual = (t) =>
    t.unit === "percent" ? fmtPct(t.actual) : t.unit === "currency" ? fmtMoney(t.actual) : fmtNum(t.actual);
  const fmtTarget = (t) =>
    t.target == null ? DASH : t.unit === "percent" ? fmtPct(t.target) : t.unit === "currency" ? fmtMoney(t.target) : fmtNum(t.target);

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500">
          <th className="pb-2 font-bold">Metric</th>
          <th className="pb-2 text-right font-bold">Actual</th>
          <th className="pb-2 text-right font-bold">Target</th>
          <th className="pb-2 text-right font-bold">vs target</th>
        </tr>
      </thead>
      <tbody>
        {targets.map((t) => {
          // A rate's distance from its target is in percentage POINTS; a count's is a
          // percentage of the target. Mixing them is how "3pp behind" gets reported as
          // "30% behind" on the same row.
          const v = t.unit === "percent" ? t.variancePp : t.variancePct;
          const suffix = t.unit === "percent" ? "pp" : "%";
          const good = v != null && v >= 0;
          return (
            <tr key={t.key} className="border-b border-slate-100 last:border-0">
              <td className="py-2 font-semibold text-slate-600">{t.label}</td>
              <td className="py-2 text-right tabular-nums font-bold text-slate-800">{fmtActual(t)}</td>
              <td className="py-2 text-right tabular-nums text-slate-500">{fmtTarget(t)}</td>
              <td className="py-2 text-right">
                {v == null ? (
                  // No target set, or an actual nobody could measure. Not a 0% variance,
                  // which reads as "exactly on target".
                  <span className="text-slate-300">{DASH}</span>
                ) : (
                  <span
                    className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-extrabold tabular-nums"
                    style={{ background: good ? "#0ca30c1a" : "#d03b3b1a", color: good ? "#0a7d0a" : "#b83232" }}
                  >
                    {/* The arrow is a second channel beside the colour, so the row is
                        readable without seeing green and red as different. */}
                    {good ? "▲" : "▼"} {v > 0 ? "+" : ""}{v}{suffix}
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
