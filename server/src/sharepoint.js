// SharePoint document storage, via Microsoft Graph (app-only / client credentials).
//
// Talks to the Microsoft Graph REST API with plain fetch rather than pulling in
// @microsoft/microsoft-graph-client or @azure/identity — the same choice moodle.js
// and storage.js make, and for the same reason: a handful of endpoints do not justify
// two dependencies (plus their transitive weight), and it keeps the server's install
// small on a free-tier host running Node 22, whose global fetch is all we need.
//
// AUTH IS APP-ONLY. There is no signed-in user here — the server authenticates AS
// itself with a client id + secret (the OAuth2 client-credentials grant) and acts with
// whatever application permissions the tenant admin has granted the app registration
// (typically Sites.ReadWrite.All or a Sites.Selected grant scoped to the one site). The
// client secret bypasses any per-user access and so must never reach the browser; it is
// read here only, server-side, behind the route guards.
//
// WHAT THIS STORES. Admissions keeps a folder per applicant under one base folder in a
// SharePoint document library; each applicant's supporting documents (ID, quals, etc.)
// are uploaded into their folder. This module resolves the site → drive → base folder
// once, then creates the per-applicant folders and uploads files into them.
//
// Env is read at CALL TIME (via the little `() =>` readers below and direct process.env
// reads), exactly like storage.js, so a value set late in boot — or in a test — still
// takes effect rather than being frozen at require() time.

// --- Configuration (all read at call time) ---------------------------------------
// Prefer what THIS institution saved over the server-wide environment. Primed once
// per request at the choke points below; peek() falls back to process.env, so a
// deployment configured by environment behaves exactly as it always did.
const cfg = require("./integrationConfig");
const TENANT_ID = () => cfg.peek("sharepoint").tenantId || "";
const CLIENT_ID = () => cfg.peek("sharepoint").clientId || "";
const CLIENT_SECRET = () => cfg.peek("sharepoint").clientSecret || "";

// Site can be given a few ways (whichever is easiest): the full site URL in SP_SITE_URL
// (e.g. https://contoso.sharepoint.com/sites/Admissions), an explicit Graph site id in
// SP_SITE_ID, or the split SP_SITE_HOST + SP_SITE_PATH. A full URL pasted into ANY of the
// SP_SITE_* vars is also understood, so a copy from the browser's address bar just works.
const SITE_ID = () => cfg.peek("sharepoint").siteId || "";
const SITE_HOST = () => cfg.peek("sharepoint").siteHost || "";
const SITE_PATH = () => cfg.peek("sharepoint").sitePath || "";
const SITE_URL = () => cfg.peek("sharepoint").siteUrl || "";

