// THE PRISMA EXTENSION THAT ENFORCES ACADEMIC DEPARTMENT SCOPE.
//
// A FACTORY TAKING A CLIENT, rather than extending the shared one in place, for two
// reasons. The first is testability: scripts/smoke-academic-scope.mjs builds a client
// explicitly from DATABASE_URL and applies this to it, so which database the guard is
// being tested against is never in question — db.js constructs its client with no
// explicit datasource, and server/.env points at live Supabase. The second is that
// db.js stays a file about the shared client rather than a file about scoping.
//
// WHAT IT CANNOT REACH. $queryRaw and $queryRawUnsafe are CLIENT-level methods and never
// pass through $allModels, so they are not protected by anything here. routes/hnd.js:6-21
// already records this from the tenant era, where every raw query scoped itself by hand.
// academicScopeSql.js is the replacement for that helper; the six remaining raw
// aggregates are its callers.
const { currentScope, AcademicScopeError } = require("./academicScope");
const { scopePredicateFor, MODEL_SCOPE } = require("./academicScopeModels");

// Operations that read or write EXISTING rows, and therefore take a `where`.
//
// `create`, `createMany` and `upsert` are deliberately absent: a create has no rows to
// filter, and which department the new row lands in is the route's decision, not the
// guard's. `upsert` is the uncomfortable one — its `where` half could be filtered — but
// filtering it would turn "update the row you cannot see" into "create a second row",
// which is worse than the refusal it replaces. Spec 2 revisits it when the first
// scoped upsert actually appears; today no route upserts a scoped model.
const FILTERED_OPS = new Set([
  "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany",
  "count", "aggregate", "groupBy",
  "update", "updateMany", "delete", "deleteMany",
]);

// Operations whose `where` must keep a unique field at the TOP LEVEL, so the predicate is
// merged into it rather than wrapped in AND.
//
// Prisma 5's extended-where permits a non-unique filter ALONGSIDE a unique one, but the
// unique one has to stay at the top: `{ id, academicDepartmentId }` is valid,
// `{ AND: [{ id }, { academicDepartmentId }] }` is not.
//
// findUnique WAS WIDENED TO findFirst HERE INSTEAD, and that was a bug with two heads.
// Re-issuing through the unextended client escaped an enclosing interactive transaction --
// so a route that created a row and read it back inside $transaction got NULL, because the
// re-issued read ran outside the uncommitted transaction. routes/timetabling.js does exactly
// that and returned an event with no id. Widening also broke compound uniques outright:
// findFirst rejects `{ sessionId_studentId: … }`. Merging fixes both and needs no second
// client.
const TOP_LEVEL_MERGE = new Set(["findUnique", "findUniqueOrThrow", "update", "delete"]);

/**
 * Return `client` extended so every departmental query carries the caller's scope.
 *
 * @param {import("@prisma/client").PrismaClient} client
 */
function withAcademicScopeGuard(client) {
  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!FILTERED_OPS.has(operation)) return query(args);

          // THE MODEL IS CLASSIFIED FIRST, AND A SCOPE IS DEMANDED ONLY IF IT NEEDS ONE.
          //
          // The order matters far more than it looks. Demanding a scope up front
          // deadlocks the application against its own guard: requireAuth reads Staff to
          // work out what the scope IS, and Staff is unscoped, so that read would throw
          // before any scope could exist — whereupon the 401 handler swallows the error
          // and the entire college is signed out. prisma/seed.js fails the same way, on
          // Adjustment.deleteMany, which is how this was found.
          //
          // It is also the difference between this guard and the tenant one described
          // above. That one could demand a tenant for every query because every model had
          // one. Most models here belong to no department, and making them all declare a
          // scope would be precisely the "tax on writing anything outside a request" that
          // this file records as the old design's cost.
          //
          // An UNCLASSIFIED model still cannot slip through: scopePredicateFor throws for
          // one, and that check happens before the scope is ever consulted.
          const rule = MODEL_SCOPE[model];
          if (rule === undefined) scopePredicateFor(model, null); // throws, naming the model
          if (rule === "UNSCOPED") return query(args);

          const scope = currentScope();
          if (!scope) {
            // NOT "see everything". A query against a DEPARTMENTAL model issued from
            // somewhere that never said who it was for is a bug in both directions:
            // inside a request it means the scope middleware did not run, and outside one
            // it means background work that forgot withoutAcademicScope(). Both used to
            // be invisible; this file records that losing exactly this fail-closed
            // behaviour was the cost of removing the tenant guard.
            throw new AcademicScopeError(
              `${model}.${operation} was issued with no academic scope bound. A request must ` +
              `pass through requireAuth; background work must declare itself with ` +
              `withoutAcademicScope("<why>").`,
            );
          }

          const predicate = scopePredicateFor(model, scope);
          if (!predicate) return query(args);

          // findUnique, update AND delete ALL NEED THE UNIQUE FIELD AT THE TOP LEVEL.
          //
          // Prisma's extended-where lets a non-unique filter sit ALONGSIDE a unique one,
          // but the unique one has to stay at the top: `{ id, academicDepartmentId }` is
          // valid, `{ AND: [{ id }, { academicDepartmentId }] }` is not, and Prisma
          // rejects it at runtime. Wrapping these in AND turned every in-department
          // update into a 500 — caught by the "can still rename its own course" control,
          // which is exactly why that control exists: the cross-department case returns
          // 404 from the route's own findUnique and never reaches the update at all, so a
          // suite testing only the refusal would have shipped this.
          //
          // Merged rather than AND-ed, and AND-ed only if the keys actually collide, so a
          // caller that already filters on the same field keeps both conditions.
          //
          // A compound-unique key (`{ sessionId_studentId: {...} }`) is left untouched at the
          // top level and the predicate sits beside it, which is what extended-where wants.
          if (TOP_LEVEL_MERGE.has(operation)) {
            const where = { ...args.where };
            for (const [k, v] of Object.entries(predicate)) {
              where[k] = k in where ? { AND: [where[k], v] } : v;
            }
            return query({ ...args, where });
          }

          return query({ ...args, where: args.where ? { AND: [args.where, predicate] } : predicate });
        },
      },
    },
  });
}

module.exports = { withAcademicScopeGuard, FILTERED_OPS };
