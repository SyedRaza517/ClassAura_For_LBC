// Remembering the sign-in details, so returning users don't retype them.
//
// The email and password are stored TOGETHER, as one record keyed to the address they
// belong to. They were separate keys with one tickbox, which desynced in a way that
// leaked a secret: teacher A signs in and signs out; teacher B opens the app, sees A's
// address with a filled password box, and either reads A's password through the reveal
// button or overwrites the address and re-saves B's email against A's password. One
// record with the owner baked in makes that state unrepresentable.
//
// WHAT STORING A PASSWORD HERE MEANS — chosen deliberately, not by accident:
//
//   • Plain text. Anything that can run script on this origin can read it. Obfuscating
//     (base64, a fixed XOR key) would be worse than nothing: the key ships in the same
//     bundle, so it stops nobody and only hides the risk from a future reviewer.
//   • It survives sign-out. That is the point — signing out and retyping would defeat
//     the feature — so on a shared machine the address stays on screen. The password
//     is NOT revealable until the user retypes it (see the login screens), so the next
//     person cannot read it, and changing the address clears it.
//   • It is cleared the moment it can no longer be right: a password change, a reset,
//     account deletion, or a 401 on that address.
//
// THE SAFER PATH, already built: turn on the biometric app lock (More → Preferences).
// The sign-in screen then offers "Sign in with Face / Fingerprint", which unlocks a
// remembered SESSION — a token that expires on its own and that the server can revoke.
// Same one-tap result, no reusable password on disk.
const KEY = "edtech_remembered_login";
// The previous email-only key. Read once for prefill so existing users don't lose
// their address, but it deliberately does NOT tick the box: everyone who had the old
// email-only "remember me" must opt in to password storage explicitly, rather than
// being silently upgraded into it by a relabelled tickbox.
const LEGACY_EMAIL_KEY = "edtech_remembered_email";

const readRecord = () => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const r = JSON.parse(raw);
      if (r && typeof r.email === "string") return { email: r.email, password: typeof r.password === "string" ? r.password : "" };
    }
    const legacy = localStorage.getItem(LEGACY_EMAIL_KEY);
    if (legacy) return { email: legacy, password: "" };
  } catch (_) { /* private browsing, or a corrupt record — fall through to nothing */ }
  return { email: "", password: "" };
};

export const rememberedEmail = () => readRecord().email;
export const rememberedPassword = () => readRecord().password;

/**
 * Save (or clear) both together. Call this only AFTER the server has accepted the
 * credentials — saving first persisted typos and, worse, kept a temporary password
 * that the forced-change gate had already replaced, so the form later prefilled a
 * dead password as dots and the user locked themselves out retrying it.
 */
export function setRememberedLogin(email, password) {
  const e = String(email || "").trim().toLowerCase();
  try {
    localStorage.removeItem(LEGACY_EMAIL_KEY);   // migrate off the old key
    if (!e) { localStorage.removeItem(KEY); return; }
    localStorage.setItem(KEY, JSON.stringify({ email: e, password: password ? String(password) : "" }));
  } catch (_) { /* remembering is optional */ }
}

/** Forget everything. Safe to call unconditionally. */
export const forgetRememberedLogin = () => {
  try { localStorage.removeItem(KEY); localStorage.removeItem(LEGACY_EMAIL_KEY); } catch (_) {}
};

/**
 * Drop only the stored PASSWORD, keeping the address.
 *
 * Used when the password is known to be stale but the person is unchanged — after a
 * password change or reset, or a 401 for that address. Keeping the email means the
 * next sign-in is still half-filled, which is the harmless half of the feature.
 */
export function forgetRememberedPassword() {
  const { email } = readRecord();
  if (email) setRememberedLogin(email, ""); else forgetRememberedLogin();
}

/**
 * True when the stored password belongs to the address currently in the box. The
 * login screens use this to decide whether to prefill at all, so an address the user
 * has edited never carries someone else's secret.
 */
export const passwordMatchesEmail = (email) => {
  const r = readRecord();
  return Boolean(r.password) && r.email === String(email || "").trim().toLowerCase();
};
