import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRsbuild} from '@rsbuild/core';
import {pluginReact} from '@rsbuild/plugin-react';
import {createServer} from '../../server/dist/app.js';
const require=createRequire(new URL('../../server/package.json',import.meta.url));
const {AgentStore,CapabilityPolicyStore}=require('@ponderosa/agents');
const playwright=await import(process.env.PONDEROSA_PLAYWRIGHT_PATH);
const web=fileURLToPath(new URL('..',import.meta.url));
const temp=await mkdtemp(path.join(tmpdir(),'pinecone-browser-')),store=new AgentStore(path.join(temp,'data'));
let browser,app;const errors=[];let starts=0;
try{
 const output=path.join(temp,'web');const build=await createRsbuild({cwd:web,rsbuildConfig:{plugins:[pluginReact()],source:{entry:{index:path.join(web,'test/pinecone-browser-entry.tsx')}},output:{distPath:{root:output}},logLevel:'error'}});await build.build();
 const adapter={id:'codex',displayName:'Synthetic subscription Adapter',listModels:()=>[],listEfforts:()=>[],run:()=>{starts++;throw Error('No provider permitted');}};
 app=createServer({dataDir:path.join(temp,'data'),store,webDist:output,engines:[{adapter,authStatus:async()=>({authenticated:true})}],logger:false,startDrained:true});
 const origin=await app.listen({port:0,host:'127.0.0.1'});browser=await playwright.chromium.launch({headless:true,executablePath:process.env.PONDEROSA_CHROMIUM_PATH});
 for(const [width,pinecone] of [[1440,true],[390,true],[320,true],[1440,false],[390,false]]){
  const p=store.createProject({label:`Synthetic ${width}`,hostPath:temp,defaultEngine:'codex'}),c=store.createConversation(p.id,{title:'Private work'});
  const page=await browser.newPage({viewport:{width,height:932}});page.on('pageerror',error=>errors.push(error.message));
  const requests=[];page.on('response',response=>{if(response.request().method()==='POST')requests.push([response.status(),response.url()]);});
  await page.goto(`${origin}/?${new URLSearchParams({project:p.id,chat:c.id})}`);
  const entry=page.getByRole('button',{name:'Create Pinecone',exact:true});await entry.waitFor();assert.equal(store.listAgents(p.id).length,0);
  if(pinecone){await entry.focus();await entry.press('Enter');}
  const name=`${pinecone?'Pinecone':'Ordinary'} ${width}`;await page.getByLabel('Name',{exact:true}).fill(name);
  if(pinecone){assert.equal(await page.getByLabel('Initial message (optional)').count(),0);assert.equal(await page.getByLabel('Delegated under').count(),0);await page.getByText(/Creation starts no work/).waitFor();}
  if(pinecone&&process.env.PONDEROSA_PINECONE_SCREENSHOTS){await mkdir(process.env.PONDEROSA_PINECONE_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.PONDEROSA_PINECONE_SCREENSHOTS,`pinecone-create-${width}.png`)});}
  const create=page.getByRole('button',{name:pinecone?'Create Pinecone':'Create Agent',exact:true});await create.focus();await create.press('Enter');
  if(pinecone)await page.getByText(`${name} · Private Agent chat`,{exact:true}).waitFor();else await page.locator('[contenteditable="true"]').waitFor();
  const id=store.listAgents(p.id)[0].id;if(pinecone)assert.equal(store.getPineconeProfile(id).conversationId,c.id);else assert.equal(store.getPineconeProfile(id),undefined);assert.equal(store.readCommunicationEvents(p.id).length,0);assert.equal(starts,0);
  if(pinecone){
   const policies=new CapabilityPolicyStore(store.sqlite),endpoint=`/api/agents/${id}/capabilities`;
   await page.getByText('Managed helper creation is restricted by current policy.',{exact:true}).waitFor();
   assert.deepEqual(policies.get('agent',id).restrictedCapabilityIds,['agents.create_managed']);
   const before=Object.fromEntries(['agents','runtime_communications','agent_activations','scheduler_runs','coordination_requests','coordination_joins'].map(table=>[table,store.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
   const settings=page.getByRole('button',{name:'Helper settings',exact:true});await settings.focus();await settings.press('Enter');
   const dialog=page.getByRole('dialog',{name:'Managed helpers',exact:true});await dialog.waitFor();
   const allow=dialog.getByRole('checkbox',{name:'Allow',exact:true});assert.equal(await allow.isChecked(),false);await allow.click();
   await dialog.getByRole('button',{name:'Close',exact:true}).click();const discard=page.getByRole('dialog',{name:'Discard unsaved helper settings?'});await discard.waitFor();await discard.getByRole('button',{name:'Keep editing'}).click();assert.equal(await allow.isChecked(),true);
   await dialog.getByRole('button',{name:'Close',exact:true}).click();await discard.getByRole('button',{name:'Discard changes'}).click();await dialog.waitFor({state:'hidden'});assert.equal(policies.get('agent',id).revision,1);
   await settings.click();await dialog.waitFor();assert.equal(await allow.isChecked(),false);await allow.click();
   const save=dialog.getByRole('button',{name:'Save capabilities',exact:true});
   if(width===1440){
    policies.put({scopeKind:'agent',scopeId:id,expectedRevision:1,restrictedCapabilityIds:['agents.create_managed']});
    const conflict=page.waitForResponse(r=>r.url().endsWith(endpoint)&&r.request().method()==='PUT'&&r.status()===409);await save.click();await conflict;
    await dialog.getByText(/Capability restrictions changed elsewhere/).waitFor();assert.equal(await allow.isChecked(),true);assert.equal(await save.isDisabled(),true);
    await dialog.getByRole('button',{name:'Load latest'}).click();assert.equal(await allow.isChecked(),false);await allow.click();
    await page.route(`**${endpoint}`,async route=>{if(route.request().method()==='PUT')await route.abort();else await route.continue();});
    await save.click();await dialog.getByRole('button',{name:'Reload current policy'}).waitFor();assert.equal(await allow.isChecked(),true);assert.equal(policies.get('agent',id).revision,2);
    await page.unroute(`**${endpoint}`);await dialog.getByRole('button',{name:'Reload current policy'}).click();
   }
   await page.waitForFunction(()=>{const dialog=document.querySelector('[role="dialog"][aria-labelledby="pinecone-helper-title"]');return dialog&&getComputedStyle(dialog.parentElement).opacity==='1'});
   assert.equal(await dialog.evaluate(el=>el.scrollWidth>el.clientWidth),false);
   if(process.env.PONDEROSA_PINECONE_SCREENSHOTS)await page.screenshot({path:path.join(process.env.PONDEROSA_PINECONE_SCREENSHOTS,`pinecone-helper-settings-${width}.png`)});
   const savedPolicy=page.waitForResponse(r=>r.url().endsWith(endpoint)&&r.request().method()==='PUT'&&r.ok());await save.click();await savedPolicy;await dialog.getByText(/Restrictions apply to new helper creation calls/).waitFor();
   assert.deepEqual(policies.get('agent',id).restrictedCapabilityIds,[]);for(const [table,n]of Object.entries(before))assert.equal(store.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n,n,table);assert.equal(starts,0);
   await dialog.getByRole('button',{name:'Close',exact:true}).click();await dialog.waitFor({state:'hidden'});await settings.waitFor();assert.equal(await settings.evaluate(el=>el===document.activeElement),true);
   await page.getByText('Managed helper creation is allowed by current policy.',{exact:true}).waitFor();
  }
  await page.reload();if(pinecone)await page.getByText(`${name} · Private Agent chat`,{exact:true}).waitFor();else await page.locator('[contenteditable="true"]').waitFor();assert.equal(store.listAgents(p.id)[0].id,id);
  if(pinecone&&process.env.PONDEROSA_PINECONE_SCREENSHOTS)await page.screenshot({path:path.join(process.env.PONDEROSA_PINECONE_SCREENSHOTS,`pinecone-welcome-${width}.png`)});
  const editor=page.locator('[contenteditable="true"]');await editor.waitFor();const text=`${name} private task`;
  const saved=page.waitForResponse(response=>response.url().includes(`/api/conversations/agent%3A${id}/draft`)&&response.request().method()==='PUT'&&response.request().postDataJSON()?.text===text);
  await editor.fill(text);assert.ok((await saved).ok());await page.reload();await editor.waitFor();await page.waitForFunction(text=>document.querySelector('[contenteditable="true"]')?.textContent===text,text);
  const sent=page.waitForResponse(response=>response.url().includes(`/api/agents/${id}/messages`) && response.request().method()==='POST',{timeout:10000}).catch(async error=>{console.log(JSON.stringify({requests,body:await page.locator('body').innerText()}));throw error;});
  const cleared=page.waitForResponse(response=>response.url().includes(`/api/conversations/agent%3A${id}/draft`)&&response.request().method()==='PUT'&&response.request().postDataJSON()?.text==='');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  assert.ok((await sent).ok());assert.ok((await cleared).ok());
  await page.waitForFunction(text=>document.body.innerText.includes(text),text);
  // Await the canonical mutation receipt, not an optimistic bubble.

  const authored=store.readCommunicationEvents(p.id);assert.equal(authored.length,1);assert.equal(authored[0].intent,'user_dm');assert.deepEqual(authored[0].audience,{kind:'user_agent',userId:'local-operator',agentId:id});assert.equal(starts,0);
  await page.reload();await page.waitForFunction(text=>document.body.innerText.includes(text),text);assert.equal(store.readCommunicationEvents(p.id).length,1);assert.equal(store.listAgents(p.id)[0].id,id);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.close();
 }
 const p=store.createProject({label:'Inherited policy UI',hostPath:temp,defaultEngine:'codex'}),chat=store.getConversation(p.lastConversationId);
 const parent=store.createAgent(p.id,{title:'Restricted spawner',engine:'codex',conversationId:chat.id});
 const child=store.createAgent(p.id,{title:'Descendant',engine:'codex',conversationId:chat.id,managerAgentId:parent.id},{agentId:parent.id,executionId:'fixture-spawn',idempotencyKey:'descendant'});
 const policies=new CapabilityPolicyStore(store.sqlite);policies.put({scopeKind:'agent',scopeId:parent.id,expectedRevision:0,restrictedCapabilityIds:['agents.create_managed']});
 const page=await browser.newPage({viewport:{width:390,height:932}});
 await page.goto(`${origin}/?${new URLSearchParams({project:p.id,chat:chat.id,editor:child.id})}`);const inherited=page.getByRole('checkbox',{name:'Allow',exact:true});await inherited.waitFor();assert.equal(await inherited.isDisabled(),true);assert.equal(await inherited.isChecked(),false);await page.getByText('Restricted by Restricted spawner (spawner)',{exact:true}).waitFor();assert.equal(policies.get('agent',child.id),undefined);await page.close();
 const other=store.createAgent(p.id,{title:'Other scope',engine:'codex',conversationId:chat.id});const switchPage=await browser.newPage({viewport:{width:390,height:932}});
 await switchPage.goto(`${origin}/?${new URLSearchParams({project:p.id,chat:chat.id,editor:parent.id,other:other.id})}`);const toggle=switchPage.getByRole('checkbox',{name:'Allow',exact:true});await toggle.waitFor();await toggle.click();assert.equal(await toggle.isChecked(),true);
 await switchPage.getByRole('button',{name:'Switch fixture policy owner'}).click();await switchPage.waitForFunction(()=>document.querySelector('input[type="checkbox"]')?.checked===true);assert.equal(await switchPage.getByRole('button',{name:'Save capabilities'}).isDisabled(),true);assert.equal(policies.get('agent',parent.id).revision,1);assert.equal(policies.get('agent',other.id),undefined);assert.equal(starts,0);await switchPage.close();
 assert.deepEqual(errors,[]);console.log('PASS Pinecone desktop/390px/320px and ordinary Dev desktop/390px keyboard creation, explicit helper Allow/Save/reload with dirty guard, conflict refetch and network error recovery, draft save/reload, explicit private Send and history reload; no provider work');
}finally{await browser?.close();if(app){app.prepareForShutdown();await app.close();}store.close();await rm(temp,{recursive:true,force:true});}
