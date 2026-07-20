import CheckOutlinedIcon from "@mui/icons-material/CheckOutlined";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import ErrorOutlineOutlinedIcon from "@mui/icons-material/ErrorOutlineOutlined";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import SearchIcon from "@mui/icons-material/Search";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  InputAdornment,
  InputLabel,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type { SelectChangeEvent } from "@mui/material/Select";
import type { AgentDto, AgentHealthDto, ArtifactDto, ProjectDto } from "@ponderosa/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { copyText } from "../clipboard";
import { artifactDisplayLabel, UnifiedDiffViewer } from "./panes";
import { ProjectOverview } from "./ProjectOverview";

export function isTextArtifactPreview(mediaType: string | undefined): boolean {
  return Boolean(mediaType && mediaType !== "text/html" && (
    mediaType.startsWith("text/") || mediaType === "application/json"
  ));
}

export type ProjectFileCategory = "all" | "code" | "documents" | "data" | "images" | "archives" | "other";

export const PROJECT_FILE_CATEGORIES: Array<{ value: ProjectFileCategory; label: string }> = [
  { value: "all", label: "All" },
  { value: "code", label: "Code" },
  { value: "documents", label: "Documents" },
  { value: "data", label: "Data & Config" },
  { value: "images", label: "Images" },
  { value: "archives", label: "Archives" },
  { value: "other", label: "Other" },
];

const FILE_CATEGORY_EXTENSIONS: Record<Exclude<ProjectFileCategory, "all" | "other">, ReadonlySet<string>> = {
  code: new Set(["c", "cc", "cpp", "css", "go", "h", "hpp", "html", "java", "js", "jsx", "kt", "php", "py", "rb", "rs", "scss", "sh", "swift", "ts", "tsx", "vue"]),
  documents: new Set(["doc", "docx", "md", "mdx", "pdf", "ppt", "pptx", "rtf", "txt", "xls", "xlsx"]),
  data: new Set(["csv", "graphql", "ini", "json", "jsonl", "sql", "toml", "tsv", "xml", "yaml", "yml"]),
  images: new Set(["avif", "gif", "jpeg", "jpg", "png", "svg", "webp"]),
  archives: new Set(["7z", "bz2", "gz", "rar", "tar", "tgz", "xz", "zip"]),
};

function extensionForArtifact(artifact: ArtifactDto): string {
  const path = artifact.sourcePath ?? artifact.path;
  const name = path.split(/[\\/]/u).at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLocaleLowerCase() : "";
}

export function projectFileCategory(artifact: ArtifactDto): Exclude<ProjectFileCategory, "all"> {
  const extension = extensionForArtifact(artifact);
  for (const [category, extensions] of Object.entries(FILE_CATEGORY_EXTENSIONS) as Array<[Exclude<ProjectFileCategory, "all" | "other">, ReadonlySet<string>]>) {
    if (extensions.has(extension)) return category;
  }
  return "other";
}

export function matchesProjectFileCategories(
  artifact: ArtifactDto,
  selected: readonly Exclude<ProjectFileCategory, "all">[],
): boolean {
  return selected.length === 0 || selected.includes(projectFileCategory(artifact));
}

