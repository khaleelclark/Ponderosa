import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient, QueryClientProvider, useMutation} from '@tanstack/react-query';
import type {ConversationMessageDto} from '@ponderosa/core';
import {Composer} from '../../src/components/chat/Composer';
import {publishConversationMessageReceipt} from '../../src/conversationMessageReceipt';
import {queryKeys} from '../../src/queryKeys';

const mode=new URLSearchParams(location.search).get('mode');
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
client.setQueryData(queryKeys.conversations.activeDeliveryReceipts('diagnostic-chat','event','activation'),{items:[]});
client.setQueryData(queryKeys.conversations.detail('diagnostic-chat'),{messages:[]});
if(mode==='cache-failure')client.setQueriesData=()=>{throw Error('Injected cache publication failure');};

function Fixture() {
  const [accepted,setAccepted]=useState('');
  const [requests,setRequests]=useState(0);
  const send=useMutation({
    mutationFn:async(text:string)=>{
      setRequests(n=>n+1);
      if(mode==='transport-failure')throw Error('Request rejected');
      setAccepted(text);
      return {id:'saved',conversationId:'diagnostic-chat',role:'user',text,createdAt:'2026-09-12T12:00:00Z'} as ConversationMessageDto;
    },
    onSuccess:message=>publishConversationMessageReceipt(client,'diagnostic-chat',message),
  });
  const binding={agentId:'boston',projectId:'project',handle:'Boston',currentHandle:'Boston',currentTitle:'Boston'};
  return <>
    <Composer draftStorageKey="receipt-check" disabled={false} running={false} destinationMode="project-chat"
      defaultDestination={{handle:'Boston',selectionKey:'Boston1',binding}}
      mentionHandles={['Boston']} mentionBindings={[binding]}
      onSend={async text=>{await send.mutateAsync(text);}} />
    <pre id="accepted">{accepted}</pre>
    <pre id="status">{send.status}</pre>
    <pre id="requests">{requests}</pre>
  </>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><Fixture/></QueryClientProvider>);
