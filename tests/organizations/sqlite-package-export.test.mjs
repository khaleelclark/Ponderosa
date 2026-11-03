import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {openSync,closeSync,readSync,writeSync,fdatasyncSync,fstatSync,mkdirSync,writeFileSync,statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {tmpdir} from 'node:os';
import Fastify from 'fastify';
import {AgentStore} from '@ponderosa/agents';
import {packageExportDownloads,PackageExportDownloads} from '../../apps/server/dist/package-export-downloads.js';
import {packageExportPoolCallbacks} from '../../apps/server/dist/package-export-pool-receipt.js';

// This fixture exercises slot and receipt protocol only, not production file authority.
function openFixturePool(root,sqlite){
 const name=path.join(root,'fixture-pool'),callbacks=packageExportPoolCallbacks(sqlite),marker=callbacks.readMarker();
 if(!marker){callbacks.beginCreation();const fd=openSync(name,'wx+',0o600);const st=fstatSync(fd,{bigint:true});callbacks.completeCreation({dev:String(st.dev),ino:String(st.ino)});closeSync(fd);}
 const receipt=callbacks.readMarker().receipt,fd=openSync(name,'r+'),first=fstatSync(fd,{bigint:true});
 if(first.dev.toString()!==receipt.dev||first.ino.toString()!==receipt.ino)throw Error('fixture identity differs');
 const assert=()=>{const st=fstatSync(fd,{bigint:true});if(st.dev!==first.dev||st.ino!==first.ino||st.nlink!==1n)throw Error('fixture authority differs');};
 return {assert,size(){assert();return Number(fstatSync(fd,{bigint:true}).size)},allocatedBytes(){assert();return Number(fstatSync(fd,{bigint:true}).blocks*512n)},read(offset,length){assert();const b=Buffer.alloc(length);if(readSync(fd,b,0,length,offset)!==length)throw Error('short fixture pool read');return b;},write(offset,b){assert();if(writeSync(fd,b,0,b.length,offset)!==b.length)throw Error('short fixture pool write');},sync(){fdatasyncSync(fd);},close(){closeSync(fd);}};
}
async function fixture(native=false){
 const root=await mkdtemp(path.join(tmpdir(),'sqlite-export-cache-'));let store=new AgentStore(root),app,captures=0;
 const open=async()=>{
  app=Fastify({bodyLimit:8*1024*1024});const service=native?packageExportDownloads(app,root,store.sqlite,undefined,()=>store.stateAdmission()):packageExportDownloads(app,root,store.sqlite,openFixturePool(root,store.sqlite));
  app.post('/prepare',async(request,reply)=>service.prepare(request.headers['x-ponderosa-export-request'],{input:request.body,download:true},reply,async()=>{captures++;return service.send(request.body,'package.json',reply,true);}));
  app.post('/direct',async(request,reply)=>service.prepare(request.headers['x-ponderosa-export-request'],{input:request.body,download:false},reply,async()=>{captures++;return service.send(request.body,'package.json',reply);}));
  app.post('/invalid',async(request,reply)=>service.prepare(request.headers['x-ponderosa-export-request'],{kind:'invalid'},reply,async()=>{captures++;return service.send({bad:1n},'invalid.json',reply,true);}));
  await app.ready();return service;
 };
 await open();
 return {root,get store(){return store},get app(){return app},get captures(){return captures},async reopen(){await app.close();store.close();store=new AgentStore(root);await open();},async dispose(){await app.close();store.close();await rm(root,{recursive:true,force:true});}};
}
const request=(f,key,value)=>f.app.inject({method:'POST',url:'/prepare',headers:{'x-ponderosa-export-request':key},payload:value});

test('completed SQLite tickets recover exact bytes and never recapture a lost response',async()=>{
 const f=await fixture();
 try{
  const original={text:'Original 🌲 '.repeat(250000)},first=await request(f,'request-key-original',original);assert.equal(first.statusCode,200,first.body);
  const descriptor=first.json(),download=await f.app.inject(descriptor.downloadUrl);assert.equal(download.statusCode,200);assert.deepEqual(download.json(),original);
  assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM package_export_chunks').get().n>1,true,'Large bytes use bounded multiple chunks');
  const token=descriptor.downloadUrl.split('/').at(-1);
  assert.throws(()=>f.store.sqlite.prepare('UPDATE package_export_chunks SET sha256=? WHERE token=?').run('changed',token),/immutable/);
  assert.throws(()=>f.store.sqlite.prepare('INSERT INTO package_export_chunks(token,ordinal,slot,length,sha256) VALUES(?,?,?,?,?)').run(token,100,100,1,'bad'),/immutable/);
  await f.reopen();const status=await f.app.inject('/api/package-export-requests/request-key-original');assert.equal(status.json().state,'completed');assert.deepEqual((await f.app.inject(status.json().downloadUrl)).json(),original);
  const retry=await request(f,'request-key-original',original);assert.equal(retry.json().downloadUrl,descriptor.downloadUrl);assert.equal(f.captures,1);
  const changed=await request(f,'request-key-original',{text:'different'});assert.equal(changed.statusCode,409);assert.equal(f.captures,1);
 }finally{await f.dispose();}
});

test('completed expired records reclaim capacity repeatedly without deleting filesystem names',async()=>{
 const f=await fixture(),clock=Date.now;let now=clock();Date.now=()=>now;
 try{
  const marker=path.join(f.root,'user-original');await import('node:fs/promises').then(fs=>fs.writeFile(marker,'retain'));
  for(let i=0;i<20;i++){
   const response=await request(f,'sequential-request-'+i,{index:i});assert.equal(response.statusCode,200,response.body);
   assert.equal((await f.app.inject(response.json().downloadUrl)).statusCode,200);
   now+=15*60_000+1;
  }
  assert.equal(await readFile(marker,'utf8'),'retain');
  assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM package_export_tickets').get().n,1);
  assert.equal(f.store.sqlite.prepare('SELECT high_water FROM package_export_pool WHERE singleton=1').get().high_water,1024*1024,'Expired slots are reused without expanding the charged pool');
  assert.equal(f.store.sqlite.prepare("SELECT count(*) n FROM package_export_claims WHERE status='expired'").get().n,19);
  const prior=await request(f,'sequential-request-0',{index:0});assert.equal(prior.statusCode,409,'An expired identity cannot silently recapture');
  await f.reopen();const next=await request(f,'sequential-request-new',{index:20});assert.equal(next.statusCode,200,next.body);
 }finally{Date.now=clock;await f.dispose();}
});

test('unconfirmed serialization and outstanding durable readers stay held over restart',async()=>{
 const f=await fixture(),clock=Date.now;let now=clock();Date.now=()=>now;
 try{
  const failed=await f.app.inject({method:'POST',url:'/invalid',headers:{'x-ponderosa-export-request':'uncertain-request'},payload:{}});assert.equal(failed.statusCode,500);
  assert.equal(f.store.sqlite.prepare("SELECT count(*) n FROM package_export_tickets WHERE status='writing'").get().n,1);
  const completed=await request(f,'reader-held-request',{text:'reader payload'}),token=completed.json().downloadUrl.split('/').at(-1);
  f.store.sqlite.prepare('INSERT INTO package_export_readers(reader_id,token,started_at) VALUES(?,?,?)').run('held-reader',token,now);
  now+=15*60_000+1;await f.reopen();
  const retry=await f.app.inject({method:'POST',url:'/invalid',headers:{'x-ponderosa-export-request':'uncertain-request'},payload:{}});assert.equal(retry.statusCode,409);assert.equal(f.captures,2);
  const next=await request(f,'reader-second-request',{text:'next'});assert.equal(next.statusCode,200,next.body);
  assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM package_export_tickets WHERE token=?').get(token).n,1,'Unknown reader prevents expired cache reclamation');
  assert.equal(f.store.sqlite.prepare('SELECT count(*) n FROM package_export_readers WHERE reader_id=?').get('held-reader').n,1);
 }finally{Date.now=clock;await f.dispose();}
});

test('keyed direct JSON replies recover the same bytes rather than recapturing',async()=>{
 const f=await fixture();
 try{
  const options={method:'POST',url:'/direct',headers:{'x-ponderosa-export-request':'direct-request-key'},payload:{message:'original'}};
  const first=await f.app.inject(options);assert.equal(first.statusCode,200,first.body);assert.deepEqual(first.json(),options.payload);
  await f.reopen();const second=await f.app.inject(options);assert.equal(second.statusCode,200,second.body);assert.equal(second.body,first.body);assert.equal(f.captures,1);
 }finally{await f.dispose();}
});

test('modified pool bytes are refused before sending any package body',async()=>{
 const f=await fixture();
 try{
  const response=await request(f,'pool-tamper-request',{message:'original'}),token=response.json().downloadUrl.split('/').at(-1);
  const slot=f.store.sqlite.prepare('SELECT slot FROM package_export_chunks WHERE token=? AND ordinal=0').get(token).slot;
  const fd=openSync(path.join(f.root,'fixture-pool'),'r+');try{writeSync(fd,Buffer.from('X'),0,1,slot*1024*1024);fdatasyncSync(fd);}finally{closeSync(fd);}
  const download=await f.app.inject(response.json().downloadUrl);assert.equal(download.statusCode,409);assert.doesNotMatch(download.body,/original/);
 }finally{await f.dispose();}
});

test('real held pool survives restart and recovers the same export', {skip:process.platform!=='linux'},async()=>{
 const f=await fixture(true);
 try{
  const first=await request(f,'native-pool-request',{text:'real pool'});assert.equal(first.statusCode,200,first.body);
  await f.reopen();
  const retry=await request(f,'native-pool-request',{text:'real pool'});assert.equal(retry.statusCode,200,retry.body);assert.equal(retry.json().downloadUrl,first.json().downloadUrl);
  assert.deepEqual((await f.app.inject(retry.json().downloadUrl)).json(),{text:'real pool'});assert.equal(f.captures,1);
 }finally{await f.dispose();}
});

test('unexplained pool growth and changed legacy inventory refuse new exports',async()=>{
 const f=await fixture();
 try{
  assert.equal((await request(f,'accounting-before',{value:1})).statusCode,200);
  const fd=openSync(path.join(f.root,'fixture-pool'),'r+');try{writeSync(fd,Buffer.from('X'),0,1,3*1024*1024);fdatasyncSync(fd);}finally{closeSync(fd);}
  const refusal=await request(f,'accounting-after',{value:2});assert.equal(refusal.statusCode,503,refusal.body);
 }finally{await f.dispose();}
 const g=await fixture();
 try{
  assert.equal((await request(g,'legacy-before',{value:1})).statusCode,200);
  const foreign=path.join(g.root,'package-export-downloads','foreign-user-file');
  await import('node:fs/promises').then(fs=>fs.writeFile(foreign,'preserve'));
  const refusal=await request(g,'legacy-after',{value:2});assert.equal(refusal.statusCode,503,refusal.body);assert.equal(await readFile(foreign,'utf8'),'preserve');
 }finally{await g.dispose();}
});

test('preallocated legacy blocks beyond EOF count toward retained capacity',{skip:process.platform!=='linux'},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'legacy-preallocation-')),app=Fastify();
 try{
  const folder=path.join(root,'package-export-downloads');mkdirSync(folder,{mode:0o700});
  const file=path.join(folder,'retained-user-file');writeFileSync(file,'');
  const result=spawnSync('fallocate',['--keep-size','--length','1048576',file]);
  if(result.status!==0){t.skip('KEEP_SIZE preallocation unavailable in the fixture filesystem');return;}
  assert.equal(statSync(file).size,0);assert.ok(statSync(file).blocks*512>=1048576);
  const service=new PackageExportDownloads(app,root,false);
  const retained=await service.retainedUsage();assert.ok(retained.bytes>=1048576);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
