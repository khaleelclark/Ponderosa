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
const rootWarm=arrow('index.tsx',text=>text.includes('isBranchesPath(window.location.pathname)')&&text.includes('prefetchConversationWorkspace'));
const routing=module(source('routing.ts'),{'./routeRegistry.js':registry}),parseRoute=routing.parseRoute;
const productScope=module(source('api/productScope.ts'));
function warmRoot(f,pathname,search=''){
 return invoke(rootWarm,{window:{location:{pathname,search}},parseRoute,...productScope,queryClient:f.client,prefetchConversationWorkspace:f.warm,api:f.api,queryKeys});
}

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
  './ConversationView':{ConversationView:'ConversationView'},'./RecoverableLazyRoute':{RecoverableLazyRoute:'RecoverableLazyRoute'},'../api/productScope':productScope,
  '../routing':routing,'../workspaceFileReturn':module(source('workspaceFileReturn.ts')),
  '../projectShellLoader':f.panelLoaders??=(module(source('projectShellLoader.ts'))),
 };
 const {ProjectShell}=f.shellModule??=(module(source('components/ProjectShell.tsx'),imports));
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
test('a failed warm refresh preserves verified membership data and its existing visible refresh warning',async()=>{
 const f=fixture();try{
  const first=f.warm(f.client,'chat-a','project-a');f.resolve('tail',{conversation:{id:'chat-a'},messages:[]});f.resolve('conversations',[{id:'chat-a'}]);f.resolve('agents',[]);await first;
  await f.client.invalidateQueries({queryKey:queryKeys.conversations.project('project-a'),refetchType:'none'});
  const refresh=f.warm(f.client,'chat-a','project-a');f.pending.filter(p=>p.kind==='conversations').at(-1).reject(Error('Exact refresh refused'));await refresh;
  const tree=shell(f,{kind:'conversation',projectId:'project-a',conversationId:'chat-a'});assert(contains(tree,'ConversationView'));assert.match(f.refreshMessage,/could not refresh/);
  assert.equal(f.client.getQueryData(queryKeys.conversations.project('project-a'))[0].id,'chat-a');assert.equal(f.client.getQueryState(queryKeys.conversations.project('project-a')).error.message,'Exact refresh refused');
 }finally{f.close();}
});

