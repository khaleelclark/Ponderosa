import test from 'node:test';
import assert from 'node:assert/strict';
import '../shared/web-typescript-loader.mjs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const {BranchWorkspaceHeader}=await import('../../apps/web/src/components/branches/BranchWorkspaceHeader.tsx');

test('Branch header reuses ordered shared icon tabs, names and guarded publication controls',()=>{
 const html=renderToStaticMarkup(React.createElement(BranchWorkspaceHeader,{name:'A long workflow name',tab:'workflow',published:false,embeddedChat:false,dirty:true,saving:false,saveDisabled:true,onTab(){},onSave(){},onExport(){},onUpdate(){}}));
 assert.ok(html.includes('A long workflow name'),'Selected workflow name is present');assert.ok(html.includes('aria-label="Unpublished changes"'),'Dirty indication is accessible');
 assert.ok(/<button[^>]*disabled=""[^>]*aria-label="Save changes…"/.test(html),'Clean/invalid/pending Save remains disabled');
 const names=[...html.matchAll(/role="tab"[^>]*>(.*?)<\/button>/g)].map(match=>match[1].replace(/<style[^>]*>[\s\S]*?<\/style>/g,'').replace(/<[^>]*>/g,''));
 assert.deepEqual(names,['Workflow','Chats','Executions','Parameters','Settings']);
 for(const tab of ['workflow','chats','executions','parameters','settings'])assert.ok(new RegExp(`id="branch-${tab}-tab"[^>]*aria-controls="branch-${tab}-panel"`).test(html),`Tab/panel association for ${tab}`);
 for(const tab of ['executions','parameters'])assert.ok(new RegExp(`disabled=""[^>]*id="branch-${tab}-tab"|id="branch-${tab}-tab"[^>]*disabled=""`).test(html),`Unpublished ${tab} remains disabled`);
 assert.ok(!/Ponderosa Branches|Build and operate|No changes to publish/.test(html),'No displaced product banner or duplicate actions');
});

test('selected nested Chat retains the Branch tabs without duplicating shared Chat identity or controls',()=>{
 const html=renderToStaticMarkup(React.createElement(BranchWorkspaceHeader,{name:'Owning workflow',tab:'chats',published:true,embeddedChat:true,dirty:false,saving:false,saveDisabled:false,onTab(){},onSave(){},onExport(){},onUpdate(){}}));
 assert.ok(html.includes('aria-label="Branch views"'),'Branch navigation remains reachable');assert.ok(/aria-selected="true"[^>]*>.*ChatBubbleOutline/.test(html),'Chats is the selected shared icon tab');
 assert.ok(!/Owning workflow|Save changes|Branch actions|<h1/.test(html),'Nested Chat owns its identity and actions');
});
const {WorkspacePreferencesWriter}=await import('../../apps/web/src/workspacePreferencesWriter.ts');
const {branchRoutePath,parseBranchRoute,branchWorkspaceRoute}=await import('../../apps/web/src/branchesRouting.ts');
const {productApiPath,productWorkspacePath,setStandaloneProductScope}=await import('../../apps/web/src/api/productScope.ts');

test('a conflicting Branch folder move retries against current membership without losing a concurrent star',async()=>{
 const first={revision:1,branchFolders:[{id:'a',name:'One',expanded:true,branchIds:['x','y']},{id:'b',name:'Two',expanded:true,branchIds:['z']}]};
 const current={revision:2,branchFolders:[{...first.branchFolders[0],starred:true,branchIds:['x','y','new']},first.branchFolders[1]]};
 const desired=[{...first.branchFolders[0],branchIds:['x']},{...first.branchFolders[1],branchIds:['z','y']}];
 let projected=first;const writes=[];
 const writer=new WorkspacePreferencesWriter({read:()=>projected,publish:value=>{projected=value},refresh:async()=>current,write:async patch=>{writes.push(patch);if(writes.length===1)throw Object.assign(new Error('conflict'),{status:409});assert.equal(patch.branchFoldersRevision,2);return {...current,...patch,revision:3}}});
 await writer.enqueueAndWait({branchFolders:desired});
 assert.equal(writes.length,2);
 assert.deepEqual(projected.branchFolders,[{...first.branchFolders[0],starred:true,branchIds:['x','new']},{...first.branchFolders[1],branchIds:['z','y']}]);
 assert.equal(projected.revision,3);
});

test('Branch nested routes preserve the selected Chat, execution and exact message focus across reload',()=>{
 const route={branchId:'b',tab:'chats',executionId:'e',chatId:'c',workspace:{kind:'conversation',projectId:'p',conversationId:'c',focusMessageId:'a#Build-Coordinator?ü'}};
 assert.deepEqual(parseBranchRoute(new URL(branchRoutePath(route),'https://example.test').search),{...route,workspace:{...route.workspace,urlDriven:true}});
 assert.equal(parseBranchRoute('?workspace=https://outside.test/projects/p').workspace,undefined);
});

