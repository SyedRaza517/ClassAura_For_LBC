// The presence rule, tested without a database — the point of splitting it out.
//
// Weighted toward what it REFUSES, matching the smoke suites: this module exists to say
// no, and a permissive bug in it is invisible (everybody checks in, exactly as before)
// while a strict one is reported within a minute (nobody can check in). So the passes are
// asserted once each and the refusals are enumerated.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_ACCURACY_METRES, MIN_RADIUS_METRES, MAX_RADIUS_METRES,
  normaliseIp, parseCidr, parseNetworks, ipInNetworks,
  distanceMetres, radiusFor, checkPresence, describeAddress,
} = require("./presence");

const reasons = (r) => r.failures.map((f) => f.reason);

/* ------------------------------- addresses ------------------------------- */

test("an address arrives in several shapes and they all have to compare equal", () => {
  // Each of these is the SAME machine as far as a college's allowlist is concerned, and
  // each is a shape Node or a proxy actually produces. Comparing them raw is how an
  // allowlist matches nothing and locks a college out of check-in on the morning it is
  // switched on.
  assert.equal(normaliseIp("203.0.113.9"), "203.0.113.9");
  assert.equal(normaliseIp("::ffff:203.0.113.9"), "203.0.113.9", "dual-stack socket");
  assert.equal(normaliseIp("::FFFF:203.0.113.9"), "203.0.113.9", "and uppercased");
  assert.equal(normaliseIp("203.0.113.9:51234"), "203.0.113.9", "with a source port");
  assert.equal(normaliseIp("  203.0.113.9  "), "203.0.113.9", "with whitespace");
  assert.equal(normaliseIp("[2001:db8::1]:443"), "2001:db8::1", "bracketed v6 with a port");
});

test("a bare IPv6 address is not chopped at its last colon", () => {
  // The port-stripping regex must not fire on an address that is mostly colons. Getting
  // this wrong turns 2001:db8::1 into 2001:db8: and every comparison after it is nonsense.
  assert.equal(normaliseIp("2001:db8::1"), "2001:db8::1");
  assert.equal(normaliseIp("::1"), "::1");
});

test("nothing usable comes back as null rather than as an empty string", () => {
  for (const v of [undefined, null, "", "   ", 42, {}, []]) {
    assert.equal(normaliseIp(v), null, `${JSON.stringify(v)} is not an address`);
  }
});

/* -------------------------------- ranges --------------------------------- */

test("a college can type a single address or a range", () => {
  assert.deepEqual(parseCidr("203.0.113.9").bits, 32, "a bare address is a /32");
  assert.deepEqual(parseCidr("203.0.113.0/24").bits, 24);
  assert.equal(parseCidr(" 203.0.113.0/24 ").bits, 24, "trimmed");
});

test("a /0 or /1 does not come out negative", () => {
  // JavaScript's bitwise operators work on SIGNED 32-bit values, so `0xffffffff << 31`
  // is negative and every comparison against it silently fails. Without the >>> 0 in
  // parseCidr this test fails and a college's widest range matches nothing.
  const wide = parseCidr("0.0.0.0/0");
  assert.ok(wide.mask >= 0, `mask went negative: ${wide.mask}`);
  assert.ok(parseCidr("128.0.0.0/1").mask >= 0);
  assert.equal(ipInNetworks("203.0.113.9", [wide]), true, "a /0 matches everything");
});

test("a range that is not one is refused rather than half-read", () => {
  for (const bad of [
    "", "   ", "not an ip", "203.0.113", "203.0.113.9.9", "203.0.113.256",
    "203.0.113.0/33", "203.0.113.0/", "203.0.113.0/24/8", "203.0.113.0/aa",
    "-1.0.0.1", "1e2.0.0.1", "2001:db8::/32", null, undefined, 42, {},
  ]) {
    assert.equal(parseCidr(bad), null, `${JSON.stringify(bad)} should not parse`);
  }
});

test("a leading zero is refused, not read as octal", () => {
  // Some resolvers read 010 as 8. A college typing 010.0.0.1 must be told their range is
  // wrong rather than silently allowlisting a network they did not mean.
  assert.equal(parseCidr("010.0.0.1"), null);
});

