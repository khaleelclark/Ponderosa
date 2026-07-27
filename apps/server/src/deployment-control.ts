import type { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import type {
  ActiveRun,
  AgentRuntimeAuthority,
  PersistentRuntime,
  PonderosaServer,
} from "./app-contracts.js";
import type { BrowserSessionManager } from "./browser-session-manager.js";
import type { ProviderUsageCache } from "./provider-usage-cache.js";

interface DeploymentControlContext {
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  activeRuns: Map<string, ActiveRun>;
  runtimeAuthorities: Map<string, AgentRuntimeAuthority>;
  liveSseClosures: Set<() => void>;
  projectBrowserGrants: Map<string, unknown>;
  browserSessions: BrowserSessionManager;
  projectBrowserSessions: BrowserSessionManager;
  providerUsage: ProviderUsageCache;
  setClosed(): void;
  pendingRuntimeAuthorityCount(authority: AgentRuntimeAuthority): number;
  teardownPersistentRuntimeInBackground(
    agentId: string,
    runtime: PersistentRuntime,
    reason: string,
  ): void;
}

export function createDeploymentControl(
  app: PonderosaServer,
  context: DeploymentControlContext,
) {
  const {
    store,
    coordinationV3,
    activeRuns,
    runtimeAuthorities,
    liveSseClosures,
    projectBrowserGrants,
    browserSessions,
    projectBrowserSessions,
    providerUsage,
    setClosed,
    pendingRuntimeAuthorityCount,
    teardownPersistentRuntimeInBackground,
  } = context;
  let deploymentDraining = false;
  let shutdownPrepared = false;
  app.prepareForShutdown = (): void => {
    if (shutdownPrepared) return;
    shutdownPrepared = true;
    setClosed();
    deploymentDraining = true;
    for (const closeStream of [...liveSseClosures]) {
      try {
        closeStream();
      } catch (error) {
        app.log.warn({ err: error }, "Ponderosa could not close a live event stream cleanly");
      }
    }
    app.server.closeIdleConnections();
  };
  const snapshot = () => {
    const schedulerRuns = coordinationV3.activeRunCount();
    const localRuns = activeRuns.size;
    const authorities = [...runtimeAuthorities.values()];
    const providerAuthorities = authorities.reduce((total, authority) => total + pendingRuntimeAuthorityCount(authority), 0)
      + providerUsage.pendingCount();
    const runtimeCleanupOperations = authorities.reduce((total, authority) =>
      total + Number(Boolean(authority.closing)) + authority.oneShots.size +
      Number(Boolean(authority.opening?.terminationOperation)), 0);
    const runtimeFailures = authorities.reduce((total, authority) => total +
      Number(Boolean(authority.opening?.lastError)) + Number(Boolean(authority.closing?.lastError)) +
      [...authority.oneShots.values()].filter((state) => Boolean(state.lastError)).length, 0);
    const browser = [browserSessions.authorityStatus(), projectBrowserSessions.authorityStatus()];
    const browserAuthorities = browser.reduce((total, status) =>
      total + status.openings + status.active + status.pendingCleanup, 0);
    const browserCleanupOperations = browser.reduce((total, status) => total + status.pendingCleanup, 0);
    const browserFailures = browser.reduce((total, status) => total + status.retainedFailures, 0);
    const projectCleanup = store.listPendingProjectDeletions();
    const committedProjectCleanup = store.listPendingProjectDeletionReceipts();
    const agentCleanup = store.listPendingAgentDeletionReceipts();
    const pendingCleanupOperations = runtimeCleanupOperations + browserCleanupOperations +
      projectCleanup.length + committedProjectCleanup.length + agentCleanup.length;
    const retainedTeardownFailures = runtimeFailures + browserFailures +
      projectCleanup.filter((entry) => Boolean(entry.lastError)).length +
      committedProjectCleanup.filter((entry) => Boolean(entry.lastError)).length +
      agentCleanup.filter((entry) => Boolean(entry.lastError)).length;
    const activeRunsCount = Math.max(schedulerRuns, localRuns);
    return {
      state: deploymentDraining ? "draining" as const : "accepting" as const,
      readyForRestart: deploymentDraining && activeRunsCount === 0 && providerAuthorities === 0 &&
        browserAuthorities === 0 && pendingCleanupOperations === 0 && retainedTeardownFailures === 0,
      activeRuns: activeRunsCount,
      schedulerRuns,
      localRuns,
      providerAuthorities,
      browserAuthorities,
      pendingCleanupOperations,
      retainedTeardownFailures,
    };
  };
  const drainIdleAuthorities = (): void => {
    if (!deploymentDraining || activeRuns.size > 0) return;
    for (const [agentId, authority] of runtimeAuthorities) {
      if (authority.reusable) teardownPersistentRuntimeInBackground(agentId, authority.reusable, "deployment drain");
    }
    projectBrowserGrants.clear();
    void browserSessions.closeAll("deployment_drain").catch((error) => {
      app.log.error({ err: error }, "Run browser deployment cleanup remains pending");
    });
    void projectBrowserSessions.closeAll("deployment_drain").catch((error) => {
      app.log.error({ err: error }, "Project browser deployment cleanup remains pending");
    });
  };
  return {
    isDraining: () => deploymentDraining,
    setDraining: (value: boolean) => { deploymentDraining = value; },
    snapshot,
    drainIdleAuthorities,
  };
}
