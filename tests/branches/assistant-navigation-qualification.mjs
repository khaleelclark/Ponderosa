// Real built renderer and real security headers; synthetic owned data and inert provider only.
import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture,until} from '../shared/fixture.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const output=process.env.QUALIFICATION_DIRECTORY??'/tmp/ponderosa-assistant-navigation';await mkdir(output,{recursive:true});
const f=await fixture({webDist:path.join(root,'apps/web/dist')});let browser;
const results=[];
async function waitForClosedDrawer(page){
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('.MuiBackdrop-root')).every(node=>{const style=getComputedStyle(node);return style.opacity==='0'||style.visibility==='hidden'||style.pointerEvents==='none';})&&Array.from(document.querySelectorAll('.MuiDrawer-paper')).every(node=>{const rect=node.getBoundingClientRect();return rect.right<=.5||getComputedStyle(node).visibility==='hidden';}));
}
try{
 const core=await f.createChat('Weekend planning');await f.createIdleAgent(core,'Planning partner');
 const app=f.ok(await f.api('POST','/api/branches/assistant',{initialize:true})).app;
 const origin=await f.listen();const corePath=`/projects/${core.projectId}/chats/${core.id}`;
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
 for(const phone of [false,true]){
  const label=phone?'phone':'desktop',row={label,errors:[],failedApi:[]};results.push(row);
  const context=await browser.newContext({viewport:phone?{width:390,height:844}:{width:1365,height:900},isMobile:phone,hasTouch:phone,serviceWorkers:'block',recordVideo:{dir:path.join(output,label+'-video')}});
  const page=await context.newPage();page.setDefaultTimeout(20000);
  page.on('pageerror',error=>row.errors.push(error.message));
  page.on('response',response=>{if(response.url().includes('/api/')&&response.status()>=400)row.failedApi.push({url:response.url(),status:response.status()});});
  if(process.env.COMPOSER_SCALE_ONLY==='1'){
   row.composerScales=[];
   await page.goto(origin+'/assistant');const editor=page.getByLabel('Message',{exact:true});await editor.waitFor();
   const inspect=async(stage,scale)=>{
    const geometry=await page.locator('.ponderosa-composer').evaluate(root=>{
     const box=element=>{if(!element)return null;const r=element.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};};
     const editor=root.querySelector('.composer-editor-input'),placeholder=Array.from(root.querySelectorAll('span')).find(element=>element.textContent==='Message Assistant directly');
     const toolbar=root.querySelector('[data-composer-toolbar]');
     const toolbarButtons=Array.from(toolbar.querySelectorAll('button')).map(box).filter(rect=>rect.width&&rect.height);
     const toolbarBox=toolbarButtons.length?{top:Math.min(...toolbarButtons.map(rect=>rect.top)),bottom:Math.max(...toolbarButtons.map(rect=>rect.bottom))}:box(toolbar);
     return {editor:box(editor),placeholder:box(placeholder),toolbar:toolbarBox,rootFont:getComputedStyle(document.documentElement).fontSize,editorFont:getComputedStyle(editor).fontSize,editorScrollHeight:editor.scrollHeight,buttons:Array.from(root.querySelectorAll('button[aria-label]')).filter(button=>button.getClientRects().length).map(button=>({label:button.getAttribute('aria-label'),...box(button)}))};
    });
    row.composerScales.push({stage,scale,geometry});await writeFile(path.join(output,label+'-geometry.json'),JSON.stringify(row.composerScales,null,2));
    await page.screenshot({path:path.join(output,`${label}-${scale}-${stage}.png`)});
    assert.equal(geometry.rootFont,scale===200?'32px':'16px','User font scaling remains intact');
    assert(geometry.editor.bottom<=geometry.toolbar.top+.5,'Editor and toolbar occupy separate rows');
    if(geometry.placeholder)assert(geometry.placeholder.bottom<=geometry.toolbar.top+.5,'Wrapped placeholder reserves its full height before the toolbar');
    for(const button of geometry.buttons)assert(button.width>=44&&button.height>=44,`${button.label} keeps a 44px target`);
    return geometry;
   };
   for(const scale of [100,200]){
    await page.evaluate(scale=>{localStorage.setItem('ponderosa.text-size.v1',String(scale));window.dispatchEvent(new Event('ponderosa:text-size'));},scale);
    await page.waitForFunction(scale=>getComputedStyle(document.documentElement).fontSize===(scale===200?'32px':'16px'),scale);
    await editor.click();await page.keyboard.press('Control+A');await page.keyboard.press('Backspace');await page.getByText('Message Assistant directly',{exact:true}).waitFor();
    await inspect('empty',scale);
    const before=f.turns.length;await page.keyboard.type('First line');await page.keyboard.press('Shift+Enter');await page.keyboard.type('Second line');await page.keyboard.press('Shift+Enter');await page.keyboard.type('Third line');
    await editor.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});assert.equal(f.turns.length,before,'IME Enter does not send the draft');
    await page.waitForFunction(()=>document.querySelector('[aria-label="Message"]')?.textContent?.includes('Third line'));
    await inspect('multiline',scale);
    await page.waitForFunction(()=>Object.keys(localStorage).some(key=>key.startsWith('ponderosa.chat.v1.draft.')&&localStorage.getItem(key)?.includes('Third line')));
    await page.reload();await editor.waitFor();await page.waitForFunction(()=>document.querySelector('[aria-label="Message"]')?.textContent?.includes('Third line'));row.draftPreserved=true;
    await editor.click();await page.keyboard.press('Control+A');await page.keyboard.press('Backspace');await page.getByText('Message Assistant directly',{exact:true}).waitFor();await inspect('cleared',scale);
    if(phone&&scale===200){
     f.plans.set(app.agentId,[{run:async session=>{assert.equal((await session.tool('ponderosa_message',{text:'Scaled composer message received.'})).success,true);}}]);
     await editor.click();await page.keyboard.type('Send from the scaled composer');await page.getByRole('button',{name:'Send Message',exact:true}).click();await page.getByText('Scaled composer message received.',{exact:true}).waitFor();await page.getByText('Message Assistant directly',{exact:true}).waitFor();row.scaledSend=true;
    }
   }
   assert.deepEqual(row.errors,[]);assert.deepEqual(row.failedApi,[]);await context.close();continue;
  }
  if(process.env.ASSISTANT_ENTRY_ALIAS_ONLY==='1'){
   const startupApi=[];page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/api/'))startupApi.push(url.pathname);});
   await page.goto(origin+'/assistant?returnTo='+encodeURIComponent(corePath));
   await page.getByRole('heading',{name:'Assistant',exact:true}).waitFor();await page.getByLabel('Message',{exact:true}).waitFor();
   const target=new URL(page.url());assert.equal(target.pathname,'/assistant');assert.equal(target.searchParams.get('returnTo'),corePath);
   assert.equal(startupApi.some(path=>/^\/api\/(?:projects|conversations|agents)(?:\/|$)/.test(path)),true,'Ponderosa navigation keeps its Core resource queries');
   assert.equal(startupApi.some(path=>path.startsWith('/api/branches/engine/')),true,'Assistant keeps its canonical Branch engine transport');
   if(phone)await page.getByRole('button',{name:'Open Workspace Navigation',exact:true}).click();
   const navigation=page.locator('aside[aria-label="Workspace Navigation"]:visible');await navigation.waitFor();
   if(phone)await page.waitForFunction(()=>{const element=Array.from(document.querySelectorAll('aside[aria-label="Workspace Navigation"]')).find(element=>element.getClientRects().length);const rect=element?.getBoundingClientRect();return rect&&rect.left>=-.5&&rect.right<=innerWidth+.5;});
   await navigation.getByRole('link',{name:'Assistant',exact:true}).waitFor();await navigation.getByRole('button',{name:'Inbox',exact:true}).waitFor();
   assert.equal(await page.locator('iframe').count(),0);row.directAliasIntegrated=true;await page.screenshot({path:path.join(output,label+'-direct-assistant-navigation.png')});
   if(phone){await page.getByRole('button',{name:'Close Workspace Navigation',exact:true}).click();await navigation.waitFor({state:'hidden'});await waitForClosedDrawer(page);await page.screenshot({path:path.join(output,label+'-direct-assistant.png')});}
   await page.goto(origin+corePath);await page.getByLabel('Message',{exact:true}).waitFor();
   await page.goto(origin+'/assistant');await page.getByRole('heading',{name:'Assistant',exact:true}).waitFor();
   await page.goBack();await page.getByLabel('Message',{exact:true}).waitFor();assert.equal(new URL(page.url()).pathname,corePath);row.noAliasHistoryEntry=true;
   await page.goto(origin+app.url);await page.getByLabel('Message',{exact:true}).waitFor();assert.equal(new URL(page.url()).pathname,app.url);assert.equal(await page.locator('aside[aria-label="Branches Navigation"]').count(),0);row.designatedAppStandalone=true;
   await page.screenshot({path:path.join(output,label+'-designated-output-app.png')});assert.deepEqual(row.errors,[]);assert.deepEqual(row.failedApi,[]);await context.close();continue;
  }
  // The shared settings view must expose Assistant configuration only in Ponderosa.
  await page.goto(origin+'/settings/general');
  await page.getByRole('heading',{name:'Settings',exact:true}).waitFor();
  await page.locator('.settings-group').getByRole('button',{name:'Assistant',exact:true}).waitFor();row.coreAssistantSettings=true;
  await page.goto(origin+'/branches?settings=general');
  await page.getByRole('heading',{name:'Settings',exact:true}).waitFor();
  assert.equal(await page.locator('.settings-group').getByRole('button',{name:'Assistant',exact:true}).count(),0,'Branches General Settings must not mount Ponderosa Assistant controls');row.branchAssistantSettingsAbsent=true;
  await page.goto(origin+corePath);const editor=page.getByLabel('Message',{exact:true});await editor.waitFor();
  await editor.fill('Keep this Core draft');await page.screenshot({path:path.join(output,label+'-core-before.png')});
  if(phone)await page.getByRole('button',{name:'Open Workspace Navigation',exact:true}).click();
  const assistant=page.getByRole('link',{name:'Assistant',exact:true});await assistant.waitFor();
  const nav=await assistant.boundingBox();assert(nav&&nav.height>=44,'Assistant has a full touch target');
  if(!phone){const inbox=await page.getByRole('button',{name:'Inbox',exact:true}).boundingBox();assert(nav.width>inbox.width*2,'Assistant owns a full-width navigation row');}
  if(phone)await page.waitForFunction(()=>{const node=Array.from(document.querySelectorAll('aside[aria-label="Workspace Navigation"]')).find(el=>el.getClientRects().length);const rect=node?.getBoundingClientRect();return rect&&rect.left>=-.5&&rect.right<=innerWidth+.5;});
  await page.screenshot({path:path.join(output,label+'-navigation.png')});await assistant.click();
  if(phone)await waitForClosedDrawer(page);
  await page.getByRole('heading',{name:'Assistant',exact:true}).waitFor();
  const direct=page.getByLabel('Message',{exact:true});await direct.waitFor();
  assert.equal(new URL(page.url()).pathname,'/assistant');
  assert.equal(await page.locator('iframe').count(),0,'Assistant is actual React in the main workspace');
  assert.equal(await page.locator('aside[aria-label="Branches Navigation"]').count(),0,'Assistant never mounts the Branches drawer');
  assert.equal(await page.getByText('Provider Usage',{exact:true}).count(),phone?0:1,'Assistant owns the desktop provider usage control without a duplicate Core header');
  assert.equal(await page.getByRole('tab',{name:'Workflow',exact:true}).count(),0,'Assistant has no workflow editor tabs');
  assert.equal(await page.getByRole('tab',{name:'Subagents',exact:true}).count(),0,'Assistant has no Agent audit tabs');
  if(!phone){
   f.plans.set(app.agentId,[{run:async session=>{assert.equal((await session.tool('ponderosa_message',{text:'Let’s keep it simple. A walk in the morning, lunch somewhere familiar, and an open afternoon. What would you most like to make time for?'})).success,true);}}]);
   await direct.fill('Help me plan a quiet weekend. I’d like a little time outside.');
   await page.getByRole('button',{name:'Send Message',exact:true}).click();
   await page.getByText('Let’s keep it simple.',{exact:false}).waitFor();
  }
  await direct.fill('Keep this Assistant draft');
  const geometry=await direct.boundingBox();assert(geometry.y>=(phone?650:680),'Composer remains grounded near the bottom of the viewport');
  if(phone){const heading=await page.getByRole('heading',{name:'Assistant',exact:true}).boundingBox();assert(heading.width>=70,'Phone contact title is readable');}
  assert.equal(await page.getByText(/Assistant Worked For/).count(),0,'Completed work receipts do not interrupt a simple direct conversation');await page.screenshot({path:path.join(output,label+'-assistant.png')});
  if(phone){
   await page.getByRole('button',{name:'Open Workspace Navigation',exact:true}).click();
   await page.waitForFunction(()=>{const node=Array.from(document.querySelectorAll('aside[aria-label="Workspace Navigation"]')).find(el=>el.getClientRects().length);const rect=node?.getBoundingClientRect();return rect&&rect.left>=-.5&&rect.right<=innerWidth+.5;});
   const active=page.getByRole('link',{name:'Assistant',exact:true});assert.equal(await active.getAttribute('aria-current'),'page');
   await page.screenshot({path:path.join(output,label+'-assistant-navigation.png')});
   await page.getByRole('button',{name:'Close Workspace Navigation',exact:true}).click();await waitForClosedDrawer(page);
  }
  await page.getByRole('link',{name:'Back To Your Chat',exact:true}).click();await editor.waitFor();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Message"]')?.textContent==='Keep this Core draft');
  assert.equal(new URL(page.url()).pathname,corePath);row.exactReturn=true;
  // Open again, then native browser Back. Both scoped drafts must remain separate.
  if(phone)await page.getByRole('button',{name:'Open Workspace Navigation',exact:true}).click();
  await page.getByRole('link',{name:'Assistant',exact:true}).click();await direct.waitFor();
  if(phone)await waitForClosedDrawer(page);
  await page.waitForFunction(()=>document.querySelector('[aria-label="Message"]')?.textContent==='Keep this Assistant draft');row.assistantDraft=true;
  await page.goBack();await editor.waitFor();await page.waitForFunction(()=>document.querySelector('[aria-label="Message"]')?.textContent==='Keep this Core draft');row.browserBack=true;
  await page.screenshot({path:path.join(output,label+'-returned-chat.png')});
  assert.deepEqual(row.errors,[]);assert.deepEqual(row.failedApi,[]);
  // The full cause remains reachable without turning a transient failure into a wall of text.
  await page.route('**/api/branches/assistant',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Synthetic Assistant refresh failure. '+('Full controlled cause. '.repeat(100)),error:'Synthetic Assistant refresh failure. '+('Full controlled cause. '.repeat(100))})}));
  await page.goto(origin+'/branches?assistant=1');assert.equal(new URL(page.url()).pathname,'/assistant','Legacy Assistant bookmark stays in Ponderosa');
  await page.getByText('Assistant could not be opened.',{exact:true}).waitFor();
  const details=page.locator('#main-content details').filter({hasText:'Full controlled cause'});await details.waitFor();assert.equal(await details.getAttribute('open'),null);
  await details.locator('summary').click();await details.locator('pre').waitFor();row.fullErrorReachable=true;
  await details.locator('summary').click();await page.screenshot({path:path.join(output,label+'-assistant-retry.png')});
  row.expectedRetryFailures=row.failedApi.splice(0);await context.close();
 }
 await writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,results,limit:'Controlled Chromium desktop and phone-sized touch viewport; no physical iPhone or native audio.'},null,2));
 console.log(JSON.stringify({passed:true,output,results}));
}finally{await browser?.close();await f.dispose();}
