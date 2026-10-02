import { Box, CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { DEFAULT_ASSET_LIMITS, type ConversationDecisionEventDto } from "@ponderosa/core";
import { MainConversationTimeline } from "@decision-timeline";
import { ChatPane } from "../src/components/chat/ChatPane";
import { AllChatView } from "../src/components/AllChatView";
import { MutationNotificationProvider } from "../src/components/MutationNotifications";
import { api } from "../src/api";
import { createPonderosaTheme } from "../src/theme";
import "../src/global.css";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "text";
const decision = { id: `question-${scenario}`, projectId: "project", conversationId: "chat", agentId: "boston-id", runId: "run",
  mode: "text" as const, question: "How should I build it?", options: [], allowOther: true, blocking: true,
  status: "resolved" as const, response: { text: "Do it all from scratch yourself", respondedAt: "2026-10-01T12:01:00Z" },
  createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:01:00Z" };
const event: ConversationDecisionEventDto = { kind: "decision_response", id: `decision-response:${decision.id}`, createdAt: decision.response.respondedAt,
  decision, recipientAgent: { id: "boston-id", title: "Boston", handle: "Boston" } };
if (scenario === "choice" || scenario === "approval") event.decision = { ...decision, mode: scenario,
  options: [{ id: "yes", label: "Continue" }], response: { optionId: "yes", respondedAt: event.createdAt } };
if (scenario === "deleted") event.recipientAgent = null;
if (scenario === "historical") delete event.recipientAgent;
if (scenario === "mismatched") event.recipientAgent = { id: "wrong-id", title: "Wrong", handle: "Wrong" };
if (scenario === "renamed") event.recipientAgent = { id: "boston-id", title: "Renamed", handle: "Boston-Renamed" };
if (scenario === "automatic") event.decision = { ...decision, response: { optionId: "auto_allowed", text: "Automatically allowed by your saved permission", respondedAt: event.createdAt } };
document.body.dataset.canonical = JSON.stringify(event.decision);
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
api.getAllChat = async () => ({ items: [], decisions: [{ ...event, project: { id: "project", label: "Project" },
  source: { kind: "project", conversationId: "chat", title: "Chat" } }], history: { limit: 50, hasMore: false } });
api.listProjects = async () => [{ id: "project", label: "Project", hostPath: "/disposable", defaultEngine: "codex" }] as never;
api.listEngines = async () => [];
api.getWorkspacePreferences = async () => ({}) as never;
api.getAssetLimits = async () => DEFAULT_ASSET_LIMITS;
api.getWorkspaceDirectory = async () => ({ items: [], starredItems: [], total: 0, history: { limit: 100, hasMore: false } }) as never;
api.respondDecision = async () => { throw new Error("Viewing a question must not respond again"); };
const onOpenAgent = (id: string) => { document.body.dataset.openAgent = id; };
const surface = params.get("surface") ?? "project";
createRoot(document.getElementById("root")!).render(<ThemeProvider theme={createPonderosaTheme("dark")}><CssBaseline />
  <QueryClientProvider client={client}><MutationNotificationProvider><Box sx={{ p: 1, height: "100dvh", display: "flex", flexDirection: "column" }}>
  {surface === "all" ? <AllChatView onNavigate={route => { if (route.kind === "agent") onOpenAgent(route.agentId); }} />
    : surface === "agent" ? <ChatPane messages={[]} decisionEvents={[event]} agentName="Boston" onOpenAgent={onOpenAgent} />
    : <MainConversationTimeline
    mainTimeline={[{ kind: "decision-response", id: event.id, at: event.createdAt, event, choice: decision.response.text }]}
    projectId="project" healthByAgentId={new Map()} agentTitle={() => "Boston"} agentIdForHandle={() => "boston-id"}
    onOpenAgent={onOpenAgent} mentionAgent={() => {}}
    markCommunicationVisible={() => {}} notifications={[]} />}
  </Box></MutationNotificationProvider></QueryClientProvider>
</ThemeProvider>);
