import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import type { NativeRuntimeControlRequest } from "@ponderosa/core";
import type { ActiveRun, PersistentRuntime } from "../app-contracts.js";
import { restrictedProviderExceptionLogDetail } from "../provider-exception-properties.js";
import { redactProviderDiagnostic } from "../provider-failure-event.js";

/** Operator HTTP only: deliberately absent from managed Agent tool schemas. */
export function registerNativeControlRoutes(app: FastifyInstance, context: {
  assertRetainedAuthentication(id: string, session: import("@ponderosa/core").RuntimeSession): void;
  store: AgentStore;
  coordinationV3: CoordinationV3Store;
  activeRuns: Map<string, ActiveRun>;
  deletingAgentIds: ReadonlySet<string>;
  deletingProjectIds: ReadonlySet<string>;
  persistentRuntimeForTermination(agentId: string): PersistentRuntime | undefined;
  isClosed(): boolean;
}): void {
  const busy = new Set<string>();
  const boundary = (id: string) => {
    const agent = context.store.getAgent(id);
    const runtime = context.persistentRuntimeForTermination(id);
    if (!agent || !runtime || context.isClosed() || context.deletingAgentIds.has(id) ||
        context.deletingProjectIds.has(agent.projectId) || context.coordinationV3.contextRecovery.active(id)) return undefined;
    if (context.store.sqlite.prepare("SELECT 1 FROM agent_run_pauses WHERE agent_id=? AND state IN ('paused','resume_requested')").get(id)) return undefined;
    try { context.assertRetainedAuthentication(id, runtime.session); } catch { return undefined; }
    const run = context.activeRuns.get(id);
    if (run) {
      if (run.controller.signal.aborted || run.persistentRuntimeIdentity !== runtime.identity ||
          run.runtimeSession !== runtime.session || !run.v3SchedulerRunId || run.v3FencingToken === undefined) return undefined;
      const owned = context.store.sqlite.prepare(`SELECT 1 FROM scheduler_runs WHERE id=? AND agent_id=?
        AND fencing_token=? AND status='running' AND side_effects_fenced_at IS NULL AND lease_expires_at>?`)
        .get(run.v3SchedulerRunId, id, run.v3FencingToken, new Date().toISOString());
      if (!owned) return undefined;
      return { runtime, session: runtime.session, sessionId: runtime.session.engineAgentId, runId: run.runId, fencingToken: run.v3FencingToken };
    }
    if (context.coordinationV3.activeAgentRun(id)) return undefined;
    const source = context.store.providerCommandContextBoundary(id);
    if (!source || source.providerSessionId !== runtime.session.engineAgentId) return undefined;
    return { runtime, session: runtime.session, sessionId: runtime.session.engineAgentId, runId: source.executionId, fencingToken: source.fencingToken };
  };
  const unchanged = (id: string, expected: NonNullable<ReturnType<typeof boundary>>) => {
    const current = boundary(id);
    return current && current.runtime === expected.runtime && current.session === expected.session &&
      current.sessionId === expected.sessionId && current.runId === expected.runId &&
      current.fencingToken === expected.fencingToken;
  };
  app.get<{Params:{id:string}}>("/api/agents/:id/native-controls", async (request, reply) => {
    const current = boundary(request.params.id);
    if (!current) return reply.code(409).send({ error: "Exact retained runtime boundary unavailable" });
    const catalog = await current.session.capabilities?.();
    if (!unchanged(request.params.id, current)) return reply.code(409).send({ error: "Native control boundary changed" });
    return { sessionId: current.sessionId, runId: current.runId,
      fencingToken: current.fencingToken,
      operations: catalog?.commands.filter(command => ["native-model", "native-permission-mode"].includes(command.name) &&
        command.invocation === "runtime" && command.status === "available").map(command => command.name.slice("native-".length)) ?? [] };
  });
  app.post<{Params:{id:string};Body:NativeRuntimeControlRequest}>("/api/agents/:id/native-controls", async (request, reply) => {
    const id = request.params.id, body = request.body;
    if (!body || !["model", "permission-mode"].includes(body.operation) || typeof body.value !== "string" ||
        !body.value || body.value.length > 200 || !Number.isSafeInteger(body.fencingToken)) return reply.code(400).send({error:"Invalid native control"});
    if (busy.has(id)) return reply.code(409).send({error:"Native control already active"});
    const current = boundary(id);
    if (!current || current.runId !== body.runId || current.fencingToken !== body.fencingToken ||
        current.sessionId !== body.sessionId) return reply.code(409).send({error:"Native control boundary changed"});
    const session = current.session;
    const catalog = await session.capabilities?.();
    if (!session.invokeCommand || !catalog?.commands.some(command => command.name === `native-${body.operation}` && command.invocation === "runtime" && command.status === "available")) return reply.code(409).send({error:"Native control unsupported"});
    if (!unchanged(id, current)) return reply.code(409).send({error:"Native control boundary changed"});
    // Human model selection already persists through the normal Agent settings UI.
    // A live command must agree with that saved selection, never silently replace it.
    const agent = context.store.getAgent(id)!;
    if (body.operation === "model" && body.value !== (agent.model ?? agent.presetSnapshot?.model)) return reply.code(409).send({error:"Save this Agent's model selection first"});
    if (busy.has(id)) return reply.code(409).send({error:"Native control already active"});
    busy.add(id);
    const callId = randomUUID();
    try {
      context.store.appendEvent(id, { type: "work_start", kind: "native_tool", callId, executionId: current.runId });
      context.store.appendEvent(id, { type: "tool_call", id: callId, name: `native_${body.operation}`, input: { sessionId:body.sessionId, runId:body.runId, fencingToken:body.fencingToken, value:body.value } });
      const result = await session.invokeCommand(`native-${body.operation}`, body.value);
      if (!unchanged(id, current)) return reply.code(409).send({outcome:"outcome_unknown",error:"Native response arrived after authority changed; do not replay"});
      context.store.appendEvent(id, { type:"tool_result", id:callId, output:"Native control acknowledged; source work remains independently governed" });
      return result;
    } catch (error) {
      const detail = redactProviderDiagnostic(restrictedProviderExceptionLogDetail(error));
      const message = `Native control refused or unconfirmed: ${detail}. Do not automatically retry.`;
      context.store.appendEvent(id, { type:"tool_result", id:callId, output:message, isError:true });
      return reply.code(409).send({error:message});
    } finally { busy.delete(id); }
  });
}
