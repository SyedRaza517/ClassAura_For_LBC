// Reading an NFC sticker from inside the app.
//
// Wraps @capgo/capacitor-nfc so the rest of the client never imports it directly and
// never has to know that the two platforms behave differently. Shaped like biometric.js:
// every entry point resolves to a described state rather than throwing, because this
// runs on desktop browsers, on phones without NFC hardware, and on phones where the
// user has NFC switched off — and "unavailable" is a normal answer in all three.
//
// THE PLATFORM DIFFERENCE, ONCE, HERE
//
// Android can listen silently: the app turns on reader mode while the check-in screen is
// showing and the tag is detected when the phone touches it, with no prompt.
//
// iOS cannot. Core NFC always presents Apple's own "Ready to Scan" sheet and it cannot
// be suppressed — a platform rule, not a plugin limitation. So on iPhone the student
// presses a button first, Apple's sheet appears, they touch the sticker, the sheet
// closes. One extra press, and there is no way to remove it.
//
// Callers get `needsPrompt` and render the right thing rather than discovering this.

import { Capacitor } from "@capacitor/core";

const NATIVE = Capacitor?.isNativePlatform?.() === true;
const PLATFORM = Capacitor?.getPlatform?.() || "web";

// iOS shows a system scan sheet that cannot be suppressed, so scanning there has to be
// started by a deliberate press. Android reader mode is silent and can be armed as soon
// as the screen appears.
export const NEEDS_PROMPT = PLATFORM === "ios";

// Loaded lazily and only on a native platform. A static import would pull the plugin
// into the web bundle, where its only job is to throw "unimplemented" — and the admin
// console runs in a desktop browser, where paying for that is pointless.
let pluginPromise = null;
async function plugin() {
  if (!NATIVE) return null;
  if (!pluginPromise) pluginPromise = import("@capgo/capacitor-nfc").then((m) => m.CapacitorNfc || m.Nfc || m.default).catch(() => null);
  return await pluginPromise;
}

/**
 * Can this device read a tag at all, and if not, why not?
 *
 * Returns one of:
 *   { ok: false, reason: "web" }        running in a browser, not the app
 *   { ok: false, reason: "no-hardware" } the handset has no NFC chip
 *   { ok: false, reason: "disabled" }    NFC is switched off in system settings
 *   { ok: false, reason: "error" }       the plugin said something we did not expect
 *   { ok: true, needsPrompt }            good to go
 *
 * The reasons are separate because the remedies are: "disabled" is something the student
 * can fix in ten seconds and should be told about, while "no-hardware" means they will
 * never use this feature and should be told THAT instead of being sent to a settings
 * screen that will not help.
 */
export async function nfcStatus() {
  if (!NATIVE) return { ok: false, reason: "web" };
  const p = await plugin();
  if (!p) return { ok: false, reason: "error", detail: "The NFC component did not load." };
  try {
    const s = await p.isSupported();
    if (!s?.supported) return { ok: false, reason: "no-hardware" };
    // getStatus reports the adapter itself: NFC_OK, NFC_DISABLED, NO_NFC. Not every
    // platform implements it, so a throw here is treated as "supported, state unknown"
    // rather than as a failure — iOS in particular has no adapter to switch off.
    try {
      const st = await p.getStatus();
      const v = st?.status || st;
      if (v === "NO_NFC") return { ok: false, reason: "no-hardware" };
      if (v === "NFC_DISABLED") return { ok: false, reason: "disabled" };
    } catch (_) { /* state unknown — fall through to ok */ }
    return { ok: true, needsPrompt: NEEDS_PROMPT };
  } catch (e) {
    return { ok: false, reason: "error", detail: e?.message || String(e) };
  }
}

/** Bytes → hex, uppercase, no separators. Used for a tag's factory UID. */
const hex = (bytes) => (Array.isArray(bytes) ? bytes : []).map((b) => Number(b).toString(16).padStart(2, "0")).join("").toUpperCase();

/**
 * Decode an NDEF Text record payload.
 *
 * The payload is NOT the text. Byte 0 is a status byte whose low six bits give the
 * length of an IANA language code that follows ("en", "en-GB"), and the text begins
 * after that. Slicing from byte 1 — the obvious mistake — yields "enLONDON-101" and a
 * code that never matches anything.
 */
function decodeTextRecord(payload) {
  const bytes = Array.isArray(payload) ? payload : [];
  if (!bytes.length) return "";
  const langLen = bytes[0] & 0x3f;
  const body = bytes.slice(1 + langLen);
  try {
    return new TextDecoder("utf-8").decode(Uint8Array.from(body)).trim();
  } catch (_) {
    return "";
  }
}

/**
 * The code this physical tag represents.
 *
 * Prefers a written NDEF text record, and falls back to the tag's factory UID. Both are
 * supported on purpose, because they are two genuinely different rollouts: a college can
 * write a generated secret onto each sticker with a phone app, or it can buy blank
 * stickers and register each one by tapping it. The second needs no tooling at all, and
 * for a college with thirty rooms that is the difference between an afternoon and a
 * fortnight of good intentions.
 */
export function codeFromTag(tag) {
  const records = tag?.ndefMessage || tag?.message || [];
  for (const r of records) {
    const text = decodeTextRecord(r?.payload);
    if (text) return text;
  }
  const uid = hex(tag?.id);
  return uid || "";
}

/**
 * Listen for one tag, then stop.
 *
 * Resolves with the tag's code, or rejects with a message meant for a person. Always
 * tears the session down — on iOS a session left open holds Apple's sheet on screen, and
 * on Android reader mode left armed keeps consuming the radio behind other screens.
 *
 * @param {object} opts
 * @param {string} opts.alertMessage  what Apple's sheet says. Ignored on Android.
 * @param {number} opts.timeoutMs     give up after this long. iOS closes its own sheet
 *                                    after ~20s; this is the app's own ceiling.
 */
export async function scanOnce({ alertMessage = "Hold your phone near the sticker", timeoutMs = 30_000 } = {}) {
  const p = await plugin();
  if (!p) throw new Error("NFC isn't available on this device.");

  let handle = null;
  let timer = null;
  const stop = async () => {
    try { if (handle?.remove) await handle.remove(); } catch (_) { /* ignore */ }
    try { await p.stopScanning(); } catch (_) { /* ignore */ }
    if (timer) clearTimeout(timer);
  };

  return await new Promise((resolve, reject) => {
    const done = (fn, arg) => { stop().finally(() => fn(arg)); };

    p.addListener("ndefDiscovered", (ev) => {
      const code = codeFromTag(ev?.tag || ev);
      if (code) done(resolve, code);
    }).then((h) => { handle = h; }).catch(() => {});

    // A blank sticker raises tagDiscovered rather than ndefDiscovered — there is no NDEF
    // message to find. That is the whole UID path, so listening for only the NDEF event
    // would silently ignore every unwritten tag.
    p.addListener("tagDiscovered", (ev) => {
      const code = codeFromTag(ev?.tag || ev);
      if (code) done(resolve, code);
    }).catch(() => {});

    p.startScanning({ alertMessage }).catch((e) => {
      done(reject, new Error(e?.message || "Could not start the NFC reader."));
    });

    timer = setTimeout(() => done(reject, new Error("No sticker detected. Try again, holding the phone still against it.")), timeoutMs);
  });
}

/** Stop any scan this module started. Safe to call when nothing is running. */
export async function cancelScan() {
  const p = await plugin();
  if (!p) return;
  try { await p.stopScanning(); } catch (_) { /* ignore */ }
}

export const NFC_PLATFORM = PLATFORM;
export const NFC_NATIVE = NATIVE;
