import { createTheme } from "@mui/material/styles";

export type ColorMode = "light" | "dark";

export const COLOR_MODE_STORAGE_KEY = "ponderosa-color-mode";

export const ponderosaColorTokens = {
  light: {
    background: "#F8F6EF",
    sidebar: "#F1EEE5",
    surface: "#FFFFFF",
    surfaceSecondary: "#F1EEE5",
    elevated: "#FFFFFF",
    hover: "#E8E7DD",
    selected: "#FFFFFF",
    border: "#D9D8CE",
    textPrimary: "#10231C",
    textSecondary: "#53645D",
    textMuted: "#87948E",
    brand: "#123126",
    brandHover: "#1B4536",
    accent: "#5C8A65",
    highlight: "#7BC47F",
    userMessage: "#F1EEE5",
  },
  dark: {
    background: "#121816",
    sidebar: "#17221E",
    surface: "#1B2823",
    surfaceSecondary: "#1B2823",
    elevated: "#22312B",
    hover: "#294039",
    selected: "#253830",
    border: "#31463D",
    textPrimary: "#E6E7DF",
    textSecondary: "#B2BBB4",
    textMuted: "#7E8B84",
    brand: "#315C48",
    brandHover: "#4D8065",
    accent: "#4D8065",
    highlight: "#7CBF8A",
    userMessage: "#24352E",
  },
} as const;

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
  const colors = ponderosaColorTokens[mode];
  const dark = mode === "dark";

  return createTheme({
    palette: {
      mode,
      contrastThreshold: 4.5,
      primary: {
        main: colors.brand,
        dark: colors.brandHover,
        light: colors.highlight,
        contrastText: dark ? "#EDE9DD" : "#F8F6EF",
      },
      secondary: {
        main: dark ? "#8FA49A" : colors.accent,
        dark: dark ? "#71877D" : "#456E50",
        light: dark ? "#B2BBB4" : "#7AA382",
      },
      background: {
        default: colors.background,
        paper: colors.surface,
      },
      divider: colors.border,
      text: {
        primary: colors.textPrimary,
        secondary: colors.textSecondary,
        disabled: colors.textMuted,
      },
      action: {
        active: colors.textSecondary,
        hover: colors.hover,
        selected: colors.selected,
        disabled: colors.textMuted,
        disabledBackground: dark ? "rgba(126,139,132,.14)" : "rgba(135,148,142,.14)",
        focus: dark ? "rgba(124,191,138,.20)" : "rgba(92,138,101,.16)",
      },
      success: { main: dark ? "#57C77A" : "#2E8B57" },
      warning: { main: "#D8B85A" },
      error: { main: "#D66A5C" },
    },
    shape: {
      borderRadius: 12,
    },
    typography: {
      fontFamily:
        'var(--ponderosa-font-family, Inter, Geist, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif)',
      h1: { letterSpacing: "-0.025em" },
      h2: { letterSpacing: "-0.022em" },
      h3: { letterSpacing: "-0.02em" },
      h4: { letterSpacing: "-0.018em" },
      h5: { letterSpacing: "-0.014em" },
      h6: { letterSpacing: "-0.01em" },
      button: { textTransform: "none", fontWeight: 650, letterSpacing: 0 },
      body1: { fontSize: 14, lineHeight: 1.55 },
      body2: { fontSize: 13, lineHeight: 1.5 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            backgroundColor: colors.background,
            color: colors.textPrimary,
          },
          "::selection": {
            backgroundColor: dark ? "rgba(124,191,138,.28)" : "rgba(92,138,101,.22)",
          },
        },
      },
      MuiButtonBase: {
        defaultProps: { disableRipple: true },
        styleOverrides: {
          root: {
            "&.Mui-focusVisible": {
              outline: `2px solid ${colors.highlight}`,
              outlineOffset: 2,
            },
          },
        },
      },
      MuiButton: {
        styleOverrides: {
          root: { minHeight: 44, borderRadius: 8 },
          containedPrimary: {
            backgroundColor: dark ? "#EDE9DD" : colors.brand,
            color: dark ? "#123126" : "#F8F6EF",
            boxShadow: "none",
            "&:hover": {
              backgroundColor: dark ? "#F8F6EF" : colors.brandHover,
              boxShadow: "none",
            },
          },
          outlined: {
            borderColor: colors.border,
            "&:hover": { borderColor: colors.textMuted, backgroundColor: colors.hover },
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: "none" },
          elevation1: {
            boxShadow: dark ? "0 10px 28px rgba(3,8,6,.18)" : "0 10px 30px rgba(33,45,38,.08)",
          },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            borderColor: colors.border,
            boxShadow: "none",
          },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            backgroundColor: dark ? colors.surface : colors.surface,
            borderRadius: 10,
            "& fieldset": { borderColor: dark ? colors.textMuted : colors.border },
            "&:hover fieldset": { borderColor: colors.textMuted },
            "&.Mui-focused fieldset": { borderColor: colors.accent, borderWidth: 1 },
            "&.Mui-disabled fieldset": { borderColor: colors.border },
          },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: {
            minWidth: 44,
            minHeight: 44,
            borderRadius: 8,
          },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: { minHeight: 48, minWidth: 72 },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            minHeight: 44,
            borderRadius: 8,
            "&.Mui-selected": {
              backgroundColor: colors.selected,
              "&:hover": { backgroundColor: colors.hover },
            },
          },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: { borderRadius: 8 },
        },
      },
      MuiToggleButton: {
        styleOverrides: {
          root: { minHeight: 44, borderRadius: 8 },
        },
      },
    },
  });
}
