import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {serveFixture} from '../shared/serve-ui-fixture.mjs';
const {fixture,until}=await import('../shared/fixture.mjs');
const {AgentStore,BranchStore,CoordinationV3Store}=await import('../../packages/agents/dist/index.js');

const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
let store,browser,web;
const f=await fixture({storeFactory:dataDir=>store=new AgentStore(dataDir)});
const post=async(path,body)=>f.ok(await f.api('POST',path,body));
try{
 const name='Run History filter qualification';
 const owner=await post('/api/branches',{name,idempotencyKey:randomUUID()});
 const filterBranch=await post('/api/branches/deploy',{branchId:owner.id,chatId:owner.chatId,expectedVersionId:owner.versionId,idempotencyKey:randomUUID(),
  definition:{schema:'ponderosa.branch.v1',name,entry:'report',trigger:{kind:'manual'},
   steps:[{id:'report',kind:'script',runtime:'node',cwdRef:'workspace',timeoutMs:5000,source:"process.stdout.write('Original selected report')"}],
   controls:[],edges:[],policy:{maxConcurrentExecutions:2,failure:{action:'stop'}}},
  bindings:{agents:{},directories:{workspace:f.root}}});
 const oldest=await post(`/api/branches/${filterBranch.id}/executions`,{input:'Keep the original report selected.',occurrenceKey:randomUUID()});
 await until(async()=>f.ok(await f.api('GET',`/api/branch-executions/${oldest.id}`)).execution.state==='completed','original Run completes',20000);
 const historyStore=new BranchStore(store.sqlite,new CoordinationV3Store(store.sqlite));
 const setState=store.sqlite.prepare('UPDATE branch_executions SET state=? WHERE id=?');
 store.sqlite.transaction(()=>{
  for(let i=0;i<165;i++){
   const seeded=historyStore.accept(filterBranch.id,'filter-history-'+i,'History entry '+i);
   setState.run(['completed','failed','canceled'][i%3],seeded.id);
  }
 })();
 web=await serveFixture(f);
 browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 for(const mobile of [false,true]){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:900},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
  const page=await context.newPage();page.setDefaultTimeout(12000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===web.origin?route.continue():route.abort());
  const activate=locator=>mobile?locator.tap():locator.click();
  const selected=page.getByRole('region',{name:'Selected Run'});
  const history=page.getByRole('region',{name:'Run History'});
  const button=(name,owner=selected)=>owner.getByRole('button',{name,exact:true});
  const filterButton=history.getByRole('button',{name:/^Filter runs/});
  const filterDialog=page.getByRole('dialog',{name:'Filter runs',exact:true});
  const historyList=history.getByRole('list',{name:'Workflow Runs'});
  const originalResult=selected.getByRole('region',{name:'Results'}).getByText('Original selected report',{exact:true});
  const stateLink=`${web.origin}/branches?branch=${filterBranch.id}&tab=executions&execution=${oldest.id}&state=failed`;
  await page.goto(stateLink);
  await originalResult.waitFor();
  if(mobile)await activate(button('Back to Run History'));
  await history.getByRole('button',{name:'Filter runs · Failed',exact:true}).waitFor();
  await history.getByText('This run is outside your filters',{exact:true}).waitFor();
  assert.equal(await historyList.locator('[aria-current="true"]').count(),0);
  assert.equal(await history.getByRole('list',{name:'Selected history run'}).locator('[aria-current="true"]').count(),1);
  const filterBox=await filterButton.boundingBox(),eventBox=await history.getByRole('button',{name:'Trigger Events'}).boundingBox();
  assert.ok(filterBox&&eventBox&&filterBox.width>eventBox.width&&eventBox.y>=filterBox.y+filterBox.height);
  await activate(filterButton);
  assert.equal(await filterDialog.getByRole('checkbox',{name:'Failed',exact:true}).isChecked(),true);
  await activate(filterDialog.getByText('Completed',{exact:true}));
  assert.deepEqual(new URL(page.url()).searchParams.getAll('state'),['failed'],'Checklist edits are staged');
  await activate(button('Apply',filterDialog));
  await history.getByRole('button',{name:'Filter runs · 2 statuses',exact:true}).waitFor();
  assert.deepEqual(new URL(page.url()).searchParams.getAll('state'),['completed','failed']);
  assert.equal(new URL(page.url()).searchParams.get('execution'),oldest.id);
  await until(async()=>await historyList.getByRole('button').count()===100,'first filtered page');
  assert.equal(await history.getByText('This run is outside your filters',{exact:true}).count(),0);
  assert.equal(await historyList.locator('[aria-current="true"]').count(),0,'The older matching selected run is beyond the first page');
  await activate(button('Load Older Runs',history));
  await until(async()=>await historyList.getByRole('button').count()===111,'both filtered pages');
  assert.equal(await historyList.locator('[aria-current="true"]').count(),1);
  assert.equal(await history.getByRole('list',{name:'Selected history run'}).count(),0);
  const previews=await historyList.getByText(/^History entry /).allTextContents();
  assert.deepEqual(previews,Array.from({length:165},(_,i)=>164-i).filter(i=>i%3!==2).map(i=>'History entry '+i));
  await activate(filterButton);
  await activate(button('Clear all',filterDialog));
  await activate(filterDialog.getByText('Skipped',{exact:true}));
  await activate(button('Apply',filterDialog));
  await history.getByText('No runs match these filters',{exact:true}).waitFor();
  await page.goBack();
  await history.getByRole('button',{name:'Filter runs · 2 statuses',exact:true}).waitFor();
  await until(async()=>await historyList.getByRole('button').count()===100,'Back resets filtered pagination');
  assert.equal(await history.getByText('This run is outside your filters',{exact:true}).count(),0);
  await page.reload();
  if(mobile)await activate(button('Back to Run History'));
  await history.getByRole('button',{name:'Filter runs · 2 statuses',exact:true}).waitFor();
  assert.deepEqual(new URL(page.url()).searchParams.getAll('state'),['completed','failed']);
  await activate(filterButton);
  assert.equal(await filterDialog.getByRole('checkbox',{name:'Completed',exact:true}).isChecked(),true);
  assert.equal(await filterDialog.getByRole('checkbox',{name:'Failed',exact:true}).isChecked(),true);
  await activate(button('Clear all',filterDialog));
  await activate(filterDialog.getByText('Skipped',{exact:true}));
  await activate(button('Apply',filterDialog));
  await history.getByText('No runs match these filters',{exact:true}).waitFor();
  await activate(button('Clear filters',history));
  await history.getByRole('button',{name:'Filter runs · All runs',exact:true}).waitFor();
  assert.deepEqual(new URL(page.url()).searchParams.getAll('state'),[]);
  assert.equal(new URL(page.url()).searchParams.get('execution'),oldest.id);
  if(mobile)await activate(history.getByRole('list',{name:'Selected history run'}).locator('[aria-current="true"]'));
  await originalResult.waitFor();
  assert.deepEqual(errors,[]);
  console.log(`Run History filters qualified on ${mobile?'390px touch phone':'1440px desktop'}`);
  await context.close();
 }
}finally{await browser?.close();await web?.close();await f.dispose();}
