import { describe, expect, it } from "vitest";
import type { ThreadDto } from "@ponderosa/core";
import { activeManagerOptions, createAgentInputFromForm } from "../src/components/dialogs";

const agent = (id: string, archived = false): ThreadDto => ({
  id,
  projectId: "project-1",
  title: id,
  activeEngine: "codex",
  masterChatIds: [],
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
      masterChatId: "room-1",
      presetId: "",
      managerAgentId: "manager-1",
      initialMessage: "  Verify the launch data, then report back.  ",
    })).toEqual({
      title: "Researcher",
      engine: "codex",
      model: undefined,
      effort: "high",
      masterChatId: "room-1",
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
      masterChatId: "",
      presetId: "",
      managerAgentId: "",
      initialMessage: "   ",
    })).toEqual({
      title: "Idle Agent",
      engine: "codex",
      model: undefined,
      effort: undefined,
      masterChatId: undefined,
      presetId: undefined,
      managerAgentId: undefined,
      initialMessage: undefined,
    });
    expect(activeManagerOptions([agent("active"), agent("archived", true)]).map((item) => item.id)).toEqual(["active"]);
  });
});
