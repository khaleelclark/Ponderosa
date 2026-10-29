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
const {previewBranchExecutionActions}=await import('../../apps/server/src/branch-detail-preview.ts');
const source=await readFile(new URL('../../apps/web/src/components/branches/ExecutionPanel.tsx',import.meta.url),'utf8');

function fixture({actions=[],state='waiting',output='Result with the complete original wording.\nSecond line.',savedView,operationsState='waiting_human'}={}){
 const execution={id:'run-a',branchId:'branch-a',versionId:'saved-version',bindingRevisionId:'binding',occurrenceKey:'manual-intent',input:'Original input',inputHash:'input-hash',state,revision:7,createdAt:'2026-10-26T12:00:00Z',updatedAt:'2026-10-26T12:01:00Z',output,admissionSource:'manual'};
 const step={id:'recent-step',executionId:execution.id,stepId:'review',pathId:'recent-path',invocation:1,state:'completed',input:'Step input'};
 const detail={execution,steps:[step],attempts:[],gates:[],paths:[],resources:[],decisions:[],waits:[]};
 const operations={executionId:execution.id,state:operationsState,label:'Needs Your Review',observedAt:execution.updatedAt,counts:{completed:1,running:0,retrying:0,failed:0,waitingAgent:0,waitingHuman:1,needsReconciliation:0,mapItems:0,mapSettled:0},agentWaits:[],additionalAgentWaits:0};
 const actionPage={executionId:execution.id,revision:7,generation:'checkpoint-7',items:actions};
 const effects=[],slots=[],queries=new Map(),buttons=[],disclosures=[],fields=[],mutations=[],requests=[],focused=[],refetches=[],viewStates=new Map(savedView?[[execution.id,savedView]]:[]),invalidations=[];
 let slot=0,transport=async()=>({}),queryPatch={};
 const hooks={...React,useState(initial){const index=slot++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return[slots[index],next=>slots[index]=typeof next==='function'?next(slots[index]):next]},useRef(initial){const index=slot++;return slots[index]??=( {current:initial} )},useEffect(fn,deps){const index=slot++,previous=slots[index];if(!previous||!deps||deps.some((value,i)=>value!==previous[i])){slots[index]=deps;effects.push(fn)}},useLayoutEffect(){}};
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
  return {data,isPending:!data,isFetching:false,isFetchingNextPage:false,error:null,hasNextPage:false,refetch(){refetches.push(key)},fetchNextPage(){},...queryPatch[key]};
 };
 const queryClient={invalidateQueries:value=>invalidations.push(value),resetQueries:()=>{throw Error('Refreshing must not reset mounted decisions')}};
 const scope={exports:{},console,Date,JSON,Map,Set,Error,navigator:{clipboard:{writeText:async()=>{}}},requestAnimationFrame:fn=>{fn();return 1},cancelAnimationFrame(){},document:{getElementById:id=>({scrollIntoView(){focused.push(id)},focus(){focused.push('focus:'+id)}})},require:name=>{
  if(name==='react')return hooks;
  if(name==='@tanstack/react-query')return {useQuery:query,useInfiniteQuery:query,useQueryClient:()=>queryClient,useMutation:options=>{const mutation={isPending:false,error:null,reset(){},mutate:input=>mutation.mutateAsync(input),async mutateAsync(input){requests.push({mutation:options,input});return options.mutationFn(input)}};mutations.push(mutation);return mutation;}};
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
 return {execution,detail,operations,actionPage,queries,buttons,disclosures,fields,requests,focused,refetches,invalidations,render,props,flushEffects:()=>effects.splice(0).forEach(fn=>fn()),setTransport:fn=>transport=fn,setQuery:(key,value)=>queryPatch[key]=value,button:label=>buttons.find(button=>button.children===label)};
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
 const f=fixture();f.detail.executionOutputTruncated=true;f.render();assert.equal(f.queries.get('branch-execution-output').enabled,true,'Selected truncated output loads without another click');
 const complete='🙂'.repeat(400)+' FINAL FACT PRESERVED';f.setQuery('branch-execution-output',{data:{output:complete},isPending:false});const html=f.render();assert.match(html,/FINAL FACT PRESERVED/);assert.ok(html.indexOf('FINAL FACT PRESERVED')<html.indexOf('<details'));assert.equal(f.disclosures[0].open,false);
 f.setTransport(async path=>{assert.equal(path,'/api/branch-executions/run-a/result');return {output:complete}});assert.equal((await f.queries.get('branch-execution-output').queryFn()).output,complete);
 const joined=fixture();joined.execution.id='11111111-1111-1111-1111-111111111111';joined.execution.output='branch-result-bundle:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222';joined.render();assert.equal(joined.queries.get('branch-result-bundle').enabled,true,'Selected joined output loads without another click');joined.setQuery('branch-result-bundle',{data:{content:complete,contentHash:'hash'},isPending:false});const bundle=joined.render();assert.match(bundle,/FINAL FACT PRESERVED/);assert.ok(bundle.indexOf('FINAL FACT PRESERVED')<bundle.indexOf('<details'));assert.equal(joined.queries.get('branch-result-bundle').enabled,true);
 const foreign=fixture({output:'branch-result-bundle:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222'});foreign.render();assert.equal(foreign.queries.get('branch-result-bundle').enabled,false,'An authored marker for another run cannot fetch that run as this result');
});

