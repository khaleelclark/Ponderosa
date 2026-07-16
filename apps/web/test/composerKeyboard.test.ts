import { describe, expect, it } from "vitest";
import { canSubmitComposerText, composerCapabilityDisabledReason, insertComposerCapability, matchingEngineCommands, shouldIgnoreComposerKey, shouldSendComposerKey, shouldShowQueueControl } from "../src/components/panes";

describe("composer keyboard behavior", () => {
  it("returns every matching inherited command instead of truncating the menu", () => {
    const commands = Array.from({ length: 20 }, (_, index) => ({
      name: `command-${index}`,
      description: `Command ${index}`,
      source: "skill" as const,
      acceptsArguments: true,
    }));
    expect(matchingEngineCommands(commands, "command-")).toHaveLength(20);
  });

  it("sends on Enter", () => {
    expect(shouldSendComposerKey({ key: "Enter", shiftKey: false, isComposing: false, repeat: false })).toBe(true);
  });

  it("keeps Shift+Enter available for newlines", () => {
    expect(shouldSendComposerKey({ key: "Enter", shiftKey: true, isComposing: false, repeat: false })).toBe(false);
  });

  it("does not send while an IME composition is active", () => {
    expect(shouldSendComposerKey({ key: "Enter", shiftKey: false, isComposing: true, repeat: false })).toBe(false);
    expect(shouldIgnoreComposerKey({ key: "Enter", isComposing: true })).toBe(true);
  });

  it("does not send repeated Enter keydowns", () => {
    expect(shouldSendComposerKey({ key: "Enter", shiftKey: false, isComposing: false, repeat: true })).toBe(false);
  });
});

describe("runtime capability menu", () => {
  it("keeps actionable skills insertable and explains unsupported expansion", () => {
    expect(composerCapabilityDisabledReason({ id: "skill:review", kind: "skill", label: "review", description: "Review", status: "available", insertText: "$review " })).toBeUndefined();
    expect(composerCapabilityDisabledReason({ id: "plugin:github", kind: "plugin", label: "GitHub", description: "GitHub", status: "available" })).toContain("runtime-provided skills");
    expect(composerCapabilityDisabledReason({ id: "connector:gmail", kind: "connector", label: "Gmail", description: "Gmail", status: "available" })).toContain("direct connector expansion");
    expect(composerCapabilityDisabledReason({ id: "connector:offline", kind: "connector", label: "Offline", description: "Offline", status: "unavailable", unavailableReason: "Sign in first." })).toBe("Sign in first.");
    expect(insertComposerCapability("Please  review", 7, { id: "skill:review", kind: "skill", label: "review", description: "Review", status: "available", insertText: "$review " }))
      .toEqual({ text: "Please $review  review", caret: 15 });
  });
});

describe("composer submission availability", () => {
  const base = {
    text: "hello",
    disabled: false,
    running: false,
    allowUnmentionedSend: false,
    mentionedBusyHandles: [] as string[],
  };

  it("allows an existing-agent reply when spawning is unavailable", () => {
    expect(canSubmitComposerText({ ...base, text: "#Acadia hello", mentionedHandles: ["Acadia"] })).toBe(true);
  });

  it("allows a reply to a busy agent so the server can queue it", () => {
    expect(
      canSubmitComposerText({
        ...base,
        text: "#Acadia follow up",
        mentionedHandles: ["Acadia"],
        mentionedBusyHandles: ["Acadia"],
      }),
    ).toBe(true);
  });

  it("blocks an unmentioned spawn when the selected engine is unavailable", () => {
    expect(canSubmitComposerText({ ...base, mentionedHandles: [] })).toBe(false);
  });
});

describe("explicit queue control", () => {
  it("appears for text or attachment-only drafts only while the agent is responding", () => {
    expect(shouldShowQueueControl({ text: "later", hasAttachments: false, agentResponding: true, disabled: false })).toBe(true);
    expect(shouldShowQueueControl({ text: "   ", hasAttachments: true, agentResponding: true, disabled: false })).toBe(true);
    expect(shouldShowQueueControl({ text: "   ", hasAttachments: false, agentResponding: true, disabled: false })).toBe(false);
    expect(shouldShowQueueControl({ text: "later", hasAttachments: false, agentResponding: false, disabled: false })).toBe(false);
    expect(shouldShowQueueControl({ text: "later", hasAttachments: false, agentResponding: true, disabled: true })).toBe(false);
  });
});
