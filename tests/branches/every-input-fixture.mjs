// Built development assets and a disposable real API; controlled providers, loopback only.
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {fixture,until} from '../shared/fixture.mjs';
const f=await fixture(),requests=[];
const branch=f.ok(await f.api('POST','/api/branches',{name:'Paste qualification Branch',idempotencyKey:randomUUID()}));
const assistant=f.ok(await f.api('POST','/api/branches/assistant',{initialize:true}));
let api=await f.listen();const web=path.resolve(fileURLToPath(new URL('../../apps/web/dist/',import.meta.url)));
const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml','.json':'application/json'};
const held=new Map(),queueSnapshots=new Map();
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/__qualification/queue-snapshots'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(Object.fromEntries(queueSnapshots)));return;}
  if(url.pathname==='/api/__qualification/prepare'&&req.method==='POST'){
   for(const [id,prefix] of held){const current=f.ok(await f.api('GET',`${prefix}/agents/${id}/queued-messages`));queueSnapshots.set(id,[...(queueSnapshots.get(id)??[]),...(Array.isArray(current)?current:current.items??current.messages)]);f.sessions.get(id)?.finish();}held.clear();
   const chunks=[];for await(const c of req)chunks.push(c);const {product,kind}=JSON.parse(Buffer.concat(chunks));const isBranch=product!=='core',prefix=isBranch?'/api/branches/engine':'/api';
   const sourceTitle='Paste '+kind+' '+randomUUID().slice(0,8);let c=isBranch?f.ok(await f.api('POST',`/api/branches/${branch.id}/chats`,{label:sourceTitle,defaultEngine:'codex'},{'idempotency-key':randomUUID()})):await f.createChat(sourceTitle);
   let a=f.ok(await f.api('POST',`${prefix}/projects/${c.projectId}/agents`,{title:'Paste recipient',engine:'codex',conversationId:c.id,idempotencyKey:randomUUID()}));
   if(product==='assistant'){
    c={id:assistant.app.chatId,projectId:assistant.app.projectId};a=f.ok(await f.api('GET',`${prefix}/agents/${assistant.app.agentId}`)).agent;
   }
   let app;if(product==='output')app=f.ok(await f.api('PUT',`/api/branches/output-apps/${a.id}`,{enabled:true})).app;
   if(kind==='initial')f.plans.set(a.id,[{output:false,run:async()=>{}}]);
   let decision,execution;let before=f.turns.filter(t=>t.agentId===a.id).length;
   const started=()=>until(()=>f.turns.filter(t=>t.agentId===a.id).length>before&&f.sessions.get(a.id),'current scoped provider turn');
   const send=(text,extra={})=>{before=f.turns.filter(t=>t.agentId===a.id).length;return f.api('POST',`${prefix}/agents/${a.id}/messages`,{text,idempotencyKey:randomUUID(),...extra}).then(f.ok);};
   const settled=()=>until(async()=>{const d=f.ok(await f.api('GET',`${prefix}/agents/${a.id}`));return f.turns.filter(t=>t.agentId===a.id).length>before&&!d.runs.some(r=>['running','preparing'].includes(r.status));},'scoped provider settlement');
   if(kind.startsWith('runtime-')){
    f.plans.set(a.id,[{hold:true}]);await send('Hold for provider alternative');await started();
    void f.sessions.get(a.id).elicit(kind==='runtime-url-other'?{mode:'url',serverName:'Controlled service',message:'Choose another instruction',url:'https://example.com/controlled-connection',elicitationId:randomUUID()}:{mode:'form',serverName:'Controlled service',message:'Choose another instruction',requestedSchema:{type:'object',properties:{}}}).then(()=>f.sessions.get(a.id).finish());
    decision=await until(async()=>f.ok(await f.api('GET',`${prefix}/decisions?agentId=${a.id}`)).find(d=>d.runtimeAction),'provider alternative Decision');
   }

   if(['inbox','queue-inbox','call-inbox'].includes(kind)){await send('Seed exact reply target');await settled();}
   if(kind.startsWith('decision')){
    f.plans.set(a.id,[{output:false,run:async session=>{decision=f.ok(await f.tool(session,'ponderosa_decision',{...(kind==='decision-group'?{questions:[{id:'first',question:'First exact answer',mode:'text'},{id:'second',question:'Second exact alternative',mode:'choice',options:[{id:'yes',label:'Use proposed response'}]},{id:'third',question:'Third exact answer',mode:'text'}]}:{question:'Paste conditional '+kind,mode:kind==='decision-approval'?'approval':['decision-text','decision-notification','decision-inbox','decision-chat','decision-execution'].includes(kind)?'text':'choice',...(['decision-text','decision-notification','decision-inbox','decision-chat','decision-execution','decision-approval'].includes(kind)?{}:{options:[{id:'yes',label:'Use proposed response'}]})}),blocking:true,idempotencyKey:randomUUID()}));}}]);
    if(kind==='decision-execution'){
     const owner=f.ok(await f.api('GET',`/api/branches/${branch.id}`));
     f.ok(await f.api('POST','/api/branches/deploy',{branchId:branch.id,expectedVersionId:owner.versionId??'',chatId:'',idempotencyKey:randomUUID(),definition:{schema:'ponderosa.branch.v1',name:'Paste execution Decision',trigger:{kind:'manual'},entry:'ask',steps:[{id:'ask',label:'Ask exact paste question',kind:'agent',target:{kind:'persistent_agent',ref:'writer'},instructions:'Ask the controlled paste question'}],controls:[],edges:[],policy:{maxConcurrentExecutions:10,maxPathInstances:1000,maxStepInvocations:1000,failure:{action:'stop'}}},bindings:{agents:{writer:a.id},directories:{}}}));
     execution=f.ok(await f.api('POST',`/api/branches/${branch.id}/executions`,{occurrenceKey:randomUUID(),input:'Ask controlled execution question'}));await until(()=>decision,'execution-owned Decision');
    }else{await send('Ask paste fixture question');await settled();}
   }
   if(kind.startsWith('queue')){
    held.set(a.id,prefix);f.plans.set(a.id,[{hold:true}]);await send('Hold for queued input');await started();if(kind==='queue')await send('Replace this queued draft',{activeRunDelivery:'queue'});else f.ok(await f.api('POST',`${prefix}/conversations/${c.id}/direct-messages`,{text:'Replace this queued draft',idempotencyKey:randomUUID(),recipients:[{agentId:a.id}],activeRunDelivery:'queue'}));
   }
   const nested=kind.endsWith('-chat')?`/projects/${c.projectId}/chats/${c.id}`:`/projects/${c.projectId}/agents/${a.id}`;const route=execution?`/branches?branch=${branch.id}&tab=executions&execution=${execution.id}`:product==='assistant'?'/assistant':product==='output'?app.url:['inbox','queue-inbox','call-inbox','decision-inbox'].includes(kind)?'/messages':kind==='initial'&&!isBranch?`/create/agent?project=${c.projectId}&chat=${c.id}`:isBranch?`/branches?branch=${branch.id}&tab=chats&chat=${c.id}&workspace=${encodeURIComponent(nested)}`:nested;
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({chat:c,agent:a,decision,prefix,route,sourceTitle}));return;
  }
  if(url.pathname.startsWith('/api/')){
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);
   const upstream=await fetch(api+req.url,{method:req.method,headers:{...Object.fromEntries(Object.entries(req.headers).filter(([name])=>!['host','connection','content-length','accept-encoding'].includes(name))),host:new URL(api).host,...(req.headers.origin===`http://${req.headers.host}`?{origin:new URL(api).origin}:{})},...(bytes.length?{body:bytes}:{})});
   requests.push({method:req.method,path:req.url,status:upstream.status});if(requests.length>1500)requests.shift();
   res.writeHead(upstream.status,Object.fromEntries([...upstream.headers].filter(([name])=>!['transfer-encoding','connection','content-encoding','content-length'].includes(name))));
   if(upstream.body){const stream=Readable.fromWeb(upstream.body);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);}else res.end();return;
  }
  if(['/sw.js','/register-sw.js'].includes(url.pathname)){res.writeHead(404);res.end();return;}
  const relative=decodeURIComponent(url.pathname).replace(/^\//,'');
  const target=path.resolve(web,relative);if(target!==web&&!target.startsWith(web+path.sep)){res.writeHead(404);res.end();return;}
  let bytes,file=target;try{bytes=await readFile(file);}catch{file=path.join(web,'index.html');bytes=await readFile(file);}
  res.writeHead(200,{'content-type':mime[path.extname(file)]??'application/octet-stream','cache-control':'no-store'});res.end(bytes);
 }catch(error){res.writeHead(500);res.end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const manifest={origin,root:f.root,branchId:branch.id,assistant};
await writeFile(path.join(f.root,'ui-fixture.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest));
let stopping=false;async function stop(){if(stopping)return;stopping=true;server.closeAllConnections();server.close();await f.dispose(false);process.exit();}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
