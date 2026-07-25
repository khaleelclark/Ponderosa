import CheckIcon from "@mui/icons-material/Check";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { Alert, Box, Button, Chip, CircularProgress, Divider, IconButton, Paper, Stack, Tooltip, Typography } from "@mui/material";
import type { AgentActivityDto, AgentActivityOutputDto, AgentRunDto, ResponseFileActivityDto, RunOutputDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../api";
import { copyText } from "../../clipboard";
import type { ExecutionItem } from "../../hooks/useAgentStream";
import { queryKeys } from "../../queryKeys";
import { telemetryElementId } from "../../telemetryFocus";
import { ResourceContextMenu } from "../ResourceContextMenu";
import type { ResourceContextMenuState } from "../ResourceContextMenu";
import { ChatMessageBody } from "../chat/ChatMessages";
import { isChatNearBottom, ScrollToLatestButton, scrollChatToBottom } from "../chat/scroll";

function EventLine({ item }: { item: ExecutionItem }): JSX.Element {
  const { event } = item;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  let title: string = event.type;
  let body = "";

  if (event.type === "command") {
    const internalCommunication = /PONDEROSA_(?:AGENT_MESSAGE|AGENT_SPAWN)|\/api\/agent-(?:messages|spawns)/u.test(event.command);
    title = internalCommunication ? "Ponderosa communication" : "Command";
    body = internalCommunication
      ? "Sent a structured Ponderosa communication or managed-agent event."
      : summarizeActivityText(event.command, 320);
  } else if (event.type === "file_change") {
    title = `File ${event.kind}`;
    body = event.path;
  } else if (event.type === "test_result") {
    title = event.passed ? "Tests passed" : "Tests failed";
    body = event.summary;
  } else if (event.type === "tool_call") {
    title = `Tool ${event.name}`;
    body = summarizeActivityText(JSON.stringify(event.input), 320);
  } else if (event.type === "tool_result") {
    title = event.isError ? "Tool error" : "Tool result";
    body = summarizeActivityText(event.output, 600);
  } else if (event.type === "error") {
    title = "Error";
    body = event.message;
  } else if (event.type === "browser_session") {
    title = `Browser ${event.status}`;
    body = event.reason ?? event.url ?? `${event.controlOwner} control`;
  } else if (event.type === "browser_action") {
    title = `Browser · ${event.action}`;
    body = event.summary;
  } else if (event.type === "browser_console") {
    title = `Browser console · ${event.level}`;
    body = summarizeActivityText(event.text, 600);
  } else if (event.type === "browser_screenshot") {
    title = "Browser screenshot";
    body = `${event.path} · ${event.width}×${event.height}`;
  }

  const copyCommand = event.type === "command" ? async () => {
    try {
      await copyText(event.command);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    globalThis.setTimeout(() => setCopyState("idle"), 2_000);
  } : undefined;
  const copyLabel = copyState === "copied"
    ? "Command copied"
    : copyState === "failed" ? "Copy command failed" : "Copy command";

  return (
    <Box sx={{ borderLeft: 2, borderColor: "divider", pl: 1.25, py: 0.75 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Chip size="small" label={`#${item.seq}`} variant="outlined" />
        <Typography variant="subtitle2" sx={{ flex: 1 }}>{title}</Typography>
        {copyCommand ? <>
          <Tooltip title={copyLabel}>
            <IconButton
              size="small"
              color={copyState === "failed" ? "error" : "inherit"}
              aria-label="Copy command"
              onClick={(clickEvent) => {
                clickEvent.preventDefault();
                clickEvent.stopPropagation();
                void copyCommand();
              }}
            >{copyState === "copied" ? <CheckIcon fontSize="inherit" /> : <ContentCopyIcon fontSize="inherit" />}</IconButton>
          </Tooltip>
          <Box component="span" aria-live="polite" sx={{ position: "absolute", width: 1, height: 1, p: 0, m: -1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 }}>{copyState === "idle" ? "" : copyLabel}</Box>
        </> : null}
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, overflowWrap: "anywhere" }}>
        {body}
      </Typography>
    </Box>
  );
}

function summarizeActivityText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…` : normalized;
}

export function ResponseFileActivity({
  files,
  onOpenFile,
  onOpenFileInNewTab,
  onViewAll,
  projectId,
}: {
  files: ResponseFileActivityDto[];
  onOpenFile?(file: ResponseFileActivityDto): void;
  onOpenFileInNewTab?(file: ResponseFileActivityDto): void;
  onViewAll?(): void;
  projectId?: string;
}): JSX.Element | null {
  const [fileMenu, setFileMenu] = useState<ResourceContextMenuState<ResponseFileActivityDto>>();
  if (files.length === 0) return null;
  const additions = files.reduce((total, file) => total + (file.additions ?? 0), 0);
  const deletions = files.reduce((total, file) => total + (file.deletions ?? 0), 0);
  const hasLineTotals = files.some((file) => file.additions !== undefined || file.deletions !== undefined);
  const inProgress = files.some((file) => file.status === "in_progress");
  return <Box component="aside" aria-label="File activity" sx={{ mt: 1 }}>
    <Stack direction="row" spacing={0.75} sx={{ alignItems: "flex-start", minWidth: 0 }}>
      <Paper component="details" variant="outlined" data-testid="response-file-activity" sx={{ flex: 1, minWidth: 0, bgcolor: "action.hover", "& > summary": { cursor: "pointer", listStylePosition: "inside" } }}>
        <Box component="summary" sx={{ px: 1, py: 0.625 }}>
          <Stack component="span" direction="row" spacing={0.75} sx={{ display: "inline-flex", alignItems: "baseline", ml: 0.25 }}>
            <Typography component="span" variant="caption" sx={{ fontWeight: 700 }}>
              {files.length} changed file{files.length === 1 ? "" : "s"}
            </Typography>
            {hasLineTotals ? <>
              <Typography component="span" variant="caption" color="success.main">+{additions}</Typography>
              <Typography component="span" variant="caption" color="error.main">−{deletions}</Typography>
            </> : null}
            {inProgress ? <Typography component="span" variant="caption" color="info.main">Live</Typography> : null}
          </Stack>
        </Box>
        <Stack spacing={0.25} sx={{ px: 0.5, pb: 0.5 }}>
          {files.map((file) => {
            const generated = file.artifactKind === "generated_file" && file.artifactId && projectId;
            const root = generated ? `/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(file.artifactId!)}` : undefined;
            return <Stack
              key={`${file.sourceSeq}:${file.path}`}
              direction="row"
              onContextMenu={(event) => {
                if (!onOpenFileInNewTab) return;
                event.preventDefault();
                setFileMenu({ anchor: event.currentTarget, resource: file });
              }}
              sx={{ alignItems: "center", minWidth: 0 }}
            >
              <Button
                size="small"
                color="inherit"
                onClick={() => onOpenFile?.(file)}
                disabled={!onOpenFile}
                aria-label={file.previewable ? `Open focused diff for ${file.path}` : `Open file artifact for ${file.path}`}
                sx={{ display: "flex", flex: 1, minWidth: 0, justifyContent: "flex-start", textTransform: "none", minHeight: 30, px: 0.75, py: 0.25, textAlign: "left" }}
              >
                <Typography variant="caption" sx={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.path}</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ ml: 1, flexShrink: 0 }}>
                  {file.kind}{file.additions !== undefined || file.deletions !== undefined ? ` · +${file.additions ?? 0} −${file.deletions ?? 0}` : " · Files & Results"}
                </Typography>
                <OpenInNewIcon sx={{ ml: 0.5, fontSize: 14, flexShrink: 0 }} />
              </Button>
              {root ? <>
                <Button size="small" component="a" href={`${root}/preview`} target="_blank" rel="noreferrer" sx={{ minWidth: 0, px: .75 }}>Preview</Button>
                <Button size="small" component="a" href={`${root}/download`} download sx={{ minWidth: 0, px: .75 }}>Download</Button>
              </> : null}
            </Stack>;
          })}
        </Stack>
      </Paper>
      {onViewAll ? <Button size="small" color="inherit" onClick={onViewAll} sx={{ flexShrink: 0, minWidth: 0, px: 0.75 }}>Review All</Button> : null}
    </Stack>
    <ResourceContextMenu state={fileMenu} onClose={() => setFileMenu(undefined)} onOpenInNewTab={onOpenFileInNewTab} />
  </Box>;
}

/** Refresh-safe chronological projection of canonical execution events. */
type MergedActivityEntry =
  | { type: "activity"; id: string; seq: number; createdAt: string; executionId?: string; item: AgentActivityDto }
  | { type: "work"; id: string; seq: number; createdAt: string; executionId: string; item: RunOutputDto };

interface MergedActivityRun {
  key: string;
  executionId?: string;
  run?: AgentRunDto;
  entries: MergedActivityEntry[];
  firstAt: string;
  lastAt: string;
}

function mergeActivityByRun(activity: AgentActivityDto[], runOutput: RunOutputDto[], runs: AgentRunDto[], activeExecutionId?: string): MergedActivityRun[] {
  const runById = new Map(runs.map((run) => [run.id, run]));
  const groups = new Map<string, MergedActivityRun>();
  const entries: MergedActivityEntry[] = [
    ...activity.map((item): MergedActivityEntry => ({ type: "activity", id: `activity:${item.id}`, seq: item.seq, createdAt: item.createdAt, ...(item.executionId ? { executionId: item.executionId } : {}), item })),
    ...runOutput.map((item): MergedActivityEntry => ({ type: "work", id: `work:${item.id}`, seq: item.seq, createdAt: item.createdAt, executionId: item.executionId, item })),
  ].sort((a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const entry of entries) {
    const key = entry.executionId ?? "unscoped";
    const current = groups.get(key);
    if (current) {
      current.entries.push(entry);
      current.lastAt = entry.createdAt;
    } else {
      groups.set(key, {
        key,
        ...(entry.executionId ? { executionId: entry.executionId, run: runById.get(entry.executionId) } : {}),
        entries: [entry],
        firstAt: entry.createdAt,
        lastAt: entry.createdAt,
      });
    }
  }
  for (const run of runs) {
    if (!groups.has(run.id)) groups.set(run.id, {
      key: run.id,
      executionId: run.id,
      run,
      entries: [],
      firstAt: run.startedAt,
      lastAt: run.completedAt ?? run.startedAt,
    });
  }
  const currentId = activeExecutionId ?? [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.id
    ?? [...groups.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt))[0]?.executionId;
  return [...groups.values()].sort((a, b) => {
    if (a.executionId === currentId) return -1;
    if (b.executionId === currentId) return 1;
    return b.lastAt.localeCompare(a.lastAt) || b.key.localeCompare(a.key);
  });
}

function scrollActivityToCurrent(
  element: Pick<HTMLElement, "scrollTo">,
  target?: Pick<HTMLElement, "scrollIntoView">,
): void {
  if (target) target.scrollIntoView({ behavior: "smooth", block: "nearest" });
  else element.scrollTo({ top: 0, behavior: "smooth" });
}

function ActivityElapsed({ startedAt, completedAt }: { startedAt: string; completedAt?: string }): JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (completedAt) return;
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1_000);
    return () => globalThis.clearInterval(timer);
  }, [completedAt]);
  const milliseconds = Math.max(0, Date.parse(completedAt ?? new Date(now).toISOString()) - Date.parse(startedAt));
  const seconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return <>{hours ? `${hours}:` : ""}{String(minutes).padStart(hours ? 2 : 1, "0")}:{String(remainder).padStart(2, "0")}</>;
}

function WorkActivityLine({ entry, focusId, onOpenFile, onOpenFileInNewTab, onViewAll, projectId }: {
  entry: Extract<MergedActivityEntry, { type: "work" }>;
  focusId?: string;
  onOpenFile?(file: ResponseFileActivityDto): void;
  onOpenFileInNewTab?(file: ResponseFileActivityDto): void;
  onViewAll?(): void;
  projectId?: string;
}): JSX.Element {
  const item = entry.item;
  const long = item.text.length > 600 || item.text.split("\n").length > 12;
  return <Paper
    component="details"
    open={!long}
    key={entry.id}
    id={telemetryElementId("runOutput", item.id)}
    tabIndex={focusId === item.id ? -1 : undefined}
    variant="outlined"
    data-activity-kind={item.kind}
    sx={{ p: 0.75, "& > summary": { cursor: "pointer" } }}
  >
    <Stack component="summary" direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <Chip size="small" variant="outlined" color={item.kind === "reasoning" ? "secondary" : "primary"} label={item.kind === "reasoning" ? "Thinking" : item.completed ? "Response" : "Response · live"} />
      <Typography variant="body2" color="text.secondary" sx={{ flex: 1, overflowWrap: "anywhere" }}>{summarizeActivityText(item.text, 220)}</Typography>
      <Typography variant="caption" color="text.secondary">{new Date(item.createdAt).toLocaleTimeString()}</Typography>
    </Stack>
    <Typography component="div" variant="body2" sx={{ mt: 0.75, pl: 1.25, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.text}</Typography>
    {item.kind === "response" && item.fileActivity?.length
      ? <ResponseFileActivity files={item.fileActivity} onOpenFile={onOpenFile} onOpenFileInNewTab={onOpenFileInNewTab} onViewAll={onViewAll} projectId={projectId} />
      : null}
  </Paper>;
}

function ActivityRunBody({ group, focusId, onOpenFile, onOpenFileInNewTab, onViewAll, projectId }: {
  group: MergedActivityRun;
  focusId?: string;
  onOpenFile?(file: ResponseFileActivityDto): void;
  onOpenFileInNewTab?(file: ResponseFileActivityDto): void;
  onViewAll?(): void;
  projectId?: string;
}): JSX.Element {
  return <Stack spacing={0.5} sx={{ p: 0.75 }}>
    {group.entries.length === 0 ? <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 0.5 }}>No detailed events were recorded in the loaded window.</Typography> : null}
    {group.entries.map((entry) => entry.type === "work"
      ? <WorkActivityLine key={entry.id} entry={entry} focusId={focusId} onOpenFile={onOpenFile} onOpenFileInNewTab={onOpenFileInNewTab} onViewAll={onViewAll} projectId={projectId} />
      : <Paper component="details" key={entry.id} id={telemetryElementId("activity", entry.item.id)} tabIndex={focusId === entry.item.id ? -1 : undefined} variant="outlined" data-activity-kind={entry.item.event.type} sx={{ p: 0.75, "& > summary": { cursor: "pointer" } }}>
        <Box component="summary"><EventLine item={{ id: entry.item.id, seq: entry.item.seq, ts: entry.item.createdAt, event: entry.item.event }} /></Box>
        <Typography variant="caption" color="text.secondary" sx={{ pl: 1.25 }}>{new Date(entry.item.createdAt).toLocaleString()}</Typography>
        {entry.item.outputPreview ? <ExactActivityOutput item={entry.item} /> : null}
      </Paper>)}
  </Stack>;
}

/** Current-first, bounded, refresh-safe timeline combining Work Log and execution activity. */
export function ActivityPane({ activity, runOutput = [], runs = [], connected, running, activeExecutionId, focusId, onOpenFile, onOpenFileInNewTab, onViewAll, projectId }: {
  activity: AgentActivityDto[];
  runOutput?: RunOutputDto[];
  runs?: AgentRunDto[];
  connected: boolean;
  running: boolean;
  activeExecutionId?: string;
  focusId?: string;
  onOpenFile?(file: ResponseFileActivityDto): void;
  onOpenFileInNewTab?(file: ResponseFileActivityDto): void;
  onViewAll?(): void;
  projectId?: string;
}): JSX.Element {
  const groups = mergeActivityByRun(activity, runOutput, runs, activeExecutionId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const firstLayout = useRef(true);
  const followCurrent = useRef(true);
  const [showCurrent, setShowCurrent] = useState(false);
  const current = groups[0];
  const currentEntry = current?.entries.at(-1);
  const currentTargetId = currentEntry
    ? telemetryElementId(currentEntry.type === "activity" ? "activity" : "runOutput", currentEntry.item.id)
    : undefined;
  const layoutKey = current?.entries.at(-1)?.id ?? current?.key ?? "empty";
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || (!firstLayout.current && !followCurrent.current)) return;
    const target = currentTargetId ? document.getElementById(currentTargetId) : undefined;
    if (target) target.scrollIntoView({ block: "nearest" });
    else element.scrollTop = 0;
    firstLayout.current = false;
    setShowCurrent(false);
  }, [currentTargetId, layoutKey]);
  return <Box sx={{ position: "relative", minHeight: 0, height: "100%" }}>
  <Stack
    ref={scrollRef}
    spacing={1}
    className="ponderosa-scroll"
    data-testid="activity-scroll-region"
    tabIndex={0}
    onScroll={(event) => {
      const target = currentTargetId ? document.getElementById(currentTargetId) : undefined;
      const visible = target
        ? target.offsetTop >= event.currentTarget.scrollTop - 64
          && target.offsetTop + target.offsetHeight <= event.currentTarget.scrollTop + event.currentTarget.clientHeight + 64
        : event.currentTarget.scrollTop <= 64;
      followCurrent.current = visible;
      setShowCurrent(!visible);
    }}
    sx={{ p: 1.5, pb: 3, minHeight: 0, maxHeight: "100%", height: "100%", alignSelf: "stretch", overflowY: "auto", overflowX: "hidden", overscrollBehavior: "contain" }}
    aria-label="Agent activity"
  >
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <Typography variant="overline" color="text.secondary" sx={{ flex: 1 }}>Activity</Typography>
      <Chip size="small" label={connected ? "Live" : "Reconnecting"} color={connected ? "success" : "warning"} variant={connected ? "filled" : "outlined"} />
      {running ? <Chip size="small" color="info" label="Working" /> : null}
    </Stack>
    {groups.length === 0 ? <Alert severity="info">Thinking, responses, commands, tests, file changes, browser actions, and tool output will appear here.</Alert> : groups.map((group, index) => {
      const isCurrent = index === 0;
      const isActive = group.executionId !== undefined && group.executionId === activeExecutionId;
      const header = <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center", px: 1.25, py: 0.75, bgcolor: "action.hover", borderBottom: isCurrent ? 1 : 0, borderColor: "divider" }}>
        <Typography variant="subtitle2">{group.run?.title ?? (group.executionId ? `Run ${group.executionId.slice(0, 8)}` : "Unscoped activity")}</Typography>
        {isCurrent ? <Chip size="small" color={isActive ? "info" : "default"} label={isActive ? "Current · working" : "Current"} /> : null}
        <Typography variant="caption" color="text.secondary">{group.entries.length} event{group.entries.length === 1 ? "" : "s"}</Typography>
        {group.run ? <Typography variant="caption" color="text.secondary"><ActivityElapsed startedAt={group.run.startedAt} completedAt={group.run.completedAt} /></Typography> : <Typography variant="caption" color="text.secondary">{formatActivitySpan(group.firstAt, group.lastAt)}</Typography>}
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary">{new Date(group.firstAt).toLocaleString()}</Typography>
      </Stack>;
      return isCurrent ? <Paper key={group.key} variant="outlined" data-testid="activity-execution" data-current-run="true" data-execution-id={group.executionId} sx={{ overflow: "visible" }}>
        {header}
        <ActivityRunBody group={group} focusId={focusId} onOpenFile={onOpenFile} onOpenFileInNewTab={onOpenFileInNewTab} onViewAll={onViewAll} projectId={projectId} />
      </Paper> : <Paper component="details" open={group.entries.some((entry) => entry.item.id === focusId) || undefined} key={group.key} variant="outlined" data-testid="activity-execution" data-current-run="false" data-execution-id={group.executionId} sx={{ overflow: "visible", "& > summary": { cursor: "pointer", listStylePosition: "inside" } }}>
        <Box component="summary">{header}</Box>
        <ActivityRunBody group={group} focusId={focusId} onOpenFile={onOpenFile} onOpenFileInNewTab={onOpenFileInNewTab} onViewAll={onViewAll} projectId={projectId} />
      </Paper>;
    })}
  </Stack>
  <ScrollToLatestButton visible={showCurrent} label="Back to Current Work" onClick={() => {
    if (!scrollRef.current) return;
    followCurrent.current = true;
    const target = currentTargetId ? document.getElementById(currentTargetId) : undefined;
    scrollActivityToCurrent(scrollRef.current, target ?? undefined);
    setShowCurrent(false);
  }} />
  </Box>;
}

function ExactActivityOutput({ item }: { item: AgentActivityDto }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [additionalPages, setAdditionalPages] = useState<AgentActivityOutputDto[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const reference = item.outputPreview;
  const query = useQuery({
    queryKey: queryKeys.activityOutput.detail(
      item.agentId,
      item.seq,
      reference?.sha256,
    ),
    queryFn: () => api.getActivityOutput(reference!.retrievalUrl),
    enabled: open && Boolean(reference),
  });
  useEffect(() => {
    setAdditionalPages([]);
    setLoadMoreError(false);
  }, [item.agentId, item.seq, reference?.sha256]);
  if (!reference) return null;
  const pages = query.data ? [query.data, ...additionalPages] : [];
  const nextCursor = pages.at(-1)?.nextCursor;
  const loadedBytes = pages.reduce((sum, page) => sum + page.pageUtf8Bytes, 0);
  const output = pages.map((page) => page.output).join("");
  return <Box sx={{ pl: 1.25, pt: 0.5 }}>
    <Button size="small" color="inherit" onClick={() => setOpen((value) => !value)}>
      {open ? "Hide Full Output" : `Load Full Output (${reference.totalUtf8Bytes.toLocaleString()} bytes)`}
    </Button>
    {open ? <Paper variant="outlined" sx={{ mt: 0.5, p: 1, maxHeight: 420, overflow: "auto" }}>
      {query.isLoading ? <CircularProgress size={18} />
        : query.isError ? <Alert severity="error">The complete canonical tool output could not be loaded.</Alert>
          : <>
            <Typography component="pre" variant="caption" sx={{ m: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{output}</Typography>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", mt: 0.75 }}>
              <Typography variant="caption" color="text.secondary">
                Loaded {loadedBytes.toLocaleString()} of {reference.totalUtf8Bytes.toLocaleString()} bytes
              </Typography>
              {nextCursor ? <Button size="small" disabled={loadingMore} onClick={() => {
                setLoadingMore(true);
                setLoadMoreError(false);
                void api.getActivityOutput(reference.retrievalUrl, nextCursor)
                  .then((page) => setAdditionalPages((current) => [...current, page]))
                  .catch(() => setLoadMoreError(true))
                  .finally(() => setLoadingMore(false));
              }}>{loadingMore ? "Loading…" : "Load More"}</Button> : null}
            </Stack>
            {loadMoreError ? <Alert severity="error" sx={{ mt: 0.75 }}>The next output page could not be loaded.</Alert> : null}
          </>}
    </Paper> : null}
  </Box>;
}

function formatActivitySpan(firstAt: string, lastAt: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(lastAt) - Date.parse(firstAt)) / 1_000));
  if (seconds < 60) return seconds === 0 ? "single moment" : `${seconds}s activity span`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s activity span`;
}
