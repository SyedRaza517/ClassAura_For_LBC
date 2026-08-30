// Assessment Tracker — one row per assessment, grouped under its module.
//
// THE RENDERING RULE THIS SCREEN EXISTS TO GET RIGHT.
//
// Three of these columns have no data source yet: AssessmentSubmission is read by the
// prediction engine and written by nothing until the LMS sync is built. So `submitted`,
// the submission rate and the marking percentage all arrive as null, and they are shown
// as "Not synced" — never as 0%, never as an empty cell.
//
// A 0% submission rate would put every module in the college on a watchlist for
// something nobody has measured, and an empty cell reads as a rendering fault. The
// muted words are the only honest option, and they are the difference between a screen
// that says "we do not know" and one that says "nobody handed anything in".
//
// TWO MARKING COLUMNS, AND THEY ARE NOT INTERCHANGEABLE.
//
//   Marked of submitted — the marking backlog. You cannot mark a script nobody handed
//     in, so 20 of 20 submitted is a finished job at 100%. Null until the sync lands.
//   Marked of cohort    — how far through the whole cohort this module is. Measurable
//     today from the grades the Moodle sync already writes.
//
// The second is NEVER used as a fallback for the first. One column whose denominator
// silently changes from row to row is worse than a blank one: the reader cannot tell
// which question any given cell answered, so they stop trusting all of them.
import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Gauge, Loader2, AlertTriangle, RefreshCw, CloudDownload, Users, Info,
} from "lucide-react";
import { api } from "./api";
import { NAVY } from "./branding";

function Banner({ tone, Icon, children }) {
  const tones = {
    rose: "bg-rose-50 text-rose-700 ring-rose-200",
    amber: "bg-amber-50 text-amber-700 ring-amber-200",
    emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    slate: "bg-slate-50 text-slate-600 ring-slate-200",
  };
  return (
    <div className={`flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-[13px] font-medium ring-1 ${tones[tone] || tones.slate}`}>
      {Icon && <Icon size={15} className="mt-0.5 shrink-0" />}
      <span>{children}</span>
    </div>
  );
}

// The one place a missing figure is turned into words.
//
// Two different sentences, because they are two different facts. `recordsSubmissions`
// false means no integration anywhere feeds this column, so "Not synced" explains the
// whole screen. True means the college does record submissions and this particular
// assessment has not been covered, which is "Awaiting sync" — a gap, not an absence.
// Neither is a statement about any student.
const Unknown = ({ recordsSubmissions }) => (
  <span className="text-[12px] italic text-slate-400">
    {recordsSubmissions ? "Awaiting sync" : "Not synced"}
  </span>
);

const Pct = ({ value, recordsSubmissions }) =>
  value == null ? <Unknown recordsSubmissions={recordsSubmissions} /> : <span className="font-semibold tabular-nums">{value}%</span>;

// Colour by state. `complete` is deliberately neutral even though its date has passed:
// an assessment fully marked a week late is finished, and painting it red fills the
// screen with rows nobody can act on, which trains people to ignore red.
const STATE_LABEL = {
  overdue: "Overdue", due: "Due today", upcoming: "Upcoming",
  complete: "Marked", none: "No deadline", unknown: "Not synced",
};

// A deadline, coloured by its own state, with the state spelled out underneath rather
// than left to the colour alone — colour is not readable to everyone, and "13 May" in
// red says nothing about WHY to somebody who cannot see the red.
//
// No date at all reads "—" in grey and says "Not set", never "overdue": a college that
// has not set this deadline is unmeasured, not late.
const DEADLINE_TEXT = {
  overdue: "text-rose-700", due: "text-amber-700", upcoming: "text-slate-700",
  complete: "text-emerald-700", none: "text-slate-400", unknown: "text-slate-400",
};
function DeadlineCell({ date, state }) {
  if (!date) return <span className="text-[12px] italic text-slate-400">Not set</span>;
  return (
    <div className="leading-tight">
      <div className={`tabular-nums font-semibold ${DEADLINE_TEXT[state] || DEADLINE_TEXT.none}`}>{date}</div>
      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{STATE_LABEL[state] || ""}</div>
    </div>
  );
}

// Can this person run the Moodle sync?
//
// Gated on registers/students, NOT on assessment-tracker, and that is deliberate.
// POST /api/moodle/sync creates students, enrolments, courses and units; routes/moodle.js
// keeps SYNC_PAGES narrow because an earlier looser gate let an admin holding only app
// configuration create student records and rewrite marks. Rendering the button for a
// tracker-only admin would either reopen that hole or show them a button that 403s.
const SYNC_PAGES = ["registers", "students"];
function canRunSync(me) {
  if (!me) return false;
  if (me.kind === "student" || me.isStudent) return false;
  if (me.isSuperAdmin) return true;
  if (me.accountRole !== "ADMIN") return false;
  const pages = me.adminPages;
  // null means "nobody has configured page restrictions", i.e. unrestricted — the same
  // reading canAccessPage uses in StaffHub.
  return pages == null || (Array.isArray(pages) && SYNC_PAGES.some((p) => pages.includes(p)));
}

