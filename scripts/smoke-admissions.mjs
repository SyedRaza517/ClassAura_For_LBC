// Admissions — the application pipeline, from the public form to the enrolment decision.
//
// This is the part of the product that holds the most dangerous data in it. One
// Admission row carries a date of birth, an NI number, passport/ID document numbers,
// a criminal-conviction declaration, medical conditions, a learning-difficulty
// declaration, ethnicity and religion — special-category data about a person who is not
// even a student yet. Three of the six routers that touch it are PUBLIC: the apply
// form, the document-upload link and the offer-acceptance link, each authenticated by
// nothing but a secret in an email.
//
// So the assertions here are almost all negative. They are about who is refused, what
// never leaves the building, and which decisions cannot be made twice — not about which
// endpoints answer 200.
//
//   node scripts/smoke-admissions.mjs
//   (needs API_URL + DATABASE_URL; the runner supplies both)
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));

// API_URL, not API_BASE — the runner sets API_URL and only smoke-branding reads the
// other name. Copying branding's shape onto a different port makes a suite that talks
// to nothing and passes anyway.
const BASE = process.env.API_URL || "http://localhost:4000/api";
const SEED_PASSWORD = process.env.SEED_PASSWORD || "test-seed-password-2026";
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required — point it at a throwaway database.");
  process.exit(1);
}

const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));
// A BARE client, deliberately. It is not the client the API writes through, so this suite can
// (a) plant the hashed halves of the emailed magic links without going anywhere near
// the email-sending routes, and (b) look at the columns the serializer is supposed to
// be keeping OUT of every response — you cannot prove a password hash never shipped by
// reading the API's own answer.
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function call(path, { method = "GET", body, token, raw, contentType } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (raw !== undefined) headers["Content-Type"] = contentType || "application/octet-stream";
  else if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined),
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* not JSON — a PDF, or an empty body */ }
  return { status: res.status, data, res };
}

const login = async (email) => {
  const r = await call("/auth/login", { method: "POST", body: { email, password: SEED_PASSWORD } });
  if (r.status !== 200 || !r.data?.token) throw new Error(`could not sign in as ${email}: HTTP ${r.status}`);
  return r.data.token;
};

// The same hash the routers use — SHA-256 of the raw token. Only the hash is stored, so
// planting one here is exactly what "the applicant clicked the link in the email" looks
// like from the database's side, without sending a single message.
const hashToken = (raw) => createHash("sha256").update(String(raw)).digest("hex");

// Unique per run, so a crashed run cannot poison the next one.
const RUN = Date.now().toString(36);
// Nothing here is ever emailed (every send path in this suite stops at a guard first),
// but the domain is a reserved-invalid one anyway, so a regression that DOES send has
// nowhere to send it.
const MAIL = (tag) => `adm-${tag}-${RUN}@smoke.invalid`;

const madeAdmissions = new Set();
const madeCourses = new Set();
const madeIntakes = new Set();

async function cleanup() {
  // Deleting the Admission cascades to AdmissionDocument, so the uploaded-document rows
  // go with it. The catch-all by email is the safety net for a row this suite created
  // but never learned the id of. Eight suites share one seeded database in one run and
  // the seed is not re-run between them.
  if (madeAdmissions.size) await db.admission.deleteMany({ where: { id: { in: [...madeAdmissions] } } });
  await db.admission.deleteMany({ where: { email: { contains: RUN } } });
  if (madeCourses.size) await db.admissionCourse.deleteMany({ where: { id: { in: [...madeCourses] } } });
  if (madeIntakes.size) await db.admissionIntake.deleteMany({ where: { id: { in: [...madeIntakes] } } });
}

