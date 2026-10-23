import test from 'node:test';
import assert from 'node:assert/strict';
import '../shared/web-typescript-loader.mjs';
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
