import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("Agent history page budgets", () => {
  it("uses a smaller initial detail page and larger explicit history pages", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.getAgent("agent/one");
    await api.getAgentHistory("agent/one", "activity");

    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      "/api/agents/agent%2Fone?limit=15",
      "/api/agents/agent%2Fone/history/activity?limit=25",
    ]);
  });
});
