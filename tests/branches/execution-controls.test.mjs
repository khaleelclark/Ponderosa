import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import '../shared/web-typescript-loader.mjs';

const require=createRequire(new URL('../../apps/web/package.json',import.meta.url)),ts=require('typescript');
const compile=path=>ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const presentation={exports:{}};
vm.runInNewContext(compile('../../apps/web/src/components/branches/budgetPresentation.ts'),{exports:presentation.exports});
const {budgetPresentation}=presentation.exports;
const budget=()=>({branchId:'owner',revision:3,periodId:'period-3',policy:{limit:10,period:'day'},used:4,allowance:2,heldCount:1,resetsAt:'2026-11-01T00:00:00.000Z'});

function nodes(tree){if(!tree||typeof tree!=='object')return [];if(Array.isArray(tree))return tree.flatMap(nodes);return [tree,...nodes(tree.props?.children),...nodes(tree.props?.control),...nodes(tree.props?.action)];}
function text(tree){if(tree==null||typeof tree==='boolean')return '';if(Array.isArray(tree))return tree.map(text).join('');if(typeof tree==='object')return text(tree.props?.children);return String(tree);}

// Run the shipped owner with controlled query/transport state. Mutation payloads,
// draft hydration, action eligibility and uncertain retries remain its real code.
function budgetOwner(){
 const cells=[],writes=[],invalidations=[],guards=new Map(),notices=[];let cursor=0,changed=false,key=0;
 const state=initial=>{const i=cursor++;if(!(i in cells))cells[i]=typeof initial==='function'?initial():initial;return [cells[i],value=>{const next=typeof value==='function'?value(cells[i]):value;if(!Object.is(next,cells[i])){cells[i]=next;changed=true}}]};
 const effects=[];
 const react={useState:state,useRef:value=>state(()=>({current:value}))[0],useEffect:(run,deps)=>{const [prior,setPrior]=state();if(!prior||deps.some((value,i)=>!Object.is(value,prior[i]))){setPrior(deps);effects.push(run)}}};
 const scope={query:{data:budget(),isFetching:false,error:null,refetch:async()=>{}},queryOptions:undefined,response:undefined,failure:undefined};
 class ApiRequestError extends Error{constructor(status,message){super(message);this.status=status}}
 const mutations=[];
 const useMutation=options=>{
  const [mutation]=state(()=>({isPending:false,error:null,reset(){this.error=null},async mutateAsync(){this.isPending=true;this.error=null;try{const value=await mutation.options.mutationFn();await mutation.options.onSuccess?.(value);return value}catch(error){this.error=error;await mutation.options.onError?.(error);throw error}finally{this.isPending=false}},mutate(){this.promise=this.mutateAsync();this.promise.catch(()=>{})}}));
  mutation.options=options;mutations.push(mutation);return mutation;
 };
 const module={exports:{}};
 vm.runInNewContext(compile('../../apps/web/src/components/branches/BranchExecutionBudget.tsx'),{exports:module.exports,JSON,Number,Boolean,String,Date,Error,require:name=>{
  if(name==='react')return react;
  if(name==='react/jsx-runtime')return require(name);
  if(name==='@mui/material')return Object.fromEntries(['Alert','Button','Dialog','DialogActions','DialogContent','DialogTitle','FormControlLabel','MenuItem','Paper','Stack','Switch','TextField','Typography'].map(name=>[name,name]));
  if(name==='@tanstack/react-query')return {useQuery:options=>{scope.queryOptions=options;return scope.query},useQueryClient:()=>({invalidateQueries:input=>{invalidations.push(input);return Promise.resolve()}}),useMutation};
  if(name==='../../clientId')return {createClientId:()=>`command-${++key}`};
  if(name==='../../api/types')return {ApiRequestError};
  if(name==='../../api/real')return {requestJson:async(path,init)=>{writes.push({path,...init,body:JSON.parse(init.body)});if(scope.failure)throw scope.failure;return scope.response??{...scope.query.data,revision:scope.query.data.revision+1,policy:writes.at(-1).body.policy??scope.query.data.policy}}};
  if(name==='../MutationNotifications')return {useMutationNotification:()=>notice=>notices.push(notice)};
  if(name==='./BranchNavigation')return {useBranchDraftGuard:(id,dirty)=>guards.set(id,dirty)};
  if(name==='./budgetPresentation')return presentation.exports;
  throw Error(name);
 }});
 let tree;
 const render=(props={})=>{let passes=0;do{changed=false;cursor=0;mutations.length=0;tree=module.exports.BranchExecutionBudget({branchId:'owner',settings:true,...props});for(const effect of effects.splice(0))effect();assert.ok(++passes<20,'Budget hydration settles');}while(changed);return tree};
 const find=(type,predicate)=>{const match=nodes(render()).find(node=>node.type===type&&predicate(node.props));assert.ok(match,`Missing ${type}`);return match.props};
 return {scope,writes,invalidations,guards,notices,render,ApiRequestError,find,button:label=>find('Button',props=>text(props.children)===label),field:label=>find('TextField',props=>props.label===label),mutation:index=>{render();return mutations[index]}};
}

