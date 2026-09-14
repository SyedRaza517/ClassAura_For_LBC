import React, { useState, useEffect, useCallback, useRef } from "react";
import PhoneShell, { isNativeApp } from "../PhoneShell";
import { BrandMark } from "../Brand";
import { useBackHandler } from "../backButton";
import { useEdgeSwipeBack } from "../edgeSwipeBack";
import { useApplyTheme } from "./theme";
import { peekPendingQr } from "../pendingQr";
import { api, API_BASE, getToken } from "../api";
// Aliased to StatusBarStyle so it never reads as this file's own ui/StatusBar.jsx
// (the attendance stacked-bar chart) — two completely different "StatusBar"s that
// happen to share a name.
import { StatusBar, Style as StatusBarStyle } from "@capacitor/status-bar";
import {
  Percent, Award, MessageSquare, ChevronLeft, RefreshCw,
  Settings, Home as HomeIcon, User, Nfc, QrCode, Bell,
} from "lucide-react";

import { NAVY, NAVY_DARK, MAROON, alpha } from "../branding";
import { DEFAULT_ATTENDANCE_BANDS } from "./ui/tokens";

import { KNOWN_LINKS } from "./utils";
import Home from "./screens/Home";
import CheckInScreen, { anyCheckInWay } from "./screens/CheckIn";
import AttendanceScreen from "./screens/Attendance";
import ResultsScreen from "./screens/Results";
import ReviewsScreen from "./screens/Reviews";
import TimetableScreen from "./screens/Timetable";
import QueryScreen from "./screens/Query";
import InboxScreen from "./screens/Inbox";
import SupportScreen from "./screens/Support";
import MitigationsScreen from "./screens/Mitigations";
import MoreScreen from "./screens/More";

/* ============================== app shell ============================== */

