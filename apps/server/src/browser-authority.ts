import type { AgentEvent, BrowserSessionDto, ProjectBrowserSessionDto } from "@ponderosa/core";
import { openManagedArtifactContent, type AgentStore, type LogEvent, type StoredLogEvent } from "@ponderosa/agents";
import {
  BrowserSessionError,
  BrowserSessionManager,
  type BrowserScope,
} from "./browser-session-manager.js";
import { playwrightBrowserDriverFactory, type BrowserDriverFactory } from "./chrome-cdp-driver.js";
import type { ActiveRun } from "./app-contracts.js";
import type { ProviderProcessAuthority } from "./provider-process-authority.js";
import { BrowserProfileAuthority } from "./browser-profile-authority.js";
import { BrowserServiceClient } from "./browser-service.js";

interface BrowserAuthorityContext {
  dataDir: string;
  driverFactory?: BrowserDriverFactory;
  store: AgentStore;
  activeRuns: ReadonlyMap<string, ActiveRun>;
  publish(agentId: string, stored: StoredLogEvent): void;
  logWarn(meta: Record<string, unknown>, message: string): void;
  persistRuntimeEvent(
    agentId: string,
    run: ActiveRun,
    event: LogEvent | AgentEvent,
  ): Promise<StoredLogEvent | undefined>;
  providerProcessAuthority: ProviderProcessAuthority;
  browserAdmissionAllowed(scope: BrowserScope): boolean;
}

export function durableBrowserDriverFactory(
  factory: BrowserDriverFactory,
  register: (handle: Parameters<NonNullable<Parameters<BrowserDriverFactory>[2]>>[0], sessionId: string) => void,
): BrowserDriverFactory {
  return (sessionId, onConsole, onSpawned, onPageEvent, launch) => factory(sessionId, onConsole, (handle, options) => {
    if (handle.processIdentity) register(handle, sessionId);
    onSpawned?.(handle, options);
  }, onPageEvent, launch);
}

