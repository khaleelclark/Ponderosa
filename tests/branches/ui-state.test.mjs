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
  for(const key of ['branch-settings:owner:parameters','branch-settings:owner:limits','branch-execution-budget:owner','branch-capabilities:owner','branch-availability:owner','branch-deletion:owner'])assert.ok(retained.localKeys.includes(key),'Mounted local editors must survive same-workflow tab changes');
  assert.ok(!retained.localKeys.includes('chat-capabilities'),'Unmounted child dialogs must keep their own navigation guard');
  assert.ok(!retained.localKeys.includes('branch-settings:foreign:limits'),'Another workflow must not borrow this draft retention');
 }
 for(const next of [{branchId:'foreign',tab:'workflow'},{branchId:'owner',tab:'workflow',global:'activity'},{tab:'workflow'}])assert.deepEqual(retainedBranchDrafts({branchId:'owner',tab:'parameters'},next).localKeys,[]);
});

// Exercise the actual asynchronous owner with controlled transport; no second restore implementation.
async function versionActionFixture(){
 const {readFile}=await import('node:fs/promises'),{createRequire}=await import('node:module'),vm=await import('node:vm');
 const ts=createRequire(new URL('../../apps/web/package.json',import.meta.url))('typescript');
 const source=await readFile(new URL('../../apps/web/src/components/BranchesView.tsx',import.meta.url),'utf8');
 const handler=source.split('\n').find(line=>line.trim().startsWith('const versionDefinition='));assert.ok(handler,'Version action owner is available');
 const errors=[],writes=[],requests=[];
 const scope={dirty:false,selection:{current:1},versionRequest:{current:0},draftRevision:{current:'current-draft'},pendingAdvanced:{current:false},contexts:{data:[]},
  setError:error=>errors.push(error),setDraft:update=>writes.push(update({bindings:{},definition:{name:'current'}})),setEditorKey(){},setTab(){},download(){},bindDefinitionDirectories:(_definition,bindings)=>bindings,
  requestJson:async url=>{requests.push(url);return {definition:{name:'old'}}}};
 const code=ts.transpileModule(handler.replace('const versionDefinition=','globalThis.action='),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,scope);return {scope,errors,writes,requests};
}

test('definition restore refuses dirty edits, then an accepted retry retires the old refusal',async()=>{
 const f=await versionActionFixture(),version={branchId:'owner',id:'old-version'};f.scope.dirty=true;
 await f.scope.action(version,true);assert.equal(f.requests.length,0);assert.equal(f.writes.length,0);assert.ok(f.errors.at(-1).includes('Publish or discard'));
 f.scope.dirty=false;await f.scope.action(version,true);
 assert.equal(f.writes.length,1);assert.equal(f.writes[0].definition.name,'old');assert.equal(f.errors.at(-1),'','A successful retry must not retain a refusal that hides the unpublished reminder');
});

test('late definition failures cannot replace feedback for another owner or a newer request',async()=>{
 for(const changed of ['selection','versionRequest']){
  const f=await versionActionFixture();let reject;
  f.scope.requestJson=()=>new Promise((_,fail)=>{reject=fail});
  const pending=f.scope.action({branchId:'old-owner',id:'old-version'},true);
  f.scope[changed].current++;f.scope.setError('Current owner feedback');reject(new Error('Old request failed'));await pending;
  assert.equal(f.errors.at(-1),'Current owner feedback',`An outdated ${changed} must not publish its error`);assert.equal(f.writes.length,0);
 }
});

