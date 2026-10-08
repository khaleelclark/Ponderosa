import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {CssBaseline,ThemeProvider} from '@mui/material';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {BranchesView} from '../../src/components/BranchesView';
import {MutationNotificationProvider} from '../../src/components/MutationNotifications';
import {createPonderosaTheme} from '../../src/theme';
import {realApi} from '../../src/api/real';
import type {BranchExecutionBudgetDto,BranchOperationalSummaryDto} from '@ponderosa/core';
import '../../src/global.css';
const now='2026-09-22T00:00:00Z';
const branch={id:'b',name:'Qualification workflow',chatId:'c',enabled:false,versionId:'v',activeExecutions:0,createdAt:now};
const otherBranch={...branch,id:'b2',name:'Other workflow',versionId:'v-b2'};
const definition={schema:'ponderosa.branch.v1',name:branch.name,trigger:{kind:'manual'},parameters:{message:{type:'text',help:'Message to process'}},entry:'script',steps:[{id:'script',kind:'script',runtime:'node',source:'return input',cwdRef:'workspace',timeoutMs:1000}],controls:[],edges:[],policy:{maxConcurrentExecutions:1,failure:{action:'stop'}}};
const project={id:'p',label:'Branch workspace',hostPath:'/tmp/qualification',defaultEngine:'codex',createdAt:now};
const chat={id:'c',branchId:'b',projectId:'p',title:'Branch Chat',workingDirectory:'/tmp/qualification',defaultEngine:'codex',createdAt:now};
const preferences={revision:1,profile:{displayName:'Tester',handle:'tester',avatarId:'default-user'},notifications:{directResponses:true,broadcasts:true},starredProjectIds:[],starredResourceIds:[],projectOrder:[],chatOrder:[],agentOrder:[],triggerOrder:[],engineDefaults:{},claudeModelOptions:[],globalInstructions:'',maxConcurrentAgentRuns:8,providerAvailability:{},contextRolloverTokens:150000,contextRolloverWindowFraction:.7};
const notificationPage={items:[],openActionCount:0,unacknowledgedActionCount:0,unreadUpdateCount:0};
const execution={id:'e',branchId:'b',versionId:'v',bindingRevisionId:'bindings',occurrenceKey:'fixture',input:'',inputHash:'hash',state:'completed',revision:1,createdAt:now,updatedAt:now};
const fixtureParams=new URLSearchParams(location.search);
let failSettings=fixtureParams.has('failSettings');
const emptyChats=fixtureParams.has('emptyChats');
const failPreferences=fixtureParams.has('failPreferences');
const slowProjectResources=fixtureParams.has('slowProjectResources');
const failProjectResources=fixtureParams.has('failProjectResources');
const slowRollover=fixtureParams.has('slowRollover');
const rejectRollover=fixtureParams.has('rejectRollover');
const backgroundDeploy=fixtureParams.has('backgroundDeploy');
const backgroundDeployDirty=fixtureParams.has('backgroundDeployDirty');
const failBackgroundVersionOnce=fixtureParams.has('failBackgroundVersionOnce');
const slowPackageFinish=fixtureParams.has('slowPackageFinish');
let branchFetchCount=0,version2FetchCount=0,packageFinalFetch=false;
let preferenceState={...preferences};
let createdChat:typeof chat|undefined;
window.fetch=async(input,init)=>{
 const requestUrl=new URL(String(input),location.origin),path=requestUrl.pathname.replace('/api/branches/engine/','/api/');
 let value:unknown=[];
 if(path==='/api/branches/install-preview'&&init?.method==='POST')return new Response(JSON.stringify({id:'install-op',operations:[]}),{headers:{'content-type':'application/json'}});
 if(path==='/api/branches/installations/install-op/confirm'&&init?.method==='POST'){packageFinalFetch=true;return new Response(JSON.stringify({state:'completed',branchId:'b'}),{headers:{'content-type':'application/json'}});}
 if(path==='/api/branches/installations/install-op')return new Response(JSON.stringify({state:'completed',branchId:'b'}),{headers:{'content-type':'application/json'}});
 if(path==='/api/branches/b/chats'&&init?.method==='POST'){
  const body=JSON.parse(String(init.body));createdChat={...chat,id:'created-chat',projectId:'p',title:body.label??'New Chat'};
  return new Response(JSON.stringify(createdChat),{headers:{'content-type':'application/json'}});
 }
 if(path==='/api/branches')value=[branch,otherBranch];
 else if(path==='/api/branches/missing')return new Response(JSON.stringify({error:'Branch not found'}),{status:404,headers:{'content-type':'application/json'}});
 else if(path==='/api/branches/b'){const fetchCount=++branchFetchCount;if(slowPackageFinish&&packageFinalFetch){packageFinalFetch=false;await new Promise(resolve=>setTimeout(resolve,1500));}if(backgroundDeployDirty&&fetchCount>1)await new Promise(resolve=>setTimeout(resolve,1200));value=(backgroundDeploy||backgroundDeployDirty)&&fetchCount>1?{...branch,name:'Deployed workflow',versionId:'v2'}:branch;}
 else if(path==='/api/branches/b2')value=otherBranch;
 else if(path==='/api/branches/b/versions/v')value={id:'v',branchId:'b',definition,createdAt:now};
 else if(path==='/api/branches/b/versions/v2'){if(failBackgroundVersionOnce&&++version2FetchCount===1)return new Response(JSON.stringify({error:'Deployed version temporarily unavailable'}),{status:503,headers:{'content-type':'application/json'}});value={id:'v2',branchId:'b',definition:{...definition,name:'Deployed workflow'},createdAt:now};}
 else if(path==='/api/branches/b2/versions/v-b2')value={id:'v-b2',branchId:'b2',definition:{...definition,name:'Other workflow'},createdAt:now};
 else if(path==='/api/branches/b/configuration'||path==='/api/branches/b2/configuration')value={agents:{},directories:{workspace:'/tmp/qualification'}};
 else if(path==='/api/branches/b/chats')value=createdChat?[createdChat]:(emptyChats?[]:[chat]);
 else if(path==='/api/branches/b2/chats')value=[];
 else if(path==='/api/branches/contexts/foreign')return new Response(JSON.stringify({error:'Chat not found'}),{status:404,headers:{'content-type':'application/json'}});
 else if(path==='/api/branches/contexts/created-chat')value=createdChat;
 else if(path==='/api/branches/contexts/execution-chat')value={...chat,id:'execution-chat',executionId:'e2'};
 else if(path==='/api/branches/contexts/c')value=chat;
 else if(path==='/api/branches/b/executions')value=[execution];
 else if(/^\/api\/branches\/b2?\/execution-budget$/.test(path))value={branchId:path.split('/')[3]!,revision:0,policy:null,used:0,allowance:0,periodId:null,periodStartedAt:null,heldCount:0,observedAt:now} satisfies BranchExecutionBudgetDto;
 else if(/^\/api\/branch-executions\/e2?\/operations$/.test(path))value={executionId:path.split('/')[3]!,state:'completed',label:'Completed',observedAt:now,counts:{completed:0,running:0,retrying:0,failed:0,waitingAgent:0,waitingHuman:0,needsReconciliation:0,mapItems:0,mapSettled:0},agentWaits:[],additionalAgentWaits:0} satisfies BranchOperationalSummaryDto;
 else if(path==='/api/branch-executions/e')value={execution,steps:[],attempts:[],paths:[],gates:[],resources:[],waits:[],decisions:[]};
 else if(path==='/api/branch-executions/e2')value={execution:{...execution,id:'e2'},steps:[],attempts:[],paths:[],gates:[],resources:[],waits:[],decisions:[]};
 else if(path==='/api/branches/b/lifecycle'||path==='/api/branches/b2/lifecycle')value={deleting:false,chats:1,activeExecutions:0,callers:[],pendingRemoval:[],updates:[]};
 else if(path==='/api/branches/b/settings'||path==='/api/branches/b2/settings'){
  if(failSettings){failSettings=false;return new Response(JSON.stringify({error:'Qualification initial load failure'}),{status:503,headers:{'content-type':'application/json'}})}
  value={configuration:{parameters:{message:'saved'},limits:{maxCallDepth:10,maxLoopIterations:100,maxTraversals:100}},revision:1};
 }else if(path.endsWith('/capabilities')&&path.startsWith('/api/branches/'))value={policy:{revision:1,restrictedCapabilityIds:[]},effective:{restrictionSources:{}},catalog:[]};
 else if(path.endsWith('/dependencies'))value={calls:[],callers:[]};
 else if(path==='/api/engines')value=[{id:'codex',displayName:'Codex',models:[{id:'fixture-model',label:'Fixture model'}],efforts:[],configured:true,enabled:true,authentication:'authenticated',intakeReady:true,reachability:'reachable'}];
 else if(path.endsWith('/preferences')){
  if(failPreferences)return new Response(JSON.stringify({error:'Preferences unavailable'}),{status:503,headers:{'content-type':'application/json'}});
  if(init?.method&&init.method!=='GET'){
   const patch=JSON.parse(String(init.body));if('contextRolloverTokens' in patch||'contextRolloverWindowFraction' in patch){if(slowRollover)await new Promise(resolve=>setTimeout(resolve,500));if(rejectRollover)return new Response(JSON.stringify({error:'Rollover save rejected'}),{status:503,headers:{'content-type':'application/json'}})}
   preferenceState={...preferenceState,...patch,revision:preferenceState.revision+1};
  }
  value=preferenceState;
 }
 else if(path==='/api/projects/p')value=project;
 else if(path==='/api/projects')value=[project];
 else if(path==='/api/projects/p/conversations'){if(slowProjectResources)await new Promise(resolve=>setTimeout(resolve,1200));if(failProjectResources)return new Response(JSON.stringify({error:'Project Chats unavailable'}),{status:503,headers:{'content-type':'application/json'}});value=[chat,...(createdChat?[createdChat]:[])];}
 else if(path==='/api/projects/p/agents'){if(slowProjectResources)await new Promise(resolve=>setTimeout(resolve,1200));if(failProjectResources)return new Response(JSON.stringify({error:'Project Agents unavailable'}),{status:503,headers:{'content-type':'application/json'}});value=[];}
 else if(path==='/api/projects/p/agent-organization')value={scope:'project',items:[],total:0,limit:25,collectionGeneration:'fixture',specialGroupCounts:{independent:0,orphaned:0,deleted:0}};
 else if(path==='/api/conversations/c'||path==='/api/conversations/created-chat')value={conversation:path.endsWith('created-chat')?createdChat:chat,messages:[],history:{hasMore:false},agents:[],members:{total:0,limit:100,hasMore:false},events:[],receipts:[]};
 else if(path.includes('members'))value=[];
 else if(path.endsWith('/agent-health'))value={agents:[]};
 else if(path.includes('/next-run-deliveries'))value={receipts:[]};
 else if(path.includes('/draft'))value={text:'',attachmentIds:[],revision:0};
 else if(path.includes('notifications'))value=notificationPage;
 else if(path.includes('provider-usage'))value={providers:[]};
 else if(path.endsWith('/health'))value={status:'ok',instanceId:'test'};
 else if(path.includes('receipts'))value={items:[]};
 if(init?.method&&init.method!=='GET')throw new Error('Fixture blocks mutations');
 return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
};
realApi.subscribeWorkspace=(()=>({close(){}})) as typeof realApi.subscribeWorkspace;
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
function Fixture(){const [mode,setMode]=useState<'light'|'dark'>(new URLSearchParams(location.search).has('dark')?'dark':'light');return <QueryClientProvider client={client}><ThemeProvider theme={createPonderosaTheme(mode)}><CssBaseline/><MutationNotificationProvider><BranchesView colorMode={mode} onToggleColorMode={()=>setMode(m=>m==='light'?'dark':'light')}/></MutationNotificationProvider></ThemeProvider></QueryClientProvider>}
createRoot(document.getElementById('root')!).render(<Fixture/>);
