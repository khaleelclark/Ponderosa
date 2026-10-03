import { Box, CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { api } from "../src/api";
import { ConversationView } from "../src/components/ConversationView";
import { AgentDetail } from "../src/components/AgentDetail";
import { AllChatView } from "../src/components/AllChatView";
import { MobileNavigationProvider } from "../src/components/MobileNavigationContext";
import { MutationNotificationProvider } from "../src/components/MutationNotifications";
import { PrimaryHeaderActionsProvider } from "../src/components/PrimaryHeaderActions";
import { WorkspaceConnectionProvider } from "../src/components/WorkspaceConnectionContext";
import { createPonderosaTheme } from "../src/theme";
import "../src/global.css";

const noop = () => {};
const params = new URLSearchParams(location.search);
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
const chatId = params.get("chat")!;
const agentId = params.get("agent")!;
const [detail, engines, preferences] = await Promise.all([
  api.getConversation(chatId), api.listEngines(), api.getWorkspacePreferences(),
]);
const openAgent = (id: string) => { document.body.dataset.openedAgent = id; };
const shared = { engines, engineCapabilities: [], onRefreshCapabilities: noop,
  statusByAgentId: new Map(), healthByAgentId: new Map(), onOpenAgent: openAgent,
  onAgentsDeleted: noop, onOpenBrowser: noop, onDeleted: noop };
const surface = params.get("surface") ?? "project";
const content = surface === "all" ? <AllChatView onNavigate={route => {
  if (route.kind === "agent") openAgent(route.agentId);
}} /> : surface === "agent" ? <AgentDetail {...shared} agentId={agentId} projectId={detail.conversation.projectId}
  agents={detail.agents} conversations={[detail.conversation]} onOpenProject={noop} onOpenAgentSettings={noop}
  onOpenCommunicationSource={noop} onOpenMaster={noop} onOpenArtifact={noop} onOpenReview={noop}
  onNewSubagent={noop} onCreateTrigger={noop} onOpenTechnicalDetails={noop} />
  : <ConversationView {...shared} conversationId={chatId} projectAgents={detail.agents}
    onOpenProject={noop} onOpenProjectBrowser={noop} onOpenAgentWork={noop} onNewAgent={noop}
    preferences={preferences} onPreferences={noop} onNavigateTrigger={noop} onCreateTrigger={noop} />;

createRoot(document.getElementById("root")!).render(<ThemeProvider theme={createPonderosaTheme("dark")}><CssBaseline />
  <QueryClientProvider client={client}><MutationNotificationProvider>
    <WorkspaceConnectionProvider value={{ status: "connected", phaseEvidenceFresh: true, prolongedDisconnect: false }}>
      <MobileNavigationProvider onOpen={noop}><PrimaryHeaderActionsProvider onOpenProviderSettings={noop}>
        <Box sx={{ height: "100dvh", display: surface === "all" ? "grid" : "flex",
          gridTemplateRows: "auto minmax(0, 1fr) auto", flexDirection: "column", minHeight: 0 }}>{content}</Box>
      </PrimaryHeaderActionsProvider></MobileNavigationProvider>
    </WorkspaceConnectionProvider>
  </MutationNotificationProvider></QueryClientProvider>
</ThemeProvider>);