test('Branch transport scopes shared APIs exactly once without changing normal product requests',()=>{
 const original=globalThis.window;
 try{
  globalThis.window={location:{pathname:'/branches'}};
  assert.equal(productApiPath('/api/agents/a?limit=1'),'/api/branches/engine/agents/a?limit=1');
  for(const url of ['/api/branches/b/chats','/api/branch-executions/e','/api/branch-gates/g','/api/branches/engine/agents/a','https://example.test/api/agents/a'])assert.equal(productApiPath(url),url);
  for(const pathname of ['/','/branches-other']){window.location.pathname=pathname;assert.equal(productApiPath('/api/agents/a'),'/api/agents/a');}
 }finally{if(original===undefined)delete globalThis.window;else globalThis.window=original;}
});


test('native file links preserve Branch context and encoded fragments instead of crossing into normal Chats',()=>{
 const original=globalThis.window;
 try{
  globalThis.window={location:{pathname:'/branches',search:'?branch=b&chat=c&execution=e&settings=profile'}};
  const file='/projects/p/files/view?path=notes%2Fa.md&conversationId=c#section';
  const url=new URL(productWorkspacePath(file),'https://example.test');
  assert.equal(url.searchParams.get('branch'),'b');assert.equal(url.searchParams.get('execution'),'e');assert.equal(url.searchParams.get('chat'),'c');assert.equal(url.searchParams.get('tab'),'chats');assert.equal(url.searchParams.has('settings'),false);assert.equal(url.searchParams.get('workspace'),file);const parsed=parseBranchRoute(url.search).workspace;assert.equal(parsed.conversationId,'c');assert.equal(parsed.path,'notes/a.md');
  const pathOnly=new URL(productWorkspacePath('/projects/p/files/view?path=notes%2Fa.md#section'),'https://example.test');assert.equal(parseBranchRoute(pathOnly.search).workspace.path,'notes/a.md');
  window.location.pathname='/';assert.equal(productWorkspacePath(file),file);
 }finally{if(original===undefined)delete globalThis.window;else globalThis.window=original;}
});

test('absolute Markdown file anchors retain Branch navigation for normal and native new-tab clicks',async()=>{
 const {renderableWorkspaceMarkdownHref}=await import('../../apps/web/src/components/filePreview/workspaceMarkdownLinks.ts');
 const original=globalThis.window;
 try{
  globalThis.window={location:{pathname:'/branches',search:'?branch=b&chat=c'}};
  const href='/projects/p/files/view?path=notes%2Fa.md&conversationId=c#heading%20one';
  const result=renderableWorkspaceMarkdownHref('p','index.md',href,{conversationId:'c'}),url=new URL(result,'https://example.test');
  assert.equal(url.pathname,'/branches');assert.equal(url.searchParams.get('branch'),'b');assert.equal(url.searchParams.get('workspace'),href);
  for(const invalid of ['//outside.test/file','/projects/../file','/projects/%2e%2e/file','/projects/%00/file'])assert.equal(renderableWorkspaceMarkdownHref('p','index.md',invalid,{conversationId:'c'}),undefined);
  window.location.pathname='/';assert.equal(renderableWorkspaceMarkdownHref('p','index.md',href,{conversationId:'c'}),href);
 }finally{if(original===undefined)delete globalThis.window;else globalThis.window=original;}
});


test('an empty Agent search reports no matches without falsely claiming the Chat has no Agents',async()=>{
 const React=await import('react'),{renderToStaticMarkup}=await import('react-dom/server'),{QueryClient,QueryClientProvider}=await import('@tanstack/react-query');
 const {AgentsTab}=await import('../../apps/web/src/components/AgentsTab.tsx');
 const {MutationNotificationProvider}=await import('../../apps/web/src/components/MutationNotifications.tsx');
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
 const props={agents:[],engines:[],conversations:[],projectId:'project',scopeConversationId:'chat',statusByAgentId:new Map(),healthByAgentId:new Map(),onOpenAgent(){},onNewAgent(){},searchValue:'missing',onSearchValueChange(){}};
 try{
  const html=renderToStaticMarkup(React.createElement(QueryClientProvider,{client},React.createElement(MutationNotificationProvider,null,React.createElement(AgentsTab,props))));
  assert.match(html,/No Agents match these filters/);assert.doesNotMatch(html,/No Agents Yet|Create an Agent to get started/);
 }finally{client.clear();}
});


