import {Suspense,lazy,useEffect,useMemo,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {Box,Button,ThemeProvider,CssBaseline} from '@mui/material';
import {V4Pinecone} from './src/components/pinecone/V4Pinecone';
import {branchRoutePath} from './src/branchesRouting';
import {BranchPinecone} from './src/components/pinecone/BranchPinecone';
import {COLOR_MODE_STORAGE_KEY,createPonderosaTheme,loadColorMode,type ColorMode} from './src/theme';
import {readBrowserStorage,writeBrowserStorage} from './src/browserStorage';
import './src/global.css';
import {useAppViewport} from './src/hooks/useAppViewport';
import {setStandaloneProductScope} from './src/api/productScope';
import {MutationNotificationProvider} from './src/components/MutationNotifications';
const BranchesView=lazy(()=>import('./src/components/BranchesView').then(module=>({default:module.BranchesView})));
setStandaloneProductScope('branches');
const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
const v4BranchId='0356095a-8d73-4249-b39d-883b978ae119';
const branchId=new URLSearchParams(location.search).get('branch')??v4BranchId;
const advanced=new URLSearchParams(location.search).get('advanced')==='1';
const navigate=(route:Parameters<typeof branchRoutePath>[0])=>{const url=new URL(branchRoutePath(route),location.origin);url.searchParams.set('advanced','1');location.assign(url.href);return true};
function loadRestoredAppearance():ColorMode {
  // Browser appearance is origin-local. Restore the known original v4 dark choice
  // on this new origin only when it has no existing explicit appearance choice.
  const saved=readBrowserStorage('localStorage',COLOR_MODE_STORAGE_KEY);
  return branchId===v4BranchId&&saved!=='light'&&saved!=='dark'?'dark':loadColorMode();
}
function CandidateApp(){
  useAppViewport();
  const [colorMode,setColorMode]=useState<ColorMode>(loadRestoredAppearance);
  const theme=useMemo(()=>createPonderosaTheme(colorMode),[colorMode]);
  useEffect(()=>{writeBrowserStorage('localStorage',COLOR_MODE_STORAGE_KEY,colorMode);document.documentElement.style.colorScheme=colorMode},[colorMode]);
  const toggle=()=>setColorMode(mode=>mode==='dark'?'light':'dark');
  return <ThemeProvider theme={theme}><CssBaseline/><QueryClientProvider client={client}><MutationNotificationProvider>{advanced?<Box sx={{height:'var(--ponderosa-app-viewport-block-size, 100dvh)',display:'flex',flexDirection:'column'}}><Box sx={{flexShrink:0,bgcolor:'background.paper',borderBottom:1,borderColor:'divider'}}><Button href={`/?branch=${encodeURIComponent(branchId)}`}>Back to Pinecone</Button></Box><Box sx={{flex:1,minHeight:0,overflow:'auto'}}><Suspense fallback={<div role="status">Loading options…</div>}><BranchesView colorMode={colorMode} onToggleColorMode={toggle}/></Suspense></Box></Box>:branchId===v4BranchId?<V4Pinecone colorMode={colorMode} onToggleColorMode={toggle} route={{branchId,tab:'pinecone'}} onNavigate={navigate}/>:<BranchPinecone candidatePreview route={{branchId,tab:'pinecone'}} onNavigate={navigate}/>}</MutationNotificationProvider></QueryClientProvider></ThemeProvider>;
}
createRoot(document.getElementById('root')!).render(<CandidateApp/>);
