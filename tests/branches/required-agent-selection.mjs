// Focused disposable form validation and publication check; no load benchmark.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {fixture} from '../shared/fixture.mjs';
import {serveFixture} from '../shared/serve-ui-fixture.mjs';
const out=process.env.PONDEROSA_UI_EVIDENCE;assert(out,'Owned evidence directory required');await mkdir(out,{recursive:true});
const result={kind:'required existing-Agent choice interaction',requests:[],pageErrors:[],cleanup:[]};
let f,web,browser,context,page;
try{
 f=await fixture();
 const branch=f.ok(await f.api('POST','/api/branches',{name:'Required Agent choice',idempotencyKey:randomUUID()}));
 const chat=f.ok(await f.api('POST','/api/branches/'+branch.id+'/chats',{label:'Required Agent Chat',defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
 const worker=f.ok(await f.api('POST','/api/branches/engine/projects/'+chat.projectId+'/agents',{title:'Selected Branch worker',engine:'codex',conversationId:chat.id,idempotencyKey:randomUUID()}));
 web=await serveFixture(f);
 const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
 browser=await chromium.launch({executablePath:'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
 context=await browser.newContext({viewport:{width:1365,height:768},serviceWorkers:'block'});
 page=await context.newPage();page.setDefaultTimeout(10000);
 page.on('pageerror',error=>result.pageErrors.push(error.message));
 page.on('request',request=>result.requests.push({method:request.method(),path:new URL(request.url()).pathname}));
 await page.route('**/*',route=>['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
 await page.goto(web.origin+'/branches?branch='+branch.id+'&tab=workflow');
 await page.getByRole('button',{name:'Add Your First Step',exact:true}).click();
 await page.getByRole('menuitem',{name:'Agent Task',exact:true}).click();
 const picker=page.getByRole('combobox',{name:'Agent',exact:true});await picker.waitFor();
 await page.getByRole('button',{name:'Save Workflow',exact:true}).click();
 await page.getByText('Choose an Agent',{exact:true}).waitFor();
 assert.equal(await picker.getAttribute('aria-invalid'),'true');
 await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-invalid')==='true');
 assert.equal(result.requests.filter(row=>row.method==='POST'&&row.path==='/api/branches/preview').length,0,'An empty required choice must not be sent as an unavailable Agent');
 result.emptyChoiceValidated=true;
 await picker.click();await page.getByRole('option').filter({hasText:worker.title}).click();
 await page.getByLabel('Agent Instructions',{exact:true}).fill('Inspect this controlled workflow input.');
 const pending=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/branches/preview'&&response.request().method()==='POST');
 await page.getByRole('button',{name:'Save Workflow',exact:true}).click();
 const preview=await pending;assert(preview.ok(),'A valid owned Agent must pass preview');result.previewStatus=preview.status();
 await page.getByRole('dialog',{name:'Review deployment',exact:true}).waitFor();
 const publishing=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/branches/deploy'&&response.request().method()==='POST');
 await page.getByRole('button',{name:'Publish workflow',exact:true}).click();
 const published=await publishing;assert(published.ok(),'A valid choice must publish');result.publishStatus=published.status();
 const stored=f.ok(await f.api('GET','/api/branches/'+branch.id)),bindings=f.ok(await f.api('GET','/api/branches/'+branch.id+'/configuration'));
 assert(stored.versionId);assert(Object.values(bindings.agents).includes(worker.id));
 assert.equal(f.turns.length,0,'Publication must not execute a native Agent job');
 assert.deepEqual(result.pageErrors,[]);result.validChoiceSaved=true;result.passed=true;
 await page.screenshot({path:out+'/published-choice.png'});
}catch(error){result.error=error.stack;if(page)await page.screenshot({path:out+'/failure.png',timeout:3000}).catch(()=>{});}
finally{
 for(const [name,close] of [['context',()=>context?.close()],['browser',()=>browser?.close()],['web',()=>web?.close()],['fixture',()=>f?.dispose(false)]])try{await close();result.cleanup.push({name,status:'complete'});}catch(error){result.cleanup.push({name,status:'failed',error:String(error)});}
 await writeFile(out+'/result.json',JSON.stringify(result,null,2));
}
console.log(JSON.stringify({passed:result.passed,error:result.error,emptyChoiceValidated:result.emptyChoiceValidated,validChoiceSaved:result.validChoiceSaved,previewStatus:result.previewStatus,publishStatus:result.publishStatus,cleanup:result.cleanup}));
if(!result.passed||result.cleanup.some(row=>row.status!=='complete'))process.exitCode=1;
