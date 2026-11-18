import type { FastifyInstance } from "fastify";
import type { AgentStore } from "@ponderosa/agents";
import { CoordinationV3SourceEffectsAuthority, SourceEffectConflictError } from "@ponderosa/agents";
import type { SourceEffectReconcileInput } from "@ponderosa/core";

/** Operator API: reads original host evidence, never a provider tool or retry. */
export function registerSourceEffectRoutes(app: FastifyInstance, {store}: {store: AgentStore}): void {
  const authority = new CoordinationV3SourceEffectsAuthority(store.sqlite);
  const readFence = (value: unknown): number | undefined => {
    if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) return undefined;
    const fence = Number(value);
    return Number.isSafeInteger(fence) ? fence : undefined;
  };
  app.get<{Params:{id:string;runId:string};Querystring:{sourceFence?:string}}>(
    "/api/agents/:id/source-runs/:runId/effects", async (request,reply) => {
      if (!store.getAgent(request.params.id)) return reply.code(404).send({error:"Agent not found"});
      const sourceFence = readFence(request.query.sourceFence);
      if (!sourceFence) return reply.code(400).send({error:"Exact positive sourceFence required"});
      try { return authority.inspect({agentId:request.params.id,sourceRunId:request.params.runId,sourceFence}); }
      catch (error) {
        if (error instanceof SourceEffectConflictError) return reply.code(409).send({code:"source_effect_conflict",error:error.message,retryable:false});
        request.log.error({err:error},"Original source effect read failed");
        return reply.code(503).send({code:"source_effect_read_unavailable",error:"Original host receipts could not be read; no effect outcome was inferred",retryable:false});
      }
    });
  app.get<{Params:{id:string;runId:string;key:string};Querystring:{sourceFence?:string}}>(
    "/api/agents/:id/source-runs/:runId/effects/reconciliations/:key", async (request,reply) => {
      if (!store.getAgent(request.params.id)) return reply.code(404).send({error:"Agent not found"});
      const sourceFence = readFence(request.query.sourceFence);
      if (!sourceFence) return reply.code(400).send({error:"Exact positive sourceFence required"});
      try {
        const receipt = authority.recorded({agentId:request.params.id,sourceRunId:request.params.runId,sourceFence},request.params.key);
        return receipt ? {receipt} : reply.code(404).send({error:"No reconciliation receipt for this exact boundary/key"});
      } catch (error) {
        if (error instanceof SourceEffectConflictError) return reply.code(400).send({error:error.message});
        request.log.error({err:error},"Original source reconciliation receipt read failed");
        return reply.code(503).send({error:"Reconciliation receipt unavailable; absence or failure was not established",retryable:false});
      }
    });
  app.post<{Params:{id:string;runId:string};Body:SourceEffectReconcileInput}>(
    "/api/agents/:id/source-runs/:runId/effects/reconcile", async (request,reply) => {
      if (!store.getAgent(request.params.id)) return reply.code(404).send({error:"Agent not found"});
      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).some(k=>!["sourceFence","expectedInventoryHash","idempotencyKey"].includes(k)) ||
          !Number.isSafeInteger(body.sourceFence) || body.sourceFence < 1 ||
          typeof body.expectedInventoryHash !== "string" || !/^[a-f0-9]{64}$/u.test(body.expectedInventoryHash) ||
          typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim() || body.idempotencyKey.length > 200) {
        return reply.code(400).send({error:"Exact fence, inventory hash and command key required; caller-supplied outcomes are not accepted"});
      }
      try { return authority.reconcile({agentId:request.params.id,sourceRunId:request.params.runId,sourceFence:body.sourceFence},body); }
      catch (error) {
        if (error instanceof SourceEffectConflictError) return reply.code(409).send({code:"source_effect_conflict",error:error.message,retryable:false});
        request.log.error({err:error},"Original source reconciliation persistence outcome unknown");
        return reply.code(503).send({code:"source_effect_persistence_unknown",error:"Reconciliation persistence outcome unknown. Read the exact command-key receipt before another action; do not replay original work",retryable:false});
      }
    });
}
