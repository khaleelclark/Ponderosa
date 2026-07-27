import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { Stack, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { ReactNode } from "react";

export function ChatLiveBanner({ children }: { children?: ReactNode }): JSX.Element | null {
  if (!children) return null;
  return (
    <Stack
      direction="row"
      spacing={0.5}
      role="status"
      aria-live="polite"
      sx={{
        minHeight: 24,
        px: 0.75,
        py: 0.25,
        alignItems: "center",
        justifyContent: "center",
        width: "fit-content",
        maxWidth: "min(1180px, calc(100% - 24px))",
        mx: "auto",
        borderRadius: 999,
        bgcolor: (theme) => alpha(theme.palette.info.main, theme.palette.mode === "dark" ? 0.08 : 0.06),
      }}
    >
      <InfoOutlinedIcon color="info" sx={{ fontSize: 16, flex: "0 0 auto" }} />
      <Typography
        variant="caption"
        component="span"
        color="text.secondary"
        sx={{ fontWeight: 700, lineHeight: 1.35, textAlign: "center" }}
      >
        {children}
      </Typography>
    </Stack>
  );
}
