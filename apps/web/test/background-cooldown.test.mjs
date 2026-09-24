import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  backgroundCooldownRemaining,
  noteBackgroundRateLimit,
  parseRetryAfter,
} from "../src/api/backgroundCooldown.js";
import { shouldRetryQuery, queryRetryDelay } from "../src/api/queryRetry.js";
import { ApiRequestError } from "../src/api/types.js";
import { createBoundedRefresh } from "../src/boundedRefresh.js";

test("Retry-After is parsed and shared with another tab through same-origin storage", async () => {
  const previous = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  try {
    assert.equal(parseRetryAfter("3", 1_000), 3_000);
    assert.equal(parseRetryAfter(new Date(6_000).toUTCString(), 1_000), 5_000);
    noteBackgroundRateLimit("3", Date.now());
    assert.ok(backgroundCooldownRemaining() >= 2_900);
    const secondTab = await import("../src/api/backgroundCooldown.js?second-tab");
    assert.ok(secondTab.backgroundCooldownRemaining() >= 2_900);
    values.set("ponderosa.background-retry-after.v1", String(Date.now() + 10_000));
    noteBackgroundRateLimit("1");
    assert.ok(secondTab.backgroundCooldownRemaining() >= 9_900,
      "a shorter observation cannot erase another tab's longer cooldown");
  } finally {
    globalThis.localStorage = previous;
  }
});

test("a 429 gets one delayed retry, not a retry loop", () => {
  const limited = new ApiRequestError(429, "request rate limit exceeded", undefined, 5_000);
  assert.equal(shouldRetryQuery(1, limited), true);
  assert.equal(shouldRetryQuery(2, limited), false);
  assert.ok(queryRetryDelay(0, limited) >= 5_000);
  assert.equal(shouldRetryQuery(0, new DOMException("Aborted", "AbortError")), false);
});

test("busy Agents share one fixed refresh window; a terminal change advances it", async () => {
  let refreshes = 0;
  const scheduler = createBoundedRefresh(() => { refreshes += 1; }, 40, 5);
  try {
    for (let event = 0; event < 12 * 10; event += 1) scheduler.schedule();
    await delay(55);
    assert.equal(refreshes, 1);
    for (let event = 0; event < 12 * 10; event += 1) scheduler.schedule();
    scheduler.schedule(true);
    await delay(15);
    assert.equal(refreshes, 2);
    await delay(45);
    assert.equal(refreshes, 2);
  } finally {
    scheduler.dispose();
  }
});
