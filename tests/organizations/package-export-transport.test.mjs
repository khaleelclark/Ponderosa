import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import Fastify from 'fastify';
import ts from 'typescript';
import {AGENT_PACKAGE_STAGING_MAX_BYTES} from '@ponderosa/core';
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
 const source=await readFile(new URL('../../apps/web/src/api/real.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('real.ts',source,ts.ScriptTarget.Latest,true),names=new Set(['startPreparedPackageDownload','downloadPackageExport']);
 const functions=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.has(node.name?.text)).map(node=>node.getText(ast).replace(/^export /,'')).join('\n');
 const requests=[],links=[],prepared={downloadUrl:'/api/package-exports/'+'a'.repeat(48),expiresAt:new Date(Date.now()+600000).toISOString(),byteLength:42};
 const scope={URL,Date,Number,Error,JSON,Promise,window:{location:{href:'https://local.example/branches',origin:'https://local.example'}},productApiPath:path=>path,requestJson:async(path,input)=>{requests.push({path,input});return prepared;},document:{createElement:()=>({dataset:{},style:{},click(){links.push({href:this.href,filename:this.download,handled:this.dataset.ponderosaDownloadFeedback});},remove(){}}),body:{append(){}}}};
 vm.createContext(scope);vm.runInContext(ts.transpile(functions,{target:ts.ScriptTarget.ES2022}),scope);
 const selections={a:{selectedWorkingFiles:['x'.repeat(20000)]}};
 await scope.downloadPackageExport('/api/branches/branch/package',{mode:'full',fileSelections:selections},'original.json');
 assert.equal(requests[0].path,'/api/branches/branch/package');assert.equal(requests[0].input.method,'POST');assert.deepEqual(JSON.parse(requests[0].input.body),{mode:'full',fileSelections:selections,download:true});assert.equal(links[0].href,'https://local.example'+prepared.downloadUrl);assert.equal(links[0].handled,'handled');
 assert.throws(()=>scope.startPreparedPackageDownload({...prepared,downloadUrl:'https://outside.example/original'},'bad.json'),/invalid/);
 assert.throws(()=>scope.startPreparedPackageDownload({...prepared,downloadUrl:'/api/package-exports/../other'},'bad.json'),/invalid/);
 scope.startPreparedPackageDownload({...prepared,downloadUrl:'/api/branches/engine'+prepared.downloadUrl.slice(4)},'branch.json');
});


test('Branch body export passes complete selections through the existing installation exporter',async()=>{
 const app=Fastify(),calls=[],pkg={schema:'ponderosa.branch-installation.v1',mode:'full',chats:[],definition:{name:'source'}};
 registerBranchRoutes(app,{store:{},branches:{},workspace:{},coordination:{},resources:{},outputApps:{},sources:{},createChat(){},notify(){},installations:{async export(...args){calls.push(args);return pkg;}}});
 await app.ready();
 try{
  const fileSelections=Object.fromEntries(Array.from({length:150},(_,index)=>['source-'+index,{wholeWorkingFolder:true,reviewedUserData:{git:true,harness:false}}]));
  const body={mode:'full',includeValues:true,fileSelections,download:true};assert.ok(JSON.stringify(body).length>14000);
  const result=await app.inject({method:'POST',url:'/api/branches/source/package',payload:body});assert.equal(result.statusCode,200,result.body);
  assert.deepEqual(calls,[['source','full',true,fileSelections]]);const downloaded=await app.inject(result.json().downloadUrl);assert.deepEqual(downloaded.json(),pkg);
  const invalid=await app.inject({method:'POST',url:'/api/branches/source/package',payload:{...body,includeValues:'true'}});assert.equal(invalid.statusCode,400);assert.equal(calls.length,1);
 }finally{await app.close();}
});
