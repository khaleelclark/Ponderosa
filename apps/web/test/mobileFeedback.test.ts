import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mobileComposerScrollAction, mobileOperationalStatus } from "../src/mobileChat";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const agentDetail = readFileSync(new URL("../src/components/AgentDetail.tsx", import.meta.url), "utf8");
const allChat = readFileSync(new URL("../src/components/AllChatView.tsx", import.meta.url), "utf8");
const conversation = readFileSync(new URL("../src/components/ConversationView.tsx", import.meta.url), "utf8");
const panes = readFileSync(new URL("../src/components/panes.tsx", import.meta.url), "utf8");
const timestamps = readFileSync(new URL("../src/components/MessageTimestamp.tsx", import.meta.url), "utf8");
const globalCss = readFileSync(new URL("../src/global.css", import.meta.url), "utf8");

describe("mobile feedback slice", () => {
  it("anchors composers at the bottom and hides them only when a phone chat is away from latest", () => {
    expect(mobileComposerScrollAction({
      mobileViewport: true, hidden: false, initialized: true, transitionActive: false,
      nearBottom: false, previousScrollTop: 500, scrollTop: 300,
    })).toBe("hide");
    expect(mobileComposerScrollAction({
      mobileViewport: true, hidden: true, initialized: true, transitionActive: false,
      nearBottom: true, previousScrollTop: 300, scrollTop: 700,
    })).toBe("show");
    expect(mobileComposerScrollAction({
      mobileViewport: true, hidden: false, initialized: true, transitionActive: true,
      nearBottom: false, previousScrollTop: 700, scrollTop: 650,
    })).toBe("none");
    expect(mobileComposerScrollAction({
      mobileViewport: false, hidden: false, initialized: true, transitionActive: false,
      nearBottom: false, previousScrollTop: 500, scrollTop: 300,
    })).toBe("none");
    expect(agentDetail).toContain("data-mobile-composer-hidden");
    expect(conversation).toContain("data-mobile-composer-hidden");
    expect(allChat).toContain("data-mobile-composer-hidden");
    expect(allChat).toContain('height: "100%"');
    expect(conversation).toContain('height: "100%"');
    expect(app).toContain('gridTemplateRows: { xs: "minmax(0, 1fr)", md: "auto minmax(0, 1fr)" }');
  });

  it("keeps message timestamps hidden until a message reveals the compact mobile row", () => {
    expect(panes).toContain("mobileTimestampMessageId");
    expect(panes).toContain("mobileTimestampRevealed={mobileTimestampMessageId === message.id}");
    expect(conversation).toContain("mobileTimestampRevealed={mobileTimestampRevealed}");
    expect(allChat).toContain("mobileTimestampId === item.communicationEventId");
    expect(timestamps.indexOf("data-mobile-message-timestamp")).toBeLessThan(timestamps.indexOf("chat-message-action-buttons"));
  });

  it("gives mobile chat headers an explicit animated minimize control", () => {
    expect(agentDetail).toContain('aria-label={mobileHeaderCollapsed ? "Expand agent header" : "Minimize agent header"}');
    expect(conversation).toContain('aria-label={mobileHeaderCollapsed ? "Expand chat header" : "Minimize chat header"}');
    expect(agentDetail).toContain("<Collapse in={!mobileHeaderCollapsed || !mobileViewport}");
    expect(conversation).toContain("<Collapse in={!mobileHeaderCollapsed || !mobileRoster}");
    expect(agentDetail).toContain('className="mobile-chat-chrome mobile-chat-composer"');
    expect(conversation).toContain('className="mobile-chat-chrome mobile-chat-composer"');
    expect(globalCss).not.toContain('[data-mobile-chat-header-hidden="true"]');
    expect(globalCss).toContain('[data-mobile-composer-hidden="true"]');
    expect(globalCss).toContain("transition: max-height 180ms");
    expect(globalCss).toContain("@media (prefers-reduced-motion: reduce)");
    const projectHeader = conversation.slice(conversation.indexOf('className="mobile-chat-chrome mobile-chat-header"'), conversation.indexOf('className="chat-scroll-region"'));
    expect(projectHeader.indexOf('aria-label="Open Agent work"')).toBeLessThan(projectHeader.indexOf('aria-label={mobileHeaderCollapsed ? "Expand chat header"'));
    expect(projectHeader.indexOf('aria-label={mobileHeaderCollapsed ? "Expand chat header"')).toBeLessThan(projectHeader.indexOf("<ChatOverflowMenu"));
    const agentHeader = agentDetail.slice(agentDetail.indexOf('className="mobile-chat-chrome mobile-chat-header"'), agentDetail.indexOf('aria-label="Agent details"'));
    expect(agentHeader.indexOf("{detail.agent.title}")).toBeLessThan(agentHeader.indexOf('aria-label={mobileHeaderCollapsed ? "Expand agent header"'));
    expect(agentHeader).toContain('flexBasis: { xs: "100%", sm: "auto" }');
  });

  it("keeps operational rows actionable while mobile copy omits agent identity", () => {
    expect(mobileOperationalStatus("completed")).toBe("✅ Processed");
    expect(mobileOperationalStatus("running")).toBe("🔄 Active");
    expect(conversation).toContain('display: { xs: "none", sm: "block" }, flex: 1 }}>{event.text}');
    expect(conversation).toContain("Open Agent work details");
  });

  it("makes mobile Ponderosa open All Chat and provides swipe and explicit-close navigation", () => {
    expect(app).toContain('aria-label="Open All Chat"');
    expect(app).toContain('navigateWorkspace({ kind: "allChat" })');
    expect(app).toContain('src={appIconSource} alt="" sx={{ display: "block", width: { xs: 26, sm: 28 }');
    expect(app).toContain("<SwipeableDrawer");
    expect(app).toContain('aria-label="Close workspace navigation"');
  });
});
