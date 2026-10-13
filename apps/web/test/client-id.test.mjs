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

test("HTTP browsers use random bytes for UUID-shaped request and short node identities", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  let seed = 0;
  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: {
      getRandomValues(bytes) {
        bytes.forEach((_, index) => { bytes[index] = seed + index; });
        seed++;
        return bytes;
      },
    } });
    const first = createClientId(), second = createClientId();
    assert.equal(first, "00010203-0405-4607-8809-0a0b0c0d0e0f");
    assert.match(second, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    assert.notEqual(first.slice(0, 8), second.slice(0, 8), "rapid node creation must not share a timestamp prefix");
    assert.equal(createClientId("request-", () => "retained-fallback"), "request-retained-fallback");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else delete globalThis.crypto;
  }
});
