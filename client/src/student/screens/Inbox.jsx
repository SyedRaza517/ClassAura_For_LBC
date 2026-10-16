import { useEffect } from "react";
import { Bell, Info, CheckCircle2, AlertTriangle, XCircle, CheckCheck } from "lucide-react";
import { Screen, Card, Empty, toneFromColour, toneVars } from "../ui";
import { fmtDate, KNOWN_LINKS } from "../utils";

// One tone + icon per Notification.type (notify.js's own default is "info"; the
// other three are what routes/*.js actually sends — see the grep across
// assessments.js/referrals.js/studentQueries.js/studentReviews.js/timetabling.js/
// mitigations.js). Reusing hexes ui/tokens.js's ATT array already carries (Present's
// green, Late's orange, Absent's rose) rather than inventing a fifth palette here —
// they are already checked as colour-blind-separable, and a student who has learned
// "rose means something needs attention" on the Attendance screen gets the same
// reading here for free.
const NOTIF_TONE = {
  info: { ...toneFromColour("#2563eb"), Icon: Info },
  success: { ...toneFromColour("#059669"), Icon: CheckCircle2 },
  warning: { ...toneFromColour("#ea580c"), Icon: AlertTriangle },
  error: { ...toneFromColour("#e11d48"), Icon: XCircle },
};
const toneFor = (type) => NOTIF_TONE[type] || NOTIF_TONE.info;

// KNOWN_LINKS now lives in ../utils (moved so StudentApp.jsx's push:open listener can
// share it) — see that file's own comment for why this screen no longer defines it.

// "5m ago" / "3h ago" / "2d ago", falling back to a plain date beyond a week.
//
// THIS READS THE HOST CLOCK, and that is not the "never use the host clock" rule
// conventions.md means (that rule is about which CALENDAR DAY it is "today" for a
// date-string comparison — attendance dates, term dates — where a host in the wrong
// timezone silently reinterprets a stored day). `createdAt` is a real instant, not a
// date string, and "how long ago did this fire" is inescapably relative to the
// reader's own clock — there is no server-side answer to hand back that would not
// go stale the moment it was computed. Kept local to this screen rather than
// utils.js: nothing else in the student app shows elapsed time, only calendar dates.
function timeAgo(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return fmtDate(String(iso).slice(0, 10));
}

function NotifRow({ n, onOpen }) {
  const tone = toneFor(n.type);
  const Icon = tone.Icon;
  return (
    <button
      onClick={() => onOpen(n)}
      className="press flex w-full items-start gap-3 border-t border-slate-100 px-3.5 py-3.5 text-left first:border-t-0 dark:border-slate-700"
    >
      <span className="tone-soft mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={toneVars(tone)}>
        <Icon size={16} />
      </span>
      <span className="min-w-0 flex-1">
        {/* Unread emphasis is weight + a dot, never colour alone (the same rule the
            ATT status letters follow) — a type's own tone already uses colour for
            something else on this row. */}
        <span className="flex items-start gap-1.5">
          {!n.read && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />}
          {/* min-w-0 + break-words. `n.message` is written by whichever route fired the
              notification, not by this screen, and those messages routinely quote an
              identifier a browser will not break on its own — a unit code, an
              assessment title, a date range joined by dashes. This span is a flex item
              inside the row's unread-dot layout, so until now its `min-width: auto`
              meant an unbreakable token sized the row and pushed the whole inbox wider
              than the phone. Breaking mid-token is the right trade for a list whose job
              is to be scanned: a clipped message cannot be read at all. */}
          <span className={`block min-w-0 break-words text-[13px] leading-snug ${n.read ? "font-semibold text-slate-500 dark:text-slate-400" : "font-extrabold text-slate-800 dark:text-slate-100"}`}>
            {n.message}
          </span>
        </span>
        <span className="mt-1 block text-[11px] text-slate-400 dark:text-slate-500">{timeAgo(n.createdAt)}</span>
      </span>
    </button>
  );
}

/**
 * The notification inbox — reached from the Header bell, never a bottom tab (six
 * already fills the bar; see StudentApp.jsx's own TABS comment on that arithmetic).
 *
 * `onOpen(n)`: MARK-READ ON OPEN, per notification. Opening a specific message is
 * treated as having read that one, mirroring an email inbox — the separate "Mark all
 * read" button below is the bulk action for "I've seen everything without opening
 * each one", which is a genuinely different intent and would be redundant if simply
 * viewing this LIST already cleared every badge (a student scrolling past unread
 * items to find one they care about should not lose the others' unread markers along
 * the way).
 */
export function InboxScreen({ notifications = [], unread = 0, refreshInbox, markRead, markAllRead, setScreen }) {
  // Targeted refetch on open — this screen's own answer to "did anything arrive since
  // the shell's last load()", the same reason Home.jsx refetches on its own mount
  // rather than trusting a load that may be minutes old.
  useEffect(() => { refreshInbox?.(); }, [refreshInbox]);

  const onOpen = (n) => {
    if (!n.read) markRead?.([n.id]);
    if (n.link && KNOWN_LINKS.has(n.link)) setScreen(n.link);
  };

  return (
    <Screen>
      <div className="flex items-center justify-between px-1">
        <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
          {unread > 0 ? `${unread} unread` : "All caught up"}
        </p>
        {unread > 0 && (
          <button onClick={() => markAllRead?.()} className="press flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1.5 text-[11px] font-bold text-slate-600 dark:bg-slate-700 dark:text-slate-300">
            <CheckCheck size={13} /> Mark all read
          </button>
        )}
      </div>

      <Card className="!p-0 overflow-hidden">
        {notifications.map((n) => <NotifRow key={n.id} n={n} onOpen={onOpen} />)}
        {notifications.length === 0 && (
          <Empty icon={Bell} title="Nothing here yet" msg="Replies, released marks, timetable changes and updates from the college will show up here." />
        )}
      </Card>
    </Screen>
  );
}

export default InboxScreen;