test('selected result errors offer inline retry and retain already-loaded text through background failure',()=>{
 const f=fixture();f.detail.executionOutputTruncated=true;
 assert.match(f.render(),/Loading complete result/);
 f.setQuery('branch-execution-output',{data:undefined,error:Error('Read unavailable'),isPending:false});let html=f.render();
 assert.match(html,/complete result could not be loaded/);assert.match(html,/complete original wording/);f.button('Retry Result').onClick();assert.deepEqual(f.refetches,['branch-execution-output']);
 f.setQuery('branch-execution-output',{data:{output:'Previously loaded exact result Ω',requestedRevision:7},error:Error('Refresh failed'),isPending:false});html=f.render();f.flushEffects();
 assert.match(html,/Previously loaded exact result Ω/);assert.match(html,/Showing the last loaded text/);
 const count=()=>f.invalidations.filter(value=>value.queryKey[0]==='branch-execution-output').length;
 const before=count();f.render();f.flushEffects();assert.equal(count(),before,'Ordinary rerenders do not loop failed refetches');
 const joined=fixture({output:'branch-result-bundle:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222'});joined.execution.id='11111111-1111-1111-1111-111111111111';joined.setQuery('branch-result-bundle',{error:Error('Bundle read failed'),isPending:false});assert.match(joined.render(),/joined result could not be loaded/);joined.button('Retry Result').onClick();assert.deepEqual(joined.refetches,['branch-result-bundle']);
});

test('a Run advancing during result fetch refreshes the existing query without discarding cached output or looping',async()=>{
 const f=fixture({state:'running'});f.detail.executionOutputTruncated=true;f.render();f.flushEffects();
 let complete;f.setTransport(()=>new Promise(resolve=>{complete=resolve}));
 const pending=f.queries.get('branch-execution-output').queryFn();f.execution.revision=8;f.render();f.flushEffects();
 complete({output:'Complete result for the earlier request'});const earlier=await pending;assert.equal(earlier.requestedRevision,7);
 f.setQuery('branch-execution-output',{data:earlier,isPending:false,isFetching:true});assert.match(f.render(),/Complete result for the earlier request/);f.flushEffects();
 const invalidations=()=>f.invalidations.filter(value=>value.queryKey[0]==='branch-execution-output');assert.equal(invalidations().length,1);assert.equal(invalidations()[0].exact,true);
 f.setQuery('branch-execution-output',{data:earlier,isPending:false,isFetching:false,error:Error('Retry unavailable')});f.render();f.flushEffects();f.render();f.flushEffects();assert.equal(invalidations().length,1,'Failed refresh keeps cached output and does not blindly retry');
 f.setTransport(async()=>({output:'Newest complete result'}));const newest=await f.queries.get('branch-execution-output').queryFn();assert.equal(newest.requestedRevision,8);
 f.setQuery('branch-execution-output',{data:newest,isPending:false});assert.match(f.render(),/Newest complete result/);f.flushEffects();assert.equal(invalidations().length,1);
});

