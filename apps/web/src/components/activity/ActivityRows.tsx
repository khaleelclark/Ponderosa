import BuildOutlinedIcon from "@mui/icons-material/BuildOutlined";
import CheckIcon from "@mui/icons-material/Check";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import CodeIcon from "@mui/icons-material/Code";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import LanguageIcon from "@mui/icons-material/Language";
import { Box, Button, Chip, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import type { ResponseFileActivityDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { copyText } from "../../clipboard";
import { queryKeys } from "../../queryKeys";
import { telemetryElementId } from "../../telemetryFocus";
import { ResourceContextMenu } from "../ResourceContextMenu";
import type { ResourceContextMenuState } from "../ResourceContextMenu";
import { ChatMessageBody } from "../chat/ChatMessages";
import { FilePreview } from "../filePreview/FilePreview";
import { ActivityOutput, RunOutputFullText } from "./ActivityOutput";
import type { ActivityStreamEntry } from "./activityStream";
import { ResponseFileActivity } from "./ResponseFileActivity";

const ACTIVITY_TITLE_COLOR = "var(--ponderosa-activity-label)";
const ACTIVITY_TITLE_FONT_SIZE = 12.5;
const RUN_TITLE_FONT_SIZE = 13.5;
type GroupedActionEntry = Extract<
  ActivityStreamEntry,
  { kind: "command" | "tool" | "file" | "browser" | "notice" }
>;

function activityTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return "";
  return timestamp.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ActivityTimestamp({ value }: { value: string }): JSX.Element {
  return <Typography
    component="time"
    dateTime={value}
    variant="caption"
    color="text.disabled"
    sx={{ display: "block", fontSize: 10.5, lineHeight: 1.3, whiteSpace: "nowrap" }}
  >
    {activityTimestamp(value)}
  </Typography>;
}

export function ActivityElapsed({
  startedAt,
  completedAt,
}: {
  startedAt: string;
  completedAt?: string;
}): JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (completedAt) return;
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1_000);
    return () => globalThis.clearInterval(timer);
  }, [completedAt]);
  const milliseconds = Math.max(
    0,
    Date.parse(completedAt ?? new Date(now).toISOString()) - Date.parse(startedAt),
  );
  const seconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return <>{hours ? `${hours}:` : ""}{String(minutes).padStart(hours ? 2 : 1, "0")}:{String(remainder).padStart(2, "0")}</>;
}

function Row({
  entry,
  focusId,
  stream = "activity",
  children,
}: {
  entry: ActivityStreamEntry;
  focusId?: string;
  stream?: "activity" | "runOutput";
  children: React.ReactNode;
}): JSX.Element {
  return <Box
    id={telemetryElementId(stream, entry.id)}
    tabIndex={focusId === entry.id ? -1 : undefined}
    data-activity-kind={entry.kind}
    sx={{ py: 0.8, borderBottom: 1, borderColor: "divider", minWidth: 0 }}
  >
    {children}
    <Box sx={{ display: "flex", justifyContent: "flex-end", mt: 0.25 }}>
      <ActivityTimestamp value={entry.createdAt} />
    </Box>
  </Box>;
}

