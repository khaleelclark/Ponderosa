import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {serveFixture} from '../shared/serve-ui-fixture.mjs';
const {fixture,until}=await import('../shared/fixture.mjs');
const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');

const f=await fixture();
let web,browser;
try{
 web=await serveFixture(f);
 browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/usr/bin/google-chrome',args:['--no-sandbox']});
 for(const mobile of [false,true]){
  const viewport=mobile?{width:390,height:844}:{width:1440,height:900};
  const context=await browser.newContext({viewport,isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
  const page=await context.newPage();
  page.setDefaultTimeout(15000);
  const errors=[],publicationRequests=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{
   const path=new URL(request.url()).pathname;
   if(request.method()==='POST'&&['/api/branches/preview','/api/branches/deploy'].includes(path))publicationRequests.push(path);
  });
  await page.route('**/*',route=>new URL(route.request().url()).origin===web.origin?route.continue():route.abort());
  const activate=control=>mobile?control.tap():control.click();
  const button=(name,owner=page)=>owner.getByRole('button',{name,exact:true});
  const item=name=>page.getByRole('menuitem',{name,exact:true});
  const tab=name=>page.getByRole('tab',{name,exact:true});
  const branchId=()=>new URL(page.url()).searchParams.get('branch');
  const inspector=page.getByRole(mobile?'dialog':'region',{name:'Workflow inspector',exact:true});
  const back=button('Back to workflow',inspector);
  const add='Add your first step';
  const canvas=page.getByRole('region',{name:'Workflow Canvas',exact:true});
  const outline=page.getByRole('region',{name:'Workflow Outline',exact:true});
  const heading=label=>inspector.getByRole('heading',{name:label,exact:true});
  const read=async path=>f.ok(await f.api('GET',path));
  const write=async(path,value)=>f.ok(await f.api('POST',path,value));
  const picker=page.getByRole('menu').filter({has:item('Notification')});
  async function dismissPicker(){
   await page.keyboard.press('Escape');
   await picker.waitFor({state:'hidden'});
  }
  async function verifyBlank(owner){
   await inspector.waitFor({state:'hidden'});
   await button(add,owner).waitFor();
  }
  try{
   const blank=await write('/api/branches',{name:'Blank destination '+viewport.width,idempotencyKey:randomUUID()});
   await page.goto(web.origin+'/branches?branch='+blank.id);
   await verifyBlank(canvas);
   await activate(button(add,canvas));
   const notification=item('Notification');
   const help='Sends the step’s input to Ponderosa Notifications and subscribed devices.';
   const description=picker.getByText(help,{exact:true});
   await description.waitFor();
   assert.equal(await notification.getAttribute('aria-describedby'),await description.getAttribute('id'));
   if(!mobile){
    await notification.hover();
    assert.equal(await description.isVisible(),true);
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    assert.equal(await notification.evaluate(node=>node===document.activeElement),true);
    assert.equal(await description.isVisible(),true);
    await page.keyboard.press('Enter');
   }else await activate(notification);
   await heading('Step Settings').waitFor();
   assert.doesNotMatch(await inspector.innerText(),/no email|Subscribed devices/i);
   await activate(button('Remove Step',inspector));
   await verifyBlank(canvas);
   await page.waitForFunction(()=>document.activeElement?.textContent==='Add your first step');
   await activate(button('Undo',canvas));
   await canvas.locator('[aria-label="Select Notify Me"]').waitFor();
   await activate(button('Redo',canvas));
   await verifyBlank(canvas);

   await activate(button('Review changes',canvas));
   await picker.waitFor();
   await dismissPicker();
   await activate(tab('Settings'));
   await activate(button(add));
   await picker.waitFor();
   await dismissPicker();
   assert.equal(branchId(),blank.id);
   assert.deepEqual(publicationRequests,[]);
   assert.equal((await read('/api/branches/'+blank.id)).versionId||'','');
   await activate(button(add,canvas));
   await activate(item('Approval'));
   await inspector.getByRole('textbox',{name:'Review Prompt',exact:true}).waitFor();
   await activate(button('Remove Step',inspector));
   await verifyBlank(canvas);

   const name='Published scheduled approval '+viewport.width;
   const branch=await write('/api/branches',{name,idempotencyKey:randomUUID()});
   const path='/api/branches/'+branch.id;
   const definition={schema:'ponderosa.branch.v1',name,trigger:{kind:'schedule',configRef:'schedule'},
    entry:'approve',steps:[{id:'approve',label:'Review request',kind:'human_gate',prompt:'Approve the fixture?',editable:true}],
    controls:[],edges:[],policy:{maxConcurrentExecutions:2,failure:{action:'stop'}},parameters:{title:{type:'text',default:'Weekly report'}}};
   const bindings={agents:{},directories:{},triggers:{schedule:{enabled:true,sourceConfig:{scheduleKind:'interval',everyMs:600000,startsAt:new Date(Date.now()+3600000).toISOString()}}}};
   const input={branchId:branch.id,chatId:'',expectedVersionId:'',definition,bindings};
   const original=await write('/api/branches/deploy',{...input,idempotencyKey:randomUUID()});
   const run=await write(path+'/executions',{input:'Retain this result',occurrenceKey:randomUUID()});
   const runPath='/api/branch-executions/'+run.id;
   await page.goto(web.origin+'/branches?'+new URLSearchParams({branch:branch.id,tab:'executions',execution:run.id}));
   const selected=page.getByRole('region',{name:'Selected Run'});
   await activate(button('Approve',selected));
   await until(async()=>{const detail=await read(runPath);return detail.execution.state==='completed'&&detail;},'Complete the original run');
   const originalVersion=await read(path+'/versions/'+original.versionId);
   const originalTrigger=await read(path+'/trigger');

   await activate(tab('Workflow'));
   await activate(button('Outline'));
   await activate(button('Every 10 minutes',outline));
   const every=inspector.getByRole('spinbutton',{name:'Every'});
   await every.fill('15');
   await inspector.getByText('Draft · Every 15 minutes',{exact:true}).waitFor();
   await activate(back);
   const step=outline.getByRole('button',{name:/^Review request/});
   await activate(step);
   await heading('Step Settings').waitFor();
   await activate(button('Remove Step',inspector));
   await verifyBlank(outline);
   await page.waitForFunction(()=>document.activeElement?.textContent==='Add your first step');
   await activate(button('Undo',outline));
   await step.waitFor();
   await activate(button('Redo',outline));
   await verifyBlank(outline);
   await activate(button('Undo',outline));
   await activate(button('Actions for Review request',outline));
   await activate(item('Remove step'));
   await verifyBlank(outline);

   const overflow=button('Workflow Actions');
   await activate(overflow);
   await activate(item('Edit Workflow JSON…'));
   const draft=JSON.parse(await inspector.getByRole('textbox',{name:'Definition JSON',exact:true}).inputValue());
   assert.deepEqual(draft,{...originalVersion.definition,entry:'',steps:[],controls:[],edges:[]});
   await activate(back);

   await activate(button('Every 15 minutes · Draft',outline));
   assert.equal(await every.inputValue(),'15');
   await activate(back);
   await activate(button('Review changes',outline));
   await picker.waitFor();
   await dismissPicker();

   await activate(tab('Settings'));
   if(mobile)await activate(button('Open Workspace Navigation'));
   await activate(page.getByRole('link',{name:'Open Workflow '+blank.name,exact:true}));
   await heading('Unsaved Changes').waitFor();
   await activate(inspector.getByRole('button',{name:/^Save and leave$/i}));
   await picker.waitFor();
   assert.equal(branchId(),branch.id);
   await dismissPicker();
   await verifyBlank(outline);
   assert.deepEqual(publicationRequests,[]);
   for(const operation of ['preview','deploy']){
    const denied=await f.api('POST','/api/branches/'+operation,{...input,definition:draft,expectedVersionId:original.versionId,idempotencyKey:randomUUID()});
    assert.equal(denied.status,400,JSON.stringify(denied.body));
    assert.match(denied.body.error,/requires 1–100 steps/);
   }
   assert.equal((await read(path)).versionId,original.versionId);
   assert.deepEqual(await read(path+'/versions/'+original.versionId),originalVersion);
   assert.deepEqual(await read(path+'/trigger'),originalTrigger);
   assert.equal((await read(runPath)).execution.output,'Retain this result');
   await activate(button('Run once'));
   await inspector.getByText('Run uses published version '+original.versionId+' · unpublished edits excluded',{exact:true}).waitFor();
   await activate(back);

   await activate(button(add,outline));
   await activate(item('Notification'));
   await heading('Step Settings').waitFor();
   await activate(back);
   await activate(button('Review changes',outline));
   await heading('Review changes').waitFor();
   await inspector.getByText(/After publishing · Every 15 minutes/).waitFor();
   assert.deepEqual(publicationRequests,['/api/branches/preview']);
   assert.deepEqual(errors,[]);
   console.log('PASS '+viewport.width+'×'+viewport.height+' picker help, Canvas and Outline removal, focus, undo/redo, empty publication guards, retained version/run/settings, replacement step review');
  }catch(error){
   console.error(JSON.stringify({viewport,url:page.url(),errors,publicationRequests,visible:(await page.locator('body').innerText()).slice(-2200)}));
   throw error;
  }finally{await context.close()}
 }
}finally{
 await browser?.close();
 await web?.close();
 await f.dispose();
}
