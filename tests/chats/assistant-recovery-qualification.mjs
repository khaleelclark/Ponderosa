// Built standalone Assistant, disposable canonical data and inert native provider only.
import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createSecureServer} from 'node:http2';
import {request as httpRequest} from 'node:http';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const {AgentStore}=await import('../../packages/agents/dist/store.js');
const {fixture,until}=await import('../shared/fixture.mjs');
const {chromium,webkit,devices}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=process.env.PONDEROSA_RECOVERY_EVIDENCE??await mkdtemp(path.join(tmpdir(),'ponderosa-assistant-recovery-'));
await mkdir(out,{recursive:true,mode:0o700});const rows=[];let browser,context,f,proxy;
// Match DEV's verified HTTP/2 transport; direct HTTP/1 fixture SSE streams can
// exhaust the browser's per-origin six connections across two tabs.
const certificate=path.join(out,'loopback.crt'),privateKey=path.join(out,'loopback.key');
assert.equal(spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',privateKey,'-out',certificate,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'}).status,0,'Owned loopback TLS certificate');
async function http2Fixture(upstream){
 const target=new URL(upstream),sessions=new Set(),requests=new Set(),protocols=new Set();let pendingRecovery,dropped=false;
 const hop=new Set(['connection','keep-alive','proxy-connection','transfer-encoding','upgrade']);
 const filter=headers=>Object.fromEntries(Object.entries(headers).filter(([name])=>!name.startsWith(':')&&!hop.has(name)));
 const server=createSecureServer({key:await readFile(privateKey),cert:await readFile(certificate),allowHTTP1:true},(incoming,outgoing)=>{
  if(incoming.method==='POST'&&new URL(incoming.url,upstream).pathname.endsWith('/context-recoveries')&&!pendingRecovery)pendingRecovery=outgoing;
  protocols.add(incoming.httpVersion);const headers=filter(incoming.headers);headers.host=target.host;
  // Only transport origin/port normalization; no API body or authority changes.
  if(headers.origin)headers.origin=upstream;
  const request=httpRequest({hostname:'127.0.0.1',port:target.port,path:incoming.url,method:incoming.method,headers,agent:false},response=>{outgoing.writeHead(response.statusCode,filter(response.headers));response.pipe(outgoing);});
  requests.add(request);request.on('close',()=>requests.delete(request));request.on('error',()=>{if(outgoing.destroyed)return;if(!outgoing.headersSent)outgoing.writeHead(502);outgoing.end();});
  incoming.on('aborted',()=>request.destroy());outgoing.on('close',()=>request.destroy());incoming.pipe(request);
 });
 server.on('session',session=>{sessions.add(session);session.on('close',()=>sessions.delete(session));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return {origin:'https://127.0.0.1:'+server.address().port,protocols,dropRecoveryResponse(){assert(pendingRecovery&&!dropped,'one original response may be dropped');dropped=true;pendingRecovery.stream.close(8);},async close(){for(const request of requests)request.destroy();for(const session of sessions)session.destroy();await new Promise(resolve=>server.close(resolve));}};
}
const save=()=>writeFile(path.join(out,'results.json'),JSON.stringify({rows,liveDataChanged:false,realDevice:false},null,2)+'\n');
try{
 for(const engine of (process.env.PONDEROSA_RECOVERY_BROWSERS??'chromium,webkit').split(',')){
  browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='webkit'?{executablePath:process.env.PONDEROSA_WEBKIT_PATH}:{executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']})});
  for(const width of (process.env.PONDEROSA_RECOVERY_SIZES??'1440,390').split(',').map(Number))for(const mode of (process.env.PONDEROSA_RECOVERY_MODES??'light,dark').split(',')){
   const row={name:`${engine}-${width}-${mode}`,passed:false,errors:[],posts:[]};rows.push(row);let store,release,entered=false;
   f=await fixture({webDist:process.env.PONDEROSA_RECOVERY_WEB_DIST??path.join(root,'apps/web/dist'),storeFactory:directory=>store=new AgentStore(directory),providerValidatesResumeBeforeTurn:true,
    providerContextRecoverySupport:{status:'managed_compaction',crashReconciliation:'hold_without_native_query'},
    providerCommandResult:async({sessionId})=>{entered=true;await new Promise(resolve=>release=resolve);return {outcome:'completed',contextUsage:{usedTokens:1000,windowTokens:200000,providerSessionGeneration:sessionId}};}});
   try{
    const descriptor=f.ok(await f.api('POST','/api/branches/assistant',{initialize:true}));assert(descriptor.app?.agentId,'actual designated Assistant');const agentId=descriptor.app.agentId;
    f.plans.set(agentId,[{output:false,run:session=>session.exitWithDetail({exitCode:9})},{}]);
    f.ok(await f.api('POST',`/api/branches/engine/agents/${agentId}/messages`,{text:'Fixture interrupted original task',idempotencyKey:'original-interrupted'}));
    const boundary=await until(()=>store.uncertainProviderContextRecoveryBoundary(agentId),'exact interrupted Assistant session');
    proxy=await http2Fixture(await f.listen());const origin=proxy.origin;assert.equal(new URL(origin).hostname,'127.0.0.1');row.recoveryReads=[];const observe=(page,label)=>page.on('response',async response=>{const url=new URL(response.url());if(response.request().method()==='GET'&&url.pathname.endsWith('/context-recoveries')){try{const value=await response.json();row.recoveryReads.push({label,status:response.status(),key:url.searchParams.get('idempotencyKey'),phase:value.request?.progress?.phase,requestState:value.request?.state,operationState:value.operationState,error:value.error});}catch{}}});
    context=await browser.newContext({...(engine==='webkit'&&width===390?{...devices['iPhone 13'],viewport:{width,height:844}}:{viewport:{width,height:width===390?844:962},isMobile:width===390,hasTouch:width===390}),serviceWorkers:'block',ignoreHTTPSErrors:true});
    await context.addInitScript(mode=>localStorage.setItem('ponderosa-color-mode',mode),mode);await context.addInitScript(()=>{window.__qaRecoveryReads=[];const get=Storage.prototype.getItem;Storage.prototype.getItem=function(key){const value=get.call(this,key);if(key.startsWith('ponderosa.context-recovery:'))window.__qaRecoveryReads.push({key,hasValue:Boolean(value),at:Date.now()});return value;};});
    row.externalRequests=[];context.on('request',request=>{
     const url=new URL(request.url());if(url.origin!==origin)row.externalRequests.push(request.url());
     if(request.method()==='POST'&&url.pathname.endsWith('/context-recoveries'))row.posts.push(request.postDataJSON());
    });
    row.networkFailures=[];context.on('requestfailed',request=>row.networkFailures.push({at:Date.now(),url:request.url(),method:request.method(),failure:request.failure()}));
    row.browserErrors=[];const errorObserver=(label,error)=>{row.errors.push(error.message);row.browserErrors.push({label,at:Date.now(),name:error.name,message:error.message,stack:error.stack});};
    const page=await context.newPage();observe(page,'first');page.setDefaultTimeout(20000);page.on('pageerror',error=>errorObserver('first',error));
    await page.goto(origin+'/assistant',{waitUntil:'domcontentloaded'});await page.getByRole('textbox',{name:'Message',exact:true}).fill('Fixture saved later instruction');await page.getByRole('button',{name:'Send Message',exact:true}).click();
    const held=await until(()=>store.sqlite.prepare(`SELECT * FROM agent_activations WHERE agent_id=? AND kind='human_message' AND state IN ('pending','retry_pending')`).get(agentId),'saved independent input');
    const original=store.sqlite.prepare('SELECT * FROM scheduler_runs WHERE id=?').get(boundary.sourceRunId);
    await until(()=>entered,'server-owned native maintenance');
    const quiet=async target=>{
     for(const name of ['Recover Assistant','Context Recovery','Try Delivery Again','Finish Cleanup'])assert.equal(await target.getByRole('button',{name,exact:true}).count(),0,name+' is absent from ordinary Chat');
     for(const text of ['Message Saved','Assistant Needs Recovery','Context Handoff Held'])assert.equal(await target.getByText(text,{exact:true}).count(),0,text+' is absent');
    };
    await quiet(page);await page.locator('[data-conversation-contact]').getByText('Connecting',{exact:true}).waitFor();
    await page.screenshot({animations:'disabled',path:path.join(out,row.name+'-connecting.png')});
    await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();await quiet(page);
    const second=await context.newPage();observe(second,'second');second.setDefaultTimeout(20000);second.on('pageerror',error=>errorObserver('second',error));await second.goto(origin+'/assistant',{waitUntil:'domcontentloaded'});await second.getByRole('textbox',{name:'Message',exact:true}).waitFor();await quiet(second);
    assert.equal(f.commands.filter(c=>c.agentId===agentId).length,1);assert.deepEqual(row.posts,[],'No browser recovery mutation');assert.deepEqual(row.recoveryReads,[],'No browser recovery polling');
    release();
    await until(()=>store.sqlite.prepare("SELECT 1 FROM scheduler_run_activations a JOIN scheduler_runs r ON r.id=a.run_id WHERE a.activation_id=? AND r.status='completed'").get(held.id),'same saved input completes once');
    await page.locator('[data-conversation-contact]').getByText('Connecting',{exact:true}).waitFor({state:'hidden'});await quiet(page);
    assert.deepEqual(store.sqlite.prepare('SELECT * FROM scheduler_runs WHERE id=?').get(boundary.sourceRunId),original);
    assert.equal(store.sqlite.prepare('SELECT count(*) n FROM scheduler_run_activations WHERE activation_id=?').get(held.id).n,1);
    assert.equal(store.sqlite.prepare('SELECT payload_json FROM agent_activations WHERE id=?').get(held.id).payload_json,held.payload_json);
    assert.equal(f.commands.filter(c=>c.agentId===agentId).length,1);assert.deepEqual(row.posts,[]);assert.deepEqual(row.externalRequests,[],'owned loopback only');
    assert.deepEqual(row.errors,[],'Uncaught browser errors invalidate qualification');
    assert((await page.locator('body').evaluate(()=>document.documentElement.scrollWidth))<=width+1);
    await page.screenshot({animations:'disabled',path:path.join(out,row.name+'-recovered.png')});row.protocols=[...proxy.protocols];assert(row.protocols.includes('2.0'),'Actual browser qualification used HTTP/2');row.passed=true;console.log('PASS '+row.name);
   }catch(error){row.error=error.stack??String(error);row.fixtureRoot=f?.root;row.dom=[];for(const [index,page]of(context?.pages()??[]).entries()){row.dom.push((await page.locator('body').innerText()).slice(-4000));await page.screenshot({animations:'disabled',path:path.join(out,row.name+'-FAIL-'+index+'.png')}).catch(()=>{});}throw error;}
   finally{release?.();await context?.close();context=undefined;await proxy?.close();proxy=undefined;await save();await f?.dispose(false);f=undefined;}
  }
  await browser.close();browser=undefined;
 }
}finally{await context?.close();await proxy?.close();await browser?.close();await f?.dispose(false);await save();console.log(out);}
