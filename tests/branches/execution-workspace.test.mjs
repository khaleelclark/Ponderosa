import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import '../shared/web-typescript-loader.mjs';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const ts=require('typescript'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const {branchScriptFailureSummary}=require('@ponderosa/core');
const {ApiRequestError}=await import('../../apps/web/src/api/types.ts');
const {ChatMessageBody}=await import('../../apps/web/src/components/chat/ChatMessages.tsx');
const presentation=await import('../../apps/web/src/components/branches/executionPresentation.ts');
const source=await readFile(new URL('../../apps/web/src/components/branches/ExecutionPanel.tsx',import.meta.url),'utf8');

function fixture({actions=[],state='waiting',output='Result with the complete original wording.\nSecond line.',savedView,operationsState='waiting_human'}={}){
 const execution={id:'run-a',branchId:'branch-a',versionId:'saved-version',bindingRevisionId:'binding',occurrenceKey:'manual-intent',input:'Original input',inputHash:'input-hash',state,revision:7,createdAt:'2026-10-26T12:00:00Z',updatedAt:'2026-10-26T12:01:00Z',output,admissionSource:'manual'};
 const step={id:'recent-step',executionId:execution.id,stepId:'review',pathId:'recent-path',invocation:1,state:'completed',input:'Step input'};
 const detail={execution,steps:[step],attempts:[],gates:[],paths:[],resources:[],decisions:[],waits:[]};
 const operations={executionId:execution.id,state:operationsState,label:'Needs Your Review',observedAt:execution.updatedAt,counts:{completed:1,running:0,retrying:0,failed:0,waitingAgent:0,waitingHuman:1,needsReconciliation:0,mapItems:0,mapSettled:0},agentWaits:[],additionalAgentWaits:0};
 const actionPage={executionId:execution.id,revision:7,generation:'checkpoint-7',items:actions};
 const effects=[],slots=[],queries=new Map(),buttons=[],disclosures=[],fields=[],mutations=[],requests=[],focused=[],viewStates=new Map(savedView?[[execution.id,savedView]]:[]),invalidations=[];
 let slot=0,transport=async()=>({}),queryPatch={};
 const hooks={...React,useState(initial){const index=slot++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return[slots[index],next=>slots[index]=typeof next==='function'?next(slots[index]):next]},useRef(initial){const index=slot++;return slots[index]??=( {current:initial} )},useEffect(fn){effects.push(fn)},useLayoutEffect(){}};
 const primitive=name=>props=>{
  if(name==='Button')buttons.push(props);
  if(name==='TextField')fields.push(props);
  if(name==='Box'&&props.component==='details')disclosures.push(props);
  const tag=props.component??(name==='Button'?'button':name==='Typography'?'span':'div');
  return React.createElement(tag,{...(props.id?{id:props.id}:{}),...(props.role?{role:props.role}:{}),...(props['aria-label']?{'aria-label':props['aria-label']}:{}),...(tag==='details'?{open:props.open}:{}),...(props.disabled?{disabled:true}:{})},props.children,name==='Alert'?props.action:null);
 };
 const mui=Object.fromEntries(['Accordion','AccordionDetails','AccordionSummary','Alert','Box','Button','Chip','Dialog','DialogActions','DialogContent','DialogTitle','FormControlLabel','MenuItem','Paper','Stack','Switch','TextField','Typography'].map(name=>[name,primitive(name)]));
 const query=options=>{
  const key=options.queryKey[0];queries.set(key,options);
  let data=key==='branch-execution-operations'?operations:key==='branch-execution-actions'?{pages:[actionPage],pageParams:[undefined]}:undefined;
  return {data,isPending:!data,isFetching:false,isFetchingNextPage:false,error:null,hasNextPage:false,refetch(){},fetchNextPage(){},...queryPatch[key]};
 };
 const scope={exports:{},console,Date,JSON,Map,Set,Error,navigator:{clipboard:{writeText:async()=>{}}},requestAnimationFrame:fn=>{fn();return 1},cancelAnimationFrame(){},document:{getElementById:id=>({scrollIntoView(){focused.push(id)},focus(){focused.push('focus:'+id)}})},require:name=>{
  if(name==='react')return hooks;
  if(name==='@tanstack/react-query')return {useQuery:query,useInfiniteQuery:query,useQueryClient:()=>({invalidateQueries:value=>invalidations.push(value),resetQueries:()=>{throw Error('Refreshing must not reset mounted decisions')}}) ,useMutation:options=>{const mutation={isPending:false,error:null,reset(){},mutate:input=>mutation.mutateAsync(input),async mutateAsync(input){requests.push({mutation:options,input});return options.mutationFn(input)}};mutations.push(mutation);return mutation;}};
  if(name==='@ponderosa/core')return {branchScriptFailureSummary};
  if(name==='@mui/material')return mui;
  if(name.startsWith('@mui/icons-material/'))return {default:()=>null};
  if(name==='../../clientId')return {createClientId:()=> 'same-command'};
  if(name==='../../branchesRouting')return {branchRoutePath:route=>'/branches?'+new URLSearchParams(Object.entries(route))};
  if(name==='../../api/types')return {ApiRequestError};
  if(name==='../../api/real')return {requestJson:async(path,options)=>{requests.push({path,options});return transport(path,options)}};
  if(name==='./BranchGraph')return {BranchGraph:()=>React.createElement('div',null,'Pinned Run Graph And Accessible Outline')};
  if(name==='../chat/ChatMessages')return {ChatMessageBody};
  if(name==='../decisions/DecisionCard')return {DecisionCard:props=>React.createElement('section',{'aria-label':'Shared Decision'},props.decision.question,React.createElement('button',{onClick:props.onResolved},'Resolve Through Existing Decision'))};
  if(name==='../ConfirmationDialogs')return {ConfirmDialog:props=>React.createElement('section',null,props.children)};
  if(name==='./model')return {currentFailedInvocations:()=>[],nodeName:node=>node.label??node.id};
  if(name==='../SemanticStatus')return {SemanticStatus:props=>React.createElement('span',{'data-status':props.status},props.label)};
  if(name==='./executionPresentation')return presentation;
  throw Error('Unexpected dependency '+name);
 }};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{...scope,require:name=>name==='react/jsx-runtime'?require('react/jsx-runtime'):scope.require(name)});
 const props={detail,definition:{name:'Published workflow',entry:'review',steps:[{id:'review',label:'Review Document',kind:'agent'},{id:'older',label:'Earlier Important Step',kind:'script'}],controls:[],edges:[],trigger:{kind:'manual'}},executions:[execution],viewStates,evidenceControls:React.createElement('div',null,'Load Older Evidence'),onBudgetSettings:id=>focused.push('budget:'+id)};
 const render=()=>{slot=0;buttons.length=0;disclosures.length=0;fields.length=0;queries.clear();effects.length=0;return renderToStaticMarkup(React.createElement(scope.exports.ExecutionPanel,props));};
 return {execution,detail,operations,actionPage,queries,buttons,disclosures,fields,requests,focused,invalidations,render,props,flushEffects:()=>effects.splice(0).forEach(fn=>fn()),setTransport:fn=>transport=fn,setQuery:(key,value)=>queryPatch[key]=value,button:label=>buttons.find(button=>button.children===label)};
}
function olderAttempt({unknown=false,current=true,blocked=false}={}){
 const step={id:'older-step',executionId:'run-a',stepId:'older',pathId:'old-path',invocation:3,state:unknown?'outcome_unknown':'failed',input:'Earlier original input'};
 return {kind:'attempt',step,current,attempt:{id:'old-attempt',stepExecutionId:step.id,number:2,state:unknown?'outcome_unknown':'failed',fence:1,error:'Original failure summary',...(blocked?{retryBlockedReason:'Path already advanced'}:{})}};
}

