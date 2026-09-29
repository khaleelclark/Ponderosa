import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import RefreshIcon from "@mui/icons-material/Refresh";
import { Alert, Box, Button, Chip, CircularProgress, IconButton, Paper, Stack, Tooltip, Typography } from "@mui/material";
import type { ChangedFileDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { queryKeys } from "../../queryKeys";
import { presentedFileIdentity } from "../../projectPathPresentation";
import { LazySyntaxHighlightedCode } from "../LazySyntaxHighlightedCode";
import { UnifiedDiffViewer } from "../filePreview/FilePreview";
import { recordedPathDiff } from "../filePreview/artifactDiff";
import { languageForPath } from "../filePreview/fileTypes";
import { PrimaryHeaderActionsOutlet } from "../PrimaryHeaderActions";

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

export function recordedPreviewLabel(file: Pick<ChangedFileDto, "diffAvailable">): string {
  return file.diffAvailable ? "Text preview recorded" : "Metadata and provenance only";
}

export function WorkspaceReviewPane({ projectRoot, agentId, files: historyFiles, running, initialPath, executionId, backLabel = "Back to Agent", onBack }: {
  projectRoot: string;
  agentId: string;
  files: ChangedFileDto[];
  running: boolean;
  initialPath?: string;
  executionId?: string;
  backLabel?: string;
  onBack(): void;
}): JSX.Element {
  const [scope, setScope] = useState<"response" | "folder">(executionId ? "response" : "folder");
  useEffect(() => setScope(executionId ? "response" : "folder"), [executionId]);
  const response = useQuery({ queryKey: ["response-file-review", agentId, executionId], queryFn: () => api.getResponseFileReview(agentId, executionId!), enabled: Boolean(executionId), staleTime: Infinity });
  const files = scope === "response" ? response.data?.files ?? [] : historyFiles;
  const [showFiles, setShowFiles] = useState(false);
  const selectFile = (path: string) => { setSelectedPath(path); setShowFiles(false); };
  const workspace = useQuery({
    queryKey: queryKeys.workspaceChanges.agent(agentId),
    queryFn: () => api.getWorkspaceStatus(agentId),
    refetchInterval: scope === "response" ? false : running ? 1_500 : 10_000,
  });
  const provenance = new Map(files.map((file) => [file.path, file]));
  const changes = workspace.data?.changes ?? [];
  const [selectedPath, setSelectedPath] = useState<string | undefined>(initialPath);
  const [reviewMode, setReviewMode] = useState<"diff" | "file">("diff");
  const lastInitialPath = useRef(initialPath);
  const recordedMode = scope === "response" || workspace.data?.isGitRepository === false;
  const reviewEntries = recordedMode ? files : changes;
  const activePath = resolveWorkspaceReviewPath(reviewEntries, selectedPath, initialPath);
  const displayPath = (path: string) => presentedFileIdentity(projectRoot, path);
  const activeDisplayPath = activePath ? displayPath(activePath) : undefined;

  useEffect(() => {
    setSelectedPath((current) => {
      const initialChanged = lastInitialPath.current !== initialPath;
      lastInitialPath.current = initialPath;
      return resolveWorkspaceReviewPath(reviewEntries, initialChanged ? undefined : current, initialPath);
    });
  }, [initialPath, reviewEntries]);

  const review = useQuery({
    queryKey: queryKeys.workspaceFile.detail(agentId, activePath),
    queryFn: () => api.getWorkspaceFile(agentId, activePath ?? ""),
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
    enabled: Boolean(agentId && activePath && scope !== "response"),
    staleTime: Infinity,
  });
  const selectedProvenance = scope === "response" ? response.data?.files.find(file => file.path === activePath) : selectedProvenanceQuery.data ?? selectedProvenanceSummary;
  const recordedDiff = selectedProvenance && "diff" in selectedProvenance && typeof selectedProvenance.diff === "string"
    ? selectedProvenance.diff
    : undefined;
  const presentedRecordedDiff = recordedDiff && activeDisplayPath
    ? recordedPathDiff(recordedDiff, activeDisplayPath, selectedProvenance?.kind === "create")
    : undefined;
  const recordedTotals = recordedDiffTotals(recordedDiff);
  const presentedWorkspaceDiff = review.data?.diff && activeDisplayPath
    ? recordedPathDiff(review.data.diff, activeDisplayPath)
    : undefined;
  const displayedChangeCount = recordedMode ? files.length : changes.length;

  return <Box sx={{ display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", minHeight: 0, height: "100%" }} aria-label="Workspace changes">
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center", px: 1.5, py: 1, borderBottom: 1, borderColor: "divider" }}>
      <Tooltip title={backLabel}><IconButton aria-label={backLabel} size="small" onClick={onBack}><ArrowBackIcon /></IconButton></Tooltip>
      <Typography variant="overline" color="text.secondary">Review</Typography>
      {executionId ? <Stack direction="row" spacing={.5}><Button size="small" variant={scope === "response" ? "outlined" : "text"} onClick={() => setScope("response")}>This response</Button><Button size="small" variant={scope === "folder" ? "outlined" : "text"} onClick={() => setScope("folder")}>Working folder</Button></Stack> : <Typography variant="caption">{recordedMode ? "Agent change history" : "Working folder"}</Typography>}
      <Button size="small" sx={{ display: { xs: "inline-flex", lg: "none" } }} onClick={() => setShowFiles(value => !value)}>{showFiles ? "Selected file" : "Files"}</Button>
      {workspace.data ? <Chip
        size="small"
        color={workspace.data.workingCopy.mode === "separate_git" ? "primary" : "default"}
        label={workspace.data.workingCopy.mode === "separate_git" ? "Separate Git copy" : "Shared folder"}
      /> : null}
      {workspace.data?.branch ? <Chip size="small" label={workspace.data.branch} /> : null}
      {workspace.data?.head ? <Typography variant="caption" color="text.secondary">{workspace.data.head}</Typography> : null}
      <Chip size="small" label={`${displayedChangeCount} change${displayedChangeCount === 1 ? "" : "s"}`} color={displayedChangeCount ? "warning" : "default"} />
      <Box sx={{ flex: 1 }} />
      <PrimaryHeaderActionsOutlet />
      <Tooltip title="Refresh review"><IconButton aria-label="Refresh review" size="small" onClick={() => void (scope === "response" ? response.refetch() : workspace.refetch())}><RefreshIcon /></IconButton></Tooltip>
    </Stack>
    {scope === "response" && response.isLoading || scope === "folder" && workspace.isLoading ? <Box sx={{ p: 2 }}><CircularProgress size={22} /></Box>
      : scope === "response" && response.isError || scope === "folder" && workspace.isError ? <Alert severity="error" sx={{ m: 1.5 }}>Review could not be loaded. Refresh to try again.</Alert>
        : recordedMode ? <Box sx={{ minHeight: 0, overflow: "auto", p: 1.5 }}>
          <Alert severity="info" sx={{ mb: 1.5 }}>{scope === "response" ? "Recorded changes from this response, not the current working folder. Each preview shows the latest recorded change for that file in this response." : "Agent change history. This working folder is not a Git repository, so no Git diff is available."}</Alert>
          {scope === "response" && response.data?.truncated ? <Alert severity="info">Showing a bounded set of recorded changes; older changes in this response may be omitted.</Alert> : null}
          {files.length === 0 ? <Typography variant="body2" color="text.secondary">No recorded changed files for this agent.</Typography> : <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "minmax(240px, 34%) minmax(0, 1fr)" }, gap: 1.5 }}>
            <Stack spacing={0.75} sx={{ display: { xs: showFiles ? "flex" : "none", lg: "flex" }, maxHeight: { lg: "65vh" }, overflowY: "auto" }}>
              {files.map((file) => {
                const presentedFilePath = displayPath(file.path);
                return <Button
                key={`${file.path}:${file.lastSeq}`}
                aria-label={`Review ${presentedFilePath}`}
                title={presentedFilePath}
                variant="outlined"
                color="inherit"
                onClick={() => selectFile(file.path)}
                sx={{ justifyContent: "flex-start", textAlign: "left", textTransform: "none", bgcolor: file.path === activePath ? "action.selected" : undefined, color: "text.primary" }}
              >
                <Box sx={{ minWidth: 0, width: "100%" }}>
                  <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{presentedFilePath}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {file.kind} · {file.executionCount} run{file.executionCount === 1 ? "" : "s"} · {recordedPreviewLabel(file)}
                  </Typography>
                </Box>
              </Button>;
              })}
            </Stack>
            <Paper variant="outlined" sx={{ display: { xs: showFiles ? "none" : "block", lg: "block" }, minWidth: 0, p: 1.25, overflow: "auto" }}>
              <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ alignItems: "center", mb: 1 }}>
                <Typography variant="subtitle2" sx={{ flex: 1, overflowWrap: "anywhere" }}>{activeDisplayPath}</Typography>
                {recordedTotals ? <>
                  <Chip size="small" color="success" variant="outlined" label={`+${recordedTotals.additions}`} />
                  <Chip size="small" color="error" variant="outlined" label={`−${recordedTotals.deletions}`} />
                </> : null}
              </Stack>
              {selectedProvenanceQuery.isLoading ? <CircularProgress size={22} />
                : selectedProvenanceQuery.isError ? <Alert severity="error">Recorded change details could not be loaded. {String(selectedProvenanceQuery.error)}</Alert>
                  : presentedRecordedDiff ? <UnifiedDiffViewer diff={presentedRecordedDiff} />
                    : selectedProvenance?.diffAvailable
                      ? <Alert
                        severity="info"
                        action={<Button color="inherit" size="small" onClick={() => void selectedProvenanceQuery.refetch()}>Reload recorded preview</Button>}
                      >
                        The recorded text preview did not load in this review.
                      </Alert>
                      : <Alert severity="info">No text preview was recorded for this change. Its canonical path and execution provenance remain available.</Alert>}
            </Paper>
          </Box>}
        </Box>
          : changes.length === 0 ? <Alert severity="success" sx={{ m: 1.5 }}>Working folder clean. Recorded changes remain available in Files & Results and Technical details.</Alert>
            : <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "minmax(220px, 32%) minmax(0, 1fr)" }, minHeight: 0 }}>
              <Stack sx={{ display: { xs: showFiles ? "flex" : "none", lg: "flex" }, overflowY: "auto", borderRight: { lg: 1 }, borderBottom: { xs: 1, lg: 0 }, borderColor: "divider" }}>
                {changes.map((change) => {
                  const touched = provenance.get(change.path);
                  const presentedChangePath = displayPath(change.path);
                  return <Button
                    key={change.path}
                    aria-label={`Review ${presentedChangePath}`}
                    title={presentedChangePath}
                    onClick={() => selectFile(change.path)}
                    variant="text"
                    color="inherit"
                    sx={{ bgcolor: change.path === activePath ? "action.selected" : undefined, color: "text.primary", borderRadius: 0, justifyContent: "flex-start", textAlign: "left", px: 1.5, py: 1, minHeight: 48 }}
                  >
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center", width: "100%", minWidth: 0 }}>
                      <Chip size="small" label={change.kind} color={change.kind === "delete" ? "error" : change.kind === "create" ? "success" : "default"} />
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Typography variant="body2" noWrap>{presentedChangePath}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {[change.staged && "staged", change.unstaged && "unstaged", change.untracked && "untracked", touched && "this agent"].filter(Boolean).join(" · ")}
                        </Typography>
                      </Box>
                    </Stack>
                  </Button>;
                })}
              </Stack>
              <Box sx={{ display: { xs: showFiles ? "none" : "block", lg: "block" }, overflow: "auto", minWidth: 0, p: 1.5 }}>
                <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center", mb: 1 }}>
                  <Typography variant="subtitle2" sx={{ flex: 1, overflowWrap: "anywhere" }}>{activeDisplayPath}</Typography>
                  {selectedChange?.staged ? <Chip size="small" label="Staged" color="success" /> : null}
                  {selectedChange?.unstaged ? <Chip size="small" label="Unstaged" color="warning" /> : null}
                  {selectedChange?.untracked ? <Chip size="small" label="Untracked" color="info" /> : null}
                  {selectedProvenance ? <Chip size="small" label={`${selectedProvenance.executionCount} agent run${selectedProvenance.executionCount === 1 ? "" : "s"}`} /> : null}
                </Stack>
                <Stack direction="row" spacing={0.5} sx={{ mb: 1 }}>
                  <Button size="small" variant={reviewMode === "diff" ? "contained" : "outlined"} onClick={() => setReviewMode("diff")}>Diff</Button>
                  <Button size="small" variant={reviewMode === "file" ? "contained" : "outlined"} onClick={() => setReviewMode("file")}>Current File</Button>
                </Stack>
                {review.isLoading ? <CircularProgress size={22} />
                  : review.isError ? <Alert severity="error">Diff could not be loaded. {String(review.error)}</Alert>
                    : reviewMode === "file" ? (review.data?.content !== undefined
                      ? <Box>
                          <LazySyntaxHighlightedCode
                            language={languageForPath(review.data.path)}
                            themeMode="auto"
                            customStyle={{ margin: 0 }}
                            renderFallback={({ status, retry }) => <>
                              {status === "failed" ? <Stack
                                direction="row"
                                alignItems="center"
                                justifyContent="space-between"
                                spacing={1}
                                sx={{ px: 2, py: 0.75, borderBottom: 1, borderColor: "divider", color: "text.secondary" }}
                              >
                                <Typography variant="caption">Syntax highlighting unavailable. Plain file text is still readable.</Typography>
                                <Button size="small" color="inherit" onClick={retry}>Retry highlighting</Button>
                              </Stack> : null}
                              <Box component="pre" sx={{ m: 0, p: 2, overflow: "auto", whiteSpace: "pre", fontFamily: "monospace" }}>{review.data?.content ?? ""}</Box>
                            </>}
                          >
                            {review.data.content}
                          </LazySyntaxHighlightedCode>
                      </Box>
                      : <Alert severity="info">The current file cannot be displayed. It may be deleted, binary, or above the safe viewer limit.</Alert>)
                    : review.data?.diff && activeDisplayPath ? <>
                      {review.data.truncated ? <Alert severity="warning" sx={{ mb: 1 }}>This review is truncated to the safe viewer limit.</Alert> : null}
                      {presentedWorkspaceDiff
                        ? <>{review.data.stagedDiff ? <Box component="section" aria-label="Staged changes"><Typography variant="subtitle2">Staged · HEAD → index</Typography><UnifiedDiffViewer diff={review.data.stagedDiff} /></Box> : null}
                          {review.data.unstagedDiff ? <Box component="section" aria-label="Unstaged changes"><Typography variant="subtitle2">Unstaged · index → working folder</Typography><UnifiedDiffViewer diff={review.data.unstagedDiff} /></Box> : null}</>
                        : <Alert severity="info">Git has no safe line-oriented diff for this change. It may be binary or metadata-only.</Alert>}
                    </> : <Alert severity="info">Git has no textual diff for this change. It may be binary or metadata-only.</Alert>}
              </Box>
            </Box>}
  </Box>;
}
