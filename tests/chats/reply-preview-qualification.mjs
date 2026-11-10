// Built product with disposable canonical data and intercepted presentation reads.
// Inert providers only. No DEV outage, real work retry, or provider connection.
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
const root=fileURLToPath(new URL('../../',import.meta.url)),out=process.env.PONDEROSA_REPLY_EVIDENCE??await mkdtemp(path.join(tmpdir(),'ponderosa-reply-preview-'));
await mkdir(out,{recursive:true});const rows=[];let f,browser,context,success=false;
const save=()=>writeFile(path.join(out,'results.json'),JSON.stringify({rows,liveRuntimeChanged:false,realDevice:false},null,2)+'\n');
try{
 f=await fixture({webDist:process.env.PONDEROSA_REPLY_WEB_DIST??path.join(root,'apps/web/dist')});
 const chat=await f.createChat('Reply Preview QA'),a=await f.createIdleAgent(chat,'miXeD Agent ID_abC'),b=await f.createIdleAgent(chat,'Second recipient');
 for(const agent of [a,b])f.plans.set(agent.id,[{hold:true}]);
 const broadcast=f.ok(await f.api('POST',`/api/conversations/${chat.id}/messages`,{text:`#${a.handle} #${b.handle} UI009 exact broadcast source`,idempotencyKey:randomUUID(),recipientAgentMentions:[a,b].map(agent=>({agentId:agent.id,projectId:chat.projectId,handle:agent.handle,currentHandle:agent.handle,currentTitle:agent.title}))}));
 const assistant=f.ok(await f.api('POST','/api/branches/assistant',{initialize:true})).app,prefix='/api/branches/engine';
 f.plans.set(assistant.agentId,[{hold:true}]);f.ok(await f.api('POST',`${prefix}/agents/${assistant.agentId}/messages`,{text:'UI009 exact Assistant source',idempotencyKey:randomUUID(),activeRunDelivery:'steer'}));
 const sourceFor=async(agent,prefix='/api')=>until(async()=>{const detail=await f.detail(agent,prefix),message=detail.messages.find(m=>m.text?.includes('UI009 exact'));return message?.deliveryReceipts?.some(r=>r.executionId)?message:false;},'exact inert source receipt');
 const shared=await sourceFor(a.id),privateSource=await sourceFor(assistant.agentId,prefix),privateProjectId=(await f.detail(assistant.agentId,prefix)).agent.projectId;
 assert.equal(shared.communicationEventId,broadcast.communicationEventId);const sources=new Map([shared,privateSource].map(message=>[message.communicationEventId,message]));
 const ownedReceipts=new Set([...sources.values()].flatMap(message=>message.deliveryReceipts.map(r=>r.activationId+':'+r.targetAgentId)));
 const origin=await f.listen(),views={chat:`/projects/${chat.projectId}/chats/${chat.id}`,agent:`/projects/${chat.projectId}/agents/${a.id}`,assistant:'/assistant',output:assistant.url};
 for(const engine of (process.env.PONDEROSA_REPLY_BROWSERS??'chromium,webkit').split(',')){
  browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='webkit'?{executablePath:process.env.PONDEROSA_WEBKIT_PATH}:{executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']})});
  for(const size of [1440,390])for(const mode of ['light','dark'])for(const view of (process.env.PONDEROSA_REPLY_VIEWS??'chat,agent,assistant,output').split(',')){
   const row={engine,size,mode,view,passed:false,errors:[],checks:[]};rows.push(row);let phase='uncertain',readMode='limit',reads=[],writes=[],limited=new Set(),closing=false;
   context=await browser.newContext({...(size===390&&engine==='webkit'?devices['iPhone 13']:{viewport:{width:size,height:size===390?844:962},isMobile:size===390,hasTouch:size===390}),serviceWorkers:'block'});
   await context.addInitScript(mode=>localStorage.setItem('ponderosa-color-mode',mode),mode);
   const mapReceipts=value=>{
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){for(const child of value)mapReceipts(child);return;}
    if(ownedReceipts.has(value.activationId+':'+value.targetAgentId))Object.assign(value,{state:phase==='uncertain'?'run_unconfirmed':'delivered',providerAcknowledged:true,canRetry:phase==='uncertain'?true:undefined,retryMayDuplicate:undefined});
    const source=sources.get(value.communicationEventId??value.id);
    if(source&&Array.isArray(value.deliveryReceipts))value.deliveryReceipts=value.deliveryReceipts.map(r=>({...r,state:phase==='uncertain'?'run_unconfirmed':'delivered',providerAcknowledged:true,canRetry:phase==='uncertain'?true:undefined,retryMayDuplicate:undefined}));
    for(const child of Object.values(value))mapReceipts(child);
   };
   await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),beganBeforeClose=!closing;assert.equal(url.origin,origin,'Owned loopback traffic only');
    try{
    if(request.method()==='POST'&&/\/message-deliveries\/[^/]+\/retry$/.test(url.pathname)){writes.push({path:url.pathname,body:request.postData()});return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'rAw explicit retry /ExactPath gpt-5.2 ID_abC'})});}
    const match=url.pathname.match(/\/reply-streams\/([^/]+)\/([^/]+)$/);
    if(match&&sources.has(match[1])){
     const source=sources.get(match[1]),receipt=source.deliveryReceipts.find(r=>r.targetAgentId===match[2]);assert(receipt?.executionId,'Exact source recipient');reads.push({id:match[1],agent:match[2],at:Date.now()});
     if(readMode==='limit'&&!limited.has(match[2])){limited.add(match[2]);return route.fulfill({status:429,headers:{'retry-after':'1'},contentType:'application/json',body:JSON.stringify({error:'request rate limit exceeded'})});}
     if(readMode==='transient')return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary read failure'})});
    if(readMode==='deny')return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'rAw preview denied /ExactPath gpt-5.2 ID_abC'})});
     const isShared=source.conversationId===chat.id,projectId=isShared?chat.projectId:privateProjectId;
     return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({messageId:match[1],runId:receipt.executionId,runStatus:'running',memoryExposure:{state:'disabled',runId:receipt.executionId},reply:{presentation:'text',purpose:'answer',projectId,conversationId:source.conversationId,agentId:match[2],messageId:match[1],runId:receipt.executionId,fence:1,streamId:'qa-'+match[2],steeringInjectionId:receipt.injectionKind==='steer'?receipt.injectionId:undefined,acceptedAt:source.createdAt,firstTextAt:new Date(Date.parse(source.createdAt)+1).toISOString(),sequence:readMode==='chunk2'?2:1,state:'streaming',text:readMode==='chunk2'?'UI009 exact live preview with **incremental Markdown**':'UI009 exact live preview',replyIntent:isShared?'broadcast':'direct_to_user'}})});
    }
    if((request.method()==='GET'||url.pathname.endsWith('/message-delivery-receipts'))&&url.pathname.startsWith('/api/')&&!/(?:\/stream|\/events)(?:\/|$)/.test(url.pathname)){
     const response=await route.fetch(),type=response.headers()['content-type']??'';
     if(type.includes('application/json')){const body=await response.json();mapReceipts(body);return route.fulfill({response,json:body});}
     return route.fulfill({response});
    }
    return await route.continue();
    }catch(error){
     const read=request.method()==='GET'||url.pathname.endsWith('/message-delivery-receipts');
     if(closing&&row.passed&&beganBeforeClose&&read&&error.message==='apiResponse.json: Response has been disposed'){row.fixtureReadCancellations=(row.fixtureReadCancellations??0)+1;assert(row.fixtureReadCancellations<=10,'Owned cleanup cancellations stay bounded');return;}
     throw error;
    }
   });
   const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>row.errors.push(e.message));
   try{
    await page.goto(origin+views[view],{waitUntil:'domcontentloaded'});await page.getByRole('textbox',{name:'Message',exact:true}).last().waitFor();
    const uncertain=page.locator('[data-delivery-status-badge]').filter({hasText:'Work Unconfirmed'});await uncertain.first().waitFor();await page.waitForTimeout(1100);assert.equal(reads.length,0,'Unconfirmed historical work never reads preview');assert.equal(await page.getByRole('alert').count(),0,'One canonical status owner without a duplicate warning');
    row.checks.push('Work Unconfirmed remains, with zero preview reads and no duplicate alerts');
    await page.screenshot({path:path.join(out,`${engine}-${size}-${mode}-${view}-uncertain.png`)});
    await page.getByRole('button',{name:'Try Work Again',exact:true}).first().click();await page.getByText('rAw explicit retry /ExactPath gpt-5.2 ID_abC',{exact:true}).waitFor();assert.equal(writes.length,1,'Only explicit retry action dispatches');assert(await uncertain.count());row.checks.push('Explicit action failure keeps raw diagnostics and canonical uncertainty');
    phase='active';await page.goto(origin+views[view]);await page.locator('article.chat-message-frame').filter({hasText:'UI009 exact live preview'}).first().waitFor();assert.equal(await page.getByRole('alert').count(),0);assert(!await page.getByText('request rate limit exceeded',{exact:true}).count());
    for(const agent of new Set(reads.map(r=>r.agent))){const times=reads.filter(r=>r.agent===agent);if(times.length>1)assert(times[1].at-times[0].at>=900,'Retry-After bounds physical preview reads');}
    assert.equal(writes.length,1,'Read recovery never retries work');row.checks.push('Active 429 recovers quietly through shared cooldown without work retry');
    const streamRow=page.locator('article.chat-message-frame').filter({hasText:'UI009 exact live preview'}).first();
    await streamRow.evaluate(node=>window.__stableReplyRow=node);assert(await streamRow.locator('.chat-message-body').count());assert(await streamRow.locator('[aria-label$=" Avatar"]').count(),'Normal named Agent avatar is visible');
    readMode='chunk2';await streamRow.getByText('incremental Markdown',{exact:true}).waitFor();assert(await streamRow.evaluate(node=>node===window.__stableReplyRow),'Chunks update the same normal row');
    readMode='transient';await page.waitForTimeout(650);assert(await streamRow.evaluate(node=>node===window.__stableReplyRow),'Read failure retains authorized row');
    await page.screenshot({path:path.join(out,`${engine}-${size}-${mode}-${view}-stream.png`)});row.checks.push('Named frame/avatar/bubble and Markdown retain mounted identity across chunks and transient read failure');
    readMode='deny';await page.getByText('Access Denied',{exact:true}).first().waitFor();assert.equal(await page.getByRole('alert').count(),0);assert(await page.getByText('rAw preview denied /ExactPath gpt-5.2 ID_abC',{exact:true}).count());await page.locator('details').filter({has:page.locator('summary',{hasText:'Access Denied'})}).first().locator('summary').click();
    await page.screenshot({path:path.join(out,`${engine}-${size}-${mode}-${view}-details.png`)});readMode='ok';await page.waitForTimeout(650);assert.equal(await page.locator('article.chat-message-frame').filter({hasText:'UI009 exact live preview'}).count(),0,'Permission invalidation cannot revive a snapshot');assert.equal(writes.length,1);
    if(view!=='output'){const nav=page.getByRole('button',{name:'Open Workspace Navigation',exact:true});if(await nav.count())await nav.first().click();await page.getByRole('navigation',{name:'Workspace Navigation',exact:true}).first().waitFor();if(await nav.count())await page.getByRole('button',{name:'Close Workspace Navigation',exact:true}).first().click();}
    assert(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),'Desktop/phone layout contains UI');assert.deepEqual(row.errors,[]);row.reads=reads.length;row.writes=writes.length;row.passed=true;
   }catch(error){row.error=error.stack??String(error);row.text=(await page.locator('body').innerText()).slice(0,12000);await page.screenshot({path:path.join(out,`${engine}-${size}-${mode}-${view}-failure.png`),fullPage:true});}
   finally{closing=true;await context.close();context=undefined;await save();console.log(`${row.passed?'PASS':'FAIL'} ${engine} ${size} ${mode} ${view}${row.error?' '+row.error.split('\n')[0]:''}`);}
  }
  await browser.close();browser=undefined;
 }
 assert(rows.every(row=>row.passed));success=true;
}finally{if(context)await context.close();if(browser)await browser.close();if(f)await f.dispose(success);await save();console.log(out);}
