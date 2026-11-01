import type {BranchDefinition} from '@ponderosa/core';
import type {BranchesClient} from '@ponderosa/core/branches-client';
/** Caller-provided working directory and explicit invocation; importing this file runs nothing. */
export async function createStateApplication(client:BranchesClient,input:{chatId:string;directory:string;commandKey:string}){
 const definition:BranchDefinition={schema:'ponderosa.branch.v1',name:'Shared state aggregation',trigger:{kind:'manual'},entry:'fork',
  state:{observations:{initial:[],reducer:'append'},total:{initial:0,reducer:'sum'},summary:{initial:null,reducer:'replace'}},
  steps:[
   ...[2,3].map(n=>({id:`worker${n}`,kind:'script' as const,runtime:'node' as const,cwdRef:'root',timeoutMs:5000,stateWrites:['observations','total'],source:`console.log(JSON.stringify({observations:[${n}],total:${n}}));`})),
   {id:'reduce',kind:'script',runtime:'node',cwdRef:'root',timeoutMs:5000,stateWrites:['summary'],source:`const {values}=globalThis.ponderosaState;console.log(JSON.stringify({summary:{maximum:Math.max(...values.observations),total:values.total}}));`}],
  controls:[{id:'fork',kind:'fork',joinId:'join'},{id:'join',kind:'join',forkId:'fork',mode:'all',remainder:'finish',inputOrder:['two','three']}],
  edges:[{id:'two',from:'fork',to:'worker2',on:'selected'},{id:'three',from:'fork',to:'worker3',on:'selected'},{id:'two-done',from:'worker2',to:'join',on:'success'},{id:'three-done',from:'worker3',to:'join',on:'success'},{id:'reduce-result',from:'join',to:'reduce',on:'success'}],
  policy:{maxConcurrentExecutions:2,failure:{action:'stop'}}};
 const workflow=await client.deploy({chatId:input.chatId,idempotencyKey:input.commandKey,definition,bindings:{agents:{},directories:{root:input.directory}}});
 return {workflow,start:(text:string,key:string)=>client.invoke(workflow.id,text,key),read:(id:string)=>client.sharedState(id)};
}
