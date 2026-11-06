// Disposable first-open/state check; not a load or performance qualification.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {fixture} from '../shared/fixture.mjs';
import {serveFixture} from '../shared/serve-ui-fixture.mjs';
const out=process.env.PONDEROSA_UI_EVIDENCE;assert(out,'Owned evidence directory required');await mkdir(out,{recursive:true});
const result={kind:'Branch Chat defers unopened Workflow and retains first-used editor',requests:[],pageErrors:[],cleanup:[]};
let f,web,browser,context,page;
try{
 f=await fixture();
 const branch=f.ok(await f.api('POST','/api/branches',{name:'First-use Workflow',idempotencyKey:randomUUID()}));
 const chat=f.ok(await f.api('POST','/api/branches/'+branch.id+'/chats',{label:'Startup Chat',defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
 web=await serveFixture(f);const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
 browser=await chromium.launch({executablePath:'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
 context=await browser.newContext({viewport:{width:1365,height:768},serviceWorkers:'block'});
 page=await context.newPage();page.setDefaultTimeout(10000);
 page.on('pageerror',error=>result.pageErrors.push(error.message));
 page.on('request',request=>result.requests.push({method:request.method(),url:request.url(),path:new URL(request.url()).pathname,type:request.resourceType()}));
 await page.route('**/*',route=>['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
 await page.goto(web.origin+'/branches?branch='+branch.id+'&tab=chats&chat='+chat.id);
 await page.getByLabel('Message',{exact:true}).waitFor();
 assert.equal(await page.locator('#branch-workflow-panel .react-flow').count(),0,'Never-opened Workflow must not mount its hidden canvas');
 assert.equal(await page.getByRole('button',{name:'Add Your First Step',exact:true}).count(),0);
 assert(result.requests.some(row=>row.path==='/api/branches/engine/conversations/'+chat.id&&new URL(row.url).searchParams.get('limit')==='100'),'Chat keeps its existing 100-message request');
 const initialScripts=new Set(result.requests.filter(row=>row.type==='script').map(row=>row.url));
 await page.getByRole('tab',{name:'Workflow',exact:true}).click();
 await page.getByRole('button',{name:'Add Your First Step',exact:true}).waitFor();
 result.firstUseChunks=result.requests.filter(row=>row.type==='script'&&!initialScripts.has(row.url)).map(row=>row.path);
 assert(result.firstUseChunks.some(path=>path.startsWith('/static/js/async/')),'The workflow canvas chunk loads at its actual first use');
 await page.getByRole('button',{name:'Add Your First Step',exact:true}).click();
 await page.getByRole('menuitem',{name:'Script',exact:true}).click();
 const script=page.getByRole('textbox',{name:'Script',exact:true});await script.waitFor();
 const authored='console.log("retained workflow draft");';await script.fill(authored);
 const advanced=page.getByRole('button',{name:'Advanced',exact:true});
 if(await advanced.getAttribute('aria-expanded')!=='true')await advanced.click();
 const directory=page.getByRole('textbox',{name:'Working Directory',exact:true});await directory.waitFor();await directory.fill('.');
 if(await advanced.getAttribute('aria-expanded')!=='true')await advanced.click();
 await directory.waitFor();
 await page.getByRole('tab',{name:'Chats',exact:true}).click();await page.getByLabel('Message',{exact:true}).waitFor();
 await page.getByRole('tab',{name:'Workflow',exact:true}).click();
 await page.getByText('Step Settings',{exact:true}).waitFor();
 assert.equal(await script.inputValue(),authored,'The authored Workflow draft survives Chat navigation');
 assert.equal(await directory.inputValue(),'.');assert.equal(await advanced.getAttribute('aria-expanded'),'true');assert.equal(await directory.isVisible(),true,'The open Step editor/Advanced state stays mounted');
 assert.equal(await page.locator('#branch-workflow-panel .react-flow').count(),1);
 assert.deepEqual(result.pageErrors,[]);
 await page.screenshot({path:out+'/retained-workflow.png'});
 await context.close();
 context=await browser.newContext({viewport:{width:1365,height:768},serviceWorkers:'block'});
 page=await context.newPage();page.setDefaultTimeout(10000);
 page.on('pageerror',error=>result.pageErrors.push(error.message));
 await page.route('**/*',route=>['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
 await page.goto(web.origin+'/branches?branch='+branch.id+'&tab=workflow');
 await page.getByRole('button',{name:'Add Your First Step',exact:true}).waitFor();
 assert.equal(await page.locator('#branch-workflow-panel .react-flow').count(),1);
 assert.deepEqual(result.pageErrors,[]);result.directWorkflowAvailable=true;result.passed=true;
}catch(error){result.error=error.stack;if(page)await page.screenshot({path:out+'/failure.png',timeout:3000}).catch(()=>{});}
finally{
 for(const [name,close]of[['context',()=>context?.close()],['browser',()=>browser?.close()],['web',()=>web?.close()],['fixture',()=>f?.dispose(false)]])try{await close();result.cleanup.push({name,status:'complete'});}catch(error){result.cleanup.push({name,status:'failed',error:String(error)});}
 await writeFile(out+'/result.json',JSON.stringify(result,null,2));
}
console.log(JSON.stringify({passed:result.passed,error:result.error,firstUseChunks:result.firstUseChunks,cleanup:result.cleanup}));
if(!result.passed||result.cleanup.some(row=>row.status!=='complete'))process.exitCode=1;