test('the shared file browser gives modified clicks a Branch destination as well as ordinary previews',async()=>{
 const React=await import('react'),{renderToStaticMarkup}=await import('react-dom/server'),{QueryClient,QueryClientProvider}=await import('@tanstack/react-query');
 const {ConversationWorkspaceFiles}=await import('../../apps/web/src/components/files/ConversationWorkspaceFiles.tsx');
 const original=globalThis.window,client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,gcTime:Infinity}}});
 try{
  globalThis.window={location:{pathname:'/branches',search:'?branch=b&chat=c'}};
  client.setQueryData(['conversationWorkspaceFiles','c',''],{kind:'dir',entries:[{path:'qualification.md',name:'qualification.md',kind:'file'}]});
  const html=renderToStaticMarkup(React.createElement(QueryClientProvider,{client},React.createElement(ConversationWorkspaceFiles,{projectId:'p',conversationId:'c'})));
  const href=html.match(/href="([^"]+)"/)?.[1]?.replaceAll('&amp;','&');assert.ok(href);
  const url=new URL(href,'https://example.test');assert.equal(url.pathname,'/branches');assert.equal(url.searchParams.get('branch'),'b');
  const nested=new URL(url.searchParams.get('workspace'),'https://example.test');assert.equal(nested.pathname,'/projects/p/files/view');assert.equal(nested.searchParams.get('conversationId'),'c');assert.equal(nested.searchParams.get('path'),'qualification.md');
 }finally{client.clear();if(original===undefined)delete globalThis.window;else globalThis.window=original;}
});


test('shared file-search destinations open their canonical Branch Chat and reject mismatched owners',async()=>{
 const {routeForGlobalSearchSelection}=await import('../../apps/web/src/components/GlobalChatSearch.tsx');
 const selection={projectId:'p',file:{path:'qualification.md',conversationId:'c'}};
 const workspace=routeForGlobalSearchSelection(selection),context={id:'c',projectId:'p',branchId:'b',executionId:'e'};
 assert.deepEqual(branchWorkspaceRoute(context,workspace),{branchId:'b',tab:'chats',executionId:'e',chatId:'c',workspace:{kind:'workspaceFile',projectId:'p',conversationId:'c',path:'qualification.md'}});
 for(const owner of [{...context,branchId:undefined},{...context,projectId:'foreign'},{...context,id:'foreign'}])assert.throws(()=>branchWorkspaceRoute(owner,workspace),/does not belong/);
});

test('the shared browser panel only offers new tabs when its session supports them',async()=>{
 const React=await import('react'),{renderToStaticMarkup}=await import('react-dom/server'),{QueryClient,QueryClientProvider}=await import('@tanstack/react-query');
 const {ProjectBrowserDialog}=await import('../../apps/web/src/components/ProjectBrowserDialog.tsx');
 const {projectBrowserAdapter}=await import('../../apps/web/src/components/browser/browserAdapters.ts');
 const {chatBrowserOwnerId}=await import('@ponderosa/core');
 const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,gcTime:Infinity}}});
 try{
  const session={id:'session',projectId:'p',status:'ready',controlOwner:'operator',controlEpoch:1,pages:[{id:'one',url:'about:blank',title:'Existing tab',active:true,closable:false}],activePageId:'one',capabilities:{multiPage:false,fileUpload:false},location:'hosted'};
  const key=projectBrowserAdapter(chatBrowserOwnerId('c')).queryKey;
  const render=multiPage=>{client.setQueryData(key,{...session,capabilities:{...session.capabilities,multiPage}});return renderToStaticMarkup(React.createElement(QueryClientProvider,{client},React.createElement(ProjectBrowserDialog,{projectId:'p',conversationId:'c',open:true,embedded:true,onClose(){}})));};
  assert.match(render(true),/aria-label="New browser tab"/);
  assert.doesNotMatch(render(false),/aria-label="New browser tab"/);
 }finally{client.clear();}
});

test('standalone voice prefixes native API and stream routes without leaking to the shared legacy backend',()=>{
 try{
  setStandaloneProductScope('branches','/standalone/test');
  assert.equal(productApiPath('/api/agents/a/messages'),'/standalone/test/api/branches/engine/agents/a/messages');
  assert.equal(productApiPath('/api/workspace/stream'),'/standalone/test/api/branches/engine/workspace/stream');
  assert.equal(productApiPath('/api/branches/b/configuration'),'/standalone/test/api/branches/b/configuration');
  assert.equal(productApiPath('https://example.test/api/agents/a'),'https://example.test/api/agents/a');
 }finally{setStandaloneProductScope(undefined)}
 assert.equal(productApiPath('/api/agents/a'),'/api/agents/a');
});


