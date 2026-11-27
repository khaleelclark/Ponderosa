import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import '../shared/web-typescript-loader.mjs';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const ts=require('typescript'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const {branchScriptFailureSummary,notificationPreviewText}=require('@ponderosa/core');
const {createHash}=require('node:crypto');
const {ApiRequestError}=await import('../../apps/web/src/api/types.ts');
const {ChatMessageBody}=await import('../../apps/web/src/components/chat/ChatMessages.tsx');
const presentation=await import('../../apps/web/src/components/branches/executionPresentation.ts');
const {MutationNotificationProvider}=await import('../../apps/web/src/components/MutationNotifications.tsx');
const stepEvidence=await import('../../apps/web/src/components/branches/BranchStepEvidence.tsx');
const {previewBranchExecutionActions,previewBranchExecutionDetail}=await import('../../apps/server/dist/branch-detail-preview.js');
const source=await readFile(new URL('../../apps/web/src/components/branches/ExecutionPanel.tsx',import.meta.url),'utf8');

function fixture({actions=[],state='waiting',output='Result with the complete original wording.\nSecond line.',savedView,operationsState='waiting_human',executionPatch={}}={}){
 const execution={...executionPatch,id:'run-a',branchId:'branch-a',versionId:'saved-version',bindingRevisionId:'binding',occurrenceKey:'manual-intent',input:'Original input',inputHash:'input-hash',state,revision:7,createdAt:'2026-10-26T12:00:00Z',updatedAt:'2026-10-26T12:01:00Z',output,admissionSource:'manual'};
 const step={id:'recent-step',executionId:execution.id,stepId:'review',pathId:'recent-path',invocation:1,state:'completed',input:'Step input'};
 const detail={execution,steps:[step],attempts:[],gates:[],paths:[],resources:[],decisions:[],waits:[]};
 const operations={executionId:execution.id,revision:execution.revision,state:operationsState,label:'Needs Your Review',observedAt:execution.updatedAt,counts:{completed:1,running:0,retrying:0,failed:0,waitingAgent:0,waitingHuman:1,needsReconciliation:0,mapItems:0,mapSettled:0},agentWaits:[],additionalAgentWaits:0};
 const actionPage={executionId:execution.id,revision:7,generation:'checkpoint-7',items:actions};
 const effects=[],slots=[],queries=new Map(),buttons=[],disclosures=[],fields=[],mutations=[],requests=[],focused=[],refetches=[],reviewChildren=[],viewStates=new Map(savedView?[[execution.id,savedView]]:[]),invalidations=[];
 let slot=0,transport=async()=>({}),queryPatch={};
 const hooks={...React,useState(initial){const index=slot++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return[slots[index],next=>slots[index]=typeof next==='function'?next(slots[index]):next]},useRef(initial){const index=slot++;return slots[index]??=( {current:initial} )},useEffect(fn,deps){const index=slot++,previous=slots[index];if(!previous||!deps||deps.some((value,i)=>value!==previous[i])){slots[index]=deps;effects.push(fn)}},useLayoutEffect(){}};
 const primitive=name=>props=>{
  if(name==='Button'||name==='ButtonBase'||name==='MenuItem')buttons.push(props);
  if(name==='TextField')fields.push(props);
  if(name==='Box'&&props.component==='details')disclosures.push(props);
   if(name==='Menu'&&!props.open)return null;
 const tag=props.component??(['Button','ButtonBase'].includes(name)?'button':name==='Typography'?'span':'div');
  return React.createElement(tag,{...(props.id?{id:props.id}:{}),...(props.href?{href:props.href}:{}),...(props.label?{'data-label':props.label}:{}),...(props.role?{role:props.role}:{}),...(props['aria-label']?{'aria-label':props['aria-label']}:{}),...(tag==='details'?{open:props.open}:{}),...(props.disabled?{disabled:true}:{})},props.children,name==='Alert'?props.action:null);
 };
 const mui=Object.fromEntries(['Accordion','AccordionDetails','AccordionSummary','Alert','Box','Button','ButtonBase','Chip','Dialog','DialogActions','DialogContent','DialogTitle','FormControlLabel','Menu','MenuItem','Paper','Stack','Switch','TextField','Typography'].map(name=>[name,primitive(name)]));
 const query=options=>{
  const key=options.queryKey[0];queries.set(key,options);
  let data=key==='branch-execution-operations'?operations:key==='branch-execution-actions'?{pages:[actionPage],pageParams:[undefined]}:undefined;
  return {data,isPending:!data,isFetching:false,isFetchingNextPage:false,error:null,hasNextPage:false,refetch(){refetches.push(key)},fetchNextPage(){},...queryPatch[key]};
 };
 const queryClient={invalidateQueries:value=>invalidations.push(value),resetQueries:()=>{throw Error('Refreshing must not reset mounted decisions')}};
 const scope={exports:{},console,Date,JSON,Map,Set,Error,navigator:{clipboard:{writeText:async()=>{}}},requestAnimationFrame:fn=>{fn();return 1},cancelAnimationFrame(){},document:{getElementById:id=>({scrollIntoView(){focused.push(id)},focus(){focused.push('focus:'+id)}})},require:name=>{
  if(name==='react')return hooks;
  if(name==='@tanstack/react-query')return {useQuery:query,useInfiniteQuery:query,useQueryClient:()=>queryClient,useMutation:options=>{const mutation={isPending:false,error:null,reset(){},mutate:input=>mutation.mutateAsync(input),async mutateAsync(input){requests.push({mutation:options,input});return options.mutationFn(input)}};mutations.push(mutation);return mutation;}};
  if(name==='@ponderosa/core')return {branchScriptFailureSummary,notificationPreviewText};
  if(name==='@mui/material')return mui;
  if(name.startsWith('@mui/icons-material/'))return {default:()=>null};
  if(name==='../../clipboard')return {copyText:async()=>{}};
  if(name==='./BranchStepEvidence')return stepEvidence;
  if(name==='../../clientId')return {createClientId:()=> 'same-command'};
  if(name==='../../branchesRouting')return {branchRoutePath:route=>'/branches?'+new URLSearchParams(Object.entries(route))};
  if(name==='../../api/productScope')return {productApiPath:path=>path};
  if(name==='../../api/types')return {ApiRequestError};
  if(name==='../../api/real')return {requestJson:async(path,options)=>{requests.push({path,options});return transport(path,options)}};
  const reviews={'./BranchRuntimePackageReview':'BranchRuntimeOwnerReadback','./BranchHistoryReview':'BranchHistoryReview','./BranchDisclosureReview':'BranchDisclosureReview','./BranchGroupReview':'BranchGroupReview','./BranchResourceReview':'BranchResourceReview'};
  if(name in reviews)return {[reviews[name]]:props=>{reviewChildren.push({name:reviews[name],props});return null;}};
  if(name==='./BranchLiveOutput')return {BranchLiveOutputs:()=>null};
  if(name==='./BranchGraph')return {BranchGraph:()=>React.createElement('div',null,'Pinned Run Graph And Accessible Outline')};
  if(name==='../chat/ChatMessages')return {ChatMessageBody};
  if(name==='../decisions/DecisionCard')return {DecisionCard:props=>React.createElement('section',{'aria-label':'Shared Decision'},props.decision.question,React.createElement('button',{onClick:props.onResolved},'Resolve Through Existing Decision'))};
  if(name==='../ConfirmationDialogs')return {ConfirmDialog:props=>React.createElement('section',null,props.children)};
  if(name==='./model')return {currentFailedInvocations:()=>[],nodeName:node=>node.label??node.id};
  if(name==='../SemanticStatus')return {SemanticStatus:props=>React.createElement('span',{'data-status':props.status},props.label)};
  if(name==='./executionPresentation')return presentation;
  if(name==='./branchRunStatus')return {branchExecutionStatus:run=>{const value=run.effectiveStatus??run.state;return {status:value,label:value.split('_').map(word=>word[0].toUpperCase()+word.slice(1)).join(' ')}}};
  throw Error('Unexpected dependency '+name);
 }};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{...scope,require:name=>name==='react/jsx-runtime'?require('react/jsx-runtime'):scope.require(name)});
 const props={detail,definition:{name:'Published workflow',entry:'review',steps:[{id:'review',label:'Review Document',kind:'agent'},{id:'older',label:'Earlier Important Step',kind:'script'}],controls:[],edges:[],trigger:{kind:'manual'}},executions:[execution],viewStates,evidenceControls:React.createElement('div',null,'Load Older Evidence'),onBudgetSettings:id=>focused.push('budget:'+id)};
 const render=()=>{slot=0;buttons.length=0;disclosures.length=0;fields.length=0;reviewChildren.length=0;queries.clear();effects.length=0;return renderToStaticMarkup(React.createElement(MutationNotificationProvider,null,React.createElement(scope.exports.ExecutionPanel,props)));};
 return {execution,detail,operations,actionPage,queries,buttons,disclosures,fields,requests,focused,refetches,invalidations,reviewChildren,render,props,flushEffects:()=>effects.splice(0).forEach(fn=>fn()),setTransport:fn=>transport=fn,setQuery:(key,value)=>queryPatch[key]=value,button:label=>buttons.find(button=>button.children===label)};
}
function olderAttempt({unknown=false,current=true,blocked=false}={}){
 const step={id:'older-step',executionId:'run-a',stepId:'older',pathId:'old-path',invocation:3,state:unknown?'outcome_unknown':'failed',input:'Earlier original input'};
 return {kind:'attempt',step,current,attempt:{id:'old-attempt',stepExecutionId:step.id,number:2,state:unknown?'outcome_unknown':'failed',fence:1,error:'Original failure summary',...(blocked?{retryBlockedReason:'Path already advanced'}:{})}};
}

