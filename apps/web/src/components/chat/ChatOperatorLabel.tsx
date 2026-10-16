import { Box, Stack } from "@mui/material";
import type { OperatorProfileDto } from "@ponderosa/core";
import { MessageSenderLabel } from "../MessageSenderLabel";
import { MessageTimestamp } from "../MessageTimestamp";
import { OperatorAvatar } from "../OperatorAvatar";

export function ChatOperatorLabel({ profile, createdAt }: { profile?: OperatorProfileDto; createdAt?: string }): JSX.Element {
  const name = profile?.displayName ?? "User";
  return (
    <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ minHeight: { xs: 32, sm: 36 }, mb: 0.25, alignItems: "center", justifyContent: "flex-end", minWidth: 0 }}>
      {createdAt ? <Box sx={{ color: "text.secondary" }}><MessageTimestamp value={createdAt} align="end" desktopOnly /></Box> : null}
      <Box sx={{ "& [data-message-sender]": { mb: 0, fontSize: { xs: 13, sm: 14 } } }}><MessageSenderLabel name={name} /></Box>
      <Box sx={{ display: "flex", flex: "0 0 auto" }}><OperatorAvatar profile={profile} compactOnMobile /></Box>
    </Stack>
  );
}