test('shared Settings entry is one direct accessible button in desktop and drawer chrome',async()=>{
 const React=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
 const {SidebarOperatorFooter}=await import('../../apps/web/src/components/WorkspaceSidebar.chrome.tsx');
 for(const drawer of [false,true]){
  const html=renderToStaticMarkup(React.createElement(SidebarOperatorFooter,{profile:{displayName:'Multiword Operator',handle:'operator'},drawer,onSettings(){}}));
  assert.equal((html.match(/aria-label="Open settings"/g)??[]).length,1);
  assert.match(html,/Multiword Operator/);assert.match(html,/#operator/);
  assert.doesNotMatch(html,/aria-haspopup|aria-expanded|Open operator menu/);
 }
});

test('DEV Settings sidebar is reused with native Branches links that retain workflow context',async()=>{
 const React=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
 const {SettingsSidebarPanel}=await import('../../apps/web/src/components/WorkspaceSidebar.chrome.tsx');
 const context={branchId:'b',tab:'chats',chatId:'c',executionId:'e',workspace:{kind:'conversation',projectId:'p',conversationId:'c'}};
 const props={route:{kind:'settings',section:'general'},onNavigate(){}};
 const dev=renderToStaticMarkup(React.createElement(SettingsSidebarPanel,props));
 const branch=renderToStaticMarkup(React.createElement(SettingsSidebarPanel,{...props,hrefForRoute:next=>branchRoutePath({...context,global:next.section})}));
 const hrefs=html=>[...html.matchAll(/href="([^"]+)"/g)].map(match=>match[1].replaceAll('&amp;','&'));
 const sections=['profile','general','providers','notifications','activity'];
 assert.deepEqual(hrefs(dev),sections.map(section=>'/settings/'+section));
 assert.deepEqual(hrefs(branch).map(href=>{
  const url=new URL(href,'https://example.test');assert.equal(url.pathname,'/branches');
  const route=parseBranchRoute(url.search);assert.equal(route.branchId,'b');assert.equal(route.chatId,'c');assert.equal(route.executionId,'e');assert.deepEqual(route.workspace,{...context.workspace,urlDriven:true});return route.global;
 }),sections);
 for(const label of ['Operator Profile','General','AI Providers','Notifications','Provider Activity'])assert.ok(dev.includes(label)&&branch.includes(label));
});

test('Branch Settings section changes preserve mounted drafts and guard profile or workflow exits like DEV',async()=>{
 const {retainedBranchDrafts,branchSettingsSection}=await import('../../apps/web/src/branchesRouting.ts');
 const context={branchId:'b',tab:'workflow'};
 for(const from of ['general','providers','notifications','activity'])for(const to of ['general','providers','notifications','activity']){
  assert.equal(retainedBranchDrafts({...context,global:from},{...context,global:to}).settings,true);
 }
 for(const [from,to] of [['general','profile'],['profile','general'],['general',undefined],[undefined,'general']]){
  assert.equal(retainedBranchDrafts({...context,global:from},{...context,global:to}).settings,false);
 }
 assert.equal(branchSettingsSection('status'),'providers');assert.equal(branchSettingsSection('usage'),'activity');
});

test('historical failed Scripts show exit diagnostics rather than stdout or a missing explanation',async()=>{
 const {executionFailures}=await import('../../apps/web/src/components/branches/model.ts');
 const detail={steps:[{id:'invocation',stepId:'script',pathId:'path',state:'failed',result:{failed:true,output:'MISLEADING_SUCCESS'}}],paths:[{id:'path',stepExecutionId:'invocation',state:'failed'}],attempts:[{stepExecutionId:'invocation',number:1,state:'failed',result:{failed:true,output:'MISLEADING_SUCCESS'},scriptEvidence:{code:7,stdout:'MISLEADING_SUCCESS',stderr:'PRIVATE_STDERR'}}]};
 assert.equal(executionFailures(detail)[0].reason,'Script exited with code 7. Inspect Step evidence for error output.');
 detail.attempts[0].scriptEvidence={code:null};
 assert.equal(executionFailures(detail)[0].reason,'Script terminated without an exit code. Inspect Step evidence for error output.');
 detail.attempts[0].scriptEvidence={code:null,error:'Script timeout'};
 assert.equal(executionFailures(detail)[0].reason,'Script timeout');
});


test('provider-attention Settings link stays in Branches and retains its execution return context', async () => {
 const React=await import('react'),{renderToStaticMarkup}=await import('react-dom/server'),{QueryClient,QueryClientProvider}=await import('@tanstack/react-query');
 const {ExecutionPanel}=await import('../../apps/web/src/components/branches/ExecutionPanel.tsx');
 const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,gcTime:Infinity}}});
 try {
  const execution={id:'execution',branchId:'branch',versionId:'version',state:'waiting',createdAt:new Date().toISOString()};
  client.setQueryData(['branch-execution-operations',execution.id],{state:'provider_attention',label:'Provider needs attention',observedAt:execution.createdAt,counts:{completed:0,running:0,retrying:0,waitingHuman:0,needsReconciliation:0},agentWaits:[],additionalAgentWaits:0});
  const detail={execution,steps:[],paths:[],attempts:[],gates:[],decisions:[],waits:[],mapItems:[]};
  const html=renderToStaticMarkup(React.createElement(QueryClientProvider,{client},React.createElement(ExecutionPanel,{detail,executions:[execution],viewStates:new Map()})));
  const href=[...html.matchAll(/href="([^"]+)"/g)].map(m=>m[1].replaceAll('&amp;','&')).find(x=>x.includes('providers'));
  assert.ok(href);
  const url=new URL(href,'https://example.test');assert.equal(url.pathname,'/branches');
  assert.deepEqual(parseBranchRoute(url.search),{branchId:'branch',tab:'executions',executionId:'execution',global:'providers'});
 } finally {client.clear();}
});


