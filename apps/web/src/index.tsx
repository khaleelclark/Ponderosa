import {isBranchesPath} from "./api/productScope.js";
import {applyBrowserTheme} from "./browserTheme";
import CssBaseline from "@mui/material/CssBaseline";
import "@fontsource-variable/inter";
import { ThemeProvider } from "@mui/material/styles";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, Suspense, lazy, useLayoutEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
const App=lazy(()=>import('./App'));
const BranchesView=lazy(()=>import('./components/BranchesView').then(module=>({default:module.BranchesView})));
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
  const [colorMode, setColorMode] = useState<ColorMode>(loadColorMode);
  const theme = useMemo(() => createPonderosaTheme(colorMode), [colorMode]);

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
            {isBranchesPath(window.location.pathname)?<BranchesView colorMode={colorMode} onToggleColorMode={()=>setColorMode(current=>current==='light'?'dark':'light')}/>:<App
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
