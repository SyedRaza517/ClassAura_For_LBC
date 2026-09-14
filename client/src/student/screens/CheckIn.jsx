import { useState, useEffect, useCallback, useRef } from "react";
// The scan outcome is a full-screen sheet, not a card in the page flow — see
// QrCheckInCard for why it has to escape this screen's scroll container.
import { createPortal } from "react-dom";
import { api } from "../../api";
import CheckInCard from "../../CheckInCard";
import {
  Loader2, CheckCircle2, AlertTriangle, MapPin, Nfc, ScanLine, Clock3, User, Video,
} from "lucide-react";

import { NAVY } from "../../branding";
import { clearPendingQr, stashScan, noteCheckedIn, hasCheckedIn } from "../../pendingQr";
import { qrScanResult, qrScanRefusal, keepScanAfter } from "../../qrResultView";
import QrScanner from "../../QrScanner";
import { nfcStatus } from "../../nfc";
import { ACCENT, ACCENT_TONE, toneVars } from "../ui/tokens";
import { ttLongDate, openExternalLink } from "../utils";

/**
 * sessionId -> teamsJoinUrl, built from the TIMETABLE's own events rather than a new
 * server call.
 *
 * tap-context's `today` list (sTapSession, routes/student.js) never carries
 * teamsJoinUrl — it is built from candidateSessions(), which selects nothing of the
 * kind. The timetable's events DO (studentEvents() reads it off the register itself,
 * see that function's own comment on why the session's copy outranks the event's).
 * Both name the same HndSession by id: a `today` row's own `id` IS that session's id
 * (sTapSession: `id: s.id`), and an event's `sessionId` is the same session (`id:
 * sessionFor.get(e.id)?.id`). So this looks the link up from data the shell already
 * fetched for the Timetable screen, rather than asking the server for a field this
 * screen's own endpoint does not serialise — no server change, and no second source
 * of truth for what is, after all, the same class.
 */
function joinUrlsBySessionId(timetable) {
  const map = new Map();
  for (const e of timetable?.events || []) {
    if (e.sessionId && e.teamsJoinUrl) map.set(e.sessionId, e.teamsJoinUrl);
  }
  return map;
}

/**
 * Is there ANY way for this student to check themselves in?
 *
 * `null` while the answer is unknown, which is not "no" — see the callers, which all
 * keep the entry point visible until told otherwise rather than popping it in half a
 * second after the app opens.
 *
 * THREE SWITCHES, and all three have to be read or this hides a working feature. A
 * college can run stickers (`enabled`), on-screen codes (`qrEnabled`), or the plain
 * "I'm here" declaration (`declareEnabled`) in any combination, and the three are
 * genuinely independent — `enabled` is the sticker switch alone, not a master. The
 * screen's own "Not switched on yet" card used to test only the first two, so a college
 * running declarations and nothing else told its students the feature did not exist
 * while the button to use it sat on the same screen. Everything that asks this question
 * now asks it here, so that cannot drift apart again.
 *
 * Exported: the shell (StudentApp.jsx) and the Home screen both need the same answer
 * about the same college, and duplicating the three-switch check anywhere is exactly
 * how those two drifted apart in the first place.
 */
export function anyCheckInWay(tapContext) {
  if (tapContext == null) return null;
  return tapContext.enabled === true || tapContext.qrEnabled === true || tapContext.declareEnabled === true;
}

/** One line for the Check In tile, honest in every state. */
export function checkInSub(tapContext) {
  if (tapContext == null) return "Checking…";
  // TWO switches now, not one. "Not switched on" is only true when BOTH are off — a
  // QR-only college's students were being told check-in didn't exist while a live code
  // sat on the projector in front of them.
  if (!tapContext.enabled && !tapContext.qrEnabled) return "Not switched on yet";
  const running = (tapContext.now || []).length;
  if (running > 1) return "Choose your class";
  if (running === 1) return tapContext.enabled ? "Ready. Tap a sticker" : "Scan the code on screen";
  if (tapContext.next) return `Next at ${tapContext.next.startTime}`;
  return "No classes left today";
}

