import {CapabilityPolicyStore,type AgentStore,type CoordinationV3Store} from '@ponderosa/agents';
import {CAPABILITY_IDS} from '@ponderosa/core';
import type {ActiveRun} from './app-contracts.js';

/** Fences only currently owned Codex Runs affected by an actual restriction.
 * The stored pause explicitly holds ordinary checkpoint recovery. */
export function createActiveAccessRevocation(context:{
 store:AgentStore;coordinationV3:CoordinationV3Store;activeRuns:Map<string,ActiveRun>;
 ownsRun:(agentId:string,run:ActiveRun)=>boolean;
 wakeScheduler:()=>void;publishPause:(agentId:string)=>void;
 logError:(error:unknown,operation:string)=>void;
}) {
 const policies=new CapabilityPolicyStore(context.store.sqlite);
 // The database mutation is already committed. A notification failure must
 // neither pretend it rolled back nor prevent the memory grant from changing.
 const notify=(affected:string[])=>{
  if(!affected.length)return;
  try{context.wakeScheduler();}catch(error){context.logError(error,'wake scheduler');}
  for(const agentId of affected)try{context.publishPause(agentId);}catch(error){context.logError(error,'publish pause');}
 };
 const candidates=()=>[...context.activeRuns].filter(([agentId,run])=>
  run.runtimeEngineId==='codex' && !!run.v3SchedulerRunId && context.ownsRun(agentId,run));
 const hold=(agentId:string,run:ActiveRun)=>{
  context.coordinationV3.pauseAgentRun({agentId,runId:run.v3SchedulerRunId!,
   idempotencyKey:`access-revocation:${run.v3SchedulerRunId}`,accessRevocationHold:true});
 };
 const policyChange=<T>(apply:()=>T):T=>{
  const affected:string[]=[];
  const result=context.store.sqlite.transaction(()=>{
   const before=candidates().map(([agentId,run])=>({agentId,run,
    restricted:new Set(policies.resolveForAgent(agentId,run.v3SchedulerRunId).restrictedCapabilityIds)}));
   const value=apply();
   for(const item of before){
    if(!context.ownsRun(item.agentId,item.run))continue;
    const after=policies.resolveForAgent(item.agentId,item.run.v3SchedulerRunId).restrictedCapabilityIds;
    if(after.some(id=>!item.restricted.has(id))){hold(item.agentId,item.run);affected.push(item.agentId);}
   }
   return value;
  })();
  notify(affected);
  return result;
 };
 const beforeGlobalMemoryRevocation=(chatId:string):void=>{
  const affected:string[]=[];
  context.store.sqlite.transaction(()=>{
   for(const [agentId,run] of candidates()){
    const home=run.homeConversationId??run.conversationId;
    if(home!==chatId&&context.store.getAgent(agentId)?.conversationId!==chatId)continue;
    // Global read was already ineffective if memory reading was restricted.
    if(policies.resolveForAgent(agentId,run.v3SchedulerRunId).restrictedCapabilityIds.includes(CAPABILITY_IDS.memoryRead))continue;
    hold(agentId,run);affected.push(agentId);
   }
  })();
  notify(affected);
 };
 return {policyChange,beforeGlobalMemoryRevocation};
}
