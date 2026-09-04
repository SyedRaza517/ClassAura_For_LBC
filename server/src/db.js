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
//
// ---------------------------------------------------------------------------------
// WHAT CAME BACK, ON 4 SEP 2026, AND WHY IT IS NOT THE ABOVE
//
// A guard of a similar SHAPE now sits here again — see academicScopeGuard.js. It scopes
// queries to the caller's ACADEMIC DEPARTMENT: Business, Computing, Law. Four things make
// it a different thing from the tenant isolation described above rather than a reversal
// of the decision to remove it:
//
//   * One institution, not many. Nothing it guards spans customers, so no amount of
//     forgetting can leak one college's data into another's. The failure it prevents is
//     a Law tutor reading Health & Social Care pastoral records, which is serious and is
//     not the same category of serious.
//   * It is PARTIAL. Tenant scoping could assume every model had a tenantId. Most models
//     belong to no department at all, so a blanket extension would be wrong — every model
//     is classified by hand in academicScopeModels.js and an undeclared one throws.
//   * There is a designed all-access role, Staff.collegeWide. Tenancy deliberately had
//     none, which is why crossTenant() existed as a hatch bolted on beside it.
//   * There is no runInTenant() equivalent. Background work does not name a department;
//     it declares itself institution-wide once, with a reason, via withoutAcademicScope().
//
// What has NOT changed: $queryRaw still bypasses all of this, because the extension hooks
// $allModels and raw queries are client-level. routes/hnd.js:6-21 says so, and
// academicScopeSql.js is where those six aggregates get their predicate by hand.
const { PrismaClient } = require("@prisma/client");
const { withAcademicScopeGuard } = require("./academicScopeGuard");

const prisma = withAcademicScopeGuard(new PrismaClient());

module.exports = prisma;
module.exports.prisma = prisma;
