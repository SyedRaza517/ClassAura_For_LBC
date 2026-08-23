// Refuses to let a destructive script run against a database that is not obviously
// disposable.
//
// WHY THIS EXISTS
//
// prisma/seed.js opens with deleteMany() on staff, students, check-ins, leave,
// documents, adjustments, attendance marks, sessions, enrolments and units. It is
// reached by `npm run seed`, by `npm test` and by `npm run setup`, and it targets
// whatever DATABASE_URL happens to say. The only guard was a check that the variable
// was set at all, plus a comment asking the caller to please point it somewhere safe.
//
// That is not a guard, it is a hope — and the hope failed: a developer .env in this
// project pointed DATABASE_URL at a LIVE production database belonging to an entirely
// separate product, while `npm test` sat one keystroke away. Nothing would have
// stopped it.
//
// AN ALLOWLIST, DELIBERATELY
//
// The obvious fix is to blocklist the production hosts. It is also the wrong one, for
// the same reason src/tenant.js gives for refusing to blocklist hostnames: no list of
// the dangerous ones is ever complete, and the entry you forget is the one that costs
// you a customer's data. So this recognises the databases that are SAFE and refuses
// everything else. A new production database added tomorrow is protected without
// anyone remembering to protect it.
//
// The escape hatch is a typed confirmation rather than a boolean, matching how account
// deletion already works in this product: you name the database you are about to wipe.
// A flag like FORCE=1 gets pasted into a shell profile and stops meaning anything; a
// name has to be looked up and retyped each time, against the URL actually in front of
// you.

/** Pull { host, database } out of a Postgres URL without needing a driver. */
function parse(url) {
  try {
    // The URL parser handles postgres:// fine; the password may contain characters it
    // dislikes, so failures fall through to "unrecognised" rather than throwing.
    const u = new URL(url);
    return {
      host: (u.hostname || "").toLowerCase(),
      database: decodeURIComponent((u.pathname || "").replace(/^\//, "")).toLowerCase(),
    };
  } catch {
    return null;
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal", "postgres", "db"]);
// Database names that say "throw me away" on their face.
const DISPOSABLE_NAME = /(^|[_-])(test|tests|testing|staging|stage|scratch|tmp|temp|dev|ci)([_-]|$)/;

/**
 * Throw unless the database named by DATABASE_URL is safe to destroy.
 *
 * @param {string} action  what the caller is about to do, for the error message.
 */
function assertDisposable(action = "This script deletes data") {
  const url = process.env.DATABASE_URL || "";
  if (!url) {
    fail(action, "DATABASE_URL is not set.", []);
  }

  const parsed = parse(url);
  if (!parsed) {
    fail(action, "DATABASE_URL could not be parsed, so it cannot be checked.", []);
  }

  const { host, database } = parsed;

  // 1. Anything on this machine or a CI service container. A local database is the
  //    developer's own and a container dies with the job.
  if (LOCAL_HOSTS.has(host)) return;

  // 2. A remote database whose NAME says it is disposable — edtech_staging, foo_test.
  //    The host is remote, so the name has to carry the intent.
  if (DISPOSABLE_NAME.test(database)) return;

  // 3. Explicit typed confirmation, as database@host.
  //
  //    The host is part of the token on purpose. Managed Postgres names the default
  //    database "postgres", so EVERY production database in this account is called
  //    that — confirming on the name alone would mean one token unlocks all of them,
  //    including the separate product's. Naming the host makes the confirmation refer
  //    to exactly one database and nothing else.
  const target = `${database}@${host}`;
  const confirmed = (process.env.DESTRUCTIVE_DB_CONFIRM || "").trim().toLowerCase();
  if (confirmed && confirmed === target) return;

  fail(action, `refusing to touch "${database}" on ${host}.`, [
    `That database is remote and its name does not mark it as disposable, so this`,
    `script will not assume it is safe to delete from.`,
    ``,
    `If it genuinely IS a throwaway database, confirm by naming it in full:`,
    ``,
    `    DESTRUCTIVE_DB_CONFIRM=${target} <your command>`,
    ``,
    `PowerShell:  $env:DESTRUCTIVE_DB_CONFIRM = "${target}"`,
    ``,
    `If you did not expect this database, your DATABASE_URL is pointing somewhere`,
    `you did not intend - check server/.env before doing anything else.`,
  ]);
}

function fail(action, reason, extra) {
  const line = "─".repeat(72);
  console.error(
    "\n" + line +
    "\n  REFUSED — " + action +
    "\n  " + reason +
    (extra.length ? "\n\n  " + extra.join("\n  ") : "") +
    "\n" + line + "\n"
  );
  process.exit(1);
}

module.exports = { assertDisposable, parse, DISPOSABLE_NAME, LOCAL_HOSTS };