export function createBrowserAuthority(context: BrowserAuthorityContext) {
  const {
    dataDir,
    driverFactory,
    store,
    activeRuns,
    publish,
    persistRuntimeEvent,
    logWarn,
    providerProcessAuthority,
    browserAdmissionAllowed,
  } = context;

  const browserFactory = durableBrowserDriverFactory(
    driverFactory ?? playwrightBrowserDriverFactory(dataDir),
    (handle, sessionId) => providerProcessAuthority.register(handle, {
      purpose: `browser session ${sessionId}`,
    }),
  );
  const browserProfiles = new BrowserProfileAuthority(dataDir);

  const resolveUploadArtifact = async (
    scope: BrowserScope,
    owner: import("@ponderosa/core").BrowserControlOwner,
    artifactId: string,
  ) => {
    const savedGrant = scope.projectId === "saved-browser" ? projectBrowserGrants.get("saved-browser") : undefined;
    const borrowingAgent = savedGrant && scope.actorAgentId === savedGrant.agentId && scope.actorRunId === savedGrant.runId ? store.getAgent(savedGrant.agentId) : undefined;
    const artifactProjectId = borrowingAgent?.projectId ?? scope.projectId;
    const artifact = store.getProjectArtifact(artifactProjectId, artifactId);
    if (!artifact) {
      throw new BrowserSessionError("Managed artifact was not found.", 404, "artifact_not_found");
    }
    const actorAgentId = scope.actorAgentId ?? scope.agentId;
    const canRead = owner === "operator"
      ? store.operatorCanReadProjectArtifact(artifactProjectId, artifactId)
      : store.agentCanReadProjectArtifact(artifactProjectId, artifactId, actorAgentId);
    if (!canRead) {
      throw new BrowserSessionError("This actor cannot read the managed artifact.", 403, "artifact_unauthorized");
    }
    if (!artifact.size || !artifact.sha256 || !artifact.mediaType) {
      throw new BrowserSessionError("Managed artifact metadata is incomplete.", 409, "artifact_content_changed");
    }
    const content = await openManagedArtifactContent(
      dataDir,
      artifactProjectId,
      artifactId,
      artifact.size,
      artifact.sha256,
    );
    if (!content) {
      throw new BrowserSessionError("Managed artifact content is unavailable.", 409, "artifact_content_changed");
    }
    return { artifact, content };
  };

  const browserSessions = new BrowserSessionManager(
    dataDir,
    browserFactory,
    (scope, event) => {
      const run = activeRuns.get(scope.agentId);
      if (!run || run.runId !== scope.runId || run.conversationId !== scope.conversationId) {
        if (event.type === "browser_screenshot") {
          throw new Error("screenshot lost exact Run authority before publication");
        }
        return;
      }
      // Cancellation advances the scheduler fence before provider/browser
      // interruption. The server-owned close audit is still valid for the exact
      // in-memory Run even though late runtime/browser activity must now fail.
      if (event.type === "browser_session" && event.status === "closed") {
        publish(scope.agentId, store.appendEvent(scope.agentId, event));
        return;
      }
      if (event.type === "browser_screenshot") {
        return persistRuntimeEvent(scope.agentId, run, event).then((stored) => {
          if (!stored) throw new Error("screenshot lost exact Run authority before publication");
        }).catch((error: unknown) => {
          logWarn(
            { err: error, agentId: scope.agentId, runId: scope.runId },
            "browser screenshot publication failed",
          );
          throw error;
        });
      }
      void persistRuntimeEvent(scope.agentId, run, event).catch((error: unknown) => {
        logWarn(
          { err: error, agentId: scope.agentId, runId: scope.runId },
          "browser runtime event persistence failed",
        );
      });
    },
    resolveUploadArtifact,
    browserProfiles,
    browserAdmissionAllowed,
  );
  const projectBrowserGrants = new Map<string, { agentId: string; runId: string }>();
  const service = !driverFactory && process.env.PONDEROSA_BROWSER_SERVICE_SOCKET ? new BrowserServiceClient(process.env.PONDEROSA_BROWSER_SERVICE_SOCKET) : undefined;
  const sharedFactory: BrowserDriverFactory = service ? (id, console, spawned, event, launch) => launch?.nativeManual
    ? service.driver(id, event, launch)
    : browserFactory(id, console, spawned, event, launch) : browserFactory;
  const projectBrowserSessions = new BrowserSessionManager(
    dataDir,
    sharedFactory,
    (scope, event) => {
      const grant = projectBrowserGrants.get(scope.projectId);
      if (!grant || scope.actorAgentId !== grant.agentId || scope.actorRunId !== grant.runId) {
        if (event.type === "browser_screenshot") {
          throw new Error("Project screenshot lost exact Run authority before publication");
        }
        return;
      }
      const run = activeRuns.get(grant.agentId);
      if (!run || run.runId !== grant.runId) {
        if (event.type === "browser_screenshot") {
          throw new Error("Project screenshot lost exact Run authority before publication");
        }
        return;
      }
      if (event.type === "browser_screenshot") {
        return persistRuntimeEvent(
          grant.agentId,
          run,
          { ...event, executionId: grant.runId },
        ).then((stored) => {
          if (!stored) throw new Error("screenshot lost exact Run authority before publication");
        }).catch((error: unknown) => {
          logWarn(
            { err: error, agentId: grant.agentId, runId: grant.runId },
            "Project browser screenshot publication failed",
          );
          throw error;
        });
      }
      void persistRuntimeEvent(
        grant.agentId,
        run,
        { ...event, executionId: grant.runId },
      ).catch((error: unknown) => {
        logWarn(
          { err: error, agentId: grant.agentId, runId: grant.runId },
          "Project browser runtime event persistence failed",
        );
      });
    },
    resolveUploadArtifact,
    browserProfiles,
    browserAdmissionAllowed,
    Boolean(service),
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

  async function releaseProjectBrowserGrant(
    agentId: string,
    reason: string,
    exactRunId?: string,
  ): Promise<void> {
    const agent = store.getAgent(agentId);
    const savedGrant = projectBrowserGrants.get("saved-browser");
    const projectId = savedGrant?.agentId === agentId && (exactRunId === undefined || savedGrant.runId === exactRunId) ? "saved-browser" : agent?.projectId;
    if (!projectId) return;
    projectBrowserSessions.expireNextRun(projectBrowserScope("saved-browser"), agentId, exactRunId);
    projectBrowserSessions.expireNextRun(projectBrowserScope(projectId), agentId, exactRunId);
    const grant = projectBrowserGrants.get(projectId);
    if (!grant || grant.agentId !== agentId || (exactRunId !== undefined && grant.runId !== exactRunId)) return;
    projectBrowserGrants.delete(projectId);
    const projectScope = projectBrowserScope(projectId);
    const session = projectBrowserSessions.get(projectScope.agentId);
    if (session?.status === "opening") {
      // An opening has no safe control handoff point. Close it and await its
      // retained process/lease cleanup before releasing the owner authority.
      await projectBrowserSessions.close(projectScope, reason);
    } else if (session?.status === "ready" && session.controlOwner === "agent") {
      try {
        await projectBrowserSessions.setControl(projectScope, "operator", session.controlEpoch);
      } catch {
        // A browser whose former controller cannot be returned safely is
        // closed rather than left stranded under a removed grant.
        await projectBrowserSessions.close(projectScope, reason);
      }
    }
  }

  function closeRunBrowser(
    agentId: string,
    run: ActiveRun,
    reason: string,
  ): Promise<void> {
    const scope = browserScopeForRun(agentId, run);
    return Promise.all([
      scope ? browserSessions.closeRun(scope, reason) : Promise.resolve(),
      releaseProjectBrowserGrant(agentId, reason, run.runId),
    ]).then(() => undefined);
  }

  async function closeAgentBrowsers(agentId: string, reason: string): Promise<void> {
    await releaseProjectBrowserGrant(agentId, reason);
    await browserSessions.closeAgent(agentId, reason);
  }

  const projectBrowserScope = (projectId: string, grant?: { agentId: string; runId: string }): BrowserScope => ({
    projectId,
    agentId: `project-browser:${projectId}`,
    runId: `project:${projectId}`,
    ...(grant ? { actorAgentId: grant.agentId, actorRunId: grant.runId } : {}),
  });

  const projectBrowserDto = (projectId: string, session: BrowserSessionDto): ProjectBrowserSessionDto => {
    const grant = projectBrowserGrants.get(projectId);
    const ready = session.status === "ready";
    return {
      id: session.id,
      nextRunAgentId: session.nextRunAgentId,
      profileMode: session.profileMode,
      location: session.location,
      localPaused: session.localPaused,
      manualControl: session.manualControl,
      privateSignIn: session.privateSignIn,
      projectId,
      status: session.status,
      // A process that is not ready has no usable controller. Normalize the
      // persisted session projection instead of asking every client to
      // reinterpret stale control metadata after a reload.
      controlOwner: ready ? session.controlOwner : "operator",
      ...(ready && grant ? { controllerAgentId: grant.agentId, controllerRunId: grant.runId } : {}),
      ...(ready && grant ? { controllerAgentTitle: store.getAgent(grant.agentId)?.title, controllerProjectId: store.getAgent(grant.agentId)?.projectId } : {}),
      controlEpoch: session.controlEpoch,
      capabilities: session.capabilities,
      ...(session.url ? { url: session.url } : {}),
      ...(session.title ? { title: session.title } : {}),
      ...(session.activePageId ? { activePageId: session.activePageId } : {}),
      pages: session.pages,
      pageRevision: session.pageRevision,
      ...(session.pendingFileChooser ? { pendingFileChooser: session.pendingFileChooser } : {}),
      frameRevision: session.frameRevision,
      openedAt: session.openedAt,
      updatedAt: session.updatedAt,
      ...(session.failure ? { failure: session.failure } : {}),
    };
  };

  return {
    restoreSharedBrowsers: async () => {
      if (service) await projectBrowserSessions.restoreRetained(await service.claim(), (id, _console, _spawned, event) => service.driver(id, event, undefined, true), dto => {
        // Profile promotion commits before its projection checkpoint. Recover
        // ownership from that transaction if the app stopped between the two.
        if (dto.profileId && browserProfiles.savedBrowser()?.profileId === dto.profileId) return projectBrowserScope("saved-browser");
        if (!store.getProject(dto.projectId)) throw new Error("Retained browser belongs to an unavailable chat; explicit cleanup is required.");
        return projectBrowserScope(dto.projectId);
      });
    },
    browserScopeForRun,
    browserProfiles,
    browserSessions,
    closeAgentBrowsers,
    closeRunBrowser,
    projectBrowserDto,
    projectBrowserGrants,
    projectBrowserScope,
    projectBrowserSessions,
  };
}
