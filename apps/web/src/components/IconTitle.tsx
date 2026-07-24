import { Box, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";

/**
 * The compact icon-and-title treatment used by sidebar panels and tabbed
 * workspace identity headers.
 */
export function IconTitle({
  icon,
  title,
  component = "h6",
}: {
  icon: ReactNode;
  title: string;
  component?: "h1" | "h6";
}): JSX.Element {
  return <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
    <Box
      component="span"
      aria-hidden
      sx={{ display: "inline-flex", flexShrink: 0, lineHeight: 0, "& .MuiSvgIcon-root": { fontSize: 24 } }}
    >
      {icon}
    </Box>
    <Typography variant="h6" component={component} fontWeight={800} noWrap sx={{ minWidth: 0 }}>
      {title}
    </Typography>
  </Stack>;
}
