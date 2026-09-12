import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {ChatMessageBody} from '../../src/components/chat/ChatMessages';
import {Composer} from '../../src/components/chat/Composer';
const binding={agentId:'boston',projectId:'project',handle:'Boston',currentHandle:'Boston',currentTitle:'Boston'};
function Fixture(){
 const [tick,setTick]=useState(0),[available,setAvailable]=useState(true),[reply,setReply]=useState(1),[ready,setReady]=useState(true),[sent,setSent]=useState(0);
 return <>
  <button onClick={()=>setTick(n=>n+1)}>Rerender</button><span>{tick}</span>
  <div id="code" style={{width:700}}><ChatMessageBody text={'```bash\nnano /example/file\n```'} /></div>
  <button onClick={()=>{setAvailable(false);setReady(false);}}>Roster pending</button>
  <button onClick={()=>{setAvailable(true);setReady(true);}}>Roster ready</button>
  <button onClick={()=>{setAvailable(false);setReady(true);}}>Remove Agent</button>
  <button onClick={()=>setReply(n=>n+1)}>New reply</button>
  <Composer disabled={false} running={false} destinationMode="project-chat" draftStorageKey="isolated-diagnostic"
   defaultDestination={available?{handle:'Boston',selectionKey:'reply'+reply,binding}:undefined}
   mentionBindings={available?[binding]:[]} mentionBindingsReady={ready} mentionHandles={available?['Boston']:[]}
   onSend={async()=>{setSent(n=>n+1);}} />
  <span id="sent">{sent}</span>
 </>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}><Fixture/></QueryClientProvider>);
