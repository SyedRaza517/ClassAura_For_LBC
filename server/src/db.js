// The shared Prisma client.
//
// WHAT USED TO BE HERE, AND WHY IT ISN'T
//
// This file was the single place tenant isolation was enforced. One database served
// every institution, so isolation was a property of the code rather than of the
// infrastructure: one query that forgot `tenantId` was a cross-tenant data leak.
// Rather than ask ~200 endpoints to remember a filter, the client itself refused —
// every query was rewritten to carry the caller's tenant, and a query issued with no
// tenant at all threw rather than quietly returning everyone's rows.
//
// The product is now sold as one deployment per college, each with its own database.
// Isolation is therefore a property of the infrastructure, which is the stronger
// place for it to live: a query that forgets a filter can only reach rows belonging
// to the institution whose server it is running on, because there are no others.
//
// The cost of removing it is real and worth stating, because the next person to read
// this file should not have to rediscover it. Three things went:
//
//   * `runInTenant(id, fn)` / `crossTenant(fn)` — every scheduler, script and tool had
//     to name the institution it meant. That was a tax on writing anything outside a
//     request, and it is now gone.
//   * `TenantScopeError` — a query with no context failed loudly. Nothing fails loudly
//     any more, because there is nothing left to fail about.
//   * The fail-closed guard on unrecognised operations. A Prisma upgrade that added an
//     operation could not slip past unscoped; now no operation is scoped at all.
//
// If this product ever serves two institutions from one database again, this file is
// where that has to come back FIRST, before any route is written against the shared
// database — and `scripts/smoke-tenant-isolation.mjs`, deleted in the same change, is
// the proof that it works. Both are in git history at the commit that removed them.
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

module.exports = prisma;
module.exports.prisma = prisma;
