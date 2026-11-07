// Real import UI with one lost acceptance response; synthetic template only.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {fixture,until} from '../shared/fixture.mjs';
const out=process.env.QUALIFICATION_DIRECTORY;assert(out);await mkdir(out,{recursive:true});
const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
const result={kind:'Synthetic template import, lost acceptance response, status-only recovery',sourceHead:process.env.QUALIFICATION_SOURCE_HEAD??'01931ae045e71f1b086b01e2f21813ccabbe2aa0',cells:[],cleanup:[]};
let f,browser,listener,store;
const persist=()=>writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));
try{
 const {AgentStore}=await import('../../packages/agents/dist/index.js');
 f=await fixture({webDist:fileURLToPath(new URL('../../apps/web/dist/',import.meta.url)),storeFactory:dir=>(store=new AgentStore(dir))});
 const source=await f.createChat('Synthetic import source');
 const sourceAgent=await f.createIdleAgent(source,'Reusable source expert');
 const child=await f.createIdleAgent(source,'Reusable source helper',sourceAgent.id);
 const origin=await f.listen();listener=f.app.server;result.origin=origin;result.fixtureRoot=f.root;
 const response=await fetch(`${origin}/api/agents/${sourceAgent.id}/export?mode=template&organization=true`);
 assert.equal(response.status,200);const packageBytes=Buffer.from(await response.arrayBuffer()),pkg=JSON.parse(packageBytes);
 assert.equal(pkg.mode,'template');assert.equal(pkg.agents.length,2);assert(pkg.agents.every(agent=>!(agent.history?.length)&&!(agent.artifacts?.length)));
 result.sourceAgentIds=[sourceAgent.id,child.id];result.packageMode=pkg.mode;result.packageMembers=pkg.agents.length;
 const sourceBefore=store.listAgents(source.projectId).map(agent=>({id:agent.id,title:agent.title,managerAgentId:agent.managerAgentId}));
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/opt/google/chrome/chrome',headless:true,chromiumSandbox:true});
 for(const mobile of [false,true]){
  const device=mobile?'phone':'desktop',dest=await f.createChat(`Recovered import ${device}`);
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block',recordVideo:{dir:path.join(out,'video',device)}});
  const row={device,destination:{projectId:dest.projectId,conversationId:dest.id},status:'started',requests:[],pageErrors:[],externalRequests:[],screens:[]};result.cells.push(row);let page,accepted;
  const beforeIds=store.listAgents(dest.projectId).map(agent=>agent.id),beforeTurns=f.turns.map(turn=>turn.turnId);
  async function picture(name){const file=`${device}-${name}.png`;await page.screenshot({path:path.join(out,file)});row.screens.push(file);}
  try{
   await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==origin){row.externalRequests.push(request.url());return route.abort();}
    row.requests.push({method:request.method(),path:url.pathname});
    if(request.method()==='POST'&&url.pathname===`/api/projects/${dest.projectId}/agent-import-operations`){
     assert.equal(accepted,undefined,'Only one import may be admitted');
     const reply=await route.fetch();assert(reply.status()>=200&&reply.status()<300,`Acceptance HTTP ${reply.status()}`);
     accepted=await reply.json();row.accepted={id:accepted.id,requestId:accepted.requestId,status:accepted.status};
     assert(accepted.id&&accepted.requestId);await route.abort('failed');return;
    }
    await route.continue();
   });
   page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>row.pageErrors.push(error.message));
   await page.goto(origin+'/create/agent');await page.getByRole('button',{name:'Import Agent package',exact:true}).click();
   const project=page.getByRole('combobox',{name:'Project',exact:true});if(await project.count()){await project.click();await page.getByRole('option',{name:`Recovered import ${device}`,exact:true}).click();}
   await page.getByText(`Destination chat: Recovered import ${device}`,{exact:true}).waitFor();
   await page.locator('input[type=file]').setInputFiles({name:'synthetic-expert-template.json',mimeType:'application/json',buffer:packageBytes});
   const engine=page.getByRole('combobox',{name:'Default Engine',exact:true});await engine.click();await page.getByRole('option',{name:'Controlled regression adapter',exact:true}).click();
   await picture('package-reviewed');
   await page.getByRole('button',{name:'Review access settings',exact:true}).click();
   const restrictions=page.getByRole('combobox',{name:'Restrictions for imported Agents',exact:true});await restrictions.click();await page.getByRole('option',{name:'Keep destination restrictions',exact:true}).click();
   for(const title of [sourceAgent.title,child.title])assert.equal(await page.getByText(`${title}: No source restrictions`,{exact:true}).count(),1,'actual source Agent names are readable and bound to their package refs');
   await picture('explicit-destination-restrictions');
   await page.getByRole('button',{name:'Import',exact:true}).click();
   await page.getByText('The original request may still be running. Check its status or retry the exact same package; no new import will be started automatically.',{exact:true}).waitFor();
   await until(()=>accepted,'observed accepted import response');
   await page.getByText('Importing Agent… Keep this window open.',{exact:true}).waitFor({state:'hidden'});
   await picture('acceptance-unconfirmed');
   row.requestsBeforeReload=row.requests.length;
   await page.reload();await page.getByRole('button',{name:'Import Agent package',exact:true}).click();
   await page.getByRole('button',{name:'Check import status',exact:true}).waitFor();await picture('saved-request-after-reload');
   await page.getByRole('button',{name:'Check import status',exact:true}).click();
   await page.getByRole('heading',{name:'Import complete',exact:true}).waitFor().catch(async()=>{await page.getByText('Import complete',{exact:true}).waitFor();});
   const operation=await (await fetch(`${origin}/api/projects/${dest.projectId}/agent-import-operations/${accepted.id}`)).json();
   assert.equal(operation.status,'completed');assert.equal(operation.requestId,accepted.requestId);assert(operation.result);assert.equal(operation.result.agentIds.length,2);
   row.completedOperation=operation;
   const doneBounds=await page.getByRole('button',{name:'Done',exact:true}).boundingBox(),viewport=page.viewportSize();
   assert(doneBounds&&doneBounds.y>=0&&doneBounds.y+doneBounds.height<=viewport.height,'completion Done is visible without scrolling');row.doneBounds={...doneBounds,viewport};
   await picture('import-complete');
   await page.getByRole('button',{name:'Done',exact:true}).click();
   assert.equal(await page.getByRole('button',{name:'Check import status',exact:true}).count(),0);
   const imported=store.listAgents(dest.projectId);assert.equal(imported.length,beforeIds.length+2);
   assert.deepEqual([...operation.result.agentIds].sort(),imported.filter(agent=>!beforeIds.includes(agent.id)).map(agent=>agent.id).sort());
   const root=imported.find(agent=>agent.id===operation.result.rootAgentId),helper=imported.find(agent=>operation.result.agentIds.includes(agent.id)&&agent.id!==root.id);
   assert.equal(root.title,sourceAgent.title);assert.equal(helper.title,child.title);assert.equal(helper.managerAgentId,root.id);
   const retainedIds=imported.map(agent=>agent.id).sort();await f.reopen();await f.listen({host:'127.0.0.1',port:new URL(origin).port});listener=f.app.server;
   assert.deepEqual(store.listAgents(dest.projectId).map(agent=>agent.id).sort(),retainedIds);
   await page.goto(`${origin}/projects/${dest.projectId}/chats/${dest.id}?view=agents`);
   await page.getByText(sourceAgent.title,{exact:true}).first().waitFor();await page.getByText(child.title,{exact:true}).first().waitFor();await picture('reopened-imported-agents');
   await page.goto(origin+'/create/agent');await page.getByRole('button',{name:'Import Agent package',exact:true}).click();
   assert.equal(await page.getByRole('button',{name:'Check import status',exact:true}).count(),0,'Done must release the completed browser notice');
   const posts=row.requests.filter(request=>request.method==='POST'&&request.path===`/api/projects/${dest.projectId}/agent-import-operations`);
   const checks=row.requests.filter(request=>request.method==='GET'&&request.path.includes('/agent-import-operations/by-request/'));
   assert.equal(posts.length,1);assert(checks.length>=1);assert.deepEqual(f.turns.map(turn=>turn.turnId),beforeTurns);
   assert.deepEqual(store.listAgents(source.projectId).map(agent=>({id:agent.id,title:agent.title,managerAgentId:agent.managerAgentId})),sourceBefore);
   assert.deepEqual(row.pageErrors,[]);assert.deepEqual(row.externalRequests,[]);row.status='pass';row.importPostCount=posts.length;row.statusCheckCount=checks.length;row.providerTurnIds=f.turns.map(turn=>turn.turnId);row.retainedAgentIds=retainedIds;
  }catch(error){row.status='failed';row.error=error.stack;if(page){row.visibleText=await page.locator('body').innerText().catch(()=>null);await picture('failure').catch(()=>{});}throw error;}
  finally{await context.close();row.contextClosed=true;await persist();}
 }
 result.passed=true;
}catch(error){result.error=error.stack;}
finally{
 for(const [name,close]of[['browser',()=>browser?.close()],['fixture',async()=>{await f?.dispose(false);if(listener){assert.equal(listener.listening,false);result.listenerClosed=true;}}]])try{await close();result.cleanup.push({name,status:'complete'});}catch(error){result.cleanup.push({name,status:'failed',error:String(error)});}
 await persist();
}
console.log(JSON.stringify({passed:result.passed,cells:result.cells.map(({device,status,error})=>({device,status,error})),cleanup:result.cleanup,listenerClosed:result.listenerClosed,error:result.error}));
if(!result.passed||result.cleanup.some(item=>item.status!=='complete'))process.exitCode=1;
