import { useState, useEffect } from "react";
import {
  HeartHandshake, Info, AlertTriangle, CheckCircle2, Send, Loader2, ChevronLeft, MessageSquare,
} from "lucide-react";
import { Screen, Card, SectionTitle, Empty, LoadingScreen, ErrBox } from "../ui";
import { api } from "../../api";
import { NAVY, MAROON } from "../../branding";

/*
 * What the student is told about being handed to Wellbeing, ASK or Student Support.
 *
 * THIS SCREEN IS DEFINED BY WHAT IT CANNOT SHOW, IN TWO DIFFERENT WAYS.
 *
 * First, WHICH referrals: only those the referrer ticked "tell the student" on. That
 * filter is a WHERE clause on the server, not a decision here — the tickbox defaults
 * off so a tutor raising a safeguarding concern does not have to remember to suppress
 * anything, and a screen that listed everything would defeat it completely.
 *
 * Second, HOW MUCH of one: the team, the dates, and where it got to. Never the tutor's
 * reason, which is their account of this student written for somebody else, and never
 * the department's case notes, which even the tutor cannot read.
 *
 * So the empty state must not say "you have never been referred" — it is also what a
 * student sees when they were referred and not told, and a portal that let them infer
 * the difference would leak the fact it exists to withhold.
 */

const REF_STATUS = {
  open: { label: "Waiting to be picked up", cls: "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800" },
  accepted: { label: "Being worked on", cls: "bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-800" },
  closed: { label: "Closed", cls: "bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:ring-slate-600" },
};

// The outcome CODE in the student's own terms. Codes, never the server's prose — the
// free text written at closure is department-only, and a label list here cannot
// accidentally carry it. An unknown code falls back to "Closed" rather than rendering
// a slug at somebody about their own wellbeing referral.
const REF_OUTCOME = {
  supported: "The team worked with you",
  referred_on: "Passed on to someone else",
  no_response: "The team could not reach you",
  not_appropriate: "Not something this team could help with",
  other: "Closed",
};

export function SupportScreen({ referrals, busy, departments, reload }) {
  // Three states on one screen rather than three screens: the list, the form, and one
  // request's thread. A student arriving here is either checking on something or asking
  // for something, and a separate tab for each would put the form behind a tap nobody
  // makes when they are struggling.
  const [mode, setMode] = useState("list");
  const [openRef, setOpenRef] = useState(null);

  if (mode === "form") {
    return (
      <SupportRequestForm
        departments={departments || []}
        onCancel={() => setMode("list")}
        onSent={() => { setMode("list"); reload && reload(); }}
      />
    );
  }
  if (mode === "thread" && openRef) {
    // Re-read from the freshest list, so a status that changed while the thread was open
    // is not rendered from a stale copy.
    const live = (referrals || []).find((r) => r.id === openRef.id) || openRef;
    return <SupportThread referral={live} onClose={() => { setMode("list"); setOpenRef(null); reload && reload(); }} />;
  }
  return (
    <SupportList
      referrals={referrals} busy={busy} departments={departments}
      onNew={() => setMode("form")}
      onOpen={(r) => { setOpenRef(r); setMode("thread"); }}
    />
  );
}

