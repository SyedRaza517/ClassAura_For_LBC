import React, { useState, useCallback, useEffect } from "react";
import useReveal from "./RevealButton";
import { useAuth } from "./auth";
import { useApiStore } from "./store";
import { api } from "./api";
import Login from "./Login";
import Landing from "./Landing";
import MobileAuth from "./MobileAuth";
import ResetPasswordPage from "./ResetPassword";
import AcceptInvite from "./AcceptInvite";
import AdmissionUpload from "./AdmissionUpload";
import AdmissionOffer from "./AdmissionOffer";
import AdmissionApply from "./AdmissionApply";
import { useIsHandset, isNativeApp } from "./PhoneShell";
import { BrandMark } from "./Brand";
import { getBranding, onBranding } from "./branding";
import StudentApp from "./StudentApp";
import ApplicantPortal, { ApplicantAuth } from "./ApplicantPortal";
import ConfirmDialog from "./ConfirmDialog";
import BiometricGate, { useAppLock, BiometricSetupPrompt } from "./BiometricGate";
import { useBackHandler } from "./backButton";
import { StaffApp, AdminDashboard } from "./StaffHub";
import { capturePendingQr, hasPendingQr, clearPendingQr } from "./pendingQr";
import { LogOut, CheckCircle2, XCircle, Sparkles, Loader2, GraduationCap, Clock, KeyRound, Lock, ShieldCheck, X, WifiOff } from "lucide-react";

import { NAVY, NAVY_DARK, MAROON } from "./branding";
const initialsOf = (name) => String(name || "").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

// Small live clock for the top bar (ticks every 30s).
function LiveClock() {
  const [t, setT] = useState(new Date());
  useEffect(() => { const i = setInterval(() => setT(new Date()), 30000); return () => clearInterval(i); }, []);
  return <span className="hidden items-center gap-1 tabular-nums text-slate-300 md:inline-flex"><Clock size={12} /> {t.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>;
}

// Shared change-password form. Used both by the forced-reset gate (full screen)
// and by the in-app modal for already-onboarded users. On success it calls
// onSuccess() — the parent decides what to do (refresh user / close modal).
function ChangePassword({ onSuccess, busyLabel = "Updating…", submitLabel = "Update password" }) {
  const revCurrent = useReveal();
  const revNext = useReveal();
  const revConfirm = useReveal();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (next.length < 8) { setError("New password must be at least 8 characters."); return; }
    if (next !== confirm) { setError("New password and confirmation do not match."); return; }
    if (next === current) { setError("New password must be different from your current one."); return; }
    setBusy(true);
    try {
      // The server bumps tokenVersion to sign out every other device, so it hands
      // back a fresh token for THIS session — the caller must store it or we'd
      // immediately 401 ourselves.
      const res = await api.changePassword(current, next);
      // The remembered password is now the OLD one. Left in place it prefills the
      // sign-in form with a value that can only fail — which is how a new starter,
      // fresh off the forced-change gate, locked themselves out by retrying it.
      try { const m = await import("./rememberEmail"); m.forgetRememberedPassword(); } catch (_) {}
      await onSuccess?.(res);
    } catch (err) {
      setError(err.message || "Could not change password.");
    } finally {
      setBusy(false);
    }
  };

  const field = (label, value, setValue, Icon, reveal) => (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      <div className="relative">
        <Icon size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          type={reveal.type}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
          autoComplete="off"
          className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-9 pr-11 text-sm text-slate-800 outline-none transition focus:border-transparent focus:ring-2 disabled:opacity-60"
          style={{ "--tw-ring-color": NAVY }}
        />
        {reveal.button}
      </div>
    </label>
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-3.5">
      {field("Current password", current, setCurrent, Lock, revCurrent)}
      {field("New password", next, setNext, KeyRound, revNext)}
      {field("Confirm new password", confirm, setConfirm, KeyRound, revConfirm)}
      <p className="text-[11px] text-slate-400">Use at least 8 characters. Choose something you haven't used here before.</p>
      {error && (
        <div className="pop flex items-center gap-2 rounded-xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 ring-1 ring-rose-200">
          <XCircle size={14} /> {error}
        </div>
      )}
      <button
        type="submit"
        disabled={busy}
        className="press shine mt-1 flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold text-white shadow-lg transition disabled:cursor-not-allowed disabled:opacity-70"
        style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}
      >
        {busy ? <><Loader2 size={16} className="animate-spin" /> {busyLabel}</> : <><ShieldCheck size={16} /> {submitLabel}</>}
      </button>
    </form>
  );
}

