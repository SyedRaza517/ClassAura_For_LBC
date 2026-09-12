// Where one institution enters its OWN Moodle and SharePoint credentials.
//
// Lives on the college's own Settings page. It was placed here rather than on the
// supplier's platform dashboard — since removed along with multi-tenancy — because
// these are the customer's credentials for the customer's systems, and nobody
// running the service on their behalf should need to hold them. The reasoning
// outlived the dashboard: the college still owns these, not us.
//
// (The SharePoint "Directory (tenant) ID" field below is Microsoft's word, naming an
// Entra ID directory. It has nothing to do with the multi-tenancy this product used
// to have, and does not go anywhere.)
//
// The saved secret is never sent back by the API — only the last four characters, so
// a person can tell which credential is in place. The field therefore starts empty
// and "leave blank to keep the current one" is stated rather than implied, because a
// blank box that silently wipes a working credential is the obvious trap here.
import React, { useEffect, useState, useCallback } from "react";
import { api } from "./api";
import { Plug, Loader2, CheckCircle2, AlertTriangle, Trash2, Save, X, PlugZap, Eye } from "lucide-react";

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
    // Stored per institution and read by the 02:00 scheduler. Presented as a choice
    // rather than a checkbox because "" (never chosen) and "off" mean different
    // things to the server: unset defers to the server default, off is this
    // college's own decision.
    choices: [
      { key: "autoSync", label: "Nightly import at 02:00", options: [
        { value: "", label: "Use the server default" },
        { value: "on", label: "On - import every night" },
        { value: "off", label: "Off - only when I press Sync" },
      ] },
    ],
  },
  // Canvas LMS. A separate provider from Moodle rather than one "VLE" with a type,
  // because a college part-way through a migration runs both and needs both sets of
  // credentials live at once.
  canvas: {
    label: "Canvas",
    blurb: "Reads courses, enrolments, assignments, submissions and grades from Canvas. Read-only — nothing is written back.",
    secret: {
      key: "token",
      label: "Access token",
      hint: "Canvas → Account → Settings → Approved Integrations → “+ New Access Token”. Generate it from an account that can read courses, rosters and grades — a tutor's token only sees that tutor's own courses. Canvas shows it once and never again.",
    },
    fields: [
      { key: "url", label: "Canvas site address", placeholder: "https://yourcollege.instructure.com", hint: "The address you sign in at. Pasting a page URL is fine — it is trimmed back to the site." },
      { key: "accountId", label: "Sub-account ID (optional)", placeholder: "e.g. 42", hint: "Limits the import to one sub-account. Leave blank for everything the token can see — but most institutions keep sandbox and training courses in a separate sub-account, which you probably do not want imported." },
      { key: "termId", label: "Term ID (optional)", placeholder: "e.g. 7", hint: "Limits the import to one enrolment term, so previous years are not pulled in on the first run." },
    ],
    choices: [
      { key: "autoSync", label: "Nightly import at 02:00", options: [
        { value: "", label: "Use the server default" },
        { value: "on", label: "On - import every night" },
        { value: "off", label: "Off - only when I press Sync" },
      ] },
    ],
    // Said on the setup screen rather than discovered after a term of empty columns.
    note: "Canvas has no API for its Roll Call attendance tool, so attendance cannot be imported from Canvas. Everything else — including whether work was actually handed in, and whether it was late — does come across.",
  },
  // Blackboard Learn. The only integration on this screen that cannot be completed by
  // the person looking at it: their Blackboard administrator has to create a REST API
  // Integration on the Learn site before any of these credentials will be accepted.
  // The form says so up front, because the failure mode otherwise is a 401 that reads
  // as "your key is wrong" when the key is fine.
  blackboard: {
    label: "Blackboard",
    blurb: "Reads courses, enrolments, gradebook columns, attempts, grades and attendance from Blackboard Learn. Read-only — nothing is written back.",
    secret: {
      key: "secret",
      label: "Application Secret",
      hint: "From the application registered at developer.anthology.com. Anthology keeps no copy — if it is lost it cannot be recovered, only replaced.",
    },
    fields: [
      { key: "url", label: "Blackboard address", placeholder: "https://blackboard.yourcollege.ac.uk", hint: "The address staff and students sign in at." },
      { key: "applicationKey", label: "Application Key", placeholder: "e.g. 9f3c1b2a-…", hint: "Issued with the Secret when the application was registered." },
      { key: "applicationId", label: "Application ID", placeholder: "e.g. 4d2e…", hint: "Not secret — this is the value your Blackboard administrator needs in order to create the REST API Integration." },
    ],
    choices: [
      { key: "autoSync", label: "Nightly import at 02:00", options: [
        { value: "", label: "Use the server default" },
        { value: "on", label: "On - import every night" },
        { value: "off", label: "Off - only when I press Sync" },
      ] },
    ],
    note: "Your Blackboard administrator must also create a REST API Integration on the Learn site (System Admin → Building Blocks → REST API Integrations), quoting the Application ID above and nominating the Learn account the import acts as. Until they do, these credentials will be refused however correct they are. That account needs permission to read courses, rosters and grades — and, to read submissions, the course.gradebook.MODIFY entitlement, which despite its name is what Blackboard uses to gate reading them.",
  },
  // Outbound email. Listed first because it is the one that affects every applicant
  // and student a college has: offers, interview invitations, password resets and
  // attendance notices all leave from here, under this college's name.
  email: {
    label: "Email",
    blurb: "The mailbox your offers, invitations and notices are sent from. Without this, nothing is emailed to your applicants or students.",
    secret: { key: "password", label: "Password or API key", hint: "Your SMTP password, or your Resend API key if you chose Resend." },
    fields: [
      { key: "host", label: "SMTP server", placeholder: "smtp.office365.com", hint: "Leave blank if you are using Resend." },
      { key: "port", label: "Port", placeholder: "587", hint: "587 for STARTTLS, 465 for implicit TLS." },
      { key: "user", label: "Username", placeholder: "admissions@yourcollege.ac.uk" },
      { key: "fromEmail", label: "Send from", placeholder: "Your College <admissions@yourcollege.ac.uk>", hint: "The address applicants see and reply to." },
    ],
    choices: [
      { key: "provider", label: "How to send", options: [
        { value: "", label: "SMTP server" },
        { value: "resend", label: "Resend (HTTP API)" },
      ] },
      { key: "secure", label: "Encryption", options: [
        { value: "", label: "Automatic (TLS on 465, STARTTLS otherwise)" },
        { value: "true", label: "Always implicit TLS" },
        { value: "false", label: "STARTTLS" },
      ] },
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
  teams: {
    label: "Teams attendance",
    blurb: "Reads who attended each online class from Microsoft Teams and fills the register automatically after the class ends. Read-only — nothing is written to Microsoft.",
    secret: { key: "clientSecret", label: "Client secret", hint: "From the app registration you created in Microsoft Entra ID for Teams attendance (separate from SharePoint's). See TEAMS_SETUP.md." },
    fields: [
      { key: "tenantId", label: "Directory (tenant) ID" },
      { key: "clientId", label: "Application (client) ID" },
      { key: "organizerAccounts", label: "Organizer accounts", placeholder: "scheduling@yourcollege.ac.uk, dept2@yourcollege.ac.uk", hint: "The dedicated accounts that CREATE your online class meetings, comma-separated. Teachers join as co-organizers and are never read. Meetings must be scheduled (not “Meet now”) from these accounts at the timetabled class time." },
    ],
    note: "Your Microsoft 365 admin must grant the app three application permissions (Calendars.Read, OnlineMeetings.Read.All, OnlineMeetingArtifact.Read.All) and scope them to these accounts with the two access policies in TEAMS_SETUP.md. Until then, Test connection will say exactly which step is missing.",
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
  // The result of the most recent "Test connection" in THIS session. item.lastTest*
  // carries the stored result from previous ones.
  const [testing, setTesting] = useState(false);
  // Canvas preview: a read-only report of what an import would find. Held in this
  // session only, like the test result beside it — it is a diagnostic, not a setting.
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState(null);
  const runPreview = async () => {
    setPreviewing(true); setPreview(null);
    try {
      setPreview(await api.canvasPreview());
    } catch (e) {
      // A failure to read Canvas is itself a finding worth showing, in the same box.
      setPreview({ ok: false, note: e?.message || "Could not read Canvas." });
    } finally { setPreviewing(false); }
  };
  const [test, setTest] = useState(null);

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

  // Save first would be the obvious thing, but this deliberately tests what is SAVED,
  // not what is typed: the point is to confirm the credential the nightly sync will
  // actually use. The button is only offered once something is stored.
  const runTest = async () => {
    setError(""); setTest(null); setTesting(true);
    try {
      const r = await api.testIntegration(item.provider);
      setTest(r);
      if (r.integration) onSaved(r.integration);
    } catch (err) {
      setTest({ ok: false, note: err.message || "Could not run the test." });
    } finally { setTesting(false); }
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

          {/* A limitation of the provider itself, stated at SET-UP time rather than
              discovered after a term of empty columns. It is not an error and not a
              warning about anything the college has done, so it reads as neither. */}
          {form.note && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-900 ring-1 ring-amber-200">
              {form.note}
            </p>
          )}

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

          {(form.choices || []).map((c) => (
            <Row key={c.key} label={c.label}>
              <select
                className={inputCls}
                value={values[c.key] ?? ""}
                onChange={(e) => setValues((s) => ({ ...s, [c.key]: e.target.value }))}
                disabled={busy}
              >
                {c.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
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

          {/* The whole value of the test is the SPECIFIC reason it failed - which of
              the secret, the site or the library is wrong - so the note is shown in
              full rather than reduced to a red cross. */}
          {test && (
            <div className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm font-medium ring-1 ${test.ok ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-rose-50 text-rose-800 ring-rose-200"}`}>
              {test.ok ? <CheckCircle2 size={15} className="mt-0.5 flex-none" /> : <AlertTriangle size={15} className="mt-0.5 flex-none" />}
              <span>{test.note}</span>
            </div>
          )}

          {preview && (
            <div className={`rounded-xl px-3.5 py-3 text-[13px] ring-1 ${preview.ok ? "bg-slate-50 text-slate-700 ring-slate-200" : "bg-amber-50 text-amber-800 ring-amber-200"}`}>
              <p className="font-semibold">{preview.note}</p>
              {preview.summary && (
                <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[12px] text-slate-600 sm:grid-cols-3">
                  <li>Courses sampled: <b>{preview.summary.coursesSampled}</b></li>
                  <li>Students: <b>{preview.summary.students}</b></li>
                  <li>Assignments: <b>{preview.summary.assignments}</b></li>
                  <li>Submission rows: <b>{preview.summary.submissionRows}</b></li>
                  <li>Marked as submitted: <b>{preview.summary.submitted}</b></li>
                  {/* THE FIGURE THIS SCREEN IS FOR. */}
                  <li>With a hand-in date: <b>{preview.summary.withDates}</b>{preview.summary.datedPercent != null ? ` (${preview.summary.datedPercent}%)` : ""}</li>
                </ul>
              )}
              {Array.isArray(preview.issues) && preview.issues.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] text-slate-500">
                  {preview.issues.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              )}
              <p className="mt-2 text-[11px] text-slate-400">Nothing was imported — this reads Canvas and writes nothing.</p>
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <button type="submit" disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save
            </button>
            {item.configured && (
              <button type="button" onClick={runTest} disabled={busy || testing} className="inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 transition hover:bg-slate-50 disabled:opacity-60">
                {testing ? <Loader2 size={15} className="animate-spin" /> : <PlugZap size={15} />} Test connection
              </button>
            )}
            {/* Canvas only, and READ-ONLY. Canvas has a complete client and normaliser
                but nothing that writes its data here yet, so there is no sync button to
                offer — a sync button that imported nothing would read as a working
                integration. The preview reads Canvas and reports what an importer WOULD
                find, chiefly whether this account's submissions carry real hand-in
                dates. That is the property that decides whether the importer is worth
                building, because Moodle+Turnitin does not carry them. */}
            {item.provider === "canvas" && item.configured && (
              <button type="button" onClick={runPreview} disabled={busy || previewing} className="inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 transition hover:bg-slate-50 disabled:opacity-60">
                {previewing ? <Loader2 size={15} className="animate-spin" /> : <Eye size={15} />} Preview import
              </button>
            )}
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
