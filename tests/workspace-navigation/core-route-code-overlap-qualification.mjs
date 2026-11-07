// After web build: QUALIFICATION_DIRECTORY=<owned> node --import ./tests/shared/workspace-resolution.mjs tests/workspace-navigation/core-route-code-overlap-qualification.mjs
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const output=process.env.QUALIFICATION_DIRECTORY;assert(output);await mkdir(output,{recursive:true});
const assets=path.join(root,'apps/web/dist/static/js/async');
const chunks=await Promise.all((await readdir(assets)).filter(name=>name.endsWith('.js')).map(async name=>({name,text:await readFile(path.join(assets,name),'utf8')})));
function chunkWith(text){const matches=chunks.filter(chunk=>chunk.text.includes(text));assert.equal(matches.length,1,`Unique built route marker: ${text}`);return '/static/js/async/'+matches[0].name;}
const appChunk=chunkWith('This workspace view could not be displayed.');
const projectChunk=chunkWith('This Project view could not be displayed.');
assert.notEqual(appChunk,projectChunk,'The selected project remains a lazy route');
const fixture=spawn(process.execPath,['--import','./tests/shared/workspace-resolution.mjs','tests/branches/ui-qualification.mjs'],{cwd:root,stdio:['ignore','pipe','inherit']});
const fixtureExit=once(fixture,'exit'),rows=[],cleanup=[];let browser,context,releaseApp=()=>{};
try{
 let setup;for await(const line of createInterface({input:fixture.stdout}))if(line.startsWith('{"origin":')){setup=JSON.parse(line);break;}
 assert(setup);browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 for(const kind of ['held-app','home-first-use','chunk-retry']){
  const row={kind,status:'started',api:[],apiRequests:[],blocked:[],errors:[]};rows.push(row);
  context=await browser.newContext({viewport:{width:412,height:823},isMobile:true,hasTouch:true,serviceWorkers:'block'});
  let appHeld=false,markAppHeld,allowProject=kind!=='chunk-retry';const appGate=new Promise(resolve=>releaseApp=resolve),appHoldReady=new Promise(resolve=>markAppHeld=resolve);
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>row.errors.push(error.message));
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==setup.origin){row.blocked.push(url.href);return route.abort();}
   if(url.pathname.startsWith('/api/')){row.api.push(url.pathname);row.apiRequests.push({method:route.request().method(),path:url.pathname,search:url.search});}
   if(kind==='held-app'&&url.pathname===appChunk){appHeld=true;markAppHeld();await appGate;}
   if(url.pathname===projectChunk&&!allowProject)return route.abort('failed');
   return route.continue();
  });
  try{
   if(kind==='held-app'){
    const before=await fetch(setup.origin+'/api/__qualification/state');assert(before.ok);row.providerTurnsBefore=(await before.json()).providerTurnIds;assert(Array.isArray(row.providerTurnsBefore),'Fixture must report a provider-turn array before navigation');
    const selectedCode=page.waitForRequest(request=>new URL(request.url()).pathname===projectChunk);
    const selectedUrl=new URL(setup.normalUrl),parts=selectedUrl.pathname.split('/');
    assert.equal(parts[1],'projects');assert.equal(parts[3],'chats');
    row.earlyDataPaths=[`/api/conversations/${parts[4]}`,`/api/projects/${parts[2]}/conversations`,`/api/projects/${parts[2]}/agents`,`/api/projects/${parts[2]}`];
    const earlyData=row.earlyDataPaths.map(path=>page.waitForResponse(response=>new URL(response.url()).pathname===path&&response.ok()));
    await page.goto(setup.normalUrl,{waitUntil:'commit'});
    let gateTimer;try{await Promise.race([Promise.all([selectedCode,appHoldReady,...earlyData]),new Promise((_,reject)=>{gateTimer=setTimeout(()=>reject(new Error('Initial route code did not overlap held App code')),15000);})]);}finally{clearTimeout(gateTimer);}
    assert(appHeld,'App response must still be held when project code is requested');
    for(const path of row.earlyDataPaths)assert.equal(row.api.filter(request=>request===path).length,1,'Each canonical read starts once while App code remains held: '+path);
    assert.deepEqual([...row.api].sort(),[...row.earlyDataPaths].sort(),'Only the four selected canonical browser API reads may start before App execution');
    assert(row.apiRequests.every(request=>request.method==='GET'),'Initial Root warm-up cannot send a mutation');
    assert.equal(new URLSearchParams(row.apiRequests.find(request=>request.path===row.earlyDataPaths[0]).search).get('limit'),'100','The exact existing canonical tail bound is retained');
    const held=await fetch(setup.origin+'/api/__qualification/state');assert(held.ok);row.providerTurnsWhileHeld=(await held.json()).providerTurnIds;assert(Array.isArray(row.providerTurnsWhileHeld),'Fixture must report a provider-turn array while App is held');
    assert.deepEqual(row.providerTurnsWhileHeld,row.providerTurnsBefore,'Early canonical reads cannot execute provider work');
    row.overlapBeforeAppExecution=true;row.dataBeforeAppExecution=true;releaseApp();
   }else if(kind==='home-first-use'){
    const projectRequests=[];page.on('request',request=>{if(new URL(request.url()).pathname===projectChunk)projectRequests.push(request.url());});
    await page.goto(setup.origin+'/home');await page.getByRole('button',{name:'Open workspace navigation',exact:true}).click();
    const chat=page.getByText('Normal product compatibility',{exact:true}).first();await chat.waitFor();
    assert.equal(projectRequests.length,0,'Home must not warm an unselected Project route');await chat.click();
    await page.waitForURL(setup.normalUrl);row.firstUseProjectRequests=projectRequests;
   }else{
    await page.goto(setup.normalUrl);await page.getByText('This view could not be loaded.',{exact:true}).waitFor();
    allowProject=true;await page.getByRole('button',{name:'Try Again',exact:true}).click();row.retry='explicit';
   }
   await page.getByLabel('Message',{exact:true}).waitFor();
   if(kind==='home-first-use')assert.equal(row.firstUseProjectRequests.length,1);
   if(kind!=='chunk-retry')assert.deepEqual(row.errors,[]);else assert(row.errors.every(error=>/chunk|loading|load/i.test(error)),JSON.stringify(row.errors));
   assert.deepEqual(row.blocked,[]);row.status='pass';console.log('PASS '+kind);
  }catch(error){row.status='failed';row.error=error.stack;throw error;}
  finally{releaseApp();await context.close();context=undefined;await writeFile(path.join(output,'results.json'),JSON.stringify({appChunk,projectChunk,rows,cleanup},null,2));}
 }
}finally{
 releaseApp();let failure;
 for(const [stage,close]of [['context',()=>context?.close()],['browser',()=>browser?.close()],['fixture',async()=>{fixture.kill('SIGTERM');const [code,signal]=await fixtureExit;assert(code===0||signal==='SIGTERM',JSON.stringify({code,signal}));}]]){
  try{await close();cleanup.push({stage,complete:true});}catch(error){cleanup.push({stage,complete:false,error:String(error)});failure??=error;}
 }
 await writeFile(path.join(output,'results.json'),JSON.stringify({appChunk,projectChunk,rows,cleanup},null,2));if(failure)throw failure;
}
