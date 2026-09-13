import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {ThemeProvider,Box} from '@mui/material';
import {Composer} from '../../src/components/chat/Composer';
import {useAppViewport} from '../../src/hooks/useAppViewport';
import {createPonderosaTheme} from '../../src/theme';
import '../../src/global.css';

const binding={agentId:'boston',projectId:'project',handle:'Boston',currentHandle:'Boston',currentTitle:'Boston'};
function Fixture(){
 useAppViewport();
 const [sent,setSent]=useState<string[]>([]);
 const mention=new URLSearchParams(location.search).has('mention');
 return <Box id="app-frame" sx={{height:{xs:'var(--ponderosa-app-viewport-block-size, 100dvh)',md:'100%'},display:'flex',flexDirection:'column',minHeight:0}}>
  <div style={{flex:'1 1 0',overflow:'auto'}}><button id="dismiss">Dismiss keyboard</button><p>Isolated conversation. No real messages or provider calls.</p></div>
  <div id="composer"><Composer disabled={false} running={false} destinationMode="project-chat"
   draftStorageKey="mobile-ios-fixture" mentionHandles={['Boston']} mentionBindings={[binding]}
   defaultDestination={mention?{handle:'Boston',selectionKey:'reply1',binding}:undefined}
   onSend={async(text)=>{setSent(previous=>[...previous,text]);}} /></div>
  <output id="sent" style={{display:'none'}}>{JSON.stringify(sent)}</output>
 </Box>;
}
createRoot(document.getElementById('root')!).render(<ThemeProvider theme={createPonderosaTheme('dark')}><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Fixture/></QueryClientProvider></ThemeProvider>);
