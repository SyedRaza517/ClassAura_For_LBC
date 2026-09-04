#!/usr/bin/env node
// One-off remedy: fold the empty "Default Institution" into the real college, so the
// de-tenanting migration can run.
//
// WHY THIS EXISTS. `20260830T210000_remove_multi_tenancy` refuses to run against a
// database holding more than one Tenant row, and that guard is not negotiable: dropping
// tenantId does not separate institutions, it MERGES them, and afterwards the only
// record of who belonged to whom is the column just dropped. On 2 Sep 2026 the
// production deploy hit exactly that guard — two Tenant rows, so the migration raised,
// the transaction rolled back, and the build failed with the old one still serving.
//
// The two rows were not two colleges:
//
//   Default Institution     1 staff, 0 students, 0 marks, 0 admissions  — scaffold from
//                           first setup, branded "Twelvetech Systems Limited" (the
//                           supplier), not a college
//   London Brookes College  1 staff, 129 students, 9,651 attendance marks — the real one
//
// SO NOTHING IS DELETED EXCEPT THE SCAFFOLD ITSELF. The obvious reading of "delete the
// default tenant" would have taken the super-admin account with it — and that account is
// the operator's own login. Every row MOVES to the real college instead, which is the
// same end state the de-tenanting migration produces (one institution, both admins in
// it), reached without destroying anything. The single exception is TenantBranding: it
// is one row per institution, so the scaffold's cannot move alongside the college's, and
// a supplier's name is not an identity worth keeping.
//
// SAFE TO RE-RUN. Every precondition is checked before anything is written, and the
// whole thing is one transaction. If the database is not in the exact shape described
// above it refuses and changes nothing.
//
// Usage, with the PRODUCTION connection string — never let it fall through to .env:
//   DATABASE_URL="postgresql://..." node server/tools/merge-default-tenant.js          # dry run
//   DATABASE_URL="postgresql://..." node server/tools/merge-default-tenant.js --apply  # write
const { PrismaClient } = require("@prisma/client");

const DEFAULT_ID = "tenant_default";
const APPLY = process.argv.includes("--apply");

// The tables that actually hold rows for the scaffold tenant. Named explicitly rather
// than swept from information_schema: this is a one-off against a known database, and a
// loop that discovers its own targets is one that can discover the wrong ones.
//
// MOVED — the rows worth keeping. Staff is the operator's own login; AuditLog is the
// history of who did what, and history is the one thing that cannot be recreated.
const MOVE_TABLES = ["Staff", "AuditLog"];

// DELETED — rows that CANNOT move, because a unique key on (tenantId, …) means the
// destination already has its own. The first attempt tried to move these and Postgres
// refused with 23505 on SentNotification's (tenantId, key): both institutions had a
// `bankholiday:2026-08-31` marker. The transaction rolled back and nothing was written,
// which is why the whole thing is one transaction.
//
// Deleting them costs nothing real. SentNotification is a "we already sent this"
// dedupe marker and the destination holds its own copy of the one that collided;
// Notification is a bell-icon entry for a scaffold institution with one user; and
// TenantBranding is one row per institution carrying the SUPPLIER's name, not a
// college's. None is recoverable information.
const DELETE_TABLES = ["Notification", "SentNotification", "TenantBranding"];

const die = (msg) => { console.error(`\nREFUSING: ${msg}\n`); process.exit(1); };

