import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Synthetic transport only. Every API request is intercepted, every external
// request is blocked, and speech APIs only record an accidental invocation.
const {chromium}=await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const root=fileURLToPath(new URL('../../apps/web/dist/pinecone/',import.meta.url));
const evidence=process.env.PINECONE_TEST_EVIDENCE;
if(evidence)await mkdir(evidence,{recursive:true});
const branchId='0356095a-8d73-4249-b39d-883b978ae119',agentId='speaker',projectId='project',conversationId='chat';
const agent={id:agentId,title:'Pinecone',projectId,conversationId,archived:false,model:'fixture',effort:'high'};
const msg=(i,text=`Saved message ${i}`,extra={})=>({id:`m${i}`,role:'assistant',text,authorAgentId:agentId,projectId,conversationId,communicationIntent:'user_dm',createdAt:new Date(Date.UTC(2026,9,1)+i*60000).toISOString(),...extra});
const result={syntheticOnly:true,escapedApi:0,realProviderCalls:0,physicalKeyboardTested:false,physicalAudioTested:false,scenarios:{}};
const server=createServer(async(req,res)=>{
  const p=new URL(req.url,'http://localhost').pathname;
  if(p.startsWith('/api/')){result.escapedApi++;res.writeHead(500);res.end('API escaped interception');return;}
  try{const file=path.resolve(root,'.'+(p==='/'||p==='/branches'?'/index.html':p));if(!file.startsWith(root))throw 0;
    const body=await readFile(file);res.writeHead(200,{'Content-Type':{'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.woff2':'font/woff2'}[path.extname(file)]??'application/octet-stream'});res.end(body);
  }catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port,origin=`http://127.0.0.1:${port}`,section='section[aria-label="Conversation with Pinecone"]';
let browser;
const stubs=()=>{
  window.__speech=[];const rec=n=>()=>{window.__speech.push(n);return n==='getVoices'?[]:undefined};
  Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{getVoices:rec('getVoices'),speak:rec('speak'),cancel:rec('cancel'),addEventListener(){},removeEventListener(){}}});
  class R{constructor(){window.__speech.push('SpeechRecognition')}start(){window.__speech.push('start')}abort(){}stop(){}}
  window.SpeechRecognition=R;window.webkitSpeechRecognition=R;
  if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=async()=>{window.__speech.push('getUserMedia');throw Error('fixture blocks microphone')};
};
async function scenario(name,options,fn){
  if(process.env.PINECONE_SCENARIOS&&!new RegExp(process.env.PINECONE_SCENARIOS).test(name))return;
  const state={all:Array.from({length:100},(_,i)=>msg(i)),mode:'ok',delay:0,fail:false,hold:0,cursors:[],submissions:[],accepted:new Map(),errors:[],unexpected:[]};
  const context=await browser.newContext({viewport:{width:390,height:844},...options});
  await context.addInitScript(stubs);
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url()),p=url.pathname,method=req.method();
    const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(!p.startsWith('/api/'))return url.port===String(port)&&['127.0.0.1','pinecone.test'].includes(url.hostname)&&['GET','HEAD'].includes(method)?route.continue():route.abort();
    // No API request is ever forwarded, including writes. Only this inert
    // fixture message endpoint simulates an acknowledgement.
    if(!['GET','HEAD'].includes(method)&&!(method==='POST'&&p===`/api/branches/engine/agents/${agentId}/messages`)){state.unexpected.push(method+' '+p);return json({error:'write blocked'},403);}
    if(p.endsWith('/stream'))return state.fail?json({error:'offline'},503):route.fulfill({contentType:'text/event-stream',body:p.includes('/workspace/')?'event: workspace_status\ndata: '+JSON.stringify({instanceId:'fixture',cursor:0,snapshot:true,caughtUp:true})+'\n\n':': fixture\n\n'});
    if(p===`/api/branches/${branchId}`)return state.fail?json({error:'offline'},503):json({id:branchId,enabled:true,bindingRevisionId:'binding',versionId:'version',triggerId:'timer',activeExecutions:0});
    if(p===`/api/branches/${branchId}/configuration`)return json({agents:{spokesperson:agentId},directories:{workspace:'/synthetic'}});
    if(p===`/api/branches/${branchId}/trigger`)return json({id:'timer',branchId,enabled:true});
    if(p===`/api/branches/${branchId}/executions`)return json([{id:'old-unknown',admissionSource:'automatic',state:'waiting',createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z'}]);
    if(p===`/api/branches/contexts/${conversationId}`)return json({branchId});
    if(p===`/api/branches/engine/agents/${agentId}`){
      const limit=Number(url.searchParams.get('limit')??100);if(limit===1)return json({agent});
      if(state.fail)return json({error:'offline'},503);
      if(state.hold)await new Promise(r=>setTimeout(r,state.hold));
      const cursor=url.searchParams.get('cursor');if(cursor)state.cursors.push(cursor);
      const end=cursor?Number(cursor.slice(2)):state.all.length,start=Math.max(0,end-limit);
      // Match server-read-models.ts: newest limit messages, cursor pages older.
      return json({agent,messages:state.all.slice(start,end),runs:[],decisionEvents:[],history:{limit,hasMore:start>0,...(start>0?{cursor:'c:'+start}:{})}});
    }
    if(method==='POST'){
      const body=req.postDataJSON();state.submissions.push(body);
      if(state.delay)await new Promise(r=>setTimeout(r,state.delay));
      if(state.mode==='403')return json({error:'Only the activated candidate spokesperson; policy delivery identity Failed to fetch'},403);
      if(!state.accepted.has(body.idempotencyKey)){
        const n=state.all.length,sent=msg(n,body.text,{id:'sent'+n,role:'user',deliveryReceipts:[{targetAgentId:agentId,state:'processed'}]});
        state.all.push(sent,msg(n+1,'Reply: '+body.text));state.accepted.set(body.idempotencyKey,{messageId:sent.id,queued:false});
      }
      if(state.mode==='network')return route.abort('failed');
      return json(state.accepted.get(body.idempotencyKey),202);
    }
    if(p===`/api/branches/engine/conversations/${conversationId}`)return json({conversation:{id:conversationId,projectId,branchId},agents:[agent],messages:[],history:{hasMore:false}});
    if(p==='/api/branches/engine/workspace/preferences'||p==='/api/branches/engine/streams/probe')return json({});
    // Advanced view qualification is limited to navigation and return affordance.
    if(p==='/api/branches/engine/branches'||p==='/api/branches/engine/engines')return json([]);
    if(p==='/api/branches/engine/notifications')return json({items:[],notifications:[],hasMore:false});
    if(p===`/api/branches/${branchId}/versions/version`)return json({definition:{schema:'ponderosa.branch.v1',name:'Fixture',steps:[],controls:[],edges:[]},bindings:{agents:{},directories:{}}});
    state.unexpected.push(method+' '+p);return json({error:'unexpected'},404);
  });
  const page=await context.newPage();page.on('pageerror',e=>state.errors.push(e.message));
  const editor=page.getByRole('textbox',{name:'Message Pinecone',exact:true});
  const open=async()=>{await page.goto(origin);await editor.waitFor();await page.locator(`article[data-message-id="${state.all.at(-1).id}"]`).waitFor({state:'attached'});};
  const distance=()=>page.$eval(section,e=>Math.round(e.scrollHeight-e.scrollTop-e.clientHeight));
  const out={};
  try{await fn({state,context,page,editor,open,distance,out});out.speechCalls=await page.evaluate(()=>window.__speech);assert.deepEqual(out.speechCalls,[]);assert.deepEqual(state.errors,[]);assert.deepEqual(state.unexpected,[]);out.passed=true;}
  catch(error){out.passed=false;out.error=error.stack;throw error;}
  finally{out.submissions=state.submissions;out.cursors=state.cursors;out.errors=state.errors;out.unexpected=state.unexpected;result.scenarios[name]=out;if(evidence)await page.screenshot({path:path.join(evidence,name+'.png')}).catch(()=>{});await context.close();}
}
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.PONDEROSA_CHROMIUM_PATH??'/usr/bin/google-chrome',args:['--host-resolver-rules=MAP pinecone.test 127.0.0.1']});
  await scenario('H1-rolling-history',{},async({state,page,open,out})=>{
    await open();assert.equal(await page.locator('article[data-message-id]').count(),60);
    await page.$eval(section,e=>{e.scrollTop=0});const old=await page.$eval(section,e=>({height:e.scrollHeight,top:e.scrollTop}));
    await page.getByRole('button',{name:'Earlier messages',exact:true}).click();await page.locator('article[data-message-id="m0"]').waitFor({state:'attached'});
    assert.equal(await page.locator('article[data-message-id]').count(),100);
    assert(await page.$eval(section,(e,old)=>Math.abs(e.scrollTop-(e.scrollHeight-old.height+old.top))<4,old),'history anchor');
    state.all.push(...Array.from({length:5},(_,k)=>msg(100+k)));
    await page.locator('article[data-message-id="m104"]').waitFor({state:'attached',timeout:12000});
    const present=await page.locator('article[data-message-id]').evaluateAll(els=>els.map(e=>e.dataset.messageId));
    assert.equal(present.length,105);assert.equal(new Set(present).size,105);assert.deepEqual(Array.from({length:105},(_,i)=>'m'+i).filter(id=>!present.includes(id)),[]);
    out.retained=present;out.anchorPreserved=true;
  });
  await scenario('M1-M2-focus-IME-desktop',{},async({state,page,editor,open,out})=>{
    await open();await editor.fill('First immutable turn');state.delay=1500;await editor.press('Enter');
    await page.getByText('Sending… You can write your next message.',{exact:true}).waitFor();assert(await editor.isEnabled());assert(await editor.evaluate(e=>e===document.activeElement));
    await editor.fill('New draft while waiting');await page.getByText('Reply: First immutable turn',{exact:true}).waitFor({state:'attached'});
    assert.equal(await editor.inputValue(),'New draft while waiting');assert(await editor.evaluate(e=>e===document.activeElement));state.delay=0;
    const before=state.submissions.length;
    for(const flags of [{isComposing:true},{keyCode:229}])await editor.evaluate((e,flags)=>{const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,isComposing:flags.isComposing??false});if(flags.keyCode)Object.defineProperty(event,'keyCode',{value:flags.keyCode});e.dispatchEvent(event)},flags);
    await page.waitForTimeout(100);assert.equal(state.submissions.length,before);
    await editor.press('Enter');await page.getByText('Reply: New draft while waiting',{exact:true}).waitFor({state:'attached'});
    assert.notEqual(state.submissions[0].idempotencyKey,state.submissions[1].idempotencyKey);out.focusRetained=true;out.ime229Sends=0;
  });
  await scenario('M2-touch-return',{hasTouch:true,isMobile:true},async({state,page,editor,open,out})=>{
    await open();await editor.fill('Touch first');await editor.press('Enter');assert.equal(await editor.inputValue(),'Touch first\n');assert.equal(state.submissions.length,0);
    state.delay=1200;await page.getByRole('button',{name:'Send message to Pinecone'}).click();await page.getByText('Sending… You can write your next message.',{exact:true}).waitFor();assert(await editor.evaluate(e=>e===document.activeElement));
    await editor.fill('Touch next');await page.getByText('Reply: Touch first',{exact:true}).waitFor({state:'attached'});assert.equal(await editor.inputValue(),'Touch next');out.returnSends=0;
  });
  await scenario('M3-follow-and-pill',{},async({state,page,open,distance,out})=>{
    await open();await page.$eval(section,e=>{e.scrollTop=e.scrollHeight});await page.waitForTimeout(100);
    await page.locator('article[data-message-id="m99"]').click();state.all.push(msg(100,'Long follow arrival. '.repeat(30)));
    await page.locator('article[data-message-id="m100"]').waitFor({state:'attached',timeout:12000});await page.waitForTimeout(100);assert((await distance())<4,'tap at bottom retains follow');
    await page.$eval(section,e=>{e.scrollTop=0});await page.waitForTimeout(100);state.all.push(msg(101,'Arrival while reading'));
    await page.getByRole('button',{name:'↓ New message',exact:true}).waitFor({timeout:12000});assert(await page.$eval(section,e=>e.scrollTop<2));
    await page.getByRole('button',{name:'↓ New message',exact:true}).click();assert((await distance())<4);out.tapFollow=true;out.readerPreserved=true;
  });
  await scenario('M4-M5-L3-unknown-tab-retry',{},async({state,context,page,editor,open,out})=>{
    await open();const other=await context.newPage();await other.goto(origin);const otherEditor=other.getByRole('textbox',{name:'Message Pinecone',exact:true});await otherEditor.waitFor();await otherEditor.fill('Other tab draft');
    state.mode='network';await editor.fill('Unknown immutable text');await editor.press('Enter');await page.getByRole('button',{name:'Retry same message',exact:true}).waitFor();
    await editor.fill('New unrelated draft');assert(await editor.isEnabled());assert(!/delivery identity|Failed to fetch|spokesperson|policy/.test(await page.innerText('form')));
    await otherEditor.fill('Other tab revised');assert.equal(await other.getByRole('button',{name:'Retry same message',exact:true}).count(),0);
    await page.reload();await page.getByRole('button',{name:'Retry same message',exact:true}).waitFor();assert.equal(await editor.inputValue(),'New unrelated draft');assert.equal(state.submissions.length,1,'reload never auto-replays');
    state.mode='ok';await page.getByRole('button',{name:'Retry same message',exact:true}).click();await page.getByText('Reply: Unknown immutable text',{exact:true}).waitFor({state:'attached'});await page.getByRole('status',{name:'Saved outgoing message',exact:true}).waitFor({state:'hidden'});
    assert.deepEqual(state.submissions[0],state.submissions[1]);assert.equal(await editor.inputValue(),'New unrelated draft');assert.equal(await otherEditor.inputValue(),'Other tab revised');
    state.mode='network';await editor.press('Enter');await page.getByRole('button',{name:'Remove from this device',exact:true}).waitFor();await editor.fill('After local removal');
    await page.getByRole('button',{name:'Remove from this device',exact:true}).click();const count=state.submissions.length;assert.equal(count,3);state.mode='ok';await editor.press('Enter');await page.getByText('Reply: After local removal',{exact:true}).waitFor({state:'attached'});assert.notEqual(state.submissions[2].idempotencyKey,state.submissions[3].idempotencyKey);
    out.immutableRetry=true;out.otherTabUnaffected=true;await other.close();
  });
  await scenario('M4-definitive-error',{},async({state,page,editor,open})=>{
    await open();state.mode='403';await editor.fill('Rejected text');await editor.press('Enter');await page.getByText('Pinecone couldn’t accept that message. Review your draft and try again.',{exact:true}).waitFor();
    assert.equal(await editor.inputValue(),'Rejected text');assert(!/activated candidate|policy|delivery identity|Failed to fetch/.test(await page.innerText('form')));state.mode='ok';await editor.press('Enter');await page.getByText('Reply: Rejected text',{exact:true}).waitFor({state:'attached'});assert.notEqual(state.submissions[0].idempotencyKey,state.submissions[1].idempotencyKey);
  });
  await scenario('M6-outage',{viewport:{width:320,height:740}},async({state,page,editor,open,out})=>{
    await open();state.fail=true;const row=page.getByRole('status',{name:'Connection status',exact:true});await row.waitFor({timeout:12000});await page.waitForTimeout(9000);
    assert.equal(await page.getByRole('status',{name:'Connection status',exact:true}).count(),1);assert.equal(await page.getByRole('alert').count(),0);assert(await editor.isVisible());
    out.layout=await row.evaluate(e=>{const r=e.getBoundingClientRect(),h=document.querySelector('header').getBoundingClientRect();return {height:r.height,y:r.y,headerBottom:h.bottom}});assert(out.layout.height<=80);assert(out.layout.y>=out.layout.headerBottom-1);
    if(evidence)await page.screenshot({path:path.join(evidence,'outage-active-320.png')});state.fail=false;await row.getByRole('button',{name:'Retry',exact:true}).click();await page.getByText('Saved message 99',{exact:true}).waitFor({state:'attached'});
  });
  await scenario('M7-terminal-failed-retry',{},async({state,page,editor,open,out})=>{
    const receipt=(id,state,extra={})=>msg(id,'Failed source '+id,{role:'user',deliveryReceipts:[{targetAgentId:agentId,state,canRetry:true,...extra}]});
    state.all.push(receipt(100,'failed'),receipt(101,'run_unconfirmed'),receipt(102,'failed',{retryMayDuplicate:true}));await open();
    assert.equal(await page.getByRole('button',{name:'Try again',exact:true}).count(),1);await page.getByRole('button',{name:'Try again',exact:true}).click();await page.waitForFunction(()=>document.querySelector('textarea[aria-label="Message Pinecone"]').value==='Failed source 100');assert.equal(state.submissions.length,0);await editor.press('Enter');await page.getByText('Reply: Failed source 100',{exact:true}).waitFor({state:'attached'});out.onlyTerminalSafeRetry=true;
    await page.getByRole('button',{name:'Conversation options'}).click();assert.equal(await page.getByRole('menuitem',{name:'Advanced options ›',exact:true}).count(),1);assert.equal(await page.getByRole('menuitem',{name:'Check for updates now',exact:true}).count(),1);
    await page.getByRole('menuitem',{name:'Advanced options ›',exact:true}).click();await page.getByRole('menuitem',{name:'Open files in advanced view',exact:true}).click();await page.getByRole('link',{name:'Back to Pinecone',exact:true}).waitFor();await page.getByRole('link',{name:'Back to Pinecone',exact:true}).click();await editor.waitFor();out.advancedReturn=true;
  });
  await scenario('L1-light-theme',{},async({page,open,out})=>{
    await open();await page.getByRole('button',{name:'Conversation options'}).click();await page.getByRole('menuitem',{name:'Use light mode',exact:true}).click();out.body=await page.evaluate(()=>({bg:getComputedStyle(document.body).backgroundColor,inline:document.body.style.cssText,color:getComputedStyle(document.querySelector('header')).color}));assert(!/background|color/.test(out.body.inline));assert.notEqual(out.body.bg,'rgb(16, 19, 16)');
  });
  await scenario('L2-filtered-history',{},async({state,page,editor,out})=>{
    state.all=Array.from({length:420},(_,i)=>msg(i,`Saved message ${i}`,i<360?{communicationIntent:'collaboration'}:{}));await page.goto(origin);await editor.waitFor();await page.getByText('Saved message 419',{exact:true}).waitFor({state:'attached'});
    await page.getByRole('button',{name:'Earlier messages',exact:true}).click();await page.getByText('No conversation messages in these earlier pages. More history is available.',{exact:true}).waitFor();assert.equal(state.cursors.length,5);assert.equal(await page.locator('article').count(),60);
    await page.getByRole('button',{name:'Earlier messages',exact:true}).click();await page.getByText('You’ve reached the start of this conversation.',{exact:true}).waitFor();assert.equal(state.cursors.length,6);assert.equal(await page.getByRole('button',{name:'Earlier messages',exact:true}).count(),0);out.boundedPages=5;
  });
  await scenario('loading-empty-error',{},async({state,page,editor})=>{
    state.hold=1000;state.all=[];await page.goto(origin);await page.getByText('Loading your messages…',{exact:true}).waitFor();await page.getByText('What’s on your mind?',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Earlier messages',exact:true}).count(),0);
    state.hold=0;state.fail=true;await page.reload();await page.getByRole('status',{name:'Connection status',exact:true}).waitFor();state.fail=false;await page.getByRole('status',{name:'Connection status',exact:true}).getByRole('button',{name:'Retry',exact:true}).click();await editor.waitFor();await page.getByText('What’s on your mind?',{exact:true}).waitFor();
  });
  await scenario('M8-insecure-call',{},async({state,page,editor,out})=>{
    await page.goto(`http://pinecone.test:${port}`);await editor.waitFor();assert.equal(await page.evaluate(()=>isSecureContext),false);await page.getByRole('button',{name:'Call Pinecone — calling unavailable',exact:true}).click();await page.getByText('Calling unavailable · typing is available',{exact:true}).waitFor();assert(await page.getByRole('button',{name:'Start call',exact:true}).isDisabled());assert(await page.getByRole('button',{name:'Mute microphone',exact:true}).isDisabled());assert.equal(await page.getByText('Ready to call',{exact:true}).count(),0);if(evidence)await page.screenshot({path:path.join(evidence,'unavailable-call-dialog.png'),animations:'disabled'});await page.getByRole('button',{name:'End call',exact:true}).click();assert.equal(state.submissions.length,0);out.openEndSends=0;
  });
  for(const [width,height,touch=false] of [[320,740],[390,844],[430,932],[390,360],[844,390],[1440,900],[390,844,true]])await scenario(`viewport-${width}x${height}${touch?'-touch':''}`,{viewport:{width,height},hasTouch:touch,isMobile:touch},async({page,open,out})=>{
    await open();out.layout=await page.evaluate(()=>{const r=document.querySelector('form').getBoundingClientRect(),c=document.querySelector('section').getBoundingClientRect();return {composerBottom:r.bottom,conversationHeight:c.height,overflow:document.documentElement.scrollWidth>innerWidth}});assert(!out.layout.overflow);assert(out.layout.composerBottom<=height+1);assert(out.layout.conversationHeight>height*.5);
  });
  assert.equal(result.escapedApi,0);result.passed=true;
}finally{
  await browser?.close();await new Promise(r=>server.close(r));result.browserClosed=true;result.serverClosed=true;
  if(evidence)await writeFile(path.join(evidence,'standalone-browser.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}
