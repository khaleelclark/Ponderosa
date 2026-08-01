import { describe, expect, it } from "vitest";
import { renderScopedMessage } from "../src/agent-mentions.js";
import { conversationPrompt } from "../src/prompts.js";

describe("managed artifact Communication prompts", () => {
  it("keeps the private scope marker on attachment-only user messages", () => {
    expect(renderScopedMessage("user", "")).toBe("#user");
  });

  it("makes attachment-only Project broadcasts discoverable by managed reference", () => {
    const prompt = conversationPrompt(
      [{
        id: "message-1",
        role: "assistant",
        text: "",
        createdAt: "2026-08-01T00:00:00.000Z",
        artifactIds: ["screenshot-1"],
      }],
      [],
      "Continue the work",
      { author: "Manager", channel: "main", mentionedAgents: [], addressedToCurrentAgent: false },
      "broadcast",
    );

    expect(prompt).toContain("ponderosa://artifact/screenshot-1");
    expect(prompt).toContain("Team: [artifact:");
  });
});
