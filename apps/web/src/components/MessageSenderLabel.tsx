import { Typography } from "@mui/material";

export function MessageSenderLabel({ name }: { name: string }): JSX.Element {
  return (
    <Typography
      component="div"
      variant="caption"
      data-message-sender
      sx={{ mb: 0.25, fontWeight: 700, lineHeight: 1.35, overflowWrap: "anywhere", userSelect: "text" }}
    >
      {name}
    </Typography>
  );
}
