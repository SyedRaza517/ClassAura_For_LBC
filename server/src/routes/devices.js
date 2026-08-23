// Push-notification device registration.
//
// The app registers its FCM token after sign-in and unregisters on sign-out, so a
// shared or handed-on phone never keeps delivering someone else's notifications.
const router = require("express").Router();
const prisma = require("../db");
const { requireAuth } = require("../auth");
const { isString } = require("../validate");

const PLATFORMS = ["ios", "android", "web"];

// POST /api/devices — register (or re-confirm) this device for the caller.
router.post("/", requireAuth, async (req, res) => {
  const { token, platform } = req.body || {};
  if (!isString(token) || token.trim().length < 10) return res.status(400).json({ error: "A device token is required" });
  if (platform != null && !isString(platform)) return res.status(400).json({ error: "platform must be text" });
  const plat = PLATFORMS.includes(String(platform)) ? String(platform) : "unknown";

  // Upsert on the token, not on (staff, token): if this handset was previously
  // signed in as somebody else, the row must MOVE to the current user rather than
  // leaving the previous account subscribed to a phone they no longer hold.
  // token is unique per INSTITUTION now, not globally — someone employed at two
  // colleges (the case tenancy exists to support) registered the same handset at the
  // first and then collided at the second. findFirst + create/update because
  // { token } alone is no longer a unique selector.
  const t = token.trim();
  const existing = await prisma.deviceToken.findFirst({ where: { token: t } });
  const device = existing
    ? await prisma.deviceToken.update({
        where: { id: existing.id },
        data: { staffId: req.user.id, platform: plat, lastSeenAt: new Date() },
      })
    : await prisma.deviceToken.create({ data: { token: t, staffId: req.user.id, platform: plat } });
  res.status(201).json({ ok: true, id: device.id, platform: device.platform });
});

// DELETE /api/devices — stop notifying this device. Called on sign-out.
router.delete("/", requireAuth, async (req, res) => {
  const { token } = req.body || {};
  if (!isString(token)) return res.status(400).json({ error: "A device token is required" });
  // Scoped to the caller, so one user cannot unregister another user's device.
  const r = await prisma.deviceToken.deleteMany({ where: { token: token.trim(), staffId: req.user.id } });
  res.json({ ok: true, removed: r.count });
});

// GET /api/devices — the caller's own registered devices (never the raw tokens).
router.get("/", requireAuth, async (req, res) => {
  const rows = await prisma.deviceToken.findMany({ where: { staffId: req.user.id }, orderBy: { lastSeenAt: "desc" } });
  res.json(rows.map((d) => ({ id: d.id, platform: d.platform, registeredAt: d.createdAt, lastSeenAt: d.lastSeenAt })));
});

module.exports = router;