// Derive { host, path } from whatever site config was supplied. A full URL (in SP_SITE_URL
// or accidentally in SP_SITE_ID/HOST/PATH) is parsed; a "/sites/<name>" or "/teams/<name>"
// path is kept and any trailing library/view segment (…/Documents/Forms/AllItems.aspx) is
// dropped. Otherwise the split host + path are used as given.
function siteHostAndPath() {
  const cand = [SITE_URL(), SITE_ID(), SITE_HOST(), SITE_PATH()].map((s) => String(s || "").trim());
  // Treat a candidate as a FULL URL only if it has a scheme (://) OR a "domain/sites/…"
  // (or /teams/) shape. A BARE host ("x.sharepoint.com") or a BARE path ("/sites/x") must
  // NOT match — otherwise a split SP_SITE_HOST + SP_SITE_PATH gets parsed as a pathless URL
  // and the path is silently dropped.
  const urlLike = cand.find((s) => s.includes("://") || /[a-z0-9][a-z0-9.-]*\.[a-z]{2,}\/(sites|teams)\//i.test(s));
  if (urlLike) {
    try {
      const u = new URL(urlLike.includes("://") ? urlLike : `https://${urlLike}`);
      let p = u.pathname || "";
      const m = p.match(/\/(sites|teams)\/[^/]+/i); // keep just /sites/<name>
      p = m ? m[0] : p.replace(/\/+$/, "");
      return { host: u.hostname, path: p };
    } catch (_) { /* fall through to the split host/path */ }
  }
  let host = SITE_HOST().trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  let path = SITE_PATH().trim();
  if (path && !path.startsWith("/")) path = `/${path}`;
  return { host, path };
}

// Optional overrides for which document library to use. Either the opaque drive id, OR
// its display name (e.g. "09  Admissions"), which the server resolves among the site's
// libraries — much friendlier than looking up an id. If neither is set, the site's
// default library ("Documents") is used.
const DRIVE_ID = () => cfg.peek("sharepoint").driveId || "";
const DRIVE_NAME = () => cfg.peek("sharepoint").driveName || "";
// The base folder under which the Course / Intake / Student tree is created. EMPTY (the
// default) means create that tree DIRECTLY in the chosen library's root. Set this only if
// you want an extra wrapper folder inside the library.
const ROOT_FOLDER = () => cfg.peek("sharepoint").rootFolder || "";

// The Graph service root. v1.0 is the stable channel; nothing here needs /beta.
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// A single request may not exceed this. Applicant documents are photos and PDFs of a
// few MB; 15MB is generous while keeping one upload from exhausting a small instance.
// A simple PUT upload is also only valid up to 250MB, so staying well under that means
// we never need the (much more involved) chunked upload-session path.
const MAX_BYTES = 15 * 1024 * 1024;

// All three credentials are required, AND a way to identify the site: either an explicit
// SP_SITE_ID, or both halves of the host+path pair to resolve one. Anything less and the
// module can't do useful work, so the app treats it as switched off.
function isConfigured() {
  const creds = Boolean(TENANT_ID() && CLIENT_ID() && CLIENT_SECRET());
  // A real Graph site id contains commas (host,siteGuid,webGuid). Otherwise we need a
  // host + path, which siteHostAndPath derives from a URL or the split vars.
  const idIsReal = SITE_ID().includes(",");
  const { host, path } = siteHostAndPath();
  return creds && Boolean(idIsReal || (host && path));
}

// One line for the startup banner, so a deployment missing its SharePoint config says so
// out loud rather than failing the first time somebody uploads an applicant's documents.
function describe() {
  if (!isConfigured()) {
    return 'not configured (set SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET and SP_SITE_ID to enable SharePoint uploads)';
  }
  const { host, path } = siteHostAndPath();
  const site = SITE_ID().includes(",") ? SITE_ID() : `${host}${path}`;
  const lib = DRIVE_ID() ? `drive ${DRIVE_ID()}` : DRIVE_NAME() ? `library "${DRIVE_NAME()}"` : "default library";
  const base = ROOT_FOLDER().trim() ? `folder "${ROOT_FOLDER().trim()}"` : "library root";
  return `SharePoint (site ${site}, ${lib}, base ${base})`;
}

// --- Access token (client-credentials grant, cached) -----------------------------
// One token serves every request until it is close to expiring. Fetching a fresh token
// on every call would triple the traffic and slow each upload; caching it — and renewing
// ~60s before Azure's stated expiry to leave a safety margin against clock skew and
// in-flight requests — keeps things quick without ever presenting a stale token.
// PER TENANT, not per process. These four caches previously held one institution's
// OAuth token, site, document library and root folder for the whole server. Because
// getAccessToken() and the resolve* functions returned the cached value BEFORE
// consulting configuration, the first college to touch SharePoint after a restart
// captured every other college's uploads: college B's applicant documents were
// written into college A's library, where A could read them and B could not. The
// three id caches had no TTL at all, so it persisted until the next deploy.
const tokenCache = new Map();       // tenantId -> { value, expiresAt }
const EMPTY_TOKEN = { value: null, expiresAt: 0 };
const tenantKey = () => currentTenantId() || "__no_tenant__";

async function getAccessToken() {
  await cfg.load("sharepoint");
  const cached = tokenCache.get(tenantKey()) || EMPTY_TOKEN;
  if (cached.value && Date.now() < cached.expiresAt) return cached.value;

  const tenant = TENANT_ID();
  if (!tenant || !CLIENT_ID() || !CLIENT_SECRET()) {
    throw new Error("SharePoint credentials are not configured (set SP_TENANT_ID, SP_CLIENT_ID and SP_CLIENT_SECRET).");
  }

  const body = new URLSearchParams({
    client_id: CLIENT_ID(),
    client_secret: CLIENT_SECRET(),
    grant_type: "client_credentials",
    // ".default" asks for exactly the application permissions granted to the app
    // registration in Azure AD — you don't list scopes for app-only, you consent to them
    // once as an admin and ".default" says "give me all of those".
    scope: "https://graph.microsoft.com/.default",
  });

  let res;
  try {
    res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (e) {
    throw new Error(`Could not reach Microsoft's login endpoint to get a SharePoint token: ${e.message}`);
  }

  const text = await res.text();
  if (!res.ok) {
    // Azure returns a JSON body with error + error_description that names the actual
    // problem (wrong secret, wrong tenant, consent not granted…). Surface it so an admin
    // can act rather than guess.
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      if (j.error_description || j.error) detail = `${j.error || ""}: ${j.error_description || ""}`.trim();
    } catch (_) { /* not JSON — keep the raw snippet */ }
    throw new Error(`Failed to get a SharePoint access token (HTTP ${res.status}). Check SP_TENANT_ID / SP_CLIENT_ID / SP_CLIENT_SECRET and that admin consent was granted. ${detail}`);
  }

  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Microsoft's token endpoint returned a non-JSON response (HTTP ${res.status}).`); }
  if (!data.access_token) {
    throw new Error("Microsoft's token endpoint did not return an access_token.");
  }

  const ttlSeconds = Number(data.expires_in) || 3600;
  const nextToken = {
    value: data.access_token,
    // Renew 60s early so a request never sets out with a token about to expire.
    expiresAt: Date.now() + Math.max(0, ttlSeconds - 60) * 1000,
  };
  tokenCache.set(tenantKey(), nextToken);
  return nextToken.value;
}

// --- Graph fetch helper ----------------------------------------------------------
// Attaches the bearer token, calls Graph, and returns the parsed JSON — throwing a clear,
// admin-facing error on any non-2xx. `init.body` may be a string (JSON we stringified) OR
// a raw Buffer (a file upload); either is passed through untouched, so this one helper
// covers both the metadata calls and the file PUT without a separate "raw" function.
async function graphFetch(path, init = {}) {
  await cfg.load("sharepoint");
  const token = await getAccessToken();
  let res;
  try {
    res = await fetch(`${GRAPH_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.headers || {}),
      },
    });
  } catch (e) {
    throw new Error(`Could not reach Microsoft Graph (${init.method || "GET"} ${path}): ${e.message}`);
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    // Graph errors are JSON shaped as { error: { code, message } }. Prefer that message;
    // fall back to a snippet of whatever came back.
    let detail = raw.slice(0, 300);
    try {
      const j = JSON.parse(raw);
      if (j.error && (j.error.message || j.error.code)) {
        detail = `${j.error.code || ""} ${j.error.message || ""}`.trim();
      }
    } catch (_) { /* not JSON — keep the raw snippet */ }
    const err = new Error(`Microsoft Graph request failed (HTTP ${res.status}) for ${init.method || "GET"} ${path}: ${detail}`);
    // Callers (folder creation, root lookup) branch on the status — a 404 means "not
    // there yet" and a 409 means "someone else just created it" — so carry it along.
    err.status = res.status;
    throw err;
  }

  // 204 No Content (e.g. DELETE) and empty bodies have nothing to parse.
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { throw new Error(`Microsoft Graph returned a non-JSON response (HTTP ${res.status}) for ${path}.`); }
}

// --- Lazy resolution of site → drive → root folder -------------------------------
// Each is resolved once on first use and cached in a module variable — these ids never
// change for the life of the process, and re-resolving them on every upload would add two
// or three needless round-trips to Graph before the request that actually matters.
// Same reasoning as tokenCache above: keyed by tenant, because a site id resolved
// for one institution is meaningless — and dangerous — for another.
const siteIdCache = new Map();
const driveIdCache = new Map();
const rootFolderIdCache = new Map();

async function resolveSiteId() {
  const kSite = tenantKey();
  if (siteIdCache.get(kSite)) return siteIdCache.get(kSite);
  // Use SP_SITE_ID directly ONLY if it's a real Graph id (has commas). A URL pasted into
  // it is handled as a URL by siteHostAndPath instead.
  if (SITE_ID().includes(",")) { siteIdCache.set(kSite, SITE_ID().trim()); return siteIdCache.get(kSite); }

  const { host, path } = siteHostAndPath();
  if (!host || !path) {
    throw new Error("SharePoint site is not configured. Set SP_SITE_URL to the site address (e.g. https://contoso.sharepoint.com/sites/Admissions), or SP_SITE_HOST + SP_SITE_PATH.");
  }
  // Graph addresses a site by path as /sites/{host}:/{server-relative-path}.
  const site = await graphFetch(`/sites/${host}:${path}`);
  if (!site || !site.id) {
    throw new Error(`Could not resolve the SharePoint site "${host}${path}". Check the site address (SP_SITE_URL).`);
  }
  siteIdCache.set(kSite, site.id);
  return site.id;
}

async function resolveDriveId() {
  const kDrive = tenantKey();
  if (driveIdCache.get(kDrive)) return driveIdCache.get(kDrive);
  if (DRIVE_ID()) { driveIdCache.set(kDrive, DRIVE_ID()); return driveIdCache.get(kDrive); }

  const siteId = await resolveSiteId();

  // Selected by name: list the site's document libraries and match on display name.
  // Comparison collapses whitespace and ignores case, so "09  Admissions" (two spaces,
  // as it appears in the URL) still matches "09 Admissions".
  const wanted = DRIVE_NAME();
  if (wanted) {
    // Compare loosely: lowercase and collapse every run of non-alphanumeric characters
    // (spaces, any kind of dash/hyphen, underscores) to one space — so "09 Admissions"
    // matches a library actually named "09 - Admissions" or "09 – Admissions". ASCII-only
    // regex, so no exotic dash character has to survive the file/deploy pipeline.
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const list = await graphFetch(`/sites/${siteId}/drives`);
    const drives = (list && list.value) || [];
    const match = drives.find((d) => norm(d.name) === norm(wanted));
    if (!match) {
      const names = drives.map((d) => `"${d.name}"`).join(", ") || "(none)";
      throw new Error(`No SharePoint document library named "${wanted}" on this site. Available libraries: ${names}. Fix SP_DRIVE_NAME (or set SP_DRIVE_ID).`);
    }
    driveIdCache.set(kDrive, match.id);
    return match.id;
  }

  const drive = await graphFetch(`/sites/${siteId}/drive`);
  if (!drive || !drive.id) {
    throw new Error("The SharePoint site has no default document library (drive). Set SP_DRIVE_ID or SP_DRIVE_NAME explicitly.");
  }
  driveIdCache.set(kDrive, drive.id);
  return drive.id;
}

// The base folder under which every applicant folder lives. Fetch it if it's there; if
// not, create it once under the drive root. A concurrent creator racing us produces a
// 409, which simply means "it exists now" — so re-fetch and use theirs.
async function resolveRootFolderId() {
  const kRoot = tenantKey();
  if (rootFolderIdCache.get(kRoot)) return rootFolderIdCache.get(kRoot);

  const driveId = await resolveDriveId();
  const rootFolder = ROOT_FOLDER().trim();

  // No base folder configured → the Course/Intake/Student tree lives directly in the
  // chosen library's root. Return the drive root item's id and skip creating a wrapper.
  if (!rootFolder) {
    const root = await graphFetch(`/drives/${driveId}/root`);
    if (!root || !root.id) throw new Error("Could not read the SharePoint library root.");
    rootFolderIdCache.set(kRoot, root.id);
    return root.id;
  }

  try {
    const item = await graphFetch(`/drives/${driveId}/root:/${encodeURIComponent(rootFolder)}`);
    if (item && item.id) { rootFolderIdCache.set(kRoot, item.id); return item.id; }
  } catch (e) {
    if (e.status !== 404) throw e; // a 404 just means it doesn't exist yet; anything else is real
  }

  try {
    const created = await graphFetch(`/drives/${driveId}/root/children`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: rootFolder, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    });
    rootFolderIdCache.set(kRoot, created.id);
    return created.id;
  } catch (e) {
    if (e.status === 409) {
      const item = await graphFetch(`/drives/${driveId}/root:/${encodeURIComponent(rootFolder)}`);
      rootFolderIdCache.set(kRoot, item.id);
      return item.id;
    }
    throw e;
  }
}

// --- Name sanitising -------------------------------------------------------------
// A folder name reaches both a Graph URL path and SharePoint's own storage, which rejects
// a fixed set of characters ( \ / : * ? " < > | ) plus # and % (which break URL/webUrl
// handling). Control characters and runs of whitespace are collapsed, the name is trimmed,
// trailing dots are removed (SharePoint forbids a name ending in "."), and the whole thing
// is capped so a very long applicant name can't produce an over-length path segment.
function sanitizeFolderName(name) {
  const cleaned = String(name || "")
    .replace(/[\\/:*?"<>|#%]/g, " ")        // characters SharePoint / URLs forbid
    .replace(/[\u0000-\u001f\u007f]/g, " ")  // control characters
    .replace(/\s+/g, " ")                    // collapse whitespace runs
    .trim()
    .slice(0, 120)                           // cap the length
    .replace(/[.\s]+$/, "")                  // no trailing dot or space (re-trim after the cap)
    .trim();
  return cleaned;
}

// --- Ensuring a child folder exists under a parent -------------------------------
// The single place that turns "a folder named N should exist directly under parent P"
// into a driveItem { id, webUrl }. Both ensureApplicantFolder (one level under root) and
// ensureFolderPath (walking a nested path) go through here so there's one implementation.
// `name` is assumed ALREADY sanitised by the caller — this helper doesn't second-guess it.
//
// Look for an existing child by path relative to the parent's id; a 404 just means it
// isn't there yet, so fall through and create it. conflictBehavior "fail" makes a race
// surface as a 409 rather than silently renaming the folder to "Name 1" — which would
// scatter documents across two folders — so on that 409 we fetch and return the folder the
// other writer just made.
async function ensureChildFolder(parentId, name) {
  const driveId = await resolveDriveId();

  // Look for an existing child by path relative to the parent folder's id.
  try {
    const existing = await graphFetch(`/drives/${driveId}/items/${parentId}:/${encodeURIComponent(name)}`);
    if (existing && existing.id) return { id: existing.id, webUrl: existing.webUrl };
  } catch (e) {
    if (e.status !== 404) throw e; // 404 = not there yet; fall through to create it
  }

  try {
    const created = await graphFetch(`/drives/${driveId}/items/${parentId}/children`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    });
    return { id: created.id, webUrl: created.webUrl };
  } catch (e) {
    if (e.status === 409) {
      const existing = await graphFetch(`/drives/${driveId}/items/${parentId}:/${encodeURIComponent(name)}`);
      return { id: existing.id, webUrl: existing.webUrl };
    }
    throw e;
  }
}

// --- Public operations -----------------------------------------------------------

/**
 * Ensure a folder for one applicant exists directly under the base (root) folder, and
 * return its { id, webUrl }. Safe to call repeatedly for the same applicant — it returns
 * the existing folder rather than creating a duplicate, and tolerates a concurrent create.
 */
async function ensureApplicantFolder(folderName) {
  if (!isConfigured()) throw new Error("SharePoint isn't set up on the server yet.");

  const name = sanitizeFolderName(folderName);
  if (!name) throw new Error("An applicant folder name is required.");

  const rootId = await resolveRootFolderId();
  return ensureChildFolder(rootId, name);
}

/**
 * Ensure a NESTED folder path exists under the base (root) folder and return the deepest
 * folder's { id, webUrl }. Given e.g. ["HND - Business", "Sep 2026", "Aaliyah Khan (a1b2c3)"]
 * it yields Course / Intake / Student, creating each missing level and reusing any that
 * already exist. Each segment is sanitised exactly like an applicant folder name; a segment
 * that sanitises to nothing becomes "Unspecified" so a missing course or intake can't
 * collapse the path or produce an empty name. Idempotent: repeated calls with the same
 * segments reuse the existing folders and never create duplicates.
 */
async function ensureFolderPath(segments) {
  if (!isConfigured()) throw new Error("SharePoint isn't set up on the server yet.");
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("A folder path (at least one segment) is required.");
  }

  // Start at the base folder, then ensure one child level per segment, descending into
  // each as we go so it becomes the parent for the next.
  let parentId = await resolveRootFolderId();
  let current = null;
  for (const segment of segments) {
    const name = sanitizeFolderName(segment) || "Unspecified";
    current = await ensureChildFolder(parentId, name);
    parentId = current.id;
  }
  return current; // the deepest (last-segment) folder
}

/**
 * Upload one file into an applicant's folder and return { id, webUrl, size }. Uses a
 * simple content PUT, which replaces any existing file of the same name in that folder
 * (re-uploading corrects rather than orphaning). Rejects empty and over-limit files with
 * a message the route can show the user.
 */
async function uploadFile(folderId, fileName, buffer, contentType) {
  if (!isConfigured()) throw new Error("SharePoint isn't set up on the server yet.");
  if (!buffer?.length) throw new Error("The file is empty.");
  if (buffer.length > MAX_BYTES) {
    throw new Error(`That file is too large (limit ${Math.round(MAX_BYTES / 1024 / 1024)}MB).`);
  }

  const driveId = await resolveDriveId();
  const safeName = String(fileName || "").trim() || "file";

  const item = await graphFetch(
    `/drives/${driveId}/items/${folderId}:/${encodeURIComponent(safeName)}:/content`,
    {
      method: "PUT",
      headers: { "Content-Type": contentType || "application/octet-stream" },
      body: buffer,
    }
  );
  return { id: item.id, webUrl: item.webUrl, size: buffer.length };
}

/**
 * Best-effort delete of a drive item. A database row going away must never fail because
 * its SharePoint file didn't — an orphaned file is harmless — so this swallows every
 * error (a missing item, a transient Graph blip) and returns quietly.
 */
async function deleteItem(itemId) {
  if (!isConfigured() || !itemId) return;
  try {
    const driveId = await resolveDriveId();
    await graphFetch(`/drives/${driveId}/items/${itemId}`, { method: "DELETE" });
  } catch (_) {
    /* the row is what matters; an orphaned file, or a delete of something already gone, is harmless */
  }
}

// PATCH a drive item's metadata (rename and/or re-parent). Returns the updated
// { id, webUrl } — both change when a folder is renamed or moved.
async function patchDriveItem(itemId, body) {
  if (!isConfigured()) throw new Error("SharePoint isn't set up on the server yet.");
  const driveId = await resolveDriveId();
  const item = await graphFetch(`/drives/${driveId}/items/${itemId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { id: item.id, webUrl: item.webUrl };
}

/** Rename a folder (e.g. to "<studentId> - <name>" on enrolment). */
async function renameItem(itemId, newName) {
  const name = sanitizeFolderName(newName) || "Unnamed";
  return patchDriveItem(itemId, { name });
}

/**
 * Move a folder under a new parent (e.g. when the applicant's course/intake changes),
 * optionally renaming it in the same call. `newParentId` is a folder driveItem id —
 * typically the intake folder from ensureFolderPath([course, intake]).
 */
async function moveItem(itemId, newParentId, newName) {
  const body = { parentReference: { id: newParentId } };
  const nm = sanitizeFolderName(newName || "");
  if (nm) body.name = nm;
  return patchDriveItem(itemId, body);
}

/**
 * Drop everything cached for one institution — call when its credentials change,
 * otherwise a corrected configuration keeps using the old site and token.
 */
function forgetTenant(tenantId) {
  const k = tenantId || "__no_tenant__";
  tokenCache.delete(k); siteIdCache.delete(k); driveIdCache.delete(k); rootFolderIdCache.delete(k);
}


// --- Test connection ----------------------------------------------------------
// Proves an institution's saved credentials actually work, WITHOUT writing anything.
// Three things can be wrong independently and each fails with a different message:
// the app registration / secret (token), the site address (site id), and the document
// library (drive id). Reporting which one failed is the difference between "it says
// error" and an administrator being able to fix their own configuration.
async function testConnection() {
  await cfg.load("sharepoint");
  if (!isConfigured()) {
    return { ok: false, note: "Not configured — a directory ID, client ID, client secret and site are all required." };
  }
  try {
    await getAccessToken();
  } catch (e) {
    return { ok: false, note: "Sign-in to Microsoft failed — check the directory ID, application ID and client secret. (" + e.message + ")" };
  }
  let siteId;
  try {
    siteId = await resolveSiteId();
  } catch (e) {
    return { ok: false, note: "Signed in, but the site could not be found — check the site host and path. (" + e.message + ")" };
  }
  try {
    await resolveDriveId();
  } catch (e) {
    return { ok: false, note: "Site found, but the document library could not be opened — check the library name. (" + e.message + ")" };
  }
  return { ok: true, note: "Connected — " + describe().replace(/^SharePoint /, "") };
}

module.exports = {
  forgetTenant,
  testConnection,
  isConfigured,
  describe,
  ensureApplicantFolder,
  ensureFolderPath,
  uploadFile,
  deleteItem,
  renameItem,
  moveItem,
  MAX_BYTES,
};
