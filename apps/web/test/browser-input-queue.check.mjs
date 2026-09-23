import assert from "node:assert/strict";
import { createBrowserInputQueue } from "../src/browserInputQueue.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));
let context = "session:epoch:tab";
let release;
const delivered = [];
const errors = [];
const queue = createBrowserInputQueue({
  context: () => context,
  dispatch: async value => { delivered.push(value); await new Promise(resolve => { release = resolve; }); },
  onError: error => errors.push(error.message),
});
queue.enqueue("click"); queue.enqueue("a"); queue.enqueue("b");
assert.deepEqual(delivered, ["click"]);
release(); await tick(); assert.deepEqual(delivered, ["click", "a"]);
release(); await tick(); assert.deepEqual(delivered, ["click", "a", "b"]);
release(); await tick();
queue.enqueue("first"); queue.enqueue("stale"); context = "new-tab";
release(); await tick();
assert.equal(delivered.includes("stale"), false);
assert.match(errors.at(-1), /tab changed/);
queue.reset(); queue.enqueue("resume"); release(); await tick();
assert.equal(delivered.at(-1), "resume");
queue.dispose(); queue.enqueue("disposed"); assert.equal(delivered.includes("disposed"), false);

let attempts = 0;
const failing = createBrowserInputQueue({ context: () => "same", dispatch: async () => { attempts++; throw Error("uncertain"); }, onError: error => errors.push(error.message) });
failing.enqueue(1); failing.enqueue(2); await tick();
assert.equal(attempts, 1); assert.match(errors.at(-1), /not replayed/);
const bounded = createBrowserInputQueue({ context: () => "same", limit: 1, dispatch: () => new Promise(() => {}), onError: error => errors.push(error.message) });
bounded.enqueue(1); bounded.enqueue(2); bounded.enqueue(3);
assert.match(errors.at(-1), /falling behind/);
console.log("PASS ordered input, context changes, disposal, bounded backpressure, no uncertain replay");
