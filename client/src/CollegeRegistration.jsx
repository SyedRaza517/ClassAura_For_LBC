// College registration — the public front door for an organisation that wants to join.
//
// Two halves, because joining is two separate events with a decision by us in between:
//
//   Apply    — an organisation tells us who they are. This grants nothing at all.
//   Activate — once we have approved them and issued an access code, they redeem it,
//              choose their own password, and their institution is created.
//
// Deliberately black and white, like the platform dashboard: this is OUR surface, not a
// college's, and a college can now choose its own colours — so colour is no longer a
// reliable signal of which product you are looking at. Monochrome is.
import React, { useState } from "react";
import { API_BASE } from "./api";
import {
  Building2, Send, KeyRound, Loader2, CheckCircle2, AlertTriangle, ArrowLeft, ArrowRight, Copy, Check,
} from "lucide-react";

const inputCls =
  "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none transition focus:border-black focus:ring-2 focus:ring-neutral-300 disabled:opacity-60";

function Field({ label, children, hint, required }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-neutral-600">
        {label}{required && <span className="ml-0.5 text-neutral-400">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-neutral-500">{hint}</span>}
    </label>
  );
}

const post = async (path, body) => {
  const res = await fetch(API_BASE.replace(/\/$/, "") + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(data?.error || `Something went wrong (${res.status}).`);
  return data;
};

/* ------------------------------------------------------------------ apply --- */

function ApplyForm({ onDone }) {
  const [f, setF] = useState({
    legalName: "", tradingName: "", institutionType: "", registrationNumber: "",
    website: "", addressLines: "", country: "United Kingdom",
    approxStaff: "", approxStudents: "",
    contactName: "", contactRole: "", contactEmail: "", contactPhone: "",
    requestedSlug: "", notes: "", website2: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError("");
    try { await post("/registrations", f); onDone(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <section>
        <h2 className="mb-3 text-sm font-extrabold uppercase tracking-wide text-neutral-600">Your institution</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Legal name" required hint="As registered — this is the name that appears on your letters.">
              <input className={inputCls} value={f.legalName} onChange={set("legalName")} disabled={busy} required maxLength={200} />
            </Field>
          </div>
          <Field label="Trading name" hint="If you are known by something shorter.">
            <input className={inputCls} value={f.tradingName} onChange={set("tradingName")} disabled={busy} maxLength={200} />
          </Field>
          <Field label="Type of institution">
            <select className={inputCls} value={f.institutionType} onChange={set("institutionType")} disabled={busy}>
              <option value="">Choose…</option>
              <option value="fe">Further education college</option>
              <option value="he">Higher education / university</option>
              <option value="private">Private provider</option>
              <option value="training">Training provider</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="Registration number" hint="Companies House, charity number or UKPRN — whichever identifies you.">
            <input className={inputCls} value={f.registrationNumber} onChange={set("registrationNumber")} disabled={busy} maxLength={80} />
          </Field>
          <Field label="Website">
            <input className={inputCls} value={f.website} onChange={set("website")} disabled={busy} placeholder="https://" maxLength={200} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Address">
              <textarea rows={2} className={inputCls} value={f.addressLines} onChange={set("addressLines")} disabled={busy} maxLength={500} />
            </Field>
          </div>
          <Field label="Country">
            <input className={inputCls} value={f.country} onChange={set("country")} disabled={busy} maxLength={80} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Approx. staff">
              <input type="number" min={0} className={inputCls} value={f.approxStaff} onChange={set("approxStaff")} disabled={busy} />
            </Field>
            <Field label="Approx. students">
              <input type="number" min={0} className={inputCls} value={f.approxStudents} onChange={set("approxStudents")} disabled={busy} />
            </Field>
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-extrabold uppercase tracking-wide text-neutral-600">Who we should speak to</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Full name" required>
            <input className={inputCls} value={f.contactName} onChange={set("contactName")} disabled={busy} required maxLength={160} />
          </Field>
          <Field label="Role" hint="e.g. Principal, Head of Admissions.">
            <input className={inputCls} value={f.contactRole} onChange={set("contactRole")} disabled={busy} maxLength={120} />
          </Field>
          <Field label="Email address" required hint="Your access code is tied to this address, and it becomes your first administrator account.">
            <input type="email" className={inputCls} value={f.contactEmail} onChange={set("contactEmail")} disabled={busy} required maxLength={200} />
          </Field>
          <Field label="Phone">
            <input className={inputCls} value={f.contactPhone} onChange={set("contactPhone")} disabled={busy} maxLength={60} />
          </Field>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-extrabold uppercase tracking-wide text-neutral-600">Anything else</h2>
        <div className="grid gap-3">
          <Field label="Preferred web address" hint="Lower-case letters, numbers and hyphens. We will tell you if it is taken.">
            <input className={inputCls} value={f.requestedSlug} onChange={set("requestedSlug")} disabled={busy} placeholder="your-college" maxLength={32} />
          </Field>
          <Field label="Notes">
            <textarea rows={3} className={inputCls} value={f.notes} onChange={set("notes")} disabled={busy} maxLength={2000}
              placeholder="Anything that would help us review your application." />
          </Field>
        </div>
      </section>

      {/* Honeypot: no human sees this, and a bot that fills it in gets the same reply as
          everyone else while nothing is stored. Hidden from assistive technology too. */}
      <div className="hidden" aria-hidden="true">
        <label>Do not fill this in<input tabIndex={-1} autoComplete="off" value={f.website2} onChange={set("website2")} /></label>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800 ring-1 ring-rose-200">
          <AlertTriangle size={15} className="mt-0.5 flex-none" /> {error}
        </div>
      )}

      <button type="submit" disabled={busy}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-black px-4 py-2.5 text-sm font-bold text-white transition hover:bg-neutral-800 disabled:opacity-60">
        {busy ? <><Loader2 size={16} className="animate-spin" /> Sending…</> : <><Send size={16} /> Send application</>}
      </button>
      <p className="text-[11px] leading-relaxed text-neutral-500">
        Sending this does not create an account. We review each application, and if we accept yours we will issue
        an access code to the email address above. Nothing exists until you redeem that code.
      </p>
    </form>
  );
}

/* --------------------------------------------------------------- activate --- */

function ActivateForm({ onDone }) {
  const [f, setF] = useState({ email: "", code: "", password: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (f.password.length < 12) { setError("Choose a password of at least 12 characters."); return; }
    if (f.password !== f.confirm) { setError("The two passwords do not match."); return; }
    setBusy(true);
    try { onDone(await post("/registrations/activate", { email: f.email, code: f.code, password: f.password })); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-sm text-neutral-700">
        Enter the access code we sent you, along with the email address you applied with. You choose your own
        password here — we never see it.
      </p>
      <Field label="Email address you applied with" required>
        <input type="email" className={inputCls} value={f.email} onChange={set("email")} disabled={busy} required />
      </Field>
      <Field label="Access code" required hint="Three groups of four characters.">
        <input className={inputCls + " text-center font-mono text-lg tracking-[0.2em] uppercase"} value={f.code}
          onChange={set("code")} disabled={busy} required placeholder="XXXX-XXXX-XXXX" maxLength={20} />
      </Field>
      <Field label="Choose a password" required hint="At least 12 characters. This becomes your administrator account.">
        <input type="password" className={inputCls} value={f.password} onChange={set("password")} disabled={busy} required autoComplete="new-password" />
      </Field>
      <Field label="Confirm password" required>
        <input type="password" className={inputCls} value={f.confirm} onChange={set("confirm")} disabled={busy} required autoComplete="new-password" />
      </Field>

      {error && (
        <div className="flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800 ring-1 ring-rose-200">
          <AlertTriangle size={15} className="mt-0.5 flex-none" /> {error}
        </div>
      )}

      <button type="submit" disabled={busy}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-black px-4 py-2.5 text-sm font-bold text-white transition hover:bg-neutral-800 disabled:opacity-60">
        {busy ? <><Loader2 size={16} className="animate-spin" /> Setting up…</> : <><KeyRound size={16} /> Set up my institution</>}
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------ page ---- */

export default function CollegeRegistration({ onBack }) {
  const [tab, setTab] = useState("apply");
  const [sent, setSent] = useState(false);
  const [done, setDone] = useState(null);
  const [copied, setCopied] = useState(false);

  // Built from where they already are, so it is correct on staging, on production and on
  // a custom domain without anything being configured per environment.
  const signInUrl = done && typeof window !== "undefined"
    ? `${window.location.origin}${window.location.pathname}?tenant=${encodeURIComponent(done.slug)}`
    : "";

  return (
    <div className="min-h-screen bg-neutral-100" style={{ fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}>
      <header className="border-b border-neutral-800 bg-black px-4 py-4 text-white sm:px-6">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <Building2 size={20} />
          <div className="flex-1">
            <h1 className="text-base font-extrabold leading-tight">College registration</h1>
            <p className="text-[12px] text-neutral-400">Join the platform, or set up an institution you have been approved for.</p>
          </div>
          {onBack && (
            <button onClick={onBack} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-neutral-300 transition hover:bg-neutral-800">
              <ArrowLeft size={14} /> Back
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        {done ? (
          <div className="rounded-xl bg-white p-8 ring-1 ring-neutral-300">
            <div className="text-center">
              <CheckCircle2 size={34} className="mx-auto mb-3 text-black" />
              <h2 className="text-lg font-extrabold text-black">{done.name} is set up</h2>
              <p className="mx-auto mt-2 max-w-md text-sm text-neutral-700">
                Sign in with <b>{done.email}</b> and the password you just chose.
              </p>
            </div>

            {/* The sign-in link MUST name the institution.
                Several colleges share one hostname, so a plain link resolves to whichever
                institution the server treats as its default — and the new administrator is
                told "invalid email or password" when in fact their password was right and
                only the college was missing. That is the worst possible message at the worst
                possible moment, so the address is spelled out here rather than assumed. */}
            <div className="mt-6 rounded-lg bg-neutral-100 p-4 ring-1 ring-neutral-300">
              <p className="text-[11px] font-bold uppercase tracking-wide text-neutral-600">Your sign-in address</p>
              <p className="mt-1 break-all font-mono text-[13px] font-semibold text-black">{signInUrl}</p>
              <p className="mt-2 text-[12px] text-neutral-600">
                Use this link the first time. It tells the app which institution you are, and your browser
                remembers it afterwards. Bookmark it and share it with your colleagues.
              </p>
              <button
                type="button"
                onClick={() => { try { navigator.clipboard.writeText(signInUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard blocked — the address is on screen to copy by hand */ } }}
                className="mt-3 inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-[12px] font-semibold text-neutral-800 ring-1 ring-neutral-400 transition hover:bg-white"
              >
                {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy link</>}
              </button>
            </div>

            <p className="mt-4 text-center text-[13px] text-neutral-700">
              Your first stop should be <b>Settings → Connected systems → Email</b>. Until you set your own
              mailbox, nothing is emailed to your applicants or students — not even password resets.
            </p>

            <div className="mt-5 text-center">
              <a href={signInUrl}
                className="inline-flex items-center gap-2 rounded-lg bg-black px-4 py-2 text-sm font-bold text-white transition hover:bg-neutral-800">
                Go to sign in <ArrowRight size={15} />
              </a>
            </div>
          </div>
        ) : sent ? (
          <div className="rounded-xl bg-white p-8 text-center ring-1 ring-neutral-300">
            <CheckCircle2 size={34} className="mx-auto mb-3 text-black" />
            <h2 className="text-lg font-extrabold text-black">Thank you — we have your application</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-neutral-700">
              We review each one by hand. If we accept yours, we will send an access code to the email address you
              gave us. Come back to this page and use <b>I have an access code</b> to finish setting up.
            </p>
            <button onClick={() => { setSent(false); setTab("activate"); }}
              className="mt-5 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-neutral-800 ring-1 ring-neutral-400 transition hover:bg-neutral-100">
              I already have a code
            </button>
          </div>
        ) : (
          <>
            <div className="mb-5 flex gap-1.5">
              {[["apply", "Apply to join"], ["activate", "I have an access code"]].map(([k, label]) => (
                <button key={k} onClick={() => setTab(k)}
                  className={`rounded-lg px-3.5 py-2 text-[13px] font-semibold transition ${
                    tab === k ? "bg-black text-white" : "bg-white text-neutral-700 ring-1 ring-neutral-300 hover:bg-neutral-100"}`}>
                  {label}
                </button>
              ))}
            </div>

            <div className="rounded-xl bg-white p-5 ring-1 ring-neutral-300 sm:p-6">
              {tab === "apply"
                ? <ApplyForm onDone={() => setSent(true)} />
                : <ActivateForm onDone={setDone} />}
            </div>
          </>
        )}

        <p className="mt-6 text-center text-[11px] leading-relaxed text-neutral-500">
          Access is granted in two steps on purpose: we approve your organisation, and you prove the code reached
          you. Neither step alone creates anything.
        </p>
      </main>
    </div>
  );
}
