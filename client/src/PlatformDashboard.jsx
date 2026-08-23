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
  LogOut, RefreshCw, AlertTriangle, X, CheckCircle2, Plug, ArrowLeft, HardDrive, FileText, ServerCog, ShieldAlert, KeyRound,
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

  // When a second factor is enrolled the password step returns a CHALLENGE rather
  // than a session, and this screen switches to asking for the code. Nothing is
  // stored until the code is accepted — a challenge cannot act on any customer.
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      const res = await platformApi.login(email.trim(), password);
      if (res.mfaRequired) {
        setChallenge({ token: res.challengeToken, name: res.name });
        setPassword("");
        return;
      }
      setPlatformToken(res.token);
      onSignedIn(res.admin);
    } catch (err) {
      setError(err.message || "Could not sign in.");
    } finally { setBusy(false); }
  };

  const submitCode = async (e) => {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      const res = await platformApi.loginVerify(challenge.token, code.trim());
      setPlatformToken(res.token);
      onSignedIn(res.admin);
    } catch (err) {
      setError(err.message || "Could not verify that code.");
    } finally { setBusy(false); }
  };

  if (challenge) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900 p-4" style={{ fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}>
        <form onSubmit={submitCode} className="w-full max-w-sm rounded-2xl bg-white p-7 shadow-2xl">
          <div className="mb-5 flex flex-col items-center text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl text-white" style={{ background: INK }}>
              <KeyRound size={24} />
            </div>
            <h1 className="text-lg font-extrabold text-slate-900">Enter your code</h1>
            <p className="mt-1 text-sm text-slate-500">Open your authenticator app and enter the six-digit code for {challenge.name}.</p>
          </div>
          <Field label="Six-digit code">
            <input
              className={inputCls + " text-center text-lg tracking-[0.4em]"}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={busy}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              autoFocus
              required
            />
          </Field>
          {error && <div className="mt-3"><Banner>{error}</Banner></div>}
          <Btn type="submit" disabled={busy} className="mt-4 w-full">
            {busy ? <><Loader2 size={16} className="animate-spin" /> Checking…</> : "Sign in"}
          </Btn>
          <button type="button" onClick={() => { setChallenge(null); setCode(""); setError(""); }}
            className="mt-3 flex w-full items-center justify-center gap-1.5 text-[11px] font-semibold text-slate-500 transition hover:text-slate-800">
            <ArrowLeft size={13} /> Start again
          </button>
        </form>
      </div>
    );
  }

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


/* --------------------------------------------------------------- usage ------- */