export function RunHeaderRow({
  entry,
}: {
  entry: Extract<ActivityStreamEntry, { kind: "run_header" }>;
}): JSX.Element {
  const sourceCommunicationCount =
    entry.run?.providerInput?.sourceManifest.communicationEventIds.length ?? 0;
  const isCoordinationContinuation =
    entry.run?.wakeCause === "coordination" ||
    (entry.run?.wakeCause === "collaboration" &&
      !entry.run.communicationEventId &&
      sourceCommunicationCount === 0);
  if (entry.prompt) return <Box
    data-activity-kind="run_header"
    sx={{ py: 1, borderBottom: 1, borderColor: "divider", minWidth: 0 }}
  >
    <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 0.35 }}>
      <Typography color={ACTIVITY_TITLE_COLOR} sx={{ flex: 1, fontSize: ACTIVITY_TITLE_FONT_SIZE, fontWeight: 750 }}>
        Prompt
      </Typography>
      <ActivityTimestamp value={entry.prompt.createdAt} />
    </Stack>
    <Typography sx={{ fontSize: 13, lineHeight: 1.4, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
      {entry.prompt.text}
    </Typography>
    <Stack direction="row" spacing={1} sx={{ alignItems: "center", mt: 0.4 }}>
      {entry.run ? <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10.5 }}>
        <ActivityElapsed startedAt={entry.run.startedAt} completedAt={entry.run.completedAt} />
      </Typography> : null}
      {entry.active ? <Chip size="small" color="info" label="Working" sx={{ height: 20, fontSize: 10.5 }} /> : null}
    </Stack>
  </Box>;
  return <Box
    data-activity-kind={isCoordinationContinuation ? "run_continuation" : "run_header"}
    sx={{
      py: 0.65,
      borderBottom: 1,
      borderColor: "divider",
    }}
  >
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <Typography color="text.secondary" sx={{ flex: 1, fontSize: RUN_TITLE_FONT_SIZE, fontWeight: 650 }}>
        {isCoordinationContinuation
          ? "Continued"
          : entry.executionId
            ? entry.run?.title ?? `Run ${entry.executionId.slice(0, 8)}`
            : "Unscoped activity"}
      </Typography>
      {entry.run ? <Typography variant="caption" color="text.secondary">
        <ActivityElapsed startedAt={entry.run.startedAt} completedAt={entry.run.completedAt} />
      </Typography> : null}
      {entry.active ? <Chip size="small" color="info" label="Working" sx={{ height: 20, fontSize: 10.5 }} /> : null}
      <ActivityTimestamp value={entry.createdAt} />
    </Stack>
  </Box>;
}

