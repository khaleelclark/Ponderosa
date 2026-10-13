import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {ThemeProvider,CssBaseline} from '@mui/material';
import {V4Pinecone} from './src/components/pinecone/V4Pinecone';
import {branchRoutePath} from './src/branchesRouting';
import {BranchPinecone} from './src/components/pinecone/BranchPinecone';
import {createPonderosaTheme} from './src/theme';
import './src/global.css';
import {useAppViewport} from './src/hooks/useAppViewport';
const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
const v4BranchId='0356095a-8d73-4249-b39d-883b978ae119';
const branchId=new URLSearchParams(location.search).get('branch')??v4BranchId;
const navigate=(route:Parameters<typeof branchRoutePath>[0])=>{location.href='http://192.168.1.147:18793'+branchRoutePath(route);return true};
function CandidateApp(){useAppViewport();return <ThemeProvider theme={createPonderosaTheme('light')}><CssBaseline/><QueryClientProvider client={client}>{branchId===v4BranchId?<V4Pinecone route={{branchId,tab:'pinecone'}} onNavigate={navigate}/>:<BranchPinecone candidatePreview route={{branchId,tab:'pinecone'}} onNavigate={navigate}/>}</QueryClientProvider></ThemeProvider>}
createRoot(document.getElementById('root')!).render(<CandidateApp/>);
