// Existing Docker WebKitGTK only: disposable controlled-provider fixture, no installs.
import assert from 'node:assert/strict';
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
const child=spawn(process.execPath,['--import','./tests/shared/workspace-resolution.mjs','tests/branches/ui-qualification.mjs'],{cwd:root,stdio:['ignore','pipe','inherit']});
const exited=once(child,'exit');let server,worker,fault;const requests=[];
try{
 let fixture;for await(const line of createInterface({input:child.stdout}))if(line.startsWith('{"origin":')){fixture=JSON.parse(line);break;}assert.ok(fixture);
 server=createServer(async(req,res)=>{try{
  const chunks=[];for await(const c of req)chunks.push(c);const bytes=Buffer.concat(chunks),url=new URL(req.url,'http://fixture');
  if(url.pathname==='/api/__qualification/fault'&&req.method==='POST'){fault=JSON.parse(bytes.toString());res.writeHead(200,{'content-type':'application/json'});res.end('{}');return;}
  let body;try{body=JSON.parse(bytes.toString())}catch{}
  const reject=req.method==='PATCH'&&((fault?.kind==='rename'&&body?.title)||(fault?.kind==='font'&&body?.fontFamily));
  if(reject){requests.push({method:req.method,path:req.url,status:503,body});res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'WebKit qualification '+fault.kind+' outage'}));return;}
  const headers=Object.fromEntries(Object.entries(req.headers).filter(([k])=>!['host','connection','content-length','accept-encoding'].includes(k)));
  if(headers.origin===`http://${req.headers.host}`)headers.origin=fixture.origin;
  const upstream=await fetch(fixture.origin+req.url,{method:req.method,headers,...(bytes.length?{body:bytes}:{})});
  if(req.url.startsWith('/api/'))requests.push({method:req.method,path:req.url,status:upstream.status,...(body?{body}:{})});
  res.writeHead(upstream.status,Object.fromEntries([...upstream.headers].filter(([k])=>!['transfer-encoding','connection','content-encoding','content-length'].includes(k))));
  if(upstream.body){const stream=Readable.fromWeb(upstream.body);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res)}else res.end();
 }catch(e){res.writeHead(500);res.end(String(e))}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 await writeFile(path.join(output,'fixture.json'),JSON.stringify({...fixture,upstreamOrigin:fixture.origin,origin,normalUrl:fixture.normalUrl.replace(fixture.origin,origin),url:fixture.url.replace(fixture.origin,origin)},null,2));
 const args=['run','--rm','--pull=never','--network','host','--user',`${process.getuid()}:${process.getgid()}`,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','512','--memory','2g','--cpus','2','--tmpfs','/tmp:rw,nosuid,nodev,size=512m','--shm-size','256m','--mount',`type=bind,src=${path.resolve(output)},dst=/evidence`,'--mount',`type=bind,src=${path.join(root,'tests/workspace-navigation')},dst=/qualification,readonly`,'--env','HOME=/tmp/webkit-qualification','unified-native-runtime:driver-2.1.0','sh','-eu','-c',`mkdir -p "$HOME"; dbus-run-session -- xvfb-run -a -s '-screen 0 1600x1200x24' sh -eu -c 'WebKitWebDriver --port=4445 > /evidence/driver.log 2>&1 & driver=$!; trap "kill $driver 2>/dev/null || true" EXIT; python3 /qualification/webkit-qualification.py'`];
 await writeFile(path.join(output,'docker-command.json'),JSON.stringify({command:'docker',args},null,2));
 worker=spawn('docker',args,{stdio:'inherit'});const [code]=await once(worker,'exit');
 const cases=JSON.parse(await readFile(path.join(output,'paste-cases.json'),'utf8')),journals=[];
 for(const dir of await readdir(path.join(fixture.root,'data/projects'))){try{journals.push(...(await readFile(path.join(fixture.root,'data/projects',dir,'message-dispatches.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse))}catch(error){if(error.code!=='ENOENT')throw error}}
 const equality=cases.map(item=>{const submitted=requests.filter(r=>r.method==='POST'&&r.status===200&&typeof (r.body?.text??r.body?.initialMessage)==='string'&&(r.body.text??r.body.initialMessage).includes(item.marker));assert.equal(submitted.length,1,'One accepted submission '+item.marker);assert.equal(submitted[0].body.text??submitted[0].body.initialMessage,item.expected,'Exact submitted body');const canonical=journals.filter(r=>r.role==='user'&&r.renderedText?.includes(item.marker));assert.equal(canonical.length,1,'One canonical message');assert.equal(canonical[0].renderedText,'#broadcast '+item.expected,'Exact canonical shared body');return {marker:item.marker,status:'pass',submitted:item.expected,canonical:canonical[0].renderedText}});
 await writeFile(path.join(output,'canonical-equality.json'),JSON.stringify(equality,null,2));assert.equal(code,0,'All eight WebKit product cells');assert.equal(equality.length,16);console.log('PASS 16 exact submitted/canonical clipboard bodies');
}finally{await writeFile(path.join(output,'requests.json'),JSON.stringify(requests,null,2));server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));child.kill('SIGTERM');await exited;}
