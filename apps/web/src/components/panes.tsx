import ArticleIcon from "@mui/icons-material/Article";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import CheckIcon from "@mui/icons-material/Check";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DifferenceIcon from "@mui/icons-material/Difference";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import AddIcon from "@mui/icons-material/Add";
import ReplyIcon from "@mui/icons-material/Reply";
import RefreshIcon from "@mui/icons-material/Refresh";
import CloseIcon from "@mui/icons-material/Close";
import StopCircleIcon from "@mui/icons-material/StopCircle";
import TerminalIcon from "@mui/icons-material/Terminal";
import LanguageIcon from "@mui/icons-material/Language";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import SearchIcon from "@mui/icons-material/Search";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import SubdirectoryArrowRightIcon from "@mui/icons-material/SubdirectoryArrowRight";
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  ClickAwayListener,
  Divider,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
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
  useTheme,
} from "@mui/material";
import {
  INLINE_TEXT_MAX_CODE_POINTS,
  LONG_TEXT_MAX_UTF8_BYTES,
  unicodeCodePointLength,
  unifiedDiffLineTotals,
  utf8ByteLength,
} from "@ponderosa/core";
import type { AgentActivityDto, AgentActivityOutputDto, AgentRunDto, AgentCoordinationV3Dto, ArtifactContentDto, ArtifactDto, ChangedFileDto, CommunicationDocumentReference, ConversationDraftConflictDto, DraftAttachmentDto, EngineCommand, EngineComposerCapability, FileEntryDto, MessageDto, OperatorProfileDto, ProviderInputDto, QueuedConversationMessageDto, ResponseFileActivityDto, WorkItemDto, RunOutputDto, VerifiedCitationDto } from "@ponderosa/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight, vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import { copyText } from "../clipboard";
import { readChatState, readScrollPosition, writeChatState } from "../chatState";
import { telemetryElementId } from "../telemetryFocus";
import type { ExecutionItem } from "../hooks/useAgentStream";
import { agentMentionHandle, findMentionedHandles } from "../mentions";
import { MessageSenderLabel } from "./MessageSenderLabel";
import { CopyMessageButton } from "./CopyMessageButton";
import { MessageActionsAndTimestamp, MessageTimestamp } from "./MessageTimestamp";
import { MessageDeliveryStatus } from "./MessageDeliveryStatus";
import { EmojiReactionPicker, MessageReactions } from "./EmojiReactionPicker";
import { useProjectBrowser } from "./ProjectBrowserContext";
import { faviconIdentity, loadFavicon, markFaviconFailed } from "../faviconCache";

function isLoopbackLink(url: URL): boolean {
  return url.protocol === "http:" && Boolean(url.port) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
}

