import { createRoot } from "react-dom/client";
import { Box, CssBaseline, ThemeProvider, Typography } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createPonderosaTheme } from "../src/theme";
import { api } from "../src/api";
import { ContextualCreateDialog } from "../src/components/CreateWorkspace";
import { MutationNotificationProvider } from "../src/components/MutationNotifications";
import { FilePreview } from "../src/components/filePreview/FilePreview";
import { ChatMessageFrame } from "../src/components/chat/ChatMessageFrame";
import { MessageDeliveryStatus } from "../src/components/MessageDeliveryStatus";
import { MainConversationTimeline } from "../src/components/ConversationView.parts";
import { WorkspaceReviewPane } from "../src/components/files/WorkspaceReviewPane";
import { BrowserWorkspaceHost } from "../src/components/browser/BrowserWorkspaceHost";
import { WorkspaceSidebar } from "../src/components/WorkspaceSidebar";
import type { Route } from "../src/routing";

const project = { id: "project", label: "Project", hostPath: "/test", defaultEngine: "codex" } as never;
const engine = { id: "codex", displayName: "Codex", authentication: "authenticated", intakeReady: true,
  models: [{ id: "test", label: "Test" }], efforts: [{ id: "high", label: "High" }] } as never;
api.listConversations = async projectId => {
  document.body.dataset.chatQueries = String(Number(document.body.dataset.chatQueries ?? 0) + 1);
  return [{ id: "chat", title: new URLSearchParams(location.search).get("case") === "browser-picker" ? "New Chat" : "Destination Chat", projectId }] as never;
};
api.listAgents = async () => new URLSearchParams(location.search).get("case") === "automation"
  ? [{ id: "agent", title: "Automation Agent", handle: "automation-agent", engine: "codex", updatedAt: "2026-09-30T12:00:00Z", projectId: "project", conversationId: "chat" }] as never : [];
api.listTriggersPage = async () => ({ items: [], hasMore: false });
api.getEngineModels = async () => ({ models: [], efforts: [] }) as never;
api.getWorkspacePreferences = async () => ({}) as never;
api.startAgentPackageImport = async () => {
  document.body.dataset.accepted = "yes";
  if (new URLSearchParams(location.search).has("fail")) throw Error("Fixture import failed. Your package was not submitted.");
  return { id: "operation", status: "pending" } as never;
};
function ImportFixture() {
  const [open, setOpen] = useState(true);
  return <><button onClick={() => setOpen(true)}>Reopen creation</button><ContextualCreateDialog
    request={open ? { resource: new URLSearchParams(location.search).get("case") === "automation" ? "trigger" : "agent", projectId: "project", conversationId: "chat" } : undefined}
    projects={[project]} engines={[engine]} preferences={{} as never}
    onClose={() => { document.body.dataset.closed = "yes"; setOpen(false); }} onNavigate={() => {}} /></>;
}
const longName = "A very long Agent name that must never push the delivery controls outside the message";
const receipts = ["unconfirmed", "cancelled"].map((state, i) => ({ activationId: `activation-${i}`, targetAgentId: `agent-${i}`,
  state, providerAcknowledged: i === 0, runStopState: "stopped", canRetry: true, retryMayDuplicate: i === 0 }));
function ReceiptFixture() {
  return <Box sx={{ p: 2, maxWidth: 960, mx: "auto" }}><ChatMessageFrame message={{ id: "message", author: { kind: "operator" },
    createdAt: "2026-09-30T12:00:00Z", body: <Typography>Short message</Typography>,
    actions: <button>Copy</button>, status: <MessageDeliveryStatus projectId="project" receipts={receipts as never} recipientName={() => longName} /> } as never} /></Box>;
}
const files = Array.from({ length: 75 }, (_, i) => ({ path: `src/${"long-directory-".repeat(5)}/file-${i}.ts`, kind: "edit", lastSeq: i,
  diffAvailable: true, executionIds: ["response-run"], diff: `--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new-${i}\n` }));
