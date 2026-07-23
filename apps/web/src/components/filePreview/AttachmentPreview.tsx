import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import { Box, Button, Paper, Stack, Typography } from "@mui/material";
import { previewCapability } from "./mimeCapabilities";

export interface AttachmentPreviewValue {
  id: string;
  name: string;
  mediaType?: string;
  size?: number;
  url: string;
  previewUrl?: string;
  downloadUrl?: string;
}

/** Compact MIME-aware card for canonical chat attachment surfaces. */
export function AttachmentPreview({ attachment, maxWidth = 280 }: {
  attachment: AttachmentPreviewValue;
  maxWidth?: number;
}): JSX.Element {
  const capability = previewCapability({ mediaType: attachment.mediaType, path: attachment.name });
  const previewUrl = capability.kind === "image" ? (attachment.previewUrl ?? attachment.url) : undefined;
  const downloadUrl = attachment.downloadUrl ?? attachment.url;
  return <Paper variant="outlined" data-preview-capability={capability.kind} sx={{ maxWidth: "100%", width: "fit-content", overflow: "hidden" }}>
    {previewUrl ? <Box component="img" src={previewUrl} alt={attachment.name} sx={{ display: "block", width: "auto", maxWidth: { xs: "100%", sm: maxWidth }, maxHeight: 220, objectFit: "contain" }} /> : <Box sx={{ px: 1.25, pt: 1, maxWidth }}>
      <Typography variant="body2" fontWeight={650} sx={{ overflowWrap: "anywhere" }}>{attachment.name}</Typography>
      <Typography variant="caption" color="text.secondary">{capability.label}{attachment.size !== undefined ? ` · ${attachment.size.toLocaleString()} bytes` : ""}</Typography>
    </Box>}
    <Stack direction="row" spacing={.25} sx={{ px: .5, py: .35, justifyContent: "flex-end" }}>
      {attachment.previewUrl ? <Button size="small" component="a" href={attachment.previewUrl} target="_blank" rel="noreferrer" startIcon={<OpenInNewOutlinedIcon />} aria-label={`Open ${attachment.name}`}>Open</Button> : null}
      <Button size="small" component="a" href={downloadUrl} download startIcon={<DownloadOutlinedIcon />} aria-label={`Download ${attachment.name}`}>Download</Button>
    </Stack>
  </Paper>;
}
