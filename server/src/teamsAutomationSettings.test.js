const { test } = require("node:test");
const assert = require("node:assert");
const { merge, DEFAULTS } = require("./teamsAutomationSettings");

test("no stored settings yields the defaults, both switches off", () => {
  assert.deepEqual(merge(undefined), { autoCreateMeetings: false, provisionTeams: false });
  assert.equal(DEFAULTS.autoCreateMeetings, false);
  assert.equal(DEFAULTS.provisionTeams, false);
});

test("a patch merges over a base without disturbing its neighbour switch", () => {
  assert.deepEqual(merge({ autoCreateMeetings: true }, DEFAULTS), {
    autoCreateMeetings: true,
    provisionTeams: false,
  });
  assert.deepEqual(merge({ provisionTeams: true }, DEFAULTS), {
    autoCreateMeetings: false,
    provisionTeams: true,
  });
});

test("a non-boolean value falls back to the base, never coerced", () => {
  assert.equal(merge({ autoCreateMeetings: "true" }).autoCreateMeetings, false);
  assert.equal(merge({ autoCreateMeetings: 1 }).autoCreateMeetings, false);
  assert.equal(merge({ provisionTeams: 0 }).provisionTeams, false);
  assert.equal(merge({ provisionTeams: null }).provisionTeams, false);
  // and it falls back to whatever base was passed, not always DEFAULTS
  assert.equal(
    merge({ autoCreateMeetings: "banana" }, { autoCreateMeetings: true, provisionTeams: true })
      .autoCreateMeetings,
    true,
  );
});

test("unknown keys are dropped, not carried through", () => {
  assert.equal(merge({ unknownKey: 1 }).unknownKey, undefined);
  assert.deepEqual(merge({ unknownKey: 1 }), DEFAULTS);
});
