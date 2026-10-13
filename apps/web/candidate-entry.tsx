import React,{useEffect,useMemo,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {ThemeProvider,CssBaseline} from '@mui/material';
import {V4Pinecone} from './src/components/pinecone/V4Pinecone';
import {branchRoutePath} from './src/branchesRouting';
import {BranchPinecone} from './src/components/pinecone/BranchPinecone';
import {COLOR_MODE_STORAGE_KEY,createPonderosaTheme,loadColorMode,type ColorMode} from './src/theme';
import {readBrowserStorage,writeBrowserStorage} from './src/browserStorage';
import './src/global.css';
import {useAppViewport} from './src/hooks/useAppViewport';
const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
const v4BranchId='0356095a-8d73-4249-b39d-883b978ae119';
const branchId=new URLSearchParams(location.search).get('branch')??v4BranchId;
const navigate=(route:Parameters<typeof branchRoutePath>[0])=>{location.href='http://192.168.1.147:18793'+branchRoutePath(route);return true};
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
  return <ThemeProvider theme={theme}><CssBaseline/><QueryClientProvider client={client}>{branchId===v4BranchId?<V4Pinecone colorMode={colorMode} onToggleColorMode={()=>setColorMode(mode=>mode==='dark'?'light':'dark')} route={{branchId,tab:'pinecone'}} onNavigate={navigate}/>:<BranchPinecone candidatePreview route={{branchId,tab:'pinecone'}} onNavigate={navigate}/>}</QueryClientProvider></ThemeProvider>;
}
createRoot(document.getElementById('root')!).render(<CandidateApp/>);
