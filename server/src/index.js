require("dotenv").config();
const express = require("express");
const cors = require("cors");
const compression = require("compression");

const app = express();
// Gzip JSON responses. The large admin lists (1000+ students, attendance) shrink
// ~80-90% on the wire, which is the biggest single win on slow mobile connections.
app.use(compression());
// No ETags on API responses — combined with Cache-Control: no-store this removes
// any conditional-request/304 path, so clients always get fresh JSON.
app.set("etag", false);

// --- Security headers on every response (lightweight, no dependency) ---
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");   // don't MIME-sniff responses
  res.setHeader("X-Frame-Options", "DENY");             // no embedding in an iframe (clickjacking)
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  // API responses are never cached by shared caches.
  res.setHeader("Cache-Control", "no-store");
  next();
});

// Behind Render (and any reverse proxy) the socket address is the proxy's, so every
// caller shares one req.ip. The login limiter keys on IP + email, which then collapsed
// to email alone: eight wrong guesses could lock a real person out, and spraying one
// guess across many accounts was never limited at all. Trusting the first proxy hop
// restores the caller's own address from X-Forwarded-For.
app.set("trust proxy", 1);

// --- CORS restricted to the configured client origin(s) ---
// Only these browser origins may call the API. Requests with no Origin header
// (curl, health checks, native mobile) are allowed; a browser page on any other
// site is refused. Configure via CORS_ORIGINS (falls back to CLIENT_URL).
const allowedOrigins = (process.env.CORS_ORIGINS || process.env.CLIENT_URL || "http://localhost:5173")
  .split(",").map((s) => s.trim()).filter(Boolean);
// The native apps ALWAYS get CORS, regardless of CORS_ORIGINS. Capacitor sends an
// Origin header from the WebView — iOS as capacitor://localhost, Android (with
// androidScheme:"https") as https://localhost. Without this, iOS in particular is
// blocked from every API call while Android happens to work. These are app-scheme
// origins, not real websites, so allowing them is safe.
const isNativeOrigin = (o) => /^(capacitor|ionic):\/\/localhost$/.test(o) || o === "https://localhost" || o === "http://localhost";
app.use(cors({
  origin(origin, cb) {
    // Grant CORS headers only to allowed origins. A disallowed browser origin
    // simply receives no CORS headers and is blocked by the browser — we don't
    // error the request (that would just spam 500s and log noise).
    cb(null, !origin || allowedOrigins.includes(origin) || isNativeOrigin(origin));
  },
}));

// Cap request bodies so a giant payload can't exhaust memory.
// 1mb is right for ordinary API traffic. Uploaded documents — a college's letterhead
// PDF, a logo — arrive as base64 on two specific routes and would exceed it, so those
// get their own larger cap rather than raising it for every endpoint.
app.use("/api/doc-templates", express.json({ limit: "8mb" }));
app.use("/api/branding", express.json({ limit: "2mb" }));
app.use(express.json({ limit: "1mb" }));

// Health check
app.get("/api/health", (_req, res) => res.json(require("./health").healthPayload()));

// wrapAsync makes a rejected promise inside an async handler reach the error
// middleware below instead of terminating the process — see asyncRoutes.js.
const { wrapAsync } = require("./asyncRoutes");
// A wrapAsyncMw lived here, giving an async MIDDLEWARE the same protection. Its only
// user was the tenant middleware, and it went with it — there is no async middleware
// left. Bring it back if one appears; an async middleware that rejects becomes an
// unhandled rejection rather than a 500.
// MOUNT ORDER USED TO CARRY MEANING HERE, AND NO LONGER DOES.
//
// Two routers were mounted above everything else — /api/platform, the supplier's
// operator tier, and /api/registrations, a college applying to join — because
// neither caller was yet an institution and the tenant middleware below would have
// had nothing to resolve them to. That middleware then ran BEFORE authentication,
// because Staff.email was unique per institution and a login could not find an
// account from an email address alone.
//
// One deployment now serves one college. There is no operator tier above it, no
// registration queue, and no institution to resolve: the server IS the college. So
// the ordering constraint is gone and these mounts are ordinary. Anything reading
// like a deliberate sequence below is about authentication, not tenancy.

