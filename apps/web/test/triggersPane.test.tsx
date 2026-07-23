import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TriggerDefinitionDto, TriggerOccurrenceDto } from "@ponderosa/core";
import { changedSourceConfig, filesystemWindowErrors, intervalSourceConfig, isoToDatetimeLocal, latestOccurrenceByTrigger, triggerSourceSummary, TriggersPane } from "../src/components/TriggersPane";

describe("Agent Triggers", () => {
  afterEach(() => vi.restoreAllMocks());

  it("preserves source configuration across metadata-only edits", () => {
    const interval = { scheduleKind: "interval" as const, everyMs: 30 * 60_000, startsAt: "2026-07-16T12:07:08.123Z" };
    expect(intervalSourceConfig(30 * 60_000, interval)).toEqual(interval);
    expect(changedSourceConfig(interval, intervalSourceConfig(30 * 60_000, interval))).toBeUndefined();
    const webhook = { replayWindowSeconds: 600 };
    expect(changedSourceConfig(webhook, webhook)).toBeUndefined();
    expect(changedSourceConfig(webhook, { replayWindowSeconds: 300 })).toEqual({ replayWindowSeconds: 300 });

    const instant = "2026-07-16T18:23:45.678Z";
    expect(new Date(isoToDatetimeLocal(instant)).toISOString()).toBe(instant);
  });

  it("rejects filesystem windows the server cannot accept", () => {
    expect(filesystemWindowErrors("5", "60")).toEqual({});
    expect(filesystemWindowErrors("5", "4")).toEqual({
      max: "Maximum window must be at least the quiet window.",
    });
    expect(filesystemWindowErrors("5", "3600.1")).toEqual({
      max: "Maximum window must be between 0.1 seconds and 1 hour.",
    });
    expect(filesystemWindowErrors("0.1", "3600")).toEqual({});
  });

  it("makes full authority prominent and renders Agent-owned Trigger status", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("trigger-occurrences") ? [] : [{
      id: "trigger-1", projectId: "project", conversationId: "chat", agentId: "agent",
      name: "Issue intake", instructions: "Review new issues", sourceKind: "webhook",
      sourceConfig: { replayWindowSeconds: 300 }, enabled: true, fullAccess: true,
      webhookPath: "/api/trigger-webhooks/trigger-1", secretFingerprint: "abc123",
      createdAt: "2026-07-16T12:00:00.000Z", updatedAt: "2026-07-16T12:00:00.000Z",
      }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
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
    expect(rendered).toContain("Open Full Details");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/agents/agent/triggers"))).toBe(true);
    view.unmount();
    client.clear();
  });

  it("shows scoped schedule, budget, latest occurrence, current failure, and accessible actions", async () => {
    const trigger: TriggerDefinitionDto = {
      id: "trigger-1", projectId: "project", conversationId: "chat", agentId: "agent",
      name: "Nightly review", instructions: "Review changes", sourceKind: "schedule",
      sourceConfig: { scheduleKind: "cron", expression: "0 9 * * *", timezone: "UTC" },
      enabled: true, fullAccess: true,
      runBudget: { limit: 10, period: "month" },
      budgetState: { used: 10, allowance: 2, held: true, periodStartedAt: "2026-07-01T00:00:00.000Z" },
      nextFireAt: "2026-07-24T09:00:00.000Z", lastFiredAt: "2026-07-23T09:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-23T09:00:00.000Z",
    };
    const occurrences: TriggerOccurrenceDto[] = [{
      id: "occurrence-1", artifactId: "artifact-1", triggerId: trigger.id, projectId: "project", agentId: "agent",
      state: "dead_lettered", payload: {}, provenance: {}, payloadMediaType: "application/json", inputHash: "hash",
      lastError: "Provider access unavailable", occurredAt: "2026-07-23T09:00:00.000Z",
      createdAt: "2026-07-23T09:00:00.000Z", updatedAt: "2026-07-23T09:00:00.000Z",
    }];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["triggers", "agent"], [trigger]);
    client.setQueryData(["agent-trigger-occurrences", "agent"], occurrences);
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><TriggersPane agent={{
        id: "agent", projectId: "project", conversationId: "chat", conversationIds: ["chat"],
        title: "Worker", activeEngine: "codex", state: {}, createdAt: "2026-07-16T12:00:00.000Z",
        updatedAt: "2026-07-16T12:00:00.000Z", archived: false,
      }} /></QueryClientProvider>);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const rendered = JSON.stringify(view.toJSON());
    expect(rendered).toContain("Cron schedule · UTC");
    expect(rendered).toContain("10/12 automatic Runs · month");
    expect(rendered).toContain("Last occurrence:");
    expect(rendered).toContain("Next scheduled occurrence:");
    expect(rendered).toContain("Current failure:");
    expect(rendered).toContain("Provider access unavailable");
    expect(view.root.findByProps({ "aria-label": "Disable Nightly review" })).toBeTruthy();
    expect(view.root.findByProps({ "aria-label": "Edit Nightly review" })).toBeTruthy();
    expect(view.root.findByProps({ "aria-expanded": false })).toBeTruthy();
    expect(latestOccurrenceByTrigger(occurrences).get(trigger.id)?.id).toBe("occurrence-1");
    expect(triggerSourceSummary(trigger)).toBe("Cron schedule · UTC");
    view.unmount();
    client.clear();
  });
});
