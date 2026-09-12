import { useEffect, useState } from "react";
import {
  HeartPulse, Info, AlertTriangle, Send, Loader2, ClipboardList,
} from "lucide-react";
import { Screen, Card, SectionTitle, Empty, LoadingScreen, ErrBox } from "../ui";
import { api } from "../../api";
import { fmtDate } from "../utils";
import { NAVY, MAROON } from "../../branding";

/*
 * Raising and tracking a mitigating circumstances claim — the student's own half of
 * the feature `server/src/routes/mitigations.js` describes at length.
 *
 * WHY THIS SCREEN EXISTS. Until now the only way onto MitigatingCircumstance was a
 * member of staff typing up what a student told them, in person or on the phone. A
 * student who already knows the dates — an operation, a bereavement, a caring spell —
 * had to wait for that conversation to happen before anything was on record, even
 * though they are the one person who does not need to be told what happened to them.
 *
 * WHAT THIS SCREEN NEVER SHOWS, AND WHY THAT SURVIVES EVEN ON A STUDENT'S OWN CLAIM.
 * `decisionNote` is "shown to staff" by the model's own comment — it is a member of
 * staff's account of the decision, written for colleagues, not for the student it is
 * about. `decidedBy` and the adjustment rows (which assessment was extended, by how
 * much) are administrative detail about HOW the college actioned a claim, not part of
 * telling the student WHAT was decided. The server's allowlist enforces all of this;
 * this screen simply never has the fields to draw even if it tried.
 *
 * THE CATEGORY LIST IS A LITERAL COPY of MIT_CATEGORIES in StaffHub.jsx (itself a
 * copy of CATEGORIES in routes/mitigations.js). Not imported — the staff client and
 * the student app are two separate bundles with no shared import path between them —
 * but kept to the exact same nine values and the same slug-to-words label function,
 * because a student choosing "financial" must land in the identical bucket a member
 * of staff would have filed the same claim under.
 */
const MIT_CATEGORIES = [
  "illness", "mental-health", "bereavement", "caring", "financial",
  "accident", "victim-of-crime", "pregnancy-maternity", "other",
];
const mitLabel = (s) => (s || "").replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

const MIT_STATUS = {
  open: { label: "Awaiting a decision", cls: "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800" },
  approved: { label: "Approved", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800" },
  rejected: { label: "Not approved", cls: "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-800" },
  withdrawn: { label: "Withdrawn", cls: "bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:ring-slate-600" },
};

export function MitigationsScreen() {
  // Self-contained, like SupportThread's own load() a screen over: this is the one
  // screen in the app whose data the central shell load() does not fetch, so a
  // college running an older build (before this endpoint existed) shows every OTHER
  // screen exactly as before and only this one degrades — rather than one failed
  // fetch here adding to the shared error banner across attendance, results and
  // messages, which is what folding it into Promise.allSettled up in StudentApp.jsx
  // would have risked.
  const [claims, setClaims] = useState(null); // null = not loaded yet, [] = loaded, none
  const [loadErr, setLoadErr] = useState("");
  const [busy, setBusy] = useState(true);
  const [open, setOpen] = useState(false); // the "raise a claim" form panel

  const load = () => {
    setBusy(true); setLoadErr("");
    api.studentMitigations()
      .then((r) => setClaims(Array.isArray(r?.claims) ? r.claims : []))
      .catch((e) => setLoadErr(e.message || "Could not load your claims."))
      .finally(() => setBusy(false));
  };
  useEffect(() => { load(); }, []);

  if (claims === null) return busy ? <LoadingScreen /> : <Screen><ErrBox>{loadErr || "Could not load your claims."}</ErrBox></Screen>;

  return (
    <Screen>
      <p className="px-1 text-[12px] leading-relaxed text-slate-500 dark:text-slate-400">
        If something outside your control — illness, bereavement, a caring responsibility, an accident —
        is affecting your attendance or your ability to submit work, tell the college here. A decision
        is recorded against the dates you give, and you can see where it's got to below.
      </p>

      {!open ? (
        <button onClick={() => setOpen(true)}
          className="press flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-bold text-white shadow-lg"
          style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}>
          <HeartPulse size={16} /> Tell the college
        </button>
      ) : (
        <MitigationForm
          onCancel={() => setOpen(false)}
          onSent={() => { setOpen(false); load(); }}
        />
      )}

      <SectionTitle>Your claims{claims.length ? ` · ${claims.length}` : ""}</SectionTitle>
      {claims.length === 0 ? (
        <Card className="!p-0">
          <Empty icon={ClipboardList} title="Nothing on record"
            msg="Anything you tell the college here — and anything raised for you and decided — will appear on this list." />
        </Card>
      ) : (
        claims.map((c, i) => <ClaimCard key={c.id} c={c} i={Math.min(i, 6)} />)
      )}

      {/* NOT A PROMISE THE FORM ABOVE CAN KEEP — evidence (a doctor's note, a death
          certificate) is a separate, sometimes sensitive document, and this screen has
          no upload of its own. Said plainly, once, rather than implied by an upload
          field that does not exist. */}
      <Card className="!bg-blue-50/70 !ring-blue-100 dark:!bg-blue-950/30 dark:!ring-blue-900">
        <p className="flex items-start gap-2 text-[11px] leading-relaxed text-blue-800 dark:text-blue-300">
          <Info size={13} className="mt-px shrink-0" />
          Only staff with access to mitigating circumstances can see the category and details you give here —
          it isn't shown to your tutor or on your general record. The college may ask you separately for
          evidence to support what you've told them.
        </p>
      </Card>
    </Screen>
  );
}

