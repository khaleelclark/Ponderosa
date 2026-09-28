import CssBaseline from "@mui/material/CssBaseline";
import "@fontsource-variable/inter";
import { ThemeProvider } from "@mui/material/styles";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { WorkspaceErrorBoundary } from "./components/WorkspaceErrorBoundary";
import { MutationNotificationProvider } from "./components/MutationNotifications";
import "./global.css";
import { installServiceWorkerReloadGuard } from "./serviceWorkerReload";
import { queryRetryDelay, shouldRetryQuery } from "./api/queryRetry";
import { COLOR_MODE_STORAGE_KEY, createPonderosaTheme, loadColorMode, type ColorMode } from "./theme";
import { writeBrowserStorage } from "./browserStorage";

installServiceWorkerReloadGuard();

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

  useEffect(() => {
    writeBrowserStorage("localStorage", COLOR_MODE_STORAGE_KEY, colorMode);
    document.documentElement.style.colorScheme = colorMode;
  }, [colorMode]);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <MutationNotificationProvider>
          <WorkspaceErrorBoundary title="Ponderosa could not display the workspace.">
            <App
              colorMode={colorMode}
              onToggleColorMode={() => setColorMode((current) => (current === "light" ? "dark" : "light"))}
            />
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
