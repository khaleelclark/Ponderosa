import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import SearchIcon from "@mui/icons-material/Search";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  InputAdornment,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { AgentDto, ArtifactDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { artifactDisplayLabel } from "./panes";

interface ProjectArtifactRecord {
  agent?: AgentDto;
  artifact: ArtifactDto;
}

const projectOutputKinds = new Set<ArtifactDto["kind"]>([
  "test_report",
  "pr_summary",
  "document",
  "screenshot",
  "generated_file",
]);

export function ProjectArtifactsView({
  projectId,
  agents,
  onOpenArtifact,
}: {
  projectId: string;
  agents: AgentDto[];
  onOpenArtifact(agentId: string, artifactId: string): void;
}): JSX.Element {
  const [filter, setFilter] = useState("");
  const [previewArtifact, setPreviewArtifact] = useState<ArtifactDto>();
  const [olderArtifacts, setOlderArtifacts] = useState<{ items: ArtifactDto[]; cursor?: string; hasMore: boolean }>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  useEffect(() => {
    setOlderArtifacts(undefined);
    setPreviewArtifact(undefined);
  }, [projectId]);
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const projectArtifacts = useQuery({
    queryKey: ["project-artifacts", projectId],
    queryFn: () => api.listProjectArtifacts(projectId),
  });
  const records = useMemo(() => {
    const agentById = new Map(agents.map((agent) => [agent.id, agent] as const));
    const canonical = [...new Map([
      ...(olderArtifacts?.items ?? []),
      ...(projectArtifacts.data?.items ?? []),
    ].map((artifact) => [artifact.id, artifact] as const)).values()]
      .filter((artifact) => projectOutputKinds.has(artifact.kind));
    return canonical.map((artifact) => ({
        agent: agentById.get(artifact.originAgentId ?? artifact.agentId),
        artifact,
      })).sort((left, right) => right.artifact.createdAt.localeCompare(left.artifact.createdAt));
  }, [agents, olderArtifacts?.items, projectArtifacts.data?.items]);
  const filtered = useMemo(() => records.filter(({ agent, artifact }) => !normalizedFilter || [
    agent?.title,
    artifactDisplayLabel(artifact),
    artifact.path,
    artifact.summary,
    artifact.kind,
  ].filter(Boolean).join(" ").toLocaleLowerCase().includes(normalizedFilter)), [records, normalizedFilter]);
  const loading = projectArtifacts.isLoading;

  return <Box sx={{ minHeight: 0, minWidth: 0, width: "100%", overflowY: "auto", p: { xs: 1.5, sm: 3 } }}>
    <Stack spacing={1.5} sx={{ width: "100%", minWidth: 0 }}>
      <Box>
        <Typography variant="h5" component="h2" fontWeight={800}>Project files</Typography>
        <Typography variant="body2" color="text.secondary">Documents, images, downloads, test results, and generated artifacts created across this project.</Typography>
      </Box>
      <TextField
        size="small"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Search files, results, or agents"
        inputProps={{ "aria-label": "Search project files" }}
        InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
        sx={{ maxWidth: 420 }}
      />
      <Typography variant="caption" color="text.secondary">{filtered.length === records.length ? `${records.length} project files` : `${filtered.length} of ${records.length} project files`}</Typography>
      {(olderArtifacts?.hasMore ?? projectArtifacts.data?.history.hasMore) ? <Button
        size="small"
        color="inherit"
        disabled={loadingOlder}
        onClick={() => {
          const cursor = olderArtifacts?.cursor ?? projectArtifacts.data?.history.cursor;
          if (!cursor) return;
          setLoadingOlder(true);
          void api.listProjectArtifacts(projectId, 100, cursor).then((page) => {
            setOlderArtifacts((current) => ({
              items: [...new Map([...page.items, ...(current?.items ?? [])].map((artifact) => [artifact.id, artifact] as const)).values()],
              cursor: page.history.cursor,
              hasMore: page.history.hasMore,
            }));
          }).finally(() => setLoadingOlder(false));
        }}
        sx={{ alignSelf: "center" }}
      >{loadingOlder ? "Loading…" : "Load older files"}</Button> : null}
      {loading && records.length === 0 ? <Stack direction="row" spacing={1} sx={{ alignItems: "center", py: 2 }}><CircularProgress size={18} /><Typography variant="body2" color="text.secondary">Loading project files…</Typography></Stack> : null}
      {projectArtifacts.isError ? <Alert severity="error">Project files could not be loaded. Try again.</Alert> : null}
      {!loading && records.length === 0 ? <Alert severity="info">No project files yet. Agent-created documents, images, downloads, and generated results will appear here.</Alert> : null}
      {records.length > 0 && filtered.length === 0 ? <Alert severity="info">No project files match “{filter.trim()}”.</Alert> : null}
      <List aria-label="Project files" disablePadding sx={{ display: "grid", gap: 0.75 }}>
        {filtered.map(({ agent, artifact }) => {
          const label = artifactDisplayLabel(artifact);
          const owner = agent?.title ?? "Project";
          const canOpen = Boolean(artifact.previewUrl || agent);
          return <Box key={`${artifact.projectId ?? projectId}:${artifact.id}`} sx={{ display: "flex", alignItems: "center", minWidth: 0, borderRadius: 1.5, bgcolor: "background.paper", boxShadow: (theme) => `inset 0 0 0 1px ${theme.palette.divider}`, overflow: "hidden" }}>
            <ListItemButton
              aria-label={`Open ${label} from ${owner}`}
              disabled={!canOpen}
              onClick={() => {
                if (artifact.previewUrl) setPreviewArtifact(artifact);
                else if (agent) onOpenArtifact(agent.id, artifact.id);
              }}
              sx={{ minWidth: 0, px: 1.5 }}
            >
              <ListItemIcon sx={{ minWidth: 40 }}><Inventory2OutlinedIcon /></ListItemIcon>
              <ListItemText
                primary={label}
                secondary={`${owner} · ${artifact.path}`}
                primaryTypographyProps={{ fontWeight: 750, noWrap: true }}
                secondaryTypographyProps={{ noWrap: true }}
              />
              <Stack direction="row" spacing={1} sx={{ ml: 1, alignItems: "center", flexShrink: 0, display: { xs: "none", lg: "flex" } }}>
                <Chip size="small" variant="outlined" label={artifact.kind.replaceAll("_", " ")} />
                <Typography variant="caption" color="text.secondary">{new Date(artifact.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</Typography>
              </Stack>
            </ListItemButton>
            {artifact.previewUrl ? <Button aria-label={`Preview ${label}`} onClick={() => setPreviewArtifact(artifact)} size="small" startIcon={<OpenInNewOutlinedIcon />} sx={{ display: { xs: "none", lg: "inline-flex" }, mr: .5, flexShrink: 0 }}>Preview</Button> : null}
            {artifact.downloadUrl ? <Button component="a" href={artifact.downloadUrl} download size="small" startIcon={<DownloadOutlinedIcon />} sx={{ mr: { xs: .5, sm: 1 }, px: { xs: .75, sm: 1 }, flexShrink: 0 }}><Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>Download</Box></Button> : null}
          </Box>;
        })}
      </List>
    </Stack>
    <Dialog open={Boolean(previewArtifact)} onClose={() => setPreviewArtifact(undefined)} fullWidth maxWidth="lg">
      <DialogTitle>{previewArtifact ? artifactDisplayLabel(previewArtifact) : "File preview"}</DialogTitle>
      <DialogContent sx={{ p: { xs: 1, sm: 2 }, bgcolor: "background.default" }}>
        {previewArtifact?.previewUrl ? previewArtifact.mediaType?.startsWith("image/") ? <Box
          component="img"
          data-testid="artifact-image-preview"
          src={previewArtifact.previewUrl}
          alt={artifactDisplayLabel(previewArtifact)}
          sx={{ display: "block", maxWidth: "100%", maxHeight: "72dvh", mx: "auto", objectFit: "contain", borderRadius: 1 }}
        /> : <Box
          component="iframe"
          data-testid="artifact-document-preview"
          src={previewArtifact.previewUrl}
          title={artifactDisplayLabel(previewArtifact)}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          sx={{ display: "block", width: "100%", height: "72dvh", border: 0, borderRadius: 1, bgcolor: "background.paper" }}
        /> : null}
      </DialogContent>
      <DialogActions>
        {previewArtifact?.downloadUrl ? <Button component="a" href={previewArtifact.downloadUrl} download startIcon={<DownloadOutlinedIcon />}>Download</Button> : null}
        <Button onClick={() => setPreviewArtifact(undefined)}>Close</Button>
      </DialogActions>
    </Dialog>
  </Box>;
}
