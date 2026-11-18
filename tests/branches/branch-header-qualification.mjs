// Real built renderer, disposable canonical Branch data, inert provider only.
import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture,until} from '../shared/fixture.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const output=process.env.QUALIFICATION_DIRECTORY??'/tmp/ponderosa-branch-header';
const compact=process.env.EXPECT_COMPACT_BRANCH_HEADER!=='0';
await mkdir(output,{recursive:true});
const f=await fixture({webDist:path.join(root,'apps/web/dist')});let browser;
const results=[];
try {
 const branch=f.ok(await f.api('POST','/api/branches',{name:'Weekly briefing',idempotencyKey:randomUUID()}));
 const createChat=label=>f.api('POST',`/api/branches/${branch.id}/chats`,{label,defaultEngine:'codex'},{'idempotency-key':randomUUID()}).then(f.ok);
 const filled=await createChat('Briefing conversation'),empty=await createChat('Quiet conversation');
 const agent=f.ok(await f.api('POST',`/api/branches/engine/projects/${filled.projectId}/agents`,{title:'Briefing partner',engine:'codex',conversationId:filled.id,idempotencyKey:randomUUID()}));
 f.ok(await f.api('POST',`/api/branches/engine/conversations/${filled.id}/messages`,{text:'A short synthetic briefing for this week.',idempotencyKey:randomUUID()}));
 await until(async()=>f.ok(await f.api('GET',`/api/branches/engine/conversations/${filled.id}`)).messages.some(message=>message.text.includes('A short synthetic briefing for this week.')),'canonical populated Chat');
 f.ok(await f.api('POST','/api/branches/assistant',{initialize:true}));
 const origin=await f.listen();
 const route=(chat,workspace)=>'/branches?'+new URLSearchParams({branch:branch.id,tab:'chats',chat:chat.id,...(workspace?{workspace}:{})});
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
 for(const phone of [false,true]) {
  const label=phone?'phone':'desktop',row={label,errors:[],failedApi:[],scenes:[]};results.push(row);
  const context=await browser.newContext({viewport:phone?{width:390,height:844}:{width:1365,height:900},isMobile:phone,hasTouch:phone,serviceWorkers:'block',recordVideo:{dir:path.join(output,label+'-video')}});
  const page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('pageerror',error=>row.errors.push(error.message));
  page.on('response',response=>{if(response.url().includes('/api/')&&response.status()>=400)row.failedApi.push({url:response.url(),status:response.status()});});
  const picker=()=>page.getByRole('combobox',{name:phone&&compact?'Current Chat':'Chat',exact:true});
  const capture=async(name,chat,expectChatHeading=true)=>{
   await page.getByLabel('Message',{exact:true}).waitFor();
   await page.getByRole('heading',{name:'Weekly briefing',exact:true}).waitFor();
   assert.equal(await picker().inputValue(),chat.title);
   if(expectChatHeading)assert.equal(await page.getByRole('heading',{name:chat.title,exact:true}).count(),phone&&compact?0:1,'Selected Chat has one identity on mobile');
   const geometry=await page.locator('[data-workspace-header]:visible').evaluateAll(elements=>elements.map(element=>{const r=element.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};}));
   const field=await picker().evaluate(element=>{const r=element.closest('.MuiInputBase-root').getBoundingClientRect();return {width:r.width,height:r.height,top:r.top,bottom:r.bottom};});
   row.scenes.push({name,geometry,field});
   if(phone&&compact&&expectChatHeading){assert(field.height>=44,'Current Chat field retains44px height');assert(field.width>=220,'Current Chat remains readable across the header');assert(geometry.at(-1).bottom<=170,'Conversation begins below compact combined chrome');}
   await page.screenshot({path:path.join(output,label+'-'+name+'.png')});
  };
  await page.goto(origin+route(filled));await page.getByText('A short synthetic briefing for this week.',{exact:false}).waitFor();await capture('populated',filled);
  await picker().click();await page.getByRole('option',{name:empty.title,exact:true}).waitFor();await page.screenshot({path:path.join(output,label+'-switcher.png')});await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('listbox').count(),0,'Escape dismisses the picker');assert.equal(await picker().evaluate(element=>document.activeElement===element),true,'Escape retains picker keyboard focus');row.pickerCancelFocus=true;
  await picker().click();await page.getByRole('option',{name:empty.title,exact:true}).click();await picker().blur();await capture('empty',empty);
  await page.goBack();await page.getByText('A short synthetic briefing for this week.',{exact:false}).waitFor();await capture('back',filled);row.switchAndBack=true;
  for(const name of ['Chat','Team Chat','Files & Results','Agents'])assert.equal(await page.getByRole('tab',{name,exact:true}).count(),1,'Chat views remain reachable');
  const editor=page.getByLabel('Message',{exact:true});await editor.fill('Retain this Branch draft');
  let heldRequest;const creationPattern='**/api/branches/'+branch.id+'/chats';
  await page.route(creationPattern,route=>{if(route.request().method()==='POST'){heldRequest=route;return;}return route.continue();});
  if(phone&&compact)await picker().click();await page.getByRole('button',{name:'New Chat',exact:true}).click();
  await page.getByLabel('Opening New Chat',{exact:true}).waitFor();await until(()=>heldRequest,'held synthetic creation request');
  await page.getByRole('button',{name:'Back',exact:true}).click();await picker().waitFor();assert.equal(await picker().inputValue(),filled.title);
  await heldRequest.abort();await page.unroute(creationPattern);row.pendingCreationBack=true;
  await page.waitForFunction(()=>document.querySelector('[aria-label="Message"]')?.textContent?.includes('Retain this Branch draft'));row.branchDraftPreserved=true;
  if(phone&&compact)await picker().click();
  const oldChat=new URL(page.url()).searchParams.get('chat');await page.getByRole('button',{name:'New Chat',exact:true}).click();
  await page.waitForFunction(old=>{const query=new URL(location.href).searchParams;return query.get('chat')&&query.get('chat')!==old&&!query.get('create');},oldChat);
  await picker().waitFor();assert.equal(await picker().inputValue(),'New Chat');await page.screenshot({path:path.join(output,label+'-new-chat.png')});
  await page.goBack();await page.getByText('A short synthetic briefing for this week.',{exact:false}).waitFor();row.newChatAndBack=true;
  await page.goto(origin+route(filled,`/projects/${filled.projectId}/agents/${agent.id}`));await page.getByRole('heading',{name:agent.title,exact:true}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'Chat',exact:true}).inputValue(),filled.title,'Nested Agent retains its original Chat selector');assert.equal(await page.getByRole('combobox',{name:'Current Chat',exact:true}).count(),0);
  await page.screenshot({path:path.join(output,label+'-nested-agent.png')});
  const returnChat=page.getByRole('button',{name:'Open Chat '+filled.title,exact:true});
  if(!await returnChat.isVisible())await page.getByRole('button',{name:'Expand Workspace Header',exact:true}).last().click();
  await returnChat.click();await page.getByLabel('Message',{exact:true}).waitFor();await capture('agent-return',filled);row.agentReturn=true;
  await page.goto(origin+'/assistant');await page.getByRole('heading',{name:'Assistant',exact:true}).waitFor();await page.getByLabel('Message',{exact:true}).waitFor();assert.equal(await page.getByRole('combobox',{name:'Current Chat',exact:true}).count(),0);row.assistantUnchanged=true;
  assert.deepEqual(row.errors,[]);assert.deepEqual(row.failedApi,[]);await context.close();
 }
 await writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,results,limit:'Synthetic Chromium desktop and phone-sized touch viewport, owner theme; no physical mobile keyboard/audio or integrated-theme acceptance.'},null,2));
 console.log(JSON.stringify({passed:true,output,results:results.map(({scenes,...row})=>({...row,scenes}))}));
}finally {await browser?.close();await f.dispose();}