// Full-screen branded gate shown when user.mustChangePassword is true.
function ChangePasswordGate({ user, onDone, logout }) {
  return (
    <div
      className="animated-gradient flex min-h-screen w-full items-center justify-center p-4"
      style={{ fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", background: `linear-gradient(160deg, ${NAVY} 0%, ${NAVY_DARK} 55%, #0f172a 100%)`, backgroundSize: "220% 220%" }}
    >
      <style>{GLOBAL_STYLE}</style>
      <div className="scale-in w-full max-w-md rounded-3xl bg-white p-7 shadow-2xl ring-1 ring-black/5">
        <div className="fade-up flex flex-col items-center text-center">
          <div className="float relative mb-3 flex h-14 w-14 items-center justify-center rounded-2xl text-white shadow-lg" style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}>
            <KeyRound size={26} />
          </div>
          <h1 className="text-xl font-extrabold tracking-tight gradient-text" style={{ fontFamily: "'Lora', serif" }}>Set a new password</h1>
          <p className="mt-1 text-sm text-slate-500">
            Welcome{user?.name ? `, ${user.name.split(/\s+/)[0]}` : ""}. For your security you must choose a new password before continuing.
          </p>
        </div>
        <div className="fade-up mt-5">
          <ChangePassword onSuccess={onDone} busyLabel="Securing account…" submitLabel="Set password & continue" />
        </div>
        <button onClick={logout} className="press mt-4 w-full text-center text-xs font-semibold text-slate-400 transition hover:text-slate-600">
          Sign out instead
        </button>
      </div>
    </div>
  );
}

const GLOBAL_STYLE = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Lora:ital,wght@0,500;0,600;1,500&display=swap');

/* ---- entrance keyframes (subtle) ---- */
@keyframes fadeUp{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
@keyframes pop{0%{transform:scale(.96);opacity:0}100%{transform:scale(1);opacity:1}}
@keyframes slideIn{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:none}}
@keyframes slideDown{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
@keyframes scaleIn{from{opacity:0;transform:scale(.975)}to{opacity:1;transform:scale(1)}}
@keyframes bounceIn{0%{opacity:0;transform:scale(.8)}60%{transform:scale(1.015)}100%{opacity:1;transform:scale(1)}}

/* ---- ambient / looping (gentle) ---- */
@keyframes floaty{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
@keyframes floatySlow{0%,100%{transform:translateY(0) rotate(0)}50%{transform:translateY(-5px) rotate(1.5deg)}}
@keyframes shimmer{0%{background-position:-468px 0}100%{background-position:468px 0}}
@keyframes gradientShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
@keyframes glowPulse{0%,100%{box-shadow:0 0 0 0 rgba(26,58,143,0)}50%{box-shadow:0 0 14px 1px rgba(26,58,143,.12)}}
@keyframes shine{0%{left:-60%}100%{left:140%}}
@keyframes pulseRing{0%{transform:scale(.9);opacity:.5}80%,100%{transform:scale(1.4);opacity:0}}

/* ---- entrance utility classes ---- */
.fade-up{animation:fadeUp .45s cubic-bezier(.2,.7,.3,1) both}
.pop{animation:pop .3s cubic-bezier(.2,.8,.3,1) both}
.slide-in{animation:slideIn .35s cubic-bezier(.2,.8,.3,1) both}
.slide-down{animation:slideDown .25s ease both}
.scale-in{animation:scaleIn .4s cubic-bezier(.2,.7,.3,1) both}
.bounce-in{animation:bounceIn .5s cubic-bezier(.2,.7,.3,1.1) both}
.float{animation:floaty 6s ease-in-out infinite}
.float-slow{animation:floatySlow 9s ease-in-out infinite}
.glow-pulse{animation:glowPulse 3.6s ease-in-out infinite}

/* ---- hover micro-interactions (restrained) ---- */
.hover-lift{transition:transform .25s cubic-bezier(.2,.7,.3,1),box-shadow .25s ease}
.hover-lift:hover{transform:translateY(-2px);box-shadow:0 10px 24px -14px rgba(20,48,111,.3)}
.hover-glow{transition:box-shadow .3s ease,transform .3s ease}
.hover-glow:hover{box-shadow:0 8px 22px -10px rgba(26,58,143,.25)}
.press{transition:transform .12s ease}
.press:active{transform:scale(.97)}

/* ---- animated gradients & text (slow drift) ---- */
.animated-gradient{background-size:180% 180%;animation:gradientShift 16s ease infinite}
.gradient-text{background:linear-gradient(90deg,var(--brand-primary),#6d28d9,var(--brand-accent),var(--brand-primary));background-size:300% auto;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;animation:gradientShift 12s ease infinite}

/* ---- shine sweep (buttons/cards) ---- */
.shine{position:relative;overflow:hidden}
.shine::after{content:"";position:absolute;top:0;left:-60%;width:40%;height:100%;background:linear-gradient(110deg,transparent,rgba(255,255,255,.3),transparent);transform:skewX(-18deg);pointer-events:none}
.shine:hover::after{animation:shine 1s ease}

/* ---- skeleton shimmer ---- */
.skeleton{background:linear-gradient(90deg,#eef1f6 25%,#e2e8f0 37%,#eef1f6 63%);background-size:800px 100%;animation:shimmer 1.5s linear infinite}

::-webkit-scrollbar{width:9px;height:9px}
::-webkit-scrollbar-thumb{background:#c5ccda;border-radius:8px;transition:background .2s}
::-webkit-scrollbar-thumb:hover{background:#a3adc2}
::-webkit-scrollbar-track{background:transparent}
input,select,textarea,button{font-family:inherit}
html{scroll-behavior:smooth}

@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}
}
`;

// "#checkin=<sessionId>.<code>" — a student's camera opening the code on a projector.
// Captured at module load, before anything renders or the fragment can be lost to a
// navigation, and stripped from the address bar in the same breath. The stash-and-strip
// lives in pendingQr.js; the WHY of the fragment shape is documented there.
capturePendingQr();

export default function App() {
  const { user, loading, logout, refreshUser, applySession, offline, retryRestore, abandonRestore } = useAuth();
  // Which front door the visitor picked: null = still on the landing screen,
  // "app" = the staff mobile app's own sign in / sign up, "admin" = dashboard login.
  // It also decides which view they land in once signed in.
  //
  // A freshly scanned check-in code skips the chooser and opens the app sign-in: the
  // person holding it is a student standing in a running class, and every extra tap
  // between the scan and the mark is time the code spends expiring. Staff who somehow
  // scan one lose nothing — "Staff App" is where they sign in anyway.
  // WHERE AN UNAUTHENTICATED VISITOR STARTS.
  //
  // The packaged app opens straight on the sign-in screen; the web build still opens on
  // the Landing chooser. That split is new — both used to open on the chooser — and the
  // reasoning on each side is different, so both are written down.
  //
  //   Packaged app. Everybody who installs ClassAura from a store has an account at the
  //   college: staff and students both sign in through MobileAuth, which is one screen
  //   for both. Making them choose "Staff App" out of three tiles before they may type a
  //   password is a step that exists only because the WEB build has to serve three
  //   audiences off one URL. The app does not; it has a front door of its own.
  //
  //   Web. Unchanged. The chooser is the only thing distinguishing the admin dashboard
  //   (a separate sign-in, 2FA) and the public Student Portal from the staff app on a
  //   single origin, so it stays.
  //
  // THE CHOOSER IS STILL REACHABLE IN THE APP, and that is not a nicety. The Student
  // Portal is the public entry point — a prospective student registers and applies with
  // no college account — and it is what makes this a general-audience app rather than a
  // login wall, which App Review reads as a reason to reject. MobileAuth's header back
  // button calls onExit, which lands on Landing. One tap away instead of zero, not gone.
  //
  // A pending scan still wins over both: somebody who scanned a projector code is
  // standing in a running class and needs the sign-in, not a menu.
  const [entry, setEntry] = useState(() => (hasPendingQr() || isNativeApp() ? "app" : null));
  // A "?reset=<token>" link from a password-reset email. Read once on mount so that
  // clearing the query string later doesn't yank the screen away mid-flow.
  const [resetToken, setResetToken] = useState(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("reset");
  });
  // "?invite=<token>" — an admin-created account being activated for the first time.
  const [inviteToken, setInviteToken] = useState(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("invite");
  });
  // "?upload=<token>" — an HND applicant opening the document-upload link from their
  // email. A public page: no account, no session.
  const [uploadToken, setUploadToken] = useState(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("upload");
  });
  // "?offer=<token>" — an applicant opening the "Accept your offer" link from their email.
  const [offerToken, setOfferToken] = useState(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("offer");
  });
  // "?apply" — a prospective student opening the public application form (shareable link).
  const [applyOpen, setApplyOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).has("apply");
  });
  // Biometric app lock — only ever active inside the packaged app, and only when
  // the user has switched it on.
  const { locked, unlock } = useAppLock(Boolean(user));

  // A scanned check-in code belongs to a STUDENT session and no other. Left in place
  // for staff it would sit in the tab until a student signed in on the same machine —
  // a classroom podium browser is exactly where that happens — and mark whoever that
  // student is off a scan they never made.
  useEffect(() => {
    if (user && user.kind !== "student") clearPendingQr();
  }, [user]);

  const clearTokenFromUrl = () => {
    // Drop the token from the address bar so a refresh (or a shared screenshot of
    // the URL) can't replay it, then land on the sign-in choice.
    if (typeof window !== "undefined") window.history.replaceState({}, "", window.location.pathname);
    setResetToken(null);
    setInviteToken(null);
    setUploadToken(null);
    setOfferToken(null);
    setApplyOpen(false);
    setEntry(null);
  };

  // `?platform` (the supplier's operator console, above every institution) and
  // `?register` (an organisation applying to join) were both checked here, ahead of
  // everything else, because neither had anything to do with a college session. Both
  // are gone: one deployment now serves one college, so there is no tier above it to
  // operate and no second college to sign up. The public entry points below are
  // unrelated to that and are unchanged.

  // These public pages are valid whether or not a stale session exists, and deliberately
  // run before the auth gate below.
  if (applyOpen) return (<><style>{GLOBAL_STYLE}</style><AdmissionApply /></>);
  if (offerToken) return (<><style>{GLOBAL_STYLE}</style><AdmissionOffer token={offerToken} /></>);
  if (uploadToken) return (<><style>{GLOBAL_STYLE}</style><AdmissionUpload token={uploadToken} /></>);
  if (inviteToken) return (<><style>{GLOBAL_STYLE}</style><AcceptInvite token={inviteToken} onDone={clearTokenFromUrl} /></>);
  if (resetToken) return (<><style>{GLOBAL_STYLE}</style><ResetPasswordPage token={resetToken} onDone={clearTokenFromUrl} /></>);

  if (loading) return (
    <div className="animated-gradient flex min-h-screen flex-col items-center justify-center gap-3 text-white" style={{ background: `linear-gradient(160deg, ${NAVY} 0%, ${NAVY_DARK} 55%, #0f172a 100%)`, backgroundSize: "220% 220%" }}>
      <div className="relative flex h-16 w-16 items-center justify-center">
        <span className="absolute inset-0 rounded-2xl bg-white/15 glow-pulse" />
        <Loader2 className="animate-spin" size={30} />
      </div>
      <p className="text-sm font-semibold tracking-wide text-white/80">Loading Staff Hub…</p>
    </div>
  );
  // Signed in, but the server could not be reached to confirm it. The token is
  // still good — say so and offer a retry, rather than silently ejecting them to
  // the sign-in screen the moment the signal drops.
  if (!user && offline) return (
    <>
      <style>{GLOBAL_STYLE}</style>
      <div className="flex flex-col items-center justify-center gap-4 px-8 text-center" style={{ minHeight: "100dvh", fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", background: "radial-gradient(1200px 600px at 50% -10%, #e7ecf6 0%, #f1f5f9 45%, #eef1f6 100%)" }}>
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
          <WifiOff size={28} className="text-slate-400" />
        </div>
        <div>
          <p className="text-lg font-extrabold" style={{ color: NAVY }}>Can’t reach the server</p>
          <p className="mt-1 text-sm text-slate-500">You’re still signed in. Check your connection and try again.</p>
        </div>
        <button onClick={retryRestore} className="min-h-[44px] rounded-xl px-6 text-sm font-bold text-white shadow-sm active:scale-95" style={{ background: NAVY }}>Try again</button>
        <button onClick={abandonRestore} className="min-h-[44px] text-sm font-semibold text-slate-500 underline">Sign in as someone else</button>
      </div>
    </>
  );

  if (!user) {
    // The three doors. Which one opens FIRST is decided where `entry` is initialised
    // above — the packaged app starts on "app", the web build starts on the chooser —
    // and the reasoning for that split lives there rather than being half-told here.
    //
    // What matters at this point is that all three remain reachable in both builds: the
    // Student Portal is the public entry point (register + apply to the College with no
    // College account), and it is what makes this a general-audience app for App Store
    // distribution rather than a staff/student login wall.
    if (entry === "admin") return (<><style>{GLOBAL_STYLE}</style><Login onBack={() => setEntry(null)} /></>);
    // The Student Portal — a prospective student (general public) registers / signs in to
    // apply to the College and track their application. The public front door.
    if (entry === "applicant") return (<><style>{GLOBAL_STYLE}</style><ApplicantAuth onBack={() => setEntry(null)} /></>);
    if (entry === "app") return (
      // 100dvh (not vh) so collapsing mobile browser chrome can't clip the page.
      <div className="w-full" style={{ minHeight: "100dvh", height: "100dvh", fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", background: "radial-gradient(1200px 600px at 50% -10%, #e7ecf6 0%, #f1f5f9 45%, #eef1f6 100%)" }}>
        <style>{GLOBAL_STYLE}</style>
        <MobileAuth onExit={() => setEntry(null)} />
      </div>
    );
    return (<><style>{GLOBAL_STYLE}</style><Landing onStaffApp={() => setEntry("app")} onAdmin={() => setEntry("admin")} onStudent={() => setEntry("applicant")} /></>);
  }

  // App lock sits in front of everything a signed-in user can see, including the
  // forced password change below.
  if (locked) return (<><style>{GLOBAL_STYLE}</style><BiometricGate user={user} onUnlock={unlock} logout={logout} /></>);

  if (user.mustChangePassword) return (
    <ChangePasswordGate
      user={user}
      onDone={async (res) => { if (res?.token) applySession(res); else await refreshUser(); }}
      logout={logout}
    />
  );
  // Students get their own app — attendance, results, and a query form. It's a
  // separate world from the staff/admin Shell below.
  // The definite height matters: PhoneShell is h-full, so without a sized parent it
  // collapsed to auto, the inner overflow-y-auto never became a real scrollport, and
  // the bottom tab bar's sticky positioning had nothing to stick to — the navigation
  // scrolled away with the content. Every other screen already sets this.
  // A prospective student (applicant) lands in the Student Portal — register/track their
  // application, documents, offer and interview. A separate world from staff/admin.
  if (user.kind === "applicant") return (
    <>
      <style>{GLOBAL_STYLE}</style>
      <div className="w-full" style={{ minHeight: "100dvh" }}>
        <ApplicantPortal user={user} logout={logout} />
      </div>
    </>
  );
  if (user.kind === "student") return (
    <>
      <style>{GLOBAL_STYLE}</style>
      <div className="w-full" style={{ height: "100dvh", minHeight: "100dvh" }}>
        <StudentApp user={user} logout={logout} />
      </div>
      {/* Students reach the lock gate above like everyone else, but this return sits
          before the staff one, so they never saw the offer to switch it on — the
          protection existed and nobody could reach it. */}
      <BiometricSetupPrompt />
    </>
  );

  // Someone who came in through the staff app lands in the staff app, even if
  // they're an admin — otherwise picking "Staff App" would drop them on the dashboard.
  return (
    <>
      <Shell user={user} logout={logout} entry={entry} />
      {/* One-time offer (phone app only) to protect sign-in with Face ID / fingerprint. */}
      <BiometricSetupPrompt />
    </>
  );
}

function Shell({ user, logout, entry }) {
  // The institution's own name, live. Two forms: the short one sits beside the mark
  // where space is tight, the full one runs across the centre of the bar. Both were
  // hardcoded to the platform's own name, so a college that set its name still saw ours
  // at the top of every page — the most visible place it could possibly have been wrong.
  const [brand, setBrand] = useState(getBranding);
  useEffect(() => onBranding(setBrand), []);
  const brandShort = brand.shortName || brand.displayName || "";
  const brandName = brand.displayName || "";

  const { applySession } = useAuth();
  const handset = useIsHandset();
  const isAdmin = user.accountRole === "ADMIN";
  // The mobile app opens on the STAFF app — that's its home. Admins can still switch
  // to the dashboard from More, kept available FOR NOW while the dashboard is being
  // tested on phones (the plan is app = staff-only later). On desktop web, admins
  // land straight on the dashboard; the dashboard is fundamentally a website feature.
  const initialView = entry === "app" ? "app"
    : (entry === "admin" && isAdmin) ? "admin"
    : (isAdmin && !handset) ? "admin"
    : "app";
  const [view, setView] = useState(initialView);
  const [confirmOut, setConfirmOut] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [notes, setNotes] = useState([]);
  const [showChangePw, setShowChangePw] = useState(false);
  // Android hardware back must close this overlay. Without its own handler the press
  // fell through to the screen underneath (navigating home, or minimising the app)
  // while the modal stayed on top.
  useBackHandler(showChangePw, () => { setShowChangePw(false); return true; });

  const notify = useCallback((msg, type = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
    setNotes((n) => [{ id, msg, type, at: new Date() }, ...n].slice(0, 30));
  }, []);

  // Seed the bell with the SIGNED-IN user's own unread notifications. Keyed to
  // user.id and cleared first, so switching accounts never carries another person's
  // notifications over — the bell is always personal to whoever is logged in.
  useEffect(() => {
    let cancelled = false;
    setNotes([]); // drop the previous account's notifications immediately
    (async () => {
      try {
        const list = await api.listNotifications();
        if (cancelled) return;
        const seed = (list || [])
          .filter((n) => n.read === false)
          .map((n) => ({ id: n.id, msg: n.message, type: n.type, at: new Date(n.at) }));
        // seed + any toasts that fired in the meantime, this user's only
        setNotes((n) => [...seed, ...n].slice(0, 30));
      } catch (_) { /* non-fatal: bell just stays toast-only */ }
    })();
    return () => { cancelled = true; };
  }, [user.id]);

  // When the existing "Clear" button empties the notes (setNotes([])), also
  // persist that by marking all of the caller's notifications read on the server.
  const setNotesPersisted = useCallback((updater) => {
    setNotes((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (Array.isArray(next) && next.length === 0) api.markNotificationsRead().catch(() => {});
      return next;
    });
  }, []);

  const store = useApiStore(notify, user);
  store.notes = notes; store.setNotes = setNotesPersisted; // notifications feed for the app bell

  return (
    <div
      style={{
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
        background: "radial-gradient(1200px 600px at 50% -10%, #e7ecf6 0%, #f1f5f9 45%, #eef1f6 100%)",
        // On a handset the top bar and the app share one screen height, so the
        // shell becomes a flex column rather than a scrolling page.
        ...(handset ? { height: "100dvh" } : {}),
      }}
      className={handset ? "flex w-full flex-col overflow-hidden text-slate-800" : "min-h-screen w-full text-slate-800"}
    >
      <style>{GLOBAL_STYLE}</style>
      <ConfirmDialog open={confirmOut} title="Sign out?" message="You'll need to sign in again to get back in." confirmLabel="Sign out" cancelLabel="Stay" danger onConfirm={logout} onCancel={() => setConfirmOut(false)} />

      {/* Top chrome (view toggle · change password · sign out). Hidden on the mobile
          staff app — those actions now live in the app's "More" screen instead, so
          the phone keeps a clean, native header. Shown on the web and on the admin
          dashboard (where the view toggle is needed). */}
      {!(handset && view === "app") && (
      <div className={`animated-gradient slide-down z-50 flex shrink-0 items-center gap-2 px-3 py-2 text-xs text-white shadow-lg ${handset ? "" : "sticky top-0"}`} style={{ background: `linear-gradient(90deg, #0f172a 0%, ${NAVY_DARK} 50%, #0f172a 100%)`, backgroundSize: "220% 220%", ...(handset ? { paddingTop: "max(env(safe-area-inset-top), 8px)" } : {}) }}>
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-8 items-center justify-center rounded-lg bg-white/95 ring-1 ring-white/15"><BrandMark size={20} /></div>
          <span className="hidden font-extrabold tracking-tight text-white sm:inline" style={{ fontFamily: "'Lora', serif" }}>{brandShort}</span>
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
          {/* The Staff-App / Admin-Dashboard view toggle used to live here. It's
              gone now: the front-door Landing screen already asks which one to
              open, so switching again from the header was redundant. */}
          <span className="min-w-0 truncate font-semibold tracking-wide text-slate-200">{brandName}</span>
        </div>
        <div className="flex items-center gap-2.5">
          <LiveClock />
          <div className="hidden min-w-0 items-center gap-2 sm:flex">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white ring-1 ring-white/20" style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}>{initialsOf(user.name)}</div>
            <span className="max-w-[24ch] truncate text-slate-300">{user.name}</span>
          </div>
          <button onClick={() => setShowChangePw(true)} title="Change password" className="press flex items-center gap-1 rounded-full px-2.5 py-1.5 font-semibold text-slate-300 transition hover:bg-white/10 hover:text-white"><KeyRound size={13} /> <span className="hidden md:inline">Change password</span></button>
          <button onClick={() => setConfirmOut(true)} className="press flex items-center gap-1 rounded-full px-2.5 py-1.5 font-semibold text-slate-300 transition hover:bg-white/10 hover:text-white"><LogOut size={13} /> Sign out</button>
        </div>
      </div>
      )}

      <div key={view} className={handset ? "min-h-0 flex-1" : "fade-up"}>
        {view === "app"
          ? <StaffApp store={store} currentStaffId={user.id} logout={logout} onChangePassword={() => setShowChangePw(true)} onSwitchToAdmin={isAdmin ? () => setView("admin") : undefined} />
          : <AdminDashboard store={store} onExitToStaffApp={handset ? () => setView("app") : undefined} />}
      </div>

      {/* App footer — carries the copyright. Hidden on the mobile staff app, which
          has its own footer on the "More" screen. */}
      {!(handset && view === "app") && (
        <footer className="shrink-0 border-t border-slate-200 bg-white/70 px-4 py-3 text-center text-[11px] text-slate-400">
          © {new Date().getFullYear()} Syed Muhammad Raza · EdTech · Staff Hub
        </footer>
      )}

      {/* The overlay below is scrollable and top-aligned: on a landscape iPhone
          (320px tall) a centred, non-scrolling overlay pushed the close button —
          and on an iPhone SE the submit button too — off the screen entirely. */}
      {showChangePw && (
        <div
          className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto p-4 sm:items-center"
          style={{ height: "100dvh", paddingTop: "max(env(safe-area-inset-top), 1rem)", paddingBottom: "max(env(safe-area-inset-bottom), 1rem)" }}
        >
          <div className="fade-up fixed inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setShowChangePw(false)} />
          <div className="scale-in relative my-auto w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl ring-1 ring-black/5">
            <button onClick={() => setShowChangePw(false)} aria-label="Close" className="press absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"><X size={16} /></button>
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl text-white shadow-md" style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}><KeyRound size={20} /></div>
              <div>
                <h2 className="text-lg font-extrabold tracking-tight text-slate-800">Change password</h2>
                <p className="text-xs text-slate-500">Update the password for your account.</p>
              </div>
            </div>
            <div className="mt-5">
              <ChangePassword onSuccess={(res) => { if (res?.token) applySession(res); setShowChangePw(false); notify("Password updated — other devices signed out", "success"); }} />
            </div>
          </div>
        </div>
      )}

      <div className="pointer-events-none fixed bottom-5 right-5 z-[80] flex flex-col gap-2">
        {toasts.map((t) => {
          const tone = t.type === "success" ? "#059669" : t.type === "error" ? MAROON : NAVY;
          const I = t.type === "success" ? CheckCircle2 : t.type === "error" ? XCircle : Sparkles;
          return (
            <div key={t.id} className="slide-in pointer-events-auto flex max-w-[min(85vw,22rem)] items-center gap-2.5 rounded-xl bg-white px-4 py-3 shadow-2xl ring-1 ring-slate-200" style={{ borderLeft: `4px solid ${tone}` }}>
              <I size={18} style={{ color: tone }} className="shrink-0" /><span className="min-w-0 break-words text-sm font-semibold text-slate-700">{t.msg}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
