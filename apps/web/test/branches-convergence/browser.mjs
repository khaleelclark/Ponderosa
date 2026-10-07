import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {chromium}=createRequire(process.env.PLAYWRIGHT_PACKAGE)('playwright');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
const base=process.env.BRANCHES_TEST_URL??'http://127.0.0.1:21859';
try {
 for(const dark of [false,true])for(const width of [320,375,768,1280]) {
  const page=await browser.newPage({viewport:{width,height:844}});
  await page.goto(`${base}/branches?branch=b&tab=executions${dark?'&dark=1':''}`);
  await page.getByText('Run the deployed workflow',{exact:true}).click();
  await page.getByRole('button',{name:'Run workflow',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Run workflow',exact:true}).isDisabled(),true,'disabled Branch cannot run');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no document overflow');
  if(width<900){
   const opener=page.getByRole('button',{name:'Open workflow navigation',exact:true});
   await opener.click();
   await page.getByRole('button',{name:'Close workspace navigation',exact:true}).click();
   await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Open workflow navigation');
  }
  await page.getByRole('tab',{name:'Parameters',exact:true}).click();
  await page.getByLabel('message',{exact:true}).fill('unsaved');
  page.once('dialog',dialog=>dialog.dismiss());
  await page.getByRole('tab',{name:'Executions',exact:true}).click();
  assert.match(page.url(),/tab=parameters/,'cancelled guard keeps route');
  assert.equal(await page.getByLabel('message',{exact:true}).inputValue(),'unsaved');
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('tab',{name:'Executions',exact:true}).click();
  assert.match(page.url(),/tab=executions/);
  await page.reload();
  await page.getByText('Run the deployed workflow',{exact:true}).click();
  await page.getByRole('button',{name:'Run workflow',exact:true}).waitFor();
  await page.goto(`${base}/branches?branch=b&tab=parameters&failSettings=1`);
  await page.getByRole('button',{name:'Retry configuration',exact:true}).click();
  await page.getByLabel('message',{exact:true}).waitFor();
  console.log(`PASS ${width}px ${dark?'dark':'light'}: disabled run, URL reload, guard, initial failure retry, focus, overflow`);
  await page.close();
 }
 const page=await browser.newPage({viewport:{width:1280,height:844}});
 await page.goto(`${base}/branches?branch=b&tab=chats&chat=c`);
 const composer=page.locator('[contenteditable="true"]').first();
 await composer.waitFor();
 for(const viewport of [{width:375,height:700},{width:375,height:380},{width:640,height:422}]){
  await page.setViewportSize(viewport);
  await composer.waitFor({state:'visible'});
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole('button',{name:/^Branches notifications/}).count(),1,'embedded mobile Chat keeps one product-scoped notification entry point');
  await composer.focus();
  const box=await composer.boundingBox();assert.ok(box&&box.y>=0&&box.y+box.height<=viewport.height,'composer stays inside viewport');
 }
 console.log('PASS Chat height at mobile keyboard size and desktop effective 200% viewport');
 await page.close();

 const navigation=await browser.newPage({viewport:{width:640,height:422}});
 await navigation.goto(`${base}/branches?branch=wrong&execution=e&tab=workflow`);
 await navigation.waitForURL(url=>url.searchParams.get('branch')==='b');
 await navigation.getByRole('heading',{name:'Qualification workflow',exact:true}).waitFor();
 assert.equal(new URL(navigation.url()).searchParams.get('branch'),'b','execution ownership normalizes conflicting Branch URLs');
 await navigation.goto(`${base}/branches?branch=b`);
 await navigation.getByRole('tab',{name:'Executions',exact:true}).click();
 await navigation.waitForURL(url=>url.searchParams.get('execution')==='e');
 await navigation.goBack();
 await navigation.waitForURL(url=>!url.searchParams.get('execution')&&url.searchParams.get('tab')!=='executions');
 await navigation.getByRole('tab',{name:'Chats',exact:true}).click();
 await navigation.waitForURL(url=>url.searchParams.get('chat')==='c');
 await navigation.goBack();
 await navigation.waitForURL(url=>!url.searchParams.get('chat')&&url.searchParams.get('tab')!=='chats');
 await navigation.goto(`${base}/branches?branch=b&tab=chats&emptyChats=1`);
 await navigation.getByText('Create a Chat when this Branch needs persistent Agents.',{exact:false}).waitFor();
 assert.equal(await navigation.getByRole('button',{name:'Open workspace navigation',exact:true}).count(),1,'empty Chats keeps one navigation opener');
 assert.equal(await navigation.getByRole('button',{name:/^Branches notifications/}).count(),1,'mobile Chats keep one product-scoped notification entry point');
 await navigation.goto(`${base}/branches?branch=b&settings=general`);
 assert.equal(await navigation.getByRole('button',{name:'Open workspace navigation',exact:true}).count(),1,'global settings renders one navigation opener');
 assert.equal(await navigation.getByRole('button',{name:/^Branches notifications/}).count(),1,'mobile global settings keeps one product-scoped notification entry point');
 assert.equal(await navigation.getByText('Ponderosa Settings',{exact:true}).count(),2,'single page heading plus navigation-panel label');
 const instructions=navigation.locator('textarea').first();
 await instructions.waitFor();
 await instructions.fill('unsaved global instructions');
 navigation.once('dialog',dialog=>dialog.dismiss());
 await navigation.getByRole('button',{name:'Back to Branches',exact:true}).click();
 assert.equal(new URL(navigation.url()).searchParams.get('settings'),'general','global settings guard keeps the route when discard is canceled');
 const saveDefaults=navigation.getByRole('button',{name:'Save Agent Defaults',exact:true});
 await saveDefaults.scrollIntoViewIfNeeded();
 const saveBox=await saveDefaults.boundingBox();assert.ok(saveBox&&saveBox.y>=0&&saveBox.y+saveBox.height<=422,'settings save remains reachable at effective 200% height');
 assert.equal(await navigation.getByRole('button',{name:'General',exact:false}).first().getAttribute('aria-current'),'page','current settings subsection is announced');
 await navigation.goto(`${base}/branches?branch=b&tab=chats&chat=foreign`);
 await navigation.getByText('This Chat is unavailable or no longer belongs to a Branch.',{exact:true}).waitFor();
 assert.equal(await navigation.getByRole('button',{name:'Open workspace navigation',exact:true}).count(),1,'invalid Chat keeps one navigation opener');
 await navigation.goto(`${base}/branches?branch=b&tab=chats&chat=c&workspace=${encodeURIComponent('/projects/p/agents')}`);
 await navigation.getByRole('heading',{name:'Agent organization',exact:true}).waitFor();
 assert.equal(await navigation.getByRole('button',{name:'Open workspace navigation',exact:true}).count(),1,'embedded Agents keeps one navigation opener');
 await navigation.goto(`${base}/branches?branch=b&tab=chats&execution=e&chat=c`);
 await navigation.waitForURL(url=>!url.searchParams.get('execution'));
 assert.equal(new URL(navigation.url()).searchParams.get('chat'),'c','persistent Chat clears a stale execution owner');
 await navigation.goto(`${base}/branches?branch=b&tab=chats&execution=e&chat=execution-chat`);
 await navigation.waitForURL(url=>url.searchParams.get('execution')==='e2');
 assert.equal(new URL(navigation.url()).searchParams.get('chat'),'execution-chat','temporary Chat canonicalizes to its exact execution');
 console.log('PASS canonical ownership, replace-history defaults, global guards, current semantics, Chat errors, and short settings viewport');
 await navigation.close();

 const unavailable=await browser.newPage({viewport:{width:640,height:422}});
 await unavailable.goto(`${base}/branches?branch=missing&tab=chats`);
 await unavailable.getByText('Branch not found',{exact:true}).waitFor();
 assert.equal(await unavailable.getByRole('button',{name:'Open workflow navigation',exact:true}).count(),1,'missing Branch Chat route keeps product navigation');
 await unavailable.goto(`${base}/branches?branch=b&settings=general&failPreferences=1`);
 await unavailable.getByText('Preferences unavailable',{exact:false}).waitFor();
 assert.equal(await unavailable.getByRole('button',{name:'Open workflow navigation',exact:true}).count(),1,'failed global settings keeps product navigation');
 console.log('PASS missing Branch and failed global-settings navigation fallbacks');
 await unavailable.close();

 const early=await browser.newPage({viewport:{width:640,height:422}});
 await early.goto(`${base}/branches?branch=b&tab=chats&chat=c&slowProjectResources=1`);
 await early.getByRole('button',{name:'Open workspace navigation',exact:true}).waitFor();
 assert.equal(await early.getByRole('button',{name:'Open workspace navigation',exact:true}).count(),1,'ProjectShell loading keeps exactly one navigation opener');
 await early.goto(`${base}/branches?branch=b&tab=chats&chat=c&failProjectResources=1`);
 await early.getByText('The requested resource could not be checked.',{exact:true}).waitFor();
 assert.equal(await early.getByRole('button',{name:'Open workspace navigation',exact:true}).count(),1,'ProjectShell error keeps exactly one navigation opener');
 await early.goto(`${base}/branches?branch=b&tab=chats&chat=c&workspace=${encodeURIComponent('/projects/p/agents')}&failProjectResources=1`);
 assert.equal(await early.getByRole('button',{name:'Open workspace navigation',exact:true}).count(),1,'failed embedded Agents keeps exactly one navigation opener');
 await early.close();

 const pristineDeployment=await browser.newPage({viewport:{width:900,height:700}});
 await pristineDeployment.goto(`${base}/branches?branch=b&backgroundDeploy=1`);
 await pristineDeployment.getByRole('heading',{name:'Deployed workflow',exact:true}).waitFor({timeout:8000});
 assert.equal(await pristineDeployment.getByText('A package update finished while this draft has local edits.',{exact:false}).count(),0,'pristine draft adopts a background deployment');
 await pristineDeployment.close();

 const dirtyDeployment=await browser.newPage({viewport:{width:900,height:700}});
 await dirtyDeployment.goto(`${base}/branches?branch=b&backgroundDeployDirty=1`);
 await dirtyDeployment.getByLabel('Workflow name',{exact:true}).fill('My local workflow edit');
 await dirtyDeployment.getByText('A package update finished while this draft has local edits.',{exact:false}).waitFor({timeout:8000});
 assert.equal(await dirtyDeployment.getByLabel('Workflow name',{exact:true}).inputValue(),'My local workflow edit','background deployment preserves a dirty draft');
 dirtyDeployment.once('dialog',dialog=>dialog.accept());
 await dirtyDeployment.getByRole('button',{name:'Load deployed version',exact:true}).click();
 await dirtyDeployment.getByRole('heading',{name:'Deployed workflow',exact:true}).waitFor();
 await dirtyDeployment.close();

 const scopedDeployment=await browser.newPage({viewport:{width:900,height:700}});
 await scopedDeployment.goto(`${base}/branches?branch=b&backgroundDeployDirty=1`);
 await scopedDeployment.getByLabel('Workflow name',{exact:true}).fill('Scoped local edit');
 await scopedDeployment.getByText('A package update finished while this draft has local edits.',{exact:false}).waitFor({timeout:8000});
 scopedDeployment.once('dialog',dialog=>dialog.accept());
 await scopedDeployment.getByText('Other workflow',{exact:true}).first().click();
 await scopedDeployment.getByRole('heading',{name:'Other workflow',exact:true}).waitFor();
 assert.equal(await scopedDeployment.getByText('A package update finished while this draft has local edits.',{exact:false}).count(),0,'deployment notice is scoped to its Branch');
 await scopedDeployment.close();

 const failedDeployment=await browser.newPage({viewport:{width:900,height:700}});
 await failedDeployment.goto(`${base}/branches?branch=b&backgroundDeploy=1&failBackgroundVersionOnce=1`);
 await failedDeployment.getByText('The package update finished, but the deployed workflow could not be loaded.',{exact:false}).waitFor({timeout:8000});
 await failedDeployment.getByRole('button',{name:'Retry loading',exact:true}).click();
 await failedDeployment.getByRole('heading',{name:'Deployed workflow',exact:true}).waitFor();
 assert.equal(await failedDeployment.getByRole('button',{name:'Retry loading',exact:true}).count(),0,'failed deployment reconciliation remains retryable');
 await failedDeployment.close();

 const latePackage=await browser.newPage({viewport:{width:900,height:700}});
 await latePackage.goto(`${base}/branches?branch=b&slowPackageFinish=1`);
 const portablePackage={schema:'ponderosa.branch-installation.v1',packageId:'late-package',mode:'template',exportedAt:new Date().toISOString(),definition:{schema:'ponderosa.branch.v1',name:'Late package',trigger:{kind:'manual'},parameters:{},entry:'script',steps:[{id:'script',kind:'script',runtime:'node',source:'return input',cwdRef:'workspace',timeoutMs:1000}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}},chats:[],agentBindings:{},limits:{maxCallDepth:100,maxLoopIterations:100,maxTraversals:100}};
 await latePackage.getByText('Apply package update…',{exact:true}).locator('input[type=file]').setInputFiles({name:'late.ponderosa.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(portablePackage))});
 await latePackage.getByRole('button',{name:'Review changes',exact:true}).click();
 await latePackage.getByRole('button',{name:'Confirm update',exact:true}).waitFor();
 await latePackage.getByRole('button',{name:'Confirm update',exact:true}).click();
 await latePackage.getByText('This update is completed.',{exact:false}).waitFor();
 await latePackage.getByRole('button',{name:'Close',exact:true}).click();
 await latePackage.getByText('Other workflow',{exact:true}).first().click();
 await latePackage.getByRole('heading',{name:'Other workflow',exact:true}).waitFor();
 await latePackage.getByLabel('Workflow name',{exact:true}).fill('Protected other workflow edit');
 await latePackage.waitForTimeout(1800);
 assert.equal(new URL(latePackage.url()).searchParams.get('branch'),'b2','dismissed package completion cannot navigate back to its Branch');
 assert.equal(await latePackage.getByLabel('Workflow name',{exact:true}).inputValue(),'Protected other workflow edit','dismissed package completion cannot replace another Branch draft');
 console.log('PASS dismissed package completion is fenced from later navigation and edits');
 await latePackage.close();

 const rollover=await browser.newPage({viewport:{width:900,height:700}});
 await rollover.goto(`${base}/branches?branch=b&settings=general&slowRollover=1`);
 const tokens=rollover.getByLabel('Roll over above (context tokens)',{exact:true}),saveRollover=rollover.getByRole('button',{name:'Save Rollover Limits',exact:true});
 await tokens.fill('180000');await saveRollover.click();await rollover.getByRole('button',{name:'Saving Rollover Limits…',exact:true}).waitFor();await tokens.fill('190000');await rollover.getByRole('button',{name:'Save Rollover Limits',exact:true}).waitFor();assert.equal(await tokens.inputValue(),'190000','edits made during a delayed save remain');
 await rollover.goto(`${base}/branches?branch=b&settings=general&rejectRollover=1`);await rollover.getByLabel('Roll over above (context tokens)',{exact:true}).fill('175000');await rollover.getByRole('button',{name:'Save Rollover Limits',exact:true}).click();await rollover.getByText('Rollover save rejected',{exact:true}).waitFor();assert.equal(await rollover.getByLabel('Roll over above (context tokens)',{exact:true}).inputValue(),'175000','failed save keeps the draft');
 await rollover.close();

 const creation=await browser.newPage({viewport:{width:640,height:600}});
 await creation.goto(`${base}/branches?branch=b&tab=chats&emptyChats=1`);
 await creation.getByRole('button',{name:'Chat actions',exact:true}).click();
 await creation.getByRole('menuitem',{name:'Create Chat',exact:true}).click();
 await creation.getByLabel('Chat name',{exact:true}).fill('Created through contract');
 await creation.getByRole('button',{name:'Create Chat',exact:true}).click();
 await creation.waitForURL(url=>url.searchParams.get('chat')==='created-chat');
 await creation.locator('[contenteditable="true"]').first().waitFor();
 assert.match(decodeURIComponent(new URL(creation.url()).searchParams.get('workspace')??''),/projects\/p\/chats\/created-chat/,'ConversationDto projectId and id drive the new Chat route');
 console.log('PASS Branch Chat ConversationDto creation contract and ProjectShell early-state navigation');
 await creation.close();

 const accessibility=await browser.newPage({viewport:{width:900,height:844}});
 await accessibility.goto(`${base}/branches?branch=b&tab=workflow`);
 const assertTabPanels=async()=>assert.deepEqual(await accessibility.getByRole('tablist',{name:'Branch views',exact:true}).getByRole('tab').evaluateAll(tabs=>tabs.map(tab=>({controls:tab.getAttribute('aria-controls'),mounted:Boolean(document.getElementById(tab.getAttribute('aria-controls')??''))}))),[
  {controls:'branch-panel-0',mounted:true},
  {controls:'branch-panel-3',mounted:true},
  {controls:'branch-panel-1',mounted:true},
  {controls:'branch-panel-4',mounted:true},
  {controls:'branch-panel-2',mounted:true},
 ],'every Branch tab controls a mounted panel');
 await assertTabPanels();
 const soleRemove=accessibility.getByRole('button',{name:'Remove step',exact:true});
 assert.equal(await soleRemove.isDisabled(),true,'the required final Step cannot be removed');
 assert.equal(await soleRemove.getAttribute('aria-describedby'),'remove-step-requirement','the disabled removal explains the requirement');
 await accessibility.getByRole('button',{name:'Add step',exact:true}).click();
 await accessibility.getByRole('button',{name:'Remove step',exact:true}).click();
 await accessibility.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Select script');
 assert.equal(await accessibility.getByRole('button',{name:'Select script',exact:true}).count(),1,'removal retains the original Step');
 assert.equal(await accessibility.getByRole('button',{name:'Remove step',exact:true}).isDisabled(),true,'removal returns to a valid one-Step graph');
 await accessibility.getByRole('tab',{name:'Workflow',exact:true}).focus();
 await accessibility.keyboard.press('ArrowRight');
 assert.equal(await accessibility.evaluate(()=>document.activeElement?.textContent),'Chats','keyboard navigation moves to the next Branch tab');
 await accessibility.keyboard.press('Enter');
 await accessibility.waitForFunction(()=>new URL(location.href).searchParams.get('tab')==='chats');
 await assertTabPanels();
 await accessibility.getByRole('tab',{name:'Settings',exact:true}).click();
 await accessibility.getByRole('tablist',{name:'Workflow settings sections',exact:true}).waitFor();
 assert.equal(await accessibility.locator('aside[aria-label="Workflow settings"]').count(),0,'Branch settings do not add a second sidebar');
 for(const width of [320,768,900]){
  await accessibility.setViewportSize({width,height:844});
  const settingsWidth=(await accessibility.locator('#branch-panel-2 .MuiPaper-root').first().boundingBox())?.width??0;
  assert.ok(settingsWidth>Math.min(width-64,350),`settings content remains usable at ${width}px (${settingsWidth}px)`);
  assert.ok(await accessibility.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${width}px settings view has no document overflow`);
 }
 await assertTabPanels();
 console.log('PASS required Step removal, deterministic focus, mounted tab panels, keyboard tabs, and single-sidebar settings from 320px through 900px');
 await accessibility.close();

 const dataflow=await browser.newPage({viewport:{width:1280,height:844}});
 await dataflow.goto(`${base}/branches?branch=b&tab=workflow`);
 await dataflow.getByLabel('Add after selected').click();
 await dataflow.getByRole('option',{name:'For Each item'}).click();
 await dataflow.getByRole('button',{name:'Add step',exact:true}).click();
 await dataflow.getByLabel('Items from previous result').waitFor();
 assert.equal(await dataflow.getByLabel('Maximum items').inputValue(),'100');
 await dataflow.getByLabel('Maximum items').fill('25');
 await dataflow.getByLabel('Concurrent items').fill('3');
 await dataflow.getByRole('button',{name:'Select Review item'}).click();
 assert.equal(await dataflow.getByRole('button',{name:'Add step',exact:true}).isDisabled(),true);
 assert.equal(await dataflow.getByRole('button',{name:'Add condition',exact:true}).isDisabled(),true);
 assert.equal(await dataflow.getByRole('button',{name:'Add route',exact:true}).isDisabled(),true);
 assert.equal(await dataflow.getByLabel('After success').count(),0);
 assert.equal(await dataflow.getByLabel('After failure').count(),0);
 assert.equal(await dataflow.getByText('Path inputs and loops').count(),0);
 await dataflow.getByText('Each item returns directly to its paired Join.').waitFor();
 await dataflow.getByRole('combobox',{name:/For Each worker type/}).click();
 await dataflow.getByRole('option',{name:'Script',exact:true}).click();
 await dataflow.getByRole('textbox',{name:'Script',exact:true}).waitFor();
 await dataflow.getByRole('combobox',{name:/For Each worker type/}).click();
 await dataflow.getByRole('option',{name:'Run Branch',exact:true}).click();
 assert.equal(await dataflow.getByLabel('After success').count(),0);
 assert.equal(await dataflow.getByLabel('After failure').count(),0);
 assert.equal(await dataflow.getByLabel('After canceled').count(),0);
 assert.equal(await dataflow.getByText('Path inputs and loops').count(),0);
 await dataflow.getByRole('button',{name:'Select Wait for items'}).click();
 await dataflow.getByLabel('Continue after').waitFor();
 await dataflow.getByLabel('If the required number cannot succeed').waitFor();
 assert.ok(await dataflow.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'For Each editor has no desktop document overflow');
 console.log('PASS For Each authoring, worker selection, Join controls, and editor bounds');
 await dataflow.close();
}finally{await browser.close()}
