import '../shared/workspace-resolution.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {AgentStore} from '../../packages/agents/dist/index.js';
import {fixture} from '../shared/fixture.mjs';

const {chromium}=createRequire(new URL('../../apps/server/package.json',import.meta.url))('playwright-core');
let store;
const f=await fixture({
 webDist:fileURLToPath(new URL('../../apps/web/dist',import.meta.url)),
 storeFactory:path=>(store=new AgentStore(path)),
});
let browser;
const post=(path,body,headers)=>f.api('POST',path,body,headers).then(f.ok);
const root=(chat)=>`/projects/${chat.projectId}/chats/${chat.id}`;
const branchPath=(branch,chat,execution)=>'/branches?'+new URLSearchParams({
 branch:branch.id,tab:'chats',chat:chat.id,...(execution?{execution:execution.id}:{}),
});
function seed(chat,title,chatCount=32,teamCount=24){
 const agent=store.createAgent(chat.projectId,{title,engine:'codex',conversationId:chat.id});
 const peer=store.createAgent(chat.projectId,{title:title+' child',engine:'codex',conversationId:chat.id,managerAgentId:agent.id});
 const start=Date.now()-300000;
 for(const [intent,count] of [['broadcast',chatCount],['collaboration',teamCount]]){
  for(let index=0;index<count;index++){
   const team=intent==='collaboration';
   const fromAgent=team||index===10;
   const {event}=store.appendCommunicationEvent({
    schemaVersion:2,eventId:randomUUID(),projectId:chat.projectId,conversationId:chat.id,
    sender:fromAgent?{kind:'agent',agentId:agent.id,executionId:randomUUID()}:{kind:'user',userId:'local-operator'},
    intent,audience:team?{kind:'agents',agentIds:[peer.id]}:{kind:'organization',organizationId:chat.projectId},
    text:`${team?'Team':'Chat'} entry ${index} for ${chat.title}.\n\nA second paragraph keeps this conversation comfortably scrollable on both screens.`,
    createdAt:new Date(start+index*1000).toISOString(),
   });
   store.appendCommunicationProjection(chat.projectId,{
    eventId:event.eventId,surface:team?'collaboration_view':'conversation',projectionKey:chat.id,projectedAt:event.createdAt,
    message:{messageId:event.eventId,role:fromAgent?'assistant':'user',renderedText:event.text,createdAt:event.createdAt,...(fromAgent?{authorAgentId:agent.id}:{})},
   });
  }
 }
 return agent;
}

