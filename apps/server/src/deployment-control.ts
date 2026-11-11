import type { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import type { ReadinessDto } from "@ponderosa/core";
import type {
  ActiveRun,
  AgentRuntimeAuthority,
  PersistentRuntime,
  PonderosaServer,
} from "./app-contracts.js";
import type { BrowserSessionManager } from "./browser-session-manager.js";
import type { ProviderUsageCache } from "./provider-usage-cache.js";
import { browserResidueCleanupBlockers, browserResidueCleanupStatus } from "./browser-session-residue.js";

interface DeploymentControlContext {
  dataDir: string;
  startDrained?: boolean;
  workflowStatus?():{authorities:number;pendingCleanupOperations:number;retainedTeardownFailures:number;blockers:ReadinessDto['deploymentDrain']['blockers']}|undefined;
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
    dataDir,
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
  let deploymentDraining = context.startDrained ?? false;
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
  const snapshot = (): ReadinessDto["deploymentDrain"] => {
    const workflow=context.workflowStatus?.()??{authorities:0,pendingCleanupOperations:0,retainedTeardownFailures:0,blockers:[]};
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
    const browser = [browserSessions.authorityStatus(), projectBrowserSessions.authorityStatus(deploymentDraining)];
    const browserAuthorities = browser.reduce((total, status) =>
      total + status.openings + status.active + status.pendingCleanup, 0);
    const browserCleanupOperations = browser.reduce((total, status) => total + status.pendingCleanup, 0);
    const browserFailures = browser.reduce((total, status) => total + status.retainedFailures, 0);
    const projectCleanup = store.listPendingProjectDeletions();
    const committedProjectCleanup = store.listPendingProjectDeletionReceipts();
    const agentCleanup = store.listPendingAgentDeletionReceipts();
    const browserResidue = browserResidueCleanupStatus(dataDir);
    const pendingCleanupOperations = runtimeCleanupOperations + browserCleanupOperations + browserResidue.pending +
      projectCleanup.length + committedProjectCleanup.length + agentCleanup.length + workflow.pendingCleanupOperations;
    const retainedTeardownFailures = runtimeFailures + browserFailures + browserResidue.failed +
      projectCleanup.filter((entry) => Boolean(entry.lastError)).length +
      committedProjectCleanup.filter((entry) => Boolean(entry.lastError)).length +
      agentCleanup.filter((entry) => Boolean(entry.lastError)).length + workflow.retainedTeardownFailures;
    const activeRunsCount = Math.max(schedulerRuns, localRuns);
    const blockers: ReadinessDto["deploymentDrain"]["blockers"] = [];
    if (schedulerRuns > 0) blockers.push({
      kind: "run",
      reason: `${schedulerRuns} active scheduler Run lease(s); ${localRuns} represented by this process`,
      status: "scheduler",
    });
    for (const [agentId, run] of activeRuns) blockers.push({
      kind: "run",
      reason: "active local Run",
      agentId,
      runId: run.runId,
      id: run.executionId,
      status: run.ownershipState,
    });
    for (const [agentId, authority] of runtimeAuthorities) {
      const reasons = [
        authority.opening ? "provider opening" : undefined,
        authority.closing ? `provider cleanup${authority.closing.lastError ? ` failed: ${authority.closing.lastError}` : " pending"}` : undefined,
        authority.oneShots.size ? `${authority.oneShots.size} one-shot provider cleanup(s)` : undefined,
      ].filter((reason): reason is string => Boolean(reason));
      if (reasons.length > 0) blockers.push({ kind: "provider", reason: reasons.join("; "), agentId });
    }
    if (providerUsage.pendingCount() > 0) blockers.push({
      kind: "provider",
      reason: `${providerUsage.pendingCount()} provider usage request(s) pending`,
    });
    blockers.push(
      ...workflow.blockers,
      ...browserSessions.authorityBlockers("run_browser"),
      ...projectBrowserSessions.authorityBlockers("project_browser", deploymentDraining),
      ...browserResidueCleanupBlockers(dataDir).map((reason) => ({ kind: "browser_residue" as const, reason })),
      ...projectCleanup.map((entry) => ({ kind: "project_cleanup" as const, reason: entry.lastError ? `cleanup failed: ${entry.lastError}` : "cleanup pending", projectId: entry.projectId })),
      ...committedProjectCleanup.map((entry) => ({ kind: "project_cleanup" as const, reason: entry.lastError ? `cleanup failed: ${entry.lastError}` : "cleanup receipt pending", projectId: entry.projectId })),
      ...agentCleanup.map((entry) => ({ kind: "agent_cleanup" as const, reason: entry.lastError ? `cleanup failed: ${entry.lastError}` : "cleanup receipt pending", projectId: entry.projectId, id: entry.id })),
    );
    return {
      state: deploymentDraining ? "draining" as const : "accepting" as const,
      readyForRestart: deploymentDraining && activeRunsCount === 0 && workflow.authorities === 0 && providerAuthorities === 0 &&
        browserAuthorities === 0 && pendingCleanupOperations === 0 && retainedTeardownFailures === 0,
      activeRuns: activeRunsCount,
      schedulerRuns,
      localRuns,
      workflowAuthorities:workflow.authorities,
      providerAuthorities,
      browserAuthorities,
      pendingCleanupOperations,
      retainedTeardownFailures,
      blockers: blockers.slice(0, 50),
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