// Execute the actual opening effect, select and workflow draft reader together.
// Transport/state cells are controlled; select and its generation transitions are not mocked.
const branchText=source('components/BranchesView.tsx');
const branchAst=ts.createSourceFile('BranchesView.tsx',branchText,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function declaration(name){let found;function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text===name)found=n.getText(branchAst);ts.forEachChild(n,visit);}visit(branchAst);assert(found,name);return found;}
const openingEffect=arrow('components/BranchesView.tsx',text=>text.includes('let cancelled=false')&&text.includes('const executionBranchId='));
const realTransportText=source('api/real.ts'),transportAst=ts.createSourceFile('real.ts',realTransportText,ts.ScriptTarget.Latest,true);
const transportFunctions=['backgroundRead','coalesceBackgroundRead','decodeHttpError','requestJson'].map(name=>transportAst.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(transportAst)).join('\n');
function realRequestTransport(fetch){
 const env={exports:{},Headers,Map,JSON,Promise,fetch,productApiPath:path=>path,waitForBackgroundCooldown:()=>Promise.resolve(),ApiRequestError:module(source('api/types.ts')).ApiRequestError,parseRetryAfter:()=>undefined,noteBackgroundRateLimit:()=>assert.fail('403 does not set rate cooldown'),API_BASE:'',pendingBackgroundReads:new Map()};
 vm.runInNewContext(ts.transpileModule(transportFunctions,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,env);return env.exports.requestJson;
}
function openingFixture(options={}){
 const f=fixture(),requests=[],pending=[],errors=[],state={draft:{},baseline:0},route={branchId:'branch-a',tab:'chats',chatId:'chat-a',...options.route};
 const requestJson=realRequestTransport((path,init)=>{requests.push(path);return new Promise((resolve,reject)=>{const row={path,signal:init?.signal,respond:resolve,resolve:value=>resolve(new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}})),reject};pending.push(row);init?.signal?.addEventListener('abort',()=>{row.aborted=true;reject(init.signal.reason);},{once:true});});});
 const env={QueryObserver,route,draft:state.draft,selection:{current:0},routeOwner:{current:route},client:f.client,realApi:f.api,queryKeys,prefetchConversationWorkspace:f.warm,requestJson,
  navigate(next){env.routeOwner.current=next;},setLoading(){},setOpeningLink(){},setDeployedUpdate(){},setError:message=>errors.push(message),setInput(){},setRunOpen(){},run:{reset(){}},setOccurrenceKey(){},createClientId:()=> 'synthetic-id',currentDraft:{current:{}},draftRevision:{current:''},pendingAdvanced:{current:false},
  resetWorkflowBaseline(next){state.draft=next;state.baseline++;},newDefinition:()=>({steps:[]}),markWorkspaceResourceUsed(){},encodeURIComponent};
 if(options.cache)f.client.setQueryData(['branch-chat-owner','chat-a'],options.cache);
 const code=ts.transpileModule(declaration('readWorkflowDraft')+'\n'+declaration('select')+'\nconst cleanup=('+openingEffect+')();',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 vm.runInNewContext(code,env);const cleanup=vm.runInNewContext('cleanup',env);
 const next=(path,value,fail=false)=>{const row=pending.find(x=>x.path===path&&!x.done);assert(row,'Pending '+path);row.done=true;row[fail?'reject':'resolve'](value);};
 return{...f,env,state,requests,pending,errors,cleanup,next,http(path,status,message){const row=pending.find(x=>x.path===path&&!x.done);assert(row);row.done=true;row.respond(new Response(JSON.stringify({error:message}),{status,headers:{'content-type':'application/json'}}));},close(){cleanup?.();f.close();}};
}
const ownerValue={id:'chat-a',branchId:'branch-a',projectId:'project-a'};
const ownerPath='/api/branches/contexts/chat-a',branchPath='/api/branches/branch-a',configPath='/api/branches/branch-a/configuration';
async function settleWarm(f){for(const [kind,value]of [['project',{id:'project-a'}],['tail',{conversation:{id:'chat-a'},messages:[]}],['conversations',[{id:'chat-a'}]],['agents',[]]])f.resolve(kind,value);await turn();}
test('actual opening/select overlaps owner before or after DTO while workflow configuration remains held',async()=>{
 for(const order of ['owner-first','branch-first','fresh-cache']){const f=openingFixture(order==='fresh-cache'?{cache:ownerValue}:{});try{
  await turn();if(order==='owner-first'){f.next(ownerPath,ownerValue);await turn();assert.equal(f.calls.length,0);}
  f.next(branchPath,{id:'branch-a',chatId:'chat-a',name:'Synthetic'});await turn();assert.equal(f.env.selection.current,1,'Actual select advances its generation');assert(f.requests.includes(configPath));assert.equal(f.state.baseline,0,'Actual select still awaits configuration');
  if(order==='branch-first'){assert.equal(f.calls.length,0);f.next(ownerPath,ownerValue);await turn();}
  assert.deepEqual(f.calls.map(x=>x.kind),['project','tail','conversations','agents']);
  if(order==='fresh-cache')assert(!f.requests.includes(ownerPath),'Nonstale canonical cache needs no artificial fetch');
  assert.equal(f.client.getQueryCache().find({queryKey:['branch-chat-owner','chat-a']}).getObserversCount(),0,'Success disposes opening observer');
  f.next(configPath,{agents:{},directories:{}});await turn();assert.equal(f.state.baseline,1);assert.equal(f.state.draft.branchId,'branch-a');await settleWarm(f);
 }finally{f.close();}}
});
test('actual snapshot cancel/invalidate resumes exactly once from fresh owner and never admits late pre-baseline result',async()=>{
 const f=openingFixture();try{await turn();f.next(branchPath,{id:'branch-a',chatId:'chat-a',name:'Synthetic'});await turn();
  const old=f.pending.find(x=>x.path===ownerPath);assert(old.signal instanceof AbortSignal,'Actual query passes its cancellation signal to actual requestJson/fetch');await f.client.cancelQueries();assert.equal(old.signal.aborted,true);assert.equal(old.aborted,true,'Old transport observes cancellation');const fresh=f.client.invalidateQueries({refetchType:'active'});await turn();assert.equal(f.requests.filter(x=>x===ownerPath).length,2);assert.notEqual(f.pending.filter(x=>x.path===ownerPath).at(-1).signal,old.signal,'Fresh query owns a distinct signal');
  f.next(ownerPath,{...ownerValue,projectId:'pre-baseline-project'});await turn();assert.equal(f.calls.length,0,'Cancelled HTTP completion cannot admit its old result');
  f.next(ownerPath,ownerValue);await fresh;await turn();assert.deepEqual(f.calls.map(x=>x.kind),['project','tail','conversations','agents']);
  await f.client.invalidateQueries({refetchType:'active'});assert.equal(f.requests.filter(x=>x===ownerPath).length,2,'Successful handoff unsubscribes and cannot dispatch again');
  f.next(configPath,{agents:{},directories:{}});await turn();await settleWarm(f);
 }finally{f.close();}
});
test('actual owner handoff preserves HTTP errors, failed selection, route/foreign guards and disposal',async()=>{
 for(const scenario of ['http-error','select-error','route-switch','foreign-branch','foreign-execution','foreign-project','wrong-chat','selection','cleanup']){
  const route=scenario==='foreign-project'?{workspace:{kind:'conversation',conversationId:'chat-a',projectId:'project-a'}}:{};
  const f=openingFixture({route});try{await turn();f.next(branchPath,{id:'branch-a',chatId:'chat-a',name:'Synthetic'});await turn();
   if(scenario==='select-error'){f.next(configPath,Error('Configuration refused'),true);await turn();}
   if(scenario==='route-switch')f.env.routeOwner.current={branchId:'branch-b',tab:'chats',chatId:'chat-b'};
   if(scenario==='cleanup')f.cleanup();
   if(scenario==='selection')f.env.selection.current++;
   const value={...ownerValue,...(scenario==='wrong-chat'?{id:'other-chat'}:{}),...(scenario==='foreign-branch'?{branchId:'branch-b'}:{}),...(scenario==='foreign-execution'?{executionId:'other-run'}:{}),...(scenario==='foreign-project'?{projectId:'other-project'}:{})};
   if(scenario==='http-error')f.http(ownerPath,403,'Exact owner denied');else f.next(ownerPath,value);await turn();await turn();
   assert.equal(f.calls.length,0,scenario+' cannot warm workspace');assert.equal(f.requests.filter(x=>x===ownerPath).length,1,'No error retry');
   const q=f.client.getQueryCache().find({queryKey:['branch-chat-owner','chat-a']});assert.equal(q.getObserversCount(),0,scenario+' disposes observer');
   if(scenario==='http-error'){assert.equal(q.state.error.message,'Exact owner denied');assert.equal(q.state.error.status,403);}
  }finally{f.close();}
 }
});

