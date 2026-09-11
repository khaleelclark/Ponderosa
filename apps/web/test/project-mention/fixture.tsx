import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {Composer} from '../../src/components/chat/Composer';
function Fixture(){
 const [request,setRequest]=useState<{id:string;text:string}>();
 return <><button onClick={()=>setRequest({id:crypto.randomUUID(),text:'#Boston '})}>Mention Boston</button>
 <button onClick={()=>setRequest({id:crypto.randomUUID(),text:'#Arches '})}>Mention Arches</button>
 <Composer disabled={false} running={false} onSend={()=>{}} destinationMode="project-chat" defaultDestination={{handle:'Boston',selectionKey:'boston',binding:{agentId:'boston',projectId:'project',handle:'Boston',currentHandle:'Boston',currentTitle:'Boston'}}} mentionHandles={['Boston','Arches']} mentionBindings={['Boston','Arches'].map(name=>({agentId:name.toLowerCase(),projectId:'project',handle:name,currentHandle:name,currentTitle:name}))} insertTextRequest={request}/></>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Fixture/></QueryClientProvider>);
