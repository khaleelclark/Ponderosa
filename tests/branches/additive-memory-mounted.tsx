// Offline mounted dialog: production component, React Query and real HTTP routes.
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {useState} from 'react';
import {BranchPackageDialog} from '../../apps/web/src/components/branches/BranchPackageDialog';
import type {InstalledBranchPackage} from '@ponderosa/core';
const cache=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
function Fixture({fixture}:{fixture:{pkg:InstalledBranchPackage;branchId:string}}){
 const [open,setOpen]=useState(false),[installed,setInstalled]=useState(false);
 return <QueryClientProvider client={cache}><button onClick={()=>setOpen(true)}>Open update</button>{installed&&<p>Installed successfully</p>}
 {open&&<BranchPackageDialog pkg={fixture.pkg} branchId={fixture.branchId} branches={[]} engines={[{id:'fixture',displayName:'Fixture',models:[{id:'fixture',label:'Fixture'}],efforts:[{id:'medium',label:'Medium'}],configured:true,authentication:'authenticated',intakeReady:false,reachability:'unverified'}]} onClose={()=>setOpen(false)} onInstalled={()=>{setInstalled(true);setOpen(false);return true}}/>}
 </QueryClientProvider>;
}
void fetch('/fixture').then(r=>r.json()).then(fixture=>createRoot(document.getElementById('root')!).render(<Fixture fixture={fixture}/>));
