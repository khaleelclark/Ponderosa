import { useState } from "react";
import { Box, CssBaseline, ThemeProvider } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
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
const params = new URLSearchParams(location.search);
const chatId = params.get("chat")!;
const [detail, engines, project] = await Promise.all([
  api.getConversation(chatId), api.listEngines(), api.getProject(params.get("project")!),
]);
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
function App() {
  const [policyOwner,setPolicyOwner]=useState(params.get("editor")??"");
  const [agentId, setAgentId] = useState(params.get("agent") ?? "");
  const shared = { engines, engineCapabilities: [], onRefreshCapabilities: noop,
    statusByAgentId: new Map(), healthByAgentId: new Map(), onOpenAgent: noop,
    onAgentsDeleted: noop, onOpenBrowser: noop, onDeleted: noop };
  if(policyOwner)return <Box sx={{p:2}}><CapabilityPolicyEditor endpoint={`/api/agents/${policyOwner}/capabilities`} scopeKind="agent"/>{params.get("other")&&<button onClick={()=>setPolicyOwner(params.get("other")!)}>Switch fixture policy owner</button>}</Box>;
  return agentId ? <AgentDetail {...shared} agentId={agentId} projectId={project.id}
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
createRoot(document.getElementById("root")!).render(<ThemeProvider theme={createPonderosaTheme("dark")}><CssBaseline />
  <QueryClientProvider client={client}><MutationNotificationProvider>
    <WorkspaceConnectionProvider value={{ status: "connected", phaseEvidenceFresh: true, prolongedDisconnect: false }}>
      <MobileNavigationProvider onOpen={noop}><PrimaryHeaderActionsProvider onOpenProviderSettings={noop}>
        <Box sx={{ height: "100dvh", display: "flex", flexDirection: "column", minHeight: 0 }}><App /></Box>
      </PrimaryHeaderActionsProvider></MobileNavigationProvider>
    </WorkspaceConnectionProvider>
  </MutationNotificationProvider></QueryClientProvider>
</ThemeProvider>);
