import AccountTreeIcon from "@mui/icons-material/AccountTree";
import AddIcon from "@mui/icons-material/Add";
import ArticleIcon from "@mui/icons-material/Article";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DifferenceIcon from "@mui/icons-material/Difference";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import HourglassEmptyIcon from "@mui/icons-material/HourglassEmpty";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import SendIcon from "@mui/icons-material/Send";
import StopCircleIcon from "@mui/icons-material/StopCircle";
import TerminalIcon from "@mui/icons-material/Terminal";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import {
  Alert,
  AppBar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  LinearProgress,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  Toolbar,
  Tooltip,
  Typography,
  useMediaQuery,
} from "@mui/material";
import type { SelectChangeEvent } from "@mui/material/Select";
import { useTheme } from "@mui/material/styles";
import type {
  ArtifactContentDto,
  ArtifactDto,
  EngineDto,
  MessageDto,
  ProjectDto,
  TaskDto,
  ThreadDetailDto,
  ThreadDto,
} from "@ponderosa/core";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import { api } from "./api";
import type { ExecutionItem } from "./hooks/useThreadStream";
import { useThreadStream } from "./hooks/useThreadStream";
import { useSendMessage } from "./hooks/useSendMessage";

type PaneId = "chat" | "tasks" | "artifacts";

const paneOrder: PaneId[] = ["chat", "tasks", "artifacts"];

function statusLabel(status: TaskDto["status"]): string {
  if (status === "waiting_approval") {
    return "Waiting";
  }
  return status[0] ? `${status[0].toUpperCase()}${status.slice(1)}` : status;
}

function statusColor(status: TaskDto["status"]): "success" | "warning" | "info" {
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

function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
}

function useThreads(projectId: string | undefined) {
  return useQuery({
    queryKey: ["threads", projectId],
    queryFn: () => api.listThreads(projectId ?? ""),
    enabled: Boolean(projectId),
  });
}

function useThread(threadId: string | undefined) {
  return useQuery({
    queryKey: ["thread", threadId],
    queryFn: () => api.getThread(threadId ?? ""),
    enabled: Boolean(threadId),
  });
}

function useEngines() {
  return useQuery({
    queryKey: ["engines"],
    queryFn: () => api.listEngines(),
  });
}

function Dashboard({ details }: { details: Array<ThreadDetailDto | undefined> }): JSX.Element {
  const tasks = details.flatMap((detail) => detail?.tasks ?? []);
  const running = tasks.filter((task) => task.status === "running").length;
  const waiting = tasks.filter((task) => task.status === "waiting_approval").length;
  const done = tasks.filter((task) => task.status === "done").length;
  const active = running + waiting;

  return (
    <Stack
      direction="row"
      spacing={1}
      useFlexGap
      flexWrap="wrap"
      sx={{ alignItems: "center", px: { xs: 1.5, md: 2 }, py: 1 }}
    >
      <Chip icon={<PlayArrowIcon />} label={`${active} active`} color={active ? "primary" : "default"} />
      <Chip icon={<HourglassEmptyIcon />} label={`${running} running`} variant="outlined" />
      <Chip icon={<WarningAmberIcon />} label={`${waiting} waiting`} variant="outlined" color="warning" />
      <Chip icon={<CheckCircleOutlineIcon />} label={`${done} done`} variant="outlined" color="success" />
    </Stack>
  );
}

function ProjectTabs({
  projects,
  selectedProjectId,
  onSelect,
  onCreate,
}: {
  projects: ProjectDto[];
  selectedProjectId: string | undefined;
  onSelect(projectId: string): void;
  onCreate(): void;
}): JSX.Element {
  return (
    <Stack direction="row" sx={{ alignItems: "center", borderBottom: 1, borderColor: "divider" }}>
      <Tabs
        value={selectedProjectId ?? false}
        onChange={(_event, value: string) => onSelect(value)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ minHeight: 48, flex: 1, minWidth: 0 }}
      >
        {projects.map((project) => (
          <Tab
            key={project.id}
            value={project.id}
            icon={<FolderOpenIcon />}
            iconPosition="start"
            label={project.label}
            sx={{ minHeight: 48 }}
          />
        ))}
      </Tabs>
      <Tooltip title="New project">
        <IconButton onClick={onCreate} aria-label="New project" sx={{ mx: 1 }}>
          <AddIcon />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}

