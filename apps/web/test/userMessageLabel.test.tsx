import type { ConversationMessageDto, MessageDto } from "@ponderosa/core";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ConversationMessage } from "../src/components/ConversationView";
import { ChatPane } from "../src/components/panes";

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
      onMentionAgent={vi.fn()}
      projectId="project-1"
    />,
  );
}

describe("user message labels on chat surfaces", () => {
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
    })]} />);

    const timestamp = html.indexOf("data-user-message-timestamp");
    const label = html.indexOf("data-user-message-name");
    const avatar = html.indexOf("data-user-message-avatar");
    const bubble = html.indexOf('data-message-bubble="true"');
    const content = html.indexOf("Manager request");
    const attachment = html.indexOf('aria-label="Download diagram.png"');
    expect(label).toBeGreaterThanOrEqual(0);
    expect(timestamp).toBeLessThan(label);
    expect(label).toBeLessThan(avatar);
    expect(avatar).toBeLessThan(bubble);
    expect(bubble).toBeLessThan(content);
    expect(content).toBeLessThan(attachment);
    expect(attachment).toBeGreaterThan(content);
    expect(html).not.toContain('aria-label="Reply to message"');
  });

  it("does not label agent messages and filters unsupported system messages from ChatPane", () => {
    const assistant = renderToStaticMarkup(<ChatPane messages={[agentMessage({ role: "assistant", text: "Agent response" })]} />);
    const system = renderToStaticMarkup(<ChatPane messages={[{ ...agentMessage({ text: "System notice" }), role: "system" } as unknown as MessageDto]} />);

    expect(assistant).toContain("Agent response");
    expect(assistant).not.toContain(">User</div>");
    expect(system).not.toContain("System notice");
    expect(system).not.toContain(">User</div>");
  });

  it("shows the exact finalized Run duration immediately beneath every Agent message", () => {
    const html = renderToStaticMarkup(<ChatPane
      agentName="Pinnacles"
      completedWorkDurationLabel={(message) => message.executionId === "run-1" ? "Worked for 1m" : message.executionId === "run-2" ? "Worked for 23m 15s" : undefined}
      messages={[
        agentMessage({ id: "answer-1", role: "assistant", text: "First result", executionId: "run-1" }),
        agentMessage({ id: "answer-2", seq: 2, role: "assistant", text: "Completed result", executionId: "run-2" }),
      ]}
    />);

    expect(html.match(/Worked for 23m 15s/g)).toHaveLength(2); // accessible label and visible text
    expect(html.match(/Worked for 1m/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Pinnacles completed work. Worked for 23m 15s."');
    expect(html.indexOf("First result")).toBeLessThan(html.indexOf("Worked for 1m"));
    expect(html.indexOf("Completed result")).toBeLessThan(html.indexOf("Worked for 23m 15s"));
    expect(html.indexOf("Worked for 1m")).toBeLessThan(html.indexOf("Completed result"));
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

  it("keeps the master timestamp with its identity while preserving attachment and Agent tag actions", () => {
    const manager = renderMaster(masterMessage({
      attachments: [{ id: "attachment-1", agentId: "agent-1", name: "diagram.png", mediaType: "image/png", size: 12, width: 2, height: 2, url: "/attachment.png" }],
    }));
    const agent = renderMaster(masterMessage({ role: "assistant", authorAgentId: "agent-1", text: "#everyone result" }));

    expect(manager.indexOf("data-user-message-timestamp")).toBeLessThan(manager.indexOf("data-user-message-name"));
    expect(manager.indexOf("data-user-message-name")).toBeLessThan(manager.indexOf("data-user-message-avatar"));
    expect(manager.indexOf("data-user-message-avatar")).toBeLessThan(manager.indexOf('data-message-bubble="true"'));
    expect(manager.indexOf("Manager request")).toBeLessThan(manager.indexOf('aria-label="Download diagram.png"'));
    expect(manager).not.toContain('aria-label="Reply to message"');
    expect(agent).toContain('data-message-tag="everyone"');
    expect(agent).toContain("#everyone</span> result");
    expect(agent).toContain('aria-label="Open agent Pinnacles from profile image"');
    expect(agent).toContain('aria-label="Open agent Pinnacles from name"');
    expect(agent).toContain('aria-label="Mention Pinnacles"');
    expect(agent).not.toContain('aria-label="Reply to message"');
    expect(agent).not.toContain("Reply directly to Pinnacles");
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
        projectId="project-1"
        onEdit={vi.fn()}
      />,
    );
    expect(attachmentOnly).toContain("brief.pdf");
    expect(attachmentOnly).toContain('aria-label="Download brief.pdf"');
    expect(edited).toContain("Edited context");
    expect(edited).toContain(">Edited</span>");
    expect(edited).toContain('aria-label="Edit message"');
  });
});
