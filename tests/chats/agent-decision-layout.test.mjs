import '../shared/web-typescript-loader.mjs';
const {ApiRequestError}=await import('../../apps/web/src/api/types.ts');
const ConversationChrome=await import('../../apps/web/src/components/ConversationChromeContext.tsx');
const AssistantIcon=await import('../../apps/web/src/components/AssistantIcon.tsx');
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const ts=require('typescript'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const one={id:'decision-a',agentId:'agent-a',projectId:'project-a',status:'pending',mode:'text',question:'FULL CANONICAL QUESTION',options:[],allowOther:true};
function fixture(decisions=[one],overrides={}){
 const captured={queries:[],chats:[],attention:[]},exports={};
 const noop=()=>{};
 const props={tab:'chat',detail:{agent:{id:'agent-a',title:'Vicksburg',projectId:'project-a'},decisionEvents:[]},agentId:'agent-a',chatMessages:[],notifications:[{id:'notification-a',kind:'decision',agentId:'agent-a',decision:{id:one.id,status:'pending'},body:'BOUNDED PREVIEW'},{id:'other',kind:'operational',agentId:'agent-a',body:'Unrelated recovery'}],onOpenTechnical:noop,settingsPane:null,decisionReviewAction:React.createElement('button',null,'Existing Notifications'),...overrides};
 const imports={'@mui/material':{Box:({children,...p})=>React.createElement('div',{'aria-label':p['aria-label']},children),Alert:({children,action})=>React.createElement('aside',null,children,action),Button:({children,onClick})=>React.createElement('button',{onClick},children)},react:React,'@tanstack/react-query':{useQueryClient:()=>({}),useQuery:options=>{captured.queries.push(options);return{data:decisions};}},'../api':{api:{listDecisions:async(filter)=>{captured.filter=filter;return decisions;}}},'../queryKeys':{queryKeys:{decisions:{all:['decisions']}}},'../messageFocus':{scrollFocusedMessageIntoView:noop},'../chatState':{chatStateKey:noop,readChatState:noop},'../technicalFocus':{notificationTechnicalFocusId:noop},'./AgentsTab':{AgentsTab:()=>null},'./AttentionSurface':{AttentionSurface:p=>{captured.attention.push(p);return null;}},'./AgentWorkInspector':{AgentWorkInspector:()=>null},'./chat/ChatPane':{ChatPane:p=>{captured.chats.push(p);return null;}},'./filePreview/ArtifactsPane':{ArtifactsPane:()=>null},'./useConversationNotificationVisibility':{useConversationNotificationVisibility:noop}};
 vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/components/AgentDetail.panels.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,document:{getElementById:()=>null},AbortSignal,require:name=>imports[name]??require(name)});
 const html=renderToStaticMarkup(React.createElement(exports.AgentDetailPanels,props));return Object.assign(captured,{html});
}
test('pending canonical questions belong to ChatPane, never the separately scrolling attention preview',()=>{
 const f=fixture();assert.deepEqual([...f.chats[0].pendingDecisions],[one]);assert.equal(f.attention.length,0);
 assert.match(f.html,/Vicksburg has a decision/);assert.doesNotMatch(f.html,/BOUNDED PREVIEW|still open|FULL CANONICAL QUESTION/);assert.match(f.html,/View Decision/);
});
test('the compact count deduplicates Decision IDs, counts a question bundle once and ignores resolved/foreign records',()=>{
 const grouped={...one,questions:[{id:'a'},{id:'b'},{id:'c'}]},second={...one,id:'decision-b'};
 const f=fixture([grouped,grouped,second,{...one,id:'resolved',status:'resolved'},{...one,id:'foreign',agentId:'elsewhere'}]);
 assert.equal(f.chats[0].pendingDecisions.length,2);assert.match(f.html,/Vicksburg has 2 decisions/);assert.match(f.html,/Existing Notifications/);
 assert.doesNotMatch(f.html,/3 decisions|BOUNDED PREVIEW/);
});
test('an empty canonical pending set hides the decision notice without a separate operational inbox',async()=>{
 const f=fixture([]);assert.doesNotMatch(f.html,/has a decision|has 0 decisions/);assert.equal(f.attention.length,0);assert.doesNotMatch(f.html,/Needs Your Attention|Dismiss hides the notice/);
 await f.queries[0].queryFn({});assert.deepEqual({...f.filter},{projectId:'project-a',agentId:'agent-a',status:'pending'});assert.equal(f.queries[0].enabled,true);
 const inactive=fixture([],{tab:'technical'});assert.equal(inactive.queries[0].enabled,false);
});

