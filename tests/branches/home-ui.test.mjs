import assert from 'node:assert/strict';
import test from 'node:test';
import '../shared/web-typescript-loader.mjs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
const {BranchNotifications}=await import('../../apps/web/src/components/branches/BranchNotifications.tsx');
const {BranchHome}=await import('../../apps/web/src/components/branches/BranchHome.tsx');
const {branchHomeItems,useBranchHome}=await import('../../apps/web/src/hooks/useBranchHome.ts');
const {queryKeys}=await import('../../apps/web/src/queryKeys.ts');
const props={engines:[],enginesLoaded:true,onRetryEngines(){},onNavigate(){},onCreate(){},onImport(){},creating:false};
const execution=(id,state='running')=>({id,branchId:'outside-sidebar',branchName:'Workflow outside the filtered sidebar',state,createdAt:'2026-10-23T12:00:00Z',updatedAt:'2026-10-23T12:00:00Z',operational:{state,label:state==='waiting_human'?'Waiting for approval':state[0].toUpperCase()+state.slice(1)}});
const home=()=>({observedAt:'2026-10-23T12:00:00Z',workflowCount:150,activeExecutionCount:120,openActionCount:55,branchNames:{'outside-sidebar':'Workflow outside the filtered sidebar'},activeExecutions:{items:[execution('run-one'),execution('run-two','waiting_human')],nextCursor:'active-next'},recentOutcomes:{items:['completed','failed','canceled','skipped','merged'].map(state=>execution(state,state)),nextCursor:'outcome-next'},attention:{items:[{id:'approval',branchId:'outside-sidebar',kind:'decision',status:'open',severity:'attention',title:'Approve this step',body:'Approval is required',createdAt:'2026-10-23T12:00:00Z'}]}});
function fixture(){
 const client=new QueryClient({defaultOptions:{queries:{retry:false,retryOnMount:false,refetchOnMount:false,gcTime:Infinity}}});
 const set=(section,data)=>client.setQueryData(queryKeys.branchesHome.section(section),{pages:[data],pageParams:[undefined]});
 const render=()=>renderToStaticMarkup(React.createElement(QueryClientProvider,{client},React.createElement(BranchHome,props)));
 const fail=(section,extra={})=>client.getQueryCache().find({queryKey:queryKeys.branchesHome.section(section)}).setState({status:'error',error:new Error('HTTP 503'),fetchStatus:'idle',...extra});
 return {client,set,render,fail};
}

test('workflow Home uses exact cross-workflow totals and distinct execution cards with canonical outcomes',t=>{
 const f=fixture();t.after(()=>f.client.clear());f.set('active',home());f.set('outcomes',home());const html=f.render();
 assert.match(html,/Across your workflows/);assert.match(html,/>120</);assert.match(html,/>55</);
 assert.match(html,/Execution run-one/);assert.match(html,/Execution run-two/);assert.match(html,/Waiting for approval/);
 for(const state of ['Completed','Failed','Canceled','Skipped','Merged'])assert.match(html,new RegExp(`>${state}<`));
 assert.doesNotMatch(html,/No executions are active|loaded workflow directory|Start Your First Workflow|No Agents/);
 assert.match(html,/Load more active executions/);assert.match(html,/Load more outcomes/);assert.match(html,/View all/);
 assert.match(html,/Script-only workflows can still run/);
});

test('Home distinguishes loading and initial failure from valid zero and preserves cached cards on refresh failure',t=>{
 const f=fixture();t.after(()=>f.client.clear());let html=f.render();assert.match(html,/Loading Home summary/);assert.doesNotMatch(html,/Nothing currently needs your attention|No executions are active/);
 f.fail('active');f.fail('outcomes');html=f.render();assert.match(html,/Workflow Home could not be loaded/);assert.match(html,/Unavailable/);assert.doesNotMatch(html,/Nothing currently needs your attention|No executions are active/);
 f.set('active',home());f.set('outcomes',home());f.fail('active');html=f.render();assert.match(html,/Last loaded counts and cards are still available/);assert.match(html,/Execution run-one/);assert.match(html,/>120</);assert.match(html,/Retry workflow Home/);
 f.set('active',home());f.fail('outcomes',{fetchMeta:{fetchMore:{direction:'forward'}}});html=f.render();assert.match(html,/next page could not be loaded/);assert.doesNotMatch(html,/Home could not refresh/);assert.match(html,/Execution run-one/);assert.match(html,/Retry next page/);
 const empty=home();empty.workflowCount=0;empty.activeExecutionCount=0;empty.openActionCount=0;empty.activeExecutions={items:[]};empty.recentOutcomes={items:[]};empty.attention={items:[]};f.set('active',empty);f.set('outcomes',empty);html=f.render();assert.match(html,/Start Your First Workflow/);assert.match(html,/New workflow/);assert.match(html,/Import workflow/);assert.match(html,/Nothing currently needs your attention/);assert.match(html,/No executions are active right now/);assert.doesNotMatch(html,/could not|Retry next page|Load more/);
});

