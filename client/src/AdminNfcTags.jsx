// NFC Tags — register the stickers, tune how tap check-in behaves, read the tap log.
//
// Two ways to register a sticker, because they suit two different rollouts and a college
// should not have to pick the hard one:
//
//   * Tap a blank sticker. The app reads its factory identifier and registers that. No
//     writing tool, no generated secret to transcribe — buy stickers, walk the corridor,
//     tap each one and name the room. Only offered on a phone with NFC.
//   * Generate a code. The server invents a secret, shows it ONCE, and somebody writes
//     it onto the sticker with a phone app like NFC Tools. This is the path for an
//     administrator at a desk.
//
// The generated code appears exactly once. There is no endpoint that reads one back, on
// purpose: a leaked code is a sticker anyone can simulate from anywhere, and the remedy
// is to retire it and register another, not to look the old one up.
import React, { useState, useEffect, useCallback } from "react";
import {
  Nfc, Plus, Loader2, AlertTriangle, CheckCircle2, Copy, Power, RefreshCw,
  ScanLine, Clock3, ShieldCheck, X,
} from "lucide-react";
import { api } from "./api";
import { nfcStatus, scanOnce } from "./nfc";
import { NAVY } from "./branding";

const fmtWhen = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch { return "—"; }
};

// Every outcome the server can log, in words a person reads rather than the enum. A tap
// that was REFUSED is the interesting half of this log, so each refusal says what
// actually happened rather than collapsing to "failed".
const OUTCOMES = {
  marked: { label: "Marked present", tone: "emerald" },
  checked_in: { label: "Staff clocked in", tone: "emerald" },
  already_marked: { label: "Already marked", tone: "slate" },
  already_checked_in: { label: "Already clocked in", tone: "slate" },
  no_session_now: { label: "No class running", tone: "amber" },
  ambiguous: { label: "Two classes — asked which", tone: "amber" },
  term_locked: { label: "Term closed", tone: "amber" },
  tag_unknown: { label: "Tag not recognised", tone: "rose" },
  rate_limited: { label: "Too many attempts", tone: "rose" },
  disabled: { label: "Feature switched off", tone: "slate" },
};
const TONES = {
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  amber: "bg-amber-50 text-amber-700 ring-amber-200",
  rose: "bg-rose-50 text-rose-700 ring-rose-200",
  slate: "bg-slate-100 text-slate-600 ring-slate-200",
};

