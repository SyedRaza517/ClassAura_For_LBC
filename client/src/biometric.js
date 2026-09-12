// Face ID / Touch ID / fingerprint unlock.
//
// This is an APP LOCK, not a second login: the user has already signed in, and
// biometrics gate access to the running app when it is opened or brought back from
// the background. That is the behaviour people expect from a banking or HR app, and
// it means a borrowed or stolen unlocked phone doesn't expose staff records.
//
// TWO BACKENDS, one behaviour:
//
//   native  the Capacitor plugin — Face ID, Touch ID, Android BiometricPrompt.
//   web     WebAuthn's platform authenticator — Windows Hello, Touch ID on a Mac,
//           the phone's own sensor in Chrome. Same hardware, reached through the
//           browser instead of through Capacitor.
//
// The web half exists because the dashboard is a website and the staff app is also
// served in a browser, where the Capacitor bridge simply is not present — so the
// feature used to be invisible there with nothing to explain why.
//
// A NOTE ON WHAT THIS PROVES. Neither backend is an authentication factor: there is
// no server-side challenge, and the session token is already held locally by the
// time any of this runs. Both are a LOCAL gate on the UI, exactly as a banking app's
// "unlock with Face ID" is. The account's real second factor remains TOTP. Do not
// promote either path to a login step without a server-verified WebAuthn ceremony.
import { isNativeApp } from "./PhoneShell";

// ============================================================================
// THE WHOLE FEATURE IS CURRENTLY SWITCHED OFF.
//
// "Remember my email and password" covers the convenience for now, so biometric
// unlock is parked until it can be finished and tested on real handsets.
//
// TO TURN IT BACK ON: change this ONE constant to true. Nothing else needs editing.
//
// It is a flag rather than commented-out code deliberately — the same approach
// TOTP_ENFORCED takes in server/src/routes/auth.js. Commenting out spans six files
// (this one, BiometricGate, BiometricSignIn, student/BiometricSetting.jsx — shared by
// both StaffHub and the student More screen since the Task 3 mechanical split moved it
// out of StaffHub.jsx — StudentApp and App), leaves dead imports behind, and makes the
// diff that restores it a reconstruction job instead of a one-character change.
// Everything below stays compiled, type-consistent and reviewable; it simply reports
// "unavailable".
//
// Anyone who had already switched the lock on is NOT stranded: isBiometricArmed()
// returns false while this is off, so useAppLock never locks and they sign in with
// their password as normal.
// ============================================================================
export const BIOMETRICS_ENABLED = false;

const ENABLED_KEY = "edtech_biometric_enabled";
// The WebAuthn credential id (base64url) created when the lock is switched on in a
// browser. It identifies which platform credential to ask for later; the private key
// never leaves the authenticator, so this is not a secret.
const CRED_KEY = "edtech_biometric_credential";
// Who the remembered session and credential belong to.
//
// Without this the keys are device-global and nothing ties them to an account, so on
// a shared machine user A could arm the lock, user B sign in and be re-remembered
// under A's credential, and A then unlock straight into B's session. The sign-in
// button also refuses to appear for an address that isn't this one.
const OWNER_KEY = "edtech_biometric_owner";
// Where the remembered session lives. Capacitor Preferences is app-private storage
// (Android SharedPreferences / iOS UserDefaults) — another app cannot read it, though
// it is not the Keychain, which is why the token is only ever put there when the user
// has switched biometric unlock ON and is only ever taken out after a successful check.
const SESSION_KEY = "edtech_remembered_session";

async function prefs() {
  if (!isNativeApp()) return null;
  try { return (await import("@capacitor/preferences")).Preferences || null; } catch (_) { return null; }
}

/**
 * Remember the signed-in session so reopening the app asks for a face or a finger
 * instead of a password.
 *
 * Without this the token sits in sessionStorage, which the OS wipes when the app
 * process ends — so every genuine app restart forced a full sign-in. That is the
 * behaviour people were complaining about, and it pushed them towards short, reused
 * passwords, which is worse than storing a short-lived token behind a biometric.
 *
 * The JWT already expires on its own, and the server can revoke it by bumping
 * tokenVersion, so a remembered session cannot outlive either.
 */