test('both products share ordered accessible sidebar controls and preserve normal mobile messages',async()=>{
 const React=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
 const {ProjectRail}=await import('../../apps/web/src/components/ProjectNavigation.tsx');
 const {BranchesSidebar}=await import('../../apps/web/src/components/branches/BranchesSidebar.tsx');
 const {createPonderosaTheme}=await import('../../apps/web/src/theme.ts');
 const {ThemeProvider}=await import('@mui/material');
 const noop=()=>{},profile={displayName:'Operator',handle:'operator'};
 for(const mode of ['light','dark'])for(const drawer of [false,true]){
  const render=element=>renderToStaticMarkup(React.createElement(ThemeProvider,{theme:createPonderosaTheme(mode)},element));
  const normal=render(React.createElement(ProjectRail,{drawer,route:{kind:'home'},profile,sections:{onSelect:noop},attentionNotifications:7,unreadNotificationUpdates:0,onOpenHome:noop,onOpenAllMessages:noop,onManageSection:noop,onOpenSearch:noop,onOpenNotifications:noop,onOpenSettings:noop,onCollapse:noop,onClose:noop}));
  const branches=render(React.createElement(BranchesSidebar,{drawer,panel:null,notifications:React.createElement('button',{'aria-label':'Branches notifications, 7 unread'}),onHome:noop,onSearch:noop,onGlobal:noop,onDismiss:noop,onCollapsedChange:noop}));
  for(const [html,home,search,bell]of [[normal,'Home','Search','Notifications, 7 unread'],[branches,'Ponderosa Branches home','Search Branch Chats','Branches notifications, 7 unread']]){
   const end=drawer?'Close workspace navigation':'Collapse sidebar';
   const labels=[home,search,bell,end].map(label=>html.indexOf('aria-label="'+label+'"'));
   assert.ok(labels.every(i=>i>=0));assert.deepEqual([...labels].sort((a,b)=>a-b),labels);
   assert.match(html,/width:32px;height:32px/);
   assert.match(html,drawer?/data-testid="CloseIcon"/:/data-testid="MenuIcon"/);
   assert.doesNotMatch(html,/data-testid="ChevronLeftIcon"/);
  }
  assert.match(normal,/aria-label="Home" aria-current="page"/);
  assert.ok(normal.includes('aria-label="Messages across Ponderosa"'));
 }
});