test('actual opening keeps execution resolution, redirect, tab/workspace and Branch failure gates',async()=>{
 for(const scenario of ['execution-pending','execution-redirect','other-tab','other-workspace','branch-failure']){
  const route=scenario.startsWith('execution')?{executionId:'run-a',...(scenario==='execution-redirect'?{branchId:undefined}:{})}:scenario==='other-tab'?{tab:'workflow'}:scenario==='other-workspace'?{workspace:{kind:'agent',agentId:'agent-a',projectId:'project-a'}}:{};
  const f=openingFixture({route});try{await turn();
   if(scenario==='execution-pending'){assert.deepEqual(f.requests,['/api/branch-executions/run-a']);f.cleanup();f.next('/api/branch-executions/run-a',{execution:{branchId:'branch-a'}});await turn();assert.equal(f.requests.length,1);}
   else if(scenario==='execution-redirect'){f.next('/api/branch-executions/run-a',{execution:{branchId:'branch-a'}});await turn();assert.equal(f.env.routeOwner.current.branchId,'branch-a');assert.equal(f.requests.length,1);}
   else if(scenario==='other-tab'||scenario==='other-workspace'){assert.deepEqual(f.requests,[branchPath]);f.next(branchPath,{id:'branch-a',name:'Synthetic'});await turn();f.next(configPath,{agents:{},directories:{}});await turn();assert.equal(f.state.baseline,1);}
   else {f.next(branchPath,Error('Exact Branch refused'),true);await turn();assert.deepEqual(f.errors,['Exact Branch refused']);assert.equal(f.client.getQueryCache().find({queryKey:['branch-chat-owner','chat-a']}).getObserversCount(),0);f.next(ownerPath,ownerValue);await turn();}
   assert.equal(f.calls.length,0,scenario+' must not warm');
  }finally{f.close();}
 }
});

