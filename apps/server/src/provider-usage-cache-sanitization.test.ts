import type { Adapter } from "@ponderosa/core";
import { describe, expect, it, vi } from "vitest";
import { ProviderUsageCache, type ProviderUsageTarget } from "./provider-usage-cache.js";

describe("ProviderUsageCache public failure projection", () => {
  it("contains circular initial success data without caching or rejecting its recovery chain", async () => {
    const marker = "PROVIDER_USAGE_CIRCULAR_SUCCESS_MARKER_8d31";
    const circular = {
      provider: "codex",
      windows: [],
      source: "provider-rpc",
      fetchedAt: new Date().toISOString(),
    } as Record<string, unknown>;
    circular.self = { marker, circular };
    const adapter = {
      id: "codex",
      displayName: "Codex",
      listModels: () => [],
      listEfforts: () => [],
      readProviderUsage: async () => circular,
    } as unknown as Adapter;
    const target: ProviderUsageTarget = {
      adapter,
      displayName: "Codex",
      authenticated: true,
      accountKey: "circular-initial",
    };
    const cache = new ProviderUsageCache(process.cwd());
    const unhandled: unknown[] = [];
    const uncaught: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    const onUncaught = (error: unknown): void => { uncaught.push(error); };
    process.on("unhandledRejection", onUnhandled);
    process.on("uncaughtException", onUncaught);
    try {
      cache.refresh(target, true);
      await vi.waitFor(() => expect(cache.state(target)).toMatchObject({
        refreshing: false,
        error: "Provider execution failed.",
      }));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(JSON.stringify(cache.state(target))).not.toContain(marker);
      expect(cache.state(target).reading).toBeUndefined();
      expect(unhandled).toEqual([]);
      expect(uncaught).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      process.off("uncaughtException", onUncaught);
      await cache.shutdown();
    }
  });

  it("rejects malformed refresh success while retaining the last closed reading", async () => {
    const marker = "PROVIDER_USAGE_CIRCULAR_REFRESH_MARKER_50f2";
    let reads = 0;
    const adapter = {
      id: "codex",
      displayName: "Codex",
      listModels: () => [],
      listEfforts: () => [],
      readProviderUsage: async () => {
        reads += 1;
        const result = {
          provider: "codex",
          windows: [],
          source: "provider-rpc",
          fetchedAt: new Date().toISOString(),
        } as Record<string, unknown>;
        if (reads > 1) result.self = { marker, result };
        return result;
      },
    } as unknown as Adapter;
    const target: ProviderUsageTarget = {
      adapter,
      displayName: "Codex",
      authenticated: true,
      accountKey: "circular-refresh",
    };
    const cache = new ProviderUsageCache(process.cwd());
    cache.refresh(target, true);
    await vi.waitFor(() => expect(cache.state(target).refreshing).toBe(false));
    expect(cache.state(target).reading).toBeDefined();
    cache.refresh(target, true);
    await vi.waitFor(() => expect(cache.state(target)).toMatchObject({
      refreshing: false,
      error: "Provider execution failed.",
      reading: { provider: "codex", stale: true },
    }));
    expect(JSON.stringify(cache.state(target))).not.toContain(marker);
    await cache.shutdown();
  });

  it("contains hostile initial rejection getters without an unhandled rejection", async () => {
    const marker = "PROVIDER_USAGE_INITIAL_GETTER_MARKER_109c";
    const errorLike = Object.create(Error.prototype) as object;
    Object.defineProperty(errorLike, "message", {
      get: () => { throw new Error(marker); },
    });
    const adapter = {
      id: "codex",
      displayName: "Codex",
      listModels: () => [],
      listEfforts: () => [],
      readProviderUsage: async () => { throw errorLike; },
    } as unknown as Adapter;
    const target: ProviderUsageTarget = {
      adapter,
      displayName: "Codex",
      authenticated: true,
      accountKey: "hostile-initial",
    };
    const cache = new ProviderUsageCache(process.cwd());
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      cache.refresh(target, true);
      await vi.waitFor(() => {
        expect(cache.state(target)).toMatchObject({
          refreshing: false,
          error: "Provider execution failed.",
        });
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(JSON.stringify(cache.state(target))).not.toContain(marker);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await cache.shutdown();
    }
  });

  it("contains hostile refresh rejections while preserving the last reading", async () => {
    const marker = "PROVIDER_USAGE_REFRESH_PROXY_MARKER_e54b";
    const hostile = new Proxy(Object.create(null) as object, {
      get: () => { throw new Error(marker); },
      getOwnPropertyDescriptor: () => { throw new Error(`${marker}:descriptor`); },
      getPrototypeOf: () => { throw new Error(`${marker}:prototype`); },
    });
    let reads = 0;
    const adapter = {
      id: "codex",
      displayName: "Codex",
      listModels: () => [],
      listEfforts: () => [],
      readProviderUsage: async () => {
        reads += 1;
        if (reads > 1) throw hostile;
        return {
          provider: "codex",
          windows: [],
          source: "provider-rpc",
          fetchedAt: new Date().toISOString(),
        };
      },
    } as unknown as Adapter;
    const target: ProviderUsageTarget = {
      adapter,
      displayName: "Codex",
      authenticated: true,
      accountKey: "hostile-refresh",
    };
    const cache = new ProviderUsageCache(process.cwd());

    cache.refresh(target, true);
    await vi.waitFor(() => expect(cache.state(target).refreshing).toBe(false));
    expect(cache.state(target).reading).toBeDefined();
    cache.refresh(target, true);
    await vi.waitFor(() => {
      expect(cache.state(target)).toMatchObject({
        refreshing: false,
        error: "Provider execution failed.",
        reading: { provider: "codex", stale: true },
      });
    });
    expect(JSON.stringify(cache.state(target))).not.toContain(marker);
    await cache.shutdown();
  });

  it("sanitizes encoded, confusable, Basic, and semantic credentials before later state reads", async () => {
    const raw = [
      "cGFzc3dvcmQ9aHVudGVyMg==",
      "Веагег short123",
      "сode=hunter2",
      "Basic dXNlcjpodW50ZXIy",
      "signing_key=x",
      "https://user:hunter2@example.com/runtime",
    ].join(" ");
    const adapter = {
      id: "codex",
      displayName: "Codex",
      listModels: () => [],
      listEfforts: () => [],
      readProviderUsage: async () => {
        await Promise.resolve();
        throw new Error(raw);
      },
    } as unknown as Adapter;
    const target: ProviderUsageTarget = {
      adapter,
      displayName: "Codex",
      authenticated: true,
      accountKey: "test-account",
    };
    const cache = new ProviderUsageCache(process.cwd());

    expect(cache.refresh(target, true).refreshing).toBe(true);
    await vi.waitFor(() => {
      expect(cache.state(target)).toMatchObject({
        provider: "codex",
        refreshing: false,
        error: "Provider execution failed.",
      });
    });

    const projected = JSON.stringify(cache.state(target));
    expect(projected).not.toContain(raw);
    expect(projected).not.toMatch(
      /cGFzc3dv|hunter2|short123|dXNlcj|signing_key|user:hunter2/iu,
    );
    await cache.shutdown();
  });

  it.each([
    ["deadline exceeded / operation exceeded retry budget", "Provider is temporarily unavailable."],
    ["Ошибка подключения к провайдеру", "Provider execution failed."],
  ])("projects benign async reader detail through the finite policy: %s", async (detail, expected) => {
    const adapter = {
      id: "codex",
      displayName: "Codex",
      listModels: () => [],
      listEfforts: () => [],
      readProviderUsage: async () => { throw new Error(detail); },
    } as unknown as Adapter;
    const target: ProviderUsageTarget = {
      adapter,
      displayName: "Codex",
      authenticated: true,
      accountKey: `safe-${detail}`,
    };
    const cache = new ProviderUsageCache(process.cwd());

    cache.refresh(target, true);
    await vi.waitFor(() => {
      expect(cache.state(target).error).toBe(expected);
      expect(cache.state(target).error).not.toContain(detail);
    });
    await cache.shutdown();
  });
});
