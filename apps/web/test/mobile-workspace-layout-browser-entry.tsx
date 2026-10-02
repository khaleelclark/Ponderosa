import { Box, CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import type { AgentDto, ArtifactDto } from "@ponderosa/core";
import { useState } from "react";
import { api } from "../src/api";
import { AgentDetailHeader } from "../src/components/AgentDetail.header";
import type { AgentTab } from "../src/components/AgentDetail.helpers";
import { ComposerRuntimeSelector } from "../src/components/ComposerRuntimeSelector";
import { Composer } from "../src/components/chat/Composer";
import { DEFAULT_ASSET_LIMITS } from "@ponderosa/core";
import { ConversationView } from "../src/components/ConversationView";
import { MobileNavigationProvider } from "../src/components/MobileNavigationContext";
import { MutationNotificationProvider } from "../src/components/MutationNotifications";
import { PrimaryHeaderActionsProvider } from "../src/components/PrimaryHeaderActions";
import { useAppViewport } from "../src/hooks/useAppViewport";
import type { WorkspaceConnectionStatus } from "../src/hooks/useWorkspaceStream";
import { createPonderosaTheme } from "../src/theme";
import "../src/global.css";

const params = new URLSearchParams(location.search);
const noop = () => {};
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
const project = { id: "project", label: "Mobile layout", hostPath: "/fixture", defaultEngine: "codex" } as const;
const conversation = { id: "chat", projectId: project.id, title: params.has("long") ? "Populated Chat with a very long recognizable title" : "Populated Chat", archived: false,
  createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-01T10:00:00Z" };
const artifacts: ArtifactDto[] = Array.from({ length: 20 }, (_, i) => ({ id: String(i),
  projectId: project.id, agentId: "deleted-agent", path: `report-${i}.txt`, kind: "document",
  mediaType: "text/plain", previewUrl: `/api/fixture/report-${i}.txt`, downloadUrl: `/api/fixture/report-${i}.txt`,
  createdAt: new Date(Date.UTC(2026, 9, 1, 10, i)).toISOString() }));
api.getProviderUsage = async () => ({ providers: [] }) as never;
api.getAssetLimits = async () => DEFAULT_ASSET_LIMITS;
api.listProjects = async () => [project] as never;
api.listAgents = async () => [];
api.getConversation = async () => ({ conversation, agents: [], messages: [], history: { limit: 100, hasMore: false } });
api.listNotifications = async () => ({ items: [], history: { hasMore: false } }) as never;
api.getWorkspacePreferences = async () => ({}) as never;
api.listActiveBrowserSessions = async () => [];
api.getTargetedNextRunReceipts = async () => ({ receipts: [] }) as never;
api.listConversationMembersPage = async () => ({ items: [], total: 0, limit: 100, hasMore: false });
api.listConversationArtifacts = async (_project, _chat, _limit, cursor, search) => ({
  items: (params.has("pagination") ? cursor ? artifacts.slice(0, 10) : artifacts.slice(10) : artifacts).filter(a => !search || a.path.includes(search)),
  history: { limit: params.has("pagination") ? 10 : 100, hasMore: params.has("pagination") && !cursor, cursor: "older" } });
api.getConversationFiles = async () => {
  document.body.dataset.folderReads = String(Number(document.body.dataset.folderReads ?? 0) + 1);
  return { kind: "dir", entries: Array.from({ length: 8 }, (_, i) => ({ kind: "file", name: `workspace-${i}.txt`, path: `workspace-${i}.txt` })) } as never;
};
api.searchGlobalFiles = async () => ({ results: [] }) as never;
api.getWorkspaceFileView = async (_project, path) => ({ path, mediaType: "text/plain", text: `Workspace preview: ${path}` }) as never;

function Probe(): JSX.Element {
  useAppViewport();
  const [tab, setTab] = useState<AgentTab>("chat");
  const [recipient, setRecipient] = useState(true);
  if (params.get("case") === "composer") return <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
    <Box sx={{ flex: 1 }}>Isolated Composer: no live data or provider calls.</Box>
    <Composer enableVoiceDictation disabled={false} running={false} destinationMode={params.has("target-required") ? "target-required" : params.has("fixed") ? "fixed" : "project-chat"}
      requiredRecipient={params.has("target-required") && recipient ? { handle: "Boston", title: "Boston", onClear: () => { setRecipient(false); document.body.dataset.recipientCleared = "yes"; } } : undefined}
      defaultDestination={params.has("reply") ? { handle: "Boston", selectionKey: "reply-boston", binding: { agentId: "boston", projectId: "project", handle: "Boston", currentHandle: "Boston", currentTitle: "Boston" } } : undefined}
      mentionHandles={["Boston"]} mentionBindings={[{ agentId: "boston", projectId: "project", handle: "Boston", currentHandle: "Boston", currentTitle: "Boston" }]}
      controls={<ComposerRuntimeSelector engine="codex" engines={[{ id: "codex", label: "Codex" }]}
        model="model" models={[{ id: "model", label: "GPT-6.1-Sol" }, { id: "other", label: "Other model" }]}
        effort="high" efforts={[{ id: "high", label: "High" }, { id: "medium", label: "Medium" }]}
        onModelChange={id => { document.body.dataset.selectedModel = id; }} onEffortChange={noop} />}
      onSend={async text => { document.body.dataset.sent = text; }} />
  </Box>;
  if (["files", "chat-header"].includes(params.get("case") ?? "")) return <ConversationView conversationId="chat" initialView={params.get("case") === "files" ? "files" : "main"}
    engines={[]} engineCapabilities={[]} onRefreshCapabilities={noop} statusByAgentId={new Map()}
    healthByAgentId={new Map()} projectAgents={[]} onOpenProject={noop} onOpenProjectBrowser={() => { document.body.dataset.browserOpened = "yes"; }}
    onOpenAgent={noop} onAgentsDeleted={noop} onOpenAgentWork={noop} onOpenBrowser={noop} onNewAgent={noop}
    preferences={{} as never} onPreferences={noop} onNavigateTrigger={noop} onCreateTrigger={noop} onDeleted={noop} />;
  if (params.get("case") === "picker") return <Box sx={{ height: "100%", position: "relative" }}>
    <Box sx={{ position: "absolute", bottom: 24, right: 24 }}><ComposerRuntimeSelector
      engine="codex" engines={[{ id: "codex", label: "Codex" }, { id: "claude", label: "Claude" }]}
      model="model" models={[{ id: "model", label: "GPT-6.1-Sol" }, { id: "other", label: "Other model" }]}
      effort="high" efforts={[{ id: "high", label: "High" }, { id: "medium", label: "Medium" }]}
      speed="standard" speeds={[{ id: "standard", label: "Standard" }, { id: "fast", label: "Fast" }]}
      scopeLabel="Mesa Verde" onEngineChange={noop} onModelChange={id => { document.body.dataset.selectedModel = id; }}
      onEffortChange={noop} onSpeedChange={noop} /></Box>
  </Box>;
  return <AgentDetailHeader agent={{ id: "agent", projectId: project.id,
    title: params.has("long") ? "Mesa Verde with a very long Agent identity that must remain identifiable" : "Mesa Verde",
    handle: "Mesa-Verde" } as AgentDto} chats={[]} lineageLabel="" status="running"
    statusLabelOverride={params.has("long") ? "Running command" : undefined}
    connectionStatus={(params.get("connection") ?? "live") as WorkspaceConnectionStatus} phaseEvidenceFresh={false}
    startedAt={new Date(Date.now() - Number(params.get("minutes") ?? 11) * 60_000).toISOString()}
    agentNameForId={() => undefined} running stopping={false} tab={tab}
    showSubagents={!params.has("no-descendants")} showAutomations transcriptMarkdown="" transcriptTitle="fixture"
    onOpenProject={noop} onOpenChat={noop} onOpenAgent={noop} onStop={() => { document.body.dataset.stopped = "yes"; }}
    onExportPackage={noop} onNotice={noop} onOpenTechnical={noop} onRename={noop} onCreateAgent={noop}
    onChangeReportingLine={noop} onDelete={noop} onTabChange={setTab} />;
}
createRoot(document.getElementById("root")!).render(<ThemeProvider theme={createPonderosaTheme(params.get("theme") === "light" ? "light" : "dark")}>
  <CssBaseline /><QueryClientProvider client={client}><MutationNotificationProvider><MobileNavigationProvider onOpen={noop}>
    <Box sx={{ height: "var(--ponderosa-app-viewport-block-size, 100dvh)", overflow: "hidden" }}>
      <PrimaryHeaderActionsProvider onOpenProviderSettings={noop}><Probe /></PrimaryHeaderActionsProvider>
    </Box>
  </MobileNavigationProvider></MutationNotificationProvider></QueryClientProvider>
</ThemeProvider>);
