// Admission Tracker — the admissions funnel, its conversion rates and what drives them.
//
// This file owns the data: the filters, the fetch, the loading and error state, the CSV
// export. Every panel it renders is a pure function of props and lives in
// AdmissionTrackerPanels.jsx, so neither half has to be read to understand the other.
//
// WHAT THIS SCREEN MAY AND MAY NOT SHOW. It is reachable by staff granted
// "admissions-tracker" and NOT "admissions" — a principal, a marketing lead — and the
// endpoint behind it returns aggregates only: no applicant name, id, email, address or
// document number, ever. So there is no drill-down here and there must not be one. If a
// future row-level view is wanted it belongs on the Admissions screen, behind the grant
// that already opens those records.
//
// THE LOADING RULES ARE COPIED FROM ExecutiveDashboard, WHICH LEARNED THEM THE HARD WAY.
// Only the newest request may write state; a failed reload drops the old figures rather
// than keeping them; and a 403 says the figures are HIDDEN, never zero. Each is
// commented at its site.
import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  TrendingUp, Loader2, AlertTriangle, RefreshCw, Download, Settings2, X, Check,
  Users, FileText, Percent, Target, GraduationCap, Banknote,
} from "lucide-react";
import { api } from "./api";
import { NAVY } from "./branding";
import StatCard from "./StatCard";
import { downloadCSV } from "./csv";
import {
  Panel, Funnel, TrendChart, SourcesDonut, Geography, YieldByCourse, CycleProgress,
  TargetsTable, Empty, fmtPct, fmtMoney, SERIES,
} from "./AdmissionTrackerPanels";

// The width is deliberately NOT baked in. It was, as `w-full`, and that silently broke
// the course-fee rows: `w-full` and a `w-32` added at the call site are both width
// utilities, so the one later in Tailwind's output wins regardless of class order, the
// input took the whole row, and the course name beside it collapsed to zero width. The
// fees were then four unlabelled boxes. Width belongs to the caller.
const inputBase =
  "rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-700 outline-none transition focus:border-slate-400";
const inputCls = `w-full ${inputBase}`;

/* -------------------------------------------------------------------------- */
/* KPI tiles                                                                   */
/* -------------------------------------------------------------------------- */

// The trend chip StatCard renders, built from whichever change the figure carries.
//
// NULL MEANS NO CHIP AT ALL. A first-ever intake has nothing to be compared with, and a
// dashboard that invents "+100%" for it is not merely wrong, it is congratulatory about
// a number it made up. `undefined` is what StatCard reads as "no chip".
const chip = (k, suffix) => {
  const v = suffix === "pp" ? k?.changePp : k?.changePct;
  if (v == null) return undefined;
  return { up: v >= 0, text: `${v > 0 ? "+" : ""}${v}${suffix}` };
};