// On the web there is no Preferences plugin, so localStorage is the fallback.
//
// Worth being clear about what that is and is not. Capacitor Preferences is
// app-private storage, which another app cannot read. localStorage is readable by
// any script on this origin, so on the web the biometric check is a gate on the UI,
// not a secret store — an XSS would read the token whether or not the check exists.
// It is no weaker than the live session, which already sits in localStorage while
// signed in, and an explicit Sign out still clears it.
const webSession = {
  get: () => { try { return localStorage.getItem(SESSION_KEY); } catch (_) { return null; } },
  set: (v) => { try { localStorage.setItem(SESSION_KEY, v); return true; } catch (_) { return false; } },
  remove: () => { try { localStorage.removeItem(SESSION_KEY); } catch (_) {} },
};

export const storedOwner = () => { try { return localStorage.getItem(OWNER_KEY) || ""; } catch (_) { return ""; } };
const setStoredOwner = (owner) => {
  try { if (owner) localStorage.setItem(OWNER_KEY, String(owner).trim().toLowerCase()); else localStorage.removeItem(OWNER_KEY); } catch (_) {}
};

export async function rememberSession(token, owner) {
  if (!token) return false;
  if (owner) setStoredOwner(owner);
  const P = await prefs();
  if (!P) return webSession.set(token);
  try { await P.set({ key: SESSION_KEY, value: token }); return true; } catch (_) { return false; }
}

export async function storedSession() {
  const P = await prefs();
  if (!P) return webSession.get();
  try { return (await P.get({ key: SESSION_KEY }))?.value || null; } catch (_) { return null; }
}

// Set when a session was just restored by a biometric check at launch, so the app
// lock knows not to ask again. Without it the user verifies twice in a row: once to
// unlock the saved session, then again because a session "appeared", which the lock
// cannot otherwise tell apart from a fresh password sign-in.
let restoredFlag = false;
export const markRestored = () => { restoredFlag = true; };
export const consumeRestored = () => { const v = restoredFlag; restoredFlag = false; return v; };

export async function forgetSession() {
  setStoredOwner("");
  const P = await prefs();
  if (!P) { webSession.remove(); return; }
  try { await P.remove({ key: SESSION_KEY }); } catch (_) {}
}

// Nothing here may hang forever.
//
// try/catch only rescues a REJECTED promise. A promise that never settles — a
// Capacitor bridge call the native layer never answers, a dynamic import of a chunk
// that never arrives, a WebAuthn availability probe a locked-down browser leaves
// pending — is not an error, so it is never caught, and the caller waits for ever.
// The settings row then sits on "Checking this device…" indefinitely, which is the
// same silent failure as a blank row wearing a spinner.
//
// Every await that crosses into the platform is therefore raced against a deadline.
const PROBE_TIMEOUT_MS = 6000;
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} didn't respond within ${Math.round(ms / 1000)}s`)), ms); }),
  ]);
}

async function plugin() {
  if (!isNativeApp()) return null;
  try {
    const mod = await withTimeout(import("@aparajita/capacitor-biometric-auth"), PROBE_TIMEOUT_MS, "The biometric plugin");
    return mod.BiometricAuth || null;
  } catch (_) {
    return null;
  }
}

/* ================================================================== *
 *            WebAuthn — the same sensors, reached from a browser      *
 * ================================================================== */