test('workflow Settings sections load without parameter configuration and keep lifecycle errors fail-closed',async t=>{
 const {QueryClient,QueryClientProvider}=await import('@tanstack/react-query');
 const {BranchSettings}=await import('../../apps/web/src/components/branches/BranchSettings.tsx');
 const branch={id:'settings-owner',name:'Settings owner',versionId:'version'},definition={parameters:{}};
 const client=new QueryClient({defaultOptions:{queries:{retry:false,retryOnMount:false,gcTime:Infinity}}});t.after(()=>client.clear());
 client.setQueryData(['branch-dependencies',branch.id],{calls:[],callers:[{id:'billing-workflow',ref:'reports-alias'}]});
 client.setQueryData(['capability-policy',`/api/branches/${branch.id}/capabilities`],{policy:{scopeId:branch.id,revision:0,restrictedCapabilityIds:[]},effective:{restrictionSources:{}},catalog:[]});
 const render=parameters=>renderToStaticMarkup(React.createElement(QueryClientProvider,{client},React.createElement(BranchSettings,{branch,definition,parameters})));
 const html=render(false),labels=['Branch capabilities','Dependencies','Delete workflow'];
 assert.ok(labels.every(label=>html.includes(label)),'All workflow Settings sections must render while configuration is unavailable');
 assert.ok(labels.every((label,index)=>!index||html.indexOf(label)>html.indexOf(labels[index-1])),'Settings section order must remain capabilities, dependencies, delete');
 assert.ok(!html.includes('Workflow settings sections')&&!html.includes('Loading configuration'),'No nested navigation or unrelated configuration gate');
 assert.equal(client.getQueryCache().find({queryKey:['branch-settings',branch.id]}),undefined,'Settings must not subscribe to unrelated configuration');
 client.setQueryData(['branch-lifecycle-summary',branch.id],{deleting:false,activeExecutions:0,chats:0,callers:[{id:'billing-workflow',name:'Billing workflow'}],updates:[],pendingRemoval:[]});
 const named=render(false);assert.ok(named.includes('Billing workflow')&&!named.includes('reports-alias'),'Called by must show the calling workflow name, never its alias for this target');
 const lifecycle=client.getQueryCache().find({queryKey:['branch-lifecycle-summary',branch.id]});lifecycle.setState({status:'error',error:new Error('Controlled lifecycle failure'),fetchStatus:'idle'});
 const failed=render(false);assert.ok(failed.includes('Deletion is unavailable'),'Unknown lifecycle must not allow deletion');
 assert.ok(/<button[^>]*disabled=""[^>]*>Delete workflow/.test(failed),'Deletion remains disabled after failed lifecycle loading');
 assert.ok(render(true).includes('Loading configuration'),'Parameters retain their separate configuration load');
});

test('shared Provider Activity offers bounded workflow pages only in the Branches opt-in view',async t=>{
 const {QueryClient,QueryClientProvider}=await import('@tanstack/react-query');
 const {ProviderActivitySettingsSection}=await import('../../apps/web/src/components/WorkspaceResourceViews.tsx');
 const client=new QueryClient({defaultOptions:{queries:{retry:false,retryOnMount:false,gcTime:Infinity}}});t.after(()=>client.clear());
 const key=['branches','activity',''];client.setQueryData(key,{pages:[{items:[{id:'off-sidebar',name:'A workflow outside the sidebar'}],hasMore:true,cursor:'next-workflows'}],pageParams:[undefined]});
 const render=workflows=>renderToStaticMarkup(React.createElement(QueryClientProvider,{client},React.createElement(ProviderActivitySettingsSection,{projects:[],workflows})));
 const ordinary=render(false);assert.ok(!ordinary.includes('Load more workflows')&&!ordinary.includes('All Branches'),'Normal Ponderosa must not consume cached Branches scopes');
 const branch=render(true);assert.ok(branch.includes('Load more workflows')&&branch.includes('All Branches'),'Branch activity keeps bounded pagination and its product label');
 const query=client.getQueryCache().find({queryKey:key});assert.equal(query.options.maxPages,1,'Scope search retains a bounded page');
 const original=globalThis.fetch,urls=[];globalThis.fetch=async url=>{urls.push(String(url));return new Response('[]',{headers:{'content-type':'application/json','x-collection-has-more':'false'}})};t.after(()=>{globalThis.fetch=original});
 await query.options.queryFn({pageParam:'opaque-cursor'});
 assert.deepEqual(urls,['/api/branches?search=&cursor=opaque-cursor'],'Workflow scope pagination must use the existing server cursor');
});


test('same-workflow tabs retain only mounted local owners, while workflow/global exits keep their guards',async()=>{
 const {retainedBranchDrafts}=await import('../../apps/web/src/branchesRouting.ts');
 for(const from of ['workflow','chats','executions','parameters','settings'])for(const to of ['workflow','chats','executions','parameters','settings']){
  const retained=retainedBranchDrafts({branchId:'owner',tab:from},{branchId:'owner',tab:to});
  for(const key of ['branch-settings:owner:parameters','branch-settings:owner:limits','branch-execution-budget:owner','branch-capabilities:owner','branch-availability:owner'])assert.ok(retained.localKeys.includes(key),'Mounted local editors must survive same-workflow tab changes');
  assert.ok(!retained.localKeys.includes('chat-capabilities'),'Unmounted child dialogs must keep their own navigation guard');
  assert.ok(!retained.localKeys.includes('branch-settings:foreign:limits'),'Another workflow must not borrow this draft retention');
 }
 for(const next of [{branchId:'foreign',tab:'workflow'},{branchId:'owner',tab:'workflow',global:'activity'},{tab:'workflow'}])assert.deepEqual(retainedBranchDrafts({branchId:'owner',tab:'parameters'},next).localKeys,[]);
});