test('selected run keeps canonical status, results and all focused decisions outside one collapsed Technical Details',()=>{
 const old=olderAttempt({unknown:true}),gate={kind:'gate',step:old.step,gate:{id:'gate-a',stepExecutionId:old.step.id,revision:4,state:'waiting',purpose:'approval',prompt:'Approve the original result?',proposal:'Exact proposed result',editable:false}};
 const f=fixture({actions:[gate,old]});
 const html=f.render();
 assert.equal(f.disclosures.length,1);assert.equal(f.disclosures[0].open,false);assert.match(html,/Needs Your Review/);assert.match(html,/Approve the original result/);assert.match(html,/Exact proposed result/);assert.match(html,/Outcome Needs Reconciliation/);assert.match(html,/Result with the complete original wording/);assert.match(html,/Second line/);assert.match(html,/Review Document/);
 assert.ok(html.indexOf('Exact proposed result')<html.indexOf('<details'));assert.ok(html.indexOf('Original failure summary')<html.indexOf('<details'));assert.ok(html.indexOf('Result with the complete original wording')<html.indexOf('<details'));
 assert.doesNotMatch(html,/Pinned Run Graph|Load Older Evidence|Run ID:|For Each items/);
 assert.equal(f.queries.get('branch-step-evidence').enabled,false);assert.equal(f.queries.get('branch-map-item-search').enabled,false);assert.equal(f.queries.get('branch-execution-input').enabled,false);
 assert.ok(f.queries.get('branch-execution-actions'));assert.ok(f.queries.get('branch-execution-operations'));
 assert.ok(f.button('Retry Anyway'));assert.ok(f.button('Mark Observed Result'));
});