const b64u = {
  encode: (buf) => { let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  decode: (str) => { const b = atob(String(str).replace(/-/g, "+").replace(/_/g, "/")); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; },
};

// WebAuthn needs a secure context — https, or localhost during development. On
// plain http the API is simply absent, which is a browser rule we cannot work around.
const webAuthnSupported = () =>
  typeof window !== "undefined" && window.isSecureContext &&
  Boolean(window.PublicKeyCredential) && Boolean(navigator.credentials?.create);

// Is there a built-in sensor (as opposed to a roaming USB key)? We only ever want
// the platform authenticator: a security key on a keyring is not an "app lock".
async function webPlatformAvailable() {
  if (!webAuthnSupported()) return false;
  // Raced against a deadline: a browser with WebAuthn disabled by policy, or a page in
  // a restricted frame, can leave this pending rather than rejecting.
  try { return await withTimeout(window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(), PROBE_TIMEOUT_MS, "This browser"); }
  catch (_) { return false; }
}

const storedCredential = () => { try { return localStorage.getItem(CRED_KEY); } catch (_) { return null; } };

// Register this device's sensor. `userVerification: "required"` is what forces an
// actual face/finger/PIN check rather than a silent presence test.
async function webEnrol(name) {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "EdTech Staff Hub", id: window.location.hostname },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: name || "Staff Hub",
        displayName: name || "Staff Hub",
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
      timeout: 60000,
      attestation: "none",
    },
  });
  if (!cred) throw new Error("No credential was created");
  localStorage.setItem(CRED_KEY, b64u.encode(cred.rawId));
  return cred;
}

async function webVerify() {
  const id = storedCredential();
  if (!id) return { ok: false, error: "This browser isn't set up for biometric unlock yet." };
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ id: b64u.decode(id), type: "public-key" }],
      userVerification: "required",
      rpId: window.location.hostname,
      timeout: 60000,
    },
  });
  if (!assertion) return { ok: false, cancelled: true };
  return { ok: true };
}

// The browser reports a dismissed prompt, a timeout and a genuinely absent sensor
// all as NotAllowedError, so a cancel is inferred rather than read off a code.
function webAuthError(e) {
  const n = e?.name || "";
  if (n === "NotAllowedError") return { cancelled: true, error: "" };
  if (n === "InvalidStateError") return { cancelled: false, error: "This device is already registered for unlock." };
  if (n === "SecurityError") return { cancelled: false, error: "Biometric unlock needs a secure (https) connection." };
  if (n === "NotSupportedError") return { cancelled: false, error: "This browser can't use the device's biometric sensor." };
  return { cancelled: false, error: e?.message || "Could not verify. Try again." };
}

/**
 * What the device can actually do.
 *
 * Returns a discriminated `state`, not just a boolean, because the outcomes need
 * different things from the UI — and collapsing them is precisely what made this
 * feature look missing. Every failure used to come back as reason:"not-native",
 * which the settings row renders as nothing at all, so a browser, a plugin that
 * failed to load and an unenrolled sensor were indistinguishable: all invisible.
 *
 *   web          a browser — no sensor to ask, so stay hidden (the ONLY silent case)
 *   no-plugin    native, but the Capacitor plugin didn't load — needs `npx cap sync`
 *   no-lock      no PIN/pattern/passcode on the device, so biometry can't be enrolled
 *   not-enrolled hardware is there, but no face/finger has been registered yet
 *   error        checkBiometry() threw — report what it said
 *   ready        good to go
 *
 * `available` and `reason` are kept for the existing callers (enableBiometric,
 * BiometricGate, BiometricSetupPrompt), so nothing downstream had to change.
 */
