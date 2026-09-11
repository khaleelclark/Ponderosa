import CloseIcon from "@mui/icons-material/Close";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import {
  Box,
  Button,
  ButtonBase,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { CommunicationAttachmentDto } from "@ponderosa/core";
import { useEffect, useState } from "react";
import { FilePreview } from "../filePreview/FilePreview";
import { previewCapability } from "../filePreview/mimeCapabilities";
import { readTextPreview } from "../filePreview/readTextPreview";

const textPreviewSupported = (attachment: CommunicationAttachmentDto) =>
  ["text", "markdown", "diff"].includes(previewCapability({
    mediaType: attachment.mediaType, path: attachment.name,
  }).kind);

export function ChatAttachments({
  attachments,
}: {
  attachments: CommunicationAttachmentDto[];
}): JSX.Element | null {
  const [preview, setPreview] = useState<CommunicationAttachmentDto>();
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const [textPreview, setTextPreview] = useState<{ attachmentId: string; content?: string; truncated?: boolean; error?: string }>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setTextPreview(undefined);
    if (!preview || preview.unavailable || !textPreviewSupported(preview)) return;
    const controller = new AbortController();
    const url = preview.downloadUrl ?? preview.url ?? preview.previewUrl;
    if (!url) { setTextPreview({ attachmentId: preview.id, error: "File URL is unavailable" }); return; }
    void readTextPreview(url, controller.signal).then(
      result => { if (!controller.signal.aborted) setTextPreview({ ...result, attachmentId: preview.id }); },
      error => { if (!controller.signal.aborted) setTextPreview({ attachmentId: preview.id, error: error instanceof Error ? error.message : "Could not load file" }); },
    );
    return () => controller.abort();
  }, [preview, retry]);
  const availabilityKey = JSON.stringify(attachments.map((attachment) => [
    attachment.id,
    attachment.mediaType,
    attachment.previewUrl ?? attachment.url ?? "",
    attachment.downloadUrl ?? attachment.url ?? "",
    attachment.unavailable ? "unavailable" : "available",
  ]));
  useEffect(() => {
    setFailed(new Set());
    setPreview(undefined);
  }, [availabilityKey]);
  if (!attachments.length) return null;
  const previewIndex = attachments.findIndex(attachment => attachment.id === preview?.id);
  const previewUnavailable = preview && (preview.unavailable || failed.has(preview.id) ||
    !(preview.previewUrl ?? preview.url ?? preview.downloadUrl));
  const currentTextPreview = textPreview?.attachmentId === preview?.id ? textPreview : undefined;
  const navigatePreview = (step: number) => setPreview(current => {
    const index = attachments.findIndex(attachment => attachment.id === current?.id);
    return index < 0 ? current : attachments[(index + step + attachments.length) % attachments.length];
  });

  return (
    <>
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: 1 }}>
        {attachments.map((attachment) => {
          const image = !attachment.mediaType || attachment.mediaType.startsWith("image/");
          const previewUrl = attachment.previewUrl ?? attachment.url;
          const downloadUrl = attachment.downloadUrl ?? attachment.url;
          const unavailable = attachment.unavailable || failed.has(attachment.id) ||
            (!previewUrl && !downloadUrl);
          return (
            <Box key={attachment.id} sx={{ maxWidth: "100%" }}>
              {unavailable ? (
                <Stack
                  spacing={0.35}
                  role="status"
                  sx={{ p: 1, minWidth: 190, border: 1, borderColor: "divider", borderRadius: 1 }}
                >
                  <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                    {attachment.name || "Artifact unavailable"}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Artifact unavailable
                  </Typography>
                </Stack>
              ) : image && previewUrl ? (
                <ButtonBase
                  aria-label={`Preview ${attachment.name}`}
                  onClick={() => setPreview(attachment)}
                  sx={{
                    display: "block",
                    width: 96,
                    height: 96,
                    maxWidth: "100%",
                    borderRadius: 1,
                    overflow: "hidden",
                    "&:hover img": { filter: "brightness(0.92)" },
                    "&:focus-visible": {
                      outline: "2px solid",
                      outlineColor: "primary.main",
                      outlineOffset: 2,
                    },
                  }}
                >
                  <Box
                    component="img"
                    src={previewUrl}
                    alt={attachment.name}
                    onError={() => setFailed((current) => new Set(current).add(attachment.id))}
                    sx={{
                      display: "block",
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      transition: "filter 120ms ease",
                    }}
                  />
                </ButtonBase>
              ) : (
                <Stack spacing={0.5} sx={{ p: 0.75, border: 1, borderColor: "divider", borderRadius: 1 }}>
                  <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{attachment.name}</Typography>
                  <Typography variant="caption" color="text.secondary">{attachment.mediaType} · {attachment.size} bytes</Typography>
                  <Stack direction="row" spacing={0.5}>
                    {textPreviewSupported(attachment) && (downloadUrl || previewUrl) ? <Button
                      size="small"
                      onClick={() => setPreview(attachment)}
                      aria-label={`Preview ${attachment.name}`}
                      startIcon={<VisibilityOutlinedIcon />}
                    >
                      Preview
                    </Button> : attachment.previewUrl && attachment.previewUrl !== downloadUrl ? <Button
                      size="small"
                      component="a"
                      href={attachment.previewUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Preview ${attachment.name}`}
                      startIcon={<VisibilityOutlinedIcon />}
                    >Preview</Button> : null}
                    {downloadUrl ? <Button
                      size="small"
                      component="a"
                      href={downloadUrl}
                      download
                      aria-label={`Download ${attachment.name}`}
                      startIcon={<DownloadOutlinedIcon />}
                    >
                      Download
                    </Button> : null}
                  </Stack>
                </Stack>
              )}
            </Box>
          );
        })}
      </Stack>
      <Dialog
        open={Boolean(preview)}
        onClose={() => setPreview(undefined)}
        onKeyDown={(event) => {
          if (attachments.length < 2 || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          event.stopPropagation();
          navigatePreview(event.key === "ArrowLeft" ? -1 : 1);
        }}
        fullWidth
        maxWidth="lg"
        aria-labelledby={preview ? `chat-image-preview-${preview.id}` : undefined}
        PaperProps={{
          sx: {
            width: "min(1100px, calc(100vw - 24px))",
            maxHeight: "min(92vh, 900px)",
            m: 1.5,
            overflow: "hidden",
          },
        }}
      >
        <DialogTitle
          id={preview ? `chat-image-preview-${preview.id}` : undefined}
          sx={{ display: "flex", alignItems: "center", gap: 0.5, py: 1, pr: 1 }}
        >
          <Typography component="span" variant="subtitle1" noWrap sx={{ flex: 1, minWidth: 0 }}>
            {preview?.name}
          </Typography>
          {preview && !preview.unavailable && (preview.downloadUrl ?? preview.url) ? (
            <Tooltip title="Download">
              <IconButton
                component="a"
                href={preview.downloadUrl ?? preview.url}
                download
                aria-label={`Download ${preview.name}`}
              >
                <DownloadOutlinedIcon />
              </IconButton>
            </Tooltip>
          ) : null}
          <Tooltip title="Close">
            <IconButton aria-label="Close attachment preview" onClick={() => setPreview(undefined)}>
              <CloseIcon />
            </IconButton>
          </Tooltip>
        </DialogTitle>
        <DialogContent
          sx={{
            p: 0,
            minHeight: 0,
            height: "min(78vh, 780px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            bgcolor: preview && textPreviewSupported(preview) ? "background.paper" : "#0b0e0d",
            overflow: "auto",
          }}
        >
          {previewUnavailable ? (
            <Typography role="status" sx={{ p: 2 }}>Artifact unavailable</Typography>
          ) : preview && textPreviewSupported(preview) ? (
            <Box sx={{ width: "100%", height: "100%", p: 2, minWidth: 0 }}>
              <FilePreview
                title={preview.name}
                path={preview.name}
                mediaType={preview.mediaType}
                content={currentTextPreview?.content}
                loading={!currentTextPreview}
                error={currentTextPreview?.error}
                truncated={currentTextPreview?.truncated}
                totalBytes={preview.size}
                downloadUrl={preview.downloadUrl ?? preview.url}
                hideHeader
                maxHeight="100%"
              />
              {currentTextPreview?.error ? <Button onClick={() => setRetry(value => value + 1)}>Retry preview</Button> : null}
            </Box>
          ) : preview && (!preview.mediaType || preview.mediaType.startsWith("image/")) && (preview.previewUrl ?? preview.url) ? (
            <Box
              component="img"
              key={preview.id}
              src={preview.previewUrl ?? preview.url}
              alt={preview.name}
              onError={() => {
                setFailed((current) => new Set(current).add(preview.id));
              }}
              sx={{
                display: "block",
                maxWidth: "100%",
                maxHeight: "100%",
                objectFit: "contain",
              }}
            />
          ) : preview ? (
            <Stack spacing={1} sx={{ p: 2, minWidth: 0, alignItems: "center" }}>
              <Typography sx={{ overflowWrap: "anywhere" }}>{preview.name}</Typography>
              <Typography color="text.secondary">Preview unavailable for this file type.</Typography>
              {preview.downloadUrl ?? preview.url ? <Button
                component="a" href={preview.downloadUrl ?? preview.url} download
                startIcon={<DownloadOutlinedIcon />}
              >Download file</Button> : null}
            </Stack>
          ) : null}
        </DialogContent>
        {attachments.length > 1 ? (
          <DialogActions sx={{ justifyContent: "center", gap: 1 }}>
            <IconButton aria-label="Previous attachment" onClick={() => navigatePreview(-1)}>
              <ChevronLeftIcon />
            </IconButton>
            <Typography variant="body2" role="status" aria-live="polite" aria-atomic="true">
              {previewIndex + 1} of {attachments.length}
            </Typography>
            <IconButton aria-label="Next attachment" onClick={() => navigatePreview(1)}>
              <ChevronRightIcon />
            </IconButton>
          </DialogActions>
        ) : null}
      </Dialog>
    </>
  );
}
