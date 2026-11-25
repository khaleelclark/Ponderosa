import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fixture} from '../shared/fixture.mjs';
import {serveFixture} from '../shared/serve-ui-fixture.mjs';

const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const f=await fixture();
let web,browser;
try{
 web=await serveFixture(f);
 browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 for(const mobile of [false,true]){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:900},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
  const page=await context.newPage();
  page.setDefaultTimeout(12000);
  const pageErrors=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===web.origin?route.continue():route.abort());
  try{
   const name=mobile?'Phone schedule':'Desktop schedule';
   const branch=f.ok(await f.api('POST','/api/branches',{name,idempotencyKey:randomUUID()}));
   const path=`/api/branches/${branch.id}`;
   const schedule={scheduleKind:'interval',everyMs:600000,startsAt:new Date(Date.now()+3600000).toISOString()};
   const initial=f.ok(await f.api('POST','/api/branches/deploy',{branchId:branch.id,chatId:branch.chatId,expectedVersionId:branch.versionId,idempotencyKey:randomUUID(),
    definition:{schema:'ponderosa.branch.v1',name,trigger:{kind:'schedule',configRef:'schedule'},entry:'review',steps:[{id:'review',label:'Review request',kind:'human_gate',prompt:'Approve the fixture?',editable:true}],controls:[],edges:[],policy:{maxConcurrentExecutions:2,failure:{action:'stop'}}},
    bindings:{agents:{},directories:{},triggers:{schedule:{enabled:true,sourceConfig:schedule}}}}));
   const url=`${web.origin}/branches?branch=${branch.id}`;
   const inspector=page.getByRole(mobile?'dialog':'region',{name:'Workflow inspector',exact:true});
   const start=page.getByRole('button',{name:/Every \d+ minutes/});
   const availability=page.getByRole('switch',{name:'Workflow availability'});
   const run=page.getByRole('button',{name:'Run once',exact:true});
   const back=inspector.getByRole('button',{name:'Back to workflow',exact:true});
   await page.goto(url);
   await start.waitFor();
   assert.equal(await availability.isChecked(),true);
   await start.click();
   await inspector.getByText('Published · Every 10 minutes',{exact:true}).waitFor();
   if(mobile){
    await page.waitForFunction(()=>{const rect=document.querySelector('[aria-label="Workflow inspector"]').getBoundingClientRect();return Math.abs(rect.width-390)<1&&rect.x<=1;});
    await inspector.getByRole('button',{name:'Workflow variables',exact:true}).click();
    await inspector.getByRole('button',{name:'Back to trigger settings'}).click();
    await back.click();await inspector.waitFor({state:'hidden'});
    await start.evaluate(element=>{if(document.activeElement!==element)throw Error('Focus returned to '+document.activeElement?.tagName+' '+document.activeElement?.getAttribute('aria-label')+' '+document.activeElement?.textContent?.slice(0,80));});
    await start.click();
   }else{
    const divider=page.getByRole('separator',{name:'Resize workflow inspector'});
    const value=async()=>Number(await divider.getAttribute('aria-valuenow'));
    const first=await value();
    await divider.focus();
    await page.keyboard.press('ArrowLeft');assert.equal(await value(),first+16);
    const handle=await divider.boundingBox();
    await page.mouse.move(handle.x+6,handle.y+30);await page.mouse.down();await page.mouse.move(handle.x-34,handle.y+30,{steps:5});await page.mouse.up();
    assert.equal(await value(),first+56);
    await page.keyboard.press('Home');assert.equal(await value(),320);
    await page.keyboard.press('End');assert.equal(await value(),Number(await divider.getAttribute('aria-valuemax')));
    await page.keyboard.press('Home');await page.keyboard.press('ArrowLeft');
    await page.reload();await start.click();assert.equal(await value(),336);
    const canvas=await page.getByRole('region',{name:'Workflow Canvas',exact:true}).boundingBox();
    const dock=await inspector.boundingBox();assert.ok(canvas.width>=380&&canvas.x+canvas.width<dock.x);
   }
   const interval=inspector.getByRole('spinbutton',{name:'Every'});
   await interval.fill('');
   await inspector.getByText('Correct the trigger fields before reviewing publication.').waitFor();
   await back.click();
   assert.equal(await page.getByRole('button',{name:'Review changes',exact:true}).isDisabled(),true);
   await start.click();
   assert.equal(await interval.inputValue(),'');
   await interval.fill('15');
   await inspector.getByText('Draft · Every 15 minutes',{exact:true}).waitFor();
   await inspector.getByText('Published · Every 10 minutes',{exact:true}).waitFor();
   await back.click();
   const step=page.locator('[aria-label="Select Review request"]');
   await step.click();
   await inspector.getByRole('textbox',{name:'Name',exact:true}).fill('Review edited request');
   await back.click();
   const reviewButton=page.getByRole('button',{name:'Review changes',exact:true});
   await page.route('**/api/branches/preview',route=>route.fulfill({status:400,json:{error:'Fixture review validation failed'}}),{times:1});
   await reviewButton.click();
   await page.getByRole('alert').getByText('Fixture review validation failed',{exact:true}).waitFor();
   await reviewButton.click();
   await inspector.getByRole('heading',{name:'Review changes',exact:true}).waitFor();
   await inspector.getByText('After publishing · Every 15 minutes · Automatic starts enabled',{exact:true}).waitFor();
   await inspector.getByRole('button',{name:'Publish workflow',exact:true}).click();
   await inspector.waitFor({state:'hidden'});
   await page.getByRole('button',{name:'Every 15 minutes',exact:true}).click();
   await inspector.getByText('Published · Every 15 minutes',{exact:true}).waitFor();
   await inspector.getByRole('button',{name:'Pause schedule',exact:true}).click();
   await inspector.getByRole('button',{name:'Resume schedule',exact:true}).waitFor();
   assert.equal(await availability.isChecked(),true);
   assert.equal(f.ok(await f.api('GET',path+'/trigger')).enabled,false);
   await back.click();
   assert.equal(await run.isEnabled(),true);
   await run.click();
   await inspector.getByRole('textbox',{name:'Run Input'}).fill('Run while paused');
   await inspector.getByRole('button',{name:'Run once',exact:true}).click();
   await page.waitForURL(next=>next.searchParams.has('execution'));
   const runId=new URL(page.url()).searchParams.get('execution');
   const details=page.getByRole('region',{name:'Selected Run'});
   await details.getByRole('button',{name:'Approve',exact:true}).waitFor();
   const execution=async()=>f.ok(await f.api('GET',`/api/branch-executions/${runId}`)).execution;
   assert.notEqual((await execution()).versionId,initial.versionId);
   assert.equal((await execution()).input,'Run while paused');

   let completeFailure,fail=true;
   const failedAvailability=new Promise(resolve=>{completeFailure=resolve});
   await page.route('**'+path+'/availability',async route=>{
    if(route.request().method()!=='PUT'||!fail)return route.continue();
    fail=false;
    await failedAvailability;
    await route.fulfill({status:400,json:{error:'Fixture availability failed'}});
   });
   await availability.click();
   await inspector.getByText('Disabling blocks new manual and automatic runs. Runs already in progress continue.').waitFor();
   await inspector.getByRole('button',{name:'Disable workflow',exact:true}).click();
   await page.getByText('Saving availability…',{exact:true}).waitFor();
   assert.equal(await availability.isDisabled(),true);
   assert.equal(await run.isDisabled(),true);
   completeFailure();
   await page.getByText('Fixture availability failed',{exact:true}).waitFor();
   assert.equal(await availability.isChecked(),true);
   await availability.click();
   await inspector.getByRole('button',{name:'Disable workflow',exact:true}).click();
   await page.getByText('Enable to run once.',{exact:true}).waitFor();
   assert.equal(await availability.isChecked(),false);
   assert.equal(await run.isDisabled(),true);
   assert.equal((await execution()).state,'waiting');
   assert.equal(f.ok(await f.api('GET',path+'/trigger')).enabled,false);
   await availability.click();
   await page.waitForFunction(()=>document.querySelector('[aria-label="Workflow availability"]')?.checked===true);
   await details.getByRole('button',{name:'Approve',exact:true}).click();
   await details.getByRole('region',{name:'Results'}).waitFor();

   const overflow=page.getByRole('button',{name:'Workflow Actions'});
   await overflow.click();
   await page.getByRole('menuitem',{name:'Version History',exact:true}).click();
   await inspector.getByRole('heading',{name:'Version history',exact:true}).waitFor();
   await inspector.getByRole('button',{name:'Download Definition',exact:true}).first().waitFor();
   await back.click();
   await overflow.click();
   await page.getByRole('menuitem',{name:'Rename…',exact:true}).click();
   await inspector.getByRole('textbox',{name:'Workflow Name',exact:true}).fill(name+' renamed');
   await inspector.getByRole('button',{name:'Apply To Draft',exact:true}).click();
   await page.getByRole('heading',{name:name+' renamed',exact:true}).waitFor();

   await overflow.click();
   await page.getByRole('menuitem',{name:'Edit Workflow JSON…',exact:true}).click();
   await inspector.getByRole('textbox',{name:'Definition JSON',exact:true}).waitFor();
   await back.click();
   await reviewButton.click();
   await inspector.getByRole('heading',{name:'Review changes',exact:true}).waitFor();
   assert.equal(await inspector.getByText(/After publishing · Every 15 minutes/).count(),0,'A rename preserves the live pause');
   await inspector.getByRole('button',{name:'Publish workflow',exact:true}).click();
   await inspector.waitFor({state:'hidden'});
   assert.equal(f.ok(await f.api('GET',path+'/trigger')).enabled,false);

   await page.getByRole('tab',{name:'Settings',exact:true}).click();
   await page.getByRole('button',{name:'Delete Workflow…',exact:true}).click();
   await inspector.getByRole('heading',{name:/Delete workflow/i}).waitFor();
   assert.equal(await inspector.getByRole('button',{name:'Delete workflow',exact:false}).isDisabled(),true);
   await back.click();
   assert.equal(f.ok(await f.api('GET',path)).id,branch.id);

   assert.deepEqual(pageErrors,[]);
   console.log(`Workflow inspector passed at ${mobile?'390 × 844':'1440 × 900'}`);
  }catch(error){
   await page.screenshot({path:`/tmp/pr111-inspector-${mobile?'phone':'desktop'}-failed.png`});
   throw error;
  }finally{await context.close()}
 }
}finally{await browser?.close();await web?.close();await f.dispose(false)}
