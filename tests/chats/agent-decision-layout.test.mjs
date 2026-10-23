import '../shared/web-typescript-loader.mjs';
const {ApiRequestError}=await import('../../apps/web/src/api/types.ts');
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
 assert.match(f.html,/Vicksburg has a decision/);assert.doesNotMatch(f.html,/BOUNDED PREVIEW|still open|FULL CANONICAL QUESTION/);assert.match(f.html,/View decision/);
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
 const imports={react:React,'@mui/material':{Box:({children,id,tabIndex})=>React.createElement('article',{id,tabIndex},children)},'../decisions/DecisionCard':{DecisionCard:p=>{cards.push(p.decision);return React.createElement('p',null,p.decision.question);}},'../CopyMessageButton':{},'../MessageDeliveryStatus':{},'../MessageRequestAction':{},'../activity/activityStream':{buildActivityStream:()=>[]},'./AgentWorkReceipt':{},'./receiptActivityEntries':{},'./ChatMessageFrame':{},'./LiveAgentProgress':{},'./ChatSurface':{ChatSurface:p=>{surfaces.push(p);return React.createElement('section',null,p.beforeMessages,p.children);}},'./ChatMessages':{chatMessageLayoutKey:()=>''},'./agentChatProjection':{projectAgentChat:()=>({messages:[],runs:[]})},'../speech/ReadAloudControls':{},'../decisions/DecisionResponseMessage':{DecisionResponseMessage:noop}};
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
 const slots=[],buttons=[],dialogs=[],calls=[],invalidations=[],queries=[];let index=0,observer,unsubscribe;
 const lifecycle={request:{id:'request-a',state,text:'Exact canonical assignment',retryAvailable},updates:[]};
 const react={useState(initial){const i=index++;slots[i]??={value:typeof initial==='function'?initial():initial};return[slots[i].value,value=>{slots[i].value=typeof value==='function'?value(slots[i].value):value;}];},useEffect(){},useMemo:fn=>fn()};
 const primitive=({children})=>React.createElement('div',null,children);
 const mui=Object.fromEntries(['Accordion','AccordionDetails','AccordionSummary','Alert','Box','Chip','CircularProgress','DialogActions','DialogContent','DialogTitle','Paper','Stack','Typography'].map(name=>[name,primitive]));
 mui.Button=p=>{buttons.push(p);return React.createElement('button',{disabled:p.disabled},p.children);};
 mui.Dialog=p=>{dialogs.push(p);return p.open?React.createElement('section',null,p.children):null;};
 const exports={},keys={agentWork:{all:['agent-work'],detail:(...args)=>['agent-work',...args]},notifications:{all:['notifications']}};
 vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../apps/web/src/components/RequestLifecycleCard.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,Error,require:name=>({react,'../api/types':{ApiRequestError},'@mui/material':mui,'@tanstack/react-query':{useQuery:options=>{queries.push(options);return{data:{requestLifecycle:lifecycle}};},useQueryClient:()=>client,useMutation:options=>{if(!observer){observer=new MutationObserver(client,options);unsubscribe=observer.subscribe(()=>{});}else observer.setOptions(options);return observer.getCurrentResult();}},'../api':{api:{retryCoordinationRequest:(...args)=>{calls.push(args);return retryCommand(...args);}}},'../queryKeys':{queryKeys:keys},'./WorkspaceReadOnlyContext':{useWorkspaceReadOnly:()=>readOnly}}[name]??require(name))});
 client.invalidateQueries=async({queryKey})=>{invalidations.push([...queryKey]);};
 const render=()=>{index=0;buttons.length=0;dialogs.length=0;const tree=exports.RequestLifecycleCard({projectId:'project-a',conversationId:'chat-a',requestId:'request-a',state,recipientAgentId:'worker',requesterAgentId:'manager',updatedAt:'2026-10-23T00:00:00Z',defaultExpanded:expanded,agentTitle:id=>id??'You'});return renderToStaticMarkup(tree);};
 const button=label=>buttons.find(p=>p.children===label);
 t.after(()=>{unsubscribe?.();client.clear();});
 return{render,button,dialogs,calls,invalidations,queries,lifecycle,observer:()=>observer};
}

