// Placing an applicant's details onto a college's own letter.
//
// The college's PDF is rendered to a canvas and the draggable field chips sit on a
// transparent layer above it. Positions are kept as a PERCENTAGE of the page, never
// as pixels: the canvas is whatever size the screen allows, the PDF is whatever size
// they exported, and the two must not have to agree. The same percentages are what
// the server writes with, so what you place is where it lands.
//
// pdfjs is loaded on demand rather than imported at the top. It is about a megabyte,
// and only an administrator who opens this editor needs it — everybody else should
// not carry it in the bundle for a screen they will never see.
import React, { useEffect, useRef, useState, useCallback } from "react";
import { api, API_BASE, getToken } from "./api";
import {
  FileText, Loader2, Upload, Trash2, Save, Eye, AlertTriangle, CheckCircle2,
  X, Plus, Type, ChevronLeft, ChevronRight,
} from "lucide-react";

const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200";

/** Load pdfjs once, on demand. */
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then(async (m) => {
      // The worker has to come from our own origin — a CDN is blocked by CSP and
      // would also be a third party in the middle of the college's documents.
      const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
      m.GlobalWorkerOptions.workerSrc = workerUrl;
      return m;
    });
  }
  return pdfjsPromise;
}

/** Fetch a PDF from the API with the caller's token (an <img>/<iframe> cannot send one). */
async function fetchPdf(path) {
  const res = await fetch(API_BASE.replace(/\/$/, "") + path, {
    headers: { Authorization: "Bearer " + getToken() },
    cache: "no-store",
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Could not load the PDF.");
  return new Uint8Array(await res.arrayBuffer());
}

/* ------------------------------------------------------------- the canvas --- */

function PageCanvas({ bytes, pageIndex, onSize }) {
  const ref = useRef(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        // getDocument consumes the buffer it is given, so each render gets its own
        // copy — reusing one leaves a detached ArrayBuffer and a blank second render.
        const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
        if (cancelled) return;
        const page = await doc.getPage(pageIndex + 1);
        const base = page.getViewport({ scale: 1 });
        // Fit the width we have, then draw at device resolution so the text on a
        // letterhead stays sharp enough to position against.
        const cssWidth = Math.min(720, ref.current?.parentElement?.clientWidth || 720);
        const scale = cssWidth / base.width;
        const viewport = page.getViewport({ scale });
        const dpr = window.devicePixelRatio || 1;
        const canvas = ref.current;
        if (!canvas) return;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = viewport.width + "px";
        canvas.style.height = viewport.height + "px";
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        await page.render({ canvasContext: ctx, viewport }).promise;
        if (!cancelled) onSize?.({ width: viewport.width, height: viewport.height });
      } catch (e) {
        if (!cancelled) setErr(e.message || "Could not render this page.");
      }
    })();
    return () => { cancelled = true; };
  }, [bytes, pageIndex, onSize]);

  if (err) return <div className="p-6 text-center text-sm text-rose-600">{err}</div>;
  return <canvas ref={ref} className="block rounded-lg shadow ring-1 ring-slate-300" />;
}

/* --------------------------------------------------------------- editor ----- */

