// Assessment Tracker — Setup.
//
// The fields the tracker needs and nothing else: who leads each module, and by when
// each of its assessments is to be marked. Everything else on this screen is read-only
// and says where it is actually edited.
//
// WHY IT IS NOT AN ASSESSMENT EDITOR. Creating and editing assessments already has a
// screen — the Assessments page — and a second screen that also created them would
// drift from the first. What this one adds is BREADTH: setting a term's marking
// deadlines here is one screen, where doing it on the Assessments page means clicking
// into forty assessments one at a time.
//
// The lecturer is deliberately not editable here either. It is set on the Registers
// screen, and two editors for one column is the same mistake in a smaller size.
import React, { useState, useEffect, useCallback } from "react";
import {
  SlidersHorizontal, Loader2, AlertTriangle, RefreshCw, UserCog, CalendarClock, Users,
} from "lucide-react";
import { api } from "./api";
import { NAVY } from "./branding";

function Banner({ tone, Icon, children }) {
  const tones = {
    rose: "bg-rose-50 text-rose-700 ring-rose-200",
    amber: "bg-amber-50 text-amber-700 ring-amber-200",
    slate: "bg-slate-50 text-slate-600 ring-slate-200",
  };
  return (
    <div className={`flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-[13px] font-medium ring-1 ${tones[tone] || tones.slate}`}>
      {Icon && <Icon size={15} className="mt-0.5 shrink-0" />}
      <span>{children}</span>
    </div>
  );
}

// "Not recorded" — never a blank cell and never a warning colour. A module whose leader
// nobody has named yet is unmeasured, not a finding, and colouring it red would report
// a college part-way through configuring this page as having a problem it does not have.
const NotSet = () => <span className="text-slate-400">— not set —</span>;

