import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TriggersPane } from "../src/components/TriggersPane";

describe("Agent Triggers", () => {
  afterEach(() => vi.restoreAllMocks());

  it("makes full authority prominent and renders Agent-owned Trigger status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      id: "trigger-1", projectId: "project", conversationId: "chat", agentId: "agent",
      name: "Issue intake", instructions: "Review new issues", sourceKind: "webhook",
      sourceConfig: { replayWindowSeconds: 300 }, enabled: true, fullAccess: true,
      webhookPath: "/api/trigger-webhooks/trigger-1", secretFingerprint: "abc123",
      createdAt: "2026-07-16T12:00:00.000Z", updatedAt: "2026-07-16T12:00:00.000Z",
    }]), { status: 200, headers: { "content-type": "application/json" } })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><TriggersPane agent={{
        id: "agent", projectId: "project", conversationId: "chat", conversationIds: ["chat"],
        title: "Worker", activeEngine: "codex", state: {}, createdAt: "2026-07-16T12:00:00.000Z",
        updatedAt: "2026-07-16T12:00:00.000Z", archived: false,
      }} /></QueryClientProvider>);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    const rendered = JSON.stringify(view.toJSON());
    expect(rendered).toContain("Triggers run automatically with this Agent's full access");
    expect(rendered).toContain("event payloads are untrusted data");
    expect(rendered).toContain("Issue intake");
    expect(rendered).toContain("Enabled");
    expect(rendered).toContain("New Trigger");
    view.unmount();
    client.clear();
  });
});