test('canonical question cards share the ordinary ChatSurface timeline, deduplicate pending rows and retain resolved history',()=>{
 const exports={},surfaces=[],cards=[],noop=()=>null;
 const imports={react:React,'@mui/material':{Box:({children,id,tabIndex})=>React.createElement('article',{id,tabIndex},children)},'../decisions/DecisionCard':{DecisionCard:p=>{cards.push(p.decision);return React.createElement('p',null,p.decision.question);}},'../CopyMessageButton':{},'../MessageDeliveryStatus':{},'../MessageRequestAction':{},'../activity/activityStream':{buildActivityStream:()=>[]},'./AgentWorkReceipt':{},'./receiptActivityEntries':{},'./ChatMessageFrame':{},'./useTextReplyProjection':{useTextReplyProjection:()=>[],ReplyReadFeedback:noop},'./LiveAgentProgress':{},'./ChatSurface':{ChatSurface:p=>{surfaces.push(p);return React.createElement('section',null,p.beforeMessages,p.children);}},'./ChatMessages':{chatMessageLayoutKey:()=>''},'./agentChatProjection':{projectAgentChat:()=>({messages:[],runs:[]})},'../speech/ReadAloudControls':{},'../decisions/DecisionResponseMessage':{DecisionResponseMessage:noop}};
 imports['./OutgoingMessage']={OutgoingMessageRow:({entries})=>React.createElement(React.Fragment,null,...entries.map(entry=>React.createElement(React.Fragment,{key:entry.id},entry.render(entry.createdAt))))};
 imports['../ConversationChromeContext']=ConversationChrome;
 imports['../AssistantIcon']=AssistantIcon;
 vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/components/chat/ChatPane.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:name=>imports[name]??require(name)});
 const created={...one,createdAt:'2026-10-23T12:00:00Z'},resolved={...created,status:'resolved'},outside={...created,id:'outside-page'};
 const render=(decision,pending)=>renderToStaticMarkup(React.createElement(exports.ChatPane,{messages:[],decisionEvents:[{kind:'decision',id:'creation-a',createdAt:decision.createdAt,decision}],pendingDecisions:pending}));
 const html=render(created,[created,outside]);assert.equal(cards.length,2);assert.equal((html.match(/FULL CANONICAL QUESTION/g)??[]).length,2);assert.match(html,/id="decision:decision-a"/);assert.equal(surfaces.length,1);
 cards.length=0;render(resolved,[]);assert.equal(cards.length,1);assert.equal(cards[0].status,'resolved');assert.equal(surfaces.at(-1).follow.kind,'latest');
});

