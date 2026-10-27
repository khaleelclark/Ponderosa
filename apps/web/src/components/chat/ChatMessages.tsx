import {productApiPath,productWorkspacePath} from "../../api/productScope.js";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import { parseRichMessageBlock, messageTagTokens, missingCollaborationRecipients, unicodeCodePointLength } from "@ponderosa/core";
import type { AgentMentionBindingDto, CollaborationRecipientDto, CommunicationDocumentReference, CommunicationIntent, MessageDto, VerifiedCitationDto, WorkspaceFileOwnerDto } from "@ponderosa/core";
import { type ReactNode, type ComponentPropsWithoutRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkMessageFormatting } from "./messageMarkdown";
import { RichMessageDisplay } from "./RichMessageDisplay";
import { ScrollableMessageTable } from "./ScrollableMessageTable";
import { copyText } from "../../clipboard";
import { MESSAGE_TAG_PREFIX, messageTagHandle } from "../../mentions";
import { LazySyntaxHighlightedCode } from "../LazySyntaxHighlightedCode";
import { useMutationNotification } from "../MutationNotifications";
import { useProjectBrowser } from "../ProjectBrowserContext";
import { ChatDocumentCard } from "./ChatDocumentCard";
import {
  chatMarkdownUrlTransform,
  parseChatProjectFileHref,
  renderableChatLinkHref,
} from "./chatMarkdownLink";
export { resolveMessageMentionText } from "./messageMentionPresentation";
import { messageProseTagTokens, resolveMessageMentionText } from "./messageMentionPresentation";

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

/** Hide the artifact pointer that is superseded by a structured document card. */
export function stripDocumentPrefixText(text: string, hasDocument: boolean): string {
  return hasDocument
    ? text.replace(
        /^(?:Full response|Full message):\s*ponderosa:\/\/artifact\/\S+\s*$/iu,
        "",
      )
    : text;
}

function stripLeadingRoutingHandle(text: string, handle: string): string {
  const visible = text.trimStart();
  const match = visible.match(
    /^#([\p{L}\p{N}_-]+)(?=$|\s|[.,!?;:])(?:[.,!?;:]?\s*)/u,
  );
  if (
    !match ||
    match[1]!.toLocaleLowerCase() !== handle.toLocaleLowerCase()
  ) {
    return text;
  }
  const remainder = visible.slice(match[0].length);
  return remainder.trim() ? remainder.trimStart() : text;
}

function canonicalRecipientPrefix(
  text: string,
  mentions: readonly AgentMentionBindingDto[] | undefined,
): string {
  const authoredHandles = new Set(messageTagTokens(text)
    .map(token => token.handle.toLocaleLowerCase()));
  const visibleHandles = new Set(messageTagTokens(resolveMessageMentionText(text, mentions))
    .map(token => token.handle.toLocaleLowerCase()));
  return [...new Set((mentions ?? [])
    .filter(mention => !authoredHandles.has(mention.handle.toLocaleLowerCase()) &&
      !visibleHandles.has(mention.currentHandle.toLocaleLowerCase()))
    .map(mention => `#${mention.currentHandle}`))]
    .join(" ");
}

/** Keep recipient handles visible; only the separately badged Broadcast route is redundant. */
export function communicationVisibleText(input: {
  text: string;
  intent?: CommunicationIntent;
  fromAgent: boolean;
  agentMentions?: readonly AgentMentionBindingDto[];
}): string {
  if (input.intent === "collaboration") return input.text;
  const routedText = input.intent === "broadcast"
    ? stripLeadingRoutingHandle(input.text, "broadcast")
    : input.text;
  const resolvedText = resolveMessageMentionText(routedText, input.agentMentions);
  const prefix = !input.fromAgent &&
    (input.intent === "user_dm" ||
      input.agentMentions?.some(mention => mention.handle === "new-agent"))
    ? canonicalRecipientPrefix(input.text, input.agentMentions)
    : "";
  return prefix ? `${prefix} ${resolvedText}` : resolvedText;
}

