import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import FolderIcon from "@mui/icons-material/Folder";
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, InputLabel, List, ListItemButton, ListItemIcon, ListItemText, MenuItem, Select, Stack, TextField, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { ProjectFolderMode } from "../projectLifecycle";

export interface HostFolderSelection { mode: ProjectFolderMode; path?: string; newFolderName?: string }

export function HostFolderPicker({ open, initialMode = "none", initialPath, initialFolderName, managedRoot, onClose, onChoose }: {
  open: boolean;
  initialMode?: ProjectFolderMode;
  initialPath?: string;
  initialFolderName?: string;
  managedRoot?: string;
  onClose(): void;
  onChoose(selection: HostFolderSelection): void;
}): JSX.Element {
  const [mode, setMode] = useState<ProjectFolderMode>(initialMode);
  const [path, setPath] = useState(initialPath);
  const [manualPath, setManualPath] = useState(initialPath ?? "");
  const [folderName, setFolderName] = useState(initialFolderName ?? "");
  useEffect(() => { if (open) { setMode(initialMode); setPath(initialPath); setManualPath(initialPath ?? ""); setFolderName(initialFolderName ?? ""); } }, [initialFolderName, initialMode, initialPath, open]);
  const query = useQuery({ queryKey: ["host-folder-browser", path], queryFn: () => api.browseProjectFolders(path), enabled: open && mode === "existing" });
  const chosenPath = manualPath.trim() || query.data?.path;
  const canChoose = mode === "none" || (mode === "existing" && Boolean(chosenPath)) || (mode === "create" && Boolean(folderName.trim()));
  return <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="host-folder-picker-title">
    <DialogTitle id="host-folder-picker-title">Choose the Project working folder</DialogTitle>
    <DialogContent>
      <Stack spacing={2} sx={{ pt: 1 }}>
        <FormControl fullWidth><InputLabel id="host-folder-mode-label">Folder option</InputLabel><Select labelId="host-folder-mode-label" label="Folder option" value={mode} onChange={(event) => setMode(event.target.value as ProjectFolderMode)}>
          <MenuItem value="none">Private Empty Workspace</MenuItem>
          <MenuItem value="existing">Existing Folder on This Host</MenuItem>
          <MenuItem value="create">New Managed Folder</MenuItem>
        </Select></FormControl>
        {mode === "none" ? <Alert severity="info">Ponderosa will create a private empty workspace. You can connect a different folder later.</Alert> : null}
        {mode === "existing" ? <>
          <Typography variant="body2" color="text.secondary">Browse server-approved folders or enter an absolute host path. This does not browse the phone or computer viewing Ponderosa.</Typography>
          {query.isError ? <Alert severity="error">This folder is unavailable or outside an allowed root.</Alert> : null}
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}><Typography variant="caption" sx={{ flex: 1, overflowWrap: "anywhere" }}>{query.data?.path ?? "Loading folders…"}</Typography>{query.data?.parentPath ? <Button startIcon={<ArrowUpwardIcon />} onClick={() => { setPath(query.data!.parentPath); setManualPath(""); }}>Up</Button> : null}</Stack>
          <List aria-label="Host folders" sx={{ maxHeight: "30vh", overflowY: "auto", border: 1, borderColor: "divider", borderRadius: 1 }}>{query.data?.folders.map((folder) => <ListItemButton key={folder.hostPath} selected={chosenPath === folder.hostPath} onDoubleClick={() => { setPath(folder.hostPath); setManualPath(folder.hostPath); }} onClick={() => { setPath(folder.hostPath); setManualPath(folder.hostPath); }}><ListItemIcon><FolderIcon /></ListItemIcon><ListItemText primary={folder.name} secondary={folder.hostPath} secondaryTypographyProps={{ sx: { overflowWrap: "anywhere" } }} /></ListItemButton>)}</List>
          <TextField label="Host path" value={manualPath} onChange={(event) => setManualPath(event.target.value)} placeholder="/Users/you/Projects/app" helperText="Use an absolute path within a server-approved root." fullWidth />
        </> : null}
        {mode === "create" ? <TextField autoFocus label="New folder name" value={folderName} onChange={(event) => setFolderName(event.target.value)} helperText={`Created inside ${managedRoot ?? "Ponderosa's managed workspace"}`} fullWidth /> : null}
      </Stack>
    </DialogContent>
    <DialogActions><Button onClick={onClose}>Cancel</Button><Button variant="contained" disabled={!canChoose} onClick={() => onChoose(mode === "existing" ? { mode, path: chosenPath } : mode === "create" ? { mode, newFolderName: folderName.trim() } : { mode })}>Use This Option</Button></DialogActions>
  </Dialog>;
}