export async function biometricStatus() {
  // Feature parked — see BIOMETRICS_ENABLED at the top of this file.
  // "off" is a state the settings row renders as nothing at all, so no half-built
  // control is left on screen for staff to find and be confused by.
  if (!BIOMETRICS_ENABLED) {
    return { state: "off", available: false, reason: "not-enabled", biometryType: null, label: "biometric unlock", methods: [] };
  }
  if (!isNativeApp()) {
    const label = webLabel();
    const web = (state, reason) => ({ state, backend: "web", available: false, reason, biometryType: null, label, detail: "" });
    // Every branch below RETURNS A REASON. An earlier version hid the setting when
    // no sensor was found, which reproduced the original complaint exactly: on a PC
    // without Windows Hello the row simply vanished and looked broken. Silence is
    // never the right answer here — say what is missing and how to fix it.
    if (typeof window !== "undefined" && window.isSecureContext === false) {
      return web("insecure", "Biometric unlock needs a secure address. Use https, or http://localhost during development.");
    }
    if (!webAuthnSupported()) {
      return web("no-webauthn", "This browser can't use biometric unlock. Try Chrome, Edge or Safari.");
    }
    if (!(await webPlatformAvailable())) {
      return web("no-sensor", `No ${label} is set up on this computer. Add it in Windows Settings → Accounts → Sign-in options (or your Mac's Touch ID settings), then tap Check again.`);
    }
    return {
      state: "ready", backend: "web", available: true, reason: null,
      biometryType: null, label, detail: "",
      // A browser never reveals which sensor answered, so we offer the platform's
      // own name (Windows Hello, Touch ID) rather than inventing a face/finger split.
      methods: [{ key: "platform", label }],
    };
  }
  const Bio = await plugin();
  if (!Bio) {
    return {
      state: "no-plugin",
      available: false,
      reason: "The biometric plugin isn't in this build of the app. Rebuild it (npm run build, then npx cap sync) and reinstall.",
      biometryType: null,
      label: "biometric unlock",
    };
  }
  try {
    // The Capacitor bridge is the likeliest thing to go quiet — a plugin that failed
    // to register answers nothing at all rather than erroring.
    const info = await withTimeout(Bio.checkBiometry(), PROBE_TIMEOUT_MS, "This device");
    const label = biometryLabel(info?.biometryType);
    const base = {
      biometryType: info?.biometryType ?? null,
      biometryTypes: info?.biometryTypes ?? [],
      methods: methodsFrom(info?.biometryTypes, info?.biometryType),
      deviceIsSecure: Boolean(info?.deviceIsSecure),
      strong: Boolean(info?.strongBiometryIsAvailable),
      label,
      // Whatever the OS itself said, kept verbatim behind "Why?" in the settings
      // row. The plugin leaves this an empty string when it has nothing to add.
      detail: String(info?.reason || info?.strongReason || "").trim(),
    };
    if (info?.isAvailable) return { ...base, state: "ready", available: true, reason: null };
    // Order matters: "no screen lock" is the cause of "not enrolled" on both
    // platforms, so reporting the symptom first would send people to a settings
    // screen that won't let them do anything until they set a passcode.
    if (!base.deviceIsSecure) {
      return {
        ...base, state: "no-lock", available: false,
        reason: "Set a screen lock (PIN, pattern or passcode) on this device first — biometrics can't be used without one.",
      };
    }
    return {
      ...base, state: "not-enrolled", available: false,
      reason: base.detail || `No ${label} is registered on this device yet. Add one in your device settings, then tap Check again.`,
    };
  } catch (e) {
    return {
      state: "error", available: false,
      reason: e?.message || "Could not check this device's biometrics.",
      biometryType: null, label: "biometric unlock", detail: String(e?.code || ""),
    };
  }
}

// Human name for the prompt and the settings row.
//
// BiometryType is a NUMERIC enum in the plugin (none=0, touchId=1, faceId=2,
// fingerprintAuthentication=3, faceAuthentication=4, irisAuthentication=5). The
// lookup here was keyed by the NAMES, so it never matched a single real device and
// every user — iPhone included — was told "biometric unlock". Both forms are
// accepted now, so this keeps working whichever the plugin hands back.
const BIOMETRY_LABELS = {
  0: "biometric unlock",  none: "biometric unlock",
  1: "Touch ID",          touchId: "Touch ID",
  2: "Face ID",           faceId: "Face ID",
  3: "fingerprint unlock", fingerprintAuthentication: "fingerprint unlock",
  4: "face unlock",       faceAuthentication: "face unlock",
  5: "iris unlock",       irisAuthentication: "iris unlock",
};
export function biometryLabel(type) {
  if (type === null || type === undefined) return "biometric unlock";
  return BIOMETRY_LABELS[type] || "biometric unlock";
}

