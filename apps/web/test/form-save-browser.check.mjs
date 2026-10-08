import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium}=createRequire(new URL('../../server/package.json',import.meta.url))('playwright-core');
const browser=await chromium.launch({headless:true,executablePath:process.env.PONDEROSA_CHROMIUM_PATH});
const base=process.env.BRANCHES_TEST_URL??'http://127.0.0.1:21859',errors=[];
async function pageAt(path){const page=await browser.newPage({viewport:{width:1280,height:844}});page.on('pageerror',e=>errors.push(e.message));await page.goto(base+path);return page;}
async function delaySettings(page){await page.evaluate(()=>{
 const previous=window.fetch;window.savePackets=[];window.savedConfiguration=null;window.releaseSave=null;window.failSave=false;window.settingsRevision=1;
 window.fetch=async(url,init)=>{
  if(String(url).includes('/branches/b/settings')){
   if(init?.method==='PUT'){
    const packet=JSON.parse(init.body);window.savePackets.push(packet);await new Promise(resolve=>window.releaseSave=resolve);
    if(window.failSave)return new Response(JSON.stringify({error:'Save rejected'}),{status:503,headers:{'content-type':'application/json'}});
    window.savedConfiguration=packet.configuration;window.settingsRevision++;return new Response(JSON.stringify({configuration:packet.configuration,revision:window.settingsRevision}),{headers:{'content-type':'application/json'}});
   }
   if(window.savedConfiguration)return new Response(JSON.stringify({configuration:window.savedConfiguration,revision:window.settingsRevision}),{headers:{'content-type':'application/json'}});
  }return previous(url,init);
 };
});}
async function guarded(page,action){let count=0;const handler=dialog=>{count++;void dialog.dismiss()};page.on('dialog',handler);await action();page.off('dialog',handler);assert.equal(count,1,'dirty navigation requires confirmation');}
try {
 const page=await pageAt('/branches?branch=b&tab=parameters&formSaves=1');
 const input=page.getByLabel('message',{exact:true});await input.waitFor();await delaySettings(page);
 await input.fill('submitted first');await page.getByRole('button',{name:'Save parameters',exact:true}).click();await page.waitForFunction(()=>Boolean(window.releaseSave));
 for(const control of [input,page.getByLabel('count',{exact:true}),page.getByRole('checkbox',{name:'flag',exact:true})])assert.equal(await control.isDisabled(),true,'all parameter fields lock pending save');
 await page.evaluate(()=>{window.failSave=true;window.releaseSave()});await page.getByText('Save rejected',{exact:true}).waitFor();assert.equal(await input.isEnabled(),true);assert.equal(await input.inputValue(),'submitted first');
 await guarded(page,()=>page.getByRole('tab',{name:'Workflow',exact:true}).click());assert.match(page.url(),/tab=parameters/);
 await input.fill('retry local edit');await page.evaluate(()=>{window.failSave=false;window.releaseSave=null});await page.getByRole('button',{name:'Save parameters',exact:true}).click();await page.waitForFunction(()=>Boolean(window.releaseSave));await page.evaluate(()=>window.releaseSave());await page.getByText('Parameters saved. New executions use these values.',{exact:true}).waitFor();
 assert.equal(await input.inputValue(),'retry local edit');assert.deepEqual(await page.evaluate(()=>window.savePackets.map(p=>p.revision)),[1,1]);
 await input.fill('later edit after acknowledgment');await guarded(page,()=>page.getByRole('tab',{name:'Workflow',exact:true}).click());assert.equal(await input.inputValue(),'later edit after acknowledgment');
 await page.evaluate(()=>window.releaseSave=null);await page.getByRole('button',{name:'Save parameters',exact:true}).click();await page.waitForFunction(()=>Boolean(window.releaseSave));await page.evaluate(()=>window.releaseSave());await page.getByRole('tab',{name:'Workflow',exact:true}).click();assert.equal(new URL(page.url()).searchParams.get('tab'),null);assert.deepEqual(await page.evaluate(()=>window.savePackets.map(p=>p.revision)),[1,1,2]);await page.close();
 const limits=await pageAt('/branches?branch=b&tab=settings');await limits.getByRole('tab',{name:'Execution',exact:true}).click();await delaySettings(limits);
 await limits.getByLabel('Nested Branch depth',{exact:true}).fill('12');await limits.getByRole('button',{name:'Save execution settings',exact:true}).click();await limits.waitForFunction(()=>Boolean(window.releaseSave));
 for(const label of ['Nested Branch depth','Loop iterations','Graph traversals'])assert.equal(await limits.getByLabel(label,{exact:true}).isDisabled(),true);
 await limits.evaluate(()=>window.releaseSave());await limits.getByText('Execution settings saved.',{exact:true}).waitFor();assert.equal(await limits.getByLabel('Nested Branch depth',{exact:true}).inputValue(),'12');await limits.close();
 for(const scope of ['branch','chat','agent']){
  const p=await pageAt(scope==='branch'?'/branches?branch=b&tab=settings':'/branches?branch=b&tab=chats&chat=c&formSaves=1');
  await p.getByRole('tab',{name:scope==='branch'?'Capabilities':'Chats',exact:true}).waitFor();
  await p.evaluate(scope=>{
   const previous=window.fetch;window.releaseCapability=null;window.failCapability=false;window.capabilityPackets=[];window.restrictions=[];window.policyRevision=1;
   const body=()=>({policy:{scopeKind:scope,scopeId:scope==='branch'?'b':scope==='chat'?'c':'a',revision:window.policyRevision,restrictedCapabilityIds:window.restrictions},effective:{restrictionSources:{}},catalog:[{id:'browser',label:'Browser access',description:'Test browser capability',categoryLabel:'Browser',available:true}]});
   window.fetch=async(url,init)=>{
    if(String(url).endsWith('/capabilities')){
     if(init?.method==='PUT'){
      const packet=JSON.parse(init.body);window.capabilityPackets.push(packet);await new Promise(resolve=>window.releaseCapability=resolve);
      if(window.failCapability)return new Response(JSON.stringify({error:'Policy rejected'}),{status:503,headers:{'content-type':'application/json'}});
      window.restrictions=packet.restrictedCapabilityIds;window.policyRevision++;
     }return new Response(JSON.stringify(body()),{headers:{'content-type':'application/json'}});
    }return previous(url,init);
   };
  },scope);
  if(scope==='branch')await p.getByRole('tab',{name:'Capabilities',exact:true}).click();else{
   await p.getByRole('button',{name:'Chat actions',exact:true}).click();
   await p.getByRole('menuitem',{name:scope==='chat'?'Chat capabilities':'Agents',exact:true}).click();
   if(scope==='agent')await p.getByRole('button',{name:'Capabilities',exact:true}).click();
  }
  const toggle=p.getByRole('checkbox',{name:'Allow',exact:true});await toggle.waitFor();await toggle.uncheck();await p.getByRole('button',{name:'Save capabilities',exact:true}).click();await p.waitForFunction(()=>Boolean(window.releaseCapability));
  assert.equal(await toggle.isDisabled(),true);assert.equal(await p.getByRole('button',{name:'Discard',exact:true}).isDisabled(),true);
  await p.evaluate(()=>{window.failCapability=true;window.releaseCapability()});await p.getByText('Policy rejected',{exact:true}).waitFor();assert.equal(await toggle.isEnabled(),true);assert.equal(await toggle.isChecked(),false);
  await guarded(p,()=>scope==='branch'?p.getByRole('tab',{name:'Workflow',exact:true}).click():p.getByRole('button',{name:'Done',exact:true}).last().click());
  await toggle.check();await toggle.uncheck();await p.evaluate(()=>{window.failCapability=false;window.releaseCapability=null});await p.getByRole('button',{name:'Save capabilities',exact:true}).click();await p.waitForFunction(()=>Boolean(window.releaseCapability));await p.evaluate(()=>window.releaseCapability());await p.getByText('Capability restrictions saved. New Runs use the updated tool contract.',{exact:true}).waitFor();assert.equal(await toggle.isEnabled(),true);assert.equal(await toggle.isChecked(),false);assert.deepEqual(await p.evaluate(()=>window.capabilityPackets.map(p=>p.revision)),[1,1]);
  await toggle.check();await guarded(p,()=>scope==='branch'?p.getByRole('tab',{name:'Workflow',exact:true}).click():p.getByRole('button',{name:'Done',exact:true}).last().click());assert.equal(await toggle.isChecked(),true);
  await p.evaluate(()=>window.releaseCapability=null);await p.getByRole('button',{name:'Save capabilities',exact:true}).click();await p.waitForFunction(()=>Boolean(window.releaseCapability));await p.evaluate(()=>window.releaseCapability());await p.getByText('Capability restrictions saved. New Runs use the updated tool contract.',{exact:true}).waitFor();assert.deepEqual(await p.evaluate(()=>window.capabilityPackets.map(p=>p.revision)),[1,1,2]);await p.close();console.log(`PASS ${scope} actual capability caller: delayed toggle locking, failure/retained draft/dirty guard, retry and current revision`);
 }
 assert.deepEqual(errors,[]);console.log('PASS parameter/limit pending controls, failure/retry, retained draft, dirty navigation and acknowledgment revisions');
}finally{await browser.close()}
