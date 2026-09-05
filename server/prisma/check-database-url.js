// Refuse to migrate through an address a migration cannot survive.
//
// Runs first in `npm run migrate:deploy`, which is the build step on Render. A Supabase
// TRANSACTION pooler URL (port 6543) makes `prisma migrate deploy` hang on its advisory
// lock rather than fail, and a hung build is a stopped deploy pipeline that DEPLOY.md
// records as having already cost a day. This turns that into a fast, named failure with
// the fix in it. On the correct URL — the session pooler, or a direct or local address —
// it prints one line and exits 0. See src/databaseUrl.js for the rules.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { databaseUrlVerdict, describeDatabaseUrl } = require("../src/databaseUrl");

const v = databaseUrlVerdict(process.env.DATABASE_URL);
if (!v.migrateOk) {
  console.error(`\n✗ Not migrating. ${v.problem}\n`);
  process.exit(1);
}
// An address this check could not read is NOT a refusal: Prisma is the authority on what
// it accepts, and this must never be the step that breaks a deploy that was working.
console.log(`Database: ${describeDatabaseUrl(process.env.DATABASE_URL)}`);