test('loaded budget presentation stays unchanged during ordinary background refresh',()=>{
 const data=budget();
 assert.deepEqual({...budgetPresentation({data,isFetching:true})},{...budgetPresentation({data,isFetching:false})});
 assert.equal(budgetPresentation({isFetching:true}).message,'Loading automatic execution budget…');
 assert.equal(budgetPresentation({data,error:new Error('offline')}).message,'Budget unavailable');
 assert.equal(budgetPresentation({data:{...data,used:undefined}}).message,'Budget unavailable');
});

test('background budget refresh preserves edits and available actions without dropping real authority guards',()=>{
 const f=budgetOwner();f.render();f.field('Executions per period').onChange({target:{value:'25'}});
 const initial=f.render();assert.equal(f.button('Save budget').disabled,false);assert.equal(f.button('Allow more executions').disabled,false);
 f.scope.query={...f.scope.query,isFetching:true};const refreshing=f.render();
 assert.equal(text(refreshing),text(initial));assert.equal(f.field('Executions per period').value,25);
 assert.equal(f.find('Switch',()=>true).disabled,false);assert.equal(f.button('Save budget').disabled,false);assert.equal(f.button('Allow more executions').disabled,false);
 assert.equal(f.guards.get('branch-execution-budget:owner'),true,'An edited live policy remains navigation-guarded');
 f.render({active:false});assert.equal(f.scope.queryOptions.enabled,false);assert.equal(f.scope.queryOptions.refetchInterval,false);
 f.render({active:true});assert.equal(f.scope.queryOptions.refetchInterval,5000);assert.equal(f.field('Executions per period').value,25,'Returning to Settings retains the mounted draft');
 f.scope.query={...f.scope.query,data:{...budget(),revision:4,periodId:'new-period'}};f.render();
 assert.equal(f.field('Executions per period').value,25,'New authority cannot replace a dirty draft');assert.equal(f.button('Save budget').disabled,true);assert.match(text(f.render()),/Budget changed/);
 f.scope.query={...f.scope.query,error:new Error('Controlled refresh failure')};assert.equal(f.button('Allow more executions').disabled,true);assert.match(text(f.render()),/Budget could not be refreshed/);
});

test('budget saves preserve exact revision, period and command identity after an uncertain response',async()=>{
 const f=budgetOwner();f.render();f.field('Budget period').onChange({target:{value:'week'}});
 f.scope.failure=new Error('Controlled response loss');f.button('Save and start new period').onClick();await assert.rejects(f.mutation(0).promise,/response loss/);
 assert.equal(f.writes.length,1);assert.equal(f.writes[0].body.expectedRevision,3);assert.equal(f.writes[0].body.expectedPeriodId,'period-3');assert.equal(f.writes[0].body.acknowledgeNewPeriod,true);assert.equal(f.writes[0].body.policy.period,'week');
 assert.equal(f.button('Retry budget save').disabled,false);assert.equal(f.field('Budget period').disabled,true);assert.equal(f.guards.get('branch-execution-budget:owner'),true);
 f.scope.query={...f.scope.query,isFetching:true};f.scope.failure=undefined;f.button('Retry budget save').onClick();await f.mutation(0).promise;
 assert.deepEqual(f.writes[1].body,f.writes[0].body);assert.equal(f.notices[0].message,'Settings Saved');
});