export function createdFileUnifiedDiff(path: string, content: string): string {
  const normalized = content.replace(/\r\n?/gu, "\n");
  const lines = normalized === "" ? [] : normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

export function recordedArtifactDiff(artifact: ArtifactDto, content: string): string | undefined {
  const normalized = content.replace(/\r\n?/gu, "\n");
  const hasDiffStructure = /^(?:diff --git |@@ |--- |\+\+\+ )/mu.test(normalized)
    && /^(?:\+(?!\+\+)|-(?!--))/mu.test(normalized);
  if (hasDiffStructure) return normalized;
  if (/^create\s+/iu.test(artifact.summary?.trim() ?? "") && !/No diff text was provided by the engine\./iu.test(normalized)) {
    return createdFileUnifiedDiff(artifact.sourcePath ?? artifact.summary!.trim().replace(/^create\s+/iu, ""), normalized);
  }
  return undefined;
}

function ArtifactTextDiffPreview({ artifact }: { artifact: ArtifactDto }): JSX.Element {
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
  const diff = createdFileUnifiedDiff(artifact.sourcePath ?? artifact.path, query.data ?? "");
  return <Box data-testid="artifact-text-diff-preview" aria-label={`Created-file diff for ${label}`} sx={{ minWidth: 0 }}>
    <UnifiedDiffViewer diff={diff} />
  </Box>;
}

function RecordedDiffPreview({ artifact, agent }: { artifact: ArtifactDto; agent?: AgentDto }): JSX.Element {
  const query = useQuery({
    queryKey: ["project-recorded-diff", artifact.id, agent?.id],
    queryFn: () => api.getArtifact(agent!.id, artifact.id),
    enabled: Boolean(agent),
  });
  if (!agent) return <Alert severity="info">The originating Agent was deleted, so this durable diff cannot be retrieved from its bounded artifact route.</Alert>;
  if (query.isLoading) return <Stack direction="row" spacing={1} role="status" sx={{ alignItems: "center", py: 3 }}><CircularProgress size={20} /><Typography variant="body2">Loading recorded diff…</Typography></Stack>;
  if (query.isError || !query.data) return <Alert severity="error">The durable recorded diff is unavailable. Ponderosa will not substitute current working-tree content for historical Agent work.</Alert>;
  const diff = recordedArtifactDiff(artifact, query.data.content);
  if (!diff) return <Alert severity="info">This canonical file-change record does not contain a line-oriented diff. Ponderosa will not present raw text or the current working tree as historical changes.</Alert>;
  return <Box data-testid="project-recorded-diff" sx={{ minWidth: 0 }}><UnifiedDiffViewer diff={diff} /></Box>;
}

function CommandCopyAction({ command }: { command: string }): JSX.Element {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const feedback = state === "copied" ? "Command copied" : state === "failed" ? "Copy command failed" : "Copy command";
  return <>
    <Tooltip title={feedback}>
      <IconButton
        size="small"
        color={state === "failed" ? "error" : "inherit"}
        aria-label="Copy command"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void copyText(command).then(() => setState("copied"), () => setState("failed"));
        }}
        sx={{ minWidth: 44, minHeight: 44, flexShrink: 0 }}
      >{state === "copied" ? <CheckOutlinedIcon fontSize="small" /> : state === "failed" ? <ErrorOutlineOutlinedIcon fontSize="small" /> : <ContentCopyOutlinedIcon fontSize="small" />}</IconButton>
    </Tooltip>
    <Box component="span" aria-live="polite" sx={{ position: "absolute", width: 1, height: 1, p: 0, m: -1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 }}>{state === "idle" ? "" : feedback}</Box>
  </>;
}

const projectOutputKinds = new Set<ArtifactDto["kind"]>([
  "diff",
  "test_report",
  "pr_summary",
  "document",
  "screenshot",
  "generated_file",
  "log",
]);

