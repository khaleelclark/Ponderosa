import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const ts=require('typescript'),{QueryClient,QueryObserver}=require('@tanstack/react-query');
const source=name=>readFileSync(new URL('../../apps/web/src/'+name,import.meta.url),'utf8');
function module(text,imports={}){
 const exports={};vm.runInNewContext(ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,Error,Promise,Map,Set,URLSearchParams,window:{location:{pathname:'/home'}},require:name=>name in imports?imports[name]:name==='react/jsx-runtime'?require(name):new Proxy({},{get:(_,key)=>String(key)})});return exports;
}
const queryKeys=module(source('queryKeys.ts'),{'./agentHistoryPagination.js':{AGENT_DETAIL_PAGE_SIZE:100}}).queryKeys;
const retained=module(source('retainedData.ts'));
const registry=module(source('routeRegistry.ts'),{'./api/productScope.js':{productWorkspacePath:path=>path}});
function fixture(){
 const client=new QueryClient({defaultOptions:{queries:{staleTime:15000,retry:false,gcTime:Infinity}}}),calls=[],pending=[];
 const request=(kind,id)=>{calls.push({kind,id});return new Promise((resolve,reject)=>pending.push({kind,id,resolve,reject}));};
 const api={getConversation:(id,limit)=>{assert.equal(limit,100);return request('tail',id);},listConversations:id=>request('conversations',id),listAgents:id=>request('agents',id),getProject:id=>request('project',id)};
 const {prefetchConversationWorkspace:warm}=module(source('conversationWorkspacePrefetch.ts'),{'./api':{api},'./queryKeys':{queryKeys}});
 const resolve=(kind,value,id)=>{const row=pending.find(p=>p.kind===kind&&(!id||p.id===id));assert(row,'Pending '+kind);row.resolve(value);};
 return{client,calls,pending,api,warm,resolve,close(){client.clear();}};
}
function arrow(file,predicate){
 const text=source(file),ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);const matches=[];
 const visit=node=>{if(ts.isArrowFunction(node)&&predicate(node.getText(ast)))matches.push(node.getText(ast));ts.forEachChild(node,visit);};visit(ast);const found=matches.sort((a,b)=>a.length-b.length)[0];assert(found,'Expected existing warm callback in '+file);return found;
}
const appWarm=arrow('App.tsx',text=>text.includes('if (routedConversationId)')&&text.includes('prefetchConversationWorkspace'));
const branchWarm=arrow('components/BranchesView.tsx',text=>text.includes('chat.branchId!==id')&&text.includes('prefetchConversationWorkspace'));
const invoke=(text,env,...args)=>vm.runInNewContext('('+text+')',env)(...args);
const turn=()=>new Promise(setImmediate);
function shell(f,route){
 const result=key=>new QueryObserver(f.client,{queryKey:key,enabled:false}).getCurrentResult();
 const imports={
  react:{useCallback:fn=>fn,useMemo:fn=>fn()},
  '@mui/material':{Alert:'Alert',Box:'Box',Button:'Button',LinearProgress:'LinearProgress',useMediaQuery:()=>false},
  '@mui/material/styles':{useTheme:()=>({breakpoints:{down:()=>''}})},
  '@mui/material/utils':{useEventCallback:fn=>fn},
  '@tanstack/react-query':{useQueryClient:()=>f.client,useQuery:()=>({data:[]})},
  '../hooks/queries':{useConversations:id=>result(queryKeys.conversations.project(id)),useAgents:id=>result(queryKeys.agents.project(id)),useAgentHealth:()=>({data:{agents:[]}}),useAgent:()=>({})},
  '../hooks/useEngineModelCatalogs':{useEngineModelCatalogs:()=>({catalogs:[]})},
  '../agents':{mergeAgentStatuses:()=>new Map()},
  '../conversationEngine':{enginesWithModelCatalog:engines=>engines},
  '../retainedData':retained,'../routeRegistry':registry,'../queryKeys':{queryKeys},
  './ProjectBrowserContext':{useProjectBrowser:()=>({open(){}})},
  './WorkspaceRefreshContext':{useReportWorkspaceRefresh:(message)=>{f.refreshMessage=message;}},
  './ConversationView':{ConversationView:'ConversationView'},'./AgentDetail':{AgentDetail:'AgentDetail'},
 };
 const {ProjectShell}=module(source('components/ProjectShell.tsx'),imports);
 return ProjectShell({projectId:'project-a',project:{id:'project-a'},route,engines:[],preferences:{},onPreferences(){},navigate(){},onCreate(){}});
}
function* nodes(tree){if(!tree||typeof tree!=='object')return;if(Array.isArray(tree)){for(const child of tree)yield*nodes(child);}else if(tree.props){yield tree;yield*nodes(tree.props.children);}}
const contains=(tree,type)=>[...nodes(tree)].some(node=>node.type===type);
const text=tree=>[...nodes(tree)].flatMap(node=>typeof node.props.children==='string'?[node.props.children]:[]).join(' ');

