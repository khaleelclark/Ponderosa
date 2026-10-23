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
 const f=fixture();assert.deepEqual([...f.chats[0].pendingDecisions],[one]);assert.ok(f.attention.every(p=>p.notifications.every(n=>n.kind!=='decision')));
 assert.match(f.html,/Vicksburg has a decision/);assert.doesNotMatch(f.html,/BOUNDED PREVIEW|still open|FULL CANONICAL QUESTION/);assert.match(f.html,/View decision/);
});
test('the compact count deduplicates Decision IDs, counts a question bundle once and ignores resolved/foreign records',()=>{
 const grouped={...one,questions:[{id:'a'},{id:'b'},{id:'c'}]},second={...one,id:'decision-b'};
 const f=fixture([grouped,grouped,second,{...one,id:'resolved',status:'resolved'},{...one,id:'foreign',agentId:'elsewhere'}]);
 assert.equal(f.chats[0].pendingDecisions.length,2);assert.match(f.html,/Vicksburg has 2 decisions/);assert.match(f.html,/Existing Notifications/);
 assert.doesNotMatch(f.html,/3 decisions|BOUNDED PREVIEW/);
});
test('an empty canonical pending set hides only the decision notice and retains recovery notifications',async()=>{
 const f=fixture([]);assert.doesNotMatch(f.html,/has a decision|has 0 decisions/);assert.equal(f.attention[0].notifications.length,1);assert.equal(f.attention[0].notifications[0].id,'other');
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
