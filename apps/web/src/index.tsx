import CssBaseline from "@mui/material/CssBaseline";
import "@fontsource-variable/inter";
import { ThemeProvider } from "@mui/material/styles";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { WorkspaceErrorBoundary } from "./components/WorkspaceErrorBoundary";
import "./global.css";
import { COLOR_MODE_STORAGE_KEY, createPonderosaTheme, loadColorMode, type ColorMode } from "./theme";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      staleTime: 15_000,
    },
  },
});

function Root(): JSX.Element {
  const [colorMode, setColorMode] = useState<ColorMode>(loadColorMode);
  const theme = useMemo(() => createPonderosaTheme(colorMode), [colorMode]);

  useEffect(() => {
    window.localStorage.setItem(COLOR_MODE_STORAGE_KEY, colorMode);
    document.documentElement.style.colorScheme = colorMode;
  }, [colorMode]);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <WorkspaceErrorBoundary title="Ponderosa could not display the workspace.">
          <App
            colorMode={colorMode}
            onToggleColorMode={() => setColorMode((current) => (current === "light" ? "dark" : "light"))}
          />
        </WorkspaceErrorBoundary>
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
