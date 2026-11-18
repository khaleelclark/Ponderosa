// A separate app using only the public client, REST and SSE. No Ponderosa stores or provider hooks.
import {createServer} from 'node:http';
import {BranchesClient} from '@ponderosa/core/branches-client';
const client=new BranchesClient(process.env.PONDEROSA_URL??'http://127.0.0.1:3000');
const branchId=process.env.BRANCH_ID;
if(!branchId)throw Error('Set BRANCH_ID to a published workflow');
const server=createServer(async(req,res)=>{
 const abort=new AbortController();res.on('close',()=>abort.abort());
 try{
  const url=new URL(req.url,'http://localhost'),options={signal:abort.signal};
  const body=async()=>{let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>1024*1024)throw Error('App input exceeds 1 MiB');}return JSON.parse(text||'{}');};
  const json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
  if(req.method==='POST'&&url.pathname==='/runs'){
   const input=await body();if(typeof input.text!=='string'||typeof input.occurrenceKey!=='string')throw Error('text and occurrenceKey are required');
   json(await client.invoke(branchId,input.text,input.occurrenceKey,options));return;
  }
  const match=url.pathname.match(/^\/runs\/([^/]+)(?:\/(actions|cancel|result))?$/u);
  if(match){
   const id=decodeURIComponent(match[1]);
   // Check the execution's workflow before operating on the public execution id.
   const detail=await client.state(id,undefined,options);if(detail.execution.branchId!==branchId){res.writeHead(404);res.end();return;}
   if(req.method==='POST'&&match[2]==='cancel'){json(await client.cancel(id,options));return;}
   if(req.method==='GET'){json(match[2]==='actions'?await client.actions(id,undefined,options):match[2]==='result'?await client.result(id,options):detail);return;}
  }
  if(req.method==='POST'&&url.pathname==='/gate'){
   const {executionId,gateId,...resolution}=await body();const detail=await client.state(executionId,undefined,options);
   const actions=await client.actions(executionId,undefined,options);
   if(detail.execution.branchId!==branchId||!actions.items.some(item=>item.kind==='gate'&&item.gate.id===gateId))throw Error('Gate is not current in this app');
   json(await client.resolveGate(gateId,resolution,options));return;
  }
  // Forward canonical exact-Run response chunks without inventing a second history.
  if(req.method==='GET'&&url.pathname==='/stream'){
   const executionId=url.searchParams.get('executionId'),agentId=url.searchParams.get('agentId'),runId=url.searchParams.get('runId');
   const detail=await client.state(executionId,undefined,options);
   if(detail.execution.branchId!==branchId||!detail.liveOutputs?.some(output=>output.agentId===agentId&&output.runId===runId))throw Error('No current output target');
   res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
   for await(const message of client.streamAgent(agentId,{...options,lastEventId:req.headers['last-event-id']})){
    const envelope=message.data;
    if(message.event==='agent_status'||(envelope?.event?.executionId===runId&&['text','agent_output'].includes(envelope.event.type))){
     if(message.id)res.write(`id: ${message.id}\n`);
     res.write(`event: ${message.event}\ndata: ${JSON.stringify(envelope)}\n\n`);
    }
   }
   res.end();return;
  }
  res.writeHead(404);res.end();
 }catch(error){if(!res.headersSent){res.writeHead(error.status??400,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}else res.destroy(error);}
});
server.listen(Number(process.env.PORT??3030),'127.0.0.1');