test('Inspect Details opens and focuses the exact older invocation and enables its existing evidence query',()=>{
 const f=fixture({actions:[olderAttempt({unknown:true})]});f.render();f.button('Inspect Details').onClick();const html=f.render();
 assert.equal(f.disclosures[0].open,true);assert.match(html,/Pinned Run Graph And Accessible Outline/);assert.match(html,/Load Older Evidence/);assert.match(html,/Run ID: run-a/);assert.match(html,/branch-step-older-step/);
 assert.equal(f.queries.get('branch-step-evidence').enabled,true);assert.deepEqual(Array.from(f.queries.get('branch-step-evidence').queryKey),['branch-step-evidence','run-a','older-step']);
 assert.deepEqual(f.focused,['branch-step-older-step','focus:branch-step-older-step']);
 f.disclosures[0].onToggle({currentTarget:{open:false}});f.render();assert.equal(f.queries.get('branch-step-evidence').enabled,false);
});

test('a blocked historical failure remains evidence without becoming another action or changing run state',()=>{
 const f=fixture({actions:[olderAttempt({current:false,blocked:true})],state:'completed',operationsState:'completed'});f.operations.label='Completed';
 const html=f.render();assert.match(html,/Completed/);assert.match(html,/Earlier Step Failure/);assert.match(html,/Path already advanced/);assert.ok(f.button('Inspect Details'));assert.equal(f.button('Retry Step'),undefined);assert.equal(f.execution.state,'completed');assert.equal(f.disclosures[0].open,false);
});

test('focused action pages reject foreign or mixed revisions and retain explicit pagination and unavailable feedback',async()=>{
 const f=fixture({actions:[olderAttempt()]});f.setQuery('branch-execution-actions',{hasNextPage:true});f.render();assert.ok(f.button('Load More Decisions And Failures'));
 const owner={id:'run-a',revision:7},good={executionId:'run-a',revision:7,generation:'checkpoint-7',items:[olderAttempt()]};
 assert.equal(presentation.currentExecutionActions(owner,[good,good]).length,1);
 for(const patch of [{executionId:'foreign'},{revision:6},{revision:8},{generation:'later-checkpoint'}])assert.equal(presentation.currentExecutionActions(owner,[good,{...good,...patch}]),undefined);
 for(const patch of [{executionId:'foreign'},{revision:8}]){f.setTransport(async()=>({...good,...patch}));await assert.rejects(f.queries.get('branch-execution-actions').queryFn({}),/run changed/);}
 f.actionPage.revision=6;f.setQuery('branch-execution-actions',{error:Error('Unable to refresh current decisions')});const html=f.render();assert.match(html,/Decisions and failures could not refresh/);assert.ok(f.button('Refresh Run'));assert.equal(f.button('Retry Step').disabled,true,'Cached evidence must not grant stale Branch intervention authority');
});

test('required action and status loading never become an empty or completed assertion',()=>{
 const f=fixture();f.setQuery('branch-execution-actions',{data:undefined,isPending:true});f.setQuery('branch-execution-operations',{data:undefined,isPending:true});const html=f.render();
 assert.match(html,/Loading current decisions and failures/);assert.match(html,/Loading run status/);assert.doesNotMatch(html.replace(/<style[^>]*>[\s\S]*?<\/style>/g,''),/No decisions|All done|100%/);
});

