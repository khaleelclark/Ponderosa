// @vitest-environment node

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Button, TextField } from "@mui/material";
import type { ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TriggerDefinitionDto, TriggerOccurrenceDto } from "@ponderosa/core";
import { api } from "../src/api";
import { TriggersPane } from "../src/components/TriggersPane";

vi.mock("@mui/material", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mui/material")>();
  const { createElement, forwardRef } = await import("react");
  return {
    ...actual,
    Dialog: forwardRef<HTMLDivElement, { open: boolean; children?: ReactNode }>(({ open, children }, ref) =>
      open ? createElement("div", { ref, role: "dialog" }, children) : null),
  };
});

describe("Agent Triggers", () => {
  afterEach(() => vi.restoreAllMocks());

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
    view.unmount();
    client.clear();
  });

  it("validates budget allowance and confirms secret rotation and deletion without native dialogs", async () => {
    const trigger: TriggerDefinitionDto = {
      id: "trigger-actions", projectId: "project", conversationId: "chat", agentId: "agent",
      name: "Action trigger", instructions: "Review changes", sourceKind: "webhook",
      sourceConfig: { replayWindowSeconds: 300 }, enabled: true, fullAccess: true,
      runBudget: { limit: 10, period: "month" },
      budgetState: { used: 10, allowance: 0, held: true, periodStartedAt: "2026-07-01T00:00:00.000Z" },
      webhookPath: "/api/trigger-webhooks/trigger-actions", secretFingerprint: "abc123",
      createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-23T09:00:00.000Z",
    };
    const allow = vi.spyOn(api, "allowTriggerRuns").mockResolvedValue({ ...trigger, budgetState: { ...trigger.budgetState!, allowance: 5 } });
    const rotate = vi.spyOn(api, "rotateTriggerSecret").mockResolvedValue({ trigger, webhookSecret: "rotated-secret" });
    const remove = vi.spyOn(api, "deleteTrigger").mockResolvedValue({ deleted: true });
    vi.spyOn(api, "listTriggers").mockResolvedValue([trigger]);
    vi.spyOn(api, "listAgentTriggerOccurrences").mockResolvedValue([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    client.setQueryData(["triggers", "agent"], [trigger]);
    client.setQueryData(["agent-trigger-occurrences", "agent"], []);
    const view = create(<QueryClientProvider client={client}><TriggersPane agent={{
      id: "agent", projectId: "project", conversationId: "chat", conversationIds: ["chat"],
      title: "Worker", activeEngine: "codex", state: {}, createdAt: "2026-07-16T12:00:00.000Z",
      updatedAt: "2026-07-16T12:00:00.000Z", archived: false,
    }} /></QueryClientProvider>);

    act(() => view.root.findAllByType(Button).find((button) => button.props.children === "Allow More Runs")!.props.onClick());
    const allowanceField = view.root.findAllByType(TextField).find((field) => field.props.label === "Additional Runs")!;
    act(() => allowanceField.props.onChange({ target: { value: "0" } }));
    expect(JSON.stringify(view.toJSON())).toContain("Enter a positive whole number.");
    expect(allow).not.toHaveBeenCalled();
    act(() => view.root.findAllByType(TextField).find((field) => field.props.label === "Additional Runs")!.props.onChange({ target: { value: "5" } }));
    await act(async () => {
      view.root.findAllByType(Button).find((button) => button.props.children === "Allow Runs")!.props.onClick();
    });
    expect(allow).toHaveBeenCalledWith(trigger.id, 5);

    act(() => view.root.findAllByType(Button).find((button) => button.props.children === "Rotate Secret")!.props.onClick());
    expect(JSON.stringify(view.toJSON())).toContain("Existing senders will stop working immediately.");
    act(() => view.root.findAllByType(Button).find((button) => button.props.children === "Cancel")!.props.onClick());
    expect(rotate).not.toHaveBeenCalled();

    act(() => view.root.findAllByType(Button).find((button) => button.props.children === "Delete")!.props.onClick());
    expect(JSON.stringify(view.toJSON())).toContain("Pending occurrences will be cancelled.");
    await act(async () => {
      view.root.findAllByType(Button).find((button) => button.props.children === "Delete Trigger")!.props.onClick();
    });
    expect(remove).toHaveBeenCalledWith(trigger.id);
    view.unmount();
    client.clear();
  });
});
