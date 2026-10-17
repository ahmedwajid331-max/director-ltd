import { test } from "node:test";
import assert from "node:assert/strict";
import { createOAuthState, OAUTH_STATE_TTL_SECONDS, verifyOAuthState } from "../../src/lib/calendar/oauth-state";

process.env.AUTH_SECRET = "unit-test-secret-unit-test-secret-unit-test-secret";
const USER = "ckuser1234567890abcdef";
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);

test("a fresh state verifies for the same user and the same state value", () => {
  const { state, cookie } = createOAuthState(USER, NOW);
  assert.ok(state.length >= 30, "unguessable length");
  assert.deepEqual(verifyOAuthState(cookie, state, USER, NOW + 5_000), { ok: true });
});

test("every state is different and never contains the user id", () => {
  const a = createOAuthState(USER, NOW);
  const b = createOAuthState(USER, NOW);
  assert.notEqual(a.state, b.state);
  assert.ok(!a.state.includes(USER));
});

test("a callback with no cookie or no state is refused (the crafted-link attack)", () => {
  const { state, cookie } = createOAuthState(USER, NOW);
  assert.deepEqual(verifyOAuthState(undefined, state, USER, NOW), { ok: false, reason: "missing" });
  assert.deepEqual(verifyOAuthState(null, state, USER, NOW), { ok: false, reason: "missing" });
  assert.deepEqual(verifyOAuthState(cookie, null, USER, NOW), { ok: false, reason: "missing" });
  // the old scheme used the user id as the state: it must not verify
  assert.equal(verifyOAuthState(cookie, USER, USER, NOW).ok, false);
});

test("a different signed-in user, a different state value or a forged cookie is refused", () => {
  const { state, cookie } = createOAuthState(USER, NOW);
  assert.deepEqual(verifyOAuthState(cookie, state, "ckotheruser0000000000000", NOW), { ok: false, reason: "user" });
  assert.deepEqual(verifyOAuthState(cookie, `${state}x`, USER, NOW), { ok: false, reason: "state" });
  // an attacker rewriting the user id in the cookie cannot re-sign it
  const forged = cookie.replace(USER, "ckotheruser0000000000000");
  assert.deepEqual(verifyOAuthState(forged, state, "ckotheruser0000000000000", NOW), { ok: false, reason: "signature" });
  // truncated / garbage values
  assert.deepEqual(verifyOAuthState("v1.a.b.c", state, USER, NOW), { ok: false, reason: "malformed" });
  assert.deepEqual(verifyOAuthState("garbage", state, USER, NOW), { ok: false, reason: "malformed" });
  // a cookie signed under a different server secret is refused
  const other = createOAuthState(USER, NOW).cookie;
  process.env.AUTH_SECRET = "a-completely-different-secret-a-completely-different";
  assert.deepEqual(verifyOAuthState(other, state, USER, NOW), { ok: false, reason: "signature" });
  process.env.AUTH_SECRET = "unit-test-secret-unit-test-secret-unit-test-secret";
});

test("the state expires after ten minutes and cannot come from the future", () => {
  const { state, cookie } = createOAuthState(USER, NOW);
  assert.equal(verifyOAuthState(cookie, state, USER, NOW + OAUTH_STATE_TTL_SECONDS * 1000).ok, true, "exactly at the limit");
  assert.deepEqual(verifyOAuthState(cookie, state, USER, NOW + (OAUTH_STATE_TTL_SECONDS + 1) * 1000), { ok: false, reason: "expired" });
  assert.deepEqual(verifyOAuthState(cookie, state, USER, NOW - 60_000), { ok: false, reason: "expired" });
});
