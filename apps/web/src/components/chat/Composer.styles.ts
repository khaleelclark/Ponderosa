import type { SxProps, Theme } from "@mui/material";

export const composerSurfaceWidth = {
  xs: "calc(100% - 16px)",
  sm: "calc(100% - 32px)",
  md: "min(880px, calc(100% - 48px))",
  xl: "min(880px, calc(100% - 64px))",
} as const;

export const composerSurfaceSx: SxProps<Theme> = {
  position: "relative",
  zIndex: 3,
  border: 1,
  borderColor: "divider",
  '&[data-file-drag-active="true"]': {
    outline: "2px solid",
    outlineColor: "primary.main",
    outlineOffset: -2,
  },
  borderRadius: { xs: 3.5, sm: 4 },
  transition:"border-color 160ms ease, box-shadow 160ms ease",
  "&:focus-within":{borderColor:"primary.main",boxShadow:"0 0 0 2px color-mix(in srgb, var(--ponderosa-primary, #2563eb) 12%, transparent)"},
  "@media (prefers-reduced-motion: reduce)":{transition:"none"},
  width: composerSurfaceWidth,
  mx: "auto",
  mb: { xs: 1, sm: 1.5 },
  minWidth: 0,
  maxWidth: "100%",
  overflow: "hidden",
  bgcolor: "background.paper",
  px: { xs: 1, sm: 1.5 },
  pt: { xs: 1, sm: 1.25 },
  pb: {
    xs: "6px",
    md: "max(10px, env(safe-area-inset-bottom))",
  },
  boxShadow: theme =>
    theme.palette.mode === "dark"
      ? "0 3px 14px rgba(0,0,0,.14)"
      : "0 3px 14px rgba(25,31,40,.045)",
};
