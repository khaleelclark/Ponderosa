import { Box, Button, CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { DEFAULT_ASSET_LIMITS, type ConversationMessageDto, type MessageDto, type EngineDto } from "@ponderosa/core";
import { api } from "../src/api";
import { ApiRequestError } from "../src/api/types";
import { Composer } from "../src/components/chat/Composer";
import { ChatSurface } from "../src/components/chat/ChatSurface";
import { ChatMessageFrame } from "../src/components/chat/ChatMessageFrame";
import { OutgoingMessageProvider } from "../src/components/chat/OutgoingMessage";
import { MessageDeliveryStatus } from "../src/components/MessageDeliveryStatus";
import { ConversationView } from "../src/components/ConversationView";
import { useAgentMessageController } from "../src/components/useAgentMessageController";
import { ChatPane } from "../src/components/chat/ChatPane";
import { queryKeys } from "../src/queryKeys";
import { MobileNavigationProvider } from "../src/components/MobileNavigationContext";
import { MutationNotificationProvider } from "../src/components/MutationNotifications";
import { PrimaryHeaderActionsProvider } from "../src/components/PrimaryHeaderActions";
import { createPonderosaTheme } from "../src/theme";
import "../src/global.css";

const noop = () => {};
const params = new URLSearchParams(location.search);
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
let releaseDraft: (() => void) | undefined, releaseSend: (() => void) | undefined;
let holdDraft = true;
let fail = false;
const keys: string[] = [];
let revision = 0;
const project = { id: "project", label: "Fixture", hostPath: "/fixture", defaultEngine: "codex" };
const engine = { id: "codex", displayName: "Codex", configured: true, authentication: "authenticated",
  intakeReady: true, reachability: "reachable", models: [], efforts: [],
  servingBuildRevision: "fixture", servingInstanceId: "fixture" } as EngineDto;
const conversation = { id: "chat", projectId: "project", title: "Fixture Chat", archived: false,
  createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-01T10:00:00Z" };
let createdAgent: any;
let createdMessages: ConversationMessageDto[] = [];
let directMessages: MessageDto[] = [];
api.getAssetLimits = async () => DEFAULT_ASSET_LIMITS;
api.getConversationDraft = async (id, ownerId) => ({ conversationId: id, ownerId,
  text: "", attachmentIds: [], attachments: [], revision: 0 }) as never;
api.putConversationDraft = async (id, request) => {
  if (request.pendingSubmission && holdDraft) {
    document.body.dataset.journal = "waiting";
    await new Promise<void>(resolve => { releaseDraft = resolve; });
  }
  return { conversationId: id, ...request, attachments: [], revision: ++revision } as never;
};
api.uploadDraftAttachment = async (_id, _owner, file) => ({ id: "attachment", name: file.name,
  mediaType: file.type, size: file.size }) as never;
api.deleteDraftAttachment = async () => undefined;
api.listProjects = async () => [project] as never;
// Deliberately stale Project roster: detail must still identify the new Agent.
api.listAgents = async () => [];
api.getConversation = async () => ({ conversation, agents: createdAgent ? [createdAgent] : [],
  messages: createdMessages, history: { limit: 100, hasMore: false } }) as never;
api.listQueuedConversationMessages = async () => [];
api.listQueuedAgentMessages = async () => [];
api.getAgent = async () => ({ agent: { id: "agent", title: "Grand Canyon", projectId: "project" }, messages: directMessages }) as never;
api.sendMessage = async (_agent, request) => {
  document.body.dataset.sendCalls = String(Number(document.body.dataset.sendCalls ?? 0) + 1);
  keys.push(request.idempotencyKey!);
  document.body.dataset.keys = JSON.stringify(keys);
  await new Promise<void>(resolve => { releaseSend = resolve; });
  if (fail) throw new ApiRequestError(400, "Test rejection.");
  directMessages = [...directMessages, { id: "canonical-direct", agentId: "agent", seq: 1, role: "user",
    text: request.text, createdAt: new Date().toISOString(), communicationEventId: "direct-event",
    deliveryReceipts: [{ activationId: "activation", targetAgentId: "agent", state: "queued",
      updatedAt: new Date().toISOString(), attemptCount: 1 }] }];
  return { queued: true, position: 1, deliveryId: "delivery", communicationEventId: "direct-event" };
};
api.getProviderUsage = async () => ({ providers: [] }) as never;
api.listNotifications = async () => ({ items: [], history: { hasMore: false } }) as never;
api.getWorkspacePreferences = async () => ({ defaultEngine: "codex" }) as never;
api.listActiveBrowserSessions = async () => [];
api.getTargetedNextRunReceipts = async () => ({ receipts: [] }) as never;
api.listConversationMembersPage = async () => ({ items: [], total: 0, limit: 100, hasMore: false });
api.createAgent = async (_project, _chat, options) => {
  document.body.dataset.sendCalls = String(Number(document.body.dataset.sendCalls ?? 0) + 1);
  await new Promise<void>(resolve => { releaseSend = resolve; });
  createdAgent = { id: "new-agent", projectId: "project", conversationId: "chat", title: options.title,
    handle: options.title.replaceAll(" ", "-"), engine: "codex", archived: false, status: "idle" };
  createdMessages = [{ id: "canonical-created-message", conversationId: "chat", role: "user",
    text: `#${createdAgent.handle} ${options.initialMessage}`, createdAt: new Date().toISOString(),
    agentMentions: [{ projectId: "project", agentId: createdAgent.id, handle: createdAgent.handle,
      currentHandle: createdAgent.handle, currentTitle: createdAgent.title }],
    deliveryReceipts: [{ activationId: "activation", targetAgentId: createdAgent.id, state: "queued",
      updatedAt: new Date().toISOString(), attemptCount: 1 }] }];
  return createdAgent;
};

function Probe() {
  const [scope, setScope] = useState("chat");
  const [messages, setMessages] = useState<ConversationMessageDto[]>([]);
  const controls = <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
    <Button onClick={() => { holdDraft = false; releaseDraft?.(); }}>Release journal</Button>
    <Button onClick={() => releaseSend?.()}>Release send</Button>
    <Button onClick={() => { fail = true; releaseSend?.(); }}>Reject send</Button>
    <Button onClick={() => setScope("other-chat")}>Switch Chat</Button>
    <Button onClick={() => {
      directMessages = [...directMessages, { id: "incoming-during-send", agentId: "agent", seq: 1,
        role: "assistant", text: "Unrelated incoming reply", createdAt: new Date().toISOString() }];
      client.setQueryData(queryKeys.agents.detail("agent"), { agent: { id: "agent", title: "Grand Canyon" }, messages: directMessages });
    }}>Publish incoming</Button>
    <Button onClick={() => setMessages(current => current.map(message => ({ ...message,
      deliveryReceipts: message.deliveryReceipts?.map(receipt => ({ ...receipt, state: "delivered", providerAcknowledged: true })) })))}>Confirm delivery</Button>
  </Box>;
  if (params.get("case")?.startsWith("direct")) return <DirectAgentProbe controls={controls} />;
  if (params.get("case") === "creation") return <Box sx={{ height: "100dvh", display: "grid", gridTemplateRows: "auto minmax(0,1fr)" }}>
    {controls}<ConversationView conversationId="chat" engines={[engine]}
      engineCapabilities={[]} onRefreshCapabilities={noop} statusByAgentId={new Map()} healthByAgentId={new Map()} projectAgents={[]}
      onOpenProject={noop} onOpenProjectBrowser={noop} onOpenAgent={noop} onAgentsDeleted={noop} onOpenAgentWork={noop}
      onOpenBrowser={noop} onNewAgent={noop} preferences={{} as never} onPreferences={noop} onNavigateTrigger={noop} onCreateTrigger={noop} onDeleted={noop} />
  </Box>;
  return <OutgoingMessageProvider scope={scope}><Box sx={{ height: "100dvh", display: "grid", gridTemplateRows: "auto minmax(0,1fr) auto" }}>
    {controls}<ChatSurface layout="project" layoutKey={messages.map(m => m.id).join(":")} showOutgoingMessage follow={{ kind: "latest" }}>
      {messages.filter(message => message.conversationId === scope).map(message => <ChatMessageFrame key={message.id} message={{
        id: message.id, author: { kind: "operator" }, createdAt: message.createdAt, body: message.text,
        status: <MessageDeliveryStatus receipts={message.deliveryReceipts} recipientName={() => "Grand Canyon"} /> }} />)}
    </ChatSurface>
    <Composer disabled={false} running={false} placeholder="Write a test message" destinationMode="fixed" projectId="project"
      conversationDraftId={scope} draftStorageKey={`fixture:${scope}`} onSend={async (text, _files, _ids, _owner, context) => {
        document.body.dataset.sendCalls = String(Number(document.body.dataset.sendCalls ?? 0) + 1);
        keys.push(context!.pendingSubmission!.idempotencyKey);
        document.body.dataset.keys = JSON.stringify(keys);
        await new Promise<void>(resolve => { releaseSend = resolve; });
        if (fail) throw new ApiRequestError(400, "Test rejection.");
        setMessages(current => [...current, { id: `canonical-${keys.length}`, conversationId: scope,
          role: "user", text, createdAt: new Date().toISOString(), deliveryReceipts: [{ activationId: "activation",
            targetAgentId: "agent", state: "queued", updatedAt: new Date().toISOString(), attemptCount: 1 }] }]);
      }} />
  </Box></OutgoingMessageProvider>;
}
function DirectAgentProbe({ controls }: { controls: React.ReactNode }) {
  const detail = useQuery({ queryKey: queryKeys.agents.detail("agent"), queryFn: () => api.getAgent("agent") });
  const controller = useAgentMessageController({ agentId: "agent", projectId: "project", engine,
    model: "", effort: "", speed: "", onNotice: noop, onChatSelected: noop });
  return <OutgoingMessageProvider scope="agent"><Box sx={{ height: "100dvh", display: "grid", gridTemplateRows: "auto minmax(0,1fr) auto" }}>
    {controls}<ChatPane messages={detail.data?.messages ?? []} agentName="Grand Canyon" />
    <Composer disabled={false} running={false} projectId="project" conversationDraftId="agent:agent"
      draftStorageKey="fixture:agent" destinationMode="fixed" placeholder="Write a test message"
      onSend={controller.submitAgentMessage("steer")} onQueue={controller.submitAgentMessage("queue")} />
  </Box></OutgoingMessageProvider>;
}
createRoot(document.getElementById("root")!).render(<ThemeProvider theme={createPonderosaTheme("dark")}><CssBaseline />
  <QueryClientProvider client={client}><MutationNotificationProvider><MobileNavigationProvider onOpen={noop}>
    <PrimaryHeaderActionsProvider onOpenProviderSettings={noop}><Probe /></PrimaryHeaderActionsProvider>
  </MobileNavigationProvider></MutationNotificationProvider></QueryClientProvider>
</ThemeProvider>);
