// After web build: QUALIFICATION_DIRECTORY=<owned> node --import ./tests/shared/workspace-resolution.mjs tests/workspace-navigation/core-navigation-startup-qualification.mjs
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../../',import.meta.url));
const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const output=process.env.QUALIFICATION_DIRECTORY;assert(output);await mkdir(output,{recursive:true});
const fixture=spawn(process.execPath,['--import','./tests/shared/workspace-resolution.mjs','tests/branches/ui-qualification.mjs'],{cwd:root,stdio:['ignore','pipe','inherit']});
const fixtureExit=once(fixture,'exit'),rows=[];let browser;
const navigation=page=>page.getByRole('navigation',{name:'Workspace navigation',exact:true,includeHidden:true});
const search=page=>page.getByRole('textbox',{name:'Search chats',exact:true});
const open=page=>page.getByRole('button',{name:'Open workspace navigation',exact:true}).click();
const close=async page=>{
 const button=page.getByRole('button',{name:'Close workspace navigation',exact:true});
 await button.click();await button.waitFor({state:'hidden'});
};
const draft=editor=>editor.evaluate(element=>element.value??element.textContent);
try{
 let setup;for await(const line of createInterface({input:fixture.stdout}))if(line.startsWith('{"origin":')){setup=JSON.parse(line);break;}
 assert(setup);browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 for(const mobile of [true,false]){
  const row={mobile,status:'started',errors:[],blocked:[]};rows.push(row);
  const context=await browser.newContext({viewport:mobile?{width:412,height:823}:{width:1365,height:768},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block',recordVideo:{dir:path.join(output,mobile?'phone-video':'desktop-video')}});
  let releaseProjects;const projectGate=new Promise(resolve=>releaseProjects=resolve);
  try{
   const route=new URL(setup.normalUrl),parts=route.pathname.split('/'),projectId=parts[2],chatId=parts[4];
   await context.route('**/*',async requestRoute=>{
    const url=new URL(requestRoute.request().url());
    if(url.origin!==setup.origin){row.blocked.push(url.href);return requestRoute.abort();}
    if(mobile&&requestRoute.request().method()==='GET'&&(url.pathname==='/api/projects'||url.pathname==='/api/projects/'+projectId))await projectGate;
    return requestRoute.continue();
   });
   const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>row.errors.push(error.message));
   const tail=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/conversations/'+chatId&&response.status()===200);
   await page.goto(setup.normalUrl);await tail;
   assert.equal(await navigation(page).count(),mobile?0:1,'Only a previously used navigation surface should be mounted');
   row.canonicalTailBeforeProjectRelease=mobile;releaseProjects();
   const editor=page.getByLabel('Message',{exact:true});await editor.waitFor();
   await editor.click();await page.keyboard.type('Keep unsent message');
   row.draftStages=[];
   const noteDraft=async step=>{const value=await draft(editor);row.draftStages.push({step,value});assert.equal(value,'Keep unsent message',step);};
   const settledDraft=async step=>{
    const started=Date.now(),initial=await draft(editor);row.draftStages.push({step:step+' initial',value:initial});
    await page.waitForFunction(expected=>Array.from(document.querySelectorAll('[aria-label="Message"]')).some(element=>element.getClientRects().length&&(element.value??element.textContent)===expected),'Keep unsent message');
    row.draftStages.push({step:step+' settled',value:await draft(editor),elapsedMs:Date.now()-started});
    assert.equal(await draft(editor),'Keep unsent message',step);
   };
   await noteDraft('trusted keyboard entry');
   await page.screenshot({path:path.join(output,mobile?'phone-before-first-open.png':'desktop-initial.png')});
   if(mobile){
    const touch=await context.newCDPSession(page);
    try{
     await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:4,y:220}]});
     for(const x of [40,110,240]){
      await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:220}]});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
     }
     assert.equal(await navigation(page).count(),1,'First drag must mount drawer contents before touchend/onOpen');
     const bounds=await page.locator('aside[aria-label="Workspace navigation"]').evaluate(element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};});
     assert(bounds.width>0&&bounds.right>0&&bounds.left<412,'First swipe must expose a populated drawer while dragging');
     await page.screenshot({path:path.join(output,'phone-first-swipe-in-progress.png')});
     await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
     await search(page).waitFor();await close(page);row.firstEdgeSwipe='pass';await noteDraft('after first swipe');
    }finally{await touch.detach();}
    await open(page);await search(page).waitFor();assert.equal(await navigation(page).count(),1);
    await search(page).fill('Keep mobile filter');await close(page);await open(page);
    await noteDraft('after drawer close and reopen');
    assert.equal(await search(page).inputValue(),'Keep mobile filter','Closing the drawer must retain its local state');
    await page.setViewportSize({width:1365,height:768});
    await page.getByRole('button',{name:'Close workspace navigation',exact:true}).waitFor({state:'hidden'});
    await search(page).waitFor();
    assert.equal(await navigation(page).count(),2,'Desktop first use must not unmount the existing drawer owner');
    await search(page).fill('Keep desktop filter');
    await noteDraft('after first desktop resize');
    await page.setViewportSize({width:412,height:823});await open(page);await search(page).waitFor();
    assert.equal(await search(page).inputValue(),'Keep mobile filter','Resize must preserve the drawer owner');
    await noteDraft('after returning to phone');
    await close(page);await page.setViewportSize({width:1365,height:768});await search(page).waitFor();
    assert.equal(await search(page).inputValue(),'Keep desktop filter','Returning to desktop must preserve its owner');
    await settledDraft('Navigation ownership must not discard the Chat draft');
    await page.setViewportSize({width:412,height:823});await open(page);await search(page).fill('');
    await page.getByRole('button',{name:'Ponderosa home',exact:true}).click();
    await page.waitForURL(url=>url.pathname==='/'||url.pathname==='/home');await page.goBack();await editor.waitFor();
    await settledDraft('Back navigation restores the existing Chat draft');
    await open(page);assert.equal(await navigation(page).count(),2);await close(page);
   }else{
    await search(page).fill('Keep first desktop filter');await page.setViewportSize({width:412,height:823});
    assert.equal(await navigation(page).count(),1,'A never-opened drawer body stays unmounted after resize');
    await open(page);await search(page).waitFor();assert.equal(await navigation(page).count(),2);await close(page);
    await page.setViewportSize({width:1365,height:768});await search(page).waitFor();
    assert.equal(await search(page).inputValue(),'Keep first desktop filter');
    await settledDraft('Desktop resize preserves the existing Chat draft');
   }
   await page.screenshot({path:path.join(output,mobile?'phone-retained-navigation.png':'desktop-retained-navigation.png')});
   assert.deepEqual(row.errors,[]);assert.deepEqual(row.blocked,[]);row.status='pass';console.log(`PASS ${mobile?'phone':'desktop'} startup and retained navigation`);
  }catch(error){row.status='failed';row.error=error.stack;await context.pages()[0]?.screenshot({path:path.join(output,`${mobile?'phone':'desktop'}-failure.png`)}).catch(()=>{});throw error;}
  finally{releaseProjects();await context.close();await writeFile(path.join(output,'results.json'),JSON.stringify(rows,null,2));}
 }
}finally{try{await browser?.close();}finally{fixture.kill('SIGTERM');await fixtureExit;}}