(async () => {
  if (!process.env.DATABASE_URL) die("DATABASE_URL is not set. Pass it on the command line.");
  const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const host = (process.env.DATABASE_URL.match(/@([^/:]+)/) || [])[1];
  const dbname = (process.env.DATABASE_URL.match(/\/([^/?]+)(\?|$)/) || [])[1];
  console.log(`\nDatabase: ${dbname} at ${host}`);
  console.log(APPLY ? "Mode: APPLY (will write)\n" : "Mode: DRY RUN (nothing will be written)\n");

  // ---- Preconditions. Any surprise stops the run. ----
  const tenants = await db.$queryRawUnsafe(`SELECT id, name, slug FROM "Tenant" ORDER BY "createdAt"`);
  console.table(tenants);
  if (tenants.length !== 2) die(`expected exactly 2 institutions, found ${tenants.length}. This script is only for the known two-row case.`);

  const scaffold = tenants.find((t) => t.id === DEFAULT_ID);
  if (!scaffold) die(`no institution with id "${DEFAULT_ID}". Nothing matches the scaffold this script removes.`);
  const keep = tenants.find((t) => t.id !== DEFAULT_ID);

  // The scaffold must be EMPTY of anything that matters. If it has grown students or
  // attendance since this was written it is not a scaffold any more and folding it into
  // another college would be the very merge the migration guard exists to prevent.
  for (const [table, label] of [["Student", "students"], ["AttendanceMark", "attendance marks"], ["Admission", "admissions"]]) {
    const n = await db.$queryRawUnsafe(`SELECT count(*)::int c FROM "${table}" WHERE "tenantId" = $1`, DEFAULT_ID);
    if (n[0].c > 0) die(`"${scaffold.name}" owns ${n[0].c} ${label}. It is not an empty scaffold, and merging it would be irreversible.`);
  }

  console.log(`Scaffold to remove : ${scaffold.name} (${scaffold.slug})`);
  console.log(`Real college kept  : ${keep.name} (${keep.slug})\n`);

  const plan = [];
  for (const t of MOVE_TABLES) {
    const n = await db.$queryRawUnsafe(`SELECT count(*)::int c FROM "${t}" WHERE "tenantId" = $1`, DEFAULT_ID);
    plan.push({ table: t, action: "move", rows: n[0].c });
  }
  for (const t of DELETE_TABLES) {
    const n = await db.$queryRawUnsafe(`SELECT count(*)::int c FROM "${t}" WHERE "tenantId" = $1`, DEFAULT_ID);
    plan.push({ table: t, action: "DELETE (unique per institution — cannot move)", rows: n[0].c });
  }
  plan.push({ table: "Tenant", action: "DELETE (the scaffold itself)", rows: 1 });
  console.table(plan);

  const staff = await db.$queryRawUnsafe(`SELECT email, name, "isSuperAdmin" FROM "Staff" WHERE "tenantId" = $1`, DEFAULT_ID);
  if (staff.length) {
    console.log("Staff accounts being MOVED (not deleted) — these keep working:");
    console.table(staff);
  }

  if (!APPLY) {
    console.log("Dry run only. Re-run with --apply to make these changes.\n");
    await db.$disconnect();
    return;
  }

  await db.$transaction(async (tx) => {
    // Deletes first: a move into a row the destination already owns is what failed the
    // first attempt, and clearing the unmovable rows cannot itself collide.
    let dropped = 0;
    for (const t of DELETE_TABLES) {
      dropped += await tx.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "tenantId" = $1`, DEFAULT_ID);
    }
    let moved = 0;
    for (const t of MOVE_TABLES) {
      moved += await tx.$executeRawUnsafe(`UPDATE "${t}" SET "tenantId" = $1 WHERE "tenantId" = $2`, keep.id, DEFAULT_ID);
    }
    const gone = await tx.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE id = $1`, DEFAULT_ID);
    console.log(`\nmoved ${moved} rows, dropped ${dropped} unmovable rows, deleted ${gone} institution`);
  });

  const after = await db.$queryRawUnsafe(`SELECT id, name FROM "Tenant"`);
  console.log("\nInstitutions remaining:");
  console.table(after);
  console.table(await db.$queryRawUnsafe(`SELECT email, name, "isSuperAdmin" FROM "Staff" ORDER BY email`));
  console.log(after.length === 1
    ? "\nDONE — one institution. The de-tenanting migration's guard will now pass.\n"
    : `\nWARNING — ${after.length} institutions remain. Do not deploy.\n`);
  await db.$disconnect();
})().catch((e) => { console.error("\nFAILED:", e.message, "\n"); process.exit(1); });
