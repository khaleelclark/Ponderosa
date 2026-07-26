// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ChatPane } from "../src/components/chat/ChatPane";

describe("Conversation #tags", () => {
  it("uses the same agent-tag navigation in Agent chat", () => {
    const onOpenAgent = vi.fn();
    const view = create(<ChatPane
      messages={[{
        id: "direct-tagged",
        agentId: "agent-olympic",
        role: "assistant",
        text: "Coordinate with #Cabrillo and tell #user",
        createdAt: "2026-07-12T00:00:00.000Z",
      }]}
      agentName="Olympic"
      agentIdForHandle={(handle) => handle.toLocaleLowerCase() === "cabrillo" ? "agent-cabrillo" : undefined}
      onOpenAgent={onOpenAgent}
    />);

    view.root.findByProps({ "aria-label": "Open agent Cabrillo" }).props.onClick();
    expect(onOpenAgent).toHaveBeenCalledWith("agent-cabrillo");
    expect(view.root.findAllByProps({ "aria-label": "Open agent user" })).toHaveLength(0);
    view.unmount();
  });

  it("opens the originating Project chat message from a structurally linked broadcast tag", () => {
    const onOpenBroadcast = vi.fn();
    const view = create(<ChatPane
      messages={[{
        id: "agent-projection",
        communicationEventId: "broadcast-event",
        conversationId: "project-chat",
        agentId: "agent-olympic",
        seq: 12,
        role: "assistant",
        text: "#broadcast Completed the audit.",
        createdAt: "2026-07-12T00:00:00.000Z",
      }]}
      agentName="Olympic"
      onOpenBroadcast={onOpenBroadcast}
    />);

    view.root.findByProps({ "aria-label": "Open originating broadcast in Project chat" }).props.onClick();
    expect(onOpenBroadcast).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "project-chat",
      communicationEventId: "broadcast-event",
    }));
    view.unmount();
  });

  it("fails closed when a broadcast-looking tag has no canonical Project chat lineage", () => {
    const html = renderToStaticMarkup(<ChatPane
      messages={[{
        id: "legacy-agent-projection",
        agentId: "agent-olympic",
        seq: 13,
        role: "assistant",
        text: "#broadcast Legacy audit.",
        createdAt: "2026-07-12T00:00:00.000Z",
      }]}
      agentName="Olympic"
      onOpenBroadcast={vi.fn()}
    />);

    expect(html).toContain('data-message-tag="broadcast"');
    expect(html).not.toContain("Open originating broadcast in Project chat");
  });

});
