// What /api/health says, beyond "up".
//
// Two things a person deploying this cannot otherwise see without signing in and
// scanning: WHICH build is answering (the client and the API deploy separately, and a
// browser can be hours newer than the server it talks to), and whether the server can
// sign check-in codes at all. Both were only discoverable by putting a code on a
// projector and watching a room of students fail to scan it.
//
// Run with: node --test src/health.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { healthPayload } = require("./health");

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test("still answers ok, with the service name the keep-alive and the runner look for", () => {
  const h = healthPayload();
  assert.equal(h.ok, true);
  assert.equal(h.service, "classaura-api");
});

test("names the deployed commit when the host provides one, and null when it does not", () => {
  withEnv({ RENDER_GIT_COMMIT: "c1cfe4f0123456789abcdef" }, () => {
    assert.equal(healthPayload().version, "c1cfe4f");
  });
  withEnv({ RENDER_GIT_COMMIT: undefined }, () => {
    assert.equal(healthPayload().version, null);
  });
});

test("never says which secret signs sessions, in either direction", () => {
  // "dev-secret" on a public endpoint would tell an anonymous caller that EVERY session
  // token on a misconfigured non-production deployment is signed with the literal in
  // sessionSecret.js — an account-takeover signal, not a QR diagnostic. The boot log says
  // it; a production process refuses to start without a real secret; this endpoint stays
  // silent on it in both directions.
  for (const secret of ["a-real-secret-for-this-test", undefined]) {
    const h = withEnv({ JWT_SECRET: secret, NODE_ENV: "test" }, () => healthPayload());
    assert.equal("checkInCodes" in h, false);
    assert.doesNotMatch(JSON.stringify(h), /secret/i);
  }
});

test("never carries the secret, the database address, or anything but those fields", () => {
  const h = withEnv({ JWT_SECRET: "a-real-secret-for-this-test", DATABASE_URL: "postgresql://u:p@h:5432/d" }, () => healthPayload());
  assert.deepEqual(Object.keys(h).sort(), ["ok", "service", "version"]);
  assert.doesNotMatch(JSON.stringify(h), /a-real-secret|postgresql/);
});
