import CheckIcon from "@mui/icons-material/Check";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { Alert, Box, Button, Chip, CircularProgress, Divider, IconButton, Paper, Stack, Tooltip, Typography } from "@mui/material";
import type { AgentActivityDto, AgentActivityOutputDto, AgentCoordinationV3Dto, AgentRunDto, ProviderInputDto, ResponseFileActivityDto, RunOutputDto, WorkItemDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../api";
import { copyText } from "../../clipboard";
import type { ExecutionItem } from "../../hooks/useAgentStream";
import { telemetryElementId } from "../../telemetryFocus";
import { ResourceContextMenu } from "../ResourceContextMenu";
import type { ResourceContextMenuState } from "../ResourceContextMenu";
import { ChatMessageBody } from "../chat/ChatMessages";
import { isChatNearBottom, ScrollToLatestButton, scrollChatToBottom } from "../chat/scroll";

export function workItemStatusLabel(status: WorkItemDto["status"]): string {
  if (status === "waiting_approval") {
    return "Waiting";
  }
  return status[0] ? `${status[0].toUpperCase()}${status.slice(1)}` : status;
}

export function workItemStatusColor(status: WorkItemDto["status"]): "success" | "warning" | "info" {
  if (status === "done") {
    return "success";
  }
  if (status === "waiting_approval") {
    return "warning";
  }
  return "info";
}

function runStatusColor(status: AgentRunDto["status"]): "success" | "warning" | "info" | "error" | "default" {
  if (status === "completed") return "success";
  if (status === "running" || status === "compacting") return "info";
  if (status === "waiting") return "warning";
  if (["failed", "interrupted", "blocked", "stalled"].includes(status)) return "error";
  return "default";
}

function runStatusLabel(status: AgentRunDto["status"]): string {
  return status[0] ? `${status[0].toUpperCase()}${status.slice(1)}` : status;
}

function wakeCauseLabel(cause: NonNullable<AgentRunDto["wakeCause"]>): string {
  switch (cause) {
    case "project_request": return "Project request";
    case "direct_message": return "Direct message";
    case "collaboration": return "Collaboration";
    case "trigger": return "Trigger";
    case "decision": return "Decision response";
    case "managed_failure": return "Managed-agent failure";
  }
}

function runCauseSentence(cause: NonNullable<AgentRunDto["wakeCause"]>): string {
  switch (cause) {
    case "project_request": return "Started because the Project received a new request";
    case "direct_message": return "Started because a direct message arrived";
    case "collaboration": return "Started because coordinated work produced a new result or message";
    case "trigger": return "Started because a Trigger fired";
    case "decision": return "Started because your Decision response arrived";
    case "managed_failure": return "Started because a managed Agent failed";
  }
}

export function EventLine({ item }: { item: ExecutionItem }): JSX.Element {
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

export function summarizeActivityText(value: string, maxLength: number): string {
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

export function RunsPane({
  runs,
  coordinationV3,
  workItems,
  timeline,
  focus,
  onOpenAgentWork,
}: {
  runs: AgentRunDto[];
  coordinationV3?: AgentCoordinationV3Dto;
  workItems: WorkItemDto[];
  timeline: ExecutionItem[];
  focus?: { stream: "runs" | "workItems"; id: string };
  onOpenAgentWork?(runId?: string): void;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const firstLayout = useRef(true);
  const followLatest = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const layoutKey = runs.at(-1)?.id ?? workItems.at(-1)?.id ?? "empty";
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || (!firstLayout.current && !followLatest.current)) return;
    scrollChatToBottom(element);
    firstLayout.current = false;
    setShowLatest(false);
  }, [layoutKey]);
  return (
    <Box sx={{ position: "relative", minHeight: 0, height: "100%" }}>
    <Stack
      ref={scrollRef}
      spacing={1}
      className="ponderosa-scroll"
      onScroll={(event) => {
        followLatest.current = isChatNearBottom(event.currentTarget);
        setShowLatest(!followLatest.current);
      }}
      sx={{ p: 1.5, pb: 3, minHeight: 0, height: "100%", overflowY: "auto", overscrollBehavior: "contain" }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
        <Typography variant="overline" color="text.secondary" sx={{ flex: 1 }}>
          Runs
        </Typography>
        {runs.length > 0 ? (
          <Typography variant="caption" color="text.secondary">
            {runs.length}
          </Typography>
        ) : null}
      </Stack>
      {coordinationV3 ? (
        <Alert severity={coordinationV3.requests.some((request) => request.state === "outcome_unknown") ? "warning" : coordinationV3.availability === "waiting" ? "info" : "success"}>
          <Typography variant="subtitle2">{coordinationV3.availability === "waiting" ? "Waiting for coordinated work" : coordinationV3.availability === "idle" ? "No coordinated work is active" : "Coordinated work is active"}</Typography>
          {coordinationV3.joins.some((join) => join.state === "open")
            ? `Waiting for ${coordinationV3.joins.filter((join) => join.state === "open").length} dependent result(s). `
            : ""}
          {coordinationV3.requests.some((request) => !["completed", "blocked", "failed", "cancelled", "superseded", "recipient_unavailable", "outcome_unknown", "expired"].includes(request.state))
            ? `${coordinationV3.requests.filter((request) => !["completed", "blocked", "failed", "cancelled", "superseded", "recipient_unavailable", "outcome_unknown", "expired"].includes(request.state)).length} assignment(s) are still active. `
            : ""}
          Technical evidence is read-only. Current issues and any operator decisions remain available in Chat.
        </Alert>
      ) : null}
      {runs.length === 0 ? (
        <Alert severity="info">No runs yet.</Alert>
      ) : (
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            gap: 1.25,
            pr: 0.5,
          }}
        >
          {runs.map((run) => (
            <Paper key={run.id} id={telemetryElementId("runs", run.id)} tabIndex={focus?.stream === "runs" && focus.id === run.id ? -1 : undefined} variant="outlined" sx={{ p: 1.25 }} data-execution-id={run.id}>
              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 0 }} noWrap>
                  {run.title}
                </Typography>
                <Chip
                  size="small"
                  label={runStatusLabel(run.status)}
                  color={runStatusColor(run.status)}
                />
              </Stack>
              <Typography variant="caption" color="text.secondary">
                {run.engine} · {run.id.slice(0, 8)} · {new Date(run.startedAt).toLocaleString()}
              </Typography>
              {run.wakeCause ? (
                onOpenAgentWork ? <Button
                  size="small"
                  color="inherit"
                  onClick={() => onOpenAgentWork(run.id)}
                  sx={{ display: "flex", justifyContent: "flex-start", px: 0, py: 0.25, textAlign: "left", color: "text.secondary" }}
                >Why This Run Started: {runCauseSentence(run.wakeCause)}</Button>
                  : <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>Started by {wakeCauseLabel(run.wakeCause)}</Typography>
              ) : null}
              <Typography variant="caption" color={run.usage ? "text.secondary" : "warning.main"} sx={{ display: "block" }}>
                {run.usage
                  ? `${new Intl.NumberFormat().format(run.usage.totalTokens ?? 0)} tokens · ${new Intl.NumberFormat().format(run.usage.inputTokens ?? 0)} in / ${new Intl.NumberFormat().format(run.usage.outputTokens ?? 0)} out`
                  : run.status === "running" ? "Usage available when this run finishes" : "Usage not reported"}
              </Typography>
              {onOpenAgentWork && !run.wakeCause ? <Button size="small" sx={{ mt: 0.5 }} onClick={() => onOpenAgentWork(run.id)}>Review Work</Button> : null}
              {run.providerInput ? <RunProviderInput run={run} /> : null}
            </Paper>
          ))}
        </Box>
      )}
      {workItems.length > 0 ? <>
        <Divider />
        <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
          <Typography variant="overline" color="text.secondary" sx={{ flex: 1 }}>Work items</Typography>
          <Typography variant="caption" color="text.secondary">{workItems.length}</Typography>
        </Stack>
        {workItems.map((item) => (
          <Paper key={item.id} id={telemetryElementId("workItems", item.id)} tabIndex={focus?.stream === "workItems" && focus.id === item.id ? -1 : undefined} variant="outlined" sx={{ p: 1.25 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <Typography variant="subtitle2" sx={{ flex: 1 }}>{item.title}</Typography>
              <Chip size="small" label={workItemStatusLabel(item.status)} color={workItemStatusColor(item.status)} />
            </Stack>
            {item.executionId ? <Typography variant="caption" color="text.secondary">Run {item.executionId.slice(0, 8)}</Typography> : null}
          </Paper>
        ))}
      </> : null}
      <Divider />
      <Typography variant="overline" color="text.secondary">
        Timeline
      </Typography>
      {timeline.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Commands, file changes, test results, and tool output will appear here.
        </Typography>
      ) : (
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            pr: 0.5,
          }}
        >
          {timeline.map((item) => (
            <EventLine key={item.id} item={item} />
          ))}
        </Box>
      )}
    </Stack>
    <ScrollToLatestButton visible={showLatest} onClick={() => {
      if (!scrollRef.current) return;
      followLatest.current = true;
      scrollChatToBottom(scrollRef.current);
      setShowLatest(false);
    }} />
    </Box>
  );
}

