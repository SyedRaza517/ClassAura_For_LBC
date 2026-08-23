// The page an "Accept your offer" link opens (?offer=<token>).
//
// A PUBLIC, token-based page (no login). An HND applicant opens it from a link in
// an email, reads their offer of a place, and clicks Accept to confirm it. If the
// offer has already been accepted (either previously, or just now), the page shows a
// thank-you confirmation instead of the Accept button.
import React, { useEffect, useState } from "react";
import { api } from "./api";
import { BrandLockup } from "./Brand";
import {
  PartyPopper, CheckCircle2, Loader2, AlertCircle, ShieldCheck,
} from "lucide-react";

// The app's palette. Not exported from elsewhere, so declared locally.
const NAVY = "#1a3a8f", NAVY_DARK = "#14306f", MAROON = "#9e1b32";

// Unit scope, NOT inside the component — a component declared inside another's body
// is a new type on every render, so React would unmount and remount its whole subtree.
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
      <div className="w-full max-w-xl">{children}</div>
    </div>
  );
}

export default function AdmissionOffer({ token }) {
  const [state, setState] = useState({ status: "checking" }); // checking | ready | accepted | invalid
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState("");   // inline error while accepting

  // Load the offer from the server on mount.
  useEffect(() => {
    const signal = { cancelled: false };
    (async () => {
      try {
        const res = await api.offerInfo(token);
        if (signal.cancelled) return;
        // { name, course, status: "sent" | "accepted", inductionDate }
        setState({ status: res?.status === "accepted" ? "accepted" : "ready", ...res });
      } catch (e) {
        if (signal.cancelled) return;
        const expired = e?.status === 404;
        setState({
          status: "invalid",
          error: expired ? "This link is not valid or has expired." : (e?.message || "Something went wrong loading your offer."),
        });
      }
    })();
    return () => { signal.cancelled = true; };
  }, [token]);

  const accept = async () => {
    setError("");
    setAccepting(true);
    try {
      const res = await api.acceptOffer(token);
      setState((s) => ({ ...s, status: "accepted", ...res }));
    } catch (e) {
      setError(e?.message || "We couldn't accept your offer. Please try again.");
    } finally {
      setAccepting(false);
    }
  };

  // ---- Checking ------------------------------------------------------------
  if (state.status === "checking") return (
    <Shell center>
      <div className="scale-in rounded-2xl bg-white p-8 text-center shadow-2xl ring-1 ring-black/5">
        <div className="mb-4 flex justify-center"><BrandLockup /></div>
        <div className="flex items-center justify-center gap-2 py-2 text-slate-400">
          <Loader2 size={22} className="animate-spin" />
          <span className="text-sm font-semibold text-slate-500">Loading your offer…</span>
        </div>
      </div>
    </Shell>
  );

  // ---- Invalid / expired ---------------------------------------------------
  if (state.status === "invalid") return (
    <Shell center>
      <div className="scale-in rounded-2xl bg-white p-8 text-center shadow-2xl ring-1 ring-black/5">
        <div className="mb-4 flex justify-center"><BrandLockup /></div>
        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-50 text-rose-600 ring-1 ring-rose-200">
          <AlertCircle size={28} />
        </div>
        <h1 className="text-xl font-extrabold tracking-tight text-slate-800">This link is not valid or has expired</h1>
        <p className="mt-1 text-sm text-slate-500">
          {state.error || "Please contact the admissions team for a new link."}
        </p>
      </div>
    </Shell>
  );

  // ---- Accepted ------------------------------------------------------------
  if (state.status === "accepted") return (
    <Shell center>
      <div className="scale-in rounded-2xl bg-white p-8 text-center shadow-2xl ring-1 ring-black/5">
        <div className="mb-4 flex justify-center"><BrandLockup /></div>
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600 ring-1 ring-emerald-200">
          <CheckCircle2 size={34} />
        </div>
        <div className="pop flex items-start gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-left text-sm font-semibold text-emerald-700 ring-1 ring-emerald-200">
          <ShieldCheck size={18} className="mt-px shrink-0" />
          <span>Offer accepted — thank you! The admissions team will be in touch about enrolment.</span>
        </div>
      </div>
    </Shell>
  );

  // ---- Ready (status === "sent") -------------------------------------------
  return (
    <Shell center>
      <div className="scale-in rounded-2xl bg-white p-6 text-center shadow-2xl ring-1 ring-black/5 sm:p-8">
        <div className="mb-4 flex justify-center"><BrandLockup /></div>

        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 ring-1 ring-amber-200">
          <PartyPopper size={34} />
        </div>

        <h1 className="text-2xl font-extrabold tracking-tight text-slate-800 sm:text-3xl">
          Congratulations{state.name ? `, ${state.name}` : ""}!
        </h1>

        <p className="mx-auto mt-3 max-w-md text-sm text-slate-600">
          You've been offered a place on {state.course} at EdTech.
          {state.inductionDate ? ` Your induction day is ${state.inductionDate}.` : ""}
        </p>

        <p className="mx-auto mt-3 max-w-md text-sm text-slate-500">
          Clicking the button below confirms your place. We can't wait to welcome you.
        </p>

        {error && (
          <p className="pop mx-auto mt-4 flex max-w-md items-start justify-center gap-1.5 text-sm font-semibold text-rose-600">
            <AlertCircle size={15} className="mt-px shrink-0" /> <span>{error}</span>
          </p>
        )}

        <button
          type="button"
          disabled={accepting}
          onClick={accept}
          className="press mt-6 flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl px-6 py-3 text-base font-bold text-white shadow-lg transition disabled:opacity-60"
          style={{ background: `linear-gradient(135deg, ${NAVY}, ${MAROON})` }}
        >
          {accepting ? (
            <><Loader2 size={18} className="animate-spin" /> Accepting…</>
          ) : (
            <><CheckCircle2 size={18} /> Accept my offer</>
          )}
        </button>

      </div>
    </Shell>
  );
}
