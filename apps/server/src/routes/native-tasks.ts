import type { FastifyInstance } from "fastify";
import type { AgentStore } from "@ponderosa/agents";
import { NativeTaskStopAuthority } from "@ponderosa/agents";
import type { NativeTaskBoundary, NativeTaskInventory, NativeTaskStopRequest, RuntimeSession } from "@ponderosa/core";
import type { ActiveRun } from "../app-contracts.js";
import { readProviderSessionIdentifier } from "../provider-session-success.js";

const text = (value: unknown, max = 200): value is string => typeof value === "string" &&
  value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

/** Human-only control surface; adapters never create Runs or infer tasks from text. */
export function registerNativeTaskRoutes(app: FastifyInstance, context: {
  store: AgentStore;
  activeRuns: Map<string, ActiveRun>;
  unavailable(agentId: string): boolean;
}): void {
  const {store, activeRuns} = context;
  const authority = new NativeTaskStopAuthority(store.sqlite);
  // One latest, bounded inventory per Agent. Never reconstructed after restart.
  const inventories = new Map<string, {run: ActiveRun; session: RuntimeSession; inventory: NativeTaskInventory}>();
  const owned = (agentId: string, boundary?: NativeTaskBoundary): ActiveRun => {
    const run = activeRuns.get(agentId), session = run?.runtimeSession;
    if (!run || !session || context.unavailable(agentId) || run.controller.signal.aborted ||
        !["running","stalled"].includes(run.ownershipState) || !run.v3SchedulerRunId || !run.v3FencingToken ||
        !session.isAlive() || boundary && (boundary.runId !== run.v3SchedulerRunId ||
          boundary.sourceFence !== run.v3FencingToken || boundary.sessionId !== readProviderSessionIdentifier(session)))
      throw new Error("Exact live Run/session ownership is unavailable or changed");
    const canonical = store.sqlite.prepare(`SELECT 1 FROM scheduler_runs WHERE id=? AND agent_id=?
      AND fencing_token=? AND provider_session_id=? AND status='running' AND prompt_injection_state='injected'
      AND side_effects_fenced_at IS NULL AND lease_expires_at>?`).get(run.v3SchedulerRunId, agentId,
        run.v3FencingToken, readProviderSessionIdentifier(session), new Date().toISOString());
    if (!canonical) throw new Error("Native task control requires the current injected, leased source fence");
    return run;
  };

  app.get<{Params:{id:string}}>("/api/agents/:id/native-tasks", async (request, reply) => {
    const agentId = request.params.id;
    if (!store.getAgent(agentId)) return reply.code(404).send({error:"Agent not found"});
    for (const [id, entry] of inventories) if (activeRuns.get(id) !== entry.run || entry.run.controller.signal.aborted) inventories.delete(id);
    inventories.delete(agentId);
    try {
      const run = owned(agentId), session = run.runtimeSession!;
      if (!session.listNativeTasks || !session.stopNativeTask) return reply.code(409).send({error:"Live session has no native task controls",retryable:false});
      const boundary: NativeTaskBoundary = {runId:run.v3SchedulerRunId!, sourceFence:run.v3FencingToken!, sessionId:readProviderSessionIdentifier(session)};
      const tasks = await session.listNativeTasks();
      if (owned(agentId,boundary) !== run || run.runtimeSession !== session) throw new Error("Run changed during native task discovery");
      // RuntimeSession is the descriptor-safe, bounded provider facade.
      const inventory = {...boundary,tasks};
      inventories.set(agentId,{run,session,inventory});
      return inventory;
    } catch {
      return reply.code(409).send({error:"Exact live native task inventory unavailable; no absence or task completion inferred",retryable:false});
    }
  });

  app.get<{Params:{id:string;key:string};Querystring:{runId?:string;sourceFence?:string;sessionId?:string;taskKey?:string}}>(
    "/api/agents/:id/native-tasks/stops/:key", async (request,reply) => {
      if (!store.getAgent(request.params.id)) return reply.code(404).send({error:"Agent not found"});
      const query=request.query, sourceFence=typeof query.sourceFence === "string" && /^[1-9]\d*$/u.test(query.sourceFence) ? Number(query.sourceFence) : undefined;
      if (!text(query.runId) || !text(query.sessionId,4096) || !text(query.taskKey,4096) ||
          !text(request.params.key) || !Number.isSafeInteger(sourceFence)) return reply.code(400).send({error:"Exact stop receipt boundary required"});
      try {
        const receipt=authority.recorded(request.params.id,{runId:query.runId,sourceFence:sourceFence!,sessionId:query.sessionId,taskKey:query.taskKey,idempotencyKey:request.params.key});
        return receipt ?? reply.code(404).send({error:"No stop receipt for this exact command key"});
      } catch { return reply.code(409).send({error:"Stop receipt target conflicts or cannot be read",retryable:false}); }
    });

  app.post<{Params:{id:string};Body:NativeTaskStopRequest}>("/api/agents/:id/native-tasks/stop", async (request, reply) => {
    const agentId = request.params.id, input = request.body;
    if (!store.getAgent(agentId)) return reply.code(404).send({error:"Agent not found"});
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some(key => !["runId","sourceFence","sessionId","taskKey","idempotencyKey"].includes(key)) ||
        !text(input.runId) || !text(input.sessionId,4096) || !text(input.taskKey,4096) || !text(input.idempotencyKey) ||
        !Number.isSafeInteger(input.sourceFence) || input.sourceFence < 1)
      return reply.code(400).send({error:"Exact listed Run, fence, session, taskKey and command idempotencyKey required"});
    try {
      const prior = authority.recorded(agentId,input);
      if (prior) return prior; // Read-only recovery is allowed after the source Run ends.
      const run = owned(agentId,input), session = run.runtimeSession!;
      const listed = inventories.get(agentId);
      if (!listed || listed.run !== run || listed.session !== session || listed.inventory.runId !== input.runId ||
          listed.inventory.sourceFence !== input.sourceFence || listed.inventory.sessionId !== input.sessionId ||
          !listed.inventory.tasks.some(task => task.taskKey === input.taskKey && task.cancellable) || !session.stopNativeTask)
        throw new Error("Stop target must come from the exact owned live inventory");
      authority.reserve(agentId,input);
      // No await separates the final host fence check, durable reservation and native dispatch.
      // Even a pre-input failure is conservatively held and never retried.
      let outcome: import("@ponderosa/core").NativeTaskStopOutcome = "unknown";
      try {
        if (owned(agentId,input) === run && run.runtimeSession === session) outcome = await session.stopNativeTask(input.taskKey);
      } catch { /* Native outcome unknown; original Run/task lifetime remains authoritative. */ }
      return authority.finish(agentId,input,outcome);
    } catch {
      return reply.code(409).send({error:"Native stop target conflicts, is unavailable, or its outcome is unknown. Read the same command key; do not submit a new stop attempt.",retryable:false});
    }
  });
}
