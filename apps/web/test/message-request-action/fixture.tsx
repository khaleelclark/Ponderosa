import React from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatMessageFrame } from '../../src/components/chat/ChatMessageFrame';
import { MessageRequestAction } from '../../src/components/MessageRequestAction';
import '../../src/global.css';
const request = {recordId:'request-1', state:'completed' as const, recipientAgentId:'agent-2', requesterAgentId:'agent-1', conversationId:'request-chat', hasUpdates:false, hasResult:false, updatedAt:'2026-09-11T12:00:00Z', preview:'Do the requested work'};
createRoot(document.getElementById('root')!).render(
  <ThemeProvider theme={createTheme({palette:{mode:'dark'}})}><CssBaseline /><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>
    {['linked','none','missing-project','blank-id','multiple'].map(id=><div key={id} data-testid={id}>
      <ChatMessageFrame message={{id,author:{kind:'agent',name:'Boston'},createdAt:request.updatedAt,body:<>Message content only</>,actions:<MessageRequestAction projectId={id==='missing-project'?undefined:'project-1'} conversationId="message-chat" requests={id==='none'?[]:id==='blank-id'?[{...request,recordId:''}]:id==='multiple'?[request,{...request,recordId:'request-2'}]:[request]} agentTitle={id=>id??'You'} />}} />
    </div>)}
  </QueryClientProvider></ThemeProvider>
);
