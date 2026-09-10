// Is this phone plausibly in the building? — the pure half.
//
// Three routes are about to need this answer: the sticker tap, the scanned code, and the
// "I'm here" button. They get ONE place to ask, and that is the whole reason this is its
// own file rather than three checks written where they are used.
//
// The precedent is not hypothetical. Six handlers in this codebase independently answered
// "who is on this register" from `Enrolment` alone, disagreed with the roster rule, and
// the disagreement was fixed six separate times — including once in a handler that MARKED
// STUDENTS ABSENT, where the wrong answer wrote wrong data rather than merely showing it.
// A presence rule spread across three routes would drift the same way, and the drift would
// be invisible: each route would still refuse somebody, just not the same somebody.
//
// PURE, so a college's attendance rules are testable without a database — the convention
// attendanceTapSettings.js and the prediction engine already follow. Nothing here reads a
// request, a clock or a row; everything arrives as an argument.
//
// WHAT THIS CAN AND CANNOT PROVE, because a college will be asked at a funding audit:
//
//   The network check proves the request reached the server from an address the college
//   says is theirs. It does not prove which room, and a VPN or a tethered phone on a
//   college laptop can defeat it.
//
//   The geofence proves the device reported a position within a radius of a campus. Indoor
//   GPS accuracy is 10-50 metres and worse through concrete, so it can NEVER prove which
//   room — a fact the settings screen has to say out loud, because "geofencing" sounds
//   precise and is not. Room resolution is what the stickers and the beacons are for.
//
// Neither is proof. Each narrows the gap. Both together, plus a sticker that must be
// physically touched, is a good deal more than a login on a phone — which is all that
// stands behind a self check-in today.

// A position is refused outright if the device's own error estimate is bigger than this,
// even when the college has not set a radius yet.
//
// This is the setting that decides whether the geofence means anything at all. A phone
// indoors will happily report "I am at the college, give or take two kilometres", and a
// circle that large contains the campus from most of the city. Accepting it is worse than
// having no geofence: the college believes it has a boundary and does not.
//
// Two kilometres is not a hypothetical figure — it is what a phone with no GPS fix falls
// back to when it locates itself from the cell tower it is attached to.
const MAX_ACCURACY_METRES = 250;

// The floor on a configurable radius. A campus is a set of buildings, not a doorway, and
// GPS scatter alone is tens of metres — so a 5-metre geofence does not mean "very strict",
// it means "refuses everybody, including the student standing in the room". That failure
// presents as "the check-in never works" rather than as a bad setting, which is how a
// feature gets blamed and switched off. Same reasoning as MIN_QR_ROTATE_SECONDS next door.
const MIN_RADIUS_METRES = 50;
const MAX_RADIUS_METRES = 5000;

const EARTH_RADIUS_METRES = 6371008.8;

/**
 * The address a request actually came from, in a comparable form — or null.
 *
 * Node hands back several shapes for the same address and they do not compare equal:
 * an IPv4 socket on a dual-stack listener reports "::ffff:203.0.113.9", a proxy header can
 * carry a port, and IPv6 may arrive bracketed or in any of its legal abbreviations.
 * Comparing those raw against a college's typed-in list is how an allowlist silently
 * matches nothing and locks a whole college out of check-in.
 */
function normaliseIp(value) {
  if (typeof value !== "string") return null;
  let ip = value.trim();
  if (!ip) return null;

  // "[::1]:443" — the bracketed form, with or without a port.
  const bracketed = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) ip = bracketed[1];

  // "203.0.113.9:51234". Only ever stripped from something that looks like IPv4 with a
  // port: a bare IPv6 address is full of colons and chopping at the last one mangles it.
  const v4WithPort = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4WithPort) ip = v4WithPort[1];

  // "::ffff:203.0.113.9" — an IPv4 address delivered over a dual-stack socket. It IS the
  // v4 address and must compare equal to a v4 range the college typed, so it is unwrapped
  // rather than being treated as a separate v6 address that happens to look similar.
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) ip = mapped[1];

  return ip.toLowerCase();
}

