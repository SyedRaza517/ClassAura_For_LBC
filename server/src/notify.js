// Helpers to create persisted notifications, and deliver them to the recipient by
// email and push. Every channel is best-effort: a delivery problem must never break
// the primary action (approving leave, deleting an account).
const prisma = require("./db");
const { sendEmail } = require("./email");
const { sendPush } = require("./push");

// Short titles for the phone's lock screen — the full sentence goes in the body.
const TITLES = {
  success: "Staff Hub",
  error: "Staff Hub",
  info: "Staff Hub",
};

// Deliver one notification to every device the staff member has registered.
// Tokens that FCM reports as dead are removed, so the table doesn't accumulate
// installs that were deleted months ago.
async function pushToDevices(staffId, { type, message, link }) {
  const devices = await prisma.deviceToken.findMany({ where: { staffId } });
  if (!devices.length) return;
  await Promise.all(devices.map(async (d) => {
    const res = await sendPush(d.token, {
      title: TITLES[type] || "Staff Hub",
      body: message,
      // The app reads `link` to open the right screen when the notification is tapped.
      data: { link: link || "home", type: type || "info" },
    });
    if (res.invalidToken) {
      await prisma.deviceToken.delete({ where: { id: d.id } }).catch(() => {});
      console.log(`[push] removed a dead device token for staff ${staffId}`);
    }
  }));
}

// Notify a single staff member. Failures are swallowed so a notification problem
// never breaks the primary action (e.g. approving leave).
async function notifyStaff(staffId, { type = "info", message, link = null } = {}) {
  if (!staffId || !message) return null;
  try {
    const n = await prisma.notification.create({ data: { staffId, type, message, link } });
    const staff = await prisma.staff.findUnique({ where: { id: staffId } });
    if (staff?.email) {
      // The subject names the college, not the platform's first customer. A college
      // that has not set a display name gets the bare product name — a staff member
      // seeing "Staff Hub" in their inbox is right; seeing another college is not.
      const brand = await require("./branding").get();
      const subject = brand.displayName ? `${brand.displayName} — Staff Hub` : "Staff Hub";
      await sendEmail(staff.email, subject, message);
    }
    await pushToDevices(staffId, { type, message, link });
    return n;
  } catch (e) {
    console.error("notifyStaff failed:", e.message);
    return null;
  }
}

// Notify every admin (e.g. when a new leave request arrives). Best-effort.
async function notifyAdmins({ type = "info", message, link = null } = {}) {
  if (!message) return;
  try {
    const admins = await prisma.staff.findMany({ where: { accountRole: "ADMIN" } });
    await Promise.all(admins.map((a) => notifyStaff(a.id, { type, message, link })));
  } catch (e) {
    console.error("notifyAdmins failed:", e.message);
  }
}

module.exports = { notifyStaff, notifyAdmins };