export function linkPresentation(href: string): { url: URL; hostname: string; destination: string; loopback: boolean } | undefined {
  let url: URL;
  try { url = new URL(href); } catch { return undefined; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return { url, hostname: url.hostname, destination: `${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname === "/" ? "" : url.pathname}`, loopback: isLoopbackLink(url) };
}

export interface LinkPreviewScope { projectId: string; agentId: string; runId: string; conversationId?: string }

function projectFileHref(projectId: string | undefined, href: string | undefined, mode: "preview" | "download"): string | undefined {
  if (!projectId || !href) return undefined;
  if (/^(?:https?:|data:|blob:|ponderosa:|mailto:|#)/iu.test(href) || href.startsWith("/api/")) return undefined;
  return `/api/projects/${encodeURIComponent(projectId)}/workspace-files/${mode}?path=${encodeURIComponent(href)}`;
}

export function linkPreviewScopeForMessage(
  message: Pick<MessageDto, "role" | "authorAgentId" | "executionId">,
  activeScope?: LinkPreviewScope,
): LinkPreviewScope | undefined {
  if (!activeScope || message.role !== "assistant") return undefined;
  if (message.authorAgentId !== activeScope.agentId || message.executionId !== activeScope.runId) return undefined;
  return activeScope;
}

function ChatLink({ href, children, previewScope, projectId }: { href: string; children: ReactNode; previewScope?: LinkPreviewScope; projectId?: string }): JSX.Element {
  const projectBrowser = useProjectBrowser();
  const projectFilePreview = projectFileHref(projectId ?? previewScope?.projectId, href, "preview");
  const link = linkPresentation(href);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [faviconFailed, setFaviconFailed] = useState(false);
  const [faviconSrc, setFaviconSrc] = useState<string>();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string>();
  const favicon = link ? faviconIdentity(link.url.href) : undefined;
  useEffect(() => {
    let current = true;
    setFaviconSrc(undefined);
    setFaviconFailed(false);
    if (!favicon) return () => { current = false; };
    void loadFavicon(favicon).then(
      (src) => { if (current) setFaviconSrc(src); },
      () => { if (current) setFaviconFailed(true); },
    );
    return () => { current = false; };
  }, [favicon]);
  if (projectFilePreview) return <a className="chat-text-navigation" href={projectFilePreview} target="_blank" rel="noreferrer">{children}</a>;
  if (!link) return <a className="chat-text-navigation" href={href}>{children}</a>;
  const activate = (event: React.MouseEvent) => { event.preventDefault(); setChooserOpen(true); setError(undefined); };
  const openInside = async () => {
    setOpening(true); setError(undefined);
    try {
      if (!previewScope) throw new Error("This localhost app is not associated with an active run.");
      const response = await fetch("/api/link-previews", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: link.url.href, ...previewScope }) });
      if (!response.ok) throw new Error("Ponderosa could not open this localhost app.");
      const preview = await response.json() as { openUrl: string };
      window.open(preview.openUrl, "_blank", "noopener,noreferrer");
      setChooserOpen(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Preview unavailable."); }
    finally { setOpening(false); }
  };
  return <>
    <Box className="chat-text-navigation" component="a" href={href} onClick={activate} aria-label={`Open link to ${link.destination}`} sx={{ display: "inline-flex", alignItems: "center", gap: .45, maxWidth: "100%", px: .5, borderRadius: .75, bgcolor: "action.hover", textDecoration: "none !important", verticalAlign: "middle" }}>
      {!faviconFailed && faviconSrc
        ? <Box component="img" src={faviconSrc} alt="" onError={() => { if (favicon) markFaviconFailed(favicon); setFaviconFailed(true); }} sx={{ width: 14, height: 14, flex: "0 0 auto" }} />
        : <LanguageIcon aria-hidden fontSize="inherit" />}
      <Box component="span" sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><strong>{link.hostname}</strong> · {link.destination}</Box>
      <OpenInNewIcon aria-hidden sx={{ fontSize: 14, flex: "0 0 auto" }} />
    </Box>
    <Dialog open={chooserOpen} onClose={() => setChooserOpen(false)} aria-labelledby="link-open-title" maxWidth="xs" fullWidth>
      <DialogTitle id="link-open-title">Open link</DialogTitle>
      <DialogContent><Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{link.url.href}</Typography>{error ? <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert> : null}</DialogContent>
      <DialogActions>
        <Button onClick={() => setChooserOpen(false)}>Cancel</Button>
        {projectBrowser.projectId ? <Button onClick={() => { projectBrowser.open(link.url.href); setChooserOpen(false); }}>Open in Ponderosa</Button> : null}
        {link.loopback && previewScope ? <Button disabled={opening} onClick={() => void openInside()}>Open live app preview</Button> : null}
        <Button component="a" href={link.url.href} target="_blank" rel="noopener noreferrer" onClick={() => setChooserOpen(false)} endIcon={<OpenInNewIcon />}>Open externally</Button>
      </DialogActions>
    </Dialog>
  </>;
}

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

export function composerCapabilityDisabledReason(capability: EngineComposerCapability): string | undefined {
  if (capability.status === "unavailable") return capability.unavailableReason ?? "This capability is not currently available.";
  if (capability.insertText) return undefined;
  if (capability.kind === "connector") return "Available to the runtime; direct connector expansion is not supported yet.";
  if (capability.kind === "plugin") return "Available through its runtime-provided skills and connectors.";
  return "This capability cannot be inserted in a message.";
}

export function matchingComposerCapabilities(
  capabilities: readonly EngineComposerCapability[],
  query: string,
): EngineComposerCapability[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...capabilities];
  return capabilities.filter((capability) =>
    [capability.label, capability.kind, capability.description]
      .some((value) => value.toLocaleLowerCase().includes(normalized)),
  );
}

export function insertComposerCapability(
  text: string,
  caret: number,
  capability: EngineComposerCapability,
): { text: string; caret: number } | undefined {
  if (!capability.insertText || composerCapabilityDisabledReason(capability)) return undefined;
  return {
    text: `${text.slice(0, caret)}${capability.insertText}${text.slice(caret)}`,
    caret: caret + capability.insertText.length,
  };
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

export function shouldExtractLongPaste(value: string): boolean {
  return unicodeCodePointLength(value) > INLINE_TEXT_MAX_CODE_POINTS;
}

export function composerSubmissionText(text: string, pastedText?: string): string {
  return [text.trim(), pastedText?.trim()].filter((part): part is string => Boolean(part)).join("\n\n");
}

export function shouldShowQueueControl(input: {
  text: string;
  hasAttachments: boolean;
  agentResponding: boolean;
  disabled: boolean;
}): boolean {
  return input.agentResponding && !input.disabled && (input.text.trim().length > 0 || input.hasAttachments);
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
    case "trigger": return "Trigger";
    case "decision": return "Decision response";
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

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function artifactDisplayLabel(artifact: Pick<ArtifactDto, "kind" | "path" | "summary">): string {
  const summary = artifact.summary?.trim();
  const fileAction = summary?.match(/^(create|edit|delete)\s+(.+)$/i);
  if (fileAction) {
    const action = fileAction[1]![0]!.toUpperCase() + fileAction[1]!.slice(1).toLowerCase();
    return `${action} · ${fileName(fileAction[2]!)}`;
  }
  if (artifact.kind === "log" && summary) {
    const command = summary.replace(/^\/bin\/(?:ba)?sh\s+-lc\s+/, "");
    return `Command · ${command.length > 56 ? `${command.slice(0, 55)}…` : command}`;
  }
  return summary || fileName(artifact.path) || "Result";
}

export const CHAT_BOTTOM_THRESHOLD = 48;

export function isChatNearBottom(
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">,
): boolean {
  return element.scrollHeight - element.clientHeight - element.scrollTop <= CHAT_BOTTOM_THRESHOLD;
}

/**
 * Stable layout signal for chat follow-mode. Query refreshes often allocate a
 * new message array even when its rendered content is unchanged; using that
 * array as an effect dependency makes a reader who scrolled up fight repeated
 * scroll-to-bottom writes.
 */
export function chatMessageLayoutKey(messages: ReadonlyArray<{
  id: string;
  text: string;
  createdAt: string;
  attachments?: readonly unknown[];
  fileActivity?: readonly unknown[];
}>): string {
  const last = messages.at(-1);
  return last
    ? `${messages.length}:${last.id}:${last.createdAt}:${last.text.length}:${last.attachments?.length ?? 0}:${last.fileActivity?.length ?? 0}`
    : "0";
}

export function scrollChatToBottom(element: Pick<HTMLElement, "scrollHeight" | "scrollTop">): void {
  element.scrollTop = element.scrollHeight;
}

export function ScrollToLatestButton({ visible, onClick }: { visible: boolean; onClick(): void }): JSX.Element | null {
  if (!visible) return null;
  return <Tooltip title="Jump to latest message">
    <IconButton
      aria-label="Jump to latest message"
      onClick={onClick}
      sx={{
        position: "absolute",
        right: { xs: 12, sm: 20 },
        bottom: 14,
        zIndex: 2,
        width: 36,
        height: 36,
        color: "primary.light",
        bgcolor: "background.paper",
        border: 1,
        borderColor: "divider",
        boxShadow: 3,
        "&:hover": { bgcolor: "action.selected" },
      }}
    ><KeyboardArrowDownIcon /></IconButton>
  </Tooltip>;
}

const scrollActivityTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/** Reveal the already-reserved scrollbar thumb for touch, wheel, and keyboard scrolling. */
export function revealChatScrollbar(element: HTMLElement): void {
  element.classList.add("is-scrolling");
  const activeTimer = scrollActivityTimers.get(element);
  if (activeTimer) clearTimeout(activeTimer);
  const timer = setTimeout(() => {
    element.classList.remove("is-scrolling");
    scrollActivityTimers.delete(element);
  }, 700);
  scrollActivityTimers.set(element, timer);
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

function fencedCodeLanguage(children: ReactNode): string {
  const nodes = Array.isArray(children) ? children : [children];
  for (const node of nodes) {
    if (!node || typeof node !== "object" || !("props" in node)) continue;
    const className = (node as { props: { className?: unknown } }).props.className;
    if (typeof className !== "string") continue;
    const match = /(?:^|\s)language-([^\s]+)/u.exec(className);
    if (match?.[1]) return match[1].toLocaleLowerCase();
  }
  return "text";
}

function CopyableCodeBlock({ children }: { children?: ReactNode }): JSX.Element {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const resetTimer = useRef<number>();
  const theme = useTheme();
  const code = codeBlockText(children).replace(/\n$/, "");
  const language = fencedCodeLanguage(children);
  const highlighted = !["text", "txt", "plaintext", "none"].includes(language);

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
      await copyText(code);
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
    <Box sx={{ my: 1, maxWidth: "100%", minWidth: 0, overflow: "hidden", borderRadius: 2, bgcolor: "action.hover", border: 1, borderColor: "divider" }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ minHeight: 38, px: 1.5, color: "text.secondary", borderBottom: 1, borderColor: "divider" }}>
        <Typography variant="caption" sx={{ fontFamily: "monospace", textTransform: "lowercase" }}>{language}</Typography>
        <Tooltip title={label}>
          <IconButton aria-label={label} size="small" onClick={() => void copyCode()}>
            {copyState === "copied" ? <CheckIcon fontSize="inherit" /> : <ContentCopyIcon fontSize="inherit" />}
          </IconButton>
        </Tooltip>
      </Stack>
      <Box sx={{ maxWidth: "100%", overflowX: "auto", overscrollBehaviorX: "contain" }}>
        {highlighted ? <SyntaxHighlighter
          language={language}
          style={theme.palette.mode === "dark" ? vscDarkPlus : oneLight}
          PreTag="div"
          wrapLongLines={false}
          customStyle={{ margin: 0, padding: "16px 18px", minWidth: "max-content", background: "transparent", fontSize: "0.875rem", lineHeight: 1.55 }}
          codeTagProps={{ style: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" } }}
        >{code}</SyntaxHighlighter> : <Box
          component="pre"
          sx={{ m: 0, p: 2, minWidth: "max-content", whiteSpace: "pre", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: "0.875rem", lineHeight: 1.55, color: "text.primary", bgcolor: "transparent" }}
        >{code}</Box>}
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
  agentMentionForHandle,
  onOpenAgent,
  onOpenBroadcast,
  previewScope,
  projectId,
}: {
  children: string;
  agentIdForHandle?(handle: string): string | undefined;
  agentMentionForHandle?(handle: string): { agentId: string; label: string } | undefined;
  onOpenAgent?(agentId: string): void;
  onOpenBroadcast?(): void;
  previewScope?: LinkPreviewScope;
  projectId?: string;
}): JSX.Element {
  return (
    <Box
      sx={{
        width: "100%",
        maxWidth: "100%",
        minWidth: 0,
        overflowWrap: "anywhere",
        // Let Markdown own block separation. Preserving whitespace on the
        // container also renders the source newlines between paragraphs,
        // headings, and lists as additional visual rows.
        whiteSpace: "normal",
        "& > :first-of-type": { mt: 0 },
        "& > :last-child": { mb: 0 },
        fontSize: "0.9375rem",
        lineHeight: 1.48,
        "& p": { my: 0.35, maxWidth: "100%", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" },
        "& h1, & h2, & h3, & h4": { mt: 1.05, mb: 0.4, lineHeight: 1.22 },
        "& h1": { fontSize: "1.35rem" },
        "& h2": { fontSize: "1.2rem" },
        "& h3, & h4": { fontSize: "1.05rem" },
        "& ul, & ol": { my: 0.45, pl: 2.75 },
        "& li": { maxWidth: "100%", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" },
        "& li + li": { mt: 0.15 },
        "& blockquote": { my: 0.65, mx: 0, pl: 1.5, whiteSpace: "pre-wrap", borderLeft: 3, borderColor: "divider" },
        "& code": { fontFamily: "monospace", fontSize: "0.875em" },
        "& :not(pre) > code": { px: 0.5, py: 0.125, borderRadius: 0.75, bgcolor: "action.hover" },
        "& pre": { my: 0.65, p: 1.1, maxWidth: "100%", overflowX: "auto", borderRadius: 1, bgcolor: "action.hover" },
        "& img": { display: "block", maxWidth: "100%", height: "auto", objectFit: "contain" },
        "& table": { display: "block", maxWidth: "100%", overflowX: "auto", borderCollapse: "collapse" },
        "& th, & td": { px: 1, py: 0.5, border: 1, borderColor: "divider" },
        "& a": { maxWidth: "100%", color: "inherit", textDecoration: "underline", overflowWrap: "anywhere", wordBreak: "break-word" },
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMessageTags]}
        components={{
          pre: ({ children: code }) => <CopyableCodeBlock>{code}</CopyableCodeBlock>,
          img: ({ src, alt }) => {
            const projectPreview = projectFileHref(projectId ?? previewScope?.projectId, src, "preview");
            const image = <Box component="img" src={projectPreview ?? src} alt={alt ?? "Agent-provided image"} loading="lazy" sx={{ display: "block", width: "auto", maxWidth: "100%", maxHeight: { xs: 320, md: 520 }, objectFit: "contain", borderRadius: 1.5 }} />;
            return projectPreview
              ? <Box component="a" href={projectPreview} target="_blank" rel="noreferrer" aria-label={`Open ${alt ?? "agent-provided image"} full size`} sx={{ display: "inline-block", maxWidth: "100%" }}>{image}</Box>
              : image;
          },
          a: ({ href, children: label }) => {
            if (!href?.startsWith(MESSAGE_TAG_PREFIX)) return <ChatLink href={href ?? ""} previewScope={previewScope} projectId={projectId}>{label}</ChatLink>;
            const handle = decodeURIComponent(href.slice(MESSAGE_TAG_PREFIX.length));
            if (handle.toLocaleLowerCase() === "broadcast" && onOpenBroadcast) {
              return <Box className="chat-text-navigation" component="button" type="button" aria-label="Open originating broadcast in Project chat" onClick={onOpenBroadcast} sx={{ display: "inline", p: 0, border: 0, bgcolor: "transparent", color: "inherit", font: "inherit", fontWeight: 600, textDecoration: "underline", textUnderlineOffset: 2, cursor: "pointer" }}>{label}</Box>;
            }
            const boundMention = agentMentionForHandle?.(handle);
            const agentId = boundMention?.agentId ?? agentIdForHandle?.(handle);
            const visibleLabel = boundMention ? `#${boundMention.label}` : label;
            if (!agentId || !onOpenAgent) {
              return <Box component="span" data-message-tag={handle.toLocaleLowerCase()} sx={{ fontWeight: 600, textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 2 }}>{visibleLabel}</Box>;
            }
            return <Box className="chat-text-navigation" component="button" type="button" aria-label={`Open agent ${boundMention?.label ?? handle}`} onClick={() => onOpenAgent(agentId)} sx={{ display: "inline", p: 0, border: 0, bgcolor: "transparent", color: "inherit", font: "inherit", fontWeight: 600, textDecoration: "underline", textUnderlineOffset: 2, cursor: "pointer" }}>{visibleLabel}</Box>;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </Box>
  );
}

export function MessageMarkdown({ text, agentIdForHandle, agentMentionForHandle, onOpenAgent, onOpenBroadcast, previewScope, projectId }: {
  text: string;
  agentIdForHandle?(handle: string): string | undefined;
  agentMentionForHandle?(handle: string): { agentId: string; label: string } | undefined;
  onOpenAgent?(agentId: string): void;
  onOpenBroadcast?(): void;
  previewScope?: LinkPreviewScope;
  projectId?: string;
}): JSX.Element {
  return <ChatMarkdown agentIdForHandle={agentIdForHandle} agentMentionForHandle={agentMentionForHandle} onOpenAgent={onOpenAgent} onOpenBroadcast={onOpenBroadcast} previewScope={previewScope} projectId={projectId}>{text}</ChatMarkdown>;
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
      <Button className="chat-text-navigation" size="small" color="inherit" onClick={() => setExpanded((value) => !value)}>{expanded ? "Hide" : "Preview"}</Button>
      <Button className="chat-text-navigation" size="small" component="a" href={document.downloadUrl} download>Download</Button>
    </Stack>
    {expanded ? <Box sx={{ mt: 1, pt: 1, borderTop: 1, borderColor: "divider" }}>
      {query.isLoading ? <CircularProgress size={20} /> : query.data ? <ChatMarkdown>{query.data.content}</ChatMarkdown> : <Alert severity="error">Document preview is unavailable.</Alert>}
    </Box> : null}
  </Paper>;
}

export function ChatMessageBody({ text, citations, collapseLongMessage = true, agentIdForHandle, agentMentionForHandle, onOpenAgent, onOpenBroadcast, previewScope, projectId }: {
  text: string;
  citations?: VerifiedCitationDto[];
  collapseLongMessage?: boolean;
  agentIdForHandle?(handle: string): string | undefined;
  agentMentionForHandle?(handle: string): { agentId: string; label: string } | undefined;
  onOpenAgent?(agentId: string): void;
  onOpenBroadcast?(): void;
  previewScope?: LinkPreviewScope;
  projectId?: string;
}): JSX.Element {
  const collapsible = collapseLongMessage && isLongChatMessage(text);
  const [expanded, setExpanded] = useState(false);
  return (
    <Box sx={{ width: "100%", maxWidth: "100%", minWidth: 0 }}>
      <Box
        sx={{
          width: "100%",
          maxWidth: "100%",
          minWidth: 0,
          ...(collapsible && !expanded ? {
            maxHeight: "22rem",
            overflow: "hidden",
            maskImage: "linear-gradient(to bottom, black calc(100% - 3rem), transparent)",
          } : {}),
        }}
      >
        <MessageMarkdown text={text} agentIdForHandle={agentIdForHandle} agentMentionForHandle={agentMentionForHandle} onOpenAgent={onOpenAgent} onOpenBroadcast={onOpenBroadcast} previewScope={previewScope} projectId={projectId} />
      </Box>
      {collapsible ? (
        <Button
          className="chat-text-navigation"
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

export function UserMessageLabel({ profile }: { profile?: OperatorProfileDto }): JSX.Element {
  const glyph = ({ "default-user": "🌲", sunset: "🌅", river: "🌊", mountain: "⛰️", fox: "🦊", owl: "🦉" } as Record<string, string>)[profile?.avatarId ?? "default-user"] ?? "●";
  return (
    <Stack direction="row" spacing={0.75} sx={{ mb: 0.25, px: { xs: 1, sm: 1.5 }, alignItems: "center" }}>
      <Avatar aria-label={`${profile?.displayName ?? "User"} profile picture`} sx={{ width: 22, height: 22, fontSize: 13, bgcolor: "action.selected" }}>{glyph}</Avatar>
      <Typography variant="caption" component="div" sx={{ fontWeight: 700, color: "text.secondary" }}>{profile?.displayName ?? "User"}</Typography>
    </Stack>
  );
}

export function ChatPane({
  messages,
  agentName = "Agent",
  agentNameForId,
  agentIdForHandle,
  onOpenAgent,
  onOpenWorkLog,
  onOpenBroadcast,
  onReact,
  onReply,
  previewScope,
  scrollStorageKey,
  operatorProfile,
  projectId,
}: {
  messages: MessageDto[];
  agentName?: string;
  agentNameForId?(agentId: string): string | undefined;
  agentIdForHandle?(handle: string): string | undefined;
  onOpenAgent?(agentId: string): void;
  onOpenWorkLog?(agentId: string): void;
  onOpenBroadcast?(message: MessageDto): void;
  onReact?(message: MessageDto, emoji: string): Promise<void>;
  onReply?(message: MessageDto): void;
  previewScope?: LinkPreviewScope;
  scrollStorageKey?: string;
  operatorProfile?: OperatorProfileDto;
  projectId?: string;
}): JSX.Element {
  const chatMessages = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const messageLayoutKey = chatMessageLayoutKey(chatMessages);
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldFollowNewMessages = useRef(true);
  const restoredScrollKey = useRef<string>();
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);

  useLayoutEffect(() => {
    if (!scrollRef.current) return;
    if (scrollStorageKey && restoredScrollKey.current !== scrollStorageKey) {
      restoredScrollKey.current = scrollStorageKey;
      const saved = readScrollPosition(scrollStorageKey);
      if (saved !== undefined) {
        scrollRef.current.scrollTop = saved;
        shouldFollowNewMessages.current = isChatNearBottom(scrollRef.current);
        setShowScrollToLatest(!shouldFollowNewMessages.current);
        return;
      }
    }
    if (shouldFollowNewMessages.current) {
      scrollChatToBottom(scrollRef.current);
      setShowScrollToLatest(false);
    }
  }, [messageLayoutKey, scrollStorageKey]);

  return (
    <Box sx={{ position: "relative", height: "100%", minHeight: 0, minWidth: 0 }}>
    <Stack
      component="section"
      aria-label="Conversation"
      className="chat-scroll-region"
      ref={scrollRef}
      spacing={0}
      tabIndex={0}
      onScroll={(event) => {
        revealChatScrollbar(event.currentTarget);
        if (scrollRef.current) {
          shouldFollowNewMessages.current = isChatNearBottom(scrollRef.current);
          setShowScrollToLatest(!shouldFollowNewMessages.current);
          if (scrollStorageKey) writeChatState(scrollStorageKey, String(scrollRef.current.scrollTop));
        }
      }}
      sx={{ px: { xs: 1, sm: 2, md: 3, lg: 4 }, py: { xs: 1, sm: 1.5 }, pb: 3, height: "100%", minHeight: 0, overflowY: "auto", overflowX: "hidden", overscrollBehavior: "contain", "& > *": { width: "min(1120px, 100%)", alignSelf: "center" } }}
    >
      {chatMessages.length === 0 ? (
        <Alert severity="info">Send a message to this agent to start the conversation.</Alert>
      ) : null}
      {chatMessages.map((message) => {
        const visibleAgentName = message.authorAgentId
          ? agentNameForId?.(message.authorAgentId) ?? "Agent"
          : agentName;
        const senderLabel = message.role === "user" && operatorProfile
          ? operatorProfile.displayName
          : individualChatSenderLabel(message.role, visibleAgentName);
        const fromUser = message.role === "user";
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
            width: "min(1120px, 100%)",
            maxWidth: "100%",
            minWidth: 0,
            py: { xs: 0.75, sm: 1 },
          }}
        >
          <Stack direction="row" spacing={{ xs: 1, sm: 1.5 }} sx={{ alignItems: "flex-start", justifyContent: fromUser ? "flex-end" : "flex-start", minWidth: 0 }}>
            {!fromUser ? <Avatar aria-label={`${senderLabel} avatar`} sx={{ width: 36, height: 36, flex: "0 0 auto", bgcolor: (theme) => theme.palette.mode === "dark" ? "#25302F" : "#F0F1EC", color: "text.primary", fontSize: 15, fontWeight: 750 }}>{senderLabel.slice(0, 1).toLocaleUpperCase()}</Avatar> : null}
            <Box sx={{ minWidth: 0, width: fromUser ? "fit-content" : "min(100%, 960px)", maxWidth: fromUser ? { xs: "94%", sm: "88%", md: "min(78%, 780px)" } : "100%" }}>
              {!fromUser ? <Stack direction="row" spacing={0.75} sx={{ minHeight: 28, alignItems: "center", mb: 0.25 }}>
                <Box sx={{ "& [data-message-sender]": { mb: 0, fontSize: 14 } }}><MessageSenderLabel name={senderLabel} /></Box>
                <Box sx={{ color: "text.secondary" }}><MessageTimestamp value={message.createdAt} compact align="start" /></Box>
              </Stack> : null}
              {fromUser ? <Box sx={{ display: "flex", justifyContent: "flex-end", mb: 0.25 }}><UserMessageLabel profile={operatorProfile} /></Box> : null}
              <Box
                data-message-bubble="true"
                sx={{
                  px: fromUser ? { xs: 1.25, sm: 1.5 } : 0,
                  py: fromUser ? { xs: 1, sm: 1.15 } : 0,
                  borderRadius: 2,
                  bgcolor: fromUser ? (theme) => theme.palette.mode === "dark" ? "#27332F" : "#EFF0EB" : "transparent",
                  color: "text.primary",
                  border: 0,
                }}
              >
            {fromUser ? <Box sx={{ position: "absolute", width: 1, height: 1, p: 0, m: -1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 }}><MessageSenderLabel name="You" /></Box> : null}
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
            <ChatMessageBody
              text={message.text}
              citations={message.citations}
              collapseLongMessage={fromUser}
              agentIdForHandle={agentIdForHandle}
              agentMentionForHandle={(handle) => {
                const binding = message.agentMentions?.find((item) => item.handle.toLocaleLowerCase() === handle.toLocaleLowerCase());
                const title = binding ? agentNameForId?.(binding.agentId) : undefined;
                return binding && title ? { agentId: binding.agentId, label: agentMentionHandle(title) } : undefined;
              }}
              onOpenAgent={onOpenAgent}
              onOpenBroadcast={message.role === "assistant" && message.conversationId && message.communicationEventId && /^\s*#broadcast(?:\s|$)/iu.test(message.text)
                ? () => onOpenBroadcast?.(message)
                : undefined}
              previewScope={linkPreviewScopeForMessage(message, previewScope)}
              projectId={projectId ?? previewScope?.projectId}
            />
            {message.document ? <CommunicationDocumentCard document={message.document} /> : null}
            {message.attachments?.length ? <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: message.text ? 1 : 0 }}>
              {message.attachments.map((attachment) => <Box key={attachment.id} component="a" href={attachment.downloadUrl ?? attachment.url} target="_blank" rel="noreferrer" aria-label={`Download ${attachment.name}`} sx={{ maxWidth: "100%" }}>
                {attachment.previewUrl || !attachment.mediaType || attachment.mediaType.startsWith("image/")
                  ? <Box component="img" src={attachment.previewUrl ?? attachment.url} alt={attachment.name} sx={{ display: "block", width: "auto", maxWidth: { xs: "100%", sm: 220 }, maxHeight: 180, objectFit: "contain", borderRadius: 1 }} />
                  : <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{attachment.name} · {attachment.mediaType} · {attachment.size} bytes</Typography>}
              </Box>)}
            </Stack> : null}
            <MessageReactions reactions={message.reactions} />
              </Box>
              <MessageActionsAndTimestamp
                showTimestamp={fromUser}
                value={message.createdAt}
                status={message.role === "user" && message.deliveryReceipts?.length ? <MessageDeliveryStatus
                  receipts={message.deliveryReceipts}
                  recipientName={(agentId) => agentNameForId?.(agentId) ?? agentName}
                  onOpenAgent={onOpenAgent}
                  onOpenWorkLog={onOpenWorkLog}
                /> : undefined}
                actions={<>
              {message.role === "assistant" && message.communicationEventId && onReact ? <EmojiReactionPicker recipientName={senderLabel} onReact={(emoji) => onReact(message, emoji)} /> : null}
              <CopyMessageButton text={message.text} />
              {onReply ? <IconButton size="small" aria-label="Reply to message" onClick={() => onReply(message)}><ReplyIcon fontSize="inherit" /></IconButton> : null}
                </>}
              />
            </Box>
          </Stack>
        </Box>
        );
      })}
    </Stack>
    <ScrollToLatestButton
      visible={showScrollToLatest}
      onClick={() => {
        if (!scrollRef.current) return;
        shouldFollowNewMessages.current = true;
        scrollChatToBottom(scrollRef.current);
        setShowScrollToLatest(false);
      }}
    />
    </Box>
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

export function ResponseFileActivity({
  files,
  onOpenFile,
  onViewAll,
  projectId,
}: {
  files: ResponseFileActivityDto[];
  onOpenFile?(file: ResponseFileActivityDto): void;
  onViewAll?(): void;
  projectId?: string;
}): JSX.Element | null {
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
            return <Stack key={`${file.sourceSeq}:${file.path}`} direction="row" sx={{ alignItems: "center", minWidth: 0 }}>
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
                  {file.kind}{file.additions !== undefined || file.deletions !== undefined ? ` · +${file.additions ?? 0} −${file.deletions ?? 0}` : " · Files & results"}
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
      {onViewAll ? <Button size="small" color="inherit" onClick={onViewAll} sx={{ flexShrink: 0, minWidth: 0, px: 0.75 }}>Review all</Button> : null}
    </Stack>
  </Box>;
}

export function WorkLogPane({ entries, focusId, onOpenFile, onViewAll, projectId }: {
  entries: RunOutputDto[];
  focusId?: string;
  onOpenFile?(file: ResponseFileActivityDto): void;
  onViewAll?(): void;
  projectId?: string;
}): JSX.Element {
  const ordered = [...entries].sort((a, b) => a.seq - b.seq);
  return (
    <Stack spacing={1.25} sx={{ p: 1.5, pb: 3, minHeight: 0 }} aria-label="Agent work log">
      <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
        <Typography variant="overline" color="text.secondary" sx={{ flex: 1 }}>Work log</Typography>
        <Typography variant="caption" color="text.secondary">{ordered.length}</Typography>
      </Stack>
      {ordered.length === 0 ? <Alert severity="info">Ordinary agent output will appear here. Only explicitly sent messages appear in Chat.</Alert> : ordered.map((entry) => (
        <Paper key={entry.id} id={telemetryElementId("runOutput", entry.id)} tabIndex={focusId === entry.id ? -1 : undefined} variant="outlined" sx={{ p: 1.25 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 0.75 }}>
            <Chip size="small" variant="outlined" label={entry.kind === "reasoning" ? "Reasoning" : entry.completed ? "Response" : "Response · live"} />
            <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
              Run {entry.executionId.slice(0, 8)} · {new Date(entry.createdAt).toLocaleString()}
            </Typography>
          </Stack>
          <Typography component="div" variant="body2" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {entry.text}
          </Typography>
          {entry.kind === "response" && entry.fileActivity?.length
            ? <ResponseFileActivity files={entry.fileActivity} onOpenFile={onOpenFile} onViewAll={onViewAll} projectId={projectId} />
            : null}
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
        <Alert severity={coordinationV3.requests.some((request) => request.state === "outcome_unknown") ? "warning" : coordinationV3.availability === "waiting" ? "info" : "success"}>
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
          {coordinationV3.requests.filter((request) => request.direction === "outbound" && ["outcome_unknown", "failed", "recipient_unavailable"].includes(request.state)).map((request) => (
            <RetryRequestButton key={request.id} requestId={request.id} />
          ))}
          {coordinationV3.requests.filter((request) => request.direction === "outbound" && !["completed", "blocked", "failed", "cancelled", "superseded", "recipient_unavailable", "outcome_unknown", "expired"].includes(request.state)).map((request) => (
            <CancelRequestButton key={request.id} requestId={request.id} />
          ))}
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
                <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                  Started by {wakeCauseLabel(run.wakeCause)}
                </Typography>
              ) : null}
              <Typography variant="caption" color={run.usage ? "text.secondary" : "warning.main"} sx={{ display: "block" }}>
                {run.usage
                  ? `${new Intl.NumberFormat().format(run.usage.totalTokens ?? 0)} tokens · ${new Intl.NumberFormat().format(run.usage.inputTokens ?? 0)} in / ${new Intl.NumberFormat().format(run.usage.outputTokens ?? 0)} out`
                  : run.status === "running" ? "Usage available when this run finishes" : "Usage not reported"}
              </Typography>
              {onOpenAgentWork ? <Button size="small" sx={{ mt: 0.5 }} onClick={() => onOpenAgentWork(run.id)}>View Agent work</Button> : null}
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

function RetryRequestButton({ requestId }: { requestId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return <Box sx={{ mt: 0.5 }}>
    <Button size="small" variant="outlined" disabled={busy} onClick={async () => {
      setBusy(true); setError(undefined);
      try {
        const response = await fetch(`/api/requests/${encodeURIComponent(requestId)}/retry`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ idempotencyKey: `operator-retry:${requestId}`, createJoin: true }),
        });
        const body = await response.json() as { error?: string };
        if (!response.ok) throw new Error(body.error ?? "Retry failed");
        await queryClient.invalidateQueries();
      } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
      finally { setBusy(false); }
    }}>{busy ? "Retrying…" : `Retry request ${requestId.slice(0, 8)}`}</Button>
    {error ? <Typography variant="caption" color="error" sx={{ ml: 1 }}>{error}</Typography> : null}
  </Box>;
}

function CancelRequestButton({ requestId }: { requestId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return <Box sx={{ mt: 0.5, ml: 0.5, display: "inline-block" }}>
    <Button size="small" color="warning" variant="outlined" disabled={busy} onClick={async () => {
      setBusy(true); setError(undefined);
      try {
        const response = await fetch(`/api/requests/${encodeURIComponent(requestId)}/cancel`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ idempotencyKey: `operator-cancel:${requestId}` }),
        });
        const body = await response.json() as { error?: string };
        if (!response.ok) throw new Error(body.error ?? "Cancellation failed");
        await queryClient.invalidateQueries();
      } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
      finally { setBusy(false); }
    }}>{busy ? "Cancelling…" : `Cancel request ${requestId.slice(0, 8)}`}</Button>
    {error ? <Typography variant="caption" color="error" sx={{ ml: 1 }}>{error}</Typography> : null}
  </Box>;
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
      Context {run.providerInput!.promptHash.slice(0, 12)} · {manifest.providerSessionDisposition.replaceAll("_", " ")} · {manifest.historyMessageCount} submitted history · {manifest.schemaVersion === 2 ? `${manifest.retainedSessionSourceCount} retained-session source(s) · ` : ""}{manifest.activationIds.length} activation(s) · {manifest.artifactIds.length} artifact(s)
    </Typography>
    <Button size="small" sx={{ px: 0, minWidth: 0 }} onClick={() => setShowExact((value) => !value)}>
      {showExact ? "Hide exact provider input" : "Show exact provider input"}
    </Button>
    {showExact ? <Paper variant="outlined" sx={{ p: 1, mt: 0.5, maxHeight: 260, overflow: "auto" }}>
      <Typography variant="caption" component="pre" sx={{ m: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {exact.isPending ? "Loading…" : exact.isError ? exact.error.message : exact.data?.exactPrompt}
      </Typography>
    </Paper> : null}
  </Box>;
}

/** Refresh-safe chronological projection of canonical execution events. */
export function ActivityPane({ activity, connected, running, activeExecutionId, focusId }: {
  activity: AgentActivityDto[];
  connected: boolean;
  running: boolean;
  activeExecutionId?: string;
  focusId?: string;
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
          {group.items.map((item) => <Paper component="details" key={item.id} id={telemetryElementId("activity", item.id)} tabIndex={focusId === item.id ? -1 : undefined} variant="outlined" sx={{ p: 0.75, "& > summary": { cursor: "pointer" } }}>
            <Box component="summary"><EventLine item={{ id: item.id, seq: item.seq, ts: item.createdAt, event: item.event }} /></Box>
            <Typography variant="caption" color="text.secondary" sx={{ pl: 1.25 }}>{new Date(item.createdAt).toLocaleString()}</Typography>
            {item.outputPreview ? <ExactActivityOutput item={item} /> : null}
          </Paper>)}
        </Stack>
      </Paper>;
    })}
  </Stack>;
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
      {open ? "Hide full output" : `Load full output (${reference.totalUtf8Bytes.toLocaleString()} bytes)`}
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
              }}>{loadingMore ? "Loading…" : "Load more"}</Button> : null}
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
            : <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "minmax(220px, 32%) minmax(0, 1fr)" }, minHeight: 0 }}>
              <Stack sx={{ overflowY: "auto", borderRight: { lg: 1 }, borderBottom: { xs: 1, lg: 0 }, borderColor: "divider", maxHeight: { xs: 220, lg: "none" } }}>
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
    const current = unifiedDiffLineTotals(file.diff) ?? { additions: 0, deletions: 0 };
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

export { unifiedDiffLineTotals } from "@ponderosa/core";

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
    enabled: Boolean(artifact && artifact.kind !== "document" && artifact.kind !== "screenshot" && !artifact.id.startsWith("live-artifact-")),
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
        <Typography variant="subtitle2" sx={{ flex: 1 }}>{artifactDisplayLabel(artifact)}</Typography>
        {artifact.previewUrl ? <Button component="a" href={artifact.previewUrl} target="_blank" rel="noreferrer" size="small" variant="outlined">Open preview</Button> : null}
        {artifact.downloadUrl ? <Button component="a" href={artifact.downloadUrl} size="small" variant="contained" download>Download</Button> : null}
      </Stack>
      {artifact.previewUrl ? <Box component="iframe" title={`Preview ${artifact.path}`} src={artifact.previewUrl} sx={{ width: "100%", height: { xs: "55vh", md: "66vh" }, border: 1, borderColor: "divider", borderRadius: 1, bgcolor: "background.paper" }} /> : <Alert severity="info">The PDF is still being indexed. Refresh to preview or download it.</Alert>}
    </Box>;
  }

  if (artifact.kind === "screenshot" && artifact.previewUrl) {
    return <Box sx={{ p: 1.5, minWidth: 0 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
        <Typography variant="subtitle2" sx={{ flex: 1 }}>{artifactDisplayLabel(artifact)}</Typography>
        <Button component="a" href={artifact.previewUrl} target="_blank" rel="noreferrer" size="small" variant="outlined">Open</Button>
        {artifact.downloadUrl ? <Button component="a" href={artifact.downloadUrl} size="small" variant="contained" download>Download</Button> : null}
      </Stack>
      <Box component="img" src={artifact.previewUrl} alt={artifact.summary ?? "Browser screenshot"} sx={{ display: "block", maxWidth: "100%", maxHeight: { xs: "55vh", md: "66vh" }, mx: "auto", border: 1, borderColor: "divider", borderRadius: 1 }} />
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
      <Stack spacing={0.25} sx={{ mb: 1, minWidth: 0 }}>
        <Typography variant="subtitle2">{artifactDisplayLabel(content)}</Typography>
        <Typography variant="caption" color="text.secondary" noWrap title={content.path}>{compactPath(content.path)}</Typography>
      </Stack>
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
  initialArtifactId,
}: {
  artifacts: ArtifactDto[];
  agentId: string;
  timeline: ExecutionItem[];
  initialArtifactId?: string;
}): JSX.Element {
  const orderedArtifacts = [...artifacts].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | undefined>(
    initialArtifactId && artifacts.some((artifact) => artifact.id === initialArtifactId)
      ? initialArtifactId
      : orderedArtifacts[0]?.id,
  );
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (initialArtifactId && artifacts.some((artifact) => artifact.id === initialArtifactId)) {
      if (selectedArtifactId !== initialArtifactId) setSelectedArtifactId(initialArtifactId);
    } else if (!selectedArtifactId || !artifacts.some((artifact) => artifact.id === selectedArtifactId)) {
      setSelectedArtifactId(orderedArtifacts[0]?.id);
    }
  }, [artifacts, initialArtifactId, orderedArtifacts, selectedArtifactId]);

  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const visibleArtifacts = orderedArtifacts.filter((artifact) => !normalizedFilter || [
    artifactDisplayLabel(artifact), artifact.path, artifact.summary, artifact.kind,
  ].filter(Boolean).join(" ").toLocaleLowerCase().includes(normalizedFilter));
  const groups = [
    { label: "Files", kinds: new Set<ArtifactDto["kind"]>(["generated_file", "document", "screenshot", "diff"]) },
    { label: "Results", kinds: new Set<ArtifactDto["kind"]>(["test_report", "pr_summary"]) },
    { label: "Activity", kinds: new Set<ArtifactDto["kind"]>(["log"]) },
  ].map((group) => ({ ...group, artifacts: visibleArtifacts.filter((artifact) => group.kinds.has(artifact.kind)) }))
    .filter((group) => group.artifacts.length > 0);

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
    <Box sx={{ display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", minHeight: 0, height: "100%", overflow: "hidden" }}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "center" }, px: 1.5, py: 1.25, borderBottom: 1, borderColor: "divider", bgcolor: "background.paper" }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle1" fontWeight={750}>Files &amp; results</Typography>
          <Typography variant="caption" color="text.secondary">{artifacts.length} item{artifacts.length === 1 ? "" : "s"} from this agent</Typography>
        </Box>
        <TextField
          size="small"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Search files and results"
          inputProps={{ "aria-label": "Search agent files and results" }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
          sx={{ width: { xs: "100%", sm: 280 } }}
        />
      </Stack>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "minmax(260px, 320px) minmax(0, 1fr)" }, gridTemplateRows: { xs: "minmax(180px, 34%) minmax(0, 1fr)", lg: "minmax(0, 1fr)" }, minHeight: 0 }}>
        <Box component="nav" aria-label="Agent files and results" sx={{ minHeight: 0, overflowY: "auto", borderRight: { lg: 1 }, borderBottom: { xs: 1, lg: 0 }, borderColor: "divider", bgcolor: "background.paper", p: 0.75 }}>
          {groups.length === 0 ? <Alert severity="info" sx={{ m: 0.75 }}>No files or results match “{filter.trim()}”.</Alert> : groups.map((group) => <Box key={group.label} sx={{ mb: 1 }}>
            <Typography variant="overline" color="text.secondary" sx={{ display: "block", px: 1, py: 0.5 }}>{group.label}</Typography>
            <List disablePadding>
              {group.artifacts.map((artifact) => {
                const selected = artifact.id === selectedArtifactId;
                return <ListItemButton
                  key={artifact.id}
                  id={telemetryElementId("artifacts", artifact.id)}
                  tabIndex={initialArtifactId === artifact.id ? -1 : undefined}
                  selected={selected}
                  onClick={() => setSelectedArtifactId(artifact.id)}
                  aria-current={selected ? "true" : undefined}
                  sx={{ borderRadius: 1.5, mb: 0.25, alignItems: "flex-start", px: 1, py: 0.75 }}
                >
                  <ListItemIcon sx={{ minWidth: 34, mt: 0.25, color: selected ? "primary.main" : "text.secondary" }}>{artifactIcon(artifact.kind)}</ListItemIcon>
                  <ListItemText
                    primary={artifactDisplayLabel(artifact)}
                    secondary={<>{compactPath(artifact.path)}<br />{new Date(artifact.createdAt).toLocaleString()}</>}
                    primaryTypographyProps={{ variant: "body2", fontWeight: selected ? 750 : 600, noWrap: true }}
                    secondaryTypographyProps={{ variant: "caption", color: "text.secondary", component: "span", sx: { lineHeight: 1.35 } }}
                    sx={{ minWidth: 0, m: 0 }}
                  />
                </ListItemButton>;
              })}
            </List>
          </Box>)}
        </Box>
        <Box sx={{ minWidth: 0, minHeight: 0, overflow: "auto", bgcolor: "background.default" }}>
          <ArtifactViewer artifact={selectedArtifact} agentId={agentId} liveContent={liveContent} />
        </Box>
      </Box>
    </Box>
  );
}