test('budget and provider controls use canonical run ownership without changing or starting work',()=>{
 const f=fixture({operationsState:'provider_unavailable'});f.operations.label='Provider Unavailable';f.execution.budgetWait={kind:'execution_budget',branchId:'called-branch'};
 const html=f.render();assert.match(html,/Waiting For Budget/);assert.ok(f.button('Open Provider Settings'));f.button('Budget Settings').onClick();assert.deepEqual(f.focused,['budget:called-branch']);assert.equal(f.requests.length,0);assert.equal(f.disclosures[0].open,false);
});

test('full ordinary and joined results stay in the main surface and reuse their existing exact routes',async()=>{
 const f=fixture();f.detail.executionOutputTruncated=true;f.render();assert.equal(f.queries.get('branch-execution-output').enabled,false);f.button('Show full result').onClick();
 const complete='🙂'.repeat(400)+' FINAL FACT PRESERVED';f.setQuery('branch-execution-output',{data:{output:complete},isPending:false});const html=f.render();assert.match(html,/FINAL FACT PRESERVED/);assert.ok(html.indexOf('FINAL FACT PRESERVED')<html.indexOf('<details'));assert.equal(f.disclosures[0].open,false);
 f.setTransport(async path=>{assert.equal(path,'/api/branch-executions/run-a/result');return {output:complete}});assert.equal((await f.queries.get('branch-execution-output').queryFn()).output,complete);
 const joined=fixture();joined.execution.id='11111111-1111-1111-1111-111111111111';joined.execution.output='branch-result-bundle:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222';joined.render();joined.button('Show full joined text').onClick();joined.setQuery('branch-result-bundle',{data:{content:complete,contentHash:'hash'},isPending:false});const bundle=joined.render();assert.match(bundle,/FINAL FACT PRESERVED/);assert.ok(bundle.indexOf('FINAL FACT PRESERVED')<bundle.indexOf('<details'));assert.equal(joined.queries.get('branch-result-bundle').enabled,true);
 const foreign=fixture({output:'branch-result-bundle:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222'});foreign.render();assert.equal(foreign.queries.get('branch-result-bundle').enabled,false,'An authored marker for another run cannot fetch that run as this result');
});

test('opening diagnostics preserves raw Script evidence, receipts, resolved decisions and existing full evidence route',()=>{
 const action=olderAttempt({unknown:true}),f=fixture({actions:[action]});f.detail.resources=[{stepExecutionId:'older-step',agentIds:['agent-a'],state:'cleanup_pending',error:'Cleanup must finish'}];f.detail.gates=[{id:'resolved',state:'resolved',prompt:'Recorded approval',resolution:{decision:'approve',output:'Accepted exact result'}}];
 f.render();f.button('Inspect Details').onClick();f.setQuery('branch-step-evidence',{data:{stepExecutionId:'older-step',input:'Exact input Ω',attempts:[{...action.attempt,scriptEvidence:{runtime:'Node.js',code:7,stderr:'Exact stderr Ω',stdout:'Exact stdout 🙂',cwd:'/owned-fixture',finishedAt:f.execution.updatedAt}}],sealedResult:{id:'seal',terminalAttemptId:'old-attempt',contentHash:'sealed-hash'}},isPending:false});
 const html=f.render();for(const value of ['Exact input Ω','Exact stderr Ω','Exact stdout 🙂','Exit code: 7','Accepted exact result','Cleanup must finish','Published version: saved-version'])assert.ok(html.includes(value),value);
 const link=f.button('Open Full Evidence (JSON)');assert.equal(link.href,'/api/branch-executions/run-a/full-detail');assert.equal(link.target,'_blank');
});

test('a saved open technical view restores only its own selection and does not activate work',()=>{
 const saved={selected:'review',selectedInvocation:'recent-step',itemSearch:'late fact',itemFilter:'all',itemSort:'index',itemLimit:100,callsExpanded:false,showBundle:false,showFullOutput:false,technicalOpen:true};
 const f=fixture({savedView:saved});f.render();assert.equal(f.disclosures[0].open,true);assert.equal(f.queries.get('branch-step-evidence').enabled,true);assert.equal(f.queries.get('branch-map-item-search').enabled,true);assert.equal(f.requests.length,0);
 const other=fixture();other.render();assert.equal(other.disclosures[0].open,false);assert.equal(other.queries.get('branch-step-evidence').enabled,false);
});