export default function AdminNfcTags() {
  const [tags, setTags] = useState(null);
  const [settings, setSettings] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(true);
  const [openLog, setOpenLog] = useState(null);

  const load = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      const [t, s] = await Promise.all([api.tags(), api.tapSettings()]);
      setTags(t); setSettings(s);
    } catch (e) {
      setErr(e?.message || "Could not load the tags.");
    } finally { setBusy(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (busy && !tags) return <div className="flex justify-center p-12"><Loader2 className="animate-spin text-slate-300" size={28} /></div>;

  return (
    <div className="space-y-5 p-4 md:p-6">
      {err && <Banner tone="rose" Icon={AlertTriangle}>{err}</Banner>}

      <TapSettings settings={settings} onSaved={(s) => setSettings(s)} />
      <RegisterTag onCreated={load} />

      <section className="rounded-2xl border border-slate-200 bg-white">
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><Nfc size={16} style={{ color: NAVY }} />Registered stickers</h3>
          <button onClick={load} className="press rounded-lg p-1.5 text-slate-400 hover:bg-slate-50" title="Refresh"><RefreshCw size={15} /></button>
        </header>

        {!tags?.length ? (
          <p className="px-5 py-8 text-center text-sm text-slate-400">No stickers registered yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {tags.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-800">{t.label}</p>
                  <p className="text-[12px] text-slate-500">
                    {/* "Never used" is a real and important state — a sticker registered
                        and never tapped is one nobody put on a wall. */}
                    {t.lastTapAt ? `Last tapped ${fmtWhen(t.lastTapAt)}` : "Never tapped"}
                    {t.createdBy && ` · added by ${t.createdBy}`}
                  </p>
                </div>
                {!t.active && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-500 ring-1 ring-slate-200">Retired</span>}
                <button onClick={() => setOpenLog(t)} className="press rounded-lg border border-slate-200 px-2.5 py-1.5 text-[12px] font-semibold text-slate-600">Taps</button>
                <button
                  onClick={async () => { await api.updateTag(t.id, { active: !t.active }).catch((e) => setErr(e.message)); load(); }}
                  className="press flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[12px] font-semibold text-slate-600"
                  title={t.active ? "Retire this sticker" : "Bring it back into use"}
                >
                  <Power size={13} />{t.active ? "Retire" : "Restore"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {openLog && <TapLog tag={openLog} onClose={() => setOpenLog(null)} />}
    </div>
  );
}

function Banner({ tone, Icon, children }) {
  return (
    <div className={`flex gap-2.5 rounded-xl p-3 ring-1 ${TONES[tone] || TONES.slate}`}>
      <Icon size={17} className="mt-0.5 shrink-0" />
      <div className="text-[13px] leading-relaxed">{children}</div>
    </div>
  );
}

/* ------------------------------ settings ------------------------------ */

function TapSettings({ settings, onSaved }) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { setDraft(settings); }, [settings]);
  if (!draft) return null;

  const save = async (patch) => {
    setSaving(true); setErr("");
    try {
      const s = await api.saveTapSettings(patch);
      setDraft(s); onSaved(s);
    } catch (e) { setErr(e?.message || "Could not save."); }
    finally { setSaving(false); }
  };

  const num = (key, label, hint) => (
    <label className="block">
      <span className="text-[12px] font-semibold text-slate-700">{label}</span>
      <input
        type="number" min="0" max="120" value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
        onBlur={(e) => { const v = Number(e.target.value); if (v !== settings[key]) save({ [key]: v }); }}
        className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm tabular-nums"
      />
      <span className="mt-1 block text-[11px] leading-snug text-slate-500">{hint}</span>
    </label>
  );

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-bold text-slate-800"><ShieldCheck size={16} style={{ color: NAVY }} />How tap check-in behaves</h3>
      <p className="mb-4 text-[12px] leading-relaxed text-slate-500">
        Students can only tap while a lecture of theirs is actually running — not before it starts, not after it ends.
      </p>

      {err && <div className="mb-3"><Banner tone="rose" Icon={AlertTriangle}>{err}</Banner></div>}

      <label className="mb-4 flex items-start gap-3 rounded-xl bg-slate-50 p-3.5">
        <input
          type="checkbox" checked={draft.enabled} disabled={saving}
          onChange={(e) => save({ enabled: e.target.checked })}
          className="mt-0.5 h-4 w-4 shrink-0"
        />
        <span>
          <span className="block text-[13px] font-semibold text-slate-800">Tap check-in is {draft.enabled ? "ON" : "OFF"}</span>
          <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">
            While this is off, no tap is accepted from anybody. Switching it on lets students mark
            themselves present on the registers for classes they are enrolled on.
          </span>
        </span>
      </label>

      <div className="grid gap-4 sm:grid-cols-3">
        {num("lateAfterMins", "Late after (minutes)", "A tap this long after the start records Late instead of Present.")}
        {num("earlyGraceMins", "Early grace (minutes)", "How long before a lecture starts taps are accepted. Zero means not before it starts.")}
        {num("armSeconds", "Button stays live (seconds)", "How long after touching a sticker the student has to press the button.")}
      </div>

      <label className="mt-4 flex items-start gap-3">
        <input type="checkbox" checked={draft.staffTapEnabled} disabled={saving} onChange={(e) => save({ staffTapEnabled: e.target.checked })} className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="text-[12px] leading-snug text-slate-600">
          <span className="font-semibold text-slate-800">Staff can clock in with the same stickers.</span>{" "}
          A tap always records <em>Onsite</em> — they are demonstrably in the building — and working online stays available from the Check-In screen.
        </span>
      </label>
    </section>
  );
}

/* --------------------------- registering one --------------------------- */

function RegisterTag({ onCreated }) {
  const [label, setLabel] = useState("");
  const [nfc, setNfc] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [created, setCreated] = useState(null);   // { label, code } — shown once
  const [copied, setCopied] = useState(false);

  useEffect(() => { nfcStatus().then(setNfc); }, []);

  const create = async (code) => {
    if (!label.trim()) { setErr("Give the sticker a name first — the room it will live in."); return; }
    setSaving(true); setErr("");
    try {
      const t = await api.createTag(label.trim(), code);
      setCreated(t); setLabel(""); onCreated();
    } catch (e) { setErr(e?.message || "Could not register that sticker."); }
    finally { setSaving(false); }
  };

  const tapToRegister = async () => {
    if (!label.trim()) { setErr("Give the sticker a name first — the room it will live in."); return; }
    setScanning(true); setErr("");
    try {
      const code = await scanOnce({ alertMessage: "Hold your phone near the new sticker" });
      await create(code);
    } catch (e) { setErr(e?.message || "Could not read that sticker."); }
    finally { setScanning(false); }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-800"><Plus size={16} style={{ color: NAVY }} />Register a sticker</h3>

      {created && (
        <div className="mb-4 rounded-xl bg-emerald-50 p-4 ring-1 ring-emerald-200">
          <p className="flex items-center gap-2 text-[13px] font-bold text-emerald-900"><CheckCircle2 size={16} />“{created.label}” is registered.</p>
          {created.code && (
            <>
              <p className="mt-2 text-[12px] leading-relaxed text-emerald-900">
                Write this onto the sticker with an NFC writing app, as a <strong>Text</strong> record.
                <strong> You will not be shown it again</strong> — if it is lost, retire the sticker and register it afresh.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-white px-3 py-2 font-mono text-[12px] ring-1 ring-emerald-200">{created.code}</code>
                <button
                  onClick={() => { navigator.clipboard?.writeText(created.code); setCopied(true); setTimeout(() => setCopied(false), 1800); }}
                  className="press flex shrink-0 items-center gap-1.5 rounded-lg bg-white px-2.5 py-2 text-[12px] font-semibold text-emerald-800 ring-1 ring-emerald-200"
                >
                  <Copy size={13} />{copied ? "Copied" : "Copy"}
                </button>
              </div>
            </>
          )}
          <button onClick={() => setCreated(null)} className="press mt-3 text-[12px] font-semibold text-emerald-800 underline">Done</button>
        </div>
      )}

      {err && <div className="mb-3"><Banner tone="rose" Icon={AlertTriangle}>{err}</Banner></div>}

      <label className="block">
        <span className="text-[12px] font-semibold text-slate-700">Where will it live?</span>
        <input
          value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120}
          placeholder="Room 101"
          className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
        />
      </label>

      <div className="mt-3 flex flex-wrap gap-2">
        {nfc?.ok && (
          <button
            onClick={tapToRegister} disabled={scanning || saving}
            className="press flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold text-white disabled:opacity-60"
            style={{ background: NAVY }}
          >
            {scanning ? <Loader2 size={15} className="animate-spin" /> : <ScanLine size={15} />}
            {scanning ? "Hold it to the sticker…" : "Tap a blank sticker"}
          </button>
        )}
        <button
          onClick={() => create(null)} disabled={saving || scanning}
          className="press flex items-center gap-2 rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-bold text-slate-700 disabled:opacity-60"
        >
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}Generate a code to write
        </button>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        {nfc?.ok
          ? "Tapping a blank sticker is the quicker route — nothing to write and nothing to transcribe."
          : "On a phone with NFC you can register a blank sticker just by tapping it, with nothing to write."}
      </p>
    </section>
  );
}

/* ------------------------------- tap log ------------------------------- */

function TapLog({ tag, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => { api.tagLog(tag.id).then(setData).catch((e) => setErr(e.message)); }, [tag.id]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-6" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-2xl overflow-hidden rounded-t-2xl bg-white sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <div>
            <h3 className="text-sm font-bold text-slate-800">{tag.label}</h3>
            <p className="text-[12px] text-slate-500">Recent taps, including the ones that were refused</p>
          </div>
          <button onClick={onClose} className="press rounded-lg p-1.5 text-slate-400 hover:bg-slate-50"><X size={17} /></button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto">
          {err && <p className="p-5 text-sm text-rose-600">{err}</p>}
          {!data && !err && <div className="flex justify-center p-10"><Loader2 className="animate-spin text-slate-300" size={24} /></div>}
          {data && !data.taps.length && <p className="p-8 text-center text-sm text-slate-400">Nobody has tapped this sticker yet.</p>}
          {data && data.taps.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {data.taps.map((t) => {
                const o = OUTCOMES[t.outcome] || { label: t.outcome, tone: "slate" };
                return (
                  <li key={t.id} className="flex flex-wrap items-center gap-2.5 px-5 py-3">
                    <Clock3 size={13} className="shrink-0 text-slate-300" />
                    <span className="w-[128px] shrink-0 text-[12px] tabular-nums text-slate-500">{fmtWhen(t.at)}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-slate-800">
                      {/* A refused tap can have no name at all — nobody was identified.
                          That is a real state and reads better than a blank. */}
                      {t.who || <span className="italic text-slate-400">not identified</span>}
                      {t.kind === "staff" && <span className="ml-1.5 text-[11px] font-semibold text-slate-400">staff</span>}
                    </span>
                    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ${TONES[o.tone]}`}>
                      {o.label}{t.status ? ` · ${t.status}` : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