/** The 32-bit value of a dotted-quad, or null if it is not one. */
function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    // Rejects "+1", "1e2", "" and anything non-numeric — and, separately, any leading
    // zero. Leading zeros matter: some resolvers read 010 as octal 8, so a college typing
    // 010.0.0.1 must be told their range is wrong rather than have it silently allowlist a
    // network they did not mean. "0" itself is legitimate, which is why the length is part
    // of the test rather than a bare "does not start with zero".
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part[0] === "0") return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/**
 * One entry from a college's allowlist, parsed — or null when it is unusable.
 *
 * Accepts a bare address ("203.0.113.9", treated as /32) or CIDR ("203.0.113.0/24").
 * IPv4 only, DELIBERATELY: a college's public egress is IPv4 in every case this product
 * has met, and a half-right IPv6 prefix comparison is worse than an honest refusal to
 * offer one — it would appear to work and admit the wrong networks. When a college
 * genuinely needs IPv6, it belongs here as its own tested implementation.
 */
function parseCidr(entry) {
  if (typeof entry !== "string") return null;
  const text = entry.trim();
  if (!text) return null;

  const [addr, bitsText, ...rest] = text.split("/");
  if (rest.length) return null;

  const base = ipv4ToInt(addr);
  if (base === null) return null;

  let bits = 32;
  if (bitsText !== undefined) {
    if (!/^\d{1,2}$/.test(bitsText)) return null;
    bits = Number(bitsText);
    if (bits > 32) return null;
  }

  // >>> 0 keeps it unsigned: JavaScript's bitwise operators work on SIGNED 32-bit values,
  // so a /0 or /1 mask comes out negative and every comparison after it is nonsense.
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask, bits, text };
}