test('operational status refuses another run and background refresh errors preserve the last known projection',async()=>{
 const f=fixture();f.render();f.setTransport(async()=>({...f.operations,executionId:'other-run'}));await assert.rejects(f.queries.get('branch-execution-operations').queryFn(),/another run/);
 f.setQuery('branch-execution-operations',{error:Error('Temporary status connection failure')});const html=f.render();assert.match(html,/Needs Your Review/);assert.match(html,/Run status could not refresh/);assert.match(html,/Temporary status connection failure/);assert.equal(f.disclosures[0].open,false);assert.ok(f.button('Retry Status'));
});

test('a changed Run revision refetches its stable actions owner without clearing mounted decision forms',()=>{
 const f=fixture({actions:[olderAttempt()]});f.execution.revision=8;
 f.render();f.flushEffects();assert.equal(f.invalidations.length,1);assert.deepEqual(Array.from(f.invalidations[0].queryKey),['branch-execution-actions','run-a']);assert.equal(f.invalidations[0].exact,true);assert.equal(f.disclosures[0].open,false);assert.equal(f.execution.output,'Result with the complete original wording.\nSecond line.');assert.equal(f.requests.length,0);
 const unavailable=fixture();unavailable.setQuery('branch-execution-actions',{error:new ApiRequestError(503,'Unavailable')});unavailable.render();unavailable.flushEffects();assert.equal(unavailable.invalidations.length,0,'Ordinary failures remain visible without a blind reset loop');
});

test('Merge discovers paged canonical candidates only on demand, independently of the visible history filter',async()=>{
 const f=fixture();f.props.executions=[];f.render();assert.equal(f.queries.get('branch-merge-targets').enabled,false);assert.ok(f.button('Merge Into Another Run'));assert.equal(f.button('Merge Into Another Run').disabled,false);
 f.button('Merge Into Another Run').onClick();let html=f.render();assert.equal(f.queries.get('branch-merge-targets').enabled,true);assert.match(html,/Loading eligible runs/);
 const completed={...f.execution,id:'completed-target',state:'completed',createdAt:'2026-10-25T01:00:00Z'};f.setQuery('branch-merge-targets',{data:{pages:[[completed]],pageParams:[undefined]},isPending:false,hasNextPage:true});html=f.render();assert.match(html,/completed/);assert.ok(f.button('Load Older Runs'));
 const field=f.fields.find(field=>field.label==='Keep this execution');field.onChange({target:{value:'completed-target'}});f.render();assert.equal(f.fields.find(field=>field.label==='Keep this execution').value,'completed-target');
 const query=f.queries.get('branch-merge-targets');f.setTransport(async path=>{assert.equal(path,'/api/branches/branch-a/executions?mergeFor=run-a&before=older-cursor');return [completed]});assert.equal((await query.queryFn({pageParam:'older-cursor'}))[0].id,'completed-target');assert.equal(query.getNextPageParam(Array.from({length:100},(_,i)=>({...completed,id:'candidate-'+i}))),'candidate-99');assert.equal(query.getNextPageParam([completed]),undefined);
 f.setQuery('branch-merge-targets',{data:{pages:[[completed]]},error:Error('Candidate list unavailable'),isPending:false});html=f.render();assert.match(html,/Eligible runs could not be loaded/);assert.match(html,/Candidate list unavailable/);assert.ok(f.button('Retry Eligible Runs'));assert.equal(f.fields.find(field=>field.label==='Keep this execution').value,'completed-target','A failed refresh cannot silently erase a selected or uncertain intervention target');
 const empty=fixture();empty.render();empty.button('Merge Into Another Run').onClick();empty.setQuery('branch-merge-targets',{data:{pages:[[]]},isPending:false});assert.match(empty.render(),/No eligible runs are currently available/);
});

