// Tests for the Canvas client's pure parts.
//
// No network. These cover the three things a Canvas integration gets wrong first, and
// all three fail silently rather than loudly:
//
//   1. The site address an administrator actually pastes, which is rarely the clean
//      root the API wants.
//   2. Pagination, where treating the `next` link as anything but opaque returns the
//      same page forever and the sync quietly imports one page of a roster.
//   3. Telling throttling apart from permission-denied. Canvas returns 403 for BOTH by
//      default, so getting this wrong means retrying a permission error until the end
//      of time and telling an administrator that a rate limit is an access problem.
//
// Run with: node --test src/vle/canvas.test.js   (from server/)
const test = require("node:test");
const assert = require("node:assert/strict");

const { apiBase, nextLink, isRateLimited } = require("./canvas");

/* -------------------------------------------------------------------------- */
/* The address an administrator pastes                                         */
/* -------------------------------------------------------------------------- */

test("a clean site address becomes the API root", () => {
  assert.equal(apiBase("https://college.instructure.com"), "https://college.instructure.com/api/v1");
});

test("a trailing slash does not produce a double slash", () => {
  assert.equal(apiBase("https://college.instructure.com/"), "https://college.instructure.com/api/v1");
  assert.equal(apiBase("https://college.instructure.com///"), "https://college.instructure.com/api/v1");
});

test("an address that already includes /api/v1 is not doubled up", () => {
  // Someone reading the API docs pastes the example URL. Appending again gives
  // /api/v1/api/v1, which 404s with a message about the path rather than the address.
  assert.equal(apiBase("https://college.instructure.com/api/v1"), "https://college.instructure.com/api/v1");
  assert.equal(apiBase("https://college.instructure.com/api/v1/"), "https://college.instructure.com/api/v1");
});

test("a page the administrator happened to have open is trimmed back to the site", () => {
  // The realistic case: they copy the URL out of the browser tab they generated the
  // token in, which is a Canvas page, not the site root.
  assert.equal(apiBase("https://college.instructure.com/login/canvas"), "https://college.instructure.com/api/v1");
  assert.equal(apiBase("https://college.instructure.com/courses/1234"), "https://college.instructure.com/api/v1");
  assert.equal(apiBase("https://college.instructure.com/accounts/1"), "https://college.instructure.com/api/v1");
});

test("surrounding whitespace from a copy and paste is ignored", () => {
  assert.equal(apiBase("  https://college.instructure.com  "), "https://college.instructure.com/api/v1");
});

test("a self-hosted Canvas on a subpath keeps its path", () => {
  // Not every Canvas is at a bare domain; a self-hosted install may sit under a path,
  // and trimming it would point every request at the wrong host root.
  assert.equal(apiBase("https://vle.college.ac.uk/canvas"), "https://vle.college.ac.uk/canvas/api/v1");
});

/* -------------------------------------------------------------------------- */
/* Pagination                                                                  */
/* -------------------------------------------------------------------------- */

const LINK_HEADER =
  '<https://c.instructure.com/api/v1/courses?page=first_bookmark&per_page=100>; rel="current", ' +
  '<https://c.instructure.com/api/v1/courses?page=bookmark%3AWyIxIl0&per_page=100>; rel="next", ' +
  '<https://c.instructure.com/api/v1/courses?page=first_bookmark&per_page=100>; rel="first"';

test("the next link is extracted whole, bookmark and all", () => {
  // The bookmark is opaque and URL-encoded. Anything that reconstructs it from a page
  // number re-requests page one until MAX_PAGES, importing the same rows repeatedly.
  assert.equal(nextLink(LINK_HEADER), "https://c.instructure.com/api/v1/courses?page=bookmark%3AWyIxIl0&per_page=100");
});

test("the end of a collection is a header with no next", () => {
  const last =
    '<https://c.instructure.com/api/v1/courses?page=x>; rel="current", ' +
    '<https://c.instructure.com/api/v1/courses?page=a>; rel="first"';
  assert.equal(nextLink(last), null);
});

test("no Link header at all is the end, not a crash", () => {
  assert.equal(nextLink(null), null);
  assert.equal(nextLink(undefined), null);
  assert.equal(nextLink(""), null);
});

test("rel values without quotes are still recognised", () => {
  // RFC5988 permits an unquoted rel, and Canvas is not the only thing on the wire —
  // a proxy may rewrite the header.
  assert.equal(nextLink('<https://c/api/v1/x?page=2>; rel=next'), "https://c/api/v1/x?page=2");
});

test("a missing rel=last is not treated as an error", () => {
  // Canvas omits rel="last" whenever counting the rows would be expensive, which is
  // most large collections. A pager that waits to see `last` never terminates.
  assert.equal(nextLink(LINK_HEADER.replace('rel="first"', 'rel="first"')), "https://c.instructure.com/api/v1/courses?page=bookmark%3AWyIxIl0&per_page=100");
});

/* -------------------------------------------------------------------------- */
/* Throttling versus permission denied                                         */
/* -------------------------------------------------------------------------- */

/** A minimal stand-in for the parts of a fetch Response this reads. */
const res = (status, headers = {}) => ({
  status,
  headers: { get: (k) => (k.toLowerCase() in headers ? headers[k.toLowerCase()] : null) },
});

test("a plain 403 is permission denied, and must not be retried as throttling", () => {
  // The failure this guards: retrying a permission error forever, and telling an
  // administrator whose token lacks a role that Canvas is "busy".
  assert.equal(isRateLimited(res(403), "You are not authorized to perform that action."), false);
});

test("a 403 with no remaining quota is throttling", () => {
  assert.equal(isRateLimited(res(403, { "x-rate-limit-remaining": "0.0" }), ""), true);
});

test("a 403 whose body says rate limit exceeded is throttling", () => {
  // Canvas's default throttled response is a 403 with a plain-text body. The published
  // docs say 429; the shipped default does not.
  assert.equal(isRateLimited(res(403), "403 Forbidden (Rate Limit Exceeded)\n"), true);
});

test("a 429 is throttling, for instances that enable it", () => {
  assert.equal(isRateLimited(res(429), ""), true);
});

test("a 403 with quota still remaining is permission denied", () => {
  assert.equal(isRateLimited(res(403, { "x-rate-limit-remaining": "412.5" }), "forbidden"), false);
});

test("a 401 is never throttling — it is a bad token", () => {
  assert.equal(isRateLimited(res(401), ""), false);
});

test("a 200 is never throttling", () => {
  assert.equal(isRateLimited(res(200, { "x-rate-limit-remaining": "0.0" }), ""), false);
});
