import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {Composer} from '../../src/components/chat/Composer';
function Fixture(){
 const [request,setRequest]=useState<{id:string;text:string}>();
 const params=new URLSearchParams(location.search);
 const replyHandle=params.has('long')?'Branches-UI-Audit-Coordinator':'Boston';
 const [target,setTarget]=useState(replyHandle);
 return <><button onClick={()=>setRequest({id:crypto.randomUUID(),text:'#Boston '})}>Mention Boston</button>
 <button onClick={()=>setRequest({id:crypto.randomUUID(),text:'#Arches '})}>Mention Arches</button>
 <Composer disabled={false} running={false} onSend={()=>{}} destinationMode={params.has('structural')?'target-required':'project-chat'} defaultDestination={target?{handle:target,selectionKey:target,binding:{agentId:target.toLowerCase(),projectId:'project',handle:target,currentHandle:target,currentTitle:target}}:undefined} requiredRecipient={params.has('structural')&&target?{handle:target,title:target,onClear:()=>setTarget('')}:undefined} mentionHandles={[replyHandle,'Boston','Arches']} mentionBindings={[...new Set([replyHandle,'Boston','Arches'])].map(name=>({agentId:name.toLowerCase(),projectId:'project',handle:name,currentHandle:name,currentTitle:name}))} insertTextRequest={request}/></>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Fixture/></QueryClientProvider>);
