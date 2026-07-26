import type { AgentDto, ConversationDetailDto, EngineDto, ProjectEngineCapabilitiesDto } from "@ponderosa/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConversationView } from "../src/components/ConversationView";

const projectId = "project-capabilities";
const conversationId = "conversation-capabilities";
const runtimeId = "runtime-selected";
const now = "2026-07-16T00:00:00.000Z";

const conversation = {
  id: conversationId,
  projectId,
  title: "Capability integration",
  defaultEngine: runtimeId,
  createdAt: now,
  updatedAt: now,
  archived: false,
};
const agent: AgentDto = {
  id: "agent-one",
  projectId,
  conversationId,
  conversationIds: [conversationId],
  title: "Agent One",
  activeEngine: runtimeId,
  state: {},
  createdAt: now,
  updatedAt: now,
  archived: false,
};
const engines: EngineDto[] = [{
  id: runtimeId,
  displayName: "Selected runtime",
  models: [],
  efforts: [],
  configured: true,
  authenticated: true,
  available: true,
}];
const engineCapabilities: ProjectEngineCapabilitiesDto[] = [{
  engineId: runtimeId,
  steering: true,
  persistentSessions: true,
  commands: [],
  mcpServers: [],
  composerCapabilities: [{
    id: "skill:review",
    kind: "skill",
    label: "Review",
    description: "Review discovered by the runtime",
    status: "available",
    insertText: "$review ",
  }],
}];

function clientWithConversation(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData<ConversationDetailDto>(["conversation", conversationId, 100], {
    conversation,
    messages: [],
    agents: [agent],
  } as ConversationDetailDto);
  client.setQueryData(["collaboration-chat", conversationId, 100], {
    messages: [],
    agents: [agent],
    operations: [],
  });
  client.setQueryData(["queued-messages", conversationId], []);
  client.setQueryData(["notifications"], []);
  client.setQueryData(["workspace-preferences"], { engineDefaults: {} });
  client.setQueryData(["projects"], [{ id: projectId, defaultEngine: runtimeId }]);
  client.setQueryData(["project-browser", projectId], { active: false });
  return client;
}

function renderConversation(initialView: "main" | "collaboration"): string {
  const client = clientWithConversation();
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><ConversationView
    conversationId={conversationId}
    initialView={initialView}
    engines={engines}
    engineCapabilities={engineCapabilities}
    onRefreshCapabilities={vi.fn()}
    statusByAgentId={new Map()}
    healthByAgentId={new Map()}
    projectAgents={[agent]}
    onOpenProject={vi.fn()}
    onOpenAgent={vi.fn()}
    onOpenAgentInNewTab={vi.fn()}
    onOpenReview={vi.fn()}
    onOpenAgentWork={vi.fn()}
    onOpenBrowser={vi.fn()}
    onOpenFileActivity={vi.fn()}
    onNewAgent={vi.fn()}
    onDeleted={vi.fn()}
  /></QueryClientProvider>);
  client.clear();
  return html;
}

describe("Project chat capability surfaces", () => {
  it("renders the public Project chat with the selected runtime composer", () => {
    const html = renderConversation("main");
    expect(html).toContain(`data-conversation-id="${conversationId}"`);
    expect(html).toContain('aria-label="Project chat messages"');
    expect(html).toContain('aria-label="Message"');
    expect(html).toContain("Capability integration");
  });

  it("renders Team chat as a read-only public audit surface", () => {
    const html = renderConversation("collaboration");
    expect(html).toContain('aria-label="Team chat messages"');
    expect(html).toContain("Team chat is a read-only audit trail of agent-to-agent coordination.");
    expect(html).not.toContain('aria-label="Message"');
  });
});
