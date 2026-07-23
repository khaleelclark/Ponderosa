import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMessageFrame } from "../src/components/chat/ChatMessageFrame";
import { Composer } from "../src/components/chat/Composer";

const agentDetail = readFileSync(new URL("../src/components/AgentDetail.tsx", import.meta.url), "utf8");
const conversation = readFileSync(new URL("../src/components/ConversationView.tsx", import.meta.url), "utf8");
const runtimeSelector = readFileSync(new URL("../src/components/ComposerRuntimeSelector.tsx", import.meta.url), "utf8");

describe("composer surface ownership", () => {
  it("keeps the full shared composer in direct Agent chat with an explicit running-agent queue", () => {
    expect(agentDetail).toContain("controls={agentRuntimeControls}");
    expect(agentDetail).toContain('onQueue={runtimeActivity ? submitAgentMessage("queue") : undefined}');
    expect(agentDetail).toContain('preferQueue={(queuedMessagesQuery.data?.length ?? 0) > 0}');
    expect(agentDetail).toContain("agentResponding={Boolean(runtimeActivity)}");
    expect(agentDetail).toContain('{tab === "chat" ? <Box');
  });

  it("keeps Team chat read-only", () => {
    expect(conversation).toContain("Team chat is a read-only audit trail of agent-to-agent coordination.");
    expect(conversation).not.toContain("TeamCollaborationComposer");
    expect(conversation).not.toContain("api.sendCollaborationMessage");
  });

  it("keeps managed-agent lineage visible beside the agent title", () => {
    expect(agentDetail).toContain('const lineageAgent = spawningAgent ?? organizationalParent;');
    expect(agentDetail).toContain('const lineageLabel = detail.agent.spawnedByAgentId ? "Created by" : "Delegated under";');
    expect(agentDetail).toContain('{lineageAgentId ? <Typography variant="caption"');
  });

  it("floats the shared composer above the viewport edge", () => {
    const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>
      <Composer disabled={false} running={false} onSend={() => undefined} />
    </QueryClientProvider>);
    expect(html).toContain("width:calc(100% - 16px)");
    expect(html).toContain("max-width:100%");
    expect(html).not.toContain("position:sticky");
  });

  it("uses one Codex-style runtime control without a speed setting", () => {
    expect(conversation).toContain("<ComposerRuntimeSelector");
    expect(agentDetail).toContain("<ComposerRuntimeSelector");
    expect(runtimeSelector).toContain('type RuntimeSection = "engine" | "model" | "effort"');
    expect(runtimeSelector).toContain('placement="top-end"');
    expect(runtimeSelector).not.toContain('label: "Speed"');
  });

  it("keeps the active-turn actions explicit and presents chat as an open transcript", () => {
    const html = renderToStaticMarkup(<ChatMessageFrame message={{
      id: "message-1",
      author: { kind: "operator" },
      createdAt: "2026-07-23T10:00:00.000Z",
      body: <p>Open transcript message</p>,
      actions: <button type="button">Copy</button>,
    }} />);
    expect(html).toContain('class="chat-message');
    expect(html).toContain('data-message-bubble="true"');
    expect(html).toContain("Open transcript message");
    expect(html).toContain(">Copy</button>");
    expect(html).toContain("max-width:94%");
    expect(html).toContain("max-width:min(78%, 780px)");
  });

  it("keeps an existing queue sticky without blocking concurrent Project chat work", () => {
    expect(conversation).toContain("allowSendWhileRunning");
    expect(conversation).toContain("queuedMentionHandles={(queuedMessagesQuery.data ?? []).flatMap");
    expect(conversation).toContain("disabled={busy}");
  });
});
