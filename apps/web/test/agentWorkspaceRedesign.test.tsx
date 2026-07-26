import type { AgentActivityDto, AgentDetailDto, AgentDto, AgentRunDto, ConversationDto, EngineDto, RunOutputDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentDetail } from "../src/components/AgentDetail";
import { ActivityPane } from "../src/components/activity/ActivityPane";

const runs = [
  { id: "run-oldest", agentId: "agent", title: "First assignment", engine: "codex", status: "completed", startedAt: "2026-07-23T08:00:00.000Z", completedAt: "2026-07-23T08:01:00.000Z" },
  { id: "run-previous", agentId: "agent", title: "Previous assignment", engine: "codex", status: "completed", startedAt: "2026-07-23T09:00:00.000Z", completedAt: "2026-07-23T09:02:00.000Z" },
  { id: "run-current", agentId: "agent", title: "Current assignment", engine: "codex", status: "running", startedAt: "2026-07-23T10:00:00.000Z" },
] as AgentRunDto[];

const activity: AgentActivityDto[] = [
  { id: "command", agentId: "agent", executionId: "run-current", seq: 4, createdAt: "2026-07-23T10:00:04.000Z", event: { type: "command", command: "pnpm test", cwd: "/repo" } },
  { id: "tool", agentId: "agent", executionId: "run-previous", seq: 2, createdAt: "2026-07-23T09:00:02.000Z", event: { type: "tool_call", name: "read_file", input: { path: "a.ts" } } },
];

const runOutput: RunOutputDto[] = [
  { id: "thinking", agentId: "agent", executionId: "run-current", kind: "reasoning", text: "Inspecting the route contract", completed: true, seq: 3, sourceSeqStart: 3, sourceSeqEnd: 3, createdAt: "2026-07-23T10:00:03.000Z" },
  { id: "response", agentId: "agent", executionId: "run-current", kind: "response", text: "Verification passed", completed: true, seq: 5, sourceSeqStart: 5, sourceSeqEnd: 5, createdAt: "2026-07-23T10:00:05.000Z" },
];

describe("Agent activity workspace", () => {
  it("renders the current Run before previous Runs and interleaves its visible evidence", () => {
    const html = renderToStaticMarkup(<ActivityPane
      activity={activity}
      runOutput={runOutput}
      runs={runs}
      connected
      running
      activeExecutionId="run-current"
    />);

    expect(html.indexOf("Current assignment")).toBeLessThan(html.indexOf("Previous assignment"));
    expect(html).toContain('data-current-run="true"');
    expect(html).toContain('data-current-run="false"');
    expect(html).toContain('data-activity-kind="reasoning"');
    expect(html).toContain('data-activity-kind="command"');
    expect(html.indexOf("Inspecting the route contract")).toBeLessThan(html.indexOf("pnpm test"));
    expect(html.indexOf("pnpm test")).toBeLessThan(html.indexOf("Verification passed"));
  });

  it("renders the public Agent detail chat with its stable audit tabs and direct composer", () => {
    const agent: AgentDto = {
      id: "agent",
      projectId: "project",
      conversationId: "conversation",
      conversationIds: ["conversation"],
      title: "Review Agent",
      activeEngine: "codex",
      state: {},
      createdAt: "2026-07-23T10:00:00.000Z",
      updatedAt: "2026-07-23T10:00:00.000Z",
      archived: false,
    };
    const conversation: ConversationDto = {
      id: "conversation",
      projectId: "project",
      title: "Release review",
      createdAt: "2026-07-23T10:00:00.000Z",
      updatedAt: "2026-07-23T10:00:00.000Z",
      archived: false,
    };
    const engine: EngineDto = {
      id: "codex",
      displayName: "Codex",
      models: [],
      efforts: [],
      configured: true,
      authenticated: true,
      available: true,
    };
    const detail = {
      agent,
      messages: [],
      runOutput: [],
      activity: [],
      changedFiles: [],
      runs: [],
      workItems: [],
      artifacts: [],
    } as AgentDetailDto;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["agent", agent.id, 100], detail);
    client.setQueryData(["notifications"], []);
    client.setQueryData(["queued-agent-messages", agent.id], []);
    client.setQueryData(["projects"], [{ id: "project", label: "Project", defaultEngine: "codex" }]);
    client.setQueryData(["workspace-preferences"], { engineDefaults: {} });

    const html = renderToStaticMarkup(<QueryClientProvider client={client}><AgentDetail
      agentId={agent.id}
      engines={[engine]}
      engineCapabilities={[]}
      onRefreshCapabilities={vi.fn()}
      statusByAgentId={new Map()}
      healthByAgentId={new Map()}
      agents={[agent]}
      conversations={[conversation]}
      onOpenProject={vi.fn()}
      onOpenAgent={vi.fn()}
      onOpenBroadcast={vi.fn()}
      onOpenMaster={vi.fn()}
      onOpenArtifact={vi.fn()}
      onOpenArtifactInNewTab={vi.fn()}
      onOpenReview={vi.fn()}
      onOpenReviewInNewTab={vi.fn()}
      onOpenBrowser={vi.fn()}
      onNewSubagent={vi.fn()}
      onOpenTechnicalDetails={vi.fn()}
      onDeleted={vi.fn()}
    /></QueryClientProvider>);

    expect(html).toContain("Review Agent");
    expect(html).toContain('aria-label="Agent details"');
    expect(html).toContain(">Chat<");
    expect(html).toContain(">Activity<");
    expect(html).toContain("Files &amp; Results");
    expect(html).toContain('aria-label="Chat panel"');
    expect(html).toContain('aria-label="Message"');
    expect(html).toContain("Message this agent directly");
    client.clear();
  });
});
