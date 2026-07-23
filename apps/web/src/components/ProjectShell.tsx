import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import TuneIcon from "@mui/icons-material/Tune";
import { Alert, Box, Button, IconButton, LinearProgress, Stack, Typography, useMediaQuery } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import type { AgentHealthDto, EngineDto, ConversationDto, ProjectDto, ProjectEngineCapabilitiesDto, ResponseFileActivityDto, AgentDto } from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { chatStateKey, writeChatState } from "../chatState";
import { mergeAgentStatuses } from "../agents";
import { pickAgentName } from "../parkNames";
import { useAgent, useAgentHealth, useAgentPresets, useConversations, useAgents } from "../hooks/queries";
import type { Route } from "../routing";
import { AgentDetail } from "./AgentDetail";
import { AgentsTab } from "./AgentsTab";
import { CreateAgentDialog, type CreateAgentInput, CreateConversationDialog, type CreateConversationInput, PresetManagerDialog } from "./dialogs";
import { ConversationView } from "./ConversationView";
import { ProjectArtifactsView } from "./ProjectArtifactsView";
import { AgentWorkInspector } from "./AgentWorkInspector";
import { BrowserPanel } from "./BrowserPanel";
import { ProjectBrowserDialog } from "./ProjectBrowserDialog";
import type { ProjectBrowserRequest } from "./ProjectBrowserContext";
import { WorkspaceReviewPane } from "./panes";
import { WorkspaceFileView } from "./WorkspaceFileView";

interface AgentDialogState {
  open: boolean;
  fixedConversationId?: string;
  defaultEngine?: string;
  defaultModel?: string;
  defaultEffort?: string;
  defaultName?: string;
  defaultManagerAgentId?: string;
}

export interface AgentReturnContext {
  conversationId: string;
  reopenRoster: boolean;
}

export function agentBackRoute(projectId: string, context?: AgentReturnContext): Route {
  return context
    ? { kind: "conversation", projectId, conversationId: context.conversationId }
    : { kind: "agents", projectId };
}

