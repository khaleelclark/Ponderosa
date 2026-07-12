import ArticleIcon from "@mui/icons-material/Article";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import CheckIcon from "@mui/icons-material/Check";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DifferenceIcon from "@mui/icons-material/Difference";
import SendIcon from "@mui/icons-material/Send";
import ReplyIcon from "@mui/icons-material/Reply";
import AttachFileIcon from "@mui/icons-material/AttachFile";
import CloseIcon from "@mui/icons-material/Close";
import StopCircleIcon from "@mui/icons-material/StopCircle";
import TerminalIcon from "@mui/icons-material/Terminal";
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  ClickAwayListener,
  Divider,
  IconButton,
  MenuItem,
  MenuList,
  Paper,
  Popper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import type { ArtifactContentDto, ArtifactDto, MessageDto, TaskDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import type { ExecutionItem } from "../hooks/useThreadStream";
import { findMentionedHandles } from "../mentions";
import { MessageSenderLabel } from "./MessageSenderLabel";
import { MessageActionsAndTimestamp } from "./MessageTimestamp";

export function taskStatusLabel(status: TaskDto["status"]): string {
  if (status === "waiting_approval") {
    return "Waiting";
  }
  return status[0] ? `${status[0].toUpperCase()}${status.slice(1)}` : status;
}

export function shouldSendComposerKey(event: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  repeat: boolean;
}): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && !event.repeat;
}

export function shouldIgnoreComposerKey(event: { key: string; isComposing: boolean }): boolean {
  return event.key === "Enter" && event.isComposing;
}

export function canSubmitComposerText(input: {
  text: string;
  disabled: boolean;
  running: boolean;
  allowUnmentionedSend: boolean;
  mentionedHandles: string[];
  mentionedBusyHandles: string[];
}): boolean {
  return (
    input.text.trim().length > 0 &&
    !input.disabled &&
    !input.running &&
    (input.allowUnmentionedSend || input.mentionedHandles.length > 0)
  );
}

export function taskStatusColor(status: TaskDto["status"]): "success" | "warning" | "info" {
  if (status === "done") {
    return "success";
  }
  if (status === "waiting_approval") {
    return "warning";
  }
  return "info";
}

function artifactIcon(kind: ArtifactDto["kind"]): JSX.Element {
  if (kind === "diff") {
    return <DifferenceIcon fontSize="small" />;
  }
  if (kind === "test_report") {
    return <CheckCircleOutlineIcon fontSize="small" />;
  }
  if (kind === "log") {
    return <TerminalIcon fontSize="small" />;
  }
  return <ArticleIcon fontSize="small" />;
}

function compactPath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 3) {
    return path;
  }
  return `${parts[0]}/.../${parts.at(-1)}`;
}

export const CHAT_BOTTOM_THRESHOLD = 48;

export function isChatNearBottom(
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">,
): boolean {
  return element.scrollHeight - element.clientHeight - element.scrollTop <= CHAT_BOTTOM_THRESHOLD;
}

export function scrollChatToBottom(element: Pick<HTMLElement, "scrollHeight" | "scrollTop">): void {
  element.scrollTop = element.scrollHeight;
}

export function replyFallbackText(text: string): string {
  return text.trim() || "Original message unavailable";
}

export function individualChatSenderLabel(
  role: MessageDto["role"],
  agentName: string,
): string {
  return role === "user" ? "You" : agentName.trim() || "Agent";
}

