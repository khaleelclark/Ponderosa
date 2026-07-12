import { Typography } from "@mui/material";

export function MessageSenderLabel({ name }: { name: string }): JSX.Element {
  return (
    <Typography
      component="div"
      variant="caption"
      data-message-sender
      dir="auto"
      sx={{
        mb: 0.5,
        maxWidth: "100%",
        fontWeight: 700,
        lineHeight: 1.35,
        overflowWrap: "anywhere",
        unicodeBidi: "plaintext",
        userSelect: "text",
      }}
    >
      {name}
    </Typography>
  );
}
