import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {AgentStore,BranchStore,CoordinationV3Store} from '../../packages/agents/dist/index.js';
import {fixture} from '../shared/fixture.mjs';
import {serveFixture} from '../shared/serve-ui-fixture.mjs';

const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
let store;
const f=await fixture({storeFactory:directory=>(store=new AgentStore(directory))});
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
   const deployment={branchId:branch.id,chatId:branch.chatId,expectedVersionId:branch.versionId,idempotencyKey:randomUUID(),
    definition:{schema:'ponderosa.branch.v1',name,trigger:{kind:'schedule',configRef:'schedule'},entry:'review',steps:[{id:'review',label:'Review request',kind:'human_gate',prompt:'Approve the fixture?',editable:true}],controls:[],edges:[],policy:{maxConcurrentExecutions:2,failure:{action:'stop'}}},
    bindings:{agents:{},directories:{},triggers:{schedule:{enabled:true,sourceConfig:schedule}}}};
   const initial=f.ok(await f.api('POST','/api/branches/deploy',deployment));
   const url=`${web.origin}/branches?branch=${branch.id}`;
   const inspector=page.getByRole(mobile?'dialog':'region',{name:'Workflow inspector',exact:true});
   const start=page.getByRole('button',{name:/Every \d+ minutes/});
   const availability=page.getByRole('switch',{name:'Workflow availability'});
   const run=page.getByRole('button',{name:'Run once',exact:true});
   const back=inspector.getByRole('button',{name:'Back to workflow',exact:true});
   const activate=control=>mobile?control.tap():control.click();
   const live=inspector.getByRole('region',{name:'Published trigger',exact:true});
   const directoryStatus=page.getByRole('link',{name:'Open Workflow '+name,exact:true}).locator('..').getByRole('img',{name:/Workflow Runs/});
   async function checkDirectory(label){
    const nav=page.getByRole('button',{name:'Open Workspace Navigation',exact:true});
    if(mobile)await activate(nav);
    await directoryStatus.getByText(label).waitFor();
    if(mobile)await page.keyboard.press('Escape');
   }
   const busy=inspector.getByRole('radiogroup',{name:'When already running',exact:true});
   await page.goto(url);
   await start.waitFor();
   assert.equal(await availability.isChecked(),true);
   await checkDirectory(/^Next /);
   await start.click();
   await inspector.getByText('Published · Every 10 minutes',{exact:true}).waitFor();
   await live.getByText('Automatic runs on',{exact:true}).waitFor();
   assert.equal(await busy.getByRole('radio',{name:'Queue every run',exact:true}).isChecked(),true);
   await inspector.getByText(/Queue a separate run for each scheduled event/).waitFor();
   assert.equal(await inspector.getByRole('combobox').count(),1,'Only the interval unit needs a dropdown');
   assert.equal(await inspector.getByRole('textbox',{name:'Cron Expression'}).count(),0);
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
   await activate(run);
   await inspector.getByText('Run uses published version '+initial.versionId+' · unpublished edits excluded',{exact:true}).waitFor();
   await activate(back);
   const reviewButton=page.getByRole('button',{name:'Review changes',exact:true});
   await page.route('**/api/branches/preview',route=>route.fulfill({status:400,json:{error:'Fixture review validation failed'}}),{times:1});
   await reviewButton.click();
   await page.getByRole('alert').getByText('Fixture review validation failed',{exact:true}).waitFor();
   await reviewButton.click();
   await inspector.getByRole('heading',{name:'Review changes',exact:true}).waitFor();
   await inspector.getByText('After publishing · Every 15 minutes · Automatic runs on',{exact:true}).waitFor();
   await inspector.getByRole('button',{name:'Publish workflow',exact:true}).click();
   await inspector.waitFor({state:'hidden'});
   await page.getByRole('button',{name:'Every 15 minutes',exact:true}).click();
   await inspector.getByText('Published · Every 15 minutes',{exact:true}).waitFor();
   await inspector.getByRole('button',{name:'Pause schedule',exact:true}).click();
   await inspector.getByRole('button',{name:'Resume schedule',exact:true}).waitFor();
   await live.getByText('Automatic runs paused',{exact:true}).waitFor();
   assert.equal(await availability.isChecked(),true);
   const paused=f.ok(await f.api('GET',path+'/trigger'));
   assert.equal(paused.enabled,false);
   assert.deepEqual(paused.sourceConfig,{...schedule,everyMs:900000},'Cadence edit preserves the saved phase and legacy overlap behavior');
   await activate(busy.getByRole('radio',{name:'Update current run',exact:true}));
   await inspector.getByText(/Send the next event to a supported Agent/).waitFor();
   await activate(busy.getByRole('radio',{name:'Run latest after current',exact:true}));
   await inspector.getByText(/Keep only the latest event for a run after the current one finishes/).waitFor();
   await live.getByText('When already running · Queue every run',{exact:true}).waitFor();
   assert.deepEqual(f.ok(await f.api('GET',path+'/trigger')),paused,'The live trigger stays paused with its old policy until publication');
   await back.click();
   await reviewButton.click();
   await inspector.getByText('After publishing · Every 15 minutes · Automatic runs paused · Run latest after current',{exact:true}).waitFor();
   await inspector.getByRole('button',{name:'Publish workflow',exact:true}).click();
   await inspector.waitFor({state:'hidden'});
   const changed=f.ok(await f.api('GET',path+'/trigger'));
   assert.equal(changed.enabled,false);
   assert.equal(changed.nextFireAt,paused.nextFireAt,'A policy-only publication preserves the schedule cursor');
   assert.deepEqual(changed.sourceConfig,{...paused.sourceConfig,whenRunning:'run_latest'});
   await page.getByRole('button',{name:'Every 15 minutes',exact:true}).click();
   await activate(live.getByRole('button',{name:'Resume schedule',exact:true}));
   await live.getByText('Automatic runs on',{exact:true}).waitFor();
   await activate(live.getByRole('button',{name:'Pause schedule',exact:true}));
   await live.getByText('Automatic runs paused',{exact:true}).waitFor();
   await back.click();
   await checkDirectory('Schedule paused');
   const beforeManual=f.ok(await f.api('GET',path+'/trigger'));
   assert.equal(await run.isEnabled(),true);
   await run.click();
   await inspector.getByRole('textbox',{name:'Run Input'}).fill('Run while paused');
   await inspector.getByRole('button',{name:'Run once',exact:true}).click();
   await page.waitForURL(next=>next.searchParams.has('execution'));
   const runId=new URL(page.url()).searchParams.get('execution');
   const details=page.getByRole('region',{name:'Selected Run'});
   await details.getByRole('button',{name:'Approve',exact:true}).waitFor();
   assert.doesNotMatch(await details.innerText(),/0 (steps? completed|running|retrying)/i);
   const execution=async()=>f.ok(await f.api('GET',`/api/branch-executions/${runId}`)).execution;
   assert.notEqual((await execution()).versionId,initial.versionId);
   assert.equal((await execution()).input,'Run while paused');
   assert.deepEqual(f.ok(await f.api('GET',path+'/trigger')),beforeManual,'Run once leaves the paused schedule intact');

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
   await checkDirectory('Disabled');
   assert.equal((await execution()).state,'waiting');
   assert.equal(f.ok(await f.api('GET',path+'/trigger')).enabled,false);
   await availability.click();
   await page.waitForFunction(()=>document.querySelector('[aria-label="Workflow availability"]')?.checked===true);
   await details.getByRole('button',{name:'Approve',exact:true}).click();
   await details.getByRole('region',{name:'Results'}).waitFor();
   const technical=details.locator('summary').filter({hasText:'Technical Details'});
   assert.equal(await technical.evaluate(el=>el.parentElement.open),false);
   await activate(technical);
   await details.getByRole('button',{name:'Copy Run ID',exact:true}).waitFor();

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
   await inspector.getByText('Automatic runs stay paused.',{exact:true}).waitFor();
   assert.equal(await inspector.getByText(/After publishing · Every 15 minutes/).count(),0,'A rename has no trigger diff');
   await inspector.getByRole('button',{name:'Publish workflow',exact:true}).click();
   await inspector.waitFor({state:'hidden'});
   assert.equal(f.ok(await f.api('GET',path+'/trigger')).enabled,false);

   const publishedBeforeRepair=f.ok(await f.api('GET',path));
   const beforeDefinition=f.ok(await f.api('GET',path+'/versions/'+publishedBeforeRepair.versionId)).definition;
   const settingsTab=page.getByRole('tab',{name:'Settings',exact:true});
   const workflowTab=page.getByRole('tab',{name:'Workflow',exact:true});
   await settingsTab.click();
   const advanced=page.getByRole('button',{name:'Advanced execution settings',exact:true});
   assert.equal(await advanced.getAttribute('aria-expanded'),'false');
   await activate(advanced);
   const concurrency=page.getByRole('spinbutton',{name:'Concurrent Executions',exact:true});
   const paths=page.getByRole('spinbutton',{name:'Maximum Paths',exact:true});
   const issues=page.getByRole('region',{name:'Publication Issues',exact:true});
   const repair=async(field,issue,value)=>{
    await activate(advanced);
    await activate(workflowTab);
    await activate(reviewButton);
    await activate(issues.getByRole('button',{name:issue}));
    assert.equal(await settingsTab.getAttribute('aria-selected'),'true');
    await field.waitFor();
    await page.waitForFunction(id=>document.activeElement?.id===id,await field.getAttribute('id'));
    assert.equal(await advanced.getAttribute('aria-expanded'),'true');
    await field.fill(value);
    await page.getByRole('alert').filter({hasText:issue}).waitFor({state:'hidden'});
    assert.equal(await advanced.getAttribute('aria-expanded'),'true','Editing away a rejected revision keeps the disclosure open');
   };
   await concurrency.fill('0');
   await paths.fill('0');
   await repair(concurrency,/Branch concurrency/,'3');
   await repair(paths,/maxPathInstances/,'500');
   await page.getByRole('combobox',{name:'Failure Handling'}).click();
   await page.getByRole('option',{name:'Retry Known Failure'}).click();
   const attempts=page.getByRole('spinbutton',{name:'Maximum Attempts',exact:true});
   await attempts.fill('0');
   await repair(attempts,/retry attempts/,'4');
   assert.equal(f.ok(await f.api('GET',path)).versionId,publishedBeforeRepair.versionId);
   assert.deepEqual(f.ok(await f.api('GET',path+'/versions/'+publishedBeforeRepair.versionId)).definition,beforeDefinition);
   await activate(workflowTab);
   await page.getByRole('button',{name:'Every 15 minutes',exact:true}).click();
   await activate(live.getByRole('button',{name:'Resume schedule',exact:true}));
   await live.getByText('Automatic runs on',{exact:true}).waitFor();
   const resumed=f.ok(await f.api('GET',path+'/trigger'));
   await back.click();
   await activate(reviewButton);
   await inspector.getByText('Automatic runs stay on.',{exact:true}).waitFor();
   await activate(inspector.getByRole('button',{name:'Publish workflow',exact:true}));
   await inspector.waitFor({state:'hidden'});
   const afterRepair=f.ok(await f.api('GET',path+'/trigger'));
   assert.equal(afterRepair.enabled,true);
   assert.equal(afterRepair.nextFireAt,resumed.nextFireAt);
   const publishedAfterRepair=f.ok(await f.api('GET',path));
   const afterDefinition=f.ok(await f.api('GET',path+'/versions/'+publishedAfterRepair.versionId)).definition;
   assert.notEqual(publishedAfterRepair.versionId,publishedBeforeRepair.versionId);
   assert.deepEqual(afterDefinition.steps,beforeDefinition.steps);
   assert.deepEqual(afterDefinition.policy,{
    ...beforeDefinition.policy,maxConcurrentExecutions:3,maxPathInstances:500,failure:{action:'retry',maxAttempts:4,delayMs:1000}
   });
   await settingsTab.click();
   assert.equal(await advanced.getAttribute('aria-expanded'),'true');
   const localLimit=page.getByRole('spinbutton',{name:'Graph Traversals',exact:true});
   await localLimit.fill('0');
   await page.getByText('Enter a positive whole number.',{exact:true}).waitFor();
   const saveLimits=page.getByRole('button',{name:'Save local limits',exact:true});
   assert.equal(await saveLimits.isDisabled(),true);
   await localLimit.fill('321');
   await activate(saveLimits);
   await saveLimits.waitFor({state:'hidden'});
   assert.equal(f.ok(await f.api('GET',path+'/settings')).configuration.limits.maxTraversals,321);
   await page.getByRole('button',{name:'Delete Workflow…',exact:true}).click();
   await inspector.getByRole('heading',{name:/Delete workflow/i}).waitFor();
   assert.equal(await inspector.getByRole('button',{name:'Delete workflow',exact:false}).isDisabled(),true);
   await back.click();
   assert.equal(f.ok(await f.api('GET',path)).id,branch.id);

   const branches=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
   for(const onceState of ['fired','expired','future']){
    const at=new Date(Date.now()+(onceState==='future'?3600000:-3600000)).toISOString();
    const legacyName='One-time '+onceState;
    const legacy=f.ok(await f.api('POST','/api/branches',{name:legacyName,idempotencyKey:randomUUID()}));
    const sourceConfig={scheduleKind:'once',at};
    const deployed=branches.deploy({...deployment,branchId:legacy.id,expectedVersionId:legacy.versionId,idempotencyKey:randomUUID(),
     definition:{...deployment.definition,name:legacyName},bindings:{...deployment.bindings,triggers:{schedule:{enabled:onceState==='fired',sourceConfig}}}},
     undefined,{sourceConfig,nextFireAt:at});
    const legacyPath='/api/branches/'+deployed.id;
    if(onceState==='fired')branches.triggers.recordScheduledTriggerOccurrence({triggerId:deployed.triggerId,expectedNextFireAt:at,lastFiredAt:at,
     occurrenceKey:'fixture-once',payload:{scheduledTimes:[at],missedCount:1},provenance:{source:'schedule'}});
    const readTrigger=async()=>f.ok(await f.api('GET',legacyPath+'/trigger'));
    const readOccurrences=async()=>f.ok(await f.api('GET',legacyPath+'/trigger/occurrences'));
    const saved=await readTrigger(),occurrences=await readOccurrences();
    assert.equal(saved.lastFiredAt,onceState==='fired'?at:undefined);
    await page.goto(web.origin+'/branches?branch='+deployed.id);
    await activate(page.getByRole('button',{name:/^Once on /}));
    const resume=live.getByRole('button',{name:'Resume schedule',exact:true});
    if(onceState==='future'){
     await live.getByText('Automatic runs paused',{exact:true}).waitFor();
     assert.equal(await resume.isEnabled(),true);
    }else{
     await live.getByText(onceState==='fired'?/already fired/:/expired before it fired/).waitFor();
     assert.equal(await resume.count(),0);
     await activate(inspector.getByRole('button',{name:'Change schedule type',exact:true}));
     await inspector.getByRole('radiogroup',{name:'Schedule type',exact:false}).waitFor();
    }
    assert.deepEqual(await readTrigger(),saved);
    assert.deepEqual(await readOccurrences(),occurrences);
   }
   assert.deepEqual(pageErrors,[]);
   console.log(`Schedule draft/live review, overlap, pause/resume, approval, technical evidence, Settings repair and one-time schedule states passed at ${mobile?'390 × 844':'1440 × 900'}`);
  }catch(error){
   await page.screenshot({path:`/tmp/pr111-inspector-${mobile?'phone':'desktop'}-failed.png`});
   throw error;
  }finally{await context.close()}
 }
}finally{await browser?.close();await web?.close();await f.dispose(false)}