// Exercise the production Request card and TanStack mutation. Controlled state
// replaces browser layout only; retry eligibility and the command stay shared.
function requestFixture(t,{expanded=true,readOnly=false,retryAvailable=true,state='failed',retryCommand=async()=>({requestIds:['successor'],retryOfRequestId:'request-a'})}={}){
 const {QueryClient,MutationObserver}=require('@tanstack/react-query');
 const client=new QueryClient({defaultOptions:{mutations:{retry:false,gcTime:Infinity},queries:{retry:false,gcTime:Infinity}}});
 const slots=[],buttons=[],dialogs=[],calls=[],invalidations=[],queries=[],clickOwners=[];let index=0,observer,unsubscribe;
 const lifecycle={request:{id:'request-a',state,text:'Exact canonical assignment',retryAvailable},updates:[]};
 const react={useState(initial){const i=index++;slots[i]??={value:typeof initial==='function'?initial():initial};return[slots[i].value,value=>{slots[i].value=typeof value==='function'?value(slots[i].value):value;}];},useRef(initial){const i=index++;slots[i]??={current:initial};return slots[i];},useEffect(){},useMemo:fn=>fn()};
 const primitive=({children})=>React.createElement('div',null,children);
 const mui=Object.fromEntries(['Accordion','AccordionDetails','AccordionSummary','Alert','Box','Chip','CircularProgress','DialogActions','DialogContent','DialogTitle','Paper','Stack','Typography'].map(name=>[name,primitive]));
 mui.Button=p=>{buttons.push(p);return React.createElement('button',{disabled:p.disabled},p.children);};
 mui.Dialog=p=>{dialogs.push(p);return p.open?React.createElement('section',null,p.children):null;};
 const shared={};mui.Box=p=>{if(p.onClick)clickOwners.push(p);return primitive(p);};
 vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/components/ConfirmationDialogs.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports:shared,require:name=>name==='@mui/material'?mui:require(name)});
 const exports={},keys={agentWork:{all:['agent-work'],detail:(...args)=>['agent-work',...args]},notifications:{all:['notifications']}};
 vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/components/RequestLifecycleCard.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,Error,require:name=>({react,'../clientId':{createClientId:()=> 'held-attempt-id'},'../api/types':{ApiRequestError},'@mui/material':mui,'@tanstack/react-query':{useQuery:options=>{queries.push(options);return{data:{requestLifecycle:lifecycle}};},useQueryClient:()=>client,useMutation:options=>{if(!observer){observer=new MutationObserver(client,options);unsubscribe=observer.subscribe(()=>{});}else observer.setOptions(options);return {...observer.getCurrentResult(),mutateAsync:observer.mutate.bind(observer)};}},'../api':{api:{retryCoordinationRequest:(...args)=>{calls.push(args);return retryCommand(...args);}}},'../queryKeys':{queryKeys:keys},'./WorkspaceReadOnlyContext':{useWorkspaceReadOnly:()=>readOnly},'./chat/useTextReplyProjection':{useRequestReplyProjection:updates=>({rows:updates.map(update=>({key:update.id,update,provisional:false})),feedback:[]}),ReplyReadFeedback:()=>null},'./ConfirmationDialogs':shared}[name]??require(name))});
 client.invalidateQueries=async({queryKey})=>{invalidations.push([...queryKey]);};
 const render=()=>{index=0;buttons.length=0;dialogs.length=0;clickOwners.length=0;const tree=exports.RequestLifecycleCard({projectId:'project-a',conversationId:'chat-a',requestId:'request-a',state,recipientAgentId:'worker',requesterAgentId:'manager',updatedAt:'2026-10-23T00:00:00Z',defaultExpanded:expanded,agentTitle:id=>id??'You'});return renderToStaticMarkup(tree);};
 const button=label=>buttons.find(p=>p.children===label);
 t.after(()=>{unsubscribe?.();client.clear();});
 return{render,button,dialogs,calls,invalidations,queries,lifecycle,clickOwners,observer:()=>observer};
}

test('assignment Retry exists only inside expanded canonical eligible recovery, never read-only or superseded work',t=>{
 for(const options of [{expanded:false},{readOnly:true},{retryAvailable:false},{retryAvailable:false,state:'completed'}]){
  const f=requestFixture(t,options);f.render();assert.equal(f.button('Retry Assignment…'),undefined);assert.equal(f.calls.length,0);
 }
 const f=requestFixture(t,{state:'outcome_unknown'});f.render();assert.ok(f.button('Retry Assignment…'));assert.equal(f.queries[0].enabled,true);assert.deepEqual([...f.queries[0].queryKey],['agent-work','project-a','chat-a','request:request-a']);
});

