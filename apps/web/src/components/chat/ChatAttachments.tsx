import { Box, Button, Stack, Typography } from "@mui/material";
import type { ImageAttachmentDto } from "@ponderosa/core";

export function ChatAttachments({
  attachments,
  density = "comfortable",
}: {
  attachments: ImageAttachmentDto[];
  density?: "comfortable" | "compact";
}): JSX.Element | null {
  if (!attachments.length) return null;
  const imageWidth = density === "compact" ? 220 : 320;
  const imageHeight = density === "compact" ? 180 : 240;

  return (
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: 1 }}>
      {attachments.map((attachment) => {
        const image = attachment.previewUrl || !attachment.mediaType || attachment.mediaType.startsWith("image/");
        return (
          <Box key={attachment.id} sx={{ maxWidth: "100%" }}>
            {image
              ? <Box component="img" src={attachment.previewUrl ?? attachment.url} alt={attachment.name} sx={{ display: "block", width: "auto", maxWidth: { xs: "100%", sm: imageWidth }, maxHeight: imageHeight, objectFit: "contain", borderRadius: 1 }} />
              : <Stack spacing={0.25} sx={{ p: 0.75, border: 1, borderColor: "divider", borderRadius: 1 }}>
                  <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{attachment.name}</Typography>
                  <Typography variant="caption" color="text.secondary">{attachment.mediaType} · {attachment.size} bytes</Typography>
                </Stack>}
            <Stack direction="row" spacing={0.5} sx={{ mt: 0.25, minHeight: 44, alignItems: "center" }}>
              {attachment.previewUrl ? <Button size="small" component="a" href={attachment.previewUrl} target="_blank" rel="noreferrer" sx={{ px: 1 }}>Open</Button> : null}
              <Button
                size="small"
                component="a"
                href={attachment.downloadUrl ?? attachment.url}
                target="_blank"
                rel="noreferrer"
                download
                aria-label={`Download ${attachment.name}`}
                sx={{ px: 1 }}
              >
                Download
              </Button>
            </Stack>
          </Box>
        );
      })}
    </Stack>
  );
}