function ClaimCard({ c, i }) {
  const st = MIT_STATUS[c.status] || MIT_STATUS.open;
  return (
    <Card i={i}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-extrabold text-slate-800 dark:text-slate-100">
            {c.category ? mitLabel(c.category) : "Circumstance"}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
            {fmtDate(c.coversFrom)} – {fmtDate(c.coversTo)}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold ring-1 ${st.cls}`}>{st.label}</span>
      </div>
      {c.coversAttendance && (
        <p className="mt-2 text-[11px] font-semibold text-slate-500 dark:text-slate-400">Also covers attendance</p>
      )}
      <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
        Raised {fmtDate(c.raisedOn)}
        {c.decidedOn ? ` · Decided ${fmtDate(c.decidedOn)}` : ""}
      </p>
    </Card>
  );
}

/*
 * The form. Dates, an optional category, the student's own account, and the
 * attendance opt-in — the exact fields the interface in the brief names, in that
 * order, because that is the order a person actually thinks about a claim: when it
 * covers, what kind, what happened, and only then the narrower question of whether it
 * should also excuse being marked in.
 */
function MitigationForm({ onCancel, onSent }) {
  const [coversFrom, setCoversFrom] = useState("");
  const [coversTo, setCoversTo] = useState("");
  const [category, setCategory] = useState("");
  const [detail, setDetail] = useState("");
  const [coversAttendance, setCoversAttendance] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Client-side gate only — the server is the actual authority on every one of these
  // (the real-date check, the ordering check, the college's own window cap), and its
  // 400/409 messages are shown back verbatim in `err` rather than re-derived here.
  // `detail.trim().length >= 3` is not enforced server-side (the column defaults to
  // ""), the same permissive choice the STAFF form makes — a claim can be actioned
  // from a conversation alone. This form asks for a little more because nobody is
  // standing in the room to ask a follow-up question the way a member of staff can.
  const valid = !!coversFrom && !!coversTo && detail.trim().length >= 3;

  const submit = async () => {
    if (!valid) return;
    setBusy(true); setErr("");
    try {
      await api.addStudentMitigation({
        coversFrom, coversTo,
        category: category || undefined,
        detail: detail.trim(),
        coversAttendance,
      });
      onSent();
    } catch (e) {
      // A 409 here names the claim already open for an overlapping window — the
      // server's own words are more useful than anything this screen could invent,
      // so they are shown as-is, the same choice Support.jsx makes for its own 409.
      setErr(e.message || "Could not send your claim.");
    } finally { setBusy(false); }
  };

  return (
    <Card>
      <p className="text-sm font-extrabold text-slate-800 dark:text-slate-100">Tell the college</p>
      <p className="mt-1 text-[12px] leading-relaxed text-slate-500 dark:text-slate-400">
        This goes to staff who handle mitigating circumstances. They'll get back to you with a decision.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">Covers from</label>
          {/* text-base (16px) on every field in this form, not text-sm (14px) — iOS
              Safari zooms the whole page in on focus of any input under 16px, and a
              student filling this in one-handed does not want the viewport jumping
              on every field of a form about something already stressful. */}
          <input type="date" value={coversFrom} onChange={(e) => setCoversFrom(e.target.value)} disabled={busy}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-base text-slate-800 outline-none focus:ring-2 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            style={{ "--tw-ring-color": NAVY }} />
        </div>
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">Covers to</label>
          <input type="date" value={coversTo} onChange={(e) => setCoversTo(e.target.value)} disabled={busy}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-base text-slate-800 outline-none focus:ring-2 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            style={{ "--tw-ring-color": NAVY }} />
        </div>
      </div>
      <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
        A single day is fine — use the same date for both. There's a limit to how long one claim can
        cover; if yours needs longer, the college will tell you when you send it.
      </p>

      <div className="mt-3">
        <label className="text-[11px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">Category (optional)</label>
        <select value={category} onChange={(e) => setCategory(e.target.value)} disabled={busy}
          className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-base text-slate-800 outline-none focus:ring-2 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
          style={{ "--tw-ring-color": NAVY }}>
          <option value="">Prefer not to say</option>
          {MIT_CATEGORIES.map((c) => <option key={c} value={c}>{mitLabel(c)}</option>)}
        </select>
      </div>

      <div className="mt-3">
        <label className="text-[11px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">What happened</label>
        <textarea value={detail} onChange={(e) => setDetail(e.target.value)} disabled={busy} rows={5}
          placeholder="In your own words — as much as you're comfortable sharing."
          className="mt-1 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-base text-slate-800 outline-none focus:ring-2 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
          style={{ "--tw-ring-color": NAVY }} />
      </div>

      {/* OPT-IN, NEVER IMPLIED BY THE CATEGORY — matching the schema's own comment on
          coversAttendance exactly, restated for a student rather than an
          administrator: covered sessions leave the percentage on BOTH sides, but the
          dates the college watches for a pattern, and any conversation a tutor might
          have, keep happening regardless. Ticking this is not a way to go quiet. */}
      <label className="mt-3 flex items-start gap-2.5 rounded-xl bg-slate-50 p-3 dark:bg-slate-700/40">
        <input type="checkbox" checked={coversAttendance} onChange={(e) => setCoversAttendance(e.target.checked)} disabled={busy}
          className="mt-0.5 h-4 w-4 shrink-0 rounded" style={{ accentColor: NAVY }} />
        <span className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">
          <span className="block font-bold text-slate-700 dark:text-slate-200">Also cover my attendance for these dates</span>
          If approved, classes in this window won't count against your attendance percentage either way —
          not attending them, and not being there. This is separate from covering coursework deadlines,
          and it's your choice whether to tick it: the college will still expect to hear from you
          during this time, just not mark you down for it.
        </span>
      </label>

      {err && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600 dark:bg-rose-950/40 dark:text-rose-300">{err}</p>}

      <div className="mt-4 flex gap-2">
        <button onClick={onCancel} disabled={busy} className="press flex-1 rounded-xl bg-slate-100 py-3 text-sm font-bold text-slate-500 dark:bg-slate-700 dark:text-slate-300">Cancel</button>
        <button onClick={submit} disabled={busy || !valid}
          className="press flex flex-[2] items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold text-white shadow disabled:opacity-50"
          style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}>
          {busy ? <><Loader2 size={15} className="animate-spin" /> Sending…</> : <><Send size={15} /> Send</>}
        </button>
      </div>

      <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-relaxed text-slate-400 dark:text-slate-500">
        <AlertTriangle size={11} className="mt-px shrink-0" />
        This isn't checked in real time. If you need urgent support, use Support in the More tab instead.
      </p>
    </Card>
  );
}

// Exported for parity with every other screen in this app (SupportScreen, QueryScreen
// all export both named and default) — StudentApp.jsx imports the default.
export default MitigationsScreen;