try{
 const chat=await f.createChat('Regular return fixture');
 const agent=seed(chat,'Regular review Agent',246);
 const other=await f.createChat('Other Chat return fixture');
 seed(other,'Other Chat review Agent');
 const branch=await post('/api/branches',{name:'Return qualification workflow',idempotencyKey:randomUUID(),example:'approval'});
 const persistent=await post(`/api/branches/${branch.id}/chats`,{label:'Persistent return fixture',defaultEngine:'codex'},{'idempotency-key':randomUUID()});
 const persistentAgent=seed(persistent,'Persistent review Agent',32,118);
 const execution=await post(`/api/branches/${branch.id}/executions`,{input:'Inspect this execution',occurrenceKey:randomUUID()});
 const project=store.createProject({label:'Execution return fixture',hostPath:f.root,defaultEngine:'codex',chatOwned:true,branchId:branch.id,executionId:execution.id});
 const temporary=store.getConversation(project.lastConversationId);
 const temporaryAgent=seed(temporary,'Execution review Agent');
 const origin=await f.listen();
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
 for(const phone of [false,true]){
  const context=await browser.newContext({viewport:phone?{width:390,height:844}:{width:1440,height:900},isMobile:phone,hasTouch:phone,serviceWorkers:'block'});
  const page=await context.newPage();
  page.setDefaultTimeout(12000);
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const activate=locator=>phone?locator.tap():locator.click();
  const chatTabs=page.getByRole('tablist',{name:'Chat Views',exact:true});
  const agentTabs=page.getByRole('tablist',{name:'Agent Details',exact:true});
  const tab=(tabs,name)=>tabs.getByRole('tab',{name,exact:true});
  const selectedTab=(tabs,name)=>tabs.getByRole('tab',{name,exact:true,selected:true});
  const workspaceHeader=tabs=>page.locator('[data-workspace-header]').filter({has:tabs});
  const toggle=(tabs,action)=>workspaceHeader(tabs).getByRole('button',{name:action+' Workspace Header',exact:true});
  const editor=page.getByRole('textbox',{name:'Message',exact:true});
  const headings=name=>page.getByRole('heading',{name,exact:true});
  const chatRegion=page.getByRole('region',{name:'Chat Messages',exact:true});
  const teamRegion=page.getByRole('region',{name:'Team Chat Messages',exact:true});
  const fromEntry=(region,index,title,team=false)=>region.getByRole('article',{name:title+' Message',exact:true})
   .filter({hasText:`${team?'Team':'Chat'} entry ${index} `}).getByRole('button',{name:'Open Agent '+title+' From Name',exact:true}).first();
  const collapse=async tabs=>{if(await toggle(tabs,'Collapse').isVisible())await activate(toggle(tabs,'Collapse'));};
  const expand=async tabs=>{if(await toggle(tabs,'Expand').isVisible())await activate(toggle(tabs,'Expand'));};
  const chatName=owner=>workspaceHeader(agentTabs).getByRole('button',{name:'Open Chat '+owner.title,exact:true});
  const returnToChat=async owner=>{
   await agentTabs.waitFor();
   await expand(agentTabs);
   const name=chatName(owner);
   assert.equal(await name.textContent(),owner.title);
   assert.equal(await workspaceHeader(agentTabs).getByRole('button',{name:'Back to Chat',exact:true}).count(),0);
   await activate(name);
  };
  const tabOrder=()=>agentTabs.getByRole('tab').evaluateAll(items=>items.map(item=>item.getAttribute('aria-label')??item.textContent.trim()));
  const readPosition=async(region,trigger)=>{
   await trigger.scrollIntoViewIfNeeded();
   const position=await region.evaluate(node=>({top:node.scrollTop,remaining:node.scrollHeight-node.clientHeight-node.scrollTop}));
   assert.ok(position.top>120&&position.remaining>120,'Fixture reaches a position away from both ends');
   return position.top;
  };
  const messageOffset=(region,author)=>author.evaluate((button,label)=>{
   const row=button.closest('article').querySelector('.chat-message-body');
   return row.getBoundingClientRect().top-row.closest(`section[aria-label="${label}"]`).getBoundingClientRect().top;
  },region===teamRegion?'Team Chat Messages':'Chat Messages');
  const assertPosition=(region,offset)=>page.waitForFunction(({name,offset})=>{
   const node=document.querySelector(`section[aria-label="${name}"]`);
   return node&&Math.abs(node.scrollTop-offset)<=2;
  },{name:region===teamRegion?'Team Chat Messages':'Chat Messages',offset});
  const checkRoute=async(chat,view,wantedBranch,wantedRun)=>{
   const url=new URL(page.url());
   const workspace=wantedBranch?new URL(url.searchParams.get('workspace'),origin):url;
   assert.equal(workspace.pathname,root(chat));
   assert.equal(workspace.searchParams.get('view'),view);
   if(wantedBranch){
    assert.equal(url.pathname,'/branches');
    assert.equal(url.searchParams.get('branch'),wantedBranch.id);
    assert.equal(url.searchParams.get('tab'),'chats');
    assert.equal(url.searchParams.get('chat'),chat.id);
    assert.equal(url.searchParams.get('execution'),wantedRun?.id??null);
   }
  };
  const assertDraft=async value=>{
   await editor.waitFor();
   await page.waitForFunction(value=>document.querySelector('[aria-label="Message"][contenteditable]')?.textContent===value,value);
  };
  try{
   for(const [owner,person,path,workflow] of [[chat,agent,root(chat)],[persistent,persistentAgent,branchPath(branch,persistent),branch]]){
    await page.goto(origin+path);
    await editor.waitFor();
    await collapse(chatTabs);
    const chatIcon=await tab(chatTabs,'Chat').boundingBox();
    assert.equal(chatIcon.width,44);
    const draft='Unsent Chat draft for '+owner.title;
    const dmDraft='Private draft for '+person.title;
    await editor.fill(draft);
    if(!workflow){
     assert.equal(await fromEntry(chatRegion,10,person.title).count(),0);
     await chatRegion.evaluate(node=>node.scrollTo({top:0}));
     await chatRegion.getByText('Chat entry 100 for '+owner.title+'.',{exact:true}).waitFor();
     await chatRegion.evaluate(node=>node.scrollTo({top:0}));
    }
    const author=fromEntry(chatRegion,10,person.title);
    const reading=await readPosition(chatRegion,author);
    const oldMessageOffset=await messageOffset(chatRegion,author);
    await activate(author);
    await headings(person.title).waitFor();
    await toggle(agentTabs,'Expand').waitFor();
    await selectedTab(agentTabs,'Chat').waitFor();
    assert.equal(await chatName(owner).count(),0);
    assert.equal(await workspaceHeader(agentTabs).getByRole('button',{name:'Back to Chat',exact:true}).count(),0);
    await page.getByText(`Message ${person.title} directly`,{exact:true}).waitFor();
    await assertDraft('');
    await editor.fill(dmDraft);
    if(phone)await page.setViewportSize({width:320,height:700});
    for(const shortcut of ['Subagents','Files & Results','Settings','Chat']){
     const item=tab(agentTabs,shortcut);
     await item.waitFor();
     const size=await item.boundingBox();
     assert.deepEqual({height:size.height,width:size.width},{height:chatIcon.height,width:chatIcon.width});
     await activate(item);
     await selectedTab(agentTabs,shortcut).waitFor();
    }
    await assertDraft(dmDraft);
    if(phone)await page.setViewportSize({width:390,height:844});
    await activate(tab(agentTabs,'Files & Results'));
    const shortcuts=await tabOrder();
    await expand(agentTabs);
    await selectedTab(agentTabs,'Files & Results').waitFor();
    assert.deepEqual(await tabOrder(),shortcuts);
    await collapse(agentTabs);
    await selectedTab(agentTabs,'Files & Results').waitFor();
    assert.deepEqual(await tabOrder(),shortcuts);
    await returnToChat(owner);
    await selectedTab(chatTabs,'Chat').waitFor();
    await checkRoute(owner,null,workflow);
    await assertDraft(draft);
    await assertPosition(chatRegion,reading);
    if(!workflow){
     const otherLink=page.getByRole('link',{name:'Open Chat '+other.title,exact:true});
     for(const interruption of ['another Chat and browser Back','reload']){
      await activate(author);
      await headings(person.title).waitFor();
      if(interruption==='reload'){
       await page.reload();
      }else{
       if(phone)await activate(page.getByRole('button',{name:'Open Workspace Navigation'}));
       if(!await otherLink.isVisible())await activate(page.getByRole('button',{name:'Chats',exact:true}).first());
       await activate(otherLink);
       await page.waitForURL('**'+root(other));
       await editor.waitFor();
       const otherText=await editor.textContent();
       assert.ok(!otherText.includes(draft)&&!otherText.includes(dmDraft));
       await page.goBack();
      }
      await returnToChat(owner);
      await selectedTab(chatTabs,'Chat').waitFor();
      await checkRoute(owner,null);
      await assertDraft(draft);
      await author.waitFor();
      await assertPosition(chatRegion,reading);
      assert.ok(Math.abs(await messageOffset(chatRegion,author)-oldMessageOffset)<=2,interruption);
      assert.equal(await chatRegion.getByText(/Other Chat return fixture/).count(),0);
      console.log(`${phone?'phone':'desktop'} restored the older Chat row after ${interruption}`);
     }
    }

    await expand(chatTabs);
    await activate(tab(chatTabs,'Team Chat'));
    await selectedTab(chatTabs,'Team Chat').waitFor();
    const teammate=fromEntry(teamRegion,10,person.title,true);
    if(workflow&&!await teammate.count())await teamRegion.evaluate(node=>node.scrollTo({top:0}));
    const teamReading=await readPosition(teamRegion,teammate);
    const teamMessageOffset=await messageOffset(teamRegion,teammate);
    await activate(teammate);
    await headings(person.title).waitFor();
    await expand(agentTabs);
    await toggle(agentTabs,'Collapse').waitFor();
    await activate(tab(agentTabs,'Chat'));
    await assertDraft(dmDraft);
    await returnToChat(owner);
    await selectedTab(chatTabs,'Team Chat').waitFor();
    await checkRoute(owner,'team',workflow);
    await assertPosition(teamRegion,teamReading);
    if(workflow){
     await activate(teammate);
     await headings(person.title).waitFor();
     await page.reload();
     await returnToChat(owner);
     await selectedTab(chatTabs,'Team Chat').waitFor();
     await checkRoute(owner,'team',workflow);
     await teammate.waitFor();
     await assertPosition(teamRegion,teamReading);
     assert.ok(Math.abs(await messageOffset(teamRegion,teammate)-teamMessageOffset)<=2,'Branch Team Chat reload');
     console.log(`${phone?'phone':'desktop'} restored the older Branch Team Chat row after reload`);
    }

    await activate(tab(chatTabs,'Agents'));
    await selectedTab(chatTabs,'Agents').waitFor();
    const roster=page.getByRole('tabpanel',{name:'Agents'});
    await activate(roster.getByText(person.title,{exact:true}).first());
    await headings(person.title).waitFor();
    await returnToChat(owner);
    await selectedTab(chatTabs,'Agents').waitFor();
    await checkRoute(owner,'agents',workflow);
    await activate(tab(chatTabs,'Chat'));
    await assertDraft(draft);
    await assertPosition(chatRegion,reading);
   }

   await page.goto(origin+branchPath(branch,temporary,execution));
   await page.getByText('Temporary workflow Chat · messages and results',{exact:true}).waitFor();
   await activate(tab(chatTabs,'Team Chat'));
   await activate(fromEntry(teamRegion,10,temporaryAgent.title,true));
   await headings(temporaryAgent.title).waitFor();
   await page.getByText('Workflow Agent · control work from its execution view',{exact:true}).waitFor();
   await expand(agentTabs);
   await activate(workspaceHeader(agentTabs).getByRole('button',{name:'Agent Chat Actions',exact:true}));
   await page.getByRole('menuitem',{name:'Technical Details'}).waitFor();
   for(const forbidden of ['Rename','Create Agent','Delete'])assert.equal(await page.getByRole('menuitem',{name:forbidden,exact:true}).count(),0);
   await page.keyboard.press('Escape');
   await collapse(agentTabs);
   for(const available of ['Chat','Files & Results'])await tab(agentTabs,available).waitFor();
   for(const unavailable of ['Subagents','Settings'])assert.equal(await tab(agentTabs,unavailable).count(),0);
   assert.equal(await editor.count(),0);
   await activate(tab(agentTabs,'Files & Results'));
   await selectedTab(agentTabs,'Files & Results').waitFor();
   await page.reload();
   await returnToChat(temporary);
   await selectedTab(chatTabs,'Team Chat').waitFor();
   await checkRoute(temporary,'team',branch,execution);
   assert.equal(await editor.count(),0);
   assert.equal(await tab(chatTabs,'Agents').count(),0);

   await page.goto(origin+`/projects/${chat.projectId}/agents/${agent.id}?view=artifacts`);
   await headings(agent.title).waitFor();
   await selectedTab(agentTabs,'Files & Results').waitFor();
   await expand(agentTabs);
   await chatName(chat).waitFor();
   assert.deepEqual(errors,[]);
   console.log(`${phone?'390 × 844':'1440 × 900'} passed: Chat, Team Chat, Agents, independent drafts and reading positions, shared tab order and selection, Chat-name return, Branch scope, read-only execution and direct Agent link`);
  }catch(error){
   console.error('Page at failure:',page.url(),await page.locator('body').innerText().then(text=>text.slice(0,2500)));
   throw error;
  }finally{await context.close();}
 }
}finally{await browser?.close();await f.dispose();}