test('Retry requires explicit side-effect confirmation, preserves exact scope and hides after canonical acceptance',async t=>{
 let release;const f=requestFixture(t,{retryCommand:()=>new Promise(resolve=>{release=resolve;})});
 f.render();f.button('Retry Assignment…').onClick({stopPropagation(){}});let html=f.render();assert.match(html,/Exact canonical assignment/);assert.match(html,/may duplicate changes/);assert.equal(f.calls.length,0);
 f.button('Not Now').onClick();f.render();assert.equal(f.dialogs[0].open,false);assert.equal(f.calls.length,0);
 f.button('Retry Assignment…').onClick({stopPropagation(){}});f.render();const confirm=f.button('Retry Assignment').onClick,saving=confirm();assert.equal(confirm(),undefined,'The shared shell fences a second click before pending renders');f.dialogs[0].onClose({},'escapeKeyDown');assert.equal(f.dialogs[0].open,true);await new Promise(resolve=>setImmediate(resolve));f.render();
 assert.equal(f.button('Starting…').disabled,true);assert.equal(f.dialogs[0]['aria-busy'],true);for(const reason of ['escapeKeyDown','backdropClick'])f.dialogs[0].onClose({},reason);f.button('Not Now').onClick();f.render();assert.equal(f.dialogs[0].open,true);assert.equal(f.button('Not Now').disabled,true);assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'request-a');assert.equal(f.calls[0][1].idempotencyKey,'operator-retry:request-a');
 release({requestIds:['successor'],retryOfRequestId:'request-a'});await saving;f.render();assert.equal(f.dialogs[0].open,false);assert.equal(f.button('Retry Assignment…'),undefined,'stale eligible detail must not offer a second retry');assert.deepEqual(f.invalidations.sort(),[['agent-work'],['notifications']]);
});

test('failed Retry retains the same command identity and error; changed canonical eligibility blocks submission',async t=>{
 let attempt=0;const f=requestFixture(t,{retryCommand:async()=>{if(++attempt===1)throw Error('Connection lost');return{requestIds:['successor'],retryOfRequestId:'request-a'};}});
 f.render();f.button('Retry Assignment…').onClick({stopPropagation(){}});f.render();await assert.rejects(f.button('Retry Assignment').onClick(),/Could not confirm whether the retry started/);assert.match(f.render(),/Could not confirm whether the retry started/);assert.equal(f.dialogs[0].open,true);
 await f.button('Retry Assignment').onClick();f.render();assert.equal(f.calls.length,2);assert.equal(f.calls[0][1].idempotencyKey,f.calls[1][1].idempotencyKey);assert.equal(f.button('Retry Assignment…'),undefined);
 const stale=requestFixture(t);stale.render();stale.button('Retry Assignment…').onClick({stopPropagation(){}});stale.lifecycle.request.retryAvailable=false;stale.render();assert.equal(stale.button('Retry Assignment').disabled,true);assert.equal(stale.button('Retry Assignment').onClick(),undefined);await assert.rejects(stale.observer().mutate(),/cannot be retried/);assert.equal(stale.calls.length,0);
});


for(const result of [undefined,{requestIds:[]},{requestIds:['next'],retryOfRequestId:'foreign'}])test('unconfirmed Retry success retains confirmation and stable identity',async t=>{
 const f=requestFixture(t,{retryCommand:async()=>result});f.render();f.button('Retry Assignment…').onClick({stopPropagation(){}});f.render();await assert.rejects(f.button('Retry Assignment').onClick(),/Could not confirm/);f.render();assert.equal(f.dialogs[0].open,true);assert.equal(f.invalidations.length,0);assert.ok(f.button('Retry Assignment…'));
});
test('definite Retry rejection preserves the actionable server explanation',async t=>{
 const f=requestFixture(t,{retryCommand:async()=>{throw new ApiRequestError(409,'Request participants are no longer available');}});f.render();f.button('Retry Assignment…').onClick({stopPropagation(){}});f.render();await assert.rejects(f.button('Retry Assignment').onClick(),/participants/);assert.doesNotMatch(f.render(),/Could not confirm/);
});