async function capabilityActionFixture(immediateSave=true,endpoint='/api/branches/owner/capabilities'){
 const {readFile}=await import('node:fs/promises'),{createRequire}=await import('node:module'),vm=await import('node:vm');
 const ts=createRequire(new URL('../../apps/web/package.json',import.meta.url))('typescript');
 const source=await readFile(new URL('../../apps/web/src/components/CapabilityPolicyEditor.tsx',import.meta.url),'utf8'),writes=[],cache=[];
 const {capabilityDraftDirty}=await import('../../apps/web/src/components/capabilityPolicyDraft.ts');
 const policy={revision:4,scopeId:'owner',restrictedCapabilityIds:['connector:hidden','unknown.future']};
 const scope={endpoint,immediateSave,draft:undefined,get dirty(){return capabilityDraftDirty(scope.draft)},writing:{current:false},query:{data:{policy},refetch:async()=>({data:scope.query.data})},
  setDraft:value=>{scope.draft=typeof value==='function'?value(scope.draft):value},client:{setQueryData:(key,value)=>{cache.push({key,value});scope.query.data=value}},
  readback:async()=>scope.query.data,requestJson:async(url,init)=>{if(!init?.body)return scope.readback();writes.push({url,...JSON.parse(init.body)});return scope.query.data},
  useMutation:options=>{scope.options=options;return {isPending:false,mutate:next=>{scope.next=next;scope.accepted=(scope.accepted??0)+1}}}};
 const owner=source.split('\n').filter(line=>['const reloadPolicy=','const save=','const toggle='].some(prefix=>line.trim().startsWith(prefix))).join('\n');
 assert.equal(owner.split('\n').length,3,'Exercise the existing editor owners');
 vm.runInNewContext(ts.transpileModule(owner.replace('const reloadPolicy=','globalThis.reloadPolicy=').replace('const save=','globalThis.save=').replace('const toggle=','globalThis.toggle='),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,scope);
 return {scope,writes,cache};
}

test('immediate capabilities preserve hidden restrictions and admit one write before React rerenders',async()=>{
 const f=await capabilityActionFixture();f.scope.toggle('memory.read',false);f.scope.toggle('memory.write',false);
 assert.equal(f.scope.accepted,1,'A second event must not start another write');await f.scope.options.mutationFn(f.scope.next);
 assert.deepEqual(f.writes,[{url:'/api/branches/owner/capabilities',revision:4,restrictedCapabilityIds:['connector:hidden','memory.read','unknown.future']}]);
 f.scope.options.onSuccess({policy:{revision:5,restrictedCapabilityIds:['connector:hidden','memory.read','unknown.future']}});f.scope.options.onSettled();
 f.scope.toggle('memory.read',true);await f.scope.options.mutationFn(f.scope.next);
 assert.equal(f.writes[1].revision,5);assert.deepEqual(f.writes[1].restrictedCapabilityIds,['connector:hidden','unknown.future']);
});

test('uncertain capability writes read back current policy before explicitly reapplying; failed readback keeps the draft unresolved',async()=>{
 const f=await capabilityActionFixture();f.scope.toggle('memory.read',false);
 f.scope.readback=async()=>{throw new Error('Offline')};await f.scope.options.onError();assert.notDeepEqual(f.scope.draft.restricted,f.scope.draft.baseline,'Unverified write retains navigation protection');
 f.scope.toggle('memory.write',false);assert.equal(f.scope.accepted,1,'Readback remains inside the single write boundary');
 const current={policy:{revision:8,restrictedCapabilityIds:['connector:other-editor']}};f.scope.options.onSettled();f.scope.toggle('memory.write',false);assert.equal(f.scope.accepted,1,'Failed readback must keep switches locked after the mutation settles');f.scope.query.data=current;f.scope.readback=async()=>current;await f.scope.reloadPolicy();
 assert.equal(f.scope.accepted,1,'Readback must never retry the intended write');assert.equal(f.scope.draft.revision,8);assert.equal(f.scope.draft.restricted,f.scope.draft.baseline);
 f.scope.toggle('memory.read',false);await f.scope.options.mutationFn(f.scope.next);assert.equal(f.writes[0].revision,8);assert.deepEqual(f.writes[0].restrictedCapabilityIds,['connector:other-editor','memory.read']);
});

test('manual capability callers still stage edits and responses stay scoped to their original endpoint',async()=>{
 const manual=await capabilityActionFixture(false);manual.scope.toggle('memory.read',false);manual.scope.toggle('memory.write',false);assert.equal(manual.scope.accepted,undefined);assert.ok(manual.scope.draft.restricted.includes('memory.read')&&manual.scope.draft.restricted.includes('memory.write'));
 const old=await capabilityActionFixture(true,'/api/branches/old/capabilities'),next=await capabilityActionFixture(true,'/api/branches/new/capabilities');old.scope.toggle('memory.read',false);old.scope.options.onSuccess({policy:{revision:5,restrictedCapabilityIds:['memory.read']}});
 assert.deepEqual(JSON.parse(JSON.stringify(old.cache[0].key)),['capability-policy','/api/branches/old/capabilities']);assert.equal(next.cache.length,0);assert.equal(next.scope.draft,undefined);
});

test('immediate-save capability presentation removes manual actions while preserving inherited/unavailable switches and ordinary defaults',async()=>{
 const {QueryClient,QueryClientProvider}=await import('@tanstack/react-query'),{CapabilityPolicyEditor}=await import('../../apps/web/src/components/CapabilityPolicyEditor.tsx');
 const client=new QueryClient({defaultOptions:{queries:{staleTime:Infinity,gcTime:Infinity,retry:false}}}),endpoint='/api/branches/b/capabilities';
 client.setQueryData(['capability-policy',endpoint],{policy:{scopeId:'b',revision:1,restrictedCapabilityIds:[]},effective:{restrictionSources:{inherited:{scopeKind:'global',scopeId:'global',label:'Global'}}},catalog:[{id:'inherited',label:'Inherited',description:'Broader restriction',categoryLabel:'Tools',available:true},{id:'unavailable',label:'Unavailable',description:'Not installed',categoryLabel:'Tools',available:false}]});
 try{for(const immediateSave of [false,true]){const html=renderToStaticMarkup(React.createElement(QueryClientProvider,{client},React.createElement(CapabilityPolicyEditor,{endpoint,scopeKind:'branch',immediateSave})));assert.equal(html.includes('Save capabilities'),!immediateSave);assert.ok(html.includes('Restricted by Global')&&html.includes('Not installed'));assert.equal((html.match(/type="checkbox"[^>]*disabled=""|disabled=""[^>]*type="checkbox"/g)??[]).length,2,'Inherited/unavailable switches stay disabled');}}finally{client.clear()}
});

test('canceled query refresh cannot retire an uncertain capability write before HTTP readback completes',async()=>{
 const {QueryClient,QueryObserver}=await import('@tanstack/react-query'),{capabilityDraftDirty}=await import('../../apps/web/src/components/capabilityPolicyDraft.ts');
 const f=await capabilityActionFixture(),client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}}),queryKey=['capability-policy',f.scope.endpoint];
 client.setQueryData(queryKey,f.scope.query.data);
 const observer=new QueryObserver(client,{queryKey,enabled:false,queryFn:()=>new Promise(()=>{})});f.scope.query.refetch=options=>observer.refetch(options);let complete;
 f.scope.readback=()=>new Promise(resolve=>{complete=resolve});
 try{
  f.scope.toggle('memory.read',false);const refresh=observer.refetch(),pending=f.scope.options.onError();await client.cancelQueries({queryKey,exact:true});await refresh;
  assert.equal(capabilityDraftDirty(f.scope.draft),true,'Canceled cached refresh is not a confirmed policy');f.scope.toggle('memory.write',false);assert.equal(f.scope.accepted,1,'Uncertain draft remains locked');
  const current={policy:{revision:9,restrictedCapabilityIds:['connector:confirmed']}};complete(current);await pending;f.scope.options.onSettled();
  assert.equal(f.scope.draft.revision,9);assert.equal(capabilityDraftDirty(f.scope.draft),false);f.scope.toggle('memory.read',false);assert.equal(f.scope.accepted,2,'Completed HTTP readback permits an explicit new toggle');
 }finally{client.clear()}
});

test('explicit capability readback shares the existing single-flight write boundary',async()=>{
 const f=await capabilityActionFixture();let complete,reads=0;f.scope.readback=()=>{reads++;return new Promise(resolve=>{complete=resolve})};
 const first=f.scope.reloadPolicy(),duplicate=f.scope.reloadPolicy();await duplicate;f.scope.toggle('memory.read',false);
 assert.equal(reads,1,'Duplicate reloads must not leave an older GET behind a newer write');assert.equal(f.scope.accepted,undefined,'No toggle may enter while readback is unresolved');
 complete({policy:{revision:10,restrictedCapabilityIds:['connector:current']}});await first;f.scope.toggle('memory.read',false);assert.equal(f.scope.accepted,1);assert.equal(f.scope.next.revision,10);
});

