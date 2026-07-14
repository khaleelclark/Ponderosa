import CheckIcon from "@mui/icons-material/Check";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import { Box, IconButton, Tooltip } from "@mui/material";
import { useState } from "react";
import { copyText } from "../clipboard";

export function CopyMessageButton({ text }: { text: string }): JSX.Element {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await copyText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 2_000);
  };
  const label = state === "copied" ? "Message copied" : state === "failed" ? "Copy failed; select the message text instead" : "Copy whole message";
  return <>
    <Tooltip title={label}>
      <IconButton size="small" color={state === "failed" ? "error" : "inherit"} aria-label="Copy whole message" onClick={() => void copy()}>
        {state === "copied" ? <CheckIcon fontSize="inherit" /> : state === "failed" ? <ErrorOutlineIcon fontSize="inherit" /> : <ContentCopyIcon fontSize="inherit" />}
      </IconButton>
    </Tooltip>
    <Box component="span" aria-live="polite" sx={{ position: "absolute", width: "1px", height: "1px", p: 0, m: "-1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 }}>{state === "idle" ? "" : label}</Box>
  </>;
}