export function codeBlockText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map(codeBlockText).join("");
  }
  if (children && typeof children === "object" && "props" in children) {
    return codeBlockText((children as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

function CopyableCodeBlock({ children }: { children?: ReactNode }): JSX.Element {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const resetTimer = useRef<number>();

  useEffect(
    () => () => {
      if (resetTimer.current !== undefined) {
        window.clearTimeout(resetTimer.current);
      }
    },
    [],
  );

  async function copyCode(): Promise<void> {
    try {
      await navigator.clipboard.writeText(codeBlockText(children).replace(/\n$/, ""));
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
    if (resetTimer.current !== undefined) {
      window.clearTimeout(resetTimer.current);
    }
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 2000);
  }

  const label =
    copyState === "copied" ? "Copied code" : copyState === "error" ? "Copy failed" : "Copy code";

  return (
    <Box sx={{ position: "relative", my: 1 }}>
      <Tooltip title={label}>
        <IconButton
          aria-label={label}
          size="small"
          onClick={() => void copyCode()}
          sx={{ position: "absolute", top: 6, right: 6, zIndex: 1, bgcolor: "background.paper" }}
        >
          {copyState === "copied" ? <CheckIcon fontSize="inherit" /> : <ContentCopyIcon fontSize="inherit" />}
        </IconButton>
      </Tooltip>
      <Box component="pre" sx={{ m: 0, pr: 5 }}>
        {children}
      </Box>
    </Box>
  );
}

export function ChatMarkdown({ children }: { children: string }): JSX.Element {
  return (
    <Box
      sx={{
        overflowWrap: "anywhere",
        "& > :first-of-type": { mt: 0 },
        "& > :last-child": { mb: 0 },
        "& p": { my: 0.75 },
        "& h1, & h2, & h3, & h4": { mt: 1.5, mb: 0.75, lineHeight: 1.25 },
        "& h1": { fontSize: "1.35rem" },
        "& h2": { fontSize: "1.2rem" },
        "& h3, & h4": { fontSize: "1.05rem" },
        "& ul, & ol": { my: 0.75, pl: 3 },
        "& li + li": { mt: 0.25 },
        "& blockquote": { my: 1, mx: 0, pl: 1.5, borderLeft: 3, borderColor: "divider" },
        "& code": { fontFamily: "monospace", fontSize: "0.875em" },
        "& :not(pre) > code": { px: 0.5, py: 0.125, borderRadius: 0.75, bgcolor: "action.hover" },
        "& pre": { p: 1.25, overflowX: "auto", borderRadius: 1, bgcolor: "action.hover" },
        "& table": { display: "block", maxWidth: "100%", overflowX: "auto", borderCollapse: "collapse" },
        "& th, & td": { px: 1, py: 0.5, border: 1, borderColor: "divider" },
        "& a": { color: "inherit", textDecoration: "underline" },
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ pre: ({ children: code }) => <CopyableCodeBlock>{code}</CopyableCodeBlock> }}
      >
        {children}
      </ReactMarkdown>
    </Box>
  );
}

export function ChatPane({
  messages,
  agentName,
  onReply,
}: {
  messages: MessageDto[];
  agentName: string;
  onReply?(message: MessageDto): void;
}): JSX.Element {
  const chatMessages = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldFollowNewMessages = useRef(true);

  useLayoutEffect(() => {
    if (scrollRef.current && shouldFollowNewMessages.current) {
      scrollChatToBottom(scrollRef.current);
    }
  }, [chatMessages]);

  return (
    <Stack
      component="section"
      aria-label="Conversation"
      ref={scrollRef}
      spacing={1.25}
      onScroll={() => {
        if (scrollRef.current) {
          shouldFollowNewMessages.current = isChatNearBottom(scrollRef.current);
        }
      }}
      sx={{ p: 1.5, pb: 3, height: "100%", minHeight: 0, overflowY: "auto" }}
    >
      {chatMessages.length === 0 ? (
        <Alert severity="info">Send a message to this agent to start the conversation.</Alert>
      ) : null}
      {chatMessages.map((message) => {
        const senderLabel = individualChatSenderLabel(message.role, agentName);
        return (
        <Box
          key={message.id}
          id={`message-${message.id}`}
          component="article"
          aria-label={`${senderLabel} message`}
          tabIndex={-1}
          sx={{
            alignSelf: message.role === "user" ? "flex-end" : "flex-start",
            maxWidth: "min(680px, 92%)",
            px: 1.5,
            py: 1,
            borderRadius: 2,
            bgcolor: message.role === "user" ? "primary.main" : "background.paper",
            color: message.role === "user" ? "primary.contrastText" : "text.primary",
            border: message.role === "assistant" ? 1 : 0,
            borderColor: "divider",
            boxShadow: message.role === "assistant" ? "0 1px 2px rgba(0,0,0,0.05)" : "none",
            overflowWrap: "anywhere",
            userSelect: "text",
          }}
        >
          <MessageSenderLabel name={senderLabel} />
          {message.replyTo ? (
            <Box
              component="button"
              onClick={() => {
                const target = document.getElementById(`message-${message.replyTo!.messageId}`);
                target?.scrollIntoView({ behavior: "smooth", block: "center" });
                target?.focus({ preventScroll: true });
              }}
              sx={{ display: "block", width: "100%", mb: 0.75, p: 0.75, textAlign: "left", border: 0, borderLeft: 3, borderColor: "currentColor", bgcolor: "rgba(127,127,127,.14)", color: "inherit", cursor: "pointer", borderRadius: 1 }}
              aria-label="Go to replied-to message"
            >
              <Typography variant="caption" component="div" noWrap>{replyFallbackText(message.replyTo.text)}</Typography>
            </Box>
          ) : null}
          <ChatMarkdown>{message.text}</ChatMarkdown>
          {message.attachments?.length ? <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: message.text ? 1 : 0 }}>
            {message.attachments.map((attachment) => <Box key={attachment.id} component="a" href={attachment.url} target="_blank" rel="noreferrer" aria-label={`Open ${attachment.name}`}>
              <Box component="img" src={attachment.url} alt={attachment.name} sx={{ display: "block", maxWidth: 220, maxHeight: 180, objectFit: "contain", borderRadius: 1 }} />
            </Box>)}
          </Stack> : null}
          <MessageActionsAndTimestamp
            value={message.createdAt}
            actions={onReply ? <IconButton size="small" aria-label="Reply to message" onClick={() => onReply(message)} sx={{ color: "inherit", mt: 0.5 }}><ReplyIcon fontSize="inherit" /></IconButton> : undefined}
          />
        </Box>
        );
      })}
    </Stack>
  );
}

export function EventLine({ item }: { item: ExecutionItem }): JSX.Element {
  const { event } = item;
  let title: string = event.type;
  let body = "";

  if (event.type === "command") {
    title = "Command";
    body = event.command;
  } else if (event.type === "file_change") {
    title = `File ${event.kind}`;
    body = event.path;
  } else if (event.type === "test_result") {
    title = event.passed ? "Tests passed" : "Tests failed";
    body = event.summary;
  } else if (event.type === "tool_call") {
    title = `Tool ${event.name}`;
    body = JSON.stringify(event.input);
  } else if (event.type === "tool_result") {
    title = event.isError ? "Tool error" : "Tool result";
    body = event.output;
  } else if (event.type === "error") {
    title = "Error";
    body = event.message;
  }

  return (
    <Box sx={{ borderLeft: 2, borderColor: "divider", pl: 1.25, py: 0.75 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Chip size="small" label={`#${item.seq}`} variant="outlined" />
        <Typography variant="subtitle2">{title}</Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, overflowWrap: "anywhere" }}>
        {body}
      </Typography>
    </Box>
  );
}

export function TasksPane({
  tasks,
  timeline,
}: {
  tasks: TaskDto[];
  timeline: ExecutionItem[];
}): JSX.Element {
  return (
    <Stack spacing={1} sx={{ p: 1.5, pb: 3, minHeight: 0 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
        <Typography variant="overline" color="text.secondary" sx={{ flex: 1 }}>
          Tasks
        </Typography>
        {tasks.length > 0 ? (
          <Typography variant="caption" color="text.secondary">
            {tasks.length}
          </Typography>
        ) : null}
      </Stack>
      {tasks.length === 0 ? (
        <Alert severity="info">No execution tasks yet.</Alert>
      ) : (
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            gap: 1.25,
            overflowY: "auto",
            maxHeight: { xs: "32vh", md: "34vh" },
            pr: 0.5,
          }}
        >
          {tasks.map((task) => (
            <Paper key={task.id} variant="outlined" sx={{ p: 1.25 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 0 }} noWrap>
                  {task.title}
                </Typography>
                <Chip
                  size="small"
                  label={taskStatusLabel(task.status)}
                  color={taskStatusColor(task.status)}
                />
              </Stack>
              <Typography variant="caption" color="text.secondary">
                {task.engine} · {new Date(task.updatedAt).toLocaleTimeString()}
              </Typography>
            </Paper>
          ))}
        </Box>
      )}
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
            overflowY: "auto",
            maxHeight: { xs: "44vh", md: "48vh" },
            pr: 0.5,
          }}
        >
          {timeline.map((item) => (
            <EventLine key={item.id} item={item} />
          ))}
        </Box>
      )}
    </Stack>
  );
}