test('Core existing route warm overlaps tail and scoped collections before Project metadata, with real QueryClient dedup and freshness',async()=>{
 const f=fixture();try{
  invoke(appWarm,{queryClient:f.client,routedConversationId:'chat-a',routedProjectId:'project-a',prefetchConversationWorkspace:f.warm});
  assert.deepEqual(f.calls.map(c=>c.kind),['tail','conversations','agents']);
  const observers=[
   new QueryObserver(f.client,{queryKey:queryKeys.conversations.detail('chat-a',100),queryFn:()=>f.api.getConversation('chat-a',100)}),
   new QueryObserver(f.client,{queryKey:queryKeys.conversations.project('project-a'),queryFn:()=>f.api.listConversations('project-a')}),
   new QueryObserver(f.client,{queryKey:queryKeys.agents.project('project-a'),queryFn:()=>f.api.listAgents('project-a')}),
  ];
  const stop=observers.map(o=>o.subscribe(()=>{}));assert.equal(f.calls.length,3,'Subscribers reuse the three in-flight canonical reads');
  f.resolve('tail',{conversation:{id:'chat-a'},messages:[]});f.resolve('conversations',[{id:'chat-a'}]);f.resolve('agents',[{id:'agent-a'}]);await turn();
  await f.warm(f.client,'chat-a','project-a');assert.equal(f.calls.length,3,'The existing 15s freshness policy is unchanged');
  stop.forEach(fn=>fn());
  invoke(appWarm,{queryClient:f.client,routedConversationId:undefined,routedProjectId:'project-b',prefetchConversationWorkspace:f.warm});assert.equal(f.calls.length,3,'Unrelated routes add no collection read');
  const legacy=f.warm(f.client,'legacy-chat',undefined);assert.deepEqual(f.calls.at(-1),{kind:'tail',id:'legacy-chat'});assert.equal(f.calls.length,4,'Missing Project identity must never become a global collection read');f.resolve('tail',{conversation:{id:'legacy-chat'},messages:[]},'legacy-chat');await legacy;
 }finally{f.close();}
});
test('warm results and failures stay in their exact canonical keys across a route switch',async()=>{
 const f=fixture();try{
  const a=f.warm(f.client,'chat-a','project-a'),b=f.warm(f.client,'chat-b','project-b');
  f.resolve('tail',{conversation:{id:'chat-b'},messages:['b']},'chat-b');f.resolve('conversations',[{id:'chat-b'}],'project-b');f.resolve('agents',[{id:'agent-b'}],'project-b');await b;
  f.resolve('tail',{conversation:{id:'chat-a'},messages:['a']},'chat-a');f.pending.find(p=>p.kind==='conversations'&&p.id==='project-a').reject(Error('Exact membership read refused'));f.resolve('agents',[],'project-a');await a;
  assert.equal(f.client.getQueryData(queryKeys.conversations.detail('chat-b',100)).conversation.id,'chat-b');
  assert.equal(f.client.getQueryData(queryKeys.conversations.project('project-b'))[0].id,'chat-b');
  assert.equal(f.client.getQueryState(queryKeys.conversations.project('project-a')).error.message,'Exact membership read refused');
 }finally{f.close();}
});
test('actual ProjectShell keeps pending, failed, foreign and deleted membership gates despite a warmed tail',async()=>{
 const route={kind:'conversation',projectId:'project-a',conversationId:'chat-a'};
 for(const kind of ['pending','failure','foreign','deleted','valid']){
  const f=fixture();try{
   const warming=f.warm(f.client,'chat-a','project-a');f.resolve('tail',{conversation:{id:'chat-a'},messages:['exact']});f.resolve('agents',[]);await turn();
   if(kind==='failure')f.pending.find(p=>p.kind==='conversations').reject(Error('Membership read unavailable'));
   else if(kind!=='pending')f.resolve('conversations',kind==='valid'?[{id:'chat-a'}]:kind==='foreign'?[{id:'different-project-chat'}]:[]);
   if(kind!=='pending')await warming;else await turn();
   const tree=shell(f,route);
   assert.equal(contains(tree,'ConversationView'),kind==='valid','Only verified membership may render the Chat: '+kind);
   if(kind==='pending')assert(contains(tree,'LinearProgress'));
   if(kind==='failure')assert.match(text(tree),/requested resource could not be checked/);
   if(kind==='foreign'||kind==='deleted')assert.match(text(tree),/unavailable in this Project/);
  }finally{f.close();}
 }
});
test('Branches existing owner guard overlaps the same reads with Project detail and refuses stale, foreign or mismatched owners',async()=>{
 const invalid=['cancelled','selection','route','chat','branch','execution','project'];
 for(const scenario of ['valid','held',...invalid]){
  const f=fixture();try{
   const route={branchId:'branch-a',tab:'chats',chatId:'chat-a',...(scenario==='held'?{executionId:'held-run'}:{}),workspace:{kind:'conversation',conversationId:'chat-a',projectId:'project-a'}};
   const branchCalls=[],branchApi=Object.fromEntries(Object.entries(f.api).map(([name,fn])=>[name,(...args)=>{branchCalls.push(name);return fn(...args);} ]));
   const env={client:f.client,realApi:branchApi,queryKeys,prefetchConversationWorkspace:f.warm,cancelled:scenario==='cancelled',selection:{current:scenario==='selection'?2:1},generation:1,routeOwner:{current:route},route,chatId:'chat-a',id:'branch-a'};
   const chat={id:'chat-a',projectId:'project-a',branchId:'branch-a',...(scenario==='held'?{executionId:'held-run'}:{})};
   if(scenario==='route')env.routeOwner.current={...route};if(scenario==='chat')chat.id='other-chat';if(scenario==='branch')chat.branchId='other-branch';if(scenario==='execution')chat.executionId='other-execution';if(scenario==='project')chat.projectId='other-project';
   const pending=invoke(branchWarm,env,chat);
   if(invalid.includes(scenario)){assert.equal(f.calls.length,0,scenario+' cannot prefetch a mismatched owner');continue;}
   assert.deepEqual(f.calls.map(c=>c.kind),['project','tail','conversations','agents'],'The tail and lists start while Project detail is still pending');assert.deepEqual(branchCalls,['getProject','getConversation','listConversations','listAgents'],'Branches uses its explicit scoped realApi transport');
   f.resolve('project',{id:'project-a'});f.resolve('tail',{conversation:{id:'chat-a'},messages:[]});f.resolve('conversations',[{id:'chat-a'}]);f.resolve('agents',[]);await pending;
  }finally{f.close();}
 }
});

