// An id this browser or app made up once and keeps, sent with every self check-in.
//
// Not identity: the signed-in account is who checked in, and the server never refuses a
// scan on this alone. It is the trail behind the log — "did one handset scan for six
// accounts in a minute" is a question an administrator can only answer if each scan
// says which handset it came from. Random, so it carries nothing about the phone; kept
// in localStorage, which inside the packaged app is private to the app.
const KEY = "edtech.deviceId";

function fresh() {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function deviceId() {
  try {
    let v = localStorage.getItem(KEY);
    if (!v || !/^[A-Za-z0-9_-]{8,64}$/.test(v)) { v = fresh(); localStorage.setItem(KEY, v); }
    return v;
  } catch (_) {
    return null; // storage blocked: the scan still goes, just without a trail
  }
}

/** The header the check-in calls attach, or nothing when no id could be kept. */
export function deviceHeaders() {
  const id = deviceId();
  return id ? { "X-Device-Id": id } : {};
}
