// Where the phone thinks it is, for a check-in — or nothing, said plainly.
//
// ONE PLACE, because three screens need it: the sticker tap, the scanned code and the
// "I'm here" button. Three copies of a permission prompt would drift, and the drift would
// be invisible until the day one of them asked for a coarse position and the server
// refused it as too vague.
//
// WHAT THIS SENDS IS A READING, NEVER A VERDICT. It reports latitude, longitude and the
// phone's own accuracy estimate, and the server does the arithmetic against coordinates
// the college recorded. A client that decided "I am close enough" and sent a boolean would
// be sending a value anybody can send — which is not a geofence, it is a checkbox.
//
// It NEVER throws and never blocks a check-in on its own. Every failure — permission
// refused, no hardware, a timeout indoors — returns null, and the server decides what null
// means. That division matters: the rule about whether a missing position is fatal belongs
// with the college's settings, not in a phone's error handler, and a client that decided
// for itself would be a second opinion about a rule that already has one.

// Long enough for a cold GPS fix indoors, short enough that a student is not left holding
// a phone at a spinner. A first fix from cold can genuinely take 20-30 seconds; a warm one
// is nearly instant, and this only bites in the bad case.
const TIMEOUT_MS = 15_000;

// Accept a fix up to a minute old. Walking into the room, taking a phone out and pressing
// a button takes longer than that, and refusing a cached fix means a fresh satellite
// acquisition inside a concrete building — the exact conditions where it fails.
const MAX_AGE_MS = 60_000;

export function wherePhoneIs() {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };

    // Our OWN timer as well as the one passed below. Some WebViews never call either
    // callback when location services are off at the operating-system level — no error, no
    // position, nothing — and a check-in that hangs for ever is worse than one refused.
    const timer = setTimeout(() => finish(null), TIMEOUT_MS + 2000);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        const c = pos?.coords;
        if (!c || typeof c.latitude !== "number" || typeof c.longitude !== "number") return finish(null);
        finish({
          latitude: c.latitude,
          longitude: c.longitude,
          // Passed on EXACTLY as reported, including when it is terrible. The server
          // refuses a fix too vague to mean anything — a phone with no satellite lock
          // reports its cell tower give or take kilometres — and it can only do that if
          // this number arrives honestly. Rounding it, defaulting it or omitting it when
          // it looks bad would each turn "we cannot tell" into "we can".
          accuracy: typeof c.accuracy === "number" ? c.accuracy : null,
        });
      },
      () => { clearTimeout(timer); finish(null); },
      // enableHighAccuracy asks for the satellite fix rather than the network estimate.
      // It costs battery and time, and it is the difference between a reading the server
      // will accept and one it refuses as too vague — so it is on for the one action in
      // this app where the answer has to be good enough to stand behind a mark.
      { enableHighAccuracy: true, timeout: TIMEOUT_MS, maximumAge: MAX_AGE_MS },
    );
  });
}
