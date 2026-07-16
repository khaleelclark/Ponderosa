import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isCompactViewport } from "../src/responsive";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("../src/components/WorkspaceSidebar.tsx", import.meta.url), "utf8");

describe("responsive compact controls", () => {
  it.each([
    [320, 568],
    [360, 800],
    [390, 844],
    [430, 932],
  ])("uses compact controls at %ipx phone width", (width, height) => {
    expect(isCompactViewport({ width, height })).toBe(true);
  });

  it.each([
    [768, 1024],
    [820, 1180],
    [1440, 900],
  ])("keeps controls expanded with %ix%i of usable space", (width, height) => {
    expect(isCompactViewport({ width, height })).toBe(false);
  });

  it.each([
    [667, 375],
    [844, 390],
    [1024, 600],
  ])("uses compact controls for short landscape viewport %ix%i", (width, height) => {
    expect(isCompactViewport({ width, height })).toBe(true);
  });

  it("uses the same accessible list navigation in the phone drawer and desktop shell", () => {
    expect(app.match(/<WorkspaceSidebar/g)).toHaveLength(2);
    expect(app).toContain('width: "min(88vw, 360px)"');
    expect(app).toContain("setMobileNavOpen(false); goHome(next)");
    expect(sidebar).toContain('aria-label="Recent chats across projects"');
    expect(sidebar).toContain('aria-label="View all agents across projects"');
    expect(sidebar).toContain("drawer?: boolean");
    expect(sidebar).toContain('minWidth: 44, minHeight: 44');
    expect(sidebar).toContain('aria-label={`Actions for ${displayTitle}`}');
    expect(sidebar).not.toContain("maxHeight: \"34%\"");
  });

  it("keeps sidebar presentation state device-local while semantic navigation stays server-backed", () => {
    expect(sidebar).toContain('collapsed: "ponderosa.sidebar.collapsed"');
    expect(sidebar).toContain('width: "ponderosa.sidebar.width"');
    expect(sidebar).toContain('agentsExpanded: "ponderosa.sidebar.agentsExpanded"');
    expect(sidebar).toContain("window.localStorage.setItem(key, value)");
    expect(sidebar).not.toContain("updateWorkspacePreferences");
    expect(sidebar).not.toContain("preferences.sidebarWidth");
    expect(app).toContain("onPreferences={savePreferences}");
  });
});
