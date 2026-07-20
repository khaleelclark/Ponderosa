import type { ConversationMessageDto, MessageDto } from "@ponderosa/core";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
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
    expect(html).toContain('aria-label="User avatar"');
    expect(html).toContain("width:32px");
    expect(html).toContain("height:32px");
    expect(html).toContain("data-message-sender");
    expect(html).not.toContain("aria-hidden");
  });

  it("preserves generated and managed uploaded profile pictures in the reordered identity", () => {
    const generated = renderToStaticMarkup(<UserMessageLabel profile={{ displayName: "User", handle: "operator", avatarId: "fox" }} createdAt={createdAt} />);
    const uploadedId = `uploaded:png:${"a".repeat(64)}`;
    const uploaded = renderToStaticMarkup(<UserMessageLabel profile={{ displayName: "User", handle: "operator", avatarId: uploadedId }} createdAt={createdAt} />);

    expect(generated).toContain("🦊");
    expect(uploaded).toContain(`/api/workspace/profile-images/${encodeURIComponent(uploadedId)}`);
    expect(uploaded.indexOf("data-user-message-timestamp")).toBeLessThan(uploaded.indexOf("data-user-message-avatar"));
  });

  it("reveals a mobile timestamp only beneath the exact tapped message", () => {
    let view!: ReturnType<typeof create>;
    act(() => {
      view = create(<ChatPane messages={[
        agentMessage({ id: "first", text: "First message" }),
        agentMessage({ id: "second", seq: 2, text: "Second message" }),
      ]} />);
    });
    const messages = view.root.findAll((node) => node.props.className === "chat-message");
    const mobileTimestamps = (root: typeof view.root) => root.findAll((node) => node.type === "div" && node.props["data-mobile-message-timestamp"] === true);

    expect(mobileTimestamps(view.root)).toHaveLength(0);
    act(() => messages[0]!.props.onClick());
    const revealed = mobileTimestamps(view.root);
    expect(revealed).toHaveLength(1);
    expect(mobileTimestamps(messages[0]!)).toHaveLength(1);
    expect(mobileTimestamps(messages[1]!)).toHaveLength(0);
    act(() => view.unmount());
  });

  it("places the ChatPane desktop user identity in timestamp-name-avatar order before the bubble", () => {
    const html = renderToStaticMarkup(<ChatPane messages={[agentMessage({
      attachments: [{ id: "attachment-1", agentId: "agent-1", name: "diagram.png", mediaType: "image/png", size: 12, width: 2, height: 2, url: "/attachment.png" }],
    })]} onReply={vi.fn()} />);

    const timestamp = html.indexOf("data-user-message-timestamp");
    const label = html.indexOf("data-user-message-name");
    const avatar = html.indexOf("data-user-message-avatar");
    const bubble = html.indexOf('data-message-bubble="true"');
    const content = html.indexOf("Manager request");
    const attachment = html.indexOf('aria-label="Download diagram.png"');
    const reply = html.indexOf('aria-label="Reply to message"');
    expect(label).toBeGreaterThanOrEqual(0);
    expect(timestamp).toBeLessThan(label);
    expect(label).toBeLessThan(avatar);
    expect(avatar).toBeLessThan(bubble);
    expect(bubble).toBeLessThan(content);
    expect(content).toBeLessThan(attachment);
    expect(attachment).toBeLessThan(reply);
  });

  it("does not label agent messages and filters unsupported system messages from ChatPane", () => {
    const assistant = renderToStaticMarkup(<ChatPane messages={[agentMessage({ role: "assistant", text: "Agent response" })]} />);
    const system = renderToStaticMarkup(<ChatPane messages={[{ ...agentMessage({ text: "System notice" }), role: "system" } as unknown as MessageDto]} />);

    expect(assistant).toContain("Agent response");
    expect(assistant).not.toContain(">User</div>");
    expect(system).not.toContain("System notice");
    expect(system).not.toContain(">User</div>");
  });

  it("shows finalized worked time with the latest completed Agent message as status metadata", () => {
    const html = renderToStaticMarkup(<ChatPane
      agentName="Pinnacles"
      completedWorkDurationLabel="Worked for 23m 15s"
      messages={[
        agentMessage({ id: "answer-1", role: "assistant", text: "First result" }),
        agentMessage({ id: "answer-2", seq: 2, role: "assistant", text: "Completed result" }),
      ]}
    />);

    expect(html.match(/Worked for 23m 15s/g)).toHaveLength(2); // accessible label and visible text
    expect(html).toContain('aria-label="Pinnacles completed work. Worked for 23m 15s total across finalized Runs."');
    expect(html.indexOf("Completed result")).toBeLessThan(html.indexOf("Worked for 23m 15s"));
    expect(html.indexOf("First result")).toBeLessThan(html.indexOf("Completed result"));
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

  it("keeps the master timestamp with its identity while preserving attachment and reply actions", () => {
    const manager = renderMaster(masterMessage({
      attachments: [{ id: "attachment-1", agentId: "agent-1", name: "diagram.png", mediaType: "image/png", size: 12, width: 2, height: 2, url: "/attachment.png" }],
    }));
    const agent = renderMaster(masterMessage({ role: "assistant", authorAgentId: "agent-1", text: "#everyone result" }));

    expect(manager.indexOf("data-user-message-timestamp")).toBeLessThan(manager.indexOf("data-user-message-name"));
    expect(manager.indexOf("data-user-message-name")).toBeLessThan(manager.indexOf("data-user-message-avatar"));
    expect(manager.indexOf("data-user-message-avatar")).toBeLessThan(manager.indexOf('data-message-bubble="true"'));
    expect(manager.indexOf("Manager request")).toBeLessThan(manager.indexOf('aria-label="Download diagram.png"'));
    expect(manager.indexOf('aria-label="Download diagram.png"')).toBeLessThan(manager.indexOf('aria-label="Reply to message"'));
    expect(agent).toContain('data-message-tag="everyone"');
    expect(agent).toContain("#everyone</span> result");
    expect(agent.indexOf('class="chat-message-actions')).toBeLessThan(agent.indexOf('aria-label="Open agent Pinnacles"'));
    expect(agent.indexOf('aria-label="Open agent Pinnacles"')).toBeLessThan(agent.indexOf('aria-label="Reply to message"'));
    expect(agent.indexOf("<time")).toBeLessThan(agent.indexOf('aria-label="Reply to message"'));
    expect(agent.indexOf('aria-label="Reply to message"')).toBeLessThan(agent.indexOf("Reply directly to Pinnacles"));
  });

  it("keeps Team Chat read-only while preserving timestamps", () => {
    const html = renderMaster(masterMessage({ role: "assistant", authorAgentId: "agent-1", text: "Collaboration update" }), "collaboration");

    expect(html).not.toContain('aria-label="Reply to message"');
    expect(html).not.toContain("Reply directly to Pinnacles");
    expect(html).toContain("<time");
  });

  it("renders attachment-only Broadcasts and the latest passive edit affordance", () => {
    const attachmentOnly = renderMaster(masterMessage({
      text: "",
      attachments: [{ id: "attachment-1", agentId: "agent-1", name: "brief.pdf", mediaType: "application/pdf", size: 42, url: "/brief.pdf" }],
    }));
    const edited = renderToStaticMarkup(
      <ConversationMessage
        message={masterMessage({
          text: "#broadcast Edited context",
          editedAt: "2026-07-12T12:35:56.000Z",
          editRevision: 1,
        })}
        conversation="main"
        agentTitle={() => "Pinnacles"}
        agentIdForHandle={() => undefined}
        onOpenAgent={vi.fn()}
        onReply={vi.fn()}
        onDirectReply={vi.fn()}
        onReact={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    expect(attachmentOnly).toContain("brief.pdf");
    expect(attachmentOnly).toContain('aria-label="Download brief.pdf"');
    expect(edited).toContain("Edited context");
    expect(edited).toContain(">Edited</span>");
    expect(edited).toContain('aria-label="Edit latest message"');
  });
});