// The unlock methods a device actually offers, so the setting can present real
// choices — "Open with Face", "Open with Fingerprint" — instead of one opaque switch.
//
// IMPORTANT: this is what the device SUPPORTS, and the options are entry points, not
// filters. Neither Android's BiometricPrompt nor iOS lets an app demand one modality
// over another: if someone has enrolled both a face and a finger, the system prompt
// decides which to ask for. The UI says so rather than implying a control we do not
// have. (Forcing it via androidBiometryStrength would be a guess — face is "weak" on
// some handsets and "strong" on others — and would break unlock on the exceptions.)
const METHOD_OF = {
  1: { key: "finger", label: "Touch ID" },
  2: { key: "face", label: "Face ID" },
  3: { key: "finger", label: "Fingerprint" },
  4: { key: "face", label: "Face" },
  5: { key: "iris", label: "Iris" },
};

function methodsFrom(types, primary) {
  const source = Array.isArray(types) && types.length ? types : (primary == null ? [] : [primary]);
  const seen = new Set();
  return source
    .map((t) => METHOD_OF[t])
    .filter((m) => m && !seen.has(m.key) && seen.add(m.key));  // some devices list a type twice
}

// Name the browser's platform authenticator the way the user knows it. WebAuthn
// deliberately never says which sensor answered, so this is derived from the
// platform — the worst case is a slightly generic label, never a wrong prompt.
function webLabel() {
  const ua = typeof navigator === "undefined" ? "" : `${navigator.userAgent || ""} ${navigator.platform || ""}`;
  if (/Windows/i.test(ua)) return "Windows Hello";
  if (/Android/i.test(ua)) return "fingerprint unlock";
  if (/iPhone|iPad|iPod/i.test(ua)) return "Face ID / Touch ID";
  if (/Mac/i.test(ua)) return "Touch ID";
  return "biometric unlock";
}

/**
 * Ask the device to verify the user.
 * Returns { ok, cancelled, error } — `cancelled` is separated out because a user
 * tapping "Cancel" is not a failure and must not be shown as an error.
 */
// The plugin throws a BiometryError carrying a machine-readable `code`. Showing
// that raw ("biometryLockout") tells a member of staff nothing about what to do,
// so each one gets a sentence that names the actual remedy.
const AUTH_ERRORS = {
  biometryNotAvailable: "This device doesn't support biometric unlock.",
  biometryNotEnrolled: "No face or fingerprint is registered on this device yet. Add one in your device settings and try again.",
  biometryLockout: "Too many failed attempts. Unlock your device with its PIN or passcode first, then try again.",
  passcodeNotSet: "Set a screen lock (PIN, pattern or passcode) on this device first.",
  noDeviceCredential: "Set a screen lock (PIN, pattern or passcode) on this device first.",
  authenticationFailed: "That wasn't recognised. Try again.",
  notInteractive: "The app couldn't show the unlock prompt. Try again.",
  invalidContext: "The unlock prompt couldn't start. Try again.",
};
// Codes that mean "the user chose not to", which must never be shown as an error.
const CANCEL_CODES = new Set(["userCancel", "appCancel", "systemCancel", "userFallback"]);

// True while an OS credential prompt is on screen.
//
// The prompt is a separate system surface — Android's Credential Manager sheet, iOS's
// LocalAuthentication dialog — and showing it can push the web page to
// visibilityState "hidden". To the app-lock's resume listener that is indistinguishable
// from the user leaving, so without this flag a slow verification re-locks the app at
// the exact moment it succeeds, and the user is bounced back to the lock screen.
let verifyInFlight = false;
export const isVerifyInFlight = () => verifyInFlight;

export async function verifyBiometric({ reason = "Unlock Staff Hub" } = {}) {
  verifyInFlight = true;
  try {
    return await runVerify(reason);
  } finally {
    verifyInFlight = false;
  }
}