test('assignment Retry exists only inside expanded canonical eligible recovery, never read-only or superseded work',t=>{
 for(const options of [{expanded:false},{readOnly:true},{retryAvailable:false},{retryAvailable:false,state:'completed'}]){
  const f=requestFixture(t,options);f.render();assert.equal(f.button('Retry assignment…'),undefined);assert.equal(f.calls.length,0);
 }
 const f=requestFixture(t,{state:'outcome_unknown'});f.render();assert.ok(f.button('Retry assignment…'));assert.equal(f.queries[0].enabled,true);assert.deepEqual([...f.queries[0].queryKey],['agent-work','project-a','chat-a','request:request-a']);
});

test('Retry requires explicit side-effect confirmation, preserves exact scope and hides after canonical acceptance',async t=>{
 let release;const f=requestFixture(t,{retryCommand:()=>new Promise(resolve=>{release=resolve;})});
 f.render();f.button('Retry assignment…').onClick();let html=f.render();assert.match(html,/Exact canonical assignment/);assert.match(html,/may duplicate changes/);assert.equal(f.calls.length,0);
 f.button('Not now').onClick();f.render();assert.equal(f.dialogs[0].open,false);assert.equal(f.calls.length,0);
 f.button('Retry assignment…').onClick();f.render();const saving=f.button('Retry assignment').onClick();await new Promise(resolve=>setImmediate(resolve));f.render();
 assert.equal(f.button('Starting…').disabled,true);assert.equal(f.button('Not now').disabled,true);assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'request-a');assert.equal(f.calls[0][1].idempotencyKey,'operator-retry:request-a');
 release({requestIds:['successor'],retryOfRequestId:'request-a'});await saving;f.render();assert.equal(f.dialogs[0].open,false);assert.equal(f.button('Retry assignment…'),undefined,'stale eligible detail must not offer a second retry');assert.deepEqual(f.invalidations.sort(),[['agent-work'],['notifications']]);
});

test('failed Retry retains the same command identity and error; changed canonical eligibility blocks submission',async t=>{
 let attempt=0;const f=requestFixture(t,{retryCommand:async()=>{if(++attempt===1)throw Error('Connection lost');return{requestIds:['successor'],retryOfRequestId:'request-a'};}});
 f.render();f.button('Retry assignment…').onClick();f.render();await assert.rejects(f.button('Retry assignment').onClick(),/Could not confirm whether the retry started/);assert.match(f.render(),/Could not confirm whether the retry started/);assert.equal(f.dialogs[0].open,true);
 await f.button('Retry assignment').onClick();f.render();assert.equal(f.calls.length,2);assert.equal(f.calls[0][1].idempotencyKey,f.calls[1][1].idempotencyKey);assert.equal(f.button('Retry assignment…'),undefined);
 const stale=requestFixture(t);stale.render();stale.button('Retry assignment…').onClick();stale.lifecycle.request.retryAvailable=false;stale.render();assert.equal(stale.button('Retry assignment').disabled,true);await assert.rejects(stale.button('Retry assignment').onClick(),/cannot be retried/);assert.equal(stale.calls.length,0);
});


for(const result of [undefined,{requestIds:[]},{requestIds:['next'],retryOfRequestId:'foreign'}])test('unconfirmed Retry success retains confirmation and stable identity',async t=>{
 const f=requestFixture(t,{retryCommand:async()=>result});f.render();f.button('Retry assignment…').onClick();f.render();await assert.rejects(f.button('Retry assignment').onClick(),/Could not confirm/);f.render();assert.equal(f.dialogs[0].open,true);assert.equal(f.invalidations.length,0);assert.ok(f.button('Retry assignment…'));
});
test('definite Retry rejection preserves the actionable server explanation',async t=>{
 const f=requestFixture(t,{retryCommand:async()=>{throw new ApiRequestError(409,'Request participants are no longer available');}});f.render();f.button('Retry assignment…').onClick();f.render();await assert.rejects(f.button('Retry assignment').onClick(),/participants/);assert.doesNotMatch(f.render(),/Could not confirm/);
});
