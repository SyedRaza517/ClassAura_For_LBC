// Where an institution chooses what it looks like and what it is called.
//
// Lives on the college's own Settings page, beside Connected systems, for the same
// reason: this is the customer's identity, and nobody running the service on their
// behalf should have to hold it — or set it for them — to keep it running. It was
// once contrasted with the supplier's platform dashboard, which has gone with
// multi-tenancy; the reasoning stands without it.
//
// The preview is live and local. Changing a colour writes the CSS variables
// immediately so the whole app around the form restyles as you drag the picker; if
// you cancel, the saved values are put back. Nothing about how a college looks should
// have to be discovered by saving and then hunting for a screen that uses it.
import React, { useEffect, useState, useCallback, useRef } from "react";
import { api } from "./api";
import { setBranding, getBranding, applyBranding, readableOn } from "./branding";
import { BrandLockup } from "./Brand";
import { Palette, Loader2, Save, RotateCcw, Upload, Trash2, AlertTriangle, CheckCircle2, X } from "lucide-react";

const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200 disabled:opacity-60";

function Row({ label, children, hint }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-400">{hint}</span>}
    </label>
  );
}

// Colour is the one field where typing hex and picking from a swatch are both
// reasonable, so both are offered and kept in step.
function ColourField({ label, value, onChange, disabled, hint }) {
  const valid = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value || "");
  return (
    <Row label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={valid ? value : "#334155"}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="h-9 w-12 flex-none cursor-pointer rounded border border-slate-300 bg-white p-1"
          aria-label={label + " swatch"}
        />
        <input
          className={inputCls + (valid || !value ? "" : " border-rose-300")}
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder="#334155"
          spellCheck={false}
        />
      </div>
      {value && !valid && <span className="mt-1 block text-[11px] font-semibold text-rose-600">Use a hex colour such as #1a3a8f.</span>}
    </Row>
  );
}

const TEXT_FIELDS = [
  { key: "displayName", label: "Institution name", hint: "Used in letters, emails and the browser tab. Defaults to the name on your account." },
  { key: "shortName", label: "Short name", hint: "Where the full name will not fit." },
  { key: "wordmarkTop", label: "Wordmark — top line", hint: "The large word in the logo lockup. Ignored if you upload a logo." },
  { key: "wordmarkSub", label: "Wordmark — second line", hint: "Optional." },
];

const LETTER_FIELDS = [
  { key: "addressLines", label: "Address", hint: "Appears at the foot of offer letters and application PDFs.", area: true },
  { key: "contactEmail", label: "Contact email", hint: "Also decides the domain outbound mail is sent from." },
  { key: "contactPhone", label: "Contact phone" },
  { key: "website", label: "Website" },
  { key: "legalFooter", label: "Legal footer", hint: "Company registration and registered office, as printed on letters.", area: true },
  { key: "signatoryName", label: "Offer letter signed by" },
  { key: "signatoryTitle", label: "Signatory's job title" },
];