test('capability readback starts a fresh HTTP request instead of joining a pre-write background GET',async()=>{
 const {requestJson}=await import('../../apps/web/src/api/real.ts'),f=await capabilityActionFixture(true,'/api/branches/readback-isolated/capabilities'),original=globalThis.fetch,calls=[],pending=[];let prior,readback;
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),cache:init?.cache});return new Promise(resolve=>pending.push(resolve))};f.scope.requestJson=requestJson;
 try{
  prior=requestJson(f.scope.endpoint);await new Promise(resolve=>setImmediate(resolve));f.scope.toggle('memory.read',false);readback=f.scope.options.onError();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,2,'Readback cannot borrow a request that began before the uncertain write');assert.equal(calls[1].cache,'no-store');
  pending[0](new Response(JSON.stringify(f.scope.query.data)));await prior;assert.equal(f.scope.dirty,true);
  pending[1](new Response(JSON.stringify({policy:{revision:12,restrictedCapabilityIds:['connector:fresh']}})));await readback;assert.equal(f.scope.draft.revision,12);
 }finally{for(const resolve of pending)resolve(new Response(JSON.stringify({policy:{revision:4,restrictedCapabilityIds:[]}})));await Promise.allSettled([prior,readback]);globalThis.fetch=original}
});

async function deletionActionFixture(initial={}){
 const {readFile}=await import('node:fs/promises'),{createRequire}=await import('node:module'),vm=await import('node:vm'),{ApiRequestError}=await import('../../apps/web/src/api/types.ts');
 const ts=createRequire(new URL('../../apps/web/package.json',import.meta.url))('typescript'),source=await readFile(new URL('../../apps/web/src/components/branches/BranchSettings.tsx',import.meta.url),'utf8'),calls=[];
 const life={deleting:false,chats:2,activeExecutions:0,callers:[],updates:[],pendingRemoval:[],...initial};
 const scope={branch:{id:'owner'},active:{current:true},generation:{current:1},removing:{current:false},finished:{current:false},acknowledged:false,deleteOpen:true,serverLife:life,lifecycle:{data:life,refetch:async()=>{}},client:{invalidateQueries:async()=>{},setQueryData:(_key,data)=>{scope.lifecycle.data=data}},ApiRequestError,
  get deletionBlocked(){return scope.blocked()},setAcknowledged:value=>{scope.acknowledged=value},setDeleteOpen:value=>{scope.deleteOpen=value},onDeleted:()=>{scope.deleted=(scope.deleted??0)+1},
  requestJson:async(path,init)=>{calls.push({path,method:init?.method??'GET',cache:init?.cache});if(init?.method==='DELETE'){if(scope.deleteError)throw scope.deleteError;return scope.deleteResult??{deleted:true,pending:false}}if(scope.readError)throw scope.readError;return scope.serverLife},
  useEffect:effect=>effect(),useMutation:options=>{const state={isPending:false,isSuccess:false,isError:false,options,mutate:input=>{state.pending=state.mutateAsync(input).catch(()=>{})},mutateAsync:async input=>{state.variables=input;state.data=undefined;state.error=null;state.isPending=true;state.isSuccess=state.isError=false;try{const data=await options.mutationFn(input);await options.onSuccess?.(data,input);state.data=data;state.isSuccess=true;return data}catch(error){await options.onError?.(error,input);state.error=error;state.isError=true;throw error}finally{state.isPending=false;options.onSettled?.()}}};return state}};
 const prefixes=['const finishDeleted=','const preflight=','const remove=','const refreshDeletion=','const closeDeletion=','const deletionBlocked=','const confirmDeletion='];
 const lines=source.split('\n').filter(line=>prefixes.some(prefix=>line.trim().startsWith(prefix)));assert.equal(lines.length,prefixes.length);
 const code=lines.map(line=>line.replace(/const (finishDeleted|preflight|remove|refreshDeletion|closeDeletion|confirmDeletion)=/,'globalThis.$1=').replace('const deletionBlocked=','globalThis.blocked=()=>')).join('\n');
 const run=code=>vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,scope);run(code);
 scope.checkRemoval=()=>run(source.split('\n').find(line=>line.includes('useEffect(()=>{if(lifecycle.error instanceof ApiRequestError')));
 await scope.preflight.mutateAsync(scope.generation.current);return {scope,calls,ApiRequestError};
}

test('workflow deletion requires acknowledgement, fresh counts and a single exact DELETE',async()=>{
 const f=await deletionActionFixture();f.scope.confirmDeletion();assert.equal(f.calls.filter(c=>c.method==='DELETE').length,0);f.scope.acknowledged=true;f.scope.confirmDeletion();f.scope.confirmDeletion();await f.scope.remove.pending;
 assert.deepEqual(f.calls.filter(c=>c.method==='DELETE'),[{path:'/api/branches/owner',method:'DELETE',cache:undefined}]);assert.equal(f.scope.deleted,1);assert.equal(f.scope.deleteOpen,false);assert.ok(f.calls.filter(c=>c.method==='GET').every(c=>c.cache==='no-store'));
});

test('changed workflow counts or blockers require fresh acknowledgement without deleting',async()=>{
 for(const change of [{chats:3},{activeExecutions:1},{callers:[{id:'caller',name:'Caller'}]},{updates:[{id:'update'}]}]){
  const f=await deletionActionFixture();f.scope.serverLife={...f.scope.serverLife,...change};f.scope.acknowledged=true;f.scope.confirmDeletion();await f.scope.remove.pending;
  assert.equal(f.calls.some(c=>c.method==='DELETE'),false);assert.equal(f.scope.acknowledged,false);assert.equal(f.scope.deleted,undefined);assert.ok(f.scope.remove.error,'Changed preflight remains visible for review');
 }
});

