// Rebuilt web + disposable real API; controlled provider only, no provider inference.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const require=createRequire(new URL('../../apps/server/package.json',import.meta.url));
const {chromium}=require('playwright-core');
const output=process.env.QUALIFICATION_DIRECTORY;
assert.ok(output,'Set QUALIFICATION_DIRECTORY');await mkdir(output,{recursive:true});
const child=spawn(process.execPath,['--import','./tests/shared/workspace-resolution.mjs','tests/branches/ui-qualification.mjs'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),stdio:['ignore','pipe','inherit']});
const exited=once(child,'exit'),results=[];let browser;
try{
 let fixture;for await(const line of createInterface({input:child.stdout}))if(line.startsWith('{"origin":')){fixture=JSON.parse(line);break;}
 assert.ok(fixture);browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 for(const product of ['core','branches'])for(const theme of ['light','dark']){
  const context=await browser.newContext({viewport:{width:1280,height:900}}),row={product,theme,checks:[]};results.push(row);
  try{
   const page=await context.newPage();page.setDefaultTimeout(10000);
   await page.addInitScript(theme=>localStorage.setItem('ponderosa-color-mode',theme),theme);
   const prefs=fixture.origin+(product==='core'?'/api/workspace/preferences':'/api/branches/engine/workspace/preferences');
   const before=await (await fetch(prefs)).json();
   await page.goto(fixture.origin+(product==='core'?'/settings/general':'/branches?settings=general'));
   const instructions=page.getByLabel('Global Agent Instructions',{exact:true});await instructions.waitFor();
   const oversized='λ'.repeat(100000)+'😀TAIL';await instructions.fill(oversized);
   const rejected=page.waitForResponse(r=>r.url()===prefs&&r.request().method()==='PATCH');
   await page.getByRole('button',{name:'Save Agent Defaults',exact:true}).click();assert.equal((await rejected).status(),400);
   await page.getByRole('alert').filter({hasText:'at most 100,000'}).first().waitFor();
   row.rejectedSaveAlerts=await page.getByRole('alert').allTextContents();
   assert.equal(await page.getByRole('alert').filter({hasText:'at most 100,000'}).count(),1,'One meaningful rejected-save error');
   assert.equal(await page.getByRole('alert').filter({hasText:'Workspace settings could not be saved.'}).count(),0,'No second generic error');
   assert.equal(await instructions.inputValue(),oversized,'Rejected save keeps exact draft');
   const after=await (await fetch(prefs)).json();assert.equal(after.globalInstructions,before.globalInstructions);assert.equal(after.revision,before.revision);
   row.checks.push('Oversized save: 400, exact dirty draft and previous stored text/revision retained');
   const unload=page.waitForEvent('dialog');const reload=page.reload().catch(error=>error.message);
   const dialog=await unload;assert.equal(dialog.type(),'beforeunload');await dialog.dismiss();await reload;
   assert.equal(await instructions.inputValue(),oversized,'Canceled reload keeps dirty draft');row.checks.push('Dirty rejected draft still blocks reload');
   const corrected=`${product}-${theme} corrected instructions`;
   await instructions.fill(corrected);const saved=page.waitForResponse(r=>r.url()===prefs&&r.request().method()==='PATCH');await page.getByRole('button',{name:'Save Agent Defaults',exact:true}).click();assert.equal((await saved).status(),200);
   await page.waitForFunction(async({prefs,corrected})=>(await (await fetch(prefs)).json()).globalInstructions===corrected,{prefs,corrected});row.checks.push('Corrected save succeeds with exact stored text');
   assert.equal(await page.getByRole('alert').filter({hasText:'at most 100,000'}).count(),0,'Corrected save removes stale rejection');
   assert.equal(await page.getByRole('alert').filter({hasText:'Workspace settings could not be saved.'}).count(),0);
   row.checks.push('One exact failure presentation; corrected save removes all rejected-save errors');
   await page.locator('.MuiSnackbar-root').evaluateAll(async nodes=>{await Promise.all(nodes.flatMap(n=>n.getAnimations({subtree:true})).map(a=>a.finished.catch(()=>{})));});
   if(process.env.AXE_CORE_PATH){await page.addScriptTag({path:process.env.AXE_CORE_PATH});row.settingsScan=await page.evaluate(()=>axe.run());assert.deepEqual(row.settingsScan.violations.filter(v=>['critical','serious'].includes(v.impact)||v.id==='heading-order').map(v=>v.id),[]);}
   row.renderedSettings=await page.locator('main').innerText();
   row.headingOutline=await page.locator('h1,h2,h3,h4,h5,h6').evaluateAll(nodes=>nodes.map(n=>({level:n.tagName,text:n.textContent})));
   await page.screenshot({path:path.join(output,`${product}-${theme}-settings.png`),fullPage:true});
   const fontFault='Qualification immediate-save outage',targetFont=before.fontFamily==='system'?'sans':'system',fontLabel=targetFont==='sans'?'Classic Sans':'System';
   const rejectFont=async route=>{if(route.request().method()==='PATCH'&&route.request().postDataJSON()?.fontFamily)await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:fontFault})});else await route.continue();};
   await page.route(prefs,rejectFont);
   await page.getByRole('combobox',{name:'Font',exact:true}).click();await page.getByRole('option',{name:fontLabel,exact:true}).click();
   await page.getByRole('alert').filter({hasText:fontFault}).waitFor();
   assert.equal(await page.getByRole('alert').filter({hasText:fontFault}).count(),1);
   assert.notEqual((await (await fetch(prefs)).json()).fontFamily,targetFont,'Failed immediate save leaves canonical font unchanged');
   await page.unroute(prefs,rejectFont);
   await page.getByRole('combobox',{name:'Font',exact:true}).click();await page.getByRole('option',{name:fontLabel,exact:true}).click();
   await page.waitForFunction(async({prefs,targetFont})=>(await (await fetch(prefs)).json()).fontFamily===targetFont,{prefs,targetFont});
   await page.getByRole('alert').filter({hasText:fontFault}).waitFor({state:'hidden'});
   row.checks.push('Immediate save shows exact error once; successful retry clears it');
   await page.goto(product==='core'?fixture.normalUrl:fixture.url);
   await page.getByLabel('Message',{exact:true}).waitFor();await page.getByRole('button',{name:'Chat settings and actions',exact:true}).click();await page.getByRole('menuitem',{name:'Rename',exact:true}).click();
   const name=page.getByLabel('Chat name',{exact:true});await name.waitFor();const title=`${product}-${theme} retry title`;await name.fill(title);
   let failures=0;const fault='**/api/**/conversations/*';await page.route(fault,async route=>{if(route.request().method()==='PATCH'&&route.request().postDataJSON()?.title){failures++;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Qualification rename outage'})});}else await route.continue();});
   await name.press('Enter');await page.getByRole('alert').filter({hasText:'Qualification rename outage'}).waitFor();assert.equal(failures,1);assert.equal(await name.inputValue(),title);row.checks.push('Rename Enter failure is visible and preserves exact draft');
   await page.screenshot({path:path.join(output,`${product}-${theme}-rename-failure.png`)});
   await page.unroute(fault);const renamed=page.waitForResponse(r=>r.request().method()==='PATCH'&&r.request().postDataJSON()?.title===title);await name.press('Enter');assert.equal((await renamed).status(),200);await name.waitFor({state:'hidden'});
   const requests=await (await fetch(fixture.origin+'/api/__qualification/state')).json();assert.equal(requests.requests.filter(r=>r.method==='PATCH'&&r.path.includes('/conversations/')&&r.status===200).length,results.length,'Exactly one accepted rename per cell');
   row.checks.push('Rename Enter retry succeeds once');row.status='pass';console.log(`PASS ${product} ${theme}: ${row.checks.length} checks`);
  }catch(error){row.status='failed';row.error=error.stack;await context.pages()[0]?.screenshot({path:path.join(output,`${product}-${theme}-failure.png`)}).catch(()=>{});throw error;}
  finally{await context.close();await writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2));}
 }
}finally{await browser?.close();child.kill('SIGTERM');await exited;}
