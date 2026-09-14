// Read-only qualification: all non-read requests are blocked, including draft saves.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium }=createRequire(process.env.PLAYWRIGHT_PACKAGE || import.meta.url)('playwright');
if(!process.env.CHAT_URL || !process.env.WEB_DIST_BEFORE || !process.env.WEB_DIST_AFTER) throw Error('Set CHAT_URL and both WEB_DIST paths');
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
try {
 for(const [label,root] of [['before',process.env.WEB_DIST_BEFORE],['after',process.env.WEB_DIST_AFTER]]) {
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  const page=await context.newPage(), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
   window.__copied='';Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.__copied=text;}}});
   window.__long=[];new PerformanceObserver(list=>window.__long.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:true});
  });
  await page.route('**/*',route=>{
   if(!['GET','HEAD','OPTIONS'].includes(route.request().method()))return route.abort();
   const pathname=new URL(route.request().url()).pathname;
   if(pathname.startsWith('/static/')&&!pathname.includes('..'))return route.fulfill({path:root+pathname});
   if(route.request().isNavigationRequest())return route.fulfill({path:root+'/index.html',contentType:'text/html'});
   return route.continue();
  });
  const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');
  const start=performance.now();await page.goto(process.env.CHAT_URL);
  await page.locator('.composer-editor-input').waitFor();
  const navigationMs=performance.now()-start;await page.waitForTimeout(4000);
  const startup=await page.evaluate(()=>({longTaskCount:window.__long.length,longTaskMs:window.__long.reduce((a,b)=>a+b,0),images:performance.getEntriesByType('resource').filter(r=>r.initiatorType==='img').map(r=>({bytes:r.encodedBodySize}))}));
  const before=(await cdp.send('Performance.getMetrics')).metrics;
  await page.waitForTimeout(10000);
  const after=(await cdp.send('Performance.getMetrics')).metrics;
  const metric=(a,n)=>a.find(e=>e.name===n)?.value??0;
  let copies=0,hidden=0;
  const articles=page.locator('article.chat-message');
  for(let i=0;i<Math.min(30,await articles.count());i++) {
   const article=articles.nth(i),button=article.getByRole('button',{name:'Copy whole message',exact:true});
   if(!await button.count())continue;
   await article.hover();await button.click();copies++;
   const copied=await page.evaluate(()=>window.__copied);
   if(/^#broadcast\b/i.test(copied)&&!(await article.innerText()).includes('#broadcast'))hidden++;
  }
  console.log(JSON.stringify({label,navigationMs,startup,idleTaskMs:1000*(metric(after,'TaskDuration')-metric(before,'TaskDuration')),copies,hidden,errors}));
  if(label==='after') {assert.ok(copies>0);assert.equal(hidden,0);assert.deepEqual(errors,[]);}
  if(label==='after'&&process.env.SCREENSHOT_PATH)await page.screenshot({path:process.env.SCREENSHOT_PATH});
  await context.close();
 }
} finally {await browser.close();}
