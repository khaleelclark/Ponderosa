// Browser-only fixture: production components, hooks, query cache and EventSource transport.
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {BranchLiveOutputs} from '../../apps/web/src/components/branches/BranchLiveOutput';
import {queryKeys} from '../../apps/web/src/queryKeys';
import {useState} from 'react';
const cache=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
function Fixture(){
 const [run,setRun]=useState('current-run'),[mounted,setMounted]=useState(true);
 return <QueryClientProvider client={cache}>
 <button onClick={()=>cache.setQueryData(queryKeys.agents.detail('worker',7),{agent:{id:'worker',projectId:'project'},activity:[],runs:[],workItems:[],artifacts:[],changedFiles:[],runOutput:[{id:'stale',executionId:'current-run',kind:'response',text:'STALE HISTORY PAGE'}]})}>Cache history page</button>
 <button onClick={()=>setRun('replacement-run')}>Replace Run</button>
 <button onClick={()=>setMounted(false)}>Unmount</button>
 {mounted&&<BranchLiveOutputs targets={[{agentId:'worker',projectId:'project',stepId:'work',attemptId:'attempt',runId:run}]} labels={{work:'Controlled Step'}}/>}
 </QueryClientProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
