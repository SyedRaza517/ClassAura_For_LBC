import { useState } from "react";
import { Send, Info, CheckCircle2, MessageSquare, Loader2 } from "lucide-react";
import { Screen, Card, SectionTitle, Empty } from "../ui";
import { ACCENT } from "../ui/tokens";
import { fmtDate } from "../utils";
import { api } from "../../api";
import { NAVY, MAROON } from "../../branding";

export function QueryScreen({ queries = [], reload }) {
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);   // compose panel

  const submit = async () => {
    setErr(""); setOk(false);
    if (message.trim().length < 3) { setErr("Please write your query."); return; }
    setBusy(true);
    try {
      await api.submitStudentQuery(subject.trim() || "Student query", message.trim());
      setSubject(""); setMessage(""); setOk(true); setOpen(false); reload && reload();
    } catch (e) { setErr(e.message || "Could not send your query."); }
    finally { setBusy(false); }
  };

  return (
    <Screen>
      {!open ? (
        <button onClick={() => { setOpen(true); setOk(false); }} className="press flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-bold text-white shadow-lg" style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}>
          <Send size={16} /> Ask a question
        </button>
      ) : (
        <Card>
          <p className="flex items-center gap-1.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400"><Info size={13} className="shrink-0 text-blue-500 dark:text-blue-400" /> Your message goes to the college office. Their reply appears below.</p>
          <div className="mt-3">
            <label className="text-[11px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">Subject</label>
            <input value={subject} onChange={e => setSubject(e.target.value)} disabled={busy} placeholder="e.g. Attendance query" className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:ring-2 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100" style={{ "--tw-ring-color": NAVY }} />
          </div>
          <div className="mt-3">
            <label className="text-[11px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">Your query</label>
            <textarea value={message} onChange={e => setMessage(e.target.value)} disabled={busy} rows={5} placeholder="Write your question or request here…" className="mt-1 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:ring-2 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100" style={{ "--tw-ring-color": NAVY }} />
          </div>
          {err && <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600 dark:bg-rose-950/40 dark:text-rose-300">{err}</p>}
          <div className="mt-3 flex gap-2">
            <button onClick={() => { setOpen(false); setErr(""); }} disabled={busy} className="press flex-1 rounded-xl border-2 border-slate-200 py-2.5 text-sm font-bold text-slate-500 dark:border-slate-600 dark:text-slate-400">Cancel</button>
            <button onClick={submit} disabled={busy} className="press flex flex-[2] items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold text-white shadow-lg disabled:opacity-60" style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}>
              {busy ? <><Loader2 size={16} className="animate-spin" /> Sending…</> : <><Send size={16} /> Send</>}
            </button>
          </div>
        </Card>
      )}

      {ok && <div className="flex items-center gap-2 rounded-2xl bg-emerald-50 px-3.5 py-3 text-xs font-bold text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800"><CheckCircle2 size={15} /> Sent — the college will reply here.</div>}

      <SectionTitle colour={ACCENT.ask}>Your conversations</SectionTitle>
      {queries.length === 0 && <Card className="!p-0"><Empty icon={MessageSquare} title="No questions yet" msg="Anything you ask the college will appear here, with their reply." /></Card>}

      {/* Conversation style: your message on the right, the college's reply on the left.
          fade-up + a stagger was missing on each conversation — every other list on this
          app (Reviews, Support) arrives one row after another, and these did not. */}
      {queries.map((q, i) => (
        <div key={q.id} className="fade-up space-y-1.5" style={{ animationDelay: `${Math.min(i, 6) * 55}ms` }}>
          <div className="flex items-center gap-2 px-1">
            <p className="flex-1 truncate text-[12px] font-extrabold text-slate-600 dark:text-slate-300">{q.subject}</p>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${q.status === "open" ? "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"}`}>{q.status === "open" ? "Awaiting reply" : "Answered"}</span>
          </div>
          <div className="flex justify-end">
            <div className="max-w-[85%] break-words rounded-2xl rounded-br-md px-3.5 py-2.5 text-sm leading-relaxed text-white shadow-sm" style={{ background: NAVY }}>
              {q.message}
              <p className="mt-1 text-[10px] text-white/60">{fmtDate(String(q.createdAt).slice(0, 10))}</p>
            </div>
          </div>
          {q.response ? (
            <div className="flex justify-start">
              <div className="max-w-[85%] break-words rounded-2xl rounded-bl-md bg-white px-3.5 py-2.5 text-sm leading-relaxed text-slate-700 shadow-sm ring-1 ring-slate-200/70 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700/60">
                <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-blue-600 dark:text-blue-400">College{q.respondedBy ? ` · ${q.respondedBy}` : ""}</p>
                {q.response}
                {q.respondedAt && <p className="mt-1 text-[10px] text-slate-400 dark:text-slate-500">{fmtDate(q.respondedAt)}</p>}
              </div>
            </div>
          ) : (
            <p className="px-1 text-[11px] text-slate-400 dark:text-slate-500">Awaiting a reply from the college.</p>
          )}
        </div>
      ))}
    </Screen>
  );
}

export default QueryScreen;
