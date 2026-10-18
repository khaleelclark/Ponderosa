import {useEffect,useMemo,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CssBaseline,ThemeProvider} from '@mui/material';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {PineconeConsumer} from '../../web/src/components/pinecone/PineconeConsumer';
import {setStandaloneProductScope} from '../../web/src/api/productScope';
import {MutationNotificationProvider} from '../../web/src/components/MutationNotifications';
import {COLOR_MODE_STORAGE_KEY,createPonderosaTheme,loadColorMode} from '../../web/src/theme';
import {writeBrowserStorage} from '../../web/src/browserStorage';
import '../../web/src/global.css';

// A product entry, not a Branches tab. Existing engine identities remain canonical.
setStandaloneProductScope('branches');
const branchId='49005cab-f4d3-4b38-a468-bf153624e4f4';
const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
function PineconeApp(){
  const [mode,setMode]=useState(loadColorMode);
  const theme=useMemo(()=>createPonderosaTheme(mode),[mode]);
  useEffect(()=>{writeBrowserStorage('localStorage',COLOR_MODE_STORAGE_KEY,mode);document.documentElement.style.colorScheme=mode},[mode]);
  return <ThemeProvider theme={theme}><CssBaseline/><QueryClientProvider client={client}><MutationNotificationProvider><PineconeConsumer branchId={branchId} colorMode={mode} onToggleColorMode={()=>setMode(m=>m==='dark'?'light':'dark')}/></MutationNotificationProvider></QueryClientProvider></ThemeProvider>;
}
createRoot(document.getElementById('root')!).render(<PineconeApp/>);
