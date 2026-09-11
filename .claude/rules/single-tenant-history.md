---
paths:
  - "server/src/**/*.js"
  - "client/src/**/*.jsx"
  - "scripts/**/*.mjs"
---

## It was multi-tenant, and the code still shows it

Until 30 Aug 2026 one deployment served every college out of one database, so isolation
was a property of the *code*: a single query that forgot `tenantId` was a cross-tenant
data leak. Rather than ask ~200 endpoints to remember a filter, `server/src/db.js`
extended the Prisma client so every query was filtered and stamped by the current tenant,
and a query issued with no tenant at all threw (`TenantScopeError`) rather than quietly
returning everyone's rows. `tenantMiddleware` resolved an `X-Tenant` header → subdomain →
`DEFAULT_TENANT_SLUG` before authentication, because `Staff.email` was unique only *per
tenant*; sessions carried a `tid` claim so a token from college A could not be replayed
against college B; and a supplier-facing **platform operator** tier sat above every
institution, mounted above the middleware because an operator was not an institution.

**All of that is gone.** `db.js` is a plain `PrismaClient`. `tenant.js`, `eachTenant.js`,
`platformAuth.js`, `routes/platform.js` and `routes/registrations.js` are deleted, as are
`runInTenant`, `crossTenant`, `TenantScopeError`, the `X-Tenant` header, subdomain
resolution and the `PlatformDashboard` / `CollegeRegistration` client screens. Isolation
is now a property of the **infrastructure**: a query that forgets a filter can only reach
rows belonging to the institution whose server it is running on, because there are no
others.

Why this is worth knowing rather than merely deleting:

- **It explains the shape of a lot of code.** Allowlisted serialisers, configuration
  held in the database instead of constants, per-send resolution of the mail `FROM`
  address rather than a module-level one, branding fallbacks that deliberately belong to
  nobody — all written against a failure mode where the wrong college's identity leaks
  into another college's letter. They are cheap, they are still correct, and none of them
  should be unwound on the grounds that there is only one college now. (The caches that
  had to be keyed by tenant — SharePoint's token, site, drive and root folder — are
  single slots again, because a `Map` that only ever holds one entry is not a `Map`.)
- **Comments across `server/src` describe both states on purpose.** Files say what used
  to be there and why it isn't, in the house style. That is not stale text to tidy away.
- **`Tenant` survives**, as the single institution settings row rather than a registry.
  Its only remaining reader is a display-name fallback in `branding.js`. Deleting it was
  the rejected option: a single `Tenant` row already *is* the singleton settings table
  the alternative would have had to build.
- **The coverage given up is real.** `smoke-tenant-isolation.mjs`, `smoke-platform.mjs`
  and `smoke-registrations.mjs` were deleted rather than adapted, because with no tenancy
  their assertions would pass while discriminating nothing — which reads as coverage on
  the summary line. If this ever serves two institutions from one database again, `db.js`
  and those suites are what has to come back **first**, before any route is written
  against the shared database. Both are in git history at the commit that removed them.