function Kpis({ stats, comparedTo }) {
  const k = stats.kpis;
  const sub = comparedTo ? `vs ${comparedTo}` : "no comparison period";
  const rev = k.revenue;
  // The coverage caveat rides ON the tile. An estimate built from four of six courses
  // is a different number from one built from all six, and the difference is invisible
  // unless it is written down beside it.
  const revSub =
    rev.pence == null
      ? rev.totalEnrolments > 0 ? `no course fee recorded for ${rev.totalEnrolments} enrolled` : sub
      : rev.coveredEnrolments < rev.totalEnrolments
        ? `from ${rev.coveredEnrolments} of ${rev.totalEnrolments} enrolments`
        : sub;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
      <StatCard label="Enquiries" value={k.enquiries.value} sub={sub} Icon={Users} tone={SERIES[0]} animate trend={chip(k.enquiries, "%")} delay={0} />
      <StatCard label="Applications" value={k.applications.value} sub={sub} Icon={FileText} tone={SERIES[1]} animate trend={chip(k.applications, "%")} delay={40} />
      {/* Rates pass a STRING ("42.6%" or "—"), which StatCard renders as-is rather than
          counting up. A null must arrive as an em dash, never as an animated 0. */}
      <StatCard label="Admit rate" value={fmtPct(k.admitRate.value)} sub={sub} Icon={Percent} tone={SERIES[2]} trend={chip(k.admitRate, "pp")} delay={80} />
      <StatCard label="Yield rate" value={fmtPct(k.yieldRate.value)} sub={sub} Icon={Target} tone={SERIES[3]} trend={chip(k.yieldRate, "pp")} delay={120} />
      <StatCard label="Enrolled" value={k.enrolled.value} sub={sub} Icon={GraduationCap} tone={SERIES[4]} animate trend={chip(k.enrolled, "%")} delay={160} />
      <StatCard label="Revenue (est.)" value={fmtMoney(rev.pence)} sub={revSub} Icon={Banknote} tone={SERIES[5]} trend={chip(rev, "%")} delay={200} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Targets and fees                                                            */
/* -------------------------------------------------------------------------- */

// Targets, required documents and course fees, in one modal. Deliberately here rather
// than on the main Settings screen: these are the numbers this dashboard is read
// against, and a target you must leave the page to change is a target nobody changes.
function SettingsModal({ intake, onClose, onSaved }) {
  const [cfg, setCfg] = useState(null);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.admissionTrackerSettings().then(setCfg).catch((e) => setErr(e.message || "Could not load settings"));
  }, []);

  // Which target set is being edited: the default, or this intake's override.
  const scopeLabel = intake || "All intakes (default)";
  const targets = useMemo(() => {
    if (!cfg) return {};
    const base = cfg.targets?.default || {};
    return intake ? { ...base, ...(cfg.targets?.byIntake?.[intake] || {}) } : base;
  }, [cfg, intake]);

  const setTarget = (key, raw) => {
    // An empty box means NO TARGET, which is null — not 0. A 0 target is one every
    // actual beats, and a dashboard full of green chips nobody set is worse than blank.
    const v = raw === "" ? null : Number(raw);
    const next = { ...targets, [key]: raw === "" ? null : Number.isFinite(v) && v >= 0 ? v : null };
    setCfg((c) => ({
      ...c,
      targets: intake
        ? { ...c.targets, byIntake: { ...(c.targets?.byIntake || {}), [intake]: next } }
        : { ...c.targets, default: next },
    }));
  };

  const toggleDoc = (key) => setCfg((c) => {
    const have = c.requiredDocTypes || [];
    return { ...c, requiredDocTypes: have.includes(key) ? have.filter((k) => k !== key) : [...have, key] };
  });

  const setFee = (id, raw) =>
    setCfg((c) => ({ ...c, courses: c.courses.map((x) => (x.id === id ? { ...x, feeAmountPence: raw === "" ? null : Math.round(Number(raw) * 100) } : x)) }));

  const save = async () => {
    setSaving(true); setErr("");
    try {
      await api.saveAdmissionTrackerSettings({
        targets: cfg.targets,
        requiredDocTypes: cfg.requiredDocTypes,
        courseFees: Object.fromEntries(cfg.courses.map((c) => [c.id, c.feeAmountPence])),
      });
      onSaved();
      onClose();
    } catch (e) { setErr(e.message || "Could not save"); }
    finally { setSaving(false); }
  };

  const TARGETS = [
    { key: "applications", label: "Applications", unit: "" },
    { key: "admitRate", label: "Admit rate", unit: "%" },
    { key: "yieldRate", label: "Yield rate", unit: "%" },
    { key: "enrolled", label: "Enrolled students", unit: "" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm">
      <div className="my-8 w-full max-w-2xl rounded-2xl bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <h3 className="text-sm font-bold text-slate-800">Tracker settings</h3>
            <p className="text-xs text-slate-400">Targets for <b>{scopeLabel}</b>, required documents and course fees</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" aria-label="Close"><X size={18} /></button>
        </header>

        {!cfg ? (
          <p className="p-8 text-center text-sm text-slate-400">Loading…</p>
        ) : (
          <div className="space-y-6 p-5">
            <section>
              <h4 className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">Targets</h4>
              <p className="mb-3 text-xs text-slate-400">
                Leave a box empty for “no target” — the dashboard then shows a dash rather than
                measuring against zero.
                {intake && " These apply to this intake only; empty boxes fall back to the default."}
              </p>
              <div className="grid grid-cols-2 gap-3">
                {TARGETS.map((t) => (
                  <label key={t.key} className="block">
                    <span className="mb-1 block text-xs font-semibold text-slate-600">{t.label}{t.unit && ` (${t.unit})`}</span>
                    <input type="number" min="0" step="any" className={inputCls}
                      value={targets[t.key] ?? ""} onChange={(e) => setTarget(t.key, e.target.value)} placeholder="none" />
                  </label>
                ))}
              </div>
            </section>

            <section>
              <h4 className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">Required documents</h4>
              <p className="mb-3 text-xs text-slate-400">
                Which documents this college actually asks for. “Documents complete” in the funnel
                counts only these — untick the ones you do not chase, or the stage reads low for
                everybody. Unticking them all falls back to requiring every type.
              </p>
              <div className="flex flex-wrap gap-2">
                {(cfg.allDocTypes || []).map((d) => {
                  const on = (cfg.requiredDocTypes || []).includes(d.key);
                  return (
                    <button key={d.key} type="button" onClick={() => toggleDoc(d.key)}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition ${
                        on ? "border-transparent text-white" : "border-slate-200 bg-white text-slate-500 hover:border-slate-300"}`}
                      style={on ? { background: NAVY } : undefined}>
                      {on && <Check size={12} />}{d.label}
                    </button>
                  );
                })}
              </div>
            </section>

            <section>
              <h4 className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">Course fees</h4>
              <p className="mb-3 text-xs text-slate-400">
                Used for the estimated revenue tile. A course left blank is <b>excluded</b> from the
                estimate and reported as uncovered — it is not treated as free. This is an estimate
                until real funding data is available.
              </p>
              <div className="space-y-2">
                {cfg.courses.map((c) => (
                  <label key={c.id} className="flex items-center gap-3">
                    <span className="flex-1 truncate text-xs text-slate-600" title={c.name}>{c.name}</span>
                    <span className="text-xs text-slate-400">£</span>
                    <input type="number" min="0" step="0.01" className={`w-32 shrink-0 ${inputBase}`} placeholder="not set"
                      value={c.feeAmountPence == null ? "" : c.feeAmountPence / 100}
                      onChange={(e) => setFee(c.id, e.target.value)} />
                  </label>
                ))}
                {!cfg.courses.length && <Empty>No courses in the admissions course list yet.</Empty>}
              </div>
            </section>

            {err && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</p>}
          </div>
        )}

        <footer className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-slate-500 hover:bg-slate-100">Cancel</button>
          <button onClick={save} disabled={!cfg || saving}
            className="rounded-lg px-4 py-1.5 text-sm font-bold text-white disabled:opacity-50" style={{ background: NAVY }}>
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}


/* -------------------------------------------------------------------------- */
/* The screen                                                                  */
/* -------------------------------------------------------------------------- */

export default function AdmissionTracker() {
  const [stats, setStats] = useState(null);
  const [options, setOptions] = useState({ courses: [], intakes: [] });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [showSettings, setShowSettings] = useState(false);

  const [intake, setIntake] = useState("");
  const [course, setCourse] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [compare, setCompare] = useState("");

  // Only the NEWEST request may write state. Switching intake twice quickly could
  // otherwise let the first response land last, painting September 2025's funnel under
  // September 2026's heading — the stale-numbers symptom that is worst precisely
  // because nothing on screen looks wrong.
  const seq = useRef(0);

  const load = useCallback(async (scope) => {
    const mine = ++seq.current;
    setLoading(true); setErr("");
    try {
      const data = await api.admissionStats(scope);
      if (mine !== seq.current) return;   // a newer request has already answered
      setStats(data);
    } catch (e) {
      if (mine !== seq.current) return;
      // A failed reload DROPS the old figures. Leaving them showed the previous
      // intake's funnel under the new intake's name — worse than showing nothing,
      // because it looks right.
      setStats(null);
      setErr(e?.status === 403
        ? "These figures are hidden — your account doesn't have access to the admission tracker."
        : (e?.message || "Could not load the admission tracker"));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load({ intake, course, from, to, compare }); }, [load, intake, course, from, to, compare]);

  useEffect(() => {
    // The filter options come from the settings endpoint, which is behind the same
    // gate. A failure here must not blank the dashboard — it only costs the dropdowns.
    api.admissionTrackerSettings()
      .then((c) => setOptions({ courses: c.courses || [], intakes: c.intakes || [] }))
      .catch(() => {});
  }, []);

  const exportCsv = () => {
    if (!stats) return;
    // The funnel is the table worth taking away. Conversion is left as a number or a
    // blank cell — never "0%" for a stage nobody could measure, which is the same rule
    // the screen follows and the reason this is not a naive stringify.
    downloadCSV(
      `admission-funnel${intake ? `-${intake.replace(/\s+/g, "-").toLowerCase()}` : ""}.csv`,
      [
        { key: "label", label: "Stage" },
        { key: "count", label: "Applicants" },
        { key: "conversion", label: "Conversion from previous (%)" },
      ],
      stats.funnel.map((s) => ({ ...s, conversion: s.conversionFromPrevious ?? "" })),
    );
  };

  const comparedTo = stats?.scope?.comparedTo;
  const busy = loading && !stats;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-extrabold text-slate-800">
            <TrendingUp size={20} style={{ color: NAVY }} /> Admission Tracker
          </h2>
          <p className="text-xs text-slate-400">
            Conversion across the admission cycle. Aggregate figures only — no applicant records are shown here.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setShowSettings(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-slate-300">
            <Settings2 size={14} /> Targets &amp; fees
          </button>
          <button onClick={exportCsv} disabled={!stats}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-slate-300 disabled:opacity-50">
            <Download size={14} /> Download report
          </button>
          <button onClick={() => load({ intake, course, from, to, compare })}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold text-white" style={{ background: NAVY }}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </header>

      {/* Filters in one row above the charts, so the scope of every panel is stated
          once rather than implied per panel. */}
      <div className="grid grid-cols-2 gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200/70 lg:grid-cols-5">
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-400">Intake</span>
          <select className={inputCls} value={intake} onChange={(e) => setIntake(e.target.value)}>
            <option value="">All intakes</option>
            {options.intakes.map((i) => <option key={i.label} value={i.label}>{i.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-400">Course</span>
          <select className={inputCls} value={course} onChange={(e) => setCourse(e.target.value)}>
            <option value="">All courses</option>
            {options.courses.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-400">Enquired from</span>
          <input type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-400">Enquired to</span>
          <input type="date" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-400">Compare to</span>
          <select className={inputCls} value={compare} onChange={(e) => setCompare(e.target.value)}>
            {/* "Automatic" is the previous intake, or the preceding window of the same
                length — and honestly nothing at all when neither exists. */}
            <option value="">Automatic</option>
            <option value="none">No comparison</option>
            {options.intakes.map((i) => <option key={i.label} value={i.label}>{i.label}</option>)}
          </select>
        </label>
      </div>

      {err && (
        <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {err}
        </p>
      )}

      {busy && (
        <p className="flex items-center justify-center gap-2 py-16 text-sm text-slate-400">
          <Loader2 size={18} className="animate-spin" /> Loading the admission funnel…
        </p>
      )}

      {stats && (
        <>
          <Kpis stats={stats} comparedTo={comparedTo} />

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Panel className="xl:col-span-2" title="Admission funnel"
              hint={comparedTo ? `Scope compared with ${comparedTo}` : "No comparable earlier period"}>
              <Funnel funnel={stats.funnel} overallConversion={stats.overallConversion} />
            </Panel>
            <Panel title="Admission cycle progress" hint="Where this scope has got to">
              <CycleProgress funnel={stats.funnel} />
            </Panel>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Panel className="xl:col-span-2" title="Trend over time" hint="By month, from the date each step was recorded">
              <TrendChart trend={stats.trend} />
            </Panel>
            <Panel title="Applications by source" hint="How applicants say they found the college">
              <SourcesDonut sources={stats.sources} />
            </Panel>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Panel title="Key metrics vs targets" hint={intake ? `Targets for ${intake}` : "Default targets"}>
              <TargetsTable targets={stats.targets} />
            </Panel>
            <Panel title="Yield rate by course" hint="Enrolled as a share of offers sent">
              <YieldByCourse rows={stats.yieldByCourse} />
            </Panel>
            <Panel title="Where applicants come from" hint="Citizenship and UK region">
              <Geography geography={stats.geography} />
            </Panel>
          </div>
        </>
      )}

      {showSettings && (
        <SettingsModal
          intake={intake}
          onClose={() => setShowSettings(false)}
          onSaved={() => load({ intake, course, from, to, compare })}
        />
      )}
    </div>
  );
}
