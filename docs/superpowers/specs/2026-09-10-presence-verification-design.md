# Proving the phone is in the building — design

**Date:** 10 September 2026
**Source:** six pages of handwritten notes, transcribed 10 Sep 2026 (WiFi, geofencing,
device ID, beacon, override lock, QR rotation period).

## What this is

Today a college has four ways to fill a register: a lecturer marks it, a student taps an
NFC sticker, a student scans a rotating code, or a student presses "I'm here". The first
is an observation by a member of staff. The other three are made by the person whose
attendance is being recorded, and the only thing standing behind them is *possession of a
phone that is logged in*.

This design adds the layers the notes ask for — the college network, a campus boundary,
and device identity — and one rule about who may overwrite a mark. It also corrects two
things the notes record as already built.

## What is NOT true today, despite the notes saying so

The notes bracket "connected with wifi of institute" and "geofencing → device should be in
range" with *"Need to test — already implemented."* Neither exists. There is no network
check and no location check anywhere in the codebase. Written down here because a plan
built on that belief would have tested two features that were never there and reported
them working.

## Three constraints that change the shape of the thing

**GPS cannot tell one room from another.** Indoor accuracy is 10–50 metres and worse
through concrete. A geofence proves *on campus*; it can never prove *in room B204*. Room
resolution is exactly what the £1 stickers and the beacons are for, and the geofence must
not be described to a college as doing more than it does.

**A browser cannot read the WiFi network's name.** iOS exposes no SSID to web code at all;
Android only behind a location permission. What is portable, permissionless and already in
front of us on every request is the *other* end of the connection: the college's public IP
address. "Connected to college WiFi" is therefore implemented as "this request reached the
server from the college's own network", which is the same fact observed from the far side,
and works identically on an iPhone, an Android and a laptop in a computer room.

**A device identifier in a browser is a deterrent, not a lock.** Clearing site data mints a
new one. In the installed Capacitor app it is considerably stronger. This catches casual
proxying and will not stop somebody determined, and the settings screen must say so rather
than let an administrator believe otherwise.

None of the three is proof. Each narrows the gap. That framing is load-bearing: a college
presenting this at a funding audit needs to describe what it actually knows.

## Decisions taken

**Presence checks apply to all three student-made methods, "I'm here" included.** The
original reason for exempting it — that it was the route for online and blended teaching —
is void: online attendance will come from Teams/Zoom (a separate subsystem, not in scope
here). Gating it *improves* it. It stops meaning "the student's word for it, from
anywhere" and starts meaning **"on campus, on the college network, but no sticker or code
was available"**, which is a defensible mark. Its wording changes everywhere to match,
because "Said they were here" would then understate what the system knows.

**A failed check refuses the mark.** Recording it flagged was rejected: a flagged mark
still counts in the attendance figure and in a funding claim, so the rule would have no
teeth until somebody reviewed the flags, and nobody reviews flags.

**Device policy: flag when two student accounts check in from ONE device — never block a
student for changing phone.** Blocking the second device was rejected because every lost,
broken, replaced or borrowed phone becomes a support ticket in the middle of a lecture,
and the friction lands on innocent students. The signal actually described in the notes —
"no other student should be able to log in with another student's credentials and mark
them present" — is not a login event at all. It is *two different students checking in
from the same device*, which is precisely what a proxy looks like from the server, and it
is recorded and surfaced rather than guessed at.

## The phases

Each ships behind its own switch, defaulting off, and each is proved by smoke assertions
that show what it **refuses**.

### Phase 1 — the module that decides

One pure module, `server/src/presence.js`, answering: given this request's IP, this
reported position, and this college's settings, is the device plausibly in the building?
Plus its settings fields and their validation. Nothing user-visible ships.

It exists as its own phase for one reason. Six handlers in this codebase independently
answered "who is on this register", disagreed, and the disagreement was a real defect
fixed six separate times. Three routes are about to need the same presence answer. They
get one place to ask.

### Phase 2 — the college network

An administrator enters the college's public IP ranges (CIDR) in Attendance → Settings.
The server compares the request's origin address, honouring the proxy hop that Render puts
in front of it. Refusal reason distinct from every other refusal, so a student is told the
thing they can act on.

### Phase 3 — the campus geofence

Coordinates and a radius per campus. The phone sends its position and the server computes
the distance. **Never** the phone reporting a boolean "I am in range" — that is a value
anybody can send. A position whose own accuracy figure is worse than the radius is refused
rather than accepted, because a 2 km error circle that happens to contain the campus is
not evidence.

### Phase 4 — device identity

A stable identifier minted client-side, stored per install, sent with every check-in.
Recorded against the student. What is surfaced to staff is the collision: two students,
one device, one class.

### Phase 5 — the override lock

*"Once marked, cannot be overridden unless the lecturer does it from the dashboard."*
Half-true today — a student cannot overwrite a lecturer's mark, and a lecturer can
overwrite anything. What needs auditing is whether a student's own mark is sealed against
a second self check-in arriving by a different route.

### Phase 6 — QR at 20 seconds, with a rotation grace

The notes ask for 20s (the default is 30s). Plus: the previous code stays valid for a few
seconds after it rotates, so a phone that began focusing at 19.5s is not refused for a
reason no student could understand. This is the reading of "while doing QR code again".

### Phase 7 — beacon

Bluetooth, needing the installed app, a Capacitor BLE plugin and hardware nobody has
bought. Last, and honestly so.

### Parked — Teams/Zoom ingestion

Online lessons take their attendance from the meeting platform. Its own subsystem, its own
spec, not folded in here.