export function QueuedMessageTray({ messages, agentNameForId, busy, onSteer, onEdit, onDelete }: {
  messages: QueuedConversationMessageDto[];
  agentNameForId?(agentId: string): string;
  busy?: boolean;
  onSteer(message: QueuedConversationMessageDto): Promise<unknown> | unknown;
  onEdit(message: QueuedConversationMessageDto, text: string): Promise<unknown> | unknown;
  onDelete(message: QueuedConversationMessageDto): Promise<unknown> | unknown;
}): JSX.Element | null {
  const [editingId, setEditingId] = useState<string>();
  const [editingText, setEditingText] = useState("");
  if (messages.length === 0) return null;
  return <Paper
    variant="outlined"
    aria-label="Queued messages"
    sx={{
      width: "min(1180px, calc(100% - 16px))",
      mx: "auto",
      mb: -1,
      pb: 1.25,
      pt: 0.75,
      px: { xs: 1, sm: 1.5 },
      maxHeight: "min(38vh, 280px)",
      overflowY: "auto",
      borderRadius: "16px 16px 8px 8px",
      bgcolor: "background.paper",
      boxShadow: 2,
    }}
  >
    <Stack spacing={0.25}>
      {messages.map((message) => {
        const editing = editingId === message.deliveryId;
        return <Box key={message.deliveryId} sx={{ display: "flex", alignItems: "center", gap: 0.75, minHeight: 40, minWidth: 0 }}>
          <SubdirectoryArrowRightIcon aria-hidden sx={{ color: "text.disabled", fontSize: 20, flex: "0 0 auto" }} />
          {editing ? <TextField
            value={editingText}
            onChange={(event) => setEditingText(event.target.value)}
            size="small"
            fullWidth
            autoFocus
            multiline
            maxRows={4}
            inputProps={{ "aria-label": `Edit queued message ${message.position}` }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditingId(undefined);
              if (event.key === "Enter" && !event.shiftKey && editingText.trim()) {
                event.preventDefault();
                void Promise.resolve(onEdit(message, editingText.trim())).then(() => setEditingId(undefined));
              }
            }}
          /> : <Tooltip title={message.text}><Typography variant="body1" noWrap sx={{ flex: 1, minWidth: 0 }}>{message.text}</Typography></Tooltip>}
          {!editing && agentNameForId ? <Typography variant="caption" color="text.secondary" noWrap sx={{ display: { xs: "none", md: "block" }, maxWidth: 160 }}>
            {agentNameForId(message.targetAgentId)}
          </Typography> : null}
          {editing ? <>
            <Button size="small" disabled={busy || !editingText.trim()} onClick={() => void Promise.resolve(onEdit(message, editingText.trim())).then(() => setEditingId(undefined))}>Save</Button>
            <Button size="small" color="inherit" onClick={() => setEditingId(undefined)}>Cancel</Button>
          </> : <>
            <Button size="small" color="inherit" disabled={busy} startIcon={<SubdirectoryArrowRightIcon />} onClick={() => void onSteer(message)}>Steer</Button>
            <Tooltip title="Edit queued message"><span><IconButton size="small" disabled={busy} aria-label={`Edit queued message ${message.position}`} onClick={() => { setEditingId(message.deliveryId); setEditingText(message.text); }}><EditOutlinedIcon fontSize="small" /></IconButton></span></Tooltip>
            <Tooltip title="Delete queued message"><span><IconButton size="small" disabled={busy} aria-label={`Delete queued message ${message.position}`} onClick={() => void onDelete(message)}><DeleteOutlineIcon fontSize="small" /></IconButton></span></Tooltip>
          </>}
        </Box>;
      })}
    </Stack>
  </Paper>;
}

