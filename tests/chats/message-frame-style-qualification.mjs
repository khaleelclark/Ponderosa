// Manual paired-build compatibility check; not performance qualification.
import assert from 'node:assert/strict';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createLoadFixture} from '../shared/ui-load-fixture.mjs';
import {serveFixture} from '../shared/serve-ui-fixture.mjs';
const out=path.resolve(process.argv[2]);await mkdir(out,{recursive:true});
const baselineRepo=process.env.BASELINE_REPO;assert(baselineRepo,'Explicit frozen baseline repository required');
const {serveFixture:serveBaseline}=await import(pathToFileURL(path.join(baselineRepo,'tests/shared/serve-ui-fixture.mjs')));
const require=createRequire(new URL('../../apps/server/package.json',import.meta.url));const {chromium}=require('playwright-core');
let f,web,baseline,browser;const contexts=[],results=[];
function near(actual,expected,label){assert.ok(Math.abs(actual-expected)<=1,`${label}: ${actual} vs ${expected}`);}
async function measure(row){return row.evaluate(a=>{
 const row=a.lastElementChild,col=row.lastElementChild,header=col.firstElementChild,body=col.children[1],time=col.querySelector('time'),button=col.querySelector('button[aria-label="Copy whole message"]');
 const box=e=>{const r=e.getBoundingClientRect(),ar=a.getBoundingClientRect();return {x:r.x-ar.x,y:r.y-ar.y,width:r.width,height:r.height};};
 const style=(e,keys)=>Object.fromEntries(keys.map(k=>[k,getComputedStyle(e)[k]]));
 return {boxes:{article:box(a),row:box(row),column:box(col),header:box(header),body:box(body)},bubble:style(body,['paddingTop','paddingRight','paddingBottom','paddingLeft','borderRadius','backgroundColor','color']),time:{...style(time,['fontFamily','fontSize','fontWeight','lineHeight']),dateTime:time.dateTime,title:time.title,text:time.textContent},button:style(button,['minWidth','minHeight','paddingTop','paddingRight','paddingBottom','paddingLeft'])};
 });}
async function context(origin,phone,mode){const c=await browser.newContext({viewport:phone?{width:412,height:823}:{width:1365,height:768},isMobile:phone,hasTouch:phone,serviceWorkers:'block'});contexts.push(c);
 await c.addInitScript(mode=>{localStorage.setItem('ponderosa-color-mode',mode);window.__copied=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.__copied.push(text)}});},mode);
 await c.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());return c;}
