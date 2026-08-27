import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import type { FastifyReply } from "fastify";
import {
  type EngineLogDto,
  type CommunicationReconciliationReport,
  type ReadinessCheckDto,
  type ReadinessDto,
} from "@ponderosa/core";
import type {
  AgentStore,
  CoordinationV3Store,
} from "@ponderosa/agents";
import type {
  ActiveRun,
  CreateServerOptions,
  EngineRegistration,
  PonderosaServer,
} from "../app-contracts.js";
import type { CoordinationV3Scheduler } from "../coordination-v3-scheduler.js";
import type { ServerContext } from "../server-context.js";
import { registerHealthRoutes } from "./health.js";
import { applyCollectionPageHeaders, sendCollectionPageError, sqliteCollectionPage, type CollectionQuery } from "../collection-page.js";
import { projectedProjectCount } from "../readiness.js";
import { writeLauncherShutdownReceipt } from "../launcher-shutdown-receipt.js";
import { processBirthMarker } from "@ponderosa/engines";
import { browserResidueCleanupStatus } from "../browser-session-residue.js";

interface ServerControlRoutesContext {
  opts: CreateServerOptions;
  serverContext: ServerContext;
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  engines: ReadonlyMap<string, EngineRegistration>;
  activeRuns: Map<string, ActiveRun>;
  launcherNow(): number;
  launcherRandomToken(): string;
  launcherBootstrapTtlMs: number;
  launcherSessionTtlMs: number;
  launcherBootstraps: Map<string, number>;
  launcherSessions: Map<string, number>;
  purgeLauncherSecurityState(): void;
  networkSecurity: ReadinessDto["networkSecurity"];
  artifactFilesystem: ReadinessCheckDto;
  processContainment: ReadinessCheckDto;
  artifactFilesystemError(): string | undefined;
  communicationReconciliation: Map<string, {
    state: "pending";
  } | {
    state: "verified";
    report: CommunicationReconciliationReport;
  }>;
  coordinationV3Scheduler: CoordinationV3Scheduler;
  isClosed(): boolean;
  setDeploymentDraining(value: boolean): void;
  deploymentDrainSnapshot(): ReadinessDto["deploymentDrain"];
  drainDeploymentIdleAuthorities(): void;
  refreshTriggerSources(): Promise<void>;
  runtimeStatus(
    id: string,
    registration: EngineRegistration,
  ): Promise<{
    configured: true;
    authentication: "authenticated" | "unauthenticated" | "error";
    intakeReady: boolean;
    reachability: "unverified" | "reachable" | "degraded";
    authDetail?: string;
    availabilityDetail?: string;
  }>;
}

const ENGINE_LOG_TAIL_BYTES = 64 * 1024;
const READINESS_RUNTIME_BUDGET_MS = 500;

