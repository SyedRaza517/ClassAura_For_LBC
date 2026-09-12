import { Info, CalendarCheck } from "lucide-react";
import { Screen, LoadingScreen, ErrBox, SectionTitle, Card, Empty } from "../ui";
import { progressTone, toneVars } from "../ui/tokens";
import { fmtDate } from "../utils";
import { NAVY, NAVY_DARK } from "../../branding";

// The section keeps the brand navy rather than taking a fifth ACCENT: the only colour
// that should carry meaning on this screen is the progress band itself, and a coloured
// section rule beside an "At Risk" chip reads as a second, competing verdict.
export function ReviewsScreen({ reviews, busy, err, bands }) {
  // This screen's OWN data decides what it shows, as on attendance and results — a
  // failure in one of the other three calls must not blank it.
  if (!reviews) return busy ? <LoadingScreen /> : <Screen><ErrBox>{err || "Could not load your reviews."}</ErrBox></Screen>;

  return (
    <Screen>
      <p className="px-1 text-[12px] leading-relaxed text-slate-500 dark:text-slate-400">
        When you have a progress conversation with a lecturer, they write up what was discussed and what you both agreed. If anything here doesn't look right, ask the college.
      </p>

      {reviews.length === 0 ? (
        <Card className="!p-0"><Empty icon={Info} title="No reviews yet" msg="A lecturer's write-up of a progress conversation with you will appear here." /></Card>
      ) : (
        <>
          <SectionTitle>Your reviews · {reviews.length}</SectionTitle>
          {/* Stagger caps at the seventh card, so a long list doesn't leave the last
              rows waiting seconds to appear. */}
          {reviews.map((r, i) => <ReviewCard key={r.id} r={r} i={Math.min(i, 6)} bands={bands} />)}
        </>
      )}
    </Screen>
  );
}

function ReviewCard({ r, i, bands }) {
  // progressTone is rebuilt on the SAME attendance ladder rather than its own three
  // colours (see ui/tokens.js's file-level comment) — "On Track"/"Monitor"/"At Risk"
  // borrows the best/middle/worst band's colour from the college's own list by rank.
  const t = progressTone(r.progress, bands);
  const concerns = Array.isArray(r.concerns) ? r.concerns : [];
  return (
    <Card i={i} className="!p-3.5">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-8 w-12 shrink-0 items-center justify-center rounded-xl text-[10px] font-extrabold text-white" style={{ background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` }}>{(r.unit?.code || "—").slice(0, 5)}</span>
        <div className="min-w-0 flex-1">
          {/* The unit can be null — a unit may be reorganised away long after the
              conversation happened, and the record outlives it. */}
          <p className="text-[13px] font-extrabold leading-tight text-slate-700 dark:text-slate-200">{r.unit?.name || "General progress review"}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-slate-400 dark:text-slate-500">{fmtDate(r.date) || "—"}{r.staffName ? ` · ${r.staffName}` : ""}</p>
        </div>
        {r.progress && <span className="tone-soft shrink-0 whitespace-nowrap rounded-xl px-2.5 py-1.5 text-[11px] font-extrabold ring-1" style={toneVars(t)}>{r.progress}</span>}
      </div>

      {concerns.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {concerns.map(c => (
            <span key={c} className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${c === "No Concerns" ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800" : "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300"}`}>{c}</span>
          ))}
        </div>
      )}

      {r.summary ? <ReviewText label="Summary of discussion" text={r.summary} /> : null}
      {r.agreedActions ? <ReviewText label="Agreed actions" text={r.agreedActions} /> : null}

      {r.followUp && (
        <p className="mt-2.5 flex items-center gap-1.5 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-700 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800">
          <CalendarCheck size={13} className="shrink-0" />
          {r.followUpDate ? `Follow-up on ${fmtDate(r.followUpDate)}` : "A follow-up was agreed"}
        </p>
      )}
    </Card>
  );
}

// Free text exactly as the lecturer typed it: line breaks kept, and long words broken
// rather than pushing the card wider than the phone.
function ReviewText({ label, text }) {
  return (
    <div className="mt-2.5 rounded-xl bg-slate-50 px-3 py-2.5 dark:bg-slate-700/60">
      <p className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400 dark:text-slate-500">{label}</p>
      <p className="mt-1 whitespace-pre-line break-words text-[12px] leading-relaxed text-slate-600 dark:text-slate-300">{text}</p>
    </div>
  );
}

export default ReviewsScreen;
