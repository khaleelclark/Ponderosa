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
      // Require MUI's automatic foreground selection to meet normal-text AA.
      contrastThreshold: 4.5,
      primary: {
        main: mode === "dark" ? "#9bc8ad" : "#20382b",
        dark: mode === "dark" ? "#5a786b" : "#172b21",
        light: mode === "dark" ? "#c0ddcd" : "#607d6e",
      },
      // Pine bark is a quiet structural accent. Keep actions, focus, health,
      // unread state, and success on the green/semantic palettes.
      secondary: {
        main: mode === "dark" ? "#b99b84" : "#765846",
        dark: mode === "dark" ? "#856a57" : "#523d31",
        light: mode === "dark" ? "#d4bead" : "#9b7b66",
      },
      background: {
        default: mode === "dark" ? "#091510" : "#faf6f3",
        paper: mode === "dark" ? "#11221a" : "#fffdfa",
      },
      // In dark mode these remain visible against both default and paper
      // surfaces. Divider also serves as the boundary for outlined controls.
      divider: mode === "dark" ? "#547164" : "rgba(32,48,40,.20)",
      text: mode === "dark" ? { primary: "#f5f1eb", secondary: "#9eaea5", disabled: "#84958b" } : { primary: "#203028", secondary: "#66756d", disabled: "#7d8982" },
      action: mode === "dark" ? {
        active: "#c0ddcd",
        hover: "rgba(192,221,205,.10)",
        selected: "rgba(185,155,132,.16)",
        disabled: "#84958b",
        disabledBackground: "rgba(132,149,139,.18)",
        focus: "rgba(155,200,173,.24)",
      } : {
        selected: "rgba(118,88,70,.10)",
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
            backgroundImage: mode === "dark" ? "radial-gradient(circle at 55% 15%, rgba(185, 155, 132, .055), transparent 32%)" : "none",
          },
        },
      },
      MuiButtonBase: {
        defaultProps: {
          disableRipple: true,
        },
        styleOverrides: {
          root: {
            "&.Mui-focusVisible": {
              outline: `2px solid ${mode === "dark" ? "#9bc8ad" : "#20382b"}`,
              outlineOffset: 2,
            },
          },
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
          root: mode === "dark" ? {
            backgroundColor: "rgba(255,255,255,.035)",
            "& fieldset": { borderColor: "#547164" },
            "&:hover fieldset, &.Mui-focused fieldset": { borderColor: "#9bc8ad" },
            "&.Mui-disabled fieldset": { borderColor: "#405a4e" },
          } : {},
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
