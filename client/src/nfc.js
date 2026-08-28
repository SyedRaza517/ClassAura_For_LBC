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
// NFC Forum record types, as byte arrays because that is how the plugin reports them.
// TNF 0x01 is "well known"; type "T" (0x54) is a Text record and "U" (0x55) is a URI.
const TNF_WELL_KNOWN = 1;
const TYPE_TEXT = 0x54;

/** Is this record genuinely an RTD-Text record, rather than a URI or a MIME record? */
function isTextRecord(r) {
  const type = Array.isArray(r?.type) ? r.type : [];
  return r?.tnf === TNF_WELL_KNOWN && type.length === 1 && type[0] === TYPE_TEXT;
}

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
    // The type check is not belt-and-braces. A URI record's first payload byte is a
    // scheme PREFIX, not a text status byte — read as one, prefix 0x01 gives a language
    // length of 1, two bytes are sliced off the front, and "https://example.com/x"
    // becomes "xample.com/x". That is a code which looks plausible, never matches
    // anything, and gives no clue why.
    if (!isTextRecord(r)) continue;
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
 * Only ONE scan runs at a time, process-wide. The plugin is a module-level singleton with
 * one radio behind it, so a second scan starting while the first is live would have both
 * sessions issuing stopScanning() at each other. Starting a new one settles the old one
 * first.
 *
 * @param {object} opts
 * @param {string} opts.alertMessage  what Apple's sheet says. Ignored on Android.
 * @param {number} opts.timeoutMs     give up after this long. iOS closes its own sheet
 *                                    after ~20s; this is the app's own ceiling.
 */
let activeScan = null;   // { settle } for the scan currently holding the radio

export async function scanOnce({ alertMessage = "Hold your phone near the sticker", timeoutMs = 30_000 } = {}) {
  const p = await plugin();
  if (!p) throw new Error("NFC isn't available on this device.");

  // Whatever was running loses the radio to us, and is told so rather than being left
  // waiting on a promise that will never settle.
  if (activeScan) activeScan.settle(new CancelledError());

  const handles = [];
  let timer = null;
  let finished = false;

  return await new Promise((resolve, reject) => {
    const settle = (err, code) => {
      if (finished) return;
      finished = true;
      if (activeScan && activeScan.token === settle) activeScan = null;
      if (timer) { clearTimeout(timer); timer = null; }
      // EVERY listener is removed, not just the first. addListener returns a handle per
      // call; keeping only the last one leaked one listener per scan, and on Android the
      // card re-arms every thirty seconds — an hour on the check-in screen accumulated
      // roughly a hundred live handlers, all of which fired at the next tag and each of
      // which then stopped the session.
      Promise.allSettled(handles.map((h) => (h?.remove ? h.remove() : Promise.resolve())))
        .then(() => p.stopScanning().catch(() => {}))
        .finally(() => (err ? reject(err) : resolve(code)));
    };
    settle.token = settle;
    activeScan = { settle: (e) => settle(e), token: settle };

    const onTag = (ev) => {
      const code = codeFromTag(ev?.tag || ev);
      if (code) settle(null, code);
      // A tag that yields no code is a dead end on iOS, where the session has already
      // closed itself after the first read. Saying so beats leaving the button disabled
      // until the timeout with the screen still reading "hold your phone against it".
      else settle(new Error("That sticker could not be read. It may be blank or damaged."));
    };

    // Both events matter. A written sticker raises ndefDiscovered; a BLANK one raises
    // only tagDiscovered, and that is the entire "register it by tapping it" path — so
    // listening for the NDEF event alone would silently ignore every unwritten tag.
    for (const evt of ["ndefDiscovered", "tagDiscovered"]) {
      p.addListener(evt, onTag).then((h) => {
        if (finished) { h?.remove?.(); return; }
        handles.push(h);
      }).catch(() => {});
    }

    // iOS ends the session when the user presses Cancel on Apple's sheet, or when it
    // times out on its own. Without this the button sat disabled reading "Scanning…"
    // for the full thirty seconds after a deliberate cancel.
    p.addListener("nfcSessionEnd", (ev) => {
      const reason = ev?.reason;
      if (reason === "userCancelled") settle(new CancelledError());
      else if (!finished) settle(new Error("The scan ended before a sticker was read."));
    }).then((h) => { if (finished) h?.remove?.(); else handles.push(h); }).catch(() => {});

    p.startScanning({ alertMessage }).catch((e) => {
      settle(new Error(e?.message || "Could not start the NFC reader."));
    });

    timer = setTimeout(() => settle(new TimeoutError()), timeoutMs);
  });
}

/**
 * Two rejections callers treat differently from a real failure.
 *
 * A cancel is the user saying no, and a timeout on Android is the ordinary case of
 * nobody having tapped yet — neither should paint an error banner, which is what the
 * check-in card was doing every thirty seconds while it silently re-armed.
 */
export class CancelledError extends Error {
  constructor() { super("Scan cancelled."); this.name = "CancelledError"; this.cancelled = true; }
}
export class TimeoutError extends Error {
  constructor() { super("No sticker detected. Try again, holding the phone still against it."); this.name = "TimeoutError"; this.timedOut = true; }
}

/** Stop any scan this module started. Safe to call when nothing is running. */
export async function cancelScan() {
  // Settles the in-flight promise as well as stopping the radio. Stopping the radio
  // alone left scanOnce pending with its listeners attached and its timer ticking — and
  // that stale timer, firing later, would call stopScanning() underneath whatever scan
  // had started in the meantime, so leaving the screen and coming back made taps
  // silently stop working for up to thirty seconds.
  if (activeScan) activeScan.settle(new CancelledError());
  const p = await plugin();
  if (!p) return;
  try { await p.stopScanning(); } catch (_) { /* ignore */ }
}

export const NFC_PLATFORM = PLATFORM;
export const NFC_NATIVE = NATIVE;
