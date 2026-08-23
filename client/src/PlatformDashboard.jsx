// The platform-operator surface — every institution on the system, in one place.
//
// Deliberately styled apart from the college app. An operator here can suspend a
// customer or delete their data, and a screen that looks identical to the one a
// college administrator uses invites the mistake of forgetting which you are in.
// Slate and amber, not the college navy.
import React, { useState, useEffect, useCallback } from "react";
import { platformApi, getPlatformToken, setPlatformToken } from "./platformApi";
import {
  Building2, Users, GraduationCap, Plus, Power, Trash2, Loader2, ShieldCheck,
  LogOut, RefreshCw, AlertTriangle, X, CheckCircle2, Plug, ArrowLeft,
} from "lucide-react";

const INK = "#0f172a";
const ACCENT = "#b45309"; // amber-700 — nothing in the college app uses it

/* ------------------------------------------------------------------ shared --- */

function Field({ label, children, hint }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200 disabled:opacity-60";

function Btn({ children, onClick, disabled, tone = "dark", type = "button", className = "" }) {
  const tones = {
    dark: "bg-slate-900 text-white hover:bg-slate-800",
    amber: "text-white hover:opacity-90",
    ghost: "bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50",
    danger: "bg-rose-600 text-white hover:bg-rose-700",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={tone === "amber" ? { background: ACCENT } : undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${tones[tone]} ${className}`}
    >
      {children}
    </button>
  );
}

function Banner({ kind = "error", children, onClose }) {
  const map = {
    error: "bg-rose-50 text-rose-800 ring-rose-200",
    ok: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    warn: "bg-amber-50 text-amber-900 ring-amber-200",
  };
  const Icon = kind === "ok" ? CheckCircle2 : AlertTriangle;
  return (
    <div className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm font-medium ring-1 ${map[kind]}`}>
      <Icon size={16} className="mt-0.5 flex-none" />
      <div className="flex-1">{children}</div>
      {onClose && <button onClick={onClose} className="flex-none opacity-60 hover:opacity-100"><X size={15} /></button>}
    </div>
  );
}

/* ------------------------------------------------------------------- login --- */

function PlatformLogin({ onSignedIn, onBack }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      const res = await platformApi.login(email.trim(), password);
      setPlatformToken(res.token);
      onSignedIn(res.admin);
    } catch (err) {
      setError(err.message || "Could not sign in.");
    } finally { setBusy(false); }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 p-4" style={{ fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}>
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-white p-7 shadow-2xl">
        <div className="mb-5 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl text-white" style={{ background: INK }}>
            <ShieldCheck size={24} />
          </div>
          <h1 className="text-lg font-extrabold text-slate-900">Platform operations</h1>
          <p className="mt-1 text-sm text-slate-500">Every institution on this system. Not a college sign-in.</p>
        </div>
        <div className="flex flex-col gap-3">
          <Field label="Email">
            <input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} autoComplete="username" required />
          </Field>
          <Field label="Password">
            <input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} autoComplete="current-password" required />
          </Field>
          {error && <Banner>{error}</Banner>}
          <Btn type="submit" disabled={busy} className="mt-1 w-full">
            {busy ? <><Loader2 size={16} className="animate-spin" /> Signing in…</> : "Sign in"}
          </Btn>
        </div>
        <p className="mt-4 text-center text-[11px] text-slate-400">
          Operator accounts are created from the server command line, never through this page.
        </p>
        {onBack && (
          <button type="button" onClick={onBack} className="mt-3 flex w-full items-center justify-center gap-1.5 text-[11px] font-semibold text-slate-500 transition hover:text-slate-800">
            <ArrowLeft size={13} /> Back to the college sign-in
          </button>
        )}
      </form>
    </div>
  );
}

/* -------------------------------------------------------------- new tenant --- */

