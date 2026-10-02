import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {Composer} from '../../src/components/chat/Composer';
import {projectFileCanonicalText} from '../../src/components/chat/ComposerEditor';
function Fixture(){
 const [scope,setScope]=useState(0);
 const [request,setRequest]=useState<{id:string;text:string}>();
 const params=new URLSearchParams(location.search);
 const replyHandle=params.has('long')?'Branches-UI-Audit-Coordinator':'Boston';
 const [target,setTarget]=useState(params.has('empty')?'':replyHandle);
 const handles=params.has('empty')?[]:[replyHandle,'Boston','Arches'];
 return <><button onClick={()=>{setScope(value=>value+1);document.body.dataset.switched='yes';}}>Switch fixture Chat</button><button onClick={()=>setRequest({id:crypto.randomUUID(),text:'#Boston '})}>Mention Boston</button>
 <button onClick={()=>setRequest({id:crypto.randomUUID(),text:'#Arches '})}>Mention Arches</button>
 <button onClick={()=>setRequest({id:crypto.randomUUID(),text:projectFileCanonicalText({projectId:'project',artifactId:'file-a',historicalFilename:'report.md',currentFilename:'report.md'})})}>Mention project file</button>
 <Composer key={scope} disabled={params.has('disabled')} running={params.has('running')} attachmentsEnabled={!params.has('no-attachments')} onSend={(text,files)=>{document.body.dataset.sent=text;document.body.dataset.sentFiles=JSON.stringify(files.map(file=>file.name));}} destinationMode={params.has('fixed')?'fixed':params.has('structural')?'target-required':'project-chat'} defaultDestination={target?{handle:target,selectionKey:target,binding:{agentId:target.toLowerCase(),projectId:'project',handle:target,currentHandle:target,currentTitle:target}}:undefined} requiredRecipient={params.has('structural')&&target?{handle:target,title:target,onClear:()=>setTarget('')}:undefined} mentionHandles={handles} mentionBindings={[...new Set(handles)].map(name=>({agentId:name.toLowerCase(),projectId:'project',handle:name,currentHandle:name,currentTitle:name}))} insertTextRequest={request}/></>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Fixture/></QueryClientProvider>);
