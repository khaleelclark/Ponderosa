import type { AgentEvent, BrowserSessionDto, ProjectBrowserSessionDto } from "@ponderosa/core";
import type { AgentStore, LogEvent, StoredLogEvent } from "@ponderosa/agents";
import {
  BrowserSessionManager,
  chromeBrowserDriverFactory,
  type BrowserDriverFactory,
  type BrowserScope,
} from "./browser-session-manager.js";
import type { ActiveRun } from "./app-contracts.js";

interface BrowserAuthorityContext {
  dataDir: string;
  driverFactory?: BrowserDriverFactory;
  store: AgentStore;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  publish(agentId: string, stored: StoredLogEvent): void;
  persistRuntimeEvent(
    agentId: string,
    run: ActiveRun,
    event: LogEvent | AgentEvent,
  ): Promise<StoredLogEvent | undefined>;
}

export function createBrowserAuthority(context: BrowserAuthorityContext) {
  const { dataDir, driverFactory, store, activeRuns, publish, persistRuntimeEvent } = context;

  const browserSessions = new BrowserSessionManager(
    dataDir,
    driverFactory ?? chromeBrowserDriverFactory(dataDir),
    (scope, event) => {
      const run = activeRuns.get(scope.agentId);
      if (!run || run.runId !== scope.runId || run.conversationId !== scope.conversationId) return;
      // Cancellation advances the scheduler fence before provider/browser
      // interruption. The server-owned close audit is still valid for the exact
      // in-memory Run even though late runtime/browser activity must now fail.
      if (event.type === "browser_session" && event.status === "closed") {
        publish(scope.agentId, store.appendEvent(scope.agentId, event));
        return;
      }
      void persistRuntimeEvent(scope.agentId, run, event);
    },
  );
  const projectBrowserGrants = new Map<string, { agentId: string; runId: string }>();
  const projectBrowserSessions = new BrowserSessionManager(
    dataDir,
    driverFactory ?? chromeBrowserDriverFactory(dataDir),
    (scope, event) => {
      const grant = projectBrowserGrants.get(scope.projectId);
      if (!grant || scope.actorAgentId !== grant.agentId || scope.actorRunId !== grant.runId) return;
      const run = activeRuns.get(grant.agentId);
      if (!run || run.runId !== grant.runId) return;
      void persistRuntimeEvent(grant.agentId, run, { ...event, executionId: grant.runId });
    },
  );

  function browserScopeForRun(agentId: string, run: ActiveRun): BrowserScope | undefined {
    const agent = store.getAgent(agentId);
    if (!agent) return undefined;
    return {
      projectId: agent.projectId,
      agentId,
      runId: run.runId,
      ...(run.conversationId ? { conversationId: run.conversationId } : {}),
    };
  }

  function closeRunBrowser(
    agentId: string,
    run: ActiveRun,
    reason: string,
  ): Promise<void> {
    const scope = browserScopeForRun(agentId, run);
    const releaseProjectBrowser = async (): Promise<void> => {
      const agent = store.getAgent(agentId);
      const projectId = agent?.projectId;
      if (!projectId) return;
      const grant = projectBrowserGrants.get(projectId);
      if (!grant || grant.agentId !== agentId || grant.runId !== run.runId) return;
      projectBrowserGrants.delete(projectId);
      const projectScope = projectBrowserScope(projectId);
      const session = projectBrowserSessions.get(projectScope.agentId);
      if (session?.status === "ready" && session.controlOwner === "agent") {
        await projectBrowserSessions.setControl(projectScope, "operator", session.controlEpoch).catch(() => undefined);
      }
    };
    return Promise.all([
      scope ? browserSessions.closeRun(scope, reason) : Promise.resolve(),
      releaseProjectBrowser(),
    ]).then(() => undefined);
  }

  const projectBrowserScope = (projectId: string, grant?: { agentId: string; runId: string }): BrowserScope => ({
    projectId,
    agentId: `project-browser:${projectId}`,
    runId: `project:${projectId}`,
    ...(grant ? { actorAgentId: grant.agentId, actorRunId: grant.runId } : {}),
  });

  const projectBrowserDto = (projectId: string, session: import("@ponderosa/core").BrowserSessionDto): ProjectBrowserSessionDto => {
    const grant = projectBrowserGrants.get(projectId);
    return {
      id: session.id,
      projectId,
      status: session.status,
      controlOwner: session.controlOwner,
      ...(grant ? { controllerAgentId: grant.agentId, controllerRunId: grant.runId } : {}),
      controlEpoch: session.controlEpoch,
      ...(session.url ? { url: session.url } : {}),
      ...(session.title ? { title: session.title } : {}),
      frameRevision: session.frameRevision,
      openedAt: session.openedAt,
      updatedAt: session.updatedAt,
      ...(session.failure ? { failure: session.failure } : {}),
    };
  };

  return {
    browserScopeForRun,
    browserSessions,
    closeRunBrowser,
    projectBrowserDto,
    projectBrowserGrants,
    projectBrowserScope,
    projectBrowserSessions,
  };
}
