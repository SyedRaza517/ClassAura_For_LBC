// The shared Prisma client — and the single place tenant isolation is enforced.
//
// WHY IT LIVES HERE AND NOT IN THE ROUTES
//
// With one database shared by every institution, isolation is a property of the
// code rather than of the infrastructure: one query that forgets tenantId is a
// cross-tenant data leak. Thirty-nine files import this client and there are ~200
// endpoints; asking every one of them to remember a filter is not a security model,
// it is a hope.
//
// So the client itself refuses. Every query is rewritten to carry the caller's
// tenant, and a query issued with no tenant at all THROWS rather than quietly
// returning everyone's rows. A route added tomorrow is isolated without its author
// knowing this file exists — the same closed-by-default idea as the STUDENT_ROUTERS
// allowlist in auth.js, which is the one line in that file most worth not breaking.
//
// The escape hatch is deliberately loud: crossTenant() has to be typed out, so
// reading across institutions is always a visible decision in the diff.
const { AsyncLocalStorage } = require("node:async_hooks");
const { PrismaClient } = require("@prisma/client");

// Request-scoped context. AsyncLocalStorage rather than a parameter threaded
// through every call, because that thread would break the first time someone
// forgot it — and a broken thread here is a data leak, not a bug report.
const ctx = new AsyncLocalStorage();

// Tables not owned by any one institution.
//   Tenant        — the registry OF institutions; scoping it by tenant is circular.
//   PlatformAdmin — operators of the platform, deliberately above every tenant.
const UNSCOPED_MODELS = new Set(["Tenant", "PlatformAdmin"]);

// Collection operations. The tenant filter can be AND-ed on safely.
const FILTERED = new Set([
  "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy",
  "updateMany", "deleteMany",
]);

// Operations that require a UNIQUE selector. Prisma insists the unique field sits
// at the TOP level of the where clause, so AND-wrapping it leaves no top-level
// unique and Prisma rejects the call outright. These merge flat instead — which
// Prisma 5's extended-where-unique permits, and which still filters correctly:
// asking for another tenant's id simply matches nothing.
const FILTERED_UNIQUE = new Set(["findUnique", "findUniqueOrThrow", "update", "delete"]);

// Operations whose payload is stamped with the tenant on the way in.
const STAMPED = new Set(["create", "createMany", "createManyAndReturn"]);

class TenantScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = "TenantScopeError";
    this.status = 500;
  }
}

const andTenant = (where, tenantId) => (where ? { AND: [where, { tenantId }] } : { tenantId });

const base = new PrismaClient();

const prisma = base.$extends({
  name: "tenant-isolation",
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (UNSCOPED_MODELS.has(model)) return query(args);

        const current = ctx.getStore();

        // No context at all — almost always a query issued outside a request: a
        // scheduler, a script, a startup task. Those must say which tenant they
        // mean, or say crossTenant() explicitly. Failing loudly is the whole point;
        // the alternative is silently reading every institution's data.
        if (!current) {
          throw new TenantScopeError(
            model + "." + operation + " ran with no tenant context. Wrap it in " +
            "runInTenant(tenantId, fn), or crossTenant(fn) if it genuinely must span institutions."
          );
        }

        // Explicit, deliberate, and visible in review.
        if (current.crossTenant) return query(args);

        const tenantId = current.tenantId;
        if (!tenantId) {
          throw new TenantScopeError(model + "." + operation + " ran with an empty tenant context.");
        }

        const next = { ...args };

        if (FILTERED.has(operation)) next.where = andTenant(args.where, tenantId);
        if (FILTERED_UNIQUE.has(operation)) next.where = { ...args.where, tenantId };

        if (STAMPED.has(operation)) {
          if (Array.isArray(args.data)) next.data = args.data.map((d) => ({ ...d, tenantId }));
          else next.data = { ...args.data, tenantId };
        }

        if (operation === "upsert") {
          next.where = { ...args.where, tenantId };
          next.create = { ...args.create, tenantId };
          // The update payload is a partial and is deliberately NOT stamped, so an
          // upsert can never move an existing row between tenants.
        }

        return query(next);
      },
    },
  },
});

/**
 * Run fn with every query scoped to one institution. The request middleware wraps
 * each request in this.
 */
function runInTenant(tenantId, fn) {
  if (!tenantId) throw new TenantScopeError("runInTenant called without a tenantId");
  // Awaited INSIDE the context, deliberately. Prisma invokes the extension callback
  // asynchronously, so a caller passing a non-async arrow would otherwise have the
  // context torn down before the query is inspected, and the call would throw. It
  // fails closed rather than leaking, but it is a trap — holding the frame open here
  // means callers may write it either way and both are correct.
  return ctx.run({ tenantId, crossTenant: false }, async () => await fn());
}

/**
 * Run fn with isolation switched OFF — every institution's rows are visible.
 *
 * Only two things may use this: the platform-admin surface, and infrastructure that
 * legitimately spans institutions. It is named to be conspicuous in review; if it
 * appears inside an ordinary route handler, that is a bug.
 */
function crossTenant(fn) {
  return ctx.run({ tenantId: null, crossTenant: true }, async () => await fn());
}

/** The tenant the current request belongs to, or null outside a request. */
const currentTenantId = () => (ctx.getStore() ? ctx.getStore().tenantId : null);

module.exports = prisma;
module.exports.prisma = prisma;
module.exports.runInTenant = runInTenant;
module.exports.crossTenant = crossTenant;
module.exports.currentTenantId = currentTenantId;
module.exports.TenantScopeError = TenantScopeError;
