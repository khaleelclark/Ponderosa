import assert from "node:assert/strict";
import test from "node:test";
import { createClientId } from "../src/clientId.js";

test("request identities remain available when randomUUID is unavailable", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
    assert.equal(createClientId("import-", () => "fallback"), "import-fallback");
    assert.match(createClientId("copy-"), /^copy-[a-z0-9]+-[a-z0-9]+$/u);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else delete globalThis.crypto;
  }
});