test('selected run keeps canonical status, results and all focused decisions outside one collapsed Technical Details, with advanced reviews inside it',()=>{
 const old=olderAttempt({unknown:true}),gate={kind:'gate',step:old.step,gate:{id:'gate-a',stepExecutionId:old.step.id,revision:4,state:'waiting',purpose:'approval',prompt:'Approve the original result?',proposal:'Exact proposed result',editable:false}};
 const f=fixture({actions:[gate,old]});
 const html=f.render();
 assert.equal(f.disclosures.length,1);assert.equal(f.disclosures[0].open,false);assert.match(html,/Needs Your Review/);assert.match(html,/Approve the original result/);assert.match(html,/Exact proposed result/);assert.match(html,/Outcome Needs Reconciliation/);assert.match(html,/Result with the complete original wording/);assert.match(html,/Second line/);assert.match(html,/Review Document/);
 assert.ok(html.indexOf('Exact proposed result')<html.indexOf('Result with the complete original wording'));
 assert.ok(html.indexOf('Exact proposed result')<html.indexOf('<details'));assert.ok(html.indexOf('Original failure summary')<html.indexOf('<details'));assert.ok(html.indexOf('Result with the complete original wording')<html.indexOf('<details'));
 assert.doesNotMatch(html,/Pinned Run Graph|Load Older Evidence|Run ID:|For Each Items/);
 assert.equal(f.queries.get('branch-step-evidence').enabled,false);assert.equal(f.queries.get('branch-map-item-search').enabled,false);assert.equal(f.queries.get('branch-execution-input').enabled,false);
 assert.ok(f.queries.get('branch-execution-actions'));assert.ok(f.queries.get('branch-execution-operations'));
 assert.deepEqual(f.reviewChildren,[],'UI032: advanced review launchers stay unmounted until Technical Details opens');
 assert.ok(f.button('Retry Anyway'));assert.ok(f.button('Mark Observed Result'));
 f.disclosures[0].onToggle({currentTarget:{open:true}});f.render();
 assert.deepEqual(f.reviewChildren,[]);
 f.button('Recovery options').onClick();f.render();
 assert.deepEqual(f.reviewChildren.map(child=>child.name),['BranchHistoryReview','BranchGroupReview','BranchDisclosureReview']);
 assert.ok(f.reviewChildren.every(child=>child.props.enabled===true),'Fresh live Run passes authority to each review surface');
});

test('UI030: an accepted Skip shows one Stopping status, no Cancel or step decisions, and Needs Attention only when cleanup truly cannot finish',()=>{
 for(const blocked of [undefined,'A stopped provider process could not be confirmed as exited.']){
  const f=fixture({actions:[olderAttempt({unknown:true})],executionPatch:{stopping:{outcome:'skipped',...(blocked?{blocked}:{})},effectiveStatus:blocked?'needs_attention':'stopping'}});
  const html=f.render().replace(/<style[^>]*>[\s\S]*?<\/style>/g,'');
  assert.match(html,blocked?/data-status="needs_attention">Needs Attention</:/data-status="stopping">Stopping</);
  assert.match(html,blocked?/could not be confirmed as exited/:/Skip accepted.*Skipped automatically/);
  for(const label of ['Cancel Run','Skip Run','Merge Into Another Run','Retry Anyway','Mark Observed Result'])assert.equal(buttonOrUndefined(f,label),undefined,label+' is refused while stopping');
  assert.doesNotMatch(html,/Needs Your Review/,'operations explanations do not compete with the stop status');
 }
});
const buttonOrUndefined=(f,label)=>{try{return f.button(label)}catch{return undefined}};
test('Inspect Details loads evidence for the exact older invocation without opening run Technical Details',()=>{
 const f=fixture({actions:[olderAttempt({unknown:true})]});f.render();f.button('Inspect Details').onClick({currentTarget:{focus(){}}});
 const html=f.render();
 assert.match(html,/aria-label="Step details"/);assert.equal(f.disclosures[0].open,false);
 assert.equal(f.queries.get('branch-step-evidence').enabled,true);
 assert.deepEqual(Array.from(f.queries.get('branch-step-evidence').queryKey),['branch-step-evidence','run-a','older-step',7]);
 f.buttons.find(button=>button.children?.[0]?.props?.children==='Back to Steps').onClick();
 f.render();assert.equal(f.queries.get('branch-step-evidence').enabled,false);
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
 assert.match(html,/Loading current decisions and failures/);assert.match(html,/Loading Run Status/);assert.doesNotMatch(html.replace(/<style[^>]*>[\s\S]*?<\/style>/g,''),/No decisions|All done|100%/);
});

