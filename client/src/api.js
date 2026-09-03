// Thin REST client.
//
// Where the API lives:
//   1. VITE_API_URL wins if set — this is what a real deployment uses, and what a
//      packaged mobile app MUST set, because "localhost" inside the app means the
//      phone itself, not the machine running the server.
//   2. Otherwise, follow the host the page was opened from. Opening the dev client
//      at http://192.168.1.5:5173 on a phone therefore talks to the API on
//      http://192.168.1.5:4000 with no configuration.
//   3. Falling back to localhost keeps `npm run dev` on this machine working.
const API_PORT = 4000;
function resolveBase() {
  const configured = import.meta.env.VITE_API_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (typeof window !== "undefined") {
    const { protocol, hostname } = window.location;
    // capacitor:// and file:// have no useful host — those builds must set VITE_API_URL.
    if (protocol.startsWith("http") && hostname) return `${protocol}//${hostname}:${API_PORT}/api`;
  }
  return `http://localhost:${API_PORT}/api`;
}
const BASE = resolveBase();
// Exported so brand.js can fetch /branding from the same server, without a second
// copy of the host-resolution logic that would drift from this one.
export const API_BASE = BASE;

// Tenancy used to live here. This browser once had to say WHICH college it was acting
// for — an X-Tenant header resolved from `?tenant=`, a remembered slug, or VITE_TENANT —
// because one deployment served many institutions. Every college now gets its own
// deployment and its own database, so the server knows the answer without being told and
// there is nothing left for the client to choose. Removed rather than left switched off:
// a header the server ignores is a lie waiting for somebody to trust it.

// NOTE for the packaged app: localStorage inside the Capacitor WebView is private
// to the app, but it is not the Keychain / Android Keystore. Before shipping,
// consider moving the JWT to secure storage — see MOBILE.md.
const TOKEN_KEY = "edtech_token";

// Session persistence, by platform:
//   Native app  → sessionStorage. It survives backgrounding (the WebView stays
//                 alive), but a fresh app process after the user closes/kills the
//                 app starts EMPTY — so reopening requires signing in again.
//   Web / PWA   → localStorage (persistent), so a browser reload keeps you in.
const NATIVE = typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.() === true;
const tokenStore = () => (NATIVE ? window.sessionStorage : window.localStorage);

// On the native app, discard any token left over from an older (persistent) build
// or a previous run so it can never keep a killed session alive.
if (NATIVE) { try { window.localStorage.removeItem(TOKEN_KEY); } catch (_) { /* ignore */ } }

export const getToken = () => { try { return tokenStore().getItem(TOKEN_KEY); } catch (_) { return null; } };
export const setToken = (t) => {
  try { if (t) tokenStore().setItem(TOKEN_KEY, t); else tokenStore().removeItem(TOKEN_KEY); } catch (_) { /* ignore */ }
  if (!t) { try { window.localStorage.removeItem(TOKEN_KEY); } catch (_) { /* ignore */ } } // belt-and-braces on logout
};

// Every request gets a deadline. Without one, a weak mobile signal or a cold-starting
// free-tier server left the app awaiting a promise that never settled: a skeleton
// screen forever, spinner turning, no error and no way to retry. 30s is generous for
// a normal call; the Moodle endpoints, which read a whole VLE, pass their own.
const DEFAULT_TIMEOUT_MS = 30000;