test('one section may fail or remain pending without claiming the other section is empty',t=>{
 const f=fixture();t.after(()=>f.client.clear());f.set('active',home());let html=f.render();
 assert.match(html,/Execution run-one/);assert.match(html,/Loading recent outcomes/);assert.doesNotMatch(html,/Finished workflow executions will appear/);
 f.fail('outcomes');html=f.render();assert.match(html,/Recent outcomes could not be loaded/);assert.match(html,/Home summary could not be fully loaded/);assert.match(html,/Execution run-one/);assert.doesNotMatch(html,/Finished workflow executions will appear/);
 f.set('outcomes',home());f.client.removeQueries({queryKey:queryKeys.branchesHome.section('active')});html=f.render();assert.match(html,/Loading active executions/);assert.doesNotMatch(html,/No executions are active/);
 f.fail('active');html=f.render();assert.match(html,/Active executions could not be loaded/);assert.match(html,/>120</);assert.doesNotMatch(html,/No executions are active/);assert.match(html,/>Completed</);
});

test('explicit pagination deduplicates execution IDs rather than grouping multiple runs of one workflow',()=>{
 const first=home(),next=home();next.activeExecutions.items=[execution('run-two','failed'),execution('run-three')];
 assert.deepEqual(branchHomeItems([first,next],'activeExecutions').map(row=>row.id),['run-one','run-two','run-three']);
 assert.equal(branchHomeItems([first,next],'activeExecutions')[1].state,'waiting_human','A stale overlapping page must not replace the newest first-page status');
 assert.deepEqual(branchHomeItems(undefined,'recentOutcomes'),[]);
});

test('both Home sections share their initial request and Retry joins in-flight work; each Load more uses its own cursor',async t=>{
 const f=fixture();t.after(()=>f.client.clear());let query;
 function Probe(){query=useBranchHome();return null}
 const render=()=>renderToStaticMarkup(React.createElement(QueryClientProvider,{client:f.client},React.createElement(Probe)));
 let release,started,calls=[];const pending=new Promise(resolve=>release=resolve),requestStarted=new Promise(resolve=>started=resolve),original=globalThis.fetch;
 globalThis.fetch=async url=>{calls.push(String(url));started();await pending;const page=home();if(String(url).includes('activeCursor='))page.activeExecutions={items:[execution('run-three')]};if(String(url).includes('outcomeCursor='))page.recentOutcomes={items:[execution('older','failed')]};return new Response(JSON.stringify(page),{headers:{'content-type':'application/json'}})};
 t.after(()=>{globalThis.fetch=original});render();const first=query.active.refetch({cancelRefetch:false}),second=query.outcomes.refetch({cancelRefetch:false}),again=query.active.refetch({cancelRefetch:false});
 await requestStarted;assert.deepEqual(calls,['/api/branches/home']);release();await Promise.all([first,second,again]);render();
 assert.equal(query.active.hasNextPage,true);assert.equal(query.outcomes.hasNextPage,true);
 await query.active.fetchNextPage({cancelRefetch:false});await query.outcomes.fetchNextPage({cancelRefetch:false});
 assert.deepEqual(calls,['/api/branches/home','/api/branches/home?activeCursor=active-next','/api/branches/home?outcomeCursor=outcome-next']);render();assert.equal(query.active.hasNextPage,false);assert.equal(query.outcomes.hasNextPage,false);
});

test('provider attention uses the existing settings destination without trying to open its old Chat',t=>{
 const f=fixture();t.after(()=>f.client.clear());let actions;const routes=[];
 renderToStaticMarkup(React.createElement(QueryClientProvider,{client:f.client},React.createElement(BranchNotifications,{onNavigate:route=>routes.push(route),children:value=>{actions=value;return null}})));
 actions.openNotification({id:'sign-in',kind:'operational',branchId:'b',projectId:'old-project',conversationId:'deleted-chat',action:{kind:'open_settings',targetId:'codex'}});
 assert.deepEqual(routes,[{tab:'workflow',global:'providers'}]);
});
