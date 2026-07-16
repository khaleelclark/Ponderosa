import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConversationMessageDto } from "@ponderosa/core";
import { useState } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ConversationMessage, TeamCollaborationComposer } from "../src/components/ConversationView";

describe("Team Collaboration composer", () => {
  it("renders in Team chat and sends an attachment-only message into its projected timeline", async () => {
    const sent = vi.fn();
    function TeamHarness(): JSX.Element {
      const [messages, setMessages] = useState<ConversationMessageDto[]>([]);
      return <>
        {messages.map((message) => <ConversationMessage
          key={message.id}
          message={message}
          conversation="collaboration"
          agentTitle={() => "Recipient"}
          agentIdForHandle={() => "recipient"}
          onOpenAgent={vi.fn()}
          onReply={vi.fn()}
          onDirectReply={vi.fn()}
          onReact={vi.fn()}
        />)}
        <TeamCollaborationComposer
          conversationId="team-conversation"
          projectId="project"
          mentionHandles={[]}
          disabled={false}
          replyTo={{
            id: "recipient-message", communicationEventId: "recipient-message", conversationId: "team-conversation",
            role: "assistant", authorAgentId: "recipient", text: "Send the brief here",
            createdAt: "2026-07-16T00:00:00.000Z",
          }}
          onCancelReply={vi.fn()}
          onSend={(text, files) => {
            sent(text, files);
            setMessages([{
              id: "communication", communicationEventId: "communication", conversationId: "team-conversation",
              role: "user", text: "#Recipient", createdAt: "2026-07-16T00:02:00.000Z",
              attachments: [{
                id: "recipient-copy", agentId: "recipient", name: files[0]!.name,
                mediaType: files[0]!.type, size: files[0]!.size,
                url: "/api/assets/recipient-copy", state: "associated", createdAt: "2026-07-16T00:01:00.000Z",
              }],
            }]);
          }}
        />
      </>;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let view!: ReturnType<typeof create>;
    await act(async () => {
      view = create(<QueryClientProvider client={client}><TeamHarness /></QueryClientProvider>);
    });

    expect(view.root.find((node) => node.type === "textarea" &&
      node.props.placeholder?.includes("attachments can be sent without message text"))).toBeTruthy();
    const file = new File(["%PDF-1.7\nbrief"], "brief.pdf", { type: "application/pdf" });
    await act(async () => {
      view.root.find((node) => node.type === "input" && node.props.type === "file")
        .props.onChange({ target: { files: [file], value: "brief.pdf" } });
    });
    await act(async () => {
      view.root.find((node) => node.type === "button" && node.props["aria-label"] === "Send message").props.onClick();
      await Promise.resolve();
    });

    expect(sent).toHaveBeenCalledWith("", [file]);
    expect(view.root.findAll((node) => node.children.includes("brief.pdf"))).not.toHaveLength(0);
    view.unmount();
    client.clear();
  });
});
