import { routeLinkPath } from "../../routeRegistry";
import { isUnmodifiedPrimaryClick } from "../../nativeNavigation";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, List, ListItemButton, ListItemIcon, ListItemText, Stack, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useState, type MouseEvent } from "react";
import { api } from "../../api";
import { FilePreview } from "../filePreview/FilePreview";

export function ConversationWorkspaceFiles({ conversationId, projectId }: { conversationId: string; projectId: string }): JSX.Element {
  const [path, setPath] = useState("");
  const [selection, setSelection] = useState<{ path: string; open: boolean }>();
  const file = selection?.path;
  const closePreview = () => setSelection(current => current ? { ...current, open: false } : current);
  const directory = useQuery({
    queryKey: ["conversationWorkspaceFiles", conversationId, path],
    queryFn: () => api.getConversationFiles(conversationId, path),
    refetchInterval: 15000,
  });
  const preview = useQuery({
    queryKey: ["conversationWorkspaceFile", conversationId, file],
    queryFn: () => api.getWorkspaceFileView(projectId, file!, undefined, conversationId),
    enabled: file !== undefined,
    staleTime: 0,
  });
  return <Box sx={{ mb: 2, border: 1, borderColor: "divider", borderRadius: 2, p: 1 }}>
    <Stack direction="row" alignItems="center" justifyContent="space-between">
      <Typography fontWeight={700}>Workspace Files</Typography>
      <Button size="small" disabled={directory.isFetching} onClick={() => void directory.refetch()}>Refresh</Button>
    </Stack>
    <Typography variant="caption" color="text.secondary">Chat folder · Browsing does not add Agent context.</Typography>
    <Stack direction="row" alignItems="center" spacing={1} sx={{ my: 1 }}>
      {path && <Button size="small" onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}>Up</Button>}
      <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{path || "Chat folder"}</Typography>
    </Stack>
    {directory.isError ? <Alert severity="error">Could not load this folder. Try Refresh.</Alert> : directory.isLoading ? <Typography variant="body2">Loading files…</Typography> : null}
    <List dense disablePadding sx={{ maxHeight: 360, overflowY: "auto" }}>
      {directory.data?.kind === "dir" && directory.data.entries.map(entry => <ListItemButton key={entry.path} component={entry.kind === "dir" ? "div" : "a"}
        href={entry.kind === "dir" ? undefined : routeLinkPath({ kind: "workspaceFile", projectId, conversationId, path: entry.path })}
        onClick={(event: MouseEvent<HTMLElement>) => { if (entry.kind === "dir") setPath(entry.path); else if (isUnmodifiedPrimaryClick(event)) { event.preventDefault(); setSelection({ path: entry.path, open: true }); } }}>
        <ListItemIcon sx={{ minWidth: 32 }}>{entry.kind === "dir" ? <FolderOutlinedIcon fontSize="small" /> : <DescriptionOutlinedIcon fontSize="small" />}</ListItemIcon>
        <ListItemText primary={entry.name} primaryTypographyProps={{ variant: "body2", sx: { overflowWrap: "anywhere" } }} />
      </ListItemButton>)}
    </List>
    {directory.data?.kind === "dir" && !directory.data.entries.length && <Typography variant="body2" color="text.secondary">No visible files in this folder.</Typography>}
    <Dialog open={selection?.open === true} onClose={closePreview} fullWidth maxWidth="md"
      slotProps={{ transition: { onExited: () => setSelection(current => current?.open ? current : undefined) } }}>
      <DialogTitle sx={{ overflowWrap: "anywhere" }}>{file}</DialogTitle>
      <DialogContent>
        <FilePreview title={file ?? "File"} projectId={projectId} conversationId={conversationId} path={file}
          loading={preview.isLoading} error={preview.isError ? preview.error as Error : undefined}
          mediaType={preview.data?.mediaType} content={preview.data?.text} previewUrl={preview.data?.previewUrl}
          downloadUrl={preview.data?.downloadUrl} truncated={preview.data?.truncated} />
      </DialogContent>
      <DialogActions><Button onClick={closePreview}>Close</Button></DialogActions>
    </Dialog>
  </Box>;
}
