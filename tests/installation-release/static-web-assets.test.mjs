import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fixture} from '../shared/fixture.mjs';

test('Browser routes fall back to the app shell, while missing assets return a non-cacheable 404',async()=>{
 const webDist=await mkdtemp(path.join(tmpdir(),'ponderosa-static-'));
 let server;
 try{
  await mkdir(path.join(webDist,'static/js/async'),{recursive:true});
  await writeFile(path.join(webDist,'index.html'),'<title>Fixture shell</title>');
  await writeFile(path.join(webDist,'static/js/async/current.js'),'export {};');
  server=await fixture({webDist});
  const shell=await server.api('GET','/branches?tab=workflow');
  assert.equal(shell.status,200);
  assert.match(shell.headers['content-type'],/^text\/html/);
  assert.equal(shell.body,'<title>Fixture shell</title>');
  assert.equal(shell.headers['cache-control'],'no-cache');
  const current=await server.api('GET','/static/js/async/current.js');
  assert.equal(current.status,200);
  assert.equal(current.headers['content-type'],'text/javascript; charset=utf-8');
  assert.match(current.headers['cache-control'],/immutable/);
  for(const url of ['/static/js/async/retired.js?rev=old','/static/extensionless','/missing-worker.js','/manifest.webmanifest']){
   const missing=await server.api('GET',url);
   assert.equal(missing.status,404,url);
   assert.equal(missing.headers['cache-control'],'no-store',url);
   assert.equal(missing.body,'',url);
  }
 }finally{
  await server?.dispose();
  await rm(webDist,{force:true,recursive:true});
 }
});
