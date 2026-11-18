// The production Assistant route with owned, intercepted read/control fixtures.
// Canonical server mutation contracts are covered by pause-resume.test.mjs.
import assert from 'node:assert/strict';
import path from 'node:path';
export async function qualifyAssistantHandoff({f,browser,engine,size,mode,out,origin,assistant,source,projectId,devices,row}){
 const agent=assistant.agentId,receipt=source.deliveryReceipts.find(r=>r.targetAgentId===agent),original=await f.detail(agent,'/api/branches/engine'),originalRun=original.runs.find(r=>r.id===receipt.executionId);
 assert(originalRun,'Exact source Run');let phase='stream',sequence=1,text='First **bold** chunk',paused=false,restricted=false,controlRun=originalRun.id,pauseId='qa-pause',pendingRelease,failNext=false,stalePauseHealth=true;const writes=[],reads=[],errors=[];
 const stamp=source.createdAt,binding={streamId:'qa-'+agent,sourceId:source.communicationEventId,runId:originalRun.id,fence:1},finalId='qa-final-'+agent;
 const activity=[{id:'qa-call',agentId:agent,executionId:originalRun.id,seq:10001,createdAt:stamp,event:{type:'tool_call',id:'qa-transport',name:'ponderosa_reply_stream',input:{}}},{id:'qa-result',agentId:agent,executionId:originalRun.id,seq:10002,createdAt:stamp,event:{type:'tool_result',id:'qa-transport',output:JSON.stringify({authorized:true})}},{id:'qa-work',agentId:agent,executionId:originalRun.id,seq:10003,createdAt:stamp,event:{type:'test_result',passed:true,summary:'Useful Verified Work'}}];
 const context=await browser.newContext({...(size===390&&engine==='webkit'?devices['iPhone 13']:{viewport:{width:size,height:size===390?844:962},isMobile:size===390,hasTouch:size===390}),serviceWorkers:'block',recordVideo:{dir:path.join(out,'videos'),size:{width:size,height:size===390?844:962}}});
 await context.addInitScript(mode=>localStorage.setItem('ponderosa-color-mode',mode),mode);
 const decorate=value=>{
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach(decorate);return;}
  if(value.agent?.id===agent&&Array.isArray(value.messages)){
   const history=Array.from({length:12},(_,i)=>({id:'qa-history-'+i,agentId:agent,authorAgentId:agent,role:'assistant',seq:i+1,communicationIntent:'user_dm',conversationId:source.conversationId,createdAt:new Date(Date.parse(stamp)-100000+i*1000).toISOString(),text:'Earlier Message '+i+'\n\n'+('History remains readable. '.repeat(14))}));
   value.messages=[...history,source,...(phase==='stream'?[]:[{id:finalId,communicationEventId:finalId,agentId:agent,authorAgentId:agent,conversationId:source.conversationId,role:'assistant',seq:10004,communicationIntent:'user_dm',executionId:originalRun.id,createdAt:new Date(Date.parse(stamp)+3000).toISOString(),text,replyStream:binding}])];
   value.history={...value.history,hasMore:false,cursor:undefined};value.telemetryHistory=Object.fromEntries(Object.entries(value.telemetryHistory??{}).map(([key,page])=>[key,{...page,hasMore:false,cursor:undefined}]));
   value.runs=[{...originalRun,status:phase==='complete'?'completed':'running',...(phase==='complete'?{completedAt:new Date(Date.parse(stamp)+9000).toISOString()}:{})}];value.activity=activity;value.runOutput=[{id:'qa-answer',executionId:originalRun.id,agentId:agent,seq:10005,createdAt:stamp,kind:'response',text,sourceSeqStart:10005,sourceSeqEnd:10005,completed:phase==='complete'}];
   if(paused)value.coordinationV3={...value.coordinationV3,pause:{id:pauseId,runId:controlRun,state:'paused',pausedAt:stamp,...(restricted?{reason:'access_restricted'}:{})}};
   else if(value.coordinationV3)delete value.coordinationV3.pause;
  }
  if(value.agentId===agent&&'statusTimestamp' in value){
   if(phase==='complete'||paused&&!stalePauseHealth){delete value.runtimeActivity;delete value.executionId;delete value.schedulerRunId;value.status=paused?'paused':'idle';}
   else {value.status='running';value.executionId=controlRun;value.runtimeActivity={state:'responding',executionId:controlRun,startedAt:stamp};}
  }
  Object.values(value).forEach(decorate);
 };
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());assert.equal(url.origin,origin);
  if(request.method()==='POST'&&new RegExp('/agents/'+agent+'/(pause|resume|cancel)$').test(url.pathname)){
   const action=url.pathname.split('/').at(-1),body=request.postDataJSON();writes.push({action,body});
   if(action==='resume')assert.equal(body.pauseId,pauseId);else assert.equal(body.targetRunId,controlRun);
   await new Promise(resolve=>{pendingRelease=resolve;});
   if(failNext){failNext=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Controlled Run Command Failure'})});}
   if(action==='pause')paused=true;
   if(action==='resume'){paused=false;controlRun=originalRun.id+'-resumed';}
   if(action==='cancel'){paused=false;phase='complete';}
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({accepted:true,...(action==='pause'?{pauseId}:{})})});
  }
  if(url.pathname.endsWith('/reply-streams/'+source.communicationEventId+'/'+agent)){
   reads.push(sequence);return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({messageId:source.communicationEventId,runId:originalRun.id,runStatus:phase==='complete'?'completed':'running',memoryExposure:{state:'disabled',runId:originalRun.id},reply:{presentation:'text',purpose:'answer',projectId,conversationId:source.conversationId,agentId:agent,messageId:source.communicationEventId,runId:originalRun.id,fence:1,streamId:binding.streamId,steeringInjectionId:receipt.injectionKind==='steer'?receipt.injectionId:undefined,sequence,state:phase==='stream'?'streaming':'completed',text,acceptedAt:stamp,firstTextAt:new Date(Date.parse(stamp)+1).toISOString(),publication:{kind:'message',intent:'direct_to_user'},...(phase==='stream'?{}:{canonicalReplyEventId:finalId})}})});
  }
  if(request.method()==='GET'&&url.pathname.startsWith('/api/')&&!/(?:\/stream|\/events)(?:\/|$)/.test(url.pathname)){
   const response=await route.fetch();if(response.headers()['content-type']?.includes('application/json')){const body=await response.json();decorate(body);return route.fulfill({response,json:body});}return route.fulfill({response});
  }
  return route.continue();
 });
 const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
 // Real Agent telemetry exercises the existing bounded detail refresh path.
 let wake=0;
 const refresh=async()=>{const session=f.sessions.get(agent);assert(session);const id='qa-refresh-'+(++wake);session.events.push({type:'tool_call',id,name:'ponderosa_reply_stream',input:{}});session.events.push({type:'tool_result',id,output:JSON.stringify({authorized:true})});};
 const button=name=>page.getByRole('button',{name,exact:true});
 const draft='Preserve My Steering Draft. '.repeat(25).trim();
 const release=()=>{assert(pendingRelease,'Observed pending command');const done=pendingRelease;pendingRelease=undefined;done();};
 const command=async(name,expected)=>{const count=writes.length;await button(name).click();for(let i=0;i<100&&!pendingRelease;i++)await page.waitForTimeout(20);assert.equal(writes.length,count+1);assert.equal(writes.at(-1).action,expected);release();};
 try{
  await page.goto(origin+'/assistant',{waitUntil:'domcontentloaded'});const editor=page.getByRole('textbox',{name:'Message',exact:true});await editor.waitFor();
  const reply=page.locator('article.chat-message-frame').filter({hasText:'First bold chunk'});await reply.waitFor();await reply.evaluate(node=>{window.__ui028={node,body:node.querySelector('.chat-message-body'),avatar:node.querySelector('[aria-label$=" Avatar"]'),disconnected:false};window.__ui028.observer=new MutationObserver(records=>{if(!node.isConnected||records.some(record=>[...record.removedNodes].some(removed=>removed===node||removed.contains?.(node))))window.__ui028.disconnected=true;});window.__ui028.observer.observe(document.body,{childList:true,subtree:true});});
  const work=reply.locator('article[aria-label$=" Work Details"]');await work.waitFor();assert.equal(await work.locator('[aria-expanded="false"]').count(),1);assert(await reply.locator('[aria-label$=" Avatar"]').count());
  await work.getByRole('button').click();assert(!await work.getByText('ponderosa_reply_stream',{exact:true}).count());assert(!await work.getByText('First bold chunk',{exact:true}).count());await work.getByRole('button').click();
  await page.evaluate(()=>document.fonts.ready);
  const region=page.locator('.chat-scroll-region');await region.evaluate(node=>{node.scrollTop=node.scrollHeight;node.dispatchEvent(new Event('scroll'));});
  text+='\n\nSecond paragraph with `code`.';sequence++;await reply.getByText('Second paragraph with',{exact:false}).waitFor();await page.waitForFunction(()=>{const n=document.querySelector('.chat-scroll-region');return n.scrollHeight-n.scrollTop-n.clientHeight<3;});
  await region.evaluate(node=>{node.scrollTop=200;node.dispatchEvent(new Event('scroll'));const top=node.getBoundingClientRect().top;const anchor=[...node.querySelectorAll('.chat-message-body')].find(n=>n.getBoundingClientRect().bottom>top);window.__ui028.anchor=anchor;window.__ui028.offset=anchor.getBoundingClientRect().top-top;});
  row.geometryBefore=await page.evaluate(()=>{const r=document.querySelector('.chat-scroll-region'),s=window.__ui028;return {scrollTop:r.scrollTop,height:r.clientHeight,offset:s.anchor.getBoundingClientRect().top-r.getBoundingClientRect().top};});
  await page.screenshot({path:path.join(out,`${engine}-${size}-${mode}-stream.png`)});phase='published';await refresh();await page.locator('#message-'+finalId).waitFor();phase='complete';await refresh();await button('Pause').waitFor({state:'hidden'});
  assert(await page.evaluate(()=>{const s=window.__ui028;return s.node.isConnected&&!s.disconnected&&s.node.querySelector('.chat-message-body')===s.body&&s.node.querySelector('[aria-label$=" Avatar"]')===s.avatar;}),'One connected frame/body/avatar through canonical publication and completion');
  row.geometryAfter=await page.evaluate(()=>{const r=document.querySelector('.chat-scroll-region'),s=window.__ui028;return {scrollTop:r.scrollTop,height:r.clientHeight,offset:s.anchor.getBoundingClientRect().top-r.getBoundingClientRect().top};});
  assert.equal(await page.locator('#message-'+finalId).count(),1);assert.equal(await work.locator('[aria-expanded="false"]').count(),1);assert(await page.evaluate(()=>{const s=window.__ui028;return Math.abs(s.anchor.getBoundingClientRect().top-document.querySelector('.chat-scroll-region').getBoundingClientRect().top-s.offset)<2;}),'History reading anchor does not bounce at publication/completion');
  row.checks.push('Recorded first text, Markdown chunks, exact publication while active and completion; single connected frame/body/avatar, collapsed work below, no transport or duplicate answer, history anchor retained');
  phase='published';await refresh();await button('Pause').waitFor();await editor.fill(draft);await page.keyboard.press('Tab');assert(await page.evaluate(()=>document.activeElement?.matches('button')&&Boolean(document.activeElement?.closest('[data-assistant-composer]'))),'Keyboard focus reaches the trailing composer controls');await editor.focus();await page.keyboard.press('Control+Enter');assert.equal(await editor.innerText(),draft);assert.equal(await button('Queue Message').count(),0);assert(await editor.evaluate(node=>{const range=document.createRange();range.selectNodeContents(node);const box=node.getBoundingClientRect(),rects=[...range.getClientRects()].filter(rect=>rect.width>0&&rect.height>0);return box.width>0&&box.height>0&&rects.length>0&&rects.every(rect=>rect.left>=box.left-1&&rect.right<=box.right+1);}), 'Typed draft characters remain horizontally visible at narrow width');
  await command('Pause','pause');await button('Resume').waitFor();await page.screenshot({path:path.join(out,`${engine}-${size}-${mode}-paused-composer.png`)});assert(await button('Stop').count());failNext=true;await command('Resume','resume');await page.getByRole('alert').filter({hasText:'Run Control Needs Review'}).first().waitFor();const failedResume=writes.at(-1);await page.getByRole('alert').filter({hasText:'Run Control Needs Review'}).getByRole('button',{name:'Close',exact:true}).click();stalePauseHealth=false;await refresh();await page.waitForTimeout(1200);await command('Resume','resume');assert.equal(writes.at(-1).body.idempotencyKey,failedResume.body.idempotencyKey,'Same pause retry survives independently refreshed health');await button('Pause').waitFor();
  failNext=true;await command('Stop','cancel');await page.getByRole('alert').filter({hasText:'Stop Needs Review'}).first().waitFor();assert.equal(await editor.innerText(),draft);const failed=writes.at(-1);await page.getByRole('alert').filter({hasText:'Stop Needs Review'}).getByRole('button',{name:'Close',exact:true}).click();await command('Stop','cancel');assert.equal(writes.at(-1).body.idempotencyKey,failed.body.idempotencyKey);await button('Stop').waitFor({state:'hidden'});
  phase='published';controlRun=originalRun.id+'-paused-stop';pauseId='qa-pause-two';paused=true;restricted=true;await refresh();await button('Resume').waitFor();assert(await button('Resume').isDisabled());await command('Stop','cancel');await button('Stop').waitFor({state:'hidden'});assert.equal(await editor.innerText(),draft);
  assert(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth));assert.deepEqual(errors,[]);row.checks.push('Recorded composer Pause/Resume, running and access-restricted paused Stop, exact target once, failed Stop retry identity, retained editable draft and no Queue');row.reads=reads.length;row.writes=writes;row.qualified=true;
 }catch(error){row.error=error.stack??String(error);row.text=(await page.locator('body').innerText()).slice(-12000);await page.screenshot({path:path.join(out,`${engine}-${size}-${mode}-handoff-failure.png`),fullPage:true});}
 finally{
  const cleanup=[];
  try{await page.evaluate(()=>window.__ui028?.observer?.disconnect());}catch(error){cleanup.push(String(error));}
  if(pendingRelease)release();
  try{await context.unrouteAll({behavior:'wait'});}catch(error){cleanup.push(String(error));}
  try{await context.close();}catch(error){cleanup.push(String(error));}
  try{row.video=await page.video()?.path();}catch(error){cleanup.push(String(error));}
  row.errors=errors;row.cleanupErrors=cleanup;row.passed=Boolean(row.qualified&&!row.error&&!errors.length&&!cleanup.length);
 }
}
