import { useState } from "react";
import { Box, CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { api } from "../src/api";
import { AgentCreateDialog } from "../src/components/AgentCreateDialog";
import { AgentDetail } from "../src/components/AgentDetail";
import { MobileNavigationProvider } from "../src/components/MobileNavigationContext";
import { MutationNotificationProvider } from "../src/components/MutationNotifications";
import { PrimaryHeaderActionsProvider } from "../src/components/PrimaryHeaderActions";
import { WorkspaceConnectionProvider } from "../src/components/WorkspaceConnectionContext";
import { useWorkspaceStream } from "../src/hooks/useWorkspaceStream";
import { useAgentHealth } from "../src/hooks/queries";
import { queryKeys } from "../src/queryKeys";
import { createPonderosaTheme } from "../src/theme";
import "../src/global.css";

const noop = () => {};
const params = new URLSearchParams(location.search);
const [initial, engines, project] = await Promise.all([
  api.getConversation(params.get("chat")!), api.listEngines(), api.getProject(params.get("project")!),
]);
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
function App() {
  const [agentId, setAgentId] = useState(params.get("agent") ?? "");
  const chat = useQuery({ queryKey: queryKeys.conversations.detail(initial.conversation.id),
    queryFn: () => api.getConversation(initial.conversation.id), initialData: initial });
  const health = useAgentHealth(project.id);
  return agentId ? <AgentDetail agentId={agentId} projectId={project.id} engines={engines}
    agents={chat.data.agents} conversations={[chat.data.conversation]} engineCapabilities={[]}
    projectedHealth={health.data?.agents.find(item => item.agentId === agentId)}
    projectedStatus={health.data?.agents.find(item => item.agentId === agentId)?.status}
    statusByAgentId={new Map()} healthByAgentId={new Map()} onRefreshCapabilities={noop}
    onOpenAgent={setAgentId} onOpenProject={noop} onOpenAgentSettings={noop}
    onOpenCommunicationSource={noop} onOpenMaster={noop} onOpenArtifact={noop} onOpenReview={noop}
    onOpenBrowser={noop} onNewSubagent={noop} onCreateTrigger={noop} onDeleted={noop}
    onAgentsDeleted={noop} onOpenTechnicalDetails={noop} /> :
    <AgentCreateDialog open projects={[project]} engines={engines} fixedProjectId={project.id}
      fixedConversationId={initial.conversation.id} onCancel={noop} onImported={noop}
      onCreated={(_project, agent) => {
        document.body.dataset.createdAgent = agent.id;
        setAgentId(agent.id);
        history.replaceState(null, "", `/?${new URLSearchParams({ project: project.id, chat: initial.conversation.id, agent: agent.id })}`);
      }} />;
}
function Connected() {
  const connection = useWorkspaceStream();
  return <WorkspaceConnectionProvider value={connection}><MobileNavigationProvider onOpen={noop}>
    <PrimaryHeaderActionsProvider onOpenProviderSettings={noop}>
      <Box sx={{ height: "100dvh", minHeight: 0, display: "flex", flexDirection: "column" }}><App /></Box>
    </PrimaryHeaderActionsProvider>
  </MobileNavigationProvider></WorkspaceConnectionProvider>;
}
// Ordinary query invalidation only; canonical state and product controls are unchanged.
Object.assign(window, { pineconeMvpFixture: { invalidate: () => client.invalidateQueries() } });
createRoot(document.getElementById("root")!).render(
  <ThemeProvider theme={createPonderosaTheme("dark")}><CssBaseline />
    <QueryClientProvider client={client}><MutationNotificationProvider><Connected /></MutationNotificationProvider></QueryClientProvider>
  </ThemeProvider>,
);
