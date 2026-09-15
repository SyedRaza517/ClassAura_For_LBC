// API-backed store. Exposes the same data shape the UI components expect
// (staff, leave, checkins, docs, adjustments) plus async action methods.
// After each mutation we refetch the affected collection so both the
// staff app and the admin dashboard always reflect the live database.
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { api } from "./api";
import { ukBankHolidaysRange } from "./bankHolidays";

const daysBetween = (a, b) => { const d1 = new Date(a), d2 = new Date(b); if (isNaN(d1) || isNaN(d2)) { console.error("Invalid dates:", a, b); return 0; } return Math.max(1, Math.round((d2 - d1) / 86400000) + 1); };
// Today as YYYY-MM-DD in the college's own timezone (Europe/London), matching the
// server's localDate(). Using the browser's UTC date instead put the client a day
// behind between midnight and 01:00 BST, so a register the UI showed as open was
// rejected as out-of-term, and a same-day booking was refused as a past date.
const todayISO = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

export function useApiStore(notify, user) {
  const [staff, setStaff] = useState([]);
  const [leave, setLeave] = useState([]);
  const [checkins, setCheckins] = useState([]);
  const [docs, setDocs] = useState([]);
  const [adjustments, setAdjustments] = useState([]);
  const [signups, setSignups] = useState([]);
  const [studentQueries, setStudentQueries] = useState([]);
  const [timesheetsPending, setTimesheetsPending] = useState(0);
  const [loaded, setLoaded] = useState(false);
  // HND registers. Loaded lazily by the admin page rather than on login —
  // staff users never open it, so there's no reason to fetch it for them.
  const [units, setUnits] = useState([]);
  const [students, setStudents] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [semesters, setSemesters] = useState([]);
  const [courses, setCourses] = useState([]);
  const [cohorts, setCohorts] = useState([]);
  const [terms, setTerms] = useState([]);
  const [unassignedSessions, setUnassignedSessions] = useState(0);
  const [attendance, setAttendance] = useState(null);
  const [hndLoaded, setHndLoaded] = useState(false);
  // Which self check-in methods the college has on. Safe default = neither, so the
  // Registers page offers no live-view action until the server has said there is one.
  const [checkIn, setCheckIn] = useState({ tapEnabled: false, qrEnabled: false });
  // PAT (Personal Academic Tutor) interactions. Admin-only; loaded lazily by the PAT page.
  const [interactions, setInteractions] = useState([]);
  const [interactionsLoaded, setInteractionsLoaded] = useState(false);
  // Assessments (gradebook). Admin-only; loaded lazily by the Assessments page.
  const [assessments, setAssessments] = useState([]);
  const [assessmentOverview, setAssessmentOverview] = useState(null);
  const [assessmentsLoaded, setAssessmentsLoaded] = useState(false);
  // Which teaching period the registers page is scoped to.
  // "" = all semesters; "unassigned" = sessions outside every semester.
  const [semesterId, setSemesterId] = useState("");

  // A student is never an admin, whatever else the object carries. Explicit rather
  // than relying on sStudent simply not setting accountRole — this flag gates the
  // admin dashboard, the Manager Approval tile and every admin-only fetch below.
  const isAdmin = user?.accountRole === "ADMIN" && user?.kind !== "student" && !user?.isStudent;

  const refresh = useCallback(async () => {
    try {
      // The three admin-only reads join the same batch as the core five: they are
      // independent round trips and used to run one AFTER another once the batch
      // resolved, which cost an admin three extra sequential trips on every load.
      //
      // Sign-up requests are admin-only AND page-gated: a staff user, or an admin
      // without the "signups" page, would 403. Each admin read is caught on its own
      // promise so a failure stays swallowed per-call — it neither breaks the rest
      // of the load nor toasts an error on every 20s refresh, just leaves that slice
      // empty — while a core failure still rejects the whole batch and, as before,
      // sets no admin state either.
      const [st, lv, ci, dc, aj, su, sq, tp] = await Promise.all([
        api.listStaff(), api.listLeave(), api.listCheckins(), api.listDocuments(), api.listAdjustments(),
        isAdmin ? api.listSignups().catch(() => []) : null,
        // Student queries — tolerant like sign-ups (page-gated + needs the new API).
        isAdmin ? api.listStudentQueries().catch(() => []) : null,
        // Timesheets awaiting review — a count for the nav badge (tolerant).
        isAdmin ? api.timesheetPendingCount().catch(() => null) : null,
      ]);
      setStaff(st); setLeave(lv); setCheckins(ci); setDocs(dc); setAdjustments(aj);
      if (isAdmin) {
        setSignups(su);
        setStudentQueries(sq);
        setTimesheetsPending(tp?.count || 0);
      }
    } catch (e) { notify?.(e.message || "Failed to load data", "error"); }
    setLoaded(true);
  }, [notify, isAdmin]);

  useEffect(() => { if (user) refresh(); }, [user, refresh]);

  // Refetches everything the registers page shows, with attendance scoped to the
  // selected semester. Depends on semesterId, so changing the picker re-runs the
  // page's load effect and every figure rescopes together.
  const refreshHnd = useCallback(async () => {
    try {
      // Cohorts, terms and check-in settings are independent round trips that used to
      // run one after another once the main batch resolved — three extra sequential
      // trips. They join the batch, each caught on its own promise because they must
      // stay tolerant: if an endpoint lags behind on a deploy (Vercel client ahead of
      // the Render server), it must not break the rest of the registers page.
      const [ms, st, se, sem, pr, at, co, tm, cis] = await Promise.all([
        api.listUnits(), api.listStudents(), api.listSessions(), api.listSemesters(), api.listCourses(), api.getAttendance(semesterId),
        api.listCohorts().catch(() => []),
        api.listTerms().catch(() => []),
        // Boxed on success so a failure (null) is distinguishable from ANY body the
        // server could answer with — on failure we keep the safe default (no live-view
        // action offered) rather than setting anything, exactly as before.
        api.checkInSettings().then((v) => ({ v }), () => null),
      ]);
      setUnits(ms); setStudents(st); setSessions(se);
      setSemesters(sem.semesters); setUnassignedSessions(sem.unassignedSessions);
      setCourses(pr);
      setAttendance(at);
      setCohorts(co); setTerms(tm);
      if (cis) setCheckIn(cis.v);
    } catch (e) {
      // Tolerate a 403 silently, exactly as refreshAssessments does. AdminKPI calls
      // this on mount, and hndLoaded is set even on failure, so the focus/visibility
      // refetch re-fired it — giving a KPI-only admin a red "You don't have access to
      // this section" toast every single time they switched back to the tab.
      if (e?.status !== 403) notify?.(e.message || "Failed to load registers", "error");
    }
    setHndLoaded(true);
  }, [notify, semesterId]);

  // derived

  // --- Bank holidays ---
  // The standard UK (England & Wales) bank holidays, computed for a span of years so
  // the calendar can page around. The 28-day total is split into two separate pots:
  //   • 8 bank holidays  — fixed days off, NOT bookable, shown as they pass.
  //   • 20 holiday allowance — the days a staff member can actually book.
  // Bank holidays never draw down the bookable 20; they live in their own counter.
  const thisYear = Number(todayISO().slice(0, 4));
  // The set used for DISPLAY (the calendar's amber highlights, the Bank Holidays
  // card). A fixed window is fine for that.
  //
  // It is NOT what chargeableDays consults any more. A window meant the client and
  // the server disagreed outside it — the server computes the exact years a booking
  // spans — so a 2032 booking was quoted as 10 working days on screen and stored as
  // 8, and bookableAllowance for that year was 28 rather than 20. The lookup below is
  // now computed per-range, on demand, exactly like the server's.
  const bankHolidays = useMemo(() => ukBankHolidaysRange(thisYear - 5, thisYear + 5), [thisYear]);
  const bankHolidaySet = useMemo(() => new Map(bankHolidays.map((h) => [h.date, h.name])), [bankHolidays]);
  // year -> Set of ISO dates, filled on demand and memoised for the session. Mirrors
  // server/src/bankHolidays.js, which builds exactly the years a range touches.
  const holidayYears = useRef(new Map());
  const holidaysForYear = useCallback((y) => {
    const cache = holidayYears.current;
    if (!cache.has(y)) cache.set(y, new Set(ukBankHolidaysRange(y, y).map((h) => h.date)));
    return cache.get(y);
  }, []);
  const isBankHoliday = useCallback((iso) => bankHolidaySet.has(iso), [bankHolidaySet]);
  // How many bank holidays fall inside an inclusive date range.
  const bankHolidaysBetween = useCallback((start, end) => bankHolidays.reduce((n, h) => n + (h.date >= start && h.date <= end ? 1 : 0), 0), [bankHolidays]);
  // The number of bank holidays in the current year (normally 8) — the total shown
  // on the Bank Holidays card and the size of the bank-holiday pot.
  const bankHolidayTotal = useMemo(() => bankHolidays.filter((h) => h.date.slice(0, 4) === String(thisYear)).length, [bankHolidays, thisYear]);
  // "As each occurs": bank holidays in THIS calendar year whose date has arrived —
  // the "taken/passed" figure on the Bank Holidays card (e.g. 5 of 8 passed).
  const bankHolidayDaysUsed = useCallback(() => {
    const today = todayISO(); const y = String(thisYear);
    return bankHolidays.filter((h) => h.date.slice(0, 4) === y && h.date <= today).length;
  }, [bankHolidays, thisYear]);

  // Days actually charged against the bookable allowance for an inclusive [start,end]
  // range: Monday–Friday only, excluding bank holidays. Weekends (Sat/Sun) and bank
  // holidays that fall inside the range are free — they are never deducted. This is
  // the single source of truth for how many days a booking costs.
  // `year` (optional) counts only the days falling in that calendar year, because the
  // allowance is per leave year — a booking straddling New Year charges each year the
  // days it actually uses. Mirrors the server's chargeableDays exactly.
  // Mirrors server/src/bankHolidays.js exactly, including its 800-day backstop — the
  // server refuses anything longer, and walking a multi-million-day range here froze
  // the browser for every user who could see the row.
  const MAX_SPAN_DAYS = 800;
  const chargeableDays = useCallback((start, end, year) => {
    if (!start || !end || start > end) return 0;
    let cur = new Date(start + "T00:00:00Z");
    const last = new Date(end + "T00:00:00Z");
    if (isNaN(cur) || isNaN(last)) return 0;
    if ((last - cur) / 86400000 + 1 > MAX_SPAN_DAYS) return 0;
    const wantYear = year == null ? null : String(year);
    let n = 0;
    while (cur <= last) {
      const iso = cur.toISOString().slice(0, 10);
      const dow = cur.getUTCDay(); // 0 = Sun … 6 = Sat
      // Looked up per-year rather than from a fixed window, so the client and server
      // agree on every date, not just dates within five years of today.
      if (dow !== 0 && dow !== 6 && !holidaysForYear(iso.slice(0, 4)).has(iso) && (wantYear === null || iso.slice(0, 4) === wantYear)) n += 1;
      cur = new Date(cur.getTime() + 86400000);
    }
    return n;
  }, [holidaysForYear]);

  // The leave year is the CALENDAR year: entitlement and usage both reset on 1 Jan,
  // which matches how the bank-holiday pot is already counted. Without this the used
  // total accumulated for ever, so a staff member who spent this year's allowance
  // could never book again in any later year.

  // Every approved leave type counts against the allowance (sick included) — the
  // total is reduced by any approved leave, regardless of type. Unpaid leave does
  // not draw down the paid allowance, so it's excluded (kept in sync with the
  // server's UNPAID_TYPES and the client's NON_ALLOWANCE_TYPES). We recompute the
  // cost from the dates (weekends + bank holidays removed) rather than trusting a
  // stored day count, so old records are handled correctly too.
  // Days charged against a given leave year (defaults to the current one). Counting
  // per-year means a Dec->Jan booking draws from both years, and next year's pot is
  // untouched by this year's usage.
  // APPROVED only. This is the figure every screen labels "used" — the Balances
  // table and its CSV, the KPI panel, the staff member's own balance card — and days
  // that are merely requested have not been used. It also matches the server, which
  // counts approved leave alone when it enforces the allowance.
  const usedDays = useCallback((id, year = thisYear) => leave.filter((l) => l.staffId === id && l.status === "approved" && l.type !== "unpaid").reduce((s, l) => s + chargeableDays(l.start, l.end, year), 0), [leave, chargeableDays, thisYear]);
  // Approved PLUS pending — what the allowance is already spoken for, as opposed to
  // what has been spent. Used only by the booking guard below, never displayed as
  // "used", so the warning can fire without misreporting anyone's record.
  //
  // Without it the booking form was blind: two non-overlapping 20-day requests both
  // submitted against a 20-day pot, each showing "20 days left" and no warning, and
  // the conflict only surfaced on the manager's screen at approval.
  const committedDays = useCallback((id, year = thisYear) => leave.filter((l) => l.staffId === id && (l.status === "approved" || l.status === "pending") && l.type !== "unpaid").reduce((s, l) => s + chargeableDays(l.start, l.end, year), 0), [leave, chargeableDays, thisYear]);
  // Adjustments belong to the leave year they were recorded in — matching the server.
  // Summing them across all time meant a one-off "+3 carried over" quietly granted 3
  // extra days every year after, while usedDays reset each January, so the two figures
  // could never be reconciled.
  const adjDays = useCallback((id, year = thisYear) =>
    adjustments.filter((a) => a.staffId === id && String(a.date || "").slice(0, 4) === String(year)).reduce((s, a) => s + a.days, 0),
    [adjustments, thisYear]);
  // Total entitlement (e.g. 28) = the bookable allowance + the 8 bank holidays.
  const effectiveAllowance = useCallback((id, year = thisYear) => { const s = staff.find((x) => x.id === id); return (s?.allowance || 0) + adjDays(id, year); }, [staff, adjDays, thisYear]);
  // The bookable pot (e.g. 20): total entitlement minus the 8 bank holidays, which
  // are never bookable. This is the "total" on the Holiday Allowance card.
  // The bank-holiday pot is per YEAR, matching the server's bankHolidayCount(year).
  // Using the current year's count while scoping everything else to the requested one
  // meant a January booking made in December could be sized against the wrong pot.
  // Also per-year now: outside the display window this returned 0, so the bookable
  // pot for a 2032 booking came out as the full 28 instead of 28 − 8.
  const bankHolidayCountIn = useCallback((year) => holidaysForYear(String(year)).size, [holidaysForYear]);
  const bookableAllowance = useCallback((id, year = thisYear) => Math.max(0, effectiveAllowance(id, year) - bankHolidayCountIn(year)), [effectiveAllowance, bankHolidayCountIn, thisYear]);
  // Remaining in a specific leave year. Booking forms MUST pass the year they are
  // booking into - pinning this to the current year stopped staff booking January
  // leave in December, and hid next year's already-approved bookings.
  // The BOOKING guard: what is still free to request, so pending requests count
  // against it. Display figures use usedDays/remaining instead.
  const remainingIn = useCallback((id, year) => bookableAllowance(id, year) - committedDays(id, year), [bookableAllowance, committedDays]);
  // Days a staff member has left to book: bookable allowance − their approved leave.
  const remaining = useCallback((id) => bookableAllowance(id, thisYear) - usedDays(id, thisYear), [bookableAllowance, usedDays, thisYear]);
  // The first leave year a booking would overflow, or null if it fits. Checks every
  // year the range touches against that year's own pot.
  const overflowYear = useCallback((id, start, end) => {
    if (!start || !end || start > end) return null;
    const y0 = Number(String(start).slice(0, 4)), y1 = Number(String(end).slice(0, 4));
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) return null;
    for (let y = y0; y <= y1; y++) {
      const cost = chargeableDays(start, end, y);
      const left = remainingIn(id, y);
      if (cost > 0 && cost > left) return { year: String(y), cost, left };
    }
    return null;
  }, [chargeableDays, remainingIn]);

  const refreshInteractions = useCallback(async () => {
    try { setInteractions(await api.listInteractions()); }
    catch (e) { notify?.(e.message || "Failed to load interactions", "error"); }
    setInteractionsLoaded(true);
  }, [notify]);

  const refreshAssessments = useCallback(async () => {
    try {
      const [list, ov] = await Promise.all([api.listAssessments(), api.assessmentOverview()]);
      setAssessments(list); setAssessmentOverview(ov);
    } catch (e) {
      // Tolerated like sign-ups: an admin with "executive" but not "assessments" 403s
      // here, and toasting on every refresh/tab-focus spammed them endlessly.
      if (e?.status !== 403) notify?.(e.message || "Failed to load assessments", "error");
    }
    setAssessmentsLoaded(true);
  }, [notify]);

  // Keep the UI fresh without a manual reload — but tiered by cost so we don't
  // re-pull large payloads needlessly:
  //   • Light collections (staff/leave/checkins/docs/adjustments) are small and
  //     change often, so they're polled on a short interval while the tab is visible.
  //   • Heavy admin collections (registers with 1000+ students + attendance,
  //     assessments, PAT) are refetched only when the app/tab regains focus — that's
  //     when another device's changes matter — instead of every interval tick.
  // A short throttle collapses the focus + visibilitychange pair that both fire when
  // returning to the app, so a return triggers one refetch, not two.
  const lastFullRefetch = useRef(0);
  useEffect(() => {
    if (!user) return;
    const refetchAll = () => {
      const now = Date.now();
      if (now - lastFullRefetch.current < 3000) return; // collapse duplicate focus/visibility events
      lastFullRefetch.current = now;
      refresh();
      if (hndLoaded) refreshHnd();
      if (interactionsLoaded) refreshInteractions();
      if (assessmentsLoaded) refreshAssessments();
    };
    const onVisible = () => { if (document.visibilityState === "visible") refetchAll(); };
    window.addEventListener("focus", refetchAll);
    document.addEventListener("visibilitychange", onVisible);
    // Interval refreshes ONLY the light collections — the heavy registers/assessments
    // lists are left to the focus/visibility refetch above.
    const id = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 20000);
    return () => {
      window.removeEventListener("focus", refetchAll);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(id);
    };
  }, [user, refresh, refreshHnd, refreshInteractions, refreshAssessments, hndLoaded, interactionsLoaded, assessmentsLoaded]);

  // Wrap an action so errors surface as toasts and the relevant data resyncs.
  // The resync runs in the BACKGROUND (not awaited): the save itself is awaited so
  // errors are caught and the toast is accurate, but the UI updates the instant the
  // save returns rather than waiting for a full refetch — which, at scale, made every
  // save/edit feel slow. The list catches up a moment later when the refetch lands.
  const run = (fn, okMsg, okType = "success") => async (...args) => {
    try { const r = await fn(...args); if (okMsg) notify?.(typeof okMsg === "function" ? okMsg(...args) : okMsg, okType); refresh().catch(() => {}); return r; }
    // Re-sync on failure too: a rejected action (e.g. 409 already-decided, 400 over-allowance)
    // usually means our cached view is stale, so refetch to match server truth.
    catch (e) { refresh().catch(() => {}); notify?.(e.message || "Action failed", "error"); throw e; }
  };

  // Same wrapper, but resyncs the HND collections instead of the staff ones.
  const runHnd = (fn, okMsg, okType = "success") => async (...args) => {
    try { const r = await fn(...args); if (okMsg) notify?.(typeof okMsg === "function" ? okMsg(...args) : okMsg, okType); refreshHnd().catch(() => {}); return r; }
    catch (e) { refreshHnd().catch(() => {}); notify?.(e.message || "Action failed", "error"); throw e; }
  };

  // Same wrapper, resyncing the PAT interactions list.
  const runPat = (fn, okMsg, okType = "success") => async (...args) => {
    try { const r = await fn(...args); if (okMsg) notify?.(typeof okMsg === "function" ? okMsg(...args) : okMsg, okType); refreshInteractions().catch(() => {}); return r; }
    catch (e) { refreshInteractions().catch(() => {}); notify?.(e.message || "Action failed", "error"); throw e; }
  };

  // Same wrapper, resyncing the assessments list + overview.
  const runAssess = (fn, okMsg, okType = "success") => async (...args) => {
    try { const r = await fn(...args); if (okMsg) notify?.(typeof okMsg === "function" ? okMsg(...args) : okMsg, okType); refreshAssessments().catch(() => {}); return r; }
    catch (e) { refreshAssessments().catch(() => {}); notify?.(e.message || "Action failed", "error"); throw e; }
  };

  // Timesheets are month-scoped and the TimesheetScreen reloads its own list, so
  // this wrapper only raises success/error toasts — no global refetch. The success
  // message receives the mutation's result as its LAST argument (used by submit).
  const runTs = (fn, okMsg, okType = "success") => async (...args) => {
    try { const r = await fn(...args); if (okMsg) notify?.(typeof okMsg === "function" ? okMsg(...args, r) : okMsg, okType); return r; }
    catch (e) { notify?.(e.message || "Action failed", "error"); throw e; }
  };

  const actions = {
    refresh,
    // check-ins
    checkIn: run((site) => api.checkIn(site), "Checked in — have a great day!"),
    // Clocking in by touching an NFC sticker. Always Onsite — the tap proves it — so
    // unlike checkIn above it takes no site. Same run() wrapper, so the check-in list
    // resyncs and the toast appears exactly as it does for the button.
    tapCheckIn: run((tagCode) => api.tapCheckIn(tagCode), "Clocked in — have a great day!"),
    checkOut: run((id) => api.checkOut(id), "Checked out. See you tomorrow!"),
    upsertCheckin: run((data) => api.upsertCheckin(data), "Check-in record saved"),
    saveSummary: run((date, text) => api.saveSummary(date, text), "Daily summary saved"),
    // leave
    requestLeave: run((data) => api.requestLeave(data), "Leave request submitted"),
    cancelLeave: run((id) => api.cancelLeave(id), "Leave cancelled — those days are back in the allowance"),
    // Admin adds an already-approved holiday: create the request, then approve it in
    // one action so it lands straight on the calendar. The allowance is still enforced
    // server-side on the approval (paid types); unpaid never draws down.
    // Admin "add holiday" = create then immediately approve.
    addApprovedLeave: run(async (data) => {
      const rec = await api.requestLeave(data);
      if (rec?.id && rec.status === "pending") {
        try {
          await api.decideLeave(rec.id, "approved");
        } catch (e) {
          // Deliberately NO cleanup here. A duplicate POST returns the STAFF member's
          // own existing pending request, so auto-rejecting it destroyed a genuine
          // request — and irreversibly, since a decided row can't be re-decided. Leave
          // it pending for the admin to handle and surface the real reason instead.
          throw new Error((e.message || "Approval failed") + " — the request was created but not approved; review it under Approvals.");
        }
      }
      return rec;
    }, "Holiday added to the calendar"),
    decideLeave: run((id, status, note) => api.decideLeave(id, status, note), (id, status) => `Request ${status}`, "info"),
    // balances
    // `date` (optional) files the adjustment against a specific leave year; omitted = today.
    adjustBalance: run((staffId, days, note, date) => api.addAdjustment({ staffId, days, note, ...(date ? { date } : {}) }), "Adjustment applied"),
    removeAdjustment: run((id) => api.removeAdjustment(id), "Adjustment removed", "error"),
    setAllowance: run((id, allowance) => api.updateStaff(id, { allowance }), "Allowance updated"),
    // documents
    addDoc: run((data) => api.addDocument(data), (d) => `"${d.name}" published`),
    deleteDoc: run((id) => api.deleteDocument(id), "Document removed", "error"),
    // Not wrapped in run(): the caller reports its own outcome, because a failed
    // upload leaves a document that DID publish — a generic "Action failed" toast
    // would be actively misleading about what happened.
    uploadDocumentFile: async (id, file) => { const r = await api.uploadDocumentFile(id, file); refresh().catch(() => {}); return r; },
    documentDownloadUrl: (id) => api.documentDownloadUrl(id),
    // sign-up requests
    updateSignup: run((id, edits) => api.updateSignup(id, edits), "Sign-up request updated"),
    decideSignup: run(
      (id, status, note, allowance, edits) => api.decideSignup(id, status, note, allowance, edits),
      (id, status) => (status === "approved" ? "Account approved — they can now sign in" : "Sign-up declined"),
      "info",
    ),
    // student queries
    respondStudentQuery: run((id, response) => api.respondStudentQuery(id, response), "Reply sent to the student"),
    // staff
    addStaff: run((data) => api.addStaff(data), (d) => `Added ${d.name}`),
    updateStaff: run((id, data) => api.updateStaff(id, data), "Staff updated"),
    removeStaff: run((id) => api.removeStaff(id), "Staff removed", "error"),
    resetStaffTotp: run((id) => api.resetStaffTotp(id), "Two-step verification reset", "info"),
    // Super-admin only: assign which admin pages a person may access.
    updateAccess: run((id, pages) => api.updateStaffAccess(id, pages), "Access updated"),
    // HND registers
    refreshHnd,
    checkIn,
    setSemesterId,
    addSemester: runHnd((data) => api.addSemester(data), (d) => `${d.name} added`),
    updateSemester: runHnd((id, data) => api.updateSemester(id, data), "Semester updated"),
    removeSemester: runHnd((id) => api.removeSemester(id), "Semester removed", "error"),
    addCourse: runHnd((data) => api.addCourse(data), (d) => `${d.name} added`),
    updateCourse: runHnd((id, data) => api.updateCourse(id, data), "Course updated"),
    removeCourse: runHnd((id) => api.removeCourse(id), "Course removed", "error"),
    // Cohorts (intakes under a course)
    addCohort: runHnd((data) => api.addCohort(data), (d) => `Cohort ${d.name} added`),
    updateCohort: runHnd((id, data) => api.updateCohort(id, data), "Cohort updated"),
    removeCohort: runHnd((id) => api.removeCohort(id), "Cohort removed", "error"),
    // Terms (6 per cohort)
    generateTerms: runHnd((cohortId, data) => api.generateTerms(cohortId, data), "6 terms created"),
    updateTerm: runHnd((id, data) => api.updateTerm(id, data), "Term updated"),
    removeTerm: runHnd((id) => api.removeTerm(id), "Term removed", "error"),
    addUnit: runHnd((data) => api.addUnit(data), (d) => `Unit ${String(d.code).toUpperCase()} added`),
    updateUnit: runHnd((id, data) => api.updateUnit(id, data), "Unit updated"),
    removeUnit: runHnd((id) => api.removeUnit(id), "Unit removed", "error"),
    setUnitEnrolments: runHnd((id, studentIds) => api.setUnitEnrolments(id, studentIds), "Students enrolled"),
    // Not runHnd: its success message only sees the ARGUMENTS, and this one has to
    // report what the server actually did — how many registers were created, whether
    // the range was capped, and whether the unit already has registers outside the
    // window (which is what a re-run on a different weekday leaves behind).
    generateSessions: async (id, data) => {
      try {
        const r = await api.generateSessions(id, data);
        const made = r?.created ?? 0;
        const parts = [made ? `${made} register${made === 1 ? "" : "s"} created` : "No new registers — they already exist"];
        if (r?.truncatedAt) parts.push(`stopped at ${r.truncatedAt} (60-week limit)`);
        // Registers outside the window are usually a PREVIOUS term's — normal, worth
        // mentioning, not a failure. Only truncation means something was lost.
        if (r?.strayCount) parts.push(`${r.strayCount} other register${r.strayCount === 1 ? "" : "s"} on this unit sit outside these dates`);
        notify?.(parts.join(" · "), r?.truncatedAt ? "error" : "success");
        refreshHnd().catch(() => {});
        return r;
      } catch (e) {
        refreshHnd().catch(() => {});
        notify?.(e.message || "Could not create the registers", "error");
        throw e;
      }
    },
    addStudent: runHnd((data) => api.addStudent(data), (d) => `Added ${d.firstName} ${d.lastName}`),
    updateStudent: runHnd((id, data) => api.updateStudent(id, data), "Student updated"),
    removeStudent: runHnd((id) => api.removeStudent(id), "Student removed", "error"),
    setEnrolments: runHnd((id, unitIds) => api.setEnrolments(id, unitIds), "Enrolments updated"),
    addSession: runHnd((data) => api.addSession(data), "Session added"),
    updateSession: runHnd((id, data) => api.updateSession(id, data), "Session updated"),
    // `override` forces deletion of a term-locked register (caller re-invokes on a 423).
    removeSession: runHnd((id, override) => api.removeSession(id, override), "Session removed", "error"),
    saveRegister: runHnd((sessionId, marks, override) => api.saveRegister(sessionId, marks, override), "Register saved"),
    getRegister: (sessionId) => api.getRegister(sessionId),
    getStudentTermAttendance: (id) => api.studentTermAttendance(id),
    // PAT interactions
    refreshInteractions,
    addInteraction: runPat((data) => api.addInteraction(data), "Interaction logged"),
    updateInteraction: runPat((id, data) => api.updateInteraction(id, data), "Interaction updated"),
    removeInteraction: runPat((id) => api.removeInteraction(id), "Interaction deleted", "error"),
    // Staff reviews. The page owns its own list (it fetches on mount), so these
    // only need to surface success/failure — there is no shared collection to
    // refetch the way refresh()/refreshHnd() do.
    addStaffReview: async (data) => {
      try { const r = await api.addStaffReview(data); notify?.(data.status === "draft" ? "Review saved as a draft" : "Review submitted"); return r; }
      catch (e) { notify?.(e.message || "Could not save the review", "error"); throw e; }
    },
    updateStaffReview: async (id, data) => {
      try { const r = await api.updateStaffReview(id, data); notify?.("Review updated"); return r; }
      catch (e) { notify?.(e.message || "Could not update the review", "error"); throw e; }
    },
    removeStaffReview: async (id) => {
      try { const r = await api.removeStaffReview(id); notify?.("Review deleted", "error"); return r; }
      catch (e) { notify?.(e.message || "Could not delete the review", "error"); throw e; }
    },
    // assessments (gradebook)
    refreshAssessments,
    addAssessment: runAssess((data) => api.addAssessment(data), (d) => `Added "${d.title}"`),
    updateAssessment: runAssess((id, data) => api.updateAssessment(id, data), "Assessment updated"),
    removeAssessment: runAssess((id) => api.removeAssessment(id), "Assessment removed", "error"),
    saveGrades: runAssess((id, grades) => api.saveGrades(id, grades), "Grades saved"),
    saveGrade: runAssess((id, studentId, marks) => api.saveGrades(id, [{ studentId, marks }]), (id, studentId, marks) => marks == null ? "Grade removed" : "Grade saved"),
    getGrades: (id) => api.getGrades(id),
    listGrades: (params) => api.listGrades(params),
    studentAssessments: (id) => api.adminStudentAssessments(id),
    // timesheets (month-scoped; screens fetch their own month and reload after writes)
    listTimesheets: (params) => api.listTimesheets(params),
    staffOnSite: (date) => api.staffOnSite(date),
    addTimesheet: runTs((data) => api.addTimesheet(data), "Timesheet entry added"),
    updateTimesheet: runTs((id, data) => api.updateTimesheet(id, data), "Entry updated"),
    removeTimesheet: runTs((id) => api.removeTimesheet(id), "Entry removed", "info"),
    submitTimesheet: runTs((month) => api.submitTimesheet(month), (month, r) => `Timesheet sent — ${r.sent} session${r.sent === 1 ? "" : "s"}, ${r.hours}h`),
    reviewTimesheet: runTs((staffId, month, decision, note) => api.reviewTimesheet(staffId, month, decision, note), (staffId, month, decision) => decision === "approved" ? "Timesheet approved — staff notified" : "Changes requested — staff notified", "info"),
  };

  return {
    staff, leave, checkins, docs, adjustments, signups, studentQueries, timesheetsPending, loaded,
    units, students, sessions, semesters, courses, cohorts, terms, unassignedSessions, semesterId, attendance, hndLoaded,
    interactions, interactionsLoaded,
    assessments, assessmentOverview, assessmentsLoaded,
    usedDays, committedDays, adjDays, effectiveAllowance, bookableAllowance, remaining, remainingIn, overflowYear, chargeableDays,
    bankHolidays, bankHolidaySet, isBankHoliday, bankHolidaysBetween, bankHolidayDaysUsed, bankHolidayTotal,
    notify, currentUser: user, isAdmin,
    ...actions,
  };
}

export { daysBetween };
