import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { IconButton, Tooltip } from "@mui/material";
import { copyText } from "../clipboard";
import { useMutationNotification } from "./MutationNotifications";

export function CopyMessageButton({ text }: { text: string }): JSX.Element {
  const notify = useMutationNotification();
  const copy = async () => {
    try {
      await copyText(text);
      notify({ key: "copy-message", message: "Copied" });
    } catch {
      notify({ key: "copy-message", message: "Copy failed; select the message text instead", severity: "error" });
    }
  };
  return <Tooltip title="Copy whole message">
    <IconButton size="small" aria-label="Copy whole message" onClick={() => void copy()}>
      <ContentCopyIcon fontSize="inherit" />
    </IconButton>
  </Tooltip>;
}
