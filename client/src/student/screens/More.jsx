import { useState } from "react";
import {
  KeyRound, Lock, Trash2, AlertTriangle, LogOut, CheckCircle2, Loader2, CalendarDays, Info,
  HeartHandshake, HeartPulse, QrCode, Nfc,
} from "lucide-react";
import { Screen, Card, Row } from "../ui";
import useReveal from "../../RevealButton";
import ConfirmDialog from "../../ConfirmDialog";
import { useBackHandler } from "../../backButton";
import { api, setToken } from "../../api";
import { NAVY, MAROON, alpha } from "../../branding";
import { BiometricSetting } from "../BiometricSetting";

// What the More screen says about check-in, in every state. This exists so there is one
// place a student — or the person setting the college up — can always look and get a
// straight answer, rather than an absence they have to interpret.
function CheckInStatusRow({ tapContext, setScreen }) {
  const loading = tapContext == null;
  // BOTH switches, not just the sticker one. A college running codes only had this row
  // saying check-in was not switched on while the Check In tab, three taps away, said
  // "Scan to check in" — the same two switches the tab already reads.
  const stickers = !loading && tapContext.enabled;
  const codes = !loading && tapContext.qrEnabled;
  const off = !loading && !stickers && !codes;
  const running = (tapContext?.now || []).length;
  const next = tapContext?.next;

  // Named for what the student can actually do. "with a sticker" is only true where the
  // sticker is the only way in.
  const title = stickers && !codes ? "Check in with a sticker" : "Check in";
  const Glyph = codes ? QrCode : Nfc;

  const body = loading
    ? "Checking…"
    : off
      ? "Your college hasn't switched check-in on yet. When it does, the Check In tab will show you how."
      : running
        ? `${running > 1 ? "Your classes are running now" : `${tapContext.now[0].unitName || tapContext.now[0].unitCode} is running now`}. ${codes && !stickers ? "Open the Check In tab and scan the code on screen." : "Open the Check In tab."}`
        : next
          ? `Nothing to check in to yet. Your next class starts at ${next.startTime}.`
          : "No more classes today.";

  return (
    <button
      type="button"
      onClick={() => setScreen("checkin")}
      disabled={loading || off}
      className="press flex w-full items-start gap-3 rounded-2xl bg-white p-4 text-left ring-1 ring-slate-200 disabled:cursor-default dark:bg-slate-800 dark:ring-slate-700"
    >
      {/* NAVY is a CSS var (the college's brand colour); alpha() builds a valid
          low-alpha tint from it the way `NAVY + "14"` cannot (see branding.js#alpha's
          own comment — that string-append trick silently drops the whole background
          declaration once the colour is a var()). */}
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-700" style={off ? {} : { background: alpha(NAVY, 14) }}>
        <Glyph size={17} style={{ color: off ? "#94a3b8" : NAVY }} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-bold text-slate-800 dark:text-slate-100">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-slate-500 dark:text-slate-400">{body}</span>
      </span>
    </button>
  );
}

