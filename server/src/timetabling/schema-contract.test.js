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

/**
 * The same body with every comment line removed.
 *
 * NEEDED FOR NEGATIVE ASSERTIONS, and the reason is a bug this file already had. The
 * comment on HndSession explains why `@@unique([unitId, date, startTime])` was removed
 * — so it QUOTES the line, and a test asserting the declaration is absent matched the
 * explanation instead and failed against a correct schema. A negative assertion that
 * cannot tell a declaration from a mention of one is worse than none: it would equally
 * have passed had the constraint been reinstated with a comment nearby.
 */
const declarations = (body) =>
  String(body ?? "").split("\n").filter((l) => !/^\s*(\/\/|\/\/\/)/.test(l)).join("\n");

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
  //
  // Keyed on campusId since 7 Sep 2026. It was [name, campus] against the free-text
  // string, which meant "101" on "Ealing" and "101" on "ealing" were two different
  // rooms — the constraint that exists to prevent a duplicate room was defeated by a
  // capital letter.
  assert.match(modelBody("Room"), /@@unique\(\[name, ?campusId\]\)/);
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

// ---------------------------------------------------------------------------
// The register link (7 Sep 2026), and the two indexes Prisma cannot see.
// ---------------------------------------------------------------------------

test("HndSession does NOT carry @@unique([unitId, date, startTime])", () => {
  // Reinstating it would forbid the second register a MERGED CLASS needs — one module,
  // one start time, two groups — and would forbid it at the database, so the failure
  // surfaces as a 500 on publish rather than as anything a person can act on.
  //
  // The guarantee it used to give (a repeated generate run silently doubling every
  // attendance denominator) is not lost: HndSession_generated_key applies it to exactly
  // the rows it still describes.
  // `declarations`, not the raw body: the comment three lines above the indexes quotes
  // this exact constraint to explain why it went, and matching that would fail against
  // a correct schema while equally passing on a reinstated one.
  assert.ok(
    !/@@unique\(\[unitId, ?date, ?startTime\]\)/.test(declarations(modelBody("HndSession"))),
    "the @@unique was reinstated — see HndSession_generated_key in 20260907T120000_timetabling_registers",
  );
});

test("HndSession names both partial indexes in a comment", () => {
  // THIS COMMENT IS THE ONLY THING PRISMA LEAVES BEHIND. A partial unique index is not
  // expressible in schema.prisma, so `prisma migrate dev` sees both as drift and would
  // drop them — and nothing would notice until duplicate registers appeared. The
  // comment is what a person reads before deciding the indexes are stale junk.
  const body = modelBody("HndSession");
  assert.match(body, /HndSession_generated_key/);
  assert.match(body, /HndSession_event_group_key/);
  assert.match(body, /20260907T120000_timetabling_registers/,
    "the comment must name the migration the indexes live in, or they cannot be found");
});

test("HndSession.timetableEventId, cohortId and roomId are all nullable", () => {
  // Every one of them is absent for a register the Moodle import or the three-hour-block
  // generator created, and NOT NULL would make those registers impossible to write.
  const body = modelBody("HndSession");
  for (const f of ["timetableEventId", "cohortId", "roomId"]) {
    assert.match(body, new RegExp(`${f}\\s+String\\?`), `HndSession.${f} must stay nullable`);
  }
});

test("deleting a timetable event, group or room never cascades into attendance", () => {
  // SetNull on all three. Cascade here would let removing a room delete the registers
  // taken in it — the college's evidence for who attended, destroyed by a tidy-up.
  const body = modelBody("HndSession");
  const rels = body.match(/onDelete: \w+/g) || [];
  assert.ok(rels.length >= 3, "expected the three new relations to declare onDelete");
  assert.ok(!/onDelete: Cascade/.test(body.split("marks AttendanceMark[]")[1] || ""),
    "no relation added below `marks` may cascade — attendance must survive its timetable");
});

test("Campus.name is unique, so a spelling cannot be entered twice", () => {
  assert.match(modelBody("Campus"), /name\s+String\s+@unique/);
});

test("Room keys its unique on campusId, not the campus string", () => {
  // With the string, "Room 101" on "Ealing" and on "ealing" were two different rooms,
  // so the constraint meant to prevent a duplicate room was defeated by a capital.
  const body = modelBody("Room");
  assert.match(body, /@@unique\(\[name, ?campusId\]\)/);
  assert.ok(!/@@unique\(\[name, ?campus\]\)/.test(body), "the old string-keyed unique is still there");
});

test("Room.campus is retained, because it is the only record of the free text", () => {
  // Dropping it in the migration that consumes it would leave nothing to check the
  // fold against, and nothing to recover from if two campuses were wrongly merged.
  assert.match(modelBody("Room"), /campus\s+String\s+@default\(""\)/);
});

test("TimetableEvent.publishedAt is nullable, and distinct from published", () => {
  // NULL means never published; published=false after a withdrawal means "was, is not
  // now". Register creation triggers on the transition and must tell them apart.
  const body = modelBody("TimetableEvent");
  assert.match(body, /publishedAt\s+DateTime\?/);
  assert.match(body, /published\s+Boolean/);
});