test('exceptionally large joined results reuse shared progressive expansion while normal results remain readable',()=>{
 const f=fixture({output:'branch-result-bundle:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222'});f.execution.id='11111111-1111-1111-1111-111111111111';
 const content='Readable joined report.\n'.repeat(1000)+'COMPLETE LAST FACT';f.setQuery('branch-result-bundle',{data:{content,contentHash:'original'},isPending:false});
 const html=f.render();assert.match(html,/Show Full Message/);assert.doesNotMatch(html,/COMPLETE LAST FACT/);assert.equal(f.queries.get('branch-result-bundle').enabled,true);
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

// Keep the real mutation owner and shared dialog callbacks in this regression;
// the transport alone models an accepted command whose response was lost.
async function interventionIntentFixture(t,action,{failure=new Error('Response lost')}={}){
 const {QueryClient,MutationObserver}=require('@tanstack/react-query');
 const ast=ts.createSourceFile('ExecutionPanel.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),declarations=new Map();let dialog;
 function visit(node){if(ts.isVariableDeclaration(node))declarations.set(node.name.getText(ast),node);if(ts.isBinaryExpression(node)&&node.left.getText(ast)==='intervention'&&ts.isJsxElement(node.right)&&node.right.openingElement.tagName.getText(ast)==='ConfirmDialog')dialog=node.getText(ast);ts.forEachChild(node,visit)}visit(ast);assert.ok(dialog);
 const bodies=[],refreshes=[],setters=[],scope={React,ApiRequestError,JSON,Date,Error,execution:{id:'exact-run',revision:7,parentExecutionId:'parent'},intervention:{action,...(['retry','resolve_script'].includes(action)?{attemptId:'exact-attempt',unknown:true}:{}),...(action==='resolve_schedule_update'?{occurrenceId:'exact-occurrence'}:{})},updateApplied:'not_applied',reason:'Verified exact reason',reconciled:true,result:'Exact observed output',failed:true,target:'exact-target',commandKey:'original-command',actionsCurrent:true,mergeTargets:{data:{},isPending:false,error:null,hasNextPage:false},executions:[{id:'exact-target',state:'completed',createdAt:'2026-10-26T00:00:00Z'}],detail:{attempts:[],steps:[]},attentionAttempts:[],refresh:()=>refreshes.push('refresh'),createClientId:()=>{setters.push('new-key');return 'new-command'},inspectStep(){}};
 for(const name of ['intervention','updateApplied','reason','reconciled','result','failed','target','commandKey'])scope['set'+name[0].toUpperCase()+name.slice(1)]=value=>{setters.push(name);scope[name]=value;};
 for(const name of ['ConfirmDialog','Stack','Alert','Typography','Button','TextField','MenuItem','FormControlLabel','Switch'])scope[name]=name;
 let release;
 scope.requestJson=async(path,options)=>{bodies.push({path,body:options.body});if(bodies.length===1)await new Promise((_resolve,reject)=>{release=()=>reject(failure)});return {accepted:true};};
 const load=text=>vm.runInContext(ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText,context);
 const context=vm.createContext(scope),client=new QueryClient({defaultOptions:{mutations:{retry:false,gcTime:Infinity}}});
 const options=load('('+declarations.get('act').initializer.arguments[0].getText(ast)+')'),observer=new MutationObserver(client,options),unsubscribe=observer.subscribe(()=>{});
 t.after(()=>{unsubscribe();client.clear()});
 const refresh=()=>{scope.act={...observer.getCurrentResult(),mutateAsync:observer.mutate.bind(observer),reset:observer.reset.bind(observer)};for(const name of ['interventionUnconfirmed','interventionLocked','submitIntervention','open'])load('globalThis.'+name+'='+declarations.get(name).initializer.getText(ast));};
 const children=tree=>tree&&typeof tree==='object'?[tree,...React.Children.toArray(tree.props?.children).flatMap(children)]:[];
 const render=()=>{refresh();const root=load('('+dialog+')');return{root,nodes:children(root)}};
 refresh();
 return {scope,bodies,refreshes,setters,refresh,render,release:()=>release(),submit:()=>{refresh();return scope.submitIntervention()}};
}

for(const action of ['retry','resolve_script','resolve_schedule_update','merge','skip'])test('uncertain '+action+' replays byte-identical intervention after polling advances the Run revision',async t=>{
 const f=await interventionIntentFixture(t,action),pending=f.submit();await new Promise(resolve=>setImmediate(resolve));f.refresh();assert.equal(f.scope.interventionLocked,true);
 f.release();await assert.rejects(pending,/Response lost/);f.scope.execution.revision=12;
 const view=f.render();assert.equal(f.scope.interventionUnconfirmed,true);assert.equal(view.root.props.confirmDisabled,false,'A newer revision cannot block exact idempotent readback');
 assert.equal(view.root.props.error,'Response lost');assert.equal(view.root.props.pending,false);assert.equal(view.root.props.onConfirm,f.scope.submitIntervention);
 const before={updateApplied:f.scope.updateApplied,reason:f.scope.reason,result:f.scope.result,target:f.scope.target,reconciled:f.scope.reconciled,failed:f.scope.failed,commandKey:f.scope.commandKey};
 for(const node of view.nodes.filter(node=>node.type==='TextField')){assert.equal(node.props.disabled,true);node.props.onChange?.({target:{value:'Must not replace the submitted value'}});}
 for(const node of view.nodes.filter(node=>node.type==='FormControlLabel')){const control=node.props.control;assert.equal(control.props.disabled,true);control.props.onChange(null,false);}
 assert.deepEqual({updateApplied:f.scope.updateApplied,reason:f.scope.reason,result:f.scope.result,target:f.scope.target,reconciled:f.scope.reconciled,failed:f.scope.failed,commandKey:f.scope.commandKey},before);
 view.root.props.onCancel();f.refresh();f.scope.open({action:action==='skip'?'merge':'skip'});assert.equal(f.scope.intervention.action,action);assert.equal(f.scope.commandKey,'original-command');assert.ok(!f.setters.includes('new-key'),'Reopening uncertain work cannot replace the original command identity');
 await f.submit();assert.equal(f.bodies.length,2);assert.deepEqual(f.bodies[1],f.bodies[0]);const payload=JSON.parse(f.bodies[0].body);assert.equal(payload.expectedRevision,7);assert.equal(payload.commandKey,'original-command');assert.equal(payload.action,action);if(action==='resolve_script')assert.deepEqual(payload.result,{failed:true,output:'Exact observed output'});if(action==='merge')assert.equal(payload.mergedInto,'exact-target');if(action==='resolve_schedule_update'){assert.equal(payload.occurrenceId,'exact-occurrence');assert.equal(payload.updateApplied,false);assert.equal(payload.externalEffectsReconciled,true);assert.equal(f.scope.intervention,undefined);}
 assert.equal(f.scope.intervention,undefined);assert.deepEqual(f.refreshes,['refresh']);
});

test('known intervention rejection permits review against the current revision while 5xx retains the original intent',async t=>{
 const known=await interventionIntentFixture(t,'retry',{failure:new ApiRequestError(409,'Stale revision')}),first=known.submit();await new Promise(resolve=>setImmediate(resolve));known.release();await assert.rejects(first,/Stale revision/);known.scope.execution.revision=9;
 const view=known.render();assert.equal(known.scope.interventionUnconfirmed,false);assert.equal(known.scope.interventionLocked,false);assert.equal(view.nodes.find(node=>node.type==='TextField'&&node.props.label==='Reason for this decision').props.disabled,false);
 view.nodes.find(node=>node.type==='TextField'&&node.props.label==='Reason for this decision').props.onChange({target:{value:'Reviewed the current revision'}});await known.submit();assert.equal(JSON.parse(known.bodies[1].body).expectedRevision,9);assert.equal(JSON.parse(known.bodies[1].body).reason,'Reviewed the current revision');assert.equal(JSON.parse(known.bodies[1].body).commandKey,'new-command');
 const uncertain=await interventionIntentFixture(t,'skip',{failure:new ApiRequestError(503,'Response unavailable')}),second=uncertain.submit();await new Promise(resolve=>setImmediate(resolve));uncertain.release();await assert.rejects(second,/Response unavailable/);uncertain.refresh();assert.equal(uncertain.scope.interventionUnconfirmed,true);uncertain.scope.execution.revision=14;await uncertain.submit();assert.equal(uncertain.bodies[1].body,uncertain.bodies[0].body);
});


test('an uncertain scheduled update remains actionable without opening Technical Details or inventing completion',()=>{
 const update={kind:'schedule_update',occurrenceId:'own-occurrence',injectionId:'uncertain-injection',eventCount:3,lastScheduledAt:'2026-10-27T12:00:00.000Z'};
 const f=fixture({actions:[update]}),html=f.render();assert.match(html,/Scheduled Update Needs Reconciliation/);assert.match(html,/3 scheduled events/);assert.ok(html.indexOf('Reconcile Scheduled Update')<html.indexOf('<details'));assert.equal(f.disclosures[0].open,false);
 assert.equal(f.queries.get('branch-step-evidence').enabled,false);assert.equal(f.requests.length,0);f.button('Reconcile Scheduled Update').onClick();const dialog=f.render();assert.match(dialog,/Neither choice cancels or restarts the Agent/);assert.match(dialog,/retains one latest check for delivery/);
 const selector=f.fields.find(field=>field.label==='Observed scheduled update outcome');assert.equal(selector.value,'');assert.equal(selector.disabled,true,'No outcome can be selected before inspecting actual effects');selector.onChange({target:{value:'applied'}});f.render();assert.equal(f.fields.find(field=>field.label===selector.label).value,'');assert.equal(f.requests.length,0);
 f.props.authorityFresh=false;f.render();assert.equal(f.button('Reconcile Scheduled Update').disabled,true,'Stale run data cannot authorize reconciliation');
 const page={executionId:f.execution.id,revision:f.execution.revision,generation:'current',items:[update]};assert.equal(presentation.currentExecutionActions(f.execution,[page,page]).length,1);
 const changed={...update,injectionId:'replacement-injection'};assert.equal(presentation.currentExecutionActions(f.execution,[page,{...page,items:[changed]}]).length,2,'Different uncertainty evidence must never be collapsed into the old injection');
 const preview=previewBranchExecutionActions(page);assert.deepEqual(preview.items,[update]);assert.equal(preview.largeEvidenceOmitted,undefined);
});

test('scheduled update reconciliation requires an observed outcome, checked effects and reason while reusing the shared dialog',async t=>{
 const f=await interventionIntentFixture(t,'resolve_schedule_update');f.scope.updateApplied='';f.scope.reconciled=false;f.scope.reason='';
 let view=f.render();assert.equal(view.root.props.title,'Reconcile Scheduled Update');assert.equal(view.root.props.confirmDisabled,true);assert.equal(f.bodies.length,0);
 const outcome=()=>view.nodes.find(node=>node.type==='TextField'&&node.props.label==='Observed scheduled update outcome');assert.equal(outcome().props.disabled,true);outcome().props.onChange({target:{value:'applied'}});assert.equal(f.scope.updateApplied,'');
 const confirmation=view.nodes.find(node=>node.type==='FormControlLabel'&&node.props.label==='I have checked and reconciled the scheduled update’s effects');assert.ok(confirmation);confirmation.props.control.props.onChange(null,true);
 view=f.render();assert.equal(outcome().props.disabled,false);outcome().props.onChange({target:{value:'applied'}});view=f.render();assert.equal(view.root.props.confirmDisabled,true,'A reason is still required');
 view.nodes.find(node=>node.type==='TextField'&&node.props.label==='Reason for this decision').props.onChange({target:{value:'Verified actual Agent output and external effects'}});view=f.render();assert.equal(view.root.props.confirmDisabled,false);
 const pending=view.root.props.onConfirm();await new Promise(resolve=>setImmediate(resolve));view=f.render();assert.equal(view.root.props.pending,true);assert.equal(outcome().props.disabled,true);assert.equal(await f.submit(),undefined,'Pending decisions cannot submit twice');
 f.release();await assert.rejects(pending,/Response lost/);f.scope.execution.revision=19;view=f.render();assert.equal(view.root.props.confirmDisabled,false);assert.equal(outcome().props.disabled,true);await f.submit();assert.equal(f.bodies[1].body,f.bodies[0].body);
 const intent=JSON.parse(f.bodies[0].body);assert.equal(intent.action,'resolve_schedule_update');assert.equal(intent.occurrenceId,'exact-occurrence');assert.equal(intent.updateApplied,true);assert.equal(intent.externalEffectsReconciled,true);assert.equal(intent.reason,'Verified actual Agent output and external effects');assert.equal(intent.expectedRevision,7);
});
