import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentEvent } from "@ponderosa/core";
import {
  artifactContentPath,
  publishManagedArtifactContent,
  type AgentStore,
  type CoordinationV3Store,
  type LogEvent,
  type StoredLogEvent,
} from "@ponderosa/agents";
import type { AssetStore } from "./assets.js";
import type {
  ActiveRun,
  AgentMessageCapability,
  CreateServerOptions,
  PersistentRuntime,
  RuntimeOwnershipState,
} from "./app-contracts.js";
import { readWorkspaceArtifactFile } from "./project-file-access.js";

interface RuntimeEventAuthorityContext {
  opts: CreateServerOptions;
  activeRuns: Map<string, ActiveRun>;
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  coordinationV3WorkerId: string;
  assets: AssetStore;
  executionLeaseNow(): number;
  executionHeartbeatMs: number;
  executionLeaseMs: number;
  setExecutionLeaseTimer(callback: () => void, delayMs: number): NodeJS.Timeout;
  clearExecutionLeaseTimer(timer: NodeJS.Timeout): void;
  leaseExpiry(): string;
  ownsActiveRunForAuditDrain(agentId: string, run: ActiveRun): boolean;
  closeRunBrowser(agentId: string, run: ActiveRun, reason: string): Promise<void>;
  closeLinkPreviewsForAgent(agentId: string, reason: string): void;
  publish(agentId: string, stored: StoredLogEvent): void;
  publishMessageDeliveryChanged(agentId: string): void;
  notifyManagerOfChildFailure(agentId: string, executionId: string, failure: string): void;
  notifyScheduler(): void;
  isClosed(): boolean;
  logWarn(meta: Record<string, unknown>, message: string): void;
  drainDeploymentIdleAuthorities(): void;
  agentMessageCapabilities: Map<string, AgentMessageCapability>;
  scheduledSessionRollovers: Map<string, string>;
  persistentRuntimeForTermination(agentId: string): PersistentRuntime | undefined;
  teardownPersistentRuntimeInBackground(
    agentId: string,
    runtime: PersistentRuntime,
    reason: string,
  ): void;
  coordinationV3LeaseMs: number;
}