test('Root starts explicit Core Chat canonical data before App executes and mounted observers reuse the same reads',async()=>{
 const f=fixture();try{
  warmRoot(f,'/projects/project-a/chats/chat-a','?message=exact-focus');
  assert.deepEqual(f.calls.map(c=>c.kind),['tail','conversations','agents','project'],'The actual Root effect starts all four existing reads before App warm-up');
  invoke(appWarm,{queryClient:f.client,routedConversationId:'chat-a',routedProjectId:'project-a',prefetchConversationWorkspace:f.warm});
  const observers=[
   new QueryObserver(f.client,{queryKey:queryKeys.conversations.detail('chat-a',100),queryFn:()=>f.api.getConversation('chat-a',100)}),
   new QueryObserver(f.client,{queryKey:queryKeys.conversations.project('project-a'),queryFn:()=>f.api.listConversations('project-a')}),
   new QueryObserver(f.client,{queryKey:queryKeys.agents.project('project-a'),queryFn:()=>f.api.listAgents('project-a')}),
   new QueryObserver(f.client,{queryKey:queryKeys.projects.detail('project-a'),queryFn:()=>f.api.getProject('project-a'),retry:false}),
  ];
  const stops=observers.map(observer=>observer.subscribe(()=>{}));
  try{
   assert.equal(f.calls.length,4,'App and mounted observers share Root in-flight promises');
   f.resolve('tail',{conversation:{id:'chat-a'},messages:[]});f.resolve('conversations',[{id:'chat-a'}]);f.resolve('agents',[]);f.resolve('project',{id:'project-a'});await turn();
   warmRoot(f,'/projects/project-a/chats/chat-a');
   assert.equal(f.calls.length,4,'Repeated initial effect retains existing freshness and deduplication');
   assert.equal(f.client.getQueryData(queryKeys.conversations.detail('chat-a',100)).conversation.id,'chat-a');
  }finally{stops.forEach(stop=>stop());}
 }finally{f.close();}
});
test('Root data warm excludes malformed and non-Core-Chat routes without global reads',()=>{
 for(const [pathname,search] of [
  ['/',''],['/home',''],['/settings/general',''],['/projects/project-a/agents/agent-a',''],
  ['/projects/project-a/chats/%E0%A4%A',''],['/projects/%E0%A4%A/chats/chat-a',''],
  ['/branches','?branch=branch-a&tab=chats&chat=chat-a&workspace=/projects/project-a/chats/chat-a'],
  ['/assistant',''],['/apps/output-a',''],
 ]){
  const f=fixture();try{warmRoot(f,pathname,search);assert.deepEqual(f.calls,[],pathname+' must not start Core reads');}finally{f.close();}
 }
});


