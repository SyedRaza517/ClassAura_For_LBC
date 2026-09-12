// Helpers to create persisted notifications, and deliver them to the recipient by
// email and push. Every channel is best-effort: a delivery problem must never break
// the primary action (approving leave, deleting an account).
const prisma = require("./db");
const { sendEmail } = require("./email");
const { sendPush } = require("./push");

// The push title used to be the literal "Staff Hub", for every recipient and every
// notification type — including student pushes, once DeviceToken grew a studentId
// and a student push became possible: a student would have unlocked their phone to
// a notification titled after a product they have never seen the name of. It is now
// the college's own display name, resolved through the SAME source GET /api/branding
// serves to the (unauthenticated) sign-in screen — because a push's lock-screen
// title is as much the college's public identity as its sign-in page is, and the two
// must not say different names for the same college.
//
// PURE, and tested as such (notify.test.js): given a resolved brand name and an
// audience, pick the title. The two audiences get different neutral fallbacks for
// when the college has configured no branding at all — "Staff Hub" for staff, which
// is the literal this replaces, so an unbranded college's staff pushes read exactly
// as they did before this change; "ClassAura" for students, the student app's own
// name, never the staff product's, because a college that has branded nothing must
// not title a student's push after a screen the student has never opened.
function titleFor(displayName, audience) {
  return displayName || (audience === "student" ? "ClassAura" : "Staff Hub");
}

// Deliver one notification to every device the staff member has registered.
// Tokens that FCM reports as dead are removed, so the table doesn't accumulate
// installs that were deleted months ago.
async function pushToDevices(staffId, { type, message, link }) {
  const devices = await prisma.deviceToken.findMany({ where: { staffId } });
  if (!devices.length) return;
  const brand = await require("./branding").get();
  const title = titleFor(brand.displayName, "staff");
  await Promise.all(devices.map(async (d) => {
    const res = await sendPush(d.token, {
      title,
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

// Deliver one notification to every device a STUDENT has registered. Mirrors
// pushToDevices above exactly — same dead-token cleanup, same best-effort shape —
// with the two differences isolation requires: it reads DeviceToken.studentId
// rather than .staffId (routes/devices.js is what guarantees a row has one or the
// other, never both — see the exactly-one-owner comment there), and its title falls
// back to "ClassAura" rather than "Staff Hub" when the college has configured no
// branding, via the same titleFor() the staff path uses.
async function pushToStudentDevices(studentId, { type, message, link }) {
  const devices = await prisma.deviceToken.findMany({ where: { studentId } });
  if (!devices.length) return;
  const brand = await require("./branding").get();
  const title = titleFor(brand.displayName, "student");
  await Promise.all(devices.map(async (d) => {
    const res = await sendPush(d.token, {
      title,
      body: message,
      data: { link: link || "home", type: type || "info" },
    });
    if (res.invalidToken) {
      await prisma.deviceToken.delete({ where: { id: d.id } }).catch(() => {});
      console.log(`[push] removed a dead device token for student ${studentId}`);
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

// Notify a single student. Mirrors notifyStaff's shape and failure handling exactly:
// the Notification row is created first (so a student always sees it in-app even if
// push fails entirely), then delivery is attempted; any problem anywhere in here is
// swallowed rather than thrown into whatever request triggered it — a tap check-in,
// a referral reply, an admin's reply to a student query — none of which should ever
// fail because a push provider is down.
//
// data.studentId is the ONLY owner field set (never staffId): the exactly-one-owner
// rule the Notification CHECK constraint enforces (Task 1) is satisfied HERE, first,
// so the CHECK exists as a backstop and never actually has to fire on a row this
// function writes.
//
// No email leg, unlike notifyStaff. A student has no college-issued inbox the way
// staff do — Student carries a personal email for password resets, not a mailing
// address the college is expected to write to — and nothing else in this codebase
// sends student mail today. In-app + push is the channel; an email leg can be added
// the same way notifyStaff's was if that ever changes, without touching this shape.
async function notifyStudent(studentId, { type = "info", message, link = null } = {}) {
  if (!studentId || !message) return null;
  try {
    const n = await prisma.notification.create({ data: { studentId, type, message, link } });
    await pushToStudentDevices(studentId, { type, message, link });
    return n;
  } catch (e) {
    console.error("notifyStudent failed:", e.message);
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

module.exports = { notifyStaff, notifyStudent, notifyAdmins, titleFor };
