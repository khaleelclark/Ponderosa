import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE ?? import.meta.url);
const { chromium } = require('playwright');
const fixture = JSON.parse(readFileSync('/tmp/ponderosa-perf-sandbox.json', 'utf8'));
const origin = 'http://127.0.0.1:21843';
const label = process.argv[2] ?? 'baseline';
const distribution = values => {
  const sorted = [...values].sort((a,b) => a-b);
  return { count: sorted.length, p50: sorted[Math.floor(sorted.length*.5)], p95: sorted[Math.floor(sorted.length*.95)], max: sorted.at(-1) };
};
const requests = {};
for (const suffix of [`agent?projectId=${fixture.projects[0].id}&limit=5`, `agent?active=true&limit=5`, `agent?outcomes=true&limit=5`, `conversation?projectId=${fixture.projects[0].id}&limit=5`]) {
  const times=[];
  for(let i=0;i<30;i++) {const t=performance.now(); const r=await fetch(`${origin}/api/workspace/directory/${suffix}`);if(!r.ok)throw Error(await r.text());await r.json();times.push(performance.now()-t);}
  requests[suffix.replace(fixture.projects[0].id,'PROJECT')] = distribution(times);
}
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const pages=[];
for(let i=0;i<2;i++) {
  const context=await browser.newContext({ viewport:{width:1440,height:1000}, serviceWorkers:'block' });
  // Same synthetic workspace-event workload on both builds, using real HTTP
  // query responses. No production events or provider work are generated.
  await context.addInitScript(() => {
    const Original=window.EventSource;
    window.EventSource=class extends Original {
      constructor(url, options){super(url,options);if(String(url).includes('/workspace/stream')) {
        window.perfSource=this;window.perfCursor=0;
        this.addEventListener('workspace_status', e=>window.perfCursor=JSON.parse(e.data).cursor);
        this.addEventListener('message',e=>window.perfCursor=Math.max(window.perfCursor,JSON.parse(e.data).id));
      }}
    };
    window.perfEvent=event=>window.perfSource.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:++window.perfCursor,ts:new Date().toISOString(),event})}));
    window.perfLongTasks=[];new PerformanceObserver(list=>window.perfLongTasks.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:true});
  });
  const page=await context.newPage();
  const traffic=[];
  page.on('requestfinished',r=>{if(r.url().includes('/api/'))traffic.push({path:r.url().replace(origin,''),ms:r.timing().responseEnd});});
  const project=fixture.projects[i];
  const target=`${origin}/projects/${project.id}/chats/${project.conversations[0].id}`;
  const start=performance.now();await page.goto(target);await page.getByText('All Chats',{exact:true}).first().waitFor();
  const initial=performance.now()-start;
  await page.waitForTimeout(2000);
  const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');
  const before=await cdp.send('Performance.getMetrics');
  traffic.length=0;
  pages.push({page,context,cdp,before,traffic,initial,target});
}
for(let i=0;i<10;i++) {
  for(const {page} of pages)await page.evaluate(projectId=>{
    for(let j=0;j<3;j++)window.perfEvent({type:'coordination_changed',projectId,conversationIds:[]});
    window.perfEvent({type:'notification_changed',action:'read'});
  },fixture.projects[0].id);
  await new Promise(r=>setTimeout(r,1000));
}
await new Promise(r=>setTimeout(r,2000));
const clients=[];
for(const item of pages){
  const {page,cdp,before,traffic}=item;const after=await cdp.send('Performance.getMetrics');
  const metrics=Object.fromEntries(after.metrics.filter(m=>['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration'].includes(m.name)).map(m=>[m.name,m.value-(before.metrics.find(b=>b.name===m.name)?.value??0)]));
  const byPath={};for(const r of traffic){const path=r.path.replaceAll(fixture.projects[0].id,'PROJECT_A').replaceAll(fixture.projects[1].id,'PROJECT_B');(byPath[path]??=[]).push(r.ms);}
  const longTasks=await page.evaluate(()=>window.perfLongTasks);
  const t=performance.now();await page.reload();await page.getByText('All Chats',{exact:true}).first().waitFor();
  clients.push({initialMs:item.initial,repeatMs:performance.now()-t,metrics,longTasks:distribution(longTasks),requests:Object.fromEntries(Object.entries(byPath).map(([p,v])=>[p,distribution(v)]))});
  await page.screenshot({path:`/tmp/ponderosa-perf-${label}-${clients.length}.png`});
}
await browser.close();
const result={label,fixture:{projects:3,agents:36,chats:12},navigationMilestone:'sidebar All Chats visible',requests,clients};
writeFileSync(`/tmp/ponderosa-perf-${label}.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
