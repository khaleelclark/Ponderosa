// Explicit offline mounted qualification, real Fastify install routes and owned Chroma.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {withMountedCell} from './additive-mounted-ownership.mjs';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {BranchStore} from '@ponderosa/agents';
import {setup,rows,preserve} from '../memory/workflow-additive-fixture.mjs';
import {vector} from '../memory/portability-fixture.mjs';
const require=createRequire(new URL('../../apps/server/package.json',import.meta.url));
const {chromium}=require('playwright-core');
const out=process.env.PONDEROSA_ADDITIVE_MOUNT_EVIDENCE,build=process.env.PONDEROSA_ADDITIVE_MOUNT_BUILD;
assert(out&&build,'Set fresh owned build and evidence directories');await mkdir(out,{recursive:true});
const results=[];
test('additive memory production dialog and real install routes on desktop and emulated phone',async t=>{
 const browser=await chromium.launch({executablePath:process.env.PONDEROSA_CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 try{for(const mobile of [false,true])await t.test(mobile?'phone':'desktop',async t=>{
  const cell=mobile?'phone':'desktop',x=await setup(t),{f}=x,requests=[],errors=[];
  let reviewError=true,reviewGate,releaseReview,lastPreview,passed,blockPublication=false,statusError=false;
  const originalDeploy=BranchStore.prototype.deploy;
  await withMountedCell({prototype:BranchStore.prototype,
   deploy:function(input,...args){if(blockPublication&&input.idempotencyKey?.startsWith('install:'))throw Error('Controlled publication unavailable');return originalDeploy.call(this,input,...args);},
   requestHandler:async(req,res)=>{try{
   const url=new URL(req.url,'http://localhost');
   if(url.pathname==='/fixture'){res.setHeader('content-type','application/json');res.end(JSON.stringify({pkg:x.pkg,branchId:x.branchId}));return;}
   if(url.pathname.startsWith('/api/')){
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const payload=Buffer.concat(chunks).toString();
    requests.push({method:req.method,url:url.pathname+url.search,...(payload?{payload:JSON.parse(payload)}:{})});
    if(url.pathname==='/api/branches/install-preview'){
     if(reviewError){reviewError=false;res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'Controlled review service unavailable'}));return;}
     if(reviewGate)await reviewGate;
    }
    if(statusError&&req.method==='GET'&&/\/installations\//.test(url.pathname)){statusError=false;res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'Controlled status unavailable'}));return;}
    const response=await f.app.inject({method:req.method,url:url.pathname+url.search,headers:{...f.headers,...(payload?{'content-type':'application/json'}:{})},...(payload?{payload}:{})});
    if(url.pathname==='/api/branches/install-preview'&&response.statusCode===200)lastPreview=response.json();
    res.writeHead(response.statusCode,{'content-type':'application/json'});res.end(response.body);return;
   }
   const file=url.pathname==='/'?'index.html':url.pathname.slice(1),target=path.resolve(build,file);assert(target.startsWith(path.resolve(build)+path.sep));res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await readFile(target));
  }catch(error){res.writeHead(500);res.end(String(error));}},
   browser,contextOptions:{viewport:mobile?{width:390,height:844}:{width:1440,height:962},isMobile:mobile,hasTouch:mobile,recordVideo:{dir:out+'/'+cell+'-video'}},
   releaseReview:()=>releaseReview?.(),
   diagnose:page=>page.screenshot({path:out+'/'+cell+'-failure.png'}),
   record:async({failed,primary,secondary})=>{
    results.push(failed||secondary.length?{cell,status:'FAIL',error:primary?.stack??String(primary),secondary:secondary.map(({stage,error})=>({stage,error:error?.stack??String(error)})),errors,requests}:passed);
    await writeFile(out+'/results.json',JSON.stringify(results,null,2)+'\n');
   },
   run:async({server,page})=>{
  page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.stack??e.message));
  const checkbox=name=>page.getByRole('checkbox',{name,exact:true}),button=name=>page.getByRole('button',{name,exact:true});
  const focusByTab=async locator=>{await locator.click({trial:true});for(let i=0;i<100;i++){if(await locator.evaluate(node=>node===document.activeElement))return;await page.keyboard.press('Tab');}assert.fail('Control is unreachable using Tab');};
  const activate=async name=>{await focusByTab(button(name));await page.keyboard.press('Enter');};
  const keyboardCheck=async locator=>{await focusByTab(locator);await page.keyboard.press('Space');assert(await locator.isChecked());};
  const choose=async()=>{
   await activate('Open update');await checkbox('Select Additive Memory Update').waitFor();await keyboardCheck(checkbox('Select Additive Memory Update'));
   const team=checkbox('Team memory: Preserved Chat');assert(await team.isDisabled());
   assert.equal(await checkbox('Private memory: Preserved Chat · Included').count(),0,'Existing Agent private memory cannot be selected');
   await keyboardCheck(checkbox('Private memory: Preserved Chat · Excluded'));assert(await team.isEnabled());await keyboardCheck(team);
   await page.getByLabel('Default Working Directory',{exact:true}).fill(f.root);
   await page.getByRole('combobox',{name:'Engine: fixture',exact:true}).click();await page.getByRole('option',{name:'fixture',exact:true}).click();
  };
  const review=async()=>{await activate('Review Changes');await button('Confirm Update').waitFor();};
  const acknowledge=async()=>{
   assert(await button('Confirm Update').isDisabled());await keyboardCheck(checkbox('I reviewed the selected incoming and existing destination memory.'));assert(await button('Confirm Update').isDisabled());
   await keyboardCheck(checkbox('I reviewed the imported Agent context and files and want to continue with this full import.'));assert(await button('Confirm Update').isEnabled());
  };
   await page.goto('http://127.0.0.1:'+server.address().port);await choose();
   await activate('Review Changes');await page.getByText('Controlled review service unavailable',{exact:true}).waitFor();assert(await checkbox('Team memory: Preserved Chat').isChecked());await x.unchanged();
   reviewGate=new Promise(resolve=>{releaseReview=resolve;});await activate('Review Changes');
   await page.waitForFunction(()=>[...document.querySelectorAll('label')].find(label=>label.textContent.includes('Select Additive Memory Update'))?.querySelector('input')?.disabled);
   assert(await checkbox('Select Additive Memory Update').isDisabled());assert(await checkbox('Private memory: Preserved Chat · Excluded').isDisabled());assert(await page.getByLabel('Default Working Directory',{exact:true}).isDisabled());assert(await button('Review Changes').isDisabled());
   // Dismiss pending review by keyboard; a late response cannot reopen the dialog or confirm.
   await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});const lateResponse=page.waitForResponse(r=>r.url().endsWith('/install-preview'));releaseReview();reviewGate=undefined;
   await lateResponse;assert.equal(await page.getByRole('dialog').count(),0);assert.equal(requests.filter(r=>r.url.endsWith('/confirm')).length,0);await x.unchanged();
   await choose();await review();
   const memory=page.getByRole('button',{name:/^Memory · Existing Agent memory/});await memory.click();
   const container=memory.locator('xpath=ancestor::*[contains(@class,"MuiAccordion-root")][1]'),snapshots=container.locator('pre');await snapshots.nth(1).waitFor();assert.equal(await snapshots.count(),2);
   assert.deepEqual(JSON.parse(await snapshots.nth(0).innerText()),lastPreview.memoryUpdateReview.destination);assert.deepEqual(JSON.parse(await snapshots.nth(1).innerText()),lastPreview.memoryUpdateReview.incoming);
   const incoming=lastPreview.memoryUpdateReview.incoming;assert.equal(incoming[0].snapshot.chunks.length,3);assert.equal(incoming[0].snapshot.conflicts.length,1);assert(!JSON.stringify(incoming).includes('Included private fact'));assert(JSON.stringify(incoming).includes('EXCLUDED_PRIVATE_FACT'));assert.equal(incoming[0].snapshot.chunks[0].embedding.length,384);assert(incoming[0].snapshot.chunks.every(r=>r.stamp.provenance&&r.stamp.origin));
   await memory.scrollIntoViewIfNeeded();await page.screenshot({path:out+'/'+cell+'-review.png'});
   await activate('Back');await checkbox('Private memory: Preserved Chat · Excluded').uncheck();assert(!(await checkbox('Team memory: Preserved Chat').isChecked()));assert(await checkbox('Team memory: Preserved Chat').isDisabled());
   await keyboardCheck(checkbox('Private memory: Preserved Chat · Excluded'));await review();assert.equal(lastPreview.memoryUpdateReview.incoming[0].snapshot.chunks.length,1,'Selection changes require new actual review without team facts');assert(!(await checkbox('I reviewed the selected incoming and existing destination memory.').isChecked()));
   await activate('Back');await keyboardCheck(checkbox('Team memory: Preserved Chat'));await review();await acknowledge();
   const raw=f.memory.core.database.raw,c=await raw.client.getCollection({name:raw.names('chat:'+x.chat.id).memory}),id=x.before[0].ids[0];
   await c.update({ids:[id],documents:['Explicit destination memory edit'],embeddings:[vector]});const edited=await rows(f,x.chat.id);
   await activate('Confirm Update');await page.getByText('Destination memory changed; review a new additive preview',{exact:true}).waitFor();await button('Review Again').waitFor();assert.deepEqual(await rows(f,x.chat.id),edited);await x.authority();
   await page.screenshot({path:out+'/'+cell+'-stale.png'});await activate('Review Again');await review();assert(!(await checkbox('I reviewed the selected incoming and existing destination memory.').isChecked()));await acknowledge();
   blockPublication=true;await activate('Confirm Update');await page.getByText('Controlled publication unavailable',{exact:true}).waitFor();await button('Stop Update').waitFor();
   statusError=true;await page.waitForResponse(r=>r.url().includes('/installations/')&&r.request().method()==='GET'&&r.status()===503);await activate('Retry Status');await button('Stop Update').waitFor();
   await activate('Stop Update');await page.getByText(/This update is canceled/).waitFor();assert.deepEqual(await rows(f,x.chat.id),edited,'Cancel compensates only staged additions');await x.authority();
   blockPublication=false;await activate('Review Again');await review();await acknowledge();await activate('Confirm Update');await page.getByText('Installed successfully',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);
   preserve(edited,await rows(f,x.chat.id));await x.authority();assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) n FROM branch_installation_resources WHERE branch_id=? AND agent_ref='new' AND state='active'").get(x.branchId).n,1);
   assert.deepEqual(errors,[]);passed={cell,status:'PASS',errors,requests,checks:['real dialog/server/Chroma','keyboard selection/acknowledgements','existing private excluded','full incoming/destination snapshots','pending keyboard dismissal ignores late response','review failure/retry','Back/selection reset/fresh review','stale refusal/no mutation','status error/retry','staged cancellation/compensation','new review/success','destination permissions/policies/grants preserved']};
   }
  });
 });}finally{await browser.close();}
});
