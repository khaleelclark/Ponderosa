import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, List, ListItemButton, ListItemIcon, ListItemText, Stack, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../api";
import { useMutationNotification } from "../MutationNotifications";

export function ConversationWorkspaceFiles({ conversationId }: { conversationId: string }): JSX.Element {
  const notify = useMutationNotification();
  const [path, setPath] = useState("");
  const [file, setFile] = useState<string>();
  const directory = useQuery({
    queryKey: ["conversationWorkspaceFiles", conversationId, path],
    queryFn: () => api.getConversationFiles(conversationId, path),
    refetchInterval: 15000,
  });
  const preview = useQuery({
    queryKey: ["conversationWorkspaceFile", conversationId, file],
    queryFn: () => api.getConversationFiles(conversationId, file!),
    enabled: file !== undefined,
    staleTime: 0,
  });
  const download = () => {
    const data = preview.data;
    if (data?.kind !== "file") return;
    const body = data.encoding === "base64" ? Uint8Array.from(atob(data.content), c => c.charCodeAt(0)) : data.content;
    const url = URL.createObjectURL(new Blob([body], { type: "application/octet-stream" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = data.path.split("/").pop() ?? "file";
    link.click();
    notify({ message: "Download started", key: "first-party-download" });
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <Box sx={{ mb: 2, border: 1, borderColor: "divider", borderRadius: 2, p: 1 }}>
    <Stack direction="row" alignItems="center" justifyContent="space-between">
      <Typography fontWeight={700}>Workspace Files</Typography>
      <Button size="small" disabled={directory.isFetching} onClick={() => void directory.refetch()}>Refresh</Button>
    </Stack>
    <Typography variant="caption" color="text.secondary">Live files in this chat’s folder. Browsing does not import files or add them to agent context.</Typography>
    <Stack direction="row" alignItems="center" spacing={1} sx={{ my: 1 }}>
      {path && <Button size="small" onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}>Up</Button>}
      <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{path || "Chat folder"}</Typography>
    </Stack>
    {directory.isError ? <Alert severity="error">Could not load this folder. Try Refresh.</Alert> : directory.isLoading ? <Typography variant="body2">Loading files…</Typography> : null}
    <List dense disablePadding sx={{ maxHeight: 360, overflowY: "auto" }}>
      {directory.data?.kind === "dir" && directory.data.entries.map(entry => <ListItemButton key={entry.path} onClick={() => entry.kind === "dir" ? setPath(entry.path) : setFile(entry.path)}>
        <ListItemIcon sx={{ minWidth: 32 }}>{entry.kind === "dir" ? <FolderOutlinedIcon fontSize="small" /> : <DescriptionOutlinedIcon fontSize="small" />}</ListItemIcon>
        <ListItemText primary={entry.name} primaryTypographyProps={{ variant: "body2", sx: { overflowWrap: "anywhere" } }} />
      </ListItemButton>)}
    </List>
    {directory.data?.kind === "dir" && !directory.data.entries.length && <Typography variant="body2" color="text.secondary">No visible files in this folder.</Typography>}
    <Dialog open={file !== undefined} onClose={() => setFile(undefined)} fullWidth maxWidth="md">
      <DialogTitle sx={{ overflowWrap: "anywhere" }}>{file}</DialogTitle>
      <DialogContent>
        {preview.isLoading && <Typography>Loading file…</Typography>}
        {preview.isError && <Alert severity="warning">{preview.error instanceof Error ? preview.error.message : "File unavailable"}</Alert>}
        {preview.data?.kind === "file" && (preview.data.encoding === "utf-8" ? <Box component="pre" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 13 }}>{preview.data.content}</Box> : <Typography>Binary file. Download to open it.</Typography>)}
      </DialogContent>
      <DialogActions><Button onClick={download} disabled={preview.data?.kind !== "file" || preview.isError}>Download</Button><Button onClick={() => setFile(undefined)}>Close</Button></DialogActions>
    </Dialog>
  </Box>;
}
