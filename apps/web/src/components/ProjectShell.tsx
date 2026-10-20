import { useEngineModelCatalogs } from "../hooks/useEngineModelCatalogs";
import { Alert, Box, Button, LinearProgress, useMediaQuery } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { useEventCallback } from "@mui/material/utils";
import type {
  AgentHealthDto,
  ConversationDto,
  EngineDto,
  ProjectDto,
  ProjectEngineCapabilitiesDto,
  ResponseFileActivityDto,
  WorkspaceNotificationDto,
  WorkspacePreferencesDto,
} from "@ponderosa/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { api } from "../api";
import { mergeAgentStatuses } from "../agents";
import { useAgent, useAgentHealth, useConversations, useAgents } from "../hooks/queries";
import { queryKeys } from "../queryKeys";
import { retainedDataFailure } from "../retainedData";
import { workspaceFileReturnFallback } from "../workspaceFileReturn";
import { enginesWithModelCatalog } from "../conversationEngine";
import { assertNeverRoute, nestedProjectRouteResources, routeToPath, type ProjectRoute } from "../routeRegistry";
import { routeReturnTarget, routeReturnLabel, type Route } from "../routing";
import { AgentDetail } from "./AgentDetail";
import { ConversationView } from "./ConversationView";
import { AgentWorkInspector } from "./AgentWorkInspector";
import { ProjectBrowserDialog } from "./ProjectBrowserDialog";
import { AgentBrowserDialog } from "./AgentBrowserDialog";
import { useProjectBrowser, type ProjectBrowserRequest } from "./ProjectBrowserContext";
import { WorkspaceReviewPane } from "./files/WorkspaceReviewPane";
import { WorkspaceFileView } from "./WorkspaceFileView";
import { WorkspaceErrorBoundary } from "./WorkspaceErrorBoundary";
import { useReportWorkspaceRefresh } from "./WorkspaceRefreshContext";

type RemovableWorkspaceResourceRoute = Extract<
  Route,
  { kind: "agent" | "conversation" }
>;

