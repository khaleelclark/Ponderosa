import assert from "node:assert/strict";
import test from "node:test";
import { createRateLimitedRefresh } from "../src/boundedRefresh.js";

test("sustained events get one prompt refresh and one trailing refresh per interval", async () => {
  const calls = [];
  const started = Date.now();
  const refresh = createRateLimitedRefresh(() => calls.push(Date.now() - started), 100, 5);
  try {
    refresh.schedule();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(calls.length, 1, "first update is prompt");
    const burst = setInterval(() => refresh.schedule(), 2);
    await new Promise(resolve => setTimeout(resolve, 250));
    clearInterval(burst);
    assert.ok(calls.length >= 2 && calls.length <= 4, `bounded calls: ${calls.length}`);
    assert.ok(calls.slice(1).every((call, index) => call - calls[index] >= 90),
      `refreshes must not collapse the minimum interval: ${calls}`);
  } finally {
    refresh.dispose();
  }
});

test("disposing a pending refresh never runs it", async () => {
  let calls = 0;
  const refresh = createRateLimitedRefresh(() => { calls += 1; }, 100, 30);
  refresh.schedule();
  refresh.dispose();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(calls, 0);
});