/** The "Live Log" tab: a running feed of commands, tools, tests, files, errors. */
export function LiveLogPane({
  timeline,
  connected,
  running,
}: {
  timeline: ExecutionItem[];
  connected: boolean;
  running: boolean;
}): JSX.Element {
  return (
    <Stack spacing={1} sx={{ p: 1.5, pb: 3, minHeight: 0 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Typography variant="overline" color="text.secondary" sx={{ flex: 1 }}>
          Live Log
        </Typography>
        <Chip
          size="small"
          label={connected ? "Live" : "Reconnecting"}
          color={connected ? "success" : "warning"}
          variant={connected ? "filled" : "outlined"}
        />
        {running ? <Chip size="small" color="info" label="Working" /> : null}
      </Stack>
      {timeline.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No activity yet. When this agent runs, its commands, tool calls, test results, file
          changes, errors, and completion events stream here in order.
        </Typography>
      ) : (
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            overflowY: "auto",
            maxHeight: { xs: "62vh", md: "68vh" },
            pr: 0.5,
          }}
        >
          {timeline.map((item) => (
            <EventLine key={item.id} item={item} />
          ))}
        </Box>
      )}
    </Stack>
  );
}

function MarkdownViewer({ content }: { content: string }): JSX.Element {
  return (
    <Box
      sx={{
        "& pre": { overflowX: "auto", m: 0 },
        "& code": { fontSize: "0.86rem" },
        "& p": { lineHeight: 1.65 },
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className ?? "");
            if (match?.[1]) {
              return (
                <SyntaxHighlighter language={match[1]} style={oneLight} PreTag="div">
                  {String(children).replace(/\n$/, "")}
                </SyntaxHighlighter>
              );
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </Box>
  );
}

function ArtifactViewer({
  artifact,
  threadId,
  liveContent,
}: {
  artifact: ArtifactDto | undefined;
  threadId: string;
  liveContent: string | undefined;
}): JSX.Element {
  const contentQuery = useQuery({
    queryKey: ["artifact", threadId, artifact?.id],
    queryFn: () => api.getArtifact(threadId, artifact?.id ?? ""),
    enabled: Boolean(artifact && !artifact.id.startsWith("live-artifact-")),
  });

  const content: ArtifactContentDto | undefined =
    liveContent && artifact
      ? { ...artifact, content: liveContent, contentType: artifact.kind === "diff" ? "diff" : "markdown" }
      : contentQuery.data;

  if (!artifact) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary">
          Select an artifact to inspect its contents.
        </Typography>
      </Box>
    );
  }

  if (contentQuery.isLoading && !content) {
    return (
      <Box sx={{ p: 2 }}>
        <CircularProgress size={22} />
      </Box>
    );
  }

  if (!content) {
    return (
      <Alert severity="warning" sx={{ m: 1.5 }}>
        Artifact content is not available yet.
      </Alert>
    );
  }

  return (
    <Box sx={{ p: 1.5, minWidth: 0 }}>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        {content.summary ?? content.path}
      </Typography>
      <Paper variant="outlined" sx={{ p: 1.25, overflow: "auto", maxHeight: { xs: "55vh", md: "64vh" } }}>
        {content.contentType === "markdown" ? (
          <MarkdownViewer content={content.content} />
        ) : (
          <SyntaxHighlighter language="diff" style={oneLight} PreTag="div">
            {content.content}
          </SyntaxHighlighter>
        )}
      </Paper>
    </Box>
  );
}