export function ProjectShell({
  projectId,
  project,
  route,
  engines,
  preferences,
  onPreferences,
  navigate,
  browserRequest,
  onBrowserRequestHandled,
  onResourceDeleted,
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
  onResourceDeleted?(route: RemovableWorkspaceResourceRoute): void;
  onProjectDeleted(projectId: string): void;
  onCreate(
    kind: "chat" | "agent",
    context: {
      projectId: string;
      conversationId?: string;
      managerAgentId?: string;
      agentId?: string;
    },
  ): void;
}): JSX.Element {
  const projectBrowser = useProjectBrowser();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  const queryClient = useQueryClient();

  const conversationsQuery = useConversations(projectId);
  const agentsQuery = useAgents(projectId);
  const routeResources = nestedProjectRouteResources(route);
  const healthQuery = useAgentHealth(projectId);
  const conversations = conversationsQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const projectedHealth = healthQuery.data?.agents ?? [];
  const modelCatalogQuery = useEngineModelCatalogs(projectId, engines);
  const projectEngines = useMemo(
    () => enginesWithModelCatalog(engines, modelCatalogQuery.catalogs),
    [engines, modelCatalogQuery.catalogs],
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
  const reviewAgentQuery = useAgent(
    route.kind === "review" && agents.some(agent => agent.id === route.agentId)
      ? route.agentId
      : undefined,
  );
  const engineCapabilities = capabilitiesQuery.data ?? [] as ProjectEngineCapabilitiesDto[];
  const refreshCapabilities = useCallback(async (context?: { engineId?: string; model?: string; agentId?: string }) => {
    const discovered = await api.getEngineCapabilities(projectId, { ...context, refresh: true });
    queryClient.setQueryData(capabilityQueryKey, discovered);
    return discovered;
  }, [capabilityQueryKey, projectId, queryClient]);

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

  // Stable handlers let memoized messages survive health/notification refreshes.
  const openAgent = useEventCallback((agentId: string, view?: "technical" | "settings", technicalFocusId?: string) => view
    ? navigate({ kind: "agent", projectId, agentId, view, ...(technicalFocusId ? { technicalFocusId } : {}) })
    : navigate({ kind: "agent", projectId, agentId }));

  const openAgentReview = useEventCallback((agentId: string, executionId?: string) => {
    navigate({ kind: "review", projectId, agentId, ...(executionId ? { executionId } : {}), returnTo: routeToPath(route) });
  });

  const openAgentFileActivity = useEventCallback((agentId: string, file: ResponseFileActivityDto) => {
    if (file.executionId) {
      navigate({ kind: "review", projectId, agentId, path: file.path, executionId: file.executionId, returnTo: routeToPath(route) });
    } else if (file.artifactId) {
      navigate({ kind: "agent", projectId, agentId, focusTelemetry: { stream: "artifacts", id: file.artifactId } });
    } else {
      navigate({ kind: "review", projectId, agentId, path: file.path, executionId: file.executionId, returnTo: routeToPath(route) });
    }
  });

  const openProjectArtifact = (agentId: string, artifactId: string) => {
    navigate({ kind: "agent", projectId, agentId, focusTelemetry: { stream: "artifacts", id: artifactId } });
  };

  const loading = conversationsQuery.isLoading || agentsQuery.isLoading;
  const conversationsFailure = retainedDataFailure(
    conversationsQuery.data !== undefined,
    conversationsQuery.isError,
  );
  const agentsFailure = retainedDataFailure(
    agentsQuery.data !== undefined,
    agentsQuery.isError,
  );
  const routeAgentId = routeResources.agentId;
  const routeConversationId = routeResources.conversationId;
  const routeResourceLoading =
    (Boolean(routeAgentId) && agentsQuery.isLoading) ||
    (Boolean(routeConversationId) && conversationsQuery.isLoading);
  const routeResourceError =
    (Boolean(routeAgentId) && agentsFailure === "initial") ||
    (Boolean(routeConversationId) && conversationsFailure === "initial");
  const routeResourceUnavailable =
    (Boolean(routeAgentId) && agentsQuery.isSuccess && !agents.some(agent => agent.id === routeAgentId)) ||
    (Boolean(routeConversationId) && conversationsQuery.isSuccess && !conversations.some(conversation => conversation.id === routeConversationId));

  const retainedResourceError = (
    conversationsFailure === "refresh" ||
    agentsFailure === "refresh"
  );
  useReportWorkspaceRefresh(retainedResourceError ? "Some workspace data could not refresh. The last loaded data remains available." : undefined, () => {
    if (conversationsFailure === "refresh") void conversationsQuery.refetch();
    if (agentsFailure === "refresh") void agentsQuery.refetch();
  });


  if (routeResourceLoading) return <LinearProgress aria-label="Loading requested resource" />;
  if (routeResourceError) {
    return <Box sx={{ p: 2 }}><Alert severity="error" action={<Button onClick={() => {
      if (routeAgentId) void agentsQuery.refetch();
      if (routeConversationId) void conversationsQuery.refetch();
    }}>Retry</Button>}>The requested resource could not be checked.</Alert></Box>;
  }
  if (routeResourceUnavailable) {
    return <Box sx={{ p: 2 }}><Alert severity="warning" action={<Button onClick={() => navigate({ kind: "home" })}>Go Home</Button>}>This resource is unavailable in this Project.</Alert></Box>;
  }

  if (conversationsFailure === "initial" || agentsFailure === "initial") {
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
        initialView={route.urlDriven
          ? (route.view ?? route.channel ?? "main")
          : (route.view ?? route.channel)}
        onViewChange={view => navigate({
          kind: "conversation",
          projectId,
          conversationId: route.conversationId,
          ...(view === "main" ? {} : { view }),
        })}
        engines={projectEngines}
        engineCapabilities={engineCapabilities}
        onRefreshCapabilities={refreshCapabilities}
        statusByAgentId={statusByAgentId}
        healthByAgentId={healthByAgentId}
        projectAgents={agents}
        onOpenProject={() => navigate({ kind: "home" })}
        onOpenProjectBrowser={() => projectBrowser.open()}
        onOpenAgent={openAgent}
        onAgentsDeleted={(agentIds) =>
          agentIds.forEach(agentId =>
            onResourceDeleted?.({ kind: "agent", projectId, agentId }),
          )}
        onOpenReview={openAgentReview}
        onOpenAgentWork={(focusId) => navigate({ kind: "projectWork", projectId, conversationId: route.conversationId, ...(focusId ? { focusId } : {}) })}
        onOpenBrowser={(agentId, runId) => projectBrowser.openAgent?.(agentId, runId)}
        onOpenFileActivity={openAgentFileActivity}
        onNewAgent={(master, managerAgentId) => onCreate("agent", {
          projectId,
          conversationId: master.id,
          ...(managerAgentId ? { managerAgentId } : {}),
        })}
        preferences={preferences}
        onPreferences={onPreferences}
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
        initialView={route.view ?? (route.urlDriven ? "chat" : undefined)}
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
        onOpenProject={() => navigate({ kind: "home" })}
        onOpenAgent={openAgent}
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
        onOpenReview={(path, executionId) => navigate({ kind: "review", projectId, agentId: route.agentId, ...(path ? { path } : {}), ...(executionId ? { executionId } : {}), returnTo: routeToPath(route) })}
        onOpenBrowser={(runId) => projectBrowser.openAgent?.(route.agentId, runId)}
        onNewSubagent={openNewSubagent}
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
      conversationId={route.conversationId ?? browserAgent?.conversationId}
      projectId={projectId}
      open
      embedded
      request={browserRequest}
      onRequestHandled={onBrowserRequestHandled}
      backLabel="Back to Chats"
      onClose={() => navigate({ kind: "home" })}
    />
  );
  } else if (route.kind === "review") {
    const detail = reviewAgentQuery.data;
    const running = Boolean(detail?.runs?.some((run) => run.status === "running" || run.status === "compacting"));
    main = <WorkspaceReviewPane
      projectRoot={project.hostPath}
      agentId={route.agentId}
      files={detail?.changedFiles ?? []}
      running={running}
      initialPath={route.path}
      executionId={route.executionId}
      backLabel={routeReturnLabel(routeReturnTarget(route.returnTo, { kind: "agent", projectId, agentId: route.agentId }))}
      onBack={() => navigate(routeReturnTarget(route.returnTo, { kind: "agent", projectId, agentId: route.agentId }))}
    />;
  } else if (route.kind === "workspaceFile") {
    const fallback = workspaceFileReturnFallback(route, agents, conversations);
    const returnTarget = routeReturnTarget(route.returnTo, fallback);
    main = <WorkspaceFileView projectId={projectId} path={route.path} agentId={route.agentId} conversationId={route.conversationId} backLabel={routeReturnLabel(returnTarget)} onBack={() => navigate(returnTarget)} />;
  } else if (route.kind === "projectWork") {
    main = <AgentWorkInspector
      key={`${projectId}:${route.conversationId ?? ""}:${route.focusId ?? ""}`}
      open
      projectId={projectId}
      conversationId={route.conversationId}
      focus={route.focusId ? { id: route.focusId } : undefined}
      backLabel={route.conversationId ? "Back to Chat" : "Back to Chats"}
      onClose={() => navigate(route.conversationId ? { kind: "conversation", projectId, conversationId: route.conversationId } : { kind: "home" })}
    />;
  } else {
    main = assertNeverRoute(route);
  }


  // Workspace navigation is owned by App on every viewport. Mobile opens the
  // same project hierarchy in an AppBar drawer, so the former per-project list
  // and its title/engine chat-creation form must never become a second flow.
  if (isMobile) {
    return (
      <Box sx={{ width: "100%", maxWidth: "100%", height: "100%", maxHeight: "100%", minHeight: 0, minWidth: 0, overflow: "hidden", display: "grid", gridTemplateRows: "auto minmax(0, 1fr)" }}>
        {loading ? <LinearProgress /> : <Box />}
        <Box sx={{ height: "100%", minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "minmax(0, 1fr)" }}><WorkspaceErrorBoundary resetKey={routeToPath(route)} title="This Project view could not be displayed.">{main}</WorkspaceErrorBoundary></Box>
      </Box>
    );
  }

  return (
    <Box sx={{ width: "100%", maxWidth: "100%", height: "100%", maxHeight: "100%", minHeight: 0, minWidth: 0, overflow: "hidden", display: "grid", gridTemplateRows: "minmax(0, 1fr)" }}>
      <Box component="section" aria-label="Project workspace" sx={{ height: "100%", minHeight: 0, minWidth: 0, display: "grid", gridTemplateRows: "minmax(0, 1fr)", bgcolor: "background.default" }}><WorkspaceErrorBoundary resetKey={routeToPath(route)} title="This Project view could not be displayed.">{main}</WorkspaceErrorBoundary></Box>
    </Box>
  );
}
