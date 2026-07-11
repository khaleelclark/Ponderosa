import { describe, expect, it } from "vitest";
import { canSubmitComposerText, shouldIgnoreComposerKey, shouldSendComposerKey } from "../src/components/panes";

describe("composer keyboard behavior", () => {
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

describe("composer submission availability", () => {
  const base = {
    text: "hello",
    disabled: false,
    running: false,
    allowUnmentionedSend: false,
    mentionedBusyHandles: [] as string[],
  };

  it("allows an existing-agent reply when spawning is unavailable", () => {
    expect(canSubmitComposerText({ ...base, text: "@Acadia hello", mentionedHandles: ["Acadia"] })).toBe(true);
  });

  it("allows a reply to a busy agent so the server can queue it", () => {
    expect(
      canSubmitComposerText({
        ...base,
        text: "@Acadia follow up",
        mentionedHandles: ["Acadia"],
        mentionedBusyHandles: ["Acadia"],
      }),
    ).toBe(true);
  });

  it("blocks an unmentioned spawn when the selected engine is unavailable", () => {
    expect(canSubmitComposerText({ ...base, mentionedHandles: [] })).toBe(false);
  });
});