export function ArtifactsPane({
  artifacts,
  threadId,
  timeline,
}: {
  artifacts: ArtifactDto[];
  threadId: string;
  timeline: ExecutionItem[];
}): JSX.Element {
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | undefined>(artifacts[0]?.id);

  useEffect(() => {
    if (!selectedArtifactId || !artifacts.some((artifact) => artifact.id === selectedArtifactId)) {
      setSelectedArtifactId(artifacts[0]?.id);
    }
  }, [artifacts, selectedArtifactId]);

  const selectedArtifact = artifacts.find((artifact) => artifact.id === selectedArtifactId);
  const liveSeq = selectedArtifact?.id.startsWith("live-artifact-")
    ? Number(selectedArtifact.id.replace("live-artifact-", ""))
    : undefined;
  const liveEvent = timeline.find((item) => item.seq === liveSeq)?.event;
  const liveContent =
    liveEvent?.type === "file_change"
      ? (liveEvent.diff ?? `No diff body for ${liveEvent.path}.`)
      : liveEvent?.type === "test_result"
        ? `## Test result\n\n${liveEvent.summary}`
        : undefined;

  if (artifacts.length === 0) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="info">No artifacts yet. Diffs, test reports, and logs appear here.</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ display: "grid", gridTemplateRows: "auto 1fr", minHeight: 0, pb: 3 }}>
      <Tabs
        value={selectedArtifactId ?? false}
        onChange={(_event, value: string) => setSelectedArtifactId(value)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ borderBottom: 1, borderColor: "divider", minHeight: 44 }}
      >
        {artifacts.map((artifact) => (
          <Tab
            key={artifact.id}
            value={artifact.id}
            icon={artifactIcon(artifact.kind)}
            iconPosition="start"
            label={artifact.summary ?? compactPath(artifact.path)}
            sx={{ minHeight: 44, maxWidth: 260 }}
          />
        ))}
      </Tabs>
      <ArtifactViewer artifact={selectedArtifact} threadId={threadId} liveContent={liveContent} />
    </Box>
  );
}