async function runVerify(reason) {
  // Browser: WebAuthn drives the very same sensor, via the OS's own prompt.
  if (!isNativeApp()) {
    if (!webAuthnSupported()) return { ok: false, error: "Biometric unlock isn't available in this browser." };
    try { return await webVerify(); }
    catch (e) { const m = webAuthError(e); return { ok: false, cancelled: m.cancelled, error: m.error }; }
  }
  const Bio = await plugin();
  if (!Bio) return { ok: false, error: "Biometric unlock isn't available in this build of the app." };
  try {
    await Bio.authenticate({
      reason,
      cancelTitle: "Cancel",
      allowDeviceCredential: true, // fall back to the device PIN/passcode
      iosFallbackTitle: "Use passcode",
      androidTitle: "Unlock Staff Hub",
      androidSubtitle: "Confirm it's you to continue",
      androidConfirmationRequired: false,
    });
    return { ok: true };
  } catch (e) {
    const code = String(e?.code || "");
    // Match on the code first; the substring test is only a fallback for a build
    // that reports the reason in the message rather than as a code.
    const cancelled = CANCEL_CODES.has(code) || /cancel/i.test(code) || /cancel/i.test(e?.message || "");
    return { ok: false, cancelled, code, error: AUTH_ERRORS[code] || e?.message || code || "Could not verify. Try again." };
  }
}

/* ---- the user's preference ---- */
export const isBiometricEnabled = () => {
  if (!BIOMETRICS_ENABLED) return false;
  try { return localStorage.getItem(ENABLED_KEY) === "1"; } catch (_) { return false; }
};
export const setBiometricEnabled = (on) => {
  try { on ? localStorage.setItem(ENABLED_KEY, "1") : localStorage.removeItem(ENABLED_KEY); } catch (_) {}
};

// True when the lock can actually be SATISFIED here, not merely switched on.
//
// The preference and the credential are stored separately, and on the web the
// credential is what the sensor is asked for. Locking on the preference alone would
// put someone behind a gate that can never open — the "Sign out" escape hatch works,
// but losing your session because a credential went missing is not a lock, it's a
// lockout. Native has no equivalent hole: the OS owns the enrolment.
/* ================================================================== *
 *          Signing IN with a face / finger, from the login screen     *
 * ================================================================== */

/**
 * Can the sign-in screen offer a biometric button? Only when all three hold:
 * the user switched the lock on, a session was remembered, and the sensor works.
 *
 * The remembered session is deliberately cleared by an explicit Sign out (see
 * clearBiometricPrefs), so this offers a way back into a session that was
 * INTERRUPTED — the app killed, the tab closed — never a way around signing out.
 */
export async function biometricSignInStatus() {
  if (!BIOMETRICS_ENABLED) return { ok: false };   // no "Sign in with Face ID" button
  if (!isBiometricArmed()) return { ok: false };
  const token = await storedSession();
  if (!token) return { ok: false };
  const s = await biometricStatus();
  if (!s.available) return { ok: false };
  // The owner travels with the offer so the sign-in screen can name the account and
  // refuse to show the button for a different address.
  return { ok: true, label: s.label, methods: s.methods || [], owner: storedOwner() };
}

/** Verify, then hand the remembered token back to the caller. */
export async function biometricSignIn() {
  const token = await storedSession();
  if (!token) return { ok: false, error: "There's no saved sign-in on this device yet." };
  const res = await verifyBiometric({ reason: "Sign in to Staff Hub" });
  if (!res.ok) return { ok: false, cancelled: res.cancelled, code: res.code, error: res.error };
  // The user has JUST proved themselves. Without this the app lock cannot tell that
  // apart from a fresh password sign-in, so it locked immediately and fired a second
  // prompt seconds after the first — and cancelling that one left a blank lock screen
  // whose only exit deleted the credential. auth.jsx's launch restore has always
  // marked it; this path was added later and did not.
  markRestored();
  return { ok: true, token };
}

export const isBiometricArmed = () => {
  // Gates useAppLock. False while the feature is parked, so anyone who had already
  // switched the lock on is not left behind a gate that no longer has a way through.
  if (!BIOMETRICS_ENABLED) return false;
  if (!isBiometricEnabled()) return false;
  if (isNativeApp()) return true;
  return Boolean(storedCredential());
};