api.getResponseFileReview = async () => ({ executionId: "response-run", files, truncated: false }) as never;
api.getWorkspaceStatus = async () => ({ isGitRepository: false, workingCopy: { mode: "shared", rootPath: "/test" }, changes: [] }) as never;
const params = new URLSearchParams(location.search);
const mode = params.get("case");
api.getProjectBrowser = async () => ({ id: "closed", status: "closed", pages: [], controlEpoch: 0, controlOwner: "operator" }) as never;
api.getSavedBrowser = async () => ({}) as never;
api.getChatBrowserPreferences = async () => ({ rememberSignIns: false }) as never;
api.listBrowserProfiles = async () => [];
const browserProjects = Array.from({ length: 11 }, (_, i) => ({ id: `${String(i + 1).padStart(8, "0")}-project`, label: "New Chat", hostPath: `/test/workspace-${i}`, defaultEngine: "codex" }));
const sidebarAgent = { id: "agent", title: "Agent", handle: "unique-agent", projectId: "project", conversationId: "chat", activeEngine: "codex" };
api.getWorkspaceDirectory = (async (kind, options) => {
  const items = kind === "project" ? [{ kind, project, displayPath: "/test" }]
    : kind === "conversation" ? [{ kind, project, conversation: { id: "chat", projectId: "project", title: "Chat" } }]
    : kind === "agent" ? [{ kind, project, agent: sidebarAgent, ownerConversation: { id: "chat", title: "Chat" }, health: { status: "idle" } }]
    : [{ kind, project, targetAgent: sidebarAgent, trigger: { id: "trigger", name: "Daily", enabled: true } }];
  return { kind, items: options.summary ? [] : items, starredItems: [], total: items.length, runningCount: 0, history: { hasMore: false } };
}) as typeof api.getWorkspaceDirectory;
api.getNotificationProjection = (async () => ({ workspace: {}, allMessages: { importantCount: 0, ordinaryCount: 0, totalCount: 0 }, projects: {}, conversations: {} })) as typeof api.getNotificationProjection;
api.markWorkspaceResourceUsed = (async () => ({})) as typeof api.markWorkspaceResourceUsed;
function SidebarFixture() {
  const [route, setRoute] = useState<Route>({ kind: "home" });
  const preferences = { revision: 1, profile: { displayName: "Tester", handle: "tester", avatarId: "default-user" }, starredProjectIds: [], projectOrder: [], chatOrder: [], agentOrder: [], triggerOrder: [], starredResourceIds: [], chatFolders: [], projectFolders: [] } as never;
  return <Box sx={{ width: "min(350px,100vw)", height: "100dvh" }}><WorkspaceSidebar drawer={new URLSearchParams(location.search).has("drawer")} projects={[project]} preferences={preferences} route={route} notifications={[]}
    onNavigate={next => { document.body.dataset.route = JSON.stringify(next); setRoute(next); }} onCreate={() => {}} onPreferences={() => {}}
    onRenameConversation={() => {}} onDeleteConversation={() => {}} onProjectDeleted={() => {}} width={350} /></Box>;
}
const content = mode === "import" || mode === "automation" ? <ImportFixture />
  : mode === "sidebar" ? <SidebarFixture />
  : mode === "browser-picker" ? <BrowserWorkspaceHost projectId={browserProjects[0].id} conversationId="chat" projects={browserProjects as never} onRequestHandled={() => {}} onClose={() => {}} onDockWidth={() => {}} />
  : mode === "receipt" ? <ReceiptFixture />
  : mode === "review-route" ? <MainConversationTimeline mainTimeline={[{ kind: "message", id: "response", at: "2026-09-30T12:00:00Z", message: {
      id: "response", text: "Changes", authorAgentId: "agent", executionId: params.has("missing-run") ? undefined : "response-run", createdAt: "2026-09-30T12:00:00Z", fileActivity: files.slice(0, 2),
    } }] as never} projectId="project" healthByAgentId={new Map()} agentTitle={() => "Agent"} agentIdForHandle={() => undefined}
    onOpenAgent={() => {}} onOpenReview={(agentId, executionId) => { document.body.dataset.review = `${agentId}:${executionId}`; }}
    mentionAgent={() => {}} markCommunicationVisible={() => {}} notifications={[]} />
  : mode === "review" ? <Box sx={{ height: "100dvh" }}><WorkspaceReviewPane projectRoot="/test" agentId="agent" files={files as never} executionId="response-run" running={false} /></Box>
  : <FilePreview title="Two-page fixture" mediaType="application/pdf" path="fixture.pdf" previewUrl={`/api/pdf/${params.has("bad") ? "bad" : "good"}`} downloadUrl="/api/pdf/good?download=1" />;
createRoot(document.getElementById("root")!).render(<ThemeProvider theme={createPonderosaTheme("dark")}><CssBaseline />
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <MutationNotificationProvider>{content}</MutationNotificationProvider>
  </QueryClientProvider></ThemeProvider>);
