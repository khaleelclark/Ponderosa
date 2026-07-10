import { describe, expect, it } from "vitest";
import { shouldIgnoreComposerKey, shouldSendComposerKey } from "../src/components/panes";

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
