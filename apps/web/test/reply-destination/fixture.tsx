import React, {useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {Composer} from '../../src/components/chat/Composer';

function Fixture() {
  const navigation = new URLSearchParams(location.search).has('navigation');
  const [visible, setVisible] = useState(true);
  const [target, setTarget] = useState(navigation ? '' : 'Boston');
  const [revision, setRevision] = useState(1);
  const [available, setAvailable] = useState(true);
  const [renamed, setRenamed] = useState(sessionStorage.getItem('renamed') === 'yes');
  const [sent, setSent] = useState('');
  const [commandResult, setCommandResult] = useState('');
  const commandFinish = useRef<() => void>();
  const commandFail = useRef<() => void>();
  const [request, setRequest] = useState<{id: string; text: string}>();
  const finish = useRef<() => void>();
  const params = new URLSearchParams(location.search);
  const original = {agentId:'boston',projectId:'project',handle:'Boston',currentHandle:renamed?'Renamed':'Boston',currentTitle:renamed?'Renamed':'Boston'};
  const bindings = [
    ...(available ? [original] : []),
    {agentId:'arches',projectId:'project',handle:'Arches',currentHandle:'Arches',currentTitle:'Arches'},
    ...(renamed ? [{...original,agentId:'impostor',handle:'Boston',currentHandle:'Boston',currentTitle:'Other Agent'}] : []),
  ];
  return <>
    <button onClick={() => setVisible(value => !value)}>{visible ? "Settings" : "Back to chat"}</button>
    <button onClick={()=>setTarget('')}>Lose target</button>
    <button onClick={()=>setTarget('Boston')}>Restore Boston</button>
    <button onClick={()=>setRevision(n=>n+1)}>Another reply</button>
    <button onClick={()=>{setTarget('Arches');setRevision(n=>n+1);}}>Arches reply</button>
    <button onClick={()=>setAvailable(false)}>Remove Boston</button>
    <button onClick={()=>{sessionStorage.setItem('renamed','yes');setRenamed(true);}}>Rename and reuse handle</button>
    <button onClick={()=>setRequest({id:crypto.randomUUID(),text:'#Boston '})}>Mention Boston</button>
    <button onClick={()=>finish.current?.()}>Finish send</button>
    <button onClick={()=>commandFinish.current?.()}>Finish command</button>
    <button onClick={()=>commandFail.current?.()}>Fail command</button>
    {visible && <Composer
      draftStorageKey="reply-destination-check"
      conversationDraftId={params.has('durable') ? 'diagnostic-chat' : undefined}
      disabled={false} running={false} destinationMode={navigation ? undefined : "project-chat"}
      commands={params.has('commands') ? [{name:'status',description:'Show status',source:'adapter-implemented',acceptsArguments:false,insertText:'/status',status:'available',invocation:'runtime'}] : undefined}
      onCommand={command => {
        setCommandResult(`started:${command.name}`);
        return new Promise<void>((resolve,reject) => {
          commandFinish.current = () => { setCommandResult(`completed:${command.name}`); resolve(); };
          commandFail.current = () => { setCommandResult(`failed:${command.name}`); reject(new Error('Command failed; retry')); };
        });
      }}
      onSend={(...args)=>{
        setSent(JSON.stringify({text:args[0],context:args[4]}));
        if(params.has('deferred')) return new Promise<void>(resolve=>{finish.current=resolve;});
      }}
      defaultDestination={target ? {handle:target,selectionKey:target+revision,binding:target==='Boston'?original:bindings.find(b=>b.agentId==='arches')} : undefined}
      mentionHandles={bindings.map(b=>b.currentHandle)} mentionBindings={bindings} insertTextRequest={request}
    />}
    <pre id="sent">{sent}</pre>
    <pre id="command-result">{commandResult}</pre>
  </>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Fixture/></QueryClientProvider>);