// Exercise the real intervention fields, mutation and shared dialog shell.
// Controlled transport keeps this recovery check isolated from live work.
async function interventionFixture(t,action,{unknown=false,submit=async()=>({})}={}){
 const {readFileSync}=await import('node:fs'),{createRequire}=await import('node:module'),vm=await import('node:vm');
 const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),ts=require('typescript'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),{QueryClient,MutationObserver}=require('@tanstack/react-query');
 const source=readFileSync(new URL('../../apps/web/src/components/branches/ExecutionPanel.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('execution.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let mutation,dialog;
 function find(node){if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='act')mutation=node.initializer.arguments[0].getText(ast);if(ts.isBinaryExpression(node)&&node.left.getText(ast)==='intervention'&&ts.isJsxElement(node.right)&&node.right.openingElement.tagName.getText(ast)==='ConfirmDialog')dialog=node.getText(ast);ts.forEachChild(node,find)}find(ast);assert.ok(mutation);assert.ok(dialog,'Interventions must use the shared confirmation owner');
 const buttons=[],fields=[],dialogs=[],calls=[],refreshes=[];
 const primitive=({children})=>React.createElement('div',null,children),mui=Object.fromEntries(['Alert','DialogActions','DialogContent','DialogTitle','Stack','Typography','MenuItem'].map(name=>[name,primitive]));
 mui.Dialog=p=>{dialogs.push(p);return p.open?React.createElement('section',null,p.children):null;};mui.Button=p=>{buttons.push(p);return React.createElement('button',{disabled:p.disabled},p.children);};mui.TextField=p=>{fields.push(p);return null;};mui.Switch=p=>{fields.push(p);return null;};mui.FormControlLabel=p=>React.createElement('div',null,p.control);
 const load=(text,scope={})=>vm.runInNewContext(ts.transpile(text,{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}),scope);
 const exports={};load(readFileSync(new URL('../../apps/web/src/components/ConfirmationDialogs.tsx',import.meta.url),'utf8'),{exports,React,require:name=>name==='@mui/material'?mui:require(name)});
 let key=0;const scope={React,...mui,ConfirmDialog:exports.ConfirmDialog,intervention:{action,...(['retry','resolve_script'].includes(action)?{attemptId:'attempt-a',unknown}:{})},reason:'',reconciled:false,result:'',failed:false,target:'',commandKey:'command-0',createClientId:()=>`command-${++key}`,execution:{id:'execution-a',revision:7,parentExecutionId:'parent'},executions:[{id:'target',state:'waiting',createdAt:'2026-10-25T00:00:00Z'}],detail:{attempts:[],steps:[]},refresh:()=>refreshes.push('refresh'),requestJson:async(path,options)=>{calls.push({path,body:JSON.parse(options.body)});return submit();}};
 for(const name of ['intervention','reason','reconciled','result','failed','target','commandKey'])scope['set'+name[0].toUpperCase()+name.slice(1)]=value=>{scope[name]=value;};
 const client=new QueryClient({defaultOptions:{mutations:{retry:false,gcTime:Infinity}}}),observer=new MutationObserver(client,load('('+mutation+')',scope)),unsubscribe=observer.subscribe(()=>{});t.after(()=>{unsubscribe();client.clear();});
 const render=()=>{buttons.length=0;fields.length=0;dialogs.length=0;scope.act={...observer.getCurrentResult(),mutateAsync:observer.mutate.bind(observer)};return renderToStaticMarkup(load('('+dialog+')',scope));};
 return{scope,calls,refreshes,render,dialogs,button:label=>buttons.find(p=>p.children===label),field:label=>fields.find(p=>p.label===label),switches:()=>fields.filter(p=>'checked'in p)};
}

