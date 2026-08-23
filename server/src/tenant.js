// Works out which institution a request belongs to, and runs the rest of the
// request inside that tenant's scope.
//
// WHY THIS HAS TO HAPPEN BEFORE AUTHENTICATION
//
// Staff.email is unique per tenant now, not globally — that is the whole point, so
// two colleges can employ the same person. But it means POST /auth/login can no
// longer find an account from an email address alone: the same address may exist at
// several institutions, and picking one of them arbitrarily would sign the caller
// into somebody else's college. The request has to declare which institution it is
// for BEFORE anyone is authenticated.
//
// Resolution order, first match wins:
//   1. X-Tenant header      — what the web and mobile clients send
//   2. Subdomain            — ONLY under TENANT_BASE_DOMAIN, e.g.
//                             brookes.edtech.co.uk -> "brookes"
//   3. DEFAULT_TENANT_SLUG  — single-institution deployments (EdTech and LBC today)
//   4. "default"            — the tenant the tenancy migration adopted every
//                             existing row into, so nothing broke on upgrade
const prisma = require("./db");
const { runInTenant, crossTenant } = require("./db");

const FALLBACK_SLUG = process.env.DEFAULT_TENANT_SLUG || "default";

// Requests that must work before any tenant is known.
//   /health   — polled by the host's monitoring and by the keep-alive. Failing it
//               because a header was missing would take the service down over a
//               configuration mistake.
//   /platform — the platform-admin surface sits ABOVE every tenant, so demanding one
//               would be circular. It is also mounted before this middleware in
//               index.js, so this is defence in depth rather than the only guard.
//
// NOTE these are mount-relative. This middleware is attached with app.use("/api"),
// so Express strips that prefix and req.path here is "/health", never "/api/health".
const TENANT_EXEMPT = new Set(["/health"]);
const TENANT_EXEMPT_PREFIXES = ["/platform", "/registrations"];

// A tenant lookup on every request would be a database round trip per request, on
// data that changes when a customer is created — roughly never. Cached by slug for
// a minute: long enough to matter, short enough that suspending a customer takes
// effect while you are still looking at the screen.
// Consequence worth stating plainly: suspending or deleting a customer takes up to
// this long to bite, because a cached row still says active. That is acceptable for a
// commercial suspension (non-payment, end of contract) and not acceptable in a test,
// so it is configurable — CI sets TENANT_CACHE_MS=0 and gets immediate effect.
const CACHE_MS = process.env.TENANT_CACHE_MS !== undefined ? Number(process.env.TENANT_CACHE_MS) : 60_000;
const cache = new Map(); // slug -> { tenant, at }

// Subdomain resolution applies ONLY under a domain you actually control, named by
// TENANT_BASE_DOMAIN (e.g. "edtech.co.uk", so brookes.edtech.co.uk -> "brookes").
//
// Without that restriction this read the first label of ANY hostname, which broke
// staging the moment it was deployed: edtech-staging-api.onrender.com resolved to a
// tenant called "edtech-staging-api", which does not exist, so every college request
// 404'd before it reached the DEFAULT_TENANT_SLUG fallback. Platform hosts, preview
// URLs and bare service names are not customer subdomains, and no denylist of them
// would ever be complete — an allowlist of one domain is the only version that holds.
const BASE_DOMAIN = (process.env.TENANT_BASE_DOMAIN || "").trim().toLowerCase().replace(/^\.+/, "");

function slugFromHost(host) {
  if (!BASE_DOMAIN) return null;              // not configured: never guess
  if (!host) return null;
  const name = String(host).split(":")[0].toLowerCase();
  if (!name.endsWith("." + BASE_DOMAIN)) return null;
  const label = name.slice(0, -(BASE_DOMAIN.length + 1));
  // Only a single label counts; a.b.example.com is not customer "a".
  if (!label || label.includes(".")) return null;
  // Platform hostnames under the same domain are not customers.
  if (["www", "api", "app", "staging", "admin", "platform"].includes(label)) return null;
  return label;
}

function slugFor(req) {
  const header = req.headers["x-tenant"];
  if (header && String(header).trim()) return String(header).trim().toLowerCase();
  const sub = slugFromHost(req.headers.host);
  if (sub) return sub;
  return FALLBACK_SLUG;
}

async function lookup(slug) {
  const hit = cache.get(slug);
  if (CACHE_MS > 0 && hit && Date.now() - hit.at < CACHE_MS) return hit.tenant;
  // Tenant is exempt from the isolation extension, but crossTenant() is used anyway
  // so the intent is explicit and this still works if that ever changes.
  const tenant = await crossTenant(() => prisma.tenant.findUnique({ where: { slug } }));
  cache.set(slug, { tenant, at: Date.now() });
  return tenant;
}

/** Drop a slug from the cache — call after creating or suspending a tenant. */
const forget = (slug) => cache.delete(slug);

/**
 * Express middleware. Resolves the tenant, then runs the whole remainder of the
 * request inside runInTenant, so every query any handler makes is scoped without
 * the handler knowing anything about it.
 */
async function tenantMiddleware(req, res, next) {
  if (TENANT_EXEMPT.has(req.path)) return next();
  if (TENANT_EXEMPT_PREFIXES.some((prefix) => req.path === prefix || req.path.startsWith(prefix + "/"))) return next();

  const slug = slugFor(req);
  let tenant;
  try {
    tenant = await lookup(slug);
  } catch (e) {
    console.error("[tenant] lookup failed for " + slug + ":", e.message);
    return res.status(503).json({ error: "Service temporarily unavailable" });
  }

  if (!tenant) {
    // Deliberately not "tenant 'x' does not exist" — that would let anyone probe
    // which institutions use the platform.
    return res.status(404).json({ error: "Unknown institution" });
  }
  if (tenant.active === false) {
    return res.status(403).json({ error: "This institution's access has been suspended" });
  }

  req.tenant = { id: tenant.id, slug: tenant.slug, name: tenant.name };
  // Everything downstream — routes, handlers, error middleware — runs in scope.
  return runInTenant(tenant.id, () => new Promise((resolve) => {
    res.on("finish", resolve);
    res.on("close", resolve);
    next();
  }));
}

module.exports = { tenantMiddleware, forget, slugFor, FALLBACK_SLUG };