export function Composer({
  disabled,
  running,
  placeholder,
  mentionHandles,
  busyMentionHandles,
  allowUnmentionedSend = true,
  onSend,
  onCancel,
  replyTo,
  onCancelReply,
  replyLabel,
}: {
  disabled: boolean;
  running: boolean;
  placeholder?: string;
  /** When provided, typing `@` autocompletes these agent handles (group chat). */
  mentionHandles?: string[];
  /** Mentioned agents that cannot accept a new turn yet. */
  busyMentionHandles?: string[];
  /** Whether text without a valid mention may be submitted. */
  allowUnmentionedSend?: boolean;
  onSend(text: string, files: File[]): Promise<unknown> | unknown;
  onCancel?(): void;
  replyTo?: { text: string };
  onCancelReply?(): void;
  replyLabel?: string;
}): JSX.Element {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Array<{ file: File; preview: string }>>([]);
  const [sendError, setSendError] = useState<string>();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [highlighted, setHighlighted] = useState(0);
  const [suppressMenu, setSuppressMenu] = useState(false);
  const mentionListId = useId();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const mentionedHandles = findMentionedHandles(text, mentionHandles ?? []);
  const busyHandles = new Set((busyMentionHandles ?? []).map((handle) => handle.toLocaleLowerCase()));
  const mentionedBusyHandles = mentionedHandles.filter((handle) => busyHandles.has(handle.toLocaleLowerCase()));
  const textCanSend = canSubmitComposerText({
    text,
    disabled,
    running,
    allowUnmentionedSend,
    mentionedHandles,
    mentionedBusyHandles,
  });
  const canSend = textCanSend || (!disabled && !running && allowUnmentionedSend && files.length > 0);
  const canCancel = running && Boolean(onCancel);

  const update = (next: string) => {
    setText(next);
  };

  // The `@partial` token immediately left of the caret, if any.
  const mentionMatch = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u.exec(text.slice(0, caret));
  const suggestions =
    mentionMatch && mentionHandles && mentionHandles.length > 0
      ? mentionHandles
          .filter((handle) => handle.toLowerCase().startsWith(mentionMatch[1]!.toLowerCase()))
          .slice(0, 6)
      : [];
  const menuOpen = suggestions.length > 0 && !suppressMenu;

  const applyMention = (handle: string) => {
    const start = caret - mentionMatch![0].length + mentionMatch![0].indexOf("@");
    const next = `${text.slice(0, start)}@${handle} ${text.slice(caret)}`;
    update(next);
    setHighlighted(0);
    // Restore focus and place the caret after the inserted handle.
    const nextCaret = start + handle.length + 2;
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(nextCaret, nextCaret);
        setCaret(nextCaret);
      }
    });
  };

  const send = () => {
    setSendError(undefined);
    void Promise.resolve(onSend(text.trim(), files.map((item) => item.file))).then(() => {
      update("");
      files.forEach((item) => URL.revokeObjectURL(item.preview));
      setFiles([]);
      setCaret(0);
    }).catch((error: unknown) => setSendError(error instanceof Error ? error.message : "Upload failed; try again."));
  };

  return (
    <Paper
      square
      elevation={3}
      sx={{
        position: "sticky",
        bottom: 0,
        zIndex: 3,
        borderTop: 1,
        borderColor: "divider",
        px: { xs: 0.75, sm: 1 },
        pt: { xs: 0.75, sm: 1 },
        pb: "max(8px, env(safe-area-inset-bottom))",
      }}
    >
      {replyTo ? (
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1, px: 0.5 }}>
          <Box sx={{ minWidth: 0, flex: 1, borderLeft: 3, borderColor: "primary.main", pl: 1 }}>
            <Typography variant="caption" color="text.secondary">{replyLabel ?? "Replying to"}</Typography>
            <Typography variant="body2" noWrap>{replyTo.text}</Typography>
          </Box>
          <IconButton aria-label="Cancel reply" size="small" onClick={onCancelReply}><CloseIcon fontSize="small" /></IconButton>
        </Stack>
      ) : null}
      {files.length > 0 ? <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mb: 1 }}>
        {files.map((item, index) => <Box key={`${item.file.name}-${index}`} sx={{ position: "relative" }}>
          <Box component="a" href={item.preview} target="_blank" rel="noreferrer" aria-label={`Open ${item.file.name}`}>
            <Box component="img" src={item.preview} alt="" sx={{ width: 72, height: 72, objectFit: "cover", borderRadius: 1 }} />
          </Box>
          <IconButton size="small" aria-label={`Remove ${item.file.name}`} onClick={() => { URL.revokeObjectURL(item.preview); setFiles((current) => current.filter((_, i) => i !== index)); }} sx={{ position: "absolute", right: -8, top: -8, bgcolor: "background.paper" }}><CloseIcon fontSize="small" /></IconButton>
        </Box>)}
      </Stack> : null}
      {sendError ? <Alert severity="error" sx={{ mb: 1 }}>Message not sent. {sendError}</Alert> : null}
      <Stack direction="row" spacing={{ xs: 0.25, sm: 1 }} sx={{ alignItems: "flex-end" }}>
        <input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={(event) => {
          const selected = Array.from(event.target.files ?? []).slice(0, 4 - files.length);
          const valid = selected.filter((file) => file.size <= 8 * 1024 * 1024);
          setFiles((current) => [...current, ...valid.map((file) => ({ file, preview: URL.createObjectURL(file) }))]);
          event.target.value = "";
        }} />
        <Tooltip title="Attach images (PNG, JPEG, GIF, or WebP; 8 MiB each)"><span><IconButton aria-label="Attach images" disabled={disabled || running || files.length >= 4} onClick={() => fileInput.current?.click()} sx={{ minWidth: 44, minHeight: 44 }}><AttachFileIcon /></IconButton></span></Tooltip>
        <Box ref={anchorRef} sx={{ flex: 1, minWidth: 0 }}>
          <TextField
            fullWidth
            multiline
            minRows={1}
            maxRows={5}
            sx={{ "& .MuiInputBase-root": { alignItems: "flex-end" } }}
            value={text}
            inputRef={inputRef}
            disabled={disabled || running}
            placeholder={running ? "Agent is working" : (placeholder ?? "Send a message")}
            inputProps={{
              "aria-label": "Message",
              enterKeyHint: "send",
              role: mentionHandles ? "combobox" : undefined,
              "aria-autocomplete": mentionHandles ? "list" : undefined,
              "aria-expanded": mentionHandles ? menuOpen : undefined,
              "aria-controls": menuOpen ? mentionListId : undefined,
              "aria-activedescendant": menuOpen ? `${mentionListId}-option-${highlighted}` : undefined,
            }}
            onChange={(event) => {
              update(event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
              setHighlighted(0);
              setSuppressMenu(false);
            }}
            onClick={(event) => setCaret((event.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onKeyUp={(event) => setCaret((event.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onKeyDown={(event) => {
              if (shouldIgnoreComposerKey({ key: event.key, isComposing: event.nativeEvent.isComposing })) {
                return;
              }
              if (menuOpen && event.key === "ArrowDown") {
                event.preventDefault();
                setHighlighted((index) => (index + 1) % suggestions.length);
                return;
              }
              if (menuOpen && event.key === "ArrowUp") {
                event.preventDefault();
                setHighlighted((index) => (index - 1 + suggestions.length) % suggestions.length);
                return;
              }
              if (menuOpen && (event.key === "Enter" || event.key === "Tab") && !event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                applyMention(suggestions[highlighted]!);
                return;
              }
              if (menuOpen && event.key === "Escape") {
                event.preventDefault();
                setSuppressMenu(true);
                return;
              }
              if (shouldSendComposerKey({
                key: event.key,
                shiftKey: event.shiftKey,
                isComposing: event.nativeEvent.isComposing,
                repeat: event.repeat,
              }) && canSend) {
                event.preventDefault();
                send();
              }
            }}
          />
          {mentionedHandles.length > 0 ? (
            <Typography variant="caption" color={mentionedBusyHandles.length > 0 ? "warning.main" : "text.secondary"}>
              {mentionedBusyHandles.length > 0
                ? `${mentionedBusyHandles.map((handle) => `@${handle}`).join(", ")} ${mentionedBusyHandles.length > 1 ? "are" : "is"} busy — your message will be queued.`
                : mentionedHandles.some((handle) => handle.toLocaleLowerCase() === "everyone")
                  ? "Notifying every eligible agent in this collaboration room"
                  : `Replying to ${mentionedHandles.map((handle) => `@${handle}`).join(", ")}`}
            </Typography>
          ) : null}
          <Popper open={menuOpen} anchorEl={anchorRef.current} placement="top-start" style={{ zIndex: 1400 }}>
            <ClickAwayListener onClickAway={() => setSuppressMenu(true)}>
              <Paper elevation={4} sx={{ mb: 0.5, minWidth: 180 }}>
                <MenuList dense id={mentionListId} role="listbox" aria-label="Agent mentions">
                  {suggestions.map((handle, index) => (
                    <MenuItem
                      key={handle}
                      id={`${mentionListId}-option-${index}`}
                      role="option"
                      aria-selected={index === highlighted}
                      selected={index === highlighted}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        applyMention(handle);
                      }}
                    >
                      @{handle}
                    </MenuItem>
                  ))}
                </MenuList>
              </Paper>
            </ClickAwayListener>
          </Popper>
        </Box>
        {canCancel ? (
          <Tooltip title="Cancel run">
            <IconButton color="error" onClick={onCancel} aria-label="Cancel run" sx={{ minWidth: 44, minHeight: 44 }}>
              <StopCircleIcon />
            </IconButton>
          </Tooltip>
        ) : (
          <Tooltip title="Send">
            <span>
              <IconButton color="primary" disabled={!canSend} onClick={send} aria-label={mentionedBusyHandles.length > 0 ? "Queue message" : "Send message"} sx={{ minWidth: 44, minHeight: 44 }}>
                <SendIcon />
              </IconButton>
            </span>
          </Tooltip>
        )}
      </Stack>
    </Paper>
  );
}
