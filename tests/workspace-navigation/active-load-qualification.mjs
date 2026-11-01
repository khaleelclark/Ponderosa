// Proof defaults to one session/cell. The heavy 32-session mode requires explicit method acceptance.
import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {until} from '../shared/fixture.mjs';
import {createLoadFixture} from '../shared/ui-load-fixture.mjs';import {serveFixture} from '../shared/serve-ui-fixture.mjs';import {installTimingObserver,summarizeTimings} from './event-timing-observer.mjs';
const require=createRequire(new URL('../../apps/server/package.json',import.meta.url)),{chromium}=require('playwright-core');
const out=process.env.PONDEROSA_LOAD_EVIDENCE;assert(out,'Owned evidence directory required');await mkdir(out,{recursive:true});
const full=process.env.PONDEROSA_LOAD_MODE==='full';assert(!full||process.env.PONDEROSA_ACCEPTED_METHOD_RECEIPT,'Heavy run requires accepted method receipt path');
// A caller-supplied retained primary profile must be reviewed; a label or CDP command is insufficient.
let primaryProfile=null;
{
 const receipt=process.env.PONDEROSA_MOBILE_PROFILE_RECEIPT??'tests/workspace-navigation/lighthouse-13.6.0/profile.json';
 primaryProfile=JSON.parse(await readFile(receipt,'utf8'));
 assert(primaryProfile.version&&primaryProfile.source&&primaryProfile.sha256&&primaryProfile.config,'Primary version/source/hash/config required');
 assert.equal(createHash('sha256').update(await readFile(primaryProfile.source)).digest('hex'),primaryProfile.sha256,'Retained primary source bytes must match receipt');
 const p=primaryProfile.config;assert.deepEqual([p.width,p.height,p.dpr,p.cpu,p.mobile,p.touch],[412,823,1.75,4,true,true],'Reconcile pinned primary profile with proposal before running; no silent profile drift');
}
const results=[];for(const product of ['core','branches'])for(const mobile of [false,true])for(let session=0;session<(full?8:1);session++)results.push({id:`${product}-${mobile?'phone':'desktop'}-${session}`,product,mobile,session,status:'planned'});await writeFile(out+'/sessions.json',JSON.stringify({full,results},null,2));
const f=await createLoadFixture(out);let browser,web;
try{
 web=await serveFixture(f.f);browser=await chromium.launch({executablePath:'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
 for(const product of ['core','branches']){
  await f.activate(product);
  for(const mobile of [false,true])for(let session=0;session<(full?8:1);session++){
   const id=`${product}-${mobile?'phone':'desktop'}-${session}`,row=Object.assign(results.find(r=>r.id===id),{status:'started',profile:mobile?primaryProfile.config:{width:1365,height:768,dpr:1,cpu:1,mobile:false,touch:false}});
   const context=await browser.newContext({viewport:{width:row.profile.width,height:row.profile.height},deviceScaleFactor:row.profile.dpr,isMobile:mobile,hasTouch:mobile,...(mobile?{userAgent:row.profile.ua,screen:{width:row.profile.screenWidth,height:row.profile.screenHeight}}:{}),serviceWorkers:'block',recordVideo:{dir:out+'/video'}});
   try{
    const page=await context.newPage();page.setDefaultTimeout(10000);row.errors=[];page.on('pageerror',e=>row.errors.push(e.message));
    await page.route('**/*',route=>['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
    await page.addInitScript(installTimingObserver);await page.addInitScript(()=>localStorage.setItem('ponderosa-color-mode','light'));
    const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:row.profile.cpu});
    row.before=await f.snapshot(product);assert.ok(row.before.runs.every(r=>r.status==='running'&&r.alive));
    row.navigation={url:web.origin+f.products[product].route,startedAt:Date.now(),seed:f.products[product].seed,profile:row.profile,primaryProfile};await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});await page.goto(row.navigation.url);const editor=page.getByLabel('Message',{exact:true});await editor.waitFor();
    const seed=f.products[product].seed;await page.locator(`[id=${JSON.stringify(seed.lastId)}]`).waitFor({state:'visible'});
    row.loadedHistory=await page.locator('article.chat-message').evaluateAll(nodes=>nodes.map(n=>({id:n.id,text:n.textContent})));assert(row.loadedHistory.some(n=>n.id===seed.lastId),'Canonical 10k seed tail must actually render, not just editor shell');
    row.historyPolicy='10k canonical backing history, bounded initial rendered page; no claim all10k DOM nodes loaded';await page.evaluate(()=>window.__uiTiming.marks.push({name:'editor-ready',time:performance.now()}));
    for(let repeat=0;repeat<2;repeat++){
     await editor.click();await page.keyboard.type('Forty input characters for timing proof!',{delay:75});await page.keyboard.press('Control+A');await page.keyboard.press('Backspace');
     await page.mouse.wheel(0,-500);await page.keyboard.press('Control+k');const search=page.getByRole('combobox',{name:'Search Ponderosa',exact:true});await search.waitFor();await page.keyboard.type('Qualification');await page.keyboard.press('Escape');
     if(full){
      await page.getByRole('button',{name:'Chat settings and actions',exact:true}).click();await page.getByRole('menuitem',{name:'Rename',exact:true}).click();const name=page.getByLabel('Chat name',{exact:true});await name.waitFor();await name.press('Control+A');await name.pressSequentially(`Load ${product} ${session} ${repeat}`);await name.press('Enter');await name.waitFor({state:'hidden'});
      await editor.click();await page.keyboard.type('#Working');await page.getByRole('option').filter({hasText:'Working'}).first().click();await page.keyboard.type('Timed short message');await page.getByRole('button',{name:'Send message',exact:true}).click();
     }
    }
    // One frame and observer delivery task: observation flush only, never included as interaction latency.
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0))));
    row.raw=await page.evaluate(()=>window.__finalizeUiTiming());row.raw.namespace=`${id}/${row.raw.documentId}`;row.emulation=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,ua:navigator.userAgent,visibility:document.visibilityState}));await until(async()=>{row.after=await f.snapshot(product);return row.after.runs.every((r,i)=>r.status==='running'&&r.alive&&r.progress>row.before.runs[i].progress);},'twenty checkpoints advance across observation window');
    assert.ok(row.after.runs.every((r,i)=>r.status==='running'&&r.alive&&r.progress>row.before.runs[i].progress),'All twenty must keep progressing during session');
    f.assertContinuity();row.summary=summarizeTimings([row.raw]);assert.deepEqual(row.errors,[]);await page.screenshot({path:out+'/'+id+'.png'});row.status='complete';
   }catch(error){row.status='failed';row.error=error.stack;throw error;}
   finally{await context.close();await writeFile(out+'/sessions.json',JSON.stringify({full,methodReceipt:process.env.PONDEROSA_ACCEPTED_METHOD_RECEIPT??null,browser:await browser.version(),results},null,2));}
  }
  await f.deactivate(product);
 }
 for(const product of ['core','branches'])for(const mobile of [false,true]){
  const cells=results.filter(r=>r.product===product&&r.mobile===mobile);assert.equal(cells.length,full?8:1);const summary=summarizeTimings(cells.map(r=>r.raw));await writeFile(out+`/${product}-${mobile?'phone':'desktop'}-summary.json`,JSON.stringify(summary,null,2));
  if(full){assert.ok(summary.qualifiedPopulation,'All-interaction population not established; observed-only latency cannot qualify');assert.ok(summary.p75BelowFloor||summary.p75<=200);const lcps=summary.sessions.map(s=>s.lcp).sort((a,b)=>a-b);assert.ok(lcps[5]<=2500,'Predeclared rank 6 of 8 LCP');}
 }
 console.log(JSON.stringify({complete:true,full,sessions:results.length}));
}finally{await browser?.close();await web?.close();await f.close();}
