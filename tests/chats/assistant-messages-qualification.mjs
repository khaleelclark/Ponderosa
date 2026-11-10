// Built product + disposable real API. Inert providers, loopback traffic only.
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
const root=fileURLToPath(new URL('../../',import.meta.url)),out=process.env.PONDEROSA_ASSISTANT_EVIDENCE??await mkdtemp(path.join(tmpdir(),'ponderosa-assistant-messages-'));
await mkdir(out,{recursive:true});
const rows=[];let browser,context,f;
const save=()=>writeFile(path.join(out,'results.json'),JSON.stringify({rows,realDeviceVerified:false},null,2)+'\n');
try{
 async function setupCell(){
 f=await fixture({webDist:path.join(root,'apps/web/dist'),modelCatalog:async()=>({models:['fixture','alternative'].map(id=>({id,label:id==='fixture'?'Fixture model':'Alternative model',kind:'alias',source:'provider-probe',efforts:[{id:'medium',label:'Medium'},{id:'high',label:'High'}],defaultEffort:'medium',serviceTiers:[{id:'standard',label:'Standard'},{id:'fast',label:'Fast'}],defaultServiceTier:'standard'})),cliVersion:'owned-fixture',configurationKey:'owned-fixture'})});
 const assistant=f.ok(await f.api('POST','/api/branches/assistant',{initialize:true})).app,prefix='/api/branches/engine';
 const agent=(await f.detail(assistant.agentId,prefix)).agent;
 let replyReady=false;
 f.plans.set(agent.id,[{hold:true,onStart:async session=>{const response=await session.tool('ponderosa_message',{text:'Synthetic Assistant reply with **real identity**.\n\n| Field | Value |\n| --- | --- |\n| Status | Contained |\n\n```ts\nconst scoped = true;\n```'});assert(response.success,response.text);replyReady=true;}}]);
 f.ok(await f.api('POST',`${prefix}/agents/${agent.id}/messages`,{text:'Synthetic history message',idempotencyKey:randomUUID(),activeRunDelivery:'steer'}));
 await until(()=>replyReady,'owned Assistant reply');
 const output=assistant; // Its existing Output URL does not change the designated speaker role.
 const origin=await f.listen();assert.equal(new URL(origin).hostname,'127.0.0.1');
  return {assistant,prefix,agent,output,origin};
 }
 let assistant,prefix,agent,output,origin;
 for(const engine of (process.env.PONDEROSA_ASSISTANT_BROWSERS??'chromium,webkit').split(',')){
  browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='webkit'?{executablePath:process.env.PONDEROSA_WEBKIT_PATH}:{executablePath:process.env.PONDEROSA_CHROME_PATH??'/usr/bin/google-chrome',args:['--no-sandbox']})});
  for(const size of (process.env.PONDEROSA_ASSISTANT_SIZES??'1440,2200,700,390').split(',').map(Number))for(const mode of ['light','dark']){
   const row={engine,size,mode,passed:false,errors:[],checks:[]};rows.push(row);const phone=size===390;
   if(f){await f.dispose(false);f=undefined;}({assistant,prefix,agent,output,origin}=await setupCell());
   context=await browser.newContext({...(phone&&engine==='webkit'?devices['iPhone 13']:{viewport:{width:size,height:phone?844:962},isMobile:phone,hasTouch:phone}),serviceWorkers:'block',acceptDownloads:false});
   await context.addInitScript(mode=>localStorage.setItem('ponderosa-color-mode',mode),mode);
   const requests=[];let rejectNext=false;
   await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());assert.equal(url.origin,origin,'Only owned loopback traffic');
    let body;try{body=request.postDataJSON();}catch{}
    if(request.method()==='POST'&&typeof body?.text==='string'&&/\/(messages|direct-messages)$/.test(url.pathname)){
     requests.push(body);if(rejectNext){rejectNext=false;return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Controlled Assistant rejection'})});}
    }
    return route.continue();
   });
   const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>row.errors.push(error.message));
   try{
    await page.goto(origin+'/assistant',{waitUntil:'domcontentloaded'});
    const assistantRoot=page.locator('[data-assistant-layout]'),composer=assistantRoot.locator('[data-assistant-composer]'),editor=composer.getByRole('textbox',{name:'Message',exact:true});await editor.waitFor();
    await assistantRoot.locator('[data-conversation-contact] [role="status"]').filter({hasText:'Working'}).waitFor();
    await assistantRoot.locator('.chat-message-assistant:not(.chat-message-end)').filter({hasText:'Synthetic Assistant reply'}).last().waitFor();
    const metrics=await assistantRoot.evaluate(root=>{const header=root.querySelector('header'),contact=root.querySelector('[data-conversation-contact]'),composer=root.querySelector('.ponderosa-composer'),row=root.querySelector('.chat-message-frame'),pill=root.querySelector('[data-composer-input-shell]'),runtime=root.querySelector('[data-composer-runtime]'),wave=root.querySelector('button[aria-label="Voice Options"]'),plus=root.querySelector('button[aria-label="Add Attachment Or Capability"]');const rect=e=>e.getBoundingClientRect().toJSON();return {header:rect(header),contact:rect(contact),composer:rect(composer),row:rect(row),pill:rect(pill),runtime:rect(runtime),wave:rect(wave),plus:rect(plus),label:getComputedStyle(runtime.querySelector('[data-runtime-label]')).display,icon:getComputedStyle(runtime.querySelector('[data-runtime-icon]')).display,gutter:root.querySelector('.chat-scroll-region').offsetWidth-root.querySelector('.chat-scroll-region').clientWidth,overflow:document.documentElement.scrollWidth>innerWidth};});row.metrics=metrics;
    assert(Math.abs(metrics.header.x+metrics.header.width/2-metrics.contact.x-metrics.contact.width/2)<1,'Name/status centered in available header');
    assert(Math.abs(metrics.composer.x-metrics.row.x)<=metrics.gutter+1&&Math.abs(metrics.composer.right-metrics.row.right)<=metrics.gutter+1,'Transcript and composer share lane');
    assert(metrics.plus.right<=metrics.pill.x&&metrics.runtime.right<=metrics.wave.x+1,'Outside plus, adjacent model and waveform');
    assert(!metrics.overflow,'No viewport overflow');assert(metrics.composer.width<520?metrics.label==='none'&&metrics.icon!=='none':metrics.label!=='none','Responsive existing speedometer');
    assert.equal(await composer.getByRole('button',{name:'Queue Message',exact:true}).count(),0);assert.equal(await composer.getByRole('button',{name:'Record Voice Message',exact:true}).count(),0);assert(!/Message Assistant directly|Send a message|Ctrl\+Enter/.test(await composer.innerText()),'Blank accessible Message editor without helper or shortcut hint');
    row.avatar=await assistantRoot.locator('.chat-message-assistant:not(.chat-message-end)').filter({hasText:'Synthetic Assistant reply'}).last().evaluate(row=>{const avatar=row.querySelector('.MuiAvatar-root').getBoundingClientRect(),body=row.querySelector('.chat-message-body').getBoundingClientRect();return {bottomGap:body.bottom-avatar.bottom,overlaps:avatar.top<body.bottom};});assert(row.avatar.bottomGap>=-1&&row.avatar.bottomGap<=8&&row.avatar.overlaps,'Avatar stays beside its bubble instead of below the action footer');
    row.checks.push('centered canonical Working status, shared lane, outside plus, responsive real runtime, one waveform');
    await assistantRoot.locator('.chat-scroll-region').evaluate(el=>{el.scrollTop=0;});await page.mouse.move(1,1);await page.waitForTimeout(200);await page.screenshot({path:path.join(out,`${engine}-${size}-${mode}-empty.png`)});
    await composer.locator('[data-composer-runtime]').click();await page.getByRole('button',{name:/^Model:/}).click();
    const currentModel=(await f.detail(agent.id,prefix)).agent.model,target=currentModel==='alternative'?'Fixture model':'Alternative model';await page.getByRole('menuitem',{name:target,exact:true}).click();
    await until(async()=>((await f.detail(agent.id,prefix)).agent.model===(target==='Fixture model'?'fixture':'alternative')),'real model setting mutation');
    await page.keyboard.press('Escape');await editor.click();row.checks.push('existing runtime picker changes canonical Agent model');
    await composer.getByRole('button',{name:'Voice Options',exact:true}).click();await page.getByRole('menuitem',{name:/Voice Conversation/}).waitFor();await page.getByRole('menuitem',{name:/Record Voice Message/}).waitFor();await page.keyboard.press('Escape');
    if(phone){
     await editor.fill('Long draft stays contained. '.repeat(40));await page.setViewportSize({width:390,height:520});
     await until(async()=>{const box=await composer.boundingBox();return box&&box.y+box.height<=521;},'composer follows reduced emulated keyboard viewport');
     assert(await composer.getByRole('button',{name:'Send Message',exact:true}).isVisible(),'Long draft preserves Send in reduced viewport');
     await page.screenshot({path:path.join(out,`${engine}-${size}-${mode}-keyboard-emulation.png`)});await page.setViewportSize({width:390,height:844});await editor.fill('');
     row.checks.push('long draft with reduced keyboard viewport emulation');
    }
    const marker=`Assistant steering ${engine} ${size} ${mode} λ😀`;
    await editor.fill(marker);await editor.focus();const before=requests.length;await page.keyboard.press('Control+Enter');await page.waitForTimeout(100);
    assert.equal(requests.length,before);assert((await editor.innerText()).includes(marker));assert(!(await editor.innerText()).includes('\n'),'Ctrl+Enter does not insert newline');
    const chooser=page.waitForEvent('filechooser');await composer.getByRole('button',{name:'Add Attachment Or Capability'}).click();await page.getByRole('menuitem',{name:/^Files/}).click();await (await chooser).setFiles({name:'assistant-readable.txt',mimeType:'text/plain',buffer:Buffer.from('Exact synthetic Assistant attachment')});
    const send=composer.getByRole('button',{name:'Send Message',exact:true});await composer.getByRole('button',{name:'Remove assistant-readable.txt'}).waitFor();await until(async()=>!await send.isDisabled(),'uploaded Assistant attachment');
    const steers=f.steers.length;await send.click();await until(()=>requests.length===before+1&&f.steers.length>steers,'existing busy Assistant steering');
    assert.equal(requests.at(-1).activeRunDelivery,'steer');assert.equal((await f.api('GET',`${prefix}/agents/${agent.id}/queued-messages`)).body.length,0,'Assistant never enqueues');
    const message=assistantRoot.locator('.chat-message-assistant.chat-message-end').filter({hasText:marker});await message.waitFor();await message.getByRole('link',{name:'Download assistant-readable.txt',exact:true}).waitFor();
    row.attachment=await message.evaluate(row=>{const bubble=getComputedStyle(row.querySelector('.chat-message-body')),card=getComputedStyle(row.querySelector('.chat-attachment-card')),button=getComputedStyle(row.querySelector('[aria-label="Download assistant-readable.txt"]'));return {bubble:bubble.backgroundColor,card:card.backgroundColor,button:button.color};});assert.notEqual(row.attachment.bubble,row.attachment.card);assert.notEqual(row.attachment.button,row.attachment.card);
    await page.mouse.move(1,1);await page.waitForTimeout(200);await page.screenshot({path:path.join(out,`${engine}-${size}-${mode}-attachment.png`)});row.checks.push('physical key emulation retains Ctrl draft; attachment Send steers once without queue; readable canonical attachment');
    await message.getByRole('button',{name:'Preview assistant-readable.txt',exact:true}).click();await page.getByRole('dialog').filter({hasText:'assistant-readable.txt'}).waitFor();await page.keyboard.press('Escape');
    await editor.fill('Preserve failed Assistant draft');rejectNext=true;await send.click();
    await assistantRoot.locator('[data-queue-row]').filter({hasText:'Preserve failed Assistant draft'}).getByText('Failed',{exact:true}).waitFor();
    const captured=await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('ponderosa.submission.v1.')).map(key=>JSON.parse(localStorage.getItem(key))).find(item=>item?.text?.includes('Preserve failed Assistant draft')));
    assert(captured?.text==='Preserve failed Assistant draft'&&captured.action==='send'&&captured.error==='Controlled Assistant rejection','Failed steering keeps its exact Send intent');row.checks.push('failed steering keeps recoverable draft and operation');
    await page.screenshot({path:path.join(out,`${engine}-${size}-${mode}-failure-retained.png`)});
    await assistantRoot.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('dialog').filter({hasText:'Run Automatically'}).waitFor();await page.getByRole('button',{name:'Done',exact:true}).click();
    assert.deepEqual(row.errors,[]);row.passed=true;
   }catch(error){row.error=error.stack;await page.screenshot({path:path.join(out,`${engine}-${size}-${mode}-FAIL.png`)}).catch(()=>{});throw error;}
   finally{await context.close();context=undefined;await save();}
   console.log(`PASS ${engine} ${size} ${mode}`);
  }
  // Same Agent via Output retains shared standard composer and Queue semantics.
  context=await browser.newContext({viewport:{width:1440,height:962},serviceWorkers:'block'});const page=await context.newPage();await page.goto(origin+output.url);await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();assert.equal(await page.locator('[data-assistant-layout],[data-assistant-composer],.chat-message-assistant').count(),0);await page.getByRole('textbox',{name:'Message',exact:true}).fill('Output queue remains available');await page.getByRole('button',{name:'Queue Message',exact:true}).waitFor();await page.screenshot({path:path.join(out,`${engine}-output.png`)});
  // A retained browser Queue intent stays inspectable in its exact Branch-owned Agent surface.
  await page.goto(origin+'/assistant');await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();
  const retainedId='owned-review-'+engine;
  const retained=await page.evaluate(({agent,id})=>{
   const item={version:1,scope:'agent:'+agent.id,ownerId:localStorage.getItem('ponderosa.draft.owner.v1'),storageKey:'owned-retained-fixture',projectId:agent.projectId,clientId:'owned-fixture',createdAt:Date.now(),action:'queue',text:'Synthetic retained Queue intent',editorText:'Synthetic retained Queue intent',attachmentNames:[],mentionedAgents:[],newAgentRequested:false,status:'unknown',dispatchStarted:true,pending:{fingerprint:'a'.repeat(64),idempotencyKey:id,request:{recipientAgentIds:[agent.id],runtime:{activeRunDelivery:'queue'}}}};
   const raw=JSON.stringify(item);localStorage.setItem('ponderosa.submission.v1.'+id,raw);window.dispatchEvent(new Event('ponderosa-submission-outbox'));return raw;
  },{agent,id:retainedId});
  const review=page.getByRole('link',{name:'Review In Agent Chat',exact:true});await review.waitFor();const href=await review.getAttribute('href'),url=new URL(href,origin);
  assert.equal(url.pathname,'/branches');assert.equal(url.searchParams.get('branch'),assistant.branchId);assert.equal(url.searchParams.get('chat'),assistant.chatId);
  assert.equal(new URL(url.searchParams.get('workspace'),origin).pathname,`/projects/${agent.projectId}/agents/${agent.id}`);
  const beforeReview=f.steers.length;await page.evaluate(id=>window.dispatchEvent(new CustomEvent('ponderosa-submission-retry',{detail:id})),retainedId);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await page.evaluate(id=>localStorage.getItem('ponderosa.submission.v1.'+id),retainedId),retained);assert.equal(f.steers.length,beforeReview);
  const recovery=await context.newPage();await recovery.goto(origin+href);await recovery.getByRole('textbox',{name:'Message',exact:true}).waitFor();await recovery.locator('[data-queue-row]').filter({hasText:'Synthetic retained Queue intent'}).getByRole('button',{name:'Retry',exact:true}).waitFor();assert.equal(await recovery.locator('[data-assistant-composer]').count(),0,'Recovery opens the ordinary Branch Agent chat');assert.equal(f.steers.length,beforeReview);assert.equal(f.ok(await f.api('GET',`${prefix}/agents/${agent.id}/queued-messages`)).length,0,'Review navigation cannot replay retained work');await recovery.close();
  await context.close();context=undefined;
  await browser.close();browser=undefined;
 }
 assert(rows.every(row=>row.passed));console.log(JSON.stringify({passed:true,cells:rows.length,evidence:out,physicalHardwareVerified:false}));
}finally{await context?.close();await browser?.close();await f?.dispose(false);await save();}
