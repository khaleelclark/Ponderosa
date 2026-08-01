import CloseIcon from "@mui/icons-material/Close";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import {
  Box,
  Button,
  ButtonBase,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { CommunicationAttachmentDto } from "@ponderosa/core";
import { useEffect, useState } from "react";

export function ChatAttachments({
  attachments,
  density = "comfortable",
}: {
  attachments: CommunicationAttachmentDto[];
  density?: "comfortable" | "compact";
}): JSX.Element | null {
  const [preview, setPreview] = useState<CommunicationAttachmentDto>();
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const [verifiedUrls, setVerifiedUrls] = useState<Record<string, boolean>>({});
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
    setVerifiedUrls({});
    const controller = new AbortController();
    const urls = [...new Set(attachments.flatMap((attachment) => {
      if (attachment.unavailable || attachment.mediaType.startsWith("image/")) return [];
      return [attachment.previewUrl ?? attachment.url, attachment.downloadUrl ?? attachment.url]
        .filter((url): url is string => Boolean(url));
    }))];
    for (const url of urls) {
      void fetch(url, {
        method: "HEAD",
        credentials: "same-origin",
        signal: controller.signal,
      }).then((response) => {
        setVerifiedUrls((current) => ({ ...current, [url]: response.ok }));
      }).catch(() => {
        if (!controller.signal.aborted) {
          setVerifiedUrls((current) => ({ ...current, [url]: false }));
        }
      });
    }
    return () => controller.abort();
  }, [availabilityKey]);
  if (!attachments.length) return null;
  const imageWidth = density === "compact" ? 220 : 320;
  const imageHeight = density === "compact" ? 180 : 240;

  return (
    <>
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: 1 }}>
        {attachments.map((attachment) => {
          const image = !attachment.mediaType || attachment.mediaType.startsWith("image/");
          const previewUrl = attachment.previewUrl ?? attachment.url;
          const downloadUrl = attachment.downloadUrl ?? attachment.url;
          const remoteUrls = image ? [] : [...new Set([previewUrl, downloadUrl].filter(Boolean))] as string[];
          const checking = !attachment.unavailable && !image && remoteUrls.some((url) => verifiedUrls[url] === undefined);
          const safePreviewUrl = image || (previewUrl && verifiedUrls[previewUrl]) ? previewUrl : undefined;
          const safeDownloadUrl = image || (downloadUrl && verifiedUrls[downloadUrl]) ? downloadUrl : undefined;
          const unavailable = attachment.unavailable || failed.has(attachment.id) ||
            (!checking && !safePreviewUrl && !safeDownloadUrl);
          return (
            <Box key={attachment.id} sx={{ maxWidth: "100%" }}>
              {checking ? (
                <Stack
                  spacing={0.35}
                  role="status"
                  sx={{ p: 1, minWidth: 190, border: 1, borderColor: "divider", borderRadius: 1 }}
                >
                  <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{attachment.name}</Typography>
                  <Typography variant="caption" color="text.secondary">Checking artifact availability…</Typography>
                </Stack>
              ) : unavailable ? (
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
              ) : image && safePreviewUrl ? (
                <ButtonBase
                  aria-label={`Preview ${attachment.name}`}
                  onClick={() => setPreview(attachment)}
                  sx={{
                    display: "block",
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
                    src={safePreviewUrl}
                    alt={attachment.name}
                    onError={() => setFailed((current) => new Set(current).add(attachment.id))}
                    sx={{
                      display: "block",
                      width: "auto",
                      maxWidth: { xs: "100%", sm: imageWidth },
                      maxHeight: imageHeight,
                      objectFit: "contain",
                      transition: "filter 120ms ease",
                    }}
                  />
                </ButtonBase>
              ) : (
                <Stack spacing={0.5} sx={{ p: 0.75, border: 1, borderColor: "divider", borderRadius: 1 }}>
                  <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{attachment.name}</Typography>
                  <Typography variant="caption" color="text.secondary">{attachment.mediaType} · {attachment.size} bytes</Typography>
                  <Stack direction="row" spacing={0.5}>
                    {safePreviewUrl ? <Button
                      size="small"
                      component="a"
                      href={safePreviewUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Preview ${attachment.name}`}
                      startIcon={<OpenInNewOutlinedIcon />}
                    >
                      Preview
                    </Button> : null}
                    {safeDownloadUrl ? <Button
                      size="small"
                      component="a"
                      href={safeDownloadUrl}
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
          {preview && (preview.downloadUrl ?? preview.url) ? (
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
            <IconButton aria-label="Close image preview" onClick={() => setPreview(undefined)}>
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
            bgcolor: "#0b0e0d",
            overflow: "auto",
          }}
        >
          {preview && (preview.previewUrl ?? preview.url) ? (
            <Box
              component="img"
              src={preview.previewUrl ?? preview.url}
              alt={preview.name}
              onError={() => {
                setFailed((current) => new Set(current).add(preview.id));
                setPreview(undefined);
              }}
              sx={{
                display: "block",
                maxWidth: "100%",
                maxHeight: "100%",
                objectFit: "contain",
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
