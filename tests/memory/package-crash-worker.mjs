// Parent releases this disposable store before the worker owns it. No provider call is permitted.
import {AgentStore} from '@ponderosa/agents';
import {createServer} from '../../apps/server/dist/app.js';
import {localMemoryFor} from '../../apps/server/dist/local-memory.js';
process.once('message',async({options,payload,key})=>{
 const adapter={id:'fixture',displayName:'Inert',listModels:()=>[{id:'fixture',label:'Fixture'}],listEfforts:()=>[{id:'medium',label:'Medium'}],defaultModel:()=>'fixture',defaultEffort:()=>'medium',async*seed(){throw Error('No provider turn allowed');},async*continue(){throw Error('No provider turn allowed');}};
 const store=new AgentStore(options.dataDir),app=createServer({...options,store,engines:[{adapter,authStatus:async()=>({authenticated:true})}]});await app.ready();
 const raw=localMemoryFor(app).core.database.raw,original=raw.client.getCollection.bind(raw.client);
 raw.client.getCollection=async args=>{const c=await original(args),upsert=c.upsert.bind(c);c.upsert=async input=>{await upsert(input);if(input.metadatas?.some(m=>m.host_package_operation))process.kill(process.pid,'SIGKILL');};return c;};
 await app.inject({method:'POST',url:`/api/projects/${payload.projectId}/import-agents`,headers:{authorization:'Bearer '+options.authToken,'idempotency-key':key},payload:payload.body});
 throw Error('Crash probe did not reach package memory write');
});
