import { describe, expect, it } from "vitest";
import { shouldSendComposerKey } from "../src/components/panes";

describe("composer keyboard behavior", () => {
  it("sends on Enter", () => {
    expect(shouldSendComposerKey({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true);
  });

  it("keeps Shift+Enter available for newlines", () => {
    expect(shouldSendComposerKey({ key: "Enter", shiftKey: true, isComposing: false })).toBe(false);
  });

  it("does not send while an IME composition is active", () => {
    expect(shouldSendComposerKey({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
  });
});