test('shared assignment confirmation stops parent-card clicks when opening and interacting',t=>{
 const f=requestFixture(t);f.render();let stopped=0;const event={stopPropagation(){stopped++;}};f.button('Retry Assignment…').onClick(event);f.render();assert.equal(stopped,1);assert.equal(f.clickOwners.length,1);f.clickOwners[0].onClick(event);assert.equal(stopped,2);assert.equal(f.button('Retry Assignment').autoFocus,true);assert.equal(f.dialogs[0].maxWidth,'xs');
 for(const reason of ['escapeKeyDown','backdropClick']){f.dialogs[0].onClose({},reason);f.render();assert.equal(f.dialogs[0].open,false);f.button('Retry Assignment…').onClick(event);f.render();}
});


test('held peer handoff retries the original assignment with one stable command and refuses uncertain holds',async t=>{
 let attempt=0;
 const f=requestFixture(t,{state:'open',retryAvailable:false,retryCommand:async()=>{
  if(++attempt===1)throw Error('response lost');
  return {requestIds:['request-a'],retryOfRequestId:'request-a',replayed:true};
 }});
 f.lifecycle.request.settingsTransitionHold='retry_available';
 let html=f.render();assert.match(html,/original assignment remains queued/u);
 assert.ok(f.button('Retry Context Handoff…'));assert.equal(f.button('Retry Assignment…'),undefined);
 f.button('Retry Context Handoff…').onClick({stopPropagation(){}});html=f.render();
 assert.match(html,/same queued assignment/u);assert.doesNotMatch(html,/may duplicate changes/u);
 await assert.rejects(f.button('Retry Handoff').onClick(),/Could not confirm whether the handoff retry/u);
 f.render();await f.button('Retry Handoff').onClick();f.render();
 assert.equal(f.calls.length,2);
 assert.equal(f.calls[0][0],'request-a');assert.equal(f.calls[0][1].retryHeldContext,true);
 assert.equal(f.calls[0][1].idempotencyKey,'held-attempt-id');
 assert.equal(f.calls[1][1].idempotencyKey,f.calls[0][1].idempotencyKey);
 const u=requestFixture(t,{state:'open',retryAvailable:true});
 u.lifecycle.request.settingsTransitionHold='review_required';
 assert.match(u.render(),/assignment remains held/u);
 assert.equal(u.button('Retry Assignment…'),undefined);assert.equal(u.button('Retry Context Handoff…'),undefined);
 const ro=requestFixture(t,{state:'open',retryAvailable:false,readOnly:true});
 ro.lifecycle.request.settingsTransitionHold='retry_available';ro.render();assert.equal(ro.button('Retry Context Handoff…'),undefined);
});


