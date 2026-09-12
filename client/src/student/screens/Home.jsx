import {
  Percent, Award, MessageSquare, ChevronRight, Info, Settings, Sparkles,
  CheckCircle2, Clock3, CalendarCheck, CalendarDays, Nfc,
} from "lucide-react";
import { Screen, ErrBox, LoadingScreen, SectionTitle, Stat, Action, HeroTile } from "../ui";
import { ACCENT, ACCENT_TONE, attendanceTone, gradeTone, bandForPct, DEFAULT_ATTENDANCE_BANDS, toneVars } from "../ui/tokens";
import { fmtDate } from "../utils";
import { NAVY, alpha } from "../../branding";
import { StudentCheckIn, anyCheckInWay, checkInSub } from "./CheckIn";

export function Home({ user, attendance, results, queries, reviews, tapContext, busy, err, reload, setScreen, newReplies, newReviews, bands }) {
  // Only blank the screen when nothing at all arrived. One failed call must not
  // hide the data that did load — that was the old silent-wrong-data bug inverted.
  if (err && !attendance && !results) return <Screen><ErrBox>{err}</ErrBox></Screen>;
  if (busy && !attendance && !results) return <LoadingScreen />;

  const cur = attendance?.current || {};
  const curUnits = cur.units || cur.modules || [];
  const o = cur.overall || {};
  const attPct = o.pct ?? null;
  const avgPct = results?.averagePct ?? null;
  const graded = results?.graded ?? 0;
  const totalAssess = results?.count ?? 0;
  const pending = Math.max(0, totalAssess - graded);
  const latestReply = queries.filter(q => q.status === "answered" && q.response)[0];
  // The server returns reviews newest-first, so the first one is the latest.
  const latestReview = (reviews || [])[0];

  const attTone = attendanceTone(attPct, bands);
  const avgTone = gradeTone(avgPct);

  // One clear message about where they stand, in words rather than numbers. This used
  // to be an inline 85/70 split invented just for this banner — a FOURTH scale next to
  // pctTone, gradeTone and progressTone, and the one the original survey found hardest
  // to spot because it lived nowhere near ui/tokens.js. It now reads straight off the
  // ladder every other attendance figure on this app uses: the band's own label, plus a
  // call to action chosen by RANK within the college's own list (best/second -> keep it
  // up, worst/second-worst -> needs attention) rather than a percentage this file would
  // otherwise have had to re-invent for a college that configures its own boundaries.
  const bandList = Array.isArray(bands) && bands.length ? bands : DEFAULT_ATTENDANCE_BANDS;
  const resolvedBand = bandForPct(attPct, bandList);
  const bandIdx = resolvedBand ? bandList.indexOf(resolvedBand) : -1;
  const band = attPct == null || !resolvedBand ? null : {
    t: `${resolvedBand.label}. ${bandIdx <= 1 ? "Keep it up." : bandIdx >= bandList.length - 2 ? "Your attendance needs attention." : "There's room to improve."}`,
  };

  return (
    <div className="space-y-3.5 px-4 pb-8 pt-5">
      {/* Check-in sits ABOVE the headline numbers on purpose: it is the one thing on
          this screen with a deadline attached. Attendance and results are still true in
          an hour; a register closes when the class does. */}
      <StudentCheckIn tapContext={tapContext} reload={reload} />

      {/* Headline pair: the two numbers a student actually cares about. */}
      <div className="grid grid-cols-2 gap-3">
        <HeroTile onClick={() => setScreen("attendance")} i={0}
          pct={attPct} label="Attendance" tone={attTone}
          foot={`${curUnits.length} current unit${curUnits.length === 1 ? "" : "s"}`} />
        <HeroTile onClick={() => setScreen("assessments")} i={1}
          pct={avgPct} label="Average" tone={avgTone}
          foot={results?.averageGrade || (graded ? "—" : "Not graded yet")} />
      </div>

      {band && (
        <div className="tone-panel fade-up flex items-center gap-2.5 rounded-2xl px-3.5 py-3 ring-1" style={{ ...toneVars(attTone), animationDelay: "110ms" }}>
          <span className="tone-soft flex h-7 w-7 shrink-0 items-center justify-center rounded-xl" style={toneVars(attTone)}><Sparkles size={14} /></span>
          <p className="tone-text text-[12px] font-bold leading-snug" style={toneVars(attTone)}>{band.t}</p>
        </div>
      )}

      {/* At a glance */}
      <div className="grid grid-cols-3 gap-2.5">
        <Stat icon={CheckCircle2} value={o.P ?? 0} label="Present" colour="#059669" i={2} />
        <Stat icon={Clock3} value={(o.L ?? 0) + (o.E ?? 0)} label="Late / Exc." colour="#ea580c" i={3} />
        <Stat icon={CalendarCheck} value={o.marked ?? 0} label="Sessions" colour={ACCENT.attendance} i={4} />
      </div>

      {/* Latest reply, surfaced so it isn't missed */}
      {latestReply && (
        <button onClick={() => setScreen("query")} className="press fade-up w-full rounded-3xl bg-white p-4 text-left shadow-card ring-1 ring-slate-200/60 dark:bg-slate-800 dark:ring-slate-700/60" style={{ animationDelay: "220ms" }}>
          <div className="flex items-center gap-2">
            <span className="tone-soft flex h-7 w-7 items-center justify-center rounded-xl" style={toneVars(ACCENT_TONE.ask)}><MessageSquare size={14} /></span>
            <p className="tone-text flex-1 text-[10px] font-extrabold uppercase tracking-widest" style={toneVars(ACCENT_TONE.ask)}>Reply from the college</p>
            {newReplies > 0 && <span className="pop rounded-full bg-amber-400 px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-slate-900">new</span>}
          </div>
          <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-slate-600 dark:text-slate-300">{latestReply.response}</p>
          <p className="tone-text mt-1.5 flex items-center gap-1 text-[11px] font-bold" style={toneVars(ACCENT_TONE.ask)}>Read the conversation <ChevronRight size={12} /></p>
        </button>
      )}

      {/* A lecturer's review, surfaced the same way a college reply is. It carries the
          summary rather than the progress band: the band belongs on the screen that
          also gives it the context of what was discussed and agreed.
          NAVY is the college's own brand colour (a CSS var, "var(--brand-primary)"),
          not a literal hex — `NAVY + "14"` used to build an invalid CSS colour string
          ("var(--brand-primary)14"), the exact break branding.js#alpha's own comment
          warns about. alpha() is the fix, and was already sitting unused in this
          file's own NAVY import. */}
      {latestReview && (
        <button onClick={() => setScreen("reviews")} className="press fade-up w-full rounded-3xl bg-white p-4 text-left shadow-card ring-1 ring-slate-200/60 dark:bg-slate-800 dark:ring-slate-700/60" style={{ animationDelay: "245ms" }}>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl" style={{ background: alpha(NAVY, 14), color: NAVY }}><Info size={14} /></span>
            <p className="flex-1 text-[10px] font-extrabold uppercase tracking-widest" style={{ color: NAVY }}>From your lecturer</p>
            {newReviews > 0 && <span className="pop shrink-0 rounded-full bg-amber-400 px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-slate-900">{newReviews} new</span>}
          </div>
          <p className="mt-2 truncate text-[11px] font-bold text-slate-400 dark:text-slate-500">{latestReview.unit?.code ? `${latestReview.unit.code} · ` : ""}{fmtDate(latestReview.date)}{latestReview.staffName ? ` · ${latestReview.staffName}` : ""}</p>
          {latestReview.summary && <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-slate-600 dark:text-slate-300">{latestReview.summary}</p>}
          <p className="mt-1.5 flex items-center gap-1 text-[11px] font-bold" style={{ color: NAVY }}>Read your reviews <ChevronRight size={12} /></p>
        </button>
      )}

      {pending > 0 && (
        <button onClick={() => setScreen("assessments")} className="press fade-up flex w-full items-center gap-3 rounded-3xl bg-white p-3.5 text-left shadow-card ring-1 ring-slate-200/60 dark:bg-slate-800 dark:ring-slate-700/60" style={{ animationDelay: "265ms" }}>
          <span className="tone-soft flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl" style={toneVars(ACCENT_TONE.results)}><Award size={17} /></span>
          <span className="flex-1">
            <span className="block text-[13px] font-extrabold text-slate-700 dark:text-slate-200">{pending} assessment{pending === 1 ? "" : "s"} awaiting marks</span>
            <span className="block text-[11px] text-slate-400 dark:text-slate-500">{graded} of {totalAssess} marked so far</span>
          </span>
          <ChevronRight size={17} className="shrink-0 text-slate-300 dark:text-slate-600" />
        </button>
      )}

      <SectionTitle colour={ACCENT.attendance}>Quick actions</SectionTitle>
      <div className="grid grid-cols-2 gap-2.5">
        {/* Rendered in every state EXCEPT one: a college that has switched all three
            capture methods off. It used to be rendered unconditionally, because showing
            it only when a class was checkable left nobody able to tell "switched off"
            from "not built" — reported as missing twice, which is why the tile explains
            itself in every state rather than disappearing between classes. That still
            holds and has not changed; what changed is that a college with the feature
            OFF is not a state to explain here. It matches the bottom tab, which is the
            point — a Check In tile linking to a tab that no longer exists is worse than
            either choice made consistently. TabBar carries the full reasoning and names
            where the "switched off" answer still lives. */}
        {anyCheckInWay(tapContext) !== false && (
          <Action onClick={() => setScreen("checkin")} Icon={Nfc} label="Check In"
            sub={checkInSub(tapContext)} c={ACCENT.checkin} i={0} />
        )}
        <Action onClick={() => setScreen("attendance")} Icon={Percent} label="My Attendance" sub="By unit" c={ACCENT.attendance} i={1} />
        <Action onClick={() => setScreen("assessments")} Icon={Award} label="My Results" sub="Marks & grades" c={ACCENT.results} i={2} />
        <Action onClick={() => setScreen("timetable")} Icon={CalendarDays} label="My Timetable" sub="Weekly classes" c={ACCENT.timetable} i={3} />
        <Action onClick={() => setScreen("query")} Icon={MessageSquare} label="Ask the College" sub={newReplies ? `${newReplies} new repl${newReplies === 1 ? "y" : "ies"}` : "Send a query"} c={ACCENT.ask} badge={newReplies} i={4} />
        <Action onClick={() => setScreen("more")} Icon={Settings} label="More" sub="Account & settings" c={ACCENT.more} i={5} />
      </div>
    </div>
  );
}

export default Home;
