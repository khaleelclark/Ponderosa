// @vitest-environment node

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentWorkInspector } from "../src/components/AgentWorkInspector";

afterEach(() => vi.restoreAllMocks());

describe("Agent work inspector", () => {
  it("requests an exact focused record in addition to the bounded recent window", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      projectId: "project",
      agentId: "agent",
      generatedAt: "2026-07-17T00:00:00.000Z",
      agents: [],
      traces: [],
      items: [],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = create(<QueryClientProvider client={client}>
      <AgentWorkInspector
        open
        projectId="project"
        agentId="agent"
        focus={{ id: "request:older-request" }}
        onClose={() => undefined}
      />
    </QueryClientProvider>);

    for (let attempt = 0; attempt < 100 && fetchMock.mock.calls.length === 0; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("focusId=request%3Aolder-request");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("limit=200");
    view.unmount();
    client.clear();
  });
});
