// Built product, disposable canonical data, and intercepted reads/SSE only.
// No DEV service interruption, external provider, action replay, or reload recovery.
import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const {fixture,until}=await import('../shared/fixture.mjs');
const {chromium,webkit,devices}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=process.env.PONDEROSA_OUTAGE_EVIDENCE??await mkdtemp(path.join(tmpdir(),'ponderosa-workspace-outage-'));
await mkdir(out,{recursive:true});const rows=[];let browser,context,f;
const save=()=>writeFile(path.join(out,'results.json'),JSON.stringify({rows,liveServiceInterrupted:false,realDevice:false},null,2)+'\n');
try{
 f=await fixture({webDist:process.env.PONDEROSA_OUTAGE_WEB_DIST??path.join(root,'apps/web/dist')});
 const chat=await f.createChat('Outage history'),agent=await f.createIdleAgent(chat,'Outage Agent');
 f.plans.set(agent.id,[{hold:true}]);await f.send(agent.id,'Canonical outage history');
 const assistant=f.ok(await f.api('POST','/api/branches/assistant',{initialize:true})).app;
 const branch=f.ok(await f.api('POST','/api/branches',{name:'Outage workflow',idempotencyKey:randomUUID()}));
 const branchChat=f.ok(await f.api('POST',`/api/branches/${branch.id}/chats`,{label:'Workflow Chat',defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
 f.ok(await f.api('POST','/api/branches/deploy',{chatId:'',branchId:branch.id,expectedVersionId:'',idempotencyKey:randomUUID(),definition:{schema:'ponderosa.branch.v1',name:branch.name,trigger:{kind:'manual'},entry:'script',steps:[{id:'script',kind:'script',runtime:'node',cwdRef:'workspace',timeoutMs:5000,source:"process.stdout.write('owned');"}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},bindings:{agents:{},directories:{workspace:f.root}}}));
 const origin=await f.listen();assert.equal(new URL(origin).hostname,'127.0.0.1');
 const views={chat:`/projects/${chat.projectId}/chats/${chat.id}`,agent:`/projects/${chat.projectId}/agents/${agent.id}`,assistant:'/assistant',workflow:`/branches?branch=${branch.id}`,executions:`/branches?branch=${branch.id}&tab=executions`,chats:`/branches?branch=${branch.id}&tab=chats&chat=${branchChat.id}`,settings:`/branches?branch=${branch.id}&tab=settings`};
 for(const engine of (process.env.PONDEROSA_OUTAGE_BROWSERS??'chromium').split(',')){
  browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='webkit'?{executablePath:process.env.PONDEROSA_WEBKIT_PATH}:{executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']})});
  for(const size of (process.env.PONDEROSA_OUTAGE_SIZES??'1440,390').split(',').map(Number))for(const name of (process.env.PONDEROSA_OUTAGE_VIEWS??Object.keys(views).join(',')).split(',')){
   const row={engine,size,name,passed:false,errors:[],browserDiagnostics:[],consoleErrors:[],checks:[]};rows.push(row);let outage=false,gets=0,rejectSettings=false,settingWrites=0;const posts=[];
   context=await browser.newContext({...(size===390&&engine==='webkit'?devices['iPhone 13']:{viewport:{width:size,height:size===390?844:962},isMobile:size===390,hasTouch:size===390}),serviceWorkers:'block'});
   await context.addInitScript(()=>{const Original=EventSource;window.__outageSources=[];window.EventSource=class extends Original{constructor(...args){super(...args);window.__outageSources.push(this)}};});
   await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());assert.equal(url.origin,origin,'Only owned loopback traffic');
    if(rejectSettings&&request.method()!=='GET'&&/\/agents\/[^/]+$/.test(url.pathname)){settingWrites++;return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Controlled settings rejection'})});}
    if(request.method()==='GET'&&url.pathname.startsWith('/api/')&&outage){gets++;return route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({error:'Controlled proxy outage'})});}
    if(request.method()==='POST'&&url.pathname===`/api/branches/${branch.id}/executions`){posts.push(request.postDataJSON());return route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({error:'Controlled lost Run acknowledgement'})});}
    return route.continue();
   });
   const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>{
    // This exact native canvas diagnostic reproduces on clean C356 in healthy
    // and mocked-outage views. Retain it separately; never ignore app errors.
    if(engine==='webkit'&&name==='workflow'&&error.message==='ResizeObserver loop completed with undelivered notifications.')row.browserDiagnostics.push(error.message);else row.errors.push(error.message);
   });page.on('console',message=>{if(message.type()==='error')row.consoleErrors.push(message.text());});
   try{
    await page.goto(origin+views[name],{waitUntil:'domcontentloaded'});
    const editor=page.getByRole('textbox',{name:'Message',exact:true}).last();
    if(['chat','agent','assistant','chats'].includes(name)){await editor.waitFor();await editor.fill('Retained outage draft');await page.waitForTimeout(1500);}
    else await page.getByRole('heading',{name:branch.name,exact:true}).or(page.getByText(branch.name,{exact:true})).first().waitFor();
    await page.waitForTimeout(1500);
    if(name==='workflow'&&size===1440){
     await page.getByRole('button',{name:'Run Workflow',exact:true}).first().click();let dialog=page.getByRole('dialog').filter({has:page.getByLabel('Run Input',{exact:true})});await dialog.getByLabel('Run Input',{exact:true}).fill('Protected run input');await dialog.getByRole('button',{name:'Run Workflow',exact:true}).click();await dialog.getByRole('button',{name:'Retry Run Submission',exact:true}).waitFor();await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
     const disclosure=page.locator('details').filter({has:page.locator('summary',{hasText:'Workflow Action Needs Attention'})});await disclosure.locator('summary').click();await disclosure.getByRole('button',{name:'Close',exact:true}).click();await page.getByRole('button',{name:'Run Workflow',exact:true}).first().click();dialog=page.getByRole('dialog').filter({has:page.getByLabel('Run Input',{exact:true})});assert.equal(await dialog.getByLabel('Run Input',{exact:true}).inputValue(),'Protected run input');assert(await dialog.getByLabel('Run Input',{exact:true}).isDisabled());await dialog.getByRole('button',{name:'Retry Run Submission',exact:true}).click();await until(()=>posts.length===2,'explicit exact Run retry');await page.waitForTimeout(200);assert.deepEqual(posts[0],posts[1]);await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
     await page.waitForTimeout(350);const snack=page.locator('.MuiSnackbar-root').getByRole('button',{name:'Close'});if(await snack.count())await snack.click();row.checks.push('Run Close preserves unconfirmed input/key and retry guard');
    }
    if(await editor.count())await editor.evaluate(el=>{window.__outageEditor=el;window.__outageRoot=el.getRootNode();});
    row.before=await page.evaluate(()=>{const scope=window.__outageRoot??document;window.__outageTranscript=scope.querySelector('.chat-scroll-region');if(window.__outageTranscript)window.__outageTranscript.scrollTop=0;return {height:window.__outageTranscript?.clientHeight,scroll:window.__outageTranscript?.scrollTop,editor:Boolean(window.__outageEditor)};});
    outage=true;await page.evaluate(()=>{for(const source of window.__outageSources)if(source.readyState!==2)source.dispatchEvent(new Event('error'));document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('online'));});
    const notice=page.getByRole('button',{name:'Reconnecting',exact:true});await notice.waitFor({timeout:25000});assert.equal(await notice.count(),1,'one compact status owner');
    row.after=await page.evaluate(()=>({height:(window.__outageRoot??document).querySelector('.chat-scroll-region')?.clientHeight,scroll:(window.__outageRoot??document).querySelector('.chat-scroll-region')?.scrollTop,editor:window.__outageEditor===(window.__outageRoot??document).querySelector('[aria-label="Message"]'),transcript:window.__outageTranscript===(window.__outageRoot??document).querySelector('.chat-scroll-region'),alerts:[...document.querySelectorAll('[role="alert"]'),...(window.__outageRoot&&window.__outageRoot!==document?window.__outageRoot.querySelectorAll('[role="alert"]'):[])].filter(el=>el.getBoundingClientRect().height>0).map(el=>el.textContent),overflow:document.documentElement.scrollWidth>innerWidth}));
    assert.deepEqual(row.after.alerts,[],'no stacked derivative read alerts');assert(!row.after.overflow,'phone/desktop no horizontal clipping');
    if(row.before.editor){assert(row.after.editor&&row.after.transcript,'cached editor/transcript stay mounted');assert.equal(row.after.height,row.before.height,'outage does not squeeze transcript');assert.equal(row.after.scroll,row.before.scroll,'outage retains scroll');assert((await editor.innerText()).includes('Retained outage draft'));}
    if(name==='assistant'){
     row.header=await editor.evaluate(el=>{const root=el.getRootNode(),header=root.querySelector('header'),contact=root.querySelector('[data-conversation-contact]'),notice=[...header.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Reconnecting');const rect=e=>e?.getBoundingClientRect().toJSON();return {header:rect(header),contact:rect(contact),notice:rect(notice),actions:[...header.querySelectorAll('button[aria-label]')].filter(b=>/call|Settings|navigation|Back/i.test(b.getAttribute('aria-label'))).map(rect)};});
     const {contact,notice:button,header,actions}=row.header;assert(button&&contact&&header,'Assistant notice is in its existing header');assert(button.right<=contact.x+1||button.x>=contact.right-1,'compact warning does not overlap centered contact');assert(button.x>=header.x-1&&button.right<=header.right+1,'compact warning stays inside header');for(const action of actions)assert(button.right<=action.x+1||button.x>=action.right-1||button.bottom<=action.y+1||button.y>=action.bottom-1,'notice does not overlap navigation, Call or Settings');
    }
    await notice.click();let details=page.getByRole('dialog',{name:'Workspace Update Details'});await details.waitFor();assert(!/never synced|data has not loaded yet/.test(await details.innerText()),'loaded owner is not described as never loaded');assert(!/deployment/i.test(await details.innerText()),'outage does not invent deployment evidence');
    const proxyText=(await details.innerText()).split('Controlled proxy outage').length-1;assert(proxyText<=1,'deduplicated proxy diagnostics');await details.getByRole('button',{name:'Close',exact:true}).click();await page.waitForTimeout(1500);assert.equal(await details.count(),0,'failed background retries cannot reopen Details');
    await page.screenshot({path:path.join(out,`${engine}-${size}-${name}-outage.png`)});
    outage=false;await notice.click();details=page.getByRole('dialog',{name:'Workspace Update Details'});await details.getByRole('button',{name:'Retry',exact:true}).click();await notice.waitFor({state:'hidden',timeout:25000});row.checks.push('mocked combined outage, cache/draft/geometry retention, Close, verified recovery without reload');
    if(name==='assistant'){
     const assistantRoot=page.locator('[data-assistant-layout]');assert(await assistantRoot.count(),'Assistant remains mounted after verified recovery');await assistantRoot.getByRole('button',{name:'Settings',exact:true}).click();const settings=page.getByRole('dialog',{name:'Settings',exact:true});await settings.getByLabel('Check Every (Minutes)',{exact:true}).fill('11');rejectSettings=true;await settings.getByRole('button',{name:'Save Model',exact:true}).click();
     await settings.locator('summary',{hasText:'Settings Action Needs Attention'}).waitFor();assert.equal(await settings.getByRole('alert').count(),0,'mutation recovery is compact, without a duplicate dialog banner');const snack=page.locator('.MuiSnackbar-root').filter({hasText:'Conversation Settings Not Saved'});await snack.waitFor();await page.keyboard.press('Escape');await snack.waitFor({state:'hidden'});assert.equal(await settings.getByLabel('Check Every (Minutes)',{exact:true}).inputValue(),'11','keyboard dismissal retains unsaved settings');assert(await settings.isVisible(),'closing feedback retains the settings draft');
     rejectSettings=false;outage=true;await settings.getByRole('button',{name:'Discard Draft And Reload',exact:true}).click();await assistantRoot.locator('header button[aria-label="Reconnecting"]').waitFor({timeout:25000});assert.equal(await settings.getByRole('alert').count(),0,'shared readback failure does not become a string action banner');
     outage=false;await settings.getByRole('button',{name:'Discard Draft And Reload',exact:true}).click();await assistantRoot.locator('header button[aria-label="Reconnecting"]').waitFor({state:'hidden',timeout:25000});assert.equal(settingWrites,1,'read-only recovery never repeats the failed settings write');await settings.getByRole('button',{name:'Done',exact:true}).click();row.checks.push('settings action uses shared snackbar/compact retained recovery; failed readback joins outage; recovery never repeats mutation');
    }
    assert(gets<150,'bounded background and coordinated retry requests');assert.deepEqual(row.errors,[]);assert(!row.consoleErrors.some(message=>message.includes('Workspace surface failed')),'outage/recovery never substitutes the error boundary');assert(row.browserDiagnostics.length<=30,'native canvas diagnostics remain bounded');row.gets=gets;row.passed=true;
   }catch(error){row.error=error.stack??String(error);row.failureDom=await page.evaluate(()=>({reportTrace:window.__reportTrace,readTrace:window.__readTrace,path:location.pathname,assistant:document.querySelectorAll('[data-assistant-layout]').length,buttons:[...document.querySelectorAll('button[aria-label="Settings"]')].map(el=>{const parents=[];for(let p=el;p;p=p.parentElement)if(p.hasAttribute('aria-hidden'))parents.push({tag:p.tagName,id:p.id,hidden:p.getAttribute('aria-hidden')});return {text:el.textContent,rect:el.getBoundingClientRect().toJSON(),parents};}),dialogs:[...document.querySelectorAll('[role="dialog"]')].map(el=>({label:el.getAttribute('aria-label'),text:el.textContent?.slice(0,500)})),text:document.body.innerText.slice(0,2000)}));await page.screenshot({path:path.join(out,`${engine}-${size}-${name}-failure.png`),fullPage:true});}
   finally{await context.close();context=undefined;await save();console.log(`${row.passed?'PASS':'FAIL'} ${engine} ${size} ${name}${row.error?' '+row.error.split('\n')[0]:''}`);}
  }
  if(process.env.PONDEROSA_OUTAGE_INITIAL==='1')for(const name of ['chat','assistant','workflow','settings']){
   const row={engine,size:390,name:`${name}-initial`,passed:false,checks:[]};rows.push(row);let down=true;
   context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
   await context.route('**/*',route=>{const url=new URL(route.request().url());assert.equal(url.origin,origin);return down&&route.request().method()==='GET'&&url.pathname.startsWith('/api/')?route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({error:'Controlled initial outage'})}):route.continue();});
   const page=await context.newPage();page.setDefaultTimeout(25000);
   try{
    await page.goto(origin+views[name],{waitUntil:'domcontentloaded'});await page.getByText(/Could Not Be Loaded/).first().waitFor();
    assert.equal(await page.getByText(/Could Not Be Loaded/).count(),1,'one contained no-cache unavailable view');assert.equal(await page.getByRole('alert').filter({hasText:'Controlled initial outage'}).count(),0,'no dependent initial error cascade');
    const notice=page.getByRole('button',{name:'Reconnecting',exact:true});await notice.waitFor();assert.equal(await notice.count(),1);await page.screenshot({path:path.join(out,`${engine}-390-${name}-initial.png`)});
    down=false;await notice.click();await page.getByRole('dialog',{name:'Workspace Update Details'}).getByRole('button',{name:'Retry',exact:true}).click();await notice.waitFor({state:'hidden'});await page.getByText(/Could Not Be Loaded/).first().waitFor({state:'hidden'});row.passed=true;row.checks.push('fresh browser has one contained unavailable state, then recovers without reload');
   }catch(error){row.error=error.stack??String(error);await page.screenshot({path:path.join(out,`${engine}-390-${name}-initial-failure.png`),fullPage:true});}
   finally{await context.close();context=undefined;await save();console.log(`${row.passed?'PASS':'FAIL'} ${engine} initial ${name}`);}
  }
  if(process.env.PONDEROSA_OUTAGE_RESTART==='1'){
   context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});const loaded=[];
   await context.route('**/*',route=>{assert.equal(new URL(route.request().url()).origin,origin);return route.continue();});
   for(const name of ['workflow','executions','chats','settings']){
    const page=await context.newPage();page.setDefaultTimeout(25000);await page.goto(origin+views[name],{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'Run Workflow',exact:true}).first().waitFor();
    if(name==='chats'){await page.getByRole('textbox',{name:'Message',exact:true}).last().fill('Retained across owned restart');await page.waitForTimeout(1000);}
    await page.waitForTimeout(500);await page.evaluate(()=>{window.__retainedMain=document.querySelector('#main-content');window.__retainedEditor=document.querySelector('[aria-label="Message"]');});
    loaded.push({name,page,reconnected:page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/workspace/stream')&&response.status()===200,{timeout:35000})});
   }
   // Restart only this disposable fixture at the same loopback address.
   await f.reopen();assert.equal(await f.listen({host:'127.0.0.1',port:Number(new URL(origin).port)}),origin);
   for(const {name,page,reconnected} of loaded){
    const row={engine,size:390,name:`${name}-owned-restart`,passed:false,checks:[]};rows.push(row);
    try{await page.bringToFront();await reconnected;await page.waitForTimeout(1500);assert(await page.evaluate(()=>window.__retainedMain===document.querySelector('#main-content')),'same loaded client survives new server instance');assert.equal(await page.getByText(/Could Not Be Loaded/).count(),0);
     if(name==='chats'){assert(await page.evaluate(()=>window.__retainedEditor===document.querySelector('[aria-label="Message"]')));assert((await page.getByRole('textbox',{name:'Message',exact:true}).last().innerText()).includes('Retained across owned restart'));}
     const notice=page.getByRole('button',{name:'Reconnecting',exact:true});if(await notice.count()){await notice.click();const details=page.getByRole('dialog',{name:'Workspace Update Details'});assert(!/never synced|data has not loaded yet/.test(await details.innerText()));await details.getByRole('button',{name:'Close',exact:true}).click();}
     await notice.waitFor({state:'hidden',timeout:25000});row.passed=true;row.checks.push('previously loaded owner/cache survives fixture restart and new SSE instance without reload');
    }catch(error){row.error=error.stack??String(error);await page.screenshot({path:path.join(out,`${engine}-390-${name}-restart-failure.png`),fullPage:true});}
    console.log(`${row.passed?'PASS':'FAIL'} ${engine} owned restart ${name}`);await save();
   }
   await context.close();context=undefined;
  }
  await browser.close();browser=undefined;
 }
 assert(rows.every(row=>row.passed),'Outage qualification failed; inspect results.json');
}finally{if(context)await context.close();if(browser)await browser.close();if(f)await f.dispose(false);await save();console.log(`Evidence: ${out}`);}
