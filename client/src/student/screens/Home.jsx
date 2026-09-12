import {
  Percent, Award, MessageSquare, ChevronRight, Info, Settings, Sparkles,
  CheckCircle2, Clock3, CalendarCheck, CalendarDays, Nfc,
} from "lucide-react";
import { Screen, ErrBox, LoadingScreen, SectionTitle, Stat, Action, HeroTile } from "../ui";
import { ACCENT, pctTone, gradeTone } from "../ui/tokens";
import { fmtDate } from "../utils";
import { NAVY } from "../../branding";
import { StudentCheckIn, anyCheckInWay, checkInSub } from "./CheckIn";

export function Home({ user, attendance, results, queries, reviews, tapContext, busy, err, reload, setScreen, newReplies, newReviews }) {
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

  // One clear message about where they stand, in words rather than numbers.
  const band = attPct == null ? null : attPct >= 85 ? { t: "Excellent attendance — keep it up.", c: "#059669" }
    : attPct >= 70 ? { t: "Good, but there's room to improve.", c: "#d97706" }
      : { t: "Your attendance needs attention.", c: "#e11d48" };

  const attTone = pctTone(attPct);
  const avgTone = gradeTone(avgPct);

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
        <div className="fade-up flex items-center gap-2.5 rounded-2xl px-3.5 py-3 ring-1" style={{ background: band.c + "12", "--tw-ring-color": band.c + "33", animationDelay: "110ms" }}>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl" style={{ background: band.c + "1f" }}><Sparkles size={14} style={{ color: band.c }} /></span>
          <p className="text-[12px] font-bold leading-snug" style={{ color: band.c }}>{band.t}</p>
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
        <button onClick={() => setScreen("query")} className="press fade-up w-full rounded-3xl bg-white p-4 text-left shadow-card ring-1 ring-slate-200/60" style={{ animationDelay: "220ms" }}>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-xl" style={{ background: ACCENT.ask + "14" }}><MessageSquare size={14} style={{ color: ACCENT.ask }} /></span>
            <p className="flex-1 text-[10px] font-extrabold uppercase tracking-widest" style={{ color: ACCENT.ask }}>Reply from the college</p>
            {newReplies > 0 && <span className="pop rounded-full bg-amber-400 px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-slate-900">new</span>}
          </div>
          <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-slate-600">{latestReply.response}</p>
          <p className="mt-1.5 flex items-center gap-1 text-[11px] font-bold" style={{ color: ACCENT.ask }}>Read the conversation <ChevronRight size={12} /></p>
        </button>
      )}

      {/* A lecturer's review, surfaced the same way a college reply is. It carries the
          summary rather than the progress band: the band belongs on the screen that
          also gives it the context of what was discussed and agreed. */}
      {latestReview && (
        <button onClick={() => setScreen("reviews")} className="press fade-up w-full rounded-3xl bg-white p-4 text-left shadow-card ring-1 ring-slate-200/60" style={{ animationDelay: "245ms" }}>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl" style={{ background: NAVY + "14" }}><Info size={14} style={{ color: NAVY }} /></span>
            <p className="flex-1 text-[10px] font-extrabold uppercase tracking-widest" style={{ color: NAVY }}>From your lecturer</p>
            {newReviews > 0 && <span className="pop shrink-0 rounded-full bg-amber-400 px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-slate-900">{newReviews} new</span>}
          </div>
          <p className="mt-2 truncate text-[11px] font-bold text-slate-400">{latestReview.unit?.code ? `${latestReview.unit.code} · ` : ""}{fmtDate(latestReview.date)}{latestReview.staffName ? ` · ${latestReview.staffName}` : ""}</p>
          {latestReview.summary && <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-slate-600">{latestReview.summary}</p>}
          <p className="mt-1.5 flex items-center gap-1 text-[11px] font-bold" style={{ color: NAVY }}>Read your reviews <ChevronRight size={12} /></p>
        </button>
      )}

      {pending > 0 && (
        <button onClick={() => setScreen("assessments")} className="press fade-up flex w-full items-center gap-3 rounded-3xl bg-white p-3.5 text-left shadow-card ring-1 ring-slate-200/60" style={{ animationDelay: "265ms" }}>
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl" style={{ background: ACCENT.results + "14" }}><Award size={17} style={{ color: ACCENT.results }} /></span>
          <span className="flex-1">
            <span className="block text-[13px] font-extrabold text-slate-700">{pending} assessment{pending === 1 ? "" : "s"} awaiting marks</span>
            <span className="block text-[11px] text-slate-400">{graded} of {totalAssess} marked so far</span>
          </span>
          <ChevronRight size={17} className="shrink-0 text-slate-300" />
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
