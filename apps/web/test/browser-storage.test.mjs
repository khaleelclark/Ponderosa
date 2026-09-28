import assert from "node:assert/strict";
import test from "node:test";
import { readBrowserStorage, removeBrowserStorage, writeBrowserStorage } from "../src/browserStorage.js";

test("denied storage getters never stop the app from initializing", () => {
  const prior = globalThis.window;
  globalThis.window = {
    get localStorage() { throw new DOMException("Access denied", "SecurityError"); },
    get sessionStorage() { throw new DOMException("Access denied", "SecurityError"); },
  };
  try {
    for (const kind of ["localStorage", "sessionStorage"]) {
      assert.equal(readBrowserStorage(kind, "test"), null);
      assert.equal(writeBrowserStorage(kind, "test", "value"), false);
      assert.equal(readBrowserStorage(kind, "test"), "value");
      assert.doesNotThrow(() => removeBrowserStorage(kind, "test"));
      assert.equal(readBrowserStorage(kind, "test"), null);
    }
  } finally { globalThis.window = prior; }
});

test("quota-denied writes do not erase readable storage", () => {
  const prior = globalThis.window;
  const values = new Map([["draft", "keep me"]]);
  globalThis.window = { localStorage: {
    getItem: key => values.get(key) ?? null,
    setItem: () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); },
    removeItem: key => values.delete(key),
  } };
  try {
    assert.equal(writeBrowserStorage("localStorage", "draft", "replacement"), false);
    assert.equal(readBrowserStorage("localStorage", "draft"), "replacement");
  } finally { globalThis.window = prior; }
});
