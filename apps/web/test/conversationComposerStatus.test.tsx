import type { AgentDto, AgentHealthDto } from "@ponderosa/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MasterRespondingIndicator } from "../src/components/ConversationComposerStatus";

const agent: AgentDto = {
  id: "agent-crater-lake",
  projectId: "project-status-test",
  conversationId: "conversation-status-test",
  conversationIds: ["conversation-status-test"],
  title: "Crater Lake",
  activeEngine: "codex",
  state: {},
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  archived: false,
  managementPermissions: {
    allowAutomaticDescendantDeletion: false,
    allowAutomaticDescendantReorganization: false,
  },
};

function runningHealth(): AgentHealthDto {
  return {
    agentId: agent.id,
    childAgentIds: [],
    status: "running",
    statusTimestamp: "2026-08-02T00:00:00.000Z",
    reason: "active_run",
    executionId: "run-status-test",
    runtimeOwnership: "running",
    runtimeActivity: {
      state: "responding",
      executionId: "run-status-test",
      startedAt: "2026-08-02T00:00:00.000Z",
    },
  };
}

describe("MasterRespondingIndicator", () => {
  it("owns the health lookup and renders nothing when no Agent is responding", () => {
    const view = render(
      <MasterRespondingIndicator
        agents={[agent]}
        healthByAgentId={new Map()}
      />,
    );

    expect(screen.queryByRole("status")).toBeNull();

    view.rerender(
      <MasterRespondingIndicator
        agents={[agent]}
        healthByAgentId={new Map([[agent.id, runningHealth()]])}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain(
      "Crater Lake is responding",
    );
  });
});