export function ProjectShell({
  projectId,
  project,
  route,
  engines,
  navigate,
  browserRequest,
  onBrowserRequestHandled,
  openInNewTab,
  onResourceDeleted,
}: {
  projectId: string;
  project: ProjectDto;
  route: Route;
  engines: EngineDto[];
  navigate(route: Route, options?: { replace?: boolean }): void;
  browserRequest?: ProjectBrowserRequest;
  onBrowserRequestHandled?(requestId: number): void;
  openInNewTab?(route: Route): void;
  onResourceDeleted?(route: Route): void;
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
  // The review surface needs changed-file and Run detail for one Agent. Fetch
  // that Agent only while the route is open instead of hydrating every roster
  // member's full history from the Project shell.
  const reviewAgentQuery = useAgent(route.kind === "review" ? route.agentId : undefined);
  const engineCapabilities = capabilitiesQuery.data ?? [] as ProjectEngineCapabilitiesDto[];
  const refreshCapabilities = useCallback(async (context?: { engineId?: string; model?: string; agentId?: string }) => {
    const discovered = await api.getEngineCapabilities(projectId, { ...context, refresh: true });
    queryClient.setQueryData(["engine-capabilities", projectId], discovered);
    return discovered;
  }, [projectId, queryClient]);
  const presets = presetsQuery.data ?? [];
  const [masterDialogOpen, setMasterDialogOpen] = useState(false);
  const [agentDialog, setAgentDialog] = useState<AgentDialogState>({ open: false });
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [agentReturnContext, setAgentReturnContext] = useState<AgentReturnContext>();

  const statusByAgentId = useMemo(() => {
    return mergeAgentStatuses(agents, healthQuery.data?.agents ?? [], new Map());
  }, [agents, healthQuery.data]);
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
    navigate({ kind: "review", projectId, agentId });
  };

  const openAgentWorkLog = (agentId: string) => {
    writeChatState(chatStateKey("view", `agent.${agentId}`), "runOutput");
    navigate({ kind: "agent", projectId, agentId });
  };

  const openAgentFileActivity = (agentId: string, file: ResponseFileActivityDto) => {
    if (file.artifactId) {
      navigate({ kind: "agent", projectId, agentId, focusTelemetry: { stream: "artifacts", id: file.artifactId } });
    } else {
      navigate({ kind: "review", projectId, agentId, path: file.path });
    }
  };

  const openProjectArtifact = (agentId: string, artifactId: string) => {
    navigate({ kind: "agent", projectId, agentId, focusTelemetry: { stream: "artifacts", id: artifactId } });
  };

  const loading = conversationsQuery.isLoading || agentsQuery.isLoading;

  useEffect(() => {
    if (loading) return;
    const missingMaster = route.kind === "conversation" && !conversations.some((master) => master.id === route.conversationId);
    const missingAgent = (route.kind === "agent" || route.kind === "review") && !agents.some((agent) => agent.id === route.agentId);
    if (missingMaster || missingAgent) {
      const fallback = conversations[0];
      navigate(fallback
        ? { kind: "conversation", projectId, conversationId: fallback.id }
        : { kind: "agents", projectId }, { replace: true });
    }
  }, [agents, loading, conversations, navigate, projectId, route]);

  useEffect(() => {
    if (loading || route.kind !== "agents" || !route.create) return;
    setAgentDialog({ open: true, defaultName: suggestedName() });
    navigate({ kind: "agents", projectId }, { replace: true });
  }, [loading, route, projectId, navigate]);

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
    const reopenRoster = agentReturnContext?.conversationId === route.conversationId && agentReturnContext.reopenRoster;
    const openAgentFromConversation = (agentId: string, fromRoster: boolean) => {
      setAgentReturnContext({ conversationId: route.conversationId, reopenRoster: fromRoster });
      navigate({ kind: "agent", projectId, agentId });
    };
    main = (
      <ConversationView
        key={route.conversationId}
        conversationId={route.conversationId}
        focusMessageId={route.focusMessageId}
        initialView={route.channel}
        engines={engines}
        engineCapabilities={engineCapabilities}
        onRefreshCapabilities={refreshCapabilities}
        statusByAgentId={statusByAgentId}
        healthByAgentId={healthByAgentId}
        onOpenAgent={(agentId, view) => view ? navigate({ kind: "agent", projectId, agentId, view }) : openAgentFromConversation(agentId, false)}
        onOpenWorkLog={openAgentWorkLog}
        onOpenRosterAgent={(agentId) => openAgentFromConversation(agentId, true)}
        onOpenRosterAgentInNewTab={(agentId) => openInNewTab?.({ kind: "agent", projectId, agentId })}
        onOpenProjectAgents={() => navigate({ kind: "allAgents", filterProjectId: projectId })}
        initialAgentsOpen={reopenRoster}
        onInitialAgentsOpenConsumed={() => setAgentReturnContext(undefined)}
        onOpenReview={openAgentReview}
        onOpenAgentWork={(focusId) => navigate({ kind: "projectWork", projectId, conversationId: route.conversationId, ...(focusId ? { focusId } : {}) })}
        onOpenBrowser={() => navigate({ kind: "browser", projectId })}
        onOpenFileActivity={openAgentFileActivity}
        onNewAgent={openNewAgentFromMaster}
        onDeleted={() => {
          onResourceDeleted?.({ kind: "conversation", projectId, conversationId: route.conversationId });
          navigate({ kind: "agents", projectId });
        }}
      />
    );
  } else if (route.kind === "agent") {
    main = (
      <AgentDetail
        key={route.agentId}
        agentId={route.agentId}
        focusMessageId={route.focusMessageId}
        focusTelemetry={route.focusTelemetry}
        initialView={route.view}
        onViewChange={(view) => navigate({ kind: "agent", projectId, agentId: route.agentId, view }, { replace: true })}
        engines={engines}
        engineCapabilities={engineCapabilities}
        onRefreshCapabilities={refreshCapabilities}
        projectedStatus={statusByAgentId.get(route.agentId)}
        projectedHealth={healthByAgentId.get(route.agentId)}
        agents={agents}
        conversations={conversations}
        onBack={() => {
          const destination = agentBackRoute(projectId, agentReturnContext);
          if (!agentReturnContext?.reopenRoster) setAgentReturnContext(undefined);
          navigate(destination);
        }}
        onOpenAgent={(agentId) => navigate({ kind: "agent", projectId, agentId })}
        onOpenBroadcast={(conversationId, communicationEventId) => navigate({ kind: "conversation", projectId, conversationId, focusMessageId: communicationEventId })}
        onOpenMaster={(conversationId) => navigate({ kind: "conversation", projectId, conversationId })}
        onOpenArtifact={(artifactId) => openProjectArtifact(route.agentId, artifactId)}
        onOpenArtifactInNewTab={(artifactId) => openInNewTab?.({ kind: "agent", projectId, agentId: route.agentId, focusTelemetry: { stream: "artifacts", id: artifactId } })}
        onOpenReview={(path) => navigate({ kind: "review", projectId, agentId: route.agentId, ...(path ? { path } : {}) })}
        onOpenReviewInNewTab={(path) => openInNewTab?.({ kind: "review", projectId, agentId: route.agentId, ...(path ? { path } : {}) })}
        onOpenBrowser={(runId) => navigate({ kind: "browser", projectId, agentId: route.agentId, runId })}
        onNewSubagent={openNewSubagent}
        onDeleted={() => {
          onResourceDeleted?.({ kind: "agent", projectId, agentId: route.agentId });
          navigate({ kind: "agents", projectId });
        }}
      />
    );
  } else if (route.kind === "browser") {
    main = route.agentId && route.runId
      ? <BrowserPanel projectId={projectId} agentId={route.agentId} runId={route.runId} standalone />
      : <ProjectBrowserDialog projectId={projectId} open embedded request={browserRequest} onRequestHandled={onBrowserRequestHandled} onClose={() => navigate({ kind: "project", projectId })} />;
  } else if (route.kind === "agents") {
    main = (
      <AgentsTab
        agents={agents}
        projectId={projectId}
        engines={engines}
        conversations={conversations}
        statusByAgentId={statusByAgentId}
        healthByAgentId={healthByAgentId}
        onOpenAgent={(agentId) => navigate({ kind: "agent", projectId, agentId })}
        onOpenAgentInNewTab={(agentId) => openInNewTab?.({ kind: "agent", projectId, agentId })}
        onNewAgent={(managerAgentId) => managerAgentId
          ? openNewSubagent(managerAgentId)
          : setAgentDialog({ open: true, defaultName: suggestedName() })}
      />
    );
  } else if (route.kind === "review") {
    const detail = reviewAgentQuery.data;
    const running = Boolean(detail?.runs?.some((run) => run.status === "running" || run.status === "compacting"));
    main = <WorkspaceReviewPane
      projectId={projectId}
      files={detail?.changedFiles ?? []}
      running={running}
      initialPath={route.path}
      onOpenInNewTab={(path) => openInNewTab?.({ kind: "review", projectId, agentId: route.agentId, path })}
    />;
  } else if (route.kind === "workspaceFile") {
    main = <WorkspaceFileView projectId={projectId} path={route.path} />;
  } else if (route.kind === "projectWork") {
    main = <AgentWorkInspector open projectId={projectId} conversationId={route.conversationId} focus={route.focusId ? { id: route.focusId } : undefined} onClose={() => navigate({ kind: "project", projectId })} />;
  } else if (route.kind === "project") {
    main =
      <ProjectArtifactsView
        projectId={projectId}
        project={project}
        agents={agents}
        healthByAgentId={healthByAgentId}
        conversations={conversations}
        onOpenConversation={(conversationId) => navigate({ kind: "conversation", projectId, conversationId })}
        onOpenBrowser={() => navigate({ kind: "browser", projectId })}
        onOpenArtifact={openProjectArtifact}
        onOpenArtifactInNewTab={(agentId, artifactId) => openInNewTab?.({ kind: "agent", projectId, agentId, focusTelemetry: { stream: "artifacts", id: artifactId } })}
        onOpenRun={(agentId, runId) => navigate({ kind: "agent", projectId, agentId, focusTelemetry: { stream: "runs", id: runId } })}
        onOpenAgentWork={() => navigate({ kind: "projectWork", projectId })}
      />
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