export default function TemplateEditor({ kind, label, spec, template, onChanged, onClose }) {
  const [bytes, setBytes] = useState(null);
  const [fields, setFields] = useState(template?.fields || []);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(null);
  const [sel, setSel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const layerRef = useRef(null);
  const drag = useRef(null);

  const pages = template?.pdfPages || 1;

  useEffect(() => {
    let go = true;
    if (!template?.hasPdf) { setBytes(null); return; }
    fetchPdf(`/doc-templates/${kind}/pdf`)
      .then((b) => go && setBytes(b))
      .catch((e) => go && setError(e.message));
    return () => { go = false; };
  }, [kind, template?.hasPdf, template?.updatedAt]);

  const byKey = Object.fromEntries((spec || []).map((f) => [f.key, f]));
  const placed = new Set(fields.map((f) => f.key));
  const unplaced = (spec || []).filter((f) => !placed.has(f.key));

  // --- dragging ---------------------------------------------------------------
  // Pointer events, not mouse: the same code then works when an administrator does
  // this on a tablet, which is where a letterhead is quite likely to be reviewed.
  const startDrag = (e, key) => {
    e.preventDefault();
    const rect = layerRef.current.getBoundingClientRect();
    drag.current = { key, rect };
    setSel(key);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (!drag.current) return;
    const { key, rect } = drag.current;
    const xPct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const yPct = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    setFields((fs) => fs.map((f) => (f.key === key ? { ...f, xPct, yPct } : f)));
  };
  const endDrag = () => { drag.current = null; };

  const addField = (key) => {
    setFields((fs) => [...fs, { key, page, xPct: 0.1, yPct: 0.3, size: 11, bold: false, align: "left", colour: "#000000" }]);
    setSel(key);
  };
  const removeField = (key) => {
    setFields((fs) => fs.filter((f) => f.key !== key));
    if (sel === key) setSel(null);
  };
  const update = (key, patch) => setFields((fs) => fs.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  // --- upload -----------------------------------------------------------------
  const upload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.type !== "application/pdf") { setError("That is not a PDF."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const dataUri = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result || ""));
        r.onerror = () => rej(new Error("Could not read that file."));
        r.readAsDataURL(file);
      });
      const saved = await api.saveDocTemplate(kind, { pdfDataUri: dataUri, pdfName: file.name });
      setFields(saved.fields || []);
      setPage(0);
      setNotice("Uploaded. Now drag each detail onto the page.");
      onChanged?.(saved);
    } catch (err) { setError(err.message || "Could not upload."); }
    finally { setBusy(false); }
  };

  const save = async (enable) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const saved = await api.saveDocTemplate(kind, { fields, ...(enable === undefined ? {} : { enabled: enable }) });
      setNotice(saved.enabled ? "Saved — new letters will use this template." : "Saved.");
      onChanged?.(saved);
    } catch (err) { setError(err.message || "Could not save."); }
    finally { setBusy(false); }
  };

  const preview = async () => {
    setBusy(true); setError("");
    try {
      // Preview what is on SCREEN, including positions not yet saved, so a placement
      // can be tried before it is committed to.
      const qs = encodeURIComponent(JSON.stringify(fields));
      const b = await fetchPdf(`/doc-templates/${kind}/preview?fields=${qs}`);
      const url = URL.createObjectURL(new Blob([b], { type: "application/pdf" }));
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try { await api.deleteDocTemplate(kind); onChanged?.(null); onClose?.(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const onPage = fields.filter((f) => (f.page || 0) === page);
  const selField = fields.find((f) => f.key === sel);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex-1 text-sm font-extrabold text-slate-800">{label}</h3>
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 transition hover:bg-slate-50">
          <Upload size={15} /> {template?.hasPdf ? "Replace PDF" : "Upload PDF"}
          <input type="file" accept="application/pdf" onChange={upload} className="hidden" disabled={busy} />
        </label>
        {template?.hasPdf && <button onClick={preview} disabled={busy} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 transition hover:bg-slate-50"><Eye size={15} /> Preview</button>}
        <button onClick={onClose} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-slate-500 hover:bg-slate-50"><X size={15} /> Close</button>
      </div>

      {error && <div className="flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800 ring-1 ring-rose-200"><AlertTriangle size={15} className="mt-0.5 flex-none" /> {error}</div>}
      {notice && <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 ring-1 ring-emerald-200"><CheckCircle2 size={15} /> {notice}</div>}

      {!template?.hasPdf ? (
        <div className="rounded-xl border-2 border-dashed border-slate-300 p-10 text-center">
          <FileText size={28} className="mx-auto mb-2 text-slate-300" />
          <p className="text-sm font-semibold text-slate-600">Upload the {label.toLowerCase()} you already send</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
            Your PDF is used as the page itself — it is never redrawn, so your letterhead,
            fonts and footer come out exactly as you designed them. You then drag each
            applicant detail onto the page.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
          {/* --- the page --- */}
          <div>
            {pages > 1 && (
              <div className="mb-2 flex items-center gap-2">
                <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="rounded p-1 text-slate-500 ring-1 ring-slate-300 disabled:opacity-40"><ChevronLeft size={15} /></button>
                <span className="text-xs font-semibold text-slate-500">Page {page + 1} of {pages}</span>
                <button onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1} className="rounded p-1 text-slate-500 ring-1 ring-slate-300 disabled:opacity-40"><ChevronRight size={15} /></button>
              </div>
            )}
            <div className="relative inline-block max-w-full overflow-x-auto">
              {bytes ? <PageCanvas bytes={bytes} pageIndex={page} onSize={setSize} /> : <div className="flex h-64 items-center justify-center text-slate-400"><Loader2 className="animate-spin" /></div>}
              {/* The draggable layer sits exactly over the canvas. */}
              <div
                ref={layerRef}
                className="absolute inset-0"
                style={size ? { width: size.width, height: size.height } : undefined}
                onPointerMove={onMove}
                onPointerUp={endDrag}
                onPointerLeave={endDrag}
              >
                {size && onPage.map((f) => (
                  <button
                    key={f.key}
                    onPointerDown={(e) => startDrag(e, f.key)}
                    className={`absolute cursor-move whitespace-nowrap rounded px-1 py-0.5 text-[11px] font-semibold shadow ring-1 transition ${sel === f.key ? "bg-amber-300 text-slate-900 ring-amber-500" : "bg-sky-200/90 text-slate-800 ring-sky-400"}`}
                    style={{
                      left: f.xPct * size.width,
                      top: f.yPct * size.height,
                      transform: f.align === "center" ? "translateX(-50%)" : f.align === "right" ? "translateX(-100%)" : "none",
                    }}
                    title="Drag to position"
                  >
                    {byKey[f.key]?.sample || f.key}
                  </button>
                ))}
              </div>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Each chip shows a sample value where it will print. Drag it into place; the position
              is stored as a proportion of the page, so it holds even if the PDF is re-exported at a
              different size.
            </p>
          </div>

          {/* --- the fields --- */}
          <div className="flex flex-col gap-3">
            <div>
              <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">Add a detail</p>
              <div className="flex flex-wrap gap-1.5">
                {unplaced.length === 0 && <span className="text-[11px] text-slate-500">All of them are placed.</span>}
                {unplaced.map((f) => (
                  <button key={f.key} onClick={() => addField(f.key)} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-200">
                    <Plus size={11} /> {f.label}
                  </button>
                ))}
              </div>
            </div>

            {selField && (
              <div className="rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-slate-700"><Type size={13} /> {byKey[selField.key]?.label || selField.key}</p>
                <div className="flex flex-col gap-2">
                  <label className="block">
                    <span className="mb-0.5 block text-[10px] font-bold uppercase text-slate-500">Size</span>
                    <input type="number" min={4} max={72} className={inputCls} value={selField.size} onChange={(e) => update(selField.key, { size: Number(e.target.value) })} />
                  </label>
                  <label className="block">
                    <span className="mb-0.5 block text-[10px] font-bold uppercase text-slate-500">Align</span>
                    <select className={inputCls} value={selField.align} onChange={(e) => update(selField.key, { align: e.target.value })}>
                      <option value="left">Left of the point</option>
                      <option value="center">Centred on it</option>
                      <option value="right">Right of it</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" checked={!!selField.bold} onChange={(e) => update(selField.key, { bold: e.target.checked })} className="h-4 w-4 rounded border-slate-300" />
                    Bold
                  </label>
                  {pages > 1 && (
                    <label className="block">
                      <span className="mb-0.5 block text-[10px] font-bold uppercase text-slate-500">Page</span>
                      <select className={inputCls} value={selField.page || 0} onChange={(e) => update(selField.key, { page: Number(e.target.value) })}>
                        {Array.from({ length: pages }, (_, i) => <option key={i} value={i}>Page {i + 1}</option>)}
                      </select>
                    </label>
                  )}
                  <button onClick={() => removeField(selField.key)} className="mt-1 inline-flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-rose-600 ring-1 ring-rose-200 transition hover:bg-rose-50">
                    <Trash2 size={13} /> Remove this detail
                  </button>
                </div>
              </div>
            )}

            <div className="mt-auto flex flex-col gap-2">
              <button onClick={() => save(undefined)} disabled={busy} className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save positions
              </button>
              <button onClick={() => save(!template?.enabled)} disabled={busy || fields.length === 0} className="inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold ring-1 transition disabled:opacity-50"
                style={template?.enabled ? { color: "#9a3412", borderColor: "#fdba74" } : { color: "#065f46" }}>
                {template?.enabled ? "Stop using this template" : "Save & start using it"}
              </button>
              <button onClick={remove} disabled={busy} className="inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-rose-600 transition hover:bg-rose-50">
                <Trash2 size={13} /> Delete template
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