test("one bad entry in the list does not throw away the good ones", () => {
  // A college pasting a list will get one line wrong. Their other three ranges must keep
  // working — but see the "nothing usable" case below for what happens when ALL of them
  // are wrong, which is deliberately NOT the same outcome.
  const parsed = parseNetworks(["203.0.113.0/24", "nonsense", "198.51.100.7", null]);
  assert.equal(parsed.length, 2);
  assert.equal(ipInNetworks("203.0.113.55", parsed), true);
  assert.equal(ipInNetworks("198.51.100.7", parsed), true);
});

test("a range matches its own network and nothing outside it", () => {
  const nets = parseNetworks(["203.0.113.0/24"]);
  assert.equal(ipInNetworks("203.0.113.0", nets), true, "the network address itself");
  assert.equal(ipInNetworks("203.0.113.255", nets), true, "and the broadcast address");
  assert.equal(ipInNetworks("203.0.114.0", nets), false, "one past the end");
  assert.equal(ipInNetworks("203.0.112.255", nets), false, "one before the start");
});

test("a dual-stack address matches the IPv4 range a college typed", () => {
  // THE FAILURE THIS WHOLE NORMALISATION EXISTS FOR. Render terminates on a dual-stack
  // listener, so without unwrapping, every real request arrives as ::ffff:x.x.x.x, matches
  // no IPv4 range, and the college's entire student body is refused on day one.
  assert.equal(ipInNetworks("::ffff:203.0.113.55", parseNetworks(["203.0.113.0/24"])), true);
});

test("an IPv6 address reaching an IPv4 list is a miss, not a crash", () => {
  assert.equal(ipInNetworks("2001:db8::1", parseNetworks(["203.0.113.0/24"])), false);
});

/* ------------------------------- distance -------------------------------- */

test("distance is real metres, not degrees", () => {
  // Two points about 111 metres apart: 0.001 degrees of latitude.
  const d = distanceMetres({ latitude: 51.5, longitude: -0.12 }, { latitude: 51.501, longitude: -0.12 });
  assert.ok(d > 105 && d < 120, `expected ~111m, got ${d}`);
  assert.equal(Math.round(distanceMetres({ latitude: 51.5, longitude: -0.12 }, { latitude: 51.5, longitude: -0.12 })), 0);
});

test("a degree of longitude is shorter in Edinburgh than in London", () => {
  // The flat-earth approximation gets this wrong, and its error GROWS with latitude — so
  // it would be tuned against a London campus and be quietly wrong for a college further
  // north. That is a location-dependent bug in a rule that refuses people.
  const london = distanceMetres({ latitude: 51.5, longitude: 0 }, { latitude: 51.5, longitude: 0.01 });
  const edinburgh = distanceMetres({ latitude: 55.95, longitude: 0 }, { latitude: 55.95, longitude: 0.01 });
  assert.ok(edinburgh < london, `${edinburgh} should be shorter than ${london}`);
});

/* -------------------------------- radius --------------------------------- */

test("a radius too small to be met is raised to the floor", () => {
  // A 5-metre geofence does not mean "very strict" — GPS scatter alone is tens of metres,
  // so it refuses the student standing in the room, and that presents as "check-in never
  // works" rather than as a bad setting.
  assert.equal(radiusFor({ geofenceRadiusM: 5 }), MIN_RADIUS_METRES);
  assert.equal(radiusFor({ geofenceRadiusM: 0 }), MIN_RADIUS_METRES);
  assert.equal(radiusFor({ geofenceRadiusM: -100 }), MIN_RADIUS_METRES);
  assert.equal(radiusFor({ geofenceRadiusM: 999999 }), MAX_RADIUS_METRES);
  assert.equal(radiusFor({}), MIN_RADIUS_METRES, "unset is the floor, never unlimited");
  assert.equal(radiusFor({ geofenceRadiusM: "200" }), MIN_RADIUS_METRES, "a string is not a number");
  assert.equal(radiusFor({ geofenceRadiusM: 200 }), 200, "a sensible one is kept");
});

/* ------------------------------ the decision ----------------------------- */

const CAMPUS = { latitude: 51.5074, longitude: -0.1278 };
const NEARBY = { latitude: 51.5076, longitude: -0.1278, accuracy: 20 };   // ~22m away
const FAR = { latitude: 51.5200, longitude: -0.1278, accuracy: 20 };      // ~1.4km away

