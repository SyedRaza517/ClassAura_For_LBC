// Which kind of Postgres address DATABASE_URL is, and whether it is safe for the job.
//
// Production runs on Supabase, reached through its pooler, and the pooler has two modes
// on two ports. Session mode (5432) behaves like a direct connection and is right for
// both the running API and `prisma migrate deploy`. Transaction mode (6543) is not: Prisma
// needs `pgbouncer=true` on it or prepared statements fail on the second query, and a
// migration through it hangs on the advisory lock it takes. DEPLOY.md says which one to
// paste, and nothing in the repo checked. These tests pin the check that now runs before
// every migration and prints a line in the boot banner.
//
// Run with: node --test src/databaseUrl.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { databaseUrlVerdict, describeDatabaseUrl } = require("./databaseUrl");

const SESSION = "postgresql://postgres.abcdefghij:secret-pw@aws-0-eu-north-1.pooler.supabase.com:5432/postgres";
const TRANSACTION = "postgresql://postgres.abcdefghij:secret-pw@aws-0-eu-north-1.pooler.supabase.com:6543/postgres";
const TRANSACTION_OK = TRANSACTION + "?pgbouncer=true";
const DIRECT = "postgresql://postgres:secret-pw@db.abcdefghij.supabase.co:5432/postgres";
const LOCAL = "postgresql://postgres:postgres@localhost:5432/edtech_dev";

test("the session pooler is right for both the app and migrations", () => {
  const v = databaseUrlVerdict(SESSION);
  assert.equal(v.mode, "session-pooler");
  assert.equal(v.ok, true);
  assert.equal(v.migrateOk, true);
});

test("a local or direct address is right for both", () => {
  for (const url of [LOCAL, DIRECT]) {
    const v = databaseUrlVerdict(url);
    assert.equal(v.mode, "direct", url);
    assert.equal(v.ok, true, url);
    assert.equal(v.migrateOk, true, url);
  }
});

test("the transaction pooler without pgbouncer=true is refused outright", () => {
  const v = databaseUrlVerdict(TRANSACTION);
  assert.equal(v.mode, "transaction-pooler");
  assert.equal(v.ok, false);
  assert.equal(v.migrateOk, false);
  assert.match(v.problem, /pgbouncer=true/);
  assert.match(v.problem, /5432/);
});

test("the transaction pooler with pgbouncer=true runs the app but cannot migrate", () => {
  const v = databaseUrlVerdict(TRANSACTION_OK);
  assert.equal(v.mode, "transaction-pooler");
  assert.equal(v.ok, true);
  assert.equal(v.migrateOk, false);
  assert.match(v.problem, /migrat/i);
  assert.match(v.problem, /5432/);
});

// THE CHECK MUST NEVER BE THE THING THAT BREAKS A WORKING DEPLOY. prisma/assertDisposable.js
// records a real incident: a password with characters Node's URL parser rejects, on a
// string Prisma accepts. So an address that cannot be parsed is handed to Prisma, not
// refused — the only hard refusal is a CONFIRMED transaction pooler.
test("an unset or unparseable value is left to Prisma, with a note, never refused", () => {
  for (const url of [undefined, "", "not a url", "postgres://"]) {
    const v = databaseUrlVerdict(url);
    assert.equal(v.ok, true, String(url));
    assert.equal(v.migrateOk, true, String(url));
    assert.equal(v.mode, "unknown", String(url));
    assert.equal(typeof v.problem, "string");
  }
});

test("a password the URL parser chokes on still has its host and port read", () => {
  // `p#ss` makes the parser see a fragment and an invalid port; the address is still
  // unmistakably the transaction pooler, and still refused.
  const awkward = "postgresql://postgres.abcdefghij:p#ss%w@rd@aws-0-eu-north-1.pooler.supabase.com:6543/postgres";
  const v = databaseUrlVerdict(awkward);
  assert.equal(v.mode, "transaction-pooler");
  assert.equal(v.ok, false);
  // ...and the same password on the session pooler passes untouched.
  const fine = databaseUrlVerdict("postgresql://postgres.abcdefghij:p#ss%w@rd@aws-0-eu-north-1.pooler.supabase.com:5432/postgres");
  assert.equal(fine.mode, "session-pooler");
  assert.equal(fine.migrateOk, true);
});

test("the banner line names the host, port and mode, and never the password", () => {
  const line = describeDatabaseUrl(SESSION);
  assert.match(line, /aws-0-eu-north-1\.pooler\.supabase\.com:5432/);
  assert.match(line, /session/i);
  assert.doesNotMatch(line, /secret-pw/);
  assert.doesNotMatch(line, /postgres\.abcdefghij/);
});

test("the banner line for a refused address carries the problem", () => {
  const line = describeDatabaseUrl(TRANSACTION);
  assert.match(line, /6543/);
  assert.match(line, /pgbouncer=true/);
});
