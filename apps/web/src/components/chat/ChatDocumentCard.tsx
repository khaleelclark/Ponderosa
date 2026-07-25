import ArticleIcon from "@mui/icons-material/Article";
import CloseIcon from "@mui/icons-material/Close";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import type { CommunicationDocumentReference } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";
import { api } from "../../api";
import { queryKeys } from "../../queryKeys";

export interface ChatDocumentContract {
  document: CommunicationDocumentReference;
  renderMarkdown(content: string): ReactNode;
}

export function ChatDocumentCard({ document, renderMarkdown }: ChatDocumentContract): JSX.Element {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: queryKeys.communicationDocument.detail(document.id),
    queryFn: () => api.getCommunicationDocument(document.previewUrl),
    enabled: open,
  });
  return (
    <>
      <Paper variant="outlined" sx={{ mt: 1, p: 1 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <ArticleIcon fontSize="small" />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle2" noWrap>{document.title}</Typography>
            <Typography variant="caption" color="text.secondary">Markdown document · {document.byteLength} bytes</Typography>
          </Box>
          <Button className="chat-text-navigation" size="small" color="inherit" onClick={() => setOpen(true)}>Preview</Button>
          <Button className="chat-text-navigation" size="small" component="a" href={document.downloadUrl} download>Download</Button>
        </Stack>
      </Paper>
      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="xl" aria-labelledby={`document-preview-${document.id}`} PaperProps={{ sx: { width: "min(1440px, calc(100vw - 24px))", height: "min(92vh, 1100px)", m: 1.5 } }}>
        <DialogTitle id={`document-preview-${document.id}`} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <ArticleIcon />
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="h6" noWrap>{document.title}</Typography>
            <Typography variant="caption" color="text.secondary">Markdown document · {document.byteLength} bytes</Typography>
          </Box>
          <IconButton aria-label="Close document preview" onClick={() => setOpen(false)}><CloseIcon /></IconButton>
        </DialogTitle>
        <DialogContent dividers className="ponderosa-scroll" sx={{ minHeight: 0, overflowY: "auto", px: { xs: 2, md: 5 }, py: 3 }}>
          {query.isLoading
            ? <Stack sx={{ height: "100%", alignItems: "center", justifyContent: "center" }}><CircularProgress size={28} /></Stack>
            : query.data
              ? <Box sx={{ width: "min(100%, 1080px)", mx: "auto" }}>{renderMarkdown(query.data.content)}</Box>
              : <Alert severity="error">Document preview is unavailable.</Alert>}
        </DialogContent>
        <DialogActions>
          <Button component="a" href={document.downloadUrl} download>Download</Button>
          <Button variant="contained" onClick={() => setOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
