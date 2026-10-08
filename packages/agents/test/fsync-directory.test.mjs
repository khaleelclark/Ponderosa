import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { fsyncDirectory } from "../dist/store-filesystem.js";

for (const failedOperation of [undefined, "open", "fsync", "close"]) {
  test(`directory durability preserves ordering and ${failedOperation ?? "successful"} outcome`, t => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux" });
    const calls = [];
    const failure = new Error(`${failedOperation} failed`);
    t.mock.method(fs, "openSync", (directory, flags) => {
      calls.push(["open", directory, flags]);
      if (failedOperation === "open") throw failure;
      return 42;
    });
    t.mock.method(fs, "fsyncSync", descriptor => {
      calls.push(["fsync", descriptor]);
      if (failedOperation === "fsync") throw failure;
    });
    t.mock.method(fs, "closeSync", descriptor => {
      calls.push(["close", descriptor]);
      if (failedOperation === "close") throw failure;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      Object.defineProperty(process, "platform", platform);
    });
    if (failedOperation) assert.throws(() => fsyncDirectory("synthetic-directory"), error => error === failure);
    else fsyncDirectory("synthetic-directory");
    assert.deepEqual(calls, failedOperation === "open"
      ? [["open", "synthetic-directory", "r"]]
      : [["open", "synthetic-directory", "r"], ["fsync", 42], ["close", 42]]);
  });
}

test("directory fsync preserves the Windows no-op", t => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  t.mock.method(fs, "openSync", () => assert.fail("Windows must not open a directory"));
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
  });
  fsyncDirectory("synthetic-directory");
});
