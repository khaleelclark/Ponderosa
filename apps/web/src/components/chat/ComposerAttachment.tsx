import {AudioMessagePlayer} from '../speech/AudioMessagePlayer';
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
  disabled = false,
  onRetry,
  onRemove,
}: {
  file: File;
  status?: DraftUploadStatus;
  error?: string;
  disabled?: boolean;
  onRetry?(): void;
  onRemove(): void;
}): JSX.Element {
  const [preview, setPreview] = useState<string>();
  useLayoutEffect(() => {
    if (!file.type.startsWith("image/")&&!file.type.startsWith("audio/")) return undefined;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <Box sx={{ position: "relative", minWidth: 0, maxWidth: 180 }}>
      {preview&&file.type.startsWith("audio/")?<Box sx={{width:180,maxWidth:"100%",mt:4}}><AudioMessagePlayer preload="metadata" src={preview} label={`Preview ${file.name}`}/></Box>:preview ? (
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
            onError={() => setPreview(undefined)}
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
          sx={{ display: "block", p: 1, pr: { xs: 6.5, sm: 5 }, overflowWrap: "anywhere" }}
        >
          {file.name}
          <br />
          {file.size} bytes
        </Typography>
      )}
      <IconButton
        disabled={disabled}
        size="small"
        aria-label={`Remove ${file.name}`}
        onClick={onRemove}
        sx={{
          position: "absolute",
          right: 3,
          top: 3,
          width: {xs:44,sm:28},
          height: {xs:44,sm:28},
          minWidth: {xs:44,sm:28},
          minHeight:44,
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
          sx={{ mt: 0.4, alignItems: "center", maxWidth: 180, minHeight:44 }}
        >
          {status === "uploading" ? <CircularProgress size={12} /> : null}
          {status === "failed" ? <Box component="details" sx={{minWidth:0,flex:1,"& summary":{cursor:"pointer",fontSize:".75rem",color:"error.main",minHeight:44,alignContent:"center"}}}>
            <summary>Failed · Details</summary><Typography variant="caption" sx={{overflowWrap:"anywhere",whiteSpace:"pre-wrap",display:"block",maxHeight:180,overflowY:"auto"}}>{error ?? "The upload could not be confirmed. Retry keeps the original file."}</Typography>
          </Box> : <Typography
            variant="caption"
            color="text.secondary"
            noWrap
            title={error}
          >
            {status === "complete"
              ? "Uploaded"
              : status[0]!.toUpperCase() + status.slice(1)}
          </Typography>}
          {status === "failed" && onRetry ? (
            <Button
              disabled={disabled}
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