/** Navigate by stable Agent ID while always displaying the current title. */
export function authoredAgentMentionForHandle(
  handle: string,
  mentions: readonly AgentMentionBindingDto[] | undefined,
): { agentId: string; label: string; authoredLabel: string } | undefined {
  const binding = mentions?.find(
    mention =>
      [mention.handle, mention.currentHandle].some(label => label.toLocaleLowerCase() === handle.toLocaleLowerCase()),
  );
  return binding
    ? {
        agentId: binding.agentId,
        label: binding.currentHandle,
        authoredLabel: binding.handle,
      }
    : undefined;
}

const AGENT_OPENING_EVENT_PREFIX = "agent-opening:";

export function agentOpeningAgentId(
  communicationEventId: string | undefined,
): string | undefined {
  return communicationEventId?.startsWith(AGENT_OPENING_EVENT_PREFIX)
    ? communicationEventId.slice(AGENT_OPENING_EVENT_PREFIX.length) || undefined
    : undefined;
}

/** Fresh-Agent openings are shared context, but not an explicit Broadcast action. */
export function showBroadcastBadge(
  intent: CommunicationIntent | undefined,
  communicationEventId: string | undefined,
): boolean {
  return intent === "broadcast" && !agentOpeningAgentId(communicationEventId);
}

function isLocalWorkspaceHref(href: string): boolean {
  return !/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/iu.test(href) && !href.startsWith("/api/");
}

function projectFileHref(projectId: string | undefined, href: string | undefined, mode: "preview" | "download", fileScope?: WorkspaceFileOwnerDto): string | undefined {
  if (!projectId || !href || !fileScope || !isLocalWorkspaceHref(href)) return undefined;
  const query = new URLSearchParams({ path: href });
  if (fileScope.agentId) query.set("agentId", fileScope.agentId);
  else if (fileScope.conversationId) query.set("conversationId", fileScope.conversationId);
  else return undefined;
  return productApiPath(`/api/projects/${encodeURIComponent(projectId)}/workspace-files/${mode}?${query}`);
}

function projectFileViewerHref(projectId: string | undefined, href: string | undefined, fileScope?: WorkspaceFileOwnerDto): string | undefined {
  if (!projectId || !href || !fileScope || !isLocalWorkspaceHref(href)) return undefined;
  const query = new URLSearchParams({ path: href });
  if (fileScope.agentId) query.set("agentId", fileScope.agentId);
  else if (fileScope.conversationId) query.set("conversationId", fileScope.conversationId);
  else return undefined;
  return productWorkspacePath(`/projects/${encodeURIComponent(projectId)}/files/view?${query}`);
}

/** Working-file ownership survives the Run-specific live-app preview grant. */
export function fileOwnerForMessage(
  message: Pick<MessageDto, "authorAgentId" | "conversationId">,
  fallbackAgentId?: string,
): WorkspaceFileOwnerDto | undefined {
  if (message.authorAgentId) return { agentId: message.authorAgentId };
  if (message.conversationId) return { conversationId: message.conversationId };
  return fallbackAgentId ? { agentId: fallbackAgentId } : undefined;
}

export function linkPreviewScopeForMessage(
  message: Pick<MessageDto, "role" | "authorAgentId" | "executionId">,
  activeScope?: LinkPreviewScope,
): LinkPreviewScope | undefined {
  if (!activeScope || message.role !== "assistant") return undefined;
  if (message.authorAgentId !== activeScope.agentId || message.executionId !== activeScope.runId) return undefined;
  return activeScope;
}