test('actual Agent lazy route keeps its Agent key, loader and exact focus props across focus-only updates',()=>{
 const f=fixture();try{
  f.client.setQueryData(queryKeys.conversations.project('project-a'),[{id:'chat-a'}]);
  f.client.setQueryData(queryKeys.agents.project('project-a'),[{id:'agent-a',projectId:'project-a',conversationId:'chat-a'}]);
  const a={kind:'agent',projectId:'project-a',agentId:'agent-a',focusTelemetry:{stream:'activity',id:'agent-a:activity:1'}};
  const first=[...nodes(shell(f,a))].find(node=>node.type==='RecoverableLazyRoute');assert(first);
  const b={...a,focusTelemetry:{stream:'activity',id:'agent-a:activity:2'},technicalFocusId:'exact-run'};
  const second=[...nodes(shell(f,b))].find(node=>node.type==='RecoverableLazyRoute');assert(second);
  assert.equal(first.key,'agent-a');assert.equal(second.key,'agent-a','Focus changes cannot reset the Agent draft owner');
  assert.equal(first.props.load,second.props.load,'The module-level loader preserves its existing route cache identity');
  assert.equal(first.props.componentProps.focusTelemetry,a.focusTelemetry);
  assert.equal(second.props.componentProps.focusTelemetry,b.focusTelemetry);
  assert.equal(second.props.componentProps.technicalFocusId,'exact-run');
  assert.equal(second.props.componentProps.agentId,'agent-a');assert.equal(second.props.componentProps.projectId,'project-a');
 }finally{f.close();}
});


test('actual optional project views preserve family and keyed scope replacement identity',()=>{
 const f=fixture();try{
  f.client.setQueryData(queryKeys.conversations.project('project-a'),[{id:'chat-a',projectId:'project-a'},{id:'chat-b',projectId:'project-a'}]);
  f.client.setQueryData(queryKeys.agents.project('project-a'),[{id:'agent-a',projectId:'project-a',conversationId:'chat-a'},{id:'agent-b',projectId:'project-a',conversationId:'chat-b'}]);
  const view=route=>{const node=[...nodes(shell(f,route))].find(node=>node.type==='RecoverableLazyRoute');assert(node,'The admitted actual route must expose its recoverable view');return node;};
  const fileA=view({kind:'workspaceFile',projectId:'project-a',conversationId:'chat-a',path:'first.md'});
  const fileB=view({kind:'workspaceFile',projectId:'project-a',conversationId:'chat-a',path:'second.md'});
  assert.equal(fileA.key,fileB.key,'Same-family unkeyed file views retain their existing local component identity');
  assert.equal(fileA.props.componentProps.path,'first.md');assert.equal(fileB.props.componentProps.path,'second.md');
  const review=view({kind:'review',projectId:'project-a',agentId:'agent-a',path:'review.md'});
  const browser=view({kind:'browser',projectId:'project-a',conversationId:'chat-a'});
  const workA=view({kind:'projectWork',projectId:'project-a',conversationId:'chat-a',focusId:'item-a'});
  const workB=view({kind:'projectWork',projectId:'project-a',conversationId:'chat-a',focusId:'item-b'});
  const agentA=view({kind:'browser',projectId:'project-a',agentId:'agent-a',runId:'run-a'});
  const agentB=view({kind:'browser',projectId:'project-a',agentId:'agent-a',runId:'run-b'});
  for(const a of [fileA,review,browser,workA,agentA])for(const b of [fileA,review,browser,workA,agentA])if(a!==b)assert.notEqual(a.key,b.key,'Different original component families cannot inherit a failed lazy boundary');
  assert.notEqual(workA.key,workB.key,'The original project/chat/focus key still resets the OUTER work boundary');
  assert.notEqual(agentA.key,agentB.key,'The original Agent/Run key still resets the OUTER browser boundary');
  assert.equal(agentA.props.componentProps.agentId,'agent-a');assert.equal(agentB.props.componentProps.runId,'run-b');
  assert.equal(workB.props.componentProps.focus.id,'item-b');
  assert.equal(fileA.props.load,fileB.props.load);assert.equal(agentA.props.load,agentB.props.load);
 }finally{f.close();}
});
