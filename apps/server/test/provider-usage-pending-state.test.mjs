import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { ProviderUsageCache } from "../dist/provider-usage-cache.js";

test("a pending usage read is not reported as an invented unknown failure", async t => {
  let reject;
  const cache = new ProviderUsageCache("/tmp", undefined, 1000);
  t.after(() => cache.shutdown());
  const target = { adapter: { id: "fixture", readProviderUsage: () => new Promise((_resolve, fail) => { reject = fail; }) }, displayName: "Fixture", enabled: true, authenticated: true };
  assert.equal(cache.state(target).status, "loading");
  assert.equal(cache.state(target).failure, undefined);
  cache.refresh(target);
  await setImmediate();
  assert.equal(cache.state(target).refreshing, true);
  assert.equal(cache.state(target).status, "loading");
  assert.equal(cache.state(target).failure, undefined);
  reject(new Error("actual completed failure"));
  while (cache.pendingCount()) await setImmediate();
  assert.equal(cache.state(target).status, "unavailable");
  assert.equal(cache.state(target).failure.code, "unknown_failure");
});
