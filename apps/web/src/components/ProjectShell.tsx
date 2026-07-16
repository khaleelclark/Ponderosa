import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import TuneIcon from "@mui/icons-material/Tune";
import { Alert, Box, Button, IconButton, LinearProgress, Stack, Typography, useMediaQuery } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import type { AgentHealthDto, EngineDto, ConversationDto, ProjectEngineCapabilitiesDto, ResponseFileActivityDto, AgentDetailDto, AgentDto } from "@ponderosa/core";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { chatStateKey, writeChatState } from "../chatState";
import { mergeAgentStatuses } from "../agents";
import { pickAgentName } from "../parkNames";
import { useAgentHealth, useAgentPresets, useConversations, useAgents } from "../hooks/queries";
import type { Route } from "../routing";
import { AgentDetail } from "./AgentDetail";
import { AgentsTab } from "./AgentsTab";
import { CreateAgentDialog, type CreateAgentInput, CreateConversationDialog, type CreateConversationInput, PresetManagerDialog } from "./dialogs";
import { ConversationView } from "./ConversationView";
import { Sidebar } from "./Sidebar";

interface AgentDialogState {
  open: boolean;
  fixedConversationId?: string;
  defaultEngine?: string;
  defaultModel?: string;
  defaultEffort?: string;
  defaultName?: string;
  defaultManagerAgentId?: string;
}

