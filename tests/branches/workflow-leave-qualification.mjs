import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {serveFixture} from '../shared/serve-ui-fixture.mjs';

const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const {fixture,until}=await import('../shared/fixture.mjs');
const f=await fixture();
let web,browser;
try{
 web=await serveFixture(f);
 browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/usr/bin/google-chrome',args:['--no-sandbox']});
 for(const mobile of [false,true]){
  const viewport=mobile?{width:390,height:844}:{width:1440,height:900};
  const context=await browser.newContext({viewport,isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
  const page=await context.newPage();
  page.setDefaultTimeout(12000);
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const activate=control=>mobile?control.tap():control.click();
  const button=(name,owner=page)=>owner.getByRole('button',{name,exact:true});
  const tab=name=>page.getByRole('tab',{name,exact:true});
  const heading=name=>page.getByRole('heading',{name,exact:true});
  const leave=page.getByRole('dialog',{name:'Unsaved changes',exact:true});
  const stay=button('Stay here',leave),save=button('Save and switch',leave),discard=button('Discard changes and switch',leave);
  const inspector=page.getByRole(mobile?'dialog':'region',{name:'Workflow inspector',exact:true});
  const current=()=>new URL(page.url()).searchParams.get('branch');
  async function open(branch){
   if(mobile)await activate(button('Open Workspace Navigation'));
   await activate(page.getByRole('link',{name:'Open Workflow '+branch.name,exact:true}));
  }
  async function selected(branch){
   await page.waitForURL(url=>url.searchParams.get('branch')===branch.id);
   await heading(branch.name).waitFor();
  }
  async function rename(name){
   await activate(button('Workflow Actions'));
   await activate(page.getByRole('menuitem',{name:'Rename…',exact:true}));
   await inspector.getByRole('textbox',{name:'Workflow Name',exact:true}).fill(name);
   await activate(button('Apply To Draft',inspector));
   await inspector.waitFor({state:'hidden'});
   await heading(name).waitFor();
  }
  async function dismissReview(){
   await activate(button('Back to workflow',inspector));
   await inspector.waitFor({state:'hidden'});
  }
  const read=async url=>f.ok(await f.api('GET',url));
  const post=async(url,body)=>f.ok(await f.api('POST',url,body));
  try{
   const source=await post('/api/branches',{name:'Source '+viewport.width,idempotencyKey:randomUUID()});
   const target=await post('/api/branches',{name:'Target '+viewport.width,idempotencyKey:randomUUID()});
   const path='/api/branches/'+source.id;
   const original=await post('/api/branches/deploy',{
    branchId:source.id,chatId:'',expectedVersionId:'',idempotencyKey:randomUUID(),
    definition:{schema:'ponderosa.branch.v1',name:source.name,trigger:{kind:'manual'},entry:'approve',
     steps:[{id:'approve',kind:'human_gate',prompt:'Approve this fixture?',editable:true}],
     controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},
    bindings:{agents:{},directories:{}},
   });
   const versionPath=path+'/versions/'+original.versionId;
   let previewFault=false,publicationFault,discardFault,releaseDiscard;
   let previews=0,discardReads=0;
   const publications=[];
   await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==web.origin)return route.abort();
    if(url.pathname==='/api/branches/preview'){
     previews++;
     if(previewFault)return route.fulfill({status:400,json:{error:'Correct the fixture validation error'}});
    }
    if(url.pathname==='/api/branches/deploy'){
     publications.push(request.postDataJSON());
     if(publicationFault==='conflict')return route.fulfill({status:409,json:{error:'Fixture publication conflict'}});
     if(publicationFault==='lost'){
      const response=await route.fetch();
      assert.equal(response.ok(),true);
      return route.abort();
     }
    }
    if(discardFault&&url.pathname===versionPath){
     discardReads++;
     await new Promise(resolve=>{releaseDiscard=resolve});
     if(discardFault==='unavailable')return route.fulfill({status:503,json:{error:'Fixture version unavailable'}});
     discardFault='changed';
    }
    if(discardFault==='changed'&&url.pathname===path){
     discardFault=undefined;
     const branch=await read(path);
     return route.fulfill({json:{...branch,versionId:'unconfirmed-fixture-version'}});
    }
    return route.continue();
   });

   await page.goto(web.origin+'/branches?branch='+target.id);
   await selected(target);
   await open(source);
   await selected(source);
   assert.equal(await leave.count(),0,'A clean workflow switch is immediate');
   const draftName='Edited source '+viewport.width;
   await rename(draftName);
   await page.evaluate(()=>history.back());
   await leave.getByText('Switch to '+target.name+'?',{exact:true}).waitFor();
   assert.equal(current(),source.id,'Dirty Back restores the accepted URL');
   await page.waitForFunction(()=>document.activeElement?.textContent==='Stay here');
   assert.equal(await page.locator('#main-content h1').filter({hasText:draftName}).isVisible(),true,'The current workflow remains visible behind the dialog');
   const box=await leave.boundingBox();
   assert.ok(Math.abs(box.x+box.width/2-viewport.width/2)<3);
   assert.ok(Math.abs(box.y+box.height/2-viewport.height/2)<3);
   for(const action of [stay,save,discard])assert.ok((await action.boundingBox()).height>=44);
   await page.keyboard.press('Shift+Tab');
   assert.equal(await save.evaluate(node=>node===document.activeElement),true);
   await page.keyboard.press('Tab');
   assert.equal(await stay.evaluate(node=>node===document.activeElement),true);
   const tabs=await page.locator('#branch-settings-tab').boundingBox();
   const x=tabs.x+tabs.width/2,y=tabs.y+tabs.height/2;
   for(let i=0;i<2;i++)await (mobile?page.touchscreen.tap(x,y):page.mouse.click(x,y));
   assert.equal(await leave.isVisible(),true);
   assert.equal(current(),source.id);
   await page.keyboard.press('Escape');
   await leave.waitFor({state:'hidden'});
   await heading(draftName).waitFor();
   await page.waitForFunction(()=>document.querySelector('main').contains(document.activeElement));

   await open(target);
   await activate(stay);
   await leave.waitFor({state:'hidden'});
   await page.waitForFunction(()=>document.querySelector('main').contains(document.activeElement));
   assert.equal(current(),source.id);
   await heading(draftName).waitFor();

   await activate(tab('Settings'));
   assert.equal(await tab('Settings').getAttribute('aria-selected'),'true');
   await heading(draftName).waitFor();
   assert.equal(await leave.count(),0,'Switching tabs preserves the draft');
   await activate(tab('Workflow'));

   for(const mode of ['unavailable','version changed']){
    discardFault=mode;
    releaseDiscard=undefined;
    await open(target);
    await discard.evaluate(node=>{node.click();node.click()});
    await leave.getByText('Restoring the saved workflow…',{exact:true}).waitFor();
    assert.ok(await stay.isDisabled());
    await page.keyboard.press('Escape');
    await page.evaluate(()=>history.back());
    assert.equal(await leave.isVisible(),true);
    await until(()=>releaseDiscard,'wait for the canonical discard read');
    releaseDiscard();
    await leave.waitFor({state:'hidden'});
    discardFault=undefined;
    const discardError=mode==='unavailable'?'Fixture version unavailable':'The published workflow changed while loading.';
    await page.getByRole('alert').filter({hasText:discardError}).waitFor();
    assert.equal(current(),source.id);
    await heading(draftName).waitFor();
   }
   assert.equal(discardReads,2,'Each discard issues one canonical version read');

   await open(target);
   await save.evaluate(node=>{node.click();node.click()});
   await inspector.getByRole('heading',{name:'Review changes',exact:true}).waitFor();
   assert.equal(previews,1,'Duplicate Save clicks issue a single review request');
   assert.equal(current(),source.id);
   assert.deepEqual(publications,[]);
   await dismissReview();
   assert.equal((await read(path)).versionId,original.versionId);
   await heading(draftName).waitFor();

   previewFault=true;
   await open(target);
   await activate(save);
   await page.getByRole('alert').filter({hasText:'Correct the fixture validation error'}).waitFor();
   assert.equal(current(),source.id);
   await heading(draftName).waitFor();
   previewFault=false;

   publicationFault='conflict';
   await open(target);
   await activate(save);
   await activate(button('Publish workflow',inspector));
   await inspector.getByRole('alert').filter({hasText:'Fixture publication conflict'}).waitFor();
   assert.equal(current(),source.id);
   assert.equal((await read(path)).versionId,original.versionId);
   await dismissReview();
   await heading(draftName).waitFor();

   publicationFault='lost';
   await open(target);
   await activate(save);
   await button('Publish workflow',inspector).evaluate(node=>{node.click();node.click()});
   await button('Retry publication',inspector).waitFor();
   assert.equal(publications.length,2,'Duplicate Publish clicks issue one submission for this review');
   assert.equal(current(),source.id,'A lost response keeps the source open even after commit');
   const published=await read(path);
   assert.notEqual(published.versionId,original.versionId);
   await dismissReview();
   await heading(draftName).waitFor();
   await open(target);
   assert.ok(await discard.isDisabled());
   await leave.getByText('Confirm the previous publication before discarding edits.',{exact:true}).waitFor();
   await activate(save);
   publicationFault=undefined;
   await activate(button('Retry publication',inspector));
   await selected(target);
   assert.equal(publications.length,3);
   assert.deepEqual(publications[2],publications[1],'Retry uses the exact reviewed publication and idempotency key');
   assert.equal((await read(path)).versionId,published.versionId);

   await page.evaluate(()=>history.back());
   source.name=draftName;
   await selected(source);
   await rename('Discarded edits '+viewport.width);
   await page.evaluate(()=>history.forward());
   await leave.getByText('Switch to '+target.name+'?',{exact:true}).waitFor();
   assert.equal(current(),source.id,'Dirty Forward restores the accepted URL');
   await activate(discard);
   await selected(target);
   await page.evaluate(()=>history.back());
   await selected(source);
   assert.equal(await leave.count(),0,'Reopening after discard has no remaining draft');
   assert.equal((await read(path)).versionId,published.versionId);
   assert.deepEqual(errors,[]);
   console.log('PASS '+viewport.width+'×'+viewport.height+' leave dialog, focus and backdrop, clean/draft-preserving navigation, Back and Forward, cancel, failed/uncertain review/publish/discard, exact confirmed switch and duplicate fencing');
  }catch(error){
   console.error(JSON.stringify({viewport,url:page.url(),errors,visible:(await page.locator('body').innerText()).slice(0,2800)}));
   throw error;
  }finally{await context.close()}
 }
}finally{await browser?.close();await web?.close();await f.dispose()}
