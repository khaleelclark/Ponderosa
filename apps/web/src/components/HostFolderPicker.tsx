import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import FolderIcon from "@mui/icons-material/Folder";
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, List, ListItemButton, ListItemIcon, ListItemText, Stack, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";

export function HostFolderPicker({ open, initialPath, onClose, onChoose }: { open: boolean; initialPath?: string; onClose(): void; onChoose(path: string): void }): JSX.Element {
  const [path, setPath] = useState(initialPath);
  useEffect(() => { if (open) setPath(initialPath); }, [initialPath, open]);
  const query = useQuery({ queryKey: ["host-folder-browser", path], queryFn: () => api.browseProjectFolders(path), enabled: open });
  return <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="host-folder-picker-title">
    <DialogTitle id="host-folder-picker-title">Choose a folder on the Ponderosa host</DialogTitle>
    <DialogContent>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>This browser shows only server-configured roots. It does not browse this phone or computer.</Typography>
      {query.isError ? <Alert severity="error">This folder is unavailable or outside an allowed root.</Alert> : null}
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", py: 1 }}><Typography variant="caption" sx={{ flex: 1, overflowWrap: "anywhere" }}>{query.data?.path ?? "Loading…"}</Typography>{query.data?.parentPath ? <Button startIcon={<ArrowUpwardIcon />} onClick={() => setPath(query.data!.parentPath)}>Up</Button> : null}</Stack>
      <List aria-label="Host folders" sx={{ maxHeight: "50vh", overflowY: "auto" }}>{query.data?.folders.map((folder) => <ListItemButton key={folder.hostPath} onDoubleClick={() => setPath(folder.hostPath)} onClick={() => setPath(folder.hostPath)}><ListItemIcon><FolderIcon /></ListItemIcon><ListItemText primary={folder.name} secondary={folder.hostPath} secondaryTypographyProps={{ sx: { overflowWrap: "anywhere" } }} /></ListItemButton>)}</List>
    </DialogContent>
    <DialogActions><Button onClick={onClose}>Cancel</Button><Button variant="contained" disabled={!query.data?.path} onClick={() => onChoose(query.data!.path)}>Choose this folder</Button></DialogActions>
  </Dialog>;
}
