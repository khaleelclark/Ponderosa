// Built Core + isolated Assistant/Output runtime, real scoped APIs, inert providers.
import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture} from '../shared/fixture.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const {chromium,webkit}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const out=process.env.PONDEROSA_OUTPUT_QUALIFICATION_DIR??'/tmp/ponderosa-ui017-settings';await mkdir(out,{recursive:true});
const f=await fixture({webDist:path.join(root,'apps/web/dist')});let browser;const results=[];
const engine=process.env.PONDEROSA_BROWSER==='webkit'?'webkit':'chromium';
try{
 const chat=await f.createChat('Planning Chat');const partner=await f.createIdleAgent(chat,'Planning Partner');
 f.ok(await f.api('PATCH','/api/workspace/preferences',{starredResourceIds:[`conversation:${chat.id}`,`agent:${partner.id}`]}));
 for(let i=0;i<28;i++){await f.createChat(`Planning ${i}`);await f.createIdleAgent(chat,`Partner ${i}`);}
 const app=f.ok(await f.api('POST','/api/branches/assistant',{initialize:true})).app;
 const origin=await f.listen();browser=await (engine==='webkit'?webkit:chromium).launch({executablePath:engine==='webkit'?process.env.PONDEROSA_WEBKIT_PATH:process.env.PONDEROSA_BROWSER_EXECUTABLE??'/opt/google/chrome/chrome',headless:true,...(engine==='chromium'?{args:['--no-sandbox']}:{})});
 let cell=0;
 for(const assistant of [true,false])for(const phone of [false,true])for(const mode of ['light','dark']){
  const id=`${assistant?'assistant':'output'}-${phone?'phone':'desktop'}-${mode}`,context=await browser.newContext({viewport:phone?{width:390,height:844}:{width:1440,height:1000},hasTouch:phone,...(phone?{isMobile:true}:{})});
  const page=await context.newPage(),errors=[],writes=[];page.setDefaultTimeout(10000);console.log(id);page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='PATCH'||request.method()==='PUT')writes.push({method:request.method(),path:new URL(request.url()).pathname,body:request.postDataJSON()});});
  await page.addInitScript(mode=>localStorage.setItem('ponderosa-color-mode',mode),mode);
  const current=f.ok(await f.api('GET','/api/branches/assistant')).app;
  await page.goto(origin+(assistant?'/assistant':app.url));await page.getByRole('heading',{name:current.title,exact:true}).waitFor();
  const editor=page.getByLabel('Message',{exact:true});await editor.waitFor();await editor.fill('Preserve This Unsent Draft');
  await page.evaluate(()=>{window.__ui017Root=document.querySelector('[data-assistant-conversation]');window.__ui017Editor=document.querySelector('[aria-label=Message]');});
  const sameConversation=async(responsive=false)=>{const state=await page.evaluate(()=>({rootSame:window.__ui017Root===document.querySelector('[data-assistant-conversation]'),editorSame:window.__ui017Editor===document.querySelector('[aria-label=Message]'),text:document.querySelector('[aria-label=Message]')?.textContent}));assert.ok(state.rootSame&&(responsive||state.editorSame)&&state.text?.includes('Preserve This Unsent Draft'),JSON.stringify(state));if(responsive)await page.evaluate(()=>{window.__ui017Editor=document.querySelector('[aria-label=Message]');});};
  const navigation=()=>page.getByRole('complementary',{name:'Workspace Navigation'}).filter({visible:true});
  const openDrawer=async()=>{if(phone)await page.getByRole('button',{name:'Open Workspace Navigation',exact:true}).click();};
  const selected=async(expected)=>{const nav=navigation();await nav.waitFor();const actual=await nav.locator('[aria-current=page], [data-sidebar-section][aria-pressed=true]').evaluateAll(nodes=>nodes.map(n=>n.textContent?.trim()));assert.deepEqual(actual,[expected]);};
  if(assistant){
   await openDrawer();await selected(current.title);
   const nav=navigation();await nav.getByRole('button',{name:'Chats',exact:true}).click();await selected('Chats');await sameConversation();
   if(!phone&&mode==='light'){
    const stars=nav.getByRole('button',{name:'Starred',exact:true});await stars.waitFor();await stars.click();assert.equal(await stars.getAttribute('aria-expanded'),'false');
    await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Open Workspace Navigation',exact:true}).click();const mobile=navigation();await selected('Chats');
    const mobileStars=mobile.getByRole('button',{name:'Starred',exact:true});assert.equal(await mobileStars.getAttribute('aria-expanded'),'false');await mobileStars.click();assert.equal(await mobileStars.getAttribute('aria-expanded'),'true');
    await mobile.locator(`[data-resource-id="sidebar-conversation:${chat.id}"]`).first().click({button:'right'});assert.equal(await page.getByRole('menu').count(),1,'One instance owns the context menu portal');await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Close Workspace Navigation',exact:true}).click();await page.setViewportSize({width:1440,height:1000});assert.equal(await navigation().getByRole('button',{name:'Starred',exact:true}).getAttribute('aria-expanded'),'true');await sameConversation(true);
   }
   await nav.getByRole('textbox',{name:'Search Chats'}).fill('Planning');
   await nav.getByRole('button',{name:'Agents',exact:true}).click();await selected('Agents');await nav.getByRole('textbox',{name:'Search Agents'}).fill('Partner');
   await nav.getByRole('button',{name:'Chats',exact:true}).click();await selected('Chats');assert.equal(await nav.getByRole('textbox',{name:'Search Chats'}).inputValue(),'Planning');
   const scroller=nav.locator('.ponderosa-scroll');await page.waitForFunction(()=>[...document.querySelectorAll('[aria-label="Workspace Navigation"] .ponderosa-scroll')].some(n=>n.getClientRects().length&&n.scrollHeight>n.clientHeight+100));
   const previousTop=await scroller.evaluate(n=>{n.scrollTop=120;n.dispatchEvent(new Event('scroll',{bubbles:true}));return n.scrollTop;});assert.ok(previousTop>0);
   await nav.getByRole('button',{name:'Agents',exact:true}).click();assert.equal(await nav.getByRole('textbox',{name:'Search Agents'}).inputValue(),'Partner');await nav.getByRole('button',{name:'Chats',exact:true}).click();
   await page.waitForFunction(previousTop=>[...document.querySelectorAll('[aria-label="Workspace Navigation"] .ponderosa-scroll')].some(n=>n.getClientRects().length&&Math.abs(n.scrollTop-previousTop)<2),previousTop);await sameConversation();
   await nav.getByRole('link',{name:current.title,exact:true}).click();
   if(phone){await page.getByRole('heading',{name:current.title,exact:true}).waitFor();await openDrawer();}await selected(current.title);
   if(phone)await page.getByRole('button',{name:'Close Workspace Navigation',exact:true}).click();await sameConversation();
  }
  const settings=page.getByRole('button',{name:'Settings',exact:true}).first();await settings.click();const dialog=page.getByRole('dialog').filter({has:page.locator('#output-app-settings-title')});await dialog.waitFor();
  assert.equal(await dialog.getByRole('button',{name:'Save Model',exact:true}).isDisabled(),true);assert.equal(await dialog.getByRole('button',{name:'Save Schedule',exact:true}).isDisabled(),true);
  assert.equal(await dialog.getByRole('button',{name:'Discard Draft And Reload'}).count(),0);assert.equal(await dialog.getByRole('button',{name:'Reload Saved Settings'}).count(),0);assert.equal(await dialog.getByRole('link',{name:'More Options'}).count(),assistant?0:1);
  await dialog.getByRole('spinbutton',{name:'Check Every (Minutes)'}).fill(String(21+cell));
  await dialog.getByRole('combobox',{name:/^Model/}).click();await page.getByRole('option',{name:cell%2===0?'Fixture':'Provider Default',exact:true}).click();
  let renamed=current.title;
  if(assistant){
   const name=dialog.getByRole('textbox',{name:'Name',exact:true});await name.fill('');assert.equal(await dialog.getByRole('button',{name:'Save Name'}).isDisabled(),true);
   renamed=`Pine Partner ${++cell}`;await name.fill(renamed);await dialog.getByRole('button',{name:'Save Name'}).click();await page.locator('[data-conversation-contact] h1').filter({hasText:renamed}).waitFor();
   assert.equal(await dialog.getByRole('spinbutton',{name:'Check Every (Minutes)'}).inputValue(),String(20+cell));assert.equal(await dialog.getByRole('button',{name:'Save Name'}).isDisabled(),true);
  }else cell++;
  await page.waitForFunction(()=>![...document.querySelectorAll('[role=dialog] [role=status]')].some(n=>['Saving…','Reloading…'].includes(n.textContent)));
  // Each section commits once without discarding the other section's draft.
  if(!await dialog.getByRole('button',{name:'Save Model'}).isDisabled())await dialog.getByRole('button',{name:'Save Model'}).click();
  await page.waitForFunction(()=>![...document.querySelectorAll('[role=dialog] [role=status]')].some(n=>n.textContent==='Saving…'));
  await dialog.getByRole('button',{name:'Save Schedule'}).click();await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(n=>n.textContent==='Save Schedule'&&n.disabled));
  if(assistant){
   const name=dialog.getByRole('textbox',{name:'Name',exact:true});await name.fill('Keep My Unsaved Name');
   const external=`External Partner ${cell}`;f.ok(await f.api('PATCH',`/api/branches/engine/agents/${app.agentId}`,{title:external,expectedTitle:renamed}));
   await dialog.getByRole('button',{name:'Save Name'}).click();await dialog.getByText('Name changed. Reload saved settings before saving.',{exact:true}).waitFor({state:'attached'});await dialog.locator('summary').filter({hasText:'Settings Action Needs Attention'}).click();assert.equal(await name.inputValue(),'Keep My Unsaved Name');const snack=page.locator('.MuiSnackbar-root');if(await snack.count())await snack.getByRole('button',{name:'Close',exact:true}).click();
   const before=writes.length;await dialog.getByRole('button',{name:'Reload Saved Settings'}).click();await page.waitForFunction(value=>[...document.querySelectorAll('input')].some(input=>input.value===value),external);
   assert.equal(await name.inputValue(),external);await page.locator('[data-workspace-sidebar-sections] a').filter({hasText:external}).first().waitFor({state:'attached'});assert.equal(writes.length,before,'Reload performs no mutation');renamed=external;
   await name.fill('Discard Only This Settings Edit');await dialog.getByRole('button',{name:'Done',exact:true}).click();const confirm=page.getByRole('dialog').filter({hasText:'Unsaved Settings'});await confirm.waitFor();await confirm.getByRole('button',{name:'Keep Editing'}).click();assert.equal(await name.inputValue(),'Discard Only This Settings Edit');
   await dialog.getByRole('button',{name:'Done',exact:true}).click();await confirm.getByRole('button',{name:'Discard Changes'}).click();await dialog.waitFor({state:'hidden'});await sameConversation();await settings.click();await dialog.waitFor();assert.equal(await dialog.getByRole('textbox',{name:'Name',exact:true}).inputValue(),external);
  }
  if(process.env.AXE_CORE_PATH){await page.addScriptTag({path:process.env.AXE_CORE_PATH});const scan=await page.evaluate(()=>window.axe.run(document.querySelector('[role=dialog]')));assert.deepEqual(scan.violations.filter(v=>['critical','serious'].includes(v.impact)).map(v=>v.id),[]);}
  assert.ok(await dialog.getAttribute('aria-labelledby'));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.waitForFunction(()=>[...document.querySelectorAll('.MuiDialog-paper')].every(node=>getComputedStyle(node).opacity==='1'));await page.screenshot({path:path.join(out,id+'.png'),fullPage:true});
  await dialog.getByRole('button',{name:'Done',exact:true}).click();await dialog.waitFor({state:'hidden'});await sameConversation();await page.reload();await page.locator('[data-conversation-contact] h1').filter({hasText:renamed}).waitFor();await editor.waitFor();assert.match(await editor.innerText(),/Preserve This Unsent Draft/);
  if(assistant){
   // Native browser history returns to the same canonical route without a second highlight.
   await page.goto(origin+'/home');await page.goBack();await page.locator('[data-conversation-contact] h1').filter({hasText:renamed}).waitFor();await openDrawer();await selected(renamed);if(phone)await page.getByRole('button',{name:'Close Workspace Navigation',exact:true}).click();
   await page.goForward();await page.waitForURL('**/home');await page.goBack();await page.locator('[data-conversation-contact] h1').filter({hasText:renamed}).waitFor();await editor.waitFor();assert.match(await editor.innerText(),/Preserve This Unsent Draft/);
  }

  assert.deepEqual(errors,[]);results.push({id,writes,mountedDraftRetained:true,canonicalName:renamed});await writeFile(path.join(out,'results.json'),JSON.stringify({engine,results},null,2));await context.close();
 }
 assert.equal(f.turns.length,0,'Settings and navigation never submit work');console.log(JSON.stringify({pass:true,engine,cells:results.length,out}));
}finally{await browser?.close();await f.dispose();}