export default function BrandingSettings() {
  const [state, setState] = useState(null);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(false);
  const fileRef = useRef(null);
  // What was applied when the form opened, so Cancel genuinely restores it.
  const original = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await api.getBrandingAll();
      setState(r);
      setForm({ ...(r.saved || {}) });
      original.current = { ...r.resolved };
    } catch (e) { setError(e.message || "Could not load branding."); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Live preview: the app around this form restyles as the colour changes.
  const set = (k, v) => {
    setForm((s) => {
      const next = { ...s, [k]: v };
      if (["primaryColor", "accentColor", "buttonColor", "buttonTextColor"].includes(k)) {
        applyBranding({
          primaryColor: next.primaryColor || state?.resolved?.primaryColor,
          accentColor: next.accentColor || state?.resolved?.accentColor,
          buttonColor: next.buttonColor || state?.resolved?.buttonColor,
          buttonTextColor: next.buttonTextColor || state?.resolved?.buttonTextColor,
        });
      }
      return next;
    });
  };

  const cancel = () => {
    setOpen(false);
    setForm({ ...(state?.saved || {}) });
    if (original.current) applyBranding(original.current);   // undo the live preview
    setError(""); setNotice("");
  };

  const pickLogo = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";                       // so re-picking the same file fires again
    if (!file) return;
    const max = state?.limits?.maxLogoBytes || 262144;
    if (file.size > max) {
      setError(`That image is ${Math.round(file.size / 1024)}KB. The limit is ${Math.round(max / 1024)}KB — the logo is embedded in every page load.`);
      return;
    }
    setError("");
    const reader = new FileReader();
    reader.onload = () => set("logoDataUri", String(reader.result || ""));
    reader.onerror = () => setError("Could not read that file.");
    reader.readAsDataURL(file);                // a data: URI, which is what the API stores
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const body = {};
      for (const f of [...TEXT_FIELDS, ...LETTER_FIELDS]) body[f.key] = form[f.key] ?? "";
      body.primaryColor = form.primaryColor ?? "";
      body.accentColor = form.accentColor ?? "";
      body.buttonColor = form.buttonColor ?? "";
      body.buttonTextColor = form.buttonTextColor ?? "";
      if (form.logoDataUri !== undefined) body.logoDataUri = form.logoDataUri ?? "";
      const r = await api.saveBranding(body);
      setBranding(r.resolved);                 // apply everywhere, including the header above
      original.current = { ...r.resolved };
      setState((s) => ({ ...s, saved: r.saved, resolved: r.resolved }));
      setNotice("Saved. Everyone at your institution will see this.");
      setOpen(false);
    } catch (err) {
      setError(err.message || "Could not save.");
    } finally { setBusy(false); }
  };

  const reset = async () => {
    setBusy(true); setError("");
    try {
      const r = await api.resetBranding();
      setBranding(r.resolved);
      original.current = { ...r.resolved };
      setState((s) => ({ ...s, saved: null, resolved: r.resolved }));
      setForm({});
      setNotice("Reset to the default appearance.");
      setOpen(false);
    } catch (err) { setError(err.message || "Could not reset."); }
    finally { setBusy(false); }
  };

  if (!state) return <div className="flex justify-center py-8 text-slate-400"><Loader2 className="animate-spin" /></div>;

  const r = state.resolved || {};
  const logo = form.logoDataUri !== undefined ? form.logoDataUri : r.logoDataUri;

  // What a button will ACTUALLY be, following the same fallbacks the app uses: an unset
  // button colour follows the primary, and unset text is chosen by luminance.
  const btnBg = form.buttonColor || r.buttonColor || form.primaryColor || r.primaryColor;
  const btnFg = form.buttonTextColor || r.buttonTextColor || readableOn(btnBg);

  // Relative luminance contrast, the WCAG ratio. Warned about rather than blocked: a
  // college may have a brand guideline we do not get to overrule, but nobody should be
  // able to save an invisible button without being told.
  const contrastWarning = (() => {
    const lum = (hex) => {
      const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || "").trim());
      if (!m) return null;
      let h = m[1];
      if (h.length === 3) h = h.split("").map((c) => c + c).join("");
      const n = parseInt(h, 16);
      const [rr, gg, bb] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
    };
    const a = lum(btnBg), b = lum(btnFg);
    if (a === null || b === null) return "";
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio >= 4.5) return "";
    return `Contrast is ${ratio.toFixed(1)}:1 — text on these buttons will be hard to read. 4.5:1 is the usual minimum.`;
  })();

  return (
    <div className="rounded-xl bg-white ring-1 ring-slate-200">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className="flex h-9 w-9 flex-none items-center justify-center rounded-lg" style={{ background: r.primaryColor, color: readableOn(r.primaryColor) }}>
          <Palette size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-slate-800">Appearance &amp; branding</p>
          <p className="mt-0.5 truncate text-[12px] text-slate-500">
            {state.saved ? <>{r.displayName} · {r.primaryColor}{logo ? " · logo set" : ""}</> : "Your name, colours and logo — used across the app, emails and letters."}
          </p>
        </div>
        <button onClick={() => (open ? cancel() : setOpen(true))} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 transition hover:bg-slate-50">
          {open ? "Close" : state.saved ? "Edit" : "Set up"}
        </button>
      </div>

      {notice && !open && (
        <div className="mx-4 mb-4 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 ring-1 ring-emerald-200">
          <CheckCircle2 size={15} /> {notice}
        </div>
      )}

      {open && (
        <form onSubmit={save} className="flex flex-col gap-5 border-t border-slate-200 p-4">
          {/* Preview first: the point of the screen is seeing it, not filling it in. */}
          <div className="rounded-xl p-4 text-center" style={{ background: `linear-gradient(135deg, ${form.primaryColor || r.primaryColor}, ${form.accentColor || r.accentColor})` }}>
            <div className="mx-auto inline-flex flex-col items-center gap-1 rounded-xl bg-white px-5 py-3 shadow">
              <BrandLockup />
            </div>
            <p className="mt-2 text-sm font-bold" style={{ color: readableOn(form.primaryColor || r.primaryColor) }}>
              {form.displayName || r.displayName}
            </p>
          </div>

          <div>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">Colours</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <ColourField label="Primary" value={form.primaryColor ?? ""} onChange={(v) => set("primaryColor", v)} disabled={busy} hint="Headers, navigation and links." />
              <ColourField label="Accent" value={form.accentColor ?? ""} onChange={(v) => set("accentColor", v)} disabled={busy} hint="The second colour in gradients and highlights." />
              <ColourField label="Buttons" value={form.buttonColor ?? ""} onChange={(v) => set("buttonColor", v)} disabled={busy} hint="Leave blank to follow your primary colour." />
              <ColourField label="Text on buttons" value={form.buttonTextColor ?? ""} onChange={(v) => set("buttonTextColor", v)} disabled={busy} hint="Leave blank and we pick black or white, whichever is readable." />
            </div>

            {/* Shown at the size a button actually is, on the surface it actually sits on.
                A colour pair that looks fine as two swatches can still be unreadable as a
                control, and this is where a college finds that out — not their staff. */}
            <div className="mt-3 rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200">
              <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-slate-500">How your buttons will look</p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center rounded-xl px-4 py-2.5 text-sm font-bold shadow-md"
                  style={{ background: btnBg, color: btnFg }}>Save changes</span>
                <span className="inline-flex items-center rounded-xl px-4 py-2.5 text-sm font-bold shadow-md"
                  style={{ background: btnBg, color: btnFg }}>Approve</span>
              </div>
              {contrastWarning && (
                <p className="mt-2 flex items-start gap-1.5 text-[11px] font-semibold text-amber-700">
                  <AlertTriangle size={12} className="mt-0.5 flex-none" />
                  {contrastWarning}
                </p>
              )}
            </div>
            <p className="mt-2 text-[11px] text-slate-400">
              Chart and category colours stay fixed — they have to remain distinguishable from one another,
              and an &ldquo;Absent&rdquo; mark should not change colour because the brand did.
            </p>
          </div>

          <div>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">Logo</p>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex h-16 w-32 flex-none items-center justify-center rounded-lg bg-slate-50 ring-1 ring-slate-200">
                {logo ? <img src={logo} alt="Logo" className="max-h-14 max-w-28 object-contain" /> : <span className="text-[11px] text-slate-400">No logo</span>}
              </div>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif" onChange={pickLogo} className="hidden" />
              <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 transition hover:bg-slate-50">
                <Upload size={15} /> Choose image
              </button>
              {logo && (
                <button type="button" onClick={() => set("logoDataUri", "")} disabled={busy} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-rose-600 ring-1 ring-rose-200 transition hover:bg-rose-50">
                  <Trash2 size={15} /> Remove
                </button>
              )}
            </div>
            <p className="mt-2 text-[11px] text-slate-400">
              PNG, JPEG, SVG, WEBP or GIF, up to {Math.round((state.limits?.maxLogoBytes || 262144) / 1024)}KB. A wide
              transparent PNG works best. Uploading one replaces the wordmark.
            </p>
          </div>

          <div>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">Names</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {TEXT_FIELDS.map((f) => (
                <Row key={f.key} label={f.label} hint={f.hint}>
                  <input className={inputCls} value={form[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} disabled={busy} placeholder={r[f.key] || ""} />
                </Row>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">Letters &amp; emails</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {LETTER_FIELDS.map((f) => (
                <Row key={f.key} label={f.label} hint={f.hint}>
                  {f.area
                    ? <textarea rows={2} className={inputCls} value={form[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} disabled={busy} placeholder={r[f.key] || ""} />
                    : <input className={inputCls} value={form[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} disabled={busy} placeholder={r[f.key] || ""} />}
                </Row>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-slate-400">
              These appear on offer letters, application PDFs and the emails sent to your applicants and students.
              Leave a field blank and it is simply omitted rather than filled with somebody else&rsquo;s.
            </p>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800 ring-1 ring-rose-200">
              <AlertTriangle size={15} className="mt-0.5 flex-none" /> {error}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className="inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold text-white transition disabled:opacity-60" style={{ background: form.primaryColor || r.primaryColor }}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save
            </button>
            {state.saved && (
              <button type="button" onClick={reset} disabled={busy} className="inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold text-slate-600 ring-1 ring-slate-300 transition hover:bg-slate-50 disabled:opacity-60">
                <RotateCcw size={15} /> Reset to default
              </button>
            )}
            <button type="button" onClick={cancel} disabled={busy} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-slate-500 transition hover:bg-slate-50">
              <X size={15} /> Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