test("with every check switched off, nothing is refused", () => {
  // The default state. A college that has not configured any of this must behave exactly
  // as it did before this module existed.
  assert.equal(checkPresence({ settings: {} }).ok, true);
  assert.equal(checkPresence({}).ok, true, "and with no settings at all");
  assert.equal(checkPresence().ok, true, "and with no arguments at all");
});

test("a switched-off check is not evaluated even when it would fail", () => {
  const r = checkPresence({
    ip: "198.51.100.1", position: FAR, campuses: [CAMPUS],
    settings: { networkCheck: false, geofenceCheck: false, allowedNetworks: ["203.0.113.0/24"] },
  });
  assert.equal(r.ok, true);
});

test("on the college network passes, off it is refused BY NAME", () => {
  const settings = { networkCheck: true, allowedNetworks: ["203.0.113.0/24"] };
  assert.equal(checkPresence({ ip: "203.0.113.55", settings }).ok, true);

  const off = checkPresence({ ip: "198.51.100.1", settings });
  assert.equal(off.ok, false);
  assert.deepEqual(reasons(off), ["off_network"]);
});

test("SWITCHED ON WITH AN EMPTY LIST REFUSES EVERYBODY, and says why", () => {
  // The alternative — treating "no ranges" as "any range" — means an administrator ticks
  // the box, saves, sees no error, and believes the college network is enforced while
  // every check-in on earth passes. A rule that silently stops applying is worse than one
  // that was never switched on.
  for (const list of [[], undefined, null, "203.0.113.0/24", ["nonsense", "also bad"]]) {
    const r = checkPresence({ ip: "203.0.113.55", settings: { networkCheck: true, allowedNetworks: list } });
    assert.equal(r.ok, false, `${JSON.stringify(list)} should refuse`);
    assert.deepEqual(reasons(r), ["network_not_configured"]);
  }
});

test("on campus passes, off campus is refused with the distance", () => {
  const settings = { geofenceCheck: true, geofenceRadiusM: 200 };
  assert.equal(checkPresence({ position: NEARBY, campuses: [CAMPUS], settings }).ok, true);

  const away = checkPresence({ position: FAR, campuses: [CAMPUS], settings });
  assert.equal(away.ok, false);
  assert.deepEqual(reasons(away), ["off_campus"]);
  // The metres are reported so an administrator debugging "my students are all refused"
  // can see whether their radius is too tight or their coordinates are simply wrong.
  assert.ok(away.failures[0].metres > 1000, `expected ~1400m, got ${away.failures[0].metres}`);
});

test("A POSITION TOO VAGUE TO MEAN ANYTHING IS REFUSED, not accepted", () => {
  // The assertion the geofence's honesty rests on. A phone with no satellite fix reports
  // its cell tower with an error estimate of kilometres — a circle that contains the campus
  // from most of the city. Accepting it means the college believes it has a boundary and
  // has not got one.
  const settings = { geofenceCheck: true, geofenceRadiusM: 200 };
  const vague = checkPresence({ position: { ...CAMPUS, accuracy: 2000 }, campuses: [CAMPUS], settings });
  assert.equal(vague.ok, false, "standing exactly on the campus is not enough if the fix is 2km wide");
  assert.deepEqual(reasons(vague), ["accuracy_too_poor"]);
  assert.equal(vague.failures[0].accuracy, 2000);
});

test("accuracy is judged against the college's own radius, not only the ceiling", () => {
  // A 100-metre campus cannot be policed by a fix that is good to 240 metres, even though
  // 240 is inside the hard ceiling.
  const tight = checkPresence({
    position: { ...CAMPUS, accuracy: 240 }, campuses: [CAMPUS],
    settings: { geofenceCheck: true, geofenceRadiusM: 100 },
  });
  assert.equal(tight.ok, false);
  assert.deepEqual(reasons(tight), ["accuracy_too_poor"]);
  assert.ok(MAX_ACCURACY_METRES >= 240, "this test is only meaningful below the ceiling");
});

