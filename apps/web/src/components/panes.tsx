import ArticleIcon from "@mui/icons-material/Article";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import DifferenceIcon from "@mui/icons-material/Difference";
import SendIcon from "@mui/icons-material/Send";
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
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import type { ExecutionItem } from "../hooks/useThreadStream";

export function taskStatusLabel(status: TaskDto["status"]): string {
  if (status === "waiting_approval") {
    return "Waiting";
  }
  return status[0] ? `${status[0].toUpperCase()}${status.slice(1)}` : status;
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

export function ChatPane({ messages }: { messages: MessageDto[] }): JSX.Element {
  const chatMessages = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );

  return (
    <Stack spacing={1.25} sx={{ p: 1.5, pb: 3, minHeight: 0 }}>
      {chatMessages.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Send a message to this agent to start the conversation.
        </Typography>
      ) : null}
      {chatMessages.map((message) => (
        <Box
          key={message.id}
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
          }}
        >
          <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {message.text}
          </Typography>
        </Box>
      ))}
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
  onSend,
  onCancel,
  onChangeText,
}: {
  disabled: boolean;
  running: boolean;
  placeholder?: string;
  /** When provided, typing `@` autocompletes these agent handles (group chat). */
  mentionHandles?: string[];
  onSend(text: string): void;
  onCancel?(): void;
  onChangeText?(text: string): void;
}): JSX.Element {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [highlighted, setHighlighted] = useState(0);
  const [suppressMenu, setSuppressMenu] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const canSend = text.trim().length > 0 && !disabled && !running;
  const canCancel = running && Boolean(onCancel);

  const update = (next: string) => {
    setText(next);
    onChangeText?.(next);
  };

  // The `@partial` token immediately left of the caret, if any.
  const mentionMatch = /(?:^|\s)@(\w*)$/.exec(text.slice(0, caret));
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
    onSend(text.trim());
    update("");
    setCaret(0);
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
        p: 1,
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: "flex-end" }}>
        <Box ref={anchorRef} sx={{ flex: 1 }}>
          <TextField
            fullWidth
            multiline
            minRows={1}
            maxRows={5}
            value={text}
            inputRef={inputRef}
            disabled={disabled || running}
            placeholder={running ? "Agent is working" : (placeholder ?? "Send a message")}
            onChange={(event) => {
              update(event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
              setHighlighted(0);
              setSuppressMenu(false);
            }}
            onClick={(event) => setCaret((event.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onKeyUp={(event) => setCaret((event.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onKeyDown={(event) => {
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
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSend) {
                event.preventDefault();
                send();
              }
            }}
          />
          <Popper open={menuOpen} anchorEl={anchorRef.current} placement="top-start" style={{ zIndex: 1400 }}>
            <ClickAwayListener onClickAway={() => setSuppressMenu(true)}>
              <Paper elevation={4} sx={{ mb: 0.5, minWidth: 180 }}>
                <MenuList dense>
                  {suggestions.map((handle, index) => (
                    <MenuItem
                      key={handle}
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
            <IconButton color="error" onClick={onCancel} aria-label="Cancel run">
              <StopCircleIcon />
            </IconButton>
          </Tooltip>
        ) : (
          <Tooltip title="Send">
            <span>
              <IconButton color="primary" disabled={!canSend} onClick={send} aria-label="Send message">
                <SendIcon />
              </IconButton>
            </span>
          </Tooltip>
        )}
      </Stack>
    </Paper>
  );
}
