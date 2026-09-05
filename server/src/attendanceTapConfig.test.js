// The settings cache, when the database is not there to read.
//
// Every scan and every mint reads this college's check-in settings first. The first
// version treated ANY failure to read the row as "no row" and cached the defaults for
// thirty seconds — so a pooler blip mid-lecture switched the feature off for half a
// minute, and a hall of students was told "scanning isn't switched on" for what was a
// connectivity fault. Local Postgres never blips; a shared Supabase pooler can.
//
// The rule now: a read that fails serves the LAST VALUE THE DATABASE CONFIRMED, if there
// is one, and throws if there is none — it never invents defaults and never caches a
// failure. The one exception is the table not existing yet (Prisma P2021), which really
// does mean "nothing configured", and keeps the old answer.
//
// The database is stubbed by planting a fake at db.js's place in the require cache
// before this module is loaded — the only unit test in the repo that touches this
// module, and it still opens no connection.
//
// Run with: node --test src/attendanceTapConfig.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Cache disabled, so every get() reaches the (fake) database and the last-known-good
// behaviour is what is under test rather than the TTL.
process.env.ATTENDANCE_TAP_CACHE_MS = "0";

let answer = null; // () => row | throws
let saved = null;
const fakePrisma = { attendanceTapConfig: { findFirst: async () => answer(), upsert: async ({ update }) => { saved = update.settings; return { id: "singleton", settings: saved }; } } };
require.cache[require.resolve("./db")] = { id: require.resolve("./db"), filename: path.resolve(__dirname, "db.js"), loaded: true, exports: fakePrisma };

const tapConfig = require("./attendanceTapConfig");
const { DEFAULTS } = require("./attendanceTapSettings");

const row = (settings) => ({ id: "singleton", settings });
const tableMissing = () => Object.assign(new Error("The table `public.AttendanceTapConfig` does not exist"), { code: "P2021" });
const poolerDown = () => new Error("Can't reach database server at `aws-0-eu-north-1.pooler.supabase.com:5432`");

// FIRST, before any read has succeeded: the module keeps the last confirmed value for the
// life of the process, so this is the only moment "nothing confirmed yet" is true.
test("a failed read with nothing confirmed yet throws rather than inventing settings", async () => {
  answer = () => { throw poolerDown(); };
  await assert.rejects(() => tapConfig.get(), /reach database/);
});

test("a table that does not exist yet still means the defaults", async () => {
  answer = () => { throw tableMissing(); };
  const s = await tapConfig.get();
  assert.equal(s.qrEnabled, DEFAULTS.qrEnabled);
  assert.equal(s.qrRotateSeconds, DEFAULTS.qrRotateSeconds);
});

test("a failed read serves the last value the database confirmed", async () => {
  answer = () => row({ qrRotateSeconds: 45 });
  assert.equal((await tapConfig.get()).qrRotateSeconds, 45);
  answer = () => { throw poolerDown(); };
  assert.equal((await tapConfig.get()).qrRotateSeconds, 45, "served the confirmed value during the outage");
});

test("a failure is never sticky: the next good read wins", async () => {
  answer = () => row({ qrRotateSeconds: 45 });
  await tapConfig.get();
  answer = () => { throw poolerDown(); };
  await tapConfig.get();
  answer = () => row({ qrRotateSeconds: 60 });
  assert.equal((await tapConfig.get()).qrRotateSeconds, 60);
});

test("a save is a confirmation: a failed read straight after it serves the saved value", async () => {
  answer = () => row({ qrEnabled: true, qrRotateSeconds: 45 });
  await tapConfig.get();
  // The administrator switches it off. The upsert succeeds; the very next read fails.
  answer = () => row({ qrEnabled: true, qrRotateSeconds: 45 }); // what save() reads as its base
  await tapConfig.save({ qrEnabled: false }, "admin");
  answer = () => { throw poolerDown(); };
  assert.equal((await tapConfig.get()).qrEnabled, false, "the switch-off held through the outage");
});
