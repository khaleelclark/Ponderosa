import CloseIcon from "@mui/icons-material/Close";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
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
import type { ImageAttachmentDto } from "@ponderosa/core";
import { useState } from "react";

export function ChatAttachments({
  attachments,
  density = "comfortable",
}: {
  attachments: ImageAttachmentDto[];
  density?: "comfortable" | "compact";
}): JSX.Element | null {
  const [preview, setPreview] = useState<ImageAttachmentDto>();
  if (!attachments.length) return null;
  const imageWidth = density === "compact" ? 220 : 320;
  const imageHeight = density === "compact" ? 180 : 240;

  return (
    <>
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: 1 }}>
        {attachments.map((attachment) => {
          const image = !attachment.mediaType || attachment.mediaType.startsWith("image/");
          return (
            <Box key={attachment.id} sx={{ maxWidth: "100%" }}>
              {image ? (
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
                    src={attachment.previewUrl ?? attachment.url}
                    alt={attachment.name}
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
                  <Button
                    size="small"
                    component="a"
                    href={attachment.downloadUrl ?? attachment.url}
                    download
                    aria-label={`Download ${attachment.name}`}
                    startIcon={<DownloadOutlinedIcon />}
                    sx={{ alignSelf: "flex-start" }}
                  >
                    Download
                  </Button>
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
          <Typography variant="subtitle1" noWrap sx={{ flex: 1, minWidth: 0 }}>
            {preview?.name}
          </Typography>
          {preview ? (
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
          {preview ? (
            <Box
              component="img"
              src={preview.previewUrl ?? preview.url}
              alt={preview.name}
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
