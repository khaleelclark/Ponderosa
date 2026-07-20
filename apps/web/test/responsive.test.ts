import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isCompactViewport } from "../src/responsive";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("../src/components/WorkspaceSidebar.tsx", import.meta.url), "utf8");
const conversation = readFileSync(new URL("../src/components/ConversationView.tsx", import.meta.url), "utf8");
const timestamps = readFileSync(new URL("../src/components/MessageTimestamp.tsx", import.meta.url), "utf8");
const artifacts = readFileSync(new URL("../src/components/ProjectArtifactsView.tsx", import.meta.url), "utf8");
const globalCss = readFileSync(new URL("../src/global.css", import.meta.url), "utf8");
const tabs = readFileSync(new URL("../src/components/WorkspaceTabs.tsx", import.meta.url), "utf8");

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
    expect(app).toContain('width: "min(100vw, 390px)", maxWidth: "100vw"');
    expect(app).toContain("setMobileNavOpen(false); navigateWorkspace(next)");
    expect(sidebar).toContain('aria-label="Primary navigation"');
    expect(sidebar).toContain('placeholder="Search Project Chats"');
    expect(sidebar).toContain("drawer?: boolean");
    expect(sidebar).toContain('width: 48');
    expect(sidebar).toContain('onContextMenu={(event)');
    expect(sidebar).toContain('view: "triggers"');
    expect(app).toContain('onRenameConversation={(conversation) => { setMobileNavOpen(false);');
    expect(app).toContain('onDeleteConversation={(conversation) => { setMobileNavOpen(false);');
    expect(sidebar).not.toContain("<Dialog");
    expect(sidebar).not.toContain("maxHeight: \"34%\"");
  });

  it("keeps mobile tabs touchable, horizontally contained, and browser-like", () => {
    expect(tabs).not.toContain('display: { xs: "none", md: "flex" }');
    expect(tabs).toContain('minWidth: { xs: 132, md: 140 }');
    expect(tabs).toContain('flex: "0 1 220px"');
    expect(tabs).toContain('overflowX: "auto"');
    expect(tabs).toContain('scrollSnapType: "x proximity"');
    expect(tabs).toContain('width: { xs: 44, md: 36 }');
  });

  it("animates collapse without slowing pointer resize and honors reduced motion", () => {
    expect(sidebar).toContain('data-sidebar-resizing={resizing ? "true" : "false"}');
    expect(sidebar).toContain('!drawer && !resizing ? "width 180ms');
    expect(sidebar).toContain('"@media (prefers-reduced-motion: reduce)": { transition: "none" }');
    expect(sidebar).toContain('touchAction: "none"');
  });

  it("keeps navigation semantic while the spine and one-level panel remain stable", () => {
    expect(sidebar).toContain("SIDEBAR_RAIL_WIDTH");
    expect(sidebar).toContain("SIDEBAR_PANEL_WIDTH");
    expect(sidebar).toContain('insideProject ? chatsPanel : projectsPanel');
    expect(sidebar).not.toContain("localStorage");
    expect(sidebar).not.toContain("updateWorkspacePreferences");
    expect(sidebar).not.toContain("preferences.sidebarWidth");
    expect(app).toContain("onPreferences={savePreferences}");
  });

  it("keeps touched chat actions, user bubbles, and file previews usable at narrow widths", () => {
    expect(conversation).toContain('maxWidth: fromManager ? { xs: "94%", sm: "88%", md: "min(78%, 780px)" }');
    expect(timestamps).toContain('useFlexGap flexWrap="wrap"');
    expect(timestamps).toContain('minWidth: { xs: 44, sm: 28 }');
    expect(globalCss).toContain("@media (hover: none), (pointer: coarse)");
    expect(artifacts).toContain('className="ponderosa-scroll"');
    expect(artifacts).toContain('overflow: "auto"');
    expect(artifacts).toContain('minHeight: { xs: 44, sm: 36 }');
  });
});
