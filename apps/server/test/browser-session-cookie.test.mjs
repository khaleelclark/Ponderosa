import assert from "node:assert/strict";
import test from "node:test";
import { browserSessionCookie } from "../dist/routes/server-control.js";

test("HTTPS browser sessions use a host-bound secure cookie", () => {
  const cookie = browserSessionCookie("opaque", 300, true);
  assert.equal(
    cookie,
    "__Host-ponderosa_session=opaque; HttpOnly; SameSite=Strict; Path=/; Max-Age=300; Secure",
  );
  assert.doesNotMatch(cookie, /Domain=/iu);
});

test("loopback development sessions retain strict non-secure cookie attributes", () => {
  const cookie = browserSessionCookie("opaque", 300, false);
  assert.equal(
    cookie,
    "ponderosa_session=opaque; HttpOnly; SameSite=Strict; Path=/; Max-Age=300",
  );
  assert.doesNotMatch(cookie, /Secure|Domain=/iu);
});
