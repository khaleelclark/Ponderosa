import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mobileComposerHiddenAfterScroll, mobileOperationalStatus } from "../src/mobileChat";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const agentDetail = readFileSync(new URL("../src/components/AgentDetail.tsx", import.meta.url), "utf8");
const allChat = readFileSync(new URL("../src/components/AllChatView.tsx", import.meta.url), "utf8");
const conversation = readFileSync(new URL("../src/components/ConversationView.tsx", import.meta.url), "utf8");
const panes = readFileSync(new URL("../src/components/panes.tsx", import.meta.url), "utf8");
const timestamps = readFileSync(new URL("../src/components/MessageTimestamp.tsx", import.meta.url), "utf8");
const globalCss = readFileSync(new URL("../src/global.css", import.meta.url), "utf8");

describe("mobile feedback slice", () => {
  it("hides on upward chat movement and restores on downward movement or at the bottom", () => {
    expect(mobileComposerHiddenAfterScroll({ previousTop: 400, currentTop: 380, hidden: false, nearBottom: false })).toBe(true);
    expect(mobileComposerHiddenAfterScroll({ previousTop: 380, currentTop: 400, hidden: true, nearBottom: false })).toBe(false);
    expect(mobileComposerHiddenAfterScroll({ previousTop: 400, currentTop: 399, hidden: true, nearBottom: false })).toBe(true);
    expect(mobileComposerHiddenAfterScroll({ previousTop: 400, currentTop: 350, hidden: true, nearBottom: true })).toBe(false);
  });

  it("wires the shared composer behavior to every composing chat surface", () => {
    expect(agentDetail).toContain("onScrollPositionChange={onChatScroll}");
    expect(agentDetail).toContain("data-mobile-composer-hidden");
    expect(conversation).toContain("onChatScroll(chatScrollRef.current");
    expect(conversation).toContain("data-mobile-composer-hidden");
    expect(allChat).toContain("onChatScroll(scrollRef.current");
    expect(allChat).toContain("data-mobile-composer-hidden");
  });

  it("keeps message timestamps hidden until a message reveals the compact mobile row", () => {
    expect(panes).toContain("mobileTimestampMessageId");
    expect(panes).toContain("mobileTimestampRevealed={mobileTimestampMessageId === message.id}");
    expect(conversation).toContain("mobileTimestampRevealed={mobileTimestampRevealed}");
    expect(allChat).toContain("mobileTimestampId === item.communicationEventId");
    expect(timestamps.indexOf("data-mobile-message-timestamp")).toBeLessThan(timestamps.indexOf("chat-message-action-buttons"));
  });

  it("animates the mobile composer and chat header from the same scroll-direction state", () => {
    expect(agentDetail).toContain('data-mobile-chat-header-hidden={composerHidden ? "true" : "false"}');
    expect(conversation).toContain('data-mobile-chat-header-hidden={composerHidden ? "true" : "false"}');
    expect(agentDetail).toContain('className="mobile-chat-chrome mobile-chat-composer"');
    expect(conversation).toContain('className="mobile-chat-chrome mobile-chat-composer"');
    expect(globalCss).toContain("transition: max-height 180ms ease, opacity 140ms ease, transform 180ms ease");
    expect(globalCss).toContain('[data-mobile-chat-header-hidden="true"]');
    expect(globalCss).toContain('[data-mobile-composer-hidden="true"]');
    expect(globalCss).toContain("@media (prefers-reduced-motion: reduce)");
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
    expect(app).toContain("<SwipeableDrawer");
    expect(app).toContain('aria-label="Close workspace navigation"');
  });
});