export function createRuntimeEventAuthority(context: RuntimeEventAuthorityContext) {
  const {
    opts,
    activeRuns,
    store,
    coordinationV3,
    coordinationV3WorkerId,
    assets,
    executionLeaseNow,
    executionHeartbeatMs,
    executionLeaseMs,
    setExecutionLeaseTimer,
    clearExecutionLeaseTimer,
    leaseExpiry,
    ownsActiveRunForAuditDrain,
    closeRunBrowser,
    closeLinkPreviewsForAgent,
    publish,
    publishMessageDeliveryChanged,
    notifyManagerOfChildFailure,
    notifyScheduler,
    isClosed,
    logWarn,
    drainDeploymentIdleAuthorities,
    agentMessageCapabilities,
    scheduledSessionRollovers,
    persistentRuntimeForTermination,
    teardownPersistentRuntimeInBackground,
    coordinationV3LeaseMs,
  } = context;

  function transitionRun(agentId: string, run: ActiveRun, state: RuntimeOwnershipState): boolean {
    if (!ownsActiveRunForAuditDrain(agentId, run)) return false;
    run.ownershipState = state;
    opts.runtimeEventFaults?.onOwnershipState?.({ agentId, runId: run.runId, generation: run.generation, state });
    return true;
  }

  function receiveRuntimeEvent(agentId: string, run: ActiveRun): boolean {
    if (!ownsActiveRunForAuditDrain(agentId, run) || run.ownershipState === "cancelling") return false;
    const at = new Date().toISOString();
    run.lastEventReceivedAt = at;
    return true;
  }

  async function waitBeforeRuntimePersist(agentId: string, run: ActiveRun, event: AgentEvent): Promise<boolean> {
    await opts.runtimeEventFaults?.beforePersist?.({ agentId, runId: run.runId, generation: run.generation, event });
    return ownsActiveRunForAuditDrain(agentId, run) && run.ownershipState !== "cancelling";
  }

  function persistRuntimeEvent(agentId: string, run: ActiveRun, event: LogEvent): StoredLogEvent | undefined {
    if (!ownsActiveRunForAuditDrain(agentId, run) || run.ownershipState === "cancelling") return undefined;
    const canonicalEvent = normalizeRuntimeFileChange(agentId, run, event);
    const stored = store.appendEvent(agentId, canonicalEvent);
    const at = new Date().toISOString();
    run.lastEventPersistedAt = at;
    const recovered = run.ownershipState === "stalled";
    if (recovered) {
      run.ownershipState = "running";
      opts.runtimeEventFaults?.onOwnershipState?.({ agentId, runId: run.runId, generation: run.generation, state: "running" });
    }
    publish(agentId, stored);
    if (canonicalEvent.type === "file_change" && canonicalEvent.kind !== "delete") {
      const agent = store.getAgent(agentId);
      const project = agent ? store.getProject(agent.projectId) : undefined;
      const mediaType = generatedArtifactMediaType(canonicalEvent.path, canonicalEvent.kind);
      if (agent && project && mediaType) {
        try {
          const source = readWorkspaceArtifactFile({
            rootPath: project.hostPath,
            requestedPath: canonicalEvent.path,
            purpose: "generated_capture",
            maxBytes: 64 * 1024 * 1024,
            requireNonEmpty: true,
            faults: opts.workspaceArtifactReadFaults,
          });
          if (!source) throw new Error("generated artifact is unavailable through the retained Project root");
          const body = source.body;
          const artifactId = randomUUID();
          const managedPath = `generated/${artifactId}${path.extname(source.name).toLowerCase()}`;
          const legacyDestination = artifactContentPath(opts.dataDir, agent.projectId, agent.id, managedPath);
          mkdirSync(path.dirname(legacyDestination), { recursive: true });
          writeFileSync(legacyDestination, body, { flag: "wx", mode: 0o600 });
          const publishedArtifact = publishManagedArtifactContent(opts.dataDir, agent.projectId, artifactId, body);
          const contentHash = publishedArtifact.sha256;
          const captured = store.appendEvent(agent.id, {
            type: "generated_artifact", artifactId, executionId: run.executionId, path: managedPath,
            sourcePath: canonicalEvent.path, name: source.name, mediaType, size: body.length,
            sha256: contentHash, visibility: "project",
          });
          const catalogArtifact = {
            id: artifactId, projectId: agent.projectId, agentId: agent.id, originAgentId: agent.id,
            executionId: run.executionId, kind: "generated_file", path: managedPath,
            sourcePath: canonicalEvent.path, summary: source.name, createdAt: captured.ts,
            mediaType, size: body.length, sha256: contentHash, visibility: "project" as const, pinned: false,
          } as const;
          assets.registerGeneratedArtifact(catalogArtifact);
          store.recordProjectArtifact(catalogArtifact);
          publish(agent.id, captured);
        } catch (error) {
          logWarn({ err: error, agentId, path: canonicalEvent.path }, "generated artifact capture skipped");
        }
      }
    }
    return stored;
  }

  function normalizeRuntimeFileChange(agentId: string, run: ActiveRun, event: LogEvent): LogEvent {
    if (event.type !== "file_change" || event.kind === "delete") return event;
    const agent = store.getAgent(agentId);
    const project = agent ? store.getProject(agent.projectId) : undefined;
    if (!project) return event;
    let kind = event.kind;
    try {
      const root = realpathSync(project.hostPath);
      const candidate = realpathSync(path.isAbsolute(event.path) ? event.path : path.resolve(root, event.path));
      if (candidate !== root && candidate.startsWith(`${root}${path.sep}`)) {
        const info = statSync(candidate);
        const runStartedAt = Date.parse(run.startedAt);
        if (kind === "edit" && info.birthtimeMs > 0 && Number.isFinite(runStartedAt) && info.birthtimeMs >= runStartedAt - 1_000) {
          kind = "create";
        }
      }
    } catch {
      // The canonical event remains useful even when the path disappeared or
      // cannot be inspected. Workspace confinement is enforced again during
      // managed-artifact capture.
    }
    const diff = normalizeProviderFileDiff(event.diff, kind, event.path);
    return {
      ...event,
      kind,
      ...(diff ? { diff } : {}),
    };
  }

  function normalizeProviderFileDiff(diff: string | undefined, kind: "create" | "edit" | "delete", file: string): string | undefined {
    if (!diff || kind !== "create" || /^(?:diff --git|--- |\+\+\+ |@@ )/mu.test(diff)) return diff;
    const content = diff.endsWith("\n") ? diff.slice(0, -1) : diff;
    const lines = content ? content.split(/\r?\n/u) : [];
    const displayPath = file.replaceAll("\\", "/");
    return [
      "--- /dev/null",
      `+++ b/${displayPath}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
    ].join("\n");
  }

  function generatedArtifactMediaType(file: string, changeKind: "create" | "edit" | "delete"): string | undefined {
    const extension = path.extname(file).toLowerCase();
    const durableMedia = ({
      ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    } as Record<string, string>)[extension];
    if (durableMedia) return durableMedia;
    // Text deliverables are common, but edits to source/config files should not
    // continually republish the whole repository into Project files.
    if (changeKind !== "create") return undefined;
    return ({
      ".md": "text/markdown", ".txt": "text/plain", ".csv": "text/csv",
      ".json": "application/json", ".html": "text/html", ".zip": "application/zip",
    } as Record<string, string>)[extension];
  }

  function clearRunLeaseTimer(run: ActiveRun): void {
    if (!run.leaseTimer) return;
    clearExecutionLeaseTimer(run.leaseTimer);
    run.leaseTimer = undefined;
  }

  function clearRunLivenessTimer(run: ActiveRun): void {
    if (!run.livenessTimer) return;
    clearExecutionLeaseTimer(run.livenessTimer);
    run.livenessTimer = undefined;
  }

  function scheduleRuntimeLivenessHeartbeat(agentId: string, run: ActiveRun): void {
    clearRunLivenessTimer(run);
    if (!run.runtimeSession) return;
    run.livenessTimer = setExecutionLeaseTimer(() => {
      run.livenessTimer = undefined;
      if (isClosed() || !ownsActiveRunForAuditDrain(agentId, run)) return;
      let alive = false;
      try { alive = run.runtimeSession?.isAlive() === true; } catch { /* failed liveness checks do not renew */ }
      if (!alive) return;
      if (renewExecutionLease(agentId, run)) scheduleRuntimeLivenessHeartbeat(agentId, run);
    }, executionHeartbeatMs);
    run.livenessTimer.unref?.();
  }

  function expireExecutionLease(agentId: string, run: ActiveRun): void {
    if (isClosed() || !ownsActiveRunForAuditDrain(agentId, run)) return;
    const remaining = Date.parse(run.leaseExpiresAt) - executionLeaseNow();
    if (remaining > 0) {
      run.leaseTimer = setExecutionLeaseTimer(() => expireExecutionLease(agentId, run), remaining);
      run.leaseTimer.unref?.();
      return;
    }

    // Delete the claim and revoke capabilities before aborting. Any synchronous
    // or late async continuation from this generation therefore fails its CAS.
    void closeRunBrowser(agentId, run, "run_lease_expired");
    activeRuns.delete(agentId);
    drainDeploymentIdleAuthorities();
    closeLinkPreviewsForAgent(agentId, "run lease expired");
    clearRunLeaseTimer(run);
    clearRunLivenessTimer(run);
    agentMessageCapabilities.delete(run.messageCapability);
    if (scheduledSessionRollovers.delete(agentId)) {
      const abandonedHandoff = store.continuationHandoffForRun(agentId, run.runId);
      if (abandonedHandoff && !abandonedHandoff.consumedAt) {
        store.consumeContinuationHandoff(agentId, abandonedHandoff.id, run.runId);
      }
    }
    try {
      coordinationV3.failRun({
        runId: run.v3SchedulerRunId!,
        fencingToken: run.v3FencingToken!,
        workerId: coordinationV3WorkerId,
        sameRunResumable: Boolean(run.runtimeSession?.isAlive()),
      });
    } catch { /* the advanced fence already rejects late runtime output */ }
    const lifecycle = store.appendEvent(agentId, {
      type: "agent_lifecycle", status: "failed", reason: "execution_lease_expired", executionId: run.executionId,
    });
    publish(agentId, lifecycle);
    publishMessageDeliveryChanged(agentId);
    notifyManagerOfChildFailure(agentId, run.executionId, "execution lease expired");
    const persistentRuntime = persistentRuntimeForTermination(agentId);
    if (persistentRuntime) {
      teardownPersistentRuntimeInBackground(agentId, persistentRuntime, "execution lease expiry");
    }
    run.controller.abort();
    notifyScheduler();
  }

  function renewExecutionLease(agentId: string, run: ActiveRun): boolean {
    if (!ownsActiveRunForAuditDrain(agentId, run)) return false;
    clearRunLeaseTimer(run);
    run.leaseExpiresAt = leaseExpiry();
    run.leaseTimer = setExecutionLeaseTimer(() => expireExecutionLease(agentId, run), executionLeaseMs);
    run.leaseTimer.unref?.();
    if (run.v3SchedulerRunId && run.v3FencingToken !== undefined) {
      coordinationV3.renewLease(
        run.v3SchedulerRunId,
        run.v3FencingToken,
        coordinationV3WorkerId,
        coordinationV3LeaseMs,
      );
    }
    return true;
  }

  function claimActiveRun(agentId: string, run: ActiveRun): void {
    activeRuns.set(agentId, run);
    renewExecutionLease(agentId, run);
  }

  function releaseActiveRun(agentId: string, run: ActiveRun, state: "completed" | "failed" | "cancelled"): boolean {
    if (activeRuns.get(agentId) !== run || !run.v3SchedulerRunId || run.v3FencingToken === undefined ||
        !coordinationV3.ownsRunForCleanup(run.v3SchedulerRunId, run.v3FencingToken, coordinationV3WorkerId)) return false;
    void closeRunBrowser(agentId, run, `run_${state}`);
    activeRuns.delete(agentId);
    drainDeploymentIdleAuthorities();
    closeLinkPreviewsForAgent(agentId, `run ${state}`);
    clearRunLeaseTimer(run);
    clearRunLivenessTimer(run);
    return true;
  }

  return {
    claimActiveRun,
    clearRunLeaseTimer,
    clearRunLivenessTimer,
    generatedArtifactMediaType,
    normalizeProviderFileDiff,
    normalizeRuntimeFileChange,
    persistRuntimeEvent,
    receiveRuntimeEvent,
    releaseActiveRun,
    renewExecutionLease,
    scheduleRuntimeLivenessHeartbeat,
    transitionRun,
    waitBeforeRuntimePersist,
  };
}
