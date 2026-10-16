import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Synthetic transport only. Every API request is intercepted, every external
// request is blocked, and speech APIs only record an accidental invocation.
const {chromium}=await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const root=path.resolve(process.env.PINECONE_DIST??fileURLToPath(new URL('../../apps/web/dist/pinecone/',import.meta.url)))+path.sep;
const evidence=process.env.PINECONE_TEST_EVIDENCE;
if(evidence)await mkdir(evidence,{recursive:true});
const branchId='0356095a-8d73-4249-b39d-883b978ae119',agentId='speaker',projectId='project',conversationId='chat';
const agent={id:agentId,title:'Pinecone',projectId,conversationId,archived:false,model:'fixture',effort:'high'};
const msg=(i,text=`Saved message ${i}`,extra={})=>({id:`m${i}`,role:'assistant',text,authorAgentId:agentId,projectId,conversationId,communicationIntent:'user_dm',createdAt:new Date(Date.UTC(2026,9,1)+i*60000).toISOString(),...extra});
const result={fixtureAssets:[],syntheticOnly:true,escapedApi:0,realProviderCalls:0,physicalKeyboardTested:false,physicalAudioTested:false,scenarios:{}};
const server=createServer(async(req,res)=>{
  const p=new URL(req.url,'http://localhost').pathname;
  if(p.startsWith('/api/')){result.escapedApi++;res.writeHead(500);res.end('API escaped interception');return;}
  try{const file=path.resolve(root,'.'+(p==='/'||p==='/branches'?'/index.html':p));if(!file.startsWith(root))throw 0;
    const body=await readFile(file);if(!result.fixtureAssets.some(a=>a.path===file.slice(root.length)))result.fixtureAssets.push({path:file.slice(root.length),bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')});res.writeHead(200,{'Content-Type':{'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.woff2':'font/woff2'}[path.extname(file)]??'application/octet-stream'});res.end(body);
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
      const body=req.postDataJSON();state.submissions.push(body);const mode=state.mode;if(state.gate)await state.gate;
      if(state.delay)await new Promise(r=>setTimeout(r,state.delay));
      if(mode==='403')return json({error:'Only the activated candidate spokesperson; policy delivery identity Failed to fetch'},403);
      if(!state.accepted.has(body.idempotencyKey)){
        const n=state.all.length,sent=msg(n,body.text,{id:'sent'+n,role:'user',deliveryReceipts:[{targetAgentId:agentId,state:'processed'}]});
        state.all.push(sent,msg(n+1,'Reply: '+body.text));state.accepted.set(body.idempotencyKey,{messageId:sent.id,queued:false});
      }
      if(mode==='network')return route.abort('failed');
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
}const saved=page=>page.getByRole('status',{name:'Saved outgoing message',exact:true});
const rejected=page=>page.getByRole('status',{name:'Not sent message',exact:true});
const sendButton=page=>page.getByRole('button',{name:'Send message to Pinecone',exact:true});
const settle=async page=>{await page.waitForTimeout(100);};
const hold=state=>{let release;state.gate=new Promise(resolve=>{release=resolve});return ()=>{state.gate=undefined;release()};};
const submit=async(page,editor,text)=>{await editor.fill(text);await sendButton(page).click();};
const ack=async(page,text)=>{await page.getByText('Reply: '+text,{exact:true}).waitFor({state:'attached'});};
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.PONDEROSA_CHROMIUM_PATH??'/usr/bin/google-chrome'});
  await scenario('N1-rejected-A-next-B-discard',{},async({state,page,editor,open,out})=>{
    await open();state.mode='403';const release=hold(state);
    await submit(page,editor,'Message A');await saved(page).waitFor();await editor.fill('Message B');release();
    // Reproduces the original source defect before the repair.
    await page.waitForFunction(()=>!document.body.innerText.includes('Sending…'));
    assert.equal(await rejected(page).count(),1,'definitively rejected Message A remains in a visible Not sent row');
    assert((await rejected(page).innerText()).includes('Message A'));assert(await rejected(page).isVisible());
    assert.equal(await editor.inputValue(),'Message B');assert(await page.getByRole('button',{name:'Edit',exact:true}).isDisabled());
    assert.equal(await page.getByRole('button',{name:'Retry same message',exact:true}).count(),0);
    if(evidence)await page.screenshot({path:path.join(evidence,'rejected-A-preserved-next-B.png')});
    await editor.press('Enter');await settle(page);assert.equal(state.submissions.length,1,'no replay or implicit send');
    await page.getByRole('button',{name:'Discard',exact:true}).click();assert.equal(await editor.inputValue(),'Message B');
    state.mode='ok';await sendButton(page).click();await ack(page,'Message B');
    assert.equal(state.submissions.length,2);assert.notEqual(state.submissions[0].idempotencyKey,state.submissions[1].idempotencyKey);
    out.rejectedVisible=true;out.nextDraftPreserved=true;out.explicitDistinctKeySend=true;
  });
  await scenario('N1-edit-with-next-draft-cleared',{},async({state,page,editor,open,out})=>{
    await open();state.mode='403';const release=hold(state);await submit(page,editor,'Recover A');await saved(page).waitFor();await editor.fill('Keep B');release();
    await rejected(page).waitFor();await editor.fill(' ');assert(await page.getByRole('button',{name:'Edit',exact:true}).isDisabled());assert.equal(await editor.inputValue(),' ');await editor.fill('');await page.getByRole('button',{name:'Edit',exact:true}).click();
    assert.equal(await editor.inputValue(),'Recover A');assert.equal(await rejected(page).count(),0);assert.equal(state.submissions.length,1);
    state.mode='ok';await editor.fill('Edited A');await sendButton(page).click();await ack(page,'Edited A');assert.notEqual(state.submissions[0].idempotencyKey,state.submissions[1].idempotencyKey);
    out.explicitEditOnly=true;out.noAutomaticSend=true;
  });
  await scenario('N1-empty-draft-definitive-reload',{},async({state,page,editor,open,out})=>{
    await open();state.mode='403';await submit(page,editor,'Empty next draft A');await rejected(page).waitFor();assert.equal(await editor.inputValue(),'');
    assert(await page.getByRole('button',{name:'Edit',exact:true}).isEnabled());await page.reload();await editor.waitFor();await rejected(page).waitFor();
    assert((await rejected(page).innerText()).includes('Empty next draft A'));assert.equal(await page.getByRole('button',{name:'Retry same message',exact:true}).count(),0);
    await page.getByRole('button',{name:'Edit',exact:true}).click();assert.equal(await editor.inputValue(),'Empty next draft A');assert.equal(state.submissions.length,1);
    out.rejectedSurvivesReload=true;out.emptyDraftRecoveredExplicitly=true;
  });
  await scenario('N1-unknown-exact-key-and-next-draft',{},async({state,page,editor,open,out})=>{
    await open();state.mode='network';await submit(page,editor,'Unknown A');await page.getByRole('button',{name:'Retry same message',exact:true}).waitFor();await editor.fill('Unknown next B');assert((await saved(page).innerText()).includes('Retry or remove the message above'));
    assert.equal(await rejected(page).count(),0);assert.equal(await page.getByRole('button',{name:'Edit',exact:true}).count(),0);
    await editor.press('Enter');await settle(page);assert.equal(state.submissions.length,1);
    await page.getByRole('button',{name:'Retry same message',exact:true}).click();await page.getByRole('button',{name:'Retry same message',exact:true}).waitFor();
    assert.equal(state.submissions.length,2);assert.deepEqual(state.submissions[0],state.submissions[1]);assert.equal(await editor.inputValue(),'Unknown next B');
    await page.getByRole('button',{name:'Remove from this device',exact:true}).click();assert.equal(await editor.inputValue(),'Unknown next B');
    state.mode='ok';await sendButton(page).click();await ack(page,'Unknown next B');assert.notEqual(state.submissions[0].idempotencyKey,state.submissions[2].idempotencyKey);out.sameKeyExactPayload=true;
  });
  await scenario('N1-late-ack-next-draft-and-other-tab',{},async({state,context,page,editor,open,out})=>{
    await open();const release=hold(state);await submit(page,editor,'Late ack A');await saved(page).waitFor();await editor.fill('Same tab B');
    const other=await context.newPage();await other.goto(origin);const otherEditor=other.getByRole('textbox',{name:'Message Pinecone',exact:true});await otherEditor.waitFor();await otherEditor.fill('Other tab C');
    assert.equal(await saved(other).count(),0);release();await ack(page,'Late ack A');assert.equal(await editor.inputValue(),'Same tab B');assert.equal(await otherEditor.inputValue(),'Other tab C');
    assert.equal(await saved(page).count(),0);assert.equal(await rejected(other).count(),0);assert.equal(state.submissions.length,1);await other.close();out.ackPreservesBothDrafts=true;
  });
  for(const outcome of ['403','ok'])await scenario('N1-late-'+outcome+'-after-scope-reload',{},async({state,page,editor,open,out})=>{
    await open();state.mode=outcome;const release=hold(state);await submit(page,editor,'Old scope A');await saved(page).waitFor();await editor.fill('Old scope B');
    await page.reload();await editor.waitFor();release();await settle(page);
    assert.equal(await editor.inputValue(),'Old scope B');assert.equal(await rejected(page).count(),0);assert.equal(await saved(page).count(),1,'old unresolved scope stays uncertain, never auto-replayed');assert.equal(state.submissions.length,1);out.previousDocumentCannotOverwriteNewScope=true;
  });
}finally{
  await browser?.close();await new Promise(resolve=>server.close(resolve));result.browserClosed=true;result.serverClosed=true;
  if(evidence)await writeFile(path.join(evidence,'fixture-results.json'),JSON.stringify(result,null,2)+'\n');
}
assert.equal(result.escapedApi,0);console.log(JSON.stringify(result,null,2));
