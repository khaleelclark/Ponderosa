import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import TuneIcon from "@mui/icons-material/Tune";
import { Alert, Box, Button, IconButton, LinearProgress, Stack, Typography, useMediaQuery } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import type {
  AgentDto,
  AgentHealthDto,
  ConversationDto,
  EngineDto,
  ProjectDto,
  ProjectEngineCapabilitiesDto,
  ResponseFileActivityDto,
  WorkspaceNotificationDto,
  WorkspacePreferencesDto,
  WorkspaceAgentDirectoryItemDto,
} from "@ponderosa/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { mergeAgentStatuses } from "../agents";
import { useAgent, useAgentHealth, useAgentPresets, useConversations, useAgents } from "../hooks/queries";
import { queryKeys } from "../queryKeys";
import { enginesWithModelCatalog } from "../conversationEngine";
import { useWorkspaceDirectory, workspaceDirectoryItems } from "../hooks/useWorkspaceDirectory";
import { assertNeverRoute, routeToPath, type ProjectRoute } from "../routeRegistry";
import type { Route } from "../routing";
import { AgentDetail } from "./AgentDetail";
import { AgentsTab } from "./AgentsTab";
import { PresetManagerDialog } from "./dialogs";
import { ConversationView } from "./ConversationView";
import { ProjectArtifactsView } from "./ProjectArtifactsView";
import { AgentWorkInspector } from "./AgentWorkInspector";
import { ProjectBrowserDialog } from "./ProjectBrowserDialog";
import { AgentBrowserDialog } from "./AgentBrowserDialog";
import type { ProjectBrowserRequest } from "./ProjectBrowserContext";
import { WorkspaceReviewPane } from "./files/WorkspaceReviewPane";
import { WorkspaceFileView } from "./WorkspaceFileView";
import { WorkspaceErrorBoundary } from "./WorkspaceErrorBoundary";
import { CollectionPagination } from "./CollectionPrimitives";
import { LoadingState } from "./LoadingState";

type RemovableWorkspaceResourceRoute = Extract<
  Route,
  { kind: "agent" | "conversation" }
>;

