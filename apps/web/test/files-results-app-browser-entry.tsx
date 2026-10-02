import { CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import { DEFAULT_ASSET_LIMITS, type ArtifactDto } from "@ponderosa/core";
import App from "../src/App";
import { api } from "../src/api";
import { MutationNotificationProvider } from "../src/components/MutationNotifications";
import { createPonderosaTheme } from "../src/theme";
import "../src/global.css";

// Real App, route outlet, Project shell, headers and Chat; only server data is
// disposable. A standalone Files & Results component misses ancestor clipping.
const project = { id: "project", label: "Scroll qualification", hostPath: "/fixture",
  defaultEngine: "codex", createdAt: "2026-10-01T10:00:00Z" } as const;
const conversation = { id: "chat", projectId: project.id, title: "Initial Conversation",
  archived: false, createdAt: project.createdAt, updatedAt: project.createdAt };
const artifacts: ArtifactDto[] = Array.from({ length: 31 }, (_, i) => ({
  id: String(i), projectId: project.id, agentId: "deleted-agent", path: `report-${i}.txt`,
  kind: "document", mediaType: "text/plain", previewUrl: `/api/fixture/report-${i}.txt`,
  downloadUrl: `/api/fixture/report-${i}.txt`,
  createdAt: new Date(Date.UTC(2026, 9, 1, 10, i)).toISOString(),
}));
api.listProjects = async () => [project] as never;
api.getProject = async () => project as never;
api.listAgents = async () => [];
api.listEngines = async () => [];
api.getAssetLimits = async () => DEFAULT_ASSET_LIMITS;
api.getConversationDraft = async (id, ownerId) => ({ conversationId: id, ownerId,
  text: "", attachmentIds: [], attachments: [], revision: 0 }) as never;
api.listConversations = async () => [conversation];
api.getAgentHealth = async () => ({ agents: [] }) as never;
api.listAgentPresets = async () => [];
api.getEngineCapabilities = async () => [];
api.getProviderUsage = async () => ({ providers: [] }) as never;
api.getHealth = async () => ({ status: "ok" }) as never;
api.getConversation = async () => ({ conversation, agents: [], messages: [],
  history: { limit: 100, hasMore: false } });
api.listQueuedConversationMessages = async () => [];
api.listActiveBrowserSessions = async () => [];
api.getTargetedNextRunReceipts = async () => ({ receipts: [] }) as never;
api.listConversationMembersPage = async () => ({ items: [], total: 0, limit: 100, hasMore: false });
api.listNotifications = async () => ({ items: [], history: { hasMore: false } }) as never;
api.getNotificationProjection = async () => ({ workspace: {},
  allMessages: { importantCount: 0, ordinaryCount: 0, totalCount: 0 }, projects: {}, conversations: {} }) as never;
api.getWorkspacePreferences = async () => ({ revision: 1,
  profile: { displayName: "Tester", handle: "tester", avatarId: "default-user" },
  fontFamily: "inter", sidebarCollapsed: false, sidebarWidth: 288,
  projectSort: "last_used", projectOrder: [], homeSort: "last_used", homeOrder: [],
  chatSort: "last_used", chatOrder: [], agentSort: "last_used", agentOrder: [], triggerSort: "last_used",
  starredResourceIds: [], starredProjectIds: [], chatFolders: [],
  notifications: { directResponses: true, broadcasts: true }, providerAvailability: {}, engineDefaults: {},
  claudeModelOptions: [], globalInstructions: "", maxConcurrentAgentRuns: 8,
  contextRolloverEnabled: false, contextRolloverTokens: 150_000, contextRolloverWindowFraction: 0.7,
  onboardingCompletedAt: project.createdAt, updatedAt: project.createdAt }) as never;
api.getWebPushStatus = async () => ({ configuration: "disabled", deviceRegistered: false }) as never;
api.getWorkspaceDirectory = async (kind, options) => ({ kind, starredItems: [],
  items: options?.summary ? [] : kind === "conversation" ? [{ kind, project, conversation, runningAgentCount: 0 }]
    : kind === "project" ? [{ kind, project, runningAgentCount: 0 }] : [],
  total: kind === "conversation" || kind === "project" ? 1 : 0, runningCount: 0,
  history: { hasMore: false } }) as never;
api.subscribeWorkspace = (_cursor, handlers) => {
  const timer = setTimeout(() => handlers.onStatus?.({ instanceId: "scroll-fixture", cursor: 0,
    reset: false, snapshot: true }), 20);
  return { close: () => clearTimeout(timer) };
};
api.listConversationArtifacts = async (_project, _chat, _limit, _cursor, search) => ({
  items: artifacts.filter(a => !search || a.path.includes(search)), history: { limit: 100, hasMore: false } });
api.getConversationFiles = async () => ({ kind: "dir", entries: Array.from({ length: 4 }, (_, i) => ({
  kind: "file", name: `workspace-${i}.txt`, path: `workspace-${i}.txt`,
})) }) as never;
api.searchGlobalFiles = async () => ({ results: [] }) as never;
api.getWorkspaceFileView = async (_project, path) => ({ path, mediaType: "text/plain", text: `Workspace preview: ${path}` }) as never;

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000,
  refetchOnWindowFocus: false } } });
createRoot(document.getElementById("root")!).render(
  <ThemeProvider theme={createPonderosaTheme("dark")}><CssBaseline />
    <QueryClientProvider client={client}><MutationNotificationProvider>
      <App colorMode="dark" onToggleColorMode={() => {}} />
    </MutationNotificationProvider></QueryClientProvider>
  </ThemeProvider>,
);
