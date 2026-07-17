import type { AgentWorkItemDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentWorkTechnicalDetails } from "../src/components/AgentWorkInspector";

afterEach(() => vi.restoreAllMocks());

describe("Agent work inspector", () => {
  it("loads payload-bearing technical details only after the operator expands them", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      projectId: "project", itemId: "request:request-one", recordId: "request-one",
      details: [
        { label: "Payload", value: '{"assignment":"review"}' },
        { label: "Wake policy", value: "Final only" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const item: AgentWorkItemDto = {
      id: "request:request-one", recordId: "request-one", referenceIds: ["request-one"], kind: "request",
      state: "open", title: "Assigned work", summary: "The assigned work is still open.",
      agentIds: ["agent"], relatedItemIds: [],
      createdAt: "2026-07-17T00:00:00.000Z", updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const view = create(<QueryClientProvider client={client}>
      <AgentWorkTechnicalDetails projectId="project" conversationId="chat" item={item} />
    </QueryClientProvider>);

    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      view.root.findByType("details").props.onToggle({ currentTarget: { open: true } });
    });

    for (let attempt = 0; attempt < 100 && !JSON.stringify(view.toJSON()).includes("assignment"); attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/projects/project/agent-work/items/request/request-one?conversationId=chat");
    expect(JSON.stringify(view.toJSON())).toContain("assignment");
    expect(JSON.stringify(view.toJSON())).toContain("Wake policy");
    expect(JSON.stringify(view.toJSON())).toContain("Final only");
    view.unmount();
    client.clear();
  });
});