test('Agent detail reserves each visible status notice before its bounded content row',()=>{
 const source=readFileSync(new URL('../../apps/web/src/components/AgentDetail.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('AgentDetail.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),matches=[];
 function walk(node){if(ts.isPropertyAssignment(node)&&node.name.getText(ast)==='gridTemplateRows'&&node.initializer.getText(ast).includes('activeBrowser'))matches.push(node.initializer);ts.forEachChild(node,walk)}walk(ast);assert.equal(matches.length,1);
 for(const activeBrowser of [undefined,{status:'opening'}])for(const detailRefreshFailed of [false,true])for(const pause of [undefined,{reason:'user'},{reason:'access_restricted'}]){
  const rows=vm.runInNewContext(matches[0].getText(ast),{activeBrowser,detailRefreshFailed,pause}),before=rows.split('minmax(0, 1fr)')[0].trim().split(/\s+/);
  assert.equal(before.length,2+Number(Boolean(activeBrowser))+Number(pause?.reason==='access_restricted'),'Only the content panel may take the flexible row');assert(before.every(row=>row==='auto'));assert.match(rows,/minmax\(0, 1fr\) auto$/);
 }
});

test('paused work receipts show waiting only for the exact cancelled Run and preserve canonical evidence',()=>{
 const exports={},primitive=({children})=>React.createElement('div',null,children),mui=Object.fromEntries(['Box','Button','Stack','Typography'].map(name=>[name,primitive]));
 const imports={react:React,'@mui/material':mui,'../../telemetryFocus':{telemetryElementId:(kind,id)=>kind+id},'../../time':{formatFinalizedWorkDuration:()=> '1s'},'../activity/ActivityStreamPane':{groupConsecutiveActions:entries=>entries},'../activity/ActivityRows':{ActionGroupRow:primitive,CompactActivityRow:primitive,ResponseRow:primitive,ThinkingRow:primitive},'../SemanticStatus':{semanticAgentStatus:state=>state,SemanticStatus:({label,status,detail,accessibleLabel})=>React.createElement('span',{'data-status':status,title:detail,'aria-label':accessibleLabel},label)},'./receiptActivityEntries':{receiptActivityEntries:entries=>entries}};
 vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/components/chat/AgentWorkReceipt.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:name=>imports[name]??require(name)});
 const run=Object.freeze({id:'paused-run',status:'cancelled',startedAt:'2026-11-06T12:00:00Z',completedAt:'2026-11-06T12:00:01Z'}),before=JSON.stringify(run);
 const render=(current,pausedRunId)=>renderToStaticMarkup(React.createElement(exports.AgentWorkReceipt,{agentName:'Restricted worker',run:current,paused:current.id===pausedRunId,entries:[]}));
 const html=render(run,run.id);
 assert.match(html,/work is paused/);assert.match(html,/>Paused<\/span>/);assert.match(html,/data-status="waiting"/);assert.match(html,/title="Run status: cancelled"/);assert.match(html,/aria-label="Paused\. Run status: cancelled"/);assert.doesNotMatch(html,/Resume to continue/);
 for(const pausedRunId of [undefined,'unrelated-current-run']){
  const stopped=render(run,pausedRunId);assert.match(stopped,/>Cancelled<\/span>/);assert.match(stopped,/data-status="failed"/);assert.doesNotMatch(stopped,/>Paused<\/span>|work is paused/);
 }
 const failed=render({...run,status:'failed'},run.id);assert.match(failed,/>Failed<\/span>/);assert.match(failed,/data-status="failed"/);assert.doesNotMatch(failed,/>Paused<\/span>/);
 const resumed=render({...run,status:'running'},undefined);assert.match(resumed,/Is Working/);assert.doesNotMatch(resumed,/>Paused<\/span>|>Cancelled<\/span>|>Failed<\/span>/);
 assert.equal(JSON.stringify(run),before,'Receipt presentation never rewrites the canonical Run');
});


