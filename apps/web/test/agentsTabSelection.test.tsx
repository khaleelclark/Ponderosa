import type { AgentDto, ConversationDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { selectedAgentDeletion } from "../src/components/AgentsTab";

const conversation: ConversationDto = {
  id: "chat-1",
  projectId: "project-1",
  title: "Project Chat",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
  archived: false,
};

const agents: AgentDto[] = [
  { id: "manager", projectId: "project-1", title: "Manager", conversationId: conversation.id, conversationIds: [conversation.id], activeEngine: "codex", state: {}, createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:00:00.000Z", archived: false },
  { id: "report", projectId: "project-1", title: "Report", managerAgentId: "manager", conversationId: conversation.id, conversationIds: [conversation.id], activeEngine: "codex", state: {}, createdAt: "2026-07-18T00:00:00.000Z", updatedAt: "2026-07-18T00:00:00.000Z", archived: false },
];

describe("agent selection deletion", () => {
  it("replaces delete-all with a guarded, cascade-aware selected-agent flow", () => {
    const managerOnly = selectedAgentDeletion(agents, new Set(["manager"]));
    expect(managerOnly.roots.map((agent) => agent.id)).toEqual(["manager"]);
    expect([...managerOnly.affectedIds]).toEqual(["manager", "report"]);

    const managerAndReport = selectedAgentDeletion(agents, new Set(["manager", "report"]));
    expect(managerAndReport.roots.map((agent) => agent.id)).toEqual(["manager"]);
    expect([...managerAndReport.affectedIds]).toEqual(["manager", "report"]);

    const reportOnly = selectedAgentDeletion(agents, new Set(["report"]));
    expect(reportOnly.roots.map((agent) => agent.id)).toEqual(["report"]);
    expect([...reportOnly.affectedIds]).toEqual(["report"]);
  });
});
