import { renderToStaticMarkup } from "react-dom/server";
import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ConversationMessage } from "../src/components/ConversationView";
import { ChatPane } from "../src/components/panes";

describe("Conversation #tags", () => {
  it("renders the current agent name for a historical tag bound to stable identity", () => {
    const html = renderToStaticMarkup(<ConversationMessage
      message={{
        id: "renamed-tag",
        conversationId: "room",
        role: "user",
        text: "Thanks #John-Day-Fossil-Beds",
        agentMentions: [{ handle: "John-Day-Fossil-Beds", agentId: "agent-john" }],
        createdAt: "2026-07-12T00:00:00.000Z",
      }}
      conversation="main"
      agentTitle={() => "John"}
      agentIdForHandle={() => undefined}
      onOpenAgent={vi.fn()}
      onReply={vi.fn()}
      onDirectReply={vi.fn()}
      onReact={vi.fn()}
    />);

    expect(html).toContain("#John");
    expect(html).not.toContain("#John-Day-Fossil-Beds");
    expect(html).toContain('aria-label="Open agent John"');
  });

  it("links agent tags while styling reserved and unknown tags without navigation", () => {
    const html = renderToStaticMarkup(<ConversationMessage
      message={{
        id: "tagged",
        conversationId: "room",
        role: "user",
        text: "#Cabrillo hello #user #broadcast #unknown `#Olympic` [#Denali](https://example.com)",
        createdAt: "2026-07-12T00:00:00.000Z",
      }}
      conversation="main"
      agentTitle={() => "Agent"}
      agentIdForHandle={(handle) => handle.toLocaleLowerCase() === "cabrillo" ? "agent-cabrillo" : undefined}
      onOpenAgent={vi.fn()}
      onReply={vi.fn()}
      onDirectReply={vi.fn()}
      onReact={vi.fn()}
    />);

    expect(html).toContain('aria-label="Open agent Cabrillo"');
    expect(html).toContain('data-message-tag="user"');
    expect(html).toContain('data-message-tag="broadcast"');
    expect(html).toContain('data-message-tag="unknown"');
    expect(html).not.toContain('aria-label="Open agent user"');
    expect(html).toContain("<code>#Olympic</code>");
    expect(html).toContain('href="https://example.com"');
  });

  it("opens Agent chat for a recognized agent tag", () => {
    const onOpenAgent = vi.fn();
    const view = create(<ConversationMessage
      message={{
        id: "tagged",
        conversationId: "room",
        role: "assistant",
        text: "Ask #Cabrillo",
        createdAt: "2026-07-12T00:00:00.000Z",
        authorAgentId: "agent-olympic",
      }}
      conversation="main"
      agentTitle={() => "Olympic"}
      agentIdForHandle={(handle) => handle.toLocaleLowerCase() === "cabrillo" ? "agent-cabrillo" : undefined}
      onOpenAgent={onOpenAgent}
      onReply={vi.fn()}
      onDirectReply={vi.fn()}
      onReact={vi.fn()}
    />);

    view.root.findByProps({ "aria-label": "Open agent Cabrillo" }).props.onClick();
    expect(onOpenAgent).toHaveBeenCalledOnce();
    expect(onOpenAgent).toHaveBeenCalledWith("agent-cabrillo");
    view.unmount();
  });

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

  it("does not render a legacy broadcast routing prefix as agent prose", () => {
    const html = renderToStaticMarkup(<ConversationMessage
      message={{
        id: "legacy-broadcast",
        conversationId: "room",
        role: "assistant",
        text: "#broadcast Completed answer",
        createdAt: "2026-07-12T00:00:00.000Z",
        authorAgentId: "agent-olympic",
      }}
      conversation="main"
      agentTitle={() => "Olympic"}
      agentIdForHandle={() => undefined}
      onOpenAgent={vi.fn()}
      onReply={vi.fn()}
      onDirectReply={vi.fn()}
      onReact={vi.fn()}
    />);

    expect(html).toContain("Completed answer");
    expect(html).not.toContain("#broadcast");
  });
});
