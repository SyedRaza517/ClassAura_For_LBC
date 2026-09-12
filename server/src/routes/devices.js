// Push-notification device registration.
//
// The app registers its FCM token after sign-in and unregisters on sign-out, so a
// shared or handed-on phone never keeps delivering someone else's notifications.
//
// TWO AUDIENCES SHARE THIS ROUTER — staff and students. requireAuth attaches
// req.user.kind ("staff" or "student"; see auth.js), and that single field is what
// every handler below branches on to decide which owner column a row belongs under.
// Applicants never reach here: APPLICANT_ROUTERS in auth.js does not name
// "/api/devices", so an applicant token is rejected before any handler runs.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth } = require("../auth");
const { isString } = require("../validate");

const PLATFORMS = ["ios", "android", "web"];

// Exactly one of staffId/studentId on every DeviceToken row (Task 1's CHECK
// constraint enforces it at the database), decided HERE from req.user.kind so the
// CHECK exists as a backstop and never actually has to fire on a row this route
// writes. staffId/studentId are always BOTH named — the one that doesn't apply set
// explicitly to null — so an update can never leave a stale owner from a previous
// request half-written on the row.
const ownerFieldsFor = (user) => (user.kind === "student"
  ? { studentId: user.id, staffId: null }
  : { staffId: user.id, studentId: null });

// POST /api/devices — register (or re-confirm) this device for the caller.
router.post("/", requireAuth, async (req, res) => {
  const { token, platform } = req.body || {};
  if (!isString(token) || token.trim().length < 10) return res.status(400).json({ error: "A device token is required" });
  if (platform != null && !isString(platform)) return res.status(400).json({ error: "platform must be text" });
  const plat = PLATFORMS.includes(String(platform)) ? String(platform) : "unknown";

  // Upsert on the token, not on (owner, token): if this handset was previously
  // signed in as somebody else — a different member of staff, or a staff member
  // whose token was on this table before this task and is now signing in through
  // the student app on the same phone — the row must MOVE to the current user
  // rather than leaving the previous account subscribed to a phone they no longer
  // hold. token is unique per INSTITUTION now, not globally — someone employed at
  // two colleges (the case tenancy exists to support) registered the same handset
  // at the first and then collided at the second. findFirst + create/update because
  // { token } alone is no longer a unique selector.
  const t = token.trim();
  const existing = await prisma.deviceToken.findFirst({ where: { token: t } });
  const ownerFields = ownerFieldsFor(req.user);
  const device = existing
    ? await prisma.deviceToken.update({
        where: { id: existing.id },
        data: { ...ownerFields, platform: plat, lastSeenAt: new Date() },
      })
    : await prisma.deviceToken.create({ data: { token: t, ...ownerFields, platform: plat } });
  res.status(201).json({ ok: true, id: device.id, platform: device.platform });
});

// DELETE /api/devices — stop notifying this device. Called on sign-out.
router.delete("/", requireAuth, async (req, res) => {
  const { token } = req.body || {};
  if (!isString(token)) return res.status(400).json({ error: "A device token is required" });
  // Scoped to the caller, so one user cannot unregister another user's device —
  // whichever owner column applies to them, per ownerFieldsFor.
  const r = await prisma.deviceToken.deleteMany({ where: { token: token.trim(), ...ownerFieldsFor(req.user) } });
  res.json({ ok: true, removed: r.count });
});

// GET /api/devices — the caller's own registered devices (never the raw tokens).
router.get("/", requireAuth, async (req, res) => {
  const rows = await prisma.deviceToken.findMany({ where: ownerFieldsFor(req.user), orderBy: { lastSeenAt: "desc" } });
  res.json(rows.map((d) => ({ id: d.id, platform: d.platform, registeredAt: d.createdAt, lastSeenAt: d.lastSeenAt })));
});

module.exports = router;
