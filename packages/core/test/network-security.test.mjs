import assert from "node:assert/strict";
import test from "node:test";
import { resolveNetworkSecurity } from "../dist/config.js";

const backendToken = "0123456789abcdef0123456789abcdef";

test("external operator origins fail closed without backend or proxy trust", () => {
  assert.throws(
    () => resolveNetworkSecurity({ PONDEROSA_OPERATOR_ORIGINS: "https://ponderosa.example" }),
    /AUTH_TOKEN or PONDEROSA_TRUSTED_REVERSE_PROXY/u,
  );
});

test("trusted reverse proxy exposure is explicit in readiness posture", () => {
  const result = resolveNetworkSecurity({
    PONDEROSA_OPERATOR_ORIGINS: "https://ponderosa.example",
    PONDEROSA_TRUSTED_REVERSE_PROXY: "true",
    PONDEROSA_OPERATOR_IDENTITIES: "Operator@Example.com",
    PONDEROSA_AUTH_TOKEN: backendToken,
  });
  assert.deepEqual(result.operatorOrigins, ["https://ponderosa.example"]);
  assert.deepEqual(result.operatorIdentities, ["operator@example.com"]);
  assert.equal(result.posture.mode, "reverse_proxy");
  assert.equal(result.posture.authenticationRequired, true);
  assert.equal(result.posture.warning, undefined);
  assert.equal(result.authToken, backendToken);
});

test("trusted reverse proxy refuses an unspecified operator identity", () => {
  assert.throws(() => resolveNetworkSecurity({
    PONDEROSA_OPERATOR_ORIGINS: "https://ponderosa.example",
    PONDEROSA_TRUSTED_REVERSE_PROXY: "true",
  }), /OPERATOR_IDENTITIES/u);
});

test("trusted reverse proxy refuses identity-only authentication", () => {
  assert.throws(() => resolveNetworkSecurity({
    PONDEROSA_OPERATOR_ORIGINS: "https://ponderosa.example",
    PONDEROSA_TRUSTED_REVERSE_PROXY: "true",
    PONDEROSA_OPERATOR_IDENTITIES: "operator@example.com",
  }), /high-entropy PONDEROSA_AUTH_TOKEN/u);
});

test("production rejects plaintext operator origins", () => {
  assert.throws(() => resolveNetworkSecurity({
    NODE_ENV: "production",
    PONDEROSA_OPERATOR_ORIGINS: "http://127.0.0.1:8787",
    PONDEROSA_AUTH_TOKEN: backendToken,
    PONDEROSA_ALLOW_UNSAFE_HTTP_ORIGINS: "true",
  }), /HTTP operator origins/u);
  assert.throws(() => resolveNetworkSecurity({
    NODE_ENV: "development",
    PONDEROSA_OPERATOR_ORIGINS: "http://127.0.0.1:8787",
    PONDEROSA_AUTH_TOKEN: backendToken,
  }), /unsafe-development opt-in/u);
  assert.deepEqual(resolveNetworkSecurity({
    NODE_ENV: "development",
    PONDEROSA_OPERATOR_ORIGINS: "http://127.0.0.1:8787",
    PONDEROSA_AUTH_TOKEN: backendToken,
    PONDEROSA_ALLOW_UNSAFE_HTTP_ORIGINS: "true",
  }).operatorOrigins, ["http://127.0.0.1:8787"]);
});

test("bearer-backed reverse proxy reports backend authentication", () => {
  const result = resolveNetworkSecurity({
    PONDEROSA_OPERATOR_ORIGINS: "https://ponderosa.example",
    PONDEROSA_AUTH_TOKEN: "secret",
  });
  assert.equal(result.posture.mode, "reverse_proxy");
  assert.equal(result.posture.authenticationRequired, true);
  assert.equal(result.posture.warning, undefined);
  assert.deepEqual(result.operatorIdentities, []);
});
