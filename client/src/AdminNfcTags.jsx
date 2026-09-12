// Check-in: QR & NFC — switch either method on, tune how they behave, register the
// stickers, read the tap log. (Named "NFC Tags" until 3 Sep 2026; the page KEY is
// still `attendance-tags`, because keys are pinned in two places and grants refer to them.)
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
import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Nfc, Plus, Loader2, AlertTriangle, CheckCircle2, Copy, Power, RefreshCw,
  ScanLine, Clock3, ShieldCheck, X, Wifi, MapPin, Crosshair, Video, History,
} from "lucide-react";
import { api } from "./api";
import { nfcStatus, scanOnce } from "./nfc";
import { NAVY } from "./branding";
import { wherePhoneIs } from "./wherePhoneIs";

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
  ambiguous: { label: "Two classes, asked which", tone: "amber" },
  term_locked: { label: "Term closed", tone: "amber" },
  tag_unknown: { label: "Tag not recognised", tone: "rose" },
  rate_limited: { label: "Too many attempts", tone: "rose" },
  disabled: { label: "Feature switched off", tone: "slate" },
  // Where the phone was, rather than what it did. Separated from the refusals above
  // because they send an administrator somewhere different: "off the college network" is
  // a student on mobile data, while "no network ranges saved" is the college's own
  // settings screen refusing everybody and needs to be unmistakable.
  off_network: { label: "Not on the college network", tone: "amber" },
  network_not_configured: { label: "No network ranges saved — everyone refused", tone: "rose" },
  off_campus: { label: "Too far from the campus", tone: "amber" },
  campus_not_located: { label: "Campus has no coordinates — everyone refused", tone: "rose" },
  position_missing: { label: "Location not shared", tone: "amber" },
  accuracy_unknown: { label: "Location sent with no accuracy", tone: "amber" },
  accuracy_too_poor: { label: "Location too vague to trust", tone: "amber" },
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
      <header>
        <h2 className="flex items-center gap-2 text-lg font-bold text-slate-800"><Nfc size={18} style={{ color: NAVY }} />Check-in: QR &amp; NFC</h2>
        <p className="mt-0.5 text-[13px] text-slate-500">The stickers students and staff tap, and how check-in behaves.</p>
      </header>
      <div role="alert" aria-live="assertive">{err && <Banner tone="rose" Icon={AlertTriangle}>{err}</Banner>}</div>

      <TapSettings settings={settings} onSaved={(s) => setSettings(s)} />
      <TeamsAttendance />
      <RegisterTag onCreated={load} />

      <section className="rounded-2xl border border-slate-200 bg-white">
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><Nfc size={16} style={{ color: NAVY }} />Registered stickers</h3>
          <button onClick={load} aria-label="Refresh the tag list" className="press rounded-lg p-2.5 text-slate-500 hover:bg-slate-50" title="Refresh"><RefreshCw size={15} /></button>
        </header>

        {!tags?.length ? (
          <p className="px-5 py-8 text-center text-sm text-slate-500">No stickers registered yet.</p>
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
                <button onClick={() => setOpenLog(t)} className="press rounded-lg border border-slate-200 px-3 py-2.5 text-[12px] font-semibold text-slate-600">Taps</button>
                <button
                  onClick={async () => { await api.updateTag(t.id, { active: !t.active }).catch((e) => setErr(e.message)); load(); }}
                  className="press flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2.5 text-[12px] font-semibold text-slate-600"
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
  // Lines the server threw away on the last save. It keeps the good ranges and drops the
  // unusable ones, which is right — a college pasting four ranges off a network diagram
  // will get one wrong, and refusing the whole save punishes the typo by leaving check-in
  // unprotected. But dropping one SILENTLY is how somebody saves a list of four, watches
  // four lines of text go in, and finds out in a lecture theatre that only three work.
  const [rejected, setRejected] = useState([]);
  useEffect(() => { setDraft(settings); }, [settings]);
  // EVERY hook is above this line. A useState below an early return renders a different
  // number of hooks on the pass where `settings` is still loading than on the pass after
  // it arrives — React error #310, which takes the whole screen down and has been
  // introduced in this codebase twice.
  if (!draft) return null;

  const save = async (patch) => {
    setSaving(true); setErr("");
    try {
      const s = await api.saveTapSettings(patch);
      // Only replaced when the save actually carried ranges — otherwise switching an
      // unrelated toggle would clear a warning the administrator has not read yet.
      if (patch.allowedNetworks) setRejected(s.rejectedNetworks || []);
      setDraft(s); onSaved(s);
    } catch (e) { setErr(e?.message || "Could not save."); }
    finally { setSaving(false); }
  };

  // armSeconds is SECONDS and capped server-side at 600; the two minute fields are
  // capped at 120. One shared max="120" silently refused a legitimate arming window.
  const num = (key, label, hint, max = 120) => (
    <label className="block">
      <span className="text-[12px] font-semibold text-slate-700">{label}</span>
      <input
        type="number" min="0" max={max} value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
        onBlur={(e) => { const v = Number(e.target.value); if (v !== settings[key]) save({ [key]: v }); }}
        className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm tabular-nums"
      />
      <span className="mt-1 block text-[11px] leading-snug text-slate-500">{hint}</span>
    </label>
  );

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-bold text-slate-800"><ShieldCheck size={16} style={{ color: NAVY }} />How self check-in behaves</h3>
      <p className="mb-4 text-[12px] leading-relaxed text-slate-500">
        Students can only check in while a lecture of theirs is actually running. Not before it starts, and not after it ends.
        That applies to stickers and to the on-screen code alike.
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

      {/* A separate switch, deliberately: a college may want the stickers and not the
          projector, or the projector and not the stickers, and neither implies the other. */}
      <label className="mb-4 flex items-start gap-3 rounded-xl bg-slate-50 p-3.5">
        <input
          type="checkbox" checked={draft.qrEnabled} disabled={saving}
          onChange={(e) => save({ qrEnabled: e.target.checked })}
          className="mt-0.5 h-4 w-4 shrink-0"
        />
        <span>
          <span className="block text-[13px] font-semibold text-slate-800">QR check-in is {draft.qrEnabled ? "ON" : "OFF"}</span>
          <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">
            Shows a check-in code on the Live Attendance screen for each running class.
            Students scan it with their phone camera. No stickers or NFC needed.
          </span>
        </span>
      </label>

      {/* DELIBERATELY NOT STYLED LIKE THE TWO ABOVE. A sticker needs a phone against a tag
          that is physically in the room; a code needs a camera pointed at the projector
          while the code is current. This one needs neither, and can be pressed from a bus.
          Presenting it as a third equivalent switch on a grey card is how an administrator
          turns it on without registering that they have changed what their attendance data
          MEANS at a funding audit — so it carries the trade-off in the label rather than in
          a document nobody reads, and says plainly that the marks stay identifiable. */}
      <label className="mb-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3.5">
        <input
          type="checkbox" checked={draft.declareEnabled} disabled={saving}
          onChange={(e) => save({ declareEnabled: e.target.checked })}
          className="mt-0.5 h-4 w-4 shrink-0"
        />
        <span>
          <span className="block text-[13px] font-semibold text-amber-900">
            Marking yourself in without a sticker or code is {draft.declareEnabled ? "ON" : "OFF"}
          </span>
          <span className="mt-0.5 block text-[11px] leading-snug text-amber-800">
            Students see their running classes on Check In and press a button to be marked present.
            Nothing proves they are in the room, so this records what the student <em>says</em> rather
            than what the college observed — useful for online and blended teaching, and for a lecturer
            who cannot stop to take a register. Every other rule still applies: only while the class is
            running, only if they are on that register, and never over a mark you have already set.
            These marks are labelled <em>Self check-in (declared)</em> everywhere they appear, so you can
            always tell them apart from a tap or a scan.
          </span>
        </span>
      </label>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {num("lateAfterMins", "Late after (minutes)", "A check-in this long after the start records Late instead of Present.")}
        {num("earlyGraceMins", "Early grace (minutes)", "How long before a lecture starts check-ins are accepted. Zero means not before it starts.")}
        {num("armSeconds", "Button stays live (seconds)", "How long after touching a sticker the student has to press the button.", 600)}
        {num("qrRotateSeconds", "Code changes every (seconds)", "How long each code is shown. It keeps working for a few seconds after it changes, so a slow phone isn't punished. Shortest allowed is ten seconds.", 300)}
      </div>

      <label className="mt-4 flex items-start gap-3">
        <input type="checkbox" checked={draft.staffTapEnabled} disabled={saving} onChange={(e) => save({ staffTapEnabled: e.target.checked })} className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="text-[12px] leading-snug text-slate-600">
          <span className="font-semibold text-slate-800">Staff can clock in with the same stickers.</span>{" "}
          A tap always records <em>Onsite</em>, because they are in the building. Working online stays available from the Check-In screen.
        </span>
      </label>

      {/* Its own panel rather than a fourth switch in the stack above, because it is not a
          fourth way to check in — it is a condition on all three of the others at once.
          Listed beside them it would read as another capture method, which is precisely
          the wrong mental model for the thing that decides whether the other three work. */}
      <NetworkPanel draft={draft} saving={saving} save={save} rejected={rejected} />
      <GeofencePanel draft={draft} saving={saving} save={save} />
    </section>
  );
}

