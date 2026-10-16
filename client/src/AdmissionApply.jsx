// The public HND application page (the app renders it when the URL has ?apply).
//
// A PUBLIC, no-login standalone page. A prospective student fills in the full HND
// application form themselves. On submit it creates an admission the college sees in
// their Admissions tab, then shows a thank-you confirmation. The form is data-driven
// from ADMISSION_SECTIONS, so admissions can change the questions without touching
// this file.
import React, { useState, useEffect } from "react";
import { api } from "./api";
import { ADMISSION_SECTIONS, ADMISSION_REQUIRED } from "./admissionSections";
import { BrandLockup } from "./Brand";
import { Send, CheckCircle2, Loader2, AlertCircle } from "lucide-react";

// The app's palette. Not exported from elsewhere, so declared locally.
import { NAVY, NAVY_DARK, MAROON } from "./branding";

// Every field key, flattened from the sections — used to build a blank form.
const FIELD_KEYS = ADMISSION_SECTIONS.flatMap((s) => s.fields.map((f) => f.key));
const blankForm = () => Object.fromEntries(FIELD_KEYS.map((k) => [k, ""]));

// Shared control styling. Full spec from the design: rounded, subtle border, a focus
// ring in the brand navy (set per-input via the --tw-ring-color CSS var).
const CONTROL =
  "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-transparent focus:ring-2";

// Unit scope, NOT inside the component — a component declared inside another's body
// is a new type on every render, so React would unmount and remount its whole subtree,
// destroying the focused field on every keystroke.
function Shell({ center = false, children }) {
  return (
    <div
      className={`animated-gradient flex min-h-[100dvh] w-full justify-center p-4 sm:p-6 ${center ? "items-center" : "items-start"}`}
      style={{
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
        background: `linear-gradient(160deg, ${NAVY} 0%, ${NAVY_DARK} 55%, #0f172a 100%)`,
        backgroundSize: "220% 220%",
        paddingBottom: "calc(1.5rem + env(safe-area-inset-bottom))",
      }}
    >
      <div className="w-full max-w-3xl">{children}</div>
    </div>
  );
}