function SupportList({ referrals, busy, departments, onNew, onOpen }) {
  if (referrals === null) return busy ? <LoadingScreen /> : (
    <Screen><ErrBox>Could not load your support referrals.</ErrBox></Screen>
  );

  return (
    <Screen>
      {/* The way IN, above the list, because that is what somebody has come to do. Shown
          only when the college actually runs a support desk — a button that opens a form
          with no teams on it is worse than no button. */}
      {(departments || []).length > 0 && (
        <button onClick={onNew}
          className="press flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-bold text-white shadow-lg"
          style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}>
          <HeartHandshake size={16} /> Ask for support
        </button>
      )}

      {referrals.length === 0 ? (
        <Card className="!p-0">
          <Empty
            icon={HeartHandshake}
            title="Nothing to show"
            msg="Ask a support team for help using the button above. Anything a tutor refers you for, and tells you about, appears here too."
          />
        </Card>
      ) : (
        <>
          <SectionTitle>Support referrals · {referrals.length}</SectionTitle>
          {referrals.map((r, i) => {
            const st = REF_STATUS[r.status] || REF_STATUS.closed;
            const mine = r.selfReferred === true;
            const Row = mine ? "button" : "div";
            return (
              <Card key={r.id} i={Math.min(i, 6)}>
                <Row {...(mine ? { onClick: () => onOpen(r), className: "w-full text-left" } : {})}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    {/* The NAME, resolved by the server. A slug is what the database
                        stores and is not something to show anybody about themselves. */}
                    <p className="text-sm font-extrabold text-slate-800 dark:text-slate-100">{r.departmentName}</p>
                    <p className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">Referred {r.raisedOn}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold ring-1 ${st.cls}`}>{st.label}</span>
                </div>
                {/* Their own words, read back — present only on a request they made. */}
                {mine && r.reason && (
                  <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-slate-600 dark:text-slate-300">{r.reason}</p>
                )}
                <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                  {mine ? "You asked for this" : "Your tutor referred you"}
                  {mine && r.status !== "closed" ? " · tap to add to it" : ""}
                </p>
                {r.status === "closed" && (
                  <p className="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-[12px] font-semibold text-slate-600 ring-1 ring-slate-100 dark:bg-slate-700/60 dark:text-slate-300 dark:ring-slate-600">
                    {REF_OUTCOME[r.outcome] || "Closed"}
                    {r.closedOn ? <span className="ml-1 font-normal text-slate-400 dark:text-slate-500">· {r.closedOn}</span> : null}
                  </p>
                )}
                </Row>
              </Card>
            );
          })}
        </>
      )}

      <Card className="!bg-blue-50/70 !ring-blue-100 dark:!bg-blue-950/30 dark:!ring-blue-900">
        <p className="flex items-start gap-2 text-[11px] leading-relaxed text-blue-800 dark:text-blue-300">
          <Info size={13} className="mt-px shrink-0" />
          This shows which team you were referred to and where it got to. What you talk to that team about
          stays between you and them — it is not shown here and it is not shown to your tutor.
        </p>
      </Card>
    </Screen>
  );
}

/*
 * Asking a support team for help — the Wellbeing and ASK forms.
 *
 * ONE FORM PER TEAM, GENERATED FROM THE COLLEGE'S OWN LIST, not two components with
 * "Wellbeing" and "ASK" typed into them. The department list is configuration an
 * administrator edits at runtime; a college that renames ASK, or runs Wellbeing and
 * Student Support as one desk, gets its own words with no code change — and a hardcoded
 * pair would quietly stop matching the queues these requests land in.
 *
 * WHAT THE STUDENT IS TOLD, AND WHY EACH SENTENCE IS THERE. Somebody opening a wellbeing
 * form is often not in a state to read carefully, so the screen answers the three
 * questions they actually have, in the order they have them: who reads this, what
 * happens next, and what to do if it is an emergency. The last one is not a legal
 * disclaimer — a support queue worked in office hours is the wrong place for a crisis,
 * and saying so plainly is safer than a form that implies somebody is watching it now.
 */
