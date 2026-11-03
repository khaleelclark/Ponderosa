import test from 'node:test';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm,unlink,realpath,readdir,rename,open,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import Fastify from 'fastify';
import ts from 'typescript';
import {AGENT_PACKAGE_STAGING_MAX_BYTES} from '@ponderosa/core';
import {stableJson} from '@ponderosa/agents';
import {packageExportDownloads} from '../../apps/server/dist/package-export-downloads.js';
import {registerBranchRoutes} from '../../apps/server/dist/routes/branches.js';

test('prepared exports retry exact staged Agent or Branch bytes within one finite lifetime',async()=>{
 const app=Fastify(),downloads=packageExportDownloads(app);
 assert.equal(packageExportDownloads(app),downloads,'Agent and Branch routes share one staging service');
 app.post('/prepare',async(request,reply)=>downloads.send(request.body,'closed.ponderosa.json',reply,true));
 app.post('/direct',async(request,reply)=>downloads.send(request.body,'direct.ponderosa.json',reply));
 await app.ready();
 try{
  for(const value of [{schema:'ponderosa.agent-package.v1',text:'完整 🌲'}, {schema:'ponderosa.branch-installation.v1',workingData:{owners:{a:{chatRef:'chat-a',agentRef:'a'}}},text:'original'}]){
   const prepared=await app.inject({method:'POST',url:'/prepare',payload:value});assert.equal(prepared.statusCode,200);
   const result=prepared.json();assert.match(result.downloadUrl,/^\/api\/package-exports\/[a-f0-9]{48}$/);assert.ok(Date.parse(result.expiresAt)>Date.now());
   const first=await app.inject(result.downloadUrl),second=await app.inject(result.downloadUrl);
   assert.equal(first.statusCode,200);assert.equal(second.statusCode,200);assert.deepEqual(first.json(),value);assert.equal(second.body,first.body);assert.equal(Number(first.headers['content-length']),Buffer.byteLength(first.body));assert.equal(result.byteLength,Buffer.byteLength(first.body));
   const token=result.downloadUrl.split('/').at(-1);downloads.tickets.get(token).expiresAt=0;
   assert.equal((await app.inject(result.downloadUrl)).statusCode,410,'expired bytes cannot become a fresh source capture');
  }
  const value={text:'direct bounded JSON'},direct=await app.inject({method:'POST',url:'/direct',payload:value});assert.equal(direct.statusCode,200);assert.deepEqual(direct.json(),value);
  assert.equal((await app.inject('/api/package-exports/'+'0'.repeat(48))).statusCode,410);
 }finally{await app.close();}
});

test('staging capacity refuses visibly before exposing a truncated download',async()=>{
 const app=Fastify(),downloads=packageExportDownloads(app);
 app.post('/prepare',async(request,reply)=>{try{return await downloads.send(request.body,'original.json',reply,true);}catch(error){return reply.code(error.statusCode??500).send({error:error.message});}});
 await app.ready();
 try{
  downloads.bytes=AGENT_PACKAGE_STAGING_MAX_BYTES;
  const result=await app.inject({method:'POST',url:'/prepare',payload:{text:'complete original'}});
  assert.equal(result.statusCode,503);assert.match(result.json().error,/capacity/);assert.equal(downloads.tickets.size,0);assert.equal(downloads.bytes,AGENT_PACKAGE_STAGING_MAX_BYTES);
 }finally{await app.close();}
});

