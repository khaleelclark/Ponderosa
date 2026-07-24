import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMessageFrame } from "../src/components/chat/ChatMessageFrame";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("../src/components/WorkspaceSidebar.tsx", import.meta.url), "utf8");
const timestamps = readFileSync(new URL("../src/components/MessageTimestamp.tsx", import.meta.url), "utf8");
const artifacts = readFileSync(new URL("../src/components/ProjectArtifactsView.tsx", import.meta.url), "utf8");
const globalCss = readFileSync(new URL("../src/global.css", import.meta.url), "utf8");
const tabs = readFileSync(new URL("../src/components/WorkspaceTabs.tsx", import.meta.url), "utf8");

describe("responsive compact controls", () => {
  it("uses the same accessible list navigation in the phone drawer and desktop shell", () => {
    expect(app.match(/<WorkspaceSidebar/g)).toHaveLength(2);
    expect(app).toContain('width: "min(100vw, 390px)", maxWidth: "100vw"');
    expect(app).toContain("<SwipeableDrawer");
    expect(app).toContain('aria-label="Close workspace navigation"');
    expect(app).toContain("setMobileNavOpen(false); navigateWorkspace(next)");
    expect(sidebar).toContain('aria-label="Primary navigation"');
    expect(sidebar).toContain('placeholder="Search Chats"');
    expect(sidebar).toContain("drawer?: boolean");
    expect(sidebar).toContain('width: 48');
    expect(sidebar).toContain('onContextMenu={(event)');
    expect(sidebar).toContain('view: "triggers"');
    expect(app).toContain('onRenameConversation={(conversation) => { setMobileNavOpen(false);');
    expect(app).toContain('onDeleteConversation={(conversation) => { setMobileNavOpen(false);');
    expect(sidebar).not.toContain("<Dialog");
    expect(sidebar).not.toContain("maxHeight: \"34%\"");
  });

  it("removes workspace tabs on mobile while retaining the desktop tab strip", () => {
    expect(app).toContain('theme.breakpoints.down("md")');
    expect(app).toContain("!mobileWorkspace ? <WorkspaceTabs");
    expect(tabs).toContain('minWidth: { xs: 132, md: 140 }');
    expect(tabs).toContain('flex: "0 1 220px"');
    expect(tabs).toContain('overflowX: "auto"');
    expect(tabs).toContain('scrollSnapType: "x proximity"');
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
    expect(sidebar).toContain('showingProjectNavigation && insideProject ? chatsPanel : homePanel');
    expect(sidebar).not.toContain("localStorage");
    expect(sidebar).not.toContain("updateWorkspacePreferences");
    expect(sidebar).not.toContain("preferences.sidebarWidth");
    expect(app).toContain("onPreferences={savePreferences}");
  });

  it("keeps touched chat actions, user bubbles, and file previews usable at narrow widths", () => {
    const html = renderToStaticMarkup(<ChatMessageFrame message={{
      id: "message-1",
      author: { kind: "operator" },
      createdAt: "2026-07-23T10:00:00.000Z",
      body: <p>Compact message</p>,
    }} />);
    expect(html).toContain("max-width:94%");
    expect(html).toContain("max-width:88%");
    expect(html).toContain("max-width:min(78%, 780px)");
    expect(timestamps).toContain('useFlexGap flexWrap="wrap"');
    expect(timestamps).toContain('minWidth: { xs: 44, sm: 28 }');
    expect(globalCss).toContain("@media (hover: none), (pointer: coarse)");
    expect(artifacts).toContain('className="ponderosa-scroll"');
    expect(artifacts).toContain('overflow: "auto"');
    expect(artifacts).toContain('minHeight: { xs: 44, sm: 36 }');
  });
});
