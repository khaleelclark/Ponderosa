import CloseIcon from "@mui/icons-material/Close";
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  Stack,
  Typography,
} from "@mui/material";
import { useLayoutEffect, useState } from "react";

export type DraftUploadStatus =
  | "queued"
  | "uploading"
  | "complete"
  | "failed";

export function ComposerAttachment({
  file,
  status,
  error,
  onRetry,
  onRemove,
}: {
  file: File;
  status?: DraftUploadStatus;
  error?: string;
  onRetry?(): void;
  onRemove(): void;
}): JSX.Element {
  const [preview, setPreview] = useState<string>();
  useLayoutEffect(() => {
    if (!file.type.startsWith("image/")) return undefined;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <Box sx={{ position: "relative", minWidth: 0, maxWidth: 180 }}>
      {preview ? (
        <Box
          component="a"
          href={preview}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${file.name}`}
        >
          <Box
            component="img"
            src={preview}
            alt=""
            sx={{
              width: 72,
              height: 72,
              objectFit: "cover",
              borderRadius: 1,
            }}
          />
        </Box>
      ) : (
        <Typography
          variant="caption"
          sx={{ display: "block", p: 1, pr: 5, overflowWrap: "anywhere" }}
        >
          {file.name}
          <br />
          {file.size} bytes
        </Typography>
      )}
      <IconButton
        size="small"
        aria-label={`Remove ${file.name}`}
        onClick={onRemove}
        sx={{
          position: "absolute",
          right: 3,
          top: 3,
          width: 28,
          height: 28,
          minWidth: 28,
          minHeight: 28,
          p: 0.4,
          bgcolor: "background.paper",
          boxShadow: 1,
          "&:hover": { bgcolor: "background.paper" },
        }}
      >
        <CloseIcon sx={{ fontSize: 16 }} />
      </IconButton>
      {status ? (
        <Stack
          direction="row"
          spacing={0.5}
          sx={{ mt: 0.4, alignItems: "center", maxWidth: 180 }}
        >
          {status === "uploading" ? <CircularProgress size={12} /> : null}
          <Typography
            variant="caption"
            color={status === "failed" ? "error.main" : "text.secondary"}
            noWrap
            title={error}
          >
            {status === "complete"
              ? "Ready"
              : status[0]!.toUpperCase() + status.slice(1)}
          </Typography>
          {status === "failed" && onRetry ? (
            <Button
              size="small"
              onClick={onRetry}
              sx={{ minWidth: 0, p: 0.25 }}
            >
              Retry
            </Button>
          ) : null}
        </Stack>
      ) : null}
    </Box>
  );
}
