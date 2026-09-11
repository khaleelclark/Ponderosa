import assert from "node:assert/strict";
import test from "node:test";
import { safeProviderConnectionUrl } from "../dist/provider-connection-url.js";

test("provider connection URLs require HTTPS or an explicit loopback HTTP host", () => {
  for (const url of [
    "https://accounts.example.com/connect?state=abc",
    "http://localhost:8080/connect",
    "http://127.0.0.42:8080/connect",
    "http://[::1]:8080/connect",
  ]) assert.equal(safeProviderConnectionUrl(url), url);

  for (const url of [
    "http://example.com/connect",
    "http://localhost.example.com/connect",
    "https://user:password@example.com/connect",
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "https:example.com/connect",
    "https:\\example.com/connect",
    "not a URL",
    `https://example.com/${"x".repeat(4_096)}`,
  ]) assert.equal(safeProviderConnectionUrl(url), undefined);
});
