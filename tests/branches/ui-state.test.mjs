import test from 'node:test';
import assert from 'node:assert/strict';
import '../shared/web-typescript-loader.mjs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const {BranchWorkspaceHeader}=await import('../../apps/web/src/components/branches/BranchWorkspaceHeader.tsx');

test('Branch header reuses ordered shared icon tabs, names and guarded publication controls',()=>{
 const html=renderToStaticMarkup(React.createElement(BranchWorkspaceHeader,{name:'A long workflow name',tab:'workflow',published:false,dirty:true,saving:false,saveDisabled:true,onTab(){},onSave(){},onExport(){},onUpdate(){}}));
 assert.ok(html.includes('A long workflow name'),'Selected workflow name is present');assert.ok(html.includes('aria-label="Unpublished changes"'),'Dirty indication is accessible');
 assert.ok(/<button[^>]*disabled=""[^>]*aria-label="Save changes…"/.test(html),'Clean/invalid/pending Save remains disabled');
 const names=[...html.matchAll(/role="tab"[^>]*>(.*?)<\/button>/g)].map(match=>match[1].replace(/<style[^>]*>[\s\S]*?<\/style>/g,'').replace(/<[^>]*>/g,''));
 assert.deepEqual(names,['Workflow','Chats','Executions','Settings']);
 for(const tab of ['workflow','chats','executions','settings'])assert.ok(new RegExp(`id="branch-${tab}-tab"[^>]*aria-controls="branch-${tab}-panel"`).test(html),`Tab/panel association for ${tab}`);
 for(const tab of ['executions'])assert.ok(new RegExp(`disabled=""[^>]*id="branch-${tab}-tab"|id="branch-${tab}-tab"[^>]*disabled=""`).test(html),`Unpublished ${tab} remains disabled`);
 assert.ok(!/Ponderosa Branches|Build and operate|No changes to publish/.test(html),'No displaced product banner or duplicate actions');
});