test('a failed warm refresh preserves verified membership data and its existing visible refresh warning',async()=>{
 const f=fixture();try{
  const first=f.warm(f.client,'chat-a','project-a');f.resolve('tail',{conversation:{id:'chat-a'},messages:[]});f.resolve('conversations',[{id:'chat-a'}]);f.resolve('agents',[]);await first;
  await f.client.invalidateQueries({queryKey:queryKeys.conversations.project('project-a'),refetchType:'none'});
  const refresh=f.warm(f.client,'chat-a','project-a');f.pending.filter(p=>p.kind==='conversations').at(-1).reject(Error('Exact refresh refused'));await refresh;
  const tree=shell(f,{kind:'conversation',projectId:'project-a',conversationId:'chat-a'});assert(contains(tree,'ConversationView'));assert.match(f.refreshMessage,/could not refresh/);
  assert.equal(f.client.getQueryData(queryKeys.conversations.project('project-a'))[0].id,'chat-a');assert.equal(f.client.getQueryState(queryKeys.conversations.project('project-a')).error.message,'Exact refresh refused');
 }finally{f.close();}
});

const branchOpen=arrow('components/BranchesView.tsx',text=>text.includes('const executionBranchId=')&&text.includes('const ownerRead='));
function invokeOpening(env){
 const compiled=ts.transpileModule('const open='+branchOpen+'; open();',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 return vm.runInNewContext(compiled,env);
}
test('Branches starts only its canonical owner read alongside Branch metadata and waits for both before scoped warming',async()=>{
 for(const order of ['owner-first','branch-first']){
  const f=fixture();let resolveBranch,resolveOwner;const calls=[];
  const route={branchId:'branch-a',tab:'chats',chatId:'chat-a',workspace:{kind:'conversation',conversationId:'chat-a',projectId:'project-a'}};
  const owner={id:'chat-a',branchId:'branch-a',projectId:'project-a'};
  const requestJson=path=>{calls.push(path);return new Promise(resolve=>{if(path==='/api/branches/branch-a')resolveBranch=resolve;else if(path==='/api/branches/contexts/chat-a')resolveOwner=resolve;else assert.fail('Unexpected '+path);});};
  const selection={current:0};let selected=0;
  const env={requestJson,route,cancelled:false,draft:{},navigate:()=>assert.fail('No redirect expected'),setLoading(){},setOpeningLink(){},setDeployedUpdate(){},client:f.client,selection,routeOwner:{current:route},realApi:f.api,queryKeys,prefetchConversationWorkspace:f.warm,select:()=>{selected++;selection.current++;return Promise.resolve(true);},markWorkspaceResourceUsed(){},setError:message=>assert.fail(message),encodeURIComponent};
  try{
   const opening=invokeOpening(env);await turn();assert.deepEqual(calls,['/api/branches/contexts/chat-a','/api/branches/branch-a']);assert.equal(selected,0);assert.equal(f.calls.length,0);
   const observer=new QueryObserver(f.client,{queryKey:['branch-chat-owner','chat-a'],queryFn:()=>requestJson('/api/branches/contexts/chat-a'),retry:false});const stop=observer.subscribe(()=>{});assert.equal(calls.length,2,'Canonical subscriber shares the in-flight owner read');
   if(order==='owner-first'){resolveOwner(owner);await turn();assert.equal(f.calls.length,0,'Owner alone cannot warm workspace');resolveBranch({id:'branch-a'});}
   else{resolveBranch({id:'branch-a'});await turn();assert.equal(f.calls.length,0,'Branch alone cannot warm workspace');resolveOwner(owner);}
   await opening;await turn();assert.equal(selected,1);assert.deepEqual(f.calls.map(c=>c.kind),['project','tail','conversations','agents']);
   assert.equal(f.client.getQueryData(['branch-chat-owner','chat-a']).id,'chat-a');
   f.resolve('project',{id:'project-a'});f.resolve('tail',{conversation:{id:'chat-a'},messages:[]});f.resolve('conversations',[{id:'chat-a'}]);f.resolve('agents',[]);await turn();stop();
  }finally{f.close();}
 }
});
test('Branches overlap retains execution resolution, route/cancellation guards and canonical owner errors on Branch failure',async()=>{
 for(const scenario of ['execution-pending','cancelled','redirect','branch-failure','owner-failure','other-tab','other-workspace']){
  const f=fixture(),calls=[];let executionResolve,branchResolve,branchReject,ownerResolve,ownerReject;const errors=[];
  const route={branchId:'branch-a',tab:scenario==='other-tab'?'workflow':'chats',chatId:'chat-a',...(scenario==='execution-pending'?{executionId:'run-a'}:{}),...(scenario==='other-workspace'?{workspace:{kind:'agent',agentId:'agent-a',projectId:'project-a'}}:{})};
  const env={route,cancelled:scenario==='cancelled',draft:{},selection:{current:0},routeOwner:{current:route},client:f.client,realApi:f.api,queryKeys,prefetchConversationWorkspace:f.warm,requestJson:path=>{calls.push(path);return new Promise((resolve,reject)=>{if(path.startsWith('/api/branch-executions/'))executionResolve=resolve;else if(path==='/api/branches/branch-a'){branchResolve=resolve;branchReject=reject;}else if(path==='/api/branches/contexts/chat-a'){ownerResolve=resolve;ownerReject=reject;}else assert.fail(path);});},navigate(){calls.push('redirect');},setLoading(){},setOpeningLink(){},setDeployedUpdate(){},select:()=>{env.selection.current++;return Promise.resolve(true);},markWorkspaceResourceUsed(){},setError:message=>errors.push(message),encodeURIComponent};
  if(scenario==='redirect')env.route={...route,branchId:undefined,executionId:'run-a'};
  try{
   const opening=invokeOpening(env);await turn();
   if(scenario==='execution-pending'){assert.deepEqual(calls,['/api/branch-executions/run-a']);env.cancelled=true;executionResolve({execution:{branchId:'branch-a'}});await opening;assert.equal(calls.length,1);continue;}
   if(scenario==='cancelled'){await opening;assert.equal(calls.length,0);continue;}
   if(scenario==='redirect'){executionResolve({execution:{branchId:'branch-a'}});await opening;assert.deepEqual(calls,['/api/branch-executions/run-a','redirect']);continue;}
   if(scenario==='other-tab'||scenario==='other-workspace'){assert.deepEqual(calls,['/api/branches/branch-a']);branchResolve({id:'branch-a'});await opening;assert.equal(f.calls.length,0);continue;}
   if(scenario==='branch-failure'){ownerReject(Error('Exact owner refused'));branchReject(Error('Exact Branch refused'));await opening;await turn();assert.deepEqual(errors,['Exact Branch refused']);assert.equal(f.client.getQueryState(['branch-chat-owner','chat-a']).error.message,'Exact owner refused');}
   else{branchResolve({id:'branch-a'});ownerReject(Error('Exact owner refused'));await opening;await turn();assert.deepEqual(errors,[]);assert.equal(f.client.getQueryState(['branch-chat-owner','chat-a']).error.message,'Exact owner refused');}
   assert.equal(f.calls.length,0,'No scoped workspace reads after a failed readiness read');
  }finally{f.close();}
 }
});