test('uncertain deletion reads back canonical pending cleanup without retrying DELETE; exact 404 retires once',async()=>{
 const f=await deletionActionFixture();f.scope.deleteError=new Error('Response lost');const request=f.scope.requestJson;f.scope.requestJson=async(path,init)=>{if(init?.method==='DELETE')f.scope.serverLife={...f.scope.serverLife,deleting:true};return request(path,init)};
 f.scope.acknowledged=true;f.scope.confirmDeletion();await f.scope.remove.pending;assert.equal(f.scope.deleteOpen,false);assert.equal(f.scope.deleted,undefined);assert.equal(f.calls.filter(c=>c.method==='DELETE').length,1);assert.equal(f.scope.deletionBlocked,true);
 f.scope.lifecycle.error=new f.ApiRequestError(503,'Unavailable');f.scope.checkRemoval();assert.equal(f.scope.deleted,undefined,'Service failure is not deletion proof');
 f.scope.lifecycle.error=new f.ApiRequestError(404,'Branch not found');f.scope.checkRemoval();f.scope.checkRemoval();assert.equal(f.scope.deleted,1);
});

test('failed deletion readback stays blocked and late owner cleanup cannot delete or clear another workflow',async()=>{
 const f=await deletionActionFixture(),request=f.scope.requestJson;f.scope.requestJson=async(path,init)=>{if(init?.method==='DELETE'){f.scope.readError=new Error('Offline');f.scope.deleteError=new Error('Response lost')}return request(path,init)};f.scope.acknowledged=true;f.scope.confirmDeletion();await f.scope.remove.pending;
 assert.equal(f.scope.preflight.isError,true);assert.equal(f.scope.deletionBlocked,true);assert.equal(f.scope.acknowledged,false);assert.equal(f.scope.deleted,undefined);f.scope.confirmDeletion();assert.equal(f.calls.filter(c=>c.method==='DELETE').length,1);
 const old=await deletionActionFixture();let complete;old.scope.requestJson=()=>new Promise(resolve=>{complete=resolve});old.scope.acknowledged=true;old.scope.confirmDeletion();old.scope.active.current=false;old.scope.generation.current++;complete(old.scope.serverLife);await old.scope.remove.pending;
 assert.equal(old.calls.some(c=>c.method==='DELETE'),false);assert.equal(old.scope.deleted,undefined);
});

test('closing deletion resets acknowledgement and invalidates a late preflight',async()=>{
 const f=await deletionActionFixture();f.scope.acknowledged=true;f.scope.closeDeletion();assert.equal(f.scope.acknowledged,false);assert.equal(f.scope.deleteOpen,false);assert.equal(f.scope.deletionBlocked,true,'Closed confirmation cannot submit its earlier snapshot');const current=f.scope.lifecycle.data;f.scope.preflight.options.onSuccess({...current,chats:99},f.scope.generation.current-1);assert.equal(f.scope.lifecycle.data,current,'Closed confirmation must not publish its late counts');
});

