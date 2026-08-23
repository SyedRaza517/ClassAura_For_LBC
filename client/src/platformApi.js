// API client for the PLATFORM surface — the tier above every institution.
//
// Deliberately separate from api.js, with its own storage key. A platform operator
// and a college administrator are different people with different reach, and sharing
// one token slot would mean signing into one silently signs you out of the other —
// or worse, that a stale token from one is sent to the other's endpoints.
const API_PORT = 4000;

function resolveBase() {
  const configured = import.meta.env.VITE_API_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (typeof window !== "undefined") {
    const { protocol, hostname } = window.location;
    if (protocol.startsWith("http") && hostname) return `${protocol}//${hostname}:${API_PORT}/api`;
  }
  return `http://localhost:${API_PORT}/api`;
}
const BASE = resolveBase();

// Its own key, never "lbc_token"/"edtech_token".
const KEY = "edtech_platform_token";
// sessionStorage, not localStorage: this account can read every customer's data, so
// closing the tab should end the session rather than leave it sitting on disk.
const store = () => window.sessionStorage;

export const getPlatformToken = () => { try { return store().getItem(KEY); } catch { return null; } };
export const setPlatformToken = (t) => {
  try { if (t) store().setItem(KEY, t); else store().removeItem(KEY); } catch { /* ignore */ }
};

async function request(path, { method = "GET", body, timeoutMs = 30000, prefix = "/platform" } = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = getPlatformToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(BASE + prefix + path, {
      method, headers, cache: "no-store", signal: controller?.signal,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e?.name === "AbortError") throw new Error("The server took too long to respond. Check your connection and try again.");
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (res.status === 401) {
    setPlatformToken(null);
    window.dispatchEvent(new CustomEvent("platform-signed-out"));
    throw new Error("Your session has expired. Please sign in again.");
  }

  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const platformApi = {
  login: (email, password) => request("/login", { method: "POST", body: { email, password } }),
  me: () => request("/me"),
  overview: () => request("/overview"),
  // Deliberately not loaded with the dashboard: it reads pg_class and counts every
  // tenanted table, so it is asked for on demand rather than on open.
  usage: () => request("/usage", { timeoutMs: 60000 }),
  // Is this SERVER configured — credential storage, email, file storage?
  health: () => request("/health"),
  // Organisations applying to join. These live under /registrations, not /platform,
  // because two of that router's routes are public — see routes/registrations.js.
  registrations: (status) => request("/registrations" + (status ? "?status=" + encodeURIComponent(status) : ""), { prefix: "" }),
  approveRegistration: (id, note) => request(`/registrations/${id}/approve`, { method: "POST", body: { note }, prefix: "" }),
  rejectRegistration: (id, note) => request(`/registrations/${id}/reject`, { method: "POST", body: { note }, prefix: "" }),
  // Restoring access to a college that has locked itself out. Both calls are scoped to
  // one institution and reach only its ADMINISTRATORS — see routes/platform.js.
  collegeAdmins: (tenantId) => request(`/tenants/${tenantId}/admins`),
  resetCollegeAdmin: (tenantId, staffId, password, newPassword) =>
    request(`/tenants/${tenantId}/admins/${staffId}/password`, { method: "PUT", body: { password, newPassword } }),
  // The second step of signing in. Takes the challenge token, not a session — the
  // session does not exist until the code is right.
  loginVerify: (challengeToken, code) => request("/login/verify", { method: "POST", body: { challengeToken, code } }),
  twoFactorSetup: (password) => request("/2fa/setup", { method: "POST", body: { password } }),
  twoFactorEnable: (code) => request("/2fa/enable", { method: "POST", body: { code } }),
  twoFactorDisable: (password, code) => request("/2fa/disable", { method: "POST", body: { password, code } }),
  createTenant: (payload) => request("/tenants", { method: "POST", body: payload }),
  setActive: (id, active) => request(`/tenants/${id}/active`, { method: "PUT", body: { active } }),
  deleteTenant: (id, confirm) => request(`/tenants/${id}`, { method: "DELETE", body: { confirm } }),
  listAdmins: () => request("/admins"),
  createAdmin: (payload) => request("/admins", { method: "POST", body: payload }),
  // Deactivate (or restore) an operator. Not a delete — the server keeps the row so the
  // platform log's "by=<email>" lines still resolve to a person; see the note on the
  // route. Deactivating also bumps the operator's tokenVersion, so any session they
  // still have open dies on its next request rather than at its 8-hour expiry.
  setAdminActive: (id, active) => request(`/admins/${id}/active`, { method: "PUT", body: { active } }),
};
