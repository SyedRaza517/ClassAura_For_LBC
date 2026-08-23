// A college's own letters and its own email wording, in one place on Settings.
//
// Two very different editors sit together because they answer the same question —
// "what does our institution actually send?" — and separating them would mean an
// administrator hunting for the other half.
import React, { useEffect, useState, useCallback } from "react";
import { api } from "./api";
import TemplateEditor from "./TemplateEditor";
import { FileText, Mail, Loader2, AlertTriangle, RotateCcw, Save, X } from "lucide-react";

const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200";

const LABELS = { offer: "Offer letter", application: "Application form" };

/* ------------------------------------------------------------- documents --- */

function DocumentTemplates() {
  const [state, setState] = useState(null);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setState(await api.listDocTemplates()); }
    catch (e) { setError(e.message || "Could not load templates."); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!state) return <div className="flex justify-center py-6 text-slate-400"><Loader2 className="animate-spin" /></div>;

  const current = state.templates.find((t) => t.kind === open);

  return (
    <div className="rounded-xl bg-white ring-1 ring-slate-200">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-slate-100 text-slate-500"><FileText size={17} /></div>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-slate-800">Your letters</p>
          <p className="mt-0.5 text-[12px] text-slate-500">
            Upload the offer letter and application form you already send. Your PDF is used as the page
            itself and is never redrawn, so it comes out exactly as you designed it.
          </p>
        </div>
      </div>

      {error && <div className="mx-4 mb-3 flex items-center gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"><AlertTriangle size={15} /> {error}</div>}

      <div className="border-t border-slate-200">
        {state.templates.map((t) => (
          <div key={t.kind} className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3 last:border-0">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-slate-800">{LABELS[t.kind]}</p>
              <p className="mt-0.5 truncate text-[11px] text-slate-500">
                {t.template
                  ? <>{t.template.pdfName} · {t.template.pdfPages} page{t.template.pdfPages === 1 ? "" : "s"} · {t.template.fields.length} detail{t.template.fields.length === 1 ? "" : "s"} placed</>
                  : "Using the built-in layout."}
              </p>
            </div>
            {t.template && (
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${t.template.enabled ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                {t.template.enabled ? "In use" : "Uploaded, not in use"}
              </span>
            )}
            <button onClick={() => setOpen(open === t.kind ? null : t.kind)} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 transition hover:bg-slate-50">
              {open === t.kind ? "Close" : t.template ? "Edit" : "Set up"}
            </button>
          </div>
        ))}
      </div>

      {current && (
        <div className="border-t border-slate-200 bg-slate-50 p-4">
          <TemplateEditor
            kind={current.kind}
            label={LABELS[current.kind]}
            spec={current.fields}
            template={current.template}
            onChanged={load}
            onClose={() => setOpen(null)}
          />
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- emails --- */

function EmailTemplateRow({ t, onSaved }) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState(t.subject ?? t.defaultSubject);
  const [body, setBody] = useState(t.body ?? t.defaultBody);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setSubject(t.subject ?? t.defaultSubject);
    setBody(t.body ?? t.defaultBody);
  }, [t]);

  const save = async () => {
    setBusy(true); setError("");
    try {
      await api.saveEmailTemplate(t.kind, { subject, body, enabled: true });
      await onSaved();
      setOpen(false);
    } catch (e) { setError(e.message || "Could not save."); }
    finally { setBusy(false); }
  };

  const reset = async () => {
    setBusy(true); setError("");
    try { await api.deleteEmailTemplate(t.kind); await onSaved(); setOpen(false); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="border-b border-slate-100 last:border-0">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-800">{t.label}</p>
          <p className="mt-0.5 truncate text-[11px] text-slate-500">{t.when}</p>
        </div>
        {t.enabled && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700">Your wording</span>}
        <button onClick={() => setOpen(!open)} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 transition hover:bg-slate-50">
          {open ? "Close" : t.enabled ? "Edit" : "Reword"}
        </button>
      </div>

      {open && (
        <div className="flex flex-col gap-3 bg-slate-50 px-4 py-4">
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-500">Subject</span>
            <input className={inputCls} value={subject} onChange={(e) => setSubject(e.target.value)} disabled={busy} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-500">Message</span>
            <textarea rows={10} className={inputCls + " font-mono text-[13px]"} value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} />
          </label>

          <div>
            <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">Values you can use</p>
            <div className="flex flex-wrap gap-1">
              {t.fields.map((f) => (
                <button key={f} type="button" onClick={() => setBody((b) => b + "{{" + f + "}}")}
                  className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-slate-600 ring-1 ring-slate-300 transition hover:bg-slate-100">
                  {"{{" + f + "}}"}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400">
              Click one to insert it. Anything in double braces is replaced when the email is sent, and
              your institution&rsquo;s name, colours and contact details are added automatically.
            </p>
          </div>

          {error && <div className="flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800 ring-1 ring-rose-200"><AlertTriangle size={15} className="mt-0.5 flex-none" /> {error}</div>}

          <div className="flex flex-wrap gap-2">
            <button onClick={save} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save &amp; use this wording
            </button>
            {t.enabled && (
              <button onClick={reset} disabled={busy} className="inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold text-slate-600 ring-1 ring-slate-300 transition hover:bg-slate-50">
                <RotateCcw size={15} /> Back to the built-in wording
              </button>
            )}
            <button onClick={() => setOpen(false)} disabled={busy} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-slate-500 transition hover:bg-slate-50">
              <X size={15} /> Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function EmailTemplates() {
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setState(await api.listEmailTemplates()); }
    catch (e) { setError(e.message || "Could not load emails."); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!state) return <div className="flex justify-center py-6 text-slate-400"><Loader2 className="animate-spin" /></div>;

  return (
    <div className="rounded-xl bg-white ring-1 ring-slate-200">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-slate-100 text-slate-500"><Mail size={17} /></div>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-slate-800">Your emails</p>
          <p className="mt-0.5 text-[12px] text-slate-500">
            What each message says. Your name, colours and contact details are applied automatically.
          </p>
        </div>
      </div>
      {error && <div className="mx-4 mb-3 flex items-center gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200"><AlertTriangle size={15} /> {error}</div>}
      <div className="border-t border-slate-200">
        {state.templates.map((t) => <EmailTemplateRow key={t.kind} t={t} onSaved={load} />)}
      </div>
    </div>
  );
}

export default function DocumentSettings() {
  return (
    <div className="flex flex-col gap-3">
      <DocumentTemplates />
      <EmailTemplates />
    </div>
  );
}