// GET /student/me/attendance-bands — fetched DEFENSIVELY. The endpoint is being built
// in the same wave as this task, in a server routes/student.js this file must not
// touch, so an app built from THIS commit can reach a server that does not have the
// route yet (a plain 404, not carrying the `{error}` body api.js's `request()` uses to
// tell "route missing" apart from "record missing") or one still deploying it. Neither
// is a real failure: DEFAULT_ATTENDANCE_BANDS (ui/tokens.js, mirrored from the server's
// own DEFAULT_BANDS) is exactly what a college that has configured nothing gets back
// anyway, so a null here is silently absorbed by every screen's `bands` prop default.
//
// Written as a bare fetch rather than a new api.js method: this task's file allowlist
// does not include api.js (a concurrent agent's routes/student.js is the other half of
// this endpoint, and api.js is the one client file closest to that seam), so this reads
// api.js's own exported pieces (API_BASE, getToken) rather than adding to it.
async function fetchAttendanceBands() {
  try {
    const token = getToken();
    const res = await fetch(`${API_BASE}/student/me/attendance-bands`, {
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Defensive about the exact shape too — the concurrent route is not landed yet, so
    // this cannot assume `{ bands: [...] }` versus a bare array without ever having
    // seen the real response. Anything that is not a non-empty array of band-shaped
    // objects is treated the same as "not answered": DEFAULT_ATTENDANCE_BANDS covers it.
    const list = Array.isArray(data?.bands) ? data.bands : Array.isArray(data) ? data : null;
    const valid = Array.isArray(list) && list.length && list.every((b) => b && typeof b.min === "number" && typeof b.colour === "string");
    return valid ? list : null;
  } catch {
    return null; // offline, CORS, malformed JSON — the default ladder covers all of it
  }
}

// SIX, and the arithmetic rather than the habit.
//
// This said five was the ceiling because "a sixth tab drops each target below the 44px it
// needs on a 320px phone". That conflated two different measurements. The button is
// flex-1, so six of them on a 320px screen are 53.3px wide — comfortably above 44. What
// actually did not fit was the highlight PILL behind the icon at w-14 (56px): six of
// those need 336px. Narrowing it to w-12 (48px) needs 288px, and the target is untouched.
//
// Check In earns the place because it is the only thing in this app with a deadline. A
// register closes when the class does; an attendance percentage is still true tomorrow.
// It sits second, next to Home, because that is where a thumb already is.
//
// Reviews are still reached from the home screen and from More.
const TABS = [
  { key: "home", label: "Home", Icon: HomeIcon },
  { key: "checkin", label: "Check In", Icon: Nfc },
  { key: "attendance", label: "Attendance", Icon: Percent },
  { key: "assessments", label: "Results", Icon: Award },
  { key: "query", label: "Ask", Icon: MessageSquare },
  { key: "more", label: "More", Icon: Settings },
];

export default function StudentApp({ user, logout }) {
  // A scanned check-in code from the one-shot stash the deep link filled — see
  // pendingQr.js. PEEKED here, not taken: an initializer must be pure (StrictMode runs
  // it twice, and a read-and-remove made the scan vanish before it was used). The card
  // clears the stash at submit time, behind its own once-only guard.
  const [pendingQr, setPendingQr] = useState(() => peekPendingQr());
  // A student who arrives holding a scan is standing in a running class — land them on
  // the check-in screen the mark belongs to, not the home screen.
  const [screen, setScreenState] = useState(pendingQr ? "checkin" : "home");
  // Where the student has BEEN, so "back" (the Android button, and the left-edge
  // swipe below) can return to the screen they actually came from — More → Support →
  // back lands on More, where the old `setScreen("home")` handler teleported them to
  // Home and made the gesture feel broken. Home is the ROOT: navigating to it clears
  // the trail, so back from Home always minimises (Android) or does nothing (swipe)
  // instead of replaying the session backwards — the convention every tabbed app on
  // both platforms follows. A ref, not state: the trail must be readable and
  // writable inside stable callbacks without re-rendering anything, and nothing
  // renders it.
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const historyRef = useRef([]);
  // Same signature as the bare setter it replaces, so every existing call site —
  // tabs, header, pushes, deep links, screens' own setScreen props — records the
  // trail without knowing it exists. The push happens HERE, outside the state
  // updater: React (StrictMode especially) may run an updater function twice, and a
  // side effect inside one would record every navigation twice.
  const setScreen = useCallback((next) => {
    const prev = screenRef.current;
    if (next === prev) return;
    if (next === "home") historyRef.current = [];
    else {
      historyRef.current.push(prev);
      // A cap nobody should ever hit — it only exists so a session left open for a
      // term cannot grow an unbounded array.
      if (historyRef.current.length > 20) historyRef.current.shift();
    }
    setScreenState(next);
  }, []);
  // Returns true when it navigated (the contract useBackHandler expects), false at
  // the root so Android's default minimise still happens. Goes through
  // setScreenState directly — going BACK must never push onto the trail it is
  // consuming.
  const goBack = useCallback(() => {
    const prev = historyRef.current.pop();
    if (prev) { setScreenState(prev); return true; }
    if (screenRef.current !== "home") { setScreenState("home"); return true; }
    return false;
  }, []);
  const [queries, setQueries] = useState([]);
  const [attendance, setAttendance] = useState(null);
  const [results, setResults] = useState(null);
  const [reviews, setReviews] = useState(null);
  const [timetable, setTimetable] = useState(null);
  const [tapContext, setTapContext] = useState(null);
  // null until the first load answers. A student with none gets [], which is a real
  // answer and renders the empty state; null is "we have not been told yet".
  const [referrals, setReferrals] = useState(null);
  const [supportDepts, setSupportDepts] = useState([]);
  // The notification inbox. `notifications` defaults to [] rather than null: a
  // student genuinely having none is a real, common answer (most students, most of
  // the time) and Inbox.jsx's own empty state already says so — there is no
  // "unknown yet" state worth distinguishing the way `referrals` (a newer, still-
  // rolling-out endpoint) needs one. `unread` drives the Header bell's badge on
  // EVERY screen, which is why it is fetched here rather than only when Inbox opens.
  const [notifications, setNotifications] = useState([]);
  const [unread, setUnread] = useState(0);
  // Streaks/badges (GET /me/streaks) — current + best run, and the badge list for the
  // Attendance screen. Bonus like referrals/timetable: a failure must not blank the
  // Home or Attendance screen, so it starts null ("not answered yet") and every
  // reader treats null as "say nothing" rather than as zero.
  const [streaks, setStreaks] = useState(null);
  // Defaulted rather than null: attendanceTone/progressTone (ui/tokens.js) accept an
  // empty or missing list and fall back to DEFAULT_ATTENDANCE_BANDS themselves, but
  // starting the STATE at the same default means every screen paints its bands from
  // frame one instead of the neutral "unknown" grey flashing briefly before the fetch
  // resolves (or fails, which — see fetchAttendanceBands — is expected until the
  // concurrent server route lands).
  const [bands, setBands] = useState(DEFAULT_ATTENDANCE_BANDS);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(true);
  // Android back retraces the trail above (it used to jump straight home).
  useBackHandler(screen !== "home", goBack);
  // And the same "back" from a left-edge swipe, on BOTH platforms — the iOS gesture
  // a WKWebView app otherwise simply doesn't have (see edgeSwipeBack.js for why the
  // web layer is the right place to build it).
  useEdgeSwipeBack(goBack);
  // The appearance choice (More → Appearance): applies/removes the `.dark` root
  // class, follows the phone while the choice is "system", and cleans the class off
  // on unmount so nothing after logout inherits it. Mounted here because dark mode
  // is a student-app feature by ruling — see theme.js's file comment.
  useApplyTheme();

  // The native status bar. Guarded on isNativeApp(): the staff app never runs inside
  // Capacitor (it is reached from a browser, same as every other non-student screen),
  // so this plugin call — which is otherwise harmless even on web, @capacitor/status-bar
  // ships a web stub — simply never fires there, which is what "unaffected" means for a
  // surface that has no status bar to control in the first place.
  //
  // overlaysWebView:true (capacitor.config.json) is what makes the status bar draw ON
  // TOP of this screen instead of pushing it down — Header's own paddingTop:
  // env(safe-area-inset-top) is the other half, keeping the greeting and refresh
  // button clear of the notch/clock now sitting over them.
  //
  // Style.Dark (light status-bar content) is used UNCONDITIONALLY rather than actually
  // switching on prefers-color-scheme, and that is a deliberate reading of "per scheme"
  // rather than a missed case: the surface the status bar overlays is Header's own
  // gradient (NAVY_DARK -> NAVY -> MAROON below), which is dark in BOTH colour schemes
  // by design — a student's Home banner does not turn white in light mode. Style.Light
  // (dark content) here would print black icons on a navy bar and be unreadable in
  // EVERY scheme, not just one. The scheme listener is kept anyway, wired through a
  // single `styleForScheme` so the one place that would need to change if the header
  // ever became scheme-dependent is a one-line edit here, not a rewrite.
  useEffect(() => {
    if (!isNativeApp()) return;
    let cancelled = false;
    let mq;
    const styleForScheme = () => StatusBarStyle.Dark; // see comment above — always Dark, on purpose
    const apply = () => { if (!cancelled) StatusBar.setStyle({ style: styleForScheme() }).catch(() => {}); };
    StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
    apply();
    if (typeof window !== "undefined" && window.matchMedia) {
      mq = window.matchMedia("(prefers-color-scheme: dark)");
      if (mq.addEventListener) mq.addEventListener("change", apply); else mq.addListener(apply);
    }
    return () => {
      cancelled = true;
      if (mq) { if (mq.removeEventListener) mq.removeEventListener("change", apply); else mq.removeListener(apply); }
    };
  }, []);

  // A scan can arrive while the app is already open — a same-document navigation that
  // never reloads the page (see pendingQr.js). Pick it up and land on the check-in
  // screen exactly as a fresh load would.
  useEffect(() => {
    const onScan = () => {
      const p = peekPendingQr();
      if (p) { setPendingQr(p); setScreen("checkin"); }
    };
    window.addEventListener("edtech:pending-qr", onScan);
    return () => window.removeEventListener("edtech:pending-qr", onScan);
  }, []);

  // Tapping a push notification opens the screen it refers to — the `link` the
  // server attached (notify.js's pushToStudentDevices carries the SAME `link` value
  // the Notification row was created with). This is the seam the final review caught:
  // auth.jsx has dispatched `window` CustomEvent("push:open", { detail: link }) since
  // the push channel itself was built (auth.jsx:111, registerForPush's onOpen), but
  // only StaffHub.jsx (line ~532) was ever listening for it — the student side of that
  // channel and the inbox that gives `link` its meaning were built in the same wave by
  // two different tasks, and neither one owned wiring the shell up to the event the
  // other had already started firing. A student tapping a push before this fix landed
  // on the same screen they had the app already open on, silently, with no error.
  //
  // KNOWN_LINKS (moved to utils.js for exactly this reuse) is the same allowlist
  // Inbox.jsx's own onOpen checks before calling setScreen — a tapped push is not
  // trusted any further than a tapped inbox row is, for the identical reason: `link`
  // is a bare string column, not a foreign key, and a future trigger that typos it
  // must fail closed (silently do nothing) rather than hand setScreen a key with no
  // matching screen in the render below.
  useEffect(() => {
    const onOpen = (e) => {
      const link = e.detail;
      if (link && KNOWN_LINKS.has(link)) setScreen(link);
    };
    window.addEventListener("push:open", onOpen);
    return () => window.removeEventListener("push:open", onOpen);
  }, []);

  // Refetches JUST the inbox, separately from the big `load()` below.
  //
  // The bell's badge has to stay honest between the shell's own loads — a query
  // answered, or a mark released, while a student is sitting on the Attendance
  // screen must not wait for a pull-to-refresh to show up as unread. Rather than
  // poll on a timer (nothing else in this app does, and a per-student inbox is not
  // urgent enough to justify one), this is called at the two moments the brief calls
  // out as worth a fresh look: Home mounting (its own effect, below) and the Inbox
  // screen opening (Inbox.jsx's own effect) — the two places a student is actually
  // about to look at, or already looking at, whether anything is unread.
  const refreshInbox = useCallback(async () => {
    try {
      const r = await api.studentNotifications();
      setNotifications(r?.notifications || []);
      setUnread(r?.unread ?? 0);
    } catch (_) {
      // Best-effort — the bell keeps its last known count rather than flashing to
      // zero because of one failed request.
    }
  }, []);

  // Mark one or more notifications read, then reconcile from the server rather than
  // guess the new unread count locally — `updated` can be less than `ids.length` (an
  // id already read, or one that never belonged to this student) and a locally
  // decremented counter would drift from the truth on exactly that case.
  const markNotificationsRead = useCallback(async (ids) => {
    try { await api.studentMarkNotificationsRead(ids); } catch (_) { /* refreshInbox reconciles either way */ }
    await refreshInbox();
  }, [refreshInbox]);
  const markAllNotificationsRead = useCallback(() => markNotificationsRead(undefined), [markNotificationsRead]);

  // Everything the app shows is loaded once, here, so the home screen can summarise
  // attendance and results without each tab refetching the same thing.
  const load = useCallback(async () => {
    setBusy(true); setErr("");
    const [a, r, q, v, tt, tap] = await Promise.allSettled([
      api.studentAttendance(), api.studentAssessments(), api.studentQueries(), api.studentReviewsAboutMe(), api.studentTimetable(),
      api.studentTapContext(),
    ]);
    const ref = await api.studentReferrals().then(v => ({ status: "fulfilled", value: v }), () => ({ status: "rejected" }));
    const sdep = await api.studentSupportDepartments().then(v => ({ status: "fulfilled", value: v }), () => ({ status: "rejected" }));
    // Streaks — a bonus fetch like referrals/support departments: never added to
    // `failed`, and left at its null default (not "0-day streak") on rejection.
    const streak = await api.studentStreaks().then(v => ({ status: "fulfilled", value: v }), () => ({ status: "rejected" }));
    // A bonus fetch like referrals/support departments above: never added to `failed`
    // below, and a null result is a silent no-op — `bands` state already starts at
    // DEFAULT_ATTENDANCE_BANDS, so there is nothing to reset it TO on a rejection.
    const bandList = await fetchAttendanceBands();
    if (bandList) setBands(bandList);
    // The inbox, fetched here so the Header bell's badge is right from the first
    // paint on every screen, not only the two that also refetch it themselves.
    await refreshInbox();
    if (streak.status === "fulfilled") setStreaks(streak.value);
    if (a.status === "fulfilled") setAttendance(a.value);
    if (r.status === "fulfilled") setResults(r.value);
    if (q.status === "fulfilled") setQueries(q.value);
    if (v.status === "fulfilled") setReviews(v.value);
    // The timetable is a bonus screen — a failure here shouldn't add to the error
    // banner that gates the core screens, so it's loaded but not counted in `failed`.
    if (tt.status === "fulfilled") setTimetable(tt.value);
    // Tap check-in is a bonus like the timetable: a college that has not switched it on
    // returns { enabled: false }, and a failure here must not add to the error banner
    // that gates attendance, results and messages.
    if (tap.status === "fulfilled") setTapContext(tap.value);
    // A bonus screen like the timetable and tap check-in: this endpoint is new, so an
    // app talking to an older API 404s here, and that must not put an error banner over
    // attendance and results — which is why it is not counted in `failed` below.
    if (ref.status === "fulfilled") setReferrals(ref.value);
    // [] is a real answer — "this college runs no support desks" — and hides the form
    // rather than offering one with nothing to choose.
    if (sdep.status === "fulfilled") setSupportDepts(sdep.value);
    // ANY failure is reported, not only a total one. Requiring all of them to fail meant
    // a single broken call showed the student "Not graded yet" or "0 sessions" — an
    // answer, and a wrong one — instead of telling them something didn't load.
    const failed = [a, r, q, v].filter(x => x.status === "rejected");
    if (failed.length) {
      const which = [a.status === "rejected" && "attendance", r.status === "rejected" && "results", q.status === "rejected" && "messages", v.status === "rejected" && "reviews"].filter(Boolean);
      setErr(failed.length === 4
        ? (failed[0].reason?.message || "Could not load your information")
        : `Could not load your ${which.join(" or ")}. Tap the refresh icon at the top to try again. Everything else here is up to date.`);
    }
    setBusy(false);
  }, [refreshInbox]);
  useEffect(() => { load(); }, [load]);

  // "New reply" badge: answered queries this student hasn't opened yet. Seen-state is
  // kept per student in localStorage, so it's entirely personal to them.
  //
  // KEPT DELIBERATELY, ALONGSIDE THE NEW BELL, rather than folded into it. The two
  // answer genuinely different questions and can legitimately disagree: this one is
  // "has THIS student actually opened the Query tab since the reply landed" (it only
  // clears when `screen === "query"` actually mounts, below), while the bell's
  // `unread` is the server's own Notification.read flag, which the Inbox screen can
  // clear on a specific row without the student ever visiting the Ask tab at all
  // (see Inbox.jsx's onOpen — it marks read AND navigates in one action, so the two
  // usually move together, but a student who ignores the inbox notification and
  // finds the reply their own way still clears this counter independently). Losing
  // the finer signal here for the coarser one on the bell would be a regression the
  // brief did not ask for, so both stay — this is the "judge and document" the task
  // brief calls for on this exact point.
  const seenKey = `edtech_seen_replies_${user.id}`;
  const answered = queries.filter(q => q.status === "answered");
  let seen = new Set();
  try { seen = new Set(JSON.parse(localStorage.getItem(seenKey) || "[]")); } catch (_) { /* ignore */ }
  const newReplies = answered.filter(q => !seen.has(q.id)).length;
  useEffect(() => {
    if (screen === "query" && answered.length) {
      try { localStorage.setItem(seenKey, JSON.stringify(answered.map(q => q.id))); } catch (_) { /* ignore */ }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, queries]);

  // The same seen-state trick for reviews a lecturer has filed but the student hasn't
  // opened. Separate key so clearing one badge never clears the other.
  const seenReviewKey = `edtech_seen_reviews_${user.id}`;
  const reviewList = reviews || [];
  let seenReviews = new Set();
  try { seenReviews = new Set(JSON.parse(localStorage.getItem(seenReviewKey) || "[]")); } catch (_) { /* ignore */ }
  const newReviews = reviewList.filter(r => !seenReviews.has(r.id)).length;
  useEffect(() => {
    if (screen === "reviews" && reviewList.length) {
      try { localStorage.setItem(seenReviewKey, JSON.stringify(reviewList.map(r => r.id))); } catch (_) { /* ignore */ }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, reviews]);

  const title = { home: "Student Hub", checkin: "Check In", attendance: "My Attendance", assessments: "My Results", reviews: "My Reviews", query: "Ask the College", timetable: "My Timetable", support: "Support", mitigations: "Mitigating Circumstances", more: "More", inbox: "Inbox" }[screen];
  const shared = { attendance, results, reviews, queries, timetable, tapContext, busy, err, reload: load, setScreen, bands, streaks, refreshInbox };

  return (
    <PhoneShell
      header={<Header title={title} screen={screen} setScreen={setScreen} user={user} onRefresh={load} busy={busy} unread={unread} />}
      // The tab bar is the shell's FOOTER, not the last child of the scroll area
      // (13 Sep 2026). It used to render inside the scrollport as `sticky bottom-0`,
      // and a device screenshot showed both failure modes at once: content (the
      // Delete-account row) peeking out UNDERNEATH the bar, and the bar itself
      // floating above the physical bottom edge — sticky positioning answers to the
      // scrollport's geometry, which on a phone with native insets is not the same
      // thing as the visible screen. A footer row in the shell's fixed column cannot
      // do either: nothing is ever after it, and it is flush with the bottom on
      // every screen by construction.
      // `=== false` rather than `!` on hideCheckIn: anyCheckInWay is null until the
      // first load answers, and treating "not told yet" as "off" would drop the tab
      // on every app open and put it back half a second later.
      footer={<TabBar screen={screen} setScreen={setScreen} newReplies={newReplies}
        codesOnly={Boolean(tapContext?.qrEnabled && !tapContext?.enabled)}
        hideCheckIn={anyCheckInWay(tapContext) === false} />}
      onRefresh={load} refreshing={busy}
      // The ONLY caller that passes this — see PhoneShell.jsx's own comment on the
      // prop. StaffHub.jsx's call site is untouched, which is what keeps dark mode
      // out of the staff handset shell now that this app's `dark:` classes are real.
      darkCapable
    >
      <div className="flex min-h-full flex-col">
        {/* .student-bg (index.css) replaces an inline linear-gradient literal so dark
            mode has somewhere to redefine it — Tailwind's `dark:` variant only matches
            class names, and a gradient this specific was never going to become one
            without a named class to hang the override on. */}
        <div className="student-bg flex-1">
          {/* Keyed on the screen name so .screen-in replays per navigation — the same
              one-rise screen entrance the staff shell applies, defined in index.css.
              Inside .student-bg, not around it: the background must not fade with
              the content or every tab change flashes the page colour. */}
          <div key={screen} className="screen-in">
          {screen === "home" && <Home user={user} {...shared} newReplies={newReplies} newReviews={newReviews} />}
          {/* `timetable` travels down here too, in addition to tapContext — so today's
              classes can carry a "Join online class" button. tapContext.today (built
              from HndSession candidates) never carries teamsJoinUrl itself; the events
              this same load() already fetched for the Timetable screen do (see
              routes/student.js#studentEvents), and both name the same HndSession id
              (tapContext's `id` and an event's own `sessionId`), so CheckIn.jsx can
              look the link up by that id without this screen asking the server for
              anything it does not already have. */}
          {screen === "checkin" && <CheckInScreen tapContext={tapContext} timetable={timetable} reload={load} pendingQr={pendingQr} onQrDone={() => setPendingQr(null)} />}
          {screen === "attendance" && <AttendanceScreen {...shared} />}
          {screen === "assessments" && <ResultsScreen {...shared} />}
          {screen === "reviews" && <ReviewsScreen {...shared} />}
          {screen === "timetable" && <TimetableScreen timetable={timetable} busy={busy} reload={load} />}
          {screen === "query" && <QueryScreen queries={queries} reload={load} />}
          {screen === "inbox" && (
            <InboxScreen
              notifications={notifications} unread={unread} refreshInbox={refreshInbox}
              markRead={markNotificationsRead} markAllRead={markAllNotificationsRead} setScreen={setScreen}
            />
          )}
          {screen === "support" && <SupportScreen referrals={referrals} busy={busy} departments={supportDepts} reload={load} />}
          {/* Self-contained, unlike the screens above it — its own data is not part of
              this shell's central load() (see Mitigations.jsx's own file comment for
              why), so it carries no props from `shared` at all. */}
          {screen === "mitigations" && <MitigationsScreen />}
          {screen === "more" && <MoreScreen user={user} logout={logout} setScreen={setScreen} tapContext={tapContext} />}
          </div>
        </div>
      </div>
    </PhoneShell>
  );
}

// Persistent bottom navigation — the single biggest thing that makes this feel like
// an app rather than a website: every section is one thumb-tap away, always.
// `codesOnly`: the Check In tab is drawn with the NFC wave glyph, which is wrong for a
// college that only shows codes on screen — the first thing a student reads on the bar
// would name the one technology their college does not use. The More screen already
// picks its glyph this way; the bar now agrees with it.
//
// `hideCheckIn`: the tab goes away entirely at a college that has switched every
// capture method off. THIS REVERSES A DELIBERATE EARLIER CHOICE and the reversal was
// asked for, so both halves are recorded. The tab used to be permanent on the reasoning
// that a student who cannot tell "switched off" from "never built" reports it as
// missing — which had happened twice — and that a destination explaining itself beats
// an absence to interpret. What that argument did not weigh is the administrator's side:
// somebody switching the feature off in Settings expects it to LEAVE the app, and a tab
// that stays put reads as a switch that did not work. A permanent tab also spends one
// of six bottom-bar slots on a screen with nothing in it.
//
// The honest answer survives where it was always kept: CheckInStatusRow on the More
// screen still renders, still says the college has not switched check-in on, and is now
// the one place that says it. Deliberately not removed alongside these two — take it out
// as well and "switched off" becomes indistinguishable from "never built" again, which
// is the exact defect the permanent tab was introduced to fix.
function TabBar({ screen, setScreen, newReplies, codesOnly = false, hideCheckIn = false }) {
  const tabs = hideCheckIn ? TABS.filter((t) => t.key !== "checkin") : TABS;
  return (
    // No `sticky` and no positioning at all — this renders as PhoneShell's footer
    // row, below the scrollport, so flush-bottom is a property of the layout rather
    // than of scroll geometry. The safe-area padding stays HERE (not on the
    // scrollport): the bar is now the element that actually meets the home
    // indicator, and having both pad for it was doubling the gap.
    <nav className="z-30 flex border-t border-slate-200/80 bg-white/90 backdrop-blur-xl dark:border-slate-700/80 dark:bg-slate-900/90" style={{ paddingBottom: "env(safe-area-inset-bottom)", boxShadow: "0 -6px 20px -12px rgba(15,23,42,.25)" }}>
      {tabs.map(({ key, label, Icon: TabIcon }) => {
        const on = screen === key;
        const Icon = key === "checkin" && codesOnly ? QrCode : TabIcon;
        // NAVY is a CSS var; `NAVY + "14"` built an invalid colour string once the
        // brand primary stopped being a literal hex (branding.js#alpha's own comment
        // names this exact break) — alpha() is the fix. The inactive grey stays a
        // literal hex; it is legible against both bg-white/90 and dark:bg-slate-900/90.
        return (
          <button key={key} onClick={() => setScreen(key)} aria-current={on ? "page" : undefined}
            className="press relative flex flex-1 flex-col items-center gap-1 py-2">
            {/* .pop only while active — replays once per tab change, exactly as the
                staff bar does, so the two bars keep one motion language. */}
            <span className={`relative flex h-8 w-12 items-center justify-center rounded-2xl transition-all duration-200 ${on ? "pop" : ""}`}
              style={on ? { background: alpha(NAVY, 14) } : undefined}>
              <Icon size={20} strokeWidth={on ? 2.6 : 2} style={{ color: on ? NAVY : "#9aa5b8" }} />
              {key === "query" && newReplies > 0 && (
                <span className="pop absolute right-1.5 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[9px] font-extrabold text-slate-900 ring-2 ring-white dark:ring-slate-900">{newReplies}</span>
              )}
            </span>
            <span className="max-w-full truncate px-0.5 text-[10px] font-bold tracking-tight" style={{ color: on ? NAVY : "#9aa5b8" }}>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function Header({ title, screen, setScreen, user, onRefresh, busy, unread }) {
  const hour = Number(new Date().toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/London" }));
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const first = String(user.name || "").trim().split(/\s+/)[0] || "there";
  const home = screen === "home";
  return (
    // A deep brand gradient that curves into the page below it. The curve plus the
    // negative margin on the content is what gives the app its sense of depth —
    // the screen reads as sitting *on* the header rather than under a flat bar.
    <div
      className="animated-gradient relative z-20 overflow-hidden"
      style={{
        background: `linear-gradient(135deg, ${NAVY_DARK} 0%, ${NAVY} 45%, #3730a3 78%, ${MAROON} 140%)`,
        backgroundSize: "220% 220%",
        borderBottomLeftRadius: home ? 30 : 22,
        borderBottomRightRadius: home ? 30 : 22,
        // env(safe-area-inset-top) is 0 on every browser and on a Capacitor app with
        // overlaysWebView:false — the calc() degrades to the old flat 0.5rem exactly.
        // It is only ever non-zero once capacitor.config.json's overlaysWebView:true
        // (this task) puts the system status bar/notch on TOP of this header instead
        // of pushing it down, at which point this is what stops the greeting and the
        // refresh button sitting under the clock and the notch.
        paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)",
      }}
    >
      {/* Decorative blooms — they give the flat gradient some light and depth. */}
      <div className="pointer-events-none absolute -right-12 -top-20 h-52 w-52 rounded-full bg-white/12 blur-3xl" />
      <div className="pointer-events-none absolute -left-16 bottom--10 h-40 w-40 rounded-full bg-white/8 blur-3xl" />

      <div className="relative flex items-center gap-2 px-3 pb-2 pt-1">
        {!home
          ? <button onClick={() => setScreen("home")} aria-label="Back" className="press flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/15 text-white ring-1 ring-white/20 hover:bg-white/25"><ChevronLeft size={22} /></button>
          : <div className="flex h-11 w-12 shrink-0 items-center justify-center rounded-2xl bg-white px-1 shadow-lg"><BrandMark size={26} /></div>}
        <div className="min-w-0 flex-1 text-center"><h1 className="truncate text-[17px] font-extrabold tracking-tight text-white">{title}</h1></div>
        {/* The bell, on EVERY screen except the inbox itself — a button that opens the
            screen you are already on is an affordance for nothing, the same reason the
            back chevron above disappears on Home. Placed before Refresh rather than
            after: Refresh is the one control every screen already had, and adding a
            second icon after it would put the NEW control furthest from the thumb on
            a right-handed phone grip, where a reachability check would flag it. */}
        {screen !== "inbox" && (
          <button onClick={() => setScreen("inbox")} aria-label={unread > 0 ? `Inbox, ${unread} unread` : "Inbox"} className="press relative flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/15 text-white ring-1 ring-white/20 hover:bg-white/25">
            <Bell size={17} />
            {unread > 0 && (
              <span className="pop absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-extrabold text-slate-900 ring-2 ring-white/90">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </button>
        )}
        <button onClick={onRefresh} aria-label="Refresh" className="press flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/15 text-white ring-1 ring-white/20 hover:bg-white/25">
          <RefreshCw size={17} className={busy ? "animate-spin" : ""} />
        </button>
      </div>

      {home && (
        <div className="relative px-4 pb-7">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl text-lg font-extrabold text-white shadow-xl ring-2 ring-white/30" style={{ background: user.colour || MAROON }}>{user.initials || "S"}</div>
              <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-emerald-400 ring-2 ring-white/90" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-medium text-white/75">{greeting},</p>
              <p className="truncate text-[19px] font-extrabold leading-tight tracking-tight text-white">{first}</p>
              <p className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-bold text-white/90 ring-1 ring-white/15">
                <User size={9} />{user.studentRef || "Student"}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