// Routes.
app.use("/api/auth", wrapAsync(require("./routes/auth")));
app.use("/api/signup", wrapAsync(require("./routes/signup")));
app.use("/api/staff", wrapAsync(require("./routes/staff")));
app.use("/api/checkins", wrapAsync(require("./routes/checkins")));
app.use("/api/leave", wrapAsync(require("./routes/leave")));
app.use("/api/documents", wrapAsync(require("./routes/documents")));
app.use("/api/adjustments", wrapAsync(require("./routes/adjustments")));
app.use("/api/notifications", wrapAsync(require("./routes/notifications")));
app.use("/api/devices", wrapAsync(require("./routes/devices")));
app.use("/api/hnd", wrapAsync(require("./routes/hnd")));
app.use("/api/tags", wrapAsync(require("./routes/tags")));
app.use("/api/interactions", wrapAsync(require("./routes/interactions")));
app.use("/api/assessments", wrapAsync(require("./routes/assessments")));
app.use("/api/assessment-tracker", wrapAsync(require("./routes/assessmentTracker")));
app.use("/api/prediction", wrapAsync(require("./routes/prediction")));
app.use("/api/mitigations", wrapAsync(require("./routes/mitigations")));
app.use("/api/timesheets", wrapAsync(require("./routes/timesheets")));
app.use("/api/student", wrapAsync(require("./routes/student")));
app.use("/api/student-queries", wrapAsync(require("./routes/studentQueries")));
app.use("/api/moodle", wrapAsync(require("./routes/moodle")));
app.use("/api/canvas", wrapAsync(require("./routes/canvas")));
app.use("/api/staff-reviews", wrapAsync(require("./routes/staffReviews")));
app.use("/api/passwords", wrapAsync(require("./routes/passwords")));
app.use("/api/my-reviews", wrapAsync(require("./routes/myReviews")));
app.use("/api/student-reviews", wrapAsync(require("./routes/studentReviews")));
// The CELCAT-style timetabling module. Two routers, deliberately split by who
// reads them: /api/timetabling is the planner and is gated on the "scheduling"
// admin page; /api/my-timetable is what every lecturer reads and carries no page
// gate at all, because gating it would mean granting an admin page to the whole
// teaching staff.
app.use("/api/timetabling", wrapAsync(require("./routes/timetabling")));
app.use("/api/my-timetable", wrapAsync(require("./routes/myTimetable")));
// Handing a student to Wellbeing, ASK or Student Support. One grantable page opens
// the feature; Staff.supportDepartments decides which queues within it a person sees,
// because the department list is configuration the college edits at runtime and a
// permission key cannot be minted into four source files at four in the afternoon.
app.use("/api/referrals", wrapAsync(require("./routes/referrals")));
// Identity-gated, no page: a lecturer announcing to a unit that names them. See the
// header of the file for why that is the whole v1 audience.
app.use("/api/announcements", wrapAsync(require("./routes/announcements")));
app.use("/api/admissions", wrapAsync(require("./routes/admissions")));
app.use("/api/admission-config", wrapAsync(require("./routes/admissionConfig")));
app.use("/api/admission-stats", wrapAsync(require("./routes/admissionStats")));
app.use("/api/admission-pdf", wrapAsync(require("./routes/admissionPdf")));
app.use("/api/attendance-emails", wrapAsync(require("./routes/attendanceEmails")));
app.use("/api/slc", wrapAsync(require("./routes/slc")));
app.use("/api/admission-uploads", wrapAsync(require("./routes/admissionsUpload")));
app.use("/api/admission-offers", wrapAsync(require("./routes/admissionOffer")));
app.use("/api/admission-apply", wrapAsync(require("./routes/admissionApply")));
app.use("/api/applicant", wrapAsync(require("./routes/applicant")));
app.use("/api/ism", wrapAsync(require("./routes/ism")));
// This institution's own Moodle / SharePoint credentials.
app.use("/api/integrations", wrapAsync(require("./routes/integrations")));
// The Teams attendance switch, threshold, manual sync and run history. Gated on
// "attendance-settings" — the same page as the NFC/QR/geofence controls beside it on
// AdminNfcTags.jsx, NOT the generic "settings" page (that gates the Teams *credentials*
// instead, on the separate /integrations/teams routes). See the router's own header
// comment in routes/teamsAttendance.js for why the split is deliberate rather than an
// oversight: "settings" would let someone connect the college's Microsoft tenant
// without being able to touch the switch this router guards, or vice versa.
app.use("/api/teams-attendance", wrapAsync(require("./routes/teamsAttendance")));
// The two Teams automation switches (auto-create meetings, provision class Teams),
// their manual "Run now" and their shared run history. Same "attendance-settings" gate
// as the mount above, for the same reason — see routes/teamsAutomation.js's own header
// comment.
app.use("/api/teams-automation", wrapAsync(require("./routes/teamsAutomation")));
// This institution's own name, colours and logo. GET is deliberately public — the
// sign-in screen must be branded before anyone has signed in — and the router
// enforces that split with an allowlist rather than trusting each handler.
app.use("/api/branding", wrapAsync(require("./routes/branding")));
// The college's academic departments -- Business, Computing, Law -- and who may see
// them. Gated on the existing "settings" page rather than a new ADMIN_PAGES key.
app.use("/api/academic-departments", wrapAsync(require("./routes/academicDepartments")));
// Mapping the VLE's own course grouping (Moodle category, Canvas sub-account) onto an
// academic department -- captured by the sync, mapped once by hand, never guessed.
app.use("/api/vle-department-mapping", wrapAsync(require("./routes/vleDepartmentMapping")));
// A college's own offer-letter / application-form PDFs. Their document is used AS the
// page and the applicant's details written on it — never redrawn. See docTemplate.js.
app.use("/api/doc-templates", wrapAsync(require("./routes/docTemplates")));
// A college's own wording for the emails we send on its behalf.
app.use("/api/email-templates", wrapAsync(require("./routes/emailTemplates")));
// Read-only. Who did what, scoped to the caller's own institution.
app.use("/api/audit", wrapAsync(require("./routes/audit")));