test('only exact paused Run delivery displays Paused without changing canonical evidence or hold precedence',async()=>{
 const {messageDeliveryPhase}=await import('../../apps/web/src/components/messageDeliveryPhase.ts');
 const source=readFileSync(new URL('../../apps/web/src/components/MessageDeliveryStatus.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('MessageDeliveryStatus.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),functions=[];
 for(const node of ast.statements)if(ts.isFunctionDeclaration(node)&&['deliveryLabel','compactDeliveryLabel','deliveryWaitLabel'].includes(node.name?.text))functions.push(node.getText(ast));assert.equal(functions.length,3);
 const owners=vm.runInNewContext(ts.transpileModule(functions.join('\n')+';({deliveryLabel,compactDeliveryLabel})',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{messageDeliveryPhase});
 const receipt=Object.freeze({activationId:'activation',targetAgentId:'worker',state:'delivered',injectionKind:'turn',providerAcknowledged:true,injectionId:'injection',executionId:'paused-run'}),before=JSON.stringify(receipt);
 assert.equal(owners.compactDeliveryLabel(receipt,'paused-run'),'Paused');assert.match(owners.deliveryLabel(receipt,'Worker','paused-run'),/delivered.*paused/);assert.doesNotMatch(owners.deliveryLabel(receipt,'Worker','paused-run'),/active|Resume|continue/);
 for(const pausedRunId of [undefined,'foreign-run'])assert.equal(owners.compactDeliveryLabel(receipt,pausedRunId),'Working');
 assert.equal(owners.compactDeliveryLabel({...receipt,state:'processed'},'paused-run'),'Processed');
 assert.equal(owners.compactDeliveryLabel({...receipt,taskDecisionRepairHold:true},'paused-run'),'Task Check Held');
 assert.equal(owners.compactDeliveryLabel({...receipt,settingsTransitionHold:'review_required'},'paused-run'),'Waiting For Context');
 assert.equal(owners.compactDeliveryLabel({...receipt,settingsTransitionHold:'review_required',contextRecoveryRequired:{sourceRunId:'earlier'}},'paused-run'),'Message Saved');
 assert.match(owners.deliveryLabel({...receipt,contextRolloverHold:'review_required'},'Worker','paused-run'),/Context refresh could not safely continue/);
 assert.equal(JSON.stringify(receipt),before,'No delivery/task/Run authority is rewritten');
});

test('Work shows recorded Chat renames and system titles while keeping generic legacy changes unknown',()=>{
 const exports={},noop=()=>{},data={projectId:'p',conversationId:'chat',generatedAt:'2026-11-07T00:00:00Z',agents:[],traces:[],items:[],chatChanges:{truncated:true,items:[
  {id:3,projectId:'p',conversationId:'chat',createdAt:'2026-11-07T00:00:03Z'},
  {id:2,projectId:'p',conversationId:'chat',createdAt:'2026-11-07T00:00:02Z',titleChange:{previousTitle:'New Chat',title:'Automatic orchard title',actor:{kind:'system'},origin:'automatic_title'}},
  {id:1,projectId:'p',conversationId:'chat',createdAt:'2026-11-07T00:00:01Z',titleChange:{previousTitle:'Original orchard',title:'Reviewed orchard',actor:{kind:'operator_api'},origin:'operator_request',requestId:'actual-recorded-request'}},
 ]}};
 const imports={react:React,'@tanstack/react-query':{useQuery:()=>({data,isLoading:false,isFetching:false,isError:false,refetch:noop})},'../api':{api:{}},'../queryKeys':{queryKeys:{agentWork:{list:()=>['work']}}},'../clipboard':{copyText:noop},'./MutationNotifications':{useMutationNotification:()=>noop},'./PrimaryHeaderActions':{PrimaryHeaderActionsOutlet:({children})=>React.createElement('div',null,children)},'./RequestLifecycleCard':{RequestLifecycleCard:()=>null},'./chat/scroll':{isChatNearBottom:()=>true,scrollChatToBottom:noop,ScrollToLatestButton:()=>null}};
 vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/components/AgentWorkInspector.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:name=>imports[name]??require(name)});
 const html=renderToStaticMarkup(React.createElement(exports.AgentWorkInspector,{open:true,projectId:'p',conversationId:'chat',onClose:noop}));
 assert.match(html,/Chat Changes/u);assert.equal((html.match(/>Chat renamed</gu)??[]).length,2);assert.match(html,/Chat settings changed/u);
 assert.match(html,/Original orchard/u);assert.match(html,/Reviewed orchard/u);assert.match(html,/Operator request/u);assert.match(html,/System automatic title/u);assert.match(html,/actual-recorded-request/u);assert.match(html,/Not recorded/u);assert.match(html,/Older events remain preserved/u);
 assert.doesNotMatch(html,/Authenticated operator|Recovered rename|Unknown rename/u);
});