for(const action of ['retry','resolve_script','merge','skip'])test(`shared execution confirmation retains ${action} payload, fields and pending/error ownership`,async t=>{
 let release;const f=await interventionFixture(t,action,{unknown:['retry','resolve_script'].includes(action),submit:()=>new Promise((resolve,reject)=>{release={resolve,reject};})});
 f.render();assert.equal(f.dialogs[0].maxWidth,'sm');assert.equal(f.button('Back').disabled,false);assert.equal(f.button('Apply decision').disabled,true);assert.equal(f.button('Apply decision').autoFocus,true);
 f.field('Reason for this decision').onChange({target:{value:'Verified recovery'}});f.render();if(f.scope.intervention.unknown){assert.equal(f.button('Apply decision').disabled,true);f.switches()[0].onChange(null,true);}
 if(action==='merge'){assert.equal(f.button('Apply decision').disabled,true);f.field('Keep this execution').onChange({target:{value:'target'}});}
 if(action==='resolve_script'){f.field('Observed output').onChange({target:{value:'Observed output retained'}});f.switches()[1].onChange(null,true);}
 f.render();assert.equal(f.button('Apply decision').disabled,false);const key=f.scope.commandKey,confirm=f.button('Apply decision').onClick,saving=confirm();assert.equal(confirm(),undefined,'A second click before pending renders is fenced');f.dialogs[0].onClose({},'escapeKeyDown');assert.ok(f.scope.intervention,'Dismissal is fenced immediately after the first click');await new Promise(resolve=>setImmediate(resolve));f.render();assert.equal(f.dialogs[0]['aria-busy'],true);assert.equal(f.button('Applying…').disabled,true);assert.equal(f.button('Back').disabled,true);if(f.scope.intervention.unknown)assert.equal(f.button('Inspect evidence before deciding').disabled,true);
 for(const why of ['escapeKeyDown','backdropClick'])f.dialogs[0].onClose({},why);f.button('Back').onClick();f.render();assert.equal(f.dialogs[0].open,true);assert.equal(f.calls.length,1,'Pending buttons cannot dispatch another submission');
 const expected={commandKey:key,expectedRevision:7,action,reason:'Verified recovery',...(['retry','resolve_script'].includes(action)?{attemptId:'attempt-a'}:{}),...(f.scope.intervention.unknown?{externalEffectsReconciled:true}:{}),...(action==='resolve_script'?{result:{failed:true,output:'Observed output retained'}}:{}),...(action==='merge'?{mergedInto:'target'}:{})};assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])),{path:'/api/branch-executions/execution-a/intervene',body:expected});
 release.reject(Error('Recovery conflict'));await assert.rejects(saving,/Recovery conflict/);assert.match(f.render(),/Recovery conflict/);assert.equal(f.field('Reason for this decision').value,'Verified recovery');if(action==='resolve_script')assert.equal(f.field('Observed output').value,'Observed output retained');assert.equal(f.scope.commandKey,key);assert.equal(f.button('Back').disabled,false);
 const retry=f.button('Apply decision').onClick();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.calls[1],f.calls[0],'Retry preserves the same intervention identity and fields');release.resolve({});await retry;f.render();assert.equal(f.scope.intervention,undefined);assert.equal(f.refreshes.length,1);
});

test('shared confirmation fences async submissions until settlement without trapping synchronous declined actions',async()=>{
 const {readFileSync}=await import('node:fs'),{createRequire}=await import('node:module'),vm=await import('node:vm');
 const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),ts=require('typescript'),React=require('react');
 const source=readFileSync(new URL('../../apps/web/src/components/ConfirmationDialogs.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('confirm.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let shell;
 ts.forEachChild(ast,node=>{if(ts.isFunctionDeclaration(node)&&node.name?.text==='FormDialogShell')shell=node.getText(ast)});assert.ok(shell);
 const latch={current:false},scope={React,useRef:()=>latch,...Object.fromEntries(['Dialog','DialogTitle','DialogContent','DialogActions','Button','Alert'].map(name=>[name,name]))};
 const render=vm.runInNewContext(ts.transpile('('+shell+')',{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}),scope);let canceled=0,confirmed=0;
 const props={open:true,title:'Confirm',children:'Body',confirmLabel:'Apply',onCancel(){canceled++;}};
 const confirm=tree=>tree.props.children[2].props.children[1].props.onClick;
 for(const throws of [false,true]){
  const tree=render({...props,onConfirm(){confirmed++;if(throws)throw Error('Declined');}});
  if(throws)assert.throws(()=>confirm(tree)(),/Declined/);else confirm(tree)();
  assert.equal(latch.current,false);tree.props.onClose({},'escapeKeyDown');assert.equal(canceled,throws?2:1,'A synchronous no-op or failure does not trap Cancel/Escape');
 }
 let settle;const pending=new Promise((resolve,reject)=>{settle={resolve,reject};}),tree=render({...props,onConfirm(){confirmed++;return pending;}});
 const saving=confirm(tree)(),before=confirmed;assert.equal(confirm(tree)(),undefined);assert.equal(confirmed,before);tree.props.onClose({},'backdropClick');assert.equal(canceled,2);assert.equal(latch.current,true);
 settle.reject(Error('Save failed'));await assert.rejects(saving,/Save failed/);assert.equal(latch.current,false);tree.props.onClose({},'escapeKeyDown');assert.equal(canceled,3);
 const retry=render({...props,onConfirm:()=>Promise.resolve()});await confirm(retry)();assert.equal(latch.current,false);
});
