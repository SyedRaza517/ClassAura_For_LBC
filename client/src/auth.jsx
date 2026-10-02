import React, { createContext, useContext, useEffect, useState } from "react";
import { api, getToken, setToken, forgetNeedsLocation } from "./api";
import { registerForPush, unregisterForPush } from "./push";
import { clearBiometricPrefs } from "./biometric";

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // We hold a token we could not check because the server was unreachable.
  const [offline, setOffline] = useState(false);

  // Restore session on load.
  //
  // Only throw the stored token away when the server actually rejects it. Phones
  // lose signal constantly — in a tunnel, on a bad lift, with the server asleep —
  // and a bare catch here used to read "unreachable" as "invalid" and sign the
  // user out for good. api.request() already clears the token and fires
  // auth:unauthorized on a genuine 401, so a real rejection is still handled.
  useEffect(() => {
    (async () => {
      // No live token, but the user asked to be remembered? Offer the sensor.
      //
      // On the packaged app the token lives in sessionStorage, which the OS wipes
      // when the app process ends — so every genuine restart used to demand the
      // password again. That is the friction people complained about, and it pushes
      // users towards short, reused passwords. A session is only ever restored after
      // the device has verified the person, and only if they switched the lock on.
      if (!getToken()) {
        try {
          const { isBiometricEnabled, storedSession, verifyBiometric, forgetSession, markRestored } = await import("./biometric");
          if (isBiometricEnabled()) {
            const saved = await storedSession();
            if (saved) {
              const ok = await verifyBiometric({ reason: "Unlock Staff Hub" });
              if (ok.ok) { setToken(saved); markRestored(); }
              // A wrong finger or a cancel leaves them at the password screen, which
              // is the correct outcome — never silently discard the saved session on
              // a cancel, or one mis-tap costs them the convenience entirely.
              //
              // Matched on the machine-readable CODE. This tested the human sentence
              // for "invalid|lockout|not enrolled", and none of the messages
              // verifyBiometric can actually produce contain any of those words — so
              // the branch never ran once, and a session whose sensor was gone for
              // good was retried on every single launch instead of being cleaned up.
              // biometryLockout is deliberately absent: it is temporary, and throwing
              // the session away over it would punish the user for a bad scan.
              else if (!ok.cancelled && ["biometryNotEnrolled", "biometryNotAvailable", "passcodeNotSet", "noDeviceCredential"].includes(ok.code)) await forgetSession();
            }
          }
        } catch (_) { /* biometrics are a convenience; fall through to the password */ }
      }
      if (getToken()) {
        try {
          setUser(await api.me());
        } catch (e) {
          // No status => fetch never got a reply. Keep the session and let the
          // user retry once they are back online.
          if (e?.status && e.status !== 502 && e.status !== 503 && e.status !== 504) setToken(null);
          else setOffline(true);
        }
      }
      setLoading(false);
    })();
  }, []);

  // When any API call hits a 401 (expired/invalid token), drop the user so the
  // app falls back to <Login> instead of getting stuck on a broken session.
  useEffect(() => {
    const onUnauthorized = (e) => {
      setUser(null);
      // Only a rejection FROM the login endpoint means the password was tried and is
      // wrong. A 401 from any other request is just an expired/revoked token — the
      // remembered password (and the biometric prefs) are still valid and must be kept,
      // or every routine session expiry would force a full retype.
      const fromLogin = e?.detail?.fromLogin === true;
      if (!fromLogin) return;
      // A 401 means the token is dead — expired, or revoked by a password change or
      // reset bumping tokenVersion.
      //
      // Clear the CREDENTIAL and the preference too, not just the session. Clearing
      // only the session left the previous user's biometric credential armed on the
      // device: the next person to sign in was silently re-remembered under it, and
      // the first user could then tap "Sign in with Face ID" and land inside the
      // second user's session. logout() has always done the full clear; this path is
      // the one that actually happens on a shared machine.
      import("./biometric").then(({ clearBiometricPrefs, consumeRestored }) => {
        clearBiometricPrefs();
        // Drop any pending "already verified at launch" flag, so it cannot be spent
        // on the NEXT sign-in and silently skip the app lock.
        consumeRestored();
      }).catch(() => {});
      // A stored password that the server has just rejected is worse than useless —
      // it prefills the form with a value that will fail again and walk the user into
      // the login rate-limiter. Keep the address, drop the secret.
      import("./rememberEmail").then(({ forgetRememberedPassword }) => forgetRememberedPassword()).catch(() => {});
    };
    window.addEventListener("auth:unauthorized", onUnauthorized);
    return () => window.removeEventListener("auth:unauthorized", onUnauthorized);
  }, []);

  // Register for push once there is a signed-in user to attach the token to.
  // A no-op on the web, so nothing changes for browser users.
  useEffect(() => {
    if (!user) return;
    registerForPush({
      // Tapping a notification should land on the screen it refers to.
      onOpen: (link) => window.dispatchEvent(new CustomEvent("push:open", { detail: link })),
    });
  }, [user?.id]);

  // Turn a successful auth response into a live session.
  const applySession = ({ token, user }) => {
    setToken(token);
    setUser(user);
    // Keep the remembered copy in step with the live one, so unlocking never
    // restores a token that expired weeks ago.
    // The owner travels with the token. Without it the remembered session was
    // device-global, so on a shared machine the next person to sign in was silently
    // re-remembered under the previous user's biometric credential.
    import("./biometric").then(({ isBiometricEnabled, rememberSession, storedOwner, clearBiometricPrefs }) => {
      if (!isBiometricEnabled()) return;
      const owner = String(user?.email || "").trim().toLowerCase();
      const held = storedOwner();
      // A different person signing in on this device: the previous owner's lock and
      // credential are not theirs to inherit, so start clean rather than re-arm.
      if (held && owner && held !== owner) { clearBiometricPrefs(); return; }
      rememberSession(token, owner);
    }).catch(() => {});
  };

  // Step one of signing in. The password may not be enough: an account with an
  // authenticator (or one that still owes us enrolment) gets a challenge token
  // instead of a session, and the caller drives the second step.
  // Returns { ok, mfaRequired?, totpSetupRequired?, challengeToken?, error? }.
  const signIn = async (email, password) => {
    setError("");
    try {
      const res = await api.login(email, password);
      if (res?.token) { applySession(res); return { ok: true }; }
      if (res?.mfaRequired) return { ok: false, mfaRequired: true, challengeToken: res.challengeToken, name: res.name };
      if (res?.totpSetupRequired) return { ok: false, totpSetupRequired: true, challengeToken: res.challengeToken, name: res.name };
      throw new Error("Unexpected response from the server");
    } catch (e) {
      const msg = e.message || "Login failed";
      setError(msg);
      return { ok: false, error: msg };
    }
  };

  // Kept for the admin dashboard login, which is a plain one-step sign-in.
  // Returns the full result so that screen can still react if 2FA is ever
  // switched on for an admin account.
  const login = async (email, password) => signIn(email, password);

  // Detach this device from push before the session goes, otherwise a shared or
  // handed-on phone keeps receiving the previous user's leave decisions.
  const logout = async () => {
    // Fire-and-forget. This used to be awaited, which on a weak connection blocked
    // sign-out for the full 30-second request timeout with no visual feedback — on
    // the biometric lock screen, where "Sign out instead" is the documented escape
    // from a stuck lock, that made the one working exit look broken.
    try { unregisterForPush().catch(() => {}); } catch (_) { /* never block signing out */ }
    // The app-lock preference is stored per DEVICE, so clear it on the way out —
    // otherwise the next account to sign in on this phone inherits it.
    try { clearBiometricPrefs(); } catch (_) {}
    // Same reasoning as the app-lock preference above: the next person to sign in on
    // this handset is not necessarily the last one, so a cached "needs location"
    // answer from THIS session must not survive to silently mis-serve the next.
    forgetNeedsLocation();
    setToken(null);
    setUser(null);
  };

  // Re-fetch the current user (used after a password change so flags like
  // mustChangePassword update without forcing a full re-login).
  const refreshUser = async () => { setUser(await api.me()); };

  // Try the stored token again after a connection drop. Same rule as on load:
  // only a real rejection from the server discards it.
  const retryRestore = async () => {
    if (!getToken()) { setOffline(false); return; }
    try {
      setUser(await api.me());
      setOffline(false);
    } catch (e) {
      if (e?.status && e.status !== 502 && e.status !== 503 && e.status !== 504) { setToken(null); setOffline(false); }
    }
  };

  // Give up on the stored session and go back to sign-in by choice.
  const abandonRestore = () => { setToken(null); setOffline(false); };

  return <AuthCtx.Provider value={{ user, loading, error, setError, login, signIn, applySession, logout, refreshUser, offline, retryRestore, abandonRestore }}>{children}</AuthCtx.Provider>;
}