test('allowance retains period limits, queue warning and exact safe retry while pending actions stay locked',async()=>{
 const f=budgetOwner();f.render();f.button('Allow more executions').onClick();f.field('Additional executions').onChange({target:{value:'3'}});
 assert.match(text(f.render()),/Eligible waiting work may start immediately/);assert.match(text(f.render()),/expires at rollover/);assert.match(text(f.render()),/Resulting effective limit: 15 executions/);
 f.scope.query={...f.scope.query,isFetching:true};assert.equal(f.button('Allow executions').disabled,false);
 f.scope.failure=new Error('Controlled allowance response loss');f.find('Stack',props=>props.component==='form').onSubmit({preventDefault(){}});
 assert.equal(f.button('Allowing…').disabled,true);assert.equal(f.button('Back').disabled,true);await assert.rejects(f.mutation(1).promise,/response loss/);
 const first=f.writes[0].body;assert.equal(first.expectedRevision,3);assert.equal(first.expectedPeriodId,'period-3');assert.equal(first.additional,3);
 f.scope.query={...f.scope.query,data:{...budget(),revision:4,allowance:9},error:new Error('Readback unavailable')};f.scope.failure=undefined;
 f.find('Stack',props=>props.component==='form').onSubmit({preventDefault(){}});await f.mutation(1).promise;
 assert.deepEqual(f.writes[1].body,first);assert.equal(f.find('Dialog',()=>true).open,false);
});

test('pending and rejected budget updates retain their locks and require current authority before saving again',async()=>{
 const f=budgetOwner();f.render();f.field('Executions per period').onChange({target:{value:'20'}});
 let finish;f.scope.response=new Promise(resolve=>{finish=resolve});f.button('Save budget').onClick();
 assert.equal(f.button('Saving…').disabled,true);assert.equal(f.field('Executions per period').disabled,true);
 finish({...budget(),revision:4,policy:{limit:20,period:'day'}});await f.mutation(0).promise;
 f.scope.query={...f.scope.query,data:{...budget(),revision:4,policy:{limit:20,period:'day'}}};f.render();f.field('Executions per period').onChange({target:{value:'30'}});
 f.scope.failure=new f.ApiRequestError(409,'Controlled revision conflict');f.button('Save budget').onClick();await assert.rejects(f.mutation(0).promise,/revision conflict/);
 f.scope.query={...f.scope.query,data:{...budget(),revision:5,periodId:'period-5'}};f.render();
 assert.equal(f.field('Executions per period').value,30);assert.equal(f.field('Executions per period').disabled,false);assert.equal(f.button('Save budget').disabled,true);
 assert.ok(f.invalidations.some(item=>item.queryKey[0]==='branch-execution-budget'),'A rejected command refreshes canonical budget authority');
 f.button('Load current budget').onClick();assert.equal(f.field('Executions per period').value,10);assert.equal(f.button('Save budget').disabled,true);
});

test('Settings groups existing independent execution owners while preserving portable policies and variables placement',async t=>{
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),{QueryClient,QueryClientProvider}=await import('@tanstack/react-query');
 const {BranchSettings}=await import('../../apps/web/src/components/branches/BranchSettings.tsx'),{MutationNotificationProvider}=await import('../../apps/web/src/components/MutationNotifications.tsx');
 const client=new QueryClient({defaultOptions:{queries:{retry:false,retryOnMount:false,gcTime:Infinity}}});t.after(()=>client.clear());
 const branch={id:'owner',name:'Readable workflow',versionId:'published'};
 client.setQueryData(['branch-execution-budget',branch.id],budget());
 client.setQueryData(['branch-dependencies',branch.id],{calls:[],callers:[]});
 client.setQueryData(['branch-lifecycle-summary',branch.id],{deleting:false,activeExecutions:0,chats:0,callers:[],updates:[],pendingRemoval:[]});
 client.setQueryData(['capability-policy',`/api/branches/${branch.id}/capabilities`],{policy:{scopeId:branch.id,revision:0,restrictedCapabilityIds:[]},effective:{restrictionSources:{}},catalog:[]});
 const html=renderToStaticMarkup(React.createElement(QueryClientProvider,{client},React.createElement(MutationNotificationProvider,null,React.createElement(BranchSettings,{branch,definition:{parameters:{note:{type:'text'}}},active:false,executionSettings:React.createElement('p',null,'Portable definition policy editor')}))));
 assert.match(html,/aria-label="Execution Controls" id="branch-execution-controls" tabindex="-1"/);
 const labels=['Execution Controls','Automatic execution budget','Advanced local execution limits','Portable definition policy editor','Branch capabilities','Dependencies','Delete workflow'];
 assert.ok(labels.every(label=>html.includes(label)));assert.deepEqual(labels.map(label=>html.indexOf(label)),labels.map(label=>html.indexOf(label)).sort((a,b)=>a-b));
 assert.equal((html.match(/Automatic execution budget/g)??[]).length,1);
 assert.equal(client.getQueryCache().find({queryKey:['branch-execution-budget',branch.id]}).options.refetchInterval,false,'Hidden Settings does not keep budget polling active');
 assert.equal(client.getQueryCache().findAll({queryKey:['branch-settings',branch.id]}).length,1,'Local limits and variables reuse the canonical configuration query');
});
