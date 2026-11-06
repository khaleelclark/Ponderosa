// Proof defaults to one session/cell. The heavy 32-session mode requires explicit method acceptance.
import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {verifyAcceptedMethod,finalizeLedger} from './qualification-ledger.mjs';
import {installTimingObserver,summarizeTimings} from './event-timing-observer.mjs';
const out=process.env.PONDEROSA_LOAD_EVIDENCE;assert(out,'Owned evidence directory required');await mkdir(out,{recursive:true});
const full=process.env.PONDEROSA_LOAD_MODE==='full';
const results=[];for(const product of ['core','branches'])for(const mobile of [false,true])for(let session=0;session<(full?8:1);session++)results.push({id:`${product}-${mobile?'phone':'desktop'}-${session}`,product,mobile,session,status:'planned'});
const ledger={full,status:'setup',stages:[],results};let f,browser,origin,listener,chromium,createLoadFixture,verifyQueuedLoadMessage,cancelQueuedLoadMessages;
const persist=()=>writeFile(out+'/sessions.json',JSON.stringify(ledger,null,2));
async function stage(name,run){const row={name,status:'started',startedAt:Date.now()};ledger.stages.push(row);await persist();try{const value=await run();row.status='complete';row.endedAt=Date.now();await persist();return value;}catch(error){row.status='failed';row.error=error.stack;row.endedAt=Date.now();await persist();throw error;}}
await persist();
try{
// A caller-supplied retained primary profile must be reviewed; a label or CDP command is insufficient.
let primaryProfile=null;
await stage('primary-profile',async()=>{
 const receipt=process.env.PONDEROSA_MOBILE_PROFILE_RECEIPT??'tests/workspace-navigation/lighthouse-13.6.0/profile.json';
 primaryProfile=JSON.parse(await readFile(receipt,'utf8'));
 assert(primaryProfile.version&&primaryProfile.source&&primaryProfile.sha256&&primaryProfile.config,'Primary version/source/hash/config required');
 assert.equal(createHash('sha256').update(await readFile(primaryProfile.source)).digest('hex'),primaryProfile.sha256,'Retained primary source bytes must match receipt');
 const p=primaryProfile.config;assert.deepEqual([p.width,p.height,p.dpr,p.cpu,p.mobile,p.touch],[412,823,1.75,4,true,true],'Reconcile pinned primary profile with proposal before running; no silent profile drift');ledger.primaryProfile=primaryProfile;
});
if(full)await stage('accepted-inputs',async()=>{
 const required=['tests/workspace-navigation/event-timing-observer.mjs','tests/workspace-navigation/active-load-qualification.mjs','tests/workspace-navigation/qualification-ledger.mjs','tests/shared/ui-load-fixture.mjs','tests/shared/fixture.mjs','apps/web/rsbuild.config.ts','pnpm-lock.yaml','tests/workspace-navigation/lighthouse-13.6.0/profile.json'];
 for(const root of ['apps/web/src','apps/server/src','packages/core/src','packages/agents/src','packages/engines/src','packages/native-host/src','apps/web/dist','apps/server/dist','packages/core/dist','packages/agents/dist','packages/engines/dist','packages/native-host/dist'])for(const entry of await readdir(root,{recursive:true,withFileTypes:true}))if(entry.isFile())required.push(entry.parentPath+'/'+entry.name);
 required.push(primaryProfile.source);for(const record of primaryProfile.records??[])required.push('tests/workspace-navigation/lighthouse-13.6.0/'+record.path);
 ledger.acceptedMethod=await verifyAcceptedMethod(process.env.PONDEROSA_ACCEPTED_METHOD_RECEIPT,process.env.PONDEROSA_ACCEPTED_METHOD_SHA256,required,process.env.PONDEROSA_REVIEWED_METHOD_HEAD);
});
 chromium=await stage('installed-browser-tooling',async()=>createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core').chromium);
 ({createLoadFixture,verifyQueuedLoadMessage,cancelQueuedLoadMessages}=await stage('fixture-module',()=>import('../shared/ui-load-fixture.mjs')));
 f=await stage('fixture-setup',()=>createLoadFixture(out));
 origin=await stage('production-ui-listener',async()=>{listener=f.f.app.server;ledger.uiDelivery={kind:'production-webDist',sameOrigin:true,listenerOwner:'fixture',separateWebServer:false};const origin=await f.f.listen();ledger.uiDelivery.origin=origin;return origin;});browser=await stage('browser-launch',()=>chromium.launch({executablePath:'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']}));ledger.browser=await browser.version();
 for(const product of ['core','branches']){
  await stage('activate-'+product,()=>f.activate(product));
  for(const mobile of [false,true])for(let session=0;session<(full?8:1);session++){
   const id=`${product}-${mobile?'phone':'desktop'}-${session}`,row=Object.assign(results.find(r=>r.id===id),{status:'started',profile:mobile?primaryProfile.config:{width:1365,height:768,dpr:1,cpu:1,mobile:false,touch:false}});
   let context,page;
   try{context=await browser.newContext({viewport:{width:row.profile.width,height:row.profile.height},deviceScaleFactor:row.profile.dpr,isMobile:mobile,hasTouch:mobile,...(mobile?{userAgent:row.profile.ua,screen:{width:row.profile.screenWidth,height:row.profile.screenHeight}}:{}),serviceWorkers:'block',recordVideo:{dir:out+'/video'}});

    page=await context.newPage();page.setDefaultTimeout(10000);row.errors=[];page.on('pageerror',e=>row.errors.push(e.message));
    await page.route('**/*',route=>['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
    await page.addInitScript(installTimingObserver);await page.addInitScript(()=>localStorage.setItem('ponderosa-color-mode','light'));
    const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:row.profile.cpu});
    row.before=await f.snapshot(product);assert.ok(row.before.runs.every(r=>r.status==='running'&&r.alive));
    row.navigation={url:origin+f.products[product].route,startedAt:Date.now(),seed:f.products[product].seed,profile:row.profile,primaryProfile};await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});await page.goto(row.navigation.url);const editor=page.getByLabel('Message',{exact:true});await editor.waitFor();
    const seed=f.products[product].seed;await page.locator(`[id=${JSON.stringify(`master-message-${seed.lastId}`)}]`).waitFor({state:'visible'});
    row.loadedHistory=await page.locator('article.chat-message').evaluateAll(nodes=>nodes.map(n=>({id:n.id,text:n.textContent})));assert(row.loadedHistory.some(n=>n.id===`master-message-${seed.lastId}`&&n.text.includes(seed.lastText.split(':')[0]+':')),'Canonical 10k seed tail must actually render, not just editor shell');
    row.historyPolicy='10k canonical backing history, bounded initial rendered page; no claim all10k DOM nodes loaded';await page.evaluate(()=>window.__uiTiming.marks.push({name:'editor-ready',time:performance.now()}));
    for(let repeat=0;repeat<2;repeat++){
     await page.evaluate(({id,count})=>window.__beginUiTask(id,{pointerdown:1,pointerup:1,click:1,keydown:count,keyup:count}),{id:`repeat-${repeat}`,count:'Forty input characters for timing proof!'.length+'Qualification'.length+4});
     await editor.click();await page.keyboard.type('Forty input characters for timing proof!',{delay:75});await page.keyboard.press('Control+A');await page.keyboard.press('Backspace');
     await page.mouse.wheel(0,-500);await page.keyboard.press('Control+k');const search=page.getByRole('combobox',{name:'Search Ponderosa',exact:true});await search.waitFor();await page.keyboard.type('Qualification');await page.keyboard.press('Escape');
     if(full){
      await page.getByRole('button',{name:'Chat settings and actions',exact:true}).click();await page.getByRole('menuitem',{name:'Rename',exact:true}).click();const name=page.getByLabel('Chat name',{exact:true});await name.waitFor();await name.press('Control+A');await name.pressSequentially(`Load ${product} ${session} ${repeat}`);await name.press('Enter');await name.waitFor({state:'hidden'});
      await editor.click();await page.keyboard.type('#Working');await page.getByRole('option').filter({hasText:'Working'}).first().click();await page.keyboard.type('Timed short message');const [response]=await Promise.all([
       page.waitForResponse(response=>new URL(response.url()).pathname===f.products[product].prefix+'/conversations/'+f.products[product].chat.id+'/direct-messages'&&response.request().method()==='POST'),
       page.getByRole('button',{name:'Queue message',exact:true}).click(),
      ]);assert.ok(response.ok(),'Queue submission must be accepted');
      const request=response.request().postDataJSON(),body=await response.json();(row.queueAttempts??=[]).push({status:response.status(),request,response:body});
      const receipt=verifyQueuedLoadMessage(request,body,f.products[product].agents);
      assert(!results.flatMap(result=>result.queuedMessages??[]).some(prior=>prior.messageId===receipt.messageId||prior.deliveryId===receipt.deliveryId),'Independent queued tasks require distinct receipts');
      (row.queuedMessages??=[]).push(receipt);
     }
     await page.evaluate(id=>window.__endUiTask(id),`repeat-${repeat}`);
    }
    // One frame and observer delivery task: observation flush only, never included as interaction latency.
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0))));
    await page.evaluate(()=>window.__finalizeUiTiming());await page.screenshot({path:out+'/'+id+'.png'});row.raw=await page.evaluate(()=>window.__verifyUiTiming());row.raw.namespace=`${id}/${row.raw.documentId}`;row.emulation=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,ua:navigator.userAgent,visibility:document.visibilityState}));
    assert.deepEqual([row.emulation.width,row.emulation.height,row.emulation.dpr],[row.profile.width,row.profile.height,row.profile.dpr],'Effective viewport/DPR must match frozen cell');if(mobile)assert.equal(row.emulation.ua,row.profile.ua);assert.equal(row.raw.visibility,'visible');assert(row.raw.cutoff.time>=row.raw.marks.find(m=>m.name==='editor-ready').time,'First trusted input must follow actual canonical tail readiness');
    await f.drain();row.workWindow=f.assertWindow(product,row.raw.window.timeOrigin+row.raw.window.start,row.raw.window.timeOrigin+row.raw.window.end);
    f.assertContinuity();row.summary=summarizeTimings([row.raw]);assert.deepEqual(row.errors,[]);
    // Proof-only diagnostics are captured after the timing window and raw observations are finalized.
    if(!full)row.resources=await page.evaluate(()=>performance.getEntriesByType('resource')
     .filter(entry=>{try{return new URL(entry.name).origin===location.origin;}catch{return false;}})
     .map(entry=>({name:entry.name,initiatorType:entry.initiatorType,startTime:entry.startTime,requestStart:entry.requestStart,responseStart:entry.responseStart,responseEnd:entry.responseEnd,transferSize:entry.transferSize,encodedBodySize:entry.encodedBodySize,decodedBodySize:entry.decodedBodySize})));
    row.status='complete';
   }catch(error){row.status='failed';row.error=error.stack;
    if(page)try{row.failureScreenshot=out+'/'+id+'-failure.png';await page.screenshot({path:row.failureScreenshot,timeout:3000});}catch(captureError){row.failureScreenshotError=String(captureError);}
    throw error;}
   finally{row.cleanup=[];try{await context?.close();row.cleanup.push({name:'context',status:'complete'});}catch(error){row.cleanup.push({name:'context',status:'failed',error:String(error)});row.status='failed';ledger.status='failed';}row.terminalAt=Date.now();await persist();}
  }
  await stage('cancel-queued-'+product,async()=>{ledger.queuedCancellations??={};ledger.queuedCancellations[product]=await cancelQueuedLoadMessages(f.f,f.products[product],results.filter(row=>row.product===product).flatMap(row=>row.queuedMessages??[]));});
   await stage('deactivate-'+product,()=>f.deactivate(product));await f.drain();f.assertContinuity();
 }
 for(const product of ['core','branches'])for(const mobile of [false,true]){
  const cells=results.filter(r=>r.product===product&&r.mobile===mobile);assert.equal(cells.length,full?8:1);const summary=summarizeTimings(cells.map(r=>r.raw));await writeFile(out+`/${product}-${mobile?'phone':'desktop'}-summary.json`,JSON.stringify(summary,null,2));
  if(full){assert.ok(summary.qualifiedPopulation,'All-interaction population not established; observed-only latency cannot qualify');assert.ok(summary.p75BelowFloor||summary.p75<=200);const lcps=summary.sessions.map(s=>s.lcp).sort((a,b)=>a-b);assert.ok(lcps[5]<=2500,'Predeclared rank 6 of 8 LCP');}
 }
 assert(results.every(row=>row.status==='complete'),'Every planned cell and context cleanup must complete');ledger.status='complete';
}catch(error){ledger.status='failed';ledger.error=error.stack;}finally{await finalizeLedger(ledger,results,persist,[['browser',()=>browser?.close()],['fixture',async()=>{try{await f?.close();}finally{if(listener)ledger.uiDelivery.listenerClosed=!listener.listening;}if(listener)assert.equal(listener.listening,false,'Shared production UI/API listener must close with its fixture');}],['final-continuity',()=>f?.assertContinuity()]]);}
console.log(JSON.stringify({status:ledger.status,full,sessions:results.length}));