function ThreadList({
  threads,
  selectedThreadId,
  onSelect,
  onCreate,
  onDelete,
}: {
  threads: ThreadDto[];
  selectedThreadId: string | undefined;
  onSelect(threadId: string): void;
  onCreate(): void;
  onDelete(thread: ThreadDto): void;
}): JSX.Element {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Stack direction="row" sx={{ alignItems: "center", px: 1, py: 0.5 }}>
        <Typography variant="overline" color="text.secondary" sx={{ flex: 1, px: 1 }}>
          Threads
        </Typography>
        <Tooltip title="New thread">
          <IconButton size="small" onClick={onCreate} aria-label="New thread">
            <AddIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      <List dense disablePadding>
        {threads.map((thread) => (
          <ListItem
            key={thread.id}
            disablePadding
            sx={{ mb: 0.5 }}
            secondaryAction={
              <Tooltip title="Delete thread">
                <IconButton
                  edge="end"
                  size="small"
                  aria-label={`Delete thread ${thread.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(thread);
                  }}
                >
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            }
          >
            <ListItemButton
              selected={thread.id === selectedThreadId}
              onClick={() => onSelect(thread.id)}
              sx={{ alignItems: "flex-start", borderRadius: 1, mx: 1, pr: 6 }}
            >
              <ListItemText
                primary={thread.title}
                secondary={[thread.state.branch, thread.state.commit].filter(Boolean).join(" · ")}
                primaryTypographyProps={{ fontWeight: 700, noWrap: true }}
                secondaryTypographyProps={{ noWrap: true }}
              />
            </ListItemButton>
          </ListItem>
        ))}
      </List>
    </Box>
  );
}

function ThreadHeader({
  detail,
  engines,
  model,
  effort,
  streamConnected,
  running,
  lastSeq,
  onModelChange,
  onEffortChange,
}: {
  detail: ThreadDetailDto;
  engines: EngineDto[];
  model: string;
  effort: string;
  streamConnected: boolean;
  running: boolean;
  lastSeq?: number;
  onModelChange(value: string): void;
  onEffortChange(value: string): void;
}): JSX.Element {
  const engine = engines.find((candidate) => candidate.id === detail.thread.activeEngine) ?? engines[0];
  const models = engine?.models ?? [];
  const efforts = engine?.efforts ?? [];

  return (
    <Box sx={{ px: { xs: 1.5, md: 2 }, py: 1.25, borderBottom: 1, borderColor: "divider" }}>
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="h6" noWrap>
              {detail.thread.title}
            </Typography>
            <Typography variant="body2" color="text.secondary" noWrap>
              {detail.state.branch ?? "No branch"} {detail.state.commit ? `· ${detail.state.commit}` : ""}
            </Typography>
          </Box>
          <Chip
            size="small"
            label={streamConnected ? "Live" : "Reconnecting"}
            color={streamConnected ? "success" : "warning"}
            variant={streamConnected ? "filled" : "outlined"}
          />
          {lastSeq !== undefined ? <Chip size="small" label={`seq ${lastSeq}`} variant="outlined" /> : null}
        </Stack>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
          <Chip
            icon={<AccountTreeIcon />}
            label={`${engine?.displayName ?? detail.thread.activeEngine}${engine?.authenticated ? "" : " not signed in"}`}
            color={engine?.authenticated ? "default" : "warning"}
            sx={{ justifyContent: "flex-start", minHeight: 40 }}
          />
          <FormControl size="small" sx={{ minWidth: { xs: "100%", sm: 180 } }}>
            <InputLabel id="model-label">Model</InputLabel>
            <Select
              labelId="model-label"
              value={model}
              label="Model"
              onChange={(event: SelectChangeEvent) => onModelChange(event.target.value)}
            >
              {!models.some((option) => option.id === "") ? (
                <MenuItem value="">Codex default</MenuItem>
              ) : null}
              {models.map((option) => (
                <MenuItem key={option.id} value={option.id}>
                  {option.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: { xs: "100%", sm: 140 } }}>
            <InputLabel id="effort-label">Effort</InputLabel>
            <Select
              labelId="effort-label"
              value={effort}
              label="Effort"
              onChange={(event: SelectChangeEvent) => onEffortChange(event.target.value)}
            >
              <MenuItem value="">Codex default</MenuItem>
              {efforts.map((option) => (
                <MenuItem key={option.id} value={option.id}>
                  {option.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Stack>
      </Stack>
      {running ? <LinearProgress sx={{ mt: 1 }} /> : null}
    </Box>
  );
}

function ChatPane({ messages }: { messages: MessageDto[] }): JSX.Element {
  const chatMessages = messages.filter((message) => message.role === "user" || message.role === "assistant");

  return (
    <Stack spacing={1.25} sx={{ p: 1.5, pb: 10, minHeight: 0 }}>
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
          {message.role === "assistant" ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.75 }}>
              See task details →
            </Typography>
          ) : null}
        </Box>
      ))}
    </Stack>
  );
}

function EventLine({ item }: { item: ExecutionItem }): JSX.Element {
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

function TasksPane({ tasks, timeline }: { tasks: TaskDto[]; timeline: ExecutionItem[] }): JSX.Element {
  return (
    <Stack spacing={1.25} sx={{ p: 1.5, pb: 10 }}>
      {tasks.length === 0 ? (
        <Alert severity="info">No execution tasks yet.</Alert>
      ) : (
        tasks.map((task) => (
          <Paper key={task.id} variant="outlined" sx={{ p: 1.25 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 0 }} noWrap>
                {task.title}
              </Typography>
              <Chip size="small" label={statusLabel(task.status)} color={statusColor(task.status)} />
            </Stack>
            <Typography variant="caption" color="text.secondary">
              {task.engine} · {new Date(task.updatedAt).toLocaleTimeString()}
            </Typography>
          </Paper>
        ))
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
        timeline.map((item) => <EventLine key={item.id} item={item} />)
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

function ArtifactsPane({
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

  return (
    <Box sx={{ display: "grid", gridTemplateRows: "auto 1fr", minHeight: 0, pb: 10 }}>
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

function ThreadPanes({
  detail,
  pane,
  onPaneChange,
  timeline,
}: {
  detail: ThreadDetailDto;
  pane: PaneId;
  onPaneChange(pane: PaneId): void;
  timeline: ExecutionItem[];
}): JSX.Element {
  const theme = useTheme();
  const compact = useMediaQuery(theme.breakpoints.down("lg"));

  const panes: Record<PaneId, JSX.Element> = {
    chat: <ChatPane messages={detail.messages} />,
    tasks: <TasksPane tasks={detail.tasks} timeline={timeline} />,
    artifacts: <ArtifactsPane artifacts={detail.artifacts} threadId={detail.thread.id} timeline={timeline} />,
  };

  if (compact) {
    return (
      <Box sx={{ minHeight: 0, display: "grid", gridTemplateRows: "auto 1fr" }}>
        <Tabs
          value={pane}
          onChange={(_event, value: PaneId) => onPaneChange(value)}
          variant="fullWidth"
          sx={{ borderBottom: 1, borderColor: "divider", minHeight: 48 }}
        >
          <Tab value="chat" icon={<ChatBubbleOutlineIcon />} label="Chat" sx={{ minHeight: 48 }} />
          <Tab value="tasks" icon={<TerminalIcon />} label="Tasks" sx={{ minHeight: 48 }} />
          <Tab value="artifacts" icon={<DifferenceIcon />} label="Artifacts" sx={{ minHeight: 48 }} />
        </Tabs>
        <Box sx={{ minHeight: 0, overflow: "auto" }}>{panes[pane]}</Box>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        minHeight: 0,
        overflow: "hidden",
        display: "grid",
        gridTemplateColumns: "minmax(320px, 1.1fr) minmax(280px, 0.9fr) minmax(320px, 1fr)",
      }}
    >
      {paneOrder.map((paneId) => (
        <Box key={paneId} sx={{ minHeight: 0, overflow: "auto", borderRight: paneId === "artifacts" ? 0 : 1, borderColor: "divider" }}>
          {panes[paneId]}
        </Box>
      ))}
    </Box>
  );
}

function Composer({
  disabled,
  running,
  onSend,
  onCancel,
}: {
  disabled: boolean;
  running: boolean;
  onSend(text: string): void;
  onCancel(): void;
}): JSX.Element {
  const [text, setText] = useState("");

  const canSend = text.trim().length > 0 && !disabled && !running;

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
        <TextField
          fullWidth
          multiline
          minRows={1}
          maxRows={5}
          value={text}
          disabled={disabled || running}
          placeholder={running ? "Agent is working" : "Send intent to the active agent"}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSend) {
              onSend(text.trim());
              setText("");
            }
          }}
        />
        {running ? (
          <Tooltip title="Cancel run">
            <IconButton color="error" onClick={onCancel} aria-label="Cancel run">
              <StopCircleIcon />
            </IconButton>
          </Tooltip>
        ) : (
          <Tooltip title="Send">
            <span>
              <IconButton
                color="primary"
                disabled={!canSend}
                onClick={() => {
                  onSend(text.trim());
                  setText("");
                }}
                aria-label="Send message"
              >
                <SendIcon />
              </IconButton>
            </span>
          </Tooltip>
        )}
      </Stack>
    </Paper>
  );
}

export default function App(): JSX.Element {
  const queryClient = useQueryClient();
  const projectsQuery = useProjects();
  const enginesQuery = useEngines();
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>();
  const threadsQuery = useThreads(selectedProjectId);
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>();
  const threadQuery = useThread(selectedThreadId);
  const stream = useThreadStream(selectedThreadId);
  const sendMessage = useSendMessage(selectedThreadId);
  const [selectedPane, setSelectedPane] = useState<PaneId>("chat");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectLabel, setProjectLabel] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [threadDialogOpen, setThreadDialogOpen] = useState(false);
  const [threadTitle, setThreadTitle] = useState("");
  const [threadPendingDelete, setThreadPendingDelete] = useState<ThreadDto | undefined>();
  const detail = threadQuery.data;
  const threads = threadsQuery.data ?? [];

  useEffect(() => {
    if (!selectedProjectId && projectsQuery.data?.[0]) {
      setSelectedProjectId(projectsQuery.data[0].id);
    }
  }, [projectsQuery.data, selectedProjectId]);

  useEffect(() => {
    if (!selectedThreadId && threadsQuery.data?.[0]) {
      setSelectedThreadId(threadsQuery.data[0].id);
    }
  }, [threadsQuery.data, selectedThreadId]);

  useEffect(() => {
    const engine = enginesQuery.data?.find((candidate) => candidate.id === detail?.thread.activeEngine) ?? enginesQuery.data?.[0];
    if (!engine) {
      setModel("");
      setEffort("");
      return;
    }
    setModel((current) =>
      current === "" || engine.models.some((option) => option.id === current) ? current : "",
    );
    setEffort((current) =>
      current === "" || engine.efforts.some((option) => option.id === current) ? current : "",
    );
  }, [detail?.thread.activeEngine, enginesQuery.data]);

  const projectThreadDetails = useQueries({
    queries:
      threadsQuery.data?.map((thread) => ({
        queryKey: ["thread", thread.id],
        queryFn: () => api.getThread(thread.id),
        staleTime: 15_000,
      })) ?? [],
  });

  const dashboardDetails = useMemo(
    () => projectThreadDetails.map((query) => query.data),
    [projectThreadDetails],
  );

  const cancelRun = useMutation({
    mutationFn: async () => {
      if (!selectedThreadId) {
        return;
      }
      await api.cancelRun(selectedThreadId);
    },
    onSettled: () => {
      if (selectedThreadId) {
        void queryClient.invalidateQueries({ queryKey: ["thread", selectedThreadId] });
      }
    },
  });

  const createProject = useMutation({
    mutationFn: () =>
      api.createProject({
        label: projectLabel.trim(),
        hostPath: projectPath.trim(),
      }),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      setSelectedProjectId(project.id);
      setSelectedThreadId(undefined);
      setProjectDialogOpen(false);
      setProjectLabel("");
      setProjectPath("");
    },
  });

  const createThread = useMutation({
    mutationFn: () => {
      if (!selectedProjectId) {
        throw new Error("No project selected");
      }
      const engine = detail?.thread.activeEngine ?? enginesQuery.data?.[0]?.id ?? "codex";
      return api.createThread(selectedProjectId, {
        title: threadTitle.trim(),
        engine,
        model: model || undefined,
        effort: effort || undefined,
      });
    },
    onSuccess: (thread) => {
      void queryClient.invalidateQueries({ queryKey: ["threads", thread.projectId] });
      setSelectedThreadId(thread.id);
      setThreadDialogOpen(false);
      setThreadTitle("");
    },
  });

  const deleteThread = useMutation({
    mutationFn: (threadId: string) => api.deleteThread(threadId),
    onSuccess: (_data, threadId) => {
      void queryClient.invalidateQueries({ queryKey: ["threads", selectedProjectId] });
      queryClient.removeQueries({ queryKey: ["thread", threadId] });
      if (selectedThreadId === threadId) {
        const remaining = threads.filter((thread) => thread.id !== threadId);
        setSelectedThreadId(remaining[0]?.id);
      }
      setThreadPendingDelete(undefined);
    },
  });

  const loading = projectsQuery.isLoading || threadsQuery.isLoading || threadQuery.isLoading;

  return (
    <Box sx={{ minHeight: "100vh", display: "grid", gridTemplateRows: "auto 1fr", bgcolor: "background.default" }}>
      <AppBar position="static" color="inherit" elevation={0} sx={{ borderBottom: 1, borderColor: "divider" }}>
        <Toolbar sx={{ minHeight: 56 }}>
          <Typography variant="h6" component="h1" sx={{ fontWeight: 800, flex: 1 }}>
            Ponderosa
          </Typography>
          <Chip
            size="small"
            label={enginesQuery.data?.some((engine) => engine.authenticated) ? "Engine ready" : "Engine auth needed"}
            color={enginesQuery.data?.some((engine) => engine.authenticated) ? "success" : "warning"}
            variant="outlined"
          />
        </Toolbar>
        <ProjectTabs
          projects={projectsQuery.data ?? []}
          selectedProjectId={selectedProjectId}
          onCreate={() => setProjectDialogOpen(true)}
          onSelect={(projectId) => {
            setSelectedProjectId(projectId);
            setSelectedThreadId(undefined);
          }}
        />
      </AppBar>

      <Box
        sx={{
          minHeight: 0,
          display: "grid",
          gridTemplateRows: "auto 1fr",
        }}
      >
        <Dashboard details={dashboardDetails} />
        <Box
          sx={{
            minHeight: 0,
            display: "grid",
            gridTemplateColumns: { xs: "1fr", md: "260px 1fr" },
            gap: 0,
          }}
        >
          <Box
            sx={{
              borderRight: { md: 1 },
              borderBottom: { xs: 1, md: 0 },
              borderColor: "divider",
              overflow: "auto",
              maxHeight: { xs: 180, md: "none" },
              bgcolor: "background.paper",
            }}
          >
            <ThreadList
              threads={threads}
              selectedThreadId={selectedThreadId}
              onSelect={setSelectedThreadId}
              onCreate={() => setThreadDialogOpen(true)}
              onDelete={setThreadPendingDelete}
            />
          </Box>

          <Box sx={{ minHeight: 0, display: "grid", gridTemplateRows: "auto 1fr auto", bgcolor: "#fbfcf8" }}>
            {loading ? <LinearProgress /> : null}
            {!loading && !detail ? (
              <Box sx={{ p: 2 }}>
                <Alert severity="info">Select a thread to start working.</Alert>
              </Box>
            ) : null}
            {detail ? (
              <>
                <ThreadHeader
                  detail={detail}
                  engines={enginesQuery.data ?? []}
                  model={model}
                  effort={effort}
                  streamConnected={stream.connected}
                  running={stream.running || sendMessage.isPending}
                  lastSeq={stream.lastSeq}
                  onModelChange={setModel}
                  onEffortChange={setEffort}
                />
                <ThreadPanes
                  detail={detail}
                  pane={selectedPane}
                  onPaneChange={setSelectedPane}
                  timeline={stream.timeline}
                />
                <Composer
                  disabled={!selectedThreadId}
                  running={stream.running || sendMessage.isPending}
                  onSend={(text) => {
                    sendMessage.mutate({ text, model: model || undefined, effort: effort || undefined });
                    setSelectedPane("chat");
                  }}
                  onCancel={() => cancelRun.mutate()}
                />
              </>
            ) : null}
          </Box>
        </Box>
      </Box>

      <Dialog open={projectDialogOpen} onClose={() => setProjectDialogOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>New Project</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              label="Label"
              value={projectLabel}
              onChange={(event) => setProjectLabel(event.target.value)}
              autoFocus
              fullWidth
            />
            <TextField
              label="Host path"
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
              placeholder="/Users/you/Projects/app"
              fullWidth
            />
            {createProject.isError ? <Alert severity="error">{String(createProject.error.message)}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setProjectDialogOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!projectLabel.trim() || !projectPath.trim() || createProject.isPending}
            onClick={() => createProject.mutate()}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={threadDialogOpen} onClose={() => setThreadDialogOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>New Thread</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              label="Title"
              value={threadTitle}
              onChange={(event) => setThreadTitle(event.target.value)}
              autoFocus
              fullWidth
            />
            {createThread.isError ? <Alert severity="error">{String(createThread.error.message)}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setThreadDialogOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!selectedProjectId || !threadTitle.trim() || createThread.isPending}
            onClick={() => createThread.mutate()}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(threadPendingDelete)}
        onClose={() => {
          if (!deleteThread.isPending) setThreadPendingDelete(undefined);
        }}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Delete thread?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            This permanently deletes{" "}
            <Box component="strong">{threadPendingDelete?.title}</Box>, including its
            event log, tasks, and artifacts. This cannot be undone.
          </Typography>
          {deleteThread.isError ? (
            <Alert severity="error" sx={{ mt: 2 }}>
              {String(deleteThread.error.message)}
            </Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setThreadPendingDelete(undefined)}
            disabled={deleteThread.isPending}
          >
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={deleteThread.isPending}
            onClick={() => {
              if (threadPendingDelete) deleteThread.mutate(threadPendingDelete.id);
            }}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