export default function AssessmentTracker({ me }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState("");
  const [course, setCourse] = useState("");
  const [cohort, setCohort] = useState("");

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      setData(await api.assessmentTracker({ courseId: course, cohortId: cohort }));
    } catch (e) {
      setErr(e?.message || "Could not load the tracker.");
    } finally { setBusy(false); }
  }, [course, cohort]);
  useEffect(() => { load(); }, [load]);

  const rows = data?.rows || [];
  const recordsSubmissions = !!data?.recordsSubmissions;

  // Filter options come from the rows themselves rather than a second request. The
  // tracker already carries every course and cohort it can show, so a separate lookup
  // could only ever offer options that return nothing.
  const courses = useMemo(() => [...new Set(rows.map((r) => r.courseName).filter(Boolean))].sort(), [rows]);
  const cohorts = useMemo(() => {
    const seen = new Map();
    for (const r of rows) if (r.cohortId && !seen.has(r.cohortId)) seen.set(r.cohortId, r.cohortName || r.cohortId);
    return [...seen.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  }, [rows]);

  // Grouped under the module, which is how the question is actually asked — "how is
  // OBM doing" rather than "how is assignment 2 doing".
  const grouped = useMemo(() => {
    const byUnit = new Map();
    for (const r of rows) {
      if (!byUnit.has(r.unitId)) byUnit.set(r.unitId, { unit: r, items: [] });
      byUnit.get(r.unitId).items.push(r);
    }
    return [...byUnit.values()];
  }, [rows]);

  const runSync = async () => {
    setSyncing(true); setErr(""); setSyncNote("");
    try {
      await api.moodleSync();
      setSyncNote("Sync started. Enrolments and marks will update; reload in a moment.");
    } catch (e) {
      setErr(e?.message || "Could not start the sync.");
    } finally { setSyncing(false); }
  };

  if (busy && !data) {
    return <div className="flex justify-center p-12"><Loader2 className="animate-spin text-slate-300" size={28} /></div>;
  }

  return (
    <div className="space-y-5 p-4 md:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold text-slate-800">
            <Gauge size={18} style={{ color: NAVY }} />Assessment Tracker
          </h2>
          <p className="mt-0.5 text-[13px] text-slate-500">
            Deadlines, submissions and marking progress, one row per assessment.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canRunSync(me) && (
            <button
              onClick={runSync}
              disabled={syncing}
              className="press inline-flex items-center gap-1.5 rounded-xl border-2 border-slate-200 px-3 py-2 text-[13px] font-bold text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50 disabled:opacity-50"
            >
              {syncing ? <Loader2 size={15} className="animate-spin" /> : <CloudDownload size={15} />}
              {syncing ? "Syncing…" : "Sync from Moodle"}
            </button>
          )}
          <button onClick={load} className="press rounded-lg p-2.5 text-slate-500 hover:bg-slate-50" aria-label="Reload the tracker" title="Reload">
            <RefreshCw size={15} />
          </button>
        </div>
      </header>

      <div role="alert" aria-live="assertive">{err && <Banner tone="rose" Icon={AlertTriangle}>{err}</Banner>}</div>
      {syncNote && <Banner tone="emerald" Icon={CloudDownload}>{syncNote}</Banner>}

      {/* Says exactly what the sync does and does not do. It refreshes enrolments and
          marks, which moves the "Marked" and "Marked of cohort" columns — it does not
          fetch submissions, and must not imply that it does. */}
      <Banner tone="slate" Icon={Info}>
        Syncing refreshes enrolments and marks from Moodle. Submission data is not yet imported from any
        LMS — Canvas and Blackboard are not connected — so the submitted and marking-progress columns read
        “Not synced”.
      </Banner>

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[12px] font-semibold text-slate-600">
          <span className="sr-only">Course</span>
          <select
            value={course}
            onChange={(e) => setCourse(e.target.value)}
            aria-label="Filter by course"
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[13px] outline-none focus:border-indigo-300"
          >
            <option value="">All courses</option>
            {courses.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="text-[12px] font-semibold text-slate-600">
          <span className="sr-only">Class</span>
          <select
            value={cohort}
            onChange={(e) => setCohort(e.target.value)}
            aria-label="Filter by class"
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[13px] outline-none focus:border-indigo-300"
          >
            <option value="">All classes</option>
            {cohorts.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
      </div>

      {!grouped.length ? (
        <p className="rounded-2xl border border-slate-200 bg-white px-5 py-10 text-center text-sm text-slate-500">
          No assessments to track yet. They are created on the Assessments page, or imported from Moodle.
        </p>
      ) : (
        <div className="space-y-3">
          {grouped.map(({ unit, items }) => (
            <section key={unit.unitId} className="rounded-2xl border border-slate-200 bg-white">
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3.5">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-bold text-slate-800">
                    <span style={{ color: NAVY }}>{unit.unitCode}</span> · {unit.unitName}
                  </h3>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[12px] text-slate-500">
                    <span>{unit.cohortName || <span className="text-slate-400">— no class —</span>}</span>
                    <span>Leader: {unit.leaderName || <span className="text-slate-400">— not set —</span>}</span>
                    <span>Lecturer: {unit.lecturerName || <span className="text-slate-400">— not set —</span>}</span>
                    <span className="inline-flex items-center gap-1"><Users size={12} />{unit.enrolled}</span>
                  </p>
                </div>
              </header>

              {/* Wide table, own scroll container — the page body must never scroll
                  sideways on a laptop. */}
              <div className="overflow-x-auto">
                {/* 820 → 960: "Total students" was added and the two deadlines now carry
                    a state line under the date, so the old floor let columns collide
                    before the scroll container took over. */}
                <table className="w-full min-w-[960px] text-left text-[13px]">
                  <thead>
                    {/* The five columns the college asked for come first and in their
                        order — total students, total submission, submission rate out of
                        total students, the assessment deadline, the marking deadline.
                        Marking progress follows, because "how many marked of those who
                        submitted" was asked for separately and is the figure marking is
                        actually chased on. */}
                    <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wide text-slate-500">
                      <th className="px-5 py-2 font-bold">Assessment</th>
                      <th className="px-3 py-2 font-bold" title="Students enrolled on this module — the denominator of the submission rate.">
                        Total students
                      </th>
                      <th className="px-3 py-2 font-bold">Total submitted</th>
                      <th className="px-3 py-2 font-bold" title="Submitted ÷ total students enrolled.">
                        Submission rate
                      </th>
                      <th className="px-3 py-2 font-bold" title="When students must hand the work in.">
                        Assessment deadline
                      </th>
                      <th className="px-3 py-2 font-bold" title="When marking must be finished. Set on Tracker Setup — Moodle has no equivalent.">
                        Marking deadline
                      </th>
                      <th className="px-3 py-2 font-bold">Marked</th>
                      <th className="px-3 py-2 font-bold" title="Marked ÷ students who submitted. The marking backlog — you cannot mark a script nobody handed in.">
                        Marked of submitted
                      </th>
                      <th className="px-3 py-2 font-bold" title="Marked ÷ all students enrolled. Measurable without submission data — but on a resubmission, which only concerns the students who failed, this reads low by design.">
                        Marked of cohort
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.map((r) => (
                      <tr key={r.assessmentId}>
                        <td className="px-5 py-2.5 font-semibold text-slate-700">
                          {r.title}
                          <span className="ml-2 text-[11px] font-medium text-slate-400">{r.type}</span>
                        </td>
                        {/* Total students — the denominator of the submission rate, and
                            previously only visible in the module heading. */}
                        <td className="px-3 py-2.5 tabular-nums font-semibold text-slate-700">{r.enrolled}</td>
                        <td className="px-3 py-2.5">
                          {r.submitted == null
                            ? <Unknown recordsSubmissions={recordsSubmissions} />
                            : <span className="tabular-nums font-semibold">{r.submitted} / {r.enrolled}</span>}
                        </td>
                        <td className="px-3 py-2.5"><Pct value={r.submissionRate} recordsSubmissions={recordsSubmissions} /></td>
                        {/* The two deadlines. The state is carried as COLOUR on the date
                            rather than as its own column: it saves a column on an
                            already-wide table, and a date that is its own status reads
                            faster than a date sitting beside a separate pill. */}
                        <td className="px-3 py-2.5"><DeadlineCell date={r.dueDate} state={r.dueState} /></td>
                        <td className="px-3 py-2.5"><DeadlineCell date={r.markingDueDate} state={r.markingState} /></td>
                        <td className="px-3 py-2.5"><span className="tabular-nums font-semibold">{r.marked} / {r.enrolled}</span></td>
                        <td className="px-3 py-2.5"><Pct value={r.markingRate} recordsSubmissions={recordsSubmissions} /></td>
                        <td className="px-3 py-2.5"><Pct value={r.coverageRate} recordsSubmissions={recordsSubmissions} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}

      <div className="space-y-1.5 text-[12px] leading-relaxed text-slate-500">
        <p>
          <strong className="font-semibold text-slate-600">Submission rate</strong> is submitted ÷ total students enrolled.
          <strong className="font-semibold text-slate-600"> Assessment deadline</strong> is when students hand work in;
          <strong className="font-semibold text-slate-600"> marking deadline</strong> is when marking must be finished, and is
          set on Tracker Setup because Moodle has no equivalent.
        </p>
        <p>
          <strong className="font-semibold text-slate-600">Marked of submitted</strong> is the marking backlog — you cannot mark
          a script nobody handed in — and needs submission data.
          <strong className="font-semibold text-slate-600"> Marked of cohort</strong> is marked ÷ all students enrolled and is
          measurable without it. They are separate columns rather than one, because a figure whose denominator changes from row
          to row cannot be read.
        </p>
        <p>
          On a <strong className="font-semibold text-slate-600">resubmission</strong>, which only concerns the students who
          failed first time, marked-of-cohort reads low by design — six resubmissions all marked is still a small fraction of
          the whole class. Marked of submitted is the figure to read on those rows.
        </p>
      </div>
    </div>
  );
}