async function ready(page,origin,p){await page.goto(origin+p.route,{waitUntil:'load'});await page.getByLabel('Message',{exact:true}).waitFor();const row=page.locator(`[id=${JSON.stringify('master-message-'+p.seed.lastId)}]`);await row.waitFor({state:'visible'});await page.evaluate(()=>document.fonts.ready);assert.equal(await page.locator('.chat-scroll-region article.chat-message').count(),100);return row;}
try{
 f=await createLoadFixture(out,{messages:100});const api=await f.f.listen(),bound={listen:async()=>api};web=await serveFixture(bound);baseline=await serveBaseline(bound);
 browser=await chromium.launch({executablePath:'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 for(const [product,mode,phone] of [['core','light',true],['core','dark',false],['branches','light',false],['branches','dark',true]]){
  const p=f.products[product],receipt=f.f.ok(await f.f.api('GET',p.prefix+'/conversations/'+p.chat.id+'?limit=100'));assert.equal(receipt.messages.length,100);
  const cells=[];
  for(const [name,host] of [['baseline',baseline],['new',web]]){const c=await context(host.origin,phone,mode),page=await c.newPage();page.setDefaultTimeout(10000);const row=await ready(page,host.origin,p);const before=await measure(row);
   const copy=row.getByRole('button',{name:'Copy whole message',exact:true});
   if(phone)await copy.tap();else{await row.hover();await copy.focus();await copy.press('Enter');}
   assert.deepEqual(await page.evaluate(()=>window.__copied),[p.seed.lastText]);assert.equal(await row.locator('time:visible').count(),phone?0:1,'Copy owns its click');
   if(phone){await row.locator('p').first().tap({position:{x:8,y:8}});await row.locator('time:visible').first().waitFor();assert.equal(await row.locator('time:visible').count(),1,'Body tap reveals native time');}
   await page.screenshot({path:path.join(out,`${product}-${mode}-${name}.png`)});cells.push({name,metrics:before});await c.close();contexts.splice(contexts.indexOf(c),1);
  }
  const [a,b]=cells.map(c=>c.metrics);for(const key of Object.keys(a.boxes))for(const prop of Object.keys(a.boxes[key]))near(b.boxes[key][prop],a.boxes[key][prop],`${product}/${mode}/${key}/${prop}`);
  assert.deepEqual(b.bubble,a.bubble);assert.equal(b.bubble.borderRadius,'24px');assert.deepEqual(b.time,a.time);assert.deepEqual(b.button,a.button);results.push({product,mode,phone,cells});await writeFile(path.join(out,'results.json'),JSON.stringify(results,null,2));
 }
 // Prefetch the existing lazy route while metadata is pending; a failed import
 // must still belong to the visible boundary and recover through its Retry.
 const asyncDir=new URL('../../apps/web/dist/static/js/async/',import.meta.url),files=await readdir(asyncDir);let routeChunk;
 for(const file of files.filter(x=>x.endsWith('.js'))){if((await readFile(new URL(file,asyncDir),'utf8')).includes('This project could not be loaded. Check the server connection and try again.')){assert.equal(routeChunk,undefined);routeChunk=file;}}
 assert(routeChunk,'Identify the actual ProjectShell artifact');let releaseMetadata,chunkSeen,deny=true;const held=new Promise(r=>releaseMetadata=r),seen=new Promise(r=>chunkSeen=r);
 const c=await context(web.origin,false,'light'),page=await c.newPage();page.setDefaultTimeout(10000);
 await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin!==web.origin)return route.abort();if(u.pathname.endsWith('/'+routeChunk)&&deny){chunkSeen();return route.fulfill({status:503,contentType:'text/javascript',body:'Controlled route failure'});}if(u.pathname==='/api/projects'||u.pathname==='/api/projects/'+f.products.core.chat.projectId)await held;return route.continue();});
 try{await page.goto(web.origin+f.products.core.route,{waitUntil:'domcontentloaded'});await Promise.race([seen,new Promise((_,reject)=>setTimeout(()=>reject(Error('Route chunk did not overlap pending metadata')),10000))]);releaseMetadata();await page.getByText('This view could not be loaded.',{exact:true}).waitFor();deny=false;await page.getByRole('button',{name:'Try Again',exact:true}).click();await page.getByLabel('Message',{exact:true}).waitFor();assert.equal(await page.locator('.chat-scroll-region article.chat-message').count(),100);results.push({routeChunk,earlyImport:true,visibleFailure:true,retryRecovered:true});}finally{releaseMetadata();await c.close();contexts.splice(contexts.indexOf(c),1);}
 await writeFile(path.join(out,'results.json'),JSON.stringify({passed:true,results},null,2));
}catch(error){await writeFile(path.join(out,'failure.json'),JSON.stringify({error:error.stack,results},null,2));throw error;}
finally{
 const stages=[],failures=[];
 const attempt=async(stage,resource,close)=>{if(!resource){stages.push({stage,status:'not-created'});return;}try{await close();stages.push({stage,status:'closed'});}catch(error){stages.push({stage,status:'failed',error:String(error)});failures.push(error);}};
 for(const [i,c] of contexts.entries())await attempt('context-'+i,c,()=>c.close());
 await attempt('browser',browser,()=>browser.close());
 await attempt('new-web-server',web,()=>web.close());
 await attempt('baseline-web-server',baseline,()=>baseline.close());
 await attempt('fixture',f,()=>f.close());
 await writeFile(path.join(out,'cleanup.json'),JSON.stringify({stages,passed:failures.length===0},null,2));
 if(failures.length)throw new AggregateError(failures,'Owned compatibility cleanup failed');
}
