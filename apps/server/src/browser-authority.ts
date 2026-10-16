import { browserOwnerFromId, browserOwnerId, chatBrowserOwnerId } from "@ponderosa/core";
import type { AgentEvent, BrowserSessionDto, ProjectBrowserSessionDto } from "@ponderosa/core";
import { openManagedArtifactContent, AgentStore, type LogEvent, type StoredLogEvent } from "@ponderosa/agents";
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
import { recoverBrowserResidue } from "./browser-session-residue.js";

interface BrowserAuthorityContext {
  dataDir: string;
  browserServiceSocket?: string;
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
    dataDir: requestedDataDir,
    browserServiceSocket,
    driverFactory,
    store,
    activeRuns,
    publish,
    persistRuntimeEvent,
    logWarn,
    providerProcessAuthority,
    browserAdmissionAllowed,
  } = context;

  AgentStore.assertCurrent(store);
  const admission = store.stateAdmission();
  let dataDir: string;
  try { admission.assertRoot(requestedDataDir); dataDir = admission.dataDir; }
  finally { admission.close(); }

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
    const chatOwner = scope.owner?.kind === "chat" ? scope.owner.conversationId : borrowingAgent?.conversationId;
    if (owner === "operator" && (!chatOwner || !store.projectArtifactBelongsToConversation(artifactProjectId, artifactId, chatOwner))) {
      throw new BrowserSessionError("This file does not belong to the browser's Chat.", 403, "artifact_unauthorized");
    }
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
  const service = !driverFactory && browserServiceSocket ? new BrowserServiceClient(browserServiceSocket) : undefined;
  // Project browsers remain broker-owned on every platform. macOS and Windows
  // use the ordinary CDP view, but must still survive an application restart.
  const sharedFactory: BrowserDriverFactory = service
    ? (id, _console, spawned, event, launch) => service.driver(id, event, launch, false, spawned)
    : browserFactory;
  const projectBrowserSessions = new BrowserSessionManager(
    dataDir,
    sharedFactory,
    (scope, event) => {
      const grant = scope.owner ? projectBrowserGrants.get(browserOwnerId(scope.owner)) : undefined;
      if (!grant || scope.actorAgentId !== grant.agentId || scope.actorRunId !== grant.runId) {
        if (event.type === "browser_screenshot") {
          throw new Error("Project screenshot lost exact Run authority before publication");
        }
        return;
      }
      const run = activeRuns.get(grant.agentId);
      if (!run || run.runId !== grant.runId || store.getAgent(grant.agentId)?.conversationId !== run.conversationId ||
          (scope.owner?.kind === "chat" && run.conversationId !== scope.owner.conversationId)) {
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
    if (!agent || !run.conversationId || agent.conversationId !== run.conversationId) return undefined;
    const chat = store.getConversation(run.conversationId);
    if (!chat || chat.deletedAt || chat.projectId !== agent.projectId) return undefined;
    return {
      projectId: agent.projectId,
      owner: { version: 1, kind: "chat", conversationId: chat.id },
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
    const projectId = savedGrant?.agentId === agentId && (exactRunId === undefined || savedGrant.runId === exactRunId) ? "saved-browser" : agent ? chatBrowserOwnerId(agent.conversationId) : undefined;
    if (!projectId) return;
    const cleanupScope = (key: string) => projectBrowserSessions.get(key === "saved-browser" ? "project-browser:saved-browser" : key);
    for (const key of ["saved-browser", projectId]) {
      const retained = cleanupScope(key);
      if (retained) projectBrowserSessions.expireNextRun(retained, agentId, exactRunId);
    }
    const grant = projectBrowserGrants.get(projectId);
    if (!grant || grant.agentId !== agentId || (exactRunId !== undefined && grant.runId !== exactRunId)) return;
    const session = cleanupScope(projectId);
    if (!session) { projectBrowserGrants.delete(projectId); return; }
    const projectScope: BrowserScope = { ...session, hostCleanup: true };
    if (session?.status === "opening") {
      // An opening has no safe control handoff point. Close it and await its
      // retained process/lease cleanup before releasing the owner authority.
      await projectBrowserSessions.close(projectScope, reason);
    } else if (session?.status === "ready") {
      if (session.controlOwner === "agent") {
        try {
          await projectBrowserSessions.setControl(projectScope, "operator", session.controlEpoch);
        } catch (error) {
          // An operator may have completed the handoff while our queued call
          // held the old epoch. Never close their draft-bearing browser.
          if (projectBrowserGrants.get(projectId) !== grant) return;
          const current = projectBrowserSessions.get(projectScope.agentId);
          if (current?.id !== session.id || current.status !== "ready") throw error;
          if (current.controlOwner === "agent") {
            // Fence Agent input before retryable chooser/native cleanup. A
            // failure retains both the browser and its exact grant.
            await projectBrowserSessions.revokeAgentControl(projectScope);
          }
        }
      }
      if (projectBrowserGrants.get(projectId) !== grant) return;
      const current = projectBrowserSessions.get(projectScope.agentId);
      if (current?.id !== session.id || current.status !== "ready") {
        throw new BrowserSessionError("Project browser changed during Run handoff; operator recovery is required.", 409);
      }
      await projectBrowserSessions.setControl(projectScope, "operator", current.controlEpoch);
    }
    if (projectBrowserGrants.get(projectId) === grant) projectBrowserGrants.delete(projectId);
  }

  function closeRunBrowser(
    agentId: string,
    run: ActiveRun,
    reason: string,
  ): Promise<void> {
    const retained = browserSessions.get(agentId);
    const scope = browserScopeForRun(agentId, run) ?? (retained?.agentId === agentId && retained.runId === run.runId &&
      retained.conversationId === run.conversationId ? retained : undefined);
    return Promise.all([
      scope ? browserSessions.closeRun(scope, reason) : Promise.resolve(),
      releaseProjectBrowserGrant(agentId, reason, run.runId),
    ]).then(() => undefined);
  }

  function closeRunBrowserAfterRun(agentId: string, run: ActiveRun, reason: string): Promise<void> {
    // Run settlement must not become an unhandled rejection when a browser
    // handoff fails. The managers retain the browser and its cleanup blocker;
    // shutdown still uses the rejecting closeRunBrowser so it cannot drain.
    return closeRunBrowser(agentId, run, reason).catch((error) => {
      logWarn({ err: error, agentId, runId: run.runId, reason }, "Run browser cleanup remains pending; retry the retained browser handoff");
    });
  }

  async function closeAgentBrowsers(agentId: string, reason: string): Promise<void> {
    await releaseProjectBrowserGrant(agentId, reason);
    await browserSessions.closeAgent(agentId, reason);
  }

  function resolveBrowserOwnerId(id: string): string {
    if (id === "saved-browser") return id;
    const parsed = browserOwnerFromId(id);
    const conversationId = parsed?.kind === "chat" ? parsed.conversationId : store.getNamespaceOwnerConversationId(id);
    const chat = conversationId ? store.getConversation(conversationId) : undefined;
    if (!chat || chat.deletedAt || !store.getProject(chat.projectId)) {
      throw new BrowserSessionError("Explicit live Chat browser ownership is required. Retained legacy browsers remain unassigned; open a new Chat browser.", 409, "browser_owner_required");
    }
    return chatBrowserOwnerId(chat.id);
  }

  const projectBrowserScope = (id: string, grant?: { agentId: string; runId: string }): BrowserScope => {
    const key = resolveBrowserOwnerId(id);
    const owner = browserOwnerFromId(key)!;
    const chat = owner.kind === "chat" ? store.getConversation(owner.conversationId)! : undefined;
    if (grant) {
      const agent = store.getAgent(grant.agentId), run = activeRuns.get(grant.agentId);
      if (!agent || !run || run.runId !== grant.runId || run.conversationId !== agent.conversationId ||
          (chat && (agent.conversationId !== chat.id || agent.projectId !== chat.projectId)) ||
          (!chat && !browserProfiles.hasSavedBrowserAccess(agent.projectId, agent.id))) {
        throw new BrowserSessionError("Browser grant no longer owns the exact Agent, Run and Chat.", 403, "browser_owner_mismatch");
      }
    }
    return {
      projectId: chat?.projectId ?? "saved-browser", owner,
      agentId: key === "saved-browser" ? "project-browser:saved-browser" : key,
      runId: key === "saved-browser" ? "project:saved-browser" : `chat:v1:${chat!.id}`,
      ...(chat ? { conversationId: chat.id } : {}),
      ...(grant ? { actorAgentId: grant.agentId, actorRunId: grant.runId, artifactProjectId: store.getAgent(grant.agentId)!.projectId } : {}),
    };
  };

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
      projectId: session.projectId,
      owner: session.owner,
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
      // Recovery is an awaited startup obligation. Starting it from each
      // manager constructor allowed it to recreate residue directories after
      // teardown had already removed the data root.
      await recoverBrowserResidue(dataDir);
      if (service) await projectBrowserSessions.restoreRetained(await service.claim(), (id, _console, _spawned, event, launch) => service.driver(id, event, launch, true), dto => {
        if (!dto.owner || dto.owner.version !== 1) throw new Error("Retained browser custody is unassigned.");
        const key = browserOwnerId(dto.owner);
        if (dto.profileId && !browserProfiles.getProfile(key, dto.profileId)) throw new Error("Retained browser profile custody does not match.");
        return projectBrowserScope(key);
      });
    },
    browserScopeForRun,
    browserProfiles,
    browserSessions,
    closeAgentBrowsers,
    closeRunBrowser,
    closeRunBrowserAfterRun,
    projectBrowserDto,
    projectBrowserGrants,
    projectBrowserScope,
    resolveBrowserOwnerId,
    projectBrowserSessions,
  };
}
