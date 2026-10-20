import type { SxProps, Theme } from "@mui/material";

export const speechControlGroupSx: SxProps<Theme> = {
  display: "flex",
  alignItems: "center",
  minWidth: 0,
  gap: 0.25,
};

export const speechStatusSx = {
  maxWidth: { xs: 132, sm: 240 },
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} satisfies SxProps<Theme>;

// MUI treats numeric 1 as 100% for sizing; hidden statuses must stay one pixel.
export const visuallyHiddenSpeechStatusSx = {
  position: "absolute",
  width: "1px",
  height: "1px",
  p: 0,
  m: "-1px",
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
} satisfies SxProps<Theme>;
