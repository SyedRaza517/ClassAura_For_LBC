---
paths:
  - "server/prisma/**"
  - "server/tools/**"
---

## Migrations

**Never rename a migration directory once it has been applied anywhere.** Prisma
identifies a migration by directory name; a rename makes an applied migration look new,
it re-runs, hits "already exists", and is recorded as failed — after which Prisma
refuses *every* later migration with P3009. Since `migrate:deploy` runs in the deploy
build command, every deploy then fails while the old build keeps serving happily. This
has happened twice. `server/tools/resolve-failed-migration.js` is the guarded remedy:
it verifies every object the failed migration creates already exists before marking it
applied, and refuses otherwise.

**The de-tenanting migration refuses to run against a database holding more than one
`Tenant` row**, and that guard is not negotiable.
`prisma/migrations/20260830T210000_remove_multi_tenancy` drops `tenantId`, which is half
of 18 unique constraints. Where two institutions share a student number or an email, the
plain unique cannot be created and the migration fails — an ordinary, recoverable
failure. Where it *succeeds*, the drop does not separate the institutions, it **merges**
them: every student, register and pastoral note lands in one undifferentiated pile, and
the only record of who belonged to whom is the column just dropped. That second outcome
is unrecoverable from the data afterwards, so the migration raises before any destructive
statement rather than trusting that the database holds one college. Postgres runs it in a
transaction, so the raise leaves nothing half-applied. If it fires, the fix is to split
the database or delete the surplus tenants deliberately — never to weaken the check.

