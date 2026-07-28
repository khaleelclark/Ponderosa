import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import RefreshIcon from "@mui/icons-material/Refresh";
import { Alert, Box, Button, Chip, CircularProgress, IconButton, Paper, Stack, Tooltip, Typography } from "@mui/material";
import type { ChangedFileDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { api } from "../../api";
import { queryKeys } from "../../queryKeys";
import { ResourceContextMenu } from "../ResourceContextMenu";
import type { ResourceContextMenuState } from "../ResourceContextMenu";
import { UnifiedDiffViewer } from "../filePreview/FilePreview";
import { languageForPath } from "../filePreview/fileTypes";

function resolveWorkspaceReviewPath(
  changes: ReadonlyArray<{ path: string }>,
  selectedPath?: string,
  initialPath?: string,
): string | undefined {
  if (selectedPath && changes.some((change) => change.path === selectedPath)) return selectedPath;
  if (initialPath && changes.some((change) => change.path === initialPath)) return initialPath;
  return changes[0]?.path;
}

function recordedDiffTotals(diff?: string): { additions: number; deletions: number } | undefined {
  if (!diff) return undefined;
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

export function WorkspaceReviewPane({ projectId, agentId, files, running, initialPath, onBack, onOpenInNewTab }: {
  projectId: string;
  agentId?: string;
  files: ChangedFileDto[];
  running: boolean;
  initialPath?: string;
  onBack(): void;
  onOpenInNewTab?(path: string): void;
}): JSX.Element {
  const workspace = useQuery({
    queryKey: queryKeys.workspaceChanges.project(projectId),
    queryFn: () => api.getWorkspaceStatus(projectId),
    refetchInterval: running ? 1_500 : 10_000,
  });
  const provenance = new Map(files.map((file) => [file.path, file]));
  const changes = workspace.data?.changes ?? [];
  const [selectedPath, setSelectedPath] = useState<string | undefined>(initialPath);
  const [reviewMode, setReviewMode] = useState<"diff" | "file">("diff");
  const [fileMenu, setFileMenu] = useState<ResourceContextMenuState<string>>();
  const lastInitialPath = useRef(initialPath);
  const recordedMode = workspace.data?.isGitRepository === false;
  const reviewEntries = recordedMode ? files : changes;
  const activePath = resolveWorkspaceReviewPath(reviewEntries, selectedPath, initialPath);

  useEffect(() => {
    setSelectedPath((current) => {
      const initialChanged = lastInitialPath.current !== initialPath;
      lastInitialPath.current = initialPath;
      return resolveWorkspaceReviewPath(reviewEntries, initialChanged ? undefined : current, initialPath);
    });
  }, [initialPath, reviewEntries]);

  const review = useQuery({
    queryKey: queryKeys.workspaceFile.detail(projectId, activePath),
    queryFn: () => api.getWorkspaceFile(projectId, activePath ?? ""),
    enabled: Boolean(activePath && !recordedMode),
    refetchInterval: running ? 1_500 : false,
  });
  const selectedChange = changes.find((change) => change.path === activePath);
  const selectedProvenanceSummary = activePath ? provenance.get(activePath) : undefined;
  const selectedProvenanceQuery = useQuery({
    queryKey: queryKeys.workspaceChanges.file(
      agentId,
      activePath,
      selectedProvenanceSummary?.lastSeq,
    ),
    queryFn: () => api.getChangedFileDetail(agentId!, activePath!),
    enabled: Boolean(agentId && activePath),
    staleTime: Infinity,
  });
  const selectedProvenance = selectedProvenanceQuery.data ?? selectedProvenanceSummary;
  const recordedDiff = selectedProvenance && "diff" in selectedProvenance && typeof selectedProvenance.diff === "string"
    ? selectedProvenance.diff
    : undefined;
  const recordedTotals = recordedDiffTotals(recordedDiff);
  const displayedChangeCount = recordedMode ? files.length : changes.length;

  return <Box data-testid="workspace-review" sx={{ display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", minHeight: 0, height: "100%" }} aria-label="Workspace changes">
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center", px: 1.5, py: 1, borderBottom: 1, borderColor: "divider" }}>
      <Tooltip title="Back to Agent"><IconButton aria-label="Back to Agent" size="small" onClick={onBack}><ArrowBackIcon /></IconButton></Tooltip>
      <Typography variant="overline" color="text.secondary">Review</Typography>
      {workspace.data?.branch ? <Chip size="small" label={workspace.data.branch} /> : null}
      {workspace.data?.head ? <Typography variant="caption" color="text.secondary">{workspace.data.head}</Typography> : null}
      <Chip size="small" label={`${displayedChangeCount} change${displayedChangeCount === 1 ? "" : "s"}`} color={displayedChangeCount ? "warning" : "default"} />
      <Box sx={{ flex: 1 }} />
      <Tooltip title="Refresh Workspace Changes"><IconButton aria-label="Refresh workspace changes" size="small" onClick={() => void workspace.refetch()}><RefreshIcon /></IconButton></Tooltip>
    </Stack>
    {workspace.isLoading ? <Box sx={{ p: 2 }}><CircularProgress size={22} /></Box>
      : workspace.isError ? <Alert severity="error" sx={{ m: 1.5 }}>Workspace status could not be loaded. {String(workspace.error)}</Alert>
        : recordedMode ? <Box sx={{ minHeight: 0, overflow: "auto", p: 1.5 }}>
          <Alert severity="info" sx={{ mb: 1.5 }}>Showing recorded agent file changes. This working folder is not a Git repository, so no Git diff is available.</Alert>
          {files.length === 0 ? <Typography variant="body2" color="text.secondary">No recorded changed files for this agent.</Typography> : <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "minmax(240px, 34%) minmax(0, 1fr)" }, gap: 1.5 }}>
            <Stack spacing={0.75}>
              {files.map((file) => <Button
                key={`${file.path}:${file.lastSeq}`}
                variant={file.path === activePath ? "contained" : "outlined"}
                color={file.path === activePath ? "primary" : "inherit"}
                onClick={() => setSelectedPath(file.path)}
                sx={{ justifyContent: "flex-start", textAlign: "left", textTransform: "none" }}
              >
                <Box sx={{ minWidth: 0, width: "100%" }}>
                  <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{file.path}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {file.kind} · {file.executionCount} run{file.executionCount === 1 ? "" : "s"}{file.diffAvailable ? " · preview available" : ""}
                  </Typography>
                </Box>
              </Button>)}
            </Stack>
            <Paper variant="outlined" sx={{ minWidth: 0, p: 1.25, overflow: "auto" }}>
              <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ alignItems: "center", mb: 1 }}>
                <Typography variant="subtitle2" sx={{ flex: 1, overflowWrap: "anywhere" }}>{activePath}</Typography>
                {recordedTotals ? <>
                  <Chip size="small" color="success" variant="outlined" label={`+${recordedTotals.additions}`} />
                  <Chip size="small" color="error" variant="outlined" label={`−${recordedTotals.deletions}`} />
                </> : null}
                {activePath && onOpenInNewTab ? <Button size="small" startIcon={<OpenInNewIcon />} onClick={() => onOpenInNewTab(activePath)}>Open in New Tab</Button> : null}
              </Stack>
              {selectedProvenanceQuery.isLoading ? <CircularProgress size={22} />
                : selectedProvenanceQuery.isError ? <Alert severity="error">Recorded change details could not be loaded. {String(selectedProvenanceQuery.error)}</Alert>
                  : recordedDiff ? <UnifiedDiffViewer diff={recordedDiff} />
                    : <Alert severity="info">This recorded change has no textual preview. The canonical path and execution provenance remain available.</Alert>}
            </Paper>
          </Box>}
        </Box>
          : changes.length === 0 ? <Alert severity="success" sx={{ m: 1.5 }}>Working tree clean. Files previously touched by this agent remain recorded in Activity and Artifacts.</Alert>
            : <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "minmax(220px, 32%) minmax(0, 1fr)" }, minHeight: 0 }}>
              <Stack sx={{ overflowY: "auto", borderRight: { lg: 1 }, borderBottom: { xs: 1, lg: 0 }, borderColor: "divider", maxHeight: { xs: 220, lg: "none" } }}>
                {changes.map((change) => {
                  const touched = provenance.get(change.path);
                  return <Button
                    key={change.path}
                    data-testid="workspace-change"
                    data-workspace-path={change.path}
                    onClick={() => setSelectedPath(change.path)}
                    onContextMenu={(event) => {
                      if (!onOpenInNewTab) return;
                      event.preventDefault();
                      setFileMenu({ anchor: event.currentTarget, resource: change.path });
                    }}
                    variant={change.path === activePath ? "contained" : "text"}
                    color={change.path === activePath ? "primary" : "inherit"}
                    sx={{ borderRadius: 0, justifyContent: "flex-start", textAlign: "left", px: 1.5, py: 1, minHeight: 48 }}
                  >
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center", width: "100%", minWidth: 0 }}>
                      <Chip size="small" label={change.kind} color={change.kind === "delete" ? "error" : change.kind === "create" ? "success" : "default"} />
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Typography variant="body2" noWrap>{change.path}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {[change.staged && "staged", change.unstaged && "unstaged", change.untracked && "untracked", touched && "this agent"].filter(Boolean).join(" · ")}
                        </Typography>
                      </Box>
                    </Stack>
                  </Button>;
                })}
              </Stack>
              <Box data-testid="workspace-diff" sx={{ overflow: "auto", minWidth: 0, p: 1.5 }}>
                <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center", mb: 1 }}>
                  <Typography variant="subtitle2" sx={{ flex: 1, overflowWrap: "anywhere" }}>{activePath}</Typography>
                  {selectedChange?.staged ? <Chip size="small" label="Staged" color="success" /> : null}
                  {selectedChange?.unstaged ? <Chip size="small" label="Unstaged" color="warning" /> : null}
                  {selectedChange?.untracked ? <Chip size="small" label="Untracked" color="info" /> : null}
                  {selectedProvenance ? <Chip size="small" label={`${selectedProvenance.executionCount} agent run${selectedProvenance.executionCount === 1 ? "" : "s"}`} /> : null}
                  {activePath && onOpenInNewTab ? <Button size="small" color="inherit" startIcon={<OpenInNewIcon />} onClick={() => onOpenInNewTab(activePath)}>Open in New Tab</Button> : null}
                </Stack>
                <Stack direction="row" spacing={0.5} sx={{ mb: 1 }}>
                  <Button size="small" variant={reviewMode === "diff" ? "contained" : "outlined"} onClick={() => setReviewMode("diff")}>Diff</Button>
                  <Button size="small" variant={reviewMode === "file" ? "contained" : "outlined"} onClick={() => setReviewMode("file")}>Current File</Button>
                </Stack>
                {review.isLoading ? <CircularProgress size={22} />
                  : review.isError ? <Alert severity="error">Diff could not be loaded. {String(review.error)}</Alert>
                    : reviewMode === "file" ? (review.data?.content !== undefined
                      ? <Box data-testid="workspace-file"><SyntaxHighlighter language={languageForPath(review.data.path)} style={oneLight} PreTag="div" customStyle={{ margin: 0 }}>{review.data.content}</SyntaxHighlighter></Box>
                      : <Alert severity="info">The current file cannot be displayed. It may be deleted, binary, or above the safe viewer limit.</Alert>)
                    : review.data?.diff ? <>
                      {review.data.truncated ? <Alert severity="warning" sx={{ mb: 1 }}>This review is truncated to the safe viewer limit.</Alert> : null}
                      <UnifiedDiffViewer diff={review.data.diff} />
                    </> : <Alert severity="info">Git has no textual diff for this change. It may be binary or metadata-only.</Alert>}
              </Box>
            </Box>}
    <ResourceContextMenu state={fileMenu} onClose={() => setFileMenu(undefined)} onOpenInNewTab={onOpenInNewTab} />
  </Box>;
}
