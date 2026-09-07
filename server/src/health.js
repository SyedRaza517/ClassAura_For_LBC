// What /api/health answers. Kept out of index.js so it can be tested without starting
// a server, which index.js does the moment it is required.
//
// One field beyond "up", for the person deploying this rather than for the app:
//
//   version   The commit the host built, as Render exposes it. The client and the API
//             deploy separately and a browser can be hours newer than the server it
//             talks to; without this the only way to learn which build is answering is
//             to try a route and read the failure.
//
// WHAT IS DELIBERATELY NOT HERE: whether check-in codes are signed with a real secret.
// It was, briefly. The signing key derives from the SESSION secret, so "running on the
// development secret" is not a QR diagnostic — it says every session token on that
// deployment is signed with the literal in sessionSecret.js, and an unauthenticated
// endpoint would be broadcasting that to anyone. A production process refuses to start
// without a real secret, so `ok: true` from a production host already answers the
// question; the boot banner ("Check-in codes: …") answers it for a developer. Nothing
// else, either: this endpoint is public and pinged by the keep-alive, so it must never
// carry the database address, a secret, or a count of anything.

function healthPayload() {
  const commit = process.env.RENDER_GIT_COMMIT;
  return {
    ok: true,
    service: "edtech-hub-api",
    version: typeof commit === "string" && commit.trim() ? commit.trim().slice(0, 7) : null,
  };
}

module.exports = { healthPayload };
