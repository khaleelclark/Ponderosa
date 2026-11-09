import {integratedAssistantPath} from './assistantRouting';
import {TEXT_SIZE_EVENT,readTextSize} from './textSize';
import {isBranchesPath,isOutputAppPath,setStandaloneProductScope} from "./api/productScope.js";
import {applyBrowserTheme} from "./browserTheme";
import CssBaseline from "@mui/material/CssBaseline";
import "@fontsource-variable/inter";
import { ThemeProvider } from "@mui/material/styles";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, Suspense, lazy, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
// Replace the bookmark entry before choosing a product scope or starting queries.
const assistantEntryPath=integratedAssistantPath(window.location.pathname,window.location.search);
if(assistantEntryPath)window.history.replaceState(window.history.state,'',assistantEntryPath);
const OutputAgentApp=lazy(()=>import('./components/OutputAgentApp').then(module=>({default:module.OutputAgentApp})));
if(isOutputAppPath(window.location.pathname))setStandaloneProductScope('branches');
const App = lazy(() => {
  // Overlap the selected route code with the Core shell, before metadata mounts.
  if (isProjectRoute(parseRoute(window.location.pathname, window.location.search))) {
    void loadProjectShell().catch(() => {});
  }
  return import(/* webpackFetchPriority: "high" */ "./App");
});
const BranchesView=lazy(()=>import(/* webpackFetchPriority: "high" */ './components/BranchesView').then(module=>({default:module.BranchesView})));
import { loadProjectShell } from "./projectShellLoader";
import { parseRoute } from "./routing";
import { prefetchConversationWorkspace } from "./conversationWorkspacePrefetch";
import { api } from "./api";
import { queryKeys } from "./queryKeys";
import { isProjectRoute } from "./routeRegistry";
import { WorkspaceErrorBoundary } from "./components/WorkspaceErrorBoundary";
import { MutationNotificationProvider } from "./components/MutationNotifications";
import "./global.css";
import { installServiceWorkerReloadGuard } from "./serviceWorkerReload";
import { queryRetryDelay, shouldRetryQuery } from "./api/queryRetry";
import { COLOR_MODE_STORAGE_KEY, createPonderosaTheme, loadColorMode, type ColorMode } from "./theme";
import { writeBrowserStorage } from "./browserStorage";

installServiceWorkerReloadGuard();
// A product switch needs its own root and QueryClient, including push clicks.
navigator.serviceWorker?.addEventListener('message',(event:MessageEvent)=>{
  if(event.data?.type!=='ponderosa:open-route'||typeof event.data.url!=='string')return;
  const target=new URL(event.data.url,window.location.origin);
  const assistantPath=integratedAssistantPath(target.pathname,target.search);
  if(target.origin===window.location.origin&&assistantPath){event.stopImmediatePropagation();window.location.assign(assistantPath);return;}
  if(target.origin===window.location.origin&&isBranchesPath(target.pathname)!==isBranchesPath(window.location.pathname))window.location.assign(target.href);
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      staleTime: 15_000,
      retry: shouldRetryQuery,
      retryDelay: queryRetryDelay,
    },
  },
});

function Root(): JSX.Element {
  useEffect(() => {
    if (isBranchesPath(window.location.pathname) || isOutputAppPath(window.location.pathname)) return;
    const route = parseRoute(window.location.pathname, window.location.search);
    if (route.kind === "conversation") {
      void prefetchConversationWorkspace(queryClient, route.conversationId, route.projectId);
      void queryClient.prefetchQuery({
        queryKey: queryKeys.projects.detail(route.projectId),
        queryFn: () => api.getProject(route.projectId),
        retry: false,
      });
    }
  }, []);
  const [colorMode, setColorMode] = useState<ColorMode>(loadColorMode);
  useEffect(()=>{
    const apply=()=>{document.documentElement.style.fontSize=`${readTextSize()}%`;};
    apply();window.addEventListener(TEXT_SIZE_EVENT,apply);window.addEventListener('storage',apply);
    return()=>{window.removeEventListener(TEXT_SIZE_EVENT,apply);window.removeEventListener('storage',apply);};
  },[]);
  const theme = useMemo(() => createPonderosaTheme(colorMode, isOutputAppPath(window.location.pathname) ? "assistant" : "standard"), [colorMode]);

  useLayoutEffect(() => {
    writeBrowserStorage("localStorage", COLOR_MODE_STORAGE_KEY, colorMode);
    applyBrowserTheme(colorMode, theme.palette.background.default);
  }, [colorMode, theme]);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <MutationNotificationProvider>
          <WorkspaceErrorBoundary title="Ponderosa could not display the workspace.">
            <Suspense fallback={<div role="status" style={{padding:24}}>Loading Ponderosa…</div>}>
            {isOutputAppPath(window.location.pathname)?<OutputAgentApp colorMode={colorMode} onToggleColorMode={()=>setColorMode(current=>current==='light'?'dark':'light')}/>:isBranchesPath(window.location.pathname)?<BranchesView colorMode={colorMode} onToggleColorMode={()=>setColorMode(current=>current==='light'?'dark':'light')}/>:<App
              colorMode={colorMode}
              onToggleColorMode={() => setColorMode((current) => (current === "light" ? "dark" : "light"))}
            />}
            </Suspense>
          </WorkspaceErrorBoundary>
        </MutationNotificationProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root not found");
}

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
