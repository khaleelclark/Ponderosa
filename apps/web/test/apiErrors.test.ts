import { afterEach, describe, expect, it, vi } from "vitest";
import { realApi } from "../src/api/real";

describe("API errors", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("surfaces a structured server error instead of hiding it behind the HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "filesystem patterns must be relative glob patterns without '..'",
    }), {
      status: 400,
      statusText: "Bad Request",
      headers: { "content-type": "application/json" },
    })));

    await expect(realApi.createTrigger("agent", {
      conversationId: "chat",
      name: "Test Trigger",
      instructions: "Audit changes",
      sourceKind: "filesystem",
      sourceConfig: { include: ["../outside/**"], exclude: [], quietMs: 5_000, maxWindowMs: 60_000 },
    })).rejects.toThrow("filesystem patterns must be relative glob patterns without '..'");
  });
});
