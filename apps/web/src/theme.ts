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
        main: mode === "dark" ? "#79c9a5" : "#245c53",
        dark: mode === "dark" ? "#315f52" : "#173f39",
        light: mode === "dark" ? "#9fdfbd" : "#5f8f85",
      },
      secondary: {
        main: mode === "dark" ? "#f0ad8b" : "#8f4b2e",
      },
      background: {
        default: mode === "dark" ? "#071619" : "#f6f7f4",
        paper: mode === "dark" ? "#0f2023" : "#ffffff",
      },
      divider: mode === "dark" ? "#24393b" : "rgba(0,0,0,.12)",
      text: mode === "dark" ? { primary: "#edf4f1", secondary: "#91a39e", disabled: "#63736f" } : undefined,
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
      borderRadius: 6,
    },
    typography: {
      fontFamily:
        'var(--ponderosa-font-family, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)',
      h1: { letterSpacing: 0 },
      h2: { letterSpacing: 0 },
      h3: { letterSpacing: 0 },
      h4: { letterSpacing: 0 },
      h5: { letterSpacing: 0 },
      h6: { letterSpacing: 0 },
      button: { textTransform: "none", fontWeight: 700, letterSpacing: 0 },
      body1: { fontSize: 14, lineHeight: "20px" },
      body2: { fontSize: 13, lineHeight: "19px" },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            backgroundImage: mode === "dark" ? "radial-gradient(circle at 55% 15%, rgba(42, 88, 77, .08), transparent 32%)" : "none",
          },
        },
      },
      MuiButtonBase: {
        defaultProps: {
          disableRipple: true,
        },
      },
      MuiButton: {
        styleOverrides: {
          root: {
            minHeight: 44,
            borderRadius: 6,
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: "none" },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: mode === "dark" ? { backgroundColor: "rgba(255,255,255,.025)", "& fieldset": { borderColor: "#294043" }, "&:hover fieldset": { borderColor: "#45605e" } } : {},
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