export default function AssessmentTrackerSetup() {
  const [modules, setModules] = useState(null);
  const [staff, setStaff] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(true);
  // Keyed per field, so saving one module's leader never greys out the whole grid.
  const [saving, setSaving] = useState({});
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      const d = await api.assessmentTrackerSetup();
      setModules(d?.modules || []);
      setStaff(d?.staff || []);
    } catch (e) {
      setErr(e?.message || "Could not load the modules.");
    } finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Saves are NOT optimistic. The field is marked busy, the server answers, and only
  // then does local state move — so a rejected save can never leave the screen showing
  // a value the database does not hold.
  const saveLeader = async (unitId, leaderStaffId) => {
    const key = `leader:${unitId}`;
    setSaving((s) => ({ ...s, [key]: true })); setErr("");
    try {
      const unit = await api.setUnitLeader(unitId, leaderStaffId || "");
      setModules((ms) => ms.map((m) => m.unitId === unitId
        ? { ...m, leaderStaffId: unit.leaderStaffId ?? null, leaderName: unit.leaderName ?? null }
        : m));
    } catch (e) {
      setErr(e?.message || "Could not save the module leader.");
    } finally { setSaving((s) => ({ ...s, [key]: false })); }
  };

  const saveMarkingDeadline = async (unitId, assessmentId, markingDueDate) => {
    const key = `marking:${assessmentId}`;
    setSaving((s) => ({ ...s, [key]: true })); setErr("");
    try {
      const a = await api.setMarkingDeadline(assessmentId, markingDueDate || "");
      setModules((ms) => ms.map((m) => m.unitId !== unitId ? m : {
        ...m,
        assessments: m.assessments.map((x) => x.id === assessmentId
          ? { ...x, markingDueDate: a.markingDueDate ?? null }
          : x),
      }));
    } catch (e) {
      setErr(e?.message || "Could not save the marking deadline.");
    } finally { setSaving((s) => ({ ...s, [key]: false })); }
  };

  if (busy && !modules) {
    return <div className="flex justify-center p-12"><Loader2 className="animate-spin text-slate-300" size={28} /></div>;
  }

  const needle = filter.trim().toLowerCase();
  const shown = (modules || []).filter((m) => !needle
    || `${m.unitCode} ${m.unitName} ${m.cohortName || ""} ${m.courseName || ""}`.toLowerCase().includes(needle));

  return (
    <div className="space-y-5 p-4 md:p-6">
      <header>
        <h2 className="flex items-center gap-2 text-lg font-bold text-slate-800">
          <SlidersHorizontal size={18} style={{ color: NAVY }} />Assessment Tracker — Setup
        </h2>
        <p className="mt-0.5 text-[13px] text-slate-500">
          Who leads each module, and by when its work is to be marked. Assessments themselves are created on the Assessments page.
        </p>
      </header>

      <div role="alert" aria-live="assertive">{err && <Banner tone="rose" Icon={AlertTriangle}>{err}</Banner>}</div>

      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor="tracker-setup-filter">Filter modules</label>
        <input
          id="tracker-setup-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by module, class or course…"
          className="w-full max-w-sm rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-300"
        />
        <button
          onClick={load}
          className="press rounded-lg p-2.5 text-slate-500 hover:bg-slate-50"
          aria-label="Reload the module list"
          title="Reload"
        >
          <RefreshCw size={15} />
        </button>
      </div>

      {!shown.length ? (
        <p className="rounded-2xl border border-slate-200 bg-white px-5 py-10 text-center text-sm text-slate-500">
          {modules?.length ? "No modules match that filter." : "No modules yet. They are created on the Registers page, or imported from Moodle."}
        </p>
      ) : (
        <ul className="space-y-3">
          {shown.map((m) => (
            <li key={m.unitId} className="rounded-2xl border border-slate-200 bg-white">
              <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-bold text-slate-800">
                    <span style={{ color: NAVY }}>{m.unitCode}</span> · {m.unitName}
                  </h3>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-slate-500">
                    <span>{m.cohortName || <NotSet />}</span>
                    {m.courseName && <span className="text-slate-400">{m.courseName}</span>}
                    <span className="inline-flex items-center gap-1"><Users size={12} />{m.enrolled} enrolled</span>
                    {/* Read-only on purpose — the lecturer is set on Registers. */}
                    <span>Lecturer: {m.lecturerName || <NotSet />}</span>
                  </p>
                </div>

                <label className="flex items-center gap-2 text-[12px] font-semibold text-slate-600">
                  <UserCog size={14} className="text-slate-400" />
                  <span className="sr-only sm:not-sr-only">Module leader</span>
                  <select
                    value={m.leaderStaffId || ""}
                    disabled={!!saving[`leader:${m.unitId}`]}
                    onChange={(e) => saveLeader(m.unitId, e.target.value)}
                    aria-label={`Module leader for ${m.unitCode}`}
                    className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[13px] font-medium text-slate-700 outline-none focus:border-indigo-300 disabled:opacity-50"
                  >
                    <option value="">— not set —</option>
                    {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  {saving[`leader:${m.unitId}`] && <Loader2 size={14} className="animate-spin text-slate-400" />}
                </label>
              </header>

              {!m.assessments.length ? (
                <p className="px-5 py-6 text-center text-[13px] text-slate-500">
                  No assessments on this module yet — add them on the Assessments page.
                </p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {m.assessments.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                      <span className="min-w-0 truncate text-[13px] font-semibold text-slate-700">{a.title}</span>
                      <div className="flex flex-wrap items-center gap-4">
                        {/* Read-only: the hand-in deadline belongs to the assessment
                            itself and is edited on the Assessments page. Shown here so
                            the marking deadline can be set against something. */}
                        <span className="text-[12px] text-slate-500">
                          Due in: <span className="font-semibold text-slate-700">{a.dueDate || "—"}</span>
                        </span>
                        <label className="flex items-center gap-2 text-[12px] font-semibold text-slate-600">
                          <CalendarClock size={14} className="text-slate-400" />
                          <span>Marked by</span>
                          <input
                            type="date"
                            defaultValue={a.markingDueDate || ""}
                            disabled={!!saving[`marking:${a.id}`]}
                            onBlur={(e) => {
                              // onBlur, not onChange: a date input fires on every
                              // keystroke through a partially-typed year, which would
                              // send "0002-01-01" to the server three times on the way
                              // to 2026 and light the error banner for each one.
                              if ((e.target.value || "") !== (a.markingDueDate || "")) {
                                saveMarkingDeadline(m.unitId, a.id, e.target.value);
                              }
                            }}
                            aria-label={`Marking deadline for ${a.title}`}
                            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[13px] font-medium text-slate-700 outline-none focus:border-indigo-300 disabled:opacity-50"
                          />
                          {saving[`marking:${a.id}`] && <Loader2 size={14} className="animate-spin text-slate-400" />}
                        </label>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
