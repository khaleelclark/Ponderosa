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
   const fault=`Font outage ${product} ${theme}`;
   const targetFont=before.fontFamily==='system'?'sans':'system',fontLabel=targetFont==='sans'?'Classic Sans':'System';
   let release,arrived;const held=new Promise(r=>release=r),intercepted=new Promise(r=>arrived=r);
   const rejectFont=async route=>{if(route.request().method()==='PATCH'&&route.request().postDataJSON()?.fontFamily){arrived();await held;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:fault})});}else await route.continue();};
   await page.route(prefs,rejectFont);
   await page.getByRole('combobox',{name:'Font',exact:true}).click();await page.getByRole('option',{name:fontLabel,exact:true}).click();await intercepted;
   await page.getByRole('checkbox',{name:'Proactive context rollover',exact:true}).click();
   const contextSaved=page.waitForResponse(r=>r.url()===prefs&&r.request().method()==='PATCH'&&r.request().postDataJSON()?.contextRolloverEnabled!==undefined);
   release();await page.getByRole('alert').filter({hasText:fault}).waitFor();assert.equal((await contextSaved).status(),200);
   assert.equal(await page.getByRole('alert').filter({hasText:fault}).count(),1,'Overlapping unrelated success keeps Font error');
   row.checks.push('Held Font failure + queued unrelated rollover success retains exact Font error');
   const instructions=page.getByLabel('Global Agent Instructions',{exact:true});await instructions.fill(`${product}-${theme} unrelated explicit save`);
   const explicitSaved=page.waitForResponse(r=>r.url()===prefs&&r.request().method()==='PATCH'&&r.request().postDataJSON()?.globalInstructions!==undefined);
   await page.getByRole('button',{name:'Save Agent Defaults',exact:true}).click();assert.equal(await page.getByRole('alert').filter({hasText:fault}).count(),1,'Explicit save start retains unrelated failure');assert.equal((await explicitSaved).status(),200);
   assert.equal(await page.getByRole('alert').filter({hasText:fault}).count(),1,'Explicit save success retains unrelated failure');
   row.checks.push('Unrelated explicit Agent Defaults save start/success keeps Font failure');
   await page.screenshot({path:path.join(output,`${product}-${theme}-unrelated-success.png`),fullPage:true});
   await page.unroute(prefs,rejectFont);
   await page.getByRole('combobox',{name:'Font',exact:true}).click();await page.getByRole('option',{name:fontLabel,exact:true}).click();
   await page.waitForFunction(async({prefs,targetFont})=>(await (await fetch(prefs)).json()).fontFamily===targetFont,{prefs,targetFont});
   await page.getByRole('alert').filter({hasText:fault}).waitFor({state:'hidden'});
   row.checks.push('Matching Font successful retry clears only its failure');
   await page.screenshot({path:path.join(output,`${product}-${theme}-retry.png`),fullPage:true});
   const secondFault=`Rollover outage ${product} ${theme}`;
   const rejectBoth=async route=>{const patch=route.request().method()==='PATCH'?route.request().postDataJSON():{};if(patch.fontFamily||patch.contextRolloverEnabled!==undefined)await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:patch.fontFamily?fault:secondFault})});else await route.continue();};
   await page.route(prefs,rejectBoth);
   const otherFont=targetFont==='system'?'Classic Sans':'System';
   let rejected=page.waitForResponse(r=>r.url()===prefs&&r.status()===503&&r.request().postDataJSON()?.fontFamily);
   await page.getByRole('combobox',{name:'Font',exact:true}).click();await page.getByRole('option',{name:otherFont,exact:true}).click();await rejected;
   rejected=page.waitForResponse(r=>r.url()===prefs&&r.status()===503&&r.request().postDataJSON()?.contextRolloverEnabled!==undefined);
   await page.getByRole('checkbox',{name:'Proactive context rollover',exact:true}).click();await rejected;
   await page.getByRole('alert').filter({hasText:fault}).waitFor();
   await page.unroute(prefs,rejectBoth);
   const recovered=page.waitForResponse(r=>r.url()===prefs&&r.status()===200&&r.request().method()==='PATCH'&&r.request().postDataJSON()?.fontFamily);
   await page.getByRole('combobox',{name:'Font',exact:true}).click();await page.getByRole('option',{name:otherFont,exact:true}).click();await recovered;
   await page.getByRole('alert').filter({hasText:fault}).waitFor({state:'hidden'});
   await page.getByRole('alert').filter({hasText:secondFault}).waitFor();
   row.checks.push('Two distinct failures: matching Font retry preserves exact Rollover failure');
   await page.screenshot({path:path.join(output,`${product}-${theme}-second-failure-retained.png`),fullPage:true});
   const rolloverRecovered=page.waitForResponse(r=>r.url()===prefs&&r.status()===200&&r.request().method()==='PATCH'&&r.request().postDataJSON()?.contextRolloverEnabled!==undefined);
   await page.getByRole('checkbox',{name:'Proactive context rollover',exact:true}).click();await rolloverRecovered;
   await page.getByRole('alert').filter({hasText:secondFault}).waitFor({state:'hidden'});
   row.checks.push('Matching Rollover retry clears remaining failure');
   row.status='pass';console.log(`PASS ${product} ${theme}: ${row.checks.length} checks`);
  }catch(error){row.status='failed';row.error=error.stack;await context.pages()[0]?.screenshot({path:path.join(output,`${product}-${theme}-failure.png`)}).catch(()=>{});throw error;}
  finally{await context.close();await writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2));}
 }
}finally{await browser?.close();child.kill('SIGTERM');await exited;}
