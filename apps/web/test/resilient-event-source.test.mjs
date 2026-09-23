import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createResilientEventSource } from "../src/api/resilientEventSource.js";

class FakeEventSource extends EventTarget {
  closed = false;
  onopen;
  onerror;

  close() {
    this.closed = true;
  }
}

test("a silent half-open event stream reconnects without waiting for a page refresh", async () => {
  const sources = [];
  let failures = 0;
  const subscription = createResilientEventSource({
    createSource: () => {
      const source = new FakeEventSource();
      sources.push(source);
      return source;
    },
    configure: () => {},
    onError: () => { failures += 1; },
    initialReconnectDelayMs: 1,
    maxSilenceMs: 20,
  });
  try {
    for (let i = 0; sources.length < 2 && i < 100; i += 1) await delay(5);
    assert.ok(sources.length >= 2, "the browser reconnects a stream that never errors or ends");
    assert.equal(sources[0].closed, true);
    assert.ok(failures >= 1);
  } finally {
    subscription.close();
  }
  assert.equal(sources.at(-1).closed, true);
});
