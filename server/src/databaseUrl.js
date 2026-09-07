// Which kind of Postgres address DATABASE_URL is, and whether it is safe for the job.
//
// PRODUCTION IS SUPABASE, REACHED THROUGH ITS POOLER, AND THE POOLER HAS TWO MODES ON TWO
// PORTS. Session mode (5432) keeps one backend per client for the life of the connection,
// so it behaves like a direct connection: prepared statements work, advisory locks work,
// and it is right for both the running API and `prisma migrate deploy`. Transaction mode
// (6543) hands a backend out per statement. Prisma needs `pgbouncer=true` on that URL or
// its second query fails with "prepared statement s0 already exists"; and a migration
// through it hangs on the advisory lock migrate takes, which stops the whole deploy
// pipeline, silently — DEPLOY.md records that a stuck migration has already cost a day.
//
// DEPLOY.md and render.yaml both say "paste the session pooler URL". Nothing checked.
// This does: `npm run migrate:deploy` refuses a URL that cannot migrate BEFORE Prisma
// starts, with a message that says which port to paste instead, and the boot banner
// prints a line naming the mode so a wrong one is visible in the first screen of the
// log rather than at the first scan of the first lecture.
//
// WHY NOT `directUrl` IN THE SCHEMA. Prisma's answer to a transaction pooler is a second
// variable, DIRECT_URL, for the CLI. Declaring it makes the CLI REQUIRE it, and a Render
// service that already exists does not receive a new Blueprint variable — so the day it
// was declared, the next deploy of the live service would fail on a variable nobody had
// been asked to set. The check below costs nothing on the correct URL and needs no new
// variable, which is the property that matters on a service configured by hand.
//
// Pure, and the URL is passed in, so every branch is a unit test without an environment.

const SUPABASE_POOLER = /\.pooler\.supabase\.(com|co)$/i;

/**
 * Host, port and whether `pgbouncer=true` is present, from a connection string that
 * Node's URL parser may or may not accept.
 *
 * THE PARSER IS NOT THE AUTHORITY, PRISMA IS. prisma/assertDisposable.js records a real
 * incident on this project: a password with characters the WHATWG parser rejects, on a
 * string Prisma accepted without complaint. So when `new URL` throws, the host and port
 * are read from after the LAST `@` instead — a password can contain `@`, a host cannot —
 * and only when that finds nothing is the address reported as unreadable.
 */
function parts(url) {
  try {
    const u = new URL(url);
    if (/^postgres(ql)?:$/.test(u.protocol) && u.hostname) {
      return { host: u.hostname, port: u.port ? Number(u.port) : 5432, pgbouncer: u.searchParams.get("pgbouncer") === "true" };
    }
  } catch { /* fall through to the lenient read */ }
  const at = url.lastIndexOf("@");
  if (at < 0) return null;
  const m = /^([^/?#:\s]+)(?::(\d+))?/.exec(url.slice(at + 1));
  if (!m) return null;
  return { host: m[1], port: m[2] ? Number(m[2]) : 5432, pgbouncer: /[?&]pgbouncer=true(?:&|$)/.test(url) };
}

/**
 * @param {string|undefined} url
 * @returns {{ ok: boolean, migrateOk: boolean, mode: "direct"|"session-pooler"|"transaction-pooler"|"unknown", host: string|null, port: number|null, problem: string|null }}
 *
 * The ONLY hard refusal is a confirmed Supabase transaction pooler. Anything that cannot
 * be read is passed through with a note: this check exists to stop a known-bad address
 * from stalling a deploy, and must never itself be the thing that stops a working one.
 */
function databaseUrlVerdict(url) {
  const unknown = (problem) => ({ ok: true, migrateOk: true, mode: "unknown", host: null, port: null, problem });
  if (typeof url !== "string" || !url.trim()) return unknown("DATABASE_URL is not set; Prisma will say so if it needs it.");
  const p = parts(url.trim());
  if (!p) return unknown("DATABASE_URL could not be read as a connection URL here; leaving it to Prisma.");

  const { host, port, pgbouncer } = p;
  const pooler = SUPABASE_POOLER.test(host);

  if (pooler && port === 6543) {
    const paste = "Paste the SESSION pooler URL instead (same host, port 5432): it is right for both the app and migrations.";
    if (!pgbouncer) {
      return {
        ok: false, migrateOk: false, mode: "transaction-pooler", host, port,
        problem: `DATABASE_URL is the Supabase TRANSACTION pooler (port 6543) without pgbouncer=true. Prisma's queries fail on it and a migration hangs. ${paste}`,
      };
    }
    return {
      ok: true, migrateOk: false, mode: "transaction-pooler", host, port,
      problem: `DATABASE_URL is the Supabase transaction pooler (port 6543). The app can run on it, but a migration cannot: prisma migrate deploy hangs there. ${paste}`,
    };
  }
  return { ok: true, migrateOk: true, mode: pooler ? "session-pooler" : "direct", host, port, problem: null };
}

/**
 * One line for the boot banner. Host, port and mode — never the user or the password,
 * because this log gets pasted into chats and screenshots.
 */
function describeDatabaseUrl(url) {
  const v = databaseUrlVerdict(url);
  if (v.mode === "unknown") return v.problem;
  const where = `${v.host}:${v.port}`;
  if (v.mode === "session-pooler") return `${where} (Supabase session pooler: right for the app and for migrations)`;
  if (v.mode === "transaction-pooler") return `${where} (Supabase transaction pooler) — ${v.problem}`;
  return `${where} (direct connection)`;
}

module.exports = { databaseUrlVerdict, describeDatabaseUrl };
