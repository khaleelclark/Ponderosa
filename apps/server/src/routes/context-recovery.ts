import { RetainedNativeAuthenticationError } from "../runtime-selection.js";
import { ContextRecoveryConflictError } from "@ponderosa/agents";
import { restrictedProviderExceptionLogDetail } from "../provider-exception-properties.js";
import type { FastifyInstance } from "fastify";
import { ProviderContextRecoveryUnavailableError, UNSUPPORTED_PROVIDER_CONTEXT_RECOVERY, type ProviderContextRecoverySupport } from "@ponderosa/core";
import type { AgentStore, CoordinationV3Store } from "@ponderosa/agents";

/** Explicit recovery never manufactures a scheduler Run or replays source work. */
export function registerContextRecoveryRoutes(app: FastifyInstance, context: {
  store: AgentStore; coordinationV3: CoordinationV3Store;
  unavailable(agentId: string,projectId: string): boolean;
  notifyScheduler(): void;
  stopRecovery?(agentId:string,recoveryId:string):Promise<boolean>;
  recover?(request: import("@ponderosa/core").ProviderContextRecoveryRequest): Promise<void>;
  support(engineId: string): Readonly<ProviderContextRecoverySupport> | undefined;
}) {
  const {store,coordinationV3} = context;
  const sourceEvidence=(agentId:string,sourceRunId:string|undefined)=>{
    if(!sourceRunId)return undefined;
    const evidence=store.providerContextRecoveryEvidence(agentId,sourceRunId);
    return evidence?{...evidence,attachedRequestIds:coordinationV3.requestIdsAttachedToRun(sourceRunId,agentId)}:undefined;
  };
  app.get<{Params:{id:string};Querystring:{idempotencyKey?:string}}>("/api/agents/:id/context-recoveries",async(request,reply)=>{
    const agent=store.getAgent(request.params.id);
    if (!agent) return reply.code(404).send({error:"Agent not found"});
    const key=request.query.idempotencyKey;
    if(key !== undefined && (typeof key !== 'string' || !key.trim() || key.length>200)) return reply.code(400).send({error:"Invalid idempotencyKey"});
    const recovery=key?coordinationV3.contextRecovery.byKey(agent.id,key):coordinationV3.contextRecovery.active(agent.id);
    const boundary=store.uncertainProviderContextRecoveryBoundary(agent.id);
    return {sourceEvidence:sourceEvidence(agent.id,recovery?.sourceRunId??boundary?.sourceRunId),support:context.support(agent.activeEngine) ?? UNSUPPORTED_PROVIDER_CONTEXT_RECOVERY,
      boundary:boundary ?? null,
      request:recovery ?? null};
  });
  app.post<{Params:{id:string};Body:{idempotencyKey?:string;expectedSessionId?:string;expectedSourceRunId?:string;expectedToolContractHash?:string;acknowledgeUnknownEffects?:boolean}}>("/api/agents/:id/context-recoveries",async(request,reply)=>{
    const body=request.body;
    const allowed=['idempotencyKey','expectedSessionId','expectedSourceRunId','expectedToolContractHash','acknowledgeUnknownEffects'];
    if(!body || Object.keys(body).some(k=>!allowed.includes(k)) || body.acknowledgeUnknownEffects!==true ||
       [body.idempotencyKey,body.expectedSessionId,body.expectedSourceRunId].some(v=>typeof v!=='string'||!v.trim()||v.length>200) ||
       typeof body.expectedToolContractHash!=='string' || !/^[a-f0-9]{64}$/u.test(body.expectedToolContractHash)) {
      return reply.code(400).send({error:"Exact session, source Run, contract, idempotencyKey and acknowledgement of unknown effects are required"});
    }
    const agent=store.getAgent(request.params.id);
    if(!agent) return reply.code(404).send({error:"Agent not found"});
    const prior=coordinationV3.contextRecovery.byKey(agent.id,body.idempotencyKey!);
    if(!prior && context.unavailable(agent.id,agent.projectId)) return reply.code(409).send({error:"Agent runtime or cleanup is active"});
    const boundary=prior ?? store.uncertainProviderContextRecoveryBoundary(agent.id);
    if(!boundary || boundary.providerSessionId!==body.expectedSessionId || boundary.sourceRunId!==body.expectedSourceRunId ||
       boundary.toolContractHash!==body.expectedToolContractHash) return reply.code(409).send({error:"Exact retained context boundary changed or unavailable"});
    const input={agentId:agent.id,projectId:boundary.projectId,providerSessionId:boundary.providerSessionId,
      sourceRunId:boundary.sourceRunId,toolContractHash:boundary.toolContractHash,sourceFence:boundary.sourceFence,
      scopeKey:boundary.scopeKey,idempotencyKey:body.idempotencyKey!};
    try {
      let result=coordinationV3.contextRecovery.request(input);
      if (!result.replayed && context.support(agent.activeEngine)?.status === "managed_compaction" && context.recover) {
        await context.recover(result.request);
        result = { ...result, request: coordinationV3.contextRecovery.byKey(agent.id,body.idempotencyKey!)! };
      }
      if(result.replayed&&!context.unavailable(agent.id,agent.projectId)&&coordinationV3.contextRecovery.reconcileRecordedCompletion(agent.id,result.request.id)) {
        result={...result,request:coordinationV3.contextRecovery.byKey(agent.id,body.idempotencyKey!)!};
      }
      if (result.request.progress) return reply.code(result.request.progress.phase === "context_accepted" ? 200 : 409).send({
        ...result, sourceEvidence:sourceEvidence(agent.id,result.request.sourceRunId), recoveredContext:result.request.progress.phase === "context_accepted",
        sourceWork:"held_unknown", retryable:false,
      });
      const refusal=new ProviderContextRecoveryUnavailableError();
      return reply.code(409).send({...result,sourceEvidence:sourceEvidence(agent.id,result.request.sourceRunId),support:context.support(agent.activeEngine) ?? UNSUPPORTED_PROVIDER_CONTEXT_RECOVERY,code:refusal.code,error:result.request.state==='dismissed' ? "This request was dismissed without recovering context. The original context guard remains." : refusal.message,retryable:false});
    } catch (error) {
      if(error instanceof RetainedNativeAuthenticationError) return reply.code(409).send({code:'retained_native_authentication_held',error:error.message,retryable:false,sourceWork:'held_unknown'});
      if(error instanceof ContextRecoveryConflictError) return reply.code(409).send({code:'context_recovery_conflict',error:error.message,retryable:false});
      // A write exception is not proof of non-commit. Read by exact key before
      // another action; even this read can fail, so do not infer absence here.
      app.log.error({providerError:restrictedProviderExceptionLogDetail(error),agentId:agent.id},"context recovery recording outcome is unknown");
      return reply.code(503).send({code:'context_recovery_persistence_unknown',
        error:"Recovery persistence, native outcome or cleanup is uncertain. Inspect the exact key before another action; never replay native input from an HTTP failure.",retryable:false});
    }
  });
  app.post<{Params:{id:string;recoveryId:string}}>("/api/agents/:id/context-recoveries/:recoveryId/stop",async(request,reply)=>{
    const active=coordinationV3.contextRecovery.active(request.params.id);
    if(!active || active.id!==request.params.recoveryId)return reply.code(409).send({error:"Exact active recovery changed"});
    try {
      const stopRequested=await context.stopRecovery?.(request.params.id,request.params.recoveryId) ?? false;
      return {stopRequested,request:coordinationV3.contextRecovery.active(request.params.id),sourceWork:"held_unknown"};
    }catch(error){
      app.log.error({providerError:restrictedProviderExceptionLogDetail(error),agentId:request.params.id},"Recovery stop cleanup remains pending");
      return reply.code(503).send({error:"Recovery stop requested; process cleanup remains pending. Source work stays held.",retryable:false});
    }
  });
  app.post<{Params:{id:string;recoveryId:string};Body:{acknowledgeStillBlocked?:boolean}}>("/api/agents/:id/context-recoveries/:recoveryId/dismiss",async(request,reply)=>{
    if(!store.getAgent(request.params.id))return reply.code(404).send({error:"Agent not found"});
    if(request.body?.acknowledgeStillBlocked!==true)return reply.code(400).send({error:"Acknowledge that original uncertain work remains unresolved"});
    try {
      const recovery=coordinationV3.contextRecovery.dismiss(request.params.id,request.params.recoveryId);
      context.notifyScheduler();
      return {request:recovery,recovered:false,recoveredContext:recovery.progress?.phase==="context_accepted",sourceWork:"held_unknown"};
    } catch (error) {
      if(error instanceof ContextRecoveryConflictError) return reply.code(409).send({error:error.message,retryable:false});
      app.log.error({providerError:restrictedProviderExceptionLogDetail(error),agentId:request.params.id},"context recovery dismissal outcome is unknown");
      return reply.code(503).send({code:'context_recovery_persistence_unknown',error:"Dismissal persistence outcome is unknown; inspect the exact key before another action",retryable:false});
    }
  });
}
