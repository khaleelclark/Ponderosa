// Disposable ownership/first-use check; not performance qualification.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {fixture} from '../shared/fixture.mjs';
import {serveFixture} from '../shared/serve-ui-fixture.mjs';
const out=process.env.PONDEROSA_UI_EVIDENCE;assert(out,'Owned evidence directory required');await mkdir(out,{recursive:true});
const result={kind:'Branch verified metadata overlaps draft; Run History first use retains state',requests:[],pageErrors:[],cleanup:[]};
const releases=[];
let f,web,browser,context,page;
const gate=()=>{let release;const promise=new Promise(resolve=>release=resolve);releases.push(release);return {promise,release};};
const routeFor=seed=>'/branches?branch='+seed.branch.id+'&tab=chats&chat='+seed.chat.id;
const projectPath=seed=>'/api/branches/engine/projects/'+seed.chat.projectId;
const contextPath=seed=>'/api/branches/contexts/'+seed.chat.id;
const configPath=seed=>'/api/branches/'+seed.branch.id+'/configuration';
const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function seed(name){
 const branch=f.ok(await f.api('POST','/api/branches',{name,idempotencyKey:randomUUID()}));
 const chat=f.ok(await f.api('POST','/api/branches/'+branch.id+'/chats',{label:name+' Chat',defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
 const definition={schema:'ponderosa.branch.v1',name,trigger:{kind:'manual'},entry:'script',steps:[{id:'script',label:'Preserve input',kind:'script',runtime:'node',source:'process.stdin.pipe(process.stdout);',cwdRef:'workspace',timeoutMs:30000}],controls:[],edges:[],policy:{maxConcurrentExecutions:2,maxPathInstances:1000,maxStepInvocations:1000,maxEphemeralAgents:100,failure:{action:'stop'}}};
 const deployed=f.ok(await f.api('POST','/api/branches/deploy',{branchId:branch.id,chatId:branch.chatId,expectedVersionId:branch.versionId,definition,bindings:{agents:{},directories:{workspace:f.root}},idempotencyKey:randomUUID()}));
 return {branch:deployed,chat};
}
async function openPage(label){
 if(context)await context.close();
 context=await browser.newContext({viewport:{width:1365,height:768},serviceWorkers:'block'});
 page=await context.newPage();page.setDefaultTimeout(10000);
 page.on('pageerror',error=>result.pageErrors.push(error.message));
 page.on('request',request=>result.requests.push({scenario:label,method:request.method(),path:new URL(request.url()).pathname,url:request.url()}));
 await page.route('**/*',route=>['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
}
try{
 f=await fixture();const a=await seed('First-use Run History'),b=await seed('Other workflow');assert.notEqual(a.chat.projectId,b.chat.projectId);
 web=await serveFixture(f);const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
 browser=await chromium.launch({executablePath:'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
 await openPage('cold');
 const draft=gate();let configHeld=false;
 await page.route('**/api/branches/'+a.branch.id+'/configuration*',async route=>{configHeld=true;await draft.promise;await route.continue().catch(()=>{});});
 const earlyProject=page.waitForRequest(request=>new URL(request.url()).pathname===projectPath(a));
 await page.goto(web.origin+routeFor(a),{waitUntil:'domcontentloaded'});await earlyProject;
 assert.equal(configHeld,true);assert.equal(await page.getByLabel('Message',{exact:true}).count(),0,'Draft/render gate still holds while metadata overlaps');
 result.metadataStartedBeforeDraftReleased=true;draft.release();
 await page.getByLabel('Message',{exact:true}).waitFor();
 assert.equal(await page.locator('[data-run-history-layout]').count(),0,'Unopened Run History must not mount its hidden layout/control effects');
 const tail=result.requests.find(row=>row.scenario==='cold'&&row.path==='/api/branches/engine/conversations/'+a.chat.id);
 assert(tail);assert.equal(new URL(tail.url).searchParams.get('limit'),'100');
 await page.getByRole('tab',{name:'Executions',exact:true}).click();
 const history=page.locator('[data-run-history-layout]');await history.waitFor();
 await history.evaluate(element=>element.dataset.retentionProbe='same-history');
 await page.getByRole('combobox',{name:'Filter Runs',exact:true}).click();await page.getByRole('option',{name:'Failed',exact:true}).click();
 await page.getByRole('tab',{name:'Chats',exact:true}).click();await page.getByLabel('Message',{exact:true}).waitFor();
 assert.equal(await history.count(),1,'Visited history remains mounted while Chat is open');
 await page.getByRole('tab',{name:'Executions',exact:true}).click();await history.waitFor();
 assert.equal(await history.getAttribute('data-retention-probe'),'same-history');
 assert.equal(await page.getByRole('combobox',{name:'Filter Runs Failed',exact:true}).innerText(),'Failed');
 result.firstUseAndRetainedHistory=true;await page.screenshot({path:out+'/retained-history.png'});
 // An owner response arriving after same-document navigation must not launch old-project work.
 await openPage('late-owner');
 const oldDraft=gate(),oldOwner=gate();
 await page.route('**/api/branches/'+a.branch.id+'/configuration*',async route=>{await oldDraft.promise;await route.continue().catch(()=>{});});
 await page.route('**'+contextPath(a),async route=>{await oldOwner.promise;await route.continue().catch(()=>{});});
 const heldOwner=page.waitForRequest(request=>new URL(request.url()).pathname===contextPath(a));
 await page.goto(web.origin+routeFor(a),{waitUntil:'domcontentloaded'});await heldOwner;
 await page.evaluate(path=>{history.pushState({},'',path);window.dispatchEvent(new PopStateEvent('popstate'));},routeFor(b));
 await page.getByLabel('Message',{exact:true}).waitFor();
 const settledOwner=page.waitForResponse(response=>new URL(response.url()).pathname===contextPath(a));
 oldOwner.release();oldDraft.release();await (await settledOwner).finished();await frames();
 assert.equal(result.requests.filter(row=>row.scenario==='late-owner'&&row.path===projectPath(a)).length,0,'Late owner must not prefetch the old Project');
 assert.equal(new URL(page.url()).searchParams.get('branch'),b.branch.id);
 assert.equal(await page.getByLabel('Message',{exact:true}).isVisible(),true);result.lateOwnerFence=true;
 // A real foreign owner response is not authority to prefetch a Project for this Branch.
 await openPage('foreign-owner');
 const foreignDraft=gate();
 await page.route('**/api/branches/'+a.branch.id+'/configuration*',async route=>{await foreignDraft.promise;await route.continue().catch(()=>{});});
 const foreignOwner=page.waitForResponse(response=>new URL(response.url()).pathname===contextPath(b));
 await page.goto(web.origin+'/branches?branch='+a.branch.id+'&tab=chats&chat='+b.chat.id,{waitUntil:'domcontentloaded'});
 await (await foreignOwner).finished();await frames();
 assert.equal(result.requests.filter(row=>row.scenario==='foreign-owner'&&row.path===projectPath(b)).length,0);
 foreignDraft.release();await page.getByLabel('Message',{exact:true}).waitFor();
 assert.equal(new URL(page.url()).searchParams.get('branch'),b.branch.id,'Existing owner redirection remains authoritative');
 result.foreignOwnerFence=true;
 assert.equal(f.turns.length,0,'This UI check must not start an Agent or script job');
 assert.deepEqual(result.pageErrors,[]);result.providerTurns=f.turns.length;result.passed=true;
}catch(error){result.error=error.stack;if(page)await page.screenshot({path:out+'/failure.png',timeout:3000}).catch(()=>{});}
finally{
 for(const release of releases)release();
 for(const [name,close]of[['context',()=>context?.close()],['browser',()=>browser?.close()],['web',()=>web?.close()],['fixture',()=>f?.dispose(false)]])try{await close();result.cleanup.push({name,status:'complete'});}catch(error){result.cleanup.push({name,status:'failed',error:String(error)});}
 await writeFile(out+'/result.json',JSON.stringify(result,null,2));
}
console.log(JSON.stringify({passed:result.passed,error:result.error,metadataStartedBeforeDraftReleased:result.metadataStartedBeforeDraftReleased,firstUseAndRetainedHistory:result.firstUseAndRetainedHistory,lateOwnerFence:result.lateOwnerFence,foreignOwnerFence:result.foreignOwnerFence,cleanup:result.cleanup}));
if(!result.passed||result.cleanup.some(row=>row.status!=='complete'))process.exitCode=1;