/* ------------------- the college network, as a condition ------------------- */

function NetworkPanel({ draft, saving, save, rejected }) {
  // The textarea is local until it is saved. Saving per keystroke would write a half-typed
  // range into the college's allowlist — and with the check on, a half-typed range refuses
  // students for as long as it takes to finish the line.
  const [text, setText] = useState((draft.allowedNetworks || []).join("\n"));
  const [seen, setSeen] = useState(null);   // what the SERVER says our address is
  useEffect(() => { setText((draft.allowedNetworks || []).join("\n")); }, [draft.allowedNetworks]);
  useEffect(() => { api.myAddress().then(setSeen).catch(() => setSeen(null)); }, [draft.allowedNetworks]);

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const dirty = JSON.stringify(lines) !== JSON.stringify(draft.allowedNetworks || []);
  // ANSWERED BY THE SERVER, not re-derived here.
  //
  // This compared the first three octets as text, which said "Already covered" to an
  // administrator sitting at 203.0.113.9 when the saved line was the bare address
  // 203.0.113.200 — a /32 that covers nothing but itself. They would stop, every student
  // would be refused, and the one diagnostic on this page would say it was fine: the exact
  // failure this panel exists to prevent.
  //
  // Reimplementing CIDR matching in the browser would have fixed the symptom and created
  // the real problem — two implementations of "is this address on the list", which is how
  // a screen and a server come to disagree about the same student. The server already owns
  // that arithmetic and now reports its own answer. It reflects what is SAVED, which is
  // also the only thing that can refuse anybody.
  const already = seen?.covered === true;

  return (
    <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
      <label className="flex items-start gap-3">
        <input
          type="checkbox" checked={draft.networkCheck} disabled={saving}
          onChange={(e) => save({ networkCheck: e.target.checked })}
          className="mt-0.5 h-4 w-4 shrink-0"
        />
        <span>
          <span className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-800">
            <Wifi size={15} style={{ color: NAVY }} />
            Check-in must come from the college network — {draft.networkCheck ? "ON" : "OFF"}
          </span>
          <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">
            Applies to all three: the stickers, the on-screen code and marking yourself in.
            A student on mobile data or at home is refused and told why. It does not affect
            a lecturer taking the register.
          </span>
        </span>
      </label>

      {draft.networkCheck && (
        <div className="mt-3.5 pl-7">
          <span className="text-[12px] font-semibold text-slate-700">The college's public IP ranges</span>
          <textarea
            value={text} onChange={(e) => setText(e.target.value)} rows={Math.max(3, lines.length + 1)}
            spellCheck={false} placeholder={"203.0.113.0/24\n198.51.100.7"}
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 font-mono text-[12px] tabular-nums"
          />
          <span className="mt-1 block text-[11px] leading-snug text-slate-500">
            One per line. A single address, or a range like <code>203.0.113.0/24</code>. Ask
            your IT team for the addresses the college's internet connection goes out on —
            not the ones inside the building, which every college shares.
          </span>

          {/* THE LINE THAT MAKES THIS SETUP SURVIVABLE. The likeliest failure is an
              administrator typing the address off a router, or the one a provider quoted
              years ago — after which every student is refused while this screen says the
              network is configured. So we show them what we can see from where they are
              sitting, and let them add it in one click. */}
          {seen?.allowlistable && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-slate-600">
              <span>You're connecting from <strong className="font-mono">{seen.ip}</strong>.</span>
              {already ? (
                <span className="text-emerald-700">Already covered.</span>
              ) : (
                <>
                  <button type="button" onClick={() => setText((t) => (t.trim() ? t.replace(/\s*$/, "\n") : "") + seen.ip)}
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1 font-semibold text-slate-700 hover:bg-slate-50">
                    Add this address
                  </button>
                  <span className="text-slate-400">
                    If you're on the college WiFi now, this is usually the one you want — but check with
                    IT that it's the college's own address. If your traffic goes through a filtering or
                    security service, this is that service's address, and allowlisting it would let in
                    everyone else who uses it too.
                  </span>
                </>
              )}
            </div>
          )}
          {/* A college whose traffic leaves over IPv6 cannot use this at all — the ranges
              are IPv4-only. Said here, while they are looking at the box, rather than
              discovered by a hall of students who cannot check in. */}
          {seen && !seen.allowlistable && (
            <div className="mt-2 text-[11.5px] leading-snug text-amber-800">
              You're connecting over IPv6 (<span className="font-mono">{seen.ip}</span>), which this
              check can't match yet. If that's how the whole college connects, leave this switched
              off and use the sticker or the code instead.
            </div>
          )}

          {rejected.length > 0 && (
            <div className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-[11.5px] leading-snug text-rose-800 ring-1 ring-rose-200">
              These lines weren't saved — they're either not valid addresses, or wide enough to
              let in networks that aren't yours (anything bigger than a /16):{" "}
              <span className="font-mono">{rejected.join(", ")}</span>. Everything else was saved.
            </div>
          )}

          {/* Switched on with nothing usable saved refuses EVERYBODY — that is the
              server's rule, and the alternative (reading an empty list as "no
              restriction") would mean this screen claims a control it is not applying.
              Since it is a real state a college can reach by ticking the box first, it is
              said here in the words of its consequence. */}
          {!draft.allowedNetworks?.length && (
            <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[11.5px] leading-snug text-amber-900 ring-1 ring-amber-200">
              No ranges saved yet, so <strong>nobody can check in</strong> — not even on the college
              WiFi. Add at least one, or switch this off.
            </div>
          )}

          <div className="mt-2.5">
            <button
              type="button" onClick={() => save({ allowedNetworks: lines })} disabled={!dirty || saving}
              className="rounded-xl px-3.5 py-2 text-[13px] font-semibold text-white disabled:cursor-not-allowed"
              style={{ background: dirty && !saving ? NAVY : "#94a3b8" }}
            >
              {saving ? "Saving…" : "Save ranges"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------- the campus boundary, as a condition ------------------- */

function GeofencePanel({ draft, saving, save }) {
  const [campuses, setCampuses] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [err, setErr] = useState("");
  const [radius, setRadius] = useState(draft.geofenceRadiusM);
  useEffect(() => { setRadius(draft.geofenceRadiusM); }, [draft.geofenceRadiusM]);

  const load = useCallback(() => {
    api.ttCampuses().then((rows) => setCampuses(rows.filter((c) => c.active))).catch(() => setCampuses([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  // Pinned FROM WHERE THE ADMINISTRATOR IS STANDING, rather than typed.
  //
  // The alternative is asking somebody to find coordinates on a map and copy two long
  // decimals into a form, where transposing a digit moves the campus a few hundred metres
  // and every student there is refused with no clue why. Standing in the building and
  // pressing a button cannot make that mistake — and it is the one moment when the phone's
  // own reading IS the answer we want.
  const pinHere = async (campus) => {
    setBusyId(campus.id); setErr("");
    const pos = await wherePhoneIs();
    if (!pos) {
      setErr("Couldn't read your location. Allow location for this site, then try again — and do it while you're on the campus.");
      setBusyId(null);
      return;
    }
    try {
      await api.ttUpdateCampus(campus.id, { latitude: pos.latitude, longitude: pos.longitude });
      load();
    } catch (e) { setErr(e?.message || "Could not save that location."); }
    finally { setBusyId(null); }
  };

  const unpin = async (campus) => {
    setBusyId(campus.id); setErr("");
    try {
      await api.ttUpdateCampus(campus.id, { latitude: null, longitude: null });
      load();
    } catch (e) { setErr(e?.message || "Could not clear that location."); }
    finally { setBusyId(null); }
  };

  const located = (campuses || []).filter((c) => c.latitude != null && c.longitude != null);

  return (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
      <label className="flex items-start gap-3">
        <input
          type="checkbox" checked={draft.geofenceCheck} disabled={saving}
          onChange={(e) => save({ geofenceCheck: e.target.checked })}
          className="mt-0.5 h-4 w-4 shrink-0"
        />
        <span>
          <span className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-800">
            <MapPin size={15} style={{ color: NAVY }} />
            Check-in must happen at a campus — {draft.geofenceCheck ? "ON" : "OFF"}
          </span>
          <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">
            The student's phone <em>tells us</em> where it is, and we check the distance. Applies
            to all three methods. A student who won't share their location is refused, so this
            asks something of every student on every check-in.
          </span>
        </span>
      </label>

      {/* SAID PLAINLY, ONCE, WHERE THE DECISION IS MADE. "Geofencing" sounds precise and is
          not: 10-50 metres indoors, worse through concrete. A college that believes this
          proves which ROOM a student is in will describe its attendance controls that way
          to an inspector, and be wrong. It is cheaper to say so here than to correct that
          conversation later. */}
      <p className="mt-2.5 pl-7 text-[11px] leading-snug text-slate-500">
        <strong className="font-semibold text-slate-600">What this can and can't show:</strong>{" "}
        it records that a phone <em>reported</em> being near the campus. It can't show which room —
        phone location is accurate to tens of metres indoors, and worse in a concrete building —
        and it can't prove the reading was honest, because the position is sent by the phone.
        It stops a student checking in from home by accident or out of habit; it won't stop
        someone who sets out to defeat it. Use the stickers for the room, and for proof.
      </p>

      {draft.geofenceCheck && (
        <div className="mt-3.5 space-y-3 pl-7">
          <div>
            <span className="text-[12px] font-semibold text-slate-700">How close counts as "at the campus"</span>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number" min="50" max="5000" step="10" value={radius}
                onChange={(e) => setRadius(Number(e.target.value))}
                onBlur={() => { if (radius !== draft.geofenceRadiusM) save({ geofenceRadiusM: radius }); }}
                className="w-28 rounded-lg border border-slate-200 px-3 py-2 text-sm tabular-nums"
              />
              <span className="text-[12px] text-slate-500">metres from the pin</span>
            </div>
            <span className="mt-1 block text-[11px] leading-snug text-slate-500">
              Big enough to cover the whole site, or students at the far end are turned away.
              Anything under 50 m is treated as 50 m — smaller isn't stricter, it just refuses
              the student standing in the room.
            </span>
          </div>

          {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-[11.5px] leading-snug text-rose-800 ring-1 ring-rose-200">{err}</div>}

          {/* NOT LOCATED YET refuses everybody, exactly like an empty network list, and for
              the same reason: a boundary that quietly stops applying wherever nobody set it
              is worse than no boundary, because this screen still claims it is enforced. */}
          {campuses && !located.length && (
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-[11.5px] leading-snug text-amber-900 ring-1 ring-amber-200">
              No campus has a location yet, so <strong>nobody can check in</strong>. Open this page
              while you're standing on the campus and press <em>Set from where I am</em>.
            </div>
          )}

          <div>
            <span className="text-[12px] font-semibold text-slate-700">Your campuses</span>
            {!campuses ? (
              <p className="mt-1 text-[12px] text-slate-400">Loading…</p>
            ) : !campuses.length ? (
              <p className="mt-1 text-[12px] text-slate-500">No campuses set up yet — add them under Timetabling → Rooms.</p>
            ) : (
              <ul className="mt-1 divide-y divide-slate-200 rounded-xl bg-white ring-1 ring-slate-200">
                {campuses.map((c) => {
                  const pinned = c.latitude != null && c.longitude != null;
                  return (
                    <li key={c.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-semibold text-slate-800">{c.name}</p>
                        <p className="text-[11px] text-slate-500">
                          {pinned ? (
                            <>
                              <span className="font-mono tabular-nums">{c.latitude.toFixed(5)}, {c.longitude.toFixed(5)}</span>
                              {c.locatedBy && <> · set by {c.locatedBy}</>}
                              {c.locatedAt && <> {fmtWhen(c.locatedAt)}</>}
                            </>
                          ) : (
                            <span className="text-amber-700">No location — check-in here is refused</span>
                          )}
                        </p>
                      </div>
                      {pinned && (
                        <button
                          type="button" onClick={() => unpin(c)} disabled={busyId === c.id}
                          className="press rounded-lg border border-slate-200 px-3 py-2 text-[12px] font-semibold text-slate-600"
                          title="Clear this location — use it if the campus was pinned in the wrong place"
                        >
                          Clear
                        </button>
                      )}
                      <button
                        type="button" onClick={() => pinHere(c)} disabled={busyId === c.id}
                        className="press flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-semibold text-white disabled:opacity-60"
                        style={{ background: NAVY }}
                      >
                        {busyId === c.id ? <><Loader2 size={13} className="animate-spin" /> Reading…</> : <><Crosshair size={13} /> Set from where I am</>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <span className="mt-1 block text-[11px] leading-snug text-slate-500">
              Press the button while you're on that campus. It reads your phone or laptop's own
              location — which is why typing coordinates isn't offered: one transposed digit puts
              the campus a few streets away and every student there is refused.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------ Teams online classes ------------------------- */

// A separate card from TapSettings on purpose, not a fourth switch inside it: taps, QR
// and self-declare all capture attendance from a phone in a room, and this one reads a
// Microsoft attendance report for a class that may never have had a room at all. It has
// its own connection state ("configured" — is Teams reachable) layered under its own
// on/off switch ("enabled" — should it write to the register), because a college can
// get as far as saving credentials, testing the connection under Connected systems, and
// only THEN decide it trusts the marks enough to switch writing on.
function TeamsAttendance() {
  const [state, setState] = useState(null); // { settings, configured, running }
  const [runs, setRuns] = useState(null);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // The outcome of a sync run FROM THIS SESSION — {ok, summary, issues} or {ok:false,
  // note}. Kept apart from the runs list below (which is the server's permanent record)
  // the same way ProviderCard's `test` is kept apart from the stored integration: this
  // is what just happened, not history.
  const [syncMsg, setSyncMsg] = useState(null);

  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([api.teamsAttendanceSettings(), api.teamsAttendanceRuns()]);
      setState(s); setRuns(r.runs); setErr("");
    } catch (e) { setErr(e?.message || "Could not load the Teams attendance settings."); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // EVERY hook above this line — see TapSettings's own comment on React #310: a
  // useState below an early return changes the hook count between the loading render
  // and the render after `state` arrives, and that is a crash, not a glitch.
  if (!state) return err ? <div className="rounded-2xl border border-slate-200 bg-white p-5"><Banner tone="rose" Icon={AlertTriangle}>{err}</Banner></div> : null;

  const { settings, configured, running } = state;

  const save = async (patch) => {
    setSaving(true); setErr("");
    try {
      const { settings: saved } = await api.saveTeamsAttendanceSettings(patch);
      setState((s) => ({ ...s, settings: saved }));
    } catch (e) { setErr(e?.message || "Could not save."); }
    finally { setSaving(false); }
  };

  const sync = async () => {
    setSyncing(true); setSyncMsg(null); setErr("");
    try {
      const r = await api.syncTeamsAttendance();
      setSyncMsg(r);
      load(); // picks up settings.running having cleared, plus the run just written
    } catch (e) {
      // 409 (unconfigured or already running) and 502 (the Graph call itself failed)
      // both land here as an ordinary message — the server already chose the words.
      setSyncMsg({ ok: false, note: e?.message || "The sync failed." });
    } finally { setSyncing(false); }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-bold text-slate-800">
        <Video size={16} style={{ color: NAVY }} />Teams online classes
      </h3>
      <p className="mb-4 text-[12px] leading-relaxed text-slate-500">
        Reads who attended each online class from its Microsoft Teams attendance report
        once it has ended, and fills the register automatically — Present, Late or
        Absent, from how long a student was actually in the meeting. A mark a lecturer
        already set is never overwritten, and a student the report cannot place is
        reported below rather than guessed at.
      </p>

      {!configured && (
        <div className="mb-4">
          <Banner tone="amber" Icon={AlertTriangle}>
            Not connected yet. Enter the Teams credentials and organizer accounts under
            Connected systems, then come back here to switch this on.
          </Banner>
        </div>
      )}
      {err && <div className="mb-3"><Banner tone="rose" Icon={AlertTriangle}>{err}</Banner></div>}

      <label className="mb-4 flex items-start gap-3 rounded-xl bg-slate-50 p-3.5">
        <input
          type="checkbox" checked={settings.enabled} disabled={saving || !configured}
          onChange={(e) => save({ enabled: e.target.checked })}
          className="mt-0.5 h-4 w-4 shrink-0"
        />
        <span>
          <span className="block text-[13px] font-semibold text-slate-800">
            Teams auto-attendance is {settings.enabled ? "ON" : "OFF"}
          </span>
          <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">
            While this is off, nothing runs at all — no calendars are read, no meetings
            are matched to classes, and nothing is written to any register. Matching
            begins on the first sync after you switch this on, so the first run may take
            a little longer than the hourly ones after it.
            {!configured && " It cannot be switched on until Teams is connected."}
          </span>
        </span>
      </label>

      <label className="block max-w-xs">
        <span className="text-[12px] font-semibold text-slate-700">Present needs at least</span>
        <div className="mt-1 flex items-center gap-2">
          <input
            type="number" min="1" max="100" value={settings.minAttendancePct} disabled={saving}
            onChange={(e) => setState((s) => ({ ...s, settings: { ...s.settings, minAttendancePct: Number(e.target.value) } }))}
            onBlur={(e) => { const v = Number(e.target.value); if (v !== settings.minAttendancePct) save({ minAttendancePct: v }); }}
            className="w-24 rounded-lg border border-slate-200 px-3 py-2 text-sm tabular-nums"
          />
          <span className="text-[12px] text-slate-500">% of the class</span>
        </div>
        <span className="mt-1 block text-[11px] leading-snug text-slate-500">
          Below this share of the class's length, a student who joined is marked Absent
          with the minutes they were in noted on the register — a student never seen in
          the meeting at all is always Absent, whatever this is set to.
        </span>
      </label>

      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        <button
          type="button" onClick={sync} disabled={syncing || running || !configured}
          className="press flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold text-white disabled:opacity-60"
          style={{ background: NAVY }}
        >
          {syncing || running ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          {running ? "A sync is already running…" : syncing ? "Syncing…" : "Sync now"}
        </button>
        <span className="text-[11px] text-slate-400">
          Runs on its own once an hour as well — this is for checking a class right after
          it ends, without waiting.
        </span>
      </div>

      {syncMsg && (
        <div className={`mt-3 rounded-xl px-3.5 py-3 text-[13px] ring-1 ${syncMsg.ok ? "bg-slate-50 text-slate-700 ring-slate-200" : "bg-rose-50 text-rose-800 ring-rose-200"}`}>
          {syncMsg.ok ? (
            <>
              <p className="font-semibold text-emerald-700">Sync finished.</p>
              <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[12px] text-slate-600 sm:grid-cols-3">
                <li>Meetings found: <b>{syncMsg.summary.meetingsDiscovered}</b></li>
                <li>Classes matched: <b>{syncMsg.summary.sessionsMatched}</b></li>
                <li>Ambiguous: <b>{syncMsg.summary.sessionsAmbiguous}</b></li>
                <li>Reports fetched: <b>{syncMsg.summary.reportsFetched}</b></li>
                <li>Marks written: <b>{syncMsg.summary.marksCreated}</b></li>
                <li>Already marked: <b>{syncMsg.summary.marksSkippedExisting}</b></li>
                <li>Unmatched people: <b>{syncMsg.summary.participantsUnmatched}</b></li>
              </ul>
              {/* THE LINE THIS WHOLE PANEL EXISTS FOR — "reported, never guessed" needs
                  somewhere a human actually reads it. Rendered even on an otherwise
                  clean run, because an ambiguous class or an unmatched participant is a
                  register a lecturer still needs to check by hand. */}
              {syncMsg.issues?.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] text-slate-500">
                  {syncMsg.issues.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              )}
            </>
          ) : (
            <p>{syncMsg.note}</p>
          )}
        </div>
      )}

      <div className="mt-5 border-t border-slate-100 pt-4">
        <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">
          <History size={13} />Recent runs
        </h4>
        {!runs ? (
          <p className="text-[12px] text-slate-400">Loading…</p>
        ) : !runs.length ? (
          <p className="text-[12px] text-slate-500">No syncs have run yet — scheduled runs happen hourly once this is switched on.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {runs.map((r) => {
              const tone = r.status === "ok" ? "emerald" : r.status === "failed" ? "rose" : "slate";
              return (
                <li key={r.id} className="px-3.5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] font-semibold text-slate-700">{fmtWhen(r.startedAt)}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${TONES[tone]}`}>{r.status}</span>
                    <span className="text-[11px] text-slate-400">
                      {r.mode === "scheduled" ? "hourly" : "manual"}{r.startedBy ? ` · ${r.startedBy}` : ""}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {r.summary?.marksCreated ?? 0} marked · {r.summary?.sessionsAmbiguous ?? 0} ambiguous ·{" "}
                    {r.summary?.participantsUnmatched ?? 0} unmatched people
                  </p>
                  {r.error && <p className="mt-1 text-[11px] font-medium text-rose-600">{r.error}</p>}
                  {/* Same "reported, never guessed" lines as a fresh sync's own result, but
                      read back from the row rather than session state — this is what
                      makes an hourly SCHEDULED run's unmatched people visible at all,
                      since nobody was watching this screen when it ran. */}
                  {r.issues?.length > 0 && (
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-slate-500">
                      {r.issues.map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
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
  // Mirrors `label` so an in-flight scan reads what is on screen now, not what was there
  // when the scan started.
  const labelRef = useRef("");
  useEffect(() => { labelRef.current = label; }, [label]);

  useEffect(() => { nfcStatus().then(setNfc); }, []);

  const create = async (code, labelOverride) => {
    const name = (labelOverride ?? label).trim();
    if (!name) { setErr("Give the sticker a name first: the room it will live in."); return; }
    setSaving(true); setErr("");
    try {
      const t = await api.createTag(name, code);
      setCreated(t); setLabel(""); onCreated();
    } catch (e) { setErr(e?.message || "Could not register that sticker."); }
    finally { setSaving(false); }
  };

  const tapToRegister = async () => {
    if (!label.trim()) { setErr("Give the sticker a name first: the room it will live in."); return; }
    setScanning(true); setErr("");
    try {
      const code = await scanOnce({ alertMessage: "Hold your phone near the new sticker" });
      // From the ref, not the closure. A scan can take thirty seconds, the input stays
      // editable throughout, and a name corrected while holding the phone to the sticker
      // was silently discarded — the tag registered under the old one.
      await create(code, labelRef.current);
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
                  onClick={async () => {
                    // The promise can reject even where the API exists — denied permission,
                    // or a non-secure context. Claiming "Copied" when nothing was is worse
                    // here than anywhere else: this code is shown exactly once, so a false
                    // confirmation loses the sticker.
                    try {
                      await navigator.clipboard.writeText(created.code);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1800);
                    } catch (_) {
                      setErr("Could not copy. Select the code and copy it by hand before leaving this screen.");
                    }
                  }}
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
        {nfc?.ok && nfc.readsUnwritten && (
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

      {/* Three genuinely different situations, and collapsing them would leave an admin
          hunting for a button that is missing for a reason. An iPhone can scan perfectly
          well; it just cannot see a sticker with nothing written on it, because Core NFC
          is held to an NDEF session here deliberately — see nfc.js. */}
      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        {nfc?.ok && nfc.readsUnwritten
          ? "Tapping a blank sticker is the quicker route: nothing to write and nothing to transcribe."
          : nfc?.ok
            ? "An iPhone can't read a blank sticker, so generate a code here and write it on with an NFC writing app, or register the sticker on an Android phone, where tapping a blank one is enough."
            : "On an Android phone with NFC you can register a blank sticker just by tapping it, with nothing to write."}
      </p>
    </section>
  );
}

/* ------------------------------- tap log ------------------------------- */

function TapLog({ tag, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => { api.tagLog(tag.id).then(setData).catch((e) => setErr(e?.message || "Could not load the taps for this sticker.")); }, [tag.id]);
  // Escape closes it. Without this the only way out on a keyboard was to tab to a close
  // button that had no accessible name either.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-6" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={"Taps on " + tag.label}
        className="max-h-[85vh] w-full max-w-2xl overflow-hidden rounded-t-2xl bg-white sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <div>
            <h3 className="text-sm font-bold text-slate-800">{tag.label}</h3>
            <p className="text-[12px] text-slate-500">Recent taps, including the ones that were refused</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="press rounded-lg p-2.5 text-slate-500 hover:bg-slate-50"><X size={17} /></button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto">
          {err && <p className="p-5 text-sm text-rose-600">{err}</p>}
          {!data && !err && <div className="flex justify-center p-10"><Loader2 className="animate-spin text-slate-300" size={24} /></div>}
          {data && !data.taps.length && <p className="p-8 text-center text-sm text-slate-500">Nobody has tapped this sticker yet.</p>}
          {data && data.taps.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {data.taps.map((t) => {
                const o = OUTCOMES[t.outcome] || { label: t.outcome, tone: "slate" };
                return (
                  <li key={t.id} className="flex flex-wrap items-center gap-2.5 px-5 py-3">
                    <Clock3 size={13} className="shrink-0 text-slate-300" />
                    <span className="w-[104px] shrink-0 text-[12px] tabular-nums text-slate-500">{fmtWhen(t.at)}</span>
                    <span className="min-w-[6.5rem] flex-1 truncate text-[13px] font-medium text-slate-800">
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
