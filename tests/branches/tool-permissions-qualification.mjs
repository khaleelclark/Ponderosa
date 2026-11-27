import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {CAPABILITY_IDS} from '../../packages/core/dist/index.js';
import {serveFixture} from '../shared/serve-ui-fixture.mjs';
const {fixture,until}=await import('../shared/fixture.mjs');

const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const pending=[],outstanding=new Set();
const f=await fixture({capabilityCatalog:()=>new Promise(resolve=>{
 const operation=value=>{outstanding.delete(operation);resolve(value)};
 pending.push(operation);
 outstanding.add(operation);
})});
const catalog=name=>({steering:true,persistentSessions:true,commands:[],composerCapabilities:[],mcpServers:[
 {name,configured:true,initialization:'initialized',usable:true,toolsDiscovered:true,toolCount:3,health:'unknown',tools:[{name:'lookup_record'}]},
]});
const write=(url,revision,restrictedCapabilityIds)=>f.api('PUT',url,{revision,restrictedCapabilityIds});
const orphan='connector:codex:saved-mail';
let web,browser;
try{
 web=await serveFixture(f);
 browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/usr/bin/google-chrome',args:['--no-sandbox']});
 f.ok(await write('/api/branches/engine/workspace/capabilities',0,[CAPABILITY_IDS.browserRead]));
 for(const viewport of [{width:1440,height:900},{width:390,height:844},{width:320,height:640}]){
  const mobile=viewport.width<600;
  const name='Tool permissions '+viewport.width;
  const branch=f.ok(await f.api('POST','/api/branches',{name,idempotencyKey:randomUUID()}));
  const path='/api/branches/'+branch.id;
  const chat=f.ok(await f.api('POST',path+'/chats',{label:name,defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
  f.ok(await f.api('POST',`/api/branches/engine/projects/${chat.projectId}/agents`,{
   title:'Fixture Agent',conversationId:chat.id,engine:'codex',idempotencyKey:randomUUID(),
  }));
  f.ok(await f.api('POST','/api/branches/deploy',{
   branchId:branch.id,chatId:branch.chatId,expectedVersionId:branch.versionId,idempotencyKey:randomUUID(),
   definition:{schema:'ponderosa.branch.v1',name,trigger:{kind:'manual'},entry:'review',
    steps:[{id:'review',kind:'human_gate',prompt:'Review the fixture.',editable:false}],controls:[],edges:[],
    policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},
   bindings:{agents:{},directories:{}},
  }));
  const endpoint=path+'/capabilities';
  f.ok(await write(endpoint,0,[orphan]));
  const discoveriesBefore=f.capabilityDiscoveries.length;
  const context=await browser.newContext({viewport,isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
  let releasePolicy;
  try{
   const policyGate=new Promise(resolve=>{releasePolicy=resolve});
   const page=await context.newPage();
   page.setDefaultTimeout(8000);
   let inventoryRequests=0,policyReads=0,failSave=false;
   const errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==web.origin)return route.abort();
    if(url.pathname===endpoint+'/connected-tools')inventoryRequests++;
    if(url.pathname===endpoint&&request.method()==='GET'&&++policyReads===1)await policyGate;
    if(url.pathname===endpoint&&request.method()==='PUT'&&failSave){
     failSave=false;
     return route.fulfill({status:503,json:{error:'Controlled permission save failure'}});
    }
    return route.continue();
   });
   const activate=control=>mobile?control.tap():control.click();
   await page.goto(web.origin+'/branches?branch='+branch.id+'&tab=settings',{waitUntil:'domcontentloaded'});
   const section=page.getByRole('region',{name:'Tool permissions',exact:true});
   const text=value=>section.getByText(value,{exact:true});
   const control=name=>section.getByLabel('Allow '+name,{exact:true});
   const connected=section.getByRole('button',{name:'Connected tools',exact:true});
   const inventory=message=>until(()=>pending.shift(),message);
   const policy=async()=>f.ok(await f.api('GET',endpoint)).policy;
   const toggle=async(name,expectedRevision)=>{
    await activate(control(name));
    await until(async()=>((await policy()).revision===expectedRevision),'committed permission revision '+expectedRevision);
   };

   await section.getByRole('heading',{name:'Tool permissions',exact:true}).waitFor();
   await text('Loading tool permissions…').waitFor();
   assert.equal(inventoryRequests,0);
   releasePolicy();
   await connected.waitFor();
   await text('Restricted by workspace settings').waitFor();
   assert.equal(await control('Read pages').getAttribute('aria-describedby'),await text('Restricted by workspace settings').getAttribute('id'));
   assert.equal(await section.getByText(/Broader restrictions still apply|Provider-native changes:|Some tool details are omitted/).count(),0);
   assert.ok(await control('Read pages').isDisabled());
   assert.equal(await control('Read pages').isChecked(),false);
   assert.equal(await connected.getAttribute('aria-expanded'),'false');
   await toggle('Read project status',2);
   assert.equal(f.capabilityDiscoveries.length,discoveriesBefore);
   assert.equal(inventoryRequests,0);
   await activate(connected);
   const initial=await inventory('initial held discovery');
   assert.equal(inventoryRequests,1);
   await text('Loading connected tools…').waitFor();
   await text('saved-mail').waitFor();
   assert.ok((await policy()).restrictedCapabilityIds.includes(orphan));
   await toggle('Write to the filesystem',3);
   await page.getByText('Provider tool changes apply on the next run.',{exact:true}).waitFor();
   await text('Loading connected tools…').waitFor();
   initial(catalog('first-service'));
   const originalLabel='first-service (Controlled regression adapter)';
   await text(originalLabel).waitFor();
   const originalDetails=section.locator('details').filter({hasText:'Showing 1 of 3 tools.'});
   assert.equal(await originalDetails.getByText('Showing 1 of 3 tools.',{exact:true}).isVisible(),false);
   await activate(originalDetails.locator('summary'));
   assert.ok(await originalDetails.getByText('Showing 1 of 3 tools.',{exact:true}).isVisible());

   await activate(section.getByRole('button',{name:'Refresh',exact:true}));
   const refresh=await inventory('held explicit refresh');
   await text('Refreshing connected tools…').waitFor();
   assert.ok(await text(originalLabel).isVisible());
   const partial=catalog('first-service');
   refresh({...partial,mcpInventoryIncomplete:true,mcpServers:partial.mcpServers.map(item=>({...item,usable:false,toolsDiscovered:false,tools:[]}))});
   await text('Some connected tools could not be loaded.').waitFor();
   assert.ok(await text(originalLabel).isVisible());
   assert.ok(await originalDetails.getByText('Showing 1 of 3 tools.',{exact:true}).isVisible());
   assert.ok(await text('saved-mail').isVisible());
   await toggle('Import host files',4);

   const current=await policy();
   f.ok(await write(endpoint,current.revision,current.restrictedCapabilityIds));
   await activate(control('Import host files'));
   await section.getByText(/Capability policy changed before this update/).waitFor();
   await until(()=>control('Import host files').isEnabled(),'readback after conflict');
   assert.equal(await control('Import host files').isChecked(),false);
   failSave=true;
   await activate(control('Import host files'));
   await section.getByText(/Controlled permission save failure/).waitFor();
   assert.equal((await policy()).revision,5);

   await activate(section.getByRole('button',{name:'Retry',exact:true}));
   const retry=await inventory('held retry');
   assert.ok(await text(originalLabel).isVisible());
   retry(catalog('replacement-service'));
   await text('replacement-service (Controlled regression adapter)').waitFor();
   await text(originalLabel).waitFor({state:'hidden'});
   await text('Some connected tools could not be loaded.').waitFor({state:'hidden'});
   assert.ok(await text('saved-mail').isVisible());
   assert.equal(inventoryRequests,3);
   assert.ok(await section.evaluate(element=>element.scrollWidth<=element.clientWidth+1),'Permission controls fit the viewport');
   assert.deepEqual(errors,[]);
   console.log(`${viewport.width}px: immediate heading, lazy discovery, independent saves, retained rows, retry, conflict and save failure passed`);
  }finally{
   releasePolicy?.();
   for(const operation of outstanding)operation(catalog('cleanup'));
   pending.length=0;
   await context.close();
  }
 }
}finally{
 for(const operation of outstanding)operation(catalog('cleanup'));
 await browser?.close();
 await web?.close();
 await f.dispose();
}
