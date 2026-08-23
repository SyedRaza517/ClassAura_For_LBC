// Where one institution enters its OWN Moodle and SharePoint credentials.
//
// Lives on the college's own Settings page, not the platform dashboard: these are
// the customer's credentials for the customer's systems, and a platform operator
// should not need to hold them to run the service.
//
// The saved secret is never sent back by the API — only the last four characters, so
// a person can tell which credential is in place. The field therefore starts empty
// and "leave blank to keep the current one" is stated rather than implied, because a
// blank box that silently wipes a working credential is the obvious trap here.
import React, { useEffect, useState, useCallback } from "react";
import { api } from "./api";
import { Plug, Loader2, CheckCircle2, AlertTriangle, Trash2, Save, X } from "lucide-react";

const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200 disabled:opacity-60";

// Mirrors PROVIDERS in server/src/integrationConfig.js. Kept as presentation only —
// the server decides what it accepts; this decides what a person is shown.
const FORMS = {
  moodle: {
    label: "Moodle",
    blurb: "Reads courses, enrolments, grades and attendance from your VLE. Read-only — nothing is written back.",
    secret: { key: "token", label: "Web services token", hint: "The 32-character token from Site administration → Server → Web services → Manage tokens." },
    fields: [
      { key: "url", label: "Moodle URL", placeholder: "https://vle.yourcollege.ac.uk", hint: "No trailing slash, and not the /login page." },
    ],
  },
  sharepoint: {
    label: "SharePoint",
    blurb: "Creates a folder per applicant and stores their documents in your own Microsoft 365, so files stay under your permissions.",
    secret: { key: "clientSecret", label: "Client secret", hint: "From the app registration you created in Microsoft Entra ID." },
    fields: [
      { key: "tenantId", label: "Directory (tenant) ID" },
      { key: "clientId", label: "Application (client) ID" },
      { key: "siteHost", label: "Site host", placeholder: "yourcollege.sharepoint.com" },
      { key: "sitePath", label: "Site path", placeholder: "/sites/Admissions" },
      { key: "driveName", label: "Document library", placeholder: "Documents" },
      { key: "rootFolder", label: "Root folder", placeholder: "(optional)" },
    ],
  },
};

function Row({ label, children, hint }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}

function ProviderCard({ item, onSaved, onRemoved }) {
  const form = FORMS[item.provider];
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({});
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(item.enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setValues(item.settings || {});
    setEnabled(item.enabled);
    setSecret(""); // never prefilled: the API does not return it, and should not
  }, [item]);

  if (!form) return null;

  const save = async (e) => {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      const body = { ...values, enabled };
      if (secret.trim()) body[form.secret.key] = secret.trim();
      const saved = await api.saveIntegration(item.provider, body);
      setSecret("");
      setOpen(false);
      onSaved(saved);
    } catch (err) {
      setError(err.message || "Could not save.");
    } finally { setBusy(false); }
  };

  const remove = async () => {
    setError(""); setBusy(true);
    try { await api.removeIntegration(item.provider); onRemoved(item.provider); setOpen(false); }
    catch (err) { setError(err.message || "Could not remove."); }
    finally { setBusy(false); }
  };

  return (
    <div className="rounded-xl bg-white ring-1 ring-slate-200">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className={`flex h-9 w-9 flex-none items-center justify-center rounded-lg ${item.configured && item.enabled ? "bg-sky-50 text-sky-600" : "bg-slate-100 text-slate-400"}`}>
          <Plug size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-bold text-slate-800">{form.label}</p>
            {item.configured ? (
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${item.enabled ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                {item.enabled ? "Connected" : "Saved, switched off"}
              </span>
            ) : (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">Not set up</span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[12px] text-slate-500">
            {item.configured ? <>{item.summary} · <span className="font-mono">{item.secretHint}</span></> : form.blurb}
          </p>
        </div>
        <button onClick={() => setOpen((v) => !v)} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 transition hover:bg-slate-50">
          {open ? "Close" : item.configured ? "Edit" : "Set up"}
        </button>
      </div>

      {open && (
        <form onSubmit={save} className="flex flex-col gap-3 border-t border-slate-200 p-4">
          <p className="text-[12px] leading-relaxed text-slate-500">{form.blurb}</p>

          {form.fields.map((f) => (
            <Row key={f.key} label={f.label} hint={f.hint}>
              <input
                className={inputCls}
                value={values[f.key] || ""}
                placeholder={f.placeholder || ""}
                onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))}
                disabled={busy}
              />
            </Row>
          ))}

          <Row
            label={form.secret.label}
            hint={item.configured ? "Leave blank to keep the credential already saved." : form.secret.hint}
          >
            <input
              className={inputCls}
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              disabled={busy}
              autoComplete="new-password"
              placeholder={item.configured ? "•••••••••• (unchanged)" : ""}
            />
          </Row>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={busy} className="h-4 w-4 rounded border-slate-300" />
            Use this integration
          </label>

          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800 ring-1 ring-rose-200">
              <AlertTriangle size={15} className="mt-0.5 flex-none" /> {error}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <button type="submit" disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save
            </button>
            {item.configured && (
              <button type="button" onClick={remove} disabled={busy} className="inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold text-rose-600 ring-1 ring-rose-200 transition hover:bg-rose-50 disabled:opacity-60">
                <Trash2 size={15} /> Disconnect
              </button>
            )}
            <button type="button" onClick={() => setOpen(false)} disabled={busy} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-slate-500 transition hover:bg-slate-50">
              <X size={15} /> Cancel
            </button>
          </div>

          {item.configured && (
            <p className="text-[11px] leading-relaxed text-slate-400">
              Disconnecting removes the stored credential and stops all future syncing. Records already
              imported are kept.
            </p>
          )}
        </form>
      )}
    </div>
  );
}

export default function IntegrationSettings() {
  const [state, setState] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setState(await api.listIntegrations()); setError(""); }
    catch (e) { setError(e.message || "Could not load integrations."); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const replace = (saved) => setState((s) => ({ ...s, integrations: s.integrations.map((i) => (i.provider === saved.provider ? saved : i)) }));
  const clear = (provider) => setState((s) => ({
    ...s,
    integrations: s.integrations.map((i) => (i.provider === provider ? { ...i, configured: false, enabled: false, settings: {}, secretHint: null, summary: null } : i)),
  }));

  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800 ring-1 ring-rose-200">
        <AlertTriangle size={15} className="mt-0.5 flex-none" /> {error}
      </div>
    );
  }
  if (!state) return <div className="flex justify-center py-8 text-slate-400"><Loader2 className="animate-spin" /></div>;

  return (
    <div className="flex flex-col gap-3">
      {!state.keyConfigured && (
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900 ring-1 ring-amber-200">
          <AlertTriangle size={15} className="mt-0.5 flex-none" />
          <span>
            Credential storage is not configured on this server, so integrations cannot be saved.
            An administrator needs to set <span className="font-mono">CREDENTIALS_KEY</span>.
          </span>
        </div>
      )}

      <div className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-[12px] leading-relaxed text-slate-600 ring-1 ring-slate-200">
        <CheckCircle2 size={15} className="mt-0.5 flex-none text-slate-400" />
        <span>
          These credentials belong to your institution alone. They are encrypted before being stored,
          are never shown again once saved, and no other institution on this system can read them.
        </span>
      </div>

      {state.integrations.map((item) => (
        <ProviderCard key={item.provider} item={item} onSaved={replace} onRemoved={clear} />
      ))}
    </div>
  );
}
