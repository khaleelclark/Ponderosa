import { Box, CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { DEFAULT_ASSET_LIMITS, type ConversationMessageDto, type AllChatItemDto, type MessageDeliveryReceiptDto } from "@ponderosa/core";
import { MainConversationTimeline } from "../src/components/ConversationView.parts";
import { ChatPane } from "../src/components/chat/ChatPane";
import { AllChatView } from "../src/components/AllChatView";
import { MutationNotificationProvider } from "../src/components/MutationNotifications";
import { api } from "../src/api";
import { queryKeys } from "../src/queryKeys";
import { createPonderosaTheme } from "../src/theme";
import "../src/global.css";

const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
const user: ConversationMessageDto = { id: "human", communicationEventId: "human", conversationId: "chat",
  role: "user", text: "Use the revised plan", createdAt: "2026-10-01T12:00:00Z", communicationIntent: "user_dm" };
const answer: ConversationMessageDto = { id: "answer", communicationEventId: "answer", conversationId: "chat",
  role: "assistant", authorAgentId: "boston", executionId: "run", text: "Here is the finished response",
  createdAt: "2026-10-01T12:05:00Z", communicationIntent: "user_dm" };
const asAll = (m: ConversationMessageDto): AllChatItemDto => ({ communicationEventId: m.id, messageId: m.id,
  directMessageAgents: [{ id: "boston", title: "Boston", handle: "Boston" }],
  directMessageAgent: { id: "boston", title: "Boston", handle: "Boston" },
  communicationIntent: "user_dm", source: { kind: "project", conversationId: "chat", title: "Chat" },
  author: m.role === "user" ? { kind: "user", label: "You" } : { kind: "agent", label: "Boston", agentId: "boston" },
  project: { id: "project", label: "Project" }, text: m.text, createdAt: m.createdAt, deliveryReceipts: m.deliveryReceipts });
let current = [user];
api.getAllChat = async () => ({ items: current.map(asAll), history: { limit: 50, hasMore: false } });
api.listProjects = async () => [{ id: "project", label: "Project", hostPath: "/disposable", defaultEngine: "codex" }] as never;
api.listEngines = async () => [];
api.getWorkspacePreferences = async () => ({ profile: { displayName: "You", handle: "operator" } }) as never;
api.getAssetLimits = async () => DEFAULT_ASSET_LIMITS;
api.getWorkspaceDirectory = async () => ({ items: [], starredItems: [], total: 0, history: { limit: 100, hasMore: false } }) as never;
const onOpenAgent = (id: string) => { document.body.dataset.openAgent = id; };
function Fixture() {
  const [messages, setMessages] = useState<ConversationMessageDto[]>([user]);
  (window as unknown as { showProgress(mode: string): void }).showProgress = mode => {
    const receipt: MessageDeliveryReceiptDto = { activationId: "activation", targetAgentId: "boston",
      injectionId: "steer", injectionKind: "steer", executionId: "run", attemptCount: 1,
      updatedAt: "2026-10-01T12:01:00Z", state: mode === "pending" ? "steering" : mode === "failed" ? "failed" : "delivered" };
    if (mode !== "pending") receipt.providerAcknowledged = true;
    if (["first", "latest", "literal", "long", "wrapped"].includes(mode)) receipt.liveProgress = {
      text: mode === "first" ? "I am adjusting the approach" : mode === "literal" ? '<img src=x onerror="alert(1)"> **literal**' :
        mode === "long" ? "long-unbroken-update".repeat(50) : mode === "wrapped"
          ? "I AM UPDATING THE IMPLEMENTATION TO FOLLOW YOUR REVISED INSTRUCTIONS AND CHECKING THE REMAINING DETAILS CAREFULLY. THE NEXT STEP IS TO VERIFY THE CHANGES BEFORE SHARING THE FINISHED RESULT WITH YOU NOW."
          : "The revised approach is now underway",
      recipientHandle: "Boston", seq: mode === "first" ? 1 : 2, createdAt: "2026-10-01T12:02:00Z" };
    current = [{ ...user, deliveryReceipts: [receipt, ...(mode === "mixed" ? [{
      ...receipt, activationId: "other", targetAgentId: "other-agent", injectionKind: "turn" as const,
      state: "failed" as const, providerAcknowledged: undefined, canRetry: true as const,
    }] : [])] }, ...(mode === "reply" ? [answer] : [])];
    client.setQueriesData({ queryKey: queryKeys.allChatAll }, { items: current.map(asAll), history: { limit: 50, hasMore: false } });
    setMessages(current);
  };
  const surface = new URLSearchParams(location.search).get("surface") ?? "project";
  return surface === "all" ? <AllChatView onNavigate={route => { if (route.kind === "agent") onOpenAgent(route.agentId); }} />
    : surface === "agent" ? <ChatPane messages={messages.map((m, seq) => ({ ...m, agentId: "boston", seq, role: m.role as "user" | "assistant" }))}
        agentName="Boston" onOpenAgent={onOpenAgent} />
    : <MainConversationTimeline mainTimeline={messages.map(message => ({ kind: "message", id: message.id, at: message.createdAt, message }))}
        projectId="project" healthByAgentId={new Map()} agentTitle={() => "Boston"} agentIdForHandle={() => "boston"}
        onOpenAgent={onOpenAgent} mentionAgent={() => {}} markCommunicationVisible={() => {}} notifications={[]} />;
}
createRoot(document.getElementById("root")!).render(<ThemeProvider theme={createPonderosaTheme("dark")}><CssBaseline />
  <QueryClientProvider client={client}><MutationNotificationProvider>
    <Box sx={{ p: 1, height: "100dvh", display: "flex", flexDirection: "column" }}><Fixture /></Box>
  </MutationNotificationProvider></QueryClientProvider>
</ThemeProvider>);
