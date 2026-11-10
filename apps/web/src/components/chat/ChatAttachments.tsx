import {AudioMessagePlayer} from '../speech/AudioMessagePlayer';
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import MoreVertIcon from "@mui/icons-material/MoreVert";
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
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { CommunicationAttachmentDto } from "@ponderosa/core";
import { useEffect, useState } from "react";
import { FilePreview } from "../filePreview/FilePreview";
import { previewCapability } from "../filePreview/mimeCapabilities";
import { readTextPreview } from "../filePreview/readTextPreview";

// Keep the download URL while asking the verified attachment route for inline
// audio. Preserve any existing query and fragment.
const audioPlaybackUrl = (url: string) => {
  if (url.startsWith("blob:")) return url;
  const [path = "", ...fragment] = url.split("#");
  return path + (path.includes("?") ? "&" : "?") + "playback=audio" + (fragment.length ? "#" + fragment.join("#") : "");
};

const textPreviewSupported = (attachment: CommunicationAttachmentDto) =>
  ["text", "markdown", "diff"].includes(previewCapability({
    mediaType: attachment.mediaType, path: attachment.name,
  }).kind);
const documentPreviewSupported = (attachment: CommunicationAttachmentDto) => ["docx", "pdf"].includes(previewCapability({
  mediaType: attachment.mediaType, path: attachment.name,
}).kind);

export function ChatAttachments({
  attachments,
}: {
  attachments: CommunicationAttachmentDto[];
}): JSX.Element | null {
  const [menu,setMenu]=useState<{anchor:HTMLElement;id:string}>();
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
    setMenu(undefined);
  }, [availabilityKey]);
  if (!attachments.length) return null;
  const menuAttachment=attachments.find(item=>item.id===menu?.id);
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
          const audioUrl = downloadUrl ?? previewUrl;
          const unavailable = attachment.unavailable || failed.has(attachment.id) ||
            (!previewUrl && !downloadUrl);
          return (
            <Box key={attachment.id} className="chat-attachment-card" sx={{ maxWidth: "100%",minWidth:0 }}>
              {!unavailable && attachment.mediaType.startsWith("audio/") && audioUrl ? (
                <Stack spacing={0.5} sx={{maxWidth:"100%",width:300}}><Typography variant="caption" title={attachment.name} noWrap sx={{minWidth:0}}>{attachment.name}</Typography><AudioMessagePlayer src={audioPlaybackUrl(audioUrl)} downloadUrl={audioUrl} label={`Play ${attachment.name}`}/></Stack>
              ) : !unavailable && image && previewUrl ? (
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
                    loading="lazy"
                    decoding="async"
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
                <Stack direction="row" alignItems="center" className="chat-file-chip" onContextMenu={event=>{event.preventDefault();event.stopPropagation();setMenu({anchor:event.currentTarget,id:attachment.id});}} onKeyDown={event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();event.stopPropagation();setMenu({anchor:event.currentTarget,id:attachment.id});}}} sx={{maxWidth:'100%',minWidth:0,border:1,borderColor:'divider',borderRadius:1.5,bgcolor:'background.paper',color:'text.primary'}}>
                  <Tooltip title={attachment.name||'Attachment Unavailable'}><ButtonBase aria-label={`Preview ${attachment.name||'Unavailable Attachment'}`} onClick={()=>setPreview(attachment)} sx={{gap:.75,px:1,minWidth:0,minHeight:32,maxWidth:'100%',borderRadius:1.5,'@media (pointer: coarse)':{minHeight:44}}}><InsertDriveFileOutlinedIcon sx={{fontSize:18,flexShrink:0}}/><Typography variant="body2" noWrap sx={{minWidth:0,maxWidth:{xs:210,sm:300}}}>{attachment.name||'Attachment Unavailable'}</Typography></ButtonBase></Tooltip>
                  <Tooltip title="File Options"><IconButton size="small" aria-label={`File Options For ${attachment.name||'Unavailable Attachment'}`} aria-haspopup="menu" aria-expanded={menu?.id===attachment.id||undefined} onClick={event=>setMenu({anchor:event.currentTarget,id:attachment.id})} sx={{width:32,height:32,flexShrink:0,'@media (pointer: coarse)':{width:44,height:44}}}><MoreVertIcon sx={{fontSize:18}}/></IconButton></Tooltip>
                </Stack>
              )}
            </Box>
          );
        })}
      </Stack>
      <Menu anchorEl={menu?.anchor} open={Boolean(menu)} onClose={()=>setMenu(undefined)}>
        <MenuItem onClick={()=>{const attachment=attachments.find(item=>item.id===menu?.id);setMenu(undefined);if(attachment)setPreview(attachment);}}><VisibilityOutlinedIcon fontSize="small" sx={{mr:1}}/>Preview</MenuItem>
        <MenuItem component="a" href={menuAttachment?.downloadUrl??menuAttachment?.url} download={menuAttachment?.name} disabled={!menuAttachment||menuAttachment.unavailable||!(menuAttachment.downloadUrl??menuAttachment.url)} onClick={()=>setMenu(undefined)}><DownloadOutlinedIcon fontSize="small" sx={{mr:1}}/>Download</MenuItem>
      </Menu>
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
            <Button component="a" href={preview.downloadUrl??preview.url} download={preview.name} aria-label={`Download ${preview.name}`} startIcon={<DownloadOutlinedIcon/>}>Download</Button>
          ) : null}
          <Tooltip title="Close">
            <IconButton aria-label="Close Attachment Preview" onClick={() => setPreview(undefined)}>
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
            bgcolor: !previewUnavailable && preview && (!preview.mediaType||preview.mediaType.startsWith("image/")) ? "#0b0e0d" : "background.paper",
            overflow: "auto",
          }}
        >
          {previewUnavailable ? (
            <Stack sx={{ p: 2 }}><Typography role="status">{preview?.unavailable ? "Attachment unavailable" : "Preview could not load."}</Typography>
              {preview && failed.has(preview.id) && !preview.unavailable ? <Button onClick={() => setFailed(current => { const next = new Set(current); next.delete(preview.id); return next; })}>Retry Preview</Button> : null}
            </Stack>
          ) : preview && documentPreviewSupported(preview) ? (
            <Box sx={{ width: "100%", height: "100%", p: 2, minWidth: 0 }}>
              <FilePreview key={preview.id} title={preview.name} path={preview.name} mediaType={preview.mediaType}
                previewUrl={preview.downloadUrl ?? preview.url ?? preview.previewUrl}
                downloadUrl={preview.downloadUrl ?? preview.url} hideHeader maxHeight="100%" />
            </Box>
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
              {currentTextPreview?.error ? <Button onClick={() => setRetry(value => value + 1)}>Retry Preview</Button> : null}
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
            <Box sx={{p:2,width:'100%',minWidth:0}}><FilePreview title={preview.name} path={preview.name} mediaType={preview.mediaType} downloadUrl={preview.downloadUrl??preview.url} hideHeader/></Box>
          ) : null}
        </DialogContent>
        {attachments.length > 1 ? (
          <DialogActions sx={{ justifyContent: "center", gap: 1 }}>
            <IconButton aria-label="Previous Attachment" onClick={() => navigatePreview(-1)}>
              <ChevronLeftIcon />
            </IconButton>
            <Typography variant="body2" role="status" aria-live="polite" aria-atomic="true">
              {previewIndex + 1} of {attachments.length}
            </Typography>
            <IconButton aria-label="Next Attachment" onClick={() => navigatePreview(1)}>
              <ChevronRightIcon />
            </IconButton>
          </DialogActions>
        ) : null}
      </Dialog>
    </>
  );
}
