import BuildOutlinedIcon from "@mui/icons-material/BuildOutlined";
import CheckIcon from "@mui/icons-material/Check";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import CodeIcon from "@mui/icons-material/Code";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import LanguageIcon from "@mui/icons-material/Language";
import PlayCircleOutlineIcon from "@mui/icons-material/PlayCircleOutline";
import PsychologyOutlinedIcon from "@mui/icons-material/PsychologyOutlined";
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

const ACTIVITY_TITLE_COLOR = "success.main";
const ACTIVITY_TITLE_FONT_SIZE = 15;
type GroupedActionEntry = Extract<ActivityStreamEntry, { kind: "command" | "tool" | "browser" }>;

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
    sx={{ py: 1.25, borderBottom: 1, borderColor: "divider", minWidth: 0 }}
  >{children}</Box>;
}

export function RunHeaderRow({
  entry,
}: {
  entry: Extract<ActivityStreamEntry, { kind: "run_header" }>;
}): JSX.Element {
  const counts = entry.run?.activityCounts;
  const countParts = counts ? [
    `${counts.commands} command${counts.commands === 1 ? "" : "s"}`,
    `${counts.tools} tool${counts.tools === 1 ? "" : "s"}`,
    `${counts.files} file${counts.files === 1 ? "" : "s"}`,
    ...(counts.errors ? [`${counts.errors} error${counts.errors === 1 ? "" : "s"}`] : []),
  ] : [];
  return <Box
    data-activity-kind="run_header"
    sx={{ mt: 3, pt: 1.5, pb: 0.75, borderTop: 2, borderColor: "divider" }}
  >
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center" }}>
      <Typography variant="subtitle2" color={ACTIVITY_TITLE_COLOR} sx={{ display: "flex", alignItems: "center", gap: 0.75, fontSize: ACTIVITY_TITLE_FONT_SIZE, fontWeight: 800, letterSpacing: ".025em" }}>
        <PlayCircleOutlineIcon fontSize="small" />
        {entry.executionId
          ? entry.run?.title ?? `Run ${entry.executionId.slice(0, 8)}`
          : "Unscoped activity"}
      </Typography>
      {countParts.length ? <Typography variant="caption" color="text.secondary">
        {countParts.join(" · ")}
      </Typography> : null}
      {entry.run ? <Typography variant="caption" color="text.secondary">
        <ActivityElapsed startedAt={entry.run.startedAt} completedAt={entry.run.completedAt} />
      </Typography> : null}
      {entry.active ? <Chip size="small" color="info" label="Working" /> : null}
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
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyLabel = copyState === "copied"
    ? "Command copied"
    : copyState === "failed" ? "Copy command failed" : "Copy command";
  return <Row entry={entry} focusId={focusId}>
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <Typography variant="subtitle2" color={ACTIVITY_TITLE_COLOR} sx={{ display: "flex", alignItems: "center", gap: 0.75, flex: 1, fontSize: ACTIVITY_TITLE_FONT_SIZE, fontWeight: 700 }}>
        <CodeIcon fontSize="small" />
        {entry.internal ? "Ponderosa communication" : "Command"}
      </Typography>
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
    {entry.internal
      ? <Typography variant="body2" color="text.secondary">Sent a structured Ponderosa communication or managed-agent event.</Typography>
      : <Box sx={{ mt: 0.5 }}>
          <CollapsibleCode value={`$ ${entry.command}`} maxLines={2} fontSize={13.5} />
        </Box>}
    {!entry.internal && entry.cwd && entry.cwd !== projectRoot ? <Typography variant="caption" color="text.secondary">
      cwd: {entry.cwd}
    </Typography> : null}
    {entry.result ? <ActivityOutput result={entry.result} label="Command output" collapsedLines={5} /> : null}
  </Row>;
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
  const hasErrors = entries.some((entry) =>
    (entry.kind === "command" || entry.kind === "tool") && entry.result?.isError);
  const containsFocus = entries.some((entry) => entry.id === focusId);
  const [expanded, setExpanded] = useState(hasErrors || containsFocus);
  useEffect(() => {
    if (hasErrors || containsFocus) setExpanded(true);
  }, [containsFocus, hasErrors]);
  const failureCount = entries.filter((entry) =>
    (entry.kind === "command" || entry.kind === "tool") && entry.result?.isError).length;
  const commandCount = entries.filter((entry) => entry.kind === "command").length;
  const toolCount = entries.filter((entry) => entry.kind === "tool").length;
  const summary = [
    ...(commandCount ? [`Ran ${commandCount} command${commandCount === 1 ? "" : "s"}`] : []),
    ...(toolCount ? [`Used ${toolCount} tool${toolCount === 1 ? "" : "s"}`] : []),
  ].join(" · ");
  return <Box data-activity-kind="action_group">
    <Stack
      direction="row"
      spacing={1}
      sx={{ py: 1.25, alignItems: "center", borderBottom: 1, borderColor: "divider" }}
    >
      <Button
        size="small"
        color="inherit"
        startIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} grouped activity`}
        onClick={() => setExpanded((value) => !value)}
        sx={{ color: ACTIVITY_TITLE_COLOR, fontSize: ACTIVITY_TITLE_FONT_SIZE, fontWeight: 700, px: 0.5 }}
      >
        <Stack component="span" direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
          {commandCount ? <CodeIcon fontSize="small" /> : null}
          {toolCount ? <BuildOutlinedIcon fontSize="small" /> : null}
          <Box component="span">{summary}</Box>
        </Stack>
      </Button>
      {failureCount ? <Typography variant="caption" color="error.main">
        {failureCount} failed
      </Typography> : null}
    </Stack>
    {expanded ? entries.map((entry) => {
      if (entry.kind === "command") return <CommandRow
        key={entry.id}
        entry={entry}
        focusId={focusId}
        projectRoot={projectRoot}
      />;
      if (entry.kind === "tool") return <ToolRow key={entry.id} entry={entry} focusId={focusId} />;
      return <CompactActivityRow key={entry.id} entry={entry} focusId={focusId} />;
    }) : null}
  </Box>;
}

function CollapsibleCode({
  value,
  maxLines,
  fontSize = 12.5,
}: {
  value: string;
  maxLines: number;
  fontSize?: number;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const lines = value.split("\n");
  const collapsible = lines.length > maxLines || value.length > 700;
  return <Box>
    <Box component="pre" sx={{
      m: 0,
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
      fontFamily: "monospace",
      fontSize,
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
  let formatted = "";
  try {
    formatted = JSON.stringify(entry.input, null, 2);
  } catch {
    formatted = String(entry.input);
  }
  return <Row entry={entry} focusId={focusId}>
    <Typography variant="subtitle2" color={ACTIVITY_TITLE_COLOR} sx={{ display: "flex", alignItems: "center", gap: 0.75, fontSize: ACTIVITY_TITLE_FONT_SIZE, fontWeight: 700 }}>
      <BuildOutlinedIcon fontSize="small" />
      Tool call: {entry.name}
    </Typography>
    <Box sx={{ mt: 0.5, pl: 1.5, borderLeft: 2, borderColor: "divider" }}>
      <CollapsibleCode value={formatted || "null"} maxLines={6} />
    </Box>
    {entry.result ? <ActivityOutput result={entry.result} label="Tool output" collapsedLines={2} /> : null}
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
  return <Row entry={entry} focusId={focusId} stream="runOutput">
    <Box sx={{ pl: 1.5, borderLeft: 2, borderColor: "divider" }}>
      <Typography variant="caption" color={ACTIVITY_TITLE_COLOR} sx={{ display: "flex", alignItems: "center", gap: 0.75, mb: 0.5, fontSize: ACTIVITY_TITLE_FONT_SIZE, fontWeight: 700 }}>
        <PsychologyOutlinedIcon fontSize="small" />
        Thinking
      </Typography>
      <RunOutputFullText segment={entry.segment} render={(text) => <ThinkingText text={text} />} />
    </Box>
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
    <Typography variant="caption" color={ACTIVITY_TITLE_COLOR} sx={{ display: "flex", alignItems: "center", gap: 0.75, mb: 0.5, fontSize: ACTIVITY_TITLE_FONT_SIZE, fontWeight: 700 }}>
      <EditOutlinedIcon fontSize="small" />
      {entry.segment.completed ? "Response" : "Response · live"}
    </Typography>
    <RunOutputFullText
      segment={entry.segment}
      render={(text) => <ChatMessageBody text={text} collapseLongMessage={false} projectId={projectId} />}
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
