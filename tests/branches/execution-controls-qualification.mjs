import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {serveFixture} from '../shared/serve-ui-fixture.mjs';

const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const {fixture}=await import('../shared/fixture.mjs');
const f=await fixture();
let web,browser;
try{
 web=await serveFixture(f);
 browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/usr/bin/google-chrome',args:['--no-sandbox']});
 const name='Execution control help';
 const branch=f.ok(await f.api('POST','/api/branches',{name,idempotencyKey:randomUUID()}));
 const path='/api/branches/'+branch.id;
 const {versionId}=f.ok(await f.api('POST','/api/branches/deploy',{
  branchId:branch.id,chatId:branch.chatId,expectedVersionId:branch.versionId,idempotencyKey:randomUUID(),
  definition:{schema:'ponderosa.branch.v1',name,trigger:{kind:'manual'},entry:'review',
   steps:[{id:'review',kind:'human_gate',prompt:'Review the fixture.',editable:false}],controls:[],edges:[],
   policy:{maxConcurrentExecutions:3,maxEphemeralAgents:4,maxPathInstances:250,maxStepInvocations:500,failure:{action:'stop'}}},
  bindings:{agents:{},directories:{}},
 }));
 const settings=async()=>f.ok(await f.api('GET',path+'/settings'));
 const budget=async()=>{const {observedAt,...saved}=f.ok(await f.api('GET',path+'/execution-budget'));return saved};
 const initialSettings=await settings(),initialBudget=await budget();
 const staleHelpWidths=[];
 for(const viewport of [{width:1440,height:900},{width:390,height:844},{width:320,height:640}]){
  const mobile=viewport.width<600;
  const context=await browser.newContext({viewport,isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
  try{
   const page=await context.newPage();
   page.setDefaultTimeout(8000);
   const errors=[],branchWrites=[];
   page.on('pageerror',error=>errors.push(error.message));
   await page.route('**/*',route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==web.origin)return route.abort();
    if(request.method()!=='GET'&&[path+'/settings',path+'/execution-budget','/api/branches/preview','/api/branches/deploy'].includes(url.pathname)){
     branchWrites.push([request.method(),url.pathname]);
    }
    return route.continue();
   });
   const activate=control=>mobile?control.tap():control.click();
   await page.goto(web.origin+'/branches?branch='+branch.id+'&tab=settings');
   const execution=page.getByRole('region',{name:'Execution Controls',exact:true});
   const button=name=>execution.getByRole('button',{name,exact:true});
   const number=name=>execution.getByRole('spinbutton',{name,exact:true});
   const details=execution.getByText('How this budget works',{exact:true});
   const examples=execution.getByText('The budget counts automatic runs and calls from other workflows when they start. Run once is exempt.',{exact:true});
   await activate(details);
   await examples.waitFor();
   await activate(details);
   await examples.waitFor({state:'hidden'});
   await activate(button('Advanced execution settings'));
   await execution.getByText('Publish the workflow to apply these changes.',{exact:true}).waitFor();
   await execution.getByText('Local limits',{exact:true}).waitFor();
   const speaker='Pause Automatic Runs When Speaker Role Is Removed';
   const controls=[
    ['Limit Automatic Executions',execution.getByLabel('Limit Automatic Executions',{exact:true}),'Caps how many automatic runs and calls from other workflows can start in each budget period. Run once is exempt.'],
    ['Concurrent Executions',number('Concurrent Executions'),'How many runs of this workflow can do work at the same time. Additional runs wait for room.'],
    ['Temporary Agents Per Execution',number('Temporary Agents Per Execution'),'How many temporary Agents one run can create, including Agents created by a temporary team.'],
    ['Maximum Paths',number('Maximum Paths'),'How many paths one run can create in total, including its starting path, parallel paths, and For Each item paths.'],
    ['Maximum Step Invocations',number('Maximum Step Invocations'),'How many step visits one run can make across its paths. Visiting the same step again in a loop uses another visit.'],
    [speaker,execution.getByLabel(speaker,{exact:true}),'If this workflow’s designated Speaker Agent loses that role, pause new automatic runs.'],
    ['Failure Handling',execution.getByRole('combobox',{name:/^Failure Handling/}),'Choose what to do when a step fails and hasn’t set its own behavior.'],
    ['Nested Branch Depth',number('Nested Branch Depth'),'How many workflows can be called in a chain beneath this one. A direct call is one level.'],
    ['Loop Iterations',number('Loop Iterations'),'How many times a run can follow a loop-back connection in total, including loops in workflows it calls.'],
    ['Graph Traversals',number('Graph Traversals'),'How many times a run can visit steps and routing points in total, including revisits and work in workflows it calls.'],
   ];
   const value=control=>control.evaluate(element=>element.type==='checkbox'?element.checked:element.value??element.textContent);
   const tooltip=page.getByRole('tooltip');
   async function expectHelp(trigger,help){
    await tooltip.getByText(help,{exact:true}).waitFor();
    assert.equal(await trigger.getAttribute('aria-describedby'),await tooltip.getAttribute('id'));
    const bounds=await tooltip.boundingBox();
    assert.ok(bounds.x>=0&&bounds.x+bounds.width<=viewport.width+1&&bounds.y>=0&&bounds.y+bounds.height<=viewport.height+1,
     `Entire help fits the viewport: ${help} ${JSON.stringify(bounds)}`);
   }
   for(const [label,control,help] of controls){
    const before=await value(control);
    assert.equal(await control.evaluate(element=>{
     const label=element.labels?.[0]??element.closest('.MuiFormControl-root')?.querySelector('label');
     return Boolean(label&&label.scrollWidth<=label.clientWidth+1);
    }),true,`${label} remains readable beside its help`);
    const trigger=button('Help for '+label);
    await trigger.evaluate(element=>element.scrollIntoView({block:'center'}));
    if(mobile){
     await trigger.tap();
     await expectHelp(trigger,help);
     const target=await trigger.boundingBox();
     assert.ok(target.width>=44&&target.height>=44);
     await page.touchscreen.tap(3,target.y+target.height/2);
     await tooltip.waitFor({state:'hidden'});
    }else{
     await trigger.hover();
     await expectHelp(trigger,help);
     await page.mouse.move(0,0);
     await tooltip.waitFor({state:'hidden'});
     await control.focus();
     await page.keyboard.press('Tab');
     assert.equal(await trigger.evaluate(element=>document.activeElement===element),true);
     await expectHelp(trigger,help);
     await page.keyboard.press('Escape');
     await tooltip.waitFor({state:'hidden'});
     assert.equal(await trigger.evaluate(element=>document.activeElement===element),true);
    }
    assert.equal(await value(control),before,`${label} changes only when the control itself is edited`);
   }
   if(mobile){
    const paths=number('Maximum Paths'),originalPaths=await paths.inputValue();
    await paths.fill('0');
    await execution.getByText('Enter a whole number from 1 to 100,000.',{exact:true}).waitFor();
    const trigger=button('Help for Maximum Paths');
    await trigger.evaluate(element=>{
     element.scrollIntoView({block:'start'});
     let scroller=element.parentElement;
     while(scroller&&!(scroller.scrollHeight>scroller.clientHeight&&/auto|scroll/.test(getComputedStyle(scroller).overflowY))){
      scroller=scroller.parentElement;
     }
     if(!scroller)throw Error('Expected the Settings scroll container');
     scroller.scrollTop-=4;
    });
    await trigger.tap();
    await expectHelp(trigger,controls[3][2]);
    const cdp=await context.newCDPSession(page);
    const touch=(type,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:y===undefined?[]:[{x:100,y}]});
    try{
     await touch('touchStart',455);
     for(const y of [440,430,420,410,400,390,380,370])await touch('touchMove',y);
     // Hold before release so momentum does not carry the next control offscreen.
     await page.waitForTimeout(220);
     await touch('touchEnd');
    }finally{await cdp.detach()}
    const clippedTooltip=page.locator('[role="tooltip"][data-popper-reference-hidden]');
    await clippedTooltip.waitFor({state:'attached'});
    if(await clippedTooltip.isVisible())staleHelpWidths.push(viewport.width);
    assert.equal(await paths.inputValue(),'0');
    assert.equal(await paths.getAttribute('aria-invalid'),'true');
    await page.touchscreen.tap(3,455);
    await tooltip.waitFor({state:'hidden'});
    await paths.fill(originalPaths);
   }
   const traversals=number('Graph Traversals'),originalTraversals=await traversals.inputValue();
   await traversals.fill('0');
   await execution.getByText('Enter a positive whole number.',{exact:true}).waitFor();
   const validationId=await traversals.getAttribute('aria-describedby');
   const saveLimits=button('Save local limits');
   assert.equal(await saveLimits.isDisabled(),true);
   await activate(button('Help for Graph Traversals'));
   await expectHelp(button('Help for Graph Traversals'),controls.at(-1)[2]);
   assert.equal(await traversals.getAttribute('aria-invalid'),'true');
   assert.equal(await traversals.getAttribute('aria-describedby'),validationId);
   assert.equal(await traversals.inputValue(),'0');
   assert.equal(await saveLimits.isDisabled(),true);
   await traversals.fill(originalTraversals);
   await saveLimits.waitFor({state:'hidden'});
   assert.equal(await button('Save Budget').count(),0);
   assert.deepEqual(branchWrites,[]);
   assert.deepEqual(await settings(),initialSettings);
   assert.deepEqual(await budget(),initialBudget);
   assert.equal(f.ok(await f.api('GET',path)).versionId,versionId);
   assert.deepEqual(errors,[]);
   console.log(`All ten help texts, accessible names, budget disclosure, save/publish distinction and unchanged values passed at ${viewport.width} × ${viewport.height} (${mobile?'tap outside to dismiss':'hover, Tab and Escape'}).`);
  }finally{await context.close()}
 }
 assert.deepEqual(staleHelpWidths,[],'Help must be hidden when the trigger scrolls out of Settings');
}finally{await browser?.close();await web?.close();await f.dispose()}
