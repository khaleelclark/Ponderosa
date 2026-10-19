import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { Stack, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { useEffect, useState, type ReactNode } from "react";

export function ChatLiveBanner({ children, singleLine = false }: { children?: ReactNode; singleLine?: boolean }): JSX.Element | null {
  if (!children) return null;
  return (
    <Stack
      direction="row"
      spacing={singleLine ? 0 : 0.5}
      role="status"
      aria-live={singleLine ? "off" : "polite"}
      sx={{
        minHeight: 24,
        px: 0.75,
        py: 0.25,
        alignItems: "center",
        gap: singleLine ? 0.5 : undefined,
        justifyContent: "center",
        width: "fit-content",
        maxWidth: "min(1180px, calc(100% - 24px))",
        ...(singleLine ? {
          "@container (max-width: 260px)": { maxWidth: "calc(100% - 8px)" },
          "@container (max-width: 180px)": { maxWidth: "100%", px: 0.25, "& .MuiTypography-root": { fontSize: 11.5 } },
        } : {}),
        mx: "auto",
        borderRadius: 999,
        bgcolor: "background.paper",
        backgroundImage: (theme) => {
          const tint = alpha(theme.palette.info.main, theme.palette.mode === "dark" ? 0.08 : 0.06);
          return `linear-gradient(${tint}, ${tint})`;
        },
      }}
    >
      <InfoOutlinedIcon color="info" sx={{ fontSize: 16, flex: "0 0 auto",
        ...(singleLine ? { "@container (max-width: 260px)": { display: "none" } } : {}) }} />
      <Typography
        variant="caption"
        component="span"
        color="text.secondary"
        sx={{ minWidth: 0, overflowWrap: singleLine ? "normal" : "anywhere", whiteSpace: singleLine ? "nowrap" : undefined,
          display: singleLine ? "flex" : undefined, fontWeight: 700, lineHeight: 1.35, textAlign: "center" }}
      >
        {children}
      </Typography>
    </Stack>
  );
}

export function TimedChatLiveBanner({
  children,
  durationMs = 3_000,
  onDismiss,
}: {
  children?: ReactNode;
  durationMs?: number;
  onDismiss?(): void;
}): JSX.Element | null {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setVisible(false);
      onDismiss?.();
    }, durationMs);
    return () => window.clearTimeout(timer);
  }, [durationMs, onDismiss]);
  return visible ? <ChatLiveBanner>{children}</ChatLiveBanner> : null;
}
