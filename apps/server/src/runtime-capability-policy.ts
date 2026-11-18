import {BUILT_IN_CAPABILITIES,CAPABILITY_IDS} from "@ponderosa/core";
import {CapabilityPolicyStore,type AgentStore} from "@ponderosa/agents";
import type {FastifyInstance} from "fastify";
import type {AgentMessageCapability} from "./app-contracts.js";

/** Recheck mutable restrictions at the server boundary as well as at session creation. */
export function runtimeCapabilityAllows(store:AgentStore,capability:Pick<AgentMessageCapability,'agentId'|'runId'>,toolName:string):boolean {
  const policy=new CapabilityPolicyStore(store.sqlite).resolveForAgent(capability.agentId,capability.runId);
  return !BUILT_IN_CAPABILITIES.some(descriptor=>descriptor.runtimeToolNames?.includes(toolName)&&policy.restrictedCapabilityIds.includes(descriptor.id));
}

export function registerRuntimeCapabilityPolicy(app:FastifyInstance,store:AgentStore,capabilities:ReadonlyMap<string,AgentMessageCapability>):void {
  app.addHook('preHandler',async(request,reply)=>{
    if(request.method!=='POST')return;
    const route=request.routeOptions.url??'';
    if(!['/api/agent-spawn','/api/agent-management','/api/agent-browser','/api/agent-import-file'].includes(route))return;
    const token=request.headers.authorization?.replace(/^Bearer\s+/iu,''),capability=token?capabilities.get(token):undefined;
    // Existing endpoint authorization still owns invalid/expired bearer refusal.
    if(!capability)return;
    const body=request.body&&typeof request.body==='object'&&!Array.isArray(request.body)?request.body as Record<string,unknown>:{};
    const toolName=route==='/api/agent-spawn'?'ponderosa_create_managed_agent':route==='/api/agent-import-file'?'ponderosa_import_file':route==='/api/agent-browser'&&typeof body.operation==='string'?`ponderosa_browser_${body.operation}`:undefined;
    try {
      if(toolName&&!runtimeCapabilityAllows(store,capability,toolName))return reply.code(403).send({error:'This capability is restricted for this Run'});
      if(route==='/api/agent-management'){
        const plan=body.action==='apply'&&typeof body.planId==='string'?store.getAgentManagementPlan(body.planId):undefined;
        const operations=plan?.agentId===capability.agentId?plan.operations:body.operations;
        const creates=Array.isArray(operations)&&operations.some(operation=>operation&&typeof operation==='object'&&operation.kind==='create_agent');
        if(creates&&new CapabilityPolicyStore(store.sqlite).resolveForAgent(capability.agentId,capability.runId).restrictedCapabilityIds.includes(CAPABILITY_IDS.managedAgentCreate))return reply.code(403).send({error:'Managed Agent creation is restricted for this Run'});
      }
    }catch{return reply.code(403).send({error:'Capability policy is unavailable; this operation was refused'});}
  });
}
