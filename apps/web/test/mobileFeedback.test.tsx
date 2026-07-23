import { readFileSync } from "node:fs";
import { act, create } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { mobileComposerScrollAction, mobileOperationalStatus } from "../src/mobileChat";
import { ChatMessageFrame } from "../src/components/chat/ChatMessageFrame";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const agentDetail = readFileSync(new URL("../src/components/AgentDetail.tsx", import.meta.url), "utf8");
const allChat = readFileSync(new URL("../src/components/AllChatView.tsx", import.meta.url), "utf8");
const conversation = readFileSync(new URL("../src/components/ConversationView.tsx", import.meta.url), "utf8");
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
    const view = create(<ChatMessageFrame message={{
      id: "message-1",
      author: { kind: "agent", name: "Pinnacles" },
      createdAt: "2026-07-23T10:00:00.000Z",
      body: <p>Finished.</p>,
    }} />);
    const revealedTimestamps = () => view.root.findAll((node) =>
      node.type === "div" && node.props["data-mobile-message-timestamp"] === true);
    expect(revealedTimestamps()).toHaveLength(0);
    act(() => view.root.findByType("article").props.onClick());
    expect(revealedTimestamps()).toHaveLength(1);
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
    expect(projectHeader.indexOf('aria-label={mobileHeaderCollapsed ? "Expand chat header"')).toBeLessThan(projectHeader.indexOf("<ChatOverflowMenu"));
    expect(projectHeader).toContain("<ProjectRelationshipLink");
    expect(projectHeader).toContain('aria-label="Open Work"');
    const agentHeader = agentDetail.slice(agentDetail.indexOf('className="mobile-chat-chrome mobile-chat-header"'), agentDetail.indexOf('aria-label="Agent details"'));
    expect(agentHeader.indexOf("{detail.agent.title}")).toBeLessThan(agentHeader.indexOf('aria-label={mobileHeaderCollapsed ? "Expand agent header"'));
    expect(agentHeader).toContain("<AgentHeaderRelationships");
    expect(agentHeader).toContain('flexBasis: { xs: "100%", sm: "auto" }');
  });

  it("keeps operational rows actionable while mobile copy omits agent identity", () => {
    expect(mobileOperationalStatus("completed")).toBe("✅ Processed");
    expect(mobileOperationalStatus("running")).toBe("🔄 Active");
    expect(conversation).toContain('display: { xs: "none", sm: "block" }, flex: 1 }}>{event.text}');
    expect(conversation).toContain("Open Work details");
  });

  it("keeps the mobile brand noninteractive and provides swipe and explicit-close navigation", () => {
    expect(app).not.toContain('aria-label="Open Home"');
    expect(app).toContain('aria-label="Ponderosa"');
    expect(app).toContain('src={appIconSource} alt="" sx={{ display: "block", width: { xs: 26, sm: 28 }');
    expect(app).toContain("<SwipeableDrawer");
    expect(app).toContain('aria-label="Close workspace navigation"');
  });
});
