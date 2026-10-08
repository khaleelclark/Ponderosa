import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {Button,CssBaseline,Stack,ThemeProvider} from '@mui/material';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {BranchExecutionBudget} from '../../src/components/branches/BranchExecutionBudget';
import {createPonderosaTheme} from '../../src/theme';
import type {BranchExecutionBudgetDto} from '@ponderosa/core';
const scenario=new URLSearchParams(location.search).get('scenario');
let failed=false;
let state:BranchExecutionBudgetDto={branchId:'fixture',revision:1,policy:{limit:2,period:'day'},used:2,allowance:0,periodId:'period-one',periodStartedAt:'2026-10-08T00:00:00.000Z',resetsAt:'2026-10-09T00:00:00.000Z',heldCount:1,observedAt:'2026-10-08T12:00:00.000Z'};
const receipts=new Map<string,{hash:string;result:BranchExecutionBudgetDto}>();
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
window.fetch=async(_url,init)=>{
 const method=init?.method??'GET';
 if(method==='GET'){
  if(scenario==='loadfail'&&!failed){failed=true;return response({error:'Fixture budget unavailable'},503)}
  return response(state);
 }
 const input=JSON.parse(String(init?.body)),hash=JSON.stringify(input),prior=receipts.get(input.commandKey);
 if(prior)return prior.hash===hash?response(prior.result):response({error:'Budget command idempotency conflict'},409);
 if(scenario==='conflict'&&!failed){failed=true;state={...state,revision:state.revision+1,periodId:'period-two',used:0};return response({error:'Budget revision or period conflict; refresh before trying again'},409)}
 if(input.expectedRevision!==state.revision||input.expectedPeriodId!==state.periodId)return response({error:'Budget revision or period conflict; refresh before trying again'},409);
 if(method==='POST')state={...state,revision:state.revision+1,allowance:state.allowance+input.additional};
 else state={...state,revision:state.revision+1,policy:input.policy,...(input.policy?.period!==state.policy?.period?{used:0,allowance:0,periodId:'new-period'}:{})};
 receipts.set(input.commandKey,{hash,result:state});
 if(scenario==='unknown'&&!failed){failed=true;throw new TypeError('Fixture response lost after commit')}
 return response(state);
};
const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
function Fixture(){const [settings,setSettings]=useState(false);return <QueryClientProvider client={client}><ThemeProvider theme={createPonderosaTheme('light')}><CssBaseline/><Stack spacing={2} sx={{p:2,maxWidth:800}}><Button onClick={()=>setSettings(!settings)}>{settings?'Show Executions':'Show Settings'}</Button><BranchExecutionBudget key={String(settings)} branchId="fixture" settings={settings}/></Stack></ThemeProvider></QueryClientProvider>}
createRoot(document.getElementById('root')!).render(<Fixture/>);
