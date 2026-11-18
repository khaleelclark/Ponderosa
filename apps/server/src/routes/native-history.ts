import type { FastifyInstance } from "fastify";
import type { AgentStore, CoordinationV3Store } from "@ponderosa/agents";
import { CapabilityPolicyStore } from "@ponderosa/agents";
import { runtimeRestrictions } from "@ponderosa/core";
import type { ActiveRun, PersistentRuntime } from "../app-contracts.js";
import type { AgentWorkingCopyService } from "../agent-working-copy-service.js";
import { NativeHistoryAuthority, historyHash, type HistoryBoundary } from "../native-history-authority.js";
import { nativeRewindFileFacts } from "../native-history-files.js";
import { randomUUID } from "node:crypto";

/** Human operator routes, intentionally absent from managed tool schemas. */
export function registerNativeHistoryRoutes(app:FastifyInstance,context:{
  assertRetainedAuthentication(id:string,session:import("@ponderosa/core").RuntimeSession):void;
  store:AgentStore;coordinationV3:CoordinationV3Store;activeRuns:Map<string,ActiveRun>;
  deletingAgentIds:ReadonlySet<string>;deletingProjectIds:ReadonlySet<string>;
  persistentRuntimeForTermination(id:string):PersistentRuntime|undefined;
  isClosed():boolean;workingCopies:AgentWorkingCopyService;busy:Set<string>;
}):void {
  const {store}=context,authority=new NativeHistoryAuthority(store);
  const boundary=(id:string):{boundary:HistoryBoundary;runtime:PersistentRuntime}|undefined=>{
    const a=store.getAgent(id),runtime=context.persistentRuntimeForTermination(id),b=store.providerCommandContextBoundary(id);
    if(!a||a.workingCopy.state!=='ready'||!runtime||!b||context.isClosed()||context.deletingAgentIds.has(id)||context.deletingProjectIds.has(a.projectId)||
       context.activeRuns.has(id)||context.coordinationV3.activeAgentRun(id)||context.coordinationV3.contextRecovery.active(id)||
       store.sqlite.prepare("SELECT 1 FROM agent_run_pauses WHERE agent_id=? AND state IN ('paused','resume_requested')").get(id)||
       runtime.session.engineAgentId!==b.providerSessionId||!runtime.session.isAlive())return undefined;
    try { context.assertRetainedAuthentication(id,runtime.session); } catch { return undefined; }
    return {runtime,boundary:{agentId:id,projectId:a.projectId,conversationId:a.conversationId,engine:a.activeEngine,
      sessionId:b.providerSessionId,runId:b.executionId,fence:b.fencingToken,toolContractHash:b.toolContractHash,rootPath:a.workingCopy.rootPath}};
  };
  const same=(id:string,b:ReturnType<typeof boundary>)=>{
    const now=boundary(id);
    if(!b||!now||now.runtime!==b.runtime||historyHash(now.boundary)!==historyHash(b.boundary))throw new Error("Native history ownership changed");
  };
  const eligible=(id:string,b:HistoryBoundary,target:ReturnType<AgentStore['getAgent']>):boolean=>{
    return !(!target||target.id===id||target.projectId!==b.projectId||target.conversationId!==b.conversationId||
           target.activeEngine!==b.engine||target.workingCopy.rootPath!==b.rootPath||target.workingCopy.state!=='ready'||
           store.resumeSessionId(target.id)||context.persistentRuntimeForTermination(target.id)||context.activeRuns.has(target.id)||
           context.coordinationV3.activeAgentRun(target.id)||context.deletingAgentIds.has(target.id)||
           store.sqlite.prepare("SELECT 1 FROM scheduler_runs WHERE agent_id=? LIMIT 1").get(target.id)||
           store.sqlite.prepare("SELECT 1 FROM events WHERE agent_id=? AND type IN ('user_message','session','session_snapshot','tool_call','text') LIMIT 1").get(target.id)||authority.held(target.id));
  };
  const trackingResponse=async(id:string)=>{
    const preference=authority.tracking(id),b=boundary(id);
    if(!b?.runtime.session.nativeHistory)return {preference};
    try {
      const catalog=await b.runtime.session.nativeHistory();same(id,b);
      if(catalog.sessionId!==b.boundary.sessionId||catalog.trackingEnabled===undefined)return {preference};
      return {preference,currentSession:{sessionId:catalog.sessionId,trackingEnabled:catalog.trackingEnabled}};
    }catch{return {preference};}
  };
  app.get<{Params:{id:string}}>("/api/agents/:id/native-history/tracking",async(request,reply)=>{
    const a=store.getAgent(request.params.id);
    if(!a)return reply.code(404).send({error:"Agent not found"});
    if(a.activeEngine!=='claude')return reply.code(409).send({error:"Claude tracking only"});
    return trackingResponse(a.id);
  });
  app.post<{Params:{id:string};Body:import('@ponderosa/core').NativeHistoryTrackingRequest}>("/api/agents/:id/native-history/tracking",async(request,reply)=>{
    const id=request.params.id,body=request.body;
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||typeof body.enabled!=='boolean')return reply.code(400).send({error:"Exact enabled boolean required"});
    if(!store.getAgent(id))return reply.code(404).send({error:"Agent not found"});
    if(context.isClosed()||context.deletingAgentIds.has(id)||context.deletingProjectIds.has(store.getAgent(id)!.projectId))return reply.code(409).send({error:"Agent unavailable"});
    try{authority.setTracking(id,body.enabled);return trackingResponse(id);}
    catch{return reply.code(409).send({error:"Claude tracking preference unavailable"});}
  });
  app.get<{Params:{id:string};Querystring:{key?:string}}>("/api/agents/:id/native-history",async(request,reply)=>{
    if(!store.getAgent(request.params.id))return reply.code(404).send({error:"Agent not found"});
    try {
      if(request.query.key!==undefined) {
        if(!validKey(request.query.key))return reply.code(400).send({error:"Invalid command key"});
        const receipt=authority.read(request.params.id,request.query.key);
        return receipt?{receipt}:reply.code(404).send({error:"No receipt for this exact Agent/key; original effects are not inferred"});
      }
      const b=boundary(request.params.id);
      if(!b||!b.runtime.session.nativeHistory)return reply.code(409).send({error:"Accepted idle native history unavailable"});
      const catalog=await b.runtime.session.nativeHistory();same(request.params.id,b);
      if(catalog.sessionId!==b.boundary.sessionId)throw new Error("Native catalog owner changed");
      return {boundary:b.boundary,boundaryHash:historyHash(b.boundary),catalog,held:authority.held(request.params.id),eligibleTargets:store.listAgents(b.boundary.projectId).filter(a=>eligible(request.params.id,b.boundary,a)).map(a=>({agentId:a.id}))} satisfies import("@ponderosa/core").NativeHistoryInventory;
    }catch(error){request.log.error({err:error},"Native history read unavailable");return reply.code(409).send({error:"Native history unavailable; no outcome inferred"});}
  });
  app.post<{Params:{id:string};Body:Record<string,unknown>}>("/api/agents/:id/native-history",async(request,reply)=>{
    const id=request.params.id,body=request.body;
    const allowed=['operation','idempotencyKey','boundaryHash','checkpointId','previewKey','targetAgentId','throughId','acknowledgeFileChanges','acknowledgeHistoryCopy'];
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k))||
       !['preview','rewind','fork'].includes(String(body.operation))||!validKey(body.idempotencyKey)||
       typeof body.boundaryHash!=='string'||!/^[a-f0-9]{64}$/u.test(body.boundaryHash))return reply.code(400).send({error:"Exact native operation, boundary hash and command key required"});
    if(!store.getAgent(id))return reply.code(404).send({error:"Agent not found"});
    let release:(()=>void)|undefined;
    let ownsBusy=false;
    try {
      const old=authority.read(id,body.idempotencyKey);
      if(old) {
        if(old.requestHash!==historyHash(body))return reply.code(409).send({error:"Command key belongs to another request"});
        return {receipt:old,replayed:true,replayAuthorized:false};
      }
      if(context.busy.has(id)||authority.held(id))return reply.code(409).send({error:"Native operation active or held; inspect its original command key"});
      const b=boundary(id);
      if(!b||historyHash(b.boundary)!==body.boundaryHash||!b.runtime.session.nativeHistory)return reply.code(409).send({error:"Exact accepted native boundary changed"});
      context.busy.add(id);ownsBusy=true;release=context.workingCopies.beginUse(id);
      const catalog=await b.runtime.session.nativeHistory();same(id,b);
      if(catalog.sessionId!==b.boundary.sessionId)throw new Error("Native history owner changed");
      if(body.operation==='fork') {
        if(body.acknowledgeHistoryCopy!==true||!validKey(body.throughId)||!validKey(body.targetAgentId)||!catalog.transcriptForkSupported||!catalog.forkPoints.includes(body.throughId))throw new Error("Explicit exact completed transcript boundary and destination required");
        const target=store.getAgent(body.targetAgentId);
        if(!eligible(id,b.boundary,target))throw new Error("Destination must be a fresh empty same-Chat same-engine Agent on the same working folder");
        const result=authority.reserve(b.boundary,body.idempotencyKey,'fork',body,{targetAgentId:body.targetAgentId,throughId:body.throughId,newSessionId:randomUUID(),requestHash:historyHash(body)});
        return { ...result,nextAction:"Send a new human message to the destination Agent. Its scheduler Run opens the fresh fork once.",sourceWork:"unchanged",replayAuthorized:false};
      }
      if(!catalog.fileRewindSupported||!b.runtime.session.rewindFiles||!validKey(body.checkpointId)||!catalog.checkpoints.some(c=>c.messageId===body.checkpointId))throw new Error("Exact tracked native checkpoint unavailable");
      if(runtimeRestrictions(new CapabilityPolicyStore(store.sqlite).resolveForAgent(id),b.boundary.engine).filesystemWriteRestricted)throw new Error("File rewind is restricted by current access policy");
      // Shared folders can have other managed writers. Do not rewind over them.
      for(const a of store.listAgents(b.boundary.projectId))if(a.id!==id&&a.workingCopy.rootPath===b.boundary.rootPath&&
        (context.activeRuns.has(a.id)||context.coordinationV3.activeAgentRun(a.id)))throw new Error("Working folder has another active managed writer");
      if(body.operation==='rewind') {
        if(body.acknowledgeFileChanges!==true||!validKey(body.previewKey))throw new Error("Explicit tracked-file restore/delete acknowledgement and preview required");
        const preview=authority.read(id,body.previewKey),r=preview?.result;
        if(!preview||preview.kind!=='preview'||preview.state!=='completed'||Date.now()-Date.parse(preview.createdAt)>60_000||
           r?.boundaryHash!==body.boundaryHash||r.native?.messageId!==body.checkpointId||!r.native.canRewind||r.native.outcome!=='completed'||
           historyHash(nativeRewindFileFacts(b.boundary.rootPath,r.native.filesChanged??[]))!==historyHash(r.facts))throw new Error("Exact fresh file preview changed; review another preview before mutation");
      }
      same(id,b);
      let {receipt}=authority.reserve(b.boundary,body.idempotencyKey,body.operation==='preview'?'preview':'rewind',body,{requestHash:historyHash(body)});
      let native:import('@ponderosa/core').NativeFileRewindResult;
      try {
        native=await b.runtime.session.rewindFiles(body.checkpointId,body.operation==='preview');same(id,b);
        if(native.sessionId!==b.boundary.sessionId||native.messageId!==body.checkpointId||native.dryRun!==(body.operation==='preview'))throw new Error("Native receipt boundary changed");
        if(body.operation==='preview'&&native.outcome==='completed'&&native.canRewind&&!native.filesChanged)throw new Error("Native changed-file inventory unavailable");
        const facts=body.operation==='preview'&&native.outcome==='completed'?nativeRewindFileFacts(b.boundary.rootPath,native.filesChanged??[]):undefined;
        receipt=authority.save(receipt,native.outcome==='completed'?'completed':'started',{native,...(facts?{facts}:{}),boundaryHash:body.boundaryHash});
      }catch(error){request.log.error({err:error},"Native file operation outcome unknown");return reply.code(409).send({receipt,outcome:"outcome_unknown",replayAuthorized:false,error:"Read the original key; never repeat a file mutation from an HTTP failure"});}
      return {receipt,replayed:false,sourceWork:"unchanged",replayAuthorized:false};
    }catch(error){request.log.error({err:error},"Native history request refused or uncertain");return reply.code(409).send({error:"Native history boundary, preview or persistence refused/unconfirmed. Inspect the original key before another action.",replayAuthorized:false});}
    finally{release?.();if(ownsBusy)context.busy.delete(id);}
  });
  app.post<{Params:{id:string};Body:{key?:string}}>("/api/agents/:id/native-history/cancel-preparation",async(request,reply)=>{
    if(!store.getAgent(request.params.id))return reply.code(404).send({error:"Agent not found"});
    if(!validKey(request.body?.key))return reply.code(400).send({error:"Exact prepared fork command key required"});
    try{return {receipt:authority.cancel(request.params.id,request.body.key),nativeInvoked:false};}
    catch{return reply.code(409).send({error:"Only an unstarted preparation may be cancelled; started native outcomes remain unknown"});}
  });
}
function validKey(v:unknown):v is string{return typeof v==='string'&&Boolean(v.trim())&&v.length<=200&&!/[\u0000-\u001f\u007f]/u.test(v);}
