// Real current-master web assets and API, synthetic provider/data, loopback only.
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {fixture} from '../shared/fixture.mjs';
const f=await fixture(),requests=[];
const branch=f.ok(await f.api('POST','/api/branches',{name:'Current master Branch QA',idempotencyKey:randomUUID()}));
const chat=f.ok(await f.api('POST',`/api/branches/${branch.id}/chats`,{label:'Scrollable Branch Chat',defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
const agents=[];
for(let i=1;i<=1;i++)agents.push(f.ok(await f.api('POST',`/api/branches/engine/projects/${chat.projectId}/agents`,{title:`Branch roster ${String(i).padStart(3,'0')}`,engine:'codex',conversationId:chat.id,idempotencyKey:randomUUID(),...(i>1&&i<=16?{managerAgentId:agents[0].id}:{})})));
const second=f.ok(await f.api('POST','/api/branches',{name:'Folder companion',idempotencyKey:randomUUID()}));
const preferences=f.ok(await f.api('GET','/api/branches/engine/workspace/preferences'));
f.ok(await f.api('PATCH','/api/branches/engine/workspace/preferences',{branchFolders:[{id:randomUUID(),name:'Qualification workflows',expanded:true,branchIds:[branch.id,second.id]}],branchFoldersRevision:preferences.revision}));
await writeFile(path.join(chat.workingDirectory,'qualification.md'),'# Current master file preview\n\nSynthetic Branch evidence.\n');
const normal=await f.createChat('Normal product compatibility');await f.createIdleAgent(normal,'Normal compatibility Agent');
const assistant=f.ok(await f.api('POST','/api/branches/assistant',{initialize:true}));
let api=await f.listen();const web=path.resolve(fileURLToPath(new URL('../../apps/web/dist/',import.meta.url)));
const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml','.json':'application/json'};
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/__qualification/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({root:f.root,branch,chat,agents,normal,requests}));return;}
  if(url.pathname==='/api/__qualification/reopen'&&req.method==='POST'){await f.reopen();api=await f.listen();res.writeHead(200,{'content-type':'application/json'});res.end('{"reopened":true}');return;}
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
const origin=`http://127.0.0.1:${server.address().port}`,route=`/branches?branch=${branch.id}&tab=chats&chat=${chat.id}`;
const manifest={origin,route,url:origin+route,normalUrl:origin+`/projects/${normal.projectId}/chats/${normal.id}`,root:f.root,branchId:branch.id,chatId:chat.id,assistant,coreConversationId:normal.id};
await writeFile(path.join(f.root,'ui-fixture.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest));
let stopping=false;async function stop(){if(stopping)return;stopping=true;server.closeAllConnections();server.close();await f.dispose(false);process.exit();}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