export function ProjectShell({
  projectId,
  route,
  engines,
  navigate,
}: {
  projectId: string;
  route: Route;
  engines: EngineDto[];
  navigate(route: Route, options?: { replace?: boolean }): void;
}): JSX.Element {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  const queryClient = useQueryClient();

  const conversationsQuery = useConversations(projectId);
  const agentsQuery = useAgents(projectId);
  const conversations = conversationsQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const presetsQuery = useAgentPresets(projectId);
  const healthQuery = useAgentHealth(projectId);
  const capabilitiesQuery = useQuery({
    queryKey: ["engine-capabilities", projectId],
    queryFn: () => api.getEngineCapabilities(projectId),
    staleTime: 60_000,
  });
  const engineCapabilities = capabilitiesQuery.data ?? [] as ProjectEngineCapabilitiesDto[];
  const presets = presetsQuery.data ?? [];
  const [masterDialogOpen, setMasterDialogOpen] = useState(false);
  const [agentDialog, setAgentDialog] = useState<AgentDialogState>({ open: false });
  const [presetsOpen, setPresetsOpen] = useState(false);

  // Per-agent detail powers live status + activity in the sidebar and Agents tab.
  const agentDetailQueries = useQueries({
    queries: agents.map((agent) => ({
      queryKey: ["agent", agent.id],
      queryFn: () => api.getAgent(agent.id),
      staleTime: 30_000,
    })),
  });

  const detailByAgentId = useMemo(() => {
    const map = new Map<string, AgentDetailDto | undefined>();
    agents.forEach((agent, index) => map.set(agent.id, agentDetailQueries[index]?.data));
    return map;
  }, [agents, agentDetailQueries]);

  const statusByAgentId = useMemo(() => {
    return mergeAgentStatuses(agents, healthQuery.data?.agents ?? [], detailByAgentId);
  }, [agents, detailByAgentId, healthQuery.data]);
  const healthByAgentId = useMemo(
    () => new Map<string, AgentHealthDto>((healthQuery.data?.agents ?? []).map((agent) => [agent.agentId, agent])),
    [healthQuery.data],
  );

  const createConversation = useMutation({
    mutationFn: (input: CreateConversationInput) => api.createConversation(projectId, input),
    onSuccess: (master) => {
      queryClient.setQueryData<ConversationDto[]>(["conversations", projectId], (current = []) =>
        current.some((item) => item.id === master.id) ? current : [...current, master],
      );
      void queryClient.invalidateQueries({ queryKey: ["conversations", projectId] });
      setMasterDialogOpen(false);
      navigate({ kind: "conversation", projectId, conversationId: master.id });
    },
  });

  const createAgent = useMutation({
    mutationFn: (input: CreateAgentInput) =>
      api.createAgent(projectId, input.conversationId, {
        title: input.title,
        engine: input.engine,
        model: input.model,
        effort: input.effort,
        presetId: input.presetId,
        managerAgentId: input.managerAgentId,
        initialMessage: input.initialMessage,
      }),
    onSuccess: (agent) => {
      queryClient.setQueryData<AgentDto[]>(["agents", projectId], (current = []) =>
        current.some((item) => item.id === agent.id) ? current : [...current, agent],
      );
      void queryClient.invalidateQueries({ queryKey: ["agents", projectId] });
      if (agent.conversationId) {
        void queryClient.invalidateQueries({ queryKey: ["conversation", agent.conversationId] });
      }
      setAgentDialog({ open: false });
      navigate({ kind: "agent", projectId, agentId: agent.id });
    },
  });

  const suggestedName = () => pickAgentName(agents.map((agent) => agent.title));

  const openNewAgentFromMaster = (master: ConversationDto) =>
    setAgentDialog({
      open: true,
      fixedConversationId: master.id,
      defaultEngine: master.defaultEngine,
      defaultModel: master.defaultModel,
      defaultEffort: master.defaultEffort,
      defaultName: suggestedName(),
    });
  const openNewSubagent = (managerAgentId: string) => {
    const manager = agents.find((agent) => agent.id === managerAgentId);
    setAgentDialog({
      open: true,
      fixedConversationId: manager?.conversationId,
      defaultEngine: manager?.activeEngine,
      defaultName: suggestedName(),
      defaultManagerAgentId: managerAgentId,
    });
  };

  const openAgentReview = (agentId: string) => {
    writeChatState(chatStateKey("view", `agent.${agentId}`), "review");
    navigate({ kind: "agent", projectId, agentId });
  };

  const openAgentFileActivity = (agentId: string, file: ResponseFileActivityDto) => {
    writeChatState(chatStateKey("view", `agent.${agentId}`), file.artifactId ? "artifacts" : "changed_files");
    if (file.artifactId) writeChatState(chatStateKey("view", `agent.${agentId}.artifact`), file.artifactId);
    navigate({ kind: "agent", projectId, agentId });
  };

  const sidebarSelection = {
    conversationId: route.kind === "conversation" ? route.conversationId : undefined,
    agentsActive: route.kind === "agents" || route.kind === "agent",
  };

  const sidebar = (
    <Sidebar
      conversations={conversations}
      agents={agents}
      statusByAgentId={statusByAgentId}
      selection={sidebarSelection}
      onSelectConversation={(conversationId) => navigate({ kind: "conversation", projectId, conversationId })}
      onSelectAgents={() => navigate({ kind: "agents", projectId })}
      onCreateConversation={() => setMasterDialogOpen(true)}
    />
  );

  const loading = conversationsQuery.isLoading || agentsQuery.isLoading;

  useEffect(() => {
    if (loading) return;
    const missingMaster = route.kind === "conversation" && !conversations.some((master) => master.id === route.conversationId);
    const missingAgent = route.kind === "agent" && !agents.some((agent) => agent.id === route.agentId);
    if (missingMaster || missingAgent) {
      const fallback = conversations[0];
      navigate(fallback
        ? { kind: "conversation", projectId, conversationId: fallback.id }
        : { kind: "agents", projectId }, { replace: true });
    }
  }, [agents, loading, conversations, navigate, projectId, route]);

  if (conversationsQuery.isError || agentsQuery.isError) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert
          severity="error"
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => {
                void conversationsQuery.refetch();
                void agentsQuery.refetch();
              }}
            >
              Retry
            </Button>
          }
        >
          This project could not be loaded. Check the server connection and try again.
        </Alert>
      </Box>
    );
  }

  let main: JSX.Element;
  if (route.kind === "conversation") {
    main = (
      <ConversationView
        key={route.conversationId}
        conversationId={route.conversationId}
        focusMessageId={route.messageId}
        engines={engines}
        engineCapabilities={engineCapabilities}
        onRefreshCapabilities={() => capabilitiesQuery.refetch()}
        statusByAgentId={statusByAgentId}
        healthByAgentId={healthByAgentId}
        onOpenAgent={(agentId) => navigate({ kind: "agent", projectId, agentId })}
        onOpenReview={openAgentReview}
        onOpenFileActivity={openAgentFileActivity}
        onNewAgent={openNewAgentFromMaster}
        onDeleted={() => navigate({ kind: "agents", projectId })}
      />
    );
  } else if (route.kind === "agent") {
    main = (
      <AgentDetail
        key={route.agentId}
        agentId={route.agentId}
        engines={engines}
        engineCapabilities={engineCapabilities}
        onRefreshCapabilities={() => capabilitiesQuery.refetch()}
        projectedStatus={statusByAgentId.get(route.agentId)}
        projectedHealth={healthByAgentId.get(route.agentId)}
        agents={agents}
        conversations={conversations}
        onBack={() => navigate({ kind: "agents", projectId })}
        onOpenAgent={(agentId) => navigate({ kind: "agent", projectId, agentId })}
        onOpenMaster={(conversationId) => navigate({ kind: "conversation", projectId, conversationId })}
        onNewSubagent={openNewSubagent}
        onDeleted={() => navigate({ kind: "agents", projectId })}
      />
    );
  } else if (route.kind === "agents") {
    main = (
      <AgentsTab
        agents={agents}
        conversations={conversations}
        statusByAgentId={statusByAgentId}
        detailByAgentId={detailByAgentId}
        onOpenAgent={(agentId) => navigate({ kind: "agent", projectId, agentId })}
        onNewAgent={(managerAgentId) => managerAgentId
          ? openNewSubagent(managerAgentId)
          : setAgentDialog({ open: true, defaultName: suggestedName() })}
      />
    );
  } else {
    main = (
      <Box sx={{ p: 3 }}>
        <Alert severity="info">
          Select a Project chat or open the Agents view to get started.
        </Alert>
      </Box>
    );
  }

  const dialogs = (
    <>
      <CreateConversationDialog
        open={masterDialogOpen}
        engines={engines}
        pending={createConversation.isPending}
        error={createConversation.isError ? String(createConversation.error) : undefined}
        onClose={() => setMasterDialogOpen(false)}
        onCreate={(input) => createConversation.mutate(input)}
      />
      <CreateAgentDialog
        open={agentDialog.open}
        engines={engines}
        conversations={conversations}
        presets={presets}
        agents={agents}
        fixedConversationId={agentDialog.fixedConversationId}
        defaultEngine={agentDialog.defaultEngine}
        defaultModel={agentDialog.defaultModel}
        defaultEffort={agentDialog.defaultEffort}
        defaultName={agentDialog.defaultName}
        defaultManagerAgentId={agentDialog.defaultManagerAgentId}
        pending={createAgent.isPending}
        error={createAgent.isError ? String(createAgent.error) : undefined}
        onClose={() => setAgentDialog({ open: false })}
        onCreate={(input) => createAgent.mutate(input)}
      />
      <PresetManagerDialog open={presetsOpen} engines={engines} presets={presets} onClose={() => setPresetsOpen(false)} onSave={(id, input) => {
        const action = id ? api.updateAgentPreset(id, input) : api.createAgentPreset(projectId, input as never);
        void action.then(() => queryClient.invalidateQueries({ queryKey: ["agent-presets", projectId] }));
      }} onDelete={(id) => { void api.deleteAgentPreset(id).then(() => queryClient.invalidateQueries({ queryKey: ["agent-presets", projectId] })); }} />
    </>
  );

  // Workspace navigation is owned by App on every viewport. Mobile opens the
  // same project hierarchy in an AppBar drawer, so the legacy per-project list
  // and its title/engine chat-creation form must never become a second flow.
  if (isMobile) {
    return (
      <Box sx={{ width: "100%", maxWidth: "100%", minHeight: 0, minWidth: 0, overflow: "hidden", display: "grid", gridTemplateRows: "auto minmax(0, 1fr)" }}>
        {loading ? <LinearProgress /> : <Box />}
        <Box sx={{ minHeight: 0, minWidth: 0, display: "grid" }}>{main}</Box>
        {dialogs}
      </Box>
    );
  }

  return (
    <Box sx={{ width: "100%", maxWidth: "100%", minHeight: 0, minWidth: 0, overflow: "hidden", display: "grid" }}>
      <Box component="section" aria-label="Project workspace" sx={{ minHeight: 0, minWidth: 0, display: "grid", bgcolor: "background.default" }}>{main}</Box>
      {dialogs}
    </Box>
  );
}
