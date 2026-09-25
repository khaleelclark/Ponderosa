import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import {
  loadLatestProviderUsage,
  providerUsageRefreshInterval,
  refreshLatestAgentProviderUsage,
  refreshLatestProviderUsage,
} from "../src/providerUsageQuery.js";
import { queryKeys } from "../src/queryKeys.js";

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

test("an older provider query cannot overwrite an explicit refresh", async () => {
  const queryClient = new QueryClient();
  const oldResponse = deferred();
  const freshResponse = deferred();
  const olderRequest = queryClient.fetchQuery({
    queryKey: queryKeys.providerUsage.all,
    queryFn: () => oldResponse.promise,
  });
  const olderOutcome = olderRequest.catch(() => undefined);

  const refresh = loadLatestProviderUsage(
    queryClient,
    () => freshResponse.promise,
  );
  const fresh = {
    providers: [{ provider: "codex", refreshing: true }],
  };
  freshResponse.resolve(fresh);
  await refresh;
  oldResponse.resolve({
    providers: [{ provider: "codex", refreshing: false }],
  });
  await olderOutcome;

  assert.deepEqual(
    queryClient.getQueryData(queryKeys.providerUsage.all),
    fresh,
  );
  assert.equal(providerUsageRefreshInterval(fresh), 5_000);
  assert.equal(providerUsageRefreshInterval(undefined), false);
});

test("a global refresh also fences an older Agent usage read", async () => {
  const queryClient = new QueryClient();
  const oldAgentResponse = deferred();
  const freshResponse = deferred();
  const agentKey = queryKeys.providerUsage.agent("agent-a");
  const olderOutcome = queryClient.fetchQuery({
    queryKey: agentKey,
    queryFn: () => oldAgentResponse.promise,
  }).catch(() => undefined);
  const refresh = loadLatestProviderUsage(
    queryClient,
    () => freshResponse.promise,
  );
  const fresh = { providers: [{ provider: "codex", refreshing: true }] };
  freshResponse.resolve(fresh);
  await refresh;
  oldAgentResponse.resolve({ provider: "codex", refreshing: false });
  await olderOutcome;

  assert.equal(queryClient.getQueryData(agentKey), undefined);
  assert.deepEqual(queryClient.getQueryData(queryKeys.providerUsage.all), fresh);
});

test("an explicit load bypasses a fresh cached reading", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(queryKeys.providerUsage.all, { providers: [] });
  let requests = 0;
  const fresh = { providers: [{ provider: "codex", refreshing: true }] };

  assert.deepEqual(
    await loadLatestProviderUsage(queryClient, async () => {
      requests += 1;
      return fresh;
    }),
    fresh,
  );
  assert.equal(requests, 1);
});

test("a provider refresh fences reads started before and during the operation", async () => {
  const queryClient = new QueryClient();
  const before = deferred();
  const during = deferred();
  const provider = deferred();
  const beforeOutcome = queryClient.fetchQuery({
    queryKey: queryKeys.providerUsage.all,
    queryFn: () => before.promise,
  }).catch(() => undefined);
  const refresh = refreshLatestProviderUsage(queryClient, () => provider.promise);
  await Promise.resolve();
  const duringOutcome = queryClient.fetchQuery({
    queryKey: queryKeys.providerUsage.all,
    queryFn: () => during.promise,
  }).catch(() => undefined);
  const fresh = { provider: "codex", refreshing: true };
  provider.resolve(fresh);
  await refresh;
  before.resolve({ providers: [] });
  during.resolve({ providers: [] });
  await Promise.all([beforeOutcome, duringOutcome]);

  assert.deepEqual(
    queryClient.getQueryData(queryKeys.providerUsage.all),
    { providers: [fresh] },
  );
});

test("Agent provider refresh also fences its older detail read", async () => {
  const queryClient = new QueryClient();
  const oldAgentResponse = deferred();
  const provider = deferred();
  const agentKey = queryKeys.providerUsage.agent("agent-a");
  const olderOutcome = queryClient.fetchQuery({
    queryKey: agentKey,
    queryFn: () => oldAgentResponse.promise,
  }).catch(() => undefined);
  const refresh = refreshLatestAgentProviderUsage(
    queryClient,
    "agent-a",
    () => provider.promise,
  );
  const fresh = { provider: "codex", refreshing: true };
  provider.resolve(fresh);
  await refresh;
  oldAgentResponse.resolve({ provider: "codex", refreshing: false });
  await olderOutcome;

  assert.deepEqual(queryClient.getQueryData(agentKey), fresh);
});
