import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

describe("application dialog migration", () => {
  it("does not use native prompt, confirm, or alert actions in workspace components", () => {
    const components = [
      "../src/components/AgentDetail.tsx",
      "../src/components/AttentionSurface.tsx",
      "../src/components/ConversationView.tsx",
      "../src/components/NotificationPanel.tsx",
    ].map(source).join("\n");
    expect(components).not.toMatch(/\b(?:window|globalThis)\.(?:prompt|confirm|alert)\(/u);
    expect(components).toContain("ConfirmDialog");
    expect(components).toContain("TextInputDialog");
  });

  it("routes global Settings entry points to the workspace view without duplicate dialog state", () => {
    const app = source("../src/App.tsx");
    expect(app).toContain("<WorkspaceSettingsView");
    expect(app).not.toContain("notificationSettingsOpen");
    expect(app).not.toContain("setNotificationSettingsOpen");
  });
});