export function CommandRow({
  entry,
  focusId,
  projectRoot,
}: {
  entry: Extract<ActivityStreamEntry, { kind: "command" }>;
  focusId?: string;
  projectRoot?: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(focusId === entry.id);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (focusId === entry.id) setExpanded(true);
  }, [entry.id, focusId]);
  const copyLabel = copyState === "copied"
    ? "Command copied"
    : copyState === "failed" ? "Copy command failed" : "Copy command";
  return <Row entry={entry} focusId={focusId}>
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <Button
        color="inherit"
        startIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        sx={{ flex: 1, minWidth: 0, justifyContent: "flex-start", px: 0.5, color: entry.result?.isError ? "error.main" : ACTIVITY_TITLE_COLOR }}
      >
        <Stack component="span" direction="row" spacing={0.75} sx={{ alignItems: "center", minWidth: 0 }}>
          <CodeIcon fontSize="small" />
          <Box component="span" sx={{ fontSize: ACTIVITY_TITLE_FONT_SIZE, fontWeight: 700, flexShrink: 0 }}>
            {entry.internal ? "Ponderosa communication" : "Command"}
          </Box>
          {!entry.internal ? <Box
            component="span"
            sx={{ color: "text.secondary", fontFamily: "monospace", fontSize: 12.5, fontWeight: 500, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {entry.command}
          </Box> : null}
        </Stack>
      </Button>
      {entry.result?.isError ? <Chip size="small" color="error" label="Failed" /> : null}
      {!entry.internal ? <>
        <Tooltip title={copyLabel}>
          <IconButton size="small" color={copyState === "failed" ? "error" : "inherit"} aria-label="Copy command" onClick={() => {
            void copyText(entry.command)
              .then(() => setCopyState("copied"))
              .catch(() => setCopyState("failed"));
            globalThis.setTimeout(() => setCopyState("idle"), 2_000);
          }}>
            {copyState === "copied" ? <CheckIcon fontSize="inherit" /> : <ContentCopyIcon fontSize="inherit" />}
          </IconButton>
        </Tooltip>
        <Box component="span" aria-live="polite" sx={{ position: "absolute", width: 1, height: 1, p: 0, m: -1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 }}>
          {copyState === "idle" ? "" : copyLabel}
        </Box>
      </> : null}
    </Stack>
    {expanded ? <Box sx={{ pl: { xs: 1, sm: 4.5 }, pr: 0.5, pb: 0.5 }}>
      {entry.internal
        ? <Typography variant="body2" color="text.secondary">Sent a structured Ponderosa communication or managed-agent event.</Typography>
        : <Box component="pre" sx={{ m: 0, mt: 0.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "monospace", fontSize: 13.5, userSelect: "text" }}>
            $ {entry.command}
          </Box>}
      {!entry.internal && entry.cwd && entry.cwd !== projectRoot ? <Typography variant="caption" color="text.secondary">
        cwd: {entry.cwd}
      </Typography> : null}
      {entry.result ? <ActivityOutput result={entry.result} label="Command output" collapsedLines={5} /> : null}
    </Box> : null}
  </Row>;
}

function GroupedActivityRow({
  entry,
  focusId,
  projectRoot,
}: {
  entry: GroupedActionEntry;
  focusId?: string;
  projectRoot?: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(entry.id === focusId);
  useEffect(() => {
    if (entry.id === focusId) setExpanded(true);
  }, [entry.id, focusId]);
  let toolInput = "";
  if (entry.kind === "tool") {
    try {
      toolInput = JSON.stringify(entry.input, null, 2);
    } catch {
      toolInput = String(entry.input);
    }
  }
  const fileVerb = entry.kind === "file"
    ? entry.changeKind === "create"
      ? "Created"
      : entry.changeKind === "delete"
        ? "Deleted"
        : "Edited"
    : undefined;
  const browser = entry.kind === "browser"
    ? browserDescription(entry)
    : undefined;
  const result = "result" in entry ? entry.result : undefined;
  const label = entry.kind === "command"
    ? entry.internal ? "Ponderosa communication" : "Command"
    : entry.kind === "tool"
      ? "Tool"
      : entry.kind === "file"
        ? fileVerb!
        : entry.kind === "browser"
          ? browser!.title
          : entry.title;
  const preview = entry.kind === "command"
    ? entry.internal ? "" : entry.command
    : entry.kind === "tool"
      ? entry.name
      : entry.kind === "file"
        ? entry.path
        : entry.kind === "browser"
          ? browser!.detail
          : entry.detail ?? "";
  return <Box
    id={telemetryElementId("activity", entry.id)}
    tabIndex={focusId === entry.id ? -1 : undefined}
    sx={{ pr: 0.5, borderBottom: 1, borderColor: "divider", "&:last-child": { borderBottom: 0 } }}
  >
    <Stack direction="row" spacing={0.75} sx={{ py: 0.35, alignItems: "center", minWidth: 0 }}>
      <Button
        color="inherit"
        startIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
        sx={{
          flex: 1,
          minWidth: 0,
          minHeight: 26,
          justifyContent: "flex-start",
          px: 0.25,
          color: result?.isError ? "error.main" : "text.secondary",
          fontSize: 11.5,
          fontWeight: 700,
        }}
      >
        <Box component="span" sx={{ flexShrink: 0 }}>{label}</Box>
        {preview ? <Box
          component="span"
          sx={{ ml: 0.75, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "text.secondary", fontFamily: entry.kind === "command" || entry.kind === "tool" ? "monospace" : "inherit", fontWeight: 500 }}
        >
          {preview}
        </Box> : null}
      </Button>
      {result?.isError ? <Chip size="small" color="error" label="Failed" sx={{ height: 18, fontSize: 10 }} /> : null}
      <ActivityTimestamp value={entry.createdAt} />
    </Stack>
    {expanded ? <Box sx={{ pb: 0.75, pl: 3.25, pr: 0.5 }}>
      {entry.kind === "command" ? (
        entry.internal
          ? <Typography color="text.secondary" sx={{ fontSize: 11.5 }}>
              Sent a structured Ponderosa communication or managed-agent event.
            </Typography>
          : <>
              <Box component="pre" sx={{ m: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "monospace", fontSize: 11.5, lineHeight: 1.4 }}>
                $ {entry.command}
              </Box>
              {entry.cwd && entry.cwd !== projectRoot ? <Typography color="text.secondary" sx={{ fontSize: 10.5 }}>
                cwd: {entry.cwd}
              </Typography> : null}
            </>
      ) : null}
      {entry.kind === "tool" ? <Box sx={{ pl: 1, borderLeft: 2, borderColor: "divider" }}>
        <CollapsibleCode value={toolInput || "null"} maxLines={4} />
      </Box> : null}
      {entry.kind === "file" && (entry.additions !== undefined || entry.deletions !== undefined) ? <Typography sx={{ fontSize: 10.5 }}>
        <Box component="span" color="success.main">+{entry.additions ?? 0}</Box>{" "}
        <Box component="span" color="error.main">−{entry.deletions ?? 0}</Box>
      </Typography> : null}
      {entry.kind === "notice" && entry.detail ? <Typography color="text.secondary" sx={{ fontSize: 11.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {entry.detail}
      </Typography> : null}
      {browser?.detail ? <Typography color="text.secondary" sx={{ fontSize: 11.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {browser.detail}
      </Typography> : null}
      {result ? <ActivityOutput result={result} label="Output" collapsedLines={2} /> : null}
    </Box> : null}
  </Box>;
}

export function ActionGroupRow({
  entries,
  focusId,
  projectRoot,
}: {
  entries: GroupedActionEntry[];
  focusId?: string;
  projectRoot?: string;
}): JSX.Element {
  const containsFocus = entries.some((entry) => entry.id === focusId);
  const [expanded, setExpanded] = useState(containsFocus);
  useEffect(() => {
    if (containsFocus) setExpanded(true);
  }, [containsFocus]);
  const failureCount = entries.filter(
    entry => "result" in entry && entry.result?.isError,
  ).length;
  const summary = `Ran ${entries.length} ${entries.length === 1 ? "activity" : "activities"}`;
  return <Box data-activity-kind="action_group">
    <Stack
      direction="row"
      spacing={1}
      sx={{ py: 0.7, alignItems: "center", borderBottom: 1, borderColor: "divider" }}
    >
      <Button
        color="inherit"
        startIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${summary.toLocaleLowerCase()}`}
        onClick={() => setExpanded((value) => !value)}
        sx={{ color: failureCount ? "error.main" : ACTIVITY_TITLE_COLOR, fontSize: ACTIVITY_TITLE_FONT_SIZE, fontWeight: 700, px: 0.25, minHeight: 28 }}
      >
        {summary}
      </Button>
      {failureCount ? <Chip size="small" color="error" label={`${failureCount} failed`} sx={{ height: 20, fontSize: 10.5 }} /> : null}
      <Box sx={{ flex: 1 }} />
      {entries[0] ? <ActivityTimestamp value={entries[0].createdAt} /> : null}
    </Stack>
    {expanded ? <Box sx={{ pl: 2, borderBottom: 1, borderColor: "divider" }}>
      {entries.map(entry => <GroupedActivityRow
          key={entry.id}
          entry={entry}
          focusId={focusId}
          projectRoot={projectRoot}
        />)}
    </Box> : null}
  </Box>;
}

function CollapsibleCode({ value, maxLines }: { value: string; maxLines: number }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const lines = value.split("\n");
  const collapsible = lines.length > maxLines || value.length > 700;
  return <Box>
    <Box component="pre" sx={{
      m: 0,
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
      fontFamily: "monospace",
      fontSize: 11.5,
      lineHeight: 1.45,
      ...(!expanded && collapsible ? {
        maxHeight: `${maxLines * 1.45}em`,
        overflow: "hidden",
        maskImage: "linear-gradient(to bottom, black calc(100% - 2em), transparent)",
      } : {}),
    }}>{value}</Box>
    {collapsible ? <Button
      size="small"
      color="inherit"
      startIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
      onClick={() => setExpanded((value) => !value)}
    >{expanded ? "Show less" : "Show more"}</Button> : null}
  </Box>;
}

export function ToolRow({
  entry,
  focusId,
}: {
  entry: Extract<ActivityStreamEntry, { kind: "tool" }>;
  focusId?: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(focusId === entry.id);
  useEffect(() => {
    if (focusId === entry.id) setExpanded(true);
  }, [entry.id, focusId]);
  let formatted = "";
  try {
    formatted = JSON.stringify(entry.input, null, 2);
  } catch {
    formatted = String(entry.input);
  }
  return <Row entry={entry} focusId={focusId}>
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <Button
        color="inherit"
        startIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        sx={{ flex: 1, minWidth: 0, justifyContent: "flex-start", px: 0.5, color: entry.result?.isError ? "error.main" : ACTIVITY_TITLE_COLOR }}
      >
        <Stack component="span" direction="row" spacing={0.75} sx={{ alignItems: "center", minWidth: 0 }}>
          <BuildOutlinedIcon fontSize="small" />
          <Box component="span" sx={{ fontSize: ACTIVITY_TITLE_FONT_SIZE, fontWeight: 700, flexShrink: 0 }}>
            Tool
          </Box>
          <Box component="span" sx={{ color: "text.secondary", fontFamily: "monospace", fontSize: 12.5, fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {entry.name}
          </Box>
        </Stack>
      </Button>
      {entry.result?.isError ? <Chip size="small" color="error" label="Failed" /> : null}
    </Stack>
    {expanded ? <Box sx={{ pl: { xs: 1, sm: 4.5 }, pr: 0.5, pb: 0.5 }}>
      <Box sx={{ mt: 0.5, pl: 1.5, borderLeft: 2, borderColor: "divider" }}>
        <CollapsibleCode value={formatted || "null"} maxLines={6} />
      </Box>
      {entry.result ? <ActivityOutput result={entry.result} label="Tool output" collapsedLines={2} /> : null}
    </Box> : null}
  </Row>;
}

export function FileRow({
  entry,
  focusId,
  onOpenFile,
  onOpenFileInNewTab,
}: {
  entry: Extract<ActivityStreamEntry, { kind: "file" }>;
  focusId?: string;
  onOpenFile?(file: ResponseFileActivityDto): void;
  onOpenFileInNewTab?(file: ResponseFileActivityDto): void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<ResourceContextMenuState<ResponseFileActivityDto>>();
  const file: ResponseFileActivityDto = {
    path: entry.path,
    kind: entry.changeKind,
    status: "completed",
    sourceSeq: entry.seq,
    artifactId: entry.artifactId,
    artifactKind: "diff",
    previewable: true,
    ...(entry.additions !== undefined ? { additions: entry.additions } : {}),
    ...(entry.deletions !== undefined ? { deletions: entry.deletions } : {}),
  };
  const query = useQuery({
    queryKey: queryKeys.projectArtifacts.agentContent(entry.agentId, entry.artifactId),
    queryFn: () => api.getArtifact(entry.agentId, entry.artifactId),
    enabled: open,
  });
  const verb = entry.changeKind === "create" ? "Created" : entry.changeKind === "delete" ? "Deleted" : "Edited";
  return <Row entry={entry} focusId={focusId}>
    <Stack
      direction="row"
      spacing={1}
      onContextMenu={(event) => {
        if (!onOpenFileInNewTab) return;
        event.preventDefault();
        setMenu({ anchor: event.currentTarget, resource: file });
      }}
      sx={{ alignItems: "center", minWidth: 0 }}
    >
      <Typography variant="subtitle2" color={ACTIVITY_TITLE_COLOR} sx={{ display: "flex", alignItems: "center", gap: 0.75, fontSize: ACTIVITY_TITLE_FONT_SIZE, fontWeight: 700, flexShrink: 0 }}>
        <DescriptionOutlinedIcon fontSize="small" />
        {verb}
      </Typography>
      <Typography variant="body2" sx={{ fontFamily: "monospace", minWidth: 0, overflowWrap: "anywhere" }}>{entry.path}</Typography>
      {entry.additions !== undefined || entry.deletions !== undefined ? <Typography variant="caption" sx={{ flexShrink: 0 }}>
        <Box component="span" color="success.main">+{entry.additions ?? 0}</Box>{" "}
        <Box component="span" color="error.main">−{entry.deletions ?? 0}</Box>
      </Typography> : null}
      <Button size="small" color="inherit" onClick={() => setOpen((value) => !value)}>
        {open ? "Hide preview" : "Preview"}
      </Button>
    </Stack>
    {open ? <Box sx={{ mt: 1 }}>
      <FilePreview
        title={entry.path}
        path={entry.path}
        artifactKind="diff"
        contentType="diff"
        content={query.data?.content}
        loading={query.isLoading}
        error={query.isError}
        truncated={query.data?.truncated}
        totalBytes={query.data?.totalBytes}
        hideHeader
        maxHeight={{ xs: "38vh", md: "46vh" }}
      />
      {onOpenFile ? <Button size="small" color="inherit" onClick={() => onOpenFile(file)} sx={{ mt: 0.5 }}>
        Open focused diff
      </Button> : null}
    </Box> : null}
    {entry.result ? <ActivityOutput result={entry.result} label="File tool output" collapsedLines={2} /> : null}
    <ResourceContextMenu state={menu} onClose={() => setMenu(undefined)} onOpenInNewTab={onOpenFileInNewTab} />
  </Row>;
}

function ThinkingText({ text }: { text: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const collapsible = text.split("\n").length > 12 || text.length > 1_200;
  return <Box>
    <Typography component="div" variant="body2" color="text.secondary" sx={{
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
      lineHeight: 1.55,
      ...(!expanded && collapsible ? {
        maxHeight: "18.6em",
        overflow: "hidden",
        maskImage: "linear-gradient(to bottom, black calc(100% - 2.5em), transparent)",
      } : {}),
    }}>{text}</Typography>
    {collapsible ? <Button size="small" color="inherit" onClick={() => setExpanded((value) => !value)}>
      {expanded ? "Show less" : "Show more"}
    </Button> : null}
  </Box>;
}

export function ThinkingRow({
  entry,
  focusId,
}: {
  entry: Extract<ActivityStreamEntry, { kind: "thinking" }>;
  focusId?: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(focusId === entry.id);
  useEffect(() => {
    if (focusId === entry.id) setExpanded(true);
  }, [entry.id, focusId]);
  return <Row entry={entry} focusId={focusId} stream="runOutput">
    <Button
      color="inherit"
      startIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
      aria-expanded={expanded}
      onClick={() => setExpanded(value => !value)}
      sx={{ color: ACTIVITY_TITLE_COLOR, px: 0.25, minHeight: 28, fontSize: ACTIVITY_TITLE_FONT_SIZE, fontWeight: 700 }}
    >
      Thinking
    </Button>
    {expanded ? <Box sx={{ mt: 0.25, pl: 1.5, borderLeft: 2, borderColor: "divider" }}>
      <RunOutputFullText segment={entry.segment} render={(text) => <ThinkingText text={text} />} />
    </Box> : null}
  </Row>;
}

export function ResponseRow({
  entry,
  focusId,
  onOpenFile,
  onOpenFileInNewTab,
  onViewAll,
  projectId,
}: {
  entry: Extract<ActivityStreamEntry, { kind: "response" }>;
  focusId?: string;
  onOpenFile?(file: ResponseFileActivityDto): void;
  onOpenFileInNewTab?(file: ResponseFileActivityDto): void;
  onViewAll?(): void;
  projectId?: string;
}): JSX.Element {
  return <Row entry={entry} focusId={focusId} stream="runOutput">
    <RunOutputFullText
      segment={entry.segment}
      render={(text) => <ChatMessageBody
        text={text}
        collapseLongMessage={false}
        projectId={projectId}
        compactMarkdown
        smallText
      />}
    />
    {entry.segment.fileActivity?.length ? <ResponseFileActivity
      files={entry.segment.fileActivity}
      onOpenFile={onOpenFile}
      onOpenFileInNewTab={onOpenFileInNewTab}
      onViewAll={onViewAll}
      projectId={projectId}
    /> : null}
  </Row>;
}

function browserDescription(entry: Extract<ActivityStreamEntry, { kind: "browser" }>): {
  title: string;
  detail: string;
} {
  const event = entry.event;
  if (event.type === "browser_session") {
    return {
      title: `Browser ${event.status}`,
      detail: event.reason ?? event.url ?? `${event.controlOwner} control`,
    };
  }
  if (event.type === "browser_action") return { title: `Browser · ${event.action}`, detail: event.summary };
  if (event.type === "browser_console") return { title: `Browser console · ${event.level}`, detail: event.text };
  return { title: "Browser screenshot", detail: `${event.path} · ${event.width}×${event.height}` };
}

export function CompactActivityRow({
  entry,
  focusId,
}: {
  entry: Extract<ActivityStreamEntry, { kind: "test" | "error" | "browser" | "notice" }>;
  focusId?: string;
}): JSX.Element {
  const content = entry.kind === "test"
    ? { title: entry.passed ? "Tests passed" : "Tests failed", detail: entry.summary }
    : entry.kind === "error"
      ? { title: "Error", detail: entry.message }
      : entry.kind === "browser"
        ? browserDescription(entry)
        : { title: entry.title, detail: entry.detail ?? "" };
  const icon = entry.kind === "test"
    ? entry.passed ? <CheckCircleOutlineIcon fontSize="small" /> : <ErrorOutlineIcon fontSize="small" />
    : entry.kind === "error"
      ? <ErrorOutlineIcon fontSize="small" />
      : entry.kind === "browser"
        ? <LanguageIcon fontSize="small" />
        : <InfoOutlinedIcon fontSize="small" />;
  return <Row entry={entry} focusId={focusId}>
    <Typography variant="subtitle2" color={entry.kind === "error" ? "error.main" : ACTIVITY_TITLE_COLOR} sx={{ display: "flex", alignItems: "center", gap: 0.75, fontSize: ACTIVITY_TITLE_FONT_SIZE, fontWeight: 700 }}>
      {icon}
      {content.title}
    </Typography>
    {content.detail ? <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
      {content.detail}
    </Typography> : null}
    {entry.kind === "notice" && entry.result ? <ActivityOutput result={entry.result} label="Tool output" collapsedLines={2} /> : null}
  </Row>;
}