function SupportRequestForm({ departments, onSent, onCancel }) {
  const [dept, setDept] = useState("");
  const [reason, setReason] = useState("");
  const [urgent, setUrgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const chosen = departments.find((d) => d.key === dept);
  const valid = !!dept && reason.trim().length >= 3;

  const send = async () => {
    if (!valid) return;
    setBusy(true); setErr("");
    try {
      await api.sendStudentReferral({ department: dept, reason: reason.trim(), urgency: urgent ? "urgent" : "routine" });
      onSent();
    } catch (e) {
      // A 409 is not a fault — it means an earlier request to the same team is still
      // open. The server's own words say so and name the team, which is more use than
      // anything this screen could invent.
      setErr(e.message || "Could not send your request.");
    } finally { setBusy(false); }
  };

  return (
    <Screen>
      <Card>
        <p className="text-sm font-extrabold text-slate-800 dark:text-slate-100">Ask for support</p>
        <p className="mt-1 text-[12px] leading-relaxed text-slate-500 dark:text-slate-400">
          Your request goes straight to the team you choose. They will pick it up and get in touch —
          you can see where it has got to on this screen at any time.
        </p>

        <div className="mt-3">
          <label className="text-[11px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">Which team</label>
          <div className="mt-1.5 space-y-2">
            {departments.map((d) => (
              <button
                key={d.key}
                onClick={() => setDept(d.key)}
                className={`press flex w-full items-center gap-2.5 rounded-xl px-3 py-3 text-left ring-1 transition ${dept === d.key ? "bg-blue-50 ring-blue-300 dark:bg-blue-950/30 dark:ring-blue-700" : "bg-white ring-slate-200 dark:bg-slate-800 dark:ring-slate-700"}`}
              >
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-1 ${dept === d.key ? "ring-transparent" : "ring-slate-300 dark:ring-slate-600"}`} style={dept === d.key ? { background: NAVY } : {}}>
                  {dept === d.key && <CheckCircle2 size={13} className="text-white" />}
                </span>
                <span className="text-sm font-bold text-slate-700 dark:text-slate-200">{d.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3">
          <label className="text-[11px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">What do you need help with?</label>
          <textarea
            value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} rows={6}
            placeholder="In your own words. As much or as little as you want to say."
            className="mt-1 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:ring-2 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            style={{ "--tw-ring-color": NAVY }}
          />
          {/* Said explicitly, because the difference between this and the case notes is
              invisible from here: what they write IS shown back to them, and it is the
              one field both sides of a referral can read. */}
          <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
            {chosen ? `Only ${chosen.name} will see this.` : "Only the team you choose will see this."} You can read it back here afterwards.
          </p>
        </div>

        <button
          onClick={() => setUrgent((v) => !v)} disabled={busy}
          className={`press mt-3 flex w-full items-center gap-2.5 rounded-xl px-3 py-3 text-left ring-1 transition ${urgent ? "bg-rose-50 ring-rose-300 dark:bg-rose-950/30 dark:ring-rose-700" : "bg-white ring-slate-200 dark:bg-slate-800 dark:ring-slate-700"}`}
        >
          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ring-1 ${urgent ? "ring-transparent" : "ring-slate-300 dark:ring-slate-600"}`} style={urgent ? { background: "#e11d48" } : {}}>
            {urgent && <CheckCircle2 size={13} className="text-white" />}
          </span>
          <span>
            <span className="block text-sm font-bold text-slate-700 dark:text-slate-200">This is urgent</span>
            <span className="block text-[11px] text-slate-400 dark:text-slate-500">Moves it to the top of their list.</span>
          </span>
        </button>

        {err && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600 dark:bg-rose-950/40 dark:text-rose-300">{err}</p>}

        <div className="mt-4 flex gap-2">
          <button onClick={onCancel} disabled={busy} className="press flex-1 rounded-xl bg-slate-100 py-3 text-sm font-bold text-slate-500 dark:bg-slate-700 dark:text-slate-300">Cancel</button>
          <button
            onClick={send} disabled={busy || !valid}
            className="press flex flex-[2] items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold text-white shadow disabled:opacity-50"
            style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}
          >
            {busy ? <><Loader2 size={15} className="animate-spin" /> Sending…</> : <><Send size={15} /> Send request</>}
          </button>
        </div>
      </Card>

      {/* NOT a legal disclaimer. A queue worked in office hours is the wrong place for a
          crisis, and a form that stays silent about that implies somebody is watching it
          right now. Last on the screen, so it is the thing still in view after they
          send. */}
      <Card className="!bg-amber-50/70 !ring-amber-200 dark:!bg-amber-950/30 dark:!ring-amber-800">
        <p className="flex items-start gap-2 text-[11px] leading-relaxed text-amber-900 dark:text-amber-200">
          <AlertTriangle size={13} className="mt-px shrink-0 text-amber-600 dark:text-amber-400" />
          <span>
            <b>If you need help right now</b>, do not wait for a reply here — this is checked during college
            hours. Contact the college directly, call <b>111</b>, or in an emergency call <b>999</b>.
          </span>
        </p>
      </Card>
    </Screen>
  );
}

/* The conversation on a request the student raised themselves. */
function SupportThread({ referral, onClose }) {
  const [messages, setMessages] = useState(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = () => api.studentReferralMessages(referral.id).then(setMessages).catch(() => setMessages([]));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [referral.id]);

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true); setErr("");
    try { await api.addStudentReferralMessage(referral.id, body); setDraft(""); await load(); }
    catch (e) { setErr(e.message || "Could not send."); }
    finally { setBusy(false); }
  };

  return (
    <Screen>
      <button onClick={onClose} className="press flex items-center gap-1 text-[12px] font-bold text-slate-500 dark:text-slate-400">
        <ChevronLeft size={14} /> Back
      </button>

      <Card>
        <p className="text-sm font-extrabold text-slate-800 dark:text-slate-100">{referral.departmentName}</p>
        <p className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">You asked on {referral.raisedOn}</p>
        {/* Their own words, read back. sReferralForStudent sends `reason` only on a
            self-referral — on a tutor's referral it is that tutor's account of them and
            never crosses. */}
        {referral.reason && (
          <p className="mt-2 whitespace-pre-wrap rounded-xl bg-slate-50 px-3 py-2 text-[12px] leading-relaxed text-slate-600 ring-1 ring-slate-100 dark:bg-slate-700/60 dark:text-slate-300 dark:ring-slate-600">{referral.reason}</p>
        )}
      </Card>

      {messages === null && <Card><div className="flex justify-center py-6"><Loader2 size={20} className="animate-spin text-slate-300 dark:text-slate-600" /></div></Card>}
      {messages && messages.length === 0 && (
        <Card className="!p-0"><Empty icon={MessageSquare} title="Nothing yet" msg="Anything you or the team add will appear here." /></Card>
      )}
      {messages && messages.length > 0 && (
        <div className="space-y-2">
          {messages.map((m) => (
            <Card key={m.id} className={m.authorRole === "student" ? "!bg-blue-50 !ring-blue-100 dark:!bg-blue-950/30 dark:!ring-blue-800" : ""}>
              <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                {m.authorRole === "student" ? "You" : referral.departmentName}
              </p>
              <p className="mt-0.5 whitespace-pre-wrap text-[12px] leading-relaxed text-slate-700 dark:text-slate-200">{m.body}</p>
            </Card>
          ))}
        </div>
      )}

      {referral.status !== "closed" ? (
        <Card>
          <label className="text-[11px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">Add to your request</label>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} disabled={busy} rows={4}
            placeholder="Anything else they should know."
            className="mt-1 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:ring-2 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            style={{ "--tw-ring-color": NAVY }} />
          {err && <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600 dark:bg-rose-950/40 dark:text-rose-300">{err}</p>}
          <button onClick={send} disabled={busy || !draft.trim()}
            className="press mt-2 flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold text-white shadow disabled:opacity-50"
            style={{ background: NAVY }}>
            {busy ? <><Loader2 size={15} className="animate-spin" /> Sending…</> : <><Send size={15} /> Send</>}
          </button>
        </Card>
      ) : (
        <Card className="!bg-slate-50 dark:!bg-slate-700/60">
          <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
            This request has been closed. If you need something else, send a new one.
          </p>
        </Card>
      )}
    </Screen>
  );
}

export default SupportScreen;
