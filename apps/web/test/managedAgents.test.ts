import { describe, expect, it } from "vitest";
import type { AgentDto } from "@ponderosa/core";
import { activeManagerOptions, createAgentInputFromForm } from "../src/components/dialogs";

const agent = (id: string, archived = false): AgentDto => ({
  id,
  projectId: "project-1",
  title: id,
  activeEngine: "codex",
  conversationIds: [],
  archived,
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
  state: "idle",
});

describe("managed-agent creation UI contracts", () => {
  it("submits a direct manager and exact optional opening message", () => {
    expect(createAgentInputFromForm({
      title: "  Researcher  ",
      engine: "codex",
      model: "",
      effort: "high",
      conversationId: "room-1",
      presetId: "",
      managerAgentId: "manager-1",
      initialMessage: "  Verify the launch data, then report back.  ",
    })).toEqual({
      title: "Researcher",
      engine: "codex",
      model: undefined,
      effort: "high",
      conversationId: "room-1",
      presetId: undefined,
      managerAgentId: "manager-1",
      initialMessage: "Verify the launch data, then report back.",
    });
  });

  it("supports an idle top-level agent and excludes archived managers", () => {
    expect(createAgentInputFromForm({
      title: "Idle Agent",
      engine: "codex",
      model: "",
      effort: "",
      conversationId: "",
      presetId: "",
      managerAgentId: "",
      initialMessage: "   ",
    })).toEqual({
      title: "Idle Agent",
      engine: "codex",
      model: undefined,
      effort: undefined,
      conversationId: undefined,
      presetId: undefined,
      managerAgentId: undefined,
      initialMessage: undefined,
    });
    expect(activeManagerOptions([agent("active"), agent("archived", true)]).map((item) => item.id)).toEqual(["active"]);
  });
});