/** Every usable entry in a college's list, with the unusable ones dropped. */
function parseNetworks(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    const parsed = parseCidr(entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Whether an address falls inside any of the parsed ranges. */
function ipInNetworks(ip, networks) {
  const normalised = normaliseIp(ip);
  if (!normalised) return false;
  const value = ipv4ToInt(normalised);
  if (value === null) return false;   // IPv6 reaching an IPv4-only allowlist: not a match.
  return networks.some((n) => ((value & n.mask) >>> 0) === n.base);
}

/**
 * What we see a caller as, for the settings screen to show them.
 *
 * This exists because of the single most likely way this feature fails at a real college:
 * an administrator types the address off a router's label, or the one their broadband
 * provider told them years ago, and it is not the address their traffic actually leaves
 * from. Every student is then refused, and the screen says the network is configured. The
 * fix is not documentation — it is showing them the address WE see, standing in their
 * college, so they can add that one.
 *
 * `allowlistable` is the honest part. A college whose traffic leaves over IPv6 cannot use
 * this feature at all, because the ranges are IPv4-only, and that has to be said on the
 * screen at the moment they would otherwise be typing a range that can never match —
 * rather than discovered by a hall of students who cannot check in.
 */
function describeAddress(ip) {
  const normalised = normaliseIp(ip);
  if (!normalised) return { ip: null, family: null, allowlistable: false };
  if (ipv4ToInt(normalised) !== null) return { ip: normalised, family: "ipv4", allowlistable: true };
  return { ip: normalised, family: "ipv6", allowlistable: false };
}

/**
 * Metres between two points on the earth.
 *
 * Haversine, not a flat approximation. The flat one is simpler and its error grows with
 * latitude, which means it would be tuned against a London campus and be wrong for a
 * college further north — a silent, location-dependent bug in a rule that refuses people.
 */
function distanceMetres(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A usable coordinate pair, or null. Rejects the shapes a broken client actually sends. */
function coordsOf(value) {
  if (!value || typeof value !== "object") return null;
  const { latitude, longitude } = value;
  if (typeof latitude !== "number" || !Number.isFinite(latitude)) return null;
  if (typeof longitude !== "number" || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;
  // (0, 0) is in the Gulf of Guinea and is what a client sends when its position object
  // was never filled in. No campus is there, so refusing it costs nothing and it is worth
  // refusing explicitly rather than letting it read as a real position 5,000 km away —
  // which would pass a large enough radius set by a college that typed one zero too many.
  if (latitude === 0 && longitude === 0) return null;
  return { latitude, longitude };
}

/** The clamped radius a campus is checked against. */
function radiusFor(settings) {
  const raw = settings?.geofenceRadiusM;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return MIN_RADIUS_METRES;
  return Math.min(MAX_RADIUS_METRES, Math.max(MIN_RADIUS_METRES, Math.round(raw)));
}

/**
 * Is this device plausibly in the building?
 *
 * Returns `{ ok, failures }` — never throws, and never returns a bare boolean, because the
 * CALLER needs to know WHICH check failed. "Check-in didn't work" sends a student to a
 * lecturer who cannot help; "you need to be on the college WiFi" is a thing they can act
 * on themselves, and the two failures need different words.
 *
 * `failures` is ordered as it is checked and may hold both. The caller reports the first,
 * and logs all of them: a college switching this on for the first time wants to see that
 * its IP list is wrong AND its campus coordinates are, not discover the second one a week
 * after fixing the first.
 *
 * NOT MEASURABLE IS NOT A PASS. A check that is switched ON but cannot be evaluated —
 * no position sent, no campus coordinates recorded, an allowlist that parsed to nothing —
 * fails. This is the null-is-not-zero convention applied to a decision instead of a
 * figure: the alternative is that a college switches the geofence on, nobody has entered
 * the coordinates, every check-in passes, and the screen says the boundary is enforced.
 * A rule that silently stops applying is worse than one that was never switched on, and
 * each of those cases reports its own reason so an administrator can see WHICH.
 */
function checkPresence({ ip, position, campus, settings } = {}) {
  const failures = [];
  const s = settings || {};

  if (s.networkCheck === true) {
    const networks = parseNetworks(s.allowedNetworks);
    if (!networks.length) {
      // Switched on with nothing usable in the list. Refusing everybody is the correct
      // reading: the college asked for "only from our network" and no network qualifies.
      failures.push({ check: "network", reason: "network_not_configured" });
    } else if (!ipInNetworks(ip, networks)) {
      failures.push({ check: "network", reason: "off_network" });
    }
  }

  if (s.geofenceCheck === true) {
    const centre = coordsOf(campus);
    const here = coordsOf(position);
    if (!centre) {
      failures.push({ check: "geofence", reason: "campus_not_located" });
    } else if (!here) {
      // Covers a refused permission, a browser with no geolocation, and a client that
      // simply did not send one. All the same answer — we cannot tell where this is.
      failures.push({ check: "geofence", reason: "position_missing" });
    } else {
      const radius = radiusFor(s);
      const accuracy = typeof position.accuracy === "number" && Number.isFinite(position.accuracy)
        ? Math.max(0, position.accuracy)
        : null;
      // A phone with no satellite fix reports its cell tower and an error estimate of
      // kilometres. That circle contains the campus from most of the city, so accepting it
      // would mean the college believes it has a boundary and does not.
      //
      // Checked against the college's own radius as well as the hard ceiling: a 100-metre
      // campus cannot be policed by a position that is only good to 400 metres, whatever
      // the ceiling says.
      if (accuracy === null) {
        failures.push({ check: "geofence", reason: "accuracy_unknown" });
      } else if (accuracy > MAX_ACCURACY_METRES || accuracy > radius) {
        failures.push({ check: "geofence", reason: "accuracy_too_poor", accuracy: Math.round(accuracy) });
      } else {
        const away = distanceMetres(centre, here);
        if (away > radius) {
          failures.push({ check: "geofence", reason: "off_campus", metres: Math.round(away) });
        }
      }
    }
  }

  return { ok: failures.length === 0, failures };
}

module.exports = {
  MAX_ACCURACY_METRES, MIN_RADIUS_METRES, MAX_RADIUS_METRES,
  normaliseIp, parseCidr, parseNetworks, ipInNetworks, describeAddress,
  distanceMetres, radiusFor, checkPresence,
};
