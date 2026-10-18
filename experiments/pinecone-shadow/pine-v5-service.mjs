import path from 'node:path';
import {servePineconeProduct,pineconeDecisionResponseAllowed,v5Identity} from './pinecone-product-proxy.ts';
import http from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {AgentStore} from './source/packages/agents/dist/index.js';
import {defaultEngineRegistrations} from './source/packages/engines/dist/index.js';
import {loadConfig} from './source/packages/core/dist/config.js';
import {WebPushDeliveryManager} from './source/apps/server/dist/web-push-delivery.js';
import {createServer} from './source/apps/server/dist/app.js';
import {candidateMutationAllowed} from './source/preview-policy.mjs';
WebPushDeliveryManager.prototype.start=function(){void this.stop()};
const root=new URL('./',import.meta.url),dataDir=path.resolve(new URL('./validation-20261016/data/',root).pathname);
const origin='http://100.88.80.22:18795',internalOrigin='http://127.0.0.1:18793';
process.env.PONDEROSA_HOST='127.0.0.1';process.env.PONDEROSA_PORT='18793';process.env.PONDEROSA_DATA_DIR=dataDir;process.env.PONDEROSA_AGENT_BASE_URL=internalOrigin;
process.env.PATH='/opt/ponderosa-server/current/runtime:/usr/local/bin:/usr/bin:/bin';
const ids={v3:'592f4798-cd48-445a-91f2-9f9a86b1c135',v4:'0356095a-8d73-4249-b39d-883b978ae119',v5:'49005cab-f4d3-4b38-a468-bf153624e4f4'};
const config=loadConfig({PONDEROSA_DATA_DIR:dataDir,PONDEROSA_HOST:'100.88.80.22',PONDEROSA_PORT:'18795',PONDEROSA_TRUSTED_TAILNET:'true'});
const store=new AgentStore(dataDir);
const engines=defaultEngineRegistrations({...process.env,PONDEROSA_CODEX_BIN:'/usr/local/bin/codex'}).filter(e=>e.adapter.id==='codex');
const app=createServer({dataDir,store,engines,startDrained:true,logger:true,webDist:new URL('./source/candidate-web-dist/',root).pathname,networkSecurity:config.networkSecurity,agentBaseUrl:internalOrigin,communicationV3:{maxConcurrentRuns:3}});
let front,stopping=false;
async function stop(){if(stopping)return;stopping=true;if(front)await new Promise(resolve=>front.close(resolve));app.prepareForShutdown();await app.close();process.exit(0)}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
async function invoke(method,url,payload){const r=await app.inject({method,url,payload,headers:{host:'127.0.0.1:18793'}});if(r.statusCode>=400)throw Error(method+' '+url+' '+r.statusCode+' '+r.body.slice(0,2000));return r.json();}
const prepared={at:new Date().toISOString(),actions:[],qualifications:{}};
try{
 await app.ready();
 const stale=['6897b947-7d1b-4814-9db7-27aa3bbf7fb6','78a80f59-ac40-4d9c-8a6d-833b18e3e550','433614ed-5427-48b3-a370-678b4b82a68d','92f96bbe-e41b-4359-ac75-da85ee16d174'];
 for(const eid of stale){const e=store.sqlite.prepare('SELECT id,state,revision,branch_id FROM branch_executions WHERE id=?').get(eid);if(!e||!['queued','waiting','running'].includes(e.state))continue;if(!Object.values(ids).includes(e.branch_id))throw Error('Unexpected stale-work owner');
  const reason=eid==='92f96bbe-e41b-4359-ac75-da85ee16d174'?'Pine migration: retire stale October14 manual outcome-unknown execution without retry or an assertion of success; preserve its evidence. Fresh comparison work is separately authorized.':'Pine migration: skip overdue automatic occurrence accepted during paused validation; preserve audit and avoid a catch-up burst.';
  await invoke('POST','/api/branch-executions/'+eid+'/intervene',{action:'skip',expectedRevision:e.revision,commandKey:'pine-migration-no-replay-20261016-'+eid,reason});prepared.actions.push({action:'skip_stale',id:eid,reason});
 }
 for(const [version,bid] of Object.entries(ids)){
  let b=await invoke('GET','/api/branches/'+bid);const definition=(await invoke('GET','/api/branches/'+bid+'/versions/'+b.versionId)).definition;
  const bindings=await invoke('GET','/api/branches/'+bid+'/configuration');let changed=false;
  for(const [key,value] of Object.entries(bindings.directories)){const next=value.replace('/runtime/workspaces/','/validation-20261016/workspaces/');if(next!==value){bindings.directories[key]=next;changed=true;}}
  if(changed){b=await invoke('POST','/api/branches/deploy',{chatId:b.chatId,branchId:bid,expectedVersionId:b.versionId,idempotencyKey:'pine-final-workspace-binding-20261016-'+bid,definition,bindings});prepared.actions.push({action:'align_workspace_binding',version,versionId:b.versionId});}
  for(const aid of Object.values(bindings.agents)){
   const row=store.sqlite.prepare('SELECT active_session_id FROM agents WHERE id=?').get(aid);
   if(row?.active_session_id){await invoke('PATCH','/api/branches/engine/agents/'+aid,{workingCopyMode:'shared'});prepared.actions.push({action:'clear_old_provider_session',version,agentId:aid});}
  }
  const scout=store.getAgent(bindings.agents.scout);
  const caps=await invoke('GET','/api/branches/engine/projects/'+scout.projectId+'/engine-capabilities?engineId=codex&agentId='+scout.id+'&model=gpt-5.6-sol&refresh=true');
  const cap=caps.find(x=>x.engineId==='codex');const selected=cap?.selectedModel??(typeof cap?.model==='string'?cap.model:cap?.model?.id);if(!cap?.discovered||selected!=='gpt-5.6-sol')throw Error('Exact model runtime discovery failed: '+JSON.stringify(caps).slice(0,1500));
  const model=engines[0].adapter.listModels().find(m=>m.id==='gpt-5.6-sol');if(!model?.efforts?.some(e=>e.id===(version==='v3'?'low':'high')))throw Error('Saved reasoning level unavailable');
  prepared.qualifications[version]={model:selected,at:new Date().toISOString(),mcpServers:cap.mcpServers,capabilityModel:cap.model};
  if(version!=='v4'){
   const qfile=new URL('./validation-20261016/workspaces/candidates/'+version+'/pinecone-runtime-capability.json',root);const q=JSON.parse(await readFile(qfile,'utf8'));
   q.supported=true;q.verifiedAt=new Date().toISOString();q.provenance='Pine authenticated Codex app-server session capability discovery accepted exact gpt-5.6-sol; current provider catalog supports '+q.effort+' reasoning. First genuine cycle receipts remain subject to unchanged delivery guard.';
   await writeFile(qfile,JSON.stringify(q)+'\n',{mode:0o600});
  }
 }
 const unrelated=store.sqlite.prepare('SELECT id FROM trigger_definitions WHERE enabled!=0 AND branch_id NOT IN (?,?,?)').all(...Object.values(ids));if(unrelated.length)throw Error('Unrelated enabled trigger prevents scoped activation');
 await writeFile(new URL('./evidence/activation-preparation.json',root),JSON.stringify(prepared,null,2)+'\n');
 await app.listen({host:'127.0.0.1',port:18793});
 const installations=[{branchId:ids.v4,spokespersonId:'f1e52ee0-6966-471c-bfe4-c9d04233a39a',triggerId:'31ecb11b-7afd-4e2b-a6f3-ee18f46f8f49',deliveryMode:'user-ui',supported:true}];
 for(const v of ['v3','v5'])installations.push({...JSON.parse(await readFile(new URL('./validation-20261016/workspaces/candidates/'+v+'/pinecone-runtime-capability.json',root),'utf8')),branchId:ids[v]});
 front=http.createServer(async(req,res)=>{
  try{
   if(await servePineconeProduct(req,res,new URL('./consumer-ui-current/',root).pathname))return;
   const u=new URL(req.url,origin),match=u.pathname.match(/^\/api\/(?:branches\/engine\/)?pinecone-candidate\/([^/]+)\/runtime$/);
   if(req.method==='GET'&&match){const version=Object.entries(ids).find(([v,id])=>id===match[1]&&v!=='v4')?.[0];if(version){const q=JSON.parse(await readFile(new URL('./validation-20261016/workspaces/candidates/'+version+'/pinecone-runtime-capability.json',root),'utf8'));res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({model:q.model,effort:q.effort,supported:q.supported,verifiedAt:q.verifiedAt,deliveryMode:q.deliveryMode,executionDrained:false}));return;}}
   let body;
   if(!['GET','HEAD'].includes(req.method)){
    if(req.headers.origin&&req.headers.origin!==origin){res.writeHead(403);res.end('Cross-origin mutation forbidden');return;}
    let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>9*1024*1024){res.writeHead(413);res.end();return;}}
    let parsed;try{parsed=JSON.parse(raw)}catch{}
    const decisionMatch=u.pathname.match(/^\/api\/(?:branches\/engine\/)?decisions\/([^/]+)\/respond$/);
    let decisionAllowed=false;
    if(req.method==='POST'&&decisionMatch){
     const decisions=await invoke('GET','/api/branches/engine/decisions?agentId='+v5Identity.agentId+'&projectId='+v5Identity.projectId+'&conversationId='+v5Identity.conversationId);
     decisionAllowed=pineconeDecisionResponseAllowed(decisions.find(d=>d.id===decisionMatch[1]),parsed);
    }
    if(!candidateMutationAllowed(req.method,u.pathname,parsed,installations)&&!decisionAllowed){res.writeHead(403);res.end('Only authorized v3/v4/v5 chat, check-now and schedule controls are exposed.');return;}
    const speaker=installations.find(i=>u.pathname.endsWith('/agents/'+i.spokespersonId+'/messages'));
    body=speaker?.model?JSON.stringify({...parsed,model:speaker.model,effort:speaker.effort}):raw;
   }
   const headers={...req.headers};delete headers['x-ponderosa-v3-dispatch'];
   if(body!==undefined){delete headers['transfer-encoding'];headers['content-length']=String(Buffer.byteLength(body));}
   const upstream=http.request({hostname:'127.0.0.1',port:18793,path:req.url,method:req.method,headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res)});
   upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Pinecone backend unavailable')});if(body!==undefined)upstream.end(body);else req.pipe(upstream);res.on('close',()=>{if(!res.writableEnded)upstream.destroy()});
  }catch(e){if(!res.headersSent)res.writeHead(500);res.end('Pinecone request failed');app.log.error(e);}
 });
 await new Promise((resolve,reject)=>{front.once('error',reject);front.listen(18795,'100.88.80.22',resolve)});
 console.log('PINECONE_PREPARED model-qualified; all schedules still disabled; runtime drained; frontend ready '+origin);
 const marker=await readFile(new URL('./evidence/activation-cycles.json',root),'utf8').then(JSON.parse).catch(()=>undefined);
 if(marker?.allThreeCompleted){await invoke('POST','/api/deployment/resume',{});console.log('PINECONE_RESUMED prior verified activation');}
}catch(e){console.error('PINECONE_ACTIVATION_BOOT_FAILED',e);app.prepareForShutdown();await app.close();process.exit(1)}