// 404 + error handlers
app.use((_req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, _req, res, _next) => {
  // Body-parser failures are the CALLER's fault, not ours. Reporting them as 500
  // both misleads the client and buries genuine server faults in the log.
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Request body is not valid JSON" });
  }
  if (err && (err.type === "entity.too.large" || err.status === 413)) {
    return res.status(413).json({ error: "Request body is too large" });
  }
  // Anything else with an explicit 4xx status is likewise a client error.
  if (err && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.expose ? err.message : "Bad request" });
  }
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
  // Say plainly how mail and push are configured — otherwise a stubbed deployment
  // looks healthy right up until someone waits for a password-reset email or a
  // notification that never arrives.
  console.log(`Email: ${require("./email").describeEmail()}`);
  console.log(`Push:  ${require("./push").describePush()}`);
  console.log(`Files: ${require("./storage").describeStorage()}`);
  console.log(`SharePoint: ${require("./sharepoint").describe()}`);
  console.log(`Check-in codes: ${require("./secrets").describeCheckInCodes()}`);
  // Which Postgres address, and whether it is the right kind. A Supabase transaction
  // pooler URL breaks queries and hangs migrations; this makes it visible in the first
  // screen of the log rather than at the first scan of the first lecture.
  console.log(`Database: ${require("./databaseUrl").describeDatabaseUrl(process.env.DATABASE_URL)}`);
  startKeepAlive();
  require("./scheduler").startScheduler();
  require("./attendanceScheduler").start();
  require("./notificationsScheduler").start();
});

// --- Keep-alive: stop the free-tier host idling the server to sleep ---
// Render's free tier spins a service down after ~15 min with no inbound traffic;
// the next request then pays a 30-50s cold-start wake-up, which users feel as
// "the app is slow". Pinging our own public health endpoint on an interval keeps
// that inbound traffic flowing so the instance stays warm and responses stay fast.
// Only runs when a public URL is known (Render sets RENDER_EXTERNAL_URL) — it does
// nothing in local dev. Override the URL with KEEPALIVE_URL if needed; set
// KEEPALIVE_URL=off to disable entirely.
function startKeepAlive() {
  const url = process.env.KEEPALIVE_URL || (process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "")}/api/health` : null);
  if (!url || url === "off") return;
  const MINUTES = Number(process.env.KEEPALIVE_MINUTES) || 12; // < Render's 15-min idle window
  console.log(`Keep-alive: pinging ${url} every ${MINUTES} min to prevent cold starts`);
  setInterval(() => {
    fetch(url).catch(() => {}); // best-effort; a failed ping just means we try again next cycle
  }, MINUTES * 60 * 1000).unref(); // unref so the timer never keeps the process alive on its own
}