// What each institution is holding. Loaded on demand, not with the dashboard: it
// reads pg_class and counts every tenanted table, which is fine when asked for and
// wasteful on every open.
//
// The database column says "estimated" on the screen and not only in the payload,
// because every institution's rows share the same tables — Postgres can size the
// Student table, not the part of it belonging to one college. File storage is exact
// and is therefore a separate column rather than being added into the same number.
function UsagePanel() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);

  const load = async () => {
    setBusy(true); setError("");
    try { setData(await platformApi.usage()); }
    catch (e) { setError(e.message || "Could not measure usage."); }
    finally { setBusy(false); }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !data && !busy) load();
  };

  return (
    <div className="mb-6 rounded-xl bg-white ring-1 ring-slate-200">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-slate-100 text-slate-500">
          <HardDrive size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-slate-800">Storage &amp; usage</p>
          <p className="mt-0.5 text-[12px] text-slate-500">
            {data ? <>Database {data.database.totalSize} total · {data.tenants.length} institution{data.tenants.length === 1 ? "" : "s"} measured</> : "How much of the database each institution is holding."}
          </p>
        </div>
        {open && data && (
          <Btn tone="ghost" onClick={load} disabled={busy}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Remeasure
          </Btn>
        )}
        <Btn tone="ghost" onClick={toggle}>{open ? "Hide" : "Measure"}</Btn>
      </div>

      {open && (
        <div className="border-t border-slate-200 p-4">
          {error && <Banner>{error}</Banner>}
          {busy && !data && <div className="flex justify-center py-6 text-slate-400"><Loader2 className="animate-spin" /></div>}
          {data && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400">
                      <th className="py-2 pr-3">Institution</th>
                      <th className="py-2 pr-3 text-right">Rows</th>
                      <th className="py-2 pr-3 text-right">Database (est.)</th>
                      <th className="py-2 pr-3 text-right">Files</th>
                      <th className="py-2 text-right">File storage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.tenants.map((t) => (
                      <tr key={t.id} className="border-b border-slate-100 last:border-0 align-top">
                        <td className="py-2 pr-3">
                          <span className="font-semibold text-slate-800">{t.name}</span>
                          <span className="ml-1.5 font-mono text-[11px] text-slate-400">{t.slug}</span>
                          {!t.active && <span className="ml-1.5 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-700">suspended</span>}
                          {t.topTables.length > 0 && (
                            <div className="mt-1 text-[11px] text-slate-400">
                              {t.topTables.map((x) => `${x.name} ${x.size}`).join(" · ")}
                            </div>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums text-slate-600">{t.rows.toLocaleString()}</td>
                        <td className="py-2 pr-3 text-right tabular-nums font-semibold text-slate-800">{t.estimatedSize}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-slate-600">{t.files.toLocaleString()}</td>
                        <td className="py-2 text-right tabular-nums font-semibold text-slate-800">{t.fileSize}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-slate-200 pt-3 text-[12px] text-slate-500">
                <span>Database total <b className="text-slate-700">{data.database.totalSize}</b></span>
                <span>Attributed to institutions <b className="text-slate-700">{data.database.accountedSize}</b></span>
                <span>Shared overhead <b className="text-slate-700">{data.database.overheadSize}</b></span>
              </div>
              <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-400">
                <FileText size={12} className="mt-0.5 flex-none" />
                {data.note} Shared overhead is system catalogues and indexes on tables belonging to no
                one institution — shown rather than folded into anybody&rsquo;s figure.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}


/* ------------------------------------------------------- platform operators --- */

// Who can sign in to THIS screen. Until now the tier had a create endpoint and a list
// endpoint and no way to take access away again: an operator who left the company kept
// a working password against every customer's data, and the only remedy was a psql
// session on production.
//
// Deactivating is reversible and keeps the account's history — see the route in
// server/src/routes/platform.js for why it is not a delete. Creating operators stays a
// command-line job on purpose (the sign-in screen says so), so there is no "add"
// button here; this panel exists to REMOVE access, which is the half that was missing.
function OperatorsPanel({ me, onError, onNotice }) {
  const [rows, setRows] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(null); // the operator awaiting confirmation

  const load = useCallback(async () => {
    setError("");
    try { setRows(await platformApi.listAdmins()); }
    catch (e) { setError(e.message || "Could not load operators."); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const apply = async (op, active) => {
    setBusyId(op.id);
    try {
      await platformApi.setAdminActive(op.id, active);
      setConfirming(null);
      onNotice(`${op.email} ${active ? "restored" : "deactivated"}.`);
      await load();
    } catch (e) {
      // The server's two guards (never yourself, never the last one) come back as 400s
      // with a sentence saying what to do instead. Show it where the operator is
      // looking — inside the dialog when one is open, otherwise on the panel.
      if (confirming) setError(e.message || "Could not update that operator.");
      else onError(e.message || "Could not update that operator.");
    } finally { setBusyId(null); }
  };

  const activeCount = (rows || []).filter((r) => r.active !== false).length;
  const fmt = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "never");

  return (
    <div className="mb-6 rounded-xl bg-white ring-1 ring-slate-200">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-slate-100 text-slate-500"><ShieldCheck size={17} /></div>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-slate-800">Platform operators</p>
          <p className="mt-0.5 text-[12px] text-slate-500">
            {rows ? <>{activeCount} active of {rows.length} · everyone who can reach this screen</> : "Everyone who can reach this screen."}
          </p>
        </div>
        <Btn tone="ghost" onClick={load}><RefreshCw size={15} /> Refresh</Btn>
      </div>

      <div className="p-4">
        {error && !confirming && <div className="mb-3"><Banner onClose={() => setError("")}>{error}</Banner></div>}
        {!rows ? (
          <div className="flex justify-center py-6 text-slate-400"><Loader2 className="animate-spin" /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400">
                  <th className="py-2 pr-3">Operator</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Last sign-in</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isMe = r.id === me?.id;
                  const isActive = r.active !== false;
                  // Mirrors the server's guards so a button that cannot work is not
                  // offered. The server still enforces both — this is a courtesy, not
                  // the control: nothing stops a caller going straight to the API.
                  const lastOne = isActive && activeCount <= 1;
                  const blocked = isActive && (isMe || lastOne);
                  return (
                    <tr key={r.id} className="border-b border-slate-100 last:border-0">
                      <td className="py-2.5 pr-3">
                        <p className="font-semibold text-slate-800">{r.name || "Operator"}{isMe && <span className="ml-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400">you</span>}</p>
                        <p className="font-mono text-[11px] text-slate-400">{r.email}</p>
                      </td>
                      <td className="py-2.5 pr-3">
                        <span className={`inline-block rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${isActive ? "bg-emerald-50 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>
                          {isActive ? "Active" : "Deactivated"}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 tabular-nums text-slate-500">{fmt(r.lastLoginAt)}</td>
                      <td className="py-2.5">
                        <div className="flex justify-end">
                          <button
                            onClick={() => (isActive ? setConfirming(r) : apply(r, true))}
                            disabled={busyId === r.id || blocked}
                            title={
                              isMe ? "You cannot deactivate your own operator account"
                                : lastOne ? "The last active operator cannot be deactivated"
                                  : isActive ? "Deactivate — ends their sessions immediately"
                                    : "Restore access"
                            }
                            className={`rounded-lg p-1.5 ring-1 transition disabled:cursor-not-allowed disabled:opacity-40 ${isActive ? "text-rose-500 ring-rose-200 hover:bg-rose-50" : "text-slate-500 ring-slate-200 hover:bg-slate-50"}`}
                          >
                            {busyId === r.id ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
          Deactivating ends that operator&rsquo;s open sessions straight away and keeps their account
          and its history, so past platform log entries still name a person. You cannot deactivate
          yourself, and the last active operator cannot be deactivated &mdash; there is no tier above
          this one to let anybody back in. New operators are created from the server command line.
        </p>
      </div>

      <Modal open={!!confirming} title={`Deactivate ${confirming?.email || ""}`} onClose={() => { setConfirming(null); setError(""); }} width={460}>
        {confirming && (
          <ConfirmDeactivateOperator
            operator={confirming}
            busy={busyId === confirming.id}
            error={error}
            onCancel={() => { setConfirming(null); setError(""); }}
            onConfirm={() => apply(confirming, false)}
          />
        )}
      </Modal>
    </div>
  );
}

// Same shape as ConfirmDelete above — warning banner, what happens, a red confirm and a
// Cancel — deliberately, so the two consequential actions on this screen look alike.
// It asks for no typed confirmation, which ConfirmDelete does require, because they are
// different kinds of action: deleting an institution destroys records and cannot be
// undone, while this one is a switch the next operator can flip back.
function ConfirmDeactivateOperator({ operator, busy, error, onConfirm, onCancel }) {
  return (
    <div className="flex flex-col gap-3">
      <Banner kind="warn">
        <strong>{operator.email}</strong> loses access to platform operations immediately &mdash; any
        session they already have open stops working on its next request, not when it expires.
      </Banner>
      <p className="text-sm text-slate-600">
        The account is kept, not deleted, so the platform log still shows what they did. Another
        operator can restore it from this panel.
      </p>
      {error && <Banner>{error}</Banner>}
      <div className="flex gap-2">
        <Btn tone="danger" onClick={onConfirm} disabled={busy} className="flex-1">
          {busy ? <><Loader2 size={16} className="animate-spin" /> Deactivating&hellip;</> : <><Power size={16} /> Deactivate</>}
        </Btn>
        <Btn tone="ghost" onClick={onCancel} disabled={busy}>Cancel</Btn>
      </div>
    </div>
  );
}


/* --------------------------------------------------------- server health ----- */

// Whether the SERVER itself is set up — the things an operator configures on the host
// and then has no way to confirm. Credential storage is first because it is the one
// that silently blocks a customer: without it a college's Settings screen refuses to
// save its Moodle token, and the only previous way to discover that was to sign in as
// that college.
function ServerHealth() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try { setData(await platformApi.health()); }
    catch (e) { setError(e.message || "Could not read server health."); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error) return <div className="mb-6"><Banner>{error}</Banner></div>;
  if (!data) return null;

  const c = data.credentials;
  const rows = [
    { label: "Credential storage", ok: c.working, note: c.note },
    { label: "Email", ok: !/not configured|console/i.test(data.email.configured), note: data.email.configured },
    { label: "File storage", ok: !/not configured/i.test(data.files.configured), note: data.files.configured },
    { label: "SharePoint", ok: !/not configured/i.test(data.sharePoint.configured), note: data.sharePoint.configured },
  ];

  return (
    <div className="mb-6 rounded-xl bg-white ring-1 ring-slate-200">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-slate-100 text-slate-500"><ServerCog size={17} /></div>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-slate-800">Server configuration</p>
          <p className="mt-0.5 text-[12px] text-slate-500">What this host is set up to do. Values are never shown, only whether they work.</p>
        </div>
        <Btn tone="ghost" onClick={load}><RefreshCw size={15} /> Recheck</Btn>
      </div>
      <div className="p-4">
        {rows.map((r) => (
          <div key={r.label} className="flex items-start gap-2 border-b border-slate-100 py-2 last:border-0">
            {r.ok
              ? <CheckCircle2 size={15} className="mt-0.5 flex-none text-emerald-600" />
              : <AlertTriangle size={15} className="mt-0.5 flex-none text-amber-600" />}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-800">{r.label}</p>
              <p className="text-[12px] text-slate-500">{r.note}</p>
            </div>
          </div>
        ))}
        <p className="mt-2 text-[11px] text-slate-400">
          Requests with no institution named resolve to <span className="font-mono">{data.tenantResolution.defaultSlug}</span>
          {data.tenantResolution.baseDomain
            ? <> · subdomains under <span className="font-mono">{data.tenantResolution.baseDomain}</span> resolve to that college</>
            : <> · subdomain resolution is off</>}
        </p>
      </div>
    </div>
  );
}


/* ------------------------------------------------------- two-step for me ----- */

// Enrolling an authenticator on the operator's OWN account.
//
// Offered rather than forced. Forcing it would lock out an operator with no
// authenticator to hand, and the platform tier is the one place where being locked
// out cannot be fixed from inside the product — it needs database access.
function TwoFactorPanel({ admin, onChanged }) {
  const [stage, setStage] = useState("idle");   // idle | password | code | off
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const begin = async (e) => {
    e.preventDefault();
    setBusy(true); setError("");
    try { setSetup(await platformApi.twoFactorSetup(password)); setStage("code"); setPassword(""); }
    catch (err) { setError(err.message || "Could not start setup."); }
    finally { setBusy(false); }
  };

  const finish = async (e) => {
    e.preventDefault();
    setBusy(true); setError("");
    try { await platformApi.twoFactorEnable(code.trim()); setStage("idle"); setCode(""); setSetup(null); await onChanged(); }
    catch (err) { setError(err.message || "Could not enable."); }
    finally { setBusy(false); }
  };

  const remove = async (e) => {
    e.preventDefault();
    setBusy(true); setError("");
    try { await platformApi.twoFactorDisable(password, code.trim()); setStage("idle"); setPassword(""); setCode(""); await onChanged(); }
    catch (err) { setError(err.message || "Could not remove."); }
    finally { setBusy(false); }
  };

  const on = !!admin?.totpEnabled;

  return (
    <div className="mb-6 rounded-xl bg-white ring-1 ring-slate-200">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className={`flex h-9 w-9 flex-none items-center justify-center rounded-lg ${on ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600"}`}>
          {on ? <ShieldCheck size={17} /> : <ShieldAlert size={17} />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-slate-800">Two-step verification</p>
          <p className="mt-0.5 text-[12px] text-slate-500">
            {on
              ? "On. Signing in needs your password and a code from your authenticator."
              : "Off. Your password alone can reach every institution on this system."}
          </p>
        </div>
        {stage === "idle" && (
          <Btn tone={on ? "ghost" : "amber"} onClick={() => setStage(on ? "off" : "password")}>
            {on ? "Turn off" : "Turn on"}
          </Btn>
        )}
        {stage !== "idle" && <Btn tone="ghost" onClick={() => { setStage("idle"); setError(""); setPassword(""); setCode(""); setSetup(null); }}>Cancel</Btn>}
      </div>

      {stage === "password" && (
        <form onSubmit={begin} className="flex flex-col gap-3 border-t border-slate-200 p-4">
          <p className="text-[12px] text-slate-500">Confirm your password to begin. This stops an unattended session from binding somebody else&rsquo;s authenticator to your account.</p>
          <Field label="Your password">
            <input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} autoComplete="current-password" required />
          </Field>
          {error && <Banner>{error}</Banner>}
          <Btn type="submit" disabled={busy}>{busy ? <Loader2 size={15} className="animate-spin" /> : null} Continue</Btn>
        </form>
      )}

      {stage === "code" && setup && (
        <form onSubmit={finish} className="flex flex-col gap-3 border-t border-slate-200 p-4">
          <p className="text-[12px] text-slate-500">
            Add this key to your authenticator app, then enter the code it shows. It is not switched on
            until a working code proves the app is set up correctly.
          </p>
          <div className="rounded-lg bg-slate-50 p-3 text-center ring-1 ring-slate-200">
            <p className="font-mono text-sm font-bold tracking-wider text-slate-800">{setup.secret}</p>
          </div>
          <Field label="Code from your app">
            <input className={inputCls + " text-center text-lg tracking-[0.4em]"} value={code} onChange={(e) => setCode(e.target.value)}
              disabled={busy} inputMode="numeric" autoComplete="one-time-code" maxLength={7} required />
          </Field>
          {error && <Banner>{error}</Banner>}
          <Btn type="submit" disabled={busy}>{busy ? <Loader2 size={15} className="animate-spin" /> : null} Turn on</Btn>
        </form>
      )}

      {stage === "off" && (
        <form onSubmit={remove} className="flex flex-col gap-3 border-t border-slate-200 p-4">
          <Banner kind="warn">Removing this leaves your password as the only thing protecting every institution on this system.</Banner>
          <Field label="Your password">
            <input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} autoComplete="current-password" required />
          </Field>
          <Field label="Current code from your app">
            <input className={inputCls + " text-center text-lg tracking-[0.4em]"} value={code} onChange={(e) => setCode(e.target.value)}
              disabled={busy} inputMode="numeric" maxLength={7} required />
          </Field>
          {error && <Banner>{error}</Banner>}
          <Btn type="submit" tone="danger" disabled={busy}>{busy ? <Loader2 size={15} className="animate-spin" /> : null} Turn off</Btn>
        </form>
      )}
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

        <TwoFactorPanel admin={admin} onChanged={async () => { try { const me = await platformApi.me(); setAdmin(me.admin); } catch { /* the panel simply keeps its last state */ } }} />

        <ServerHealth />

        <UsagePanel />

        <OperatorsPanel me={admin} onError={setError} onNotice={setNotice} />

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