export function ProjectShell({
  projectId,
  project,
  route,
  engines,
  notifications,
  preferences,
  onPreferences,
  onRenameConversation,
  onDeleteConversation,
  onOpenEngineStatus,
  navigate,
  browserRequest,
  onBrowserRequestHandled,
  openInNewTab,
  onResourceDeleted,
  onProjectDeleted,
  onCreate,
}: {
  projectId: string;
  project: ProjectDto;
  route: ProjectRoute;
  engines: EngineDto[];
  notifications: WorkspaceNotificationDto[];
  preferences: WorkspacePreferencesDto;
  onPreferences(patch: Partial<WorkspacePreferencesDto>): void;
  onRenameConversation(conversation: ConversationDto): void;
  onDeleteConversation(conversation: ConversationDto): void;
  onOpenEngineStatus(): void;
  navigate(route: Route, options?: { replace?: boolean }): void;
  browserRequest?: ProjectBrowserRequest;
  onBrowserRequestHandled?(requestId: number): void;
  openInNewTab?(route: Route): void;
  onResourceDeleted?(route: RemovableWorkspaceResourceRoute): void;
  onProjectDeleted(projectId: string): void;
  onCreate(
    kind: "chat" | "agent" | "trigger",
    context: {
      projectId: string;
      conversationId?: string;
      managerAgentId?: string;
      agentId?: string;
    },
  ): void;
}): JSX.Element {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  const queryClient = useQueryClient();

  const pagedAgentRoster = route.kind === "agents";
  const [agentDirectorySearch, setAgentDirectorySearch] = useState("");
  const agentDirectoryQuery =
    useWorkspaceDirectory<WorkspaceAgentDirectoryItemDto>("agent", {
      search: agentDirectorySearch,
      projectId,
      enabled: pagedAgentRoster,
    });
  const agentDirectory = workspaceDirectoryItems(agentDirectoryQuery.data?.pages, preferences);
  const conversationsQuery = useConversations(projectId);
  const agentsQuery = useAgents(projectId);
  const healthQuery = useAgentHealth(projectId);
  const agentDirectoryRows = [
    ...agentDirectory.starredItems,
    ...agentDirectory.items,
  ];
  const conversations = conversationsQuery.data ?? [];
  const agents = useMemo(() => {
    const byId = new Map((agentsQuery.data ?? []).map(agent => [agent.id, agent]));
    for (const item of agentDirectoryRows) byId.set(item.agent.id, item.agent);
    return [...byId.values()];
  }, [agentDirectoryRows, agentsQuery.data]);
  const projectedHealth = healthQuery.data?.agents ??
    agentDirectoryRows.map(item => item.health);
  const visibleAgentIds = new Set(
    agentDirectoryRows.map(item => item.agent.id),
  );
  const presetsQuery = useAgentPresets(projectId);
  const claudeEngine = engines.find((engine) => engine.id === "claude");
  const modelCatalogQuery = useQuery({
    queryKey: queryKeys.engines.models(projectId, "claude"),
    queryFn: () => api.getEngineModels(projectId, "claude"),
    enabled: Boolean(claudeEngine),
    staleTime: 5 * 60_000,
  });
  const projectEngines = useMemo(
    () => enginesWithModelCatalog(engines, modelCatalogQuery.data),
    [engines, modelCatalogQuery.data],
  );
  const routedAgent = route.kind === "agent"
    ? agents.find((agent) => agent.id === route.agentId)
    : undefined;
  const routedAgentHasLiveSession = route.kind === "agent" && Boolean(
    projectedHealth.find((agent) => agent.agentId === route.agentId)
      ?.providerSessionLive,
  );
  const capabilityAgent = routedAgentHasLiveSession ? routedAgent : undefined;
  const capabilityQueryKey = useMemo(
    () => route.kind === "agent" && capabilityAgent
      ? queryKeys.engines.capabilitySelection(
        projectId,
        capabilityAgent.id,
        capabilityAgent.activeEngine,
        capabilityAgent.model,
      )
      : queryKeys.engines.capabilities(projectId),
    [capabilityAgent, projectId, route.kind],
  );
  const capabilitiesQuery = useQuery({
    queryKey: capabilityQueryKey,
    queryFn: () => api.getEngineCapabilities(projectId, capabilityAgent ? {
      agentId: capabilityAgent.id,
      engineId: capabilityAgent.activeEngine,
      model: capabilityAgent.model,
    } : undefined),
    enabled: route.kind !== "agent" || Boolean(routedAgent && healthQuery.data),
    staleTime: 60_000,
  });
  // The review surface needs changed-file and Run detail for one Agent. Fetch
  // that Agent only while the route is open instead of hydrating every roster
  // member's full history from the Project shell.
  const reviewAgentQuery = useAgent(route.kind === "review" ? route.agentId : undefined);
  const engineCapabilities = capabilitiesQuery.data ?? [] as ProjectEngineCapabilitiesDto[];
  const refreshCapabilities = useCallback(async (context?: { engineId?: string; model?: string; agentId?: string }) => {
    const discovered = await api.getEngineCapabilities(projectId, { ...context, refresh: true });
    queryClient.setQueryData(capabilityQueryKey, discovered);
    return discovered;
  }, [capabilityQueryKey, projectId, queryClient]);
  const presets = presetsQuery.data ?? [];
  const [presetsOpen, setPresetsOpen] = useState(false);

  const statusByAgentId = useMemo(() => {
    return mergeAgentStatuses(agents, projectedHealth, new Map());
  }, [agents, projectedHealth]);
  const healthByAgentId = useMemo(
    () => new Map<string, AgentHealthDto>(projectedHealth.map((agent) => [agent.agentId, agent])),
    [projectedHealth],
  );

  const openNewSubagent = (managerAgentId: string) => {
    const manager = agents.find((agent) => agent.id === managerAgentId);
    onCreate("agent", {
      projectId,
      ...(manager?.conversationId
        ? { conversationId: manager.conversationId }
        : {}),
      managerAgentId,
    });
  };

  const openAgentReview = (agentId: string) => {
    navigate({ kind: "review", projectId, agentId });
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
  const openProjectConversation = (conversationId: string) => {
    void api.markProjectUsed(projectId, conversationId);
    navigate({ kind: "conversation", projectId, conversationId });
  };

  const loading = conversationsQuery.isLoading || agentsQuery.isLoading;

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
        focusMessageId={route.focusMessageId}
        initialView={route.urlDriven ? (route.channel ?? "main") : route.channel}
        engines={projectEngines}
        engineCapabilities={engineCapabilities}
        onRefreshCapabilities={refreshCapabilities}
        statusByAgentId={statusByAgentId}
        healthByAgentId={healthByAgentId}
        projectAgents={agents}
        onOpenProject={() => navigate({ kind: "project", projectId })}
        onOpenProjectBrowser={() => navigate({ kind: "browser", projectId })}
        onOpenAgent={(agentId, view, technicalFocusId) => view
          ? navigate({ kind: "agent", projectId, agentId, view, ...(technicalFocusId ? { technicalFocusId } : {}) })
          : navigate({ kind: "agent", projectId, agentId })}
        onOpenAgentInNewTab={(agentId) => openInNewTab?.({ kind: "agent", projectId, agentId })}
        onAgentsDeleted={(agentIds) =>
          agentIds.forEach(agentId =>
            onResourceDeleted?.({ kind: "agent", projectId, agentId }),
          )}
        onOpenReview={openAgentReview}
        onOpenAgentWork={(focusId) => navigate({ kind: "projectWork", projectId, conversationId: route.conversationId, ...(focusId ? { focusId } : {}) })}
        onOpenBrowser={(agentId, runId) => navigate({
          kind: "browser",
          projectId,
          agentId,
          runId,
          conversationId: route.conversationId,
        })}
        onOpenFileActivity={openAgentFileActivity}
        onNewAgent={(master, managerAgentId) => onCreate("agent", {
          projectId,
          conversationId: master.id,
          ...(managerAgentId ? { managerAgentId } : {}),
        })}
        preferences={preferences}
        onPreferences={onPreferences}
        onNavigateTrigger={(triggerRoute) => navigate(triggerRoute)}
        onOpenTriggerInNewTab={(triggerRoute) => openInNewTab?.(triggerRoute)}
        onCreateTrigger={(agentId) => onCreate("trigger", {
          projectId,
          conversationId: route.conversationId,
          ...(agentId ? { agentId } : {}),
        })}
        onDeleted={() => {
          onResourceDeleted?.({ kind: "conversation", projectId, conversationId: route.conversationId });
        }}
      />
    );
  } else if (route.kind === "agent") {
    main = (
      <AgentDetail
        key={route.agentId}
        agentId={route.agentId}
        projectId={projectId}
        focusMessageId={route.focusMessageId}
        focusTelemetry={route.focusTelemetry}
        technicalFocusId={route.technicalFocusId}
        initialView={route.view}
        triggerSettingsId={route.triggerId}
        onViewChange={(view) => navigate({ kind: "agent", projectId, agentId: route.agentId, view }, { replace: true })}
        onOpenTechnicalDetails={(technicalFocusId) => navigate({
          kind: "agent", projectId, agentId: route.agentId, view: "technical",
          ...(technicalFocusId ? { technicalFocusId } : {}),
        })}
        engines={projectEngines}
        modelCatalogLoading={modelCatalogQuery.isLoading}
        engineCapabilities={engineCapabilities}
        onRefreshCapabilities={refreshCapabilities}
        projectedStatus={statusByAgentId.get(route.agentId)}
        projectedHealth={healthByAgentId.get(route.agentId)}
        statusByAgentId={statusByAgentId}
        healthByAgentId={healthByAgentId}
        agents={agents}
        conversations={conversations}
        onOpenProject={() => navigate({ kind: "project", projectId })}
        onOpenAgent={(agentId) => navigate({ kind: "agent", projectId, agentId })}
        onOpenAgentSettings={(agentId) =>
          navigate({ kind: "agent", projectId, agentId, view: "settings" })}
        onOpenCommunicationSource={(conversationId, communicationEventId, channel) => navigate({
          kind: "conversation",
          projectId,
          conversationId,
          focusMessageId: communicationEventId,
          ...(channel === "collaboration" ? { channel } : {}),
        })}
        onOpenMaster={(conversationId) => {
          navigate({ kind: "conversation", projectId, conversationId });
        }}
        onOpenArtifact={(artifactId) => openProjectArtifact(route.agentId, artifactId)}
        onOpenArtifactInNewTab={(artifactId) => openInNewTab?.({ kind: "agent", projectId, agentId: route.agentId, focusTelemetry: { stream: "artifacts", id: artifactId } })}
        onOpenReview={(path) => navigate({ kind: "review", projectId, agentId: route.agentId, ...(path ? { path } : {}) })}
        onOpenReviewInNewTab={(path) => openInNewTab?.({ kind: "review", projectId, agentId: route.agentId, ...(path ? { path } : {}) })}
        onOpenBrowser={(runId) => navigate({ kind: "browser", projectId, agentId: route.agentId, runId })}
        onNewSubagent={openNewSubagent}
        onCreateTrigger={() => onCreate("trigger", {
          projectId,
          agentId: route.agentId,
        })}
        onDeleted={(deletedAgentIds) =>
          deletedAgentIds.forEach(agentId =>
            onResourceDeleted?.({ kind: "agent", projectId, agentId }),
          )}
        onAgentsDeleted={(deletedAgentIds) =>
          deletedAgentIds.forEach(agentId =>
            onResourceDeleted?.({ kind: "agent", projectId, agentId }),
          )}
      />
    );
} else if (route.kind === "browser") {
  const browserAgent = route.agentId ? agents.find(agent => agent.id === route.agentId) : undefined;
  main = route.agentId && route.runId ? (
    <AgentBrowserDialog
      key={`${route.agentId}:${route.runId}`}
      projectId={projectId}
      agentId={route.agentId}
      runId={route.runId}
      agentTitle={browserAgent?.title ?? "Agent"}
      backLabel={route.conversationId ? "Back to Chat" : "Back to Agent"}
      onClose={() => navigate(route.conversationId
        ? { kind: "conversation", projectId, conversationId: route.conversationId }
        : { kind: "agent", projectId, agentId: route.agentId! })}
    />
  ) : (
    <ProjectBrowserDialog
      projectId={projectId}
      open
      embedded
      request={browserRequest}
      onRequestHandled={onBrowserRequestHandled}
      backLabel="Back to Project"
      onClose={() => navigate({ kind: "project", projectId })}
    />
  );
  } else if (route.kind === "agents") {
    main = agentDirectoryQuery.isLoading ? (
      <LoadingState resource="Agents" variant="route" />
    ) : (
      <AgentsTab
        searchValue={agentDirectorySearch}
        onSearchValueChange={setAgentDirectorySearch}
        collectionFooter={(
          <CollectionPagination
            resourceLabel={preferences.agentSort === "last_used"
              ? "older Agents"
              : "Agents"}
            request={agentDirectoryQuery.requestState}
          />
        )}
        agents={agents}
        renderedAgentIds={agentDirectoryQuery.data ? visibleAgentIds : undefined}
        projectId={projectId}
        engines={projectEngines}
        conversations={conversations}
        statusByAgentId={statusByAgentId}
        healthByAgentId={healthByAgentId}
        onOpenAgent={(agentId) => navigate({ kind: "agent", projectId, agentId })}
        onOpenAgentInNewTab={(agentId) => openInNewTab?.({ kind: "agent", projectId, agentId })}
        onOpenAgentSettings={(agentId) =>
          navigate({ kind: "agent", projectId, agentId, view: "settings" })}
        onAgentsDeleted={(_deletedProjectId, agentIds) =>
          agentIds.forEach(agentId =>
            onResourceDeleted?.({ kind: "agent", projectId, agentId }),
          )}
        onNewAgent={(managerAgentId) => managerAgentId
          ? openNewSubagent(managerAgentId)
          : onCreate("agent", { projectId })}
        scopeLabel={project.label}
      />
    );
  } else if (route.kind === "review") {
    const detail = reviewAgentQuery.data;
    const running = Boolean(detail?.runs?.some((run) => run.status === "running" || run.status === "compacting"));
    main = <WorkspaceReviewPane
      projectId={projectId}
      projectRoot={project.hostPath}
      agentId={route.agentId}
      files={detail?.changedFiles ?? []}
      running={running}
      initialPath={route.path}
      onBack={() => navigate({ kind: "agent", projectId, agentId: route.agentId })}
      onOpenInNewTab={(path) => openInNewTab?.({ kind: "review", projectId, agentId: route.agentId, path })}
    />;
  } else if (route.kind === "workspaceFile") {
    main = <WorkspaceFileView projectId={projectId} path={route.path} onBack={() => navigate({ kind: "project", projectId })} />;
  } else if (route.kind === "projectWork") {
    main = <AgentWorkInspector
      key={`${projectId}:${route.conversationId ?? ""}:${route.focusId ?? ""}`}
      open
      projectId={projectId}
      conversationId={route.conversationId}
      focus={route.focusId ? { id: route.focusId } : undefined}
      backLabel={route.conversationId ? "Back to Chat" : "Back to Project"}
      onClose={() => navigate(route.conversationId ? { kind: "conversation", projectId, conversationId: route.conversationId } : { kind: "project", projectId })}
    />;
  } else if (route.kind === "project") {
    main =
      <ProjectArtifactsView
        projectId={projectId}
        project={project}
        initialView={route.view}
        onViewChange={(view) =>
          navigate(
            {
              kind: "project",
              projectId,
              ...(view === "overview" ? {} : { view }),
            },
            { replace: true },
          )}
        agents={agents}
        health={projectedHealth}
        healthByAgentId={healthByAgentId}
        engines={projectEngines}
        notifications={notifications}
        preferences={preferences}
        onPreferences={onPreferences}
        onCreateConversation={() => onCreate("chat", { projectId })}
        conversations={conversations}
        onOpenConversation={openProjectConversation}
        onOpenConversationInNewTab={openInNewTab ? (conversationId) => openInNewTab({ kind: "conversation", projectId, conversationId }) : undefined}
        onRenameConversation={onRenameConversation}
        onDeleteConversation={onDeleteConversation}
        statusByAgentId={statusByAgentId}
        onOpenAgent={(agentId) => navigate({ kind: "agent", projectId, agentId })}
        onOpenAgentInNewTab={(agentId) => openInNewTab?.({ kind: "agent", projectId, agentId })}
        onOpenAgentSettings={(agentId) =>
          navigate({ kind: "agent", projectId, agentId, view: "settings" })}
        onAgentsDeleted={(agentIds) =>
          agentIds.forEach(agentId =>
            onResourceDeleted?.({ kind: "agent", projectId, agentId }),
          )}
        onNewAgent={(managerAgentId) => managerAgentId
          ? openNewSubagent(managerAgentId)
          : onCreate("agent", { projectId })}
        onNavigateTrigger={(triggerRoute) => navigate(triggerRoute)}
        onOpenTriggerInNewTab={(triggerRoute) => openInNewTab?.(triggerRoute)}
        onCreateTrigger={() => onCreate("trigger", { projectId })}
        onProjectDeleted={() => {
          onProjectDeleted(projectId);
        }}
        onOpenEngineStatus={onOpenEngineStatus}
        onOpenArtifact={openProjectArtifact}
        onOpenArtifactInNewTab={(agentId, artifactId) => openInNewTab?.({ kind: "agent", projectId, agentId, focusTelemetry: { stream: "artifacts", id: artifactId } })}
        onOpenAgentWork={() => navigate({ kind: "projectWork", projectId })}
      />
  } else {
    main = assertNeverRoute(route);
  }

  const dialogs = (
    <>
      <PresetManagerDialog open={presetsOpen} engines={projectEngines} presets={presets} onClose={() => setPresetsOpen(false)} onSave={async (id, input) => {
        const action = id ? api.updateAgentPreset(id, input) : api.createAgentPreset(projectId, input);
        await action;
        await queryClient.invalidateQueries({ queryKey: queryKeys.agents.presets(projectId) });
      }} onDelete={async (id) => {
        await api.deleteAgentPreset(id);
        await queryClient.invalidateQueries({ queryKey: queryKeys.agents.presets(projectId) });
      }} />
    </>
  );

  // Workspace navigation is owned by App on every viewport. Mobile opens the
  // same project hierarchy in an AppBar drawer, so the legacy per-project list
  // and its title/engine chat-creation form must never become a second flow.
  if (isMobile) {
    return (
      <Box sx={{ width: "100%", maxWidth: "100%", minHeight: 0, minWidth: 0, overflow: "hidden", display: "grid", gridTemplateRows: "auto minmax(0, 1fr)" }}>
        {loading ? <LinearProgress /> : <Box />}
        <Box sx={{ minHeight: 0, minWidth: 0, display: "grid" }}><WorkspaceErrorBoundary resetKey={routeToPath(route)} title="This Project view could not be displayed.">{main}</WorkspaceErrorBoundary></Box>
        {dialogs}
      </Box>
    );
  }

  return (
    <Box sx={{ width: "100%", maxWidth: "100%", minHeight: 0, minWidth: 0, overflow: "hidden", display: "grid" }}>
      <Box component="section" aria-label="Project workspace" sx={{ minHeight: 0, minWidth: 0, display: "grid", bgcolor: "background.default" }}><WorkspaceErrorBoundary resetKey={routeToPath(route)} title="This Project view could not be displayed.">{main}</WorkspaceErrorBoundary></Box>
      {dialogs}
    </Box>
  );
}
