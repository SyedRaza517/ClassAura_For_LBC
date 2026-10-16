// Student Portal — a prospective student (applicant) registers, signs in, and tracks their
// application end to end: fill/edit the application form, upload documents, see the offer
// letter, and see their interview call + outcome and overall progress.
//
// This is a standalone top-level area (like AdmissionApply/AdmissionUpload), reached from
// the "Student Portal" tile on the Landing screen. ApplicantAuth is shown before login;
// ApplicantPortal (default export) once signed in (user.kind === "applicant"). All data
// comes from /api/applicant/* — every call is scoped by the server to the caller's own
// Admission record.
import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  GraduationCap, LogOut, Loader2, CheckCircle2, Circle, Clock, FileText, Upload, RefreshCw,
  ClipboardList, Award, CalendarClock, Download, ArrowRight, ArrowLeft, AlertCircle, Save,
  ShieldCheck, Mail, Sparkles, MapPin, Video, PartyPopper, Eye, EyeOff,
} from "lucide-react";
import { useAuth } from "./auth";
import { api } from "./api";
import { BrandLockup } from "./Brand";
import { ADMISSION_SECTIONS, ADMISSION_REQUIRED } from "./admissionSections";

import { NAVY, NAVY_DARK, MAROON } from "./branding";
// TEAL is the student/applicant portal's own accent, not the institution's brand —
// it distinguishes the public applicant surface from the staff app and stays fixed.
const TEAL = "#0f766e", TEAL_LT = "#14b8a6";
const FONT = "'Plus Jakarta Sans', system-ui, sans-serif";

const inputCls = "w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20";

function Field({ label, hint, required, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-bold text-slate-600">{label}{required && <span className="text-rose-500"> *</span>}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-snug text-slate-500">{hint}</span>}
    </label>
  );
}

function PrimaryBtn({ children, onClick, disabled, type = "button", className = "", tone = "teal" }) {
  const bg = tone === "navy" ? `linear-gradient(135deg, ${NAVY}, #4a63cf)` : `linear-gradient(135deg, ${TEAL}, ${TEAL_LT})`;
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className={`press inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold text-white shadow-sm transition disabled:opacity-50 ${className}`}
      style={{ background: bg }}>
      {children}
    </button>
  );
}
function GhostBtn({ children, onClick, disabled, className = "" }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`press inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50 ${className}`}>
      {children}
    </button>
  );
}

const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
};
const outcomeLabel = (o) => (o === "Yes" ? "Successful" : o === "No" ? "Not successful this time" : o === "May Be" ? "Under review" : "");

/* ============================================================= *
 *  ApplicantAuth — register / sign in (shown before login)      *
 * ============================================================= */
