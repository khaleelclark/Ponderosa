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

test("opening and immediately failing retains backoff instead of a fast reconnect loop", async () => {
  const sources=[], delays=[];
  const original=globalThis.setTimeout;
  const originalNow=Date.now;
  globalThis.setTimeout=(fn,ms,...args)=>{if(ms<1_000)delays.push(ms);return original(fn,ms,...args);};
  const subscription=createResilientEventSource({
    createSource:()=>{const source=new FakeEventSource();sources.push(source);return source;},
    configure:()=>{},initialReconnectDelayMs:5,maxReconnectDelayMs:20,maxSilenceMs:1_000,
  });
  try {
    for(let i=0;i<4;i++) {
      const source=sources.at(-1);
      source.onopen(new Event('open'));
      source.dispatchEvent(new Event('heartbeat'));
      source.onerror(new Event('error'));
      for(let j=0;sources.length<i+2&&j<100;j++)await delay(2);
      assert.equal(sources.length,i+2);
    }
    assert.deepEqual(delays,[5,10,20,20]);
    const recovered=sources.at(-1);
    recovered.onopen(new Event('open'));
    Date.now=()=>originalNow()+11_000;
    recovered.dispatchEvent(new Event('heartbeat'));
    recovered.onerror(new Event('error'));
    for(let i=0;sources.length<6&&i<100;i++)await delay(2);
    assert.deepEqual(delays,[5,10,20,20,5],'sustained heartbeat recovery resets backoff');
  } finally {subscription.close();globalThis.setTimeout=original;Date.now=originalNow;}
});

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

test("a rate-limited stream waits for the observed Retry-After before reconnect", async () => {
  const sources = [];
  let cooldownUntil = 0;
  const subscription = createResilientEventSource({
    createSource: () => {
      const source = new FakeEventSource();
      sources.push(source);
      return source;
    },
    configure: () => {},
    probeRateLimit: async () => { cooldownUntil = Date.now() + 50; },
    reconnectCooldownMs: () => Math.max(0, cooldownUntil - Date.now()),
    initialReconnectDelayMs: 1,
    maxReconnectDelayMs: 5,
    maxSilenceMs: 1_000,
  });
  try {
    sources[0].onerror(new Event("error"));
    await delay(20);
    assert.equal(sources.length, 1);
    await delay(65);
    assert.equal(sources.length, 2);
  } finally {
    subscription.close();
  }
});
