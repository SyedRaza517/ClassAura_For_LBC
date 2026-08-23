# Database migrations

Every change to `schema.prisma` is recorded here as a numbered folder containing the
exact SQL that will run against the database. Nothing changes a database except a file
in this directory.

## Why this exists

Before this, the schema was applied with **`prisma db push`**, which reconciles the
database to whatever `schema.prisma` currently says. That has three problems that make
it unusable for a product other people depend on:

- **It can destroy data without asking.** Renaming a field is a drop and an add. Push
  performs it, and the column's data is gone.
- **There is no history.** Nothing records how production reached its current shape,
  so a change cannot be reviewed before it runs or reproduced afterwards.
- **There is no way back.** A bad change cannot be reversed, because nothing describes
  what it did.

`migrate deploy` applies reviewed SQL files forward, in order, once each. It never
resets and never drops anything the migration does not explicitly say to drop.

## The baseline: `0_init`

`0_init/migration.sql` is the whole schema as it stood on 23 Aug 2026 — 36 tables,
34 foreign keys, 58 indexes. It was generated from `schema.prisma` after confirming
the live database matched it exactly:

```bash
npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel  prisma/schema.prisma --script
# → "This is an empty migration."  (no drift)
```

It is already marked as applied on the production database, so `migrate deploy` skips
it there. On an **empty** database it runs and builds everything.

## Making a schema change

1. Edit `prisma/schema.prisma`.
2. Create the migration and apply it to your **local/staging** database:
   ```bash
   npm run migrate           # prisma migrate dev — prompts for a name
   ```
3. **Read the generated SQL** in the new `prisma/migrations/<timestamp>_<name>/`
   folder before committing it. This is the review step `db push` never had. Look for
   `DROP COLUMN`, `DROP TABLE` and any `NOT NULL` added to a column that already holds
   rows — each of those needs a data step, not just a schema step.
4. Commit the migration folder **with** the schema change. They must never be
   separated: the schema file says what the shape is, the migration says how to get
   there, and a database with one and not the other is broken.
5. Deploy. Render's build runs `npm run migrate:deploy` and applies it.

## Commands

| Command | What it does |
|---|---|
| `npm run migrate` | Create + apply a migration (development only — may prompt to reset) |
| `npm run migrate:deploy` | Apply pending migrations (production/staging — never resets) |
| `npm run migrate:status` | Show which migrations this database has |

## Rules

- **Never run `prisma db push` again.** It bypasses this directory entirely and will
  put the database out of step with the migration history.
- **Never edit an applied migration.** Prisma records a checksum; changing the file
  makes the database report as failed. Write a new migration instead.
- **Never run `migrate dev` or `migrate reset` against production.** Both can drop the
  database. Production only ever gets `migrate deploy`.

## Baselining another existing database

Only needed for a database that already has the tables but no `_prisma_migrations`
table — the production database has already had this done:

```bash
npx prisma migrate resolve --applied 0_init
```