export function ApplicantAuth({ onBack }) {
  const { signIn, applySession } = useAuth();
  const [mode, setMode] = useState("register"); // "register" | "signin"
  const [f, setF] = useState({ firstName: "", surname: "", email: "", password: "", confirmPassword: "" });
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [emailTaken, setEmailTaken] = useState(false);
  const set = (k) => (e) => { setF((s) => ({ ...s, [k]: e.target.value })); setErr(""); if (k === "email") setEmailTaken(false); };

  // Light live check so a taken email is flagged before submit (server is the authority).
  const checkEmail = async () => {
    if (mode !== "register" || !f.email) return;
    try { const r = await api.applicantCheckEmail(f.email); setEmailTaken(r.valid && !r.available); } catch { /* ignore */ }
  };

  const submit = async (e) => {
    e?.preventDefault();
    setErr(""); setBusy(true);
    try {
      if (mode === "register") {
        const res = await api.applicantRegister(f);
        applySession(res); // auto sign-in → App routes to the portal
      } else {
        const res = await signIn(f.email.trim(), f.password);
        if (!res.ok) setErr(res.error || "Could not sign in. Please check your details.");
      }
    } catch (e2) {
      setErr(e2.message || "Something went wrong. Please try again.");
    }
    setBusy(false);
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-4" style={{ fontFamily: FONT }}>
      <div className="animated-gradient absolute inset-0" style={{ background: `linear-gradient(135deg, ${NAVY_DARK} 0%, ${TEAL} 45%, ${TEAL_LT} 75%, ${NAVY} 100%)`, backgroundSize: "220% 220%" }} />
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="float absolute -top-24 -left-24 h-80 w-80 rounded-full blur-3xl" style={{ background: "rgba(20,184,166,0.35)" }} />
        <div className="float-slow absolute -bottom-28 right-1/4 h-80 w-80 rounded-full blur-3xl" style={{ background: "rgba(73,99,205,0.30)", animationDelay: "1.4s" }} />
      </div>

      <div className="relative w-full max-w-md">
        <button onClick={onBack} className="press mb-4 inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-1.5 text-xs font-bold text-white backdrop-blur hover:bg-white/25">
          <ArrowLeft size={14} /> Back
        </button>
        {/* p-7 is 28px a side, which on a 320px handset spends 56px of a 288px card on
            nothing. Stepped down at base and restored from sm: up, so the roomy desktop
            card is unchanged and only the small phone gets the narrower gutter. */}
        <div className="scale-in rounded-3xl bg-white/95 p-5 shadow-2xl ring-1 ring-black/5 backdrop-blur-xl sm:p-7">
          <div className="mb-5 flex flex-col items-center text-center">
            <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl text-white shadow-lg" style={{ background: `linear-gradient(135deg, ${TEAL}, ${TEAL_LT})` }}>
              <GraduationCap size={26} />
            </div>
            <h1 className="text-xl font-extrabold tracking-tight text-slate-800">Student Portal</h1>
            <p className="mt-0.5 text-xs text-slate-500">EdTech · applications & admissions</p>
          </div>

          <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
            {[["register", "Register"], ["signin", "Sign in"]].map(([m, lbl]) => (
              <button key={m} onClick={() => { setMode(m); setErr(""); }}
                className={`rounded-lg py-2 text-sm font-bold transition ${mode === m ? "bg-white text-teal-700 shadow-sm" : "text-slate-500"}`}>{lbl}</button>
            ))}
          </div>

          {err && <div className="mb-4 flex items-start gap-2 rounded-xl bg-rose-50 px-3.5 py-2.5 text-[13px] font-semibold text-rose-700 ring-1 ring-rose-200"><AlertCircle size={15} className="mt-px shrink-0" />{err}</div>}

          <form onSubmit={submit} className="flex flex-col gap-3.5">
            {mode === "register" && (
              // One column at base, two from sm: up. Two text inputs side by side inside a
              // 288px card leave about 110px each once the gutter and gap are taken out, and
              // an <input> carries a browser-default intrinsic width (the `size` attribute)
              // that `w-full` alone does not stop from contributing to the grid's minimum —
              // so the row pushed the card wide on a 320px phone. Keeping two columns and
              // merely shrinking the type was rejected: a name field you cannot see what you
              // typed in is the first thing an applicant meets, and this is the registration
              // screen for a member of the public on whatever handset they own.
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="First name" required><input className={inputCls} value={f.firstName} onChange={set("firstName")} autoComplete="given-name" /></Field>
                <Field label="Surname" required><input className={inputCls} value={f.surname} onChange={set("surname")} autoComplete="family-name" /></Field>
              </div>
            )}
            <Field label="Email address" required hint={emailTaken ? undefined : "You'll use this to sign in."}>
              <input className={inputCls} type="email" value={f.email} onChange={set("email")} onBlur={checkEmail} autoComplete="email" />
              {emailTaken && <span className="mt-1 block text-[11px] font-semibold text-rose-600">This email is already registered — please sign in, or use a different email.</span>}
            </Field>
            <Field label="Password" required hint={mode === "register" ? "At least 8 characters." : undefined}>
              <div className="relative">
                <input className={`${inputCls} pr-10`} type={showPw ? "text" : "password"} value={f.password} onChange={set("password")} autoComplete={mode === "register" ? "new-password" : "current-password"} />
                <button type="button" onClick={() => setShowPw((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-600">{showPw ? <EyeOff size={16} /> : <Eye size={16} />}</button>
              </div>
            </Field>
            {mode === "register" && (
              <Field label="Confirm password" required><input className={inputCls} type={showPw ? "text" : "password"} value={f.confirmPassword} onChange={set("confirmPassword")} autoComplete="new-password" /></Field>
            )}
            <PrimaryBtn type="submit" disabled={busy} className="mt-1 w-full">
              {busy ? <><Loader2 size={16} className="animate-spin" /> Please wait…</> : mode === "register" ? <>Create account & start <ArrowRight size={16} /></> : <>Sign in <ArrowRight size={16} /></>}
            </PrimaryBtn>
          </form>

          <p className="mt-4 text-center text-[11px] text-slate-500">
            {mode === "register"
              ? <>Already registered? <button onClick={() => setMode("signin")} className="font-bold text-teal-700">Sign in</button></>
              : <>New here? <button onClick={() => setMode("register")} className="font-bold text-teal-700">Create an account</button></>}
          </p>
        </div>
      </div>
    </div>
  );
}

/* ============================================================= *
 *  Progress stepper                                             *
 * ============================================================= */
function Stepper({ p }) {
  const stages = [
    { label: "Registered", state: "done", hint: "Account created" },
    { label: "Application", state: p.applicationSubmitted ? "done" : "current", hint: p.applicationSubmitted ? "Submitted" : "In progress" },
    { label: "Documents", state: p.docsTotal > 0 && p.docsUploaded === p.docsTotal ? "done" : (p.docsUploaded > 0 ? "current" : "todo"), hint: `${p.docsUploaded}/${p.docsTotal} uploaded` },
    { label: "Interview", state: p.interviewOutcome ? "done" : (p.interviewInvited ? "current" : "todo"), hint: p.interviewOutcome ? outcomeLabel(p.interviewOutcome) : (p.interviewInvited ? "Scheduled" : "Pending") },
    { label: "Offer", state: p.offerStatus === "accepted" ? "done" : (p.offerStatus ? "current" : "todo"), hint: p.offerStatus === "accepted" ? "Accepted" : (p.offerStatus ? "Received" : "Pending") },
    { label: "Enrolment", state: p.enrolled ? "done" : (p.enrollStatus === "Rejected" ? "rejected" : "todo"), hint: p.enrolled ? "Enrolled" : (p.enrollStatus || "Pending") },
  ];
  const dot = (st) => st === "done" ? "bg-teal-600 text-white" : st === "current" ? "bg-amber-400 text-white" : st === "rejected" ? "bg-rose-500 text-white" : "bg-slate-200 text-slate-400";
  return (
    <div className="flex flex-wrap gap-2">
      {stages.map((s, i) => (
        <div key={i} className="flex min-w-[120px] flex-1 items-center gap-2.5 rounded-xl border border-slate-100 bg-white px-3 py-2.5 shadow-sm">
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-extrabold ${dot(s.state)}`}>
            {s.state === "done" ? <CheckCircle2 size={16} /> : i + 1}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-bold text-slate-700">{s.label}</p>
            <p className="truncate text-[11px] text-slate-500">{s.hint}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ============================================================= *
 *  Application form field                                       *
 * ============================================================= */
function FormField({ f, value, onChange, courses, intakes }) {
  const common = { className: inputCls, value: value ?? "", onChange: (e) => onChange(f.key, e.target.value) };
  let control;
  if (f.type === "select") {
    const opts = f.key === "course" ? (courses.length ? courses : f.options || []) : f.key === "intake" ? (intakes.length ? intakes : f.options || []) : (f.options || []);
    control = (
      <select {...common}>
        <option value="">Please select…</option>
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  } else if (f.type === "textarea") {
    control = <textarea {...common} rows={3} className={`${inputCls} resize-y`} />;
  } else {
    control = <input {...common} type={f.type === "date" ? "date" : f.type === "email" ? "email" : f.type === "tel" ? "tel" : "text"} />;
  }
  // min-w-0 is not decoration. A <select> or an <input> has an intrinsic width of its
  // own — Chrome sizes a select to its widest option, and this form's options run to
  // "Two evenings online - 6 p.m.-9 p.m. (6hrs) plus One day In-Campus 10 a.m. - 5 p.m.
  // (6hrs)" — and a grid child defaults to `min-width: auto`, which is that intrinsic
  // width rather than zero. The control therefore refused to shrink below its widest
  // option and spilled the card sideways on a 320px screen however many `w-full`s were
  // on it. min-w-0 lets the cell shrink to the track and `w-full` then does the work.
  return <div className={`min-w-0 ${f.span === 2 ? "sm:col-span-2" : ""}`}><Field label={f.label} hint={f.hint} required={f.required}>{control}</Field></div>;
}

/* ============================================================= *
 *  ApplicantPortal — the logged-in portal (default export)      *
 * ============================================================= */
export default function ApplicantPortal({ user, logout }) {
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState("overview");
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try { setMe(await api.applicantMe()); }
    catch (e) { setErr(e.message || "Could not load your application."); }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const flash = (msg, tone = "success") => { setToast({ msg, tone }); setTimeout(() => setToast(null), 3200); };

  if (loading) return (
    <div className="flex min-h-screen items-center justify-center" style={{ fontFamily: FONT, background: "radial-gradient(1200px 600px at 50% -10%, #e7f5f3 0%, #f1f5f9 45%, #eef1f6 100%)" }}>
      <div className="flex flex-col items-center gap-3 text-slate-500"><Loader2 size={30} className="animate-spin text-teal-600" /><p className="text-sm font-semibold">Loading your portal…</p></div>
    </div>
  );

  const TABS = [
    { key: "overview", label: "Overview", Icon: ClipboardList },
    { key: "application", label: "Application", Icon: FileText },
    { key: "documents", label: "Documents", Icon: Upload },
    { key: "interview", label: "Interview", Icon: CalendarClock },
    { key: "offer", label: "Offer", Icon: Award },
  ];

  return (
    <div className="min-h-screen" style={{ fontFamily: FONT, background: "radial-gradient(1200px 600px at 50% -10%, #e7f5f3 0%, #f1f5f9 45%, #eef1f6 100%)" }}>
      {/* Top bar.
          pt-safe-top, not a magic number. index.html sets viewport-fit=cover, so on a
          notched iPhone the top of a sticky top-0 bar sits underneath the status bar and
          the applicant's own name is the thing hidden by it. env(safe-area-inset-top) is
          0 everywhere else, which is why this is additive rather than a handset branch. */}
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 pt-safe-top backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl text-white shadow-sm" style={{ background: `linear-gradient(135deg, ${TEAL}, ${TEAL_LT})` }}><GraduationCap size={18} /></div>
          <div className="mr-auto min-w-0">
            <p className="truncate text-sm font-extrabold text-slate-800">Student Portal</p>
            <p className="truncate text-[11px] text-slate-500">{me?.name || user?.name}</p>
          </div>
          <button onClick={logout} className="press inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"><LogOut size={14} /> Sign out</button>
        </div>
        <nav className="mx-auto flex max-w-4xl gap-1 overflow-x-auto px-3 pb-2">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-bold transition ${tab === t.key ? "bg-teal-600 text-white shadow-sm" : "text-slate-500 hover:bg-slate-100"}`}>
              <t.Icon size={14} /> {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-6">
        {err && <div className="mb-4 flex items-start gap-2 rounded-xl bg-rose-50 px-3.5 py-3 text-sm font-semibold text-rose-700 ring-1 ring-rose-200"><AlertCircle size={16} className="mt-px shrink-0" />{err}</div>}
        {me && tab === "overview" && <Overview me={me} go={setTab} />}
        {me && tab === "application" && <ApplicationTab me={me} onSaved={(m) => { setMe(m); }} flash={flash} />}
        {me && tab === "documents" && <DocumentsTab me={me} onChange={(docs) => setMe((s) => ({ ...s, documents: docs, progress: { ...s.progress, docsUploaded: docs.filter((d) => d.uploaded).length } }))} flash={flash} />}
        {me && tab === "interview" && <InterviewTab me={me} />}
        {me && tab === "offer" && <OfferTab me={me} onAccepted={(m) => setMe(m)} flash={flash} />}
      </main>

      {toast && (
        // Capped and centred rather than left to its own width: a flash message can be a
        // server error sentence, and at 320px an uncapped one ran off both edges. The cap
        // is calc(100% - 2rem) of the viewport — not 100vw, which counts a desktop
        // scrollbar and so can itself be a source of horizontal scroll. The bottom offset
        // clears the home indicator on a notched iPhone; env() is 0 everywhere else.
        <div className="fixed left-1/2 z-50 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-xl px-4 py-2.5 text-center text-sm font-bold text-white shadow-lg"
          style={{ background: toast.tone === "error" ? MAROON : TEAL, bottom: "calc(1.25rem + env(safe-area-inset-bottom))" }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

/* ---------- Overview ---------- */
function Overview({ me, go }) {
  const p = me.progress;
  const next = !p.applicationSubmitted ? { label: "Complete your application", tab: "application", Icon: FileText }
    : p.docsUploaded < p.docsTotal ? { label: "Upload your documents", tab: "documents", Icon: Upload }
    : p.offerStatus && p.offerStatus !== "accepted" ? { label: "Review & accept your offer", tab: "offer", Icon: Award }
    : null;
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <Sparkles size={16} className="text-teal-600" />
          <h2 className="text-sm font-extrabold uppercase tracking-wide text-slate-500">Your application progress</h2>
        </div>
        <Stepper p={p} />
      </div>

      {next && (
        <button onClick={() => go(next.tab)} className="press flex items-center gap-3 rounded-2xl p-4 text-left text-white shadow-sm" style={{ background: `linear-gradient(135deg, ${TEAL}, ${TEAL_LT})` }}>
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/20"><next.Icon size={20} /></span>
          <div className="mr-auto">
            <p className="text-[11px] font-bold uppercase tracking-wide text-white/70">Next step</p>
            <p className="text-[15px] font-extrabold">{next.label}</p>
          </div>
          <ArrowRight size={20} />
        </button>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <SummaryCard Icon={FileText} label="Application" value={p.applicationSubmitted ? "Submitted" : "Draft — not submitted"} tone={p.applicationSubmitted ? "good" : "warn"} onClick={() => go("application")} />
        <SummaryCard Icon={Upload} label="Documents" value={`${p.docsUploaded} of ${p.docsTotal} uploaded`} tone={p.docsUploaded === p.docsTotal && p.docsTotal > 0 ? "good" : "warn"} onClick={() => go("documents")} />
        <SummaryCard Icon={CalendarClock} label="Interview" value={p.interviewOutcome ? outcomeLabel(p.interviewOutcome) : (p.interviewInvited ? "Scheduled" : "Not scheduled yet")} tone={p.interviewOutcome === "Yes" ? "good" : p.interviewInvited ? "info" : "muted"} onClick={() => go("interview")} />
        <SummaryCard Icon={Award} label="Offer" value={p.offerStatus === "accepted" ? "Accepted" : p.offerStatus === "sent" ? "Offer received" : "Not issued yet"} tone={p.offerStatus ? "good" : "muted"} onClick={() => go("offer")} />
      </div>

      {p.enrolled && (
        <div className="flex items-start gap-3 rounded-2xl bg-emerald-50 p-4 text-emerald-800 ring-1 ring-emerald-200">
          <PartyPopper size={22} className="mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-bold">Congratulations — you've been enrolled!</p>
            {p.inductionDate
              ? <p className="mt-0.5 text-[13px] font-semibold">Your induction is on {fmtDate(p.inductionDate)}{p.inductionTime ? ` at ${p.inductionTime}` : ""} — EdTech. Please bring photo ID.</p>
              : <p className="mt-0.5 text-[13px]">The admissions team will be in touch with your next steps.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
function SummaryCard({ Icon, label, value, tone, onClick }) {
  const ring = tone === "good" ? "ring-emerald-200" : tone === "warn" ? "ring-amber-200" : tone === "info" ? "ring-sky-200" : "ring-slate-200";
  const col = tone === "good" ? "text-emerald-600" : tone === "warn" ? "text-amber-600" : tone === "info" ? "text-sky-600" : "text-slate-400";
  return (
    <button onClick={onClick} className={`press flex items-center gap-3 rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ${ring}`}>
      <span className={`flex h-10 w-10 items-center justify-center rounded-xl bg-slate-50 ${col}`}><Icon size={18} /></span>
      <div className="min-w-0">
        <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
        <p className="truncate text-[14px] font-extrabold text-slate-700">{value}</p>
      </div>
    </button>
  );
}

/* ---------- Application ---------- */
function ApplicationTab({ me, onSaved, flash }) {
  const [form, setForm] = useState(() => ({ ...me.application, email: me.application.email || me.email }));
  const [courses, setCourses] = useState([]);
  const [intakes, setIntakes] = useState([]);
  const [busy, setBusy] = useState("");
  const [missing, setMissing] = useState([]);
  const set = (k, v) => setForm((s) => ({ ...s, [k]: v }));

  useEffect(() => {
    api.applicationCourses().then(setCourses).catch(() => {});
    api.applicationIntakes().then(setIntakes).catch(() => {});
  }, []);

  const save = async (submit) => {
    setBusy(submit ? "submit" : "save"); setMissing([]);
    try {
      if (submit) {
        const gaps = ADMISSION_REQUIRED.filter((k) => !String(form[k] || "").trim());
        if (gaps.length) { setMissing(gaps); setBusy(""); flash(`Please complete ${gaps.length} required field${gaps.length === 1 ? "" : "s"}.`, "error"); return; }
        onSaved(await api.submitApplicantApplication(form));
        flash("Application submitted — thank you!");
      } else {
        onSaved(await api.saveApplicantApplication(form));
        flash("Saved.");
      }
    } catch (e) { flash(e.message || "Could not save.", "error"); }
    setBusy("");
  };

  const submitted = me.progress.applicationSubmitted;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <div className="mr-auto">
          <h2 className="text-base font-extrabold text-slate-800">Application form</h2>
          <p className="text-[12px] text-slate-500">{submitted ? "Submitted — you can still update your details below." : "Fill in your details and submit when you're ready."}</p>
        </div>
        {submitted && <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700 ring-1 ring-emerald-200"><CheckCircle2 size={13} /> Submitted</span>}
        {me.progress.applicationSubmitted && <GhostBtn onClick={() => api.downloadApplicantApplication(`Application - ${me.name}.pdf`).catch((e) => flash(e.message, "error"))}><Download size={15} /> PDF</GhostBtn>}
      </div>

      {missing.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3.5 py-3 text-[13px] font-semibold text-amber-800 ring-1 ring-amber-200">
          <AlertCircle size={15} className="mt-px shrink-0" /> Please complete the highlighted required fields before submitting.
        </div>
      )}

      {ADMISSION_SECTIONS.map((sec) => (
        <div key={sec.title} className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-extrabold" style={{ color: NAVY_DARK }}>{sec.title}</h3>
          {sec.note && <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{sec.note}</p>}
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {sec.fields.map((f) => (
              <div key={f.key} className={`min-w-0 ${f.span === 2 ? "sm:col-span-2" : ""} ${missing.includes(f.key) ? "rounded-xl ring-2 ring-rose-300" : ""}`} style={missing.includes(f.key) ? { padding: 2 } : undefined}>
                <FormField f={f} value={form[f.key]} onChange={set} courses={courses} intakes={intakes} />
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* The submit bar is pinned to the bottom of the scrollport, which on a notched
          iPhone is behind the home indicator — i.e. "Submit application" was the one
          control the gesture area sat on. The offset is written inline, as calc() over
          env(), because that is how the sibling public pages (AdmissionApply's Shell and
          friends) already do it, and because a Tailwind `bottom-safe-bottom` would read
          as 0 on every phone without a notch and lose the 12px lift the design has. */}
      <div className="sticky flex flex-wrap justify-end gap-2 rounded-2xl border border-slate-100 bg-white/95 p-3 shadow-lg backdrop-blur"
        style={{ bottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}>
        <GhostBtn onClick={() => save(false)} disabled={!!busy}>{busy === "save" ? <><Loader2 size={15} className="animate-spin" /> Saving…</> : <><Save size={15} /> Save draft</>}</GhostBtn>
        <PrimaryBtn onClick={() => save(true)} disabled={!!busy}>{busy === "submit" ? <><Loader2 size={16} className="animate-spin" /> Submitting…</> : <>{submitted ? "Update & re-submit" : "Submit application"} <ArrowRight size={16} /></>}</PrimaryBtn>
      </div>
    </div>
  );
}

/* ---------- Documents ---------- */
function DocumentsTab({ me, onChange, flash }) {
  const [docs, setDocs] = useState(me.documents);
  const [uploading, setUploading] = useState("");
  const fileRefs = useRef({});

  const pick = (key) => fileRefs.current[key]?.click();
  const upload = async (key, file) => {
    if (!file) return;
    setUploading(key);
    try {
      const res = await api.uploadApplicantDoc(key, file);
      setDocs(res.docs); onChange(res.docs);
      flash("Document uploaded.");
    } catch (e) { flash(e.message || "Upload failed.", "error"); }
    setUploading("");
  };

  const uploaded = docs.filter((d) => d.uploaded).length;
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-slate-100 bg-white p-5 shadow-sm">
        <h2 className="text-base font-extrabold text-slate-800">Your documents</h2>
        <p className="mt-0.5 text-[12px] text-slate-500">Upload each document below. Anything you upload is converted to PDF automatically. You can replace a file any time before the admissions team confirms it.</p>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full transition-all" style={{ width: `${docs.length ? (uploaded / docs.length) * 100 : 0}%`, background: `linear-gradient(90deg, ${TEAL}, ${TEAL_LT})` }} />
        </div>
        <p className="mt-1.5 text-[12px] font-bold text-slate-500">{uploaded} of {docs.length} uploaded</p>
      </div>

      <div className="flex flex-col gap-2.5">
        {docs.map((d) => (
          <div key={d.key} className="flex items-center gap-3 rounded-2xl border border-slate-100 bg-white p-3.5 shadow-sm">
            <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${d.confirmed ? "bg-emerald-50 text-emerald-600" : d.uploaded ? "bg-teal-50 text-teal-600" : "bg-slate-50 text-slate-600"}`}>
              {d.confirmed ? <ShieldCheck size={18} /> : d.uploaded ? <FileText size={18} /> : <Circle size={16} />}
            </span>
            <div className="mr-auto min-w-0">
              <p className="truncate text-[14px] font-bold text-slate-700">{d.label}</p>
              <p className="truncate text-[11px] text-slate-500">
                {d.confirmed ? <span className="font-bold text-emerald-600">Verified</span> : d.uploaded ? <span className="font-bold text-teal-600">Uploaded · awaiting review</span> : "Not uploaded yet"}
                {d.fileName ? ` · ${d.fileName}` : ""}
              </p>
            </div>
            <input ref={(el) => (fileRefs.current[d.key] = el)} type="file" className="hidden"
              accept="image/*,application/pdf" onChange={(e) => { upload(d.key, e.target.files?.[0]); e.target.value = ""; }} />
            <button onClick={() => pick(d.key)} disabled={uploading === d.key}
              className={`press inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold transition disabled:opacity-50 ${d.uploaded ? "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50" : "text-white"}`}
              style={d.uploaded ? undefined : { background: `linear-gradient(135deg, ${TEAL}, ${TEAL_LT})` }}>
              {uploading === d.key ? <Loader2 size={13} className="animate-spin" /> : d.uploaded ? <><RefreshCw size={13} /> Replace</> : <><Upload size={13} /> Upload</>}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Interview ---------- */
function InterviewTab({ me }) {
  const iv = me.interview;
  const invited = !!iv.inviteSentAt;
  return (
    <div className="flex flex-col gap-4">
      {iv.outcome && (
        <div className={`flex items-center gap-3 rounded-2xl p-4 ring-1 ${iv.outcome === "Yes" ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : iv.outcome === "No" ? "bg-rose-50 text-rose-800 ring-rose-200" : "bg-sky-50 text-sky-800 ring-sky-200"}`}>
          {iv.outcome === "Yes" ? <PartyPopper size={22} /> : <ClipboardList size={22} />}
          <div><p className="text-[11px] font-bold uppercase tracking-wide opacity-70">Interview outcome</p><p className="text-[15px] font-extrabold">{outcomeLabel(iv.outcome)}</p></div>
        </div>
      )}

      {!invited ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-6 text-center shadow-sm sm:p-8">
          <CalendarClock size={30} className="mx-auto mb-2 text-slate-300" />
          <p className="font-bold text-slate-600">No interview scheduled yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">When the admissions team schedules your interview, the date, time and joining details will appear here — and we'll email you.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-sm">
          <div className="flex items-center gap-2 px-5 py-4 text-white" style={{ background: `linear-gradient(135deg, ${NAVY}, ${NAVY_DARK})` }}>
            <CalendarClock size={20} /> <p className="text-[15px] font-extrabold">You're invited to an interview</p>
          </div>
          <div className="flex flex-col gap-3 p-5">
            <Row Icon={CalendarClock} label="When" value={`${fmtDate(iv.date)}${iv.time ? ` at ${iv.time}` : ""}`} />
            <Row Icon={iv.mode === "Online" ? Video : MapPin} label="Where" value={iv.mode === "Online" ? "Online" : (iv.location || "EdTech")} />
            {iv.mode === "Online" && iv.link && <Row Icon={Video} label="Join link" value={<a href={iv.link} target="_blank" rel="noreferrer" className="break-all font-bold text-teal-700 underline">{iv.link}</a>} />}
            {iv.note && <div className="rounded-xl bg-slate-50 p-3.5 text-[13px] leading-relaxed text-slate-600">{iv.note}</div>}
            <p className="text-[12px] text-slate-500">If the time doesn't suit you, reply to the invitation email and we'll rearrange.</p>
          </div>
        </div>
      )}
    </div>
  );
}
function Row({ Icon, label, value }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-50 text-slate-500"><Icon size={16} /></span>
      <div className="min-w-0"><p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</p><p className="text-[14px] font-bold text-slate-700">{value}</p></div>
    </div>
  );
}

/* ---------- Offer ---------- */
function OfferTab({ me, onAccepted, flash }) {
  const o = me.offer;
  const [busy, setBusy] = useState("");
  const accept = async () => {
    setBusy("accept");
    try { onAccepted(await api.acceptApplicantOffer()); flash("Offer accepted — congratulations!"); }
    catch (e) { flash(e.message || "Could not accept.", "error"); }
    setBusy("");
  };
  const download = () => api.downloadApplicantOfferLetter(`Offer Letter - ${me.name}.pdf`).catch((e) => flash(e.message, "error"));

  if (!o.status) return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-6 text-center shadow-sm sm:p-8">
      <Award size={30} className="mx-auto mb-2 text-slate-300" />
      <p className="font-bold text-slate-600">No offer yet</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">Once your application and interview are complete, your offer letter will appear here for you to download and accept.</p>
    </div>
  );

  const accepted = o.status === "accepted";
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-sm">
      <div className="px-5 py-6 text-center text-white sm:px-6 sm:py-7" style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}>
        <div className="text-4xl">🎉</div>
        {/* break-words because the name is somebody else's data: a long unhyphenated
            surname at text-2xl is wider than a 288px card and would otherwise be the one
            thing on the offer screen that spills off the side of the phone. */}
        <h2 className="mt-2 break-words text-2xl font-extrabold">Congratulations, {me.firstName || me.name}!</h2>
        <p className="mt-1 text-[12px] font-bold uppercase tracking-[0.16em] text-white/80">Unconditional Offer</p>
      </div>
      <div className="flex flex-col gap-4 p-6">
        <p className="text-[14px] leading-relaxed text-slate-600">We're delighted to offer you a place on <b>{o.course || "your course"}</b> at EdTech. Your official offer letter is ready to download below.</p>
        {o.inductionDate && <Row Icon={CalendarClock} label="Induction / first day" value={fmtDate(o.inductionDate)} />}
        <div className="flex flex-wrap gap-2">
          <PrimaryBtn tone="navy" onClick={download}><Download size={16} /> Download offer letter</PrimaryBtn>
          {!accepted
            ? <PrimaryBtn onClick={accept} disabled={busy === "accept"}>{busy === "accept" ? <><Loader2 size={16} className="animate-spin" /> Accepting…</> : <>Accept my offer <CheckCircle2 size={16} /></>}</PrimaryBtn>
            : <span className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-50 px-4 py-2.5 text-sm font-bold text-emerald-700 ring-1 ring-emerald-200"><CheckCircle2 size={16} /> Offer accepted</span>}
        </div>
        {accepted && <p className="text-[12px] text-slate-500">Thank you for accepting. The admissions team will be in touch about enrolment and your first day.</p>}
      </div>
    </div>
  );
}
