// Scheduling — the planner half. An administrator places an event and ASSIGNS a
// room, staff and groups to it, from dropdowns backed by real foreign keys.
//
// This is a different page from "Timetable", which still serves the older weekly
// TimetableSlot screen and the student timetable. They are deliberately not merged:
// that one is scoped to a course/year/term and has free-text lecturer and room, and
// folding this into it would mean one screen where half the fields are relations and
// half are strings.
import React, { useCallback, useEffect, useState } from "react";
import {
  DoorOpen, Tag, CalendarDays, Plus, Trash2, Loader2, AlertTriangle, X, Check,
  ChevronLeft, ChevronRight, Send, Repeat, Settings as SettingsIcon, Users, Building2,
} from "lucide-react";
import { api } from "./api";
import { NAVY, alpha } from "./branding";
import TimetableCalendar from "./TimetableCalendar";
import TimetableSettingsModal from "./TimetableSettingsModal";
import { windowFor, shiftAnchor, RANGE_LABEL } from "./timetableView";

function Field({ label, children, hint }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}
const inputCls = "w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm";

/* ------------------------------------------------------------------ rooms -- */

function RoomsTab() {
  const [rooms, setRooms] = useState([]);
  const [campuses, setCampuses] = useState([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState({ name: "", floor: "", campusId: "", capacity: "", kind: "" });

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      const [rm, cp] = await Promise.all([api.ttRooms(), api.ttCampuses()]);
      setRooms(rm); setCampuses(cp);
    }
    catch (e) { setErr(e?.message || "Could not load rooms."); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setErr("");
    try {
      await api.ttCreateRoom(draft);
      setDraft({ name: "", floor: "", campusId: "", capacity: "", kind: "" });
      load();
    } catch (e) {
      // 409 is the duplicate case and it is worth saying precisely, because the
      // constraint is (name, campusId): the same room number on another campus is
      // allowed, and an administrator hitting this needs to know that.
      setErr(e?.message?.includes("already exists") ? "That room already exists on that campus. The same number on a different campus is fine." : (e?.message || "Could not add the room."));
    }
  };

  const remove = async (r) => {
    setErr("");
    try {
      const res = await api.ttDeleteRoom(r.id);
      // Deleting a room does NOT delete the classes that were in it — the events
      // survive with no room. Saying so is the difference between an administrator
      // fixing them and never knowing.
      if (res?.eventsLeftWithoutARoom > 0) setErr(`Room deleted. ${res.eventsLeftWithoutARoom} event(s) now have no room and need one.`);
      load();
    } catch (e) { setErr(e?.message || "Could not delete the room."); }
  };

  return (
    <div>
      {err && <div className="mb-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 ring-1 ring-amber-200"><AlertTriangle size={15} /> {err}</div>}
      <div className="mb-4 grid gap-2 rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200 sm:grid-cols-6">
        <Field label="Name"><input className={inputCls} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="101" /></Field>
        <Field label="Floor"><input className={inputCls} value={draft.floor} onChange={(e) => setDraft({ ...draft, floor: e.target.value })} placeholder="First floor" /></Field>
        <Field label="Campus" hint={campuses.length ? undefined : "Add one on the Campuses tab"}>
          <select className={inputCls} value={draft.campusId} onChange={(e) => setDraft({ ...draft, campusId: e.target.value })}>
            <option value="">No campus</option>
            {campuses.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Seats" hint="Blank = not recorded"><input className={inputCls} type="number" min={0} value={draft.capacity} onChange={(e) => setDraft({ ...draft, capacity: e.target.value })} /></Field>
        <Field label="Kind"><input className={inputCls} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} placeholder="Lecture" /></Field>
        <div className="flex items-end">
          <button onClick={create} disabled={!draft.name.trim()} className="flex w-full items-center justify-center gap-1 rounded-lg py-2 text-sm font-bold text-white disabled:opacity-40" style={{ background: NAVY }}><Plus size={15} /> Add</button>
        </div>
      </div>

      {busy ? <div className="flex justify-center py-10 text-slate-400"><Loader2 className="animate-spin" size={20} /></div> : (
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-200 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400">
              <th className="px-3 py-2">Room</th><th className="px-3 py-2">Campus</th><th className="px-3 py-2">Seats</th><th className="px-3 py-2">Kind</th><th className="px-3 py-2" />
            </tr></thead>
            <tbody>
              {!rooms.length && <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-400">No rooms yet. Add the first one above.</td></tr>}
              {rooms.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2 font-semibold text-slate-700">{r.label}</td>
                  <td className="px-3 py-2 text-slate-500">{r.campus || "—"}</td>
                  {/* Null prints as an em dash, never as 0 — "not recorded" and
                      "seats nobody" are different facts. */}
                  <td className="px-3 py-2 text-slate-500">{r.capacity ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-500">{r.kind || "—"}</td>
                  <td className="px-3 py-2 text-right"><button onClick={() => remove(r)} aria-label={`Delete ${r.label}`} className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 size={15} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- campuses -- */

function CampusesTab() {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [name, setName] = useState("");

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try { setRows(await api.ttCampuses()); }
    catch (e) { setErr(e?.message || "Could not load campuses."); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const remove = async (c) => {
    setErr("");
    try {
      const res = await api.ttDeleteCampus(c.id);
      // Deleting a campus that still has rooms DEACTIVATES it instead, because the
      // alternative silently detaches every room on it. Saying which happened is the
      // difference between an administrator understanding the list and distrusting it.
      if (res?.deactivated) setErr(`"${c.name}" still has ${res.rooms} room(s), so it has been retired rather than deleted. Its rooms keep their campus.`);
      load();
    } catch (e) { setErr(e?.message || "Could not delete the campus."); }
  };

  return (
    <div>
      {err && <div className="mb-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 ring-1 ring-amber-200"><AlertTriangle size={15} /> {err}</div>}
      <p className="mb-3 text-xs text-slate-500">
        Your sites. Rooms belong to one, and the register dashboard filters by them — which is why this is a list rather than something typed onto each room, where “Ealing” and “ealing” would count separately.
      </p>
      <div className="mb-4 flex flex-wrap items-end gap-2 rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
        <Field label="Campus name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Harrow" /></Field>
        <button
          onClick={async () => { setErr(""); try { await api.ttCreateCampus({ name }); setName(""); load(); } catch (e) { setErr(e?.message || "Could not add the campus."); } }}
          disabled={!name.trim()} className="flex items-center gap-1 rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-40" style={{ background: NAVY }}><Plus size={15} /> Add</button>
      </div>

      {busy ? <div className="flex justify-center py-10 text-slate-400"><Loader2 className="animate-spin" size={20} /></div> : (
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-200 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400">
              <th className="px-3 py-2">Campus</th><th className="px-3 py-2">Status</th><th className="px-3 py-2" />
            </tr></thead>
            <tbody>
              {!rows.length && <tr><td colSpan={3} className="px-3 py-8 text-center text-slate-400">No campuses yet. Add the first one above.</td></tr>}
              {rows.map((c) => (
                <tr key={c.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2 font-semibold text-slate-700">{c.name}</td>
                  <td className="px-3 py-2 text-slate-500">{c.active ? "In use" : "Retired"}</td>
                  <td className="px-3 py-2 text-right">
                    {!c.active && (
                      <button onClick={async () => { try { await api.ttUpdateCampus(c.id, { active: true }); load(); } catch (e) { setErr(e?.message || "Could not restore."); } }}
                        className="mr-1 rounded px-2 py-1 text-xs font-bold text-slate-500 hover:bg-slate-100">Restore</button>
                    )}
                    <button onClick={() => remove(c)} aria-label={`Delete ${c.name}`} className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 size={15} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- groups -- */

// A named, reusable class list — "BSc Software Engineering SEP 25" — built once and
// then picked in one click when a class is timetabled, instead of naming forty
// students every time.
//
// ONE STUDENT IS IN ONE GROUP. Student.cohortId is a single column, so adding somebody
// here takes them out of wherever they were. The screen says so before the click and
// names who moved after it: an administrator adding forty people has no other way to
// notice they have just emptied another class.
function GroupsTab({ cohorts = [], courses = [], students = [], hndLoaded, refreshHnd }) {
  // Courses, cohorts and students load lazily — the store only fetches them when a
  // page that needs them is opened, and Scheduling was not one of them. Without this
  // an administrator who lands here first sees an empty group list and concludes the
  // feature is broken rather than unloaded.
  useEffect(() => { if (!hndLoaded && refreshHnd) refreshHnd().catch(() => {}); }, [hndLoaded, refreshHnd]);

  const [groupId, setGroupId] = useState(cohorts[0]?.id || "");
  const [members, setMembers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState([]);
  const [making, setMaking] = useState(false);
  const [draft, setDraft] = useState({ course: "", name: "", startDate: "" });

  const courseName = (id) => courses.find((c) => c.id === id)?.name || "";

  // The sentinel the course <select> uses for "I am going to type one". A literal rather
  // than an empty string, because empty already means "nothing chosen yet" and the
  // Create button has to be able to tell those apart.
  /** Existing course whose name matches what was typed, ignoring case and edge spaces. */
  const matchCourse = (typed, list = courses) => {
    const want = String(typed || "").trim().toLowerCase();
    return want ? list.find((c) => (c.name || "").trim().toLowerCase() === want) : undefined;
  };

  // Says which of the two things the button is about to do, WHILE TYPING.
  //
  // A free text box that silently either reuses or creates is the one thing worth
  // guarding against here: "BSc Software Engineering" and "BSc Software Engineerng" look
  // identical at a glance and produce two programmes, and the mistake is only visible
  // weeks later when half the students are on the wrong one. Naming the matched course
  // back makes a typo obvious before the click rather than after it.
  const typedCourse = matchCourse(draft.course);
  const courseHint = !draft.course.trim()
    ? "Type it — existing ones will suggest themselves"
    : typedCourse
      ? `Existing course — the group joins "${typedCourse.name}"`
      : "New course — created with the group";

  /**
   * The course this group will belong to, creating it if the name is a new one.
   *
   * A FREE TEXT BOX RATHER THAN A DROPDOWN, because most of the time the course is
   * already known to the person typing and making them hunt for it in a list of forty
   * is slower than typing it. The existing courses are offered as browser suggestions
   * (a <datalist>), so picking one is still a keystroke away.
   *
   * MATCHED CASE-INSENSITIVELY AGAINST WHAT ALREADY EXISTS FIRST, and that is the part
   * that matters. Course.name is unique, but Postgres compares it case-sensitively, so
   * "BSc Software Engineering" and "BSc software engineering" are two courses to the
   * database and one course to everybody else. A free text box makes that easy to do by
   * accident — which is exactly why the box has to resolve to the existing row rather
   * than create beside it. Otherwise a college accumulates three spellings of one
   * programme, each holding its own groups and its own share of the students. Same
   * failure the campus list exists to prevent, reached from the other direction.
   */
  const resolveCourseId = async () => {
    const wanted = draft.course.trim();
    const existing = matchCourse(wanted);
    if (existing) return existing.id;
    try {
      return (await api.addCourse({ name: wanted })).id;
    } catch (e) {
      // Someone else created it between the list loading and this click. Refetch and
      // use theirs rather than failing the group the administrator was actually making.
      if (!/already exists/i.test(e?.message || "")) throw e;
      const fresh = await api.listCourses().catch(() => []);
      const found = matchCourse(wanted, fresh);
      if (!found) throw e;
      return found.id;
    }
  };

  // Creating the group here rather than only on the Registers page: the whole point of
  // this tab is "build the class list once", and sending somebody to another screen to
  // make the empty group first breaks that in half.
  //
  // The COURSE IS REQUIRED because Cohort.courseId is NOT NULL — a group belongs to a
  // programme, and it is what makes "SEP 25" unambiguous when three courses each have
  // one. The name is unique per course for the same reason, so the 409 is worth saying
  // in full rather than as "could not create".
  const createGroup = async () => {
    setErr(""); setNote("");
    try {
      const courseId = await resolveCourseId();
      const made = await api.addCohort({
        courseId,
        name: draft.name.trim(),
        ...(draft.startDate ? { startDate: draft.startDate } : {}),
      });
      // The store owns both lists, so they have to be refetched before the new group can
      // be selected — selecting an id the <select> has no <option> for silently shows
      // nothing, and a course created a moment ago would not be in the picker either.
      if (refreshHnd) await refreshHnd().catch(() => {});
      setDraft({ course: "", name: "", startDate: "" });
      setMaking(false);
      setGroupId(made?.id || "");
      setNote(`"${made?.name || draft.name}" created. Add students to it below.`);
    } catch (e) {
      const m = e?.message || "";
      setErr(
        m.includes("already exists") ? `A group called "${draft.name.trim()}" already exists on that course. Names are unique per course.`
        : e?.status === 403 || m.includes("403") ? "You need the Registers page to create a group or a course. You can still add students to an existing group."
        : m || "Could not create the group.",
      );
    }
  };

  const load = useCallback(async (id) => {
    if (!id) { setMembers([]); return; }
    setBusy(true); setErr("");
    try { setMembers(await api.ttGroupStudents(id)); }
    catch (e) { setErr(e?.message || "Could not load the group."); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { load(groupId); }, [groupId, load]);

  const memberIds = new Set(members.map((m) => m.id));
  const term = q.trim().toLowerCase();
  const candidates = students
    .filter((s) => !memberIds.has(s.id))
    .filter((s) => !term || `${s.firstName || ""} ${s.lastName || ""} ${s.studentRef || ""}`.toLowerCase().includes(term))
    .slice(0, 50);

  const add = async () => {
    setErr(""); setNote("");
    try {
      const res = await api.ttAddToGroup(groupId, picked);
      setPicked([]); setQ("");
      // Naming who moved, not just how many were added. The move is the surprising
      // half and it is invisible on this screen otherwise.
      setNote(`${res.changed} student(s) added.` + (res.moved?.length ? ` ${res.moved.length} moved out of another group: ${res.moved.map((m) => m.name || m.studentRef).join(", ")}.` : ""));
      load(groupId);
    } catch (e) {
      setErr(e?.message?.includes("403") || e?.status === 403
        ? "You need the Students page to move students between groups — it changes which department can see them."
        : (e?.message || "Could not add those students."));
    }
  };

  const removeOne = async (s) => {
    setErr(""); setNote("");
    try { await api.ttRemoveFromGroup(groupId, [s.id]); load(groupId); }
    catch (e) { setErr(e?.message || "Could not remove that student."); }
  };

  return (
    <div>
      {err && <div className="mb-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 ring-1 ring-amber-200"><AlertTriangle size={15} /> {err}</div>}
      {note && <div className="mb-3 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200"><Check size={15} /> {note}</div>}

      <p className="mb-3 text-xs text-slate-500">
        Build a class list once and reuse it. When you timetable a class, pick the group instead of naming every student. A student belongs to <strong>one</strong> group — adding them here removes them from wherever they were.
      </p>

      <div className="mb-4 rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Field label="Group">
              <select className={inputCls} value={groupId} onChange={(e) => { setGroupId(e.target.value); setPicked([]); setNote(""); }}>
                <option value="">{cohorts.length ? "Choose a group…" : "No groups yet — create one"}</option>
                {cohorts.map((c) => (
                  <option key={c.id} value={c.id}>{courseName(c.courseId) ? `${courseName(c.courseId)} · ${c.name}` : c.name}</option>
                ))}
              </select>
            </Field>
          </div>
          <button onClick={() => { setMaking((v) => !v); setErr(""); setNote(""); }}
            className="flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">
            {making ? <><X size={15} /> Cancel</> : <><Plus size={15} /> New group</>}
          </button>
        </div>

        {making && (
          <div className="mt-3 grid gap-2 border-t border-slate-200 pt-3 sm:grid-cols-4">
            <Field label="Course" hint={courseHint}>
              {/* A plain text box, with the college's existing courses offered as
                  browser suggestions. Typing an existing name reuses that course;
                  anything new is created with the group. */}
              <input className={inputCls} list="tt-course-options" value={draft.course}
                onChange={(e) => setDraft({ ...draft, course: e.target.value })}
                placeholder="BSc Software Engineering" />
              <datalist id="tt-course-options">
                {courses.map((c) => <option key={c.id} value={c.name} />)}
              </datalist>
            </Field>
            <Field label="Group name" hint="The intake, e.g. SEP 25">
              <input className={inputCls} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="SEP 25" />
            </Field>
            <Field label="Starts" hint="Optional">
              <input type="date" className={inputCls} value={draft.startDate} onChange={(e) => setDraft({ ...draft, startDate: e.target.value })} />
            </Field>
            <div className="flex items-end">
              {/* Both required: the course because Cohort.courseId is NOT NULL, the name
                  because it is what anybody picking this group will read. */}
              {/* When "add a new course" is chosen the typed name is what stands in for
                  the course, so the button must wait for it — otherwise Create fires with
                  the sentinel as a courseId and the server rejects it as unknown. */}
              <button onClick={createGroup}
                disabled={!draft.name.trim() || !draft.course.trim()}
                className="flex w-full items-center justify-center gap-1 rounded-lg py-2 text-sm font-bold text-white disabled:opacity-40" style={{ background: NAVY }}>
                <Check size={15} /> Create group
              </button>
            </div>

          </div>
        )}
      </div>

      {!groupId ? (
        <p className="py-8 text-center text-sm text-slate-400">
          {cohorts.length ? "Choose a group to see and edit who is in it." : "Create your first group above, then pick students for it."}
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
            <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">In this group ({members.length})</h4>
            {busy ? <div className="flex justify-center py-8 text-slate-400"><Loader2 className="animate-spin" size={18} /></div> : (
              <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
                {!members.length && <li className="py-8 text-center text-sm text-slate-400">Nobody yet. Add students from the right.</li>}
                {members.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 py-1.5">
                    <span className="flex-1 truncate text-sm text-slate-700">{`${s.firstName || ""} ${s.lastName || ""}`.trim()}</span>
                    <span className="text-xs text-slate-400">{s.studentRef}</span>
                    <button onClick={() => removeOne(s)} aria-label={`Remove ${s.firstName} ${s.lastName}`} className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><X size={14} /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
            <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">Add students</h4>
            <input className={`${inputCls} mb-2`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or student number…" />
            <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
              {!candidates.length && <li className="py-8 text-center text-sm text-slate-400">{term ? "Nobody matches that." : "Everyone is already in this group."}</li>}
              {candidates.map((s) => {
                const on = picked.includes(s.id);
                return (
                  <li key={s.id}>
                    <label className="flex cursor-pointer items-center gap-2 py-1.5">
                      <input type="checkbox" checked={on} onChange={() => setPicked(on ? picked.filter((x) => x !== s.id) : [...picked, s.id])} />
                      <span className="flex-1 truncate text-sm text-slate-700">{`${s.firstName || ""} ${s.lastName || ""}`.trim()}</span>
                      <span className="text-xs text-slate-400">{s.studentRef}</span>
                      {/* Flagged BEFORE the click, not reported after it. */}
                      {s.cohortId && s.cohortId !== groupId && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">in another group</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
            <button onClick={add} disabled={!picked.length}
              className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg py-2 text-sm font-bold text-white disabled:opacity-40" style={{ background: NAVY }}>
              <Plus size={15} /> Add {picked.length || ""} to this group
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- categories -- */

function CategoriesTab() {
  const [cats, setCats] = useState([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState({ name: "", colour: "#1a3a8f" });

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try { setCats(await api.ttCategories()); }
    catch (e) { setErr(e?.message || "Could not load categories."); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      {err && <div className="mb-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 ring-1 ring-amber-200"><AlertTriangle size={15} /> {err}</div>}
      <p className="mb-3 text-xs text-slate-500">Categories are what an event <em>is</em> — Lecture, Seminar, Exam. The colour is used when a reader colours their timetable by category.</p>
      <div className="mb-4 flex flex-wrap items-end gap-2 rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
        <Field label="Name"><input className={inputCls} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Lecture" /></Field>
        <Field label="Colour"><input type="color" className="h-9 w-16 rounded border border-slate-300" value={draft.colour} onChange={(e) => setDraft({ ...draft, colour: e.target.value })} /></Field>
        <button
          onClick={async () => { setErr(""); try { await api.ttCreateCategory(draft); setDraft({ name: "", colour: "#1a3a8f" }); load(); } catch (e) { setErr(e?.message || "Could not add."); } }}
          disabled={!draft.name.trim()} className="flex items-center gap-1 rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-40" style={{ background: NAVY }}><Plus size={15} /> Add</button>
      </div>

      {busy ? <div className="flex justify-center py-10 text-slate-400"><Loader2 className="animate-spin" size={20} /></div> : (
        <div className="flex flex-wrap gap-2">
          {!cats.length && <p className="py-8 text-center text-sm text-slate-400">No categories yet.</p>}
          {cats.map((c) => (
            <span key={c.id} className="flex items-center gap-2 rounded-full py-1.5 pl-3 pr-1.5 text-sm font-bold" style={{ background: alpha(c.colour, 14), color: c.colour }}>
              {c.name}
              <button onClick={async () => { try { const r = await api.ttDeleteCategory(c.id); if (r?.eventsLeftWithoutACategory > 0) setErr(`Deleted. ${r.eventsLeftWithoutACategory} event(s) now have no category.`); load(); } catch (e) { setErr(e?.message || "Could not delete."); } }}
                aria-label={`Delete ${c.name}`} className="rounded-full p-1 hover:bg-white/60"><X size={13} /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- root -- */

export default function AdminTimetablePlanner({ store }) {
  const [tab, setTab] = useState("calendar");
  const TABS = [["calendar", "Calendar", CalendarDays], ["groups", "Groups", Users], ["rooms", "Rooms", DoorOpen], ["campuses", "Campuses", Building2], ["categories", "Categories", Tag]];
  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-slate-200">
        {TABS.map(([k, l, I]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-bold ${tab === k ? "border-b-2 text-slate-800" : "text-slate-400 hover:text-slate-600"}`}
            style={tab === k ? { borderColor: NAVY } : undefined}>
            <I size={15} /> {l}
          </button>
        ))}
      </div>
      {/* The lists come from the store StaffHub already loads, not from new endpoints
          — store.staff, store.units, store.cohorts and store.courses are all already
          fetched for other pages, and adding an endpoint for them would be a second
          source of truth for the same rows. */}
      {tab === "calendar" && <PlannerCalendarTab staff={store?.staff || []} units={store?.units || []} cohorts={store?.cohorts || []} courses={store?.courses || []} />}
      {tab === "groups" && <GroupsTab cohorts={store?.cohorts || []} courses={store?.courses || []} students={store?.students || []} hndLoaded={store?.hndLoaded} refreshHnd={store?.refreshHnd} />}
      {tab === "rooms" && <RoomsTab />}
      {tab === "campuses" && <CampusesTab />}
      {tab === "categories" && <CategoriesTab />}
    </div>
  );
}

function PlannerCalendarTab({ staff = [], units = [], cohorts = [], courses = [] }) {
  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  const [anchor, setAnchor] = useState(today);
  const [view, setView] = useState("week");
  const [events, setEvents] = useState([]);
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(true);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [warnings, setWarnings] = useState([]);
  const [editing, setEditing] = useState(null);
  const [prefs, setPrefs] = useState(false);
  const [rooms, setRooms] = useState([]);
  const [cats, setCats] = useState([]);

  const { from, to } = windowFor(view, anchor);

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      // Drafts INCLUDED, deliberately: an administrator building next term must see
      // what they are building. That is the whole difference between this screen and
      // the staff one, which is published-only.
      const [ev, st, rm, ct] = await Promise.all([
        api.ttEvents({ from, to }), api.ttSettings(), api.ttRooms(), api.ttCategories(),
      ]);
      setEvents(ev || []);
      // Drawn with the COLLEGE's settings over the platform defaults, never with this
      // administrator's personal ones. They are laying out a timetable other people
      // read, and their own hidden weekend would hide events they had scheduled on it.
      setSettings({ ...st.defaults, ...st.institution });
      setRooms(rm || []); setCats(ct || []);
    } catch (e) { setErr(e?.message || "Could not load the timetable."); }
    finally { setBusy(false); }
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  const blank = () => ({
    date: anchor, start: "09:00", end: "10:00", title: "", notes: "",
    roomId: "", categoryId: "", unitId: "", staffIds: [], cohortIds: [], published: false,
  });

  // A cohort's own name is an intake label like "SEP 2025", which repeats across every
  // course in the college. Prefixing the course is how the rest of StaffHub already
  // renders these, and without it the Groups list is a wall of identical entries.
  const cohortLabel = (c) => {
    const course = courses.find((x) => x.id === c.courseId);
    return course ? `${course.name} — ${c.name}` : c.name;
  };

  const save = async () => {
    setErr(""); setNote(""); setWarnings([]);
    try {
      const body = { ...editing, staffIds: editing.staffIds || [], cohortIds: editing.cohortIds || [] };
      const r = editing.id ? await api.ttUpdateEvent(editing.id, body) : await api.ttCreateEvent(body);
      // A CLASH IS A WARNING, NOT A FAILURE. The server saved it. Closing the editor
      // and showing the warnings above the grid is the honest reading — refusing to
      // close would imply the save had not happened, and an administrator would try
      // again and create a second copy.
      setWarnings(r.warnings || []);
      setEditing(null);
      load();
    } catch (e) { setErr(e?.message || "Could not save the event."); }
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button onClick={() => setAnchor(today)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50">Today</button>
        <button onClick={() => setAnchor((a) => shiftAnchor(view, a, -1))} aria-label="Previous" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><ChevronLeft size={16} /></button>
        <p className="min-w-[150px] text-center text-sm font-extrabold text-slate-700">{RANGE_LABEL(view, from, to)}</p>
        <button onClick={() => setAnchor((a) => shiftAnchor(view, a, 1))} aria-label="Next" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><ChevronRight size={16} /></button>
        <input type="date" value={anchor} onChange={(e) => e.target.value && setAnchor(e.target.value)} aria-label="Jump to date"
          className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-bold text-slate-600" />
        <select value={view} onChange={(e) => setView(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-bold text-slate-600">
          {["day", "week", "month", "timeline"].map((v) => <option key={v} value={v}>{v[0].toUpperCase() + v.slice(1)}</option>)}
        </select>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={() => setEditing(blank())} className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold text-white" style={{ background: NAVY }}><Plus size={14} /> New event</button>
          <button
            onClick={async () => {
              if (!window.confirm(`Publish every event from ${from} to ${to}? Staff will see them immediately.`)) return;
              setErr(""); setNote("");
              try { const r = await api.ttPublish({ from, to, published: true }); setNote(`${r.updated} event(s) published.`); load(); }
              catch (e) { setErr(e?.message || "Could not publish."); }
            }}
            className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"><Send size={14} /> Publish this period</button>
          <button onClick={() => setPrefs(true)} aria-label="Display settings" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><SettingsIcon size={16} /></button>
        </div>
      </div>

      {/* An outcome and a failure are different things and are told apart on purpose:
          "12 events published" in slate, "could not publish" in rose. One colour for
          both trains people to ignore the colour. */}
      {note && <div className="mb-3 rounded-lg bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700">{note}</div>}
      {err && <div className="mb-3 flex items-center gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700 ring-1 ring-rose-200"><AlertTriangle size={15} /> {err}</div>}

      {/* Clash warnings sit ABOVE the grid and stay until the next save. They are the
          only thing on this screen reporting a decision the administrator may want to
          undo, and burying them in a toast that vanishes is the same as not showing
          them at all. */}
      {!!warnings.length && (
        <div className="mb-3 rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200">
          <div className="mb-1 flex items-center gap-1.5 text-sm font-extrabold text-amber-800">
            <AlertTriangle size={15} /> Saved, but this clashes
            <button onClick={() => setWarnings([])} className="ml-auto rounded px-2 py-0.5 text-[11px] font-bold hover:bg-amber-100">Dismiss</button>
          </div>
          <ul className="space-y-0.5 text-xs text-amber-800">
            {warnings.map((w, i) => (
              <li key={i}>
                {w.date ? <b>{w.date}: </b> : null}
                {(w.clashes || [w]).map((c, j) => (
                  <span key={j}>
                    {c.kind === "room" ? "Room" : c.kind === "staff" ? "Staff" : "Group"} <b>{c.resource}</b> is already on “{c.event?.title}” {c.event?.start}–{c.event?.end}
                    {j < (w.clashes || [w]).length - 1 ? "; " : ""}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}

      {busy && !settings ? (
        <div className="flex justify-center py-16 text-slate-400"><Loader2 className="animate-spin" size={20} /></div>
      ) : (
        <TimetableCalendar events={events} settings={settings} view={view} anchor={anchor} today={today}
          onSelectEvent={(e) => setEditing({ ...e, staffIds: (e.staff || []).map((s) => s.id), cohortIds: (e.groups || []).map((g) => g.id) })}
          selectedId={editing?.id} />
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-3">
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between px-4 py-3 text-white" style={{ background: NAVY }}>
              <p className="text-base font-extrabold">{editing.id ? "Edit event" : "New event"}</p>
              <button onClick={() => setEditing(null)} aria-label="Close" className="rounded-full p-1.5 hover:bg-white/20"><X size={18} /></button>
            </div>
            <div className="grid flex-1 gap-3 overflow-y-auto p-4 sm:grid-cols-2">
              <Field label="Title"><input className={inputCls} value={editing.title || ""} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></Field>
              <Field label="Date"><input type="date" className={inputCls} value={editing.date || ""} onChange={(e) => setEditing({ ...editing, date: e.target.value })} /></Field>
              <Field label="Start"><input type="time" className={inputCls} value={editing.start || ""} onChange={(e) => setEditing({ ...editing, start: e.target.value })} /></Field>
              <Field label="End"><input type="time" className={inputCls} value={editing.end || ""} onChange={(e) => setEditing({ ...editing, end: e.target.value })} /></Field>
              <Field label="Room">
                <select className={inputCls} value={editing.roomId || ""} onChange={(e) => setEditing({ ...editing, roomId: e.target.value })}>
                  <option value="">No room</option>
                  {rooms.filter((r) => r.active).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              </Field>
              <Field label="Category">
                <select className={inputCls} value={editing.categoryId || ""} onChange={(e) => setEditing({ ...editing, categoryId: e.target.value })}>
                  <option value="">No category</option>
                  {cats.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              {/* Nullable on purpose. An exam, a workshop or a staff meeting belongs to
                  no module — which is exactly what HndSession.unitId being NOT NULL
                  cannot express, and the reason this feature has its own table. */}
              <Field label="Module" hint="Optional — exams and meetings have none">
                <select className={inputCls} value={editing.unitId || ""} onChange={(e) => setEditing({ ...editing, unitId: e.target.value })}>
                  <option value="">No module</option>
                  {units.map((u) => <option key={u.id} value={u.id}>{u.code ? `${u.code} — ` : ""}{u.name}</option>)}
                </select>
              </Field>
              <Field label="Teaching staff" hint="Ctrl/Cmd-click for more than one">
                <select multiple size={4} className={inputCls} value={editing.staffIds || []}
                  onChange={(e) => setEditing({ ...editing, staffIds: [...e.target.selectedOptions].map((o) => o.value) })}>
                  {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
              <Field label="Groups" hint="Ctrl/Cmd-click for more than one">
                <select multiple size={4} className={inputCls} value={editing.cohortIds || []}
                  onChange={(e) => setEditing({ ...editing, cohortIds: [...e.target.selectedOptions].map((o) => o.value) })}>
                  {cohorts.map((c) => <option key={c.id} value={c.id}>{cohortLabel(c)}</option>)}
                </select>
              </Field>
              <div className="sm:col-span-2">
                <Field label="Notes"><textarea rows={2} className={inputCls} value={editing.notes || ""} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></Field>
              </div>
              <label className="flex items-center gap-2 text-sm font-semibold text-slate-600 sm:col-span-2">
                <input type="checkbox" checked={!!editing.published} onChange={(e) => setEditing({ ...editing, published: e.target.checked })} className="h-4 w-4 rounded border-slate-300" />
                Published — visible to staff
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 p-3">
              {editing.id && (
                <>
                  <button
                    onClick={async () => {
                      const until = window.prompt("Repeat weekly until (YYYY-MM-DD)?");
                      if (!until) return;
                      setErr(""); setNote("");
                      try {
                        const r = await api.ttRepeatEvent(editing.id, { until });
                        // Per-date, because "week 4 clashes" is actionable and "there
                        // were clashes" is not.
                        setWarnings(r.warnings || []);
                        setNote(`${r.created} weekly copies created.`);
                        setEditing(null); load();
                      } catch (e) { setErr(e?.message || "Could not repeat the event."); }
                    }}
                    className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50"><Repeat size={14} /> Repeat weekly</button>
                  <button
                    onClick={async () => {
                      if (!window.confirm("Delete this event?")) return;
                      try { await api.ttDeleteEvent(editing.id); setEditing(null); load(); }
                      catch (e) { setErr(e?.message || "Could not delete."); }
                    }}
                    className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-bold text-rose-600 hover:bg-rose-50"><Trash2 size={14} /> Delete</button>
                </>
              )}
              <button onClick={() => setEditing(null)} className="ml-auto rounded-lg px-4 py-2 text-sm font-bold text-slate-500 hover:bg-slate-100">Cancel</button>
              <button onClick={save} disabled={!editing.title?.trim() || !editing.date}
                className="flex items-center gap-1 rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-40" style={{ background: NAVY }}><Check size={15} /> Save</button>
            </div>
          </div>
        </div>
      )}

      {settings && (
        <TimetableSettingsModal open={prefs} settings={settings} scope="college" onClose={() => setPrefs(false)}
          onSave={async (patch) => { const r = await api.ttSaveSettings(patch); setSettings((s) => ({ ...s, ...r.institution })); setPrefs(false); }} />
      )}
    </div>
  );
}