test("a position with no accuracy figure at all is refused", () => {
  // A client that sends coordinates without an error estimate is either broken or hand-
  // written. Trusting it would be the easiest way around the whole geofence: send the
  // campus coordinates and no accuracy.
  const r = checkPresence({
    position: { ...CAMPUS }, campuses: [CAMPUS],
    settings: { geofenceCheck: true, geofenceRadiusM: 200 },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(reasons(r), ["accuracy_unknown"]);
});

test("NO POSITION IS A REFUSAL, not a pass", () => {
  // Refused permission, a browser with no geolocation, or a client that just omitted it —
  // all the same answer, because all three mean we cannot tell where this device is.
  // Passing here would make the geofence optional at the student's discretion.
  const settings = { geofenceCheck: true, geofenceRadiusM: 200 };
  for (const p of [undefined, null, {}, { latitude: 51.5 }, { latitude: "51.5", longitude: -0.12, accuracy: 5 }]) {
    const r = checkPresence({ position: p, campuses: [CAMPUS], settings });
    assert.equal(r.ok, false, `${JSON.stringify(p)} should refuse`);
    assert.deepEqual(reasons(r), ["position_missing"]);
  }
});

test("(0, 0) is not a position", () => {
  // What a client sends when its position object was never filled in. It is in the Gulf of
  // Guinea, and reading it as real would pass any college that typed one zero too many
  // into its radius.
  const r = checkPresence({
    position: { latitude: 0, longitude: 0, accuracy: 5 }, campuses: [CAMPUS],
    settings: { geofenceCheck: true, geofenceRadiusM: 200 },
  });
  assert.deepEqual(reasons(r), ["position_missing"]);
});

test("an out-of-range coordinate is not a position either", () => {
  const settings = { geofenceCheck: true, geofenceRadiusM: 200 };
  for (const p of [{ latitude: 91, longitude: 0, accuracy: 5 }, { latitude: 0, longitude: 181, accuracy: 5 },
                   { latitude: NaN, longitude: 0, accuracy: 5 }, { latitude: Infinity, longitude: 0, accuracy: 5 }]) {
    assert.deepEqual(reasons(checkPresence({ position: p, campuses: [CAMPUS], settings })), ["position_missing"]);
  }
});

test("A CAMPUS WITH NO COORDINATES REFUSES, and does not quietly stop checking", () => {
  // The same failure as the empty allowlist, in the other check: switched on, nothing to
  // compare against, so the boundary the screen claims to enforce would enforce nothing.
  const settings = { geofenceCheck: true, geofenceRadiusM: 200 };
  for (const c of [undefined, null, {}, { latitude: 51.5 }, { latitude: null, longitude: null }]) {
    const r = checkPresence({ position: NEARBY, campuses: [c], settings });
    assert.equal(r.ok, false, `${JSON.stringify(c)} should refuse`);
    assert.deepEqual(reasons(r), ["campus_not_located"]);
  }
});

test("both checks failing reports both, in the order they are checked", () => {
  // A college switching this on for the first time needs to see that its IP list is wrong
  // AND its coordinates are — not discover the second one a week after fixing the first.
  const r = checkPresence({
    ip: "198.51.100.1", position: FAR, campuses: [CAMPUS],
    settings: { networkCheck: true, allowedNetworks: ["203.0.113.0/24"], geofenceCheck: true, geofenceRadiusM: 200 },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(reasons(r), ["off_network", "off_campus"]);
});

test("both checks passing together is a pass", () => {
  const r = checkPresence({
    ip: "::ffff:203.0.113.55", position: NEARBY, campuses: [CAMPUS],
    settings: { networkCheck: true, allowedNetworks: ["203.0.113.0/24"], geofenceCheck: true, geofenceRadiusM: 200 },
  });
  assert.deepEqual(r, { ok: true, failures: [] });
});

test("it never throws, whatever it is handed", () => {
  // It is called on the check-in path. A throw here is a 500 for a student standing in a
  // lecture, on input that reaches us from a phone.
  const nasty = [
    { ip: {}, settings: { networkCheck: true, allowedNetworks: [{}] } },
    { position: "here", campuses: ["there"], settings: { geofenceCheck: true } },
    { settings: { networkCheck: true, geofenceCheck: true, allowedNetworks: [[]], geofenceRadiusM: NaN } },
    { ip: [], position: [], campuses: [], settings: [] },
  ];
  for (const args of nasty) {
    const r = checkPresence(args);
    assert.equal(typeof r.ok, "boolean", JSON.stringify(args));
    assert.ok(Array.isArray(r.failures));
  }
});

/* ---------------------------- several campuses --------------------------- */

const OTHER_CAMPUS = { latitude: 51.4545, longitude: -2.5879 };   // Bristol, ~170km away

test("near ANY of the college's campuses passes", () => {
  // Half the classes in a college have no room recorded — a seminar arranged by email, a
  // register created before rooms were used — so "which campus is this class at" is
  // frequently unknowable, and the caller passes every located campus instead. Refusing
  // all of those would make the geofence unusable at the colleges most likely to want it.
  const settings = { geofenceCheck: true, geofenceRadiusM: 200 };
  assert.equal(checkPresence({ position: NEARBY, campuses: [OTHER_CAMPUS, CAMPUS], settings }).ok, true);
  assert.equal(checkPresence({ position: NEARBY, campuses: [CAMPUS, OTHER_CAMPUS], settings }).ok, true,
    "and the order it is asked in makes no difference");
});

test("near NONE of them is still refused", () => {
  const r = checkPresence({
    position: FAR, campuses: [CAMPUS, OTHER_CAMPUS],
    settings: { geofenceCheck: true, geofenceRadiusM: 200 },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(reasons(r), ["off_campus"]);
});

test("the distance reported is to the NEAREST campus, not an arbitrary one", () => {
  // An administrator told a student is 170 km away, when the campus down the road is 1.4 km
  // off, goes looking for the wrong problem entirely.
  const r = checkPresence({
    position: FAR, campuses: [OTHER_CAMPUS, CAMPUS],
    settings: { geofenceCheck: true, geofenceRadiusM: 200 },
  });
  assert.ok(r.failures[0].metres < 5000, `expected the London distance, got ${r.failures[0].metres}m`);
});

test("campuses with no coordinates are skipped, not counted as somewhere", () => {
  // A college part-way through recording its campuses. The located ones must keep working;
  // an unlocated one must not read as a place the student could be.
  const settings = { geofenceCheck: true, geofenceRadiusM: 200 };
  const mixed = [{ latitude: null, longitude: null }, {}, CAMPUS];
  assert.equal(checkPresence({ position: NEARBY, campuses: mixed, settings }).ok, true);
  assert.deepEqual(
    reasons(checkPresence({ position: NEARBY, campuses: [{ latitude: null, longitude: null }, {}], settings })),
    ["campus_not_located"],
    "and a college where NONE of them is located refuses, loudly",
  );
});

test("a single campus may still be passed on its own", () => {
  // The caller passes one when the class has a room and the room has a campus. Kept
  // working rather than forcing every caller to wrap it, because a caller that forgets is
  // a silent `campus_not_located` refusing a whole building.
  const settings = { geofenceCheck: true, geofenceRadiusM: 200 };
  assert.equal(checkPresence({ position: NEARBY, campuses: CAMPUS, settings }).ok, true);
  assert.deepEqual(reasons(checkPresence({ position: FAR, campuses: CAMPUS, settings })), ["off_campus"]);
});

/* --------------------- what the settings screen shows -------------------- */

test("an administrator is shown the address we ACTUALLY see them at", () => {
  // The single most likely way this feature fails at a real college: somebody types the
  // address off a router label, or the one their provider told them years ago, and it is
  // not what their traffic leaves from. Every student is refused and the screen says the
  // network is configured.
  assert.deepEqual(describeAddress("::ffff:203.0.113.9"), { ip: "203.0.113.9", family: "ipv4", allowlistable: true });
  assert.deepEqual(describeAddress("203.0.113.9:443"), { ip: "203.0.113.9", family: "ipv4", allowlistable: true });
});

test("AN IPv6 COLLEGE IS TOLD SO, rather than typing a range that can never match", () => {
  // The ranges are IPv4-only by design. A college whose egress is IPv6 cannot use this
  // feature at all, and must find that out on the settings screen — not from a hall of
  // students who cannot check in.
  const seen = describeAddress("2001:db8::1");
  assert.equal(seen.family, "ipv6");
  assert.equal(seen.allowlistable, false, "and the screen must not offer to add it");
});

test("no address at all is not reported as a usable one", () => {
  for (const v of [undefined, null, "", 42]) {
    assert.deepEqual(describeAddress(v), { ip: null, family: null, allowlistable: false });
  }
});
