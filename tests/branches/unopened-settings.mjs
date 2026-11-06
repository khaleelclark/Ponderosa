// Focused disposable interaction check, not load or performance qualification.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {fixture} from '../shared/fixture.mjs';
import {serveFixture} from '../shared/serve-ui-fixture.mjs';
const out=process.env.PONDEROSA_UI_EVIDENCE;assert(out,'Owned evidence directory required');await mkdir(out,{recursive:true});
const result={kind:'unopened Branch Settings request/error/draft interaction check',requests:[],pageErrors:[],cleanup:[]};
let f,web,browser,context,page,failCapabilities=true;
try{
 f=await fixture();
 const branch=f.ok(await f.api('POST','/api/branches',{name:'Deferred Settings',idempotencyKey:randomUUID()}));
 const chat=f.ok(await f.api('POST','/api/branches/'+branch.id+'/chats',{label:'Settings check Chat',defaultEngine:'codex'},{'idempotency-key':randomUUID()}));
 web=await serveFixture(f);
 const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
 browser=await chromium.launch({executablePath:'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
 const open=async route=>{
  context=await browser.newContext({viewport:{width:1365,height:768},serviceWorkers:'block'});
  page=await context.newPage();page.setDefaultTimeout(10000);
  page.on('pageerror',error=>result.pageErrors.push(error.message));
  page.on('request',request=>result.requests.push({method:request.method(),path:new URL(request.url()).pathname}));
  await page.route('**/*',route=>{
   const url=new URL(route.request().url());
   if(!['127.0.0.1','localhost'].includes(url.hostname))return route.abort();
   if(url.pathname==='/api/branches/'+branch.id+'/capabilities'&&failCapabilities)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Controlled capability read unavailable'})});
   return route.continue();
  });
  await page.goto(web.origin+route);
 };
 const base='/branches?branch='+branch.id;
 await open(base+'&tab=chats&chat='+chat.id);
 await page.getByLabel('Message',{exact:true}).waitFor();
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const deferred=['settings','capabilities','dependencies'].map(part=>'/api/branches/'+branch.id+'/'+part);
 assert.equal(result.requests.filter(request=>deferred.includes(request.path)).length,0,'Chat must not mount never-opened Settings owners');
 assert.equal(await page.getByLabel('Graph traversals',{exact:true}).count(),0);
 result.beforeFirstSelection=result.requests.length;
 await page.getByRole('tab',{name:'Settings',exact:true}).click();
 await page.getByText('Capabilities could not be loaded.',{exact:false}).waitFor();
 result.firstSelectionErrorVisible=true;failCapabilities=false;
 await page.getByRole('button',{name:'Reload current policy',exact:true}).click();
 await page.getByText('Branch capabilities',{exact:true}).waitFor();
 await page.getByText('Advanced local execution limits',{exact:true}).click();
 const limit=page.getByLabel('Graph traversals',{exact:true});await limit.waitFor();await limit.fill('321');
 await page.getByRole('tab',{name:'Chats',exact:true}).click();await page.getByLabel('Message',{exact:true}).waitFor();
 await page.getByRole('tab',{name:'Settings',exact:true}).click();
 assert.equal(await limit.inputValue(),'321','Returning to Settings must retain the unsaved draft');
 assert.equal(result.requests.filter(request=>request.method==='PUT'&&request.path===deferred[0]).length,0,'Draft check must not persist settings');
 result.draftRetained=true;await page.screenshot({path:out+'/retained-settings.png'});
 await context.close();context=undefined;
 await open(base+'&tab=settings');
 await page.getByText('Execution Controls',{exact:true}).waitFor();
 await page.getByText('Branch capabilities',{exact:true}).waitFor();
 await page.getByText('Advanced local execution limits',{exact:true}).click();
 assert.notEqual(await page.getByLabel('Graph traversals',{exact:true}).inputValue(),'321','Unsaved local draft must not become stored settings');
 result.directSettingsAvailable=true;assert.deepEqual(result.pageErrors,[]);result.passed=true;
}catch(error){result.error=error.stack;if(page)await page.screenshot({path:out+'/failure.png',timeout:3000}).catch(()=>{});}
finally{
 for(const [name,close] of [['context',()=>context?.close()],['browser',()=>browser?.close()],['web',()=>web?.close()],['fixture',()=>f?.dispose(false)]])try{await close();result.cleanup.push({name,status:'complete'});}catch(error){result.cleanup.push({name,status:'failed',error:String(error)});}
 await writeFile(out+'/result.json',JSON.stringify(result,null,2));
}
console.log(JSON.stringify({passed:result.passed,error:result.error,firstSelectionErrorVisible:result.firstSelectionErrorVisible,draftRetained:result.draftRetained,directSettingsAvailable:result.directSettingsAvailable,cleanup:result.cleanup}));
if(!result.passed||result.cleanup.some(row=>row.status!=='complete'))process.exitCode=1;
