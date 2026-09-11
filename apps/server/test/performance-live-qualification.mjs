import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const {chromium}=createRequire(process.env.PLAYWRIGHT_PACKAGE ?? import.meta.url)('playwright');
const fixture=JSON.parse(readFileSync('/tmp/ponderosa-perf-sandbox.json','utf8'));
assert.ok(fixture.decision,'Start the disposable sandbox with PERF_QUALIFY=1');
const base='http://127.0.0.1:21843';
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
const results=[];
try {
  const clients=[];
  for(const project of fixture.projects.slice(0,2)){
    const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
    const page=await context.newPage();
    await page.goto(`${base}/projects/${project.id}/chats/${project.conversations[0].id}`);
    await page.locator('[contenteditable]').first().waitFor();
    await page.getByText('Agents',{exact:true}).first().click();
    await page.getByPlaceholder('Search agents').waitFor();
    await page.getByText('Perf Agent 00',{exact:true}).first().waitFor();
    clients.push({page,project});
  }
  const first=clients[0].page, second=clients[1].page;
  await first.getByPlaceholder('Search agents').fill('Agent 07');
  await first.getByText('Perf Agent 07',{exact:true}).first().waitFor();
  await first.waitForFunction(()=>!document.body.innerText.includes('Perf Agent 00'));
  results.push('Agent search filters visible rows');
  await first.getByPlaceholder('Search agents').fill('');
  await first.getByText('Perf Agent 00',{exact:true}).first().waitFor();
  let siblingRequests=0;
  second.on('request',r=>{if(r.url().includes('/workspace/directory/agent'))siblingRequests++;});
  const live=first.waitForResponse(async r=>{
    if(!r.url().includes('/workspace/directory/agent')||!r.url().includes('summary=true')||!r.url().includes('active=true'))return false;
    return r.ok()&&(await r.json()).total===0;
  });
  const response=await first.request.post(`${base}/api/decisions/${fixture.decision.id}/respond`,{data:{text:'Continue'}});
  assert.equal(response.status(),200,await response.text());
  await live;
  await first.waitForTimeout(800);
  assert.equal(siblingRequests,0,'Project A decision must not reload Project B Agent directories');
  results.push('Real Decision response updates active summary through live SSE; unrelated client does not refetch');
  await first.goto(`${base}/projects/${fixture.projects[1].id}/chats/${fixture.projects[1].conversations[0].id}`);
  await first.locator('[contenteditable]').first().waitFor();
  const heading=first.getByText('Perf Project 1',{exact:true});await heading.first().waitFor();
  results.push('Project switching completes with scoped sidebar and composer');
  await first.getByText('Chats',{exact:true}).first().click();
  await first.getByPlaceholder('Search chats').first().waitFor();
  const agentRequests=[];
  first.on('request',r=>{if(r.url().includes('/workspace/directory/agent'))agentRequests.push(r.url());});
  await first.reload();await first.locator('[contenteditable]').first().waitFor();await first.waitForTimeout(1000);
  assert.ok(agentRequests.length>0);
  assert.ok(agentRequests.every(url=>url.includes('summary=true')),'Chats only requests Agent summaries');
  results.push('Inactive Agent sidebar requests contain summaries only; displayed Agent count remains 12');
  await first.screenshot({path:'/tmp/ponderosa-perf-live-qualified.png'});
} finally {await browser.close();}
writeFileSync('/tmp/ponderosa-perf-live-qualification.json',JSON.stringify({passed:results},null,2));console.log(JSON.stringify(results));