function ChatLink({ href, children, previewScope, projectId, fileScope }: { href: string; children: ReactNode; previewScope?: LinkPreviewScope; projectId?: string; fileScope?: WorkspaceFileOwnerDto }): JSX.Element {
  const projectBrowser = useProjectBrowser();
  const projectFilePreview = projectFileViewerHref(projectId, href, fileScope);
  const link = linkPresentation(href);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string>();

  if (projectFilePreview) return <a className="chat-text-navigation" href={projectFilePreview} target="_blank" rel="noreferrer">{children}</a>;
  if (isLocalWorkspaceHref(href)) return <Box component="span">{children}</Box>;
  if (!link) return <a className="chat-text-navigation" href={href}>{children}</a>;
  const activate = (event: React.MouseEvent) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (!link.loopback && projectBrowser.projectId) {
      event.preventDefault(); projectBrowser.open(link.url.href); return;
    }
    if (!link.loopback) return;
    event.preventDefault();
    setChooserOpen(true);
    setError(undefined);
  };
  const openInside = async () => {
    setOpening(true); setError(undefined);
    try {
      if (!previewScope) throw new Error("This localhost app is not associated with an active run.");
      const response = await fetch(productApiPath("/api/link-previews"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: link.url.href, ...previewScope }) });
      if (!response.ok) throw new Error("Ponderosa could not open this localhost app.");
      const preview = await response.json() as { openUrl: string };
      window.open(preview.openUrl, "_blank", "noopener,noreferrer");
      setChooserOpen(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Preview unavailable."); }
    finally { setOpening(false); }
  };
  return <>
    <Box className="chat-text-navigation" component="a" href={href} target={link.loopback ? undefined : "_blank"} rel={link.loopback ? undefined : "noreferrer"} onClick={activate} onContextMenu={event => { event.preventDefault(); setChooserOpen(true); setError(undefined); }} aria-label={`Open link to ${link.destination}`} sx={{ display: "inline-flex", alignItems: "center", gap: .45, maxWidth: "100%", px: .5, borderRadius: .75, bgcolor: "action.hover", textDecoration: "none !important", verticalAlign: "middle" }}>
      <Box component="span" title={link.url.href} sx={{ minWidth: 0, maxWidth: "18rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{children}</Box>
      <OpenInNewIcon aria-hidden sx={{ fontSize: 14, flex: "0 0 auto" }} />
    </Box>
    <Dialog open={chooserOpen} onClose={() => setChooserOpen(false)} aria-labelledby="link-open-title" maxWidth="xs" fullWidth>
      <DialogTitle id="link-open-title">Open link</DialogTitle>
      <DialogContent><Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{link.url.href}</Typography>{error ? <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert> : null}</DialogContent>
      <DialogActions>
        <Button onClick={() => setChooserOpen(false)}>Cancel</Button>
        {projectBrowser.projectId ? <Button onClick={() => { projectBrowser.open(link.url.href); setChooserOpen(false); }}>Open in Ponderosa</Button> : null}
        {link.loopback && previewScope ? <Button disabled={opening} onClick={() => void openInside()}>Open Live App Preview</Button> : null}
        <Button component="a" href={link.url.href} target="_blank" rel="noopener noreferrer" onClick={() => setChooserOpen(false)} endIcon={<OpenInNewIcon />}>Open Externally</Button>
      </DialogActions>
    </Dialog>
  </>;
}

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

function isLongChatMessage(text: string): boolean {
  // Display-only progressive disclosure. Provider input and artifact limits
  // remain governed by the canonical constants imported above.
  return unicodeCodePointLength(text) > 6_400 || text.split("\n").length > 72;
}

const COLLAPSED_MESSAGE_PREVIEW_CODE_POINTS = 3_200;
const COLLAPSED_MESSAGE_PREVIEW_LINES = 36;

/** Bound the Markdown source before parsing so a collapsed long response does
 * not retain the complete rich-render tree in the DOM. */
export function collapsedLongMessagePreview(text: string): string {
  const lineBounded = text.split("\n").slice(0, COLLAPSED_MESSAGE_PREVIEW_LINES).join("\n");
  const codePoints = [...lineBounded];
  const preview = codePoints.length > COLLAPSED_MESSAGE_PREVIEW_CODE_POINTS
    ? codePoints.slice(0, COLLAPSED_MESSAGE_PREVIEW_CODE_POINTS).join("")
    : lineBounded;
  return preview.length < text.length ? `${preview.trimEnd()}\n\n…` : preview;
}

export function individualChatSenderLabel(
  role: MessageDto["role"],
  agentName: string,
): string {
  return role === "user" ? "You" : agentName.trim() || "Agent";
}

function codeBlockText(children: ReactNode): string {
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
  const notify = useMutationNotification();
  const code = codeBlockText(children).replace(/\n$/, "");
  const language = fencedCodeLanguage(children);
  const highlighted = !["text", "txt", "plaintext", "none", "ponderosa"].includes(language);

  async function copyCode(): Promise<void> {
    try {
      await copyText(code);
      notify({ key: "copy-code", message: "Copied" });
    } catch {
      notify({ key: "copy-code", message: "Code could not be copied. Check your browser clipboard permissions and try again.", severity: "error" });
    }
  }

  const plainCode = ({ status, retry }: {
    status: "pending" | "failed";
    retry(): void;
  }): ReactNode => <>
    {status === "failed" ? <Stack
      direction="row"
      alignItems="center"
      justifyContent="space-between"
      spacing={1}
      sx={{ px: 2, py: 0.75, borderBottom: 1, borderColor: "divider", color: "text.secondary" }}
    >
      <Typography variant="caption">Syntax highlighting unavailable. Plain code is still readable.</Typography>
      <Button size="small" color="inherit" onClick={retry}>Retry highlighting</Button>
    </Stack> : null}
    <Box
      component="pre"
      sx={{ m: 0, p: "16px 18px", minWidth: "max-content", whiteSpace: "pre", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: "0.875rem", lineHeight: 1.55, color: "text.primary", bgcolor: "transparent" }}
    >{code}</Box>
  </>;

  return (
    <Box sx={{ my: 1, maxWidth: "100%", minWidth: 0, overflow: "hidden", borderRadius: 2, bgcolor: "action.hover", border: 1, borderColor: "divider" }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ minHeight: 38, px: 1.5, color: "text.secondary", borderBottom: 1, borderColor: "divider" }}>
        <Typography variant="caption" sx={{ fontFamily: "monospace", textTransform: "lowercase" }}>{language}</Typography>
        <Tooltip title="Copy code">
          <IconButton aria-label="Copy code" size="small" onClick={() => void copyCode()}>
            <ContentCopyIcon fontSize="inherit" />
          </IconButton>
        </Tooltip>
      </Stack>
      <Box sx={{ maxWidth: "100%", overflowX: "auto", overscrollBehaviorX: "contain" }}>
        {highlighted ? <LazySyntaxHighlightedCode
            language={language}
            customStyle={{ margin: 0, padding: "16px 18px", minWidth: "max-content", background: "transparent", fontSize: "0.875rem", lineHeight: 1.55 }}
            codeTagProps={{ style: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" } }}
            renderFallback={plainCode}
          >{code}</LazySyntaxHighlightedCode> : <Box
          component="pre"
          sx={{ m: 0, p: "16px 18px", minWidth: "max-content", whiteSpace: "pre", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: "0.875rem", lineHeight: 1.55, color: "text.primary", bgcolor: "transparent" }}
        >{code}</Box>}
      </Box>
    </Box>
  );
}

function MessageCodeBlock({ node, children }: { node?: unknown; children?: ReactNode }): JSX.Element {
  const code = (node as { children?: { properties?: Record<string, unknown> }[] })?.children?.[0];
  const block = code?.properties?.["data-ponderosa-closed"] === "true"
    ? parseRichMessageBlock(codeBlockText(children).replace(/\n$/, "")) : undefined;
  return block ? <RichMessageDisplay block={block} /> : <CopyableCodeBlock>{children}</CopyableCodeBlock>;
}

function MessageTableHeader({ node: _node, ...props }: ComponentPropsWithoutRef<"th"> & { node?: unknown }): JSX.Element {
  return <th {...props} scope="col" />;
}

interface MarkdownAstNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownAstNode[];
  data?: { hProperties: Record<string, string> };
}

export const messageMentionSx = {
  display: "inline",
  px: 0.45,
  py: 0.1,
  borderRadius: 0.75,
  bgcolor: "action.selected",
  color: "primary.main",
  fontWeight: 700,
  textDecoration: "none",
  boxShadow: "inset 0 0 0 1px rgba(127, 196, 142, .18)",
} as const;

const messageHandleSx = {
  font: "inherit",
  ...messageMentionSx,
  display: "inline-flex",
  alignItems: "center",
  minHeight: 24,
  border: 0,
} as const;

/** An identity-bound mention; display text never selects its navigation target. */
export function AgentMention({ agentId, label, title, onOpenAgent }: {
  agentId: string; label: string; title?: string; onOpenAgent?(agentId: string): void;
}): JSX.Element {
  if (!onOpenAgent) return <Box component="span" title={title} sx={messageHandleSx}>#{label}</Box>;
  return <Box className="chat-text-navigation" component="button" type="button" title={title}
    aria-label={`Open agent ${label}${title ? `. ${title}` : ""}`} onClick={() => onOpenAgent(agentId)}
    sx={{ ...messageHandleSx, cursor: "pointer", maxWidth: "100%", overflowWrap: "anywhere" }}>#{label}</Box>;
}

/** Add canonical recipients not already represented by authored prose tags. */
function remarkMessageTags(options: { tokens: ReturnType<typeof messageProseTagTokens>; recipients?: readonly CollaborationRecipientDto[]; mentions?: readonly AgentMentionBindingDto[] }) {
  return (tree: MarkdownAstNode): void => {
    const representedIds = new Set<string>();
    for (const { handle } of options.tokens) {
      const bindings = options.mentions?.filter(mention => mention.handle === handle) ?? [];
      if (bindings.length === 1) representedIds.add(bindings[0]!.agentId);
    }
    if (!options.recipients) return;
    const missing = missingCollaborationRecipients(options.recipients, representedIds);
    const prefix: MarkdownAstNode[] = missing.flatMap(recipient => [{ type: "link",
      url: `${MESSAGE_TAG_PREFIX}${encodeURIComponent(recipient.handle ?? "unavailable-recipient")}`,
      data: { hProperties: { "data-ponderosa-recipient": recipient.id } },
      children: [{ type: "text", value: recipient.handle ? `#${recipient.handle}` : "Unavailable recipient" }] },
      { type: "text", value: " " }]);
    if (!prefix.length) return;
    const first = tree.children?.[0];
    if (first?.type === "paragraph") first.children = [...prefix, ...(first.children ?? [])];
    else tree.children = [{ type: "paragraph", children: prefix }, ...(tree.children ?? [])];
  };
}

function ChatMarkdown({
  children,
  collaborationRecipients,
  agentMentions,
  agentIdForHandle,
  agentMentionForHandle,
  onOpenAgent,
  onOpenBroadcast,
  previewScope,
  fileScope,
  projectId,
  operatorHandle,
  compact = false,
  small = false,
}: {
  children: string;
  collaborationRecipients?: readonly CollaborationRecipientDto[];
  agentMentions?: readonly AgentMentionBindingDto[];
  agentIdForHandle?(handle: string): string | undefined;
  agentMentionForHandle?(handle: string): { agentId: string; label: string; authoredLabel?: string; available?: boolean; title?: string } | undefined;
  onOpenAgent?(agentId: string): void;
  onOpenBroadcast?(): void;
  previewScope?: LinkPreviewScope;
  fileScope?: WorkspaceFileOwnerDto;
  projectId?: string;
  operatorHandle?: string;
  compact?: boolean;
  small?: boolean;
}): JSX.Element {
  const tokens = messageProseTagTokens(children);
  // Insert links at authored source offsets before Markdown decodes entities
  // and escapes. Copy/source text stays untouched; literal regions are excluded.
  let taggedText = children;
  for (const { handle, start, end } of [...tokens].reverse()) {
    taggedText = taggedText.slice(0, start) + `[#${handle}](${MESSAGE_TAG_PREFIX}${encodeURIComponent(handle)})` + taggedText.slice(end);
  }
  return (
    <Box
      sx={{
        width: "100%",
        maxWidth: "100%",
        minWidth: 0,
        overflowWrap: "anywhere",
        // The prose transform preserves authored breaks without exposing parser separators.
        whiteSpace: "normal",
        "& > :first-of-type": { mt: 0 },
        "& > :last-child": { mb: 0 },
        fontSize: small
          ? { xs: "0.9375rem", md: "0.82rem" }
          : { xs: "0.875rem", sm: "1rem", md: "0.9375rem" },
        lineHeight: small ? 1.42 : { xs: "20px", sm: 1.48 },
        "& p": { my: compact ? 0.15 : 0.35, maxWidth: "100%", whiteSpace: "normal", overflowWrap: "anywhere", wordBreak: "break-word" },
        "& h1, & h2, & h3, & h4": { mt: 1.05, mb: 0.4, lineHeight: 1.22 },
        "& h1": { fontSize: { xs: "1.22rem", sm: "1.35rem" } },
        "& h2": { fontSize: { xs: "1.1rem", sm: "1.2rem" } },
        "& h3, & h4": { fontSize: { xs: "1rem", sm: "1.05rem" } },
        "& ul, & ol": { my: compact ? 0.25 : 0.45, pl: 2.75, whiteSpace: "normal" },
        "& li": { maxWidth: "100%", whiteSpace: "normal", overflowWrap: "anywhere", wordBreak: "break-word" },
        "& li + li": { mt: compact ? 0.05 : 0.15 },
        "& blockquote": { my: 0.65, mx: 0, pl: 1.5, whiteSpace: "normal", borderLeft: 3, borderColor: "divider" },
        "& code": { fontFamily: "monospace", fontSize: "0.875em" },
        "& :not(pre) > code": { px: 0.5, py: 0.125, borderRadius: 0.75, bgcolor: "action.hover" },
        "& pre": { my: 0.65, p: 1.1, maxWidth: "100%", overflowX: "auto", borderRadius: 1, bgcolor: "action.hover" },
        "& img": { display: "block", maxWidth: "100%", height: "auto", objectFit: "contain" },
        "& table": { width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" },
        "& th, & td": { px: 1.25, py: 0.875, borderBottom: 1, borderColor: "divider", minWidth: "7rem", maxWidth: "24rem", verticalAlign: "top", overflowWrap: "break-word", wordBreak: "normal" },
        "& th": { textAlign: "left", fontWeight: 700, bgcolor: "action.hover" },
        "& th:first-child, & td:first-child": { minWidth: "3rem" },
        "& td a, & th a": { maxWidth: "16rem" },
        "& a": { maxWidth: "100%", color: "primary.main", textDecoration: "underline", textUnderlineOffset: "0.15em", overflowWrap: "anywhere", wordBreak: "break-word", "&:hover": { textDecorationThickness: "2px" }, "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 2 } },
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMessageFormatting, [remarkMessageTags, { tokens, recipients: collaborationRecipients, mentions: agentMentions }]]}
        urlTransform={chatMarkdownUrlTransform}
        components={{
          table: ScrollableMessageTable,
          th: MessageTableHeader,
          pre: MessageCodeBlock,
          img: ({ src, alt }) => {
            const projectPreview = projectFileHref(projectId, src, "preview", fileScope);
            if (src && isLocalWorkspaceHref(src) && !projectPreview) return <Box component="span">{alt ?? "Image unavailable"}</Box>;
            const image = <Box component="img" src={projectPreview ?? src} alt={alt ?? "Agent-provided image"} loading="lazy" sx={{ display: "block", width: "auto", maxWidth: "100%", maxHeight: { xs: 320, md: 520 }, objectFit: "contain", borderRadius: 1.5 }} />;
            return projectPreview
              ? <Box component="a" href={projectPreview} target="_blank" rel="noreferrer" aria-label={`Open ${alt ?? "agent-provided image"} full size`} sx={{ display: "inline-block", maxWidth: "100%" }}>{image}</Box>
              : image;
          },
          a: ({ href, children: label, node }) => {
            // Only our AST projection sets this property; authored Markdown
            // never chooses an added recipient's stable navigation identity.
            const recipientId = node?.properties["data-ponderosa-recipient"];
            const recipient = collaborationRecipients?.find(candidate => candidate.id === recipientId);
            if (recipient) return recipient.handle ? <AgentMention agentId={recipient.id} label={recipient.handle}
              title={!recipient.available ? "Agent no longer available" : recipient.currentTitle && recipient.currentTitle !== recipient.title ? `Currently ${recipient.currentTitle}` : undefined}
              onOpenAgent={recipient.available ? onOpenAgent : undefined} /> : <Box component="span" sx={messageHandleSx}>Unavailable recipient</Box>;
            const fileReference = parseChatProjectFileHref(href);
            if (fileReference) {
              const filename = fileReference.currentFilename || fileReference.historicalFilename;
              if (!projectId || fileReference.projectId !== projectId) {
                return <Box component="span">@{filename}</Box>;
              }
              const target = `/projects/${encodeURIComponent(projectId)}?view=files&artifact=${encodeURIComponent(fileReference.artifactId)}`;
              return (
                <Box
                  className="chat-text-navigation"
                  component="a"
                  href={target}
                  aria-label={`Open Project File ${filename}`}
                  onClick={event => {
                    if (
                      event.defaultPrevented ||
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    ) return;
                    event.preventDefault();
                    window.history.pushState(null, "", target);
                    window.dispatchEvent(new PopStateEvent("popstate"));
                  }}
                  sx={{
                    ...messageMentionSx,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 0.35,
                    maxWidth: "100%",
                    verticalAlign: "middle",
                  }}
                >
                  <InsertDriveFileOutlinedIcon aria-hidden sx={{ fontSize: "1em", flex: "0 0 auto" }} />
                  <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                    @{filename}
                  </Box>
                </Box>
              );
            }
            if (!href?.startsWith(MESSAGE_TAG_PREFIX)) {
              const safeHref = renderableChatLinkHref(href);
              return safeHref
                ? <ChatLink href={safeHref} previewScope={previewScope} fileScope={fileScope} projectId={projectId}>{label}</ChatLink>
                : <Box component="span">{label}</Box>;
            }
            const handle = messageTagHandle(href);
            if (!handle) return <Box component="span">{label}</Box>;
            if (handle.toLocaleLowerCase() === "broadcast" && onOpenBroadcast) {
              return <Box className="chat-text-navigation" component="button" type="button" aria-label="Open originating broadcast in Chat" onClick={onOpenBroadcast} sx={{ display: "inline", p: 0, border: 0, bgcolor: "transparent", color: "inherit", font: "inherit", fontWeight: 600, textDecoration: "none", cursor: "pointer" }}>{label}</Box>;
            }
            const boundMention = agentMentionForHandle?.(handle);
            const agentId = boundMention?.agentId ?? agentIdForHandle?.(handle);
            // #pto is the stable internal operator route handle. It predates
            // configurable profile handles, so render it as the same inert
            // route chip rather than leaking it as unstyled prose.
            const operatorMention = handle.toLocaleLowerCase() === "user"
              || handle.toLocaleLowerCase() === "pto"
              || Boolean(operatorHandle && handle.toLocaleLowerCase() === operatorHandle.toLocaleLowerCase());
            const visibleLabel = operatorMention && handle.toLocaleLowerCase() !== "pto" && operatorHandle
              ? `#${operatorHandle}`
              : boundMention ? `#${boundMention.label}` : label;
            const mentionTitle = boundMention?.title ?? (boundMention?.authoredLabel &&
              boundMention.authoredLabel.toLocaleLowerCase() !== boundMention.label.toLocaleLowerCase()
                ? `Originally authored as #${boundMention.authoredLabel}`
                : undefined);
            if (operatorMention) return <Box component="span" sx={messageHandleSx}>{visibleLabel}</Box>;
            if (!agentId) {
              if (["broadcast", "everyone", "new-agent"].includes(handle.toLocaleLowerCase())) {
                return <Box component="span" sx={messageMentionSx}>{label}</Box>;
              }
              return <>{label}</>;
            }
            return <AgentMention agentId={agentId} label={boundMention?.label ?? handle} title={mentionTitle} onOpenAgent={boundMention?.available === false ? undefined : onOpenAgent} />;
          },
        }}
      >
        {taggedText}
      </ReactMarkdown>
    </Box>
  );
}

export function CommunicationDocumentCard({ document, projectId, fileScope }: { document: CommunicationDocumentReference; projectId?: string; fileScope?: WorkspaceFileOwnerDto }): JSX.Element {
  return <ChatDocumentCard document={document} renderMarkdown={(content) => <ChatMarkdown projectId={projectId} fileScope={fileScope}>{content}</ChatMarkdown>} />;
}

export function ChatMessageBody({ text, citations, collaborationRecipients, agentMentions, collapseLongMessage = true, agentIdForHandle, agentMentionForHandle, onOpenAgent, onOpenBroadcast, previewScope, fileScope, projectId, operatorHandle, compactMarkdown = false, smallText = false }: {
  text: string;
  collaborationRecipients?: readonly CollaborationRecipientDto[];
  agentMentions?: readonly AgentMentionBindingDto[];
  citations?: VerifiedCitationDto[];
  collapseLongMessage?: boolean;
  agentIdForHandle?(handle: string): string | undefined;
  agentMentionForHandle?(handle: string): { agentId: string; label: string; authoredLabel?: string } | undefined;
  onOpenAgent?(agentId: string): void;
  onOpenBroadcast?(): void;
  previewScope?: LinkPreviewScope;
  fileScope?: WorkspaceFileOwnerDto;
  projectId?: string;
  operatorHandle?: string;
  compactMarkdown?: boolean;
  smallText?: boolean;
}): JSX.Element {
  const collaborationMention = (handle: string) => {
    const matches = agentMentions?.filter(mention => mention.handle === handle) ?? [];
    if (matches.length !== 1) return undefined;
    const binding = matches[0]!;
    return { agentId: binding.agentId, label: handle, available: binding.available,
      title: binding.available === false ? "Agent no longer available" : binding.currentHandle !== handle ? `Currently ${binding.currentTitle}` : undefined };
  };
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
        <ChatMarkdown collaborationRecipients={collaborationRecipients} agentMentions={agentMentions} agentIdForHandle={collaborationRecipients ? undefined : agentIdForHandle} agentMentionForHandle={collaborationRecipients ? collaborationMention : agentMentionForHandle} onOpenAgent={onOpenAgent} onOpenBroadcast={onOpenBroadcast} previewScope={previewScope} fileScope={fileScope} projectId={projectId} operatorHandle={operatorHandle} compact={compactMarkdown} small={smallText}>
          {collapsible && !expanded ? collapsedLongMessagePreview(text) : text}
        </ChatMarkdown>
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
          {expanded ? "Show Less" : "Show Full Message"}
        </Button>
      ) : null}
      {citations?.length ? <Box component="aside" aria-label="Sources" sx={{ mt: 1, pt: 1, borderTop: 1, borderColor: "divider" }}><Typography variant="caption" sx={{ display: "block", fontWeight: 700, mb: .5 }}>Sources</Typography>{citations.map((citation) => <Typography key={citation.url} variant="caption" component="div"><ChatLink href={citation.url} projectId={projectId} fileScope={fileScope} previewScope={previewScope}>{citation.title}</ChatLink></Typography>)}</Box> : null}
    </Box>
  );
}
