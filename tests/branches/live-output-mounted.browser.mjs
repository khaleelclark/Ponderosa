// Explicit offline browser qualification; not part of the ordinary Node test lane.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const require=createRequire(new URL('../../apps/server/package.json',import.meta.url));
const {chromium}=require('playwright-core');
const out=process.env.PONDEROSA_LIVE_MOUNT_EVIDENCE,build=process.env.PONDEROSA_LIVE_MOUNT_BUILD;
assert(out&&build,'Set owned build and evidence paths');await mkdir(out,{recursive:true});
let browser,server;const streams=new Set(),requests=[],results=[];let seq=0,blockReconnect=false;const heldStreams=new Set();
const entry=(run,text,id)=>({id,agentId:'worker',executionId:run,kind:'response',text,completed:false,seq:1,createdAt:new Date().toISOString()});
let output=[],canonicalFailure=false;
const canonicalText="Bounded canonical preview\n"+"Full content ".repeat(3000);
const previewText=canonicalText.slice(0,32768);
const preview=(total=Buffer.byteLength(canonicalText))=>({...entry('current-run',previewText,'snapshot'),textPreview:{truncated:true,previewUtf8Bytes:Buffer.byteLength(previewText),totalUtf8Bytes:total,retrievalUrl:'/api/agents/worker/run-output/1/text'}});
const detail=()=>({agent:{id:'worker',projectId:'project'},runOutput:output,activity:[],runs:[],workItems:[],artifacts:[],changedFiles:[]});
const openStream=res=>{res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});res.write(': connected\n\n');streams.add(res);res.on('close',()=>streams.delete(res));};
const send=(run,text)=>{const envelope={seq:++seq,ts:new Date().toISOString(),event:{type:'text',executionId:run,delta:text}};for(const res of streams)res.write('data: '+JSON.stringify(envelope)+'\n\n');return envelope;};
try{
 server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://localhost');requests.push(url.pathname+url.search);
  if(url.pathname==='/api/agents/worker/stream'){
   if(blockReconnect){heldStreams.add(res);res.on('close',()=>heldStreams.delete(res));return;}
   openStream(res);return;
  }
  if(url.pathname==='/api/agents/worker/run-output/1/text'){res.setHeader('content-type','application/json');if(canonicalFailure){res.writeHead(503);res.end(JSON.stringify({error:'Controlled canonical retrieval failure'}));}else res.end(JSON.stringify({agentId:'worker',runOutputId:'snapshot',seq:1,text:canonicalText,totalUtf8Bytes:Buffer.byteLength(canonicalText)}));return;}
  if(url.pathname.startsWith('/api/')){res.setHeader('content-type','application/json');res.end(JSON.stringify(url.pathname==='/api/agents/worker'?detail():{}));return;}
  const file=url.pathname==='/'?'index.html':url.pathname.slice(1);const target=path.resolve(build,file);assert(target.startsWith(path.resolve(build)+path.sep));res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await readFile(target));
 }catch(e){res.writeHead(500);res.end(String(e));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:process.env.PONDEROSA_CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 for(const mobile of [false,true]){
  seq=0;canonicalFailure=false;output=[entry('old-run','FOREIGN OLD RUN','old')];const cell=mobile?'phone':'desktop';
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:962},isMobile:mobile,hasTouch:mobile,recordVideo:{dir:out+'/'+cell+'-video'}});
  const page=await context.newPage();page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',e=>errors.push(e.stack??e.message));
  const text=()=>page.locator('body').innerText();const wait=async predicate=>{await page.waitForFunction(predicate);};
  try{
   await page.goto(origin);await page.getByText('Waiting for output…',{exact:true}).waitFor();
   await page.waitForFunction(()=>!document.body.innerText.includes('Connecting…'));
   assert.equal(streams.size,1,'One actual stream per Agent');
   send('old-run','FOREIGN LIVE RUN');send('current-run','First incremental');
   await page.getByText('First incremental',{exact:true}).waitFor();assert(!/FOREIGN/.test(await text()));
   await page.getByText('First incremental',{exact:true}).evaluate(node=>window.liveTextNode=node);
   send('current-run',' second chunk');await page.getByText('First incremental second chunk',{exact:true}).waitFor();assert(await page.getByText('First incremental second chunk',{exact:true}).evaluate(node=>node===window.liveTextNode),'Deltas preserve DOM identity');
   await page.getByRole('button',{name:'Cache history page'}).click();assert(!(await text()).includes('STALE HISTORY PAGE'));
   await page.screenshot({path:out+'/'+cell+'-incremental.png'});
   const streamRequests=requests.filter(p=>p.includes('/stream')).length;blockReconnect=true;for(const res of streams)res.end();
   await page.getByText('Live updates unavailable; reconnecting…',{exact:true}).waitFor();assert((await text()).includes('First incremental second chunk'),'Cached text survives disconnect');
   blockReconnect=false;for(const res of heldStreams){heldStreams.delete(res);openStream(res);}
   await wait(()=>!document.body.innerText.includes('Live updates unavailable; reconnecting…'));
   assert(requests.filter(p=>p.includes('/stream')).length>streamRequests,'Real EventSource reconnect');assert.equal(streams.size,1);
   send('current-run',' after reconnect');await page.getByText('First incremental second chunk after reconnect',{exact:true}).waitFor();
   output=[entry('current-run','Canonical refreshed output','snapshot')];
   for(const res of streams)res.write('event: agent_status\ndata: '+JSON.stringify({instanceId:'fixture',cursor:seq,snapshot:true})+'\n\n');
   await page.getByText('Canonical refreshed output',{exact:true}).waitFor();assert(!(await text()).includes('First incremental'),'Snapshot replaces projected output');
   const snapshot=()=>{for(const res of streams)res.write('event: agent_status\ndata: '+JSON.stringify({instanceId:'fixture',cursor:seq,snapshot:true})+'\n\n');};
   const retrievalCount=()=>requests.filter(p=>p==='/api/agents/worker/run-output/1/text').length;
   const beforeRetrieval=retrievalCount();output=[preview()];snapshot();
   await page.getByText(previewText,{exact:true}).waitFor();
   await page.getByRole('button',{name:/Load full text/}).waitFor();assert.equal(retrievalCount(),beforeRetrieval,'Preview does not automatically fetch canonical text');
   assert(await page.getByRole('button',{name:/Load full text/}).evaluate((button,text)=>Boolean(button.compareDocumentPosition([...document.querySelectorAll('*')].find(node=>node.textContent===text)) & Node.DOCUMENT_POSITION_FOLLOWING),previewText),'Full-text control precedes the long preview');
   await page.getByRole('button',{name:/Load full text/}).click();
   await page.getByText(canonicalText,{exact:true}).waitFor();assert.equal(retrievalCount(),beforeRetrieval+1);
   // Same stable segment gains a new canonical byte count after snapshot replacement.
   canonicalFailure=true;output=[preview(Buffer.byteLength(canonicalText)+1)];snapshot();
   await page.getByText('The complete canonical segment could not be loaded.',{exact:true}).waitFor();
   assert(await page.getByRole('alert').evaluate((alert,text)=>Boolean(alert.compareDocumentPosition([...document.querySelectorAll('*')].find(node=>node.textContent===text)) & Node.DOCUMENT_POSITION_FOLLOWING),previewText),'Retrieval error precedes the long preview');
   await page.getByRole('alert').scrollIntoViewIfNeeded();const errorBox=await page.getByRole('alert').boundingBox();assert(errorBox && errorBox.y >= 0 && errorBox.y + errorBox.height <= (mobile?844:962),'Retrieval error is reachable within the viewport');
   await page.getByText(previewText,{exact:true}).waitFor();assert.equal(retrievalCount(),beforeRetrieval+2);
   await page.screenshot({path:out+'/'+cell+'-canonical-error.png'});
   canonicalFailure=false;output=[entry('current-run','Complete replacement snapshot','snapshot')];snapshot();
   await page.getByText('Complete replacement snapshot',{exact:true}).waitFor();
   assert(!(await text()).includes('Bounded canonical preview'));assert(!(await text()).includes('could not be loaded'));assert.equal(await page.getByRole('button',{name:/Load full text|Show Preview/}).count(),0);
   output=[entry('replacement-run','New exact Run','new'),entry('current-run','OLD CANONICAL RUN','old')];
   await page.getByRole('button',{name:'Replace Run'}).click();assert(!(await text()).includes('First incremental'));
   send('current-run','OLD LATE CHUNK');send('replacement-run','New live Run');await page.getByText('New live Run',{exact:true}).waitFor();assert(!/OLD|FOREIGN|STALE/.test(await text()));
   await page.screenshot({path:out+'/'+cell+'-reconnected.png'});assert.deepEqual(errors,[]);
   await page.getByRole('button',{name:'Unmount',exact:true}).click();await page.waitForTimeout(100);assert.equal(streams.size,0,'Unmount closes EventSource');
   results.push({cell,status:'PASS',checks:['mounted production hooks','incremental SSE/stable DOM','canonical snapshot replacement','truncated preview explicit retrieval/no autoload','canonical full text success/error','same segment replacement clears preview/error','exact Run','stale history exclusion','disconnect retains text','EventSource reconnect','Run replacement','unmount cleanup'],errors});
  }finally{await context.close();}
 }
}finally{
 for(const res of [...streams,...heldStreams])res.end();if(browser)await browser.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
 await writeFile(out+'/results.json',JSON.stringify({results,requests,remainingStreams:streams.size},null,2)+'\n');
}
assert.equal(results.length,2);console.log(JSON.stringify(results));
