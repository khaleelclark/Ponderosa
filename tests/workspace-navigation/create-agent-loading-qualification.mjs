// After the web build: QUALIFICATION_DIRECTORY=<owned> node --import ./tests/shared/workspace-resolution.mjs tests/workspace-navigation/create-agent-loading-qualification.mjs
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
const absent='Create a Chat before adding an Agent.';
try{
 let setup;for await(const line of createInterface({input:fixture.stdout}))if(line.startsWith('{"origin":')){setup=JSON.parse(line);break;}
 assert(setup);browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 for(const mobile of [false,true])for(const scenario of ['delayed','empty','chat-error','project-error']){
  if(process.env.QUALIFICATION_SCENARIO&&process.env.QUALIFICATION_SCENARIO!==scenario)continue;
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
  const row={mobile,scenario,errors:[],blocked:[],status:'started'};rows.push(row);
  let releaseProjects,releaseChats,projectsSeen,chatsSeen,failChats=true,failProjects=true,refreshChatFailure=false,refreshProjectFailure=false,refreshChatErrors=0;
  const projectGate=new Promise(resolve=>releaseProjects=resolve),chatGate=new Promise(resolve=>releaseChats=resolve);
  const projectRequest=new Promise(resolve=>projectsSeen=resolve),chatRequest=new Promise(resolve=>chatsSeen=resolve);
  try{
   await context.addInitScript(()=>{window.creationStates=[];new MutationObserver(()=>{const text=document.body?.innerText??'';window.creationStates.push({at:performance.now(),empty:text.includes('Create a Chat before adding an Agent.'),loading:text.includes('Loading Chats…')});}).observe(document,{childList:true,subtree:true,characterData:true});});
   await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==setup.origin){row.blocked.push(request.url());return route.abort();}
    if(request.method()==='GET'&&url.pathname==='/api/projects'){
     projectsSeen();
     if(scenario==='delayed')await projectGate;
     if(scenario==='project-error'&&failProjects)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Qualification Project list unavailable'})});
     if(scenario==='empty')return route.fulfill({status:200,contentType:'application/json',body:'[]',headers:{'x-total-count':'0','x-collection-has-more':'false'}});
    }
    if(request.method()==='GET'&&/^\/api\/projects\/[^/]+\/conversations$/.test(url.pathname)){
     chatsSeen();
     if(scenario==='delayed')await chatGate;
     if(refreshChatFailure){refreshChatErrors++;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Qualification cached Chat refresh unavailable'})});}
     if(scenario==='chat-error'&&failChats)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Qualification Chat list unavailable'})});
    }
    return route.continue();
   });
   const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>row.errors.push(error.message));
   await page.goto(setup.origin+'/create/agent');await projectRequest;
   if(scenario==='delayed'){
    await page.locator('#main-content').getByText('Loading Chats…',{exact:true}).waitFor();
    assert.equal(await page.getByText(absent,{exact:true}).count(),0,'Pending Projects must not imply no Chats');
    releaseProjects();await chatRequest;
    await page.locator('#main-content').getByText('Loading Chats…',{exact:true}).waitFor();
    assert.equal(await page.getByText(absent,{exact:true}).count(),0,'Pending Chat collections must not imply no Chats');
    releaseChats();await page.getByRole('textbox',{name:'Name',exact:true}).waitFor();
    row.states=await page.evaluate(()=>window.creationStates);assert(!row.states.some(state=>state.empty),'No false empty-state frame during delayed loading');
    await page.getByRole('textbox',{name:'Name',exact:true}).fill('Keep this draft');
    refreshChatFailure=true;refreshProjectFailure=true;
    await page.route('**/api/projects?**',route=>refreshProjectFailure?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Qualification project refresh unavailable'})}):route.continue());
    const refresh=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/projects'&&response.status()===503);
    const chatRefresh=page.waitForResponse(response=>/\/api\/projects\/[^/]+\/conversations$/.test(new URL(response.url()).pathname)&&response.status()===503&&refreshChatErrors>=4);
    assert.equal((await page.request.post(setup.origin+'/api/__qualification/reopen')).status(),200);
    await refresh;
    await page.getByRole('alert').filter({hasText:'Some workspace data could not be refreshed'}).waitFor();
    await chatRefresh;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.getByRole('textbox',{name:'Name',exact:true}).inputValue(),'Keep this draft','A failed background refresh must not unmount the draft');
    assert.equal(await page.getByText(absent,{exact:true}).count(),0,'Cached Chat metadata remains usable after failed refresh retries');
    const projectWarning=page.getByRole('alert').filter({hasText:'Qualification project refresh unavailable'});
    const chatWarning=page.getByRole('alert').filter({hasText:'Qualification cached Chat refresh unavailable'});
    await projectWarning.waitFor();await chatWarning.waitFor();
    refreshChatFailure=false;refreshProjectFailure=false;
    await chatWarning.getByRole('button',{name:'Retry',exact:true}).click();await chatWarning.waitFor({state:'hidden'});
    assert.equal(await page.getByRole('textbox',{name:'Name',exact:true}).inputValue(),'Keep this draft','Chat refresh retry preserves the draft');
    await projectWarning.getByRole('button',{name:'Retry',exact:true}).click();await projectWarning.waitFor({state:'hidden'});
    assert.equal(await page.getByRole('textbox',{name:'Name',exact:true}).inputValue(),'Keep this draft','Projects refresh retry preserves the draft');
   }else if(scenario==='project-error'){
    const error=page.getByRole('alert').filter({hasText:'Qualification Project list unavailable'});await error.waitFor();
    assert.equal(await page.getByText(absent,{exact:true}).count(),0,'A failed Projects query is not an empty collection');
    failProjects=false;await error.getByRole('button',{name:'Retry',exact:true}).click();await page.getByRole('textbox',{name:'Name',exact:true}).waitFor();
   }else if(scenario==='empty'){
    await page.getByText(absent,{exact:true}).waitFor();assert.equal(await page.getByRole('textbox',{name:'Name',exact:true}).count(),0);
   }else{
    await chatRequest;const error=page.getByRole('alert').filter({hasText:'Qualification Chat list unavailable'}).first();await error.waitFor();
    assert.equal(await page.getByText(absent,{exact:true}).count(),0,'A failed query is not an empty collection');
    failChats=false;await error.getByRole('button',{name:'Retry',exact:true}).click();await page.getByRole('textbox',{name:'Name',exact:true}).waitFor();
   }
   await page.screenshot({path:path.join(output,`${mobile?'phone':'desktop'}-${scenario}.png`)});
   assert.deepEqual(row.errors,[]);assert.deepEqual(row.blocked,[]);row.status='pass';console.log(`PASS ${mobile?'phone':'desktop'} ${scenario}`);
  }catch(error){row.status='failed';row.error=error.stack;await context.pages()[0]?.screenshot({path:path.join(output,`${mobile?'phone':'desktop'}-${scenario}-failure.png`)}).catch(()=>{});throw error;}
  finally{releaseProjects();releaseChats();await context.close();await writeFile(path.join(output,'results.json'),JSON.stringify(rows,null,2));}
 }
}finally{await browser?.close();fixture.kill('SIGTERM');await fixtureExit;}
