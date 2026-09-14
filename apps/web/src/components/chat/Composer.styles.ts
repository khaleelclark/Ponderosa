import type { SxProps, Theme } from "@mui/material";

export const composerSurfaceSx: SxProps<Theme> = {
  position: "relative",
  zIndex: 3,
  border: 1,
  borderColor: "divider",
  borderRadius: { xs: 2, sm: 2.25 },
  width: {
    xs: "calc(100% - 16px)",
    sm: "calc(100% - 32px)",
    md: "min(1180px, calc(100% - 48px))",
    xl: "min(1240px, calc(100% - 64px))",
  },
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
      ? "0 10px 30px rgba(3,8,6,.18)"
      : "0 10px 30px rgba(33,45,38,.09)",
};
