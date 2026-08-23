// The applicant portal — the one part of this system a stranger from the internet is
// invited to create an account on.
//
// Everything else behind /api belongs to somebody the college has already vetted: a
// staff account created by an admin, a student account approved through sign-up. An
// applicant registers themselves, unsupervised, and is then handed a session token.
// So the questions this suite asks are not "does the form save" — they are:
//
//   * can that self-service account become anything other than an applicant?
//     (the router allowlist, and the admin-only columns on its own Admission row)
//   * can it see or touch a second applicant's application?
//   * do the decisions the college has recorded — the received date of an application,
//     an offer that has been accepted — survive the applicant pressing the button again?
//   * does an upload with no storage configured degrade honestly, or does it swallow a
//     document and tell the applicant it was filed?
//
// Those are the ones that would be a real incident. An applicant who can read
// /api/admissions is a data-protection breach involving other people's passports; an
// applicationSubmittedAt that slides forward on every re-save changes who met a
// deadline; an offer that can be re-accepted rewrites the acceptance date the college
// relies on for its funding return.
//
//   node scripts/smoke-applicant.mjs
//   (needs API_URL + DATABASE_URL; the runner supplies both)
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server");
const require = createRequire(pathToFileURL(join(server, "package.json")));

// API_URL, not API_BASE: the runner passes API_URL, and a hard-coded 4010 fallback
// would silently talk to nothing on any other TEST_PORT.
const BASE = process.env.API_URL || "http://localhost:4000/api";
const SEED_PW = process.env.SEED_PASSWORD || "test-seed-password-2026";
const ADMIN_EMAIL = "admin@edtech.co.uk";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required — point it at a throwaway database.");
  process.exit(1);
}

const { PrismaClient } = require(join(server, "node_modules", "@prisma", "client"));
// A BARE client: the tenant-extended one in src/db.js would answer the very questions
// this suite is trying to verify independently. We need to read the raw Admission row
// to prove the API did NOT write the columns an applicant must never control.
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function call(path, { method = "GET", body, token, tenant = "default" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers["X-Tenant"] = tenant;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty or non-JSON body */ }
  return { status: res.status, data };
}