// One field's label + hint + control. Self-contained (no StaffHub internals).
function Field({ f, value, missing, onChange }) {
  const wide = f.span === 2 || f.type === "textarea";
  const cls = `${CONTROL}${missing ? " border-rose-300 ring-2 ring-rose-100" : ""}`;
  const common = {
    id: `apply-${f.key}`,
    value,
    onChange: (e) => onChange(f.key, e.target.value),
    className: cls,
    style: { "--tw-ring-color": NAVY },
    "aria-required": f.required || undefined,
    "aria-invalid": missing || undefined,
  };

  let control;
  if (f.type === "select") {
    control = (
      <select {...common}>
        <option value="">Select your answer</option>
        {(f.options || []).map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    );
  } else if (f.type === "textarea") {
    control = <textarea rows={3} {...common} className={`${cls} resize-y`} placeholder={f.placeholder || ""} />;
  } else {
    control = <input type={f.type || "text"} {...common} placeholder={f.placeholder || ""} autoComplete="off" />;
  }

  // min-w-0 on every cell, not only the wide ones. A grid child defaults to
  // `min-width: auto`, which is its own min-content width, and a form control brings an
  // intrinsic width with it: a <select> is sized to its widest option (several of this
  // form's run past 90 characters), and a date or text <input> to its default `size`.
  // `w-full` sets the width but does nothing about that minimum, so the cell refused to
  // shrink and the whole 320px form scrolled sideways — the single commonest way a long
  // application form loses a phone applicant. Shrinking the type instead was rejected:
  // the questions are the college's own wording and must stay legible.
  return (
    <div data-akey={f.key} className={`min-w-0 ${wide ? "sm:col-span-2" : ""}`}>
      <label htmlFor={`apply-${f.key}`} className="block text-[13px] font-semibold leading-snug text-slate-600">
        {f.label}{f.required && <span className="ml-0.5 text-rose-500">*</span>}
      </label>
      {f.hint && <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{f.hint}</p>}
      <div className="mt-1.5">{control}</div>
    </div>
  );
}

export default function AdmissionApply() {
  const [form, setForm] = useState(blankForm);
  const [hp, setHp] = useState("");            // honeypot — real people leave it empty
  const [missing, setMissing] = useState(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [courseOptions, setCourseOptions] = useState([]); // admissions-managed course list
  const [intakeOptions, setIntakeOptions] = useState([]); // admissions-managed intake list

  useEffect(() => {
    api.applicationCourses().then(setCourseOptions).catch(() => {});
    api.applicationIntakes().then(setIntakeOptions).catch(() => {});
  }, []);

  // Editing a field clears its "missing" flag so its rose ring disappears as it fills.
  const set = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }));
    setMissing((m) => { if (!m.has(k)) return m; const n = new Set(m); n.delete(k); return n; });
  };

  const submit = async (e) => {
    e.preventDefault();
    setError("");

    // Every required field must be non-empty. Mark the blanks and jump to the first.
    const blanks = ADMISSION_REQUIRED.filter((k) => !String(form[k] || "").trim());
    if (blanks.length) {
      setMissing(new Set(blanks));
      setError("Please complete all required fields (marked *).");
      const el = typeof document !== "undefined" && document.querySelector(`[data-akey="${blanks[0]}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    setBusy(true);
    try {
      await api.submitApplication({ ...form, _hp: hp });
      setDone(true);
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError(err.message || "Something went wrong submitting your application. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  // ---- Success -------------------------------------------------------------
  if (done) return (
    <Shell center>
      <div className="scale-in rounded-2xl bg-white p-6 text-center shadow-2xl ring-1 ring-black/5 sm:p-8">
        <div className="mb-4 flex justify-center"><BrandLockup /></div>
        <div className="bounce-in mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-3xl bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200">
          <CheckCircle2 size={34} />
        </div>
        <h1 className="text-xl font-extrabold tracking-tight text-slate-800">Application submitted — thank you!</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
          The admissions team will contact you soon about your process.
        </p>
      </div>
    </Shell>
  );

  // ---- Form ----------------------------------------------------------------
  return (
    <Shell>
      {/* 16px of card gutter at base, the designed 32px from sm: up. The Shell outside
          this form already spends 16px a side, so p-6 here left a 320px phone 240px of
          actual field width; p-4 gives it back 16px without touching any width at which
          the form was ever comfortable. */}
      <form onSubmit={submit} noValidate className="scale-in rounded-2xl bg-white p-4 shadow-2xl ring-1 ring-black/5 sm:p-8">
        {/* Header */}
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-4"><BrandLockup /></div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-800">HND Application Form</h1>
          <p className="mt-2 max-w-md text-sm text-slate-500">
            Complete the form below to apply. Fields marked <span className="font-semibold text-rose-500">*</span> are required.
          </p>
        </div>

        {/* Honeypot — hidden from real users; bots that fill it are rejected server-side. */}
        <input
          type="text"
          name="_hp"
          value={hp}
          onChange={(e) => setHp(e.target.value)}
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          style={{ position: "absolute", left: "-9999px", width: 1, height: 1, opacity: 0 }}
        />

        {/* Sections */}
        <div className="flex flex-col gap-7">
          {ADMISSION_SECTIONS.map((sec) => (
            <section key={sec.title}>
              <h2 className="text-sm font-bold tracking-tight" style={{ color: NAVY }}>{sec.title}</h2>
              {sec.note && <p className="mt-1 text-xs leading-relaxed text-slate-500">{sec.note}</p>}
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {sec.fields.map((f) => {
                  const ff = (f.key === "course" && courseOptions.length) ? { ...f, options: courseOptions }
                    : (f.key === "intake" && intakeOptions.length) ? { ...f, options: intakeOptions }
                    : f;
                  return <Field key={f.key} f={ff} value={form[f.key]} missing={missing.has(f.key)} onChange={set} />;
                })}
              </div>
            </section>
          ))}
        </div>

        {/* Error banner */}
        {error && (
          <div className="pop mt-6 flex items-start gap-2 rounded-xl bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700 ring-1 ring-rose-200">
            <AlertCircle size={18} className="mt-px shrink-0" /> <span>{error}</span>
          </div>
        )}

        {/* Submit */}
        <div className="mt-6">
          <button
            type="submit"
            disabled={busy}
            className="press flex min-h-[46px] w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold text-white shadow-lg transition disabled:opacity-60"
            style={{ background: NAVY }}
          >
            {busy
              ? <><Loader2 size={16} className="animate-spin" /> Submitting…</>
              : <><Send size={16} /> Submit application</>}
          </button>
        </div>
      </form>
    </Shell>
  );
}
