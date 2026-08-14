import type { Adapter } from "@ponderosa/core";
import { describe, expect, it, vi } from "vitest";
import { ProviderUsageCache, type ProviderUsageTarget } from "./provider-usage-cache.js";

describe("ProviderUsageCache public failure projection", () => {
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
        error: "Provider usage could not be refreshed.",
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
    "deadline exceeded / operation exceeded retry budget",
    "Ошибка подключения к провайдеру",
  ])("retains useful benign async reader detail: %s", async (detail) => {
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
      expect(cache.state(target).error).toBe(detail);
    });
    await cache.shutdown();
  });
});