function RunProviderInput({ run }: { run: AgentRunDto }): JSX.Element {
  const [showExact, setShowExact] = useState(false);
  const exact = useQuery({
    queryKey: ["provider-input", run.id],
    queryFn: async () => {
      const response = await fetch(`/api/runs/${encodeURIComponent(run.id)}/provider-input?exact=1`);
      if (!response.ok) throw new Error("Provider input is unavailable");
      return await response.json() as ProviderInputDto;
    },
    enabled: showExact,
    staleTime: Infinity,
  });
  const manifest = run.providerInput!.sourceManifest;
  return <Box sx={{ mt: 0.75 }}>
    <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
      Context {run.providerInput!.promptHash.slice(0, 12)} · {manifest.providerSessionDisposition.replaceAll("_", " ")} · {manifest.historyMessageCount} submitted history · {"retainedSessionSourceCount" in manifest ? `${manifest.retainedSessionSourceCount} retained-session source(s) · ` : ""}{manifest.activationIds.length} activation(s) · {manifest.artifactIds.length} artifact(s)
    </Typography>
    <Box sx={{ mt: 0.5, maxHeight: 150, overflowY: "auto", borderLeft: 2, borderColor: "divider", pl: 1 }} aria-label={`Provider input sources for Run ${run.id}`}>
      {manifest.sources.map((source, index) => <Stack key={`${source.kind}:${source.ref}:${index}`} direction="row" spacing={0.75} sx={{ alignItems: "baseline", minWidth: 0 }}>
        <Typography variant="caption" fontWeight={700} sx={{ flexShrink: 0 }}>{source.kind.replaceAll("_", " ")}</Typography>
        <Typography variant="caption" color="text.secondary" noWrap title={source.ref}>{source.ref}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ ml: "auto !important", flexShrink: 0 }}>{"delivery" in source ? source.delivery.replaceAll("_", " ") : "submitted"}</Typography>
      </Stack>)}
    </Box>
    <Button size="small" sx={{ px: 0, minWidth: 0 }} onClick={() => setShowExact((value) => !value)}>
      {showExact ? "Hide Exact Provider Input" : "Show Exact Provider Input"}
    </Button>
    {showExact ? <Paper variant="outlined" sx={{ p: 1, mt: 0.5, maxHeight: 260, overflow: "auto" }}>
      <Typography variant="caption" component="pre" sx={{ m: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {exact.isPending ? "Loading…" : exact.isError ? exact.error.message : exact.data?.exactPrompt}
      </Typography>
    </Paper> : null}
  </Box>;
}

/** Refresh-safe chronological projection of canonical execution events. */
type MergedActivityEntry =
  | { type: "activity"; id: string; seq: number; createdAt: string; executionId?: string; item: AgentActivityDto }
  | { type: "work"; id: string; seq: number; createdAt: string; executionId: string; item: RunOutputDto };

export interface MergedActivityRun {
  key: string;
  executionId?: string;
  run?: AgentRunDto;
  entries: MergedActivityEntry[];
  firstAt: string;
  lastAt: string;
}

export function mergeActivityByRun(activity: AgentActivityDto[], runOutput: RunOutputDto[], runs: AgentRunDto[], activeExecutionId?: string): MergedActivityRun[] {
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

export function scrollActivityToCurrent(
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
    queryKey: ["activity-output", item.agentId, item.seq, reference?.sha256],
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

export interface ActivityExecutionGroup {
  key: string;
  executionId?: string;
  firstAt: string;
  lastAt: string;
  items: AgentActivityDto[];
}

export function groupActivityByExecution(activity: AgentActivityDto[]): ActivityExecutionGroup[] {
  const groups = new Map<string, ActivityExecutionGroup>();
  for (const item of [...activity].sort((a, b) => a.seq - b.seq)) {
    const key = item.executionId ?? "unscoped";
    const group = groups.get(key);
    if (group) {
      group.items.push(item);
      group.lastAt = item.createdAt;
    } else {
      groups.set(key, { key, ...(item.executionId ? { executionId: item.executionId } : {}), firstAt: item.createdAt, lastAt: item.createdAt, items: [item] });
    }
  }
  return [...groups.values()];
}

export function formatActivitySpan(firstAt: string, lastAt: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(lastAt) - Date.parse(firstAt)) / 1_000));
  if (seconds < 60) return seconds === 0 ? "single moment" : `${seconds}s activity span`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s activity span`;
}
