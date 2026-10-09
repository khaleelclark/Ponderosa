import { useState } from "react";
import type { AgentDetailView } from "../src/routing";
import { Box, CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { useWorkspaceStream } from "../src/hooks/useWorkspaceStream";
import { useAgentHealth } from "../src/hooks/queries";
import { api } from "../src/api";
import { AgentCreateDialog } from "../src/components/AgentCreateDialog";
import { CapabilityPolicyEditor } from "../src/components/CapabilityPolicyEditor";
import { AgentDetail } from "../src/components/AgentDetail";
import { MobileNavigationProvider } from "../src/components/MobileNavigationContext";
import { MutationNotificationProvider } from "../src/components/MutationNotifications";
import { PrimaryHeaderActionsProvider } from "../src/components/PrimaryHeaderActions";
import { WorkspaceConnectionProvider } from "../src/components/WorkspaceConnectionContext";
import { createPonderosaTheme } from "../src/theme";
import "../src/global.css";

const noop = () => {};
let disconnect = () => {};
let switchAgent = (_id: string) => {};
let switchView = (_view: AgentDetailView) => {};
const params = new URLSearchParams(location.search);
const chatId = params.get("chat")!;
const [detail, engines, project] = await Promise.all([
  api.getConversation(chatId), api.listEngines(), api.getProject(params.get("project")!),
]);
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
function App() {
  const [policyOwner,setPolicyOwner]=useState(params.get("editor")??"");
  const [agentId, setAgentId] = useState(params.get("agent") ?? "");
  switchAgent = setAgentId;
  const [view, setView] = useState<AgentDetailView>();
  switchView = setView;
  const health = useAgentHealth(project.id);
  const shared = { engines, engineCapabilities: [], onRefreshCapabilities: noop,
    statusByAgentId: new Map(), healthByAgentId: new Map(), onOpenAgent: noop,
    onAgentsDeleted: noop, onOpenBrowser: noop, onDeleted: noop };
  if(policyOwner)return <Box sx={{p:2}}><CapabilityPolicyEditor endpoint={`/api/agents/${policyOwner}/capabilities`} scopeKind="agent"/>{params.get("other")&&<button onClick={()=>setPolicyOwner(params.get("other")!)}>Switch fixture policy owner</button>}</Box>;
  return agentId ? <AgentDetail {...shared} agentId={agentId} projectId={project.id} initialView={view} onViewChange={setView}
    projectedHealth={health.data?.agents.find(item => item.agentId === agentId)} projectedStatus={health.data?.agents.find(item => item.agentId === agentId)?.status}
    agents={detail.agents} conversations={[detail.conversation]} onOpenProject={noop} onOpenAgentSettings={noop}
    onOpenCommunicationSource={noop} onOpenMaster={noop} onOpenArtifact={noop} onOpenReview={noop}
    onNewSubagent={noop} onCreateTrigger={noop} onOpenTechnicalDetails={noop} /> :
    <AgentCreateDialog open projects={[project]} engines={engines} fixedProjectId={project.id}
      fixedConversationId={chatId} onCancel={noop} onImported={noop} onCreated={(_project, agent) => {
        document.body.dataset.createdAgent = agent.id;
        setAgentId(agent.id);
        history.replaceState(null, "", `/?${new URLSearchParams({chat: chatId, project: project.id, agent: agent.id})}`);
      }} />;
}
function ConnectedFixture() {
  const [offline, setOffline] = useState(false);
  const live = useWorkspaceStream();
  disconnect = () => setOffline(value => !value);
  return <WorkspaceConnectionProvider value={{ ...live, status: offline ? "unavailable" : live.status, phaseEvidenceFresh: !offline && live.phaseEvidenceFresh, prolongedDisconnect: offline || live.prolongedDisconnect }}>
    <MobileNavigationProvider onOpen={noop}><PrimaryHeaderActionsProvider onOpenProviderSettings={noop}>
      <Box sx={{ height: "100dvh", display: "flex", flexDirection: "column", minHeight: 0 }}><App /></Box>
    </PrimaryHeaderActionsProvider></MobileNavigationProvider>
  </WorkspaceConnectionProvider>;
}
function Fixture() {
  return <ThemeProvider theme={createPonderosaTheme("dark")}><CssBaseline />
    <QueryClientProvider client={client}><MutationNotificationProvider><ConnectedFixture /></MutationNotificationProvider></QueryClientProvider>
  </ThemeProvider>;
}
Object.assign(window, { pineconeFixture: { switchView: (view: AgentDetailView) => switchView(view), disconnect: () => disconnect(), switchAgent: (id: string) => switchAgent(id), invalidate: () => client.invalidateQueries(), hasInstructions: (text: string) => client.getQueriesData({ queryKey: ["triggers", "project", project.id] }).some(([, data]) => JSON.stringify(data).includes(text)) } });
createRoot(document.getElementById("root")!).render(<Fixture />);