test('canonical workflow deletion defers navigation until cleanup and fences both owner and next frame',async()=>{
 const {readFile}=await import('node:fs/promises'),{createRequire}=await import('node:module'),vm=await import('node:vm');const ts=createRequire(new URL('../../apps/web/package.json',import.meta.url))('typescript'),source=await readFile(new URL('../../apps/web/src/components/BranchesView.tsx',import.meta.url),'utf8'),handler=source.split('\n').find(line=>line.trim().startsWith('const branchDeleted='));
 for(const changed of ['none','before-owner','before-global','after-owner','after-tab','after-selection']){
  const frames=[],writes=[],navigations=[],scope={routeOwner:{current:{branchId:changed==='before-owner'?'new':'old',...(changed==='before-global'?{global:'general'}:{})}},selection:{current:7},savedDraft:{current:'dirty'},emptyDraft:()=>({}),setDraft:value=>writes.push(value),setAdvancedDirty(){},setPreview(){},client:{removeQueries(){},invalidateQueries:async()=>{}},requestAnimationFrame:cb=>frames.push(cb),navigate:route=>navigations.push(route)};
  vm.runInNewContext(ts.transpileModule(handler.replace('const branchDeleted=','globalThis.deleted='),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,scope);scope.deleted('old',7);
  if(changed==='before-owner'||changed==='before-global'){assert.equal(writes.length,0);continue}assert.equal(writes.length,1);assert.equal(navigations.length,0);if(changed==='after-owner')scope.routeOwner.current={branchId:'new'};if(changed==='after-tab')scope.routeOwner.current={branchId:'old',tab:'chats'};if(changed==='after-selection')scope.selection.current++;frames[0]();assert.equal(navigations.length,changed==='none'?1:0);
 }
});

test('a fresh deletion owner resumes durable pending cleanup and leaves only on canonical absence',async()=>{
 const f=await deletionActionFixture({deleting:true});assert.equal(f.scope.deleteOpen,false);assert.equal(f.scope.deletionBlocked,true);assert.equal(f.scope.deleted,undefined);assert.equal(f.calls.some(c=>c.method==='DELETE'),false);
 f.scope.lifecycle.error=new f.ApiRequestError(404,'Branch not found');f.scope.checkRemoval();assert.equal(f.scope.deleted,1);
});

test('declined parent deletion cleanup remains retryable when the current callback is reconciled',async()=>{
 const f=await deletionActionFixture();f.scope.onDeleted=()=>false;f.scope.lifecycle.error=new f.ApiRequestError(404,'Branch not found');f.scope.checkRemoval();assert.equal(f.scope.finished.current,false);
 f.scope.onDeleted=()=>{f.scope.deleted=(f.scope.deleted??0)+1};f.scope.checkRemoval();assert.equal(f.scope.finished.current,true);assert.equal(f.scope.deleted,1);
});

const creationJournal=await import('../../apps/web/src/components/chatCreationAttempts.ts');
const {resolveConversationEngine}=await import('../../apps/web/src/conversationEngine.ts');
const {ApiRequestError}=await import('../../apps/web/src/api/types.ts');
const {definitiveSubmissionStatus}=await import('../../apps/web/src/components/idempotentAttempt.ts');
const {removeBrowserStorage}=await import('../../apps/web/src/browserStorage.ts');
function creationStorage(){removeBrowserStorage('sessionStorage',creationJournal.chatCreationAttemptsKey);let value='[]',blocked=false;return {get value(){return value},set value(next){value=next},set blocked(next){blocked=next},getItem(){if(blocked)throw Error('Storage denied');return value},setItem(_key,next){if(blocked)throw Error('Storage denied');value=next}};}
async function creationActionFixture(){
 const fs=await import('node:fs/promises'),vm=await import('node:vm'),ts=await import('typescript'),source=await fs.readFile(new URL('../../apps/web/src/components/NewChatComposer.tsx',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('  const retire ='),source.indexOf('  useEffect(() => {\n    if (!creationKey')),errors=[],opened=[],invalidated=[],requests=[];
 const scope={...creationJournal,ApiRequestError,definitiveSubmissionStatus,resolveConversationEngine,owner:{product:'branches',branchId:'owner'},creationKey:'same-intent',locked:{current:false},mounted:{current:true},engines:[{id:'codex',installed:true,enabled:true,authentication:'authenticated',intakeReady:true}],setBusy(){},setError:value=>errors.push(value),queryKeys:{projects:{all:['projects']},workspaceDirectory:{all:['directory']}},queryClient:{invalidateQueries:async value=>invalidated.push(value.queryKey)},onCreated:(projectId,id)=>opened.push({projectId,id}),submitCreationAttempt:async attempt=>{requests.push(attempt);return {id:'created',projectId:'project'}}};
 vm.runInNewContext(ts.transpileModule(code+'\nglobalThis.create=create;',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,scope);return {scope,errors,opened,invalidated,requests};
}

test('creation journal scopes Branch identities, retains ordinary legacy attempts and requires durable storage',()=>{
 const original=globalThis.window,storage=creationStorage();globalThis.window={sessionStorage:storage};
 try{const input={label:'New Chat',defaultEngine:'codex'},legacy={key:'ordinary',input},branch={key:'branch',owner:{product:'branches',branchId:'one'},input};
  storage.value=JSON.stringify([legacy,branch,{...branch,key:'invalid',owner:{product:'other',branchId:'one'}},{...branch,key:'invalid2',owner:{product:'branches'}}]);assert.deepEqual(creationJournal.readCreationAttempts(),[legacy,branch]);assert.equal(creationJournal.sameCreationAttempt(branch,{...branch,owner:undefined}),false);assert.equal(creationJournal.sameCreationOwner(branch.owner,{product:'branches',branchId:'two'}),false);
  storage.blocked=true;assert.equal(creationJournal.ensureCreationAttemptPersisted(branch),false,'Memory fallback cannot authorize dispatch');storage.blocked=false;assert.equal(creationJournal.ensureCreationAttemptPersisted(branch),true);
 }finally{globalThis.window=original;}
});

test('creation transport sends exact payload/key through its persisted Branch or ordinary owner',async()=>{
 const original=globalThis.window,fetch=globalThis.fetch,calls=[];globalThis.window={location:{pathname:'/branches'}};globalThis.fetch=async(url,init)=>{calls.push({url,...init});return new Response(JSON.stringify({id:'created',projectId:'project'}),{headers:{'content-type':'application/json'}})};
 try{const input={label:'New Chat',defaultEngine:'codex'};await creationJournal.submitCreationAttempt({key:'branch-intent',input,owner:{product:'branches',branchId:'owner/encoded'}});assert.equal(calls[0].url,'/api/branches/owner%2Fencoded/chats');assert.equal(new Headers(calls[0].headers).get('idempotency-key'),'branch-intent');assert.equal(calls[0].body,JSON.stringify(input));window.location.pathname='/home';await creationJournal.submitCreationAttempt({key:'ordinary-intent',input});assert.equal(calls[1].url,'/api/chats');assert.equal(new Headers(calls[1].headers).get('idempotency-key'),'ordinary-intent');}finally{globalThis.window=original;globalThis.fetch=fetch;}
});

test('single-flight creation preserves exact retries through response loss, reload and changed engine defaults',async()=>{
 const original=globalThis.window,storage=creationStorage();globalThis.window={sessionStorage:storage};
 try{const f=await creationActionFixture();let reject;f.scope.submitCreationAttempt=attempt=>{f.requests.push(attempt);return new Promise((_,fail)=>{reject=fail})};const pending=f.scope.create();await f.scope.create();assert.equal(f.requests.length,1);reject(Error('Response lost'));await pending;assert.match(f.errors.at(-1),/unconfirmed/);const attempt=JSON.parse(storage.value)[0];
  const retry=await creationActionFixture();retry.scope.engines=[{id:'claude'}];await retry.scope.create();assert.equal(JSON.stringify(retry.requests[0]),JSON.stringify(attempt));assert.equal(retry.opened.length,1);assert.equal(JSON.parse(storage.value)[0].chat.id,'created');
 }finally{globalThis.window=original;}
});

test('receipt failure and late completion retain retry and refresh the original owner without stealing navigation',async()=>{
 const original=globalThis.window,storage=creationStorage();globalThis.window={sessionStorage:storage};
 try{const f=await creationActionFixture();f.scope.submitCreationAttempt=async()=>{storage.blocked=true;return {id:'created',projectId:'project'}};await f.scope.create();assert.equal(f.opened.length,0);assert.ok(f.invalidated.some(key=>key[0]==='branch-chats'&&key[1]==='owner'));assert.match(f.errors.at(-1),/receipt/);
  storage.blocked=false;const retry=await creationActionFixture();retry.scope.mounted.current=false;await retry.scope.create();assert.equal(retry.opened.length,0);assert.equal(JSON.parse(storage.value)[0].chat.id,'created');assert.ok(retry.invalidated.some(key=>key[0]==='branch-chats'&&key[1]==='owner'));
 }finally{globalThis.window=original;}
});

test('missing provider/storage and definite rejection remain actionable without unsafe dispatch',async()=>{
 const original=globalThis.window,storage=creationStorage();globalThis.window={sessionStorage:storage};
 try{const f=await creationActionFixture();f.scope.engines=[];await f.scope.create();assert.equal(f.requests.length,0);assert.match(f.errors.at(-1),/No provider/);f.scope.engines=[{id:'codex'}];storage.blocked=true;await f.scope.create();assert.equal(f.requests.length,0);assert.match(f.errors.at(-1),/storage/);storage.blocked=false;f.scope.submitCreationAttempt=async()=>{throw new ApiRequestError(400,'Provider unavailable')};await f.scope.create();assert.equal(creationJournal.readCreationAttempts().length,0);}finally{globalThis.window=original;}
});

test('Branch creation URL survives reload and completion refuses another owner, view or intent',async()=>{
 const route={branchId:'owner',tab:'chats',creationKey:'exact-intent'};assert.deepEqual(parseBranchRoute(new URL(branchRoutePath(route),'https://example.test').search),route);
 const fs=await import('node:fs/promises'),vm=await import('node:vm'),ts=await import('typescript'),source=await fs.readFile(new URL('../../apps/web/src/components/branches/BranchChats.tsx',import.meta.url),'utf8'),handler=source.split('\n').find(line=>line.trim().startsWith('const created='));assert.ok(handler);
 const writes=[],scope={branchId:'owner',creationKey:'exact-intent',currentRoute:{current:route},onNavigate:next=>{writes.push(next);return true}};vm.runInNewContext(ts.transpileModule(handler.replace('const created=','globalThis.created='),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,scope);
 for(const next of [{...route,branchId:'other'},{...route,tab:'workflow'},{...route,global:'providers'},{...route,creationKey:'new-intent'},{...route,executionId:'temporary'}]){scope.currentRoute.current=next;assert.equal(scope.created('p','c'),false)}assert.equal(writes.length,0);scope.currentRoute.current=route;scope.created('p','c');assert.equal(writes.length,1);assert.equal(writes[0].chatId,'c');assert.equal(writes[0].creationKey,undefined);
});

test('ordinary recovery excludes Branch attempts instead of using the generic endpoint',async()=>{
 const original=globalThis.window,storage=creationStorage();globalThis.window={sessionStorage:storage};const {QueryClient,QueryClientProvider}=await import('@tanstack/react-query'),{ChatCreationRecovery}=await import('../../apps/web/src/components/ChatCreationRecovery.tsx'),client=new QueryClient();
 try{storage.value=JSON.stringify([{key:'branch',owner:{product:'branches',branchId:'owner'},input:{label:'Branch',defaultEngine:'codex'}}]);const render=()=>renderToStaticMarkup(React.createElement(QueryClientProvider,{client},React.createElement(ChatCreationRecovery,{onCreated(){}})));assert.equal(render(),'');storage.value=JSON.stringify([{key:'legacy',input:{label:'Ordinary',defaultEngine:'codex'}}]);assert.match(render(),/Recover earlier Chat/);}finally{client.clear();globalThis.window=original;}
});


test('invalid raw owner metadata cannot stand in for an ordinary durable creation attempt',()=>{
 const original=globalThis.window,attempt={key:'ordinary-raw',input:{label:'New Chat',defaultEngine:'codex'}};
 try{for(const owner of [{},null]){removeBrowserStorage('sessionStorage',creationJournal.chatCreationAttemptsKey);globalThis.window={sessionStorage:{getItem:()=>JSON.stringify([{...attempt,owner}]),setItem(){throw Error('Denied')}}};assert.equal(creationJournal.sameCreationOwner(undefined,owner),false);assert.equal(creationJournal.ensureCreationAttemptPersisted(attempt),false,'Invalid raw owner must be rewritten durably before dispatch');}}finally{removeBrowserStorage('sessionStorage',creationJournal.chatCreationAttemptsKey);globalThis.window=original;}
});

test('declined navigation retains a completed receipt and an actionable exact retry',async()=>{
 const original=globalThis.window,storage=creationStorage();globalThis.window={sessionStorage:storage};
 try{const f=await creationActionFixture();f.scope.onCreated=()=>false;await f.scope.create();assert.equal(JSON.parse(storage.value)[0].chat.id,'created');assert.match(f.errors.at(-1),/Retry to open the same Chat/);}finally{globalThis.window=original;}
});

test('a stale Branch panel cannot start creation for a new selection or temporary inspection',async()=>{
 const fs=await import('node:fs/promises'),vm=await import('node:vm'),ts=await import('typescript'),source=await fs.readFile(new URL('../../apps/web/src/components/branches/BranchChats.tsx',import.meta.url),'utf8');
 const allowed=source.split('\n').find(line=>line.trim().startsWith('const creationAllowed=')),start=source.split('\n').find(line=>line.trim().startsWith('const startChat='));assert.ok(allowed&&start);
 for(const route of [{branchId:'other',tab:'chats'},{branchId:'owner',tab:'workflow'},{branchId:'owner',tab:'chats',global:'providers'},{branchId:'owner',tab:'chats',executionId:'temporary'},{branchId:'owner',tab:'chats'}]){
  const writes=[],scope={branchRoute:route,branchId:'owner',executionId:route.executionId,creationKey:undefined,pendingAttempt:undefined,starting:{current:false},createClientId:()=> 'intent',onNavigate:next=>{writes.push(next);return true}};
  vm.runInNewContext(ts.transpileModule(allowed+'\n'+start.replace('const startChat=','globalThis.startChat='),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,scope);scope.startChat();scope.startChat();assert.equal(writes.length,route.branchId==='owner'&&route.tab==='chats'&&!route.global&&!route.executionId?1:0);
 }
});

test('BR010 compact picker distinguishes unknown and empty counts without restoring the wide dropdown',async()=>{
 const fs=await import('node:fs/promises'),vm=await import('node:vm'),ts=await import('typescript'),mui=await import('@mui/material'),source=await fs.readFile(new URL('../../apps/web/src/components/branches/BranchChats.tsx',import.meta.url),'utf8');
 const toolbar=source.split('\n').find(line=>line.includes('aria-haspopup="dialog"'));assert.ok(toolbar);
 const scope={React,...mui,ChatIcon:()=>null,ArrowDropDownIcon:()=>null,AddIcon:()=>null,MoreHorizIcon:()=>null,executionId:undefined,chatCount:undefined,chatPages:{},creationKey:undefined,chat:undefined,notificationAction:undefined,setSearch(){},setPicker(){},startChat(){}};
 vm.runInNewContext(ts.transpileModule('globalThis.Toolbar=()=>('+toolbar+');',{fileName:'toolbar.tsx',compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText,scope);
 for(const total of [undefined,0,103]){scope.chatCount=total;const html=renderToStaticMarkup(React.createElement(scope.Toolbar));assert.ok(html.includes(`Chats (${total??'…'})`));assert.doesNotMatch(html,/Branch Chat<|role="combobox"/);assert.match(html,/aria-label="New Chat"/);}
 scope.chatPages={error:Error('Unavailable')};scope.chatCount=undefined;assert.ok(renderToStaticMarkup(React.createElement(scope.Toolbar)).includes('Chats (?)'));
});

test('BR010 picker uses current owner/execution and keeps the chooser open when navigation is refused',async()=>{
 const fs=await import('node:fs/promises'),vm=await import('node:vm'),ts=await import('typescript'),source=await fs.readFile(new URL('../../apps/web/src/components/branches/BranchChats.tsx',import.meta.url),'utf8'),handler=source.split('\n').find(line=>line.trim().startsWith('const chooseChat='));assert.ok(handler);
 const route={branchId:'owner',tab:'chats'},writes=[],closes=[],scope={branchId:'owner',executionId:undefined,currentRoute:{current:route},openChat:(...args)=>{writes.push(args);return false},setPicker:value=>closes.push(value)};vm.runInNewContext(ts.transpileModule(handler.replace('const chooseChat=','globalThis.chooseChat='),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,scope);
 for(const current of [{...route,branchId:'other'},{...route,executionId:'temporary'},{...route,tab:'workflow'},{...route,global:'providers'}]){scope.currentRoute.current=current;scope.chooseChat({id:'c',projectId:'p'})}assert.equal(writes.length,0);
 scope.currentRoute.current=route;scope.chooseChat({id:'c',projectId:'p'});assert.equal(writes.length,1);assert.equal(closes.length,0);scope.openChat=()=>true;scope.chooseChat({id:'c',projectId:'p'});assert.deepEqual(closes,[false]);
});

test('BR010 records only accepted canonical Chat selections, never polling or failed/foreign/temporary routes',async()=>{
 const fs=await import('node:fs/promises'),vm=await import('node:vm'),ts=await import('typescript'),source=await fs.readFile(new URL('../../apps/web/src/components/branches/BranchChats.tsx',import.meta.url),'utf8'),handler=source.split('\n').find(line=>line.trim().startsWith('const recordSelectedChatUse='));assert.ok(handler);
 const uses=[],refreshes=[],route={branchId:'owner',tab:'chats'},scope={branchId:'owner',chatId:'old-chat',executionId:undefined,ownerMatches:false,usedChat:{current:undefined},currentRoute:{current:route},client:{invalidateQueries:value=>refreshes.push(value)},markWorkspaceResourceUsed:async(_client,kind,id)=>uses.push({kind,id})};
 vm.runInNewContext(ts.transpileModule(handler.replace('const recordSelectedChatUse=','globalThis.record='),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,scope);scope.record();assert.equal(uses.length,0);scope.ownerMatches=true;scope.record();scope.record();await Promise.resolve();assert.deepEqual(uses,[{kind:'conversation',id:'old-chat'}]);assert.equal(refreshes.length,1);
 for(const current of [{...route,branchId:'other'},{...route,tab:'workflow'},{...route,global:'providers'}]){scope.currentRoute.current=current;scope.record()}assert.equal(uses.length,1);scope.currentRoute.current=route;scope.executionId='temporary';scope.record();assert.equal(uses.length,1);scope.executionId=undefined;scope.chatId='other-chat';scope.record();assert.equal(uses.length,2);
});

async function br011OwnerFixture(){
 const fs=await import('node:fs/promises'),vm=await import('node:vm'),ts=await import('typescript'),source=await fs.readFile(new URL('../../apps/web/src/components/branches/BranchChats.tsx',import.meta.url),'utf8');
 const intent={projectId:'p',conversationId:'c'},route={branchId:'owner',tab:'chats',chatId:'c',workspace:{kind:'agent',projectId:'p',agentId:'a'}},frames=[],navigations=[],closes=[],pending=[],dirty=[],errors=[],invalidated=[];
 const scope={active:{current:true},currentAgentCreate:{current:intent},agentCreate:intent,currentRoute:{current:route},branchId:'owner',chat:{id:'c',projectId:'p'},client:{invalidateQueries:async value=>invalidated.push(value.queryKey)},setAgentCreate:value=>closes.push(value),setAgentCreatePending:value=>pending.push(value),setCapabilityDirty:value=>dirty.push(value),setError:value=>errors.push(value),onNavigate:next=>{navigations.push(next);return true},requestAnimationFrame:fn=>frames.push(fn)};
 const lines=source.split('\n').filter(line=>['const closeAgentCreate=','const agentCreated=','const resourceDeleted='].some(prefix=>line.trim().startsWith(prefix))).map(line=>line.replace(/const (closeAgentCreate|agentCreated|resourceDeleted)=/,'globalThis.$1='));assert.equal(lines.length,3);
 vm.runInNewContext(ts.transpileModule(lines.join('\n'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,scope);return {scope,frames,navigations,closes,pending,dirty,errors,invalidated,intent,route};
}

test('BR011 created Agents clear pending before guarded navigation and old import/cancel cannot close a new modal',async()=>{
 const f=await br011OwnerFixture();f.scope.agentCreated('p','new');assert.deepEqual(f.pending,[false]);assert.deepEqual(f.closes,[undefined]);assert.equal(f.navigations.length,0,'Completion waits for the pending guard to unregister');f.scope.currentAgentCreate.current=undefined;f.frames.shift()();assert.equal(f.navigations[0].workspace.agentId,'new');
 for(const stale of ['unmounted','reopened']){const old=await br011OwnerFixture();if(stale==='unmounted')old.scope.active.current=false;else old.scope.currentAgentCreate.current={...old.intent};assert.equal(old.scope.closeAgentCreate(),false);old.scope.agentCreated('p','late');assert.equal(old.closes.length,0);assert.equal(old.pending.length,0);assert.equal(old.frames.length,0);}
});

test('BR011 late create completion cannot overwrite another route or a new dialog, and declined navigation stays truthful',async()=>{
 for(const change of ['route','dialog']){const f=await br011OwnerFixture();f.scope.agentCreated('p','new');f.scope.currentAgentCreate.current=undefined;if(change==='route')f.scope.currentRoute.current={...f.route,branchId:'other'};else f.scope.currentAgentCreate.current={...f.intent};f.frames.shift()();assert.equal(f.navigations.length,0);}
 const f=await br011OwnerFixture();f.scope.onNavigate=()=>false;f.scope.agentCreated('p','new');f.scope.currentAgentCreate.current=undefined;f.frames.shift()();assert.match(f.errors[0],/Agent was created/);
});

test('BR011 canonical deletion retires only the removed current view and preserves unrelated navigation/drafts',async()=>{
 const f=await br011OwnerFixture();f.scope.resourceDeleted({kind:'agent',projectId:'p',agentId:'other'});assert.equal(f.frames.length,0);assert.equal(f.dirty.length,0);
 f.scope.resourceDeleted({kind:'agent',projectId:'p',agentId:'a'});assert.deepEqual(f.dirty,[false]);assert.equal(f.navigations.length,0);f.frames.shift()();assert.equal(f.navigations[0].workspace.conversationId,'c');
 for(const changed of ['unmounted','route','project']){const old=await br011OwnerFixture();if(changed==='unmounted')old.scope.active.current=false;if(changed==='project')old.scope.chat={id:'c',projectId:'new-project'};old.scope.resourceDeleted({kind:'conversation',projectId:'p',conversationId:'c'});if(changed==='route')old.scope.currentRoute.current={...old.route,branchId:'other'};old.frames.forEach(fn=>fn());assert.equal(old.navigations.length,0);}
});

test('BR011 Agent tabs preserve the mounted settings draft when navigation is refused, retaining ordinary void behavior',async()=>{
 const fs=await import('node:fs/promises'),vm=await import('node:vm'),ts=await import('typescript'),source=await fs.readFile(new URL('../../apps/web/src/components/AgentDetail.tsx',import.meta.url),'utf8'),line=source.split('\n').find(line=>line.trim().startsWith('const changeTab='));assert.ok(line);
 const changes=[],scope={onViewChange:()=>false,setTab:value=>changes.push(value)};vm.runInNewContext(ts.transpileModule(line.replace('const changeTab=','globalThis.changeTab='),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,scope);scope.changeTab('chat');assert.equal(changes.length,0);scope.onViewChange=()=>undefined;scope.changeTab('chat');assert.deepEqual(changes,['chat']);scope.onViewChange=()=>true;scope.changeTab('technical');assert.deepEqual(changes,['chat','technical']);
 const technical=source.slice(source.indexOf('  const openTechnicalDetails ='),source.indexOf('  const openActivityFile ='));const focused=[];scope.onOpenTechnicalDetails=()=>false;scope.setAgentWorkFocus=id=>focused.push(id);vm.runInNewContext(ts.transpileModule(technical.replace('const openTechnicalDetails =','globalThis.openTechnicalDetails='),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,scope);scope.openTechnicalDetails('focus');assert.equal(focused.length,0);assert.equal(changes.length,2);
});

test('BR011 shared Chat settings closes only after its scoped draft guard accepts, including instructions-save success',async()=>{
 const fs=await import('node:fs/promises'),vm=await import('node:vm'),ts=await import('typescript'),source=await fs.readFile(new URL('../../apps/web/src/components/ChatContextSettings.tsx',import.meta.url),'utf8'),close=source.split('\n').find(line=>line.trim().startsWith('const close=')),save=source.slice(source.indexOf('  const save ='),source.indexOf('  return <Dialog'));const closed=[],scope={extension:{confirmClose:()=>false},onClose:()=>closed.push(true),chat:{id:'c'},instructions:'text',queryKeys:{conversations:{detailPrefix:()=>['c']}},client:{invalidateQueries:async()=>{}},useMutation:options=>{scope.options=options}};
 vm.runInNewContext(ts.transpileModule(close.replace('const close=','globalThis.close=')+'\n'+save,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,scope);scope.close();await scope.options.onSuccess();assert.equal(closed.length,0);scope.extension={};scope.close();assert.equal(closed.length,1);
});

test('BR011 scoped workspace adapter returns the shared navigation decision and replacement semantics',async()=>{
 const fs=await import('node:fs/promises'),vm=await import('node:vm'),ts=await import('typescript'),source=await fs.readFile(new URL('../../apps/web/src/components/branches/BranchChats.tsx',import.meta.url),'utf8'),handler=source.slice(source.indexOf(' const navigate='),source.indexOf(' return <Stack'));const calls=[],scope={chat:{id:'c',projectId:'p'},executionId:undefined,setRoute:(...args)=>{calls.push(args);return false},route:undefined,setChatId:()=>false,setError(){}};
 vm.runInNewContext(ts.transpileModule(handler.replace('const navigate=','globalThis.navigate='),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,scope);assert.equal(scope.navigate({kind:'agent',projectId:'p',agentId:'a',view:'settings'},{replace:true}),false);assert.equal(calls[0][1],true);scope.executionId='temporary';assert.equal(scope.navigate({kind:'trigger',projectId:'p',triggerId:'t'}),false);assert.equal(calls.length,1);
});

test('BR011 shared Chat settings exposes scoped capability content without changing ordinary callers',async()=>{
 const {QueryClient,QueryClientProvider}=await import('@tanstack/react-query'),{ThemeProvider,createTheme}=await import('@mui/material/styles'),{ChatContextSettings}=await import('../../apps/web/src/components/ChatContextSettings.tsx'),{ResourceSettingsContext}=await import('../../apps/web/src/components/ResourceSettingsContext.tsx');
 const theme=createTheme({components:{MuiDialog:{defaultProps:{disablePortal:true}}}}),client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
 try{for(const scoped of [false,true]){const value=scoped?{render:(kind,id)=>React.createElement('section',{'aria-label':'Scoped capabilities'},`${kind}:${id}`)}:{};const html=renderToStaticMarkup(React.createElement(QueryClientProvider,{client},React.createElement(ThemeProvider,{theme},React.createElement(ResourceSettingsContext.Provider,{value},React.createElement(ChatContextSettings,{chat:{id:'c',instructions:'kept',workingDirectory:'/managed/kept'},open:true,onClose(){}})))));assert.equal(html.includes('Scoped capabilities'),scoped);assert.ok(html.includes('Instructions')&&html.includes('Working folder')&&html.includes('kept'));}}finally{client.clear()}
});
