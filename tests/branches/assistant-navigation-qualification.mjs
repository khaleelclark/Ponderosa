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
  await page.goto(origin+corePath);const editor=page.getByLabel('Message',{exact:true});await editor.waitFor();
  await editor.fill('Keep this Core draft');await page.screenshot({path:path.join(output,label+'-core-before.png')});
  if(phone)await page.getByRole('button',{name:'Open workspace navigation',exact:true}).click();
  const assistant=page.getByRole('link',{name:'Assistant',exact:true});await assistant.waitFor();
  const nav=await assistant.boundingBox();assert(nav&&nav.height>=44,'Assistant has a full touch target');
  if(!phone){const inbox=await page.getByRole('button',{name:'Inbox',exact:true}).boundingBox();assert(Math.abs(nav.y-inbox.y)<1,'Assistant is aligned with Inbox');}
  await page.screenshot({path:path.join(output,label+'-navigation.png')});await assistant.click();
  await page.getByRole('heading',{name:'Assistant',exact:true}).waitFor();
  const direct=page.getByLabel('Message',{exact:true});await direct.waitFor();
  assert.equal(new URL(page.url()).pathname,'/branches');assert.equal(new URL(page.url()).searchParams.get('assistant'),'1');
  assert.equal(await page.locator('iframe').count(),0,'Assistant is actual React in the main workspace');
  assert.equal(await page.getByRole('tab',{name:'Workflow',exact:true}).count(),0,'Assistant has no workflow editor tabs');
  assert.equal(await page.getByRole('tab',{name:'Subagents',exact:true}).count(),0,'Assistant has no Agent audit tabs');
  if(!phone){
   f.plans.set(app.agentId,[{run:async session=>{assert.equal((await session.tool('ponderosa_message',{text:'Let’s keep it simple. A walk in the morning, lunch somewhere familiar, and an open afternoon. What would you most like to make time for?'})).success,true);}}]);
   await direct.fill('Help me plan a quiet weekend. I’d like a little time outside.');
   await page.getByRole('button',{name:'Send message',exact:true}).click();
   await page.getByText('Let’s keep it simple.',{exact:false}).waitFor();
  }
  await direct.fill('Keep this Assistant draft');
  const geometry=await direct.boundingBox();assert(geometry.y>=(phone?650:680),'Composer remains grounded near the bottom of the viewport');
  if(phone){const heading=await page.getByRole('heading',{name:'Assistant',exact:true}).boundingBox();assert(heading.width>=70,'Phone contact title is readable');}
  assert.equal(await page.getByText(/Assistant worked for/).count(),0,'Completed work receipts do not interrupt a simple direct conversation');await page.screenshot({path:path.join(output,label+'-assistant.png')});
  await page.getByRole('link',{name:'Back to your Chat',exact:true}).click();await editor.waitFor();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Message"]')?.textContent==='Keep this Core draft');
  assert.equal(new URL(page.url()).pathname,corePath);row.exactReturn=true;
  // Open again, then native browser Back. Both scoped drafts must remain separate.
  if(phone)await page.getByRole('button',{name:'Open workspace navigation',exact:true}).click();
  await page.getByRole('link',{name:'Assistant',exact:true}).click();await direct.waitFor();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Message"]')?.textContent==='Keep this Assistant draft');row.assistantDraft=true;
  await page.goBack();await editor.waitFor();await page.waitForFunction(()=>document.querySelector('[aria-label="Message"]')?.textContent==='Keep this Core draft');row.browserBack=true;
  await page.screenshot({path:path.join(output,label+'-returned-chat.png')});
  assert.deepEqual(row.errors,[]);assert.deepEqual(row.failedApi,[]);
  // The full cause remains reachable without turning a transient failure into a wall of text.
  await page.route('**/api/branches/assistant',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Synthetic Assistant refresh failure. '+('Full controlled cause. '.repeat(100)),error:'Synthetic Assistant refresh failure. '+('Full controlled cause. '.repeat(100))})}));
  await page.goto(origin+'/branches?assistant=1');
  await page.getByText('Assistant could not be opened.',{exact:true}).waitFor();
  const details=page.locator('details').filter({hasText:'Full controlled cause'});await details.waitFor();assert.equal(await details.getAttribute('open'),null);
  await details.locator('summary').click();await details.locator('pre').waitFor();row.fullErrorReachable=true;
  await details.locator('summary').click();await page.screenshot({path:path.join(output,label+'-assistant-retry.png')});
  row.expectedRetryFailures=row.failedApi.splice(0);await context.close();
 }
 await writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,results,limit:'Controlled Chromium desktop and phone-sized touch viewport; no physical iPhone or native audio.'},null,2));
 console.log(JSON.stringify({passed:true,output,results}));
}finally{await browser?.close();await f.dispose();}