try {
  const adminToken = await login("admin@edtech.co.uk");
  const staffToken = await login("j.whitfield@edtech.co.uk"); // STAFF, not ADMIN

  // ------------------------------------------------------------------------
  console.log("\n--- who may see an application at all ---");
  // Every staff-facing router below is gated on the "admissions" admin page. A teacher
  // who can take a class register must not be able to read a prospective student's
  // criminal-record declaration or NI number, and an applicant must not be able to read
  // anybody's but their own.

  const anon = await call("/admissions");
  check("no token cannot list applications", anon.status === 401, `HTTP ${anon.status}`);

  const staffList = await call("/admissions", { token: staffToken });
  check("an ordinary teacher is refused the applicant list", staffList.status === 403, `HTTP ${staffList.status}`);

  const staffConfig = await call("/admission-config/courses", { token: staffToken });
  check("...and the course/intake configuration", staffConfig.status === 403, `HTTP ${staffConfig.status}`);

  const staffPdf = await call("/admission-pdf/whatever/application.pdf", { token: staffToken });
  check("...and the application-form PDF download", staffPdf.status === 403, `HTTP ${staffPdf.status}`);

  // An applicant portal account is a login that exists purely to fill in ONE form. If
  // its token reached a staff router it would read every other applicant's file.
  const reg = await call("/applicant/register", {
    method: "POST",
    body: {
      firstName: "Portal", surname: "Applicant", email: MAIL("portal"),
      password: "applicant-portal-2026", confirmPassword: "applicant-portal-2026",
    },
  });
  check("an applicant can self-register for the portal", reg.status === 201 && !!reg.data?.token, `HTTP ${reg.status}`);
  const applicantToken = reg.data?.token;
  if (reg.data?.user?.id) madeAdmissions.add(reg.data.user.id);

  const applicantReach = await call("/admissions", { token: applicantToken });
  check("an applicant token cannot reach the staff admissions router",
    applicantReach.status === 403 && /applicant accounts/i.test(applicantReach.data?.error || ""),
    `HTTP ${applicantReach.status} ${applicantReach.data?.error || ""}`);

  // ------------------------------------------------------------------------
  console.log("\n--- creating an application: what the body is allowed to say ---");

  const nameless = await call("/admissions", { method: "POST", token: adminToken, body: { course: "HND Business" } });
  check("an application with no name at all is refused", nameless.status === 400, `HTTP ${nameless.status}`);

  // Mass assignment. The create body is copied through pick(), an allowlist of the
  // form's own answers — so a caller cannot choose their own primary key, hand
  // themselves a place on the course, or write a password hash onto the row that the
  // applicant portal would then honour as a login.
  const smuggle = await call("/admissions", {
    method: "POST", token: adminToken,
    body: {
      firstName: "Mass", surname: "Assignment", email: MAIL("smuggle"),
      id: "chosen-by-the-caller",
      enrollStatus: "Enroll", offerStatus: "accepted", studentId: "999999",
      passwordHash: "$2a$10$notarealhashbutitisplentylongenough", tokenVersion: 99,
      // This was `tenantId: "some-other-college"` — half "you cannot file this
      // application against another college", which is gone with tenancy, and half "a key
      // pick() does not name is DROPPED rather than forwarded to Prisma". The second half
      // is the one that matters and is kept: a key that exists on no model stands in, and
      // the 201 asserted below is what proves it was dropped rather than passed through
      // (a forwarded unknown key makes Prisma throw, and the create 500s).
      notAColumnOnAnyModel: "x",
      medicalDetails: "z".repeat(6000),   // MAX_LEN is 5000
      city: "", phone: "   ",             // blank answers must store as null, not ""
    },
  });
  check("an application is created from a name alone", smuggle.status === 201 && !!smuggle.data?.id, `HTTP ${smuggle.status}`);
  const smuggleId = smuggle.data?.id;
  if (smuggleId) madeAdmissions.add(smuggleId);
  check("the caller cannot choose the row's id", smuggleId !== "chosen-by-the-caller", String(smuggleId));
  check("the caller cannot enrol themselves in the create body",
    smuggle.data?.enrollStatus == null && smuggle.data?.studentId == null && smuggle.data?.offerStatus == null,
    `enroll=${smuggle.data?.enrollStatus} studentId=${smuggle.data?.studentId} offer=${smuggle.data?.offerStatus}`);

  const smuggleRow = await db.admission.findUnique({ where: { id: smuggleId } });
  // A passwordHash written through this route would be a login nobody created, on a
  // record full of somebody else's personal data.
  check("no password hash can be written through the admin create form",
    smuggleRow?.passwordHash === null && smuggleRow?.tokenVersion === 0,
    `passwordHash=${smuggleRow?.passwordHash} ver=${smuggleRow?.tokenVersion}`);
  check("one giant paste is capped at 5000 characters", smuggleRow?.medicalDetails?.length === 5000, `${smuggleRow?.medicalDetails?.length} chars`);
  check("a blank answer is stored as no value, not an empty string",
    smuggleRow?.city === null && smuggleRow?.phone === null,
    `city=${JSON.stringify(smuggleRow?.city)} phone=${JSON.stringify(smuggleRow?.phone)}`);

  // ------------------------------------------------------------------------
  console.log("\n--- what an application is allowed to say back ---");
  // The serializer is an ALLOWLIST for a reason written at length in routes/admissions.js:
  // it used to be a denylist, and the applicant portal's bcrypt hash shipped to the admin
  // dashboard on every list call for as long as that lasted. Any column added to this
  // model in future must stay invisible until somebody opts it in on purpose.
  const list = await call("/admissions", { token: adminToken });
  check("an admin can list applications", list.status === 200 && Array.isArray(list.data), `HTTP ${list.status}`);
  const mine = (list.data || []).find((r) => r.id === smuggleId);
  // tenantId used to head this list — it is gone from the schema, so naming it would be
  // a clause that can never fire. The rest are live: two are magic-link hashes, and
  // spFolderId is a SharePoint location.
  const LEAKS = ["passwordHash", "uploadTokenHash", "offerTokenHash", "tokenVersion", "active", "spFolderId"];
  const leaked = LEAKS.filter((k) => mine && k in mine);
  check("no secret or internal column reaches the admin client", leaked.length === 0, leaked.join(", ") || "none");
  check("...while the fields the screen needs are still there",
    !!mine && "firstName" in mine && "course" in mine && "enrollStatus" in mine && "offerStatus" in mine);

  // ------------------------------------------------------------------------
  console.log("\n--- an application that does not exist ---");
  // Every one of these reaches Prisma with a caller-supplied id. A missing row has to
  // come back as a 404; a stack trace through wrapAsync is not an answer.
  const noSuch = "no-such-application-id";
  const missing = [
    ["status update", await call(`/admissions/${noSuch}/status`, { method: "PUT", token: adminToken, body: { enrollStatus: "Enroll" } })],
    ["delete", await call(`/admissions/${noSuch}`, { method: "DELETE", token: adminToken })],
    ["document request", await call(`/admissions/${noSuch}/request-documents`, { method: "POST", token: adminToken })],
    ["application PDF", await call(`/admission-pdf/${noSuch}/application.pdf`, { token: adminToken })],
    ["document confirm", await call(`/admissions/documents/${noSuch}/confirm`, { method: "PUT", token: adminToken, body: { confirmed: true } })],
  ];
  check("every route on a missing record is a clean 404",
    missing.every(([, r]) => r.status === 404),
    missing.map(([l, r]) => `${l}=${r.status}`).join(" "));

  // ------------------------------------------------------------------------
  console.log("\n--- an email flow must not half-run ---");
  // Each of these routes mints a token, writes a timestamp, or renames a SharePoint
  // folder BEFORE it sends. If a guard moved after the write, the record would claim a
  // link had been sent to an applicant who has no address to send it to — and an admin
  // reading "requested 3 days ago" would stop chasing them.
  const noEmail = smuggleId; // created above with an email; strip it
  await db.admission.update({ where: { id: noEmail }, data: { email: null } });

  const reqDocs = await call(`/admissions/${noEmail}/request-documents`, { method: "POST", token: adminToken });
  check("no upload link is minted for an applicant with no email", reqDocs.status === 400, `HTTP ${reqDocs.status}`);
  const afterReq = await db.admission.findUnique({ where: { id: noEmail } });
  check("...and nothing was written to the record",
    afterReq?.uploadTokenHash === null && afterReq?.docsRequestedAt === null);

  const offerNoMail = await call(`/admissions/${noEmail}/send-offer`, { method: "POST", token: adminToken, body: { inductionDate: "2026-09-15" } });
  check("no offer is sent to an applicant with no email", offerNoMail.status === 400, `HTTP ${offerNoMail.status}`);
  const afterOffer = await db.admission.findUnique({ where: { id: noEmail } });
  check("...and the offer is not recorded as sent", afterOffer?.offerStatus === null && afterOffer?.offerSentAt === null);

  // Give the address back, so the *date* guard is the one under test rather than the
  // email one that fires first.
  await db.admission.update({ where: { id: noEmail }, data: { email: MAIL("smuggle") } });
  const inviteNoDate = await call(`/admissions/${noEmail}/send-interview-invite`, { method: "POST", token: adminToken, body: { mode: "Online" } });
  check("an interview invitation with no date is refused", inviteNoDate.status === 400, `HTTP ${inviteNoDate.status}`);
  const afterInvite = await db.admission.findUnique({ where: { id: noEmail } });
  check("...and no invitation is recorded as sent", afterInvite?.interviewInviteSentAt === null);

  // ------------------------------------------------------------------------
  console.log("\n--- the enrolment decision ---");
  // Enrolling is the point where an applicant becomes a student. The congratulations
  // email fires only when the admin actually picked an induction date in the dialog —
  // an inline Student-ID edit, or a Reject, must never mail somebody "You're enrolled".
  const plainEnrol = await call(`/admissions/${noEmail}/status`, {
    method: "PUT", token: adminToken, body: { enrollStatus: "Enroll", studentId: "x".repeat(150) },
  });
  check("an enrol with no induction date succeeds", plainEnrol.status === 200, `HTTP ${plainEnrol.status}`);
  check("...without sending a congratulations email", plainEnrol.data?.emailed === false, String(plainEnrol.data?.emailed));
  const enrolled = await db.admission.findUnique({ where: { id: noEmail } });
  check("...and without inventing an induction date",
    enrolled?.enrolInductionDate === null && enrolled?.enrolEmailSentAt === null,
    `date=${enrolled?.enrolInductionDate}`);
  // A student ID is typed by hand into a free-text box that becomes a SharePoint folder
  // name ("<studentId> - <name>"); an unbounded one is a 5000-character folder waiting
  // to happen, and Graph rejects the whole enrolment when it arrives.
  check("a hand-typed student ID is capped at 100 characters", enrolled?.studentId?.length === 100, `${enrolled?.studentId?.length} chars`);

  const cleared = await call(`/admissions/${noEmail}/status`, { method: "PUT", token: adminToken, body: { studentId: "" } });
  check("clearing the student ID stores no value rather than an empty string",
    cleared.status === 200 && cleared.data?.studentId === null, JSON.stringify(cleared.data?.studentId));

  // ------------------------------------------------------------------------
  console.log("\n--- the PDF download ---");
  // The applicant's own name lands in a Content-Disposition header. Left unsanitised, a
  // name containing CRLF is HTTP response splitting on an authenticated admin route —
  // and the name is typed by the applicant, on a public form.
  const nasty = await call("/admissions", {
    method: "POST", token: adminToken,
    body: { firstName: 'Rob"ert\r\nX-Injected: yes', surname: "Tables", course: "HND Business" },
  });
  const nastyId = nasty.data?.id;
  if (nastyId) madeAdmissions.add(nastyId);
  const pdf = await call(`/admission-pdf/${nastyId}/application.pdf`, { token: adminToken });
  const disp = pdf.res.headers.get("content-disposition") || "";
  check("the application form downloads as a real PDF",
    pdf.status === 200 && (pdf.res.headers.get("content-type") || "").includes("application/pdf"),
    `HTTP ${pdf.status} ${pdf.res.headers.get("content-type")}`);
  const inner = disp.replace(/^attachment; filename="/, "").replace(/"$/, "");
  check("a hostile applicant name cannot inject a response header",
    !pdf.res.headers.get("x-injected") && !/[\r\n"]/.test(inner), disp);

  // ------------------------------------------------------------------------
  console.log("\n--- the PUBLIC application form ---");
  // Unauthenticated, behind a shareable link. Anything it accepts, anyone on the
  // internet can send it.
  const publicSmuggle = await call("/admission-apply", {
    method: "POST",
    body: {
      firstName: "Public", surname: "Form", email: `ADM-PUBLIC-${RUN}@Smoke.Invalid`,
      enrollStatus: "Enroll", offerStatus: "accepted", studentId: "000001", source: "admin",
    },
  });
  check("the public form creates an application", publicSmuggle.status === 201 && !!publicSmuggle.data?.id, `HTTP ${publicSmuggle.status}`);
  const publicId = publicSmuggle.data?.id;
  if (publicId) madeAdmissions.add(publicId);
  const publicRow = await db.admission.findUnique({ where: { id: publicId } });
  // The single most valuable assertion on this router: an anonymous stranger must not
  // be able to post themselves an accepted offer and a student number.
  check("a stranger cannot enrol themselves through the public form",
    publicRow?.enrollStatus === null && publicRow?.offerStatus === null && publicRow?.studentId === null,
    `enroll=${publicRow?.enrollStatus} offer=${publicRow?.offerStatus} id=${publicRow?.studentId}`);
  check("the record is stamped as having come from the public form", publicRow?.source === "apply", String(publicRow?.source));
  // Login is shared across staff, students and applicants and resolves on the address,
  // so a mixed-case duplicate would later resolve to the wrong account.
  check("the email is normalised to lower case", publicRow?.email === `adm-public-${RUN}@smoke.invalid`, String(publicRow?.email));

  const publicNameless = await call("/admission-apply", { method: "POST", body: { course: "HND Business" } });
  check("the public form still requires a name", publicNameless.status === 400, `HTTP ${publicNameless.status}`);

  // One email, one login. The portal account registered above already owns this
  // address; a second application under it would make the shared login ambiguous.
  const dupe = await call("/admission-apply", { method: "POST", body: { firstName: "Dup", surname: "Licate", email: MAIL("portal") } });
  check("an address that already has a portal login is refused", dupe.status === 409, `HTTP ${dupe.status}`);
  const staffDupe = await call("/admission-apply", { method: "POST", body: { firstName: "Dup", surname: "Licate", email: "admin@edtech.co.uk" } });
  check("...and so is a member of staff's address", staffDupe.status === 409, `HTTP ${staffDupe.status}`);

  // The honeypot has to look like success or the bot simply retries; it must also
  // create nothing, or the admissions pile fills with rows no human ever typed.
  const hpEmail = `adm-bot-${RUN}@smoke.invalid`;
  const honeypot = await call("/admission-apply", { method: "POST", body: { firstName: "Bot", surname: "Net", email: hpEmail, _hp: "http://spam" } });
  check("a honeypot submission is answered as if it worked", honeypot.status === 200 && honeypot.data?.ok === true, `HTTP ${honeypot.status}`);
  check("...but no application is created", (await db.admission.count({ where: { email: hpEmail } })) === 0);

  // ------------------------------------------------------------------------
  console.log("\n--- the course and intake lists the public form offers ---");
  const blank = await call("/admission-config/courses", { method: "POST", token: adminToken, body: { name: "   " } });
  check("a nameless course is refused", blank.status === 400, `HTTP ${blank.status}`);

  const courseName = `Smoke HND ${RUN}`;
  const mkCourse = await call("/admission-config/courses", { method: "POST", token: adminToken, body: { name: courseName } });
  check("a course is created", mkCourse.status === 201 && !!mkCourse.data?.id, `HTTP ${mkCourse.status}`);
  const courseId = mkCourse.data?.id;
  if (courseId) madeCourses.add(courseId);
  const mkIntake = await call("/admission-config/intakes", { method: "POST", token: adminToken, body: { label: `Smoke Intake ${RUN}` } });
  if (mkIntake.data?.id) madeIntakes.add(mkIntake.data.id);

  // These two lists shipped straight off Prisma, and tenantId went out with them — the
  // one field routes/admissions.js named explicitly as leaking the estate's shape. That
  // column is gone, and with it the only negative these two assertions made: what was
  // left would have been "name and active are present", which every denylist in history
  // also satisfies.
  //
  // Restated instead as the property the allowlist actually exists for, which is the one
  // the comment in admissionConfig.js states — a column added to either model TOMORROW
  // must not become public the moment it exists. So the key set is pinned EXACTLY against
  // sCourse/sIntake rather than probed for one forbidden name. This fails on a new column
  // reaching the client, which is what tenantId was only ever an instance of.
  const COURSE_KEYS = ["id", "name", "active", "sortOrder", "createdAt"];
  const INTAKE_KEYS = ["id", "label", "active", "sortOrder", "createdAt"];
  const exactly = (row, keys) => !!row && Object.keys(row).sort().join(",") === [...keys].sort().join(",");
  const cfgList = await call("/admission-config/courses", { token: adminToken });
  const cfgRow = (cfgList.data || []).find((c) => c.id === courseId);
  check("the course list says exactly what the serializer allows, and nothing else",
    exactly(cfgRow, COURSE_KEYS), Object.keys(cfgRow || {}).join(","));
  check("...and so does the intake list",
    exactly(mkIntake.data, INTAKE_KEYS), Object.keys(mkIntake.data || {}).join(","));

  const publicCourses = await call("/admission-apply/courses");
  check("an active course is offered on the public form",
    publicCourses.status === 200 && (publicCourses.data || []).includes(courseName), `HTTP ${publicCourses.status}`);

  // "Active" is how a college closes a course without losing the applications already
  // filed against it. If deactivating did not remove it from the public dropdown,
  // people would keep applying for something that no longer runs.
  await call(`/admission-config/courses/${courseId}`, { method: "PUT", token: adminToken, body: { active: false } });
  const afterHide = await call("/admission-apply/courses");
  check("a deactivated course disappears from the public form", !(afterHide.data || []).includes(courseName));

  const ghost = await call("/admission-config/courses/no-such-course", { method: "PUT", token: adminToken, body: { name: "Ghost" } });
  check("editing a course that does not exist is a 404", ghost.status === 404, `HTTP ${ghost.status}`);

  // sortOrder is a 32-bit Int column, and this number comes straight off a JSON body.
  // An out-of-range value is the exact shape of the defect that once killed this API
  // for good (STATUS.md §4): the row was written, Prisma could then never read the
  // table again, and it survived every restart.
  const overflow = await call(`/admission-config/courses/${courseId}`, { method: "PUT", token: adminToken, body: { sortOrder: 2 ** 40 } });
  check("an out-of-range sort order is rejected", overflow.status === 400, `HTTP ${overflow.status}`);
  // ...and rejected as a BAD VALUE, not as a missing row. The blanket catch this
  // replaces answered "Course not found." for every failure the write could produce,
  // which sent an admin hunting for a row that was sitting in front of them — and hid
  // a genuinely broken database behind a reassuring 404.
  check("...and named as a bad value, not reported as a missing course",
    !/not found/i.test(overflow.data?.error || ""), overflow.data?.error || "");
  const courseRow = await db.admissionCourse.findUnique({ where: { id: courseId } });
  check("...and nothing the Int column cannot hold was stored", !!courseRow && courseRow.sortOrder === 0, `sortOrder=${courseRow?.sortOrder}`);
  // A real reorder still works, so the bound is a guard and not a wall.
  const reorder = await call(`/admission-config/courses/${courseId}`, { method: "PUT", token: adminToken, body: { sortOrder: 7 } });
  check("a sensible sort order is still accepted", reorder.status === 200 && reorder.data?.sortOrder === 7, `HTTP ${reorder.status} sortOrder=${reorder.data?.sortOrder}`);

  // ------------------------------------------------------------------------
  console.log("\n--- the offer-acceptance link (public, token only) ---");
  const offerTarget = await call("/admissions", {
    method: "POST", token: adminToken,
    body: { firstName: "Offer", surname: "Holder", email: MAIL("offer"), course: "HND Business" },
  });
  const offerId = offerTarget.data?.id;
  if (offerId) madeAdmissions.add(offerId);

  const bogus = await call(`/admission-offers/${"0".repeat(64)}`);
  check("a made-up offer token is not valid", bogus.status === 404, `HTTP ${bogus.status}`);

  // Plant the hash of a token whose offer has NOT been sent. The token alone must not be
  // enough: a link that leaked from a draft, or a hash left behind by a cancelled send,
  // must not let anyone accept a place that was never offered them.
  const OFFER_TOKEN = `offer-token-${RUN}`;
  await db.admission.update({ where: { id: offerId }, data: { offerTokenHash: hashToken(OFFER_TOKEN), offerStatus: null } });
  const unsent = await call(`/admission-offers/${OFFER_TOKEN}`);
  check("a token for an offer that was never sent is not valid", unsent.status === 404, `HTTP ${unsent.status}`);
  const unsentAccept = await call(`/admission-offers/${OFFER_TOKEN}/accept`, { method: "POST" });
  check("...and it cannot be accepted either", unsentAccept.status === 404, `HTTP ${unsentAccept.status}`);

  await db.admission.update({ where: { id: offerId }, data: { offerStatus: "sent", offerInductionDate: "Tuesday, 15th September 2026" } });
  const view = await call(`/admission-offers/${OFFER_TOKEN}`);
  check("the real offer link opens", view.status === 200 && view.data?.status === "sent", `HTTP ${view.status}`);
  // Anyone holding the link sees this page, so it must carry the applicant's name and
  // course and nothing else — not their email, not the row id, not the token back again.
  check("the public offer page shows only name, course, status and date",
    JSON.stringify(Object.keys(view.data || {}).sort()) === JSON.stringify(["course", "inductionDate", "name", "status"]),
    Object.keys(view.data || {}).join(","));

  const accept1 = await call(`/admission-offers/${OFFER_TOKEN}/accept`, { method: "POST" });
  check("the applicant accepts their place", accept1.status === 200 && accept1.data?.status === "accepted", `HTTP ${accept1.status}`);
  const acceptedRow = await db.admission.findUnique({ where: { id: offerId } });
  check("...and the acceptance is timestamped", acceptedRow?.offerStatus === "accepted" && !!acceptedRow?.offerAcceptedAt);

  // Applicants double-click, and mail clients pre-fetch links. Accepting twice must be
  // the same as accepting once — in particular the ORIGINAL acceptance time has to
  // survive, because that timestamp is the college's evidence of when the place was
  // confirmed, and re-decision is the rule this product enforces everywhere else.
  const accept2 = await call(`/admission-offers/${OFFER_TOKEN}/accept`, { method: "POST" });
  const reRead = await db.admission.findUnique({ where: { id: offerId } });
  check("accepting the same offer twice is idempotent",
    accept2.status === 200 && accept2.data?.status === "accepted" &&
    reRead?.offerAcceptedAt?.getTime() === acceptedRow?.offerAcceptedAt?.getTime(),
    `${acceptedRow?.offerAcceptedAt?.toISOString()} -> ${reRead?.offerAcceptedAt?.toISOString()}`);

  // ------------------------------------------------------------------------
  console.log("\n--- the document-upload link (public, token only) ---");
  const upTarget = await call("/admissions", {
    method: "POST", token: adminToken,
    body: { firstName: "Upload", surname: "Subject", email: MAIL("upload"), course: "HND Business" },
  });
  const upId = upTarget.data?.id;
  if (upId) madeAdmissions.add(upId);
  const UP_TOKEN = `upload-token-${RUN}`;
  const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

  const badToken = await call(`/admission-uploads/${"f".repeat(64)}`);
  check("a made-up upload token is not valid", badToken.status === 404, `HTTP ${badToken.status}`);

  // An expired link is the one an applicant finds in a year-old email. It must say so
  // rather than working, and — because the link is the only credential — it must not
  // list which of this person's identity documents are already on file.
  await db.admission.update({
    where: { id: upId },
    data: { uploadTokenHash: hashToken(UP_TOKEN), uploadTokenExpires: new Date(Date.now() - 60_000), docsRequestedAt: new Date() },
  });
  const expiredView = await call(`/admission-uploads/${UP_TOKEN}`);
  check("an expired link says so", expiredView.status === 200 && expiredView.data?.expired === true, `HTTP ${expiredView.status}`);
  check("...and leaks no document checklist with it", (expiredView.data?.docs || []).length === 0);
  const expiredPost = await call(`/admission-uploads/${UP_TOKEN}?type=passport`, { method: "POST", raw: PDF_MAGIC });
  check("an expired link cannot upload", expiredPost.status === 410, `HTTP ${expiredPost.status}`);

  await db.admission.update({ where: { id: upId }, data: { uploadTokenExpires: new Date(Date.now() + 3600_000) } });
  const liveView = await call(`/admission-uploads/${UP_TOKEN}`);
  check("a live link shows the full checklist, nothing uploaded yet",
    liveView.status === 200 && liveView.data?.expired === false &&
    (liveView.data?.docs || []).length === 10 && (liveView.data?.docs || []).every((d) => d.uploaded === false),
    `${(liveView.data?.docs || []).length} document types`);

  const badType = await call(`/admission-uploads/${UP_TOKEN}?type=bank-details`, { method: "POST", raw: PDF_MAGIC });
  check("an unknown document type is refused", badType.status === 400, `HTTP ${badType.status}`);

  // The type is sniffed from the leading bytes, never from the filename or the
  // Content-Type — both of which the uploader controls. A .pdf full of executable is
  // still not a PDF, and this is an unauthenticated endpoint writing to college storage.
  const liar = await call(`/admission-uploads/${UP_TOKEN}?type=passport`, {
    method: "POST", contentType: "application/pdf",
    raw: new TextEncoder().encode("MZ  this is not a pdf at all"),
  });
  check("a file that only claims to be a PDF is rejected on its bytes",
    liar.status === 400 && /PDF or a photo/i.test(liar.data?.error || ""),
    `HTTP ${liar.status} ${liar.data?.error || ""}`);

  const empty = await call(`/admission-uploads/${UP_TOKEN}?type=passport`, { method: "POST", raw: new Uint8Array(0) });
  check("an empty upload is refused", empty.status === 400, `HTTP ${empty.status}`);

  // ------------------------------------------------------------------------
  console.log("\n--- verifying an uploaded document ---");
  // Neither SharePoint nor Supabase is configured in this build, so a real upload stops
  // at 503 and the document row is planted directly. What is under test is the
  // verification workflow above the transport, not the transport.
  const doc = await db.admissionDocument.create({
    data: { admissionId: upId, docType: "passport", fileName: "Passport.pdf", mimeType: "application/pdf", sizeBytes: 1234 },
  });

  const withDocs = await call("/admissions", { token: adminToken });
  const upRow = (withDocs.data || []).find((r) => r.id === upId);
  const outDoc = (upRow?.documents || [])[0];
  check("the uploaded document rides along on the application", !!outDoc && outDoc.id === doc.id);
  // Storage locations are not the client's business: it opens a file through the
  // authorising route below, which mints a short-lived link at the moment of asking.
  const docLeaks = ["storagePath", "webUrl", "spItemId"].filter((k) => outDoc && k in outDoc);
  check("...without its storage location", docLeaks.length === 0, docLeaks.join(", ") || "none");

  const confirm = await call(`/admissions/documents/${doc.id}/confirm`, { method: "PUT", token: adminToken, body: { confirmed: true } });
  check("an admin can verify a document", confirm.status === 200 && confirm.data?.confirmed === true, `HTTP ${confirm.status}`);
  // Who signed off an identity check, and when, is the whole point of the record.
  check("...and the sign-off names the person who made it",
    confirm.data?.confirmedBy === "HR Administrator" && !!confirm.data?.confirmedAt,
    `${confirm.data?.confirmedBy} @ ${confirm.data?.confirmedAt}`);

  const unconfirm = await call(`/admissions/documents/${doc.id}/confirm`, { method: "PUT", token: adminToken, body: { confirmed: false } });
  check("un-verifying clears the sign-off rather than leaving a stale one",
    unconfirm.status === 200 && unconfirm.data?.confirmed === false &&
    unconfirm.data?.confirmedAt === null && unconfirm.data?.confirmedBy === null,
    `at=${unconfirm.data?.confirmedAt} by=${unconfirm.data?.confirmedBy}`);

  const file = await call(`/admissions/documents/${doc.id}/file`, { token: adminToken });
  check("a document row with no stored file 404s instead of handing back a broken link",
    file.status === 404, `HTTP ${file.status}`);

  // ------------------------------------------------------------------------
  console.log("\n--- deleting an application takes its documents with it ---");
  // Retention: when a college erases an applicant, every uploaded identity document has
  // to go in the same movement. A surviving AdmissionDocument row is a passport-scan
  // reference outliving the erasure it was supposed to be part of.
  const del = await call(`/admissions/${upId}`, { method: "DELETE", token: adminToken });
  check("the application is deleted", del.status === 200 && del.data?.ok === true, `HTTP ${del.status}`);
  check("...and its documents are gone with it", (await db.admissionDocument.count({ where: { admissionId: upId } })) === 0);
} finally {
  await cleanup();
  await db.$disconnect();
  console.log("\ncleanup: test applications, courses and intakes removed");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
