// Normal-build, disposable-data first-use and explicit chunk retry; no timing/provider work.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const root=fileURLToPath(new URL('../../',import.meta.url)),out=process.env.QUALIFICATION_DIRECTORY;assert(out);await mkdir(out,{recursive:true});
const dir=path.join(root,'apps/web/dist/static/js/async');
const chunks=await Promise.all((await readdir(dir)).filter(x=>x.endsWith('.js')).map(async name=>({name,text:await readFile(path.join(dir,name),'utf8')})));
const chunkWith=marker=>{const rows=chunks.filter(x=>x.text.includes(marker));assert.equal(rows.length,1,marker);return '/static/js/async/'+rows[0].name;};
const agentsChunk=chunkWith('AgentsTab:()=>'),settingsChunk=chunkWith('BranchGlobalSettings:()=>');
const result={kind:'inactive Chat Agents and Branch global settings code boundaries',agentsChunk,settingsChunk,cells:[],cleanup:[]};
const save=()=>writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2)+'\n');
const fixture=spawn(process.execPath,['--import','./tests/shared/workspace-resolution.mjs','tests/branches/ui-qualification.mjs'],{cwd:root,stdio:['ignore','pipe','inherit']});
const fixtureExit=once(fixture,'exit');let browser,context;
try{
 let setup;for await(const line of createInterface({input:fixture.stdout}))if(line.startsWith('{"origin":')){setup=JSON.parse(line);break;}
 assert(setup);const state=await(await fetch(setup.origin+'/api/__qualification/state')).json();assert(Array.isArray(state.providerTurnIds));assert.equal(typeof state.normalAgent.title,'string');
 const post=async(url,body)=>{const r=await fetch(setup.origin+url,{method:'POST',headers:{'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify(body)});const value=await r.json();assert(r.ok,JSON.stringify(value));return value;};
 const branch=await post('/api/branches',{name:'Deferred settings fixture',idempotencyKey:randomUUID()}),chat=await post('/api/branches/'+branch.id+'/chats',{label:'Deferred settings Chat',defaultEngine:'codex'});
 const branchUrl=setup.origin+'/branches?branch='+branch.id+'&tab=chats&chat='+chat.id;
 const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');browser=await chromium.launch({executablePath:'/opt/google/chrome/chrome',headless:true,chromiumSandbox:true});
 for(const mobile of [false,true])for(const product of ['core','branches'])for(const retry of [false,true]){
  if(process.env.QUALIFICATION_ONLY==='phone-branches'&&(!mobile||product!=='branches'))continue;
  const row={device:mobile?'phone':'desktop',product,retry,status:'started',moduleRequests:0,pageErrors:[],external:[]};result.cells.push(row);let allow=!retry;const target=product==='core'?agentsChunk:settingsChunk;
  context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1365,height:768},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>row.pageErrors.push(e.message));
  await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==setup.origin){row.external.push(u.origin);return route.abort();}if(u.pathname===target){row.moduleRequests++;if(!allow)return route.abort('failed');}return route.continue();});
  const draft=`Retained ${row.device} ${product} retry=${retry} draft λ😀`;
  try{
   await page.goto(product==='core'?setup.normalUrl:branchUrl);await page.getByLabel('Message',{exact:true}).waitFor();
   assert.equal(row.moduleRequests,0,'Cold Chat does not request inactive panel code');await page.getByLabel('Message',{exact:true}).fill(draft);
   if(product==='core')await page.getByRole('tab',{name:'Agents',exact:true}).click();
   else{if(mobile)await page.getByRole('button',{name:'Open Workspace Navigation',exact:true}).first().click();await page.locator('[aria-label$=". Open Settings"]:visible').first().click();}
   if(retry){await page.getByText('This View Could Not Be Loaded.',{exact:true}).waitFor();assert.equal(row.moduleRequests,1,'No automatic chunk retry');await page.screenshot({path:path.join(out,`${row.device}-${product}-retry.png`)});allow=true;await page.getByRole('button',{name:'Try Again',exact:true}).click();}
   if(product==='core'){
    await page.locator('#chat-workspace-agents-panel').getByText(state.normalAgent.title,{exact:true}).first().waitFor();
    assert.equal(await page.getByRole('tab',{name:'Agents',exact:true}).getAttribute('aria-selected'),'true');await page.getByRole('tab',{name:'Chat',exact:true}).click();
   }else{await page.getByText('Appearance',{exact:true}).waitFor();await page.getByRole('button',{name:'Back To Branches',exact:true}).click();}
   await page.getByLabel('Message',{exact:true}).waitFor();assert.equal(await page.getByLabel('Message',{exact:true}).innerText(),draft,'Same Chat draft retained across first-use/retry');
   assert.equal(row.moduleRequests,retry?2:1,'Exactly the first-use request and optional explicit retry');
   const after=await(await fetch(setup.origin+'/api/__qualification/state')).json();assert.deepEqual(after.providerTurnIds,state.providerTurnIds,'Opening/retrying panels never executes provider work');
   assert.deepEqual(row.external,[]);assert.deepEqual(row.pageErrors,[]);
   row.draftRetained=true;row.providerTurnsUnchanged=true;row.status='pass';console.log('PASS',row.device,product,'retry='+retry);
  }catch(e){row.status='failed';row.error=e.stack;throw e;}
  finally{await context.close();context=undefined;await save();}
 }
}finally{
 let failure;for(const [name,close]of [['context',()=>context?.close()],['browser',()=>browser?.close()],['fixture',async()=>{fixture.kill('SIGTERM');const [code,signal]=await fixtureExit;assert(code===0||signal==='SIGTERM',JSON.stringify({code,signal}));}]]){try{await close();result.cleanup.push({name,complete:true});}catch(e){result.cleanup.push({name,complete:false,error:String(e)});failure??=e;}}
 await save();if(failure)throw failure;
}
