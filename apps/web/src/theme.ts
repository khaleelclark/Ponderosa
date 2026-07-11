import { createTheme } from "@mui/material/styles";

export type ColorMode = "light" | "dark";

export const COLOR_MODE_STORAGE_KEY = "ponderosa-color-mode";

export function loadColorMode(): ColorMode {
  if (typeof window === "undefined") {
    return "light";
  }

  const savedMode = window.localStorage.getItem(COLOR_MODE_STORAGE_KEY);
  if (savedMode === "light" || savedMode === "dark") {
    return savedMode;
  }

  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function createPonderosaTheme(mode: ColorMode) {
  return createTheme({
    palette: {
      mode,
      primary: {
        main: mode === "dark" ? "#79c4b2" : "#245c53",
        dark: mode === "dark" ? "#3c8f7e" : "#173f39",
        light: mode === "dark" ? "#b4e1d5" : "#5f8f85",
      },
      secondary: {
        main: mode === "dark" ? "#f0ad8b" : "#8f4b2e",
      },
      background: {
        default: mode === "dark" ? "#121816" : "#f6f7f4",
        paper: mode === "dark" ? "#1a2320" : "#ffffff",
      },
      success: {
        main: mode === "dark" ? "#75c990" : "#277a46",
      },
      warning: {
        main: mode === "dark" ? "#ebbd67" : "#a86f1b",
      },
      error: {
        main: mode === "dark" ? "#f08a94" : "#b23b45",
      },
    },
    shape: {
      borderRadius: 8,
    },
    typography: {
      fontFamily:
        'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      h1: { letterSpacing: 0 },
      h2: { letterSpacing: 0 },
      h3: { letterSpacing: 0 },
      h4: { letterSpacing: 0 },
      h5: { letterSpacing: 0 },
      h6: { letterSpacing: 0 },
      button: { textTransform: "none", fontWeight: 700, letterSpacing: 0 },
    },
    components: {
      MuiButtonBase: {
        defaultProps: {
          disableRipple: true,
        },
      },
      MuiButton: {
        styleOverrides: {
          root: {
            minHeight: 44,
          },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: {
            minWidth: 44,
            minHeight: 44,
          },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: {
            minHeight: 48,
            minWidth: 72,
          },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            minHeight: 48,
          },
        },
      },
      MuiToggleButton: {
        styleOverrides: {
          root: {
            minHeight: 44,
          },
        },
      },
    },
  });
}