test('Script failure summaries keep the existing exit-code interpretation ahead of stdout and supplied Run links remain main',()=>{
 const action=olderAttempt();action.attempt.error=undefined;action.attempt.scriptEvidence={code:7,stdout:'Ordinary output is not the failure explanation'};action.attempt.result={failed:true,output:'Ordinary stdout'};
 const f=fixture({actions:[action]});f.props.runLinks=React.createElement('a',{href:'/exact-run-chat'},'Open Exact Run Chat');const html=f.render();
 assert.match(html,/Script exited with code 7. Inspect Step evidence for error output/);assert.ok(html.indexOf('Open Exact Run Chat')<html.indexOf('<details'));assert.equal(f.disclosures[0].open,false);assert.equal(f.requests.length,0);
});


test('main results reuse shared Markdown for authored download links without guessing a result project owner',()=>{
 const url='/api/branches/engine/projects/own-project/artifacts/own-file/download';
 const f=fixture({output:`Report ready. [Download report](${url})`}),html=f.render();
 assert.ok(html.includes('href="'+url+'"'));assert.ok(html.includes('Download report'));assert.ok(html.indexOf('href="'+url+'"')<html.indexOf('<details'));
 const unsafe=fixture({output:'[Unsupported](javascript:alert(1)) [Unscoped legacy](ponderosa://artifact/opaque)'}).render();assert.doesNotMatch(unsafe,/href="(?:javascript:|ponderosa:)/);
});

test('canonical Agent decisions use the existing shared DecisionCard before Technical Details',()=>{
 const decision={id:'exact-agent-decision',projectId:'actual-project',agentId:'actual-agent',coordinationRunId:'actual-scheduler-run',mode:'text',question:'Which report should I publish?',options:[],allowOther:true,status:'pending'};
 const f=fixture({actions:[{kind:'decision',decision}]}),html=f.render();assert.match(html,/Shared Decision/);assert.ok(html.indexOf(decision.question)<html.indexOf('<details'));
 assert.equal(presentation.currentExecutionActions(f.execution,[f.actionPage,f.actionPage]).length,1);
});


test('a pending Decision remains in the same render position across revision refresh and failed refresh',()=>{
 const decision={id:'decision-b',projectId:'owned-project',agentId:'reviewer',question:'Preserve this open answer',mode:'text',options:[],allowOther:true,status:'pending'};
 const f=fixture({actions:[{kind:'decision',decision},olderAttempt()]});f.render();const key=[...f.queries.get('branch-execution-actions').queryKey];
 f.execution.revision++;const refreshing=f.render();assert.match(refreshing,/Preserve this open answer/);assert.match(refreshing,/Your open decisions are kept/);assert.equal(f.button('Retry Step').disabled,true);assert.deepEqual([...f.queries.get('branch-execution-actions').queryKey],key);f.flushEffects();
 f.setQuery('branch-execution-actions',{error:new ApiRequestError(409,'Actions changed')});const failed=f.render();assert.match(failed,/Preserve this open answer/);assert.match(failed,/could not refresh/);assert.equal(f.button('Retry Step').disabled,true);
});

test('React Query refetch retains coherent loaded action pages when a later cursor conflicts',async t=>{
 const {QueryClient,InfiniteQueryObserver}=require('@tanstack/react-query');let fail=false;const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}}),key=['branch-execution-actions','run-a'];
 const queryFn=async({pageParam})=>{if(fail&&pageParam)throw new ApiRequestError(409,'Changed cursor');return{executionId:'run-a',revision:7,generation:fail?'new':'old',items:[{kind:'decision',decision:{id:pageParam?'decision-b':'decision-a'}}],nextCursor:pageParam?undefined:'older'}};
 const observer=new InfiniteQueryObserver(client,{queryKey:key,initialPageParam:undefined,queryFn,getNextPageParam:page=>page.nextCursor}),unsubscribe=observer.subscribe(()=>{});t.after(()=>{unsubscribe();client.clear()});
 await observer.refetch();await observer.fetchNextPage();const before=client.getQueryData(key);assert.equal(before.pages.length,2);fail=true;await observer.refetch();assert.equal(client.getQueryData(key),before,'Failed refresh must retain the exact previous coherent pages, not destroy forms or mix generations');
 assert.equal(observer.getCurrentResult().isError,true);assert.equal(observer.getCurrentResult().data.pages[1].items[0].decision.id,'decision-b');
});