export function Composer({
  disabled,
  running,
  allowSendWhileRunning = false,
  placeholder,
  projectId,
  mentionHandles,
  commands,
  capabilities,
  onCapabilitiesOpen,
  attachmentsEnabled = true,
  attachmentsUnavailableReason,
  busyMentionHandles,
  allowUnmentionedSend = true,
  onSend,
  onQueue,
  preferQueue = false,
  queuedMentionHandles,
  agentResponding = false,
  onCancel,
  replyTo,
  onCancelReply,
  replyLabel,
  draftStorageKey,
  conversationDraftId,
  controls,
  guidance,
  focusReply = false,
}: {
  disabled: boolean;
  running: boolean;
  /** Keep the composer available while other Agents in this shared chat are working. */
  allowSendWhileRunning?: boolean;
  placeholder?: string;
  /** Project scope used by `@` file/folder reference autocomplete. */
  projectId?: string;
  /** When provided, typing `#` autocompletes these agent handles (group chat). */
  mentionHandles?: string[];
  /** Engine/system capabilities shown when the composer starts with `/`. */
  commands?: EngineCommand[];
  /** Adapter-normalized capabilities for the selected authenticated runtime. */
  capabilities?: EngineComposerCapability[];
  /** Refresh discovery immediately before the capability menu is shown. */
  onCapabilitiesOpen?(): Promise<unknown> | unknown;
  /** Whether this communication surface currently accepts staged assets. */
  attachmentsEnabled?: boolean;
  attachmentsUnavailableReason?: string;
  /** Mentioned agents that cannot accept a new turn yet. */
  busyMentionHandles?: string[];
  /** Whether text without a valid mention may be submitted. */
  allowUnmentionedSend?: boolean;
  onSend(text: string, files: File[], draftAttachmentIds?: string[]): Promise<unknown> | unknown;
  /** Explicitly enqueue this draft instead of steering the active agent turn. */
  onQueue?(text: string, files: File[], draftAttachmentIds?: string[]): Promise<unknown> | unknown;
  /** Make the primary send action enqueue while this direct Agent already has pending work. */
  preferQueue?: boolean;
  /** Agent handles whose existing pending work should make a targeted follow-up enqueue by default. */
  queuedMentionHandles?: string[];
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
  /** Context-specific targeting/file guidance rendered inside the shared shell. */
  guidance?: ReactNode;
  /** Focus the normal composer when a direct reply is selected. */
  focusReply?: boolean;
}): JSX.Element {
  const [text, setText] = useState(() => draftStorageKey ? readChatState(draftStorageKey) ?? "" : "");
  const [pastedText, setPastedText] = useState<string>();
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
  const capabilityListId = useId();
  const [capabilityMenuAnchor, setCapabilityMenuAnchor] = useState<HTMLElement | null>(null);
  const [capabilityFilter, setCapabilityFilter] = useState("");
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const submissionText = composerSubmissionText(text, pastedText);
  const mentionedHandles = findMentionedHandles(submissionText, mentionHandles ?? []);
  const queuedHandles = new Set((queuedMentionHandles ?? []).map((handle) => handle.toLocaleLowerCase()));
  const mentionedAgentsWithQueues = mentionedHandles.filter((handle) => queuedHandles.has(handle.toLocaleLowerCase()));
  const defaultsToQueue = Boolean(onQueue) && (preferQueue || (
    mentionedHandles.length > 0 && mentionedAgentsWithQueues.length === mentionedHandles.length
  ));
  const composerLocked = running && !allowSendWhileRunning;
  const busyHandles = new Set((busyMentionHandles ?? []).map((handle) => handle.toLocaleLowerCase()));
  const mentionedBusyHandles = mentionedHandles.filter((handle) => busyHandles.has(handle.toLocaleLowerCase()));
  const textCanSend = canSubmitComposerText({
    text: submissionText,
    disabled,
    running: composerLocked,
    allowUnmentionedSend,
    mentionedHandles,
    mentionedBusyHandles,
  });
  const canSend = textCanSend || (!disabled && !composerLocked && allowUnmentionedSend && files.length > 0);
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
      setPastedText(undefined);
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

  const applyCapability = (capability: EngineComposerCapability) => {
    const inserted = insertComposerCapability(text, caret, capability);
    if (!inserted) return;
    update(inserted.text);
    setCapabilityMenuAnchor(null);
    setCapabilityFilter("");
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(inserted.caret, inserted.caret);
      setCaret(inserted.caret);
    });
  };

  const visibleCapabilities = matchingComposerCapabilities(capabilities ?? [], capabilityFilter);

  const submit = (handler: (message: string, selectedFiles: File[], stagedAttachmentIds?: string[]) => Promise<unknown> | unknown) => {
    if (sendingRef.current || !canSend) return;
    sendingRef.current = true;
    setSendError(undefined);
    const stagedIds = files.map((file) => draftAttachmentIds.current.get(file)).filter((id): id is string => Boolean(id));
    void Promise.resolve(handler(submissionText, files, stagedIds)).then(() => {
      update("");
      setPastedText(undefined);
      dispatchAttachments({ type: "clear" });
      draftAttachmentIds.current.clear();
      setDraftAttachmentVersion((value) => value + 1);
      if (conversationDraftId) for (const id of stagedIds) void api.deleteDraftAttachment(conversationDraftId, id).catch(() => undefined);
      setCaret(0);
    }).catch((error: unknown) => setSendError(error instanceof Error ? error.message : "Upload failed; try again."))
      .finally(() => { sendingRef.current = false; });
  };
  const steer = () => submit(onSend);
  const queue = () => {
    if (!onQueue) return;
    submit(onQueue);
  };
  const send = () => defaultsToQueue ? queue() : steer();
  const showQueue = Boolean(onQueue) && shouldShowQueueControl({
    text: submissionText,
    hasAttachments: files.length > 0,
    agentResponding: agentResponding || mentionedBusyHandles.length > 0,
    disabled,
  });

  return (
    <Paper
      className="ponderosa-composer"
      elevation={0}
      sx={{
        position: "relative",
        zIndex: 3,
        border: 1,
        borderColor: "divider",
        borderRadius: { xs: 2, sm: 2.25 },
        width: { xs: "calc(100% - 16px)", sm: "calc(100% - 32px)", md: "min(1180px, calc(100% - 48px))", xl: "min(1240px, calc(100% - 64px))" },
        mx: "auto",
        mt: { xs: 0.75, sm: 1 },
        mb: { xs: 1, sm: 1.5 },
        minWidth: 0,
        maxWidth: "100%",
        overflow: "hidden",
        bgcolor: "background.paper",
        px: { xs: 1, sm: 1.5 },
        pt: { xs: 1, sm: 1.25 },
        pb: "max(10px, env(safe-area-inset-bottom))",
        boxShadow: (theme) => theme.palette.mode === "dark" ? "0 10px 30px rgba(3,8,6,.18)" : "0 10px 30px rgba(33,45,38,.09)",
      }}
    >
      {guidance ? (
        <Box sx={{ px: 0.25, pb: 0.9, color: "text.secondary" }}>
          {typeof guidance === "string" ? <Typography variant="body2" sx={{ fontSize: { xs: 12.5, sm: 13.5 }, lineHeight: 1.45 }}>{guidance}</Typography> : guidance}
        </Box>
      ) : null}
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
      {pastedText ? (
        <Paper variant="outlined" sx={{ mb: 1, px: 1, py: 0.75, display: "flex", alignItems: "center", gap: 1, maxWidth: 360 }}>
          <ArticleIcon color="action" fontSize="small" />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="body2" noWrap>Pasted text</Typography>
            <Button size="small" sx={{ p: 0, minWidth: 0, textTransform: "none" }} onClick={() => {
              update(composerSubmissionText(text, pastedText));
              setPastedText(undefined);
              requestAnimationFrame(() => inputRef.current?.focus());
            }}>Show in text field</Button>
          </Box>
          <Typography variant="caption" color="text.secondary">{utf8ByteLength(pastedText).toLocaleString()} bytes</Typography>
          <IconButton size="small" aria-label="Remove pasted text" onClick={() => setPastedText(undefined)}><CloseIcon fontSize="small" /></IconButton>
        </Paper>
      ) : null}
      {(attachments.error ?? sendError) ? <Alert severity="error" sx={{ mb: 1 }}>Message not sent. {attachments.error ?? sendError}</Alert> : null}
      {draftConflict ? <Alert severity="warning" sx={{ mb: 1 }} action={<Button size="small" onClick={() => { update(draftConflict.displaced.text); setDraftConflict(undefined); inputRef.current?.focus(); }}>Restore</Button>}>
        This chat changed in another tab. Your displaced draft is preserved: “{replyPreviewText(draftConflict.displaced.text)}”
      </Alert> : null}
      <Stack direction="row" spacing={{ xs: 0.25, sm: 0.5 }} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/webp,application/pdf,text/plain,application/json,application/zip,.txt,.md,.csv,.log,.json,.zip,.pdf" multiple onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }} />
        <Tooltip title="Add an image, file, skill, plugin, or connector"><span><IconButton
          aria-label="Add attachment or capability"
          aria-haspopup="menu"
          aria-expanded={Boolean(capabilityMenuAnchor)}
          aria-controls={capabilityMenuAnchor ? capabilityListId : undefined}
          disabled={disabled || composerLocked}
          onClick={(event) => {
            setCapabilityFilter("");
            setCapabilityMenuAnchor(event.currentTarget);
            void Promise.resolve(onCapabilitiesOpen?.()).catch(() => undefined);
          }}
          sx={{ minWidth: 44, minHeight: 44 }}
        ><AddIcon /></IconButton></span></Tooltip>
        <Popper open={Boolean(capabilityMenuAnchor)} anchorEl={capabilityMenuAnchor} placement="top-start" style={{ zIndex: 1400 }}>
          <ClickAwayListener onClickAway={() => { setCapabilityMenuAnchor(null); setCapabilityFilter(""); }}>
            <Paper elevation={5} sx={{ mb: 0.5, width: "min(420px, calc(100vw - 24px))", maxHeight: "min(52vh, 390px)", overflow: "hidden" }}>
              <Box sx={{ p: 1, borderBottom: 1, borderColor: "divider" }}>
                <TextField
                  autoFocus
                  fullWidth
                  size="small"
                  value={capabilityFilter}
                  onChange={(event) => setCapabilityFilter(event.target.value)}
                  placeholder="Find a skill, plugin, or connector"
                  inputProps={{ "aria-label": "Filter runtime capabilities" }}
                />
              </Box>
              <MenuList dense id={capabilityListId} aria-label="Add attachment or runtime capability" sx={{ maxHeight: "min(38vh, 300px)", overflowY: "auto", overscrollBehavior: "contain" }}>
                <MenuItem
                  disabled={!attachmentsEnabled || files.length >= COMPOSER_MAX_FILES}
                  onClick={() => { setCapabilityMenuAnchor(null); fileInput.current?.click(); }}
                  sx={{ whiteSpace: "normal", alignItems: "flex-start", minHeight: 54 }}
                >
                  <Box><Typography variant="body2">Upload image or file</Typography><Typography variant="caption" color="text.secondary">{!attachmentsEnabled
                    ? attachmentsUnavailableReason ?? "Attachments are not supported in this chat."
                    : files.length >= COMPOSER_MAX_FILES
                      ? "Remove an attachment before adding another."
                      : "PNG, JPEG, WebP, PDF, text, JSON, or ZIP · 8 MiB each"}</Typography></Box>
                </MenuItem>
                <Divider />
                {(capabilities ?? []).length === 0 ? (
                  <MenuItem disabled sx={{ whiteSpace: "normal" }}><Typography variant="caption">No runtime skills, plugins, or connectors are currently available.</Typography></MenuItem>
                ) : visibleCapabilities.length === 0 ? (
                  <MenuItem disabled><Typography variant="caption">No capabilities match “{capabilityFilter.trim()}”.</Typography></MenuItem>
                ) : visibleCapabilities.map((capability) => {
                  const reason = composerCapabilityDisabledReason(capability);
                  return <MenuItem
                    key={capability.id}
                    disabled={Boolean(reason)}
                    onClick={() => applyCapability(capability)}
                    sx={{ whiteSpace: "normal", alignItems: "flex-start", minHeight: 58, py: 0.75 }}
                  >
                    <Box sx={{ minWidth: 0, width: "100%" }}>
                      <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", minWidth: 0 }}>
                        <Typography variant="body2" noWrap sx={{ flex: 1, fontWeight: 650 }}>{capability.label}</Typography>
                        <Chip size="small" variant="outlined" label={capability.kind} />
                      </Stack>
                      <Typography variant="caption" color="text.secondary" sx={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere", lineHeight: 1.35 }}>
                        {capability.description}
                      </Typography>
                      {reason ? <Typography variant="caption" color="text.disabled" noWrap sx={{ display: "block" }}>{reason}</Typography> : null}
                    </Box>
                  </MenuItem>;
                })}
              </MenuList>
            </Paper>
          </ClickAwayListener>
        </Popper>
        <Box sx={{ flex: 1, minWidth: { xs: 0, sm: 24 } }} />
        {controls ? <Box sx={{ minWidth: 0, maxWidth: "100%", overflowX: "auto" }}>{controls}</Box> : null}
        <Box ref={anchorRef} sx={{ order: -1, flex: "1 0 100%", minWidth: 0 }}>
          <TextField
            fullWidth
            multiline
            variant="standard"
            minRows={1}
            maxRows={5}
            sx={{
              "& .MuiInputBase-root": { alignItems: "flex-end", bgcolor: "transparent", px: 0.25, pb: 0.5 },
              "& textarea": { fontSize: 15, lineHeight: "22px", maxHeight: "110px !important", overflowY: "auto !important" },
            }}
            InputProps={{ disableUnderline: true }}
            value={text}
            inputRef={inputRef}
            disabled={disabled || composerLocked}
            placeholder={composerLocked ? "Agent is working" : (placeholder ?? "Send a message")}
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
              if (disabled || composerLocked) return;
              if (attachmentsEnabled) {
                const pasted = filesFromClipboard(event.clipboardData.items, event.clipboardData.files);
                if (pasted.length > 0) {
                  event.preventDefault();
                  addFiles(pasted);
                  return;
                }
              }
              const pasted = event.clipboardData.getData("text/plain");
              if (!shouldExtractLongPaste(pasted)) return;
              event.preventDefault();
              const combined = composerSubmissionText(pastedText ?? "", pasted);
              if (utf8ByteLength(combined) > LONG_TEXT_MAX_UTF8_BYTES) {
                setSendError("Pasted text exceeds the 8 MiB limit.");
                return;
              }
              setPastedText(combined);
              setSendError(undefined);
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
          <Tooltip title={defaultsToQueue ? "Send after the active response finishes" : "Steer the active response"}>
            <span>
              <Button
                size="small"
                variant="contained"
                disabled={!canSend}
                onClick={send}
                aria-label={defaultsToQueue ? "Queue message" : "Steer active response"}
                sx={{ minHeight: 40, px: 1.5, boxShadow: "none" }}
              >
                {defaultsToQueue ? "Queue" : "Steer"}
              </Button>
            </span>
          </Tooltip>
        ) : null}
        {showQueue ? (
          <Tooltip title={defaultsToQueue ? "Steer the active response" : "Send after the active response finishes"}>
            <span>
              <Button
                size="small"
                variant="outlined"
                disabled={!canSend}
                onClick={defaultsToQueue ? steer : queue}
                aria-label={defaultsToQueue ? "Steer active response" : "Queue message"}
                sx={{ minHeight: 40, px: 1.5 }}
              >
                {defaultsToQueue ? "Steer" : "Queue"}
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
        ) : null}
        {!showQueue && (!canCancel || allowSendWhileRunning) ? (
          <Tooltip title="Send">
            <span>
              <IconButton color="primary" disabled={!canSend} onClick={send} aria-label={mentionedBusyHandles.length > 0 ? "Queue message" : "Send message"} sx={{ minWidth: 44, minHeight: 44 }}>
                <ArrowUpwardIcon />
              </IconButton>
            </span>
          </Tooltip>
        ) : null}
      </Stack>
    </Paper>
  );
}

export function replyPreviewText(text: string, maxLength = 240): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}
