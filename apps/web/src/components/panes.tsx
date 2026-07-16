import ArticleIcon from "@mui/icons-material/Article";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import CheckIcon from "@mui/icons-material/Check";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DifferenceIcon from "@mui/icons-material/Difference";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ReplyIcon from "@mui/icons-material/Reply";
import RefreshIcon from "@mui/icons-material/Refresh";
import AttachFileIcon from "@mui/icons-material/AttachFile";
import CloseIcon from "@mui/icons-material/Close";
import StopCircleIcon from "@mui/icons-material/StopCircle";
import TerminalIcon from "@mui/icons-material/Terminal";
import {
  Alert,
  Box,
  Button,
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
import type { AgentActivityDto, AgentRunDto, AgentCoordinationV3Dto, ArtifactContentDto, ArtifactDto, ChangedFileDto, CommunicationDocumentReference, ConversationDraftConflictDto, DraftAttachmentDto, EngineCommand, FileEntryDto, MessageDto, WorkItemDto, RunOutputDto, VerifiedCitationDto } from "@ponderosa/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import { copyText } from "../clipboard";
import { readChatState, readScrollPosition, writeChatState } from "../chatState";
import type { ExecutionItem } from "../hooks/useAgentStream";
import { findMentionedHandles } from "../mentions";
import { MessageSenderLabel } from "./MessageSenderLabel";
import { CopyMessageButton } from "./CopyMessageButton";
import { MessageActionsAndTimestamp } from "./MessageTimestamp";
import { EmojiReactionPicker, MessageReactions } from "./EmojiReactionPicker";

export function workItemStatusLabel(status: WorkItemDto["status"]): string {
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

export function matchingEngineCommands(commands: EngineCommand[], prefix: string): EngineCommand[] {
  const normalized = prefix.toLocaleLowerCase();
  return commands.filter((command) => command.name.toLocaleLowerCase().startsWith(normalized));
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

export function shouldShowQueueControl(input: {
  text: string;
  agentResponding: boolean;
  disabled: boolean;
}): boolean {
  return input.agentResponding && !input.disabled && input.text.trim().length > 0;
}

const COMPOSER_ACCEPTED_MEDIA_TYPES = new Set([
  "image/png", "image/jpeg", "image/webp", "application/pdf",
  "text/plain", "application/json", "application/zip",
]);
const COMPOSER_MAX_FILES = 4;
const COMPOSER_MAX_FILE_BYTES = 8 * 1024 * 1024;
const COMPOSER_MAX_MESSAGE_BYTES = 24 * 1024 * 1024;

export function filesFromClipboard(
  items: ArrayLike<Pick<DataTransferItem, "kind" | "getAsFile">>,
  fallback: ArrayLike<File> = [],
): File[] {
  const extracted = Array.from(items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  return extracted.length > 0 ? extracted : Array.from(fallback);
}

export function selectComposerFiles(current: File[], candidates: File[]): { accepted: File[]; error?: string } {
  const accepted: File[] = [];
  let bytes = current.reduce((total, file) => total + file.size, 0);
  for (const file of candidates) {
    if (
      current.length + accepted.length < COMPOSER_MAX_FILES &&
      COMPOSER_ACCEPTED_MEDIA_TYPES.has(file.type) &&
      file.size <= COMPOSER_MAX_FILE_BYTES &&
      bytes + file.size <= COMPOSER_MAX_MESSAGE_BYTES
    ) {
      accepted.push(file);
      bytes += file.size;
    }
  }
  const rejected = candidates.length - accepted.length;
  return {
    accepted,
    error: rejected > 0
      ? `${rejected} pasted or selected ${rejected === 1 ? "file was" : "files were"} not attached. Use up to 4 supported files, 8 MiB each and 24 MiB total.`
      : undefined,
  };
}

type ComposerAttachmentState = { files: File[]; error?: string };
type ComposerAttachmentAction =
  | { type: "add"; candidates: File[] }
  | { type: "remove"; index: number }
  | { type: "replace"; files: File[]; error?: string }
  | { type: "clear" };

export function composerAttachmentReducer(
  state: ComposerAttachmentState,
  action: ComposerAttachmentAction,
): ComposerAttachmentState {
  if (action.type === "clear") return { files: [] };
  if (action.type === "remove") return { files: state.files.filter((_, index) => index !== action.index) };
  if (action.type === "replace") return { files: action.files, ...(action.error ? { error: action.error } : {}) };
  const selection = selectComposerFiles(state.files, action.candidates);
  return {
    files: selection.accepted.length > 0 ? [...state.files, ...selection.accepted] : state.files,
    error: selection.error,
  };
}

function ComposerAttachment({ file, onRemove }: { file: File; onRemove(): void }): JSX.Element {
  const [preview, setPreview] = useState<string>();
  useLayoutEffect(() => {
    if (!file.type.startsWith("image/")) return undefined;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <Box sx={{ position: "relative", minWidth: 0, maxWidth: 180 }}>
      {preview ? <Box component="a" href={preview} target="_blank" rel="noreferrer" aria-label={`Open ${file.name}`}>
        <Box component="img" src={preview} alt="" sx={{ width: 72, height: 72, objectFit: "cover", borderRadius: 1 }} />
      </Box> : <Typography variant="caption" sx={{ display: "block", p: 1, pr: 5, overflowWrap: "anywhere" }}>{file.name}<br />{file.size} bytes</Typography>}
      <IconButton size="small" aria-label={`Remove ${file.name}`} onClick={onRemove} sx={{ position: "absolute", right: 0, top: 0, bgcolor: "background.paper", minWidth: 44, minHeight: 44 }}><CloseIcon fontSize="small" /></IconButton>
    </Box>
  );
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
    case "managed_failure": return "Managed-agent failure";
  }
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

export function isLongChatMessage(text: string): boolean {
  return text.length > 1_600 || text.split("\n").length > 18;
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
      await copyText(codeBlockText(children).replace(/\n$/, ""));
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

interface MarkdownAstNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownAstNode[];
}

const MESSAGE_TAG_PREFIX = "#ponderosa-tag:";
const MESSAGE_TAG_PATTERN = /(^|[^\p{L}\p{N}_-])#([\p{L}\p{N}_-]+)/gu;

/** Mark #tags in Markdown text nodes without touching code or existing links. */
export function remarkMessageTags() {
  return (tree: MarkdownAstNode): void => {
    const visit = (node: MarkdownAstNode): void => {
      if (!node.children || node.type === "link" || node.type === "code" || node.type === "inlineCode") return;
      const next: MarkdownAstNode[] = [];
      for (const child of node.children) {
        if (child.type !== "text" || child.value === undefined) {
          visit(child);
          next.push(child);
          continue;
        }
        let cursor = 0;
        for (const match of child.value.matchAll(MESSAGE_TAG_PATTERN)) {
          const boundary = match[1] ?? "";
          const handle = match[2]!;
          const tagStart = (match.index ?? 0) + boundary.length;
          if (tagStart > cursor) next.push({ type: "text", value: child.value.slice(cursor, tagStart) });
          next.push({
            type: "link",
            url: `${MESSAGE_TAG_PREFIX}${encodeURIComponent(handle)}`,
            children: [{ type: "text", value: `#${handle}` }],
          });
          cursor = tagStart + handle.length + 1;
        }
        if (cursor === 0) next.push(child);
        else if (cursor < child.value.length) next.push({ type: "text", value: child.value.slice(cursor) });
      }
      node.children = next;
    };
    visit(tree);
  };
}

export function ChatMarkdown({
  children,
  agentIdForHandle,
  onOpenAgent,
}: {
  children: string;
  agentIdForHandle?(handle: string): string | undefined;
  onOpenAgent?(agentId: string): void;
}): JSX.Element {
  return (
    <Box
      sx={{
        overflowWrap: "anywhere",
        whiteSpace: "pre-wrap",
        "& > :first-of-type": { mt: 0 },
        "& > :last-child": { mb: 0 },
        fontSize: 14,
        lineHeight: "20px",
        "& p": { my: 0.35 },
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
        remarkPlugins={[remarkGfm, remarkMessageTags]}
        components={{
          pre: ({ children: code }) => <CopyableCodeBlock>{code}</CopyableCodeBlock>,
          a: ({ href, children: label }) => {
            if (!href?.startsWith(MESSAGE_TAG_PREFIX)) return <a href={href}>{label}</a>;
            const handle = decodeURIComponent(href.slice(MESSAGE_TAG_PREFIX.length));
            const agentId = agentIdForHandle?.(handle);
            if (!agentId || !onOpenAgent) {
              return <Box component="span" data-message-tag={handle.toLocaleLowerCase()} sx={{ fontWeight: 600, textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 2 }}>{label}</Box>;
            }
            return <Box component="button" type="button" aria-label={`Open agent ${handle}`} onClick={() => onOpenAgent(agentId)} sx={{ display: "inline", p: 0, border: 0, bgcolor: "transparent", color: "inherit", font: "inherit", fontWeight: 600, textDecoration: "underline", textUnderlineOffset: 2, cursor: "pointer" }}>{label}</Box>;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </Box>
  );
}

export function MessageMarkdown({ text, agentIdForHandle, onOpenAgent }: {
  text: string;
  agentIdForHandle?(handle: string): string | undefined;
  onOpenAgent?(agentId: string): void;
}): JSX.Element {
  return <ChatMarkdown agentIdForHandle={agentIdForHandle} onOpenAgent={onOpenAgent}>{text}</ChatMarkdown>;
}

export function CommunicationDocumentCard({ document }: { document: CommunicationDocumentReference }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const query = useQuery({
    queryKey: ["communication-document", document.id],
    queryFn: () => api.getCommunicationDocument(document.previewUrl),
    enabled: expanded,
  });
  return <Paper variant="outlined" sx={{ mt: 1, p: 1 }}>
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <ArticleIcon fontSize="small" />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="subtitle2" noWrap>{document.title}</Typography>
        <Typography variant="caption" color="text.secondary">Markdown document · {document.byteLength} bytes</Typography>
      </Box>
      <Button size="small" color="inherit" onClick={() => setExpanded((value) => !value)}>{expanded ? "Hide" : "Preview"}</Button>
      <Button size="small" component="a" href={document.downloadUrl} download>Download</Button>
    </Stack>
    {expanded ? <Box sx={{ mt: 1, pt: 1, borderTop: 1, borderColor: "divider", maxHeight: "60vh", overflow: "auto" }}>
      {query.isLoading ? <CircularProgress size={20} /> : query.data ? <ChatMarkdown>{query.data.content}</ChatMarkdown> : <Alert severity="error">Document preview is unavailable.</Alert>}
    </Box> : null}
  </Paper>;
}

export function ChatMessageBody({ text, citations, agentIdForHandle, onOpenAgent }: {
  text: string;
  citations?: VerifiedCitationDto[];
  agentIdForHandle?(handle: string): string | undefined;
  onOpenAgent?(agentId: string): void;
}): JSX.Element {
  const collapsible = isLongChatMessage(text);
  const [expanded, setExpanded] = useState(false);
  return (
    <Box>
      <Box
        sx={collapsible && !expanded ? {
          maxHeight: "22rem",
          overflow: "hidden",
          maskImage: "linear-gradient(to bottom, black calc(100% - 3rem), transparent)",
        } : undefined}
      >
        <MessageMarkdown text={text} agentIdForHandle={agentIdForHandle} onOpenAgent={onOpenAgent} />
      </Box>
      {collapsible ? (
        <Button
          size="small"
          color="inherit"
          startIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          sx={{ mt: 0.5 }}
        >
          {expanded ? "Show less" : "Show full message"}
        </Button>
      ) : null}
      {citations?.length ? <Box component="aside" aria-label="Sources" sx={{ mt: 1, pt: 1, borderTop: 1, borderColor: "divider" }}><Typography variant="caption" sx={{ display: "block", fontWeight: 700, mb: .5 }}>Sources</Typography>{citations.map((citation) => <Typography key={citation.url} variant="caption" component="div"><a href={citation.url} target="_blank" rel="noreferrer">{citation.title}</a></Typography>)}</Box> : null}
    </Box>
  );
}

export function UserMessageLabel(): JSX.Element {
  return (
    <Typography
      variant="caption"
      component="div"
      sx={{ mb: 0.25, mr: 0.5, fontWeight: 700, color: "text.secondary", textAlign: "right" }}
    >
      User
    </Typography>
  );
}

export function ChatPane({
  messages,
  agentName = "Agent",
  agentNameForId,
  agentIdForHandle,
  onOpenAgent,
  onReact,
  onReply,
  scrollStorageKey,
}: {
  messages: MessageDto[];
  agentName?: string;
  agentNameForId?(agentId: string): string | undefined;
  agentIdForHandle?(handle: string): string | undefined;
  onOpenAgent?(agentId: string): void;
  onReact?(message: MessageDto, emoji: string): Promise<void>;
  onReply?(message: MessageDto): void;
  scrollStorageKey?: string;
}): JSX.Element {
  const chatMessages = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldFollowNewMessages = useRef(true);
  const restoredScrollKey = useRef<string>();

  useLayoutEffect(() => {
    if (!scrollRef.current) return;
    if (scrollStorageKey && restoredScrollKey.current !== scrollStorageKey) {
      restoredScrollKey.current = scrollStorageKey;
      const saved = readScrollPosition(scrollStorageKey);
      if (saved !== undefined) {
        scrollRef.current.scrollTop = saved;
        shouldFollowNewMessages.current = isChatNearBottom(scrollRef.current);
        return;
      }
    }
    if (shouldFollowNewMessages.current) {
      scrollChatToBottom(scrollRef.current);
    }
  }, [chatMessages, scrollStorageKey]);

  return (
    <Stack
      component="section"
      aria-label="Conversation"
      className="chat-scroll-region"
      ref={scrollRef}
      spacing={1.25}
      onScroll={() => {
        if (scrollRef.current) {
          shouldFollowNewMessages.current = isChatNearBottom(scrollRef.current);
          if (scrollStorageKey) writeChatState(scrollStorageKey, String(scrollRef.current.scrollTop));
        }
      }}
      sx={{ p: 1.5, pb: 3, height: "100%", minHeight: 0, overflowY: "auto" }}
    >
      {chatMessages.length === 0 ? (
        <Alert severity="info">Send a message to this agent to start the conversation.</Alert>
      ) : null}
      {chatMessages.map((message) => {
        const visibleAgentName = message.authorAgentId
          ? agentNameForId?.(message.authorAgentId) ?? "Agent"
          : agentName;
        const senderLabel = individualChatSenderLabel(message.role, visibleAgentName);
        return (
        <Box
          key={message.id}
          id={`message-${message.id}`}
          component="article"
          className="chat-message"
          aria-label={`${senderLabel} message`}
          tabIndex={-1}
          sx={{
            alignSelf: "center",
            width: "min(760px, 100%)",
            maxWidth: "100%",
            minWidth: 0,
          }}
        >
          {message.role === "user" ? <UserMessageLabel /> : null}
          <Box
            data-message-bubble="true"
            sx={{
              px: { xs: 1, sm: 1.5 },
              py: { xs: 0.75, sm: 1 },
              borderRadius: 2,
              bgcolor: message.role === "user" ? "action.selected" : "background.paper",
              color: "text.primary",
              border: 1,
              borderColor: "divider",
              boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
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
            <ChatMessageBody text={message.text} citations={message.citations} agentIdForHandle={agentIdForHandle} onOpenAgent={onOpenAgent} />
            {message.document ? <CommunicationDocumentCard document={message.document} /> : null}
            {message.attachments?.length ? <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: message.text ? 1 : 0 }}>
              {message.attachments.map((attachment) => <Box key={attachment.id} component="a" href={attachment.downloadUrl ?? attachment.url} target="_blank" rel="noreferrer" aria-label={`Download ${attachment.name}`} sx={{ maxWidth: "100%" }}>
                {attachment.previewUrl || !attachment.mediaType || attachment.mediaType.startsWith("image/")
                  ? <Box component="img" src={attachment.previewUrl ?? attachment.url} alt={attachment.name} sx={{ display: "block", maxWidth: 220, maxHeight: 180, objectFit: "contain", borderRadius: 1 }} />
                  : <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{attachment.name} · {attachment.mediaType} · {attachment.size} bytes</Typography>}
              </Box>)}
            </Stack> : null}
            <MessageReactions reactions={message.reactions} />
          </Box>
          <MessageActionsAndTimestamp
            value={message.createdAt}
            actions={<>
              {message.role === "assistant" && message.communicationEventId && onReact ? <EmojiReactionPicker recipientName={senderLabel} onReact={(emoji) => onReact(message, emoji)} /> : null}
              <CopyMessageButton text={message.text} />
              {onReply ? <IconButton size="small" aria-label="Reply to message" onClick={() => onReply(message)}><ReplyIcon fontSize="inherit" /></IconButton> : null}
            </>}
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

export function summarizeActivityText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…` : normalized;
}

export function WorkLogPane({ entries }: { entries: RunOutputDto[] }): JSX.Element {
  const ordered = [...entries].sort((a, b) => a.seq - b.seq);
  return (
    <Stack spacing={1.25} sx={{ p: 1.5, pb: 3, minHeight: 0 }} aria-label="Agent work log">
      <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
        <Typography variant="overline" color="text.secondary" sx={{ flex: 1 }}>Work log</Typography>
        <Typography variant="caption" color="text.secondary">{ordered.length}</Typography>
      </Stack>
      {ordered.length === 0 ? <Alert severity="info">Ordinary agent output will appear here. Only explicitly sent messages appear in Chat.</Alert> : ordered.map((entry) => (
        <Paper key={entry.id} variant="outlined" sx={{ p: 1.25 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 0.75 }}>
            <Chip size="small" variant="outlined" label={entry.kind === "reasoning" ? "Reasoning" : entry.completed ? "Response" : "Response · live"} />
            <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
              Run {entry.executionId.slice(0, 8)} · {new Date(entry.createdAt).toLocaleString()}
            </Typography>
          </Stack>
          <Typography component="div" variant="body2" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {entry.text}
          </Typography>
        </Paper>
      ))}
    </Stack>
  );
}

export function RunsPane({
  runs,
  coordinationV3,
  workItems,
  timeline,
}: {
  runs: AgentRunDto[];
  coordinationV3?: AgentCoordinationV3Dto;
  workItems: WorkItemDto[];
  timeline: ExecutionItem[];
}): JSX.Element {
  return (
    <Stack spacing={1} sx={{ p: 1.5, pb: 3, minHeight: 0 }}>
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
        <Alert severity={coordinationV3.availability === "waiting" ? "info" : "success"}>
          Communication V3: {coordinationV3.availability}
          {coordinationV3.joins.some((join) => join.state === "open")
            ? ` · ${coordinationV3.joins.filter((join) => join.state === "open").length} open join(s)`
            : ""}
          {coordinationV3.requests.some((request) => !["completed", "blocked", "failed", "cancelled", "superseded", "recipient_unavailable", "outcome_unknown", "expired"].includes(request.state))
            ? ` · ${coordinationV3.requests.filter((request) => !["completed", "blocked", "failed", "cancelled", "superseded", "recipient_unavailable", "outcome_unknown", "expired"].includes(request.state)).length} open request(s)`
            : ""}
          {coordinationV3.activeRun
            ? ` · fence ${coordinationV3.activeRun.fencingToken} · ${coordinationV3.activeRun.promptInjectionState.replaceAll("_", " ")}`
            : ""}
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
            overflowY: "auto",
            maxHeight: { xs: "32vh", md: "34vh" },
            pr: 0.5,
          }}
        >
          {runs.map((run) => (
            <Paper key={run.id} variant="outlined" sx={{ p: 1.25 }} data-execution-id={run.id}>
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
                <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                  Started by {wakeCauseLabel(run.wakeCause)}
                </Typography>
              ) : null}
              <Typography variant="caption" color={run.usage ? "text.secondary" : "warning.main"} sx={{ display: "block" }}>
                {run.usage
                  ? `${new Intl.NumberFormat().format(run.usage.totalTokens ?? 0)} tokens · ${new Intl.NumberFormat().format(run.usage.inputTokens ?? 0)} in / ${new Intl.NumberFormat().format(run.usage.outputTokens ?? 0)} out`
                  : run.status === "running" ? "Usage available when this run finishes" : "Usage not reported"}
              </Typography>
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
          <Paper key={item.id} variant="outlined" sx={{ p: 1.25 }}>
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

/** Refresh-safe chronological projection of canonical execution events. */
export function ActivityPane({ activity, connected, running, activeExecutionId }: {
  activity: AgentActivityDto[];
  connected: boolean;
  running: boolean;
  activeExecutionId?: string;
}): JSX.Element {
  const groups = groupActivityByExecution(activity);
  return <Stack spacing={1} sx={{ p: 1.5, pb: 3, minHeight: 0 }} aria-label="Agent activity">
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <Typography variant="overline" color="text.secondary" sx={{ flex: 1 }}>Activity</Typography>
      <Chip size="small" label={connected ? "Live" : "Reconnecting"} color={connected ? "success" : "warning"} variant={connected ? "filled" : "outlined"} />
      {running ? <Chip size="small" color="info" label="Working" /> : null}
    </Stack>
    {groups.length === 0 ? <Alert severity="info">Commands, tests, file changes, and tool output will appear here.</Alert> : groups.map((group) => {
      const isActive = group.executionId !== undefined && group.executionId === activeExecutionId;
      return <Paper key={group.key} variant="outlined" data-testid="activity-execution" data-execution-id={group.executionId} sx={{ overflow: "hidden" }}>
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center", px: 1.25, py: 0.75, bgcolor: "action.hover", borderBottom: 1, borderColor: "divider" }}>
          <Typography variant="subtitle2">{group.executionId ? `Run ${group.executionId.slice(0, 8)}` : "Unscoped activity"}</Typography>
          {isActive ? <Chip size="small" color="info" label="Working" /> : null}
          <Typography variant="caption" color="text.secondary">{group.items.length} event{group.items.length === 1 ? "" : "s"}</Typography>
          <Typography variant="caption" color="text.secondary">{formatActivitySpan(group.firstAt, group.lastAt)}</Typography>
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary">{new Date(group.firstAt).toLocaleString()}</Typography>
        </Stack>
        <Stack spacing={0.5} sx={{ p: 0.75 }}>
          {group.items.map((item) => <Paper component="details" key={item.id} variant="outlined" sx={{ p: 0.75, "& > summary": { cursor: "pointer" } }}>
            <Box component="summary"><EventLine item={{ id: item.id, seq: item.seq, ts: item.createdAt, event: item.event }} /></Box>
            <Typography variant="caption" color="text.secondary" sx={{ pl: 1.25 }}>{new Date(item.createdAt).toLocaleString()}</Typography>
          </Paper>)}
        </Stack>
      </Paper>;
    })}
  </Stack>;
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

export function WorkspaceReviewPane({ projectId, files, running, initialPath }: { projectId: string; files: ChangedFileDto[]; running: boolean; initialPath?: string }): JSX.Element {
  const workspace = useQuery({
    queryKey: ["workspace", projectId],
    queryFn: () => api.getWorkspaceStatus(projectId),
    refetchInterval: running ? 1_500 : 10_000,
  });
  const provenance = new Map(files.map((file) => [file.path, file]));
  const changes = workspace.data?.changes ?? [];
  const [selectedPath, setSelectedPath] = useState<string | undefined>(initialPath);
  const [reviewMode, setReviewMode] = useState<"diff" | "file">("diff");

  useEffect(() => {
    if (initialPath && changes.some((change) => change.path === initialPath)) {
      setSelectedPath(initialPath);
    } else if (!selectedPath || !changes.some((change) => change.path === selectedPath)) {
      setSelectedPath(changes[0]?.path);
    }
  }, [changes, initialPath, selectedPath]);

  const review = useQuery({
    queryKey: ["workspace-file", projectId, selectedPath],
    queryFn: () => api.getWorkspaceFile(projectId, selectedPath ?? ""),
    enabled: Boolean(selectedPath),
    refetchInterval: running ? 1_500 : false,
  });
  const selectedChange = changes.find((change) => change.path === selectedPath);
  const selectedProvenance = selectedPath ? provenance.get(selectedPath) : undefined;

  return <Box data-testid="workspace-review" sx={{ display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", minHeight: 0, height: "100%" }} aria-label="Workspace changes">
    <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center", px: 1.5, py: 1, borderBottom: 1, borderColor: "divider" }}>
      <Typography variant="overline" color="text.secondary">Review</Typography>
      {workspace.data?.branch ? <Chip size="small" label={workspace.data.branch} /> : null}
      {workspace.data?.head ? <Typography variant="caption" color="text.secondary">{workspace.data.head}</Typography> : null}
      <Chip size="small" label={`${changes.length} change${changes.length === 1 ? "" : "s"}`} color={changes.length ? "warning" : "default"} />
      <Box sx={{ flex: 1 }} />
      <Tooltip title="Refresh workspace changes"><IconButton aria-label="Refresh workspace changes" size="small" onClick={() => void workspace.refetch()}><RefreshIcon /></IconButton></Tooltip>
    </Stack>
    {workspace.isLoading ? <Box sx={{ p: 2 }}><CircularProgress size={22} /></Box>
      : workspace.isError ? <Alert severity="error" sx={{ m: 1.5 }}>Workspace status could not be loaded. {String(workspace.error)}</Alert>
        : workspace.data && !workspace.data.isGitRepository ? <Alert severity="info" sx={{ m: 1.5 }}>This working folder is not a Git repository. Run-related file events remain available in Activity and Changed Files.</Alert>
          : changes.length === 0 ? <Alert severity="success" sx={{ m: 1.5 }}>Working tree clean. Files previously touched by this agent remain recorded in Activity and Artifacts.</Alert>
            : <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "minmax(220px, 32%) minmax(0, 1fr)" }, minHeight: 0 }}>
              <Stack sx={{ overflowY: "auto", borderRight: { md: 1 }, borderBottom: { xs: 1, md: 0 }, borderColor: "divider", maxHeight: { xs: 220, md: "none" } }}>
                {changes.map((change) => {
                  const touched = provenance.get(change.path);
                  return <Button
                    key={change.path}
                    data-testid="workspace-change"
                    data-workspace-path={change.path}
                    onClick={() => setSelectedPath(change.path)}
                    variant={change.path === selectedPath ? "contained" : "text"}
                    color={change.path === selectedPath ? "primary" : "inherit"}
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
                  <Typography variant="subtitle2" sx={{ flex: 1, overflowWrap: "anywhere" }}>{selectedPath}</Typography>
                  {selectedChange?.staged ? <Chip size="small" label="Staged" color="success" /> : null}
                  {selectedChange?.unstaged ? <Chip size="small" label="Unstaged" color="warning" /> : null}
                  {selectedChange?.untracked ? <Chip size="small" label="Untracked" color="info" /> : null}
                  {selectedProvenance ? <Chip size="small" label={`${selectedProvenance.executionIds.length} agent run${selectedProvenance.executionIds.length === 1 ? "" : "s"}`} /> : null}
                </Stack>
                <Stack direction="row" spacing={0.5} sx={{ mb: 1 }}>
                  <Button size="small" variant={reviewMode === "diff" ? "contained" : "outlined"} onClick={() => setReviewMode("diff")}>Diff</Button>
                  <Button size="small" variant={reviewMode === "file" ? "contained" : "outlined"} onClick={() => setReviewMode("file")}>Current file</Button>
                </Stack>
                {review.isLoading ? <CircularProgress size={22} />
                  : review.isError ? <Alert severity="error">Diff could not be loaded. {String(review.error)}</Alert>
                    : reviewMode === "file" ? (review.data?.content !== undefined
                      ? <Box data-testid="workspace-file"><SyntaxHighlighter language={languageForPath(review.data.path)} style={oneLight} PreTag="div" customStyle={{ margin: 0 }}>{review.data.content}</SyntaxHighlighter></Box>
                      : <Alert severity="info">The current file cannot be displayed. It may be deleted, binary, or above the safe viewer limit.</Alert>)
                    : review.data?.diff ? <>
                      {review.data.truncated ? <Alert severity="warning" sx={{ mb: 1 }}>This review is truncated to the safe viewer limit.</Alert> : null}
                      <SyntaxHighlighter language="diff" style={oneLight} PreTag="div" customStyle={{ margin: 0 }}>{review.data.diff}</SyntaxHighlighter>
                    </> : <Alert severity="info">Git has no textual diff for this change. It may be binary or metadata-only.</Alert>}
              </Box>
            </Box>}
  </Box>;
}

/** Durable execution provenance, distinct from the live Git working-tree Review surface. */
export function ChangedFilesPane({ files }: { files: ChangedFileDto[] }): JSX.Element {
  const ordered = [...files].sort((a, b) => b.lastSeq - a.lastSeq);
  const totals = ordered.reduce((sum, file) => {
    const current = unifiedDiffLineTotals(file.diff);
    return { additions: sum.additions + current.additions, deletions: sum.deletions + current.deletions };
  }, { additions: 0, deletions: 0 });
  return <Stack spacing={1} sx={{ p: 1.5, pb: 3, minHeight: 0 }} aria-label="Changed files">
    <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
      <Typography variant="overline" color="text.secondary" sx={{ flex: 1 }}>Changed Files</Typography>
      <Typography variant="caption" color="text.secondary">{ordered.length}</Typography>
      <Typography variant="caption" color="success.main">+{totals.additions}</Typography>
      <Typography variant="caption" color="error.main">−{totals.deletions}</Typography>
    </Stack>
    {ordered.length === 0 ? <Alert severity="info">Files touched by this agent will remain listed here after refresh.</Alert> : ordered.map((file) =>
      <Paper component="details" key={file.path} variant="outlined" sx={{ p: 1.25, "& > summary": { cursor: "pointer" } }}>
        <Stack component="summary" direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Chip size="small" label={file.kind} color={file.kind === "delete" ? "error" : file.kind === "create" ? "success" : "default"} />
          <Typography variant="body2" sx={{ flex: 1, overflowWrap: "anywhere" }}>{file.path}</Typography>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
          Last changed {new Date(file.lastChangedAt).toLocaleString()} · {file.executionIds.length} run{file.executionIds.length === 1 ? "" : "s"}
        </Typography>
        {file.diff ? <Box sx={{ mt: 1, overflow: "auto" }}><SyntaxHighlighter language="diff" style={oneLight} PreTag="div">{file.diff}</SyntaxHighlighter></Box> : <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>The engine did not provide a diff for this canonical event. Open Review for the current Git working-tree diff.</Typography>}
      </Paper>)}
  </Stack>;
}

export function unifiedDiffLineTotals(diff: string | undefined): { additions: number; deletions: number } {
  if (!diff) return { additions: 0, deletions: 0 };
  return diff.split(/\r?\n/u).reduce((totals, line) => {
    if (line.startsWith("+++") || line.startsWith("---")) return totals;
    if (line.startsWith("+")) return { ...totals, additions: totals.additions + 1 };
    if (line.startsWith("-")) return { ...totals, deletions: totals.deletions + 1 };
    return totals;
  }, { additions: 0, deletions: 0 });
}

export function languageForPath(filePath: string): string {
  const extension = filePath.split(".").at(-1)?.toLocaleLowerCase();
  return ({ ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", json: "json", css: "css", html: "html", md: "markdown", py: "python", rs: "rust", go: "go", sh: "bash", yml: "yaml", yaml: "yaml" } as Record<string, string>)[extension ?? ""] ?? "text";
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
  agentId,
  liveContent,
}: {
  artifact: ArtifactDto | undefined;
  agentId: string;
  liveContent: string | undefined;
}): JSX.Element {
  const contentQuery = useQuery({
    queryKey: ["artifact", agentId, artifact?.id],
    queryFn: () => api.getArtifact(agentId, artifact?.id ?? ""),
    enabled: Boolean(artifact && artifact.kind !== "document" && !artifact.id.startsWith("live-artifact-")),
  });

  const content: ArtifactContentDto | undefined =
    liveContent && artifact
      ? { ...artifact, content: liveContent, contentType: artifact.kind === "diff" ? "diff" : "markdown" }
      : contentQuery.data;

  if (!artifact) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary">
          Select a file or result to inspect its contents.
        </Typography>
      </Box>
    );
  }

  if (artifact.kind === "document" && artifact.mediaType === "application/pdf") {
    return <Box sx={{ p: 1.5, minWidth: 0 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
        <Typography variant="subtitle2" sx={{ flex: 1 }}>{artifact.summary ?? artifact.path}</Typography>
        {artifact.previewUrl ? <Button component="a" href={artifact.previewUrl} target="_blank" rel="noreferrer" size="small" variant="outlined">Open preview</Button> : null}
        {artifact.downloadUrl ? <Button component="a" href={artifact.downloadUrl} size="small" variant="contained" download>Download</Button> : null}
      </Stack>
      {artifact.previewUrl ? <Box component="iframe" title={`Preview ${artifact.path}`} src={artifact.previewUrl} sx={{ width: "100%", height: { xs: "55vh", md: "66vh" }, border: 1, borderColor: "divider", borderRadius: 1, bgcolor: "background.paper" }} /> : <Alert severity="info">The PDF is still being indexed. Refresh to preview or download it.</Alert>}
    </Box>;
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
  agentId,
  timeline,
}: {
  artifacts: ArtifactDto[];
  agentId: string;
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
        <Alert severity="info">No files or results yet. Diffs, test reports, and logs appear here.</Alert>
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
      <ArtifactViewer artifact={selectedArtifact} agentId={agentId} liveContent={liveContent} />
    </Box>
  );
}

export function Composer({
  disabled,
  running,
  placeholder,
  projectId,
  mentionHandles,
  commands,
  busyMentionHandles,
  allowUnmentionedSend = true,
  onSend,
  onQueue,
  agentResponding = false,
  onCancel,
  replyTo,
  onCancelReply,
  replyLabel,
  draftStorageKey,
  conversationDraftId,
  controls,
  focusReply = false,
}: {
  disabled: boolean;
  running: boolean;
  placeholder?: string;
  /** Project scope used by `@` file/folder reference autocomplete. */
  projectId?: string;
  /** When provided, typing `#` autocompletes these agent handles (group chat). */
  mentionHandles?: string[];
  /** Engine/system capabilities shown when the composer starts with `/`. */
  commands?: EngineCommand[];
  /** Mentioned agents that cannot accept a new turn yet. */
  busyMentionHandles?: string[];
  /** Whether text without a valid mention may be submitted. */
  allowUnmentionedSend?: boolean;
  onSend(text: string, files: File[]): Promise<unknown> | unknown;
  /** Explicitly enqueue this draft instead of steering the active agent turn. */
  onQueue?(text: string, files: File[]): Promise<unknown> | unknown;
  /** Canonical server-owned activity; used only to reveal the explicit Queue action. */
  agentResponding?: boolean;
  onCancel?(): void;
  replyTo?: { text: string };
  onCancelReply?(): void;
  replyLabel?: string;
  /** Stable surface key used to preserve an unsent draft across tabs and refreshes. */
  draftStorageKey?: string;
  /** Enables server-authoritative, revisioned draft persistence for this chat surface. */
  conversationDraftId?: string;
  /** Compact engine/model/effort controls rendered in the bottom action row. */
  controls?: ReactNode;
  /** Focus the normal composer when a direct reply is selected. */
  focusReply?: boolean;
}): JSX.Element {
  const [text, setText] = useState(() => draftStorageKey ? readChatState(draftStorageKey) ?? "" : "");
  const [attachments, dispatchAttachments] = useReducer(composerAttachmentReducer, { files: [] });
  const files = attachments.files;
  const queryClient = useQueryClient();
  const [sendError, setSendError] = useState<string>();
  const [draftConflict, setDraftConflict] = useState<ConversationDraftConflictDto>();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const previousDraftStorageKey = useRef(draftStorageKey);
  const previousConversationDraftId = useRef(conversationDraftId);
  const draftRevision = useRef(0);
  const draftReady = useRef(false);
  const draftClientId = useRef<string>();
  const draftAttachmentIds = useRef(new Map<File, string>());
  const draftWriteChain = useRef<Promise<void>>(Promise.resolve());
  const draftGeneration = useRef(0);
  const [draftAttachmentVersion, setDraftAttachmentVersion] = useState(0);
  const sendingRef = useRef(false);
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

  useEffect(() => {
    if (!focusReply) return;
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      const end = inputRef.current?.value.length ?? 0;
      inputRef.current?.setSelectionRange(end, end);
      setCaret(end);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusReply]);
  const draftQuery = useQuery({
    queryKey: ["conversation-draft", conversationDraftId],
    queryFn: () => api.getConversationDraft(conversationDraftId!),
    enabled: Boolean(conversationDraftId),
    staleTime: 0,
  });

  const update = (next: string) => {
    setText(next);
  };

  useEffect(() => {
    if (previousDraftStorageKey.current !== draftStorageKey) {
      previousDraftStorageKey.current = draftStorageKey;
      setText(draftStorageKey ? readChatState(draftStorageKey) ?? "" : "");
    }
  }, [draftStorageKey]);

  useEffect(() => {
    const changed = previousConversationDraftId.current !== conversationDraftId;
    previousConversationDraftId.current = conversationDraftId;
    if (changed) {
      draftReady.current = false;
      draftRevision.current = 0;
      draftAttachmentIds.current.clear();
      dispatchAttachments({ type: "clear" });
    }
    if (!conversationDraftId) return;
    const key = "ponderosa.draft.client.v1";
    let clientId = window.sessionStorage.getItem(key);
    if (!clientId) {
      clientId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
      window.sessionStorage.setItem(key, clientId);
    }
    draftClientId.current = clientId;
  }, [conversationDraftId]);

  useEffect(() => {
    const draft = draftQuery.data;
    if (!conversationDraftId || !draft || (draftReady.current && draft.revision <= draftRevision.current)) return;
    let cancelled = false;
    const apply = async () => {
      const restored = await Promise.all((draft.attachments ?? []).map(async (attachment: DraftAttachmentDto) => ({
        attachment,
        file: await api.downloadDraftAttachment(attachment),
      })));
      if (cancelled || draft.revision < draftRevision.current) return;
      draftAttachmentIds.current = new Map(restored.map(({ attachment, file }) => [file, attachment.id]));
      dispatchAttachments({ type: "replace", files: restored.map(({ file }) => file) });
      setDraftAttachmentVersion((value) => value + 1);
      draftRevision.current = draft.revision;
      const local = draftStorageKey ? readChatState(draftStorageKey) ?? "" : "";
      const nextText = draft.revision === 0 && local && !draft.text ? local : draft.text;
      setText(nextText);
      if (draftStorageKey) writeChatState(draftStorageKey, nextText);
      draftReady.current = true;
    };
    void apply().catch(() => {
      if (!cancelled) {
        draftRevision.current = draft.revision;
        setText(draft.text);
        dispatchAttachments({ type: "replace", files: [], error: "Some staged draft attachments could not be restored." });
        draftReady.current = true;
      }
    });
    return () => { cancelled = true; };
  }, [conversationDraftId, draftQuery.data, draftStorageKey]);

  useEffect(() => {
    if (draftStorageKey) writeChatState(draftStorageKey, text);
  }, [draftStorageKey, text]);

  useEffect(() => {
    if (!conversationDraftId || !draftReady.current || !draftClientId.current) return;
    const timer = window.setTimeout(() => {
      const generation = draftGeneration.current;
      const attachmentIds = files.map((file) => draftAttachmentIds.current.get(file)).filter((id): id is string => Boolean(id));
      const clientId = draftClientId.current!;
      draftWriteChain.current = draftWriteChain.current.then(async () => {
        if (generation !== draftGeneration.current) return;
        try {
          const draft = await api.putConversationDraft(conversationDraftId, { text, attachmentIds, expectedRevision: draftRevision.current, clientId });
          if (generation !== draftGeneration.current) return;
          draftRevision.current = draft.revision;
          queryClient.setQueryData(["conversation-draft", conversationDraftId], draft);
        } catch {
          const current = await api.getConversationDraft(conversationDraftId);
          draftGeneration.current += 1;
          draftRevision.current = current.revision;
          queryClient.setQueryData(["conversation-draft", conversationDraftId], current);
          const conflicts = await api.getConversationDraftConflicts(conversationDraftId).catch(() => undefined);
          const displaced = conflicts?.conflicts.at(-1);
          if (displaced) setDraftConflict(displaced);
        }
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [conversationDraftId, draftAttachmentVersion, files, queryClient, text]);

  const addFiles = (candidates: File[]) => {
    const selection = selectComposerFiles(files, candidates);
    dispatchAttachments({ type: "add", candidates });
    if (!conversationDraftId || selection.accepted.length === 0) return;
    void Promise.allSettled(selection.accepted.map(async (file) => ({ file, staged: await api.uploadDraftAttachment(conversationDraftId, file) })))
      .then((results) => {
        const staged = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (!failure) {
          for (const { file, staged: attachment } of staged) draftAttachmentIds.current.set(file, attachment.id);
          setDraftAttachmentVersion((value) => value + 1);
          return;
        }
        for (const { staged: attachment } of staged) void api.deleteDraftAttachment(conversationDraftId, attachment.id).catch(() => undefined);
        const rejected = new Set(selection.accepted);
        const error = failure.reason as unknown;
        dispatchAttachments({ type: "replace", files: files.filter((file) => !rejected.has(file)), error: error instanceof Error ? error.message : "Draft attachment upload failed." });
      });
  };

  const removeFile = (index: number) => {
    const file = files[index];
    if (!file) return;
    const id = draftAttachmentIds.current.get(file);
    draftAttachmentIds.current.delete(file);
    dispatchAttachments({ type: "remove", index });
    setDraftAttachmentVersion((value) => value + 1);
    if (conversationDraftId && id) void api.deleteDraftAttachment(conversationDraftId, id).catch(() => undefined);
  };

  // Agent routing uses #; @ is reserved for project file/folder references.
  const mentionMatch = /(?:^|\s)#([\p{L}\p{N}_-]*)$/u.exec(text.slice(0, caret));
  const suggestions =
    mentionMatch && mentionHandles && mentionHandles.length > 0
      ? mentionHandles
          .filter((handle) => handle.toLowerCase().startsWith(mentionMatch[1]!.toLowerCase()))
      : [];
  const fileMatch = /(?:^|\s)@([^\s@#]*)$/u.exec(text.slice(0, caret));
  const fileToken = fileMatch?.[1] ?? "";
  const fileSlash = fileToken.lastIndexOf("/");
  const fileDirectory = fileSlash >= 0 ? fileToken.slice(0, fileSlash) : "";
  const filePrefix = fileSlash >= 0 ? fileToken.slice(fileSlash + 1) : fileToken;
  const [fileEntries, setFileEntries] = useState<FileEntryDto[]>([]);
  const fileReferenceActive = Boolean(fileMatch);
  useEffect(() => {
    let cancelled = false;
    if (!projectId || !fileReferenceActive) {
      setFileEntries([]);
      return () => { cancelled = true; };
    }
    void api.getFiles(projectId, fileDirectory)
      .then((response) => {
        if (!cancelled) setFileEntries(response.kind === "dir" ? response.entries : []);
      })
      .catch(() => {
        if (!cancelled) setFileEntries([]);
      });
    return () => { cancelled = true; };
  }, [fileDirectory, fileReferenceActive, projectId]);
  const fileSuggestions = fileMatch
    ? fileEntries
        .filter((entry) => entry.name.toLocaleLowerCase().startsWith(filePrefix.toLocaleLowerCase()))
    : [];
  const slashMatch = /^\/([\p{L}\p{N}_-]*)$/u.exec(text.slice(0, caret));
  const commandSuggestions = slashMatch && commands
    ? matchingEngineCommands(commands, slashMatch[1]!)
    : [];
  const menuSuggestions = commandSuggestions.length > 0
    ? commandSuggestions.map((command) => ({ kind: "command" as const, command }))
    : suggestions.length > 0
      ? suggestions.map((handle) => ({ kind: "mention" as const, handle }))
      : fileSuggestions.map((entry) => ({ kind: "file" as const, entry }));
  const menuOpen = menuSuggestions.length > 0 && !suppressMenu;

  const applyMention = (handle: string) => {
    const start = caret - mentionMatch![0].length + mentionMatch![0].indexOf("#");
    const next = `${text.slice(0, start)}#${handle} ${text.slice(caret)}`;
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

  const applyFileReference = (entry: { path: string; kind: "file" | "dir" }) => {
    const start = caret - fileMatch![0].length + fileMatch![0].indexOf("@");
    const suffix = entry.kind === "dir" ? "/" : " ";
    const next = `${text.slice(0, start)}@${entry.path}${suffix}${text.slice(caret)}`;
    update(next);
    setHighlighted(0);
    const nextCaret = start + entry.path.length + 1 + suffix.length;
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
      setSuppressMenu(false);
    });
  };

  const applyCommand = (command: EngineCommand) => {
    const next = `/${command.name}${command.acceptsArguments ? " " : ""}${text.slice(caret)}`;
    update(next);
    setHighlighted(0);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const nextCaret = command.name.length + (command.acceptsArguments ? 2 : 1);
      el.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  };

  const submit = (handler: (message: string, selectedFiles: File[]) => Promise<unknown> | unknown) => {
    if (sendingRef.current || !canSend) return;
    sendingRef.current = true;
    setSendError(undefined);
    const stagedIds = files.map((file) => draftAttachmentIds.current.get(file)).filter((id): id is string => Boolean(id));
    void Promise.resolve(handler(text.trim(), files)).then(() => {
      update("");
      dispatchAttachments({ type: "clear" });
      draftAttachmentIds.current.clear();
      setDraftAttachmentVersion((value) => value + 1);
      if (conversationDraftId) for (const id of stagedIds) void api.deleteDraftAttachment(conversationDraftId, id).catch(() => undefined);
      setCaret(0);
    }).catch((error: unknown) => setSendError(error instanceof Error ? error.message : "Upload failed; try again."))
      .finally(() => { sendingRef.current = false; });
  };
  const send = () => submit(onSend);
  const queue = () => {
    if (!onQueue || files.length > 0) return;
    submit(onQueue);
  };
  const showQueue = Boolean(onQueue) && shouldShowQueueControl({
    text,
    agentResponding: agentResponding || mentionedBusyHandles.length > 0,
    disabled,
  });

  return (
    <Paper
      elevation={3}
      sx={{
        position: "sticky",
        bottom: 0,
        zIndex: 3,
        border: 1,
        borderColor: "divider",
        borderRadius: { xs: 2, sm: 2.5 },
        width: "min(780px, 100%)",
        mx: "auto",
        minWidth: 0,
        maxWidth: "100%",
        overflow: "hidden",
        px: { xs: 0.75, sm: 1 },
        pt: { xs: 0.75, sm: 1 },
        pb: "max(8px, env(safe-area-inset-bottom))",
      }}
    >
      {replyTo ? (
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1, px: 0.5, minWidth: 0, width: "100%", overflow: "hidden" }}>
          <Box sx={{ minWidth: 0, flex: "1 1 auto", overflow: "hidden", borderLeft: 3, borderColor: "primary.main", pl: 1 }}>
            <Typography variant="caption" color="text.secondary">{replyLabel ?? "Replying to"}</Typography>
            <Typography variant="body2" title={replyTo.text} sx={{ display: "-webkit-box", maxWidth: "100%", maxHeight: "3.6rem", overflow: "hidden", overflowWrap: "anywhere", WebkitBoxOrient: "vertical", WebkitLineClamp: 3, lineHeight: 1.2 }}>
              {replyPreviewText(replyTo.text)}
            </Typography>
          </Box>
          <IconButton aria-label="Cancel reply" size="small" onClick={onCancelReply} sx={{ flex: "0 0 auto" }}><CloseIcon fontSize="small" /></IconButton>
        </Stack>
      ) : null}
      {files.length > 0 ? <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mb: 1 }}>
        {files.map((file, index) => <ComposerAttachment key={`${file.name}-${file.size}-${file.lastModified}-${index}`} file={file} onRemove={() => removeFile(index)} />)}
      </Stack> : null}
      {(attachments.error ?? sendError) ? <Alert severity="error" sx={{ mb: 1 }}>Message not sent. {attachments.error ?? sendError}</Alert> : null}
      {draftConflict ? <Alert severity="warning" sx={{ mb: 1 }} action={<Button size="small" onClick={() => { update(draftConflict.displaced.text); setDraftConflict(undefined); inputRef.current?.focus(); }}>Restore</Button>}>
        This chat changed in another tab. Your displaced draft is preserved: “{replyPreviewText(draftConflict.displaced.text)}”
      </Alert> : null}
      <Stack direction="row" spacing={{ xs: 0.25, sm: 1 }} useFlexGap sx={{ alignItems: "flex-end", flexWrap: "wrap" }}>
        <input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/webp,application/pdf,text/plain,application/json,application/zip,.txt,.md,.csv,.log,.json,.zip,.pdf" multiple onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }} />
        <Tooltip title="Attach or paste assets (PNG, JPEG, WebP, PDF, text, JSON, or ZIP; 8 MiB each)"><span><IconButton aria-label="Attach assets" disabled={disabled || running || files.length >= COMPOSER_MAX_FILES} onClick={() => fileInput.current?.click()} sx={{ minWidth: 44, minHeight: 44 }}><AttachFileIcon /></IconButton></span></Tooltip>
        {controls ? <Box sx={{ minWidth: 0, flex: "1 1 0", overflowX: "auto" }}>{controls}</Box> : null}
        <Box ref={anchorRef} sx={{ order: -1, flex: "1 0 100%", minWidth: 0 }}>
          <TextField
            fullWidth
            multiline
            minRows={1}
            maxRows={5}
            sx={{
              "& .MuiInputBase-root": { alignItems: "flex-end", borderRadius: 2, bgcolor: "background.paper" },
              "& textarea": { fontSize: 14, lineHeight: "20px" },
            }}
            value={text}
            inputRef={inputRef}
            disabled={disabled || running}
            placeholder={running ? "Agent is working" : (placeholder ?? "Send a message")}
            inputProps={{
              "aria-label": "Message",
              enterKeyHint: "send",
              role: mentionHandles || commands?.length || projectId ? "combobox" : undefined,
              "aria-autocomplete": mentionHandles || commands?.length || projectId ? "list" : undefined,
              "aria-expanded": mentionHandles || commands?.length || projectId ? menuOpen : undefined,
              "aria-controls": menuOpen ? mentionListId : undefined,
              "aria-activedescendant": menuOpen ? `${mentionListId}-option-${highlighted}` : undefined,
            }}
            onChange={(event) => {
              update(event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
              setHighlighted(0);
              setSuppressMenu(false);
            }}
            onPaste={(event) => {
              if (disabled || running) return;
              const pasted = filesFromClipboard(event.clipboardData.items, event.clipboardData.files);
              if (pasted.length === 0) return;
              event.preventDefault();
              addFiles(pasted);
            }}
            onClick={(event) => setCaret((event.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onKeyUp={(event) => setCaret((event.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onKeyDown={(event) => {
              if (shouldIgnoreComposerKey({ key: event.key, isComposing: event.nativeEvent.isComposing })) {
                return;
              }
              if (menuOpen && event.key === "ArrowDown") {
                event.preventDefault();
                setHighlighted((index) => (index + 1) % menuSuggestions.length);
                return;
              }
              if (menuOpen && event.key === "ArrowUp") {
                event.preventDefault();
                setHighlighted((index) => (index - 1 + menuSuggestions.length) % menuSuggestions.length);
                return;
              }
              if (menuOpen && (event.key === "Enter" || event.key === "Tab") && !event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                const selected = menuSuggestions[highlighted]!;
                if (selected.kind === "mention") applyMention(selected.handle);
                else if (selected.kind === "file") applyFileReference(selected.entry);
                else applyCommand(selected.command);
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
              {mentionedHandles.some((handle) => handle.toLocaleLowerCase() === "broadcast")
                ? "Adding durable shared context without starting an agent"
                : mentionedBusyHandles.length > 0
                ? `${mentionedBusyHandles.map((handle) => `#${handle}`).join(", ")} ${mentionedBusyHandles.length > 1 ? "are" : "is"} working — your message will steer the active turn when supported.`
                : mentionedHandles.some((handle) => handle.toLocaleLowerCase() === "everyone")
                  ? "Notifying every active agent in this conversation"
                  : `Replying to ${mentionedHandles.map((handle) => `#${handle}`).join(", ")}`}
            </Typography>
          ) : null}
          <Popper open={menuOpen} anchorEl={anchorRef.current} placement="top-start" style={{ zIndex: 1400 }}>
            <ClickAwayListener onClickAway={() => setSuppressMenu(true)}>
              <Paper elevation={4} sx={{ mb: 0.5, minWidth: 180, maxWidth: "min(720px, calc(100vw - 24px))" }}>
                <MenuList
                  dense
                  id={mentionListId}
                  role="listbox"
                  aria-label={commandSuggestions.length ? "Commands" : suggestions.length ? "Agent tags" : "Project files and folders"}
                  sx={{ maxHeight: "min(40vh, 360px)", overflowY: "auto", overscrollBehavior: "contain" }}
                >
                  {menuSuggestions.map((suggestion, index) => (
                    <MenuItem
                      key={suggestion.kind === "mention" ? suggestion.handle : suggestion.kind === "file" ? suggestion.entry.path : suggestion.command.name}
                      id={`${mentionListId}-option-${index}`}
                      role="option"
                      aria-selected={index === highlighted}
                      selected={index === highlighted}
                      sx={{ whiteSpace: "normal", alignItems: "flex-start" }}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        if (suggestion.kind === "mention") applyMention(suggestion.handle);
                        else if (suggestion.kind === "file") applyFileReference(suggestion.entry);
                        else applyCommand(suggestion.command);
                      }}
                    >
                      {suggestion.kind === "mention"
                        ? `#${suggestion.handle}`
                        : suggestion.kind === "file"
                          ? <Box><Typography variant="body2">@{suggestion.entry.path}{suggestion.entry.kind === "dir" ? "/" : ""}</Typography><Typography variant="caption" color="text.secondary">{suggestion.entry.kind === "dir" ? "Folder" : "File"}</Typography></Box>
                          : <Box sx={{ minWidth: 0 }}><Typography variant="body2">/{suggestion.command.name}</Typography><Typography variant="caption" color="text.secondary" sx={{ display: "block", overflowWrap: "anywhere" }}>{suggestion.command.source} · {suggestion.command.description}</Typography></Box>}
                    </MenuItem>
                  ))}
                </MenuList>
              </Paper>
            </ClickAwayListener>
          </Popper>
        </Box>
        {showQueue ? (
          <Tooltip title={files.length > 0 ? "Attachments cannot be queued while the agent is responding" : "Send after the active response finishes"}>
            <span>
              <Button
                size="small"
                variant="outlined"
                disabled={!canSend || files.length > 0}
                onClick={queue}
                aria-label="Queue message"
                sx={{ minHeight: 44 }}
              >
                Queue
              </Button>
            </span>
          </Tooltip>
        ) : null}
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
                <ArrowUpwardIcon />
              </IconButton>
            </span>
          </Tooltip>
        )}
      </Stack>
    </Paper>
  );
}

export function replyPreviewText(text: string, maxLength = 240): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}
