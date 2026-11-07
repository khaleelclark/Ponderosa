// Actual Branch controller + normal workspace snapshot; functional, not performance qualification.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {fixture} from '../shared/fixture.mjs';
import {serveFixture} from '../shared/serve-ui-fixture.mjs';
const out=process.env.PONDEROSA_UI_EVIDENCE;assert(out);await mkdir(out,{recursive:true});
const result={scope:'actual Branch opening/select, normal snapshot cancellation, held configuration; no performance claim',cases:[],cleanup:[]};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Controlled response stage timed out")),12000);})]);}finally{clearTimeout(timer);}}
let f,web,browser,context,page;
try{
 f=await fixture();const branch=f.ok(await f.api('POST','/api/branches',{name:'Snapshot handoff',idempotencyKey:randomUUID()}));
 const chat=f.ok(await f.api('POST',`/api/branches/${branch.id}/chats`,{label:'Snapshot Chat',defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
 const initialTurns=f.turns.map(t=>t.turnId);web=await serveFixture(f);
 const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
 browser=await chromium.launch({executablePath:'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
 for(const order of ['owner-before-dto','dto-before-owner']){
  const row={order,requests:[],errors:[],ownerRequests:0};result.cases.push(row);
  const firstStarted=deferred(),releaseFirst=deferred(),secondStarted=deferred(),releaseFresh=deferred(),freshDelivered=deferred(),releaseDto=deferred(),configStarted=deferred(),releaseConfig=deferred(),ownerAborted=deferred();
  context=await browser.newContext({viewport:{width:412,height:823},isMobile:true,hasTouch:true,serviceWorkers:'block'});
  await context.addInitScript(()=>{const Original=window.EventSource;window.__ownerSnapshot=false;window.EventSource=class extends Original{constructor(...args){super(...args);this.addEventListener('workspace_status',event=>{if(JSON.parse(event.data).snapshot)window.__ownerSnapshot=true;});}};});
  page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>row.errors.push(e.message));
  const ownerPath=`/api/branches/contexts/${chat.id}`,branchPath=`/api/branches/${branch.id}`,configPath=branchPath+'/configuration',prefix='/api/branches/engine';
  const expected=[prefix+`/projects/${chat.projectId}`,prefix+`/conversations/${chat.id}`,prefix+`/projects/${chat.projectId}/conversations`,prefix+`/projects/${chat.projectId}/agents`];
  page.on('request',request=>{const u=new URL(request.url());row.requests.push({method:request.method(),path:u.pathname,search:u.search});});
  page.on('requestfailed',request=>{if(new URL(request.url()).pathname===ownerPath&&request.failure()?.errorText==='net::ERR_ABORTED'){row.ownerAbortObserved=true;ownerAborted.resolve();}});
  await page.route('**/*',async route=>{const u=new URL(route.request().url());if(!['127.0.0.1','localhost'].includes(u.hostname))return route.abort();
   if(u.pathname===ownerPath){row.ownerRequests++;const n=row.ownerRequests;const response=await route.fetch();if(n===1){firstStarted.resolve();await releaseFirst.promise;if(route.request().failure()?.errorText==='net::ERR_ABORTED'){row.oldResponseDiscarded=true;return;}}else{secondStarted.resolve();await releaseFresh.promise;}await route.fulfill({response});if(n===2)freshDelivered.resolve();return;}
   if(u.pathname.endsWith('/workspace/stream')){await firstStarted.promise;return route.continue();}
   if(u.pathname===branchPath){const response=await route.fetch();if(order==='owner-before-dto')await releaseDto.promise;return route.fulfill({response});}
   if(u.pathname===configPath){configStarted.resolve();await releaseConfig.promise;return route.continue();}
   return route.continue();
  });
  const started=Date.now();
  try{
   await page.goto(web.origin+`/branches?branch=${branch.id}&tab=chats&chat=${chat.id}`,{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>window.__ownerSnapshot===true);await bounded(secondStarted.promise);await bounded(ownerAborted.promise);
   assert.equal(row.ownerRequests,2,'Real snapshot cancels the first owner query and active canonical observer refetches');
   releaseFirst.resolve();
   if(order==='dto-before-owner')await bounded(configStarted.promise);
   releaseFresh.resolve();await bounded(freshDelivered.promise);
   if(order==='owner-before-dto')releaseDto.resolve();
   await bounded(configStarted.promise);
   for(const path of expected){if(!row.requests.some(x=>x.path===path))await page.waitForRequest(request=>new URL(request.url()).pathname===path);}
   assert.equal(await page.getByLabel('Message',{exact:true}).count(),0,'Real select still waits for held workflow configuration');
   row.workspaceReadsBeforeConfiguration=expected.map(path=>row.requests.filter(x=>x.path===path));
   assert(row.workspaceReadsBeforeConfiguration.every(x=>x.length===1),'All four warm reads use one canonical request');
   assert.equal(new URL('http://fixture'+row.workspaceReadsBeforeConfiguration[1][0].path+row.workspaceReadsBeforeConfiguration[1][0].search).searchParams.get('limit'),'100');
   releaseConfig.resolve();const editor=page.getByLabel('Message',{exact:true});await editor.waitFor();await editor.fill('Retained snapshot draft λ😀');
   await page.getByRole('tab',{name:'Workflow',exact:true}).click();await page.getByRole('tab',{name:'Chats',exact:true}).click();await editor.waitFor();assert.equal(await editor.innerText(),'Retained snapshot draft λ😀');
   assert.deepEqual(f.turns.map(t=>t.turnId),initialTurns,'Navigation/warming cannot execute provider work');assert.deepEqual(row.errors,[]);
   row.snapshot=true;row.actualSelectAndNavigation=true;row.passed=true;await page.screenshot({path:out+'/'+order+'.png'});
  }finally{releaseFirst.resolve();releaseFresh.resolve();releaseDto.resolve();releaseConfig.resolve();await context.close();context=undefined;row.elapsed=Date.now()-started;await writeFile(out+'/result.json',JSON.stringify(result,null,2));}
 }
 result.passed=true;
}catch(error){result.error=error.stack;}
finally{
 for(const [name,close]of [['context',()=>context?.close()],['browser',()=>browser?.close()],['web',()=>web?.close()],['fixture',()=>f?.dispose(false)]])try{await close();result.cleanup.push({name,status:'complete'});}catch(error){result.cleanup.push({name,status:'failed',error:String(error)});}
 await writeFile(out+'/result.json',JSON.stringify(result,null,2));
}
console.log(JSON.stringify(result));if(!result.passed||result.cleanup.some(x=>x.status!=='complete'))process.exitCode=1;