export function MoreScreen({ user, logout, setScreen, tapContext }) {
  const [cur, setCur] = useState(""); const [nw, setNw] = useState(""); const [cf, setCf] = useState("");
  const [pwBusy, setPwBusy] = useState(false); const [pwErr, setPwErr] = useState(""); const [pwOk, setPwOk] = useState(false);
  const [openPw, setOpenPw] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const [showDel, setShowDel] = useState(false);
  // Back collapses the delete-account form first (it holds a typed password), the
  // same way the sign-out ConfirmDialog cancels on back.
  useBackHandler(showDel, () => { setShowDel(false); return true; });
  const [delPw, setDelPw] = useState(""); const [delConfirm, setDelConfirm] = useState("");
  const [delBusy, setDelBusy] = useState(false); const [delErr, setDelErr] = useState("");

  const changePw = async () => {
    setPwErr(""); setPwOk(false);
    if (nw.length < 8) { setPwErr("New password must be at least 8 characters."); return; }
    if (nw !== cf) { setPwErr("New passwords do not match."); return; }
    setPwBusy(true);
    try { const res = await api.changePassword(cur, nw); if (res?.token) setToken(res.token); try { const m = await import("../../rememberEmail"); m.forgetRememberedPassword(); } catch (_) {} setCur(""); setNw(""); setCf(""); setPwOk(true); setOpenPw(false); }
    catch (e) { setPwErr(e.message || "Could not change your password."); }
    finally { setPwBusy(false); }
  };

  const del = async () => {
    setDelErr("");
    if (delConfirm.trim().toUpperCase() !== "DELETE") { setDelErr('Type DELETE to confirm.'); return; }
    setDelBusy(true);
    try { await api.deleteAccount(delPw, delConfirm.trim().toUpperCase()); logout(); }
    catch (e) { setDelErr(e.message || "Could not delete your account."); setDelBusy(false); }
  };

  return (
    <Screen>
      <ConfirmDialog open={confirmOut} title="Sign out?" message="You'll need to sign in again to get back in." confirmLabel="Sign out" cancelLabel="Stay" danger onConfirm={logout} onCancel={() => setConfirmOut(false)} />

      {/* Profile */}
      <Card className="!p-5 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl text-xl font-bold text-white shadow-lg" style={{ background: user.colour || MAROON }}>{user.initials || "S"}</div>
        <p className="mt-2.5 text-base font-extrabold text-slate-800 dark:text-slate-100">{user.name}</p>
        <p className="text-xs text-slate-400 dark:text-slate-500">{user.email}</p>
        {user.studentRef && <span className="mt-2 inline-block rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-500 dark:bg-slate-700 dark:text-slate-300">Student · {user.studentRef}</span>}
      </Card>

      {/* Always present, in every state. The home card only appears when a class is
          actually checkable, which is right for a student but left nobody able to tell
          "switched off" from "not built" — the reason this was reported missing. */}
      <CheckInStatusRow tapContext={tapContext} setScreen={setScreen} />

      {/* The second way in. Home only shows a review card once one exists, so this row
          is what makes the screen findable — and it's here whether there are any or not. */}
      <Card className="!p-0 overflow-hidden">
        <Row Icon={CalendarDays} label="My timetable" sub="Your weekly classes" onClick={() => setScreen("timetable")} />
        <Row Icon={Info} label="My progress reviews" sub="What your lecturers have written" onClick={() => setScreen("reviews")} />
        {/* Reached from More rather than the tab bar: six tabs is already the most a
            thumb can find, and this is a screen a student visits when something has
            happened rather than every day. */}
        <Row Icon={HeartHandshake} label="Support referrals" sub="Teams you have been referred to" onClick={() => setScreen("support")} />
        {/* Mitigating circumstances — its own row rather than folded into Support:
            those are two different queues, read by two different sets of staff, and
            merging their entry points would misfile a health-and-deadlines claim as
            a general support request. */}
        <Row Icon={HeartPulse} label="Mitigating circumstances" sub="Tell the college about your circumstances" onClick={() => setScreen("mitigations")} />
      </Card>

      {pwOk && <div className="flex items-center gap-2 rounded-2xl bg-emerald-50 px-3.5 py-3 text-xs font-bold text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800"><CheckCircle2 size={15} /> Password changed.</div>}

      {/* Settings rows */}
      <Card className="!p-0 overflow-hidden">
        {/* Always renders something — the options, or why they aren't available. */}
        <BiometricSetting owner={user.email} />
        <Row Icon={KeyRound} label="Change password" sub="Update your sign-in password" onClick={() => setOpenPw(v => !v)} open={openPw} />
        {openPw && (
          <div className="space-y-2.5 border-t border-slate-100 bg-slate-50 p-3.5 dark:border-slate-700 dark:bg-slate-700/40">
            <PwField label="Current password" value={cur} onChange={setCur} disabled={pwBusy} />
            <PwField label="New password" value={nw} onChange={setNw} disabled={pwBusy} />
            <PwField label="Confirm new password" value={cf} onChange={setCf} disabled={pwBusy} />
            {pwErr && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600 dark:bg-rose-950/40 dark:text-rose-300">{pwErr}</p>}
            <button onClick={changePw} disabled={pwBusy || !cur || !nw} className="press flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold text-white shadow disabled:opacity-60" style={{ background: NAVY }}>
              {pwBusy ? <><Loader2 size={15} className="animate-spin" /> Saving…</> : <><Lock size={15} /> Update password</>}
            </button>
          </div>
        )}
        <Row Icon={LogOut} label="Sign out" sub="You'll need to sign in again" onClick={() => setConfirmOut(true)} />
      </Card>

      {/* Danger zone */}
      <Card className="!p-0 overflow-hidden !ring-rose-200 dark:!ring-rose-900">
        {!showDel ? (
          <Row Icon={Trash2} label="Delete my account" sub="Permanently remove your app access" danger onClick={() => setShowDel(true)} />
        ) : (
          <div className="space-y-2.5 p-3.5">
            <p className="flex items-start gap-1.5 rounded-xl bg-rose-50 px-3 py-2.5 text-[11px] leading-relaxed text-rose-700 ring-1 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-800">
              <AlertTriangle size={14} className="mt-px shrink-0" />
              This removes your sign-in access and personal login data. Your college records (attendance and results) are kept by the college. This cannot be undone.
            </p>
            <PwField label="Your password" value={delPw} onChange={setDelPw} disabled={delBusy} />
            <div>
              <label className="text-[11px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">Type DELETE to confirm</label>
              <input value={delConfirm} onChange={e => setDelConfirm(e.target.value)} disabled={delBusy} placeholder="DELETE" className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-800 outline-none focus:ring-2 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100" style={{ "--tw-ring-color": MAROON }} />
            </div>
            {delErr && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600 dark:bg-rose-950/40 dark:text-rose-300">{delErr}</p>}
            <div className="flex gap-2">
              <button onClick={() => { setShowDel(false); setDelErr(""); }} disabled={delBusy} className="press flex-1 rounded-xl border-2 border-slate-200 py-2.5 text-sm font-bold text-slate-500 dark:border-slate-600 dark:text-slate-400">Cancel</button>
              <button onClick={del} disabled={delBusy || !delPw} className="press flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold text-white shadow disabled:opacity-60" style={{ background: MAROON }}>
                {delBusy ? <><Loader2 size={15} className="animate-spin" /> Deleting…</> : <><Trash2 size={15} /> Delete</>}
              </button>
            </div>
          </div>
        )}
      </Card>

      <p className="px-1 pb-2 text-center text-[10px] text-slate-400 dark:text-slate-500">EdTech · Student Hub</p>
    </Screen>
  );
}

function PwField({ label, value, onChange, disabled }) {
  // One hook per instance, so each field on the change-password form reveals on its own.
  const pw = useReveal();
  return (
    <div>
      <label className="text-[11px] font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">{label}</label>
      <div className="relative mt-1">
        <input type={pw.type} value={value} onChange={e => onChange(e.target.value)} disabled={disabled} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 pr-11 text-sm text-slate-800 outline-none focus:ring-2 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100" style={{ "--tw-ring-color": NAVY }} />
        {pw.button}
      </div>
    </div>
  );
}

export default MoreScreen;