test('browser handoff validates exact origin-owned ticket paths and sends selections in the POST body',async()=>{
 const source=await readFile(new URL('../../apps/web/src/api/real.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('real.ts',source,ts.ScriptTarget.Latest,true),names=new Set(['preparePackageExport','preparedPackageExportUrl','startPreparedPackageDownload','downloadPackageExport']);
 const functions=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.has(node.name?.text)).map(node=>node.getText(ast).replace(/^export /,'')).join('\n');
 const requests=[],links=[],prepared={downloadUrl:'/api/package-exports/'+'a'.repeat(48),expiresAt:new Date(Date.now()+600000).toISOString(),byteLength:42};
 const scope={URL,Date,Number,Error,JSON,Promise,Map,encodeURIComponent,uncertainPackageExports:new Map(),createClientId:()=> 'original-request-key',window:{location:{href:'https://local.example/branches',origin:'https://local.example'}},productApiPath:path=>path,requestJson:async(path,input)=>{requests.push({path,input});return prepared;},document:{createElement:()=>({dataset:{},style:{},click(){links.push({href:this.href,filename:this.download,handled:this.dataset.ponderosaDownloadFeedback});},remove(){}}),body:{append(){}}}};
 vm.createContext(scope);vm.runInContext(ts.transpile(functions,{target:ts.ScriptTarget.ES2022}),scope);
 const selections={a:{selectedWorkingFiles:['x'.repeat(20000)]}};
 await scope.downloadPackageExport('/api/branches/branch/package',{mode:'full',fileSelections:selections},'original.json');
 assert.equal(requests[0].path,'/api/branches/branch/package');assert.equal(requests[0].input.method,'POST');assert.deepEqual(JSON.parse(requests[0].input.body),{mode:'full',fileSelections:selections,download:true});assert.equal(links[0].href,'https://local.example'+prepared.downloadUrl);assert.equal(links[0].handled,'handled');
 assert.throws(()=>scope.startPreparedPackageDownload({...prepared,downloadUrl:'https://outside.example/original'},'bad.json'),/invalid/);
 assert.throws(()=>scope.startPreparedPackageDownload({...prepared,downloadUrl:'/api/package-exports/../other'},'bad.json'),/invalid/);
 scope.startPreparedPackageDownload({...prepared,downloadUrl:'/api/branches/engine'+prepared.downloadUrl.slice(4)},'branch.json');
});


test('Branch body export passes complete selections through the existing installation exporter',async()=>{
 const app=Fastify(),calls=[],pkg={schema:'ponderosa.branch-installation.v1',mode:'full',chats:[],definition:{name:'source'}};let publisher;
 registerBranchRoutes(app,{store:{},branches:{},workspace:{},coordination:{},resources:{},outputApps:{},sources:{},createChat(){},notify(){},installations:{setPublisher(value){publisher=value;},async export(...args){calls.push(args);return pkg;}}});
 assert.equal(typeof publisher,'function');
 await app.ready();
 try{
  const fileSelections=Object.fromEntries(Array.from({length:150},(_,index)=>['source-'+index,{wholeWorkingFolder:true,reviewedUserData:{git:true,harness:false}}]));
  const body={mode:'full',includeValues:true,fileSelections,download:true};assert.ok(JSON.stringify(body).length>14000);
  const result=await app.inject({method:'POST',url:'/api/branches/source/package',payload:body});assert.equal(result.statusCode,200,result.body);
  assert.deepEqual(calls,[['source','full',true,fileSelections]]);const downloaded=await app.inject(result.json().downloadUrl);assert.deepEqual(downloaded.json(),pkg);
  const invalid=await app.inject({method:'POST',url:'/api/branches/source/package',payload:{...body,includeValues:'true'}});assert.equal(invalid.statusCode,400);assert.equal(calls.length,1);
 }finally{await app.close();}
});


test('clipboard fallback keeps its first ticket after source removal and never captures again',async()=>{
 const directory=await realpath(await mkdtemp(path.join(tmpdir(),'export-clipboard-original-'))),sourcePath=path.join(directory,'source.json'),app=Fastify();
 const original={text:'Exact original 🌲 '.repeat(40)};await writeFile(sourcePath,JSON.stringify(original));let captures=0;
 const downloads=packageExportDownloads(app,directory);
 app.post('/prepare',async(_request,reply)=>{captures++;return downloads.send(JSON.parse(await readFile(sourcePath,'utf8')),'original.json',reply,true);});await app.ready();
 try{
  const clipboardSource=await readFile(new URL('../../apps/web/src/agent-package-clipboard.ts',import.meta.url),'utf8'),clipboardModule={exports:{}};
  vm.runInNewContext(ts.transpileModule(clipboardSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:clipboardModule,exports:clipboardModule.exports,Error,TextDecoder});
  const source=await readFile(new URL('../../apps/web/src/api/real.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('real.ts',source,ts.ScriptTarget.Latest,true),names=new Set(['preparePackageExport','requestAgentPackageText','preparedPackageExportUrl','startPreparedPackageDownload']);
  const functions=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.has(node.name?.text)).map(node=>node.getText(ast).replace(/^export /,'')).join('\n'),links=[];
  const scope={URL,Date,Number,Error,JSON,Promise,Map,encodeURIComponent,uncertainPackageExports:new Map(),createClientId:()=> 'original-request-key',window:{location:{href:'https://local.example/',origin:'https://local.example'}},productApiPath:path=>path,AgentPackageDownloadRequired:clipboardModule.exports.AgentPackageDownloadRequired,
   readAgentPackageClipboard:response=>clipboardModule.exports.readAgentPackageClipboard(response,32),
   requestJson:async()=>{const result=await app.inject({method:'POST',url:'/prepare'});assert.equal(result.statusCode,200,result.body);await unlink(sourcePath);return result.json();},
   fetch:async url=>{const result=await app.inject(new URL(url).pathname);return new Response(result.rawPayload,{status:result.statusCode,headers:result.headers});},
   decodeHttpError:async()=>Error('Unexpected GET failure'),document:{createElement:()=>({dataset:{},style:{},click(){links.push(this.href);},remove(){}}),body:{append(){}}}};
  vm.createContext(scope);vm.runInContext(ts.transpile(functions,{target:ts.ScriptTarget.ES2022}),scope);
  let overflow;await assert.rejects(scope.requestAgentPackageText('/prepare',{mode:'full'}),error=>{overflow=error;return error instanceof clipboardModule.exports.AgentPackageDownloadRequired&&Boolean(error.preparedExport);});
  // Exercise the actual action: the fallback must use only the carried ticket.
  const actionSource=await readFile(new URL('../../apps/web/src/components/useAgentPackageActions.ts',import.meta.url),'utf8'),actionsModule={exports:{}},notices=[];
  const imports={'../api/real':{startPreparedPackageDownload:scope.startPreparedPackageDownload},'../agent-package-clipboard':clipboardModule.exports,'../api':{api:{exportAgentText:()=>Promise.reject(overflow),downloadAgentPackage:()=>{throw Error('A second capture is forbidden');}}},'../clipboard':{copyDeferredText:pending=>pending},'./MutationNotifications':{useMutationNotification:()=>notice=>notices.push(notice)},'./AgentDetail.helpers':{portablePackageFileName:()=> 'original.json'}};
  vm.runInNewContext(ts.transpileModule(actionSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:actionsModule,exports:actionsModule.exports,Error,require:name=>imports[name]});
  await actionsModule.exports.useAgentPackageActions({agentId:'source'}).copyAgentPackage('full');
  assert.equal(captures,1);assert.equal(links.length,1);assert.equal(new URL(links[0]).pathname,overflow.preparedExport.downloadUrl);assert.match(notices[0].message,/original package download/);
  const retried=await app.inject(new URL(links[0]).pathname);assert.deepEqual(retried.json(),original,'Download survives removal of its source after clipboard preparation');
 }finally{await app.close();await rm(directory,{recursive:true,force:true});}
});

test('confirmed export tickets survive restart with exact bytes and original expiry; unconfirmed files stay held',async()=>{
 const directory=await realpath(await mkdtemp(path.join(tmpdir(),'export-ticket-restart-')));let app;
 const openApp=async()=>{app=Fastify();const service=packageExportDownloads(app,directory);app.post('/prepare',async(request,reply)=>service.send(request.body,'durable.json',reply,true));await app.ready();return service;};
 try{
  await openApp();const value={schema:'ponderosa.agent-package.v1',original:'retained 🌲'},prepared=(await app.inject({method:'POST',url:'/prepare',payload:value})).json(),first=await app.inject(prepared.downloadUrl);
  await app.close();
  const staging=path.join(directory,'package-export-downloads'),token=prepared.downloadUrl.split('/').at(-1),manifest=JSON.parse(await readFile(path.join(staging,token+'.json'),'utf8'));
  await writeFile(path.join(staging,'f'.repeat(48)+'.bytes'),'unconfirmed crash bytes');
  const reopened=await openApp(),second=await app.inject(prepared.downloadUrl);assert.equal(second.statusCode,200);assert.equal(second.body,first.body);assert.equal(reopened.tickets.get(token).expiresAt,Date.parse(prepared.expiresAt));assert.equal(reopened.held,1);
  assert.equal((await app.inject('/api/package-exports/'+'f'.repeat(48))).statusCode,410);assert.equal(await readFile(path.join(staging,'f'.repeat(48)+'.bytes'),'utf8'),'unconfirmed crash bytes');
  await writeFile(path.join(staging,token+'.bytes'),first.body.replace('retained','modified'));
  assert.equal((await app.inject(prepared.downloadUrl)).statusCode,500,'Same-inode same-size edits after hydration cannot masquerade as original bytes');
  await app.close();
  await writeFile(path.join(staging,token+'.bytes'),'replaced same-inode original');
  const changed=await openApp();assert.equal((await app.inject(prepared.downloadUrl)).statusCode,410,'Manifest digest/size cannot adopt changed bytes');assert.ok(changed.held>=2);assert.equal(JSON.parse(await readFile(path.join(staging,token+'.json'),'utf8')).sha256,manifest.sha256);
  assert.ok((await readdir(staging)).includes(token+'.bytes'),'Unconfirmed bytes remain available for exact manual recovery');
 }finally{await app?.close().catch(()=>{});await rm(directory,{recursive:true,force:true});}
});


test('a lost prepare response recovers the original request ticket after restart without reading its removed source',async()=>{
 const directory=await realpath(await mkdtemp(path.join(tmpdir(),'export-lost-prepare-'))),sourcePath=path.join(directory,'source.json');let app,captures=0;
 const original={schema:'ponderosa.branch-installation.v1',source:'First complete snapshot'};await writeFile(sourcePath,JSON.stringify(original));
 const openApp=async()=>{app=Fastify();const service=packageExportDownloads(app,directory);app.post('/prepare',async(request,reply)=>service.prepare(request.headers['x-ponderosa-export-request'],{kind:'branch',id:'source',input:request.body},reply,async()=>{captures++;return service.send(JSON.parse(await readFile(sourcePath,'utf8')),'original.json',reply,true);}));await app.ready();return service;};
 try{
  await openApp();const source=await readFile(new URL('../../apps/web/src/api/real.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('real.ts',source,ts.ScriptTarget.Latest,true),node=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='preparePackageExport'),requests=[];
  const scope={Error,JSON,Map,encodeURIComponent,uncertainPackageExports:new Map(),createClientId:()=> 'lost-original-request',requestJson:async(url,input)=>{
   requests.push({url,input});if(input?.method==='POST'){
    const result=await app.inject({method:'POST',url,headers:input.headers,payload:JSON.parse(input.body)});assert.equal(result.statusCode,200,result.body);
    await unlink(sourcePath);await app.close();await openApp();throw Error('Preparation POST response lost');
   }
   const result=await app.inject(url);assert.equal(result.statusCode,200,result.body);return result.json();
  }};vm.createContext(scope);vm.runInContext(ts.transpile(node.getText(ast).replace(/^export /,''),{target:ts.ScriptTarget.ES2022}),scope);
  const recovered=await scope.preparePackageExport('/prepare',{mode:'full',fileSelections:{source:{wholeWorkingFolder:true}}});
  assert.equal(captures,1);assert.equal(requests.filter(request=>request.input?.method==='POST').length,1);assert.match(requests[1].url,/package-export-requests\/lost-original-request$/);
  assert.deepEqual((await app.inject(recovered.downloadUrl)).json(),original);
  const repeated=await app.inject({method:'POST',url:'/prepare',headers:{'x-ponderosa-export-request':'lost-original-request'},payload:{mode:'full',fileSelections:{source:{wholeWorkingFolder:true}},download:true}});assert.equal(repeated.statusCode,200);assert.equal(repeated.json().downloadUrl,recovered.downloadUrl);assert.equal(captures,1);
  const changed=await app.inject({method:'POST',url:'/prepare',headers:{'x-ponderosa-export-request':'lost-original-request'},payload:{mode:'full',fileSelections:{source:{wholeWorkingFolder:true}},download:false}});assert.equal(changed.statusCode,409);assert.equal(captures,1);
  // An interrupted claim with no complete manifest cannot replay source capture.
  await app.close();const key='unconfirmed-source-request',selectionHash=createHash('sha256').update(stableJson({kind:'branch',id:'source',input:{mode:'full'}})).digest('hex');
  await writeFile(path.join(directory,'package-export-downloads','request-'+createHash('sha256').update(key).digest('hex')+'.json'),JSON.stringify({schema:'ponderosa.package-export-request.v1',key,selectionHash,createdAt:Date.now()}));
  await openApp();const held=await app.inject({method:'POST',url:'/prepare',headers:{'x-ponderosa-export-request':key},payload:{mode:'full'}});assert.equal(held.statusCode,409);assert.equal(captures,1);
 }finally{await app?.close().catch(()=>{});await rm(directory,{recursive:true,force:true});}
});


test('export readback rejects FIFO crash remnants and cleanup preserves replaced manifests',{skip:process.platform!=='linux'},async()=>{
 const directory=await realpath(await mkdtemp(path.join(tmpdir(),'export-held-remnants-')));let app;
 try{
  app=Fastify();let downloads=packageExportDownloads(app,directory);app.post('/prepare',async(request,reply)=>downloads.send(request.body,'retained.json',reply,true));await app.ready();
  const prepared=(await app.inject({method:'POST',url:'/prepare',payload:{x:'AAAA'}})).json(),token=prepared.downloadUrl.split('/').at(-1),staging=path.join(directory,'package-export-downloads');await app.close();
  await rename(path.join(staging,token+'.bytes'),path.join(staging,token+'.retained'));
  execFileSync('mkfifo',[path.join(staging,token+'.bytes')]);execFileSync('mkfifo',[path.join(staging,'e'.repeat(48)+'.json')]);
  app=Fastify();downloads=packageExportDownloads(app,directory);await app.ready();assert.equal((await app.inject(prepared.downloadUrl)).statusCode,410,'No FIFO endpoint can become an original or block readback');await app.close();
  await unlink(path.join(staging,token+'.bytes'));await rename(path.join(staging,token+'.retained'),path.join(staging,token+'.bytes'));
  app=Fastify();downloads=packageExportDownloads(app,directory);await app.ready();assert.equal((await app.inject(prepared.downloadUrl)).statusCode,200);
  const ticket=downloads.tickets.get(token);await rename(path.join(staging,token+'.json'),path.join(staging,token+'.original-manifest'));await writeFile(path.join(staging,token+'.json'),'unknown replacement manifest');
  ticket.expiresAt=0;await downloads.remove(token,ticket);
  assert.equal(await readFile(path.join(staging,token+'.json'),'utf8'),'unknown replacement manifest');assert.ok(downloads.tickets.has(token),'Failed cleanup retains its capacity charge and does not adopt the replacement');
 }finally{await app?.close().catch(()=>{});await rm(directory,{recursive:true,force:true});}
});


test('descriptor-backed data root retains private staging and refuses a replaced directory',{skip:process.platform!=='linux'},async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'package-export-held-root-'))),rootHandle=await open(root,'r'),app=Fastify();
 const downloads=packageExportDownloads(app,'/proc/self/fd/'+rootHandle.fd);
 app.post('/prepare',async(request,reply)=>downloads.send(request.body,'original.json',reply,true));
 await app.ready();
 try{
  const value={text:'Original exact exported data'},prepared=await app.inject({method:'POST',url:'/prepare',payload:value});
  assert.equal(prepared.statusCode,200,prepared.body);
  const ticket=prepared.json(),first=await app.inject(ticket.downloadUrl);assert.equal(first.statusCode,200);assert.deepEqual(first.json(),value);
  const original=path.join(root,'package-export-downloads'),retained=path.join(root,'original-retained'),outside=path.join(root,'outside');
  await rename(original,retained);await mkdir(outside);await writeFile(path.join(outside,'sentinel'),'unrelated');
  await symlink(outside,original);
  const refused=await app.inject(ticket.downloadUrl);assert.equal(refused.statusCode,500);
  assert.equal(await readFile(path.join(outside,'sentinel'),'utf8'),'unrelated');
  assert.ok((await readdir(retained)).some(name=>name.endsWith('.bytes')),'Original package remains retained');
 }finally{await app.close();await rootHandle.close();await rm(root,{recursive:true,force:true});}
});