function NewInstitution({ onDone, onCancel }) {
  const [f, setF] = useState({ name: "", slug: "", adminName: "", adminEmail: "", adminPassword: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  // Suggest a slug from the name, but let it be overridden — it becomes the
  // subdomain and cannot change afterwards without breaking saved links.
  const onName = (e) => {
    const name = e.target.value;
    setF((s) => ({
      ...s,
      name,
      slug: s.slug && s.slug !== slugify(s.name) ? s.slug : slugify(name),
    }));
  };
  const slugify = (v) => v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

  const submit = async (e) => {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      await platformApi.createTenant({
        name: f.name.trim(), slug: f.slug.trim(),
        adminName: f.adminName.trim(), adminEmail: f.adminEmail.trim(), adminPassword: f.adminPassword,
      });
      onDone();
    } catch (err) {
      setError(err.message || "Could not create the institution.");
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3.5">
      <Field label="Institution name">
        <input className={inputCls} value={f.name} onChange={onName} disabled={busy} required placeholder="Brookes College" />
      </Field>
      <Field label="Slug" hint="Their subdomain and the X-Tenant value. Lowercase letters, numbers and hyphens. Cannot be changed later.">
        <input className={inputCls} value={f.slug} onChange={set("slug")} disabled={busy} required placeholder="brookes" />
      </Field>
      <div className="mt-1 border-t border-slate-200 pt-3">
        <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">Their first administrator</p>
        <div className="flex flex-col gap-3">
          <Field label="Name"><input className={inputCls} value={f.adminName} onChange={set("adminName")} disabled={busy} placeholder="Jane Head" /></Field>
          <Field label="Email"><input className={inputCls} type="email" value={f.adminEmail} onChange={set("adminEmail")} disabled={busy} required /></Field>
          <Field label="Password" hint="At least 12 characters. Give it to them over a channel other than email, and ask them to change it.">
            <input className={inputCls} type="text" value={f.adminPassword} onChange={set("adminPassword")} disabled={busy} required />
          </Field>
        </div>
      </div>
      {error && <Banner>{error}</Banner>}
      <div className="mt-1 flex gap-2">
        <Btn type="submit" tone="amber" disabled={busy} className="flex-1">
          {busy ? <><Loader2 size={16} className="animate-spin" /> Creating…</> : <><Plus size={16} /> Create institution</>}
        </Btn>
        <Btn tone="ghost" onClick={onCancel} disabled={busy}>Cancel</Btn>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ delete --- */

function ConfirmDelete({ tenant, onDone, onCancel }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setError(""); setBusy(true);
    try { await platformApi.deleteTenant(tenant.id, typed.trim()); onDone(); }
    catch (err) { setError(err.message || "Could not delete."); }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <Banner kind="warn">
        This permanently deletes <strong>{tenant.name}</strong> and everything belonging to it —
        {" "}{tenant.counts.staff} staff, {tenant.counts.students} students, {tenant.counts.admissions} admissions,
        their documents, registers and history. There is no undo and no per-institution backup.
      </Banner>
      <p className="text-sm text-slate-600">
        If you meant to stop their access rather than destroy their records, <strong>suspend</strong> them instead.
      </p>
      <Field label={`Type ${tenant.slug} to confirm`}>
        <input className={inputCls} value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy} autoComplete="off" />
      </Field>
      {error && <Banner>{error}</Banner>}
      <div className="flex gap-2">
        <Btn type="submit" tone="danger" disabled={busy || typed.trim() !== tenant.slug} className="flex-1">
          {busy ? <><Loader2 size={16} className="animate-spin" /> Deleting…</> : <><Trash2 size={16} /> Delete permanently</>}
        </Btn>
        <Btn tone="ghost" onClick={onCancel} disabled={busy}>Cancel</Btn>
      </div>
    </form>
  );
}

/* --------------------------------------------------------------- dashboard --- */

function Stat({ label, value, Icon }) {
  return (
    <div className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
      <div className="flex items-center gap-2 text-slate-400"><Icon size={14} /><span className="text-[11px] font-bold uppercase tracking-wide">{label}</span></div>
      <p className="mt-1.5 text-2xl font-extrabold tabular-nums text-slate-900">{value}</p>
    </div>
  );
}

function Modal({ open, title, onClose, children, width = 460 }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 sm:items-center" onClick={onClose}>
      <div className="w-full rounded-2xl bg-white p-6 shadow-2xl" style={{ maxWidth: width }} onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-extrabold text-slate-900">{title}</h3>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function PlatformDashboard({ onBack }) {
  const [admin, setAdmin] = useState(null);
  const [checking, setChecking] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(async () => {
    try { setData(await platformApi.overview()); setError(""); }
    catch (e) { setError(e.message || "Could not load."); }
  }, []);

  // Restore an existing session rather than demanding a fresh sign-in on reload.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!getPlatformToken()) { setChecking(false); return; }
      try {
        const me = await platformApi.me();
        if (!cancelled) { setAdmin(me.admin); await load(); }
      } catch { setPlatformToken(null); }
      finally { if (!cancelled) setChecking(false); }
    })();
    return () => { cancelled = true; };
  }, [load]);

  // The api client raises this when a request 401s, so an expired session drops to
  // the sign-in screen instead of leaving a dashboard where every action fails.
  useEffect(() => {
    const onOut = () => { setAdmin(null); setData(null); };
    window.addEventListener("platform-signed-out", onOut);
    return () => window.removeEventListener("platform-signed-out", onOut);
  }, []);

  const signOut = () => { setPlatformToken(null); setAdmin(null); setData(null); };

  const toggleActive = async (t) => {
    setBusyId(t.id); setError(""); setNotice("");
    try {
      await platformApi.setActive(t.id, !t.active);
      setNotice(`${t.name} ${t.active ? "suspended" : "restored"}.`);
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusyId(null); }
  };

  if (checking) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-100 text-slate-500"><Loader2 className="animate-spin" /></div>;
  }
  if (!admin) return <PlatformLogin onBack={onBack} onSignedIn={async (a) => { setAdmin(a); await load(); }} />;

  const totals = data?.totals;

  return (
    <div className="min-h-screen bg-slate-100" style={{ fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}>
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-900 px-5 py-3 text-white">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <ShieldCheck size={18} style={{ color: ACCENT }} />
          <div className="flex-1">
            <p className="text-sm font-extrabold leading-tight">Platform operations</p>
            <p className="text-[11px] text-slate-400">Signed in as {admin.email}</p>
          </div>
          <button onClick={load} className="rounded-lg p-2 text-slate-300 hover:bg-slate-800" title="Refresh"><RefreshCw size={15} /></button>
          <button onClick={signOut} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-800"><LogOut size={14} /> Sign out</button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-6">
        <div className="mb-4 flex flex-col gap-2">
          {error && <Banner onClose={() => setError("")}>{error}</Banner>}
          {notice && <Banner kind="ok" onClose={() => setNotice("")}>{notice}</Banner>}
        </div>

        {totals && (
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Institutions" value={totals.institutions} Icon={Building2} />
            <Stat label="Active" value={totals.active} Icon={CheckCircle2} />
            <Stat label="Staff" value={totals.staff} Icon={Users} />
            <Stat label="Students" value={totals.students} Icon={GraduationCap} />
          </div>
        )}

        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-extrabold uppercase tracking-wide text-slate-500">Institutions</h2>
          <Btn tone="amber" onClick={() => setShowNew(true)}><Plus size={16} /> New institution</Btn>
        </div>

        {!data ? (
          <div className="flex justify-center py-12 text-slate-400"><Loader2 className="animate-spin" /></div>
        ) : data.tenants.length === 0 ? (
          <div className="rounded-xl bg-white p-10 text-center ring-1 ring-slate-200">
            <Building2 size={28} className="mx-auto mb-2 text-slate-300" />
            <p className="text-sm font-semibold text-slate-600">No institutions yet</p>
            <p className="mt-1 text-sm text-slate-400">Create the first one to get started.</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl bg-white ring-1 ring-slate-200">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-3">Institution</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Staff</th>
                  <th className="px-4 py-3 text-right">Students</th>
                  <th className="px-4 py-3 text-right">Admissions</th>
                  <th className="px-4 py-3">Integrations</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {data.tenants.map((t) => (
                  <tr key={t.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3">
                      <p className="font-semibold text-slate-800">{t.name}</p>
                      <p className="font-mono text-[11px] text-slate-400">{t.slug}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${t.active ? "bg-emerald-50 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>
                        {t.active ? "Active" : "Suspended"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{t.counts.staff}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{t.counts.students}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">{t.counts.admissions}</td>
                    <td className="px-4 py-3">
                      {t.integrations.length === 0 ? (
                        <span className="text-[11px] text-slate-400">none</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {t.integrations.map((i) => (
                            <span key={i.provider} className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${i.enabled ? "bg-sky-50 text-sky-700" : "bg-slate-100 text-slate-500"}`}>
                              <Plug size={10} /> {i.provider}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1.5">
                        <button
                          onClick={() => toggleActive(t)}
                          disabled={busyId === t.id}
                          title={t.active ? "Suspend access" : "Restore access"}
                          className="rounded-lg p-1.5 text-slate-500 ring-1 ring-slate-200 transition hover:bg-slate-50 disabled:opacity-50"
                        >
                          {busyId === t.id ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
                        </button>
                        <button
                          onClick={() => setDeleting(t)}
                          title="Delete permanently"
                          className="rounded-lg p-1.5 text-rose-500 ring-1 ring-rose-200 transition hover:bg-rose-50"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
          Suspending blocks sign-in for an institution but keeps every record — use it for an unpaid
          invoice or a contract under review. Deleting removes their data permanently and cannot be undone.
          Each institution manages its own Moodle and SharePoint credentials from its own Settings page;
          they are encrypted and are not readable from here.
        </p>
      </main>

      <Modal open={showNew} title="New institution" onClose={() => setShowNew(false)} width={480}>
        <NewInstitution
          onCancel={() => setShowNew(false)}
          onDone={async () => { setShowNew(false); setNotice("Institution created."); await load(); }}
        />
      </Modal>

      <Modal open={!!deleting} title={`Delete ${deleting?.name || ""}`} onClose={() => setDeleting(null)} width={480}>
        {deleting && (
          <ConfirmDelete
            tenant={deleting}
            onCancel={() => setDeleting(null)}
            onDone={async () => { const n = deleting.name; setDeleting(null); setNotice(`${n} deleted.`); await load(); }}
          />
        )}
      </Modal>
    </div>
  );
}