// Uploads are a raw byte body, not JSON — the route mounts express.raw({type:"*/*"}).
async function upload(path, { token, bytes, contentType = "application/pdf" } = {}) {
  const headers = { Authorization: `Bearer ${token}`, "X-Tenant": "default" };
  if (bytes) headers["Content-Type"] = contentType;
  const res = await fetch(BASE + path, { method: "POST", headers, body: bytes });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

// A download is judged by its bytes, not by a 200 — a JSON error served as a "PDF" is
// what an applicant's browser would try to open.
async function download(path, token) {
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${token}`, "X-Tenant": "default" } });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get("content-type") || "", magic: buf.subarray(0, 5).toString("latin1"), bytes: buf.length };
}

// Distinct per run so a half-finished run cannot collide with the next one, and so a
// leftover row is obviously ours.
const RUN = Date.now().toString(36);
const A_EMAIL = `portal-a-${RUN}@applicant.test`;
const B_EMAIL = `portal-b-${RUN}@applicant.test`;
const PW = "ApplicantPortal!2026";
const created = [];   // Admission ids to remove in the finally block

const register = (email, extra = {}) =>
  call("/applicant/register", {
    method: "POST",
    body: { email, firstName: "Ada", surname: "Lovelace", password: PW, confirmPassword: PW, ...extra },
  });

async function cleanup() {
  for (const id of created) {
    await db.admissionDocument.deleteMany({ where: { admissionId: id } }).catch(() => {});
    await db.admission.delete({ where: { id } }).catch(() => {});
  }
  // Belt and braces: anything carrying this run's tag, however it was created.
  await db.admission.deleteMany({ where: { email: { contains: `-${RUN}@applicant.test` } } }).catch(() => {});
}

try {
  console.log("\n=== applicant portal ===");

  /* ------------------------------------------------- registration: the gate --- */
  //
  // Registration is PUBLIC and unauthenticated. Every one of these refusals is the
  // only thing standing between the admissions table and whatever a script posts.

  console.log("\n--- self-registration refuses what it should ---");
  const noName = await register(`nn-${RUN}@applicant.test`, { surname: "" });
  check("a registration with no surname is refused", noName.status === 400, `HTTP ${noName.status}`);

  const badEmail = await register("not-an-email");
  // The email IS the login. An unusable address means an account nobody can recover,
  // and an applicant who never receives their offer letter.
  check("a malformed email address is refused", badEmail.status === 400, `HTTP ${badEmail.status}`);

  const shortPw = await register(`sp-${RUN}@applicant.test`, { password: "Short1!", confirmPassword: "Short1!" });
  check("a password under 8 characters is refused", shortPw.status === 400, `HTTP ${shortPw.status}`);

  const mismatch = await register(`mm-${RUN}@applicant.test`, { confirmPassword: PW + "x" });
  // Caught here or the applicant is locked out of an account they just made and the
  // college fields a support call for every typo.
  check("mismatched password confirmation is refused", mismatch.status === 400, `HTTP ${mismatch.status}`);

  console.log("\n--- a real registration ---");
  const regA = await register(A_EMAIL);
  if (regA.data?.user?.id) created.push(regA.data.user.id);
  check("registering returns 201 with a session token", regA.status === 201 && !!regA.data?.token, `HTTP ${regA.status}`);
  check("...and the session is an APPLICANT session", regA.data?.user?.kind === "applicant", `kind=${regA.data?.user?.kind}`);
  // The register response is the first thing this row is ever serialised into. If the
  // bcrypt hash escapes here it escapes everywhere downstream.
  check("...carrying no password hash", !/hash/i.test(JSON.stringify(regA.data?.user || {})));

  const regB = await register(B_EMAIL, { firstName: "Grace", surname: "Hopper" });
  if (regB.data?.user?.id) created.push(regB.data.user.id);
  check("a second applicant registers independently", regB.status === 201 && regB.data?.user?.id !== regA.data?.user?.id);

  console.log("\n--- one address, one account (login is shared across all three kinds) ---");
  const dupe = await register(A_EMAIL.toUpperCase());
  // Case-insensitively, or two rows share one login: /auth/login picks the first match
  // and the other applicant can never sign in to the application they filled in.
  check("the same address in different case is refused", dupe.status === 409, `HTTP ${dupe.status}`);

  const asStaff = await register(ADMIN_EMAIL);
  // The nastiest version of the same collision. Staff are matched BEFORE applicants in
  // /auth/login, so an applicant registering a staff address would be shadowed by it —
  // and, worse, the college's own address would be sitting in the applicant table.
  check("a STAFF address cannot be claimed by an applicant", asStaff.status === 409, `HTTP ${asStaff.status}`);

  /* --------------------------------------------------------- check-email ------ */
  //
  // Deliberately only three calls. This endpoint's per-IP budget is 40 in 15 minutes
  // and smoke-security-d5-d9-t6 measures the limiter itself by spending it; burning it
  // here would make that suite's readings meaningless.
  console.log("\n--- the live 'is this address free?' check ---");
  const ceBad = await call("/applicant/check-email", { method: "POST", body: { email: "nope" } });
  check("a malformed address is reported invalid", ceBad.status === 200 && ceBad.data?.valid === false && ceBad.data?.available === false, JSON.stringify(ceBad.data));

  const ceTaken = await call("/applicant/check-email", { method: "POST", body: { email: ADMIN_EMAIL } });
  // `checked:false` means the budget was already spent by another suite in this run —
  // the endpoint fails OPEN by design (a 429 would be rendered as "email taken" and
  // would turn away an honest applicant), so only assert the oracle when it answered.
  check(
    ceTaken.data?.checked === false
      ? "over budget, the check fails open rather than blocking the form"
      : "an address already in use is reported unavailable",
    ceTaken.data?.checked === false
      ? ceTaken.status === 200 && ceTaken.data?.valid === true && ceTaken.data?.available === true
      : ceTaken.status === 200 && ceTaken.data?.available === false,
    JSON.stringify(ceTaken.data),
  );

  const ceFree = await call("/applicant/check-email", { method: "POST", body: { email: `free-${RUN}@applicant.test` } });
  check("an unused address is reported available", ceFree.status === 200 && ceFree.data?.available === true, JSON.stringify(ceFree.data));

  /* --------------------------------------------------------------- login ------ */
  console.log("\n--- signing in with what was just registered ---");
  const loginA = await call("/auth/login", { method: "POST", body: { email: A_EMAIL, password: PW } });
  check("the registered credentials sign in", loginA.status === 200 && loginA.data?.user?.kind === "applicant", `HTTP ${loginA.status}`);
  const tokenA = loginA.data?.token || regA.data?.token;
  const tokenB = regB.data?.token;
  const idA = regA.data?.user?.id;
  const idB = regB.data?.user?.id;

  const admin = await call("/auth/login", { method: "POST", body: { email: ADMIN_EMAIL, password: SEED_PW } });
  if (!admin.data?.token) throw new Error(`admin login failed (HTTP ${admin.status}) — is the API seeded?`);

  /* ---------------------------------------------- the walls around the token -- */
  //
  // requireAuth holds an ALLOWLIST of the routers an applicant token may reach. This is
  // the cheapest high-value check in the codebase: if it ever regresses, a stranger who
  // registered on a public form is inside the staff API.
  console.log("\n--- an applicant session reaches nothing but its own portal ---");
  const anon = await call("/applicant/me");
  check("the portal is closed without a token", anon.status === 401, `HTTP ${anon.status}`);

  const staffAsApplicant = await call("/applicant/me", { token: admin.data.token });
  // The reverse guard. Without requireApplicant the handler would look up an Admission
  // by the STAFF id — a lookup that happens to miss today, and would not if ids ever
  // collided. Fail closed on the kind, not on the miss.
  check("a staff token is not an applicant", staffAsApplicant.status === 403, `HTTP ${staffAsApplicant.status}`);

  const toStaff = await call("/staff", { token: tokenA });
  check("applicant token → /api/staff refused", toStaff.status === 403 && /applicant accounts/i.test(toStaff.data?.error || ""), `HTTP ${toStaff.status} ${toStaff.data?.error || ""}`);

  const toAdmissions = await call("/admissions", { token: tokenA });
  // The one that matters most: /api/admissions is every applicant's full application —
  // passport numbers, criminal-conviction declarations, medical disclosures.
  check("applicant token → /api/admissions refused", toAdmissions.status === 403 && !Array.isArray(toAdmissions.data), `HTTP ${toAdmissions.status}`);

  const toStudent = await call("/student/me", { token: tokenA });
  check("applicant token → /api/student refused", toStudent.status === 403, `HTTP ${toStudent.status}`);

  /* ------------------------------------------------------------ /me: reads ---- */
  console.log("\n--- an applicant sees their own application and only their own ---");
  const meA = await call("/applicant/me", { token: tokenA });
  check("GET /me returns the caller's own record", meA.status === 200 && meA.data?.id === idA && meA.data?.email === A_EMAIL, `id=${meA.data?.id}`);
  const meJson = JSON.stringify(meA.data || {});
  // The portal view is hand-built rather than serialised off the row, and this is why:
  // the row carries the login hash and two single-use link hashes (upload + offer). Any
  // of those in the applicant's own JSON is a handed-over credential.
  check("...with no password or link-token hashes in it", !/hash/i.test(meJson) && !meJson.includes("tenantId"));
  check("...and the full document checklist", Array.isArray(meA.data?.documents) && meA.data.documents.length === 10 && meA.data.documents.every((d) => d.uploaded === false), `${meA.data?.documents?.length} types`);

  const meB = await call("/applicant/me", { token: tokenB });
  // No id is ever taken from the URL or the body on this router — identity comes only
  // from the token — so two sessions must be completely blind to each other.
  check("a second applicant sees a different application", meB.data?.id === idB && meB.data?.email === B_EMAIL && meB.data?.id !== meA.data?.id);

  /* ----------------------------------------------------------- /me: writes ---- */
  console.log("\n--- saving the form ---");
  const saved = await call("/applicant/me", {
    method: "PUT", token: tokenA,
    body: { firstName: "Ada", surname: "Lovelace", course: "HND Business", phone: "07000 000000", niNumber: "QQ123456C" },
  });
  check("PUT /me saves the answers", saved.status === 200 && saved.data?.application?.course === "HND Business" && saved.data?.application?.phone === "07000 000000", `HTTP ${saved.status}`);

  const capped = await call("/applicant/me", {
    method: "PUT", token: tokenA,
    body: { firstName: "Ada", surname: "Lovelace", course: "HND Business", medicalDetails: "x".repeat(6000) },
  });
  // A 5000-character cap per answer. Without it one paste turns a row into megabytes
  // and the admissions list — which loads every application — degrades for everyone.
  check("an over-long answer is capped, not stored whole", capped.data?.application?.medicalDetails?.length === 5000, `${capped.data?.application?.medicalDetails?.length} chars`);

  console.log("\n--- the columns an applicant must never write ---");
  const escalate = await call("/applicant/me", {
    method: "PUT", token: tokenA,
    body: {
      firstName: "Ada", surname: "Lovelace", course: "HND Business",
      // Every one of these is an ADMIN decision living on the same row as the form.
      offerStatus: "accepted", offerAcceptedAt: new Date().toISOString(),
      enrollStatus: "Enroll", ismOutcome: "Yes", interviewStatus: "Passed",
      studentId: "st-100121", applicationSubmittedAt: new Date().toISOString(),
      active: false, tokenVersion: 99, passwordHash: "not-a-hash", id: idB, tenantId: "somewhere-else",
    },
  });
  const rowA = await db.admission.findUnique({ where: { id: idA } });
  const untouched =
    rowA.offerStatus === null && rowA.offerAcceptedAt === null && rowA.enrollStatus === null &&
    rowA.ismOutcome === null && rowA.interviewStatus === null && rowA.studentId === null &&
    rowA.applicationSubmittedAt === null && rowA.active === true && rowA.tokenVersion === 0 &&
    rowA.passwordHash?.startsWith("$2") && rowA.id === idA;
  // pick() copies an allowlist of form columns; anything else in the body is dropped on
  // the floor. If that ever becomes a denylist, an applicant self-enrols, self-offers,
  // and awards themselves a student ID — with a real record to show for it.
  check("admin-only columns smuggled into the body are ignored", escalate.status === 200 && untouched,
    `offer=${rowA.offerStatus} enroll=${rowA.enrollStatus} studentId=${rowA.studentId} submitted=${rowA.applicationSubmittedAt} active=${rowA.active}`);

  const rowB = await db.admission.findUnique({ where: { id: idB } });
  // The body carried B's id. If it had been honoured, one applicant would have written
  // over another's application — the same class of bug as an IDOR, arriving by a field.
  check("...including an id pointing at another applicant", rowB.firstName === "Grace" && rowB.course === null, `B.firstName=${rowB.firstName}`);

  const collide = await call("/applicant/me", { method: "PUT", token: tokenA, body: { firstName: "Ada", surname: "Lovelace", email: B_EMAIL } });
  const stillA = await db.admission.findUnique({ where: { id: idA } });
  // Changing the email changes the LOGIN. Allowing a duplicate here is the same
  // account-shadowing bug as registration, arriving through the back door.
  check("changing the email to another account's is refused", collide.status === 409 && stillA.email === A_EMAIL, `HTTP ${collide.status} email=${stillA.email}`);

  /* -------------------------------------------------------------- submit ------ */
  console.log("\n--- submitting the application ---");
  const badSubmit = await call("/applicant/me/submit", { method: "POST", token: tokenA, body: { firstName: "Ada", surname: "Lovelace" } });
  const afterBad = await db.admission.findUnique({ where: { id: idA } });
  // A submission missing the course is not a submission. Critically the rejection must
  // land BEFORE the write, or a refused submit still stamps the row as received.
  check("submitting without a course is refused, and nothing is stamped", badSubmit.status === 400 && afterBad.applicationSubmittedAt === null, `HTTP ${badSubmit.status}`);

  const submit1 = await call("/applicant/me/submit", {
    method: "POST", token: tokenA,
    body: { firstName: "Ada", surname: "Lovelace", course: "HND Business", intake: "September", intakeYear: "2026" },
  });
  check("a complete submission is accepted", submit1.status === 200 && submit1.data?.progress?.applicationSubmitted === true, `HTTP ${submit1.status}`);
  const firstStamp = (await db.admission.findUnique({ where: { id: idA } })).applicationSubmittedAt;
  check("...and records when it was received", !!firstStamp, String(firstStamp));

  const submit2 = await call("/applicant/me/submit", {
    method: "POST", token: tokenA,
    body: { firstName: "Ada", surname: "Lovelace", course: "HND Business", intake: "September", intakeYear: "2026", phone: "07111 111111" },
  });
  const secondStamp = (await db.admission.findUnique({ where: { id: idA } })).applicationSubmittedAt;
  // The portal invites the applicant to "Update & re-submit", so this button gets
  // pressed repeatedly. The received date must not move with it: it is what decides
  // who made an intake deadline, and moving it would silently disqualify people or
  // let a late application look on time.
  check("re-submitting does NOT reset the received date", submit2.status === 200 && +secondStamp === +firstStamp, `${firstStamp} → ${secondStamp}`);
  check("...but the edited answers are saved", submit2.data?.application?.phone === "07111 111111");

  /* --------------------------------------------------------------- offer ------ */
  console.log("\n--- the offer, before the college has made one ---");
  const offerBefore = await call("/applicant/offer", { token: tokenA });
  check("no offer reads as no offer", offerBefore.status === 200 && offerBefore.data?.status === null, JSON.stringify(offerBefore.data));

  const acceptEarly = await call("/applicant/offer/accept", { method: "POST", token: tokenA });
  // Nobody accepts a place they were never given. If this succeeded the admissions list
  // would show an accepted offer the college never sent.
  check("accepting a non-existent offer is refused", acceptEarly.status === 400, `HTTP ${acceptEarly.status}`);

  const letterEarly = await download("/applicant/offer-letter.pdf", tokenA);
  check("the offer letter is not downloadable before it is sent", letterEarly.status === 400, `HTTP ${letterEarly.status}`);

  console.log("\n--- once admissions sends the offer ---");
  // Set directly rather than through /api/admission-offers: that route emails the
  // applicant, and server/.env carries live SMTP credentials.
  await db.admission.update({ where: { id: idA }, data: { offerStatus: "sent", offerSentAt: new Date(), offerInductionDate: "2026-09-14" } });

  const accept1 = await call("/applicant/offer/accept", { method: "POST", token: tokenA });
  const acceptedRow = await db.admission.findUnique({ where: { id: idA } });
  check("the applicant can accept it", accept1.status === 200 && accept1.data?.progress?.offerAccepted === true && acceptedRow.offerStatus === "accepted", `status=${acceptedRow.offerStatus}`);
  const acceptedAt = acceptedRow.offerAcceptedAt;

  const accept2 = await call("/applicant/offer/accept", { method: "POST", token: tokenA });
  const reAccepted = await db.admission.findUnique({ where: { id: idA } });
  // Idempotent on purpose. A double-tap on a phone, or a refresh of the accept page,
  // must not rewrite the acceptance date — that timestamp is the college's evidence of
  // when the place was taken up, and it feeds the funding return.
  check("accepting twice does not move the acceptance date", accept2.status === 200 && +reAccepted.offerAcceptedAt === +acceptedAt, `${acceptedAt} → ${reAccepted.offerAcceptedAt}`);

  const letter = await download("/applicant/offer-letter.pdf", tokenA);
  check("the offer letter downloads as a real PDF", letter.status === 200 && letter.magic === "%PDF-" && /pdf/i.test(letter.type), `HTTP ${letter.status} ${letter.type} ${letter.bytes}B`);

  const appPdf = await download("/applicant/application.pdf", tokenA);
  check("the application form downloads as a real PDF", appPdf.status === 200 && appPdf.magic === "%PDF-", `HTTP ${appPdf.status} ${appPdf.bytes}B`);

  const offerB = await call("/applicant/offer", { token: tokenB });
  // A's offer must be invisible to B. Same router, same handler, different token.
  check("the other applicant still has no offer", offerB.data?.status === null && !/Ada/.test(JSON.stringify(offerB.data)), JSON.stringify(offerB.data));

  /* ----------------------------------------------------------- documents ------ */
  console.log("\n--- document uploads ---");
  const unknownType = await upload("/applicant/documents?type=nonsense", { token: tokenA, bytes: new Uint8Array(Buffer.from("%PDF-1.4\n%fake\n")) });
  check("an unknown document type is refused", unknownType.status === 400, `HTTP ${unknownType.status}`);

  const emptyFile = await upload("/applicant/documents?type=passport", { token: tokenA });
  check("an empty upload is refused", emptyFile.status === 400, `HTTP ${emptyFile.status}`);

  const disguised = await upload("/applicant/documents?type=passport", { token: tokenA, bytes: new Uint8Array(Buffer.from("<html><script>alert(1)</script>")), contentType: "application/pdf" });
  // Sniffed by magic bytes, never by the declared Content-Type or the file name. This
  // is what stops an executable or an HTML payload being filed into the admissions
  // folder and later opened by a member of staff.
  check("a file that only claims to be a PDF is refused", disguised.status === 400, `HTTP ${disguised.status} ${disguised.data?.error || ""}`);

  const realPdf = await upload("/applicant/documents?type=passport", { token: tokenA, bytes: new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n")) });
  const docRows = await db.admissionDocument.count({ where: { admissionId: idA } });
  // No SharePoint and no Supabase are configured in this build. The right answer is a
  // 503 that says so — NOT a 200, and above all not a database row claiming the college
  // holds a passport scan it never received.
  check("with no storage configured the upload fails honestly (503)", realPdf.status === 503 && docRows === 0, `HTTP ${realPdf.status} rows=${docRows}`);

  const checklist = await call("/applicant/documents", { token: tokenA });
  check("...and the checklist still shows nothing uploaded", checklist.status === 200 && checklist.data?.docs?.every((d) => d.uploaded === false), `${checklist.data?.docs?.length} types`);

  /* ------------------------------------------------- ending a session --------- */
  console.log("\n--- revoking access ---");
  await db.admission.update({ where: { id: idA }, data: { tokenVersion: { increment: 1 } } });
  const stale = await call("/applicant/me", { token: tokenA });
  // Changing the password bumps tokenVersion. If an old token kept working, a password
  // change after a shoulder-surf or a shared laptop would not actually lock anyone out.
  check("a token issued before a password change stops working", stale.status === 401, `HTTP ${stale.status}`);

  const freshA = await call("/auth/login", { method: "POST", body: { email: A_EMAIL, password: PW } });
  check("...while signing in again works", freshA.status === 200 && !!freshA.data?.token, `HTTP ${freshA.status}`);

  await db.admission.update({ where: { id: idA }, data: { active: false } });
  const deactivatedToken = await call("/applicant/me", { token: freshA.data?.token });
  const deactivatedLogin = await call("/auth/login", { method: "POST", body: { email: A_EMAIL, password: PW } });
  // A withdrawn or fraudulent applicant is deactivated, not deleted (the application is
  // a record the college has to keep). Deactivation has to end the session AND the
  // ability to start a new one, or it is just a flag in a list.
  check("a deactivated applicant is locked out of both token and login", deactivatedToken.status === 401 && deactivatedLogin.status === 401, `token=${deactivatedToken.status} login=${deactivatedLogin.status}`);
} finally {
  await cleanup();
  await db.$disconnect();
  console.log("\ncleanup: test applicants removed");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
