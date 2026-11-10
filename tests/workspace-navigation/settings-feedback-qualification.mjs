// Run after the web build: QUALIFICATION_DIRECTORY=/tmp/... node --import ./tests/shared/workspace-resolution.mjs tests/workspace-navigation/settings-feedback-qualification.mjs
// Uses the existing disposable real-API fixture with controlled providers; no inference.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(new URL('../../apps/server/package.json',import.meta.url));
const {chromium}=require('playwright-core'),output=process.env.QUALIFICATION_DIRECTORY;
assert.ok(output,'Set QUALIFICATION_DIRECTORY');await mkdir(output,{recursive:true});
const fixture=spawn(process.execPath,['--import','./tests/shared/workspace-resolution.mjs','tests/branches/ui-qualification.mjs'],{cwd:root,stdio:['ignore','pipe','inherit']});
const exited=once(fixture,'exit'),results=[];let browser;
const overlaps=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
try{
 let setup;for await(const line of createInterface({input:fixture.stdout}))if(line.startsWith('{"origin":')){setup=JSON.parse(line);break;}
 assert.ok(setup);browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 for(const product of ['core','branches'])for(const mobile of [false,true]){
  const viewport=mobile?{width:390,height:844}:{width:1280,height:900},context=await browser.newContext({viewport,isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
  const row={product,mobile,viewport,checks:[],errors:[],blocked:[]};results.push(row);
  try{
   await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==setup.origin){row.blocked.push(route.request().url());return route.abort();}return route.continue();});
   const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>row.errors.push(String(e)));
   const prefs=setup.origin+(product==='core'?'/api/workspace/preferences':'/api/branches/engine/workspace/preferences');
   await page.goto(setup.origin+(product==='core'?'/settings/general':'/branches?settings=general'));
   const input=page.getByRole('textbox',{name:'Global Agent Instructions',exact:true}),save=page.getByRole('button',{name:'Save Agent Defaults',exact:true}),rollover=page.getByRole('button',{name:'Save Rollover Limits',exact:true});
   const saved=save.locator('..').getByRole('status'),rolloverSaved=rollover.locator('..').getByRole('status');
   await input.fill(product+' '+(mobile?'phone':'desktop')+' saved instructions');
   let response=page.waitForResponse(r=>r.url()===prefs&&r.request().method()==='PATCH');await save.click();assert.equal((await response).status(),200);
   await saved.filter({hasText:'Settings Saved'}).waitFor();await page.screenshot({path:path.join(output,product+'-'+(mobile?'phone':'desktop')+'-defaults-saved.png')});assert.equal(await page.locator('.MuiSnackbar-root').filter({hasText:'Settings Saved'}).count(),0);
   assert.equal(overlaps(await saved.boundingBox(),await rollover.boundingBox()),false,'Saved feedback must not cover rollover action');
   await rollover.scrollIntoViewIfNeeded();assert.equal(await rollover.evaluate(el=>{const b=el.getBoundingClientRect();return el.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));}),true,'Other save action remains reachable');
   row.checks.push('Confirmed save is in flow beside its own action, without covering another save action or a floating toast');
   await input.fill('pending late-edit source');await saved.waitFor({state:'hidden'});
   let release,start;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>start=resolve);
   const delay=async route=>{if(route.request().method()==='PATCH'&&route.request().postDataJSON()?.globalInstructions){start();await gate;}await route.continue();};
   await page.route(prefs,delay);response=page.waitForResponse(r=>r.url()===prefs&&r.request().method()==='PATCH');await save.click();await started;
   assert.equal(await saved.count(),0);await input.fill('newer unsaved draft');release();assert.equal((await response).status(),200);await save.waitFor({state:'visible'});await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Saving…'));
   assert.equal(await input.inputValue(),'newer unsaved draft');assert.equal(await saved.count(),0,'An older acknowledgement must not label a newer draft saved');await page.unroute(prefs,delay);
   row.checks.push('Edit and pending save clear feedback; late acknowledgement preserves newer draft without claiming it saved');
   const reject=async route=>route.request().method()==='PATCH'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Qualification settings outage'})}):route.continue();
   await page.route(prefs,reject);response=page.waitForResponse(r=>r.url()===prefs&&r.request().method()==='PATCH');await save.click();assert.equal((await response).status(),503);await page.getByRole('alert').filter({hasText:'Qualification settings outage'}).first().waitFor();
   assert.equal(await saved.count(),0);assert.equal(await input.inputValue(),'newer unsaved draft');await page.unroute(prefs,reject);
   response=page.waitForResponse(r=>r.url()===prefs&&r.request().method()==='PATCH');await save.click();assert.equal((await response).status(),200);await saved.waitFor();row.checks.push('Failed save keeps the draft and error; successful retry alone restores confirmation');
   const tokens=page.getByRole('spinbutton',{name:'Roll Over Above (Context Tokens)',exact:true});await tokens.fill('160000');
   response=page.waitForResponse(r=>r.url()===prefs&&r.request().method()==='PATCH');await rollover.click();assert.equal((await response).status(),200);await rolloverSaved.waitFor();
   assert.equal(overlaps(await rollover.boundingBox(),await rolloverSaved.boundingBox()),false);await page.screenshot({path:path.join(output,product+'-'+(mobile?'phone':'desktop')+'-rollover-saved.png')});
   await tokens.fill('170000');await rolloverSaved.waitFor({state:'hidden'});row.checks.push('Rollover confirmation is local to its successful save and clears on editing');
   await page.screenshot({path:path.join(output,product+'-'+(mobile?'phone':'desktop')+'-settings.png')});
   // Discard this intentionally dirty disposable form only; no provider work exists.
   page.once('dialog',dialog=>dialog.accept());
   await page.goto(product==='core'?setup.normalUrl:setup.url);
   await page.getByRole('tab',{name:'Agents',exact:true}).click();await page.getByText(product==='core'?'Normal compatibility Agent':'Branch roster 001',{exact:true}).first().click();
   const heading=page.getByRole('heading',{name:product==='core'?'Normal compatibility Agent':'Branch roster 001',exact:true});await heading.waitFor();
   const header=page.locator('[data-workspace-header]').filter({has:heading});
   const expand=header.getByRole('button',{name:'Expand Workspace Header',exact:true});if(await expand.count())await expand.click();
   const collapse=header.getByRole('button',{name:'Collapse Workspace Header',exact:true});await collapse.hover();
   await page.getByRole('tooltip').filter({hasText:'Collapse Workspace Header'}).waitFor();
   const actions=header.getByRole('button',{name:'Agent Chat Actions',exact:true});
   assert.equal(await actions.evaluate(el=>{const b=el.getBoundingClientRect();return el.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));}),true,'Hover label must not intercept the Agent action');
   await actions.click({timeout:1500});await page.getByRole('menu').waitFor();await page.keyboard.press('Escape');
   await collapse.focus();await collapse.press('Enter');await expand.waitFor();assert.equal(await expand.evaluate(el=>el===document.activeElement),true);
   await expand.press('Enter');await collapse.waitFor();assert.equal(await collapse.evaluate(el=>el===document.activeElement),true);row.checks.push('Plain header tooltip does not intercept adjacent action; keyboard collapse/expand preserves focus');
   await page.screenshot({path:path.join(output,product+'-'+(mobile?'phone':'desktop')+'-header.png')});
   assert.deepEqual(row.errors,[]);assert.deepEqual(row.blocked,[]);row.status='pass';console.log('PASS '+product+' '+(mobile?'phone':'desktop')+': '+row.checks.length+' checks');
  }catch(error){row.status='failed';row.error=error.stack;await context.pages()[0]?.screenshot({path:path.join(output,product+'-'+(mobile?'phone':'desktop')+'-failure.png')}).catch(()=>{});throw error;}
  finally{await context.close();await writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2));}
 }
}finally{await browser?.close();fixture.kill('SIGTERM');await exited;}