export function projectArtifactGroup(kind: ArtifactDto["kind"]): "Modified & Created Files" | "Results" | "Commands" | undefined {
  if (["diff", "document", "screenshot", "generated_file"].includes(kind)) return "Modified & Created Files";
  if (["test_report", "pr_summary"].includes(kind)) return "Results";
  if (kind === "log") return "Commands";
  return undefined;
}

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
  const [fileCategories, setFileCategories] = useState<Array<Exclude<ProjectFileCategory, "all">>>([]);
  const [previewArtifact, setPreviewArtifact] = useState<ArtifactDto>();
  const [olderArtifacts, setOlderArtifacts] = useState<{ items: ArtifactDto[]; cursor?: string; hasMore: boolean }>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [artifactMenu, setArtifactMenu] = useState<{ anchor: HTMLElement; agentId: string; artifactId: string }>();
  useEffect(() => {
    setOlderArtifacts(undefined);
    setPreviewArtifact(undefined);
    setFileCategories([]);
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
  const filtered = useMemo(() => records.filter(({ agent, artifact }) => {
    if (projectArtifactGroup(artifact.kind) === "Modified & Created Files" && !matchesProjectFileCategories(artifact, fileCategories)) return false;
    return !normalizedFilter || [
      agent?.title,
      artifactDisplayLabel(artifact),
      artifact.path,
      artifact.sourcePath,
      artifact.summary,
      artifact.kind,
    ].filter(Boolean).join(" ").toLocaleLowerCase().includes(normalizedFilter);
  }), [fileCategories, records, normalizedFilter]);
  const fileCategoryOptions = useMemo(() => {
    const counts = new Map<ProjectFileCategory, number>(PROJECT_FILE_CATEGORIES.map(({ value }) => [value, 0]));
    const files = records.filter(({ artifact }) => projectArtifactGroup(artifact.kind) === "Modified & Created Files");
    counts.set("all", files.length);
    files.forEach(({ artifact }) => {
      const category = projectFileCategory(artifact);
      counts.set(category, (counts.get(category) ?? 0) + 1);
    });
    return PROJECT_FILE_CATEGORIES.map((option) => ({ ...option, count: counts.get(option.value) ?? 0 }));
  }, [records]);
  const grouped = (["Modified & Created Files", "Results", "Commands"] as const).map((label) => ({
    label,
    records: filtered.filter(({ artifact }) => projectArtifactGroup(artifact.kind) === label),
  })).filter((group) => group.records.length > 0);
  const loading = projectArtifacts.isLoading;

  return <Box className="ponderosa-scroll" sx={{ minHeight: 0, minWidth: 0, width: "100%", overflowY: "auto", p: { xs: 1.5, sm: 3 } }}>
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
        <Typography id="project-files-and-results" variant="h5" component="h2" fontWeight={800} sx={{ scrollMarginTop: 16 }}>Files &amp; Results</Typography>
        <Typography variant="body2" color="text.secondary">Modified and created files, documents, images, downloads, and results across this Project.</Typography>
      </Box>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "center" } }}>
        <TextField
          size="small"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Search files, results, or agents"
          inputProps={{ "aria-label": "Search project files" }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
          sx={{ width: { xs: "100%", sm: 420 } }}
        />
        <FormControl size="small" sx={{ minWidth: 180, width: { xs: "100%", sm: "auto" } }}>
          <InputLabel id="project-file-category-label">File Types</InputLabel>
          <Select
            labelId="project-file-category-label"
            label="File Types"
            multiple
            value={fileCategories}
            onChange={(event: SelectChangeEvent<Array<Exclude<ProjectFileCategory, "all">>>) => {
              const value = event.target.value;
              setFileCategories(typeof value === "string"
                ? value.split(",") as Array<Exclude<ProjectFileCategory, "all">>
                : value);
            }}
            inputProps={{ "aria-label": "Filter project files by type" }}
            sx={{ minHeight: { xs: 44, sm: 40 } }}
            renderValue={(values) => {
              if (values.length === 0) return `All (${fileCategoryOptions.find((option) => option.value === "all")?.count ?? 0})`;
              if (values.length <= 2) return values.map((value) => fileCategoryOptions.find((candidate) => candidate.value === value)?.label ?? value).join(", ");
              return `${values.length} File Types`;
            }}
          >
            {fileCategoryOptions.filter((option) => option.value !== "all").map((option) => <MenuItem key={option.value} value={option.value}>
              <Checkbox checked={fileCategories.includes(option.value as Exclude<ProjectFileCategory, "all">)} />
              {option.label} ({option.count})
            </MenuItem>)}
          </Select>
        </FormControl>
      </Stack>
      <Typography variant="caption" color="text.secondary">{filtered.length === records.length ? `${records.length} project items` : `${filtered.length} of ${records.length} project items`}</Typography>
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
      {records.length > 0 && filtered.length === 0 ? <Alert severity="info">No project files match the active search and file-type filters.</Alert> : null}
      <Box aria-label="Project files and results" sx={{ display: "grid", gap: 1.25 }}>
        {grouped.map((group) => <Box key={group.label} component="section" aria-label={group.label}>
          <Typography variant="overline" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>{group.label}</Typography>
          <List aria-label={`${group.label} items`} disablePadding sx={{ display: "grid", gap: 0.75 }}>
        {group.records.map(({ agent, artifact }) => {
          const label = artifactDisplayLabel(artifact);
          const originAgentId = artifact.originAgentId ?? artifact.agentId;
          const owner = agent?.title ?? `Deleted Agent · ${originAgentId.slice(0, 8)}`;
          const canOpen = Boolean(artifact.previewUrl || agent || artifact.kind === "diff");
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
                if (artifact.previewUrl || artifact.kind === "diff") setPreviewArtifact(artifact);
                else if (agent) onOpenArtifact(agent.id, artifact.id);
              }}
              sx={{ minWidth: 0, px: 1.5 }}
            >
              <ListItemIcon sx={{ minWidth: 40 }}><Inventory2OutlinedIcon /></ListItemIcon>
              <ListItemText
                primary={label}
                secondary={`${owner}${artifact.executionId ? ` · Run ${artifact.executionId.slice(0, 8)}` : ""} · ${artifact.visibility === "published" ? "Published" : "Project"} · ${artifact.sourcePath ?? artifact.path}`}
                primaryTypographyProps={{ fontWeight: 750, noWrap: true }}
                secondaryTypographyProps={{ noWrap: true }}
              />
              <Stack direction="row" spacing={1} sx={{ ml: 1, alignItems: "center", flexShrink: 0, display: { xs: "none", lg: "flex" } }}>
                <Chip size="small" variant="outlined" label={artifact.kind.replaceAll("_", " ")} />
                {artifact.pinned ? <Chip size="small" color="primary" variant="outlined" label="Pinned" /> : null}
                <Typography variant="caption" color="text.secondary">{new Date(artifact.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</Typography>
              </Stack>
            </ListItemButton>
            {artifact.kind === "log" && artifact.summary ? <CommandCopyAction command={artifact.summary} /> : null}
            {artifact.kind === "diff" ? <Button aria-label={`Preview ${label}`} onClick={() => setPreviewArtifact(artifact)} size="small" sx={{ display: { xs: "none", lg: "inline-flex" }, mr: .5, flexShrink: 0 }}>View Diff</Button> : null}
            {artifact.previewUrl ? <Button aria-label={`Preview ${label}`} onClick={() => setPreviewArtifact(artifact)} size="small" startIcon={<OpenInNewOutlinedIcon />} sx={{ display: { xs: "none", lg: "inline-flex" }, mr: .5, flexShrink: 0 }}>Preview</Button> : null}
            {artifact.downloadUrl ? <Button component="a" href={artifact.downloadUrl} download size="small" aria-label={`Download ${label}`} startIcon={<DownloadOutlinedIcon />} sx={{ minWidth: 44, minHeight: 44, mr: { xs: .5, sm: 1 }, px: { xs: .75, sm: 1 }, flexShrink: 0 }}><Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>Download</Box></Button> : null}
          </Box>;
        })}
          </List>
        </Box>)}
      </Box>
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
        {previewArtifact?.kind === "diff" ? <RecordedDiffPreview
          key={previewArtifact.id}
          artifact={previewArtifact}
          agent={agents.find((candidate) => candidate.id === (previewArtifact.originAgentId ?? previewArtifact.agentId))}
        /> : previewArtifact?.previewUrl ? previewArtifact.mediaType?.startsWith("image/") ? <Box
          component="img"
          data-testid="artifact-image-preview"
          src={previewArtifact.previewUrl}
          alt={artifactDisplayLabel(previewArtifact)}
          sx={{ display: "block", maxWidth: "100%", maxHeight: "72dvh", mx: "auto", objectFit: "contain", borderRadius: 1 }}
        /> : isTextArtifactPreview(previewArtifact.mediaType) ? <ArtifactTextDiffPreview key={previewArtifact.id} artifact={previewArtifact} /> : <Box
          component="iframe"
          data-testid="artifact-document-preview"
          src={previewArtifact.previewUrl}
          title={artifactDisplayLabel(previewArtifact)}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          sx={{ display: "block", width: "100%", height: "72dvh", border: 0, borderRadius: 1, bgcolor: "background.paper" }}
        /> : previewArtifact ? <Alert severity="info">This file has no safe inline preview. Download it or open its originating Agent record when available.</Alert> : null}
      </DialogContent>
      <DialogActions sx={{ flexWrap: "wrap", gap: 0.5, px: { xs: 1, sm: 2 }, "& .MuiButton-root": { minHeight: { xs: 44, sm: 36 } } }}>
        {previewArtifact ? (() => {
          const owner = agents.find((agent) => agent.id === (previewArtifact.originAgentId ?? previewArtifact.agentId));
          return owner ? <Button onClick={() => onOpenArtifact(owner.id, previewArtifact.id)}>Open Agent Record</Button> : null;
        })() : null}
        {previewArtifact?.visibility ? <Button disabled={updateArtifact.isPending} onClick={() => updateArtifact.mutate({ artifactId: previewArtifact.id, pinned: !previewArtifact.pinned })}>{previewArtifact.pinned ? "Unpin" : "Pin"}</Button> : null}
        {previewArtifact?.visibility ? <Button disabled={updateArtifact.isPending} onClick={() => updateArtifact.mutate({ artifactId: previewArtifact.id, visibility: previewArtifact.visibility === "published" ? "project" : "published" })}>{previewArtifact.visibility === "published" ? "Make Project-Only" : "Publish"}</Button> : null}
        {previewArtifact?.downloadUrl ? <Button component="a" href={previewArtifact.downloadUrl} download startIcon={<DownloadOutlinedIcon />}>Download</Button> : null}
        <Button onClick={() => setPreviewArtifact(undefined)}>Close</Button>
      </DialogActions>
    </Dialog>
  </Box>;
}
