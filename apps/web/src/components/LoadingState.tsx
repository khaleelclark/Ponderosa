import { Box, CircularProgress, Stack, Typography } from "@mui/material";

export function LoadingState({
  resource,
  variant = "section",
}: {
  resource: string;
  variant?: "route" | "section" | "inline";
}): JSX.Element {
  const label = `Loading ${resource}…`;
  if (variant === "inline") {
    return (
      <Stack
        role="status"
        aria-busy="true"
        aria-live="polite"
        direction="row"
        spacing={0.75}
        sx={{ alignItems: "center", color: "text.secondary" }}
      >
        <CircularProgress size={14} color="inherit" sx={{ "@media (prefers-reduced-motion: reduce)": { animation: "none" } }} />
        <Typography variant="caption">{label}</Typography>
      </Stack>
    );
  }
  return (
    <Box
      role="status"
      aria-busy="true"
      aria-live="polite"
      sx={{
        width: "100%",
        px: variant === "route" ? 3 : 1,
        py: variant === "route" ? 6 : 2,
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mx: "auto", maxWidth: variant === "route" ? 480 : undefined }}>
        <CircularProgress size={16} color="inherit" sx={{ color: "text.secondary", "@media (prefers-reduced-motion: reduce)": { animation: "none" } }} />
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
      </Stack>
    </Box>
  );
}