async function request(path, { method = "GET", body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    // cache:"no-store" — never serve a cached response. Without this, a mobile
    // WebView can return stale data after a mutation's refetch, so the UI only
    // updates on a manual reload. This forces every request to hit the network.
    res = await fetch(BASE + path, { method, headers, cache: "no-store", signal: controller?.signal, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    // An abort is a timeout, not a mystery network failure — say so, because the two
    // need different things from the user.
    if (e?.name === "AbortError") {
      const err = new Error("The server took too long to respond. Check your connection and try again.");
      err.timeout = true;
      throw err;
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (res.status === 401) {
    setToken(null);
    // Signal the app to drop the user and show <Login>, rather than leaving a
    // broken authenticated UI where every subsequent request also 401s.
    //
    // Carry WHICH request 401'd. A 401 from /auth/login means a password was actually
    // submitted and rejected — clear the remembered credential. A 401 from any OTHER
    // path means an existing token expired or was revoked; the password was never sent
    // and is still valid, so the handler must keep it. Without this distinction, a
    // routine token expiry wiped a correct remembered password and forced a retype on
    // every session end — defeating the feature the user just turned on.
    const fromLogin = path.startsWith("/auth/login");
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("auth:unauthorized", { detail: { fromLogin } }));
  }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    // Carry the status on the error. A network-level failure makes fetch itself
    // reject, so that error has no `status` — which is how callers tell "the
    // server rejected me" apart from "I never reached the server".
    // A 404 on a route the SERVER does not have is a different thing from a 404 on a
    // record that does not exist, and only one of them is the user's problem.
    //
    // The client and the API deploy separately — a browser can be running a build
    // hours newer than the server. When that happens every call to a newly-added
    // route 404s, and the bare message ("Request failed (404)") sends whoever is
    // looking at it hunting for a fault in a feature that is simply not deployed yet.
    //
    // The server answers a route it HAS but is not authorised for with 401/403, so a
    // 404 carrying no error body of its own is the signature of a route it does not
    // know about at all.
    const missingRoute = res.status === 404 && !data?.error;
    const err = new Error(
      missingRoute
        ? "This part of the app is newer than the server it is talking to. The page will work once the API has been redeployed — nothing is wrong with your data."
        : (data?.error || `Request failed (${res.status})`)
    );
    err.status = res.status;
    // Lets a screen tell "the server is behind" apart from a genuine failure, and say
    // so in its own words rather than rendering a generic error box.
    if (missingRoute) err.staleServer = true;
    // Carry the whole body. The server sends flags alongside the message — notably
    // `locked: true` on a 423 term-locked register — and discarding them meant no
    // caller could react to one even if it wanted to.
    err.body = data;
    throw err;
  }
  return data;
}

export const api = {
  // auth
  login: (email, password) => request("/auth/login", { method: "POST", body: { email, password } }),
  me: () => request("/auth/me"),

  // This institution's own Moodle / SharePoint credentials. The saved secret is
  // never returned — only whether one is set and its last four characters.
  listIntegrations: () => request("/integrations"),
  saveIntegration: (provider, body) => request(`/integrations/${provider}`, { method: "PUT", body }),
  removeIntegration: (provider) => request(`/integrations/${provider}`, { method: "DELETE" }),
  testIntegration: (provider) => request(`/integrations/${provider}/test`, { method: "POST" }),
  // The institution's own name, colours and logo. getBranding (public) is fetched by
  // branding.js at boot; these are the administrator's read/write views.
  getBrandingAll: () => request("/branding/all"),
  saveBranding: (body) => request("/branding", { method: "PUT", body }),
  resetBranding: () => request("/branding", { method: "DELETE" }),
  // A college's own offer-letter / application-form PDFs. The PDF bytes themselves are
  // fetched directly in TemplateEditor (they are not JSON), so only the metadata and
  // field positions go through here.
  listDocTemplates: () => request("/doc-templates"),
  saveDocTemplate: (kind, body) => request(`/doc-templates/${kind}`, { method: "PUT", body, timeoutMs: 60000 }),
  deleteDocTemplate: (kind) => request(`/doc-templates/${kind}`, { method: "DELETE" }),
  listEmailTemplates: () => request("/email-templates"),
  saveEmailTemplate: (kind, body) => request(`/email-templates/${kind}`, { method: "PUT", body }),
  deleteEmailTemplate: (kind) => request(`/email-templates/${kind}`, { method: "DELETE" }),
  changePassword: (currentPassword, newPassword) => request("/auth/change-password", { method: "PUT", body: { currentPassword, newPassword } }),

  // The audit trail. Read-only by design — the API has no write endpoint, because a
  // log the people it records can edit is not evidence. Cursor-paged rather than
  // offset-paged: rows keep arriving while somebody is reading, and an offset would
  // quietly repeat or skip entries as the list shifts under them.
  audit: (params = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== "" && v != null) q.set(k, v);
    const s = q.toString();
    return request(`/audit${s ? "?" + s : ""}`);
  },
  // The verbs actually present, for the filter — built from the data rather than a
  // hardcoded list that would drift from what is really being recorded.
  auditActions: () => request("/audit/actions"),
  // forgotten password
  forgotPassword: (email) => request("/auth/forgot-password", { method: "POST", body: { email } }),
  verifyResetToken: (token) => request("/auth/reset-password/verify", { method: "POST", body: { token } }),
  resetPassword: (token, newPassword, code) => request("/auth/reset-password", { method: "POST", body: { token, newPassword, code } }),
  // activating an admin-created account from its invitation link
  verifyInvite: (token) => request("/auth/invite/verify", { method: "POST", body: { token } }),
  acceptInvite: (token, newPassword) => request("/auth/invite/accept", { method: "POST", body: { token, newPassword } }),
  resendInvite: (id) => request(`/staff/${id}/invite`, { method: "POST" }),
  // two-factor (authenticator app)
  totpSetup: (challengeToken) => request("/auth/totp/setup", { method: "POST", body: { challengeToken } }),
  totpEnable: (challengeToken, code) => request("/auth/totp/enable", { method: "POST", body: { challengeToken, code } }),
  totpVerify: (challengeToken, code) => request("/auth/totp/verify", { method: "POST", body: { challengeToken, code } }),
  totpDisable: (password) => request("/auth/totp", { method: "DELETE", body: { password } }),
  // permanently delete your own account (App Store / Play Store requirement)
  deleteAccount: (password, confirm, code) => request("/auth/account", { method: "DELETE", body: { password, confirm, code } }),
  // self-service sign-up (public) + admin approval queue
  signUp: (data) => request("/signup", { method: "POST", body: data }),
  // Admin password reset. `kind` is "staff" or "student" — one list, so the admin
  // picks a person rather than first choosing which kind of person they are.
  passwordPeople: () => request("/passwords/people"),
  setPassword: (kind, id, password, confirm) => request(`/passwords/${kind}/${id}`, { method: "PUT", body: { password, confirm } }),

  listSignups: (status) => request(`/signup${status ? `?status=${status}` : ""}`),
  // Correct a pending request without deciding it yet.
  updateSignup: (id, edits) => request(`/signup/${id}`, { method: "PUT", body: edits }),
  // `edits` carries any corrections the admin made to what the applicant typed.
  decideSignup: (id, status, note, allowance, edits) => request(`/signup/${id}/decision`, { method: "PUT", body: { status, note, allowance, ...(edits || {}) } }),

  // student app (each is scoped to the signed-in student on the server)
  studentMe: () => request("/student/me"),
  studentAttendance: () => request("/student/me/attendance"),
  studentAssessments: () => request("/student/me/assessments"),
  submitStudentQuery: (subject, message) => request("/student/me/query", { method: "POST", body: { subject, message } }),
  studentQueries: () => request("/student/me/queries"),
  studentTimetable: () => request("/student/me/timetable"),
  // NFC tap check-in. tapContext says whether the feature is on and which of this
  // student's classes are running; tapCheckIn writes the mark. sessionId is sent only
  // after an "ambiguous" reply, when two of their classes overlap.
  studentTapContext: () => request("/student/me/tap-context"),
  studentTapCheckIn: (tagCode, sessionId) => request("/student/me/tap-check-in", { method: "POST", body: { tagCode, ...(sessionId ? { sessionId } : {}) } }),
  studentQrCheckIn: (sessionId, code) => request("/student/me/qr-check-in", { method: "POST", body: { sessionId, code } }),

  // timetable (admin) — weekly slots scoped to course + year + term
  timetableCourses: () => request("/timetable/courses"),
  timetable: (courseId, year, termNumber) => { const q = new URLSearchParams({ courseId }); if (year != null && year !== "") q.set("year", year); if (termNumber != null && termNumber !== "") q.set("termNumber", termNumber); return request(`/timetable?${q.toString()}`); },
  timetableAutofill: (data) => request("/timetable/autofill", { method: "POST", body: data }),
  publishTimetable: (data) => request("/timetable/publish", { method: "POST", body: data }),
  saveTimetableCalendar: (data) => request("/timetable/calendar", { method: "PUT", body: data }),
  addTimetableSlot: (data) => request("/timetable/slots", { method: "POST", body: data }),
  updateTimetableSlot: (id, data) => request(`/timetable/slots/${id}`, { method: "PUT", body: data }),
  removeTimetableSlot: (id) => request(`/timetable/slots/${id}`, { method: "DELETE" }),

  // CELCAT-style timetabling. Two groups, and the split is the point: `myTimetable*`
  // is what every lecturer calls and needs no admin page, while `tt*` is the planner
  // and 403s for anyone without the "scheduling" page. Naming them apart keeps a
  // planner call from being pasted into a staff screen, where it would work for the
  // developer testing it as an admin and 403 for every real user of that screen.
  myTimetable: (from, to, type, ids) => {
    const q = new URLSearchParams({ from, to });
    // Sent only together. `type` without `ids` means "my own", which is the default
    // the server already applies — sending a bare type would be a no-op that reads
    // like a filter.
    if (type && ids?.length) { q.set("type", type); q.set("ids", ids.join(",")); }
    return request(`/my-timetable?${q.toString()}`);
  },
  myTimetableResources: (type, q = "", limit = 25) =>
    request(`/my-timetable/resources?${new URLSearchParams({ type, q, limit: String(limit) })}`),
  myTimetableSettings: () => request("/my-timetable/settings"),
  saveMyTimetableSettings: (patch) => request("/my-timetable/settings", { method: "PUT", body: patch }),

  ttRooms: () => request("/timetabling/rooms"),
  ttCreateRoom: (d) => request("/timetabling/rooms", { method: "POST", body: d }),
  ttUpdateRoom: (id, d) => request(`/timetabling/rooms/${id}`, { method: "PUT", body: d }),
  ttDeleteRoom: (id) => request(`/timetabling/rooms/${id}`, { method: "DELETE" }),

  ttCategories: () => request("/timetabling/categories"),
  ttCreateCategory: (d) => request("/timetabling/categories", { method: "POST", body: d }),
  ttUpdateCategory: (id, d) => request(`/timetabling/categories/${id}`, { method: "PUT", body: d }),
  ttDeleteCategory: (id) => request(`/timetabling/categories/${id}`, { method: "DELETE" }),

  ttEvents: (params) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
    return request(`/timetabling/events?${q.toString()}`);
  },
  ttCreateEvent: (d) => request("/timetabling/events", { method: "POST", body: d }),
  ttUpdateEvent: (id, d) => request(`/timetabling/events/${id}`, { method: "PUT", body: d }),
  ttDeleteEvent: (id) => request(`/timetabling/events/${id}`, { method: "DELETE" }),
  ttRepeatEvent: (id, d) => request(`/timetabling/events/${id}/repeat`, { method: "POST", body: d }),
  ttPublish: (d) => request("/timetabling/events/publish", { method: "POST", body: d }),

  ttSettings: () => request("/timetabling/settings"),
  ttSaveSettings: (patch) => request("/timetabling/settings", { method: "PUT", body: patch }),

  // SLC (admin) — Student Loans Company application tracking
  slcList: () => request("/slc"),
  addSlc: (data) => request("/slc", { method: "POST", body: data }),
  updateSlc: (id, data) => request(`/slc/${id}`, { method: "PUT", body: data }),
  removeSlc: (id) => request(`/slc/${id}`, { method: "DELETE" }),

  // attendance emails (admin) — banded month-end recognition/engagement emails
  attendanceEmailData: (from, to) => request("/attendance-emails/data" + (from && to ? `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : "")),
  attendanceEmailConfig: () => request("/attendance-emails/config"),
  saveAttendanceEmailConfig: (data) => request("/attendance-emails/config", { method: "PUT", body: data }),
  runAttendanceEmails: (opts = {}) => { const o = typeof opts === "boolean" ? { force: opts } : (opts || {}); return request("/attendance-emails/run", { method: "POST", body: { force: o.force !== false, from: o.from || undefined, to: o.to || undefined } }); },
  sendAttendanceEmailToStudent: (studentId, opts = {}) => request("/attendance-emails/send-one", { method: "POST", body: { studentId, from: opts.from || undefined, to: opts.to || undefined } }),

  // Admission Tracker — AGGREGATES ONLY. A separate endpoint from /admissions on
  // purpose: it is reachable by staff granted "admissions-tracker" who were
  // deliberately not granted "admissions", and it never returns an applicant row.
  admissionStats: (scope = {}) => {
    const q = new URLSearchParams();
    for (const k of ["intake", "course", "from", "to", "compare"]) if (scope[k]) q.set(k, scope[k]);
    const s = q.toString();
    return request(`/admission-stats${s ? `?${s}` : ""}`);
  },
  admissionTrackerSettings: () => request("/admission-stats/settings"),
  saveAdmissionTrackerSettings: (data) => request("/admission-stats/settings", { method: "PUT", body: data }),

  // admissions (admin) — HND application entries: create, list, edit, delete
  admissions: () => request("/admissions"),
  addAdmission: (data) => request("/admissions", { method: "POST", body: data }),
  updateAdmission: (id, data) => request(`/admissions/${id}`, { method: "PUT", body: data }),
  removeAdmission: (id) => request(`/admissions/${id}`, { method: "DELETE" }),
  // admissions — documents workflow (admin)
  requestAdmissionDocuments: (id) => request(`/admissions/${id}/request-documents`, { method: "POST" }),
  confirmAdmissionDocument: (docId, confirmed = true) => request(`/admissions/documents/${docId}/confirm`, { method: "PUT", body: { confirmed } }),
  removeAdmissionDocument: (docId) => request(`/admissions/documents/${docId}`, { method: "DELETE" }),
  admissionDocumentUrl: (docId) => request(`/admissions/documents/${docId}/file`),
  // admissions — decision (interview/enrol/studentId) + offer letter (admin)
  updateAdmissionStatus: (id, data) => request(`/admissions/${id}/status`, { method: "PUT", body: data }),
  sendAdmissionOffer: (id, data) => request(`/admissions/${id}/send-offer`, { method: "POST", body: data }),
  sendAdmissionInterviewInvite: (id, data) => request(`/admissions/${id}/send-interview-invite`, { method: "POST", body: data }),
  // admissions — server-generated PDF downloads (admin). Fetch the PDF as a Blob and
  // trigger a real file download. This works uniformly across Chrome, Firefox,
  // Safari/Mac and Edge, unlike the old window.open()+print() export (pop-up blockers,
  // Safari print quirks). The Authorization header mirrors request() exactly.
  downloadPdf: async (path, filename) => {
    const token = getToken();
    const res = await fetch(`${BASE}${path}`, { cache: "no-store", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    if (!res.ok) { let m = "Download failed"; try { m = (await res.json()).error || m; } catch (_) {} const e = new Error(m); e.status = res.status; throw e; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  },
  downloadAdmissionApplicationPdf: (id, filename) => api.downloadPdf(`/admission-pdf/${id}/application.pdf`, filename),
  downloadAdmissionOfferLetterPdf: (id, filename) => api.downloadPdf(`/admission-pdf/${id}/offer-letter.pdf`, filename),
  // admissions — applicant offer acceptance (PUBLIC: authed by the emailed token)
  offerInfo: async (token) => {
    const res = await fetch(`${BASE}/admission-offers/${encodeURIComponent(token)}`);
    const data = await res.json().catch(() => null);
    if (!res.ok) { const e = new Error(data?.error || `Could not load (${res.status})`); e.status = res.status; throw e; }
    return data;
  },
  acceptOffer: async (token) => {
    const res = await fetch(`${BASE}/admission-offers/${encodeURIComponent(token)}/accept`, { method: "POST" });
    const data = await res.json().catch(() => null);
    if (!res.ok) { const e = new Error(data?.error || `Could not accept (${res.status})`); e.status = res.status; throw e; }
    return data;
  },
  // ISM (Intention to Study Meeting) — admission interview records (admin)
  isms: () => request("/ism"),
  ismRoster: () => request("/ism/roster"),
  addIsm: (data) => request("/ism", { method: "POST", body: data }),
  updateIsm: (id, data) => request(`/ism/${id}`, { method: "PUT", body: data }),
  removeIsm: (id) => request(`/ism/${id}`, { method: "DELETE" }),
  // admissions config (admin) — the course + intake lists shown on the application form
  admissionCourseList: () => request("/admission-config/courses"),
  addAdmissionCourse: (name) => request("/admission-config/courses", { method: "POST", body: { name } }),
  updateAdmissionCourse: (id, data) => request(`/admission-config/courses/${id}`, { method: "PUT", body: data }),
  removeAdmissionCourse: (id) => request(`/admission-config/courses/${id}`, { method: "DELETE" }),
  admissionIntakeList: () => request("/admission-config/intakes"),
  addAdmissionIntake: (label) => request("/admission-config/intakes", { method: "POST", body: { label } }),
  updateAdmissionIntake: (id, data) => request(`/admission-config/intakes/${id}`, { method: "PUT", body: data }),
  removeAdmissionIntake: (id) => request(`/admission-config/intakes/${id}`, { method: "DELETE" }),
  // public: the course list for the application form's course dropdown (no login)
  applicationCourses: async () => {
    const res = await fetch(`${BASE}/admission-apply/courses`);
    const data = await res.json().catch(() => []);
    return Array.isArray(data) ? data : [];
  },
  // public: the intake list ("September 2026", …) for the application form (no login)
  applicationIntakes: async () => {
    const res = await fetch(`${BASE}/admission-apply/intakes`);
    const data = await res.json().catch(() => []);
    return Array.isArray(data) ? data : [];
  },
  // public: a prospective student submitting the application form (no login)
  submitApplication: async (data) => {
    const res = await fetch(`${BASE}/admission-apply`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    });
    const out = await res.json().catch(() => null);
    if (!res.ok) { const e = new Error(out?.error || `Could not submit (${res.status})`); e.status = res.status; throw e; }
    return out;
  },
  // admissions — applicant upload page (PUBLIC: authed by the emailed token, no login)
  admissionUploadInfo: async (token) => {
    const res = await fetch(`${BASE}/admission-uploads/${encodeURIComponent(token)}`);
    const data = await res.json().catch(() => null);
    if (!res.ok) { const e = new Error(data?.error || `Could not load (${res.status})`); e.status = res.status; throw e; }
    return data;
  },
  uploadAdmissionDoc: async (token, type, file) => {
    const res = await fetch(`${BASE}/admission-uploads/${encodeURIComponent(token)}?type=${encodeURIComponent(type)}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
      body: file,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) { const e = new Error(data?.error || `Upload failed (${res.status})`); e.status = res.status; throw e; }
    return data;
  },

  // ---- Applicant / Student Portal (a prospective student's own login) ----
  // register is PUBLIC (no token yet) and returns { token, user } so we sign in straight
  // away. Signing IN later uses the shared api.login (server returns kind:"applicant").
  applicantRegister: async (data) => {
    const res = await fetch(`${BASE}/applicant/register`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    });
    const out = await res.json().catch(() => null);
    if (!res.ok) { const e = new Error(out?.error || `Could not register (${res.status})`); e.status = res.status; throw e; }
    return out;
  },
  applicantCheckEmail: async (email) => {
    try {
      const res = await fetch(`${BASE}/applicant/check-email`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      return await res.json().catch(() => ({ valid: false, available: false }));
    } catch { return { valid: false, available: false }; }
  },
  // authed applicant calls — the stored kind:"applicant" token is attached by request()
  applicantMe: () => request("/applicant/me"),
  saveApplicantApplication: (data) => request("/applicant/me", { method: "PUT", body: data }),
  submitApplicantApplication: (data) => request("/applicant/me/submit", { method: "POST", body: data }),
  applicantDocuments: () => request("/applicant/documents"),
  applicantOffer: () => request("/applicant/offer"),
  acceptApplicantOffer: () => request("/applicant/offer/accept", { method: "POST" }),
  uploadApplicantDoc: async (type, file) => {
    const token = getToken();
    const res = await fetch(`${BASE}/applicant/documents?type=${encodeURIComponent(type)}`, {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
      body: file,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) { const e = new Error(data?.error || `Upload failed (${res.status})`); e.status = res.status; throw e; }
    return data;
  },
  downloadApplicantOfferLetter: (filename) => api.downloadPdf(`/applicant/offer-letter.pdf`, filename || "Offer Letter.pdf"),
  downloadApplicantApplication: (filename) => api.downloadPdf(`/applicant/application.pdf`, filename || "Application Form.pdf"),

  // admin: student queries tab
  listStudentQueries: (status) => request(`/student-queries${status ? `?status=${status}` : ""}`),
  respondStudentQuery: (id, response) => request(`/student-queries/${id}/respond`, { method: "PUT", body: { response } }),
  // notifications
  listNotifications: () => request("/notifications"),
  markNotificationsRead: () => request("/notifications/read", { method: "PUT" }),
  markNotificationRead: (id) => request(`/notifications/${id}/read`, { method: "PUT" }),
  clearNotifications: () => request("/notifications", { method: "DELETE" }),
  // push-notification devices
  registerDevice: (token, platform) => request("/devices", { method: "POST", body: { token, platform } }),
  unregisterDevice: (token) => request("/devices", { method: "DELETE", body: { token } }),
  listDevices: () => request("/devices"),
  // staff
  listStaff: () => request("/staff"),
  addStaff: (data) => request("/staff", { method: "POST", body: data }),
  updateStaff: (id, data) => request(`/staff/${id}`, { method: "PUT", body: data }),
  removeStaff: (id) => request(`/staff/${id}`, { method: "DELETE" }),
  resetStaffTotp: (id) => request(`/staff/${id}/totp`, { method: "DELETE" }),
  // Super-admin only: set which admin pages a staff member may access.
  // pages: array of page keys, or null to clear the restriction (full access).
  //
  // `supportDepartments` — which support-department queues this person works — rides
  // on the same call because it is set from the same screen and the two are one
  // administrative decision: the "referrals" page opens the feature, the membership
  // list decides which queues within it, and granting one without the other produces a
  // person who can open Referrals and see nothing.
  //
  // It is OMITTED ENTIRELY when the caller does not pass it, rather than sent as [].
  // Those say different things to the server — `undefined` means "leave membership
  // alone", null or [] means "remove them from every department" — and every caller
  // that predates this feature passes two arguments, so an absent third must never be
  // read as a clear-out.
  updateStaffAccess: (id, pages, supportDepartments) => request(`/staff/${id}/access`, {
    method: "PUT",
    body: { pages, ...(supportDepartments === undefined ? {} : { supportDepartments }) },
  }),
  // check-ins
  listCheckins: (date) => request(`/checkins${date ? `?date=${date}` : ""}`),
  checkIn: (site) => request("/checkins/check-in", { method: "POST", body: site ? { site } : {} }),
  // Clocking in by touching a sticker. No site is sent: the tap proves Onsite, and the
  // server refuses to record anything else for this route.
  tapCheckIn: (tagCode) => request("/checkins/tap-check-in", { method: "POST", body: { tagCode } }),
  // Reachable by ANY signed-in staff member, unlike api.tapSettings() below, whose whole
  // router needs the NFC Tags admin page. The check-in screen asks this one.
  staffTapSettings: () => request("/checkins/tap-settings"),
  checkOut: (id) => request(`/checkins/${id}/check-out`, { method: "POST" }),
  upsertCheckin: (data) => request("/checkins", { method: "PUT", body: data }),
  saveSummary: (date, summary) => request("/checkins/summary", { method: "PUT", body: { date, summary } }),
  // leave
  listLeave: () => request("/leave"),
  requestLeave: (data) => request("/leave", { method: "POST", body: data }),
  // Cancel/withdraw a booking and return the days to the allowance.
  cancelLeave: (id) => request(`/leave/${id}`, { method: "DELETE" }),
  decideLeave: (id, status, note) => request(`/leave/${id}/decision`, { method: "PUT", body: { status, note } }),
  // adjustments
  listAdjustments: () => request("/adjustments"),
  addAdjustment: (data) => request("/adjustments", { method: "POST", body: data }),
  removeAdjustment: (id) => request(`/adjustments/${id}`, { method: "DELETE" }),
  // documents
  listDocuments: () => request("/documents"),
  addDocument: (data) => request("/documents", { method: "POST", body: data }),
  deleteDocument: (id) => request(`/documents/${id}`, { method: "DELETE" }),
  // Upload the RAW file. Deliberately not the JSON `request` helper: that would
  // JSON.stringify a File into "{}", and base64-in-JSON would inflate every upload by
  // a third. The filename travels in a header because the body is the file itself.
  uploadDocumentFile: async (id, file) => {
    const token = getToken();
    const res = await fetch(`${BASE}/documents/${id}/file`, {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": file.type || "application/octet-stream",
        // Header values must be latin-1, and a filename can be anything at all.
        "X-File-Name": encodeURIComponent(file.name),
      },
      body: file,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) { const e = new Error(data?.error || `Upload failed (${res.status})`); e.status = res.status; e.body = data; throw e; }
    return data;
  },
  // A short-lived signed link. The server checks access BEFORE it signs.
  documentDownloadUrl: (id) => request(`/documents/${id}/download`),
  // HND attendance registers
  listSemesters: () => request("/hnd/semesters"),
  addSemester: (data) => request("/hnd/semesters", { method: "POST", body: data }),
  updateSemester: (id, data) => request(`/hnd/semesters/${id}`, { method: "PUT", body: data }),
  removeSemester: (id) => request(`/hnd/semesters/${id}`, { method: "DELETE" }),
  listCourses: () => request("/hnd/courses"),
  addCourse: (data) => request("/hnd/courses", { method: "POST", body: data }),
  updateCourse: (id, data) => request(`/hnd/courses/${id}`, { method: "PUT", body: data }),
  removeCourse: (id) => request(`/hnd/courses/${id}`, { method: "DELETE" }),
  // Cohorts (intakes under a course, e.g. "SEP 2025")
  listCohorts: (courseId) => request(`/hnd/cohorts${courseId ? `?courseId=${encodeURIComponent(courseId)}` : ""}`),
  addCohort: (data) => request("/hnd/cohorts", { method: "POST", body: data }),
  updateCohort: (id, data) => request(`/hnd/cohorts/${id}`, { method: "PUT", body: data }),
  removeCohort: (id) => request(`/hnd/cohorts/${id}`, { method: "DELETE" }),
  // Terms (6 per cohort: Y1 T1-3, Y2 T1-3)
  listTerms: (cohortId) => request(`/hnd/terms${cohortId ? `?cohortId=${encodeURIComponent(cohortId)}` : ""}`),
  generateTerms: (cohortId, data) => request(`/hnd/cohorts/${cohortId}/terms/generate`, { method: "POST", body: data || {} }),
  updateTerm: (id, data) => request(`/hnd/terms/${id}`, { method: "PUT", body: data }),
  removeTerm: (id) => request(`/hnd/terms/${id}`, { method: "DELETE" }),
  listUnits: () => request("/hnd/units"),
  addUnit: (data) => request("/hnd/units", { method: "POST", body: data }),
  updateUnit: (id, data) => request(`/hnd/units/${id}`, { method: "PUT", body: data }),
  removeUnit: (id) => request(`/hnd/units/${id}`, { method: "DELETE" }),
  setUnitEnrolments: (id, studentIds) => request(`/hnd/units/${id}/enrolments`, { method: "PUT", body: { studentIds } }),
  generateSessions: (id, data) => request(`/hnd/units/${id}/sessions/generate`, { method: "POST", body: data }),
  listStudents: () => request("/hnd/students"),
  addStudent: (data) => request("/hnd/students", { method: "POST", body: data }),
  updateStudent: (id, data) => request(`/hnd/students/${id}`, { method: "PUT", body: data }),
  removeStudent: (id) => request(`/hnd/students/${id}`, { method: "DELETE" }),
  setEnrolments: (id, unitIds) => request(`/hnd/students/${id}/enrolments`, { method: "PUT", body: { unitIds } }),
  listSessions: (unitId) => request(`/hnd/sessions${unitId ? `?unitId=${unitId}` : ""}`),
  addSession: (data) => request("/hnd/sessions", { method: "POST", body: data }),
  updateSession: (id, data) => request(`/hnd/sessions/${id}`, { method: "PUT", body: data }),
  // `override:true` forces deletion of a term-locked register (server replies 423 without it).
  removeSession: (id, override) => request(`/hnd/sessions/${id}`, { method: "DELETE", body: override ? { override: true } : undefined }),
  getRegister: (sessionId) => request(`/hnd/sessions/${sessionId}/register`),
  saveRegister: (sessionId, marks, override) => request(`/hnd/sessions/${sessionId}/register`, { method: "PUT", body: { marks, ...(override ? { override: true } : {}) } }),
  // The lecturer's live view: who is in, who is late, who has not appeared, and the
  // minute each of them tapped. Polled while a class is running.
  sessionLive: (sessionId) => request(`/hnd/sessions/${sessionId}/live`),
  sessionQr: (sessionId) => request(`/hnd/sessions/${sessionId}/qr-code`),
  // scope "all" asks for every class running today rather than only the caller's own.
  // Refused with 403 unless they hold registers/students/executive, so the screen only
  // offers it when the server says it may.
  mySessionsToday: (scope) => request("/hnd/my-sessions/today" + (scope === "all" ? "?scope=all" : "")),
  // Which self check-in methods are on, for the Registers page to decide whether a
  // session row offers a "QR code" action at all.
  checkInSettings: () => request("/hnd/check-in-settings"),
  // The ONLY route from tap check-in to an absence, and it takes a named human.
  markRemainingAbsent: (sessionId, override) => request(`/hnd/sessions/${sessionId}/mark-remaining-absent`, { method: "POST", body: override ? { override: true } : {} }),

  // --- NFC tags (admin) ---
  tags: () => request("/tags"),
  // `code` is optional: supplied when an admin registers a blank sticker by tapping it,
  // omitted when the server should generate a secret to be written onto one.
  createTag: (label, code) => request("/tags", { method: "POST", body: { label, ...(code ? { code } : {}) } }),
  updateTag: (id, patch) => request(`/tags/${id}`, { method: "PATCH", body: patch }),
  tagLog: (id) => request(`/tags/${id}/log`),
  tapSettings: () => request("/tags/settings"),
  saveTapSettings: (patch) => request("/tags/settings", { method: "PUT", body: patch }),
  // semesterId: "" = all semesters, "unassigned" = sessions outside every semester
  getAttendance: (semesterId, termId) => request(`/hnd/attendance${termId ? `?termId=${encodeURIComponent(termId)}` : semesterId ? `?semesterId=${encodeURIComponent(semesterId)}` : ""}`),
  // year/termNumber scope to a curriculum stage ("Year 1 · Term 2") by narrowing to
  // the units taught at that point in the course.
  attendanceMonthly: (opts = {}) => { const q = new URLSearchParams(); if (opts.studentId) q.set("studentId", opts.studentId); if (opts.unitId) q.set("unitId", opts.unitId); if (opts.courseId) q.set("courseId", opts.courseId); if (opts.year) q.set("year", opts.year); if (opts.termNumber) q.set("termNumber", opts.termNumber); const s = q.toString(); return request(`/hnd/attendance/monthly${s ? `?${s}` : ""}`); },
  // A student's attendance grouped by term (current + previous terms).
  studentTermAttendance: (id) => request(`/hnd/students/${id}/attendance-terms`),
  // PAT (Personal Academic Tutor) interactions
  listInteractions: (params = {}) => { const q = new URLSearchParams(params).toString(); return request(`/interactions${q ? `?${q}` : ""}`); },
  addInteraction: (data) => request("/interactions", { method: "POST", body: data }),
  updateInteraction: (id, data) => request(`/interactions/${id}`, { method: "PUT", body: data }),
  removeInteraction: (id) => request(`/interactions/${id}`, { method: "DELETE" }),
  // Predictive analysis — progression risk.
  //
  // recalculate() is bounded server-side and may leave students outstanding, so its
  // response carries `remaining`; the screen re-runs until that reaches zero rather
  // than assuming one press did the whole college. It gets a long timeout because it
  // scores up to 500 students synchronously.
  predictionSettings: () => request("/prediction/settings"),
  savePredictionSettings: (config) => request("/prediction/settings", { method: "PUT", body: { config } }),
  resetPredictionSettings: () => request("/prediction/settings", { method: "DELETE" }),
  predictionSummary: () => request("/prediction/summary"),
  predictionStudents: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null)).toString();
    return request(`/prediction/students${q ? `?${q}` : ""}`);
  },
  predictionStudent: (id) => request(`/prediction/students/${id}`),
  predictionOutcomes: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();
    return request(`/prediction/outcomes${q ? `?${q}` : ""}`);
  },
  predictionRecordOutcome: (body) => request("/prediction/outcomes", { method: "POST", body }),
  predictionCalibration: () => request("/prediction/outcomes/calibration"),
  predictionRecalculate: (body = {}) => request("/prediction/recalculate", { method: "POST", body, timeoutMs: 120000 }),
  listInterventions: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null)).toString();
    return request(`/prediction/interventions${q ? `?${q}` : ""}`);
  },
  addIntervention: (body) => request("/prediction/interventions", { method: "POST", body }),
  updateIntervention: (id, body) => request(`/prediction/interventions/${id}`, { method: "PUT", body }),

  // Mitigating circumstances.
  //
  // Its own page, and therefore its own permission: a college can grant "see the risk
  // register" without granting "read why each student is on it". A claim is usually
  // health data — illness, bereavement, mental health — and the server never lets any of
  // it reach the prediction pipeline. This screen shows it because the people granted
  // this page are the ones deciding the claims.
  listMitigations: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null)).toString();
    return request(`/mitigations${q ? `?${q}` : ""}`);
  },
  addMitigation: (body) => request("/mitigations", { method: "POST", body }),
  updateMitigation: (id, body) => request(`/mitigations/${id}`, { method: "PATCH", body }),
  removeMitigation: (id) => request(`/mitigations/${id}`, { method: "DELETE" }),
  addMitigationAdjustment: (id, body) => request(`/mitigations/${id}/adjustments`, { method: "POST", body }),
  removeMitigationAdjustment: (id, adjustmentId) =>
    request(`/mitigations/${id}/adjustments/${adjustmentId}`, { method: "DELETE" }),

  // Referrals to support departments (Wellbeing, ASK, Student Support, or whatever
  // this college calls its own).
  //
  // TWO ROUTES RETURN A REFERRAL AND THEY ARE NOT THE SAME OBJECT. `listReferrals`
  // is the RECEIVING department's view and carries the case notes and the free text
  // written at closure; `myReferrals` is the view of the tutor who raised it and is
  // built by a server-side allowlist that names neither. That asymmetry is the whole
  // confidentiality model, so nothing in this client should ever call one route to
  // fill in fields the other withheld — the omission is the feature, not a gap.
  //
  // Both are gated on the "referrals" page, and the queue additionally on membership:
  // asking for a department you are not on is a 403, deliberately, because an empty
  // queue and a queue you may not read are different answers.
  referralDepartments: () => request("/referrals/departments"),
  // Replaces the whole list — the editor edits all of it, and retiring a department
  // has to be expressible. Needs "settings" as well as "referrals" on the server.
  saveReferralDepartments: (departments) => request("/referrals/departments", { method: "PUT", body: { departments } }),
  listReferrals: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null)).toString();
    return request(`/referrals${q ? `?${q}` : ""}`);
  },
  myReferrals: () => request("/referrals/mine"),
  addReferral: (body) => request("/referrals", { method: "POST", body }),
  acceptReferral: (id) => request(`/referrals/${id}/accept`, { method: "PUT" }),
  saveReferralNotes: (id, notes) => request(`/referrals/${id}/notes`, { method: "PUT", body: { notes } }),
  // `outcome` is required and the server 400s without it, so the screen must never
  // offer a close button that has not collected one.
  closeReferral: (id, body) => request(`/referrals/${id}/close`, { method: "PUT", body }),

  // Handing a case to another desk. The server archives the sending team's case notes
  // onto the transfer row and CLEARS them from the referral, so the receiving team
  // starts from the referrer's reason and not from somebody else's record of a
  // disclosure. Nothing in this client should try to read them back.
  transferReferral: (id, body) => request(`/referrals/${id}/transfer`, { method: "PUT", body }),
  // Where the case has been. Each entry carries `notesAtTransfer` ONLY when the caller
  // is on the department that wrote them — so the field is absent rather than empty for
  // everybody else, and a screen must not treat absent as "they wrote nothing".
  referralHistory: (id) => request(`/referrals/${id}/history`),
  // The referrer/department conversation, which is a THIRD visibility and not a window
  // onto the case notes: everything in this thread is shared with both parties by
  // construction. The server scopes what comes back by department, so after a transfer
  // the receiving team sees its own thread and not the previous team's.
  referralMessages: (id) => request(`/referrals/${id}/messages`),
  addReferralMessage: (id, body) => request(`/referrals/${id}/messages`, { method: "POST", body: { body } }),

  // assessments (gradebook)
  listAssessments: (unitId) => request(`/assessments${unitId ? `?unitId=${unitId}` : ""}`),
  addAssessment: (data) => request("/assessments", { method: "POST", body: data }),
  updateAssessment: (id, data) => request(`/assessments/${id}`, { method: "PUT", body: data }),
  removeAssessment: (id) => request(`/assessments/${id}`, { method: "DELETE" }),
  getGrades: (id) => request(`/assessments/${id}/grades`),
  saveGrades: (id, grades) => request(`/assessments/${id}/grades`, { method: "PUT", body: { grades } }),
  listGrades: (params = {}) => { const q = new URLSearchParams(params).toString(); return request(`/assessments/grades${q ? `?${q}` : ""}`); },
  assessmentOverview: () => request("/assessments/overview"),
  // Admin gradebook view of ONE student. Deliberately named differently from the
  // student app's `studentAssessments` (their own results) — when both keys shared a
  // name the later one silently won and broke the student "My Results" screen.
  adminStudentAssessments: (studentId) => request(`/assessments/student/${studentId}`),

  // assessment tracker — the management view over assessment progress.
  //
  // The two writes go to narrow, single-purpose endpoints rather than to the general
  // unit and assessment updaters. Those live behind guards that also protect deleting
  // a unit and reading student marks, and a tracker admin holds neither; see the
  // comments on the routes themselves.
  assessmentTracker: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return request(`/assessment-tracker${q ? `?${q}` : ""}`);
  },
  assessmentTrackerSetup: () => request("/assessment-tracker/setup"),
  // "" clears the leader — the server reads an empty string as "not recorded".
  setUnitLeader: (unitId, leaderStaffId) =>
    request(`/hnd/units/${unitId}/leader`, { method: "PUT", body: { leaderStaffId } }),
  setMarkingDeadline: (assessmentId, markingDueDate) =>
    request(`/assessments/${assessmentId}/marking-deadline`, { method: "PUT", body: { markingDueDate } }),
  execSummary: () => request("/assessments/exec-summary"),
  // staff reviews (Strategic Self-Reflection, Monthly Performance & Support)
  // The question definitions come FROM the server, so a new form or a reworded
  // question needs no client release.
  reviewForms: () => request("/staff-reviews/forms"),
  // A staff member's OWN reflections, from the staff app. staffId is never sent —
  // the server always uses the signed-in user, so there is no id to tamper with.
  // Student reviews — a lecturer's record of a progress conversation. The scope is
  // decided by the server from the token: staff see their own, students see the ones
  // about them, admins see everything.
  // A lecturer's teaching load: their units, attendance, marking outstanding.
  staffTeaching: (id) => request(`/hnd/staff/${id}/teaching`),
  studentReviewOptions: () => request("/student-reviews/options"),
  // The student/unit pickers. Deliberately NOT listStudents()/listUnits(): those live on
  // /api/hnd, which is gated on page grants an ordinary lecturer doesn't hold, so the
  // pickers 403'd for exactly the staff the feature is for. This one is open to anyone
  // who may write a review and returns only what a dropdown needs.
  studentReviewRoster: () => request("/student-reviews/roster"),
  listStudentReviews: (params = {}) => { const q = new URLSearchParams(params).toString(); return request(`/student-reviews${q ? `?${q}` : ""}`); },
  myStudentReviews: () => request("/student-reviews?mine=true"),
  studentReviewsAboutMe: () => request("/student/me/reviews"),
  // The referrals this student was TOLD about. The server filters on studentNotified,
  // so a referral raised with the tickbox off is not in this list — which is the whole
  // point of the tickbox, and the reason this client must never try to widen it.
  studentReferrals: () => request("/student/me/referrals"),
  addStudentReview: (data) => request("/student-reviews", { method: "POST", body: data }),
  updateStudentReview: (id, data) => request(`/student-reviews/${id}`, { method: "PUT", body: data }),
  removeStudentReview: (id) => request(`/student-reviews/${id}`, { method: "DELETE" }),
  myReviewForms: () => request("/my-reviews/forms"),
  listMyReviews: () => request("/my-reviews"),
  addMyReview: (data) => request("/my-reviews", { method: "POST", body: data }),
  updateMyReview: (id, data) => request(`/my-reviews/${id}`, { method: "PUT", body: data }),
  removeMyReview: (id) => request(`/my-reviews/${id}`, { method: "DELETE" }),
  listStaffReviews: (params = {}) => { const q = new URLSearchParams(params).toString(); return request(`/staff-reviews${q ? `?${q}` : ""}`); },
  getStaffReview: (id) => request(`/staff-reviews/${id}`),
  addStaffReview: (data) => request("/staff-reviews", { method: "POST", body: data }),
  updateStaffReview: (id, data) => request(`/staff-reviews/${id}`, { method: "PUT", body: data }),
  removeStaffReview: (id) => request(`/staff-reviews/${id}`, { method: "DELETE" }),
  // timesheets
  listTimesheets: (params = {}) => { const q = new URLSearchParams(params).toString(); return request(`/timesheets${q ? `?${q}` : ""}`); },
  // Who is in today, across the whole college — open to any member of staff.
  staffOnSite: (date) => request(`/checkins/on-site${date ? `?date=${date}` : ""}`),
  timesheetPendingCount: () => request("/timesheets/pending-count"),
  addTimesheet: (data) => request("/timesheets", { method: "POST", body: data }),
  updateTimesheet: (id, data) => request(`/timesheets/${id}`, { method: "PUT", body: data }),
  removeTimesheet: (id) => request(`/timesheets/${id}`, { method: "DELETE" }),
  submitTimesheet: (month) => request("/timesheets/submit", { method: "POST", body: { month } }),
  reviewTimesheet: (staffId, month, decision, note) => request("/timesheets/review", { method: "POST", body: { staffId, month, decision, note } }),
  // Moodle (VLE). preview writes nothing; sync imports courses, units, assessments,
  // students and marks. sync only STARTS the run and returns — reading a whole VLE
  // can outlast a proxy's request timeout — so poll moodleStatus() for the result.
  moodleStatus: () => request("/moodle/status"),
  // Canvas is READ-ONLY here: a preview reports what an import would find and writes
  // nothing. There is deliberately no canvasSync() — nothing writes Canvas data yet,
  // and a sync call that imported nothing would read as a working integration.
  canvasStatus: () => request("/canvas/status"),
  canvasPreview: () => request("/canvas/preview", { timeoutMs: 120000 }),
  // A preview reads every course, every enrolment and every grade item in the VLE, so
  // it legitimately outlives the default deadline.
  moodlePreview: () => request("/moodle/preview", { timeoutMs: 180000 }),
  moodleSync: () => request("/moodle/sync", { method: "POST" }),
};