// Clear the app-lock preference and the "don't ask again" flag. Called on sign-out:
// both live in localStorage, so without this they were device-global — the next
// person to sign in on the same phone inherited the previous user's app lock and
// their dismissal of the setup prompt.
export const clearBiometricPrefs = () => {
  try {
    localStorage.removeItem(ENABLED_KEY);
    localStorage.removeItem(CRED_KEY);
    localStorage.removeItem(OWNER_KEY);
    localStorage.removeItem("edtech_biometric_prompt_dismissed");
  } catch (_) {}
  // Fire-and-forget: the caller is signing out and must not wait on storage.
  forgetSession();
};

/**
 * Turn the lock on. Verifies once first — enabling a lock the device can't
 * actually satisfy would shut the user out of their own app.
 */
/**
 * Turn the lock off WITHOUT a verification, and forget the remembered session.
 *
 * The escape hatch for a credential the authenticator no longer holds — after a
 * Windows Hello PIN reset, a changed Android screen lock, or a recreated browser
 * profile. Every check then fails with a 60-second timeout reported as a "cancel",
 * so the user sits behind a gate that can never open. This costs them the session
 * (they sign in with their password again), which is the correct trade: a lock you
 * cannot satisfy is a lockout, and the account itself is unaffected.
 */
export async function resetBiometric() {
  setBiometricEnabled(false);
  try { localStorage.removeItem(CRED_KEY); } catch (_) {}
  await forgetSession();
  return { ok: true };
}

export async function enableBiometric({ name, owner } = {}) {
  const status = await biometricStatus();
  if (!status.available) return { ok: false, reason: status.reason };

  // In a browser, enrolling IS the verification: navigator.credentials.create()
  // runs the same face/finger/PIN check before it will hand back a credential, so
  // a separate verify step would ask the user twice for nothing.
  if (status.backend === "web") {
    try { await webEnrol(name || owner); }
    catch (e) { const m = webAuthError(e); return { ok: false, reason: m.cancelled ? "cancelled" : m.error }; }
    setBiometricEnabled(true);
    // Remember the session so the SIGN-IN screen can offer the button too, not just
    // the app lock. Without this the browser had no token to unlock back into.
    try {
      const { getToken } = await import("./api");
      const t = getToken();
      if (t) await rememberSession(t, owner);
    } catch (_) { /* remembering is a convenience, never a reason to fail the toggle */ }
    return { ok: true, label: status.label };
  }

  const res = await verifyBiometric({ reason: "Confirm it's you to turn on app lock" });
  if (!res.ok) return { ok: false, reason: res.cancelled ? "cancelled" : res.error };
  setBiometricEnabled(true);
  // Remember the CURRENT session, so the next cold start can be unlocked by face or
  // finger. Imported lazily to avoid a cycle: api.js has no knowledge of biometrics.
  try {
    const { getToken } = await import("./api");
    const t = getToken();
    if (t) await rememberSession(t);
  } catch (_) { /* remembering is a convenience, never a reason to fail the toggle */ }
  return { ok: true, biometryType: status.biometryType };
}

// Turning it off requires a successful check too, so someone holding an unlocked
// phone can't simply switch the lock off.
export async function disableBiometric() {
  const res = await verifyBiometric({ reason: "Confirm it's you to turn off app lock" });
  // Turning the lock OFF must not require a check that can never succeed. If the
  // credential has been destroyed out from under us — a Windows Hello PIN reset, a
  // changed Android screen lock, a recreated browser profile — verification fails for
  // ever, and demanding it here left the lock permanently on AND permanently
  // unsatisfiable. Removing a protection you can no longer use is always allowed;
  // the session itself is still behind the password.
  if (!res.ok && !res.cancelled && !isNativeApp() && !storedCredential()) {
    setBiometricEnabled(false);
    try { localStorage.removeItem(CRED_KEY); } catch (_) {}
    await forgetSession();
    return { ok: true, recovered: true };
  }
  if (!res.ok) return { ok: false, reason: res.cancelled ? "cancelled" : res.error };
  setBiometricEnabled(false);
  // Drop the browser credential too, so turning the lock back on later registers a
  // fresh one rather than reusing a handle the user may since have removed from
  // their OS keychain (which would fail with nothing useful to say).
  try { localStorage.removeItem(CRED_KEY); } catch (_) {}
  await forgetSession();
  return { ok: true };
}
