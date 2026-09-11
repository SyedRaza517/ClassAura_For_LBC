#!/usr/bin/env node
// Refuses, at the tool layer, any command or MCP call that could destroy a database
// nobody meant to touch.
//
// WHY THIS EXISTS WHEN assertDisposable ALREADY DOES
//
// prisma/assertDisposable.js is the policy, and this file deliberately does not
// restate it — it imports parse(), LOCAL_HOSTS and DISPOSABLE_NAME and applies the
// same three tests in the same order. A second copy of the rules would drift, and the
// half that drifts is always the half nobody is looking at.
//
// What it adds is REACH. assertDisposable only runs where somebody remembered to call
// it: npm test, prisma/seed.js, scope-all-staff.js, tools/seed-demo.js. It is absent
// from every other route to the same rows:
//
//   - `prisma migrate dev` and `migrate reset`, which drop and recreate
//   - `prisma db push`, which rewrites the schema with no migration at all
//   - `prisma studio`, a full edit GUI pointed at whatever DATABASE_URL says
//   - `psql`
//   - the Supabase MCP tools, which reach staging AND production over HTTP and never
//     load a line of this repo's code
//
// CLAUDE.md is not a guard for any of these. It is context: the model reads it and
// tries to comply, and there is no guarantee of compliance — Claude Code's own
// documentation says to use a PreToolUse hook for anything that must actually be
// blocked. This is that hook. It runs before the tool call and can refuse it.
//
// WHY IT DEMANDS THE URL ON THE COMMAND LINE
//
// CLAUDE.md: "Always pass DATABASE_URL on the command line. Never let it fall through
// to server/.env." That instruction exists because server/.env has pointed at a live
// production database while `npm test` sat one keystroke away. A hook that read the
// env the same way the command would could only repeat the mistake in the same
// direction, so a DB-touching command with no inline DATABASE_URL is refused outright
// — not guessed at, not resolved from .env, refused. The remedy is one prefix long and
// it is in the refusal message.

const { createRequire } = require("module");
const { join } = require("path");

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const { parse, DISPOSABLE_NAME, LOCAL_HOSTS } = createRequire(__filename)(
  join(projectDir, "server", "prisma", "assertDisposable.js")
);

// ─── what counts as touching the database ────────────────────────────────────────
//
// npm's own flags sit BETWEEN the binary and the script — `npm --workspace server run
// migrate:deploy` is how CLAUDE.md spells every server command — so the patterns below
// would never see `npm run …` adjacent. Strip the flags first rather than trying to
// write a regex that tolerates them: the first version of this file did the latter,
// and guard-database.test.js caught `npm --workspace server run migrate:deploy` being
// allowed with no DATABASE_URL at all.
function normalise(command) {
  return command
    .replace(/\s--workspace(?:=|\s+)\S+/g, " ")
    .replace(/\s--prefix(?:=|\s+)\S+/g, " ")
    .replace(/\s-w\s+\S+/g, " ")
    .replace(/\s--(silent|quiet|loglevel(?:=|\s+)\S+)/g, " ")
    .replace(/\s+/g, " ");
}

// Read-only commands are carved out FIRST, because friction on a harmless command is
// how a guard gets switched off. `migrate status` and `generate` read; they never write.
const READ_ONLY = [
  /\bprisma\s+migrate\s+status\b/,
  /\bprisma\s+generate\b/,
  /\bnpm\s+(run\s+)?(migrate:status|generate)\b/,
];

const TOUCHES_DB = [
  /\bprisma\s+migrate\b/,               // dev, deploy, reset, resolve
  /\bprisma\s+db\s+(push|execute|seed|pull)\b/,
  /\bprisma\s+studio\b/,
  /\bnpm\s+(run\s+)?(seed|studio|setup|migrate(:deploy)?)\b/,
  /\bnpm\s+(run\s+)?test\b/,
  /\bnode\s+\S*scripts[/\\]test\.mjs\b/,
  /\bnode\s+\S*prisma[/\\](seed|scope-all-staff)\.js\b/,
  /\bnode\s+\S*tools[/\\]seed-demo\.js\b/,
  /\bpsql\b/,
  /\bpg_restore\b/,
  /\bdropdb\b/,
];

/** Pull an inline DATABASE_URL out of a command, in either shell's syntax. */
function inlineUrl(command) {
  // POSIX: DATABASE_URL="..." cmd    PowerShell: $env:DATABASE_URL = "..."
  const m =
    command.match(/(?:\$env:)?DATABASE_URL\s*=\s*"([^"]*)"/) ||
    command.match(/(?:\$env:)?DATABASE_URL\s*=\s*'([^']*)'/) ||
    command.match(/(?:\$env:)?DATABASE_URL\s*=\s*(\S+)/);
  return m ? m[1] : null;
}

