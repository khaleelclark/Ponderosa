// Existing Docker WebKitGTK only: disposable controlled-provider fixture, no installs.
import assert from 'node:assert/strict';
import {verifyChatInputEvidence} from './verify-chat-input-evidence.mjs';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
const root=fileURLToPath(new URL('../../',import.meta.url));
const output=process.env.QUALIFICATION_DIRECTORY;assert.ok(output,'Set QUALIFICATION_DIRECTORY');await mkdir(output,{recursive:true});
const child=spawn(process.execPath,['--import','./tests/shared/workspace-resolution.mjs','tests/branches/every-input-fixture.mjs'],{cwd:root,stdio:['ignore','pipe','inherit']});
const exited=once(child,'exit');let server,worker;const requests=[];
try{
 const files=['tests/workspace-navigation/webkit-every-input.mjs','tests/workspace-navigation/webkit-every-input.py','tests/workspace-navigation/verify-chat-input-evidence.mjs','tests/workspace-navigation/webkit-clipboard.py','tests/branches/every-input-fixture.mjs','tests/shared/fixture.mjs','apps/web/src/components/chat/Composer.tsx','apps/web/src/components/chat/ComposerEditor.tsx','apps/web/src/components/chat/QueuedMessageTray.tsx','apps/web/src/components/speech/VoiceConversation.tsx','apps/web/src/components/AgentCreateDialog.tsx','apps/web/src/components/decisions/DecisionResponseDialog.tsx','apps/web/src/components/decisions/RuntimeElicitationActions.tsx'];
 const manifest=[];for(const file of files){const bytes=await readFile(path.join(root,file)),target=path.join(output,'source',file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes);manifest.push({file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
 await writeFile(path.join(output,'source-manifest.json'),JSON.stringify(manifest,null,2));
 let fixture;for await(const line of createInterface({input:child.stdout}))if(line.startsWith('{"origin":')){fixture=JSON.parse(line);break;}assert.ok(fixture);
 server=createServer(async(req,res)=>{try{
  const chunks=[];for await(const c of req)chunks.push(c);const bytes=Buffer.concat(chunks),url=new URL(req.url,'http://fixture');
  if(url.pathname==='/api/__qualification/accepted'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(requests.filter(r=>r.status>=200&&r.status<300)));return;}
  let body;try{body=JSON.parse(bytes.toString())}catch{}
  const headers=Object.fromEntries(Object.entries(req.headers).filter(([k])=>!['host','connection','content-length','accept-encoding'].includes(k)));
  if(headers.origin===`http://${req.headers.host}`)headers.origin=fixture.origin;
  const upstream=await fetch(fixture.origin+req.url,{method:req.method,headers,...(bytes.length?{body:bytes}:{})});
  if(req.url.startsWith('/api/')){const responseId=body?.initialMessage&&upstream.ok?(await upstream.clone().json()).id:undefined;requests.push({method:req.method,path:req.url,status:upstream.status,...(body?{body}:{}),...(responseId?{responseId}:{})});}
  res.writeHead(upstream.status,Object.fromEntries([...upstream.headers].filter(([k])=>!['transfer-encoding','connection','content-encoding','content-length'].includes(k))));
  if(upstream.body){const stream=Readable.fromWeb(upstream.body);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res)}else res.end();
 }catch(e){res.writeHead(500);res.end(String(e))}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 await writeFile(path.join(output,'fixture.json'),JSON.stringify({...fixture,upstreamOrigin:fixture.origin,origin},null,2));
 const args=['run','--rm','--pull=never','--network','host','--user',`${process.getuid()}:${process.getgid()}`,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','512','--memory','2g','--cpus','2','--tmpfs','/tmp:rw,nosuid,nodev,size=512m','--shm-size','256m','--mount',`type=bind,src=${path.resolve(output)},dst=/evidence`,'--mount',`type=bind,src=${path.join(root,'tests/workspace-navigation')},dst=/qualification,readonly`,'--env','HOME=/tmp/webkit-qualification','--env',`QUALIFICATION_MODE=${process.env.QUALIFICATION_MODE??'rapid'}`,...['QUALIFICATION_KINDS','QUALIFICATION_PRODUCTS','QUALIFICATION_THEMES'].flatMap(key=>process.env[key]?['--env',key+'='+process.env[key]]:[]),'unified-native-runtime:driver-2.1.0','sh','-eu','-c',`mkdir -p "$HOME"; dbus-run-session -- xvfb-run -a -s '-screen 0 1600x1200x24' sh -eu -c 'WebKitWebDriver --port=4445 > /evidence/driver.log 2>&1 & driver=$!; trap "kill $driver 2>/dev/null || true" EXIT; python3 /qualification/webkit-every-input.py'`];
 await writeFile(path.join(output,'docker-command.json'),JSON.stringify({command:'docker',args},null,2));
 worker=spawn('docker',args,{stdio:'inherit'});const [code]=await once(worker,'exit');
 const cases=JSON.parse(await readFile(path.join(output,'paste-cases.json'),'utf8')),journals=[];
 for(const dir of await readdir(path.join(fixture.root,'data/projects'))){try{journals.push(...(await readFile(path.join(fixture.root,'data/projects',dir,'message-dispatches.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse))}catch(error){if(error.code!=='ENOENT')throw error}}
 await writeFile(path.join(output,'canonical-journal.json'),JSON.stringify(journals,null,2));
 const state={queues:await (await fetch(fixture.origin+'/api/__qualification/queue-snapshots')).json(),decisions:{}};
 for(const item of cases){
  if(item.kind.startsWith('queue')){const current=await (await fetch(fixture.origin+item.prefix+'/agents/'+item.agentId+'/queued-messages')).json();state.queues[item.agentId]=[...(state.queues[item.agentId]??[]),...(Array.isArray(current)?current:current.items??current.messages)];}
  if(item.decisionId){const rows=await (await fetch(fixture.origin+item.prefix+'/decisions?agentId='+item.agentId)).json();state.decisions[item.decisionId]=rows.find(d=>d.id===item.decisionId);}
 }
 await writeFile(path.join(output,'canonical-state.json'),JSON.stringify(state,null,2));
 await writeFile(path.join(output,'requests.json'),JSON.stringify(requests,null,2));
 const equality=await verifyChatInputEvidence(output);assert.equal(code,0,'All focused WebKit flows');console.log('PASS '+equality.length+' complete submitted/canonical clipboard bodies');
}finally{await writeFile(path.join(output,'requests.json'),JSON.stringify(requests,null,2));server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));child.kill('SIGTERM');await exited;}
