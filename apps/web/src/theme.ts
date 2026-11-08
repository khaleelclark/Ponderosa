import { alpha, createTheme, getContrastRatio } from "@mui/material/styles";
import type { Theme } from "@mui/material/styles";
import { readBrowserStorage } from "./browserStorage";

import {COLOR_MODE_STORAGE_KEY, THEME_BACKGROUNDS, resolveColorMode, type ColorMode} from "./browserTheme";
export {COLOR_MODE_STORAGE_KEY, type ColorMode} from "./browserTheme";

const ponderosaFocusIndicator = {
  light: "#2563EB",
  dark: "#92B7FF",
} as const;

/** Shared geometry for navigation and collection surfaces. */
export const ponderosaLayoutTokens = {
  sidebarRailWidth: 64,
  sidebarPanelWidth: 296,
  contentMaxWidth: 1320,
  compactControlHeight: 40,
  touchTarget: 44,
  collectionRowRadius: 12,
  panelRadius: 12,
} as const;

/** Shared translucent workspace chrome with an opaque CSS fallback. */
export function workspaceHeaderSurfaceSx(
  theme: Theme,
) {
  return {
    backgroundColor: theme.palette.background.default,
    "@supports (background-color: rgb(0 0 0 / 50%))": {
      backgroundColor: alpha(
        theme.palette.background.default,
        theme.palette.mode === "dark" ? 0.94 : 0.92,
      ),
    },
  };
}

const ponderosaColorTokens = {
  light: {
    background: THEME_BACKGROUNDS.light,
    rail: "#F3F2EE",
    topbar: "#FAF9F6",
    railBorder: "#DEDCD6",
    railForeground: "#686A66",
    railForegroundActive: "#2563EB",
    sidebar: "#F3F2EE",
    surface: "#FFFFFF",
    surfaceSecondary: "#F2F1ED",
    inputSurface: "#FFFFFF",
    delegatedSurface: "#EBEFEB",
    delegatedHover: "#E0E7E1",
    elevated: "#FFFFFF",
    hover: "#EEEDE9",
    selected: "#E9EFFD",
    border: "#DEDCD6",
    textPrimary: "#202621",
    textSecondary: "#656A64",
    textMuted: "#777C75",
    brand: "#2563EB",
    brandHover: "#1D4ED8",
    accent: "#2563EB",
    highlight: "#92B7FF",
    activityLabel: "#547763",
    star: "#987400",
    userMessage: "#2563EB",
  },
  dark: {
    background: THEME_BACKGROUNDS.dark,
    rail: "#171A18",
    topbar: "#1C1F1C",
    railBorder: "#343B38",
    railForeground: "#B5BCB8",
    railForegroundActive: "#92B7FF",
    sidebar: "#191C19",
    surface: "#202420",
    surfaceSecondary: "#272B26",
    inputSurface: "#202420",
    delegatedSurface: "#2A332C",
    delegatedHover: "#333E35",
    elevated: "#292E29",
    hover: "#30362F",
    selected: "#263750",
    border: "#3A4039",
    textPrimary: "#F0F0E9",
    textSecondary: "#B8BDB4",
    textMuted: "#959D91",
    brand: "#2563EB",
    brandHover: "#1D4ED8",
    accent: "#92B7FF",
    highlight: "#92B7FF",
    activityLabel: "#68A97C",
    star: "#BFA34A",
    userMessage: "#2563EB",
  },
} as const;