test('budget and provider controls use canonical run ownership without changing or starting work',()=>{
 const f=fixture({operationsState:'provider_attention'});f.operations.label='Provider needs attention';f.execution.budgetWait={kind:'execution_budget',branchId:'called-branch'};
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

test('large joined results render in full while ordinary Chat still collapses long messages',()=>{
 const f=fixture({output:'branch-result-bundle:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222'});f.execution.id='11111111-1111-1111-1111-111111111111';
 const content='Readable joined report.\n'.repeat(1000)+'COMPLETE LAST FACT';f.setQuery('branch-result-bundle',{data:{content,contentHash:'original'},isPending:false});
 const html=f.render();assert.doesNotMatch(html,/Show Full Message/);assert.match(html,/COMPLETE LAST FACT/);assert.equal(f.queries.get('branch-result-bundle').enabled,true);
 const chat=renderToStaticMarkup(React.createElement(ChatMessageBody,{text:content}));assert.match(chat,/Show Full Message/);assert.doesNotMatch(chat,/COMPLETE LAST FACT/);
});

test('opening diagnostics preserves raw Script evidence, receipts, resolved decisions and existing full evidence route',()=>{
 const action=olderAttempt({unknown:true}),f=fixture({actions:[action]});f.detail.resources=[{stepExecutionId:'older-step',agentIds:['agent-a'],state:'cleanup_pending',error:'Cleanup must finish'}];f.detail.gates=[{id:'resolved',stepExecutionId:'older-step',state:'resolved',prompt:'Recorded approval',resolution:{decision:'approve',output:'Accepted exact result'}}];
 f.render();f.button('Inspect Details').onClick({currentTarget:{focus(){}}});f.setQuery('branch-step-evidence',{data:{stepExecutionId:'older-step',input:'Exact input Ω',attempts:[{...action.attempt,scriptEvidence:{runtime:'Node.js',code:7,stderr:'Exact stderr Ω',stdout:'Exact stdout 🙂',cwd:'/owned-fixture',finishedAt:f.execution.updatedAt}}],sealedResult:{id:'seal',terminalAttemptId:'old-attempt',contentHash:'sealed-hash',result:{failed:true}}},isPending:false});
 f.render();f.disclosures[0].onToggle({currentTarget:{open:true}});
 const html=f.render();for(const value of ['Step Input','Stderr','Stdout','Exit code: 7','Recorded approval','Cleanup must finish'])assert.ok(html.includes(value),value);
 const resourceReview=f.reviewChildren.find(child=>child.name==='BranchResourceReview');
 assert.ok(resourceReview);assert.equal(resourceReview.props.branchId,'branch-a');assert.equal(resourceReview.props.executionId,'run-a');assert.equal(resourceReview.props.stepId,'older-step');assert.equal(resourceReview.props.enabled,true);
 f.props.authorityFresh=false;f.render();assert.equal(f.reviewChildren.find(child=>child.name==='BranchResourceReview').props.enabled,false,'Stale run data cannot authorize resource review');
 const link=f.button('Open Full Evidence (JSON)');assert.equal(link.href,'/api/branch-executions/run-a/full-detail');assert.equal(link.target,'_blank');
});

test('a saved open technical view restores only its own selection and does not activate work',()=>{
 const saved={selected:'review',summaryStepId:'recent-step',itemSearch:'late fact',itemFilter:'all',itemSort:'index',itemLimit:100,callsExpanded:false,showBundle:false,showFullOutput:false,technicalOpen:true};
 const f=fixture({savedView:saved});f.render();assert.equal(f.disclosures[0].open,true);assert.equal(f.queries.get('branch-step-evidence').enabled,true);assert.equal(f.queries.get('branch-map-item-search').enabled,true);assert.equal(f.requests.length,0);
 const other=fixture();other.render();assert.equal(other.disclosures[0].open,false);assert.equal(other.queries.get('branch-step-evidence').enabled,false);
});

test('operational status refuses another run and background refresh errors preserve the last known projection',async()=>{
 const f=fixture();f.render();f.setTransport(async()=>({...f.operations,executionId:'other-run'}));await assert.rejects(f.queries.get('branch-execution-operations').queryFn(),/another run/);
 f.setQuery('branch-execution-operations',{error:Error('Temporary status connection failure')});const html=f.render();assert.match(html,/Needs Your Review/);assert.match(html,/Run status could not refresh/);assert.match(html,/Temporary status connection failure/);assert.equal(f.disclosures[0].open,false);assert.ok(f.button('Retry Status'));
});

test('a changed Run revision refetches its stable actions owner without clearing mounted decision forms',()=>{
 const f=fixture({actions:[olderAttempt()]});f.execution.revision=8;
 f.render();f.flushEffects();assert.deepEqual(f.invalidations.map(entry=>Array.from(entry.queryKey)),[['branch-execution-operations','run-a'],['branch-execution-actions','run-a']]);assert.ok(f.invalidations.every(entry=>entry.exact));assert.equal(f.disclosures[0].open,false);assert.equal(f.execution.output,'Result with the complete original wording.\nSecond line.');assert.equal(f.requests.length,0);
 const unavailable=fixture();unavailable.setQuery('branch-execution-actions',{error:new ApiRequestError(503,'Unavailable')});unavailable.render();unavailable.flushEffects();assert.equal(unavailable.invalidations.length,0,'Ordinary failures remain visible without a blind reset loop');
});

test('Merge discovers paged canonical candidates only on demand, independently of the visible history filter',async()=>{
 const f=fixture();f.props.executions=[];f.render();assert.equal(f.queries.get('branch-merge-targets').enabled,false);f.button('Run actions').onClick({currentTarget:{}});f.render();assert.ok(f.button('Merge Into Another Run'));assert.equal(f.button('Merge Into Another Run').disabled,false);
 f.button('Merge Into Another Run').onClick();let html=f.render();assert.equal(f.queries.get('branch-merge-targets').enabled,true);assert.match(html,/Loading eligible runs/);
 const completed={...f.execution,id:'completed-target',state:'completed',createdAt:'2026-10-25T01:00:00Z'};f.setQuery('branch-merge-targets',{data:{pages:[[completed]],pageParams:[undefined]},isPending:false,hasNextPage:true});html=f.render();assert.match(html,/completed/);assert.ok(f.button('Load Older Runs'));
 const field=f.fields.find(field=>field.label==='Keep This Execution');field.onChange({target:{value:'completed-target'}});f.render();assert.equal(f.fields.find(field=>field.label==='Keep This Execution').value,'completed-target');
 const query=f.queries.get('branch-merge-targets');f.setTransport(async path=>{assert.equal(path,'/api/branches/branch-a/executions?mergeFor=run-a&before=older-cursor');return [completed]});assert.equal((await query.queryFn({pageParam:'older-cursor'}))[0].id,'completed-target');assert.equal(query.getNextPageParam(Array.from({length:100},(_,i)=>({...completed,id:'candidate-'+i}))),'candidate-99');assert.equal(query.getNextPageParam([completed]),undefined);
 f.setQuery('branch-merge-targets',{data:{pages:[[completed]]},error:Error('Candidate list unavailable'),isPending:false});html=f.render();assert.match(html,/Eligible runs could not be loaded/);assert.match(html,/Candidate list unavailable/);assert.ok(f.button('Retry Eligible Runs'));assert.equal(f.fields.find(field=>field.label==='Keep This Execution').value,'completed-target','A failed refresh cannot silently erase a selected or uncertain intervention target');
 const empty=fixture();empty.render();empty.button('Run actions').onClick({currentTarget:{}});empty.render();empty.button('Merge Into Another Run').onClick();empty.setQuery('branch-merge-targets',{data:{pages:[[]]},isPending:false});assert.match(empty.render(),/No eligible runs are currently available/);
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
 f.execution.revision++;const refreshing=f.render();assert.match(refreshing,/Preserve this open answer/);assert.match(refreshing,/open decisions are kept/);assert.equal(f.button('Retry Step').disabled,true);assert.deepEqual([...f.queries.get('branch-execution-actions').queryKey],key);f.flushEffects();
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
 const bodies=[],refreshes=[],setters=[],scope={React,ApiRequestError,JSON,Date,Error,execution:{id:'exact-run',revision:7,parentExecutionId:'parent'},intervention:{action,...(['retry','resolve_script'].includes(action)?{attemptId:'exact-attempt',unknown:true}:{}),...(action==='resolve_schedule_update'?{occurrenceId:'exact-occurrence'}:{}),...(action==='resolve_guidance'?{attemptId:'exact-attempt',injectionId:'exact-injection'}:{})},updateApplied:'not_applied',reason:'Verified exact reason',reconciled:true,result:'Exact observed output',failed:true,target:'exact-target',commandKey:'original-command',actionsCurrent:true,mergeTargets:{data:{},isPending:false,error:null,hasNextPage:false},executions:[{id:'exact-target',state:'completed',createdAt:'2026-10-26T00:00:00Z'}],detail:{attempts:[],steps:[]},attentionAttempts:[],openStep(){},stepOpener:{},refresh:()=>refreshes.push('refresh'),createClientId:()=>{setters.push('new-key');return 'new-command'},inspectStep(){}};
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

for(const action of ['retry','resolve_script','resolve_schedule_update','resolve_guidance','merge','skip'])test('uncertain '+action+' replays byte-identical intervention after polling advances the Run revision',async t=>{
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
 const view=known.render();assert.equal(known.scope.interventionUnconfirmed,false);assert.equal(known.scope.interventionLocked,false);assert.equal(view.nodes.find(node=>node.type==='TextField'&&node.props.label==='Reason For This Decision').props.disabled,false);
 view.nodes.find(node=>node.type==='TextField'&&node.props.label==='Reason For This Decision').props.onChange({target:{value:'Reviewed the current revision'}});await known.submit();assert.equal(JSON.parse(known.bodies[1].body).expectedRevision,9);assert.equal(JSON.parse(known.bodies[1].body).reason,'Reviewed the current revision');assert.equal(JSON.parse(known.bodies[1].body).commandKey,'new-command');
 const uncertain=await interventionIntentFixture(t,'skip',{failure:new ApiRequestError(503,'Response unavailable')}),second=uncertain.submit();await new Promise(resolve=>setImmediate(resolve));uncertain.release();await assert.rejects(second,/Response unavailable/);uncertain.refresh();assert.equal(uncertain.scope.interventionUnconfirmed,true);uncertain.scope.execution.revision=14;await uncertain.submit();assert.equal(uncertain.bodies[1].body,uncertain.bodies[0].body);
});


test('an uncertain scheduled update remains actionable without opening Technical Details or inventing completion',()=>{
 const update={kind:'schedule_update',occurrenceId:'own-occurrence',injectionId:'uncertain-injection',eventCount:3,lastScheduledAt:'2026-10-27T12:00:00.000Z'};
 const f=fixture({actions:[update]}),html=f.render();assert.match(html,/Scheduled Update Needs Reconciliation/);assert.match(html,/3 scheduled events/);assert.ok(html.indexOf('Reconcile Scheduled Update')<html.indexOf('<details'));assert.equal(f.disclosures[0].open,false);
 assert.equal(f.queries.get('branch-step-evidence').enabled,false);assert.equal(f.requests.length,0);f.button('Reconcile Scheduled Update').onClick();const dialog=f.render();assert.match(dialog,/Both choices · no Agent cancellation\/restart/);assert.match(dialog,/retains one latest delivery while schedule active/);
 const selector=f.fields.find(field=>field.label==='Observed Scheduled Update Outcome');assert.equal(selector.value,'');assert.equal(selector.disabled,true,'No outcome can be selected before inspecting actual effects');selector.onChange({target:{value:'applied'}});f.render();assert.equal(f.fields.find(field=>field.label===selector.label).value,'');assert.equal(f.requests.length,0);
 f.props.authorityFresh=false;f.render();assert.equal(f.button('Reconcile Scheduled Update').disabled,true,'Stale run data cannot authorize reconciliation');
 const page={executionId:f.execution.id,revision:f.execution.revision,generation:'current',items:[update]};assert.equal(presentation.currentExecutionActions(f.execution,[page,page]).length,1);
 const changed={...update,injectionId:'replacement-injection'};assert.equal(presentation.currentExecutionActions(f.execution,[page,{...page,items:[changed]}]).length,2,'Different uncertainty evidence must never be collapsed into the old injection');
 const preview=previewBranchExecutionActions(page);assert.deepEqual(preview.items,[update]);assert.equal(preview.largeEvidenceOmitted,undefined);
});

test('scheduled update reconciliation requires an observed outcome, checked effects and reason while reusing the shared dialog',async t=>{
 const f=await interventionIntentFixture(t,'resolve_schedule_update');f.scope.updateApplied='';f.scope.reconciled=false;f.scope.reason='';
 let view=f.render();assert.equal(view.root.props.title,'Reconcile Scheduled Update');assert.equal(view.root.props.confirmDisabled,true);assert.equal(f.bodies.length,0);
 const outcome=()=>view.nodes.find(node=>node.type==='TextField'&&node.props.label==='Observed Scheduled Update Outcome');assert.equal(outcome().props.disabled,true);outcome().props.onChange({target:{value:'applied'}});assert.equal(f.scope.updateApplied,'');
 const confirmation=view.nodes.find(node=>node.type==='FormControlLabel'&&node.props.label==='I have checked and reconciled the scheduled update’s effects');assert.ok(confirmation);confirmation.props.control.props.onChange(null,true);
 view=f.render();assert.equal(outcome().props.disabled,false);outcome().props.onChange({target:{value:'applied'}});view=f.render();assert.equal(view.root.props.confirmDisabled,true,'A reason is still required');
 view.nodes.find(node=>node.type==='TextField'&&node.props.label==='Reason For This Decision').props.onChange({target:{value:'Verified actual Agent output and external effects'}});view=f.render();assert.equal(view.root.props.confirmDisabled,false);
 const pending=view.root.props.onConfirm();await new Promise(resolve=>setImmediate(resolve));view=f.render();assert.equal(view.root.props.pending,true);assert.equal(outcome().props.disabled,true);assert.equal(await f.submit(),undefined,'Pending decisions cannot submit twice');
 f.release();await assert.rejects(pending,/Response lost/);f.scope.execution.revision=19;view=f.render();assert.equal(view.root.props.confirmDisabled,false);assert.equal(outcome().props.disabled,true);await f.submit();assert.equal(f.bodies[1].body,f.bodies[0].body);
 const intent=JSON.parse(f.bodies[0].body);assert.equal(intent.action,'resolve_schedule_update');assert.equal(intent.occurrenceId,'exact-occurrence');assert.equal(intent.updateApplied,true);assert.equal(intent.externalEffectsReconciled,true);assert.equal(intent.reason,'Verified actual Agent output and external effects');assert.equal(intent.expectedRevision,7);
});


const liveOutputSource=await readFile(new URL('../../apps/web/src/components/branches/BranchLiveOutput.tsx',import.meta.url),'utf8');
function liveOutputFixture(){
 const target={attemptId:'attempt-a',stepId:'work',agentId:'agent-a',projectId:'project-a',runId:'scheduler-a'},data={runOutput:[]},connection={connectionStatus:'live'},calls=[],responseProps=[];
 const mui=Object.fromEntries(['Alert','Paper','Stack','Typography'].map(name=>[name,props=>React.createElement(props.component??'div',props.role?{role:props.role}:{},props.children)]));
 const scope={exports:{},require:name=>{
  if(name==='react/jsx-runtime')return require(name);
  if(name==='@mui/material')return mui;
  if(name==='../chat/AgentResponseText')return {AgentResponseText:props=>{responseProps.push(props);return React.createElement('span',null,props.text)}};
  if(name==='../activity/ActivityOutput')return {RunOutputFullText:props=>props.render(props.segment.text)};
  if(name==='../../hooks/queries')return {useAgent:id=>{calls.push(['query',id]);return {data,error:data.error}}};
  if(name==='../../hooks/useAgentStream')return {useAgentStream:(agentId,projectId)=>{calls.push(['stream',agentId,projectId]);return connection}};
  throw Error('Unexpected live output dependency '+name);
 }};
 vm.runInNewContext(ts.transpileModule(liveOutputSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,scope);
 return {target,data,connection,calls,responseProps,render:()=>{responseProps.length=0;return renderToStaticMarkup(React.createElement(scope.exports.BranchLiveOutput,{targets:[target],labels:{work:'Document review'}}))}};
}

test('real Branch live-output view renders incremental exact-Run response telemetry before a final Step result',()=>{
 const f=liveOutputFixture();assert.match(f.render(),/Waiting for output/);
 f.data.runOutput=[{id:'earlier',executionId:'other-run',kind:'response',text:'DO_NOT_SHOW_OTHER_RUN'},{id:'reason',executionId:'scheduler-a',kind:'reasoning',text:'DO_NOT_SHOW_REASONING'},{id:'delta',executionId:'scheduler-a',kind:'response',text:'First phrase'}];
 let html=f.render();assert.match(html,/First phrase/);assert.doesNotMatch(html,/DO_NOT_SHOW/);
 f.data.runOutput[2]={...f.data.runOutput[2],text:'First phrase and next phrase'};html=f.render();assert.match(html,/First phrase and next phrase/);assert.equal((html.match(/First phrase/g)??[]).length,1);
 assert.deepEqual(f.calls.at(-1),['stream','agent-a','project-a']);assert.deepEqual(f.calls.at(-2),['query','agent-a']);
 assert.equal(f.responseProps[0].projectId,'project-a');assert.equal(f.responseProps[0].fileScope.agentId,'agent-a');assert.equal(f.responseProps[0].text,'First phrase and next phrase');
 assert.match(html,/Document review.*Live work/);
});

test('live output keeps exact cached Run text while reconnecting and reconciles canonical replacement without duplicate deltas',()=>{
 const f=liveOutputFixture();f.data.runOutput=[{id:'live',executionId:'scheduler-a',kind:'response',text:'Retained prefix'}];
 f.connection.connectionStatus='reconnecting';let html=f.render();assert.match(html,/Retained prefix/);assert.match(html,/Live updates unavailable/);
 f.data.runOutput=[{id:'canonical',executionId:'scheduler-a',kind:'response',text:'Retained prefix complete',completed:true}];f.connection.connectionStatus='live';html=f.render();assert.match(html,/Retained prefix complete/);assert.equal((html.match(/Retained prefix/g)??[]).length,1);assert.doesNotMatch(html,/unavailable/);
 f.target.runId='new-run';assert.doesNotMatch(f.render(),/Retained prefix/);
 f.data.error=Error('Exact controlled projection read failure');assert.match(f.render(),/Exact controlled projection read failure/);
});


test('loaded live-output history merges exact current revision targets and excludes stale or foreign pages',async()=>{
 const source=await readFile(new URL('../../apps/web/src/components/BranchesView.tsx',import.meta.url),'utf8');
 const module=ts.createSourceFile('BranchesView.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const declaration=module.statements.find(statement=>ts.isFunctionDeclaration(statement)&&statement.name?.text==='mergeHistory');
 assert.ok(declaration,'The product history merger must be present');
 const body=declaration.getText(module);
 const scope={isOlderExecutionObservation:presentation.isOlderExecutionObservation};vm.runInNewContext(ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText+';globalThis.merge=mergeHistory',scope);
 const page=(revision,liveOutputs,id='run-a')=>({execution:{id,revision},liveOutputs,steps:[],attempts:[],gates:[],paths:[],resources:[]});
 const a={attemptId:'a',runId:'scheduler-a'},b={attemptId:'b',runId:'scheduler-b'};
 assert.deepEqual(JSON.parse(JSON.stringify(scope.merge([page(2,[a]),page(2,[b,a]),page(1,[{attemptId:'stale',runId:'old'}]),page(2,[{attemptId:'foreign',runId:'foreign'}],'other')]).liveOutputs)),[b,a]);
});

test('uncertain guidance is actionable with exact evidence and no invented result',()=>{
 const guidance={kind:'guidance_review',attemptId:'own-attempt',injectionId:'own-injection'};
 const f=fixture({actions:[guidance]}),html=f.render();
 assert.match(html,/Guidance Delivery Needs Review/);assert.ok(html.indexOf('Review Guidance Delivery')<html.indexOf('<details'));assert.equal(f.requests.length,0);
 f.button('Review Guidance Delivery').onClick();const dialog=f.render();
 assert.match(dialog,/keeps this guidance held without automatic resend/);assert.match(dialog,/not an Agent result/);
 const selector=f.fields.find(field=>field.label==='Observed Guidance Delivery');assert.equal(selector.value,'');assert.equal(selector.disabled,true);
 selector.onChange({target:{value:'applied'}});f.render();assert.equal(f.fields.find(field=>field.label===selector.label).value,'');
 f.props.authorityFresh=false;f.render();assert.equal(f.button('Review Guidance Delivery').disabled,true);
 const page={executionId:f.execution.id,revision:f.execution.revision,generation:'current',items:[guidance]};
 assert.equal(presentation.currentExecutionActions(f.execution,[page,page]).length,1);
 assert.equal(presentation.currentExecutionActions(f.execution,[page,{...page,items:[{...guidance,injectionId:'other'}]}]).length,2);
});

for(const applied of [true,false])test('guidance review requires observed delivery, checked effects and reason: '+applied,async t=>{
 const f=await interventionIntentFixture(t,'resolve_guidance');f.scope.updateApplied='';f.scope.reconciled=false;f.scope.reason='';
 let view=f.render();assert.equal(view.root.props.title,'Review Guidance Delivery');assert.equal(view.root.props.confirmDisabled,true);
 const outcome=()=>view.nodes.find(node=>node.type==='TextField'&&node.props.label==='Observed Guidance Delivery');
 assert.equal(outcome().props.disabled,true);outcome().props.onChange({target:{value:'applied'}});assert.equal(f.scope.updateApplied,'');
 const confirmation=view.nodes.find(node=>node.type==='FormControlLabel'&&node.props.label==='I have checked and reconciled this guidance’s effects');assert.ok(confirmation);
 confirmation.props.control.props.onChange(null,true);view=f.render();outcome().props.onChange({target:{value:applied?'applied':'not_applied'}});view=f.render();assert.equal(view.root.props.confirmDisabled,true);
 view.nodes.find(node=>node.type==='TextField'&&node.props.label==='Reason For This Decision').props.onChange({target:{value:'Checked original delivery and effects'}});
 view=f.render();assert.equal(view.root.props.confirmDisabled,false);const pending=view.root.props.onConfirm();await new Promise(resolve=>setImmediate(resolve));assert.equal(await f.submit(),undefined);
 f.release();await assert.rejects(pending,/Response lost/);f.scope.execution.revision=19;await f.submit();assert.equal(f.bodies[1].body,f.bodies[0].body);
 const intent=JSON.parse(f.bodies[0].body);assert.equal(intent.action,'resolve_guidance');assert.equal(intent.attemptId,'exact-attempt');assert.equal(intent.injectionId,'exact-injection');assert.equal(intent.updateApplied,applied);assert.equal(intent.externalEffectsReconciled,true);assert.equal(intent.expectedRevision,7);assert.equal(intent.result,undefined);
});

test('only confirmed current prepared copy exposes the scoped preparation retry',()=>{
 const action=olderAttempt();action.attempt.state='prepared';action.attempt.snapshotRetryAvailable=true;
 const f=fixture({actions:[action]});assert.match(f.render(),/Copy Preparation Needs Retry/);
 f.button('Retry Preparing Copy').onClick();const dialog=f.render();assert.match(dialog,/same temporary copy reservation/);assert.match(dialog,/no copy was published/);assert.doesNotMatch(dialog,/Starts · new Step invocation/);assert.equal(f.requests.length,0);
 f.props.authorityFresh=false;f.render();assert.equal(f.button('Retry Preparing Copy').disabled,true);
 const ordinary=olderAttempt();ordinary.attempt.state='prepared';const held=fixture({actions:[ordinary]});held.render();assert.equal(held.button('Retry Preparing Copy'),undefined);assert.equal(held.button('Retry Step'),undefined);
 const unknown=olderAttempt({unknown:true});unknown.attempt.snapshotRetryAvailable=true;const uncertain=fixture({actions:[unknown]});uncertain.render();assert.equal(uncertain.button('Retry Preparing Copy'),undefined);assert.ok(uncertain.button('Retry Anyway'));
});


test('valid same-Run action revision drift is neutral while malformed, foreign and HTTP errors stay visible',async()=>{
 const f=fixture({actions:[olderAttempt()]});f.render();
 f.setTransport(async()=>({...f.actionPage,revision:8,generation:'checkpoint-8'}));
 let pending;await assert.rejects(f.queries.get('branch-execution-actions').queryFn({}),error=>{pending=error;return true;},'Different revision cannot grant action authority');
 f.setQuery('branch-execution-actions',{error:pending});
 const waiting=f.render();assert.match(waiting,/Refreshing Run actions/);assert.doesNotMatch(waiting,/Decisions and failures could not refresh/);
 assert.equal(f.button('Retry Step').disabled,true);assert.ok(f.button('Refresh Run'),'Neutral pending keeps a manual recovery path');
 f.execution.revision=8;f.actionPage.revision=8;f.actionPage.generation='checkpoint-8';f.setQuery('branch-execution-actions',{error:null});
 assert.doesNotMatch(f.render(),/Refreshing Run actions/);assert.equal(f.button('Retry Step').disabled,false);
 for(const response of [null,{...f.actionPage,executionId:'foreign'},{...f.actionPage,revision:'8'},{...f.actionPage,generation:''},{...f.actionPage,items:null},{...f.actionPage,revision:9,items:[null]}]){
  f.setTransport(async()=>response);let failure;
  await assert.rejects(f.queries.get('branch-execution-actions').queryFn({}),error=>{failure=error;return true;},'Invalid response must be rejected');
  f.setQuery('branch-execution-actions',{error:failure});const html=f.render();
  assert.match(html,/Decisions and failures could not refresh/);assert.equal(f.button('Retry Step').disabled,true);assert.ok(f.button('Refresh Run'));
 }
 const outage=new ApiRequestError(503,'Actions service unavailable');f.setTransport(async()=>{throw outage});
 await assert.rejects(f.queries.get('branch-execution-actions').queryFn({}),error=>error===outage);
 f.setQuery('branch-execution-actions',{error:outage});assert.match(f.render(),/Decisions and failures could not refresh.*Actions service unavailable/);
 assert.equal(f.button('Retry Step').disabled,true);
});

async function activityQueryModule(){
 const {pathToFileURL}=await import('node:url'),file=require.resolve('@tanstack/react-query/package.json');
 const metadata=JSON.parse(await readFile(file,'utf8'));
 return import(new URL(metadata.exports['.'].import.default,pathToFileURL(file)).href);
}

test('tool output formats only bounded exact inline JSON and preserves canonical fallbacks',async()=>{
 const {ActivityOutput}=await import('../../apps/web/src/components/activity/ActivityOutput.tsx');
 const {QueryClient,QueryClientProvider}=await activityQueryModule();
 const render=(raw,reference)=>{const result=Object.freeze({activityId:'result',agentId:'agent',seq:1,completedAt:'2026-11-08T00:00:00Z',output:raw,isError:false,...(reference?{outputPreview:reference}:{})});const client=new QueryClient({defaultOptions:{queries:{retry:false}}});try{const html=renderToStaticMarkup(React.createElement(QueryClientProvider,{client},React.createElement(ActivityOutput,{result,collapsedLines:2})));assert.equal(result.output,raw);const match=/<pre\b[^>]*>([\s\S]*?)<\/pre>/.exec(html);assert.ok(match,'Actual output text is rendered');return{html,text:match[1]};}finally{client.clear();}};
 const escaped=text=>renderToStaticMarkup(React.createElement('pre',null,text)).slice(5,-6);
 for(const [raw,display]of[
  ['{"ok":true,"items":[1,2]}','{\n  "ok": true,\n  "items": [\n    1,\n    2\n  ]\n}'],
  ['[1,{"ok":false}]','[\n  1,\n  {\n    "ok": false\n  }\n]'],
 ]){const view=render(raw);assert.equal(view.text,escaped(display));assert.match(view.html,/Show More/,'Formatted lines retain the existing bounded disclosure');}
 for(const raw of['Ordinary tool text','42','null','{"duplicate":1,"duplicate":2}','{"n":9007199254740993}','{"n":-0}','{"n":1e2}',String.raw`{"value":"\u0061"}`,' {"ok":true}','{\n "ok":true\n}','{"broken":',JSON.stringify({long:'x'.repeat(810)}),'['.repeat(40)+'0'+']'.repeat(40)]){
  assert.equal(render(raw).text,escaped(raw),'Canonical text must remain exact: '+raw.slice(0,60));
 }
 const large=JSON.stringify({long:'x'.repeat(810)}),largeView=render(large);assert.match(largeView.html,/Show More/);assert.ok(largeView.html.includes(new TextEncoder().encode(large).byteLength+' B'),'Byte count describes raw canonical bytes');
 const raw='{"paged":true}',paged=render(raw,{sha256:'fixed',totalUtf8Bytes:1000,retrievalUrl:'/api/agents/agent/activity/1/output'});assert.equal(paged.text,escaped(raw));assert.match(paged.html,/Show More/,'Existing canonical-page disclosure remains available');
});

test('real expanded tool activity labels its existing input and output without changing their values',async()=>{
 const {ActionGroupRow}=await import('../../apps/web/src/components/activity/ActivityRows.tsx');
 const {QueryClient,QueryClientProvider}=await activityQueryModule();
 const input=Object.freeze({agentId:'owned-agent'}),output='{"name":"Synthetic Agent","status":"running"}',entry={id:'tool-call',seq:1,createdAt:'2026-11-08T00:00:00Z',kind:'tool',name:'ponderosa_team_directory',input,result:{activityId:'tool-result',agentId:'owned-agent',seq:2,completedAt:'2026-11-08T00:00:01Z',output,isError:false}};
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});try{const html=renderToStaticMarkup(React.createElement(QueryClientProvider,{client},React.createElement(ActionGroupRow,{entries:[entry],focusId:entry.id})));assert.ok(html.includes('Input:'));assert.ok(html.includes('Output:'));assert.ok(html.includes('owned-agent'));assert.ok(html.includes('&quot;name&quot;: &quot;Synthetic Agent&quot;'));assert.equal(entry.input,input);assert.equal(entry.result.output,output);}finally{client.clear();}
});

test('results show one stable publication, report reuse, and keep earlier output visible while a downstream step waits',()=>{
 const packet={id:'synthetic-packet',recommendations:'Example result'};
 const sha256=createHash('sha256').update(JSON.stringify(packet,null,2)+'\n').digest('hex');
 const url='/api/branches/branch-a/results/'+sha256;
 for(const saved of ['created','reused']){
  const f=fixture({output:''});
  delete f.execution.output;
  Object.assign(f.detail.steps[0],{stepId:'older',sealedResultId:'sealed',result:{failed:false,output:JSON.stringify({id:packet.id,saved,sha256,packet})}});
  f.detail.steps.push({id:'browser-step',executionId:f.execution.id,stepId:'review',state:'waiting',input:'Private request',invocation:1});
  f.detail.waits.push({kind:'agent',message:'Waiting for browser',stepId:'review',stepExecutionId:'browser-step',requestId:'waiting'});
  f.operations.state='retrying';f.operations.label='Checking provider sign-in';
  f.operations.agentWaits.push({requestId:'waiting',stepId:'review',stepExecutionId:'browser-step',state:'retry_pending',label:'Checking provider sign-in',reason:'The check is pending',nextRetryAt:'2026-10-26T12:03:00Z'});
  f.props.detail=previewBranchExecutionDetail(f.detail);
  const html=f.render();
  assert.equal(f.button('Packet').href,url);
  assert.equal(html.split(url).length-1,1);
  assert.equal(html.includes('data-label="Reused"'),saved==='reused');
  assert.match(html,/Review Document · Checking provider sign-in/);
  assert.match(html,/Retry eligible/);assert.match(html,/No action needed\./);
  assert.match(html,/Earlier Important Step<\/span><\/div><span data-status="completed">Completed/);
  assert.doesNotMatch(html,/signed out|Provider Settings|Private request/);
  assert.equal(f.disclosures[0].open,false);
 }
});

test('a context hold combines the blocked step, reason and retry above any output',()=>{
 const f=fixture({output:''});
 Object.assign(f.operations,{state:'blocked',counts:{},agentWaits:[{requestId:'held-request',stepId:'review',stepExecutionId:'recent-step',
  state:'context_blocked',label:'Blocked',reason:'The saved session needs to be restored.',contextRetryActivationId:'held-activation'}]});
 const html=f.render();
 assert.match(html,/Blocked · Review Document/);
 assert.match(html,/The saved session needs to be restored/);
 assert.match(html,/No output yet/);
 assert.doesNotMatch(html,/aria-label="Results"|0 Steps completed/);
 assert.ok(f.button('Retry step'));
});

test('only a current confirmed provider hold needs attention, and terminal failure replaces the wait',()=>{
 const f=fixture({output:''});
 f.detail.steps[0].state='waiting';
 f.detail.waits=[{kind:'agent',message:'Browser check queued',stepId:'review',stepExecutionId:'recent-step',requestId:'retry'}];
 f.operations.state='provider_attention';
 f.operations.label='Provider sign-in required';
 f.operations.agentWaits=[{requestId:'retry',stepId:'review',stepExecutionId:'recent-step',state:'provider_attention',label:f.operations.label,reason:'Sign in from Provider Settings. The step can resume when sign-in is verified.'}];
 let html=f.render();
 assert.match(html,/data-status="needs_attention">Needs Attention/);
 assert.doesNotMatch(html,/aria-label="Results"/);
 assert.match(html,/sign-in is verified/);assert.ok(f.button('Open Provider Settings'));
 assert.doesNotMatch(html,/No action needed/);

 f.execution.state='failed';
 f.execution.revision++;
 f.actionPage.revision=f.execution.revision;
 f.detail.steps[0].state='failed';
 f.actionPage.items=[{kind:'attempt',current:true,step:f.detail.steps[0],attempt:{id:'retry',state:'failed',error:'Provider retry timed out'}}];
 html=f.render();
 assert.match(html,/data-status="failed">Failed/);assert.match(html,/Provider retry timed out/);
 assert.doesNotMatch(html,/Provider sign-in required|Browser check queued|No action needed/);
});

test('late same-revision evidence cannot replace a completed step or its output',async()=>{
 const source=await readFile(new URL('../../apps/web/src/components/BranchesView.tsx',import.meta.url),'utf8');
 const module=ts.createSourceFile('BranchesView.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const body=module.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='mergeHistory').getText(module);
 const scope={isOlderExecutionObservation:presentation.isOlderExecutionObservation};
 vm.runInNewContext(ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText+';globalThis.merge=mergeHistory',scope);
 const f=fixture(),base=f.detail.steps[0],fresh={...f.detail,observedAt:'2026-11-22T12:01:00Z',steps:[{...base,result:{failed:false,output:'Saved result'}}]};
 const old={...f.detail,observedAt:'2026-11-22T12:00:00Z',steps:[{...base,state:'running'}]};
 assert.equal(scope.merge([fresh,old]).steps[0].state,'completed');
 assert.equal(scope.merge([old,fresh]).steps[0].result.output,'Saved result');
 assert.equal(presentation.isOlderExecutionObservation(fresh,old),true);
 assert.equal(presentation.isOlderExecutionObservation(fresh,{...old,execution:{...old.execution,revision:8}}),false);
});

test('preview keeps stored output classifications and compares complete text before truncation',()=>{
 const f=fixture({state:'completed',output:'a'.repeat(200)+' final'});
 const step=f.detail.steps[0];
 f.detail.steps=[
  {...step,result:{output:f.execution.output,failed:false}},
  {...step,id:'distinct',result:{output:'a'.repeat(200)+' distinct',failed:false}},
  {...step,id:'technical',resultOutputTechnical:true,result:{output:JSON.stringify({text:'a'.repeat(200)}),failed:false}},
  {...step,id:'authored',result:{output:JSON.stringify({text:'b'.repeat(200)}),failed:false}},
 ];
 const preview=previewBranchExecutionDetail(f.detail);
 assert.equal(preview.steps[0].result.output,preview.steps[1].result.output);
 assert.equal(preview.steps[0].resultInRun,true);
 assert.equal(preview.steps[1].resultInRun,undefined);
 assert.equal(preview.steps[1].resultOutputTruncated,true);
 assert.equal(preview.steps[2].resultOutputTechnical,true);
 assert.equal(preview.steps[3].resultOutputTechnical,undefined);
 assert.equal(previewBranchExecutionDetail({...f.detail,execution:{...f.execution,output:'[Read the report](https://example.org)'}}).executionOutputTechnical,undefined);
});

test('step shortcuts skip the main output and match only complete or canonically equivalent results',()=>{
 const f=fixture({state:'completed',output:'a'.repeat(200)+' final'});
 const step=f.detail.steps[0];
 f.detail.steps=[
  {...step,result:{output:f.execution.output,failed:false}},
  {...step,id:'distinct',stepId:'older',result:{output:'a'.repeat(200)+' distinct',failed:false}},
  {...step,id:'technical',stepId:'technical',resultOutputTechnical:true,result:{output:'{"raw":true}',failed:false}},
 ];
 f.props.detail=previewBranchExecutionDetail(f.detail);
 let html=f.render();
 assert.doesNotMatch(html,/View result for Review Document|View result for technical|id="branch-result-recent-step"/);
 assert.match(html,/View result for Earlier Important Step/);
 assert.match(html,/id="branch-result-distinct"/);
 f.buttons.find(button=>button['aria-label']==='Details for Review Document').onClick({currentTarget:{}});
 f.render();
 assert.ok(f.button('Back to Results'));

 f.execution.output='short exact result';
 step.result={output:f.execution.output,failed:false};
 f.props.detail={...f.detail,steps:[step]};
 html=f.render();
 assert.doesNotMatch(html,/View result for Review Document|id="branch-result-recent-step"/);
 assert.ok(f.button('Back to Results'));
});

test('a recorded cancellation reason is visible beside the canceled run action',()=>{
 const f=fixture({state:'canceled',output:undefined});
 f.execution.output=undefined;
 f.execution.waitReason='Canceled while waiting for the review.';
 f.props.onRerun=()=>{};
 const html=f.render();
 assert.ok(html.indexOf(f.execution.waitReason)<html.indexOf('<details'));
 assert.ok(f.button('Run again with edited input'));
});
