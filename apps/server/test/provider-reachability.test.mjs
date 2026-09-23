import assert from "node:assert/strict";
import test from "node:test";
import {
  qualifyProviderReachability,
} from "../../../packaging/qualification/provider-reachability.mjs";

const nowMs = Date.parse("2026-09-22T12:00:00.000Z");
const base = {
  id: "codex",
  enabled: true,
  authentication: "authenticated",
  intakeReady: true,
  reachability: "unverified",
  servingBuildRevision: "revision-b",
  servingInstanceId: "instance-b",
};
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const fetchFor = (initial, recheck) => async (url) =>
  response(url.endsWith("/api/engines") ? initial : recheck);
const input = (fetchImpl) => ({
  baseUrl: "http://127.0.0.1:1234",
  cookie: "session=example",
  fetchImpl,
  now: () => nowMs,
  expectedRevision: "revision-b",
});

test("provider qualification rejects authenticated intake without reachable evidence", async () => {
  const result = await qualifyProviderReachability(input(fetchFor([base], base)));
  assert.equal(result.passed, false);
  assert.equal(result.evidence[0].reachability, "unverified");
});

test("provider qualification accepts a fresh, successful explicit recheck", async () => {
  const checked = {
    ...base,
    reachability: "reachable",
    availabilitySource: "operator_probe",
    availabilityObservedAt: "2026-09-22T11:59:59.000Z",
    availabilityBuildRevision: "revision-b",
    availabilityInstanceId: "instance-b",
  };
  const result = await qualifyProviderReachability(input(fetchFor([base], checked)));
  assert.equal(result.passed, true);
  assert.equal(result.evidence[0].qualified, true);
  assert.equal(result.evidence[0].source, "operator_probe");
});

test("provider qualification rejects stale or degraded evidence", async () => {
  const old = {
    ...base,
    reachability: "reachable",
    availabilitySource: "provider_run",
    availabilityObservedAt: "2026-09-22T11:50:00.000Z",
    availabilityBuildRevision: "revision-b",
    availabilityInstanceId: "instance-b",
  };
  assert.equal((await qualifyProviderReachability(input(fetchFor([base], old)))).passed, false);
  assert.equal((await qualifyProviderReachability(input(fetchFor([base], {
    ...old,
    reachability: "degraded",
    availabilityObservedAt: "2026-09-22T11:59:00.000Z",
    availabilityCategory: "authentication",
  })))).evidence[0].failureCategory, "authentication");
});

test("provider qualification reports sanitized failed-recheck category", async () => {
  const fetchImpl = async (url) => url.endsWith("/api/engines")
    ? response([base])
    : response({ error: "secret response" }, 401);
  const result = await qualifyProviderReachability(input(fetchImpl));
  assert.equal(result.passed, false);
  assert.equal(result.evidence[0].failureCategory, "authentication");
  assert.equal(JSON.stringify(result).includes("secret response"), false);
});

test("provider qualification rejects prior-build and prior-startup evidence", async () => {
  const checked = {
    ...base,
    reachability: "reachable",
    availabilitySource: "provider_run",
    availabilityObservedAt: "2026-09-22T11:59:59.000Z",
    availabilityBuildRevision: "revision-a",
    availabilityInstanceId: "instance-a",
  };
  assert.equal((await qualifyProviderReachability(input(fetchFor([base], checked)))).passed, false);
  assert.equal((await qualifyProviderReachability(input(fetchFor([base], {
    ...checked, availabilityBuildRevision: "revision-b",
  })))).passed, false);
  assert.equal((await qualifyProviderReachability(input(fetchFor([base], {
    ...checked, availabilityBuildRevision: undefined, availabilityInstanceId: undefined,
  })))).passed, false);
});

test("degraded authenticated provider is rechecked and may recover", async () => {
  let rechecks = 0;
  const degraded = { ...base, intakeReady: false, reachability: "degraded" };
  const result = await qualifyProviderReachability(input(async (url) => {
    if (url.endsWith("/api/engines")) return response([degraded]);
    rechecks += 1;
    return response({
      ...base, reachability: "reachable", availabilitySource: "operator_probe",
      availabilityObservedAt: "2026-09-22T11:59:59.000Z",
      availabilityBuildRevision: "revision-b", availabilityInstanceId: "instance-b",
    });
  }));
  assert.equal(rechecks, 1);
  assert.equal(result.passed, true);
});

test("disabled provider is never probed", async () => {
  let rechecks = 0;
  const result = await qualifyProviderReachability(input(async (url) => {
    if (url.endsWith("/api/engines")) return response([{ ...base, enabled: false }]);
    rechecks += 1;
    return response(base);
  }));
  assert.equal(rechecks, 0);
  assert.equal(result.passed, false);
});
