import assert from "node:assert/strict";
import test from "node:test";
import { WorkspacePreferencesWriter } from "../src/workspacePreferencesWriter.js";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const preferences = (updatedAt, extra = {}) => ({
  revision: Math.max(0, (Date.parse(updatedAt) - Date.parse("2026-01-01T00:00:00.000Z")) / 1_000),
  updatedAt,
  projectSort: "last_used",
  projectOrder: [],
  ...extra,
});

test("preference writes stay ordered and newer intent remains optimistic", async () => {
  let cache = preferences("2026-01-01T00:00:00.000Z", { sidebarWidth: 280, fontFamily: "inter" });
  const calls = [];
  const first = deferred();
  const second = deferred();
  const writer = new WorkspacePreferencesWriter({
    read: () => cache,
    publish: value => { cache = value; },
    write: patch => { calls.push(patch); return calls.length === 1 ? first.promise : second.promise; },
    refresh: async () => cache,
  });
  writer.enqueue({ sidebarWidth: 300 });
  writer.enqueue({ fontFamily: "system" });
  await tick();
  assert.deepEqual(calls, [{ sidebarWidth: 300 }]);
  assert.equal(cache.sidebarWidth, 300);
  assert.equal(cache.fontFamily, "system");
  first.resolve(preferences("2026-01-01T00:00:01.000Z", { sidebarWidth: 300, fontFamily: "inter" }));
  await tick();
  assert.deepEqual(calls, [{ sidebarWidth: 300 }, { fontFamily: "system" }]);
  assert.equal(cache.fontFamily, "system");
  second.resolve(preferences("2026-01-01T00:00:02.000Z", { sidebarWidth: 300, fontFamily: "system" }));
  await tick();
  assert.equal(cache.sidebarWidth, 300);
  assert.equal(cache.fontFamily, "system");
});

test("a failed write reconciles canonical state before the next write", async () => {
  let cache = preferences("2026-01-01T00:00:00.000Z", { sidebarWidth: 280, fontFamily: "inter" });
  const first = deferred();
  const calls = [];
  let errors = 0;
  const writer = new WorkspacePreferencesWriter({
    read: () => cache,
    publish: value => { cache = value; },
    write: patch => { calls.push(patch); return calls.length === 1 ? first.promise : Promise.resolve(preferences("2026-01-01T00:00:02.000Z", { sidebarWidth: 280, fontFamily: "system" })); },
    refresh: async () => preferences("2026-01-01T00:00:01.000Z", { sidebarWidth: 280, fontFamily: "inter" }),
    onError: () => { errors += 1; },
  });
  writer.enqueue({ sidebarWidth: 300 });
  writer.enqueue({ fontFamily: "system" });
  await tick();
  first.reject(new Error("offline"));
  await tick();
  await tick();
  assert.equal(errors, 1);
  assert.deepEqual(calls, [{ sidebarWidth: 300 }, { fontFamily: "system" }]);
  assert.equal(cache.sidebarWidth, 280);
  assert.equal(cache.fontFamily, "system");
});

test("a failed write and refresh roll back only that intent and leave the queue usable", async () => {
  let cache = preferences("2026-01-01T00:00:00.000Z", { sidebarWidth: 280, fontFamily: "inter" });
  const first = deferred();
  const calls = [];
  let errors = 0;
  const writer = new WorkspacePreferencesWriter({
    read: () => cache,
    publish: value => { cache = value; },
    write: patch => {
      calls.push(patch);
      return calls.length === 1
        ? first.promise
        : Promise.resolve(preferences("2026-01-01T00:00:02.000Z", { sidebarWidth: 280, fontFamily: "system" }));
    },
    refresh: async () => { throw new Error("still offline"); },
    onError: () => { errors += 1; },
  });

  writer.enqueue({ sidebarWidth: 300 });
  writer.enqueue({ fontFamily: "system" });
  await tick();
  first.reject(new Error("offline"));
  await tick();
  await tick();

  assert.equal(errors, 1);
  assert.deepEqual(calls, [{ sidebarWidth: 300 }, { fontFamily: "system" }]);
  assert.equal(cache.sidebarWidth, 280, "the failed optimistic field is rolled back");
  assert.equal(cache.fontFamily, "system", "a different pending field remains optimistic");

  writer.enqueue({ sidebarWidth: 320 });
  await tick();
  await tick();
  assert.equal(calls.length, 3, "a rejected refresh does not poison later writes");
  assert.equal(cache.sidebarWidth, 280);
  assert.equal(cache.fontFamily, "system");
});

test("an older response cannot overwrite newer canonical cache state", async () => {
  let cache = preferences("2026-01-01T00:00:00.000Z", { sidebarWidth: 280, fontFamily: "inter" });
  const response = deferred();
  const writer = new WorkspacePreferencesWriter({
    read: () => cache,
    publish: value => { cache = value; },
    write: () => response.promise,
    refresh: async () => cache,
  });
  writer.enqueue({ fontFamily: "system" });
  await tick();
  cache = writer.projectCanonical(preferences("2026-01-01T00:00:03.000Z", { sidebarWidth: 340, fontFamily: "inter" }));
  response.resolve(preferences("2026-01-01T00:00:01.000Z", { sidebarWidth: 280, fontFamily: "system" }));
  await tick();
  assert.equal(cache.updatedAt, "2026-01-01T00:00:03.000Z");
  assert.equal(cache.sidebarWidth, 340);
  assert.equal(cache.fontFamily, "inter");
});

test("canonical revision orders same-millisecond SSE and PATCH responses", async () => {
  const timestamp = "2026-01-01T00:00:00.000Z";
  let cache = preferences(timestamp, { revision: 0, sidebarWidth: 280, fontFamily: "inter" });
  const response = deferred();
  const writer = new WorkspacePreferencesWriter({
    read: () => cache,
    publish: value => { cache = value; },
    write: () => response.promise,
    refresh: async () => cache,
  });
  writer.enqueue({ fontFamily: "system" });
  await tick();
  cache = writer.projectCanonical(preferences(timestamp, {
    revision: 2,
    sidebarWidth: 340,
    fontFamily: "inter",
  }));
  response.resolve(preferences(timestamp, {
    revision: 1,
    sidebarWidth: 280,
    fontFamily: "system",
  }));
  await tick();
  assert.equal(cache.revision, 2);
  assert.equal(cache.sidebarWidth, 340);
  assert.equal(cache.fontFamily, "inter");
});
