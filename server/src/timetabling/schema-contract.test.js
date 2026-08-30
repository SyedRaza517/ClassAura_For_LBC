// The timetabling schema, asserted as text.
//
// Reading schema.prisma as a string rather than probing the generated client is
// deliberate, and follows src/prediction/schema-contract.test.js: it catches a
// hand-edit to the schema in the same commit that makes it, rather than at the
// moment some unrelated query returns the wrong shape in production.
//
// Two of these assertions are not stylistic.
//
// TimetableEvent.unitId MUST stay nullable. It is the whole reason this table exists
// rather than an extension of HndSession — an exam, a workshop, study support or a
// staff meeting belongs to no module, and HndSession.unitId is NOT NULL. A later
// reader tidying up "why is this optional" would quietly delete the feature.
//
// Room.capacity MUST stay nullable. Null means "we have not recorded how many this
// room seats", which is not the same as zero. A zero would make the room unusable by
// any future capacity check, retiring a real room because nobody had measured it.
// This is the null-is-not-zero convention the academic code already runs on.
//
// Run with: node --test src/timetabling/schema-contract.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");

/** The body of one `model X { ... }` block, or null. */
function modelBody(name) {
  const m = SCHEMA.match(new RegExp(`\\nmodel ${name} \\{([\\s\\S]*?)\\n\\}`));
  return m ? m[1] : null;
}

const MODELS = [
  "Room", "EventCategory", "TimetableEvent",
  "TimetableEventStaff", "TimetableEventGroup",
  "TimetableSettings", "TimetableUserPref",
];

// A "${name} is tenant-scoped" case used to sit beside the existence check, asserting
// `tenantId String` and `@@index([tenantId])` on each of these models. It is DELETED,
// not adapted. The column is gone from the schema, so any surviving form of it — a
// negative "has no tenantId", a check that the index is absent — would pass on every
// future edit to these models without discriminating between a correct schema and a
// broken one, while still reading as coverage on the summary line.
for (const name of MODELS) {
  test(`${name} exists`, () => {
    assert.ok(modelBody(name), `model ${name} is missing from schema.prisma`);
  });
}

test("TimetableEvent.unitId is nullable", () => {
  assert.match(modelBody("TimetableEvent"), /unitId\s+String\?/);
});

test("TimetableEvent.courseId, roomId and categoryId are nullable", () => {
  const body = modelBody("TimetableEvent");
  assert.match(body, /courseId\s+String\?/);
  assert.match(body, /roomId\s+String\?/);
  assert.match(body, /categoryId\s+String\?/);
});

test("Room.capacity is nullable", () => {
  assert.match(modelBody("Room"), /capacity\s+Int\?/);
});

test("a room number is unique per campus, not globally", () => {
  // Two campuses may both have a room 101 — the reference institution has exactly
  // that, listing "101 [Harrow]" and "101 - First floor [Great Titchfield Street]".
  // A unique on name alone would refuse the second one.
  assert.match(modelBody("Room"), /@@unique\(\[name, campus\]\)/);
});

test("an event cannot list the same staff member or group twice", () => {
  assert.match(modelBody("TimetableEventStaff"), /@@unique\(\[eventId, staffId\]\)/);
  assert.match(modelBody("TimetableEventGroup"), /@@unique\(\[eventId, cohortId\]\)/);
});

test("one pref row per staff member", () => {
  // Without this a staff member could accumulate two preference rows, and the
  // findFirst in timetabling/settings.js would return whichever the planner picked —
  // their own settings changing between page loads for no visible reason.
  assert.match(modelBody("TimetableUserPref"), /@@unique\(\[staffId\]\)/);
});

// The other half of that test asserted @@unique([tenantId]) on TimetableSettings, and
// is DELETED with the column. What replaced the guarantee is a constant primary key,
// and THAT is what the test below pins — for a while this comment said the schema
// carried no such thing, which was true of an earlier draft and would have sent a
// reader off to fix a gap that had already been closed.

// One settings row, and the schema has to say so. settings.js upserts on the literal
// "singleton" and its `create` does not set an id, so it relies entirely on this
// default; if the default reverted to cuid(), two saves racing on an empty table
// would insert two rows and findFirst() would then pick between two sets of the
// college's settings. The same constant guards TenantBranding,
// AttendanceBandConfig, PredictionModelSettings, AttendanceTapConfig and Tenant.
test("the timetable settings row is a singleton, by constant primary key", () => {
  const model = modelBody("TimetableSettings");
  assert.match(model, /id\s+String\s+@id @default\("singleton"\)/,
    "TimetableSettings.id must default to the literal \"singleton\" — see settings.js saveInstitution()");
});

test("events are indexed by date, because every read is a date-window read", () => {
  assert.match(modelBody("TimetableEvent"), /@@index\(\[date\]\)/);
});
