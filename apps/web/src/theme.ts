import { createTheme } from "@mui/material/styles";

export type ColorMode = "light" | "dark";

export const COLOR_MODE_STORAGE_KEY = "ponderosa-color-mode";

export const ponderosaFocusIndicator = {
  light: "#123126",
  dark: "#9ED4AA",
} as const;

/** Shared geometry for navigation and collection surfaces. */
export const ponderosaLayoutTokens = {
  sidebarRailWidth: 72,
  sidebarPanelWidth: 318,
  contentMaxWidth: 1320,
  compactControlHeight: 40,
  touchTarget: 44,
  collectionRowRadius: 12,
  panelRadius: 12,
} as const;

export const ponderosaColorTokens = {
  light: {
    background: "#FFFFFF",
    rail: "#17221E",
    railBorder: "#354542",
    railForeground: "#B2BBB4",
    railForegroundActive: "#7CBF8A",
    sidebar: "#ECEFEE",
    surface: "#FFFFFF",
    surfaceSecondary: "#F5F7F6",
    elevated: "#FFFFFF",
    hover: "#E1E6E3",
    selected: "#DCE6E1",
    border: "#CDD5D1",
    textPrimary: "#10231C",
    textSecondary: "#53645D",
    textMuted: "#7A8982",
    brand: "#123126",
    brandHover: "#1B4536",
    accent: "#47785D",
    highlight: "#5E9B6B",
    star: "#987400",
    userMessage: "#EFF2F0",
  },
  dark: {
    background: "#121816",
    rail: "#17221E",
    railBorder: "#354542",
    railForeground: "#B2BBB4",
    railForegroundActive: "#7CBF8A",
    sidebar: "#17221E",
    surface: "#1B2523",
    surfaceSecondary: "#202A29",
    elevated: "#25302F",
    hover: "#2B3735",
    selected: "#273633",
    border: "#354542",
    textPrimary: "#E6E7DF",
    textSecondary: "#B2BBB4",
    textMuted: "#7E8B84",
    brand: "#315C48",
    brandHover: "#4D8065",
    accent: "#4D8065",
    highlight: "#7CBF8A",
    star: "#987400",
    userMessage: "#27332F",
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
  const focusIndicator = ponderosaFocusIndicator[mode];

  return createTheme({
    palette: {
      mode,
      contrastThreshold: 4.5,
      primary: {
        // In dark mode primary.main is used for links and outlined controls, so it
        // must be a readable foreground rather than the much darker brand surface.
        main: dark ? colors.highlight : colors.brand,
        dark: dark ? colors.brand : colors.brandHover,
        light: dark ? "#9ED4AA" : colors.highlight,
        contrastText: dark ? "#10231C" : "#F8F6EF",
      },
      secondary: {
        main: dark ? "#91AAB6" : "#607A87",
        dark: dark ? "#708894" : "#48606C",
        light: dark ? "#B8C8CF" : "#8FA5AF",
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
      info: { main: dark ? "#79B8D1" : "#356F8B" },
      warning: { main: dark ? "#D8B85A" : "#8A6C22" },
      error: { main: dark ? "#D66A5C" : "#B74D43" },
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
            "--ponderosa-focus-ring": focusIndicator,
            "--ponderosa-rail": colors.rail,
            "--ponderosa-rail-border": colors.railBorder,
            "--ponderosa-rail-foreground": colors.railForeground,
            "--ponderosa-rail-foreground-active": colors.railForegroundActive,
            "--ponderosa-sidebar": colors.sidebar,
            "--ponderosa-star": colors.star,
            "--ponderosa-surface-secondary": colors.surfaceSecondary,
            "--ponderosa-elevated": colors.elevated,
            "--ponderosa-touch-target": `${ponderosaLayoutTokens.touchTarget}px`,
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
              outline: `2px solid ${focusIndicator}`,
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