// Today's classes, in the order they run.
//
// The point of this list is that it answers the question a student actually has —
// "what have I got today and when" — whether or not the college taps stickers. It also
// makes the check-in card legible: a row marked NOW is the one the button will mark, and
// a row already carrying P or L is one nobody needs to think about again.
function TodaysClasses({ today, loading, canDeclare, onDeclared, canScan, onScan, joinUrls }) {
  // Which class is mid-request, and what the last attempt said. Above the early return
  // with every other hook: the rule is positional, and a hook below `if (loading)` runs a
  // different number of times on the render after the data lands.
  const [marking, setMarking] = useState(null);
  const [failed, setFailed] = useState("");

  /**
   * "I'm here" — mark this class without a sticker or a code.
   *
   * OPTIMISTIC IS WRONG HERE, and that is the one place this differs from the register
   * screen a lecturer uses. This writes a mark ON THE STUDENT'S OWN RECORD with nothing
   * standing behind it, so it must not appear to have succeeded until the server says it
   * has: a row that reads "Present" and was never written is exactly the claim somebody
   * brings to an appeal.
   */
  const declare = async (c) => {
    if (!canDeclare || marking) return;
    setMarking(c.id); setFailed("");
    try {
      await api.studentDeclareCheckIn(c.id);
      await onDeclared?.();
    } catch (e) {
      setFailed(e?.message || "Could not mark you in. Try again.");
    } finally {
      setMarking(null);
    }
  };

  if (loading) return null;

  // An empty day is a real answer and deserves saying, not an absence to interpret.
  if (!today || !today.length) {
    return (
      <div className="rounded-2xl bg-white p-5 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">
        <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Today</p>
        <p className="mt-1.5 text-sm font-extrabold text-slate-800 dark:text-slate-100">No classes timetabled</p>
        <p className="mt-1 text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
          Nothing is scheduled for you today. If you think that&rsquo;s wrong, ask the college —
          registers are created from each unit&rsquo;s teaching dates.
        </p>
      </div>
    );
  }

  // P and L are the two a tap can produce; E and A come from a lecturer. Kept in one
  // place so the words and the colours cannot drift apart.
  const MARK = {
    P: { label: "Present", bg: "bg-emerald-50 dark:bg-emerald-950/40", text: "text-emerald-700 dark:text-emerald-300", ring: "ring-emerald-200 dark:ring-emerald-800" },
    L: { label: "Late", bg: "bg-amber-50 dark:bg-amber-950/40", text: "text-amber-700 dark:text-amber-300", ring: "ring-amber-200 dark:ring-amber-800" },
    E: { label: "Excused", bg: "bg-sky-50 dark:bg-sky-950/40", text: "text-sky-700 dark:text-sky-300", ring: "ring-sky-200 dark:ring-sky-800" },
    A: { label: "Absent", bg: "bg-rose-50 dark:bg-rose-950/40", text: "text-rose-700 dark:text-rose-300", ring: "ring-rose-200 dark:ring-rose-800" },
  };

  return (
    <div className="space-y-2.5">
      <p className="px-1 text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
        Today &middot; {today.length} class{today.length === 1 ? "" : "es"}
      </p>
      {/* SAID, NOT SWALLOWED. The server refuses a declaration for good reasons — the
          class is not running, the term is closed, somebody has already marked them —
          and each is a different next step for the student. A button that simply did
          nothing would send them to the office to ask why. */}
      {failed && (
        <p className="rounded-xl bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-700 ring-1 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-800">
          {failed}
        </p>
      )}

      {/* ONE CARD PER CLASS, not rows in a shared box.
          The screen-level scanner bar is gone, so each class has to carry its own action
          — and an action inside a divided list row reads as an afterthought. Separate
          cards give the running class somewhere to be obviously different from the two
          that are not, which is the whole job of this screen. */}
      {today.map((c, i) => {
        const mark = c.status ? MARK[c.status] : null;
        const isNow = c.state === "now";
        const over = c.state === "over";
        const actionable = isNow && !mark && (canScan || canDeclare);
        const where = [c.room ? `Room ${c.room}` : null, c.floor, c.campus].filter(Boolean).join(" · ");
        const about = [c.unitCode, c.course, c.school].filter(Boolean).join(" · ");
        const joinUrl = joinUrls?.get(c.id) || null;
        return (
          <div
            key={c.id}
            className={`fade-up overflow-hidden rounded-2xl bg-white transition dark:bg-slate-800 ${
              isNow ? "shadow-card ring-2" : "shadow-sm ring-1 ring-slate-200 dark:ring-slate-700"
            } ${over && !mark ? "opacity-70" : ""}`}
            style={{ ...(isNow ? { "--tw-ring-color": ACCENT.checkin } : null), animationDelay: `${i * 60}ms` }}
          >
            {/* The live strip. A student glancing at this screen between corridors is
                answering one question — which of these is happening NOW — and colour
                answers it before any word does. */}
            {isNow && <div className="h-1" style={{ background: ACCENT.checkin }} />}

            <div className="p-4">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className={`text-[15px] font-extrabold leading-tight ${over && !mark ? "text-slate-400 dark:text-slate-500" : "text-slate-800 dark:text-slate-100"}`}>
                    {c.unitName || c.unitCode}
                  </p>
                  <p className="mt-1 flex items-center gap-1.5 text-[12.5px] font-bold tabular-nums text-slate-600 dark:text-slate-300">
                    <Clock3 size={12.5} className="shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" />
                    {c.startTime}&ndash;{c.endTime}
                    {c.checkedInAt && <span className="font-semibold text-emerald-600 dark:text-emerald-400">&middot; in at {c.checkedInAt}</span>}
                    {!c.termOpen && <span className="font-semibold text-amber-600 dark:text-amber-400">&middot; term closed</span>}
                  </p>
                  {/* WRAPPED, NOT TRUNCATED. On a phone the campus and the lecturer used
                      to fall off the end of the line — which is precisely the half that
                      tells two classes at the same hour apart, and the reason the line is
                      here at all. Each part is omitted rather than dashed when the college
                      has not recorded it: an online class has no room, and "—" reads as a
                      room nobody knows. */}
                  {where && (
                    <p className="mt-1.5 flex items-start gap-1.5 text-[12px] leading-snug text-slate-500 dark:text-slate-400">
                      <MapPin size={12.5} className="mt-0.5 shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" />
                      <span>{where}</span>
                    </p>
                  )}
                  {(c.staff || []).length > 0 && (
                    <p className="mt-1 flex items-start gap-1.5 text-[12px] leading-snug text-slate-500 dark:text-slate-400">
                      <User size={12.5} className="mt-0.5 shrink-0 text-slate-400 dark:text-slate-500" aria-hidden="true" />
                      <span>{(c.staff || []).join(", ")}</span>
                    </p>
                  )}
                  {about && <p className="mt-1.5 text-[11px] leading-snug text-slate-400 dark:text-slate-500">{about}</p>}
                  {/* Present whether or not the class is running right now — the
                      register's own join link, once set, is not something a student
                      should only see for the hour it is actually on: joining a
                      couple of minutes early is normal, and a link that vanished
                      the moment `state` left "now" would have taught them not to
                      trust it being there. Not gated on `actionable` below: joining
                      an online class and marking a register are two independent
                      actions, and a class already marked (or over) can still be
                      one a student wants to open, e.g. for a recording. */}
                  {joinUrl && (
                    <button onClick={() => openExternalLink(joinUrl)}
                      className="tone-soft press mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold"
                      style={toneVars(ACCENT_TONE.checkin)}>
                      <Video size={12} aria-hidden="true" /> Join online class
                    </button>
                  )}
                </div>

                <span className="shrink-0">
                  {mark
                    ? <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ${mark.bg} ${mark.text} ${mark.ring}`}>{mark.label}</span>
                    : isNow
                      ? <span className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold text-white" style={{ background: ACCENT.checkin }}>
                          {/* A pulse, because "on now" is the only thing on this screen
                              that is true for the next hour and then stops being true. */}
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />On now
                        </span>
                      : <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-400 dark:bg-slate-700 dark:text-slate-500">{over ? "Finished" : "Later"}</span>}
                </span>
              </div>

              {/* THE ACTION, ON THE CLASS IT MARKS. Offered only while the class is
                  running and only if nobody has marked them: a class that is over cannot
                  be claimed after the fact, and a mark that already stands is never
                  overwritten by a student — the same rule the sticker and the code obey.
                  Said here so a button is never offered for a request the server refuses. */}
              {actionable && (
                <div className="mt-3.5 flex gap-2">
                  {canScan && (
                    <button onClick={onScan}
                      className="press flex flex-1 items-center justify-center gap-2 rounded-xl py-3 text-[13px] font-bold text-white"
                      style={{ background: ACCENT.checkin }}>
                      <ScanLine size={15} aria-hidden="true" /> Scan the code
                    </button>
                  )}
                  {canDeclare && (
                    <button onClick={() => declare(c)} disabled={marking === c.id}
                      className={`press flex items-center justify-center gap-2 rounded-xl py-3 text-[13px] font-bold disabled:opacity-50 ${
                        canScan ? "px-4 bg-white text-slate-700 ring-1 ring-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:ring-slate-600" : "flex-1 text-white"
                      }`}
                      style={canScan ? undefined : { background: ACCENT.checkin }}>
                      {marking === c.id ? "Marking…" : "I'm here"}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function CheckInScreen({ tapContext, timetable, reload, pendingQr, onQrDone }) {
  const enabled = tapContext?.enabled;
  const qrEnabled = tapContext?.qrEnabled;
  // Recomputed on every render rather than useMemo'd: `timetable` only actually
  // changes on a reload (a handful of times per session), and a Map over a day's
  // worth of events is not expensive enough to be worth the extra hook for.
  const joinUrls = joinUrlsBySessionId(timetable);
  const running = (tapContext?.now || []).length;
  // The in-app scanner. A decoded code is stashed exactly as a scanned link would be,
  // and the app's own listener turns it into the card above — one road for both.
  const [scanning, setScanning] = useState(false);
  const onScanned = useCallback((p) => { setScanning(false); stashScan(p); }, []);
  const closeScanner = useCallback(() => setScanning(false), []);

  // CAN THIS PHONE ACTUALLY TAP A STICKER? Asked here rather than left inside the sticker
  // card, because the answer decides whether two whole blocks belong on the screen at all.
  //
  // The card used to answer it privately and render "Use the app to check in — a browser
  // can't read a sticker" in its place. On a college where codes are also on, that banner
  // is an apology for a method the student does not need, sitting directly above the class
  // they can scan right now. It is still shown where it is the ONLY answer — a college
  // with stickers and nothing else has to tell somebody why the screen is empty.
  const tapReady = useCanTap();
  const canTap = enabled && tapReady === true;
  const tapIsOnlyMethod = enabled && !qrEnabled && tapContext?.declareEnabled !== true;

  const next = tapContext?.next;

  return (
    <div className="space-y-3.5 px-4 pb-8 pt-5">
      {/* A scanned code outranks everything else on the screen: the student is holding
          the result of an action they just took, and it answers first. It renders as a
          full-screen sheet over this whole screen rather than as the first card in it —
          its own comment explains why anything less went unseen. Left HERE in the tree,
          not lifted to the app root, because this screen owns the scan lifecycle and
          nothing about a portalled child cares where it was declared. */}
      {/* Keyed on the code so a SECOND scan remounts the card — its once-only submit
          guard is a ref, which must not survive from the previous scan's card. */}
      {pendingQr && <QrCheckInCard key={pendingQr.code} qr={pendingQr} reload={reload} onDone={onQrDone} />}

      {/* ONE LINE THAT ANSWERS THE WHOLE SCREEN, before any card.
          A student opens this in a corridor with one question — can I check in, now? —
          and previously had to read three cards to find out. The state is said once, at
          the top, in the words the answer actually takes. */}
      {tapContext && (
        <div className="overflow-hidden rounded-2xl bg-white dark:bg-slate-800" style={running ? { background: ACCENT.checkin } : undefined}>
          <div className={`px-4 py-3.5 ${running ? "text-white" : "ring-1 ring-slate-200 dark:ring-slate-700"}`}>
            <p className={`text-[11px] font-bold uppercase tracking-wider ${running ? "text-white/70" : "text-slate-400 dark:text-slate-500"}`}>
              {ttLongDate(tapContext.date)}
            </p>
            <p className={`mt-0.5 text-[17px] font-extrabold leading-tight ${running ? "text-white" : "text-slate-800 dark:text-slate-100"}`}>
              {running > 1 ? `${running} classes on now`
                : running === 1 ? `${(tapContext.now[0].unitName || tapContext.now[0].unitCode)} is on now`
                : next ? "No class on right now"
                : "That's you done for today"}
            </p>
            <p className={`mt-1 text-[12.5px] leading-snug ${running ? "text-white/85" : "text-slate-500 dark:text-slate-400"}`}>
              {running
                ? (canTap && qrEnabled ? "Scan the code on screen, or tap the sticker in your room."
                  : qrEnabled ? "Scan the code your lecturer has on screen."
                  : canTap ? "Hold your phone against the sticker in your room."
                  : "Use the button on your class below.")
                : next
                  ? <>Check-in opens when <strong className="font-semibold">{next.unitName || next.unitCode}</strong> starts at {next.startTime}.</>
                  : "You have no more classes today."}
            </p>
          </div>
        </div>
      )}

      {tapContext == null && (
        <div className="rounded-2xl bg-white p-5 text-center ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">
          <Loader2 size={20} className="mx-auto animate-spin text-slate-300 dark:text-slate-600" />
          <p className="mt-2 text-[13px] text-slate-500 dark:text-slate-400">Just a moment…</p>
        </div>
      )}

      {/* "Not switched on" is only true when EVERY capture method is off — asked of
          anyCheckInWay so this card, the bottom tab and the More row cannot disagree
          about the same college. This has been wrong in both directions: it keyed on the
          sticker switch alone, which told a QR-only college's students the feature didn't
          exist while a live code sat on their projector, and then on two switches of
          three, which said the same thing to a college running "I'm here" declarations.
          Reachable even with the tab hidden — a student who scans a projector code at a
          college that has since switched check-in off arrives straight here. */}
      {anyCheckInWay(tapContext) === false && (
        <div className="rounded-2xl bg-white p-5 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">
          <span className="tone-soft flex h-11 w-11 items-center justify-center rounded-2xl" style={toneVars(ACCENT_TONE.checkin)}>
            <Nfc size={19} />
          </span>
          <p className="mt-3 text-sm font-extrabold text-slate-800 dark:text-slate-100">Not switched on yet</p>
          <p className="mt-1 text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
            Your college hasn&rsquo;t turned on self check-in. Your lecturer takes the register as usual.
          </p>
        </div>
      )}

      {/* The sticker card, only where a sticker is reachable — or where it is the only
          method a student has, in which case they need to be told why it will not work. */}
      <StudentCheckIn tapContext={tapContext} reload={reload} />

      {/* THE SCANNER IS NOT A SCREEN-LEVEL CONTROL. Two of them used to sit above the
          class list — a "Scan to check in" card and a "Scan the code on screen" bar — so a
          student had to hold two ideas at once: which class they are in, and a button
          elsewhere that did not name it. The action is on the class now. */}
      {scanning && <QrScanner onScan={onScanned} onClose={closeScanner} />}

      <TodaysClasses today={tapContext?.today} loading={tapContext == null}
        canDeclare={tapContext?.declareEnabled === true} onDeclared={reload}
        canScan={qrEnabled === true} onScan={() => setScanning(true)} joinUrls={joinUrls} />

      {/* The sticker flow has real steps (arm, wait for the button, press), so its
          walkthrough stays — but only for somebody who can actually follow it. Explaining
          how to tap a sticker to a browser that cannot read one is the same apology the
          banner above used to make, in three more lines. */}
      {canTap && (
        <div className="rounded-2xl bg-white p-5 ring-1 ring-slate-200 dark:bg-slate-800 dark:ring-slate-700">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">How the sticker works</p>
          <ul className="mt-2 space-y-2 text-[13px] leading-relaxed text-slate-600 dark:text-slate-300">
            <li>1. Hold your phone against the sticker in your classroom.</li>
            <li>2. The button turns blue for about a minute.</li>
            <li>3. Press it, and you&rsquo;re marked present with the time.</li>
          </ul>
          <p className="mt-3 text-[12px] leading-relaxed text-slate-400 dark:text-slate-500">
            It only works while your class is actually running.
          </p>
        </div>
      )}
    </div>
  );
}


/* --------------------------- the scanned-code card --------------------------- */

// What a scan becomes once the app has hold of it. Renders at the very top of the
// check-in screen, submits the code exactly ONCE on mount, and then shows what the
// server decided — including every way it can say no, each with its own next step.
//
// A sibling of the NFC card, not a change to it: CheckInCard.jsx is deeply coupled to
// the sticker flow (arming windows, NFC availability, the blue button) and none of that
// applies to a code that has already been read. The two share nothing but the screen.
// The four answers a scan can end on, plus the refusal. Absent and refused are rose on
// purpose: before this, every outcome was emerald or amber, so "you are marked absent"
// and "you are checked in, late" were the same colour and differed only in wording.
const QR_TONES = {
  present: { bg: "bg-emerald-50", ring: "ring-emerald-200", text: "text-emerald-700", chip: "bg-emerald-100 dark:bg-emerald-900/60" },
  late:    { bg: "bg-amber-50",   ring: "ring-amber-200",   text: "text-amber-700",   chip: "bg-amber-100 dark:bg-amber-900/60" },
  excused: { bg: "bg-sky-50",     ring: "ring-sky-200",     text: "text-sky-700",     chip: "bg-sky-100 dark:bg-sky-900/60" },
  absent:  { bg: "bg-rose-50",    ring: "ring-rose-200",    text: "text-rose-700",    chip: "bg-rose-100 dark:bg-rose-900/60" },
  refused: { bg: "bg-rose-50",    ring: "ring-rose-200",    text: "text-rose-700",    chip: "bg-rose-100 dark:bg-rose-900/60" },
};
// The tone's text colour, dark-mode paired — QR_TONES.* stays untouched above (the
// modal's coloured icon chip is decorative, fine unchanged), but the HEADING text sits
// directly on the sheet's own bg-white/dark:bg-slate-800 surface and needs the same
// AA-nudged pair every other dynamic colour in this app now gets.
const QR_TONE_TEXT_DARK = {
  present: "dark:text-emerald-300", late: "dark:text-amber-300", excused: "dark:text-sky-300",
  absent: "dark:text-rose-300", refused: "dark:text-rose-300",
};

/**
 * What a scanned code turned into, shown as a FULL-SCREEN SHEET rather than a card in
 * the page flow.
 *
 * THIS IS A BUG FIX, and the bug was invisible in every way that matters. The outcome
 * used to render as the first child of the check-in screen — above the day's header
 * line, above the class list. But the button that opens the scanner is ON the running
 * class, which is usually the second or third card down, so a student had scrolled to
 * reach it. The camera closed the instant the code decoded (a few hundred milliseconds:
 * the code is right in front of them), the sheet-less card mounted somewhere above the
 * fold, and the screen they were looking at did not visibly change. Reported exactly as
 * it looked from the outside: "the camera closes in a millisecond and it doesn't put me
 * present." It very often HAD put them present.
 *
 * A sheet is the fix rather than scrolling the container to the top, because the scroll
 * would be a race — the card mounts in the same commit that the scanner unmounts, and
 * a scroll into a list whose height is changing lands wherever it lands. The outcome of
 * a check-in is also the one thing on this screen that must not be missed: the student
 * is standing in a lecture theatre deciding whether to put the phone away. It takes over
 * the screen the camera just gave back, which is where their eyes already are.
 *
 * Portalled to document.body deliberately. This screen is inside PhoneShell's
 * overflow-y-auto scrollport, and a `fixed` element inside a scrolling ancestor is only
 * as reliable as that ancestor's transforms — one `transform` anywhere up the tree makes
 * it the containing block, and "fixed" quietly becomes "absolute inside a box you have
 * scrolled past". The portal steps outside all of it.
 */
function QrCheckInCard({ qr, reload, onDone }) {
  // sending → done | failed. One object rather than separate flags so a render can
  // never see a half-updated pair.
  const [state, setState] = useState({ phase: "sending" });
  // The submit guard. The qr object is taken from storage exactly once, but React 18's
  // StrictMode double-runs effects in development, and one scan must never become two
  // submits — the server would answer alreadyMarked, which reads as a bug to a student
  // who scanned once.
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current || !qr) return;
    fired.current = true;
    // The stash dies the moment the submit fires — one scan, one attempt. A reload
    // that races the request simply resubmits and is answered alreadyMarked.
    clearPendingQr();

    // ALREADY CHECKED IN ON THIS TAB FOR THIS CLASS? Then this is not a new attempt — the
    // code rotated and the camera re-read it, or the deep link re-navigated, or this card
    // remounted on the new code. Show the reassuring answer and DO NOT resubmit. A second
    // POST here returns "already marked" at best and, once the code has expired, a red
    // "scan again" over a check-in that already worked — and a burst of them trips the
    // rate limiter. The `fired` ref only guards one card instance; this guard (see
    // pendingQr.noteCheckedIn) is what holds across rotations and remounts. Keyed on the
    // session, because the class is what stays the same while the code turns over.
    // Short-circuit ONLY on a status this tab actually checked in with, and REPLAY that
    // status — the fabricated `{ alreadyMarked }` with no status defaulted to "P" in the
    // verdict builder, which painted a green "Already checked in" over a register that
    // said ABSENT (a real device report, 14 Sep 2026). A null/undefined answer — never
    // scanned, or a pre-upgrade entry with no recorded status — falls through to the
    // server, whose repeat answer is idempotent, budget-refunded and truthful.
    const standing = hasCheckedIn(qr.sessionId);
    if (standing === "P" || standing === "L") {
      setState({ phase: "done", result: { ok: true, alreadyMarked: true, status: standing } });
      return;
    }
    (async () => {
      try {
        const r = await api.studentQrCheckIn(qr.sessionId, qr.code);
        // Record ONLY a real check-in (noteCheckedIn refuses anything but P/L): a 200
        // carrying a lecturer's standing "A" must not become this tab's "I'm in".
        noteCheckedIn(qr.sessionId, r?.status);
        setState({ phase: "done", result: r });
        // Refresh the day's list so the P or L pill appears under the card at once.
        reload();
      } catch (e) {
        // An expired session is the one refusal that never reached the register. The app
        // is about to show the sign-in; put the scan back so it submits itself afterwards
        // instead of sending the student back to the projector. See keepScanAfter.
        if (keepScanAfter(e)) stashScan(qr);
        setState({ phase: "failed", error: e });
      }
    })();
  }, [qr, reload]);

  // Escape closes it, but only once there is something to close. Dismissing mid-flight
  // would leave a request in the air with nowhere to report back to, and the student
  // believing they had cancelled something that had already been written.
  const settled = state.phase !== "sending";
  useEffect(() => {
    if (!settled) return;
    const onKey = (e) => { if (e.key === "Escape") onDone(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settled, onDone]);

  let body;
  if (state.phase === "sending") {
    body = (
      <div className="p-6 text-center">
        <Loader2 size={26} className="mx-auto animate-spin text-slate-300 dark:text-slate-600" />
        <p className="mt-3 text-sm font-bold text-slate-700 dark:text-slate-200">Checking you in…</p>
        <p className="mt-1 text-[12.5px] text-slate-500 dark:text-slate-400">Hold on a moment.</p>
      </div>
    );
  } else if (state.phase === "done") {
    const v = qrScanResult(state.result);
    const tone = QR_TONES[v.tone] || QR_TONES.present;
    const toneDark = QR_TONE_TEXT_DARK[v.tone] || QR_TONE_TEXT_DARK.present;
    const Icon = v.good ? CheckCircle2 : AlertTriangle;
    body = (
      <div className="p-5" role="status" aria-live="polite">
        {/* The icon is BIG and on its own line here, where the card had it beside the
            text at 44px. On a sheet that has the whole screen, the first thing to reach
            the student across a lecture theatre is the shape and the colour — they read
            the sentence second. */}
        <div className={`mx-auto flex h-16 w-16 items-center justify-center rounded-3xl ${tone.chip}`}>
          <Icon size={30} className={`${tone.text} ${toneDark}`} />
        </div>
        <p className={`mt-3.5 flex items-center justify-center gap-2 text-center text-[17px] font-extrabold ${tone.text} ${toneDark}`}>
          {v.heading}
          {v.chip && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10.5px] font-bold text-amber-700 ring-1 ring-amber-200 dark:bg-amber-900/60 dark:text-amber-300 dark:ring-amber-800">{v.chip}</span>}
        </p>
        <p className="mt-1.5 text-center text-[13px] leading-relaxed text-slate-600 dark:text-slate-300">{v.detail}</p>
        <button onClick={onDone} className="press mt-5 w-full rounded-xl py-3.5 text-[14px] font-bold text-white" style={{ background: ACCENT.checkin }}>Done</button>
      </div>
    );
  } else {
    // Refused. Rose, so a refusal is never mistaken at a glance for the amber of a Late
    // check-in — the two used to differ only by the words in them.
    const v = qrScanRefusal(state.error);
    const tone = QR_TONES.refused;
    const toneDark = QR_TONE_TEXT_DARK.refused;
    body = (
      <div className="p-5" role="alert" aria-live="assertive">
        <div className={`mx-auto flex h-16 w-16 items-center justify-center rounded-3xl ${tone.chip}`}>
          <AlertTriangle size={28} className={`${tone.text} ${toneDark}`} />
        </div>
        <p className={`mt-3.5 text-center text-[17px] font-extrabold ${tone.text} ${toneDark}`}>{v.heading}</p>
        <p className="mt-1.5 text-center text-[13px] leading-relaxed text-slate-600 dark:text-slate-300">{v.advice}</p>
        <button onClick={onDone} className="press mt-5 w-full rounded-xl bg-white py-3.5 text-[14px] font-bold text-slate-700 ring-1 ring-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:ring-slate-600">Dismiss</button>
      </div>
    );
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Check-in result"
      className="fixed inset-0 z-[96] flex items-end justify-center bg-slate-900/55 p-4 sm:items-center"
      // The scrim dismisses, once settled — the same rule as Escape, and never a way to
      // walk away from a request still in flight.
      onClick={settled ? onDone : undefined}
    >
      {/* z-[96]: one above the scanner's z-[95]. They are never on screen together —
          the scanner stops itself before handing the code over — but ordering them
          leaves nothing to a mount race if that ever stops being true. */}
      <div
        className="scale-in w-full max-w-sm overflow-hidden rounded-3xl bg-white shadow-2xl dark:bg-slate-800"
        onClick={(e) => e.stopPropagation()}
      >
        {body}
      </div>
    </div>,
    document.body
  );
}
// The card at the top of the home screen. Renders nothing at all when the college has
// not switched tap check-in on, so a student at an institution that does not use it
// never sees a feature they cannot have.
//
// `now` from the server is the list of this student's classes running at this moment:
// empty when none is, one when it is unambiguous, several when two overlap. The picker
// only appears in that last case, which is rare enough that making it the default shape
// would put a menu in front of every student every day for the sake of a few.
/**
 * Whether this phone can actually read a sticker.
 *
 * A HOOK RATHER THAN A CHECK IN TWO PLACES. The sticker card renders on Home and again on
 * Check In, and the screen around it needs the same answer to decide its own wording and
 * whether the walkthrough belongs there at all. Three copies of an async probe is three
 * chances for the screens to disagree about the same phone.
 *
 * `null` while the answer is unknown, which is NOT "no": rendering the unavailable state
 * during the first tick would flash an apology at every student for a moment before the
 * probe comes back.
 */
function useCanTap() {
  const [nfc, setNfc] = useState(null);
  useEffect(() => {
    let live = true;
    nfcStatus().then((v) => live && setNfc(v)).catch(() => live && setNfc({ ok: false, reason: "error" }));
    return () => { live = false; };
  }, []);
  return nfc === null ? null : nfc.ok === true;
}

// Exported: the Home screen renders the same sticker card above its headline numbers
// (see that file's comment on why it sits there), so this cannot stay private to the
// Check In screen the way QrCheckInCard and TodaysClasses do.
export function StudentCheckIn({ tapContext, reload }) {
  const [picked, setPicked] = useState(null);
  // Every hook above the early returns. A hook below one runs a different number of times
  // on the render after the data lands, which is React error #310 and a blank screen.
  const canTap = useCanTap();
  // Hidden on the home screen when the college has not switched tap check-in on: a
  // student should not be shown a control their institution has not adopted. The row on
  // the More screen stays visible in that case and says so, because rendering NOTHING
  // anywhere made "switched off" and "never built" look identical — and that is how this
  // came to be reported as missing.
  if (!tapContext?.enabled) return null;
  // AND HIDDEN WHERE THE PHONE CANNOT TAP AND SOMETHING ELSE CAN. The card's own
  // unavailable state said "Use the app to check in — a browser can't read a sticker",
  // which on a college that also shows codes is an apology for a method the student does
  // not need, printed directly above the class they can scan right now. It renders on
  // Home and on Check In, so it said it twice.
  //
  // Still shown where tapping is the ONLY method: a college with stickers and nothing
  // else has to tell somebody why they cannot check in, or the screen is silently empty.
  const anotherWay = tapContext.qrEnabled === true || tapContext.declareEnabled === true;
  if (canTap === false && anotherWay) return null;

  const running = tapContext.now || [];
  const next = tapContext.next;
  const many = running.length > 1;
  const one = running.length === 1 ? running[0] : null;
  const target = many ? picked : one;

  const when = (s) => `${s.startTime}–${s.endTime}`;

  const subtitle = (
    <div className="mb-3">
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
        <Nfc size={13} /> Check in
      </p>
      {running.length === 0 ? (
        <p className="mt-1 text-sm leading-snug text-slate-600">
          {next
            ? <>No class on right now. Your next one is <span className="font-semibold text-slate-800">{next.unitName}</span> at {next.startTime}.</>
            : "You have no more classes today."}
        </p>
      ) : many && !picked ? (
        <>
          <p className="mt-1 text-sm leading-snug text-slate-600">Two of your classes are running. Which one are you in?</p>
          <div className="mt-2 space-y-1.5">
            {running.map((s) => (
              <button key={s.id} type="button" onClick={() => setPicked(s)}
                className="press w-full rounded-xl border border-slate-200 px-3 py-2 text-left">
                <p className="text-[13px] font-semibold text-slate-800">{s.unitName || s.unitCode}</p>
                <p className="text-[11px] text-slate-500">{when(s)}</p>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="mt-1 text-sm leading-snug text-slate-600">
          <span className="font-semibold text-slate-800">{target?.unitName || target?.unitCode}</span>
          <span className="text-slate-500"> · {target ? when(target) : ""}</span>
          {many && <button type="button" onClick={() => setPicked(null)} className="ml-2 text-[12px] font-semibold underline" style={{ color: NAVY }}>change</button>}
        </p>
      )}
    </div>
  );

  return (
    <CheckInCard
      armSeconds={tapContext.armSeconds || 60}
      subtitle={subtitle}
      actionLabel="Check in"
      disabled={running.length === 0 || (many && !picked)}
      disabledNote={running.length === 0
        ? (next ? `Check-in opens at ${next.startTime}.` : "Nothing to check in to today.")
        : "Choose which class you're in first."}
      onCheckIn={async (tagCode) => {
        const r = await api.studentTapCheckIn(tagCode, target?.id);
        // The mark changes this student's attendance percentage, so the screen behind
        // the card is now stale. Refreshing also re-reads tap-context, which is what
        // stops a second check-in being offered for a class already marked.
        reload();
        return r;
      }}
      renderResult={(r) => {
        // The SAME verdict builder as the QR sheet, so the two capture methods can
        // never describe one mark two ways. This line used to render any status that
        // was not "L" as "present" — including a lecturer's standing ABSENT, which a
        // tap deliberately never overwrites; qrScanResult is where A and E already
        // get told the truth and the one next step a student can actually take.
        const v = qrScanResult(r);
        return <>{v.heading}. {v.detail}</>;
      }}
    />
  );
}

export default CheckInScreen;