export function loadColorMode(): ColorMode {
  if (typeof window === "undefined") {
    return "light";
  }

  const savedMode = readBrowserStorage("localStorage", COLOR_MODE_STORAGE_KEY);
  return resolveColorMode(savedMode, window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
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
        light: "#92B7FF",
        contrastText: dark ? "#132440" : "#FFFFFF",
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
        disabledBackground: dark
          ? "rgba(126,139,132,.14)"
          : "rgba(135,148,142,.14)",
        focus: dark ? "rgba(146,183,255,.20)" : "rgba(37,99,235,.16)",
      },
      success: { main: dark ? "#57C77A" : "#2E8B57" },
      info: { main: dark ? "#79B8D1" : "#356F8B" },
      warning: { main: dark ? "#D8B85A" : "#8A6C22" },
      error: { main: dark ? "#D66A5C" : "#B74D43" },
    },
    transitions: {
      duration: { shortest: 160, shorter: 180, short: 200, standard: 200, complex: 220, enteringScreen: 220, leavingScreen: 180 },
      easing: { easeInOut: "cubic-bezier(0.2, 0, 0, 1)", easeOut: "cubic-bezier(0.2, 0, 0, 1)", easeIn: "cubic-bezier(0.4, 0, 1, 1)", sharp: "cubic-bezier(0.2, 0, 0, 1)" },
    },
    shape: {
      borderRadius: 12,
    },
    typography: {
      fontFamily:
        'var(--ponderosa-font-family, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif)',
      h1: { letterSpacing: "-0.025em" },
      h2: { letterSpacing: "-0.022em" },
      h3: { letterSpacing: "-0.02em" },
      h4: { letterSpacing: "-0.018em" },
      h5: { fontSize: "1.375rem", fontWeight: 650, letterSpacing: "-0.025em", lineHeight: 1.35 },
      h6: { fontSize: "1.0625rem", fontWeight: 650, letterSpacing: "-0.018em", lineHeight: 1.4 },
      button: { textTransform: "none", fontWeight: 600, letterSpacing: 0 },
      body1: { fontSize: "0.9375rem", lineHeight: 1.55 },
      body2: { fontSize: "0.875rem", lineHeight: 1.5 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            backgroundColor: colors.background,
            color: colors.textPrimary,
            "--ponderosa-focus-ring": focusIndicator,
            "--ponderosa-canvas": colors.background,
            "--ponderosa-surface": colors.surface,
            "--ponderosa-border": colors.border,
            "--ponderosa-accent": dark ? colors.highlight : colors.brand,
            "--ponderosa-motion-duration": "200ms",
            "--ponderosa-rail": colors.rail,
            "--ponderosa-topbar": colors.topbar,
            "--ponderosa-rail-border": colors.railBorder,
            "--ponderosa-rail-foreground": colors.railForeground,
            "--ponderosa-rail-foreground-active": colors.railForegroundActive,
            "--ponderosa-sidebar": colors.sidebar,
            "--ponderosa-activity-label": colors.activityLabel,
            "--ponderosa-star": colors.star,
            "--ponderosa-surface-secondary": colors.surfaceSecondary,
            "--ponderosa-input-surface": colors.inputSurface,
            "--ponderosa-delegated-surface": colors.delegatedSurface,
            "--ponderosa-delegated-hover": colors.delegatedHover,
            "--ponderosa-elevated": colors.elevated,
            "--ponderosa-touch-target": `${ponderosaLayoutTokens.touchTarget}px`,
            "--ponderosa-text-primary": colors.textPrimary,
            "--ponderosa-text-secondary": colors.textSecondary,
            "--ponderosa-message-bubble": colors.userMessage,
            "--ponderosa-message-bubble-text": "#FFFFFF",
            "--ponderosa-prose-divider": colors.border,
            "--ponderosa-prose-hover": colors.hover,
            "--ponderosa-prose-link": dark ? colors.highlight : colors.brand,
          },
          a: { textDecoration: "none" },
          "a:hover, a:focus-visible": { textDecoration: "none" },
          "::selection": {
            backgroundColor: dark
              ? "rgba(146,183,255,.28)"
              : "rgba(37,99,235,.22)",
          },
        },
      },
      MuiAlert: {
        styleOverrides: {
          filled: ({ theme, ownerState }) => {
            const background = theme.palette[ownerState.color ?? ownerState.severity ?? "success"][theme.palette.mode === "dark" ? "dark" : "main"];
            return { color: getContrastRatio(background, "#FFFFFF") >= 4.5 ? "#FFFFFF" : "#000000" };
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
      MuiLink: {
        defaultProps: { underline: "none" },
        styleOverrides: {
          root: {
            "&:hover": { color: dark ? colors.highlight : colors.brand },
          },
        },
      },
      MuiButton: {
        styleOverrides: {
          root: { minHeight: 44, borderRadius: 10, paddingInline: 16, transition: "background-color 180ms ease, border-color 180ms ease, color 180ms ease" },
          containedPrimary: {
            backgroundColor: colors.brand,
            color: "#FFFFFF",
            boxShadow: "none",
            "&:hover": {
              backgroundColor: colors.brandHover,
              boxShadow: "none",
            },
          },
          outlined: {
            borderColor: colors.border,
            "&:hover": {
              borderColor: colors.textMuted,
              backgroundColor: colors.hover,
            },
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: "none" },
          elevation1: {
            boxShadow: dark
              ? "0 10px 28px rgba(3,8,6,.18)"
              : "0 10px 30px rgba(33,45,38,.08)",
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
      MuiDialog: {
        defaultProps: { transitionDuration: { enter: 220, exit: 180 } },
        styleOverrides: {
          container: ({ ownerState }) => ({
            ...(ownerState.maxWidth !== "xs" && !ownerState.fullScreen ? { "@media (max-width: 599.95px)": { alignItems: "flex-end" } } : {}),
          }),
          paper: ({ ownerState }) => ({
            backgroundColor: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: 20,
            boxShadow: dark ? "0 24px 80px rgba(0,0,0,.36)" : "0 24px 80px rgba(28,34,28,.16)",
            overscrollBehavior: "contain",
            ...(ownerState.maxWidth !== "xs" && !ownerState.fullScreen ? { "@media (max-width: 599.95px)": {
              margin: 0, width: "100%", maxWidth: "100%", maxHeight: "calc(100dvh - 24px)",
              borderRadius: "20px 20px 0 0", borderBottom: 0,
            } } : {}),
          }),
          paperFullScreen: { borderRadius: 0, "@media (max-width: 599.95px)": { maxHeight: "100dvh", borderRadius: 0 } },
        },
      },
      MuiDialogTitle: { styleOverrides: { root: { padding: "24px 24px 16px", fontSize: "1.125rem", fontWeight: 650, letterSpacing: "-0.02em" } } },
      MuiDialogContent: { styleOverrides: { root: { padding: "8px 24px 24px", overscrollBehavior: "contain", scrollbarGutter: "stable" } } },
      MuiDialogActions: { styleOverrides: { root: { padding: "12px 24px max(16px, env(safe-area-inset-bottom, 0px))", gap: 8, borderTop: `1px solid ${colors.border}`, backgroundColor: colors.surface, flexWrap: "wrap" } } },
      MuiBackdrop: { styleOverrides: { root: { backgroundColor: dark ? "rgba(0,0,0,.56)" : "rgba(29,35,30,.28)" } } },
      MuiDrawer: {
        defaultProps: { transitionDuration: { enter: 220, exit: 180 } },
        styleOverrides: { paper: { backgroundColor: colors.surface, backgroundImage: "none", overscrollBehavior: "contain" } },
      },
      MuiMenu: {
        defaultProps: { transitionDuration: { enter: 160, exit: 120 } },
        styleOverrides: {
          paper: { padding: 4, border: `1px solid ${colors.border}`, borderRadius: 14, backgroundColor: colors.elevated, boxShadow: dark ? "0 12px 40px rgba(0,0,0,.32)" : "0 12px 40px rgba(28,34,28,.14)" },
          list: { padding: 0 },
        },
      },
      MuiMenuItem: { styleOverrides: { root: { minHeight: 44, paddingInline: 12, paddingBlock: 10, borderRadius: 8, fontSize: "0.875rem", whiteSpace: "normal", "&.Mui-selected": { backgroundColor: colors.selected }, "@media (min-width: 600px)": { minHeight: 44 } } } },
      MuiAccordion: { defaultProps: { elevation: 0 }, styleOverrides: { root: { backgroundColor: "transparent", borderBottom: `1px solid ${colors.border}`, "&:before": { display: "none" }, "&.Mui-expanded": { margin: 0 } } } },
      MuiAccordionSummary: { styleOverrides: { root: { minHeight: 56, paddingInline: 0, "&.Mui-expanded": { minHeight: 56 } }, content: { marginBlock: 14, "&.Mui-expanded": { marginBlock: 14 } } } },
      MuiAccordionDetails: { styleOverrides: { root: { padding: "0 0 24px" } } },
      MuiTooltip: { styleOverrides: { tooltip: { borderRadius: 8, padding: "8px 12px", fontSize: "0.75rem" } } },
      MuiTabs: { styleOverrides: { indicator: { height: 2, borderRadius: 2 } } },
      MuiInputLabel: {
        styleOverrides: {
          root: {
            "&.MuiInputLabel-outlined.MuiInputLabel-shrink": {
              zIndex: 1,
              marginLeft: -4,
              paddingInline: 4,
              backgroundColor: colors.inputSurface,
            },
          },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            backgroundColor: colors.inputSurface,
            borderRadius: 10,
            "& fieldset": {
              borderColor: dark ? colors.textMuted : colors.border,
            },
            "&:hover fieldset": { borderColor: colors.textMuted },
            "&.Mui-focused fieldset": {
              borderColor: colors.accent,
              borderWidth: 1,
            },
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
              color: colors.textPrimary,
              boxShadow: "none",
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
          root: {
            minHeight: 44,
            borderRadius: 8,
            ...(!dark ? {
              "&.Mui-selected": {
                backgroundColor: colors.selected,
                color: colors.textPrimary,
                "&:hover": { backgroundColor: colors.hover },
              },
            } : {}),
          },
        },
      },
    },
  });
}
