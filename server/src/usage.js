// How much of the shared database each institution is actually using.
//
// WHY THIS IS AN ESTIMATE, AND WHY THAT IS THE HONEST ANSWER
//
// Every institution's rows live in the SAME tables — that is the whole design. So
// Postgres cannot tell you "tenant X occupies N bytes": it knows the size of the
// Student table, not which slice of it belongs to which college. There is no exact
// figure available short of summing pg_column_size() over every row of every table,
// which is a full scan of the entire database per call and is not something an admin
// screen may do.
//
// So this apportions: for each table, take its real on-disk size (heap + indexes +
// TOAST), divide by its row count to get an average row cost, and multiply by the
// rows that belong to each tenant. It is arithmetic on real measurements rather than
// a guess, and it is labelled "estimated" everywhere it surfaces, because a number
// that will end up on an invoice must not pretend to a precision it does not have.
//
// Where it is least accurate:
//   • Small tables. Postgres allocates a minimum 8KB page, so a table with three rows
//     reports 8KB+ and each row looks enormous. Fine in aggregate, misleading per row.
//   • Wide rows. A student with a long address costs more than the table average.
//   • Dead tuples awaiting VACUUM are counted, because they genuinely occupy disk.
//
// File storage is NOT an estimate. Documents live in SharePoint or Supabase, not in
// Postgres, and their exact byte counts are recorded on the rows — so those are summed
// directly and reported separately. Conflating the two would be the misleading part:
// a college with 4GB of scanned passports has a tiny database and a large footprint.
const prisma = require("./db");
const { crossTenant } = require("./db");

/** Tables that carry a tenantId, discovered rather than hand-listed so a new one counts automatically. */
async function tenantedTables() {
  const rows = await crossTenant(() => prisma.$queryRawUnsafe(`
    SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN information_schema.columns col
      ON col.table_schema = n.nspname AND col.table_name = c.relname AND col.column_name = 'tenantId'
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `));
  return rows.map((r) => r.name);
}

/** Real on-disk size and row count per table. */
async function tableStats() {
  const rows = await crossTenant(() => prisma.$queryRawUnsafe(`
    SELECT c.relname AS name,
           pg_total_relation_size(c.oid)::bigint AS bytes,
           GREATEST(c.reltuples, 0)::bigint AS rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  `));
  const out = new Map();
  for (const r of rows) out.set(r.name, { bytes: Number(r.bytes), rows: Number(r.rows) });
  return out;
}

/**
 * Rows per (table, tenant), in ONE round trip.
 *
 * Built as a UNION ALL over the tenanted tables rather than 38 separate groupBy calls.
 * The table names come from pg_class, never from user input, and are double-quoted —
 * so this is not a place a slug or a form field can reach.
 */
async function rowsPerTenant(tables) {
  if (!tables.length) return [];
  const sql = tables
    .map((t) => `SELECT '${t}' AS t, "tenantId" AS tid, count(*)::bigint AS n FROM "${t}" GROUP BY "tenantId"`)
    .join("\nUNION ALL\n");
  return crossTenant(() => prisma.$queryRawUnsafe(sql));
}

/** Exact bytes held OUTSIDE Postgres — SharePoint / Supabase — per tenant. */
async function fileBytesPerTenant() {
  const rows = await crossTenant(() => prisma.$queryRawUnsafe(`
    SELECT tid, SUM(n)::bigint AS files, SUM(b)::bigint AS bytes FROM (
      SELECT "tenantId" AS tid, count(*)::bigint AS n, COALESCE(SUM("sizeBytes"), 0)::bigint AS b
        FROM "Document" GROUP BY "tenantId"
      UNION ALL
      SELECT "tenantId" AS tid, count(*)::bigint AS n, COALESCE(SUM("sizeBytes"), 0)::bigint AS b
        FROM "AdmissionDocument" GROUP BY "tenantId"
    ) x GROUP BY tid
  `));
  const out = new Map();
  for (const r of rows) out.set(r.tid, { files: Number(r.files), bytes: Number(r.bytes) });
  return out;
}

/**
 * Usage for every institution.
 *
 * @returns {Promise<{byTenant: Map<string, object>, databaseBytes: number, measuredAt: Date}>}
 */
async function usageByTenant() {
  const [tables, stats, counts, files] = await Promise.all([
    tenantedTables().then((t) => t),
    tableStats(),
    tenantedTables().then((t) => rowsPerTenant(t)),
    fileBytesPerTenant(),
  ]);

  // Average cost of one row in each table, from its real size.
  const perRow = new Map();
  for (const t of tables) {
    const s = stats.get(t);
    if (!s) continue;
    perRow.set(t, s.rows > 0 ? s.bytes / s.rows : 0);
  }

  const byTenant = new Map();
  const get = (tid) => {
    if (!byTenant.has(tid)) byTenant.set(tid, { rows: 0, estimatedBytes: 0, tables: {}, files: 0, fileBytes: 0 });
    return byTenant.get(tid);
  };

  for (const row of counts) {
    const tid = row.tid;
    if (!tid) continue;
    const n = Number(row.n);
    const bytes = Math.round(n * (perRow.get(row.t) || 0));
    const e = get(tid);
    e.rows += n;
    e.estimatedBytes += bytes;
    if (n > 0) e.tables[row.t] = { rows: n, estimatedBytes: bytes };
  }

  for (const [tid, f] of files) {
    const e = get(tid);
    e.files = f.files;
    e.fileBytes = f.bytes;
  }

  // Keep only the largest few tables per tenant — a 38-entry breakdown per college is
  // data, not information, and the screen shows a handful.
  for (const e of byTenant.values()) {
    e.topTables = Object.entries(e.tables)
      .sort((a, b) => b[1].estimatedBytes - a[1].estimatedBytes)
      .slice(0, 5)
      .map(([name, v]) => ({ name, rows: v.rows, estimatedBytes: v.estimatedBytes }));
    delete e.tables;
  }

  const dbSize = await crossTenant(() => prisma.$queryRawUnsafe(
    `SELECT pg_database_size(current_database())::bigint AS b`));

  return { byTenant, databaseBytes: Number(dbSize[0].b), measuredAt: new Date() };
}

/** 1.4 MB, 812 KB — for the UI and for logs. */
function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + " " + units[i];
}

module.exports = { usageByTenant, formatBytes };
