// Mark a FAILED migration as applied — but only after proving it already ran.
//
// WHY THIS EXISTS
//
// Prisma identifies a migration by its DIRECTORY NAME. Rename a directory that has
// already been applied and Prisma sees an unfamiliar name, re-runs its SQL, hits
// "already exists", and records the migration as failed. From that moment it refuses
// EVERY later migration with P3009, `migrate deploy` exits non-zero, and — because
// render.yaml runs it in buildCommand — every deploy fails. The API keeps serving the
// old build quite happily, so the symptom is simply that new code never appears.
//
// That happened here twice: once on staging (fixed by hand on 25 Aug 2026) and once
// on production, whose database is a DIFFERENT one and so was not fixed with it.
//
// The documented remedy is `prisma migrate resolve --applied <name>`. The danger in
// it is that marking a migration applied when it was NOT skips a real schema change
// and leaves the database quietly short of a table or a column — a far worse problem
// than the one being fixed, and one that surfaces days later as a confusing runtime
// error.
//
// So this tool refuses to guess. It reads the migration's OWN SQL, extracts every
// object that SQL creates, and checks each one is already present in the database.
// Only if all of them are does it mark the migration applied. If any is missing it
// exits non-zero and changes nothing — because a genuinely un-applied migration
// should be applied, not annotated.
//
// USAGE
//
//   node tools/resolve-failed-migration.js <migration_directory_name>
//   node tools/resolve-failed-migration.js --any     # resolve every failed migration
//
// Safe to leave in a build command: with no failed migrations it prints one line and
// exits 0.
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const MIGRATIONS_DIR = path.join(__dirname, "..", "prisma", "migrations");

/** Every object a migration's SQL creates, as { kind, name }. */
function objectsCreatedBy(sql) {
  const out = [];
  const add = (kind, name) => name && out.push({ kind, name });

  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi)) add("table", m[1]);
  for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi)) add("index", m[1]);
  for (const m of sql.matchAll(/ADD\s+CONSTRAINT\s+"([^"]+)"/gi)) add("constraint", m[1]);
  // A column added to an existing table, as "Table"."column".
  for (const m of sql.matchAll(/ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi)) {
    add("column", m[1] + "." + m[2]);
  }
  return out;
}

// EVERY lookup is scoped to current_schema(), never hardcoded to "public".
//
// A test caught this the hard way: with the checks pinned to "public", the tool read
// the migration row from the schema it was connected to but looked for the OBJECTS in
// public — and cheerfully reported all three present when the table did not exist in
// the target schema at all. That is the precise failure this whole file exists to
// prevent, arrived at from the other direction: it would have marked a genuinely
// un-applied migration as applied, on the evidence of a different schema's tables.
//
// pg_constraint needs the namespace join for the same reason; conname alone is not
// unique across schemas.
async function exists(prisma, obj) {
  const q = (sql, ...args) => prisma.$queryRawUnsafe(sql, ...args);
  if (obj.kind === "table") {
    const r = await q(`SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1`, obj.name);
    return r.length > 0;
  }
  if (obj.kind === "index") {
    const r = await q(`SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1`, obj.name);
    return r.length > 0;
  }
  if (obj.kind === "constraint") {
    const r = await q(
      `SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = current_schema() AND c.conname = $1`,
      obj.name
    );
    return r.length > 0;
  }
  if (obj.kind === "column") {
    const [table, column] = obj.name.split(".");
    const r = await q(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
      table, column
    );
    return r.length > 0;
  }
  return false;
}

(async () => {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: node tools/resolve-failed-migration.js <migration_name> | --any");
    process.exit(2);
  }

  const prisma = new PrismaClient();
  try {
    const [{ schema }] = await prisma.$queryRawUnsafe(`SELECT current_schema() AS schema`);
    console.log(`[resolve-failed-migration] schema: ${schema}`);

    const failed = await prisma.$queryRawUnsafe(
      `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL ORDER BY started_at`
    );

    if (!failed.length) {
      console.log("[resolve-failed-migration] no failed migrations — nothing to do.");
      return;
    }

    const targets = arg === "--any" ? failed.map((r) => r.migration_name) : [arg];

    for (const name of targets) {
      if (!failed.some((r) => r.migration_name === name)) {
        console.log(`[resolve-failed-migration] "${name}" is not recorded as failed — skipping.`);
        continue;
      }

      const file = path.join(MIGRATIONS_DIR, name, "migration.sql");
      if (!fs.existsSync(file)) {
        console.error(`[resolve-failed-migration] REFUSING: ${name} is failed in the database but its SQL is not in this build, so what it should have created cannot be checked.`);
        process.exit(1);
      }

      const objects = objectsCreatedBy(fs.readFileSync(file, "utf8"));
      if (!objects.length) {
        console.error(`[resolve-failed-migration] REFUSING: no CREATE/ADD statements found in ${name}, so there is nothing to verify against.`);
        process.exit(1);
      }

      const missing = [];
      for (const o of objects) if (!(await exists(prisma, o))) missing.push(o);

      console.log(`[resolve-failed-migration] ${name}: ${objects.length} object(s) declared, ${objects.length - missing.length} already present.`);
      for (const o of objects) {
        console.log(`    ${missing.includes(o) ? "MISSING " : "present "} ${o.kind} ${o.name}`);
      }

      if (missing.length) {
        console.error(`[resolve-failed-migration] REFUSING to mark ${name} applied: ${missing.length} object(s) do not exist. This migration genuinely did NOT run, so it must be APPLIED, not annotated. Marking it applied here would leave the database permanently short of them.`);
        process.exit(1);
      }

      // Everything it creates is already there. Exactly what `prisma migrate resolve
      // --applied` writes, done directly because the Prisma CLI is not always on PATH
      // in a build container.
      await prisma.$executeRawUnsafe(
        `UPDATE _prisma_migrations SET finished_at = NOW(), applied_steps_count = 1, logs = NULL
         WHERE migration_name = $1 AND finished_at IS NULL`,
        name
      );
      console.log(`[resolve-failed-migration] ${name} marked as applied. No schema was changed.`);
    }
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error("[resolve-failed-migration] failed:", e.message);
  process.exit(1);
});