test('selected nested Chat retains the owning Branch identity and guarded actions',()=>{
 const html=renderToStaticMarkup(React.createElement(BranchWorkspaceHeader,{name:'Owning workflow',tab:'chats',published:true,dirty:false,saving:false,saveDisabled:false,onTab(){},onSave(){},onExport(){},onUpdate(){}}));
 assert.ok(html.includes('aria-label="Branch views"'),'Branch navigation remains reachable');assert.ok(/aria-selected="true"[^>]*>.*ChatBubbleOutline/.test(html),'Chats is the selected shared icon tab');
 for(const label of ['Owning workflow','Save changes…','Branch actions'])assert.ok(html.includes(label),'Branch owner remains visible beside its nested Chat');
 assert.equal((html.match(/role="tablist"/g)??[]).length,1,'One Branch navigation owner');
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

test('explicit Workflow navigation survives reload with a retained execution selection',()=>{
 const route={branchId:'b',tab:'workflow',executionId:'e'};
 const path=branchRoutePath(route);assert.ok(path.includes('tab=workflow'));
 assert.deepEqual(parseBranchRoute(new URL(path,'https://example.test').search),route);
 assert.equal(parseBranchRoute('?branch=b&execution=e').tab,'executions','Existing execution-only deep links retain their default');
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
 const render=(extra={})=>renderToStaticMarkup(React.createElement(QueryClientProvider,{client},React.createElement(BranchSettings,{branch,definition,...extra})));
 const html=render(),labels=['Branch capabilities','Dependencies','Delete workflow'];
 assert.ok(labels.every(label=>html.includes(label)),'All workflow Settings sections must render while configuration is unavailable');
 assert.ok(labels.every((label,index)=>!index||html.indexOf(label)>html.indexOf(labels[index-1])),'Settings section order must remain capabilities, dependencies, delete');
 assert.ok(!html.includes('Workflow settings sections')&&!html.includes('Loading configuration'),'No nested navigation or unrelated configuration gate');
 assert.ok(client.getQueryCache().find({queryKey:['branch-settings',branch.id]}),'The sole configuration editor stays mounted without blocking other Settings sections');
 client.setQueryData(['branch-lifecycle-summary',branch.id],{deleting:false,activeExecutions:0,chats:0,callers:[{id:'billing-workflow',name:'Billing workflow'}],updates:[],pendingRemoval:[]});
 const named=render();assert.ok(named.includes('Billing workflow')&&!named.includes('reports-alias'),'Called by must show the calling workflow name, never its alias for this target');
 const lifecycle=client.getQueryCache().find({queryKey:['branch-lifecycle-summary',branch.id]});lifecycle.setState({status:'error',error:new Error('Controlled lifecycle failure'),fetchStatus:'idle'});
 const failed=render();assert.ok(failed.includes('Deletion is unavailable'),'Unknown lifecycle must not allow deletion');
 assert.ok(/<button[^>]*disabled=""[^>]*>Delete workflow/.test(failed),'Deletion remains disabled after failed lifecycle loading');
 assert.ok(render({definition:{parameters:{note:{type:'text'}}}}).includes('Loading configuration'),'Published variables retain their independent configuration load');
 assert.ok(!html.includes('Workflow variables')&&!html.includes('Save variables'),'Zero variables creates no empty form or Save action');
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
 for(const from of ['workflow','chats','executions','settings'])for(const to of ['workflow','chats','executions','settings']){
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

// Exercise the real BranchChats props/closures while controlling only hook scheduling and transport.
async function chatDropdownFixture(){
 const fs=await import('node:fs/promises'),vm=await import('node:vm'),ts=await import('typescript'),source=await fs.readFile(new URL('../../apps/web/src/components/branches/BranchChats.tsx',import.meta.url),'utf8');
 const cells=[],queries=[],requests=[],navigations=[];let cursor=0;
 const state=initial=>{const i=cursor++;cells[i]??={value:typeof initial==='function'?initial():initial};return[cells[i].value,next=>{cells[i].value=typeof next==='function'?next(cells[i].value):next}];};
 const react={...React,useState:state,useRef:initial=>state(()=>({current:initial}))[0],useEffect(){},useLayoutEffect(){}},mui=new Proxy({},{get:(_o,key)=>String(key)});
 const selected={id:'selected-outside-page',title:'Selected Chat',branchId:'owner',projectId:'p'},rows=[{...selected,id:'one',title:'Duplicate'},{...selected,id:'two',title:'Duplicate'},{...selected,id:'three',title:'Unique'}];
 const page={data:{pages:[{items:rows}]},isSuccess:true,hasNextPage:true,fetchNextPage:()=>requests.push('next'),refetch:()=>requests.push('retry')},search={...page,data:{pages:[{items:[]}]}};
 const queryClient={invalidateQueries:async()=>{}},exports={},imports={
  react,'react/jsx-runtime':await import('react/jsx-runtime'),'@mui/material':mui,
  '@tanstack/react-query':{useQueryClient:()=>queryClient,useQuery:options=>options.queryKey[0]==='branch-chat-owner'?{data:selected}:{},useInfiniteQuery:options=>{queries.push(options);return options.queryKey.includes('search')?search:page}},
  '../../hooks/queries':{useWorkspacePreferences:()=>({}),useWorkspacePreferencesWriter:()=>({})},'./BranchNavigation':{useBranchNavigationGuard:()=>()=>true,useBranchDraftGuard(){}},
  '../chatCreationAttempts':{readCreationAttempts:()=>[],sameCreationOwner:()=>false},'../../clientId':{createClientId:()=> 'intent'},'../../collections':await import('../../apps/web/src/collections.ts'),
  '../../api/types':{ApiRequestError},'../../api/real':{requestCollectionPage:path=>requests.push(path)},'../../workspaceRecency':{markWorkspaceResourceUsed:async()=>{}}
 };
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,{exports,require:name=>imports[name]??new Proxy({},{get:(_o,key)=>key==='__esModule'?true:String(key)})});
 const props={branchId:'owner',branchRoute:{branchId:'owner',tab:'chats',chatId:selected.id},engines:[],onNavigate:next=>{navigations.push(next);return true}},walk=node=>Array.isArray(node)?node.flatMap(walk):React.isValidElement(node)?[node,...walk(node.props.children),...walk(node.props.action)]:[];
 let nodes;const render=()=>{cursor=0;queries.length=0;nodes=walk(exports.BranchChats(props));};render();
 const control=()=>nodes.find(n=>n.type==='Autocomplete').props;
 return{page,search,selected,rows,props,queries,requests,navigations,render,control,button:label=>nodes.find(n=>n.type==='Button'&&n.props.children===label).props};
}

test('Chat dropdown retains an unloaded selected owner, uses server search and disambiguates only duplicate names',async()=>{
 const f=await chatDropdownFixture(),a=f.control();assert.equal(a.value.id,f.selected.id);assert.equal(a.inputValue,'Selected Chat');assert.equal(a.options.some(c=>c.id===f.selected.id),false);
 assert.equal(a.filterOptions(f.rows),f.rows,'Server result ordering/filtering is authoritative');assert.equal(a.getOptionKey(f.rows[0]),'one');assert.equal(a.isOptionEqualToValue(f.rows[0],{...f.rows[0]}),true);
 const html=c=>renderToStaticMarkup(a.renderOption({key:c.id},c));assert.match(html(f.rows[0]),/one/);assert.doesNotMatch(html(f.rows[2]),/three/);
 a.onOpen();f.render();assert.equal(f.control().inputValue,'');f.control().onInputChange({},'beyond page','input');f.render();const q=f.queries.find(q=>q.queryKey.includes('search'));assert.equal(q.enabled,true);await q.queryFn({pageParam:'exact cursor'});assert.match(f.requests.at(-1),/search=beyond%20page/);assert.match(f.requests.at(-1),/cursor=exact%20cursor/);
 f.control().onInputChange({},'Selected Chat','reset');f.render();assert.equal(f.control().inputValue,'beyond page','MUI reset must not replace the server search');f.control().onClose({},'escape');f.render();assert.equal(f.control().inputValue,'Selected Chat');f.control().onInputChange({},'A','input');f.control().onOpen();f.render();assert.equal(f.control().inputValue,'A','MUI input-before-open must preserve the first character');f.control().onClose({},'selectOption');f.render();assert.equal(f.control().open,false,'Selecting the exact current value closes even without onChange');
});

test('Chat dropdown preserves guarded selection, pagination, loading/error feedback and one-click creation',async()=>{
 const f=await chatDropdownFixture();f.control().onOpen();f.render();f.props.onNavigate=()=>false;f.render();const event={};f.control().onChange(event,f.rows[0]);f.control().onClose(event,'selectOption');f.render();assert.equal(f.control().open,true,'Declined navigation keeps the chooser open');
 f.props.onNavigate=next=>{f.navigations.push(next);return true};f.render();f.control().onChange({},f.rows[1]);f.render();assert.equal(f.control().open,false);assert.equal(f.navigations.at(-1).chatId,'two');assert.equal(f.navigations.at(-1).workspace.projectId,'p');
 f.control().slotProps.listbox.onScroll({currentTarget:{scrollHeight:200,scrollTop:90,clientHeight:100}});f.control().onHighlightChange({},f.rows.at(-1),'keyboard');assert.deepEqual(f.requests,['next','next']);f.page.isFetching=true;f.render();f.control().onHighlightChange({},f.rows.at(-1),'keyboard');assert.equal(f.requests.length,2);
 f.page.isFetching=false;f.page.error=Error('Offline');f.render();assert.equal(f.control().noOptionsText,'Chats could not be loaded.');f.control().onOpen();f.render();f.control().onInputChange({},'failed search','input');f.search.error=Error('Search unavailable');f.render();f.control().onClose({},'blur');f.render();assert.equal(f.control().open,false);assert.ok(f.button('Retry search'),'Retry remains mounted outside the popup after keyboard blur');f.button('Retry search').onClick();assert.equal(f.requests.at(-1),'retry');f.requests.pop();f.control().onHighlightChange({},f.rows.at(-1),'keyboard');assert.equal(f.requests.length,2,'Failed paging waits for explicit retry');
 f.button('New Chat').onClick();f.button('New Chat').onClick();assert.equal(f.navigations.at(-1).creationKey,'intent');assert.equal(f.navigations.filter(n=>n.creationKey).length,1);
});

test('BR010 picker uses current owner/execution and keeps the chooser open when navigation is refused',async()=>{
 const fs=await import('node:fs/promises'),vm=await import('node:vm'),ts=await import('typescript'),source=await fs.readFile(new URL('../../apps/web/src/components/branches/BranchChats.tsx',import.meta.url),'utf8'),handler=source.split('\n').find(line=>line.trim().startsWith('const chooseChat='));assert.ok(handler);
 const route={branchId:'owner',tab:'chats'},writes=[],closes=[],scope={branchId:'owner',executionId:undefined,currentRoute:{current:route},openChat:(...args)=>{writes.push(args);return false},setPicker:value=>closes.push(value),setSearch(){}};vm.runInNewContext(ts.transpileModule(handler.replace('const chooseChat=','globalThis.chooseChat='),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,scope);
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
 const scope={completedNavigation:undefined,agentCreatePending:false,setCompletedNavigation:value=>{scope.completedNavigation=value},useEffect:fn=>frames.push(fn),active:{current:true},currentAgentCreate:{current:intent},agentCreate:intent,currentRoute:{current:route},branchId:'owner',chat:{id:'c',projectId:'p'},client:{invalidateQueries:async value=>invalidated.push(value.queryKey)},setAgentCreate:value=>closes.push(value),setAgentCreatePending:value=>pending.push(value),setCapabilityDirty:value=>dirty.push(value),setError:value=>errors.push(value),onNavigate:next=>{navigations.push(next);return true},requestAnimationFrame:fn=>frames.push(fn)};
 const lines=source.split('\n').filter(line=>['const closeAgentCreate=','const agentCreated=','const resourceDeleted='].some(prefix=>line.trim().startsWith(prefix))).map(line=>line.replace(/const (closeAgentCreate|agentCreated|resourceDeleted)=/,'globalThis.$1='));assert.equal(lines.length,3);
 vm.runInNewContext(ts.transpileModule(lines.join('\n'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,scope);const effect=source.split('\n').find(line=>line.trim().startsWith('useEffect(()=>{if(!completedNavigation)'));assert.ok(effect);const commit=()=>{scope.agentCreate=scope.currentAgentCreate.current;vm.runInNewContext(ts.transpileModule('(()=>{const completedNavigation=globalThis.completedNavigation;'+effect+'})()',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,scope);frames.shift()()};return {scope,frames,navigations,closes,pending,dirty,errors,invalidated,intent,route,commit};
}

test('BR011 created Agents clear pending before guarded navigation and old import/cancel cannot close a new modal',async()=>{
 const f=await br011OwnerFixture();f.scope.agentCreated('p','new');assert.deepEqual(f.pending,[false]);assert.deepEqual(f.closes,[undefined]);assert.equal(f.navigations.length,0,'Completion waits for the pending guard to unregister');f.scope.currentAgentCreate.current=undefined;f.commit();assert.equal(f.navigations[0].workspace.agentId,'new');f.commit();assert.equal(f.navigations.length,1,'Committed completion is consumed once');
 for(const stale of ['unmounted','reopened']){const old=await br011OwnerFixture();if(stale==='unmounted')old.scope.active.current=false;else old.scope.currentAgentCreate.current={...old.intent};assert.equal(old.scope.closeAgentCreate(),false);old.scope.agentCreated('p','late');assert.equal(old.closes.length,0);assert.equal(old.pending.length,0);assert.equal(old.scope.completedNavigation,undefined);}
});

test('BR011 late create completion cannot overwrite another route or a new dialog, and declined navigation stays truthful',async()=>{
 for(const change of ['route','dialog']){const f=await br011OwnerFixture();f.scope.agentCreated('p','new');f.scope.currentAgentCreate.current=undefined;if(change==='route')f.scope.currentRoute.current={...f.route,branchId:'other'};else f.scope.currentAgentCreate.current={...f.intent};f.commit();assert.equal(f.navigations.length,0);assert.equal(f.scope.completedNavigation,undefined);}
 const f=await br011OwnerFixture();f.scope.onNavigate=()=>false;f.scope.agentCreated('p','new');f.scope.currentAgentCreate.current=undefined;f.commit();assert.match(f.errors[0],/Agent was created/);
});

test('BR011 canonical deletion retires only the removed current view and preserves unrelated navigation/drafts',async()=>{
 const f=await br011OwnerFixture();f.scope.resourceDeleted({kind:'agent',projectId:'p',agentId:'other'});assert.equal(f.scope.completedNavigation,undefined);assert.equal(f.dirty.length,0);
 f.scope.resourceDeleted({kind:'agent',projectId:'p',agentId:'a'});assert.deepEqual(f.dirty,[false]);assert.equal(f.navigations.length,0);f.scope.currentAgentCreate.current=undefined;f.commit();assert.equal(f.navigations[0].workspace.conversationId,'c');
 for(const changed of ['unmounted','route','project']){const old=await br011OwnerFixture();if(changed==='unmounted')old.scope.active.current=false;if(changed==='project')old.scope.chat={id:'c',projectId:'new-project'};old.scope.resourceDeleted({kind:'conversation',projectId:'p',conversationId:'c'});if(changed==='route')old.scope.currentRoute.current={...old.route,branchId:'other'};old.scope.currentAgentCreate.current=undefined;old.commit();assert.equal(old.navigations.length,0);}
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
 const fs=await import('node:fs/promises'),vm=await import('node:vm'),ts=await import('typescript'),source=await fs.readFile(new URL('../../apps/web/src/components/branches/BranchChats.tsx',import.meta.url),'utf8'),handler=source.slice(source.indexOf(' const navigate='),source.indexOf(' const pickerPaperProps:'));const calls=[],scope={chat:{id:'c',projectId:'p'},executionId:undefined,setRoute:(...args)=>{calls.push(args);return false},route:undefined,setChatId:()=>false,setError(){}};
 vm.runInNewContext(ts.transpileModule(handler.replace('const navigate=','globalThis.navigate='),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,scope);assert.equal(scope.navigate({kind:'agent',projectId:'p',agentId:'a',view:'settings'},{replace:true}),false);assert.equal(calls[0][1],true);scope.executionId='temporary';assert.equal(scope.navigate({kind:'trigger',projectId:'p',triggerId:'t'}),false);assert.equal(calls.length,1);
});

test('BR011 shared Chat settings exposes scoped capability content without changing ordinary callers',async()=>{
 const {QueryClient,QueryClientProvider}=await import('@tanstack/react-query'),{ThemeProvider,createTheme}=await import('@mui/material/styles'),{ChatContextSettings}=await import('../../apps/web/src/components/ChatContextSettings.tsx'),{ResourceSettingsContext}=await import('../../apps/web/src/components/ResourceSettingsContext.tsx');
 const theme=createTheme({components:{MuiDialog:{defaultProps:{disablePortal:true}}}}),client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
 try{for(const scoped of [false,true]){const value=scoped?{render:(kind,id)=>React.createElement('section',{'aria-label':'Scoped capabilities'},`${kind}:${id}`)}:{};const html=renderToStaticMarkup(React.createElement(QueryClientProvider,{client},React.createElement(ThemeProvider,{theme},React.createElement(ResourceSettingsContext.Provider,{value},React.createElement(ChatContextSettings,{chat:{id:'c',instructions:'kept',workingDirectory:'/managed/kept'},open:true,onClose(){}})))));assert.equal(html.includes('Scoped capabilities'),scoped);assert.ok(html.includes('Instructions')&&html.includes('Working folder')&&html.includes('kept'));}}finally{client.clear()}
});


test('BR011 a loading or unavailable deep-linked Agent cannot be replaced by automatic single-Chat selection',async()=>{
 const fs=await import('node:fs/promises'),vm=await import('node:vm'),ts=await import('typescript'),source=await fs.readFile(new URL('../../apps/web/src/components/branches/BranchChats.tsx',import.meta.url),'utf8'),effect=source.split('\n').find(line=>line.includes("chats.data?.length===1"));assert.ok(effect);
 const opened=[],scope={branchRoute:{},routeAgentId:'a',chatId:'',chats:{data:[{id:'c',projectId:'p'}]},openChat:(...args)=>opened.push(args),useEffect:fn=>fn()};
 const run=()=>vm.runInNewContext(ts.transpileModule(effect,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,scope);run();assert.equal(opened.length,0,'Pending/failed Agent ownership keeps the requested Agent route');scope.chatId='c';run();assert.equal(opened.length,0,'Resolved Agent owner stays selected');scope.chatId='';scope.routeAgentId=undefined;run();assert.equal(opened.length,1,'An unselected ordinary Branch Chat still autoselects');scope.branchRoute={creationKey:'draft'};run();assert.equal(opened.length,1,'New Chat intent remains intact');
});

test('shared permissions expose Included tools, friendly effective states and immediate saves in ordinary resource Settings',async()=>{
 const {QueryClient,QueryClientProvider}=await import('@tanstack/react-query'),{CapabilityPolicyEditor}=await import('../../apps/web/src/components/CapabilityPolicyEditor.tsx'),{ResourceSettingsContext}=await import('../../apps/web/src/components/ResourceSettingsContext.tsx');
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}}),policy={scopeKind:'chat',scopeId:'normal',revision:2,restrictedCapabilityIds:['local','connector:codex:missing']},catalog=[
  {id:'allowed',label:'Import files',description:'Copy a file',categoryLabel:'Files',available:true,includedTools:[{name:'ponderosa_import_file',description:'Import an authorized file'}]},
  {id:'local',label:'Read pages',description:'Inspect pages',categoryLabel:'Browser',available:true},
  {id:'ancestor',label:'Interact with pages',description:'Control pages',categoryLabel:'Browser',available:true},
  {id:'unavailable',label:'Read memory',description:'Read granted memory',categoryLabel:'Memory',available:false,unavailableReason:'Local Memory is not configured',includedTools:[]},
 ];
 const endpoint='/api/conversations/normal/capabilities';client.setQueryData(['capability-policy',endpoint],{policy,effective:{restrictionSources:{ancestor:{scopeKind:'product',scopeId:'interactive',label:'Ponderosa defaults'}}},catalog});
 try{const html=renderToStaticMarkup(React.createElement(QueryClientProvider,{client},React.createElement(CapabilityPolicyEditor,{endpoint,scopeKind:'chat',immediateSave:true})));assert.ok(html.includes('<summary>Included tools')&&html.includes('ponderosa_import_file')&&html.includes('Import an authorized file'));for(const text of ['Allowed','Restricted here','Restricted by Ponderosa defaults','Unavailable','Local Memory is not configured','next Run','Activity'])assert.ok(html.includes(text),text);assert.equal(html.includes('Save capabilities'),false);assert.ok(html.includes('Allow Import files'));
  const Probe=()=>React.useContext(ResourceSettingsContext).render('chat','normal');const ordinary=renderToStaticMarkup(React.createElement(QueryClientProvider,{client},React.createElement(Probe)));assert.ok(ordinary.includes('Tool permissions')&&ordinary.includes('ponderosa_import_file'));assert.equal(ordinary.includes('Save capabilities'),false);
 }finally{client.clear()}
});


test('ordinary Agent navigation preserves a canceled permission draft through the real route and App callbacks',async()=>{
 const fs=await import('node:fs/promises'),vm=await import('node:vm'),ts=await import('typescript');
 const routing=await fs.readFile(new URL('../../apps/web/src/routing.ts',import.meta.url),'utf8'),app=await fs.readFile(new URL('../../apps/web/src/App.tsx',import.meta.url),'utf8'),agent=await fs.readFile(new URL('../../apps/web/src/components/AgentDetail.tsx',import.meta.url),'utf8');
 const routeHandler=routing.slice(routing.indexOf('  const navigate = useCallback('),routing.indexOf('  return { route, navigate };'));
 const workspaceHandler=app.slice(app.indexOf('  const navigateWorkspace ='),app.indexOf('  useEffect(() => {',app.indexOf('  const navigateWorkspace =')));
 const tabHandler=agent.split('\n').find(line=>line.trim().startsWith('const changeTab='));
 const changes=[],history=[],uses=[],speech=[],route={kind:'agent',projectId:'p',agentId:'a',view:'settings'},scope={route,currentRoute:{current:route},acceptedLocation:{current:'/settings'},window:{location:{pathname:'/settings',search:''},history:{replaceState:(_s,_t,p)=>history.push(['replace',p]),pushState:(_s,_t,p)=>history.push(['push',p])}},useCallback:fn=>fn,routeToPath:r=>r.view==='settings'?'/settings':'/chat',navigationPreservesSettings:()=>false,confirmUnsavedNavigation:()=>false,setRoute:r=>changes.push(r),stopSpeech:()=>speech.push(true),recordWorkspaceRouteUse:r=>uses.push(r),setTab:v=>changes.push(v)};
 const run=code=>vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,scope);
 run(routeHandler.replace('const navigate =','globalThis.navigate =')+workspaceHandler.replace('const navigateWorkspace =','globalThis.navigateWorkspace ='));
 scope.onViewChange=view=>scope.navigateWorkspace({...route,view},{replace:true});run(tabHandler.replace('const changeTab=','globalThis.changeTab='));scope.changeTab('chat');
 assert.equal(changes.length,0);assert.equal(history.length,0);assert.equal(uses.length,0);assert.equal(speech.length,0);
 scope.confirmUnsavedNavigation=()=>true;scope.changeTab('chat');assert.equal(changes.at(-1),'chat');assert.deepEqual(history,[['replace','/chat']]);assert.equal(uses.length,1);assert.equal(speech.length,1);
 assert.equal(scope.navigate({...route}),true,'Same-location navigation reports acceptance');
});

test('Main permission saves protect subsection and history navigation while retained ordinary Settings drafts stay mounted',async()=>{
 const {navigationPreservesSettings}=await import('../../apps/web/src/routing.ts'),{setReloadBlocker}=await import('../../apps/web/src/reloadSafety.ts');
 const general={kind:'settings',section:'general'},providers={kind:'settings',section:'providers'},blocker='tool-permissions:/api/workspace/capabilities';
 try{assert.equal(navigationPreservesSettings(general,providers),true);setReloadBlocker(blocker,true);assert.equal(navigationPreservesSettings(general,providers),false);assert.equal(navigationPreservesSettings(providers,general),false);assert.equal(navigationPreservesSettings(general,{kind:'home'}),false);}finally{setReloadBlocker(blocker,false)}
 assert.equal(navigationPreservesSettings(general,providers),true);
});


test('workflow Rename uses the clicked owner, preserves canceled navigation and fences late dialogs',async()=>{
 const fs=await import('node:fs/promises'),vm=await import('node:vm'),ts=await import('typescript'),source=await fs.readFile(new URL('../../apps/web/src/components/BranchesView.tsx',import.meta.url),'utf8');
 const handlers=['requestRename','applyRename'].map(name=>source.split('\n').find(line=>line.trim().startsWith(`const ${name}=`))).join('\n');
 const draft={branchId:'a',definition:{name:'Original',steps:[{id:'retained'}]},bindings:{retained:true}},opened=[],scope={loading:false,openingLink:false,creating:false,review:{isPending:false},deploy:{isPending:false},draft,route:{branchId:'a'},routeOwner:{current:{branchId:'a'}},selection:{current:1},editorGeneration:1,renameId:'a',navigate:()=>false,setRenameId:id=>opened.push(id),setDraft:update=>{scope.draft=update(scope.draft)}};
 vm.runInNewContext(ts.transpile(handlers+';this.requestRename=requestRename;this.applyRename=applyRename;',{target:ts.ScriptTarget.ES2022}),scope);
 scope.requestRename({id:'b'});assert.deepEqual(opened,[],'Canceled navigation never opens the wrong owner');
 scope.navigate=route=>{assert.equal(route.branchId,'b');return true};scope.requestRename({id:'b'});assert.deepEqual(opened,['b']);
 scope.requestRename({id:'a'});assert.equal(opened.at(-1),'a');
 scope.applyRename('  Updated  ');assert.equal(scope.draft.definition.name,'Updated');assert.equal(scope.draft.definition.steps,draft.definition.steps);assert.equal(scope.draft.bindings,draft.bindings);assert.equal(opened.at(-1),undefined);
 for(const change of [()=>scope.selection.current++,()=>scope.routeOwner.current={branchId:'b'},()=>scope.routeOwner.current={branchId:'a',global:'general'},()=>scope.deploy.isPending=true]){
  scope.selection.current=1;scope.routeOwner.current={branchId:'a'};scope.deploy.isPending=false;change();scope.applyRename('Stale');assert.equal(scope.draft.definition.name,'Updated');
 }
});


test('an external publication cannot unmount and erase an open workflow Rename draft',async()=>{
 const fs=await import('node:fs/promises'),vm=await import('node:vm'),ts=await import('typescript'),source=await fs.readFile(new URL('../../apps/web/src/components/BranchesView.tsx',import.meta.url),'utf8');
 const effect=source.split('\n').find(line=>line.includes('current.versionId===draft.expectedVersionId'));
 const refreshed=[],updates=[],scope={current:{id:'a',versionId:'new'},draft:{branchId:'a',expectedVersionId:'old'},renameId:'a',dirty:false,deployedUpdate:undefined,draftRevision:{current:'baseline'},useEffect:fn=>fn(),setDeployedUpdate:value=>updates.push(value),select:(...args)=>refreshed.push(args)};
 const run=()=>vm.runInNewContext(ts.transpile(effect,{target:ts.ScriptTarget.ES2022}),scope);
 run();assert.equal(refreshed.length,0,'Dialog remains mounted with its local input');assert.equal(updates.length,0);
 scope.renameId=undefined;run();assert.equal(refreshed.length,1,'Cancel allows canonical refresh');
 scope.dirty=true;run();assert.equal(refreshed.length,1,'Apply preserves the edited definition');assert.equal(updates.at(-1).reason,'dirty');
});

test('Branch execution status distinguishes confirmed zero, active, unresolved and failed cached counts',()=>{
 const props={name:'Workflow status owner',tab:'workflow',published:true,dirty:true,saving:false,saveDisabled:false,onTab(){},onSave(){},onExport(){},onUpdate(){},onRename(){}};
 const render=extra=>renderToStaticMarkup(React.createElement(BranchWorkspaceHeader,{...props,...extra}));
 for(const [extra,label] of [[{executionCount:0},'0 active executions'],[{executionCount:4},'4 active executions'],[{},'Executions loading…'],[{executionCount:4,executionsUnavailable:true},'Executions unavailable']]){
  const html=render(extra);assert.ok(html.includes(`aria-label="${label}"`));assert.ok(html.includes('aria-label="Unpublished changes"'),'Execution state and unpublished draft remain independently visible');
  if(extra.executionsUnavailable)assert.ok(!html.includes('4 active executions'),'A failed query overrides its cached count');
 }
 const nested=renderToStaticMarkup(React.createElement(BranchWorkspaceHeader,{...props,tab:'chats',executionCount:4}));
 assert.ok(nested.includes('4 active executions'),'The retained outer Branch header keeps its own execution status in Chats');
});


test('workflow directory status keeps availability, trigger intake and active work independent',async()=>{
 const {BranchDirectoryStatus}=await import('../../apps/web/src/components/branches/BranchDirectoryStatus.tsx');
 const branch={id:'stable-id',name:'Full workflow name',versionId:'published',enabled:true,activeExecutions:0};
 const render=(patch={},delayed=false)=>renderToStaticMarkup(React.createElement(BranchDirectoryStatus,{branch:{...branch,...patch},delayed}));
 const enabled=render();assert.ok(enabled.includes('aria-label="Enabled · Manual · No active executions"'));assert.ok(enabled.includes('data-branch-availability="enabled"'));
 const paused=render({enabled:false,triggerId:'trigger',triggerEnabled:true,activeExecutions:3});assert.ok(paused.includes('aria-label="Paused · Automatic intake paused · 3 active executions"'));assert.ok(paused.includes('data-branch-availability="paused"'));assert.ok(paused.includes('M3 2.5v3 M5 2.5v3'),'Pause is identified by shape as well as color');assert.ok(paused.includes('Automatic'));
 assert.ok(render({triggerId:'trigger',triggerEnabled:true}).includes('Enabled · Automatic intake on · No active executions'));
 assert.ok(render({triggerId:'trigger',triggerEnabled:false}).includes('Automatic intake paused'));
 const unknown=render({enabled:undefined,activeExecutions:undefined,triggerId:'trigger',triggerEnabled:true},true);assert.ok(unknown.includes('Availability unknown · Automatic intake unknown · Active executions unknown · Updates delayed'));assert.ok(!unknown.includes('No active executions'));
 assert.ok(render({versionId:''}).includes('Unpublished — cannot run'));assert.ok(!render({versionId:''}).includes('aria-label="Enabled'));
 for(const activeExecutions of [-1,NaN,Infinity])assert.ok(render({activeExecutions}).includes('Active executions unknown'));
 const busy=render({activeExecutions:200});assert.ok(busy.includes('200 active executions'));assert.ok(busy.includes('99+'));assert.ok(!busy.includes('stable-id'),'Tooltip does not expose raw identifiers');
});


test('graph labels keep their full text above all connectors with a theme halo',async()=>{
 const {BranchGraph}=await import('../../apps/web/src/components/branches/BranchGraph.tsx');
 const long='A custom route '+ '界'.repeat(80);
 const definition={name:'Labels',entry:'route',steps:[{id:'a',kind:'script',label:'First'},{id:'b',kind:'script',label:'Last'}],controls:[{id:'route',kind:'route',label:'Choose',otherwise:'b'}],edges:[{id:'one',from:'route',to:'a',on:'selected',choice:long},{id:'two',from:'a',to:'b',on:'success'},{id:'otherwise',from:'route',to:'b',on:'failure'},{id:'loop',from:'b',to:'route',on:'failure',loop:true},{id:'self',from:'a',to:'a',on:'failure',loop:true}]};
 const html=renderToStaticMarkup(React.createElement(BranchGraph,{definition,onSelect(){}}));
 const svg=html.slice(html.indexOf('<svg'),html.indexOf('</svg>'));
 assert.ok(svg.includes(long),'Full custom choice is retained');
 assert.ok(svg.lastIndexOf('<path')<svg.indexOf('<text'),'No connector can overpaint a label');
 assert.equal((svg.match(/paint-order="stroke"/g)??[]).length,5);
 assert.equal((svg.match(/stroke-width="8"/g)??[]).length,5);
 assert.equal((svg.match(/d="M[^"]+ V[^"]+ H[^"]+ V[^"]+ V[^"]+ H[^"]+ V/g)??[]).length,2,'Explicit self and back loops use visible side gutters');
 assert.ok(html.indexOf('</svg>')<html.indexOf('aria-label="Select First"'),'Cards remain above the connector/label layer');
 assert.ok(html.includes('Workflow text description')&&html.includes('aria-pressed="false"'),'Accessible description and node controls remain');
});

test('native-sized graph labels clear cards and neighboring labels without truncation',async()=>{
 const {placeGraphLabels}=await import('../../apps/web/src/components/branches/BranchGraph.tsx');
 const nodes=[{x:142,y:30},{x:30,y:172},{x:254,y:172},{x:142,y:314}];
 const labels=[{id:'left',x:170,y:136,width:50,height:20},{id:'right',x:180,y:136,width:1008,height:20},{id:'loop',x:200,y:200,width:108,height:20},{id:'converging',x:200,y:278,width:88,height:20},{id:'crossing',x:200,y:278,width:88,height:20}];
 const placed=placeGraphLabels(labels,nodes,[143.5,285.5,427.5]);
 const overlaps=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
 assert.deepEqual(placed.map(x=>[x.id,x.width,x.height]),labels.map(x=>[x.id,x.width,x.height]),'No text is shrunk or clipped');
 for(let i=0;i<placed.length;i++){
  assert.ok(!nodes.some(p=>overlaps(placed[i],{x:p.x-8,y:p.y-8,width:220,height:101})),'Label clears cards and arrowheads');
  assert.ok(!placed.slice(0,i).some(other=>overlaps(placed[i],other)),'Labels do not overlap');
 }
});


test('moving a graph label around another label rechecks node clearance',async()=>{
 const {placeGraphLabels}=await import('../../apps/web/src/components/branches/BranchGraph.tsx');
 const placed=placeGraphLabels([{id:'a',x:8,y:120,width:150,height:20},{id:'b',x:100,y:120,width:80,height:20}],[{x:200,y:100}],[250]);
 const overlapsCard=p=>p.x<412&&p.x+p.width>192&&p.y<193&&p.y+p.height>92;
 assert.ok(placed.every(p=>p.x>=8&&!overlapsCard(p)),'Labels stay within the scrolling canvas and clear nodes after horizontal shifts');
});


test('tall native graph ink gets a clear canvas fallback instead of reusing overlap',async()=>{
 const {placeGraphLabels}=await import('../../apps/web/src/components/branches/BranchGraph.tsx');
 const placed=placeGraphLabels([{id:'tall',x:90,y:60,width:80,height:100}],[{x:20,y:30}],[143.5]);
 assert.equal(placed[0].height,100);assert.ok(placed[0].y>=30-8+101+8,'Full tall ink is below the card and remains inside the growing canvas');
});


test('graph label wrapping retains complete words and graphemes in native-width rows',async()=>{
 const {wrapGraphLabel}=await import('../../apps/web/src/components/branches/BranchGraph.tsx');
 const measure=value=>Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(value)).length*10;
 for(const text of ['W'.repeat(100),'界'.repeat(100),'A long custom choice with words that must remain readable across narrow graph views','👨‍👩‍👧‍👦'.repeat(6)+' é'.repeat(10)]){
  const lines=wrapGraphLabel(text,measure);assert.equal(lines.join(''),text,'No authored label text is dropped');
  assert.ok(lines.every(line=>measure(line)<=160),'Every line fits its native-width limit');
  assert.ok(!lines.some(line=>line.startsWith('\u200d')||line.startsWith('\u0301')),'Grapheme clusters remain intact');
 }
});


test('loop label gutters stay beyond the final forward labels and node bounds',async()=>{
 const {placeGraphLabels,wrapGraphLabel}=await import('../../apps/web/src/components/branches/BranchGraph.tsx');
 const labels=[{id:'a',x:38,y:127,width:168,height:90},{id:'b',x:38,y:127,width:168,height:90},{id:'otherwise',x:94.5,y:162,width:55,height:20},{id:'loop',x:280,y:162,width:41,height:20,loop:true}];
 const placed=placeGraphLabels(labels,[{x:20,y:30},{x:20,y:229}],[172,371]),loop=placed.find(x=>x.id==='loop');
 assert.ok(placed.filter(x=>!x.loop).every(x=>loop.x>=x.x+x.width+16),'Loop path and label share a dedicated clear gutter');
 assert.deepEqual(wrapGraphLabel('',()=>0),[],'An empty authored choice has no stale text');
});


test('over-limit authoring labels stay complete without prefix measurement work',async()=>{
 const {wrapGraphLabel}=await import('../../apps/web/src/components/branches/BranchGraph.tsx');
 for(const text of ['W'.repeat(101),' '.repeat(101),'W'.repeat(100_000)]){let probes=0;assert.deepEqual(wrapGraphLabel(text,()=>{probes++;return 0}),[text]);assert.equal(probes,0);}
 const decomposed='e\u0301'.repeat(100),lines=wrapGraphLabel(decomposed,value=>Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(value)).length*10);
 assert.equal(lines.join(''),decomposed);assert.ok(lines.length>1,'NFC-valid decomposed choices keep their normal editing and wrapping behavior');
});


test('scoped header usage stays with the nested owner across outer remounts and falls back on cleanup',async()=>{
 const fs=await import('node:fs/promises'),vm=await import('node:vm'),ts=await import('typescript'),source=await fs.readFile(new URL('../../apps/web/src/components/PrimaryHeaderActions.tsx',import.meta.url),'utf8');
 const ast=ts.createSourceFile('header.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),provider=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='PrimaryHeaderActionsProvider');
 const declaration=name=>provider.body.statements.flatMap(node=>ts.isVariableStatement(node)?[...node.declarationList.declarations]:[]).find(node=>node.name.getText(ast)===name).initializer.getText(ast);
 const scope={useCallback:fn=>fn,outlets:[],setOutlets:update=>{scope.outlets=update(scope.outlets)}};
 const execute=value=>vm.runInNewContext(ts.transpile(value,{target:ts.ScriptTarget.ES2022}),scope);
 const register=execute(declaration('register')),active=()=>execute(declaration('activeOutlet'));
 const outer={},nested={},laterOuter={},peer={},deep={};
 const removeOuter=register(outer);assert.equal(active(),outer);
 const scopedProvider=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='PrimaryHeaderActionsScope'),scopedDeclaration=scopedProvider.body.statements.flatMap(node=>ts.isVariableStatement(node)?[...node.declarationList.declarations]:[]).find(node=>node.name.getText(ast)==='scopedRegister').initializer.getText(ast);scope.register=register;
 const scopedRegister=execute(scopedDeclaration),removeNested=scopedRegister(nested),removeLater=register(laterOuter);assert.equal(active(),nested,'A later outer registration cannot steal scoped usage');
 const removePeer=register(peer,1);assert.equal(active(),peer,'Equal-depth ordering remains last registered');
 const removeDeep=register(deep,2);assert.equal(active(),deep);removeDeep();assert.equal(active(),peer);
 removePeer();assert.equal(active(),nested);removeNested();assert.equal(active(),laterOuter,'Nested cleanup restores the latest outer owner');
 removeLater();assert.equal(active(),outer);removeOuter();assert.equal(active(),undefined,'The existing fallback can take over');
});


test('legacy Parameters links normalize to the same Settings variables owner and preserve roundtrip',()=>{
 const legacy=parseBranchRoute('?branch=owner&tab=parameters&execution=run&chat=chat');
 assert.deepEqual(legacy,{branchId:'owner',tab:'settings',settingsSection:'variables',executionId:'run',chatId:'chat'});
 const path=branchRoutePath(legacy);assert.ok(path.includes('tab=settings')&&path.includes('section=variables')&&!path.includes('parameters'));
 assert.deepEqual(parseBranchRoute(new URL(path,'https://example.test').search),legacy);
 assert.equal(parseBranchRoute('?branch=owner&tab=workflow&section=variables').settingsSection,undefined);
});

async function variableEditorFixture(parameters={note:'edited'},definition={parameters:{note:{type:'text'}}}){
 const fs=await import('node:fs/promises'),vm=await import('node:vm'),ts=await import('typescript'),source=await fs.readFile(new URL('../../apps/web/src/components/branches/BranchSettings.tsx',import.meta.url),'utf8');
 const ast=ts.createSourceFile('settings.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),editor=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='BranchConfigurationEditor'),declarations=editor.body.statements.flatMap(node=>ts.isVariableStatement(node)?[...node.declarationList.declarations]:[]),expression=name=>declarations.find(node=>node.name.getText(ast)===name).initializer.getText(ast),writes=[];
 const configuration={parameters:{note:'original'},limits:{maxCallDepth:8,maxLoopIterations:50,maxTraversals:500}};
 const scope={branch:{id:'variables-owner',versionId:'published'},definition,draft:{parameters,limits:{...configuration.limits}},revision:3,baseline:{current:{configuration,revision:3}},server:{configuration,revision:3},client:{setQueryData(){},invalidateQueries:async()=>{}},setDraft:value=>{scope.draft=value},setRevision:value=>{scope.revision=value},settings:{refetch:async()=>({data:scope.server})},requestJson:async(path,init)=>{if(init?.method!=='PUT'){if(scope.readback)return scope.readback(path,init);return scope.server}const body=JSON.parse(init.body);writes.push({path,...body});if(body.revision!==scope.server.revision)throw new Error('Configuration changed; reload before saving');scope.server={configuration:body.configuration,revision:body.revision+1};return scope.server},useMutation:options=>{const mutation={options,reset(){},mutate:input=>{mutation.pending=mutation.mutateAsync(input)},mutateAsync:async input=>{const next=await options.mutationFn(input);options.onSuccess(next);return next}};return mutation}};
 scope.currentDraft={current:scope.draft};scope.writeDraft=value=>{scope.draft=value};
 const execute=value=>vm.runInNewContext(ts.transpile(value,{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}),scope);
 scope.setDraft=execute(expression('setDraft'));scope.save=execute(expression('save'));scope.reloadAction=execute(expression('reloadAction'));const errors=()=>execute(expression('parameterErrors'));
 const reload=declarations.find(node=>node.name.getText(ast)==='reload').initializer,handler=reload.openingElement.attributes.properties.find(node=>node.name?.getText(ast)==='onClick').initializer.expression;
 const clickReload=execute(handler.getText(ast));
 return {scope,writes,errors,reload:()=>{clickReload();return scope.reloadAction.pending},hydrate:()=>execute(editor.body.statements.find(node=>node.getText(ast).startsWith('useEffect(()=>{if(!settings.data')).getText(ast)),execute};
}

test('workflow variables reject removed/secret keys, changed scalar types and missing required values without filtering drafts',async()=>{
 const f=await variableEditorFixture({removed:'retain me',secret:'prior text',n:'wrong',flag:'wrong',path:12},{parameters:{secret:{type:'secret'},n:{type:'number'},flag:{type:'boolean'},path:{type:'path'},required:{type:'text',required:true}}});
 assert.equal(f.errors().length,6);assert.equal(f.scope.draft.parameters.removed,'retain me');assert.equal(f.scope.draft.parameters.secret,'prior text');
 f.scope.draft.parameters={n:2,flag:false,path:'/valid',required:'ready'};assert.deepEqual([...f.errors()],[]);
 f.scope.draft.parameters.n=Infinity;assert.ok(f.errors().some(error=>error.includes('finite number')));
 f.scope.definition={parameters:{}};assert.equal(f.errors().length,4,'Removing the final schema cannot silently drop unsaved fields');
});

test('variable saves retain full limits and CAS; concurrent configuration refresh preserves edits until explicit reload',async()=>{
 const f=await variableEditorFixture();f.scope.server={configuration:{parameters:{note:'concurrent'},limits:{maxCallDepth:12,maxLoopIterations:60,maxTraversals:700}},revision:4};
 f.scope.settings.data=f.scope.server;f.scope.useEffect=effect=>effect();f.hydrate();assert.equal(f.scope.draft.parameters.note,'edited');assert.equal(f.scope.revision,3);
 await assert.rejects(f.scope.save.mutateAsync(),/Configuration changed/);assert.equal(f.writes[0].revision,3);assert.equal(f.writes[0].configuration.limits.maxCallDepth,8);assert.equal(f.scope.draft.parameters.note,'edited');
 await f.reload();assert.equal(f.scope.revision,4);assert.equal(f.scope.draft.limits.maxCallDepth,12);assert.equal(f.scope.draft.parameters.note,'concurrent');
 f.scope.draft={...f.scope.draft,parameters:{note:'after explicit reload'}};await f.scope.save.mutateAsync();assert.deepEqual(f.writes.at(-1).configuration,{parameters:{note:'after explicit reload'},limits:{maxCallDepth:12,maxLoopIterations:60,maxTraversals:700}});assert.equal(f.scope.revision,5);
});


test('a delayed variable reload cannot erase newer typed values',async()=>{
 const f=await variableEditorFixture();let finish;f.scope.readback=()=>new Promise(resolve=>{finish=resolve});
 const pending=f.reload();const newer={...f.scope.draft,parameters:{note:'typed while reloading'}};f.scope.setDraft(newer);
 finish({configuration:{parameters:{note:'server'},limits:f.scope.draft.limits},revision:8});await pending;
 assert.equal(f.scope.draft.parameters.note,'typed while reloading');assert.equal(f.scope.revision,3,'The stale completion cannot replace the edit baseline either');
});


test('explicit configuration recovery waits for its fresh HTTP response and ignores canceled query cache',async()=>{
 const f=await variableEditorFixture();let finish,reads=0;f.scope.settings.refetch=async()=>({data:{configuration:f.scope.draft,revision:3},error:null});
 f.scope.readback=async(path,init)=>{reads++;assert.equal(path,'/api/branches/variables-owner/settings');assert.equal(init.cache,'no-store');return new Promise(resolve=>{finish=resolve})};
 const pending=f.reload();assert.equal(reads,1);assert.equal(f.scope.revision,3);
 finish({configuration:{parameters:{note:'verified'},limits:f.scope.draft.limits},revision:9});await pending;assert.equal(f.scope.revision,9);assert.equal(f.scope.draft.parameters.note,'verified');
 f.scope.settings.data={configuration:{parameters:{note:'old canceled cache'},limits:f.scope.draft.limits},revision:3};f.scope.useEffect=effect=>effect();f.hydrate();assert.equal(f.scope.revision,9);assert.equal(f.scope.draft.parameters.note,'verified','Older query completion cannot roll back verified recovery');
});


test('uncertain variable saves recover the accepted revision without replay and failed readback preserves edits',async()=>{
 const f=await variableEditorFixture(),request=f.scope.requestJson;f.scope.requestJson=async(path,init)=>{const next=await request(path,init);if(init?.method==='PUT')throw new Error('Controlled response loss');return next};
 await assert.rejects(f.scope.save.mutateAsync(),/response loss/);assert.equal(f.scope.revision,3);assert.equal(f.writes.length,1);assert.equal(f.scope.server.revision,4);
 f.scope.readback=async()=>{throw new Error('Controlled recovery failure')};await assert.rejects(f.reload(),/recovery failure/);assert.equal(f.scope.draft.parameters.note,'edited');assert.equal(f.scope.revision,3);
 f.scope.readback=undefined;await f.reload();assert.equal(f.scope.revision,4);assert.equal(f.scope.draft.parameters.note,'edited');assert.equal(f.writes.length,1,'Readback must not repeat the accepted write');
});

async function discardActionFixture(){
 const {readFile}=await import('node:fs/promises'),{createRequire}=await import('node:module'),vm=await import('node:vm'),ts=createRequire(new URL('../../apps/web/package.json',import.meta.url))('typescript');
 const source=await readFile(new URL('../../apps/web/src/components/BranchesView.tsx',import.meta.url),'utf8'),file=ts.createSourceFile('BranchesView.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const declarations=new Map();function visit(node){if(ts.isVariableStatement(node))for(const d of node.declarationList.declarations)if(ts.isIdentifier(d.name))declarations.set(d.name.text,node.getText(file));if(ts.isFunctionDeclaration(node)&&node.name)declarations.set(node.name.text,node.getText(file));ts.forEachChild(node,visit)}visit(file);
 const branch={id:'owner',name:'Published workflow',versionId:'v1',bindingRevisionId:'b1',chatId:'chat'},definition={name:branch.name,steps:[],controls:[],edges:[],trigger:{kind:'manual'}},bindings={agents:{},directories:{workspace:'.'}};
 const {branchDraftRevision}=await import('../../apps/web/src/components/branches/model.ts'),{ApiRequestError}=await import('../../apps/web/src/api/types.ts');
 const baseline={branchId:branch.id,expectedVersionId:branch.versionId,chatId:branch.chatId,definition,bindings},draft={...baseline,definition:{...definition,name:'Local rename'}},requests=[],resets=[],cache=[];
 const scope={draft,currentDraft:{current:draft},draftRevision:{current:branchDraftRevision(draft)},pendingAdvanced:{current:true},workflowEdits:{current:3},routeOwner:{current:{branchId:'owner',tab:'workflow'}},selection:{current:7},savedDraft:{current:branchDraftRevision(baseline)},branchDraftRevision,ApiRequestError,
  serverBranch:branch,serverDefinition:definition,serverBindings:bindings,advancedDirty:true,dirty:true,loading:false,openingLink:false,publicationUnconfirmed:false,discardDisabled:false,discardIntent:undefined,preview:{draftRevision:branchDraftRevision(draft),input:{branchId:'owner',idempotencyKey:'exact-attempt',definition:draft.definition},expectsNewWebhookSecret:false,result:{operations:[]}},
  input:'keep execution input',runOpen:true,occurrenceKey:'keep accepted intent',notice:'Unrelated success',error:'Unrelated failure',independentSettings:{count:'dirty'},current:branch,
  review:{isPending:false,reset(){resets.push('review')},mutate(){resets.push('new preview')}},deploy:{isPending:false,isError:false,reset(){resets.push('deploy')}},run:{reset(){resets.push('run')}},
  actionLocks:{current:new Set()},once(key,action){if(scope.actionLocks.current.has(key))return;scope.actionLocks.current.add(key);action()},
  newDefinition:()=>({...definition,name:'Untitled workflow'}),updateDraft:next=>{scope.draft=next},setAdvancedDirty:value=>{scope.advancedDirty=value},setDeployedUpdate:value=>{scope.deployedUpdate=value},setEditorKey:update=>{scope.editorKey=update(scope.editorKey??0)},setPreview:value=>{scope.preview=value},setReminderDismissed:value=>{scope.reminderDismissed=value},setDiscardIntent:value=>{scope.discardIntent=value},setError:value=>{scope.error=value},setLoading:value=>{scope.loading=value},setSecret:value=>{scope.secret=value},setSecretRecovery:value=>{scope.secretRecovery=value},setNotice:value=>{scope.notice=value},
  client:{setQueryData:(key,value)=>cache.push({key,value}),invalidateQueries:async()=>{}},
  requestJson:async(path,init)=>{requests.push({path,method:init?.method??'GET',cache:init?.cache,body:init?.body});await scope.onRead?.(path,init);if(init?.method==='POST')return scope.serverBranch;if(path.includes('/versions/'))return {id:scope.serverBranch.versionId,branchId:'owner',definition:scope.serverDefinition};if(path.includes('/configuration'))return scope.serverBindings;return {...scope.serverBranch}},
  useMutation:options=>{const state={options,isPending:false,isError:false,error:null,reset(){state.error=null;state.isError=false},mutate(input){state.pending=state.mutateAsync(input).catch(()=>{})},async mutateAsync(input){state.variables=input;state.isPending=true;state.isError=false;state.error=null;try{await options.onMutate?.(input);const value=await options.mutationFn(input);await options.onSuccess?.(value,input);return value}catch(error){state.isError=true;state.error=error;throw error}finally{state.isPending=false;options.onSettled?.()}}};return state}
 };
 vm.createContext(scope);
 const load=name=>{let statement=declarations.get(name);assert.ok(statement,`Actual owner ${name} exists`);if(statement.startsWith('async function'))statement=statement.replace(`async function ${name}`,`globalThis.${name}=async function`);else statement=statement.replace(`const ${name}=`,`globalThis.${name}=`);vm.runInContext(ts.transpileModule(statement,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,scope)};
 for(const name of ['readWorkflowDraft','setDraft','resetWorkflowBaseline','ownsDiscard','discard','requestDiscard','reviewChanges','publishChanges'])load(name);
 return {scope,requests,resets,cache,baseline,load,source,file,ts,vm};
}

test('Discard resets the verified workflow only and uses immutable binding revision with fresh reads',async()=>{
 const f=await discardActionFixture(),s=f.scope;s.requestDiscard();assert.equal(s.discardIntent.branchId,'owner');await s.discard.mutateAsync(s.discardIntent);
 assert.equal(s.draft.definition.name,'Published workflow');assert.equal(s.savedDraft.current,s.branchDraftRevision(s.draft));assert.equal(s.pendingAdvanced.current,false);assert.equal(s.advancedDirty,false);assert.equal(s.preview,undefined);assert.equal(s.discardIntent,undefined);assert.equal(s.reminderDismissed,false);
 assert.equal(s.input,'keep execution input');assert.equal(s.runOpen,true);assert.equal(s.occurrenceKey,'keep accepted intent');assert.equal(s.independentSettings.count,'dirty');assert.equal(s.error,'Unrelated failure');assert.equal(s.notice,'Unrelated success');assert.deepEqual(f.resets,['review']);
 assert.equal(f.requests.length,4);assert.ok(f.requests.every(r=>r.method==='GET'&&r.cache==='no-store'));assert.ok(f.requests.some(r=>r.path.endsWith('/configuration?revisionId=b1')));assert.equal(f.requests[0].path,f.requests.at(-1).path);
});

test('Discard retains never-published Branch identity and restores its persisted default without a write',async()=>{
 const f=await discardActionFixture(),s=f.scope;s.serverBranch={...s.serverBranch,versionId:'',bindingRevisionId:'',name:'Never published'};s.requestDiscard();await s.discard.mutateAsync(s.discardIntent);
 assert.equal(s.draft.branchId,'owner');assert.equal(s.draft.definition.name,'Never published');assert.equal(s.draft.expectedVersionId,'');assert.ok(!f.requests.some(r=>r.path.includes('/versions/')));assert.ok(f.requests.every(r=>r.method==='GET'));
});

test('failed or incoherent Discard reads retain all edits and an explicit retry can recover',async()=>{
 for(const failure of ['read','version','bindings']){const f=await discardActionFixture(),s=f.scope,before=s.draft;s.requestDiscard();let gets=0;s.onRead=async path=>{if(failure==='read')throw Error('Offline');if(path==='/api/branches/owner'&&++gets===2)s.serverBranch={...s.serverBranch,...(failure==='version'?{versionId:'v2'}:{bindingRevisionId:'b2'})}};
  await assert.rejects(s.discard.mutateAsync(s.discardIntent));assert.equal(s.draft,before);assert.equal(s.advancedDirty,true);assert.ok(s.discardIntent);assert.equal(f.resets.length,0);s.onRead=undefined;await s.discard.mutateAsync(s.discardIntent);assert.equal(s.draft.definition.name,'Published workflow');
 }
});

test('late Discard cannot erase another owner, same-value newer draft edits, or unapplied advanced edits',async()=>{
 for(const change of ['owner','selection','revision','edits']){const f=await discardActionFixture(),s=f.scope,before=s.draft;s.requestDiscard();let release,entered;const read=new Promise(resolve=>{entered=resolve});s.onRead=()=>new Promise(resolve=>{release=()=>{s.onRead=undefined;resolve()};entered()});const pending=s.discard.mutateAsync(s.discardIntent);await read;
  if(change==='owner')s.routeOwner.current={branchId:'other'};else if(change==='selection')s.selection.current++;else if(change==='revision')s.draftRevision.current='newer draft';else s.workflowEdits.current++;
  release();await assert.rejects(pending,/changed/);assert.equal(s.draft,before);assert.equal(s.advancedDirty,true);assert.equal(f.resets.length,0);
 }
});

test('both Discard entry points share pending locks and publication uncertainty cannot silently reset the attempt',async()=>{
 const f=await discardActionFixture(),s=f.scope;s.requestDiscard();s.once('discard',()=>s.discard.mutate(s.discardIntent));s.once('discard',()=>s.discard.mutate(s.discardIntent));await s.discard.pending;assert.equal(f.requests.length,4);
 const u=await discardActionFixture(),a=u.scope,attempt=a.preview;a.deploy={...a.deploy,isError:true,variables:attempt,error:Error('Response lost')};u.load('publicationUnconfirmed');u.load('discardDisabled');assert.equal(a.publicationUnconfirmed,true);a.requestDiscard();assert.equal(a.discardIntent,undefined);a.preview=undefined;a.reviewChanges();assert.equal(a.preview,attempt);assert.equal(u.resets.length,0);a.draftRevision.current='new edits';let retried;a.deploy.mutate=value=>{retried=value};a.publishChanges();assert.equal(retried,attempt,'Retry uses the exact old idempotent attempt even if newer edits exist');
 a.deploy.error=new a.ApiRequestError(400,'Rejected');u.load('publicationUnconfirmed');assert.equal(a.publicationUnconfirmed,false,'A settled rejection can use fresh canonical Discard recovery');
});

test('reconciled publication keeps newer draft edits instead of resetting them; unrelated owner is not selected',async()=>{
 for(const owner of ['owner','other']){const f=await discardActionFixture(),s=f.scope,attempt=s.preview;f.load('deploy');s.routeOwner.current={branchId:owner};s.draftRevision.current='newer draft';let selected=0;s.select=async()=>{selected++;return true};await s.deploy.options.onSuccess({...s.serverBranch,versionId:'published-after-retry'},attempt);
  assert.equal(selected,0);assert.equal(s.draft.definition.name,'Local rename');assert.equal(s.independentSettings.count,'dirty');if(owner==='owner')assert.equal(s.deployedUpdate.reason,'dirty');else assert.equal(s.deployedUpdate,undefined);
 }
});


test('successful Discard retires late callbacks from the old editor generation',async()=>{
 const f=await discardActionFixture(),s=f.scope;s.editorGeneration=s.selection.current;
 const callbacks={};function visit(node){if(f.ts.isJsxAttribute(node)&&['onDefinition','onBindings'].includes(node.name.getText(f.file))&&node.initializer&&f.ts.isJsxExpression(node.initializer)){const text=node.initializer.expression?.getText(f.file);if(text?.includes('editorGeneration===selection.current'))callbacks[node.name.getText(f.file)]=text}f.ts.forEachChild(node,visit)}visit(f.file);
 s.bindDefinitionDirectories=(_definition,bindings)=>bindings;s.contexts={data:[]};for(const [name,code] of Object.entries(callbacks))f.vm.runInContext(f.ts.transpileModule(`globalThis.old_${name}=${code}`,{compilerOptions:{target:f.ts.ScriptTarget.ES2022}}).outputText,s);
 assert.equal(Object.keys(callbacks).length,2);s.requestDiscard();await s.discard.mutateAsync(s.discardIntent);const restored=s.draft;
 s.old_onDefinition({...restored.definition,name:'Late discarded JSON'});s.old_onBindings({agents:{late:'discarded'}});assert.equal(s.draft,restored);assert.equal(s.draft.definition.name,'Published workflow');
});


test('retrying an unconfirmed publication keeps unapplied advanced edits mounted until its outcome is known',async()=>{
 const f=await discardActionFixture(),s=f.scope,attempt=s.preview;f.load('deploy');let selected=0;s.select=async()=>{selected++;return true};
 await s.deploy.options.onMutate?.(attempt);assert.equal(s.loading,false,'Do not unmount the advanced editor just to retry a publication');assert.equal(s.pendingAdvanced.current,true);await s.deploy.options.onSuccess(s.serverBranch,attempt);assert.equal(selected,0);assert.equal(s.advancedDirty,true);assert.equal(s.deployedUpdate.reason,'dirty');
});


test('pending actual advanced Apply survives publication retry without a new editor generation',async()=>{
 const {readFile}=await import('node:fs/promises');
 for(const responseFirst of [false,true]){const f=await discardActionFixture(),s=f.scope,attempt=s.preview;f.load('deploy');s.editorGeneration=s.selection.current;s.definition=s.draft.definition;s.currentDefinition={current:s.definition};s.applyRequest={current:0};s.advanced=JSON.stringify({...s.definition,name:'New advanced edit'});s.setAdvanced=value=>{s.advanced=value};s.setJsonError=value=>{s.jsonError=value};s.contexts={data:[]};s.bindDefinitionDirectories=(_definition,bindings)=>bindings;
  let parent;function visit(node){if(f.ts.isJsxAttribute(node)&&node.name.getText(f.file)==='onDefinition'&&node.initializer&&f.ts.isJsxExpression(node.initializer)&&node.initializer.expression?.getText(f.file).includes('editorGeneration===selection.current'))parent=node.initializer.expression.getText(f.file);f.ts.forEachChild(node,visit)}visit(f.file);f.vm.runInContext(f.ts.transpileModule(`globalThis.onDefinition=${parent}`,{compilerOptions:{target:f.ts.ScriptTarget.ES2022}}).outputText,s);
  const editorSource=await readFile(new URL('../../apps/web/src/components/branches/WorkflowEditor.tsx',import.meta.url),'utf8'),editor=f.ts.createSourceFile('WorkflowEditor.tsx',editorSource,f.ts.ScriptTarget.Latest,true,f.ts.ScriptKind.TSX);let apply;function find(node){if(f.ts.isJsxAttribute(node)&&node.name.getText(editor)==='onClick'&&node.initializer&&f.ts.isJsxExpression(node.initializer)&&node.initializer.expression?.getText(editor).includes('startedDefinition=definition'))apply=node.initializer.expression.getText(editor);f.ts.forEachChild(node,find)}find(editor);assert.ok(apply);f.vm.runInContext(f.ts.transpileModule(`globalThis.apply=${apply}`,{compilerOptions:{target:f.ts.ScriptTarget.ES2022}}).outputText,s);
  let finish;s.requestJson=()=>new Promise(resolve=>{finish=resolve});const pending=s.apply();await s.deploy.options.onMutate?.(attempt);let selected=0;s.select=async()=>{selected++;return true};if(responseFirst)await s.deploy.options.onSuccess(s.serverBranch,attempt);finish({definition:{...s.definition,name:'New advanced edit'}});await pending;if(!responseFirst)await s.deploy.options.onSuccess(s.serverBranch,attempt);
  assert.equal(s.draft.definition.name,'New advanced edit');assert.equal(s.advanced,undefined,'Raw text clears only because the real parent accepted its validated definition');assert.equal(selected,0);assert.equal(s.jsonError,'');
 }
});


test('unpublished dot has a focusable shared tooltip, distinguishes initial drafts, and disappears at baseline',()=>{
 const props={name:'Workflow',tab:'workflow',published:true,dirty:true,executionCount:2,saving:false,saveDisabled:false,onTab(){},onSave(){},onExport(){},onUpdate(){}};
 const dirty=renderToStaticMarkup(React.createElement(BranchWorkspaceHeader,props));
 assert.ok(/role="img"[^>]*tabindex="0"[^>]*aria-label="Unpublished changes"/.test(dirty));assert.ok(dirty.includes('Unpublished workflow changes. Use Save to review and publish, or Discard changes.'));assert.ok(dirty.indexOf('2 active executions')<dirty.indexOf('aria-label="Unpublished changes"'));assert.ok(dirty.indexOf('aria-label="Unpublished changes"')<dirty.indexOf('aria-label="Save changes…"'));
 const clean=renderToStaticMarkup(React.createElement(BranchWorkspaceHeader,{...props,dirty:false}));assert.ok(!clean.includes('aria-label="Unpublished changes"'));assert.ok(!clean.includes('role="img"'));
 const initial=renderToStaticMarkup(React.createElement(BranchWorkspaceHeader,{...props,dirty:false,published:false}));assert.ok(initial.includes('aria-label="Unpublished workflow"'));assert.ok(initial.includes('Unpublished workflow — review and publish to run'));assert.ok(!initial.includes('Use Save to review and publish, or Discard changes.'));
});
