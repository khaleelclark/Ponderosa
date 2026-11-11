import type {BranchesClient} from '@ponderosa/core/branches-client';
import type {BranchDefinition, BranchGateResolution} from '@ponderosa/core';

/** Public-client research/review app. Agent IDs are explicitly supplied, never created implicitly. */
export async function createReviewApplication(client:BranchesClient,input:{researchBranchId:string;researchVersionId:string;parentBranchId:string;parentVersionId:string;researcherId:string;criticId:string;commandKey:string;rememberApproved?:boolean}) {
 const policy={maxConcurrentExecutions:2,failure:{action:'stop' as const}};
 const child:BranchDefinition={schema:'ponderosa.branch.v1',name:'Research with existing tools and memory',trigger:{kind:'manual'},entry:'research',
  parameters:{topic:{type:'text',default:'the supplied question'}},
  steps:[{id:'research',kind:'agent',target:{kind:'persistent_agent',ref:'researcher'},instructions:'Research {{parameter:topic}}. Use your currently permitted tools and memory search when helpful. Distinguish retained evidence from inference; report sources in the canonical result.'}],controls:[],edges:[],policy};
 const subgraph=await client.deploy({chatId:"",branchId:input.researchBranchId,expectedVersionId:input.researchVersionId,idempotencyKey:`${input.commandKey}:child`,definition:child,bindings:{agents:{researcher:input.researcherId},directories:{}}});
 const definition:BranchDefinition={schema:'ponderosa.branch.v1',name:'Parallel research and critique with human review',trigger:{kind:'manual'},entry:'fork',steps:[
  {id:'research',kind:'branch_call',branchRef:'research'},
  {id:'critique',kind:'agent',target:{kind:'persistent_agent',ref:'critic'},instructions:input.rememberApproved?'Search your current Chat memory for earlier approved answers relevant to the question, then independently identify assumptions and risks. Use only permitted tools and return a concise result.':'Independently identify assumptions and risks in the supplied question. Use only your permitted tools and memory. Return a concise canonical result.'},
  {id:'review',kind:'human_gate',prompt:'Review the ordered research and critique results. Edit the proposed answer or reject it.',editable:true},
  ...(input.rememberApproved?[{id:'remember',kind:'agent' as const,target:{kind:'persistent_agent' as const,ref:'critic'},instructions:'Save the approved answer supplied in this task to your current Chat memory using the authorized memory save tool, then return the approved answer. If the save is unavailable or fails, report the failure; do not claim it was saved.'}]:[])],
  controls:[{id:'fork',kind:'fork',joinId:'join'},{id:'join',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:['research-arm','critique-arm']}],
  edges:[{id:'research-arm',from:'fork',to:'research',on:'selected'},{id:'critique-arm',from:'fork',to:'critique',on:'selected'},
   {id:'research-join',from:'research',to:'join',on:'success'},{id:'critique-join',from:'critique',to:'join',on:'success'},{id:'review-result',from:'join',to:'review',on:'success'},
   ...(input.rememberApproved?[{id:'approved-to-memory',from:'review',to:'remember',on:'approved' as const}]:[])],policy};
 const workflow=await client.deploy({chatId:"",branchId:input.parentBranchId,expectedVersionId:input.parentVersionId,idempotencyKey:`${input.commandKey}:parent`,definition,bindings:{agents:{critic:input.criticId},directories:{},branches:{research:subgraph.id}}});
 return {
  workflow,subgraph,
  start:(question:string,occurrenceKey:string)=>client.invoke(workflow.id,question,occurrenceKey),
  async inspect(executionId:string){
   const state=await client.state(executionId);
   if(state.execution.branchId!==workflow.id)throw Error('Execution belongs to another application');
   return {state,actions:await client.actions(executionId),checkpoints:await client.checkpoints(workflow.id,executionId)};
  },
  async resolve(executionId:string,gateId:string,resolution:BranchGateResolution){
   const state=await client.state(executionId),actions=await client.actions(executionId);
   if(state.execution.branchId!==workflow.id||!actions.items.some(item=>item.kind==='gate'&&item.gate.id===gateId))throw Error('Review is not current in this application');
   return client.resolveGate(gateId,resolution);
  },
  async *stream(executionId:string,agentId:string,runId:string,lastEventId?:string){
   const state=await client.state(executionId);
   if(state.execution.branchId!==workflow.id||!state.liveOutputs?.some(output=>output.agentId===agentId&&output.runId===runId))throw Error('Output is not current in this application');
   for await(const message of client.streamAgent(agentId,{lastEventId})){
    const envelope=message.data as {event?:{executionId?:string;type?:string}};
    if(envelope?.event?.executionId===runId&&['text','agent_output'].includes(envelope.event.type??''))yield message;
   }
  },
 };
}