async function engineLogTail(
  pathname: string | undefined,
  stream: EngineLogDto["stream"],
): Promise<EngineLogDto> {
  if (!pathname) {
    return {
      stream,
      text: "",
      totalBytes: 0,
      returnedBytes: 0,
      truncated: false,
    };
  }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(pathname, "r");
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - ENGINE_LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(stat.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return {
      stream,
      text,
      totalBytes: stat.size,
      returnedBytes: Buffer.byteLength(text),
      truncated: start > 0,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        stream,
        text: "",
        totalBytes: 0,
        returnedBytes: 0,
        truncated: false,
      };
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export function registerServerControlRoutes(
  app: PonderosaServer,
  context: ServerControlRoutesContext,
): void {
  const {
    opts,
    serverContext,
    store,
    coordinationV3,
    engines,
    activeRuns,
    launcherNow,
    launcherRandomToken,
    launcherBootstrapTtlMs,
    launcherSessionTtlMs,
    launcherBootstraps,
    launcherSessions,
    purgeLauncherSecurityState,
    networkSecurity,
    artifactFilesystem,
    processContainment,
    artifactFilesystemError,
    communicationReconciliation,
    coordinationV3Scheduler,
    isClosed,
    setDeploymentDraining,
    deploymentDrainSnapshot,
    drainDeploymentIdleAuthorities,
    refreshTriggerSources,
    runtimeStatus,
  } = context;

registerHealthRoutes(app, serverContext);

app.get(
  "/api/launcher/status",
  { logLevel: "silent" },
  async () => ({
    service: "ponderosa",
    pid: process.pid,
    dataDir: opts.dataDir,
    version: opts.buildVersion?.trim() || "0.0.0",
    commit: opts.buildRevision?.trim() || "development",
    channel: opts.releaseChannel?.trim() || "development",
    acceptingDurableIntake: !isClosed() && artifactFilesystem.ok && processContainment.ok,
    leasingRuns: coordinationV3Scheduler.isLeasingRuns(),
    activeRunCount: activeRuns.size,
  }),
);

app.get<{ Querystring: { stream?: string } }>(
  "/api/launcher/logs",
  { logLevel: "silent" },
  async (request, reply) => {
    const stream = request.query.stream;
    if (stream !== "server" && stream !== "error") {
      return reply.code(400).send({ error: "stream must be server or error" });
    }
    const filename = stream === "server" ? "server.log" : "server-error.log";
    const pathname = opts.launcherDataDir
      ? path.join(opts.launcherDataDir, "logs", filename)
      : undefined;
    reply.header("Cache-Control", "no-store");
    return engineLogTail(pathname, stream);
  },
);

app.post("/api/launcher/bootstrap", async (_request, reply) => {
  reply.header("Cache-Control", "no-store");
  purgeLauncherSecurityState();
  const token = launcherRandomToken();
  launcherBootstraps.set(token, launcherNow() + launcherBootstrapTtlMs);
  return { token, expiresInMs: launcherBootstrapTtlMs };
});

app.post<{ Body: { token?: string } }>("/api/launcher/session-exchange", async (request, reply) => {
  reply.header("Cache-Control", "no-store");
  if (!opts.launcherSecurity) return reply.code(404).send({ error: "launcher session bootstrap is disabled" });
  purgeLauncherSecurityState();
  const token = request.body?.token;
  const expiresAt = typeof token === "string" ? launcherBootstraps.get(token) : undefined;
  if (!token || !expiresAt || expiresAt <= launcherNow()) {
    if (token) launcherBootstraps.delete(token);
    return reply.code(401).send({ error: "browser bootstrap is invalid or expired" });
  }
  // Consume before issuing the browser session. Concurrent replay loses.
  launcherBootstraps.delete(token);
  const session = launcherRandomToken();
  launcherSessions.set(session, launcherNow() + launcherSessionTtlMs);
  reply.header(
    "Set-Cookie",
    `ponderosa_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(launcherSessionTtlMs / 1_000)}`,
  );
  return reply.code(204).send();
});

app.get("/__ponderosa_bootstrap", async (_request, reply) => reply
  .type("text/html; charset=utf-8")
  .header("Cache-Control", "no-store")
  .send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Opening Ponderosa…</title>
</head>
<body>
<main><h1>Opening Ponderosa…</h1><p id="status">Securing this browser session.</p></main>
<script src="/__ponderosa_bootstrap.js"></script>
</body>
</html>`));

app.get("/__ponderosa_bootstrap.js", async (_request, reply) => reply
  .type("text/javascript; charset=utf-8")
  .header("Cache-Control", "no-store")
  .send(`(async()=>{
const status=document.getElementById("status");
const token=decodeURIComponent(location.hash.slice(1));
const destination="/";
history.replaceState(null,"","/__ponderosa_bootstrap"+location.search);
if(!token){location.replace(destination);return}
try{
  const response=await fetch("/api/launcher/session-exchange",{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({token})
  });
  if(!response.ok)throw new Error("exchange failed");
  if("serviceWorker" in navigator){
    try{
      const registration=await navigator.serviceWorker.getRegistration("/");
      if(registration){
        await registration.update();
        let candidate=registration.waiting||registration.installing;
        if(candidate&&candidate.state!=="installed"){
          await Promise.race([
            new Promise(resolve=>{
              const changed=()=>{
                if(candidate.state==="installed"||candidate.state==="redundant"){
                  candidate.removeEventListener("statechange",changed);
                  resolve();
                }
              };
              candidate.addEventListener("statechange",changed);
              changed();
            }),
            new Promise(resolve=>setTimeout(resolve,5000))
          ]);
        }
        candidate=registration.waiting;
        if(candidate){
          const controlled=Promise.race([
            new Promise(resolve=>navigator.serviceWorker.addEventListener("controllerchange",resolve,{once:true})),
            new Promise(resolve=>setTimeout(resolve,5000))
          ]);
          candidate.postMessage({type:"SKIP_WAITING"});
          await controlled;
        }
      }
    }catch{}
  }
  location.replace(destination);
}catch{
  status.textContent="This launch link expired or was already used. Open Ponderosa Engine again.";
}
})();`));

const beginShutdown = (reply: FastifyReply, requestGeneration: unknown, requestTime: unknown) => {
  if (isClosed()) return reply.code(409).send({ error: "Ponderosa is already shutting down" });
  const generation = opts.launcherGeneration;
  const launcherRoot = opts.launcherDataDir;
  if (!generation || !launcherRoot) {
    return reply.code(409).send({ error: "launcher shutdown receipt authority is unavailable" });
  }
  if (requestGeneration !== generation || typeof requestTime !== "string" ||
      !Number.isFinite(Date.parse(requestTime))) {
    return reply.code(409).send({ error: "shutdown request does not match this launcher generation" });
  }
  const requestedAt = requestTime;
  const birthMarker = processBirthMarker(process.pid);
  const writeTerminalReceipt = (state: "clean" | "incomplete", error?: unknown): void => {
    const updatedAt = new Date().toISOString();
    writeLauncherShutdownReceipt(launcherRoot, {
      schemaVersion: 1,
      generation,
      pid: process.pid,
      ...(birthMarker ? { processBirthMarker: birthMarker } : {}),
      state,
      requestedAt,
      updatedAt,
      ...(state === "incomplete"
        ? { error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) }
        : {}),
    });
  };
  try {
    writeLauncherShutdownReceipt(launcherRoot, {
      schemaVersion: 1,
      generation,
      pid: process.pid,
      ...(birthMarker ? { processBirthMarker: birthMarker } : {}),
      state: "pending",
      requestedAt,
      updatedAt: requestedAt,
    });
  } catch (error) {
    return reply.code(503).send({ error: error instanceof Error ? error.message : "shutdown receipt could not be persisted" });
  }
  app.completeLauncherShutdownRecovery = () => writeTerminalReceipt("clean");
  reply.code(202);
  setImmediate(() => {
    app.prepareForShutdown();
    void app.close().then(() => {
      writeTerminalReceipt("clean");
    }).catch((error) => {
      process.exitCode = 1;
      try {
        writeTerminalReceipt("incomplete", error);
      } catch (receiptError) {
        app.log.error({ err: receiptError }, "Launcher shutdown failure receipt could not be persisted");
      }
      app.log.error({ err: error }, "Launcher-requested shutdown remains incomplete");
    });
  });
  return { accepted: true };
};

app.post<{ Body: { generation?: unknown; requestedAt?: unknown } }>(
  "/api/launcher/shutdown",
  async (request, reply) => beginShutdown(
    reply,
    request.body?.generation,
    request.body?.requestedAt,
  ),
);

app.post("/api/deployment/drain", async (_request, reply) => {
  if (isClosed()) return reply.code(409).send({ error: "daemon is shutting down" });
  setDeploymentDraining(true);
  try {
    await coordinationV3Scheduler.pauseLeasing();
    drainDeploymentIdleAuthorities();
  } catch (error) {
    setDeploymentDraining(false);
    if (!isClosed()) coordinationV3Scheduler.resumeLeasing();
    return reply.code(409).send({ error: error instanceof Error ? error.message : "deployment drain failed" });
  }
  return {
    acceptingDurableIntake: artifactFilesystem.ok && processContainment.ok,
    leasingRuns: false,
    ...deploymentDrainSnapshot(),
  };
});

app.post("/api/deployment/resume", async (_request, reply) => {
  if (isClosed()) return reply.code(409).send({ error: "daemon is shutting down" });
  if (!artifactFilesystem.ok || !processContainment.ok) {
    return reply.code(409).send({ error: artifactFilesystemError() });
  }
  await refreshTriggerSources();
  setDeploymentDraining(false);
  coordinationV3Scheduler.resumeLeasing();
  return {
    acceptingDurableIntake: true,
    leasingRuns: true,
    ...deploymentDrainSnapshot(),
  };
});

app.get("/api/communication-v3/metrics", async (_request, reply) => {
  if (!coordinationV3 || !coordinationV3Scheduler) return reply.code(404).send({ error: "Communication V3 is not enabled" });
  return {
    enabled: true,
    storage: coordinationV3.schedulerMetrics(),
    scheduler: coordinationV3Scheduler.snapshotMetrics(),
    recentTerminalActivations: coordinationV3.terminalActivations(undefined, 100),
    waitCycleWarnings: coordinationV3.waitGraphCycles(),
  };
});

app.post<{
  Params: { id: string };
  Body: { projectId?: string; idempotencyKey?: string; reason?: string };
}>("/api/communication-v3/activations/:id/settle-recipient-unavailable", async (request, reply) => {
  const projectId = request.body?.projectId?.trim() ?? "";
  const idempotencyKey = request.body?.idempotencyKey?.trim() ?? "";
  const reason = request.body?.reason?.trim();
  if (!projectId) return reply.code(400).send({ error: "projectId is required" });
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return reply.code(400).send({ error: "idempotencyKey must be 1 to 200 characters" });
  }
  if (reason && reason.length > 2_000) return reply.code(400).send({ error: "reason must not exceed 2000 characters" });
  try {
    const result = coordinationV3.settleUnavailableActivation({
      activationId: request.params.id,
      projectId,
      idempotencyKey,
      ...(reason ? { reason } : {}),
    });
    if (result.status === "not_pending") return reply.code(409).send(result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "activation not found in project") return reply.code(404).send({ error: message });
    if (message === "activation recipient is still available") return reply.code(409).send({ error: message });
    return reply.code(400).send({ error: message });
  }
});

app.get("/api/ready", async (_request, reply): Promise<ReadinessDto> => {
  const startedAt = performance.now();
  reply.header("Cache-Control", "no-store");
  reply.header("X-Ponderosa-Readiness-Mode", "bounded");
  let dataDirectory: ReadinessDto["checks"]["dataDirectory"];
  try {
    await fs.access(opts.dataDir, fsConstants.R_OK | fsConstants.W_OK);
    dataDirectory = { ok: true, detail: "data directory is readable and writable" };
  } catch (error) {
    dataDirectory = { ok: false, detail: `data directory unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  let projections: ReadinessDto["checks"]["projections"];
  let projectCount = 0;
  try {
    projectCount = projectedProjectCount(store.sqlite);
    projections = { ok: true, detail: "projection database query succeeded" };
  } catch (error) {
    projections = { ok: false, detail: `projection database unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const runtimeStatuses = await Promise.all([...engines.entries()].map(async ([id, registration]) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("runtime check exceeded readiness budget")), READINESS_RUNTIME_BUDGET_MS);
      timer.unref?.();
    });
    try {
      const status = await Promise.race([runtimeStatus(id, registration), timeout]);
      return {
        id,
        configured: true as const,
        authentication: status.authentication,
        intakeReady: status.intakeReady,
        reachability: status.reachability,
        ...((status.availabilityDetail ?? status.authDetail)
          ? { detail: status.availabilityDetail ?? status.authDetail }
          : {}),
      };
    } catch (error) {
      return {
        id,
        configured: true as const,
        authentication: error instanceof Error && error.message === "runtime check exceeded readiness budget"
          ? "checking" as const
          : "error" as const,
        intakeReady: false,
        reachability: error instanceof Error && error.message === "runtime check exceeded readiness budget"
          ? "checking" as const
          : "degraded" as const,
        detail: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }));
  const intakeReady = runtimeStatuses.filter((runtime) => runtime.intakeReady).length;
  const reachable = runtimeStatuses.filter((runtime) => runtime.reachability === "reachable").length;
  const degraded = runtimeStatuses.filter((runtime) => runtime.reachability === "degraded").length;
  const runtimes = {
    ok: intakeReady > 0,
    detail: engines.size === 0
      ? "no runtimes are configured"
      : `${intakeReady} of ${engines.size} configured runtimes intake-ready; ${reachable} reachable, ${degraded} degraded`,
  };
  const evidence = [...communicationReconciliation.values()];
  const driftedProjects = evidence.filter((item) => item.state === "verified" && !item.report.ok).length;
  const pendingProjects = Math.max(0, projectCount - evidence.length) +
    evidence.filter((item) => item.state === "pending").length;
  const communicationParity = driftedProjects === 0 && pendingProjects === 0;
  const communicationMigration = {
    ok: communicationParity,
    detail: communicationParity
      ? "canonical communication projections=ok"
      : pendingProjects > 0
        ? `canonical communication projection verification pending for ${pendingProjects} project(s); new work remains available`
        : `canonical communication projections=drift in ${driftedProjects} quarantined project(s); new work remains available`,
  };
  const browserCleanup = browserResidueCleanupStatus(opts.dataDir);
  const browserResidueCleanup = {
    ok: browserCleanup.failed === 0,
    detail: `${browserCleanup.pending} pending browser residue cleanup(s); ${browserCleanup.failed} with failed attempts`,
  };
  const acceptingDurableIntake = !isClosed() && dataDirectory.ok && projections.ok &&
    artifactFilesystem.ok && processContainment.ok;
  const leasingRuns = coordinationV3Scheduler.isLeasingRuns();
  const canAcceptWork = acceptingDurableIntake && leasingRuns && runtimes.ok;
  const body: ReadinessDto = {
    status: canAcceptWork ? "ready" : "not_ready",
    service: "ponderosa",
    version: opts.buildVersion?.trim() || "0.0.0",
    canAcceptWork,
    networkSecurity,
    acceptingDurableIntake,
    leasingRuns,
    deploymentDrain: deploymentDrainSnapshot(),
    checks: {
      daemon: { ok: !isClosed(), detail: isClosed() ? "daemon is shutting down" : "daemon request loop is running" },
      dataDirectory,
      projections,
      artifactFilesystem,
      processContainment,
      browserResidueCleanup,
      runtimes,
      communicationMigration,
    },
    runtimes: runtimeStatuses,
  };
  app.log.info({
    readinessMode: "bounded",
    durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    projectCount,
    configuredRuntimeCount: engines.size,
    intakeReadyRuntimeCount: intakeReady,
    reachableRuntimeCount: reachable,
    browserResidueCleanupPending: browserCleanup.pending,
    browserResidueCleanupFailed: browserCleanup.failed,
  }, "readiness check completed");
  if (!canAcceptWork) reply.code(503);
  return body;
});

app.get("/api/diagnostics/ready", async (_request, reply): Promise<ReadinessDto> => {
  const startedAt = performance.now();
  reply.header("Cache-Control", "no-store");
  reply.header("X-Ponderosa-Readiness-Mode", "deep");
  let dataDirectory: ReadinessDto["checks"]["dataDirectory"];
  try {
    await fs.access(opts.dataDir, fsConstants.R_OK | fsConstants.W_OK);
    dataDirectory = { ok: true, detail: "data directory is readable and writable" };
  } catch (error) {
    dataDirectory = { ok: false, detail: `data directory unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }

  let projections: ReadinessDto["checks"]["projections"];
  try {
    store.listProjects();
    projections = { ok: true, detail: "projection database query succeeded" };
  } catch (error) {
    projections = { ok: false, detail: `projection database unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }

  const runtimeStatuses = await Promise.all([...engines.entries()].map(async ([id, registration]) => {
    try {
      const status = await runtimeStatus(id, registration);
      return {
        id,
        configured: true as const,
        authentication: status.authentication,
        intakeReady: status.intakeReady,
        reachability: status.reachability,
        ...((status.availabilityDetail ?? status.authDetail)
          ? { detail: status.availabilityDetail ?? status.authDetail }
          : {}),
      };
    } catch (error) {
      return {
        id,
        configured: true as const,
        authentication: "error" as const,
        intakeReady: false,
        reachability: "degraded" as const,
        detail: `runtime check failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }));
  const intakeReady = runtimeStatuses.filter((runtime) => runtime.intakeReady).length;
  const reachable = runtimeStatuses.filter((runtime) => runtime.reachability === "reachable").length;
  const degraded = runtimeStatuses.filter((runtime) => runtime.reachability === "degraded").length;
  const runtimes = {
    ok: intakeReady > 0,
    detail: engines.size === 0
      ? "no runtimes are configured"
      : `${intakeReady} of ${engines.size} configured runtimes intake-ready; ${reachable} reachable, ${degraded} degraded`,
  };
  const communicationStates = store.listProjects().map((project) => ({
    projectId: project.id,
    evidence: communicationReconciliation.get(project.id),
  }));
  const driftedProjects = communicationStates.filter(({ evidence }) =>
    evidence?.state === "verified" && !evidence.report.ok).map(({ projectId }) => projectId);
  const pendingProjects = communicationStates.filter(({ evidence }) => !evidence || evidence.state === "pending")
    .map(({ projectId }) => projectId);
  const communicationParity = driftedProjects.length === 0 && pendingProjects.length === 0;
  const communicationMigration = {
    ok: communicationParity,
    detail: communicationParity
      ? "canonical communication projections=ok"
      : pendingProjects.length > 0
        ? `canonical communication projection verification pending for ${pendingProjects.length} project(s); new work remains available`
      : `canonical communication projections=drift in ${driftedProjects.length} quarantined project(s); new work remains available`,
  };
  // Projection drift is project-scoped diagnostic state. It must not make
  // unrelated clean projects or the entire daemon reject new work.
  const browserCleanup = browserResidueCleanupStatus(opts.dataDir);
  const browserResidueCleanup = {
    ok: browserCleanup.failed === 0,
    detail: `${browserCleanup.pending} pending browser residue cleanup(s); ${browserCleanup.failed} with failed attempts`,
  };
  const acceptingDurableIntake = !isClosed() && dataDirectory.ok && projections.ok &&
    artifactFilesystem.ok && processContainment.ok;
  const leasingRuns = coordinationV3Scheduler.isLeasingRuns();
  const canAcceptWork = acceptingDurableIntake && leasingRuns && runtimes.ok;
  const body: ReadinessDto = {
    status: canAcceptWork ? "ready" : "not_ready",
    service: "ponderosa",
    version: opts.buildVersion?.trim() || "0.0.0",
    canAcceptWork,
    networkSecurity,
    acceptingDurableIntake,
    leasingRuns,
    deploymentDrain: deploymentDrainSnapshot(),
    checks: {
      daemon: { ok: !isClosed(), detail: isClosed() ? "daemon is shutting down" : "daemon request loop is running" },
      dataDirectory,
      projections,
      artifactFilesystem,
      processContainment,
      browserResidueCleanup,
      runtimes,
      communicationMigration,
    },
    runtimes: runtimeStatuses,
  };
  app.log.info({
    readinessMode: "deep",
    durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    projectCount: communicationStates.length,
    configuredRuntimeCount: engines.size,
    intakeReadyRuntimeCount: intakeReady,
    reachableRuntimeCount: reachable,
    browserResidueCleanupPending: browserCleanup.pending,
    browserResidueCleanupFailed: browserCleanup.failed,
  }, "readiness diagnostic completed");
  if (!canAcceptWork) reply.code(503);
  return body;
});

app.get<{ Querystring: CollectionQuery }>("/api/projects", async (request, reply) => {
  try {
    const normalizedSearch = request.query.search?.trim().toLocaleLowerCase() ?? "";
    const page = sqliteCollectionPage(store.sqlite, request.query, {
      baseSql: `
        SELECT id, label AS title, COALESCE(last_used_at, created_at) AS updated_at
        FROM projects
        ${normalizedSearch ? "WHERE lower(label || ' ' || host_path) LIKE ? ESCAPE '\\\\'" : ""}
      `,
      params: normalizedSearch
        ? [`%${normalizedSearch.replace(/[\\%_]/g, match => `\\${match}`)}%`]
        : [],
      order: "updated",
      scope: "projects",
      generationKeys: ["projects"],
      hydrate: id => store.getProject(id),
    });
    applyCollectionPageHeaders(reply, page);
    return page.items;
  } catch (error) {
    return sendCollectionPageError(reply, error);
  }
});
}
