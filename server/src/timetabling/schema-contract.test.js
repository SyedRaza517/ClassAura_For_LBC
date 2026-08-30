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

for (const name of MODELS) {
  test(`${name} exists`, () => {
    assert.ok(modelBody(name), `model ${name} is missing from schema.prisma`);
  });

  test(`${name} is tenant-scoped`, () => {
    const body = modelBody(name) || "";
    // Without this, db.js cannot filter the model. Every query would throw
    // TenantScopeError at runtime — or, if somebody "fixed" that by adding the model
    // to UNSCOPED_MODELS, would return every college's rows to every college.
    assert.match(body, /tenantId\s+String/, `${name} has no tenantId`);
    assert.match(body, /@@index\(\[tenantId\]\)/, `${name} does not index tenantId`);
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
  // A global unique on name would refuse the second one.
  assert.match(modelBody("Room"), /@@unique\(\[tenantId, name, campus\]\)/);
});

test("an event cannot list the same staff member or group twice", () => {
  assert.match(modelBody("TimetableEventStaff"), /@@unique\(\[eventId, staffId\]\)/);
  assert.match(modelBody("TimetableEventGroup"), /@@unique\(\[eventId, cohortId\]\)/);
});

test("one settings row per tenant, one pref row per staff member", () => {
  assert.match(modelBody("TimetableSettings"), /@@unique\(\[tenantId\]\)/);
  assert.match(modelBody("TimetableUserPref"), /@@unique\(\[tenantId, staffId\]\)/);
});

test("events are indexed by date, because every read is a date-window read", () => {
  assert.match(modelBody("TimetableEvent"), /@@index\(\[tenantId, date\]\)/);
});
