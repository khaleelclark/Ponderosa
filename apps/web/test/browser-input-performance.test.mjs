import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const source = name => pathToFileURL(join(process.cwd(), "src", name)).href;
const { createBrowserInputQueue } = await import(source("browserInputQueue.ts"));
const { coalesceBrowserScrollInputs, createBrowserFrameScheduler } = await import(source("browserInteraction.ts"));
const flush = () => new Promise(resolve => setImmediate(resolve));

test("a burst of scroll inputs is coalesced without dropping distance or crossing a click", async () => {
  const delivered = [];
  let release;
  const queue = createBrowserInputQueue({
    context: () => "same-page-and-epoch",
    dispatch: async value => {
      delivered.push(value);
      await new Promise(resolve => { release = resolve; });
    },
    onError: error => { throw error; },
    coalesce: (pending, next) => pending.kind === "scroll" && next.kind === "scroll"
      ? coalesceBrowserScrollInputs(pending, next) : undefined,
  });
  queue.enqueue({ kind: "scroll", deltaX: 0, deltaY: 20 });
  for (let i = 0; i < 120; i++) queue.enqueue({ kind: "scroll", deltaX: 0, deltaY: 20 });
  queue.enqueue({ kind: "click", x: 10, y: 10 });
  queue.enqueue({ kind: "scroll", deltaX: 0, deltaY: -30 });
  assert.equal(delivered.length, 1, "only the first input is in flight");
  for (let i = 0; i < 7; i++) { release(); await flush(); }
  assert.deepEqual(delivered.slice(0, 6).map(value => value.deltaY), [20, 480, 480, 480, 480, 480]);
  assert.equal(delivered.slice(0, 6).reduce((sum, value) => sum + value.deltaY, 0), 2_420);
  assert.equal(delivered[6].kind, "click", "scroll must not move past a click");
  assert.equal(delivered[7].deltaY, -30);
  release(); await flush();
  queue.dispose();
});

test("interaction refresh has a leading frame and a bounded active cadence", async () => {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const captures = [];
  const scheduler = createBrowserFrameScheduler({
    capture: async () => { captures.push(now); },
    now: () => now,
    setTimer: (callback, delay) => {
      const id = ++nextId;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimer: id => { timers.delete(id); },
  });
  const advance = async time => {
    now = time;
    for (const [id, timer] of [...timers]) {
      if (timer.due <= now) { timers.delete(id); timer.callback(); }
    }
    await flush();
  };
  scheduler.setVisible(true);
  await flush();
  assert.deepEqual(captures, [0]);
  await advance(20);
  for (let i = 0; i < 50; i++) scheduler.requestInteractionRefresh();
  await advance(74);
  assert.deepEqual(captures, [0]);
  await advance(75);
  assert.deepEqual(captures, [0, 75]);
  await advance(90);
  for (let i = 0; i < 50; i++) scheduler.requestInteractionRefresh();
  await advance(149);
  assert.deepEqual(captures, [0, 75]);
  await advance(150);
  assert.deepEqual(captures, [0, 75, 150]);
  scheduler.setVisible(false);
  await advance(1_000);
  assert.equal(captures.length, 3, "hidden viewers do not capture frames");
  scheduler.dispose();
});
