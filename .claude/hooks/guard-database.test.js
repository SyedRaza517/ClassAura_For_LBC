// Proves the guard refuses what it must and stays out of the way otherwise.
//
// Run:  node .claude/hooks/guard-database.test.js
//
// The second half matters as much as the first. A guard that refuses safe commands is
// a guard somebody deletes, and then nothing is checked at all.

const { spawnSync } = require("child_process");
const { join, dirname } = require("path");

const HOOK = join(__dirname, "guard-database.js");
const PROJECT_DIR = dirname(dirname(__dirname));
const LOCAL = 'DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev"';
const PROD = 'DATABASE_URL="postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres"';

function run(payload) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_DIR },
  });
  if (r.error) throw r.error;
  const out = (r.stdout || "").trim();
  if (!out) return { decision: "allow" };
  return { decision: JSON.parse(out).hookSpecificOutput.permissionDecision };
}

const shell = (command, tool = "Bash") =>
  run({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command } });

const supabase = (tool, input) =>
  run({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input });

const cases = [
  // ── must be REFUSED ───────────────────────────────────────────────────────────
  ["deny", "npm test with no URL — falls through to server/.env", () => shell("npm test")],
  ["deny", "seed with no URL", () => shell("npm run seed")],
  ["deny", "migrate dev with no URL", () => shell("npx prisma migrate dev --name x")],
  ["deny", "db push with no URL", () => shell("npx prisma db push")],
  ["deny", "studio with no URL", () => shell("npm run studio")],
  ["deny", "migrate:deploy with no URL", () => shell("npm --workspace server run migrate:deploy")],
  ["deny", "psql with no URL", () => shell("psql -c 'select 1'")],
  // The workspace flag sits between `npm` and `run`. This is the exact shape CLAUDE.md
  // documents, and the first version of the hook allowed all three of these.
  ["deny", "seed behind --workspace", () => shell("npm --workspace server run seed")],
  ["deny", "studio behind --workspace", () => shell("npm --workspace server run studio")],
  ["deny", "setup behind -w", () => shell("npm -w server run setup")],
  ["deny", "remote production URL, name not disposable", () => shell(`${PROD} npm test`)],
  ["deny", "the ?schema= dodge does not make it disposable", () =>
    shell('DATABASE_URL="postgresql://postgres:pw@db.abc.supabase.co:5432/postgres?schema=smoketest" npm test')],
  ["deny", "confirm token naming a DIFFERENT database", () =>
    shell(`DESTRUCTIVE_DB_CONFIRM=postgres@db.other.supabase.co ${PROD} npm test`)],
  ["deny", "PowerShell tool, same command", () =>
    shell('$env:DATABASE_URL = "postgresql://postgres:pw@db.abc.supabase.co:5432/postgres"; npm test', "PowerShell")],
  ["deny", "Supabase apply_migration", () =>
    supabase("mcp__claude_ai_Supabase__apply_migration", { project_id: "x", query: "create table t(id int)" })],
  ["deny", "Supabase execute_sql carrying a DELETE", () =>
    supabase("mcp__claude_ai_Supabase__execute_sql", { query: "delete from \"Student\" where id = 1" })],
  ["deny", "Supabase execute_sql carrying an UPDATE", () =>
    supabase("mcp__claude_ai_Supabase__execute_sql", { query: "update \"Staff\" set email = 'x' where id = 2" })],

  // ── must be ALLOWED ───────────────────────────────────────────────────────────
  ["allow", "local database, the documented route", () => shell(`${LOCAL} npm test`)],
  ["allow", "local database, one suite", () => shell(`${LOCAL} npm test -- smoke-nfc-tap`)],
  ["allow", "local database, migrate deploy", () => shell(`${LOCAL} npx prisma migrate deploy`)],
  ["allow", "remote but named disposable", () =>
    shell('DATABASE_URL="postgresql://u:p@db.abc.supabase.co:5432/edtech_staging" npm test')],
  ["allow", "typed confirmation matching the target exactly", () =>
    shell(`DESTRUCTIVE_DB_CONFIRM=postgres@db.abcdefgh.supabase.co ${PROD} npm test`)],
  ["allow", "migrate status is read-only", () => shell("npm --workspace server run migrate:status")],
  ["allow", "prisma generate touches no data", () => shell("npm --workspace server run generate")],
  ["allow", "unit tests do not use the database", () => shell('node --test "src/**/*.test.js"')],
  ["allow", "the client build", () => shell("npm run --workspace client build")],
  ["allow", "ordinary git", () => shell("git status --short")],
  ["allow", "grep for a migration by name", () => shell("grep -rn migrate server/prisma")],
  ["allow", "Supabase execute_sql read", () =>
    supabase("mcp__claude_ai_Supabase__execute_sql", { query: 'select count(*) from "Student"' })],
  ["allow", "Supabase list_tables", () =>
    supabase("mcp__claude_ai_Supabase__list_tables", { project_id: "x" })],
  // The first-time setup the run-tests skill documents. A guard that refuses its own
  // project's documented setup command is a guard somebody turns off.
  ["allow", "psql explicitly at localhost", () =>
    shell('psql -U postgres -h localhost -c "CREATE DATABASE edtech_dev"')],
  ["allow", "psql at 127.0.0.1", () => shell("psql -h 127.0.0.1 -c 'select 1'")],
  ["deny", "psql at a remote host", () =>
    shell("psql -h db.abcdefgh.supabase.co -U postgres -c 'truncate \"Student\"'")],
];

let failed = 0;
for (const [expected, name, fn] of cases) {
  let actual;
  try {
    actual = fn().decision;
  } catch (err) {
    actual = `threw: ${err.message}`;
  }
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${expected.padEnd(5)}  ${name}${ok ? "" : `  (got ${actual})`}`);
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
