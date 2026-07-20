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
  Menu,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { AgentDto, AgentHealthDto, ArtifactDto, ProjectDto } from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { artifactDisplayLabel } from "./panes";
import { ProjectOverview } from "./ProjectOverview";

interface ProjectArtifactRecord {
  agent?: AgentDto;
  artifact: ArtifactDto;
}

export function isTextArtifactPreview(mediaType: string | undefined): boolean {
  return Boolean(mediaType && mediaType !== "text/html" && (
    mediaType.startsWith("text/") || mediaType === "application/json"
  ));
}

function ArtifactTextPreview({ artifact }: { artifact: ArtifactDto }): JSX.Element {
  const query = useQuery({
    queryKey: ["project-artifact-text-preview", artifact.id, artifact.previewUrl],
    queryFn: async ({ signal }) => {
      const response = await fetch(artifact.previewUrl!, {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      if (!response.ok) throw new Error(`Preview request failed (${response.status})`);
      return response.text();
    },
    enabled: Boolean(artifact.previewUrl),
  });
  const label = artifactDisplayLabel(artifact);
  if (query.isLoading) return <Stack direction="row" spacing={1} role="status" sx={{ alignItems: "center", py: 3 }}><CircularProgress size={20} /><Typography variant="body2">Loading text preview…</Typography></Stack>;
  if (query.isError) return <Alert severity="error">Text preview is unavailable. Download the file to inspect it.</Alert>;
  if (query.data === "") return <Alert severity="info">This file is empty.</Alert>;
  return <Box
    component="pre"
    className="ponderosa-scroll"
    data-testid="artifact-text-preview"
    aria-label={`Text preview of ${label}`}
    tabIndex={0}
    sx={{
      width: "100%",
      minWidth: 0,
      maxHeight: "72dvh",
      minHeight: { xs: "45dvh", sm: "28rem" },
      m: 0,
      p: { xs: 1.25, sm: 2 },
      overflow: "auto",
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
      bgcolor: "background.paper",
      color: "text.primary",
      borderRadius: 1,
      fontSize: { xs: 12, sm: 13 },
      lineHeight: 1.55,
    }}
  >{query.data}</Box>;
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
  project,
  agents,
  healthByAgentId,
  onOpenArtifact,
  onOpenArtifactInNewTab,
  onOpenRun,
  onOpenAgentWork,
}: {
  projectId: string;
  project: ProjectDto;
  agents: AgentDto[];
  healthByAgentId: Map<string, AgentHealthDto>;
  onOpenArtifact(agentId: string, artifactId: string): void;
  onOpenArtifactInNewTab?(agentId: string, artifactId: string): void;
  onOpenRun(agentId: string, runId: string): void;
  onOpenAgentWork(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [previewArtifact, setPreviewArtifact] = useState<ArtifactDto>();
  const [olderArtifacts, setOlderArtifacts] = useState<{ items: ArtifactDto[]; cursor?: string; hasMore: boolean }>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [artifactMenu, setArtifactMenu] = useState<{ anchor: HTMLElement; agentId: string; artifactId: string }>();
  useEffect(() => {
    setOlderArtifacts(undefined);
    setPreviewArtifact(undefined);
  }, [projectId]);
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const projectArtifacts = useQuery({
    queryKey: ["project-artifacts", projectId],
    queryFn: () => api.listProjectArtifacts(projectId),
  });
  const updateArtifact = useMutation({
    mutationFn: ({ artifactId, pinned, visibility }: { artifactId: string; pinned?: boolean; visibility?: "project" | "published" }) =>
      api.updateProjectArtifact(projectId, artifactId, { ...(pinned !== undefined ? { pinned } : {}), ...(visibility ? { visibility } : {}) }),
    onSuccess: (artifact) => {
      setPreviewArtifact(artifact);
      void queryClient.invalidateQueries({ queryKey: ["project-artifacts", projectId] });
    },
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
      <ProjectOverview
        project={project}
        agents={agents}
        healthByAgentId={healthByAgentId}
        importantArtifacts={(projectArtifacts.data?.items ?? []).filter((artifact) => artifact.pinned || artifact.visibility === "published")}
        onOpenAgentWork={onOpenAgentWork}
        onOpenProjectFiles={() => document.getElementById("project-files-and-results")?.scrollIntoView({ behavior: "smooth", block: "start" })}
        onOpenImportantArtifact={(artifact) => {
          if (artifact.previewUrl) setPreviewArtifact(artifact);
          else {
            const owner = agents.find((agent) => agent.id === (artifact.originAgentId ?? artifact.agentId));
            if (owner) onOpenArtifact(owner.id, artifact.id);
            else document.getElementById("project-files-and-results")?.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        }}
      />
      <Box>
        <Typography id="project-files-and-results" variant="h5" component="h2" fontWeight={800} sx={{ scrollMarginTop: 16 }}>Files & results</Typography>
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
      >{loadingOlder ? "Loading…" : "Load Older Files"}</Button> : null}
      {loading && records.length === 0 ? <Stack direction="row" spacing={1} sx={{ alignItems: "center", py: 2 }}><CircularProgress size={18} /><Typography variant="body2" color="text.secondary">Loading project files…</Typography></Stack> : null}
      {projectArtifacts.isError ? <Alert severity="error">Project files could not be loaded. Try again.</Alert> : null}
      {!loading && records.length === 0 ? <Alert severity="info">No project files yet. Agent-created documents, images, downloads, and generated results will appear here.</Alert> : null}
      {records.length > 0 && filtered.length === 0 ? <Alert severity="info">No project files match “{filter.trim()}”.</Alert> : null}
      <List aria-label="Project files" disablePadding sx={{ display: "grid", gap: 0.75 }}>
        {filtered.map(({ agent, artifact }) => {
          const label = artifactDisplayLabel(artifact);
          const originAgentId = artifact.originAgentId ?? artifact.agentId;
          const owner = agent?.title ?? `Deleted Agent · ${originAgentId.slice(0, 8)}`;
          const canOpen = Boolean(artifact.previewUrl || agent);
          return <Box key={`${artifact.projectId ?? projectId}:${artifact.id}`} sx={{ display: "flex", alignItems: "center", minWidth: 0, borderRadius: 1.5, bgcolor: "background.paper", boxShadow: (theme) => `inset 0 0 0 1px ${theme.palette.divider}`, overflow: "hidden" }}>
            <ListItemButton
              aria-label={`Open ${label} from ${owner}`}
              disabled={!canOpen}
              onContextMenu={(event) => {
                if (!agent) return;
                event.preventDefault();
                setArtifactMenu({ anchor: event.currentTarget, agentId: agent.id, artifactId: artifact.id });
              }}
              onClick={() => {
                if (artifact.previewUrl) setPreviewArtifact(artifact);
                else if (agent) onOpenArtifact(agent.id, artifact.id);
              }}
              sx={{ minWidth: 0, px: 1.5 }}
            >
              <ListItemIcon sx={{ minWidth: 40 }}><Inventory2OutlinedIcon /></ListItemIcon>
              <ListItemText
                primary={label}
                secondary={`${owner}${artifact.executionId ? ` · Run ${artifact.executionId.slice(0, 8)}` : ""} · ${artifact.visibility === "published" ? "Published" : "Project"} · ${artifact.path}`}
                primaryTypographyProps={{ fontWeight: 750, noWrap: true }}
                secondaryTypographyProps={{ noWrap: true }}
              />
              <Stack direction="row" spacing={1} sx={{ ml: 1, alignItems: "center", flexShrink: 0, display: { xs: "none", lg: "flex" } }}>
                <Chip size="small" variant="outlined" label={artifact.kind.replaceAll("_", " ")} />
                {artifact.pinned ? <Chip size="small" color="primary" variant="outlined" label="Pinned" /> : null}
                <Typography variant="caption" color="text.secondary">{new Date(artifact.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</Typography>
              </Stack>
            </ListItemButton>
            {artifact.previewUrl ? <Button aria-label={`Preview ${label}`} onClick={() => setPreviewArtifact(artifact)} size="small" startIcon={<OpenInNewOutlinedIcon />} sx={{ display: { xs: "none", lg: "inline-flex" }, mr: .5, flexShrink: 0 }}>Preview</Button> : null}
            {artifact.downloadUrl ? <Button component="a" href={artifact.downloadUrl} download size="small" aria-label={`Download ${label}`} startIcon={<DownloadOutlinedIcon />} sx={{ minWidth: 44, minHeight: 44, mr: { xs: .5, sm: 1 }, px: { xs: .75, sm: 1 }, flexShrink: 0 }}><Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>Download</Box></Button> : null}
          </Box>;
        })}
      </List>
    </Stack>
    {artifactMenu ? <Menu anchorEl={artifactMenu.anchor} open onClose={() => setArtifactMenu(undefined)}><MenuItem disabled={!onOpenArtifactInNewTab} onClick={() => { onOpenArtifactInNewTab?.(artifactMenu.agentId, artifactMenu.artifactId); setArtifactMenu(undefined); }}>Open in New Ponderosa Tab</MenuItem></Menu> : null}
    <Dialog open={Boolean(previewArtifact)} onClose={() => setPreviewArtifact(undefined)} fullWidth maxWidth="lg">
      <DialogTitle>{previewArtifact ? artifactDisplayLabel(previewArtifact) : "File Preview"}</DialogTitle>
      <DialogContent sx={{ minWidth: 0, p: { xs: 1, sm: 2 }, bgcolor: "background.default", overflow: "auto" }}>
        {previewArtifact ? <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ mb: 1.25, alignItems: "center" }}>
          <Chip size="small" label={`Created by ${agents.find((agent) => agent.id === (previewArtifact.originAgentId ?? previewArtifact.agentId))?.title ?? "deleted Agent"}`} />
          {previewArtifact.executionId ? (() => {
            const originAgentId = previewArtifact.originAgentId ?? previewArtifact.agentId;
            const originAgent = agents.find((agent) => agent.id === originAgentId);
            return originAgent
              ? <Button size="small" aria-label={`Open originating Run ${previewArtifact.executionId}`} onClick={() => onOpenRun(originAgent.id, previewArtifact.executionId!)}>Generated from Run {previewArtifact.executionId.slice(0, 8)}</Button>
              : <Chip size="small" variant="outlined" label={`Run ${previewArtifact.executionId.slice(0, 8)} · originating Agent deleted`} />;
          })() : <Chip size="small" variant="outlined" label="No originating Run recorded" />}
          <Chip size="small" variant="outlined" label={previewArtifact.visibility === "published" ? "Published" : "Project Scope"} />
        </Stack> : null}
        {previewArtifact?.previewUrl ? previewArtifact.mediaType?.startsWith("image/") ? <Box
          component="img"
          data-testid="artifact-image-preview"
          src={previewArtifact.previewUrl}
          alt={artifactDisplayLabel(previewArtifact)}
          sx={{ display: "block", maxWidth: "100%", maxHeight: "72dvh", mx: "auto", objectFit: "contain", borderRadius: 1 }}
        /> : isTextArtifactPreview(previewArtifact.mediaType) ? <ArtifactTextPreview artifact={previewArtifact} /> : <Box
          component="iframe"
          data-testid="artifact-document-preview"
          src={previewArtifact.previewUrl}
          title={artifactDisplayLabel(previewArtifact)}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          sx={{ display: "block", width: "100%", height: "72dvh", border: 0, borderRadius: 1, bgcolor: "background.paper" }}
        /> : null}
      </DialogContent>
      <DialogActions sx={{ flexWrap: "wrap", gap: 0.5, px: { xs: 1, sm: 2 }, "& .MuiButton-root": { minHeight: { xs: 44, sm: 36 } } }}>
        {previewArtifact ? <Button disabled={updateArtifact.isPending} onClick={() => updateArtifact.mutate({ artifactId: previewArtifact.id, pinned: !previewArtifact.pinned })}>{previewArtifact.pinned ? "Unpin" : "Pin"}</Button> : null}
        {previewArtifact ? <Button disabled={updateArtifact.isPending} onClick={() => updateArtifact.mutate({ artifactId: previewArtifact.id, visibility: previewArtifact.visibility === "published" ? "project" : "published" })}>{previewArtifact.visibility === "published" ? "Make Project-Only" : "Publish"}</Button> : null}
        {previewArtifact?.downloadUrl ? <Button component="a" href={previewArtifact.downloadUrl} download startIcon={<DownloadOutlinedIcon />}>Download</Button> : null}
        <Button onClick={() => setPreviewArtifact(undefined)}>Close</Button>
      </DialogActions>
    </Dialog>
  </Box>;
}