function inlineConfirm(command) {
  const m =
    command.match(/(?:\$env:)?DESTRUCTIVE_DB_CONFIRM\s*=\s*"([^"]*)"/) ||
    command.match(/(?:\$env:)?DESTRUCTIVE_DB_CONFIRM\s*=\s*'([^']*)'/) ||
    command.match(/(?:\$env:)?DESTRUCTIVE_DB_CONFIRM\s*=\s*(\S+)/);
  return m ? m[1].trim().toLowerCase() : null;
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

/** Allow by staying silent: no decision, so the normal permission flow applies. */
function allow() {
  process.exit(0);
}

function checkShellCommand(command) {
  const probe = normalise(command);
  if (READ_ONLY.some((re) => re.test(probe))) allow();
  if (!TOUCHES_DB.some((re) => re.test(probe))) allow();

  // psql and friends name their host with -h rather than a URL, and the first-time
  // setup in the run-tests skill is exactly that: `psql -h localhost -c "CREATE
  // DATABASE edtech_dev"`. Refusing it would make the guard contradict the documented
  // route onto a safe machine, which is how a guard earns a reputation for crying wolf.
  // The test is the same one LOCAL_HOSTS applies, just read from the flag instead.
  const flagHost = probe.match(/\s-h(?:\s+|=)(\S+)/);
  if (flagHost && LOCAL_HOSTS.has(flagHost[1].toLowerCase())) allow();

  const url = inlineUrl(command);
  if (!url) {
    deny(
      "This command reads or writes a database, but carries no DATABASE_URL. It would " +
        "fall through to server/.env, which points at a live database.\n\n" +
        "Re-run it with the local one:\n\n" +
        '    DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" ' +
        command.trim() +
        "\n\nSee .claude/rules/database-safety.md."
    );
  }

  const parsed = parse(url);
  if (!parsed) {
    deny(`DATABASE_URL could not be parsed, so it cannot be checked: ${url}`);
  }

  const { host, database } = parsed;
  if (LOCAL_HOSTS.has(host)) allow();
  if (DISPOSABLE_NAME.test(database)) allow();

  const target = `${database}@${host}`;
  if (inlineConfirm(command) === target) allow();

  deny(
    `Refusing to run this against "${database}" on ${host} — a remote database whose ` +
      "name does not mark it as disposable.\n\n" +
      "If that is genuinely a throwaway database, confirm it by name:\n\n" +
      `    DESTRUCTIVE_DB_CONFIRM=${target} <command>\n\n` +
      "If you did not expect this database, the URL is pointing somewhere you did not " +
      "intend. Note that a ?schema= parameter is NOT part of this check: confirming " +
      "the name authorises the whole database, public schema included."
  );
}

// ─── Supabase MCP ────────────────────────────────────────────────────────────────
//
// These tools reach a real project over HTTP. There is no DATABASE_URL to inspect and
// no way from here to tell the staging project from the production one, so the split
// is by what the call DOES rather than where it lands: reads pass, writes do not.
const WRITES = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|comment\s+on|copy|vacuum|reindex|refresh\s+materialized)\b/i;

function checkSupabase(toolName, input) {
  if (/__apply_migration$/.test(toolName)) {
    deny(
      "apply_migration writes DDL straight into a live Supabase project, and this repo " +
        "keeps its schema in server/prisma/migrations — applied by `migrate:deploy` in " +
        "the deploy build, in order, from a history CI proves can build from nothing. A " +
        "migration applied out of band leaves that history unable to reproduce the " +
        "schema, and Prisma reports the drift as a failure on the next deploy.\n\n" +
        "Write the migration into server/prisma/migrations/ instead, and let the deploy " +
        "apply it. See .claude/rules/migrations.md."
    );
  }

  if (/__execute_sql$/.test(toolName)) {
    const sql = String(input.query || input.sql || "");
    if (WRITES.test(sql)) {
      deny(
        "execute_sql carrying a write, against a live Supabase project. Reads are fine " +
          "here; writes are not, because this path never touches assertDisposable and " +
          "there are two projects — staging and production — that this call cannot tell " +
          "apart.\n\nRun it against the local database, or ask the user to run it " +
          "themselves if it must land on the real one."
      );
    }
  }

  allow();
}

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // A guard that crashes must not become a guard that blocks everything. An
    // unreadable payload is a bug in this file, not evidence of a dangerous command.
    allow();
  }

  const toolName = payload.tool_name || "";
  const input = payload.tool_input || {};

  try {
    if (toolName === "Bash" || toolName === "PowerShell") {
      checkShellCommand(String(input.command || ""));
    } else if (/Supabase__/.test(toolName)) {
      checkSupabase(toolName, input);
    }
  } catch (err) {
    // Same reasoning as above, with one difference: say so, because a guard that has
    // silently stopped guarding is worse than one that is plainly broken.
    process.stderr.write(`guard-database.js failed open: ${err.message}\n`);
  }
  allow();
});
