// Disposable first-open/state/retry checks; no load or performance qualification.
import assert from 'node:assert/strict';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {fixture} from '../shared/fixture.mjs';
import {serveFixture} from '../shared/serve-ui-fixture.mjs';
const out=process.env.PONDEROSA_UI_EVIDENCE;assert(out,'Owned evidence directory required');await mkdir(out,{recursive:true});
const assetRoot=fileURLToPath(new URL('../../apps/web/dist/',import.meta.url));
const chunks=await Promise.all((await readdir(path.join(assetRoot,'static/js/async'))).filter(name=>name.endsWith('.js')).map(async name=>({name,text:await readFile(path.join(assetRoot,'static/js/async',name),'utf8')})));
const chunkWith=marker=>{const matches=chunks.filter(chunk=>chunk.text.includes(marker));assert.equal(matches.length,1,'Unique built module marker '+marker);return '/static/js/async/'+matches[0].name;};
const editorChunk=chunkWith('Loading Workflow Canvas'),nodeEditorChunk=chunkWith('Select a step to edit it.');
const branchChunk=chunkWith('BranchesView:()=>');assert.notEqual(editorChunk,branchChunk);assert.notEqual(nodeEditorChunk,branchChunk);
const result={kind:'Branch Chat defers editor code; first-use, retention and explicit retry',editorChunk,nodeEditorChunk,branchChunk,cells:[],cleanup:[]};
let f,web,browser,context,page;
const persist=()=>writeFile(out+'/result.json',JSON.stringify(result,null,2));
try{
 f=await fixture();
 const branch=f.ok(await f.api('POST','/api/branches',{name:'First-use Workflow',idempotencyKey:randomUUID()}));
 const chat=f.ok(await f.api('POST','/api/branches/'+branch.id+'/chats',{label:'Startup Chat',defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
 web=await serveFixture(f);const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
 browser=await chromium.launch({executablePath:'/opt/google/chrome/chrome',headless:true,chromiumSandbox:true});
 const chatUrl=web.origin+'/branches?branch='+branch.id+'&tab=chats&chat='+chat.id;
 for(const mobile of [false,true])for(const kind of ['retained-editor','settings-first','editor-retry','direct-workflow']){
  const cell=mobile?'phone':'desktop',row={cell,kind,status:'started',requests:[],pageErrors:[],external:[]};result.cells.push(row);let allowEditor=kind!=='editor-retry';
  context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1365,height:768},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
  page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>row.pageErrors.push(error.message));
  page.on('request',request=>row.requests.push({method:request.method(),path:new URL(request.url()).pathname,url:request.url(),type:request.resourceType()}));
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==web.origin){row.external.push(url.href);return route.abort();}if(url.pathname===editorChunk){row.editorRequests=(row.editorRequests??0)+1;if(!allowEditor){row.blockedEditorRequests=(row.blockedEditorRequests??0)+1;return route.abort('failed');}}return route.continue();});
  const turnsBefore=f.turns.map(turn=>turn.turnId),picture=label=>page.screenshot({path:`${out}/${cell}-${kind}-${label}.png`});
  const tab=name=>page.getByRole('tab',{name,exact:true}).click();
  const chatReady=()=>page.getByLabel('Message',{exact:true}).waitFor();
  try{
   if(kind==='direct-workflow'){
    await page.goto(web.origin+'/branches?branch='+branch.id+'&tab=workflow');await page.getByRole('button',{name:'Add Your First Step',exact:true}).waitFor();
    assert.equal(await page.locator('#branch-workflow-panel .react-flow').count(),1);row.directWorkflowAvailable=true;
   }else{
    await page.goto(chatUrl);await chatReady();
    assert.equal(await page.locator('#branch-workflow-panel .react-flow').count(),0,'Unvisited Workflow stays unmounted');
    assert.equal(await page.getByRole('button',{name:'Add Your First Step',exact:true}).count(),0);
    assert(row.requests.some(request=>request.path==='/api/branches/engine/conversations/'+chat.id&&new URL(request.url).searchParams.get('limit')==='100'),'Existing canonical tail bound stays100');
    assert(!row.requests.some(request=>[editorChunk,nodeEditorChunk].includes(request.path)),'Cold Chat must not request editor module or NodeEditor code');
    row.coldScripts=row.requests.filter(request=>request.type==='script').map(request=>request.path);
    const chatDraft=`Retained ${cell} ${kind} Chat draft λ😀`;await page.getByLabel('Message',{exact:true}).fill(chatDraft);
    if(kind==='settings-first'){
     await tab('Settings');const policy=page.getByRole('spinbutton',{name:'Concurrent Executions',exact:true});await policy.waitFor();await policy.fill('9');
     assert(row.requests.some(request=>request.path===editorChunk),'First Settings loads its own export from editor module');
     assert.equal(await page.locator('.react-flow').count(),0,'Settings first-use must not mount the workflow canvas');
     await tab('Chats');await chatReady();assert.equal(await page.getByLabel('Message',{exact:true}).innerText(),chatDraft);
     await tab('Settings');assert.equal(await policy.inputValue(),'9','Settings draft survives Chat navigation');
     await tab('Workflow');await page.getByRole('button',{name:'Add Your First Step',exact:true}).waitFor();
    }else{
     await tab('Workflow');
     if(kind==='editor-retry'){
      await page.getByText('This view could not be loaded.',{exact:true}).waitFor();assert.equal(await page.locator('#branch-workflow-panel .react-flow').count(),0);
      assert.equal(row.blockedEditorRequests,1,'A rejected view does not retry automatically');await picture('explicit-retry');allowEditor=true;await page.getByRole('button',{name:'Try Again',exact:true}).click();row.retry='explicit';
     }
     await page.getByRole('button',{name:'Add Your First Step',exact:true}).waitFor();assert(row.requests.some(request=>request.path===editorChunk));if(kind==='editor-retry')assert.equal(row.editorRequests,2,'Exactly one explicit retry downloads the view');
     if(kind==='retained-editor'){
      await page.getByRole('button',{name:'Add Your First Step',exact:true}).click();await page.getByRole('menuitem',{name:'Script',exact:true}).click();
      const script=page.getByRole('textbox',{name:'Script',exact:true});await script.waitFor();const authored='console.log("retained workflow draft");';await script.fill(authored);
      const advanced=page.getByRole('button',{name:'Advanced',exact:true});if(await advanced.getAttribute('aria-expanded')!=='true')await advanced.click();
      const directory=page.getByRole('textbox',{name:'Working Directory',exact:true});await directory.waitFor();await directory.fill('.');if(await advanced.getAttribute('aria-expanded')!=='true')await advanced.click();await directory.waitFor();
      await tab('Chats');await chatReady();assert.equal(await page.getByLabel('Message',{exact:true}).innerText(),chatDraft);
      await tab('Workflow');await page.getByText('Step Settings',{exact:true}).waitFor();
      assert.equal(await script.inputValue(),authored);assert.equal(await directory.inputValue(),'.');assert.equal(await advanced.getAttribute('aria-expanded'),'true');assert.equal(await directory.isVisible(),true,'Open Advanced editor state stays mounted');
      await page.getByRole('button',{name:'Close Step Settings',exact:true}).click();await page.getByRole('button',{name:'Explore Workflow',exact:true}).click();
      const viewport=page.locator('#branch-workflow-panel .react-flow__viewport'),before=await viewport.getAttribute('style');await page.getByRole('button',{name:'Zoom In',exact:true}).click();
      await page.waitForFunction(before=>document.querySelector('#branch-workflow-panel .react-flow__viewport')?.getAttribute('style')!==before,before);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));row.retainedViewport=await viewport.getAttribute('style');
      await tab('Settings');const policy=page.getByRole('spinbutton',{name:'Concurrent Executions',exact:true});await policy.waitFor();await policy.fill('7');
      await tab('Chats');await chatReady();assert.equal(await page.getByLabel('Message',{exact:true}).innerText(),chatDraft);
      await tab('Workflow');await page.getByRole('button',{name:'Return To Workflow',exact:true}).waitFor();
      assert.equal(await viewport.getAttribute('style'),row.retainedViewport,'Actual explored viewport survives Settings and Chat navigation');
      await tab('Settings');assert.equal(await policy.inputValue(),'7','Execution settings retain authored policy through another route');
     }else{
      await tab('Chats');await chatReady();assert.equal(await page.getByLabel('Message',{exact:true}).innerText(),chatDraft,'Explicit chunk retry preserves original Chat draft');
      await tab('Workflow');await page.getByRole('button',{name:'Add Your First Step',exact:true}).waitFor();
     }
    }
   }
   assert.deepEqual(f.turns.map(turn=>turn.turnId),turnsBefore,'Opening editor/settings cannot admit provider work');assert.deepEqual(row.pageErrors,[]);assert.deepEqual(row.external,[]);await picture('complete');row.status='pass';
  }catch(error){row.status='failed';row.error=error.stack;row.visibleText=await page.locator('body').innerText().catch(()=>null);await picture('failure').catch(()=>{});throw error;}
  finally{await context.close();context=undefined;row.contextClosed=true;await persist();}
 }
 result.passed=true;
}catch(error){result.error=error.stack;}
finally{
 for(const [name,close]of[['context',()=>context?.close()],['browser',()=>browser?.close()],['web',()=>web?.close()],['fixture',()=>f?.dispose(false)]])try{await close();result.cleanup.push({name,status:'complete'});}catch(error){result.cleanup.push({name,status:'failed',error:String(error)});}
 await persist();
}
console.log(JSON.stringify({passed:result.passed,error:result.error,cells:result.cells.map(({cell,kind,status,error})=>({cell,kind,status,error})),cleanup:result.cleanup}));
if(!result.passed||result.cleanup.some(row=>row.status!=='complete'))process.exitCode=1;
