import type { ConversationMessageDto, MessageDto } from "@ponderosa/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConversationMessage } from "../src/components/ConversationView";
import { ChatPane, UserMessageLabel } from "../src/components/panes";

const createdAt = "2026-07-12T12:34:56.000Z";

function agentMessage(overrides: Partial<MessageDto>): MessageDto {
  return {
    id: "message-1",
    agentId: "agent-1",
    seq: 1,
    role: "user",
    text: "Manager request",
    createdAt,
    ...overrides,
  };
}

function masterMessage(overrides: Partial<ConversationMessageDto>): ConversationMessageDto {
  return {
    id: "master-message-1",
    conversationId: "master-1",
    role: "user",
    text: "Manager request",
    createdAt,
    ...overrides,
  };
}

function renderMaster(message: ConversationMessageDto, conversation: "main" | "collaboration" = "main"): string {
  return renderToStaticMarkup(
    <ConversationMessage
      message={message}
      conversation={conversation}
      agentTitle={() => "Pinnacles"}
      agentIdForHandle={() => undefined}
      onOpenAgent={vi.fn()}
      onReply={vi.fn()}
      onDirectReply={vi.fn()}
      onReact={vi.fn()}
    />,
  );
}

describe("user message labels on chat surfaces", () => {
  it("renders visible, non-aria-hidden label text", () => {
    const html = renderToStaticMarkup(<UserMessageLabel />);

    expect(html).toContain(">User</div>");
    expect(html).not.toContain("aria-hidden");
  });

  it("places the ChatPane user label outside the bubble before content, attachment, reply, and timestamp", () => {
    const html = renderToStaticMarkup(<ChatPane messages={[agentMessage({
      attachments: [{ id: "attachment-1", agentId: "agent-1", name: "diagram.png", mediaType: "image/png", size: 12, width: 2, height: 2, url: "/attachment.png" }],
    })]} onReply={vi.fn()} />);

    const label = html.indexOf(">User</div>");
    const bubble = html.indexOf('data-message-bubble="true"');
    const content = html.indexOf("Manager request");
    const attachment = html.indexOf('aria-label="Download diagram.png"');
    const reply = html.indexOf('aria-label="Reply to message"');
    const timestamp = html.indexOf("<time");
    expect(label).toBeGreaterThanOrEqual(0);
    expect(label).toBeLessThan(bubble);
    expect(bubble).toBeLessThan(content);
    expect(content).toBeLessThan(attachment);
    expect(attachment).toBeLessThan(reply);
    expect(reply).toBeLessThan(timestamp);
  });

  it("does not label agent messages and filters unsupported system messages from ChatPane", () => {
    const assistant = renderToStaticMarkup(<ChatPane messages={[agentMessage({ role: "assistant", text: "Agent response" })]} />);
    const system = renderToStaticMarkup(<ChatPane messages={[{ ...agentMessage({ text: "System notice" }), role: "system" } as unknown as MessageDto]} />);

    expect(assistant).toContain("Agent response");
    expect(assistant).not.toContain(">User</div>");
    expect(system).not.toContain("System notice");
    expect(system).not.toContain(">User</div>");
  });

  it("labels only manager-authored user-role master and collaboration messages", () => {
    const managerMain = renderMaster(masterMessage({}));
    const managerCollaboration = renderMaster(masterMessage({ id: "collab-user" }), "collaboration");
    const agent = renderMaster(masterMessage({ role: "assistant", authorAgentId: "agent-1", text: "Agent result" }));
    const assistant = renderMaster(masterMessage({ role: "assistant", text: "Assistant notice" }));
    const system = renderMaster(masterMessage({ role: "system", text: "System notice" }));

    expect(managerMain).toContain(">User</div>");
    expect(managerCollaboration).toContain(">User</div>");
    expect(agent).not.toContain(">User</div>");
    expect(agent).toContain("Pinnacles");
    expect(assistant).not.toContain(">User</div>");
    expect(system).not.toContain(">User</div>");
  });

  it("keeps master label outside the bubble and preserves attachment, reply actions, and timestamp ordering", () => {
    const manager = renderMaster(masterMessage({
      attachments: [{ id: "attachment-1", agentId: "agent-1", name: "diagram.png", mediaType: "image/png", size: 12, width: 2, height: 2, url: "/attachment.png" }],
    }));
    const agent = renderMaster(masterMessage({ role: "assistant", authorAgentId: "agent-1", text: "#everyone result" }));

    expect(manager.indexOf(">User</div>")).toBeLessThan(manager.indexOf('data-message-bubble="true"'));
    expect(manager.indexOf("Manager request")).toBeLessThan(manager.indexOf('aria-label="Download diagram.png"'));
    expect(manager.indexOf('aria-label="Download diagram.png"')).toBeLessThan(manager.indexOf(">Reply</button>"));
    expect(manager.indexOf(">Reply</button>")).toBeLessThan(manager.indexOf("<time"));
    expect(agent).toContain('data-message-tag="everyone"');
    expect(agent).toContain("#everyone</span> result");
    expect(agent.indexOf(">Reply</button>")).toBeLessThan(agent.indexOf("Reply Directly"));
    expect(agent.indexOf("Reply Directly")).toBeLessThan(agent.indexOf("<time"));
  });

  it("does not offer Reply Directly in collaboration while preserving Reply and timestamps", () => {
    const html = renderMaster(masterMessage({ role: "assistant", authorAgentId: "agent-1", text: "Collaboration update" }), "collaboration");

    expect(html).toContain(">Reply</button>");
    expect(html).not.toContain("Reply Directly");
    expect(html).toContain("<time");
  });
});
