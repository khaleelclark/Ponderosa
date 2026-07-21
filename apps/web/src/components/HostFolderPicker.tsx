import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import CreateNewFolderOutlinedIcon from "@mui/icons-material/CreateNewFolderOutlined";
import FolderIcon from "@mui/icons-material/Folder";
import {
  Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
  IconButton, List, ListItemButton, ListItemIcon, ListItemText, Stack, TextField, Tooltip, Typography,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";

export function HostFolderPicker({ open, initialPath, onClose, onChoose }: {
  open: boolean;
  initialPath?: string;
  onClose(): void;
  onChoose(path: string): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [path, setPath] = useState(initialPath);
  const [pathInput, setPathInput] = useState(initialPath ?? "");
  const [selectedPath, setSelectedPath] = useState(initialPath);
  const [creating, setCreating] = useState(false);
  const [folderName, setFolderName] = useState("");
  useEffect(() => {
    if (!open) return;
    setPath(initialPath);
    setPathInput(initialPath ?? "");
    setSelectedPath(initialPath);
    setCreating(false);
    setFolderName("");
  }, [initialPath, open]);
  const query = useQuery({
    queryKey: ["host-folder-browser", path],
    queryFn: () => api.browseProjectFolders(path),
    enabled: open,
  });
  useEffect(() => {
    if (!query.data || query.data.path !== path) return;
    setPathInput(query.data.path);
    if (!selectedPath) setSelectedPath(query.data.path);
  }, [path, query.data, selectedPath]);
  const createFolder = useMutation({
    mutationFn: () => api.createProjectFolder({ parentPath: query.data!.path, name: folderName.trim() }),
    onSuccess: (folder) => {
      setFolderName("");
      setCreating(false);
      setPath(folder.hostPath);
      setPathInput(folder.hostPath);
      setSelectedPath(folder.hostPath);
      void queryClient.invalidateQueries({ queryKey: ["host-folder-browser"] });
    },
  });
  const navigateTo = (hostPath: string) => {
    setPath(hostPath);
    setPathInput(hostPath);
    setSelectedPath(undefined);
    setCreating(false);
  };
  return <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" aria-labelledby="host-folder-picker-title">
    <DialogTitle id="host-folder-picker-title">Choose a Working Folder</DialogTitle>
    <DialogContent>
      <Stack spacing={1.5} sx={{ pt: 1 }}>
        <Typography variant="body2" color="text.secondary">
          Browse folders on the {query.data ? "Ponderosa host" : "host running Ponderosa"}. Paths follow that host&apos;s operating system.
        </Typography>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
          <TextField
            label="Folder Path"
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && pathInput.trim()) navigateTo(pathInput.trim()); }}
            fullWidth
          />
          <Button variant="outlined" disabled={!pathInput.trim()} onClick={() => navigateTo(pathInput.trim())}>Go</Button>
        </Stack>
        {query.isError ? <Alert severity="error">This folder is unavailable or Ponderosa does not have permission to open it.</Alert> : null}
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", minHeight: 36 }}>
          {query.data?.parentPath ? <Button size="small" startIcon={<ArrowUpwardIcon />} onClick={() => navigateTo(query.data!.parentPath!)}>Up</Button> : null}
          <Typography variant="caption" sx={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{query.data?.path ?? "Loading folders…"}</Typography>
          <Button size="small" startIcon={<CreateNewFolderOutlinedIcon />} disabled={!query.data} onClick={() => setCreating((value) => !value)}>New Folder</Button>
        </Stack>
        {creating ? <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
          <TextField autoFocus label="New Folder Name" value={folderName} onChange={(event) => setFolderName(event.target.value)} fullWidth />
          <Button variant="contained" disabled={!folderName.trim() || createFolder.isPending} onClick={() => createFolder.mutate()}>
            {createFolder.isPending ? "Creating…" : "Create"}
          </Button>
        </Stack> : null}
        {createFolder.isError ? <Alert severity="error">{createFolder.error instanceof Error ? createFolder.error.message : "Folder could not be created."}</Alert> : null}
        <Box sx={{ minHeight: 280, maxHeight: "42vh", overflowY: "auto", border: 1, borderColor: "divider", borderRadius: 1.5 }}>
          {query.isLoading ? <Stack sx={{ py: 6, alignItems: "center" }}><CircularProgress size={26} /></Stack> : null}
          <List aria-label="Folders on the Ponderosa host" disablePadding>
            {query.data?.folders.map((folder) => <ListItemButton
              key={folder.hostPath}
              selected={selectedPath === folder.hostPath}
              onClick={() => setSelectedPath(folder.hostPath)}
              onDoubleClick={() => navigateTo(folder.hostPath)}
            >
              <ListItemIcon><FolderIcon /></ListItemIcon>
              <ListItemText primary={folder.name} secondary={folder.hostPath} secondaryTypographyProps={{ sx: { overflowWrap: "anywhere" } }} />
              <Tooltip title="Open Folder"><IconButton edge="end" aria-label={`Open ${folder.name}`} onClick={(event) => { event.stopPropagation(); navigateTo(folder.hostPath); }}><ChevronRightIcon /></IconButton></Tooltip>
            </ListItemButton>)}
          </List>
        </Box>
        <Typography variant="caption" color="text.secondary">Selected: {selectedPath ?? query.data?.path ?? "No folder selected"}</Typography>
      </Stack>
    </DialogContent>
    <DialogActions>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="contained" disabled={query.isError || (!selectedPath && !query.data?.path)} onClick={() => onChoose(selectedPath ?? query.data!.path)}>Use This Folder</Button>
    </DialogActions>
  </Dialog>;
}
