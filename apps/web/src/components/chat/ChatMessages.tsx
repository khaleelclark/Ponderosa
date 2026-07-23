import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import CheckIcon from "@mui/icons-material/Check";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import LanguageIcon from "@mui/icons-material/Language";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Stack, Tooltip, Typography, useTheme } from "@mui/material";
import { unicodeCodePointLength } from "@ponderosa/core";
import type { CommunicationDocumentReference, MessageDto, OperatorProfileDto, VerifiedCitationDto } from "@ponderosa/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight, vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import { copyText } from "../../clipboard";
import { acquireFavicon, faviconIdentity, markFaviconFailed } from "../../faviconCache";
import { useProjectBrowser } from "../ProjectBrowserContext";
import { ChatDocumentCard } from "./ChatDocumentCard";
import { ChatOperatorLabel } from "./ChatOperatorLabel";

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

export function projectFileViewerHref(projectId: string | undefined, href: string | undefined): string | undefined {
  if (!projectId || !href) return undefined;
  if (/^(?:https?:|data:|blob:|ponderosa:|mailto:|#)/iu.test(href) || href.startsWith("/api/")) return undefined;
  return `/projects/${encodeURIComponent(projectId)}/files/view?path=${encodeURIComponent(href)}`;
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
  const projectFilePreview = projectFileViewerHref(projectId ?? previewScope?.projectId, href);
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
    const resource = acquireFavicon(favicon);
    void resource.src.then(
      (src) => { if (current) setFaviconSrc(src); },
      () => { if (current) setFaviconFailed(true); },
    );
    return () => { current = false; resource.release(); };
  }, [favicon]);
  if (projectFilePreview) return <a className="chat-text-navigation" href={projectFilePreview} target="_blank" rel="noreferrer">{children}</a>;
  if (!link) return <a className="chat-text-navigation" href={href}>{children}</a>;
  const activate = (event: React.MouseEvent) => {
    if (!link.loopback) return;
    event.preventDefault();
    setChooserOpen(true);
    setError(undefined);
  };
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
    <Box className="chat-text-navigation" component="a" href={href} target={link.loopback ? undefined : "_blank"} rel={link.loopback ? undefined : "noreferrer"} onClick={activate} aria-label={`Open link to ${link.destination}`} sx={{ display: "inline-flex", alignItems: "center", gap: .45, maxWidth: "100%", px: .5, borderRadius: .75, bgcolor: "action.hover", textDecoration: "none !important", verticalAlign: "middle" }}>
      {!faviconFailed && faviconSrc
        ? <Box component="img" src={faviconSrc} alt="" onError={() => { if (favicon) markFaviconFailed(favicon, faviconSrc); setFaviconFailed(true); }} sx={{ width: 14, height: 14, flex: "0 0 auto" }} />
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

export function replyFallbackText(text: string): string {
  return text.trim() || "Original message unavailable";
}

export function isLongChatMessage(text: string): boolean {
  // Display-only progressive disclosure. Provider input and artifact limits
  // remain governed by the canonical constants imported above.
  return unicodeCodePointLength(text) > 6_400 || text.split("\n").length > 72;
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

export function CopyableCodeBlock({ children }: { children?: ReactNode }): JSX.Element {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout>>();
  const theme = useTheme();
  const code = codeBlockText(children).replace(/\n$/, "");
  const language = fencedCodeLanguage(children);
  const highlighted = !["text", "txt", "plaintext", "none"].includes(language);

  useEffect(
    () => () => {
      if (resetTimer.current !== undefined) {
        globalThis.clearTimeout(resetTimer.current);
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
      globalThis.clearTimeout(resetTimer.current);
    }
    resetTimer.current = globalThis.setTimeout(() => setCopyState("idle"), 2000);
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
  operatorHandle,
  compact = false,
}: {
  children: string;
  agentIdForHandle?(handle: string): string | undefined;
  agentMentionForHandle?(handle: string): { agentId: string; label: string } | undefined;
  onOpenAgent?(agentId: string): void;
  onOpenBroadcast?(): void;
  previewScope?: LinkPreviewScope;
  projectId?: string;
  operatorHandle?: string;
  compact?: boolean;
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
        fontSize: { xs: "0.875rem", sm: "0.9375rem" },
        lineHeight: { xs: 1.44, sm: 1.48 },
        "& p": { my: compact ? 0.15 : 0.35, maxWidth: "100%", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" },
        "& h1, & h2, & h3, & h4": { mt: 1.05, mb: 0.4, lineHeight: 1.22 },
        "& h1": { fontSize: { xs: "1.22rem", sm: "1.35rem" } },
        "& h2": { fontSize: { xs: "1.1rem", sm: "1.2rem" } },
        "& h3, & h4": { fontSize: { xs: "1rem", sm: "1.05rem" } },
        "& ul, & ol": { my: compact ? 0.25 : 0.45, pl: 2.75 },
        "& li": { maxWidth: "100%", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" },
        "& li + li": { mt: compact ? 0.05 : 0.15 },
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
            const operatorMention = handle.toLocaleLowerCase() === "user"
              || Boolean(operatorHandle && handle.toLocaleLowerCase() === operatorHandle.toLocaleLowerCase());
            const visibleLabel = operatorMention && operatorHandle ? `#${operatorHandle}` : boundMention ? `#${boundMention.label}` : label;
            const mentionSx = { display: "inline", px: 0.45, py: 0.1, borderRadius: 0.75, bgcolor: "action.selected", color: "primary.light", fontWeight: 700, textDecoration: "none", boxShadow: "inset 0 0 0 1px rgba(127, 196, 142, .18)" } as const;
            if (operatorMention) return <Box component="span" data-message-tag={handle.toLocaleLowerCase()} sx={mentionSx}>{visibleLabel}</Box>;
            if (!agentId) {
              if (["broadcast", "everyone"].includes(handle.toLocaleLowerCase())) {
                return <Box component="span" data-message-tag={handle.toLocaleLowerCase()} sx={mentionSx}>{label}</Box>;
              }
              return <>{label}</>;
            }
            if (!onOpenAgent) return <Box component="span" data-message-tag={handle.toLocaleLowerCase()} sx={mentionSx}>{visibleLabel}</Box>;
            return <Box className="chat-text-navigation" component="button" type="button" aria-label={`Open agent ${boundMention?.label ?? handle}`} onClick={() => onOpenAgent(agentId)} sx={{ ...mentionSx, border: 0, font: "inherit", cursor: "pointer" }}>{visibleLabel}</Box>;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </Box>
  );
}

export function MessageMarkdown({ text, agentIdForHandle, agentMentionForHandle, onOpenAgent, onOpenBroadcast, previewScope, projectId, operatorHandle, compact }: {
  text: string;
  agentIdForHandle?(handle: string): string | undefined;
  agentMentionForHandle?(handle: string): { agentId: string; label: string } | undefined;
  onOpenAgent?(agentId: string): void;
  onOpenBroadcast?(): void;
  previewScope?: LinkPreviewScope;
  projectId?: string;
  operatorHandle?: string;
  compact?: boolean;
}): JSX.Element {
  return <ChatMarkdown agentIdForHandle={agentIdForHandle} agentMentionForHandle={agentMentionForHandle} onOpenAgent={onOpenAgent} onOpenBroadcast={onOpenBroadcast} previewScope={previewScope} projectId={projectId} operatorHandle={operatorHandle} compact={compact}>{text}</ChatMarkdown>;
}

export function CommunicationDocumentCard({ document }: { document: CommunicationDocumentReference }): JSX.Element {
  return <ChatDocumentCard document={document} renderMarkdown={(content) => <ChatMarkdown>{content}</ChatMarkdown>} />;
}

export function ChatMessageBody({ text, citations, collapseLongMessage = true, agentIdForHandle, agentMentionForHandle, onOpenAgent, onOpenBroadcast, previewScope, projectId, operatorHandle, compactMarkdown = false }: {
  text: string;
  citations?: VerifiedCitationDto[];
  collapseLongMessage?: boolean;
  agentIdForHandle?(handle: string): string | undefined;
  agentMentionForHandle?(handle: string): { agentId: string; label: string } | undefined;
  onOpenAgent?(agentId: string): void;
  onOpenBroadcast?(): void;
  previewScope?: LinkPreviewScope;
  projectId?: string;
  operatorHandle?: string;
  compactMarkdown?: boolean;
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
        <MessageMarkdown text={text} agentIdForHandle={agentIdForHandle} agentMentionForHandle={agentMentionForHandle} onOpenAgent={onOpenAgent} onOpenBroadcast={onOpenBroadcast} previewScope={previewScope} projectId={projectId} operatorHandle={operatorHandle} compact={compactMarkdown} />
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
      {citations?.length ? <Box component="aside" aria-label="Sources" sx={{ mt: 1, pt: 1, borderTop: 1, borderColor: "divider" }}><Typography variant="caption" sx={{ display: "block", fontWeight: 700, mb: .5 }}>Sources</Typography>{citations.map((citation) => <Typography key={citation.url} variant="caption" component="div"><a href={citation.url} target="_blank" rel="noreferrer">{citation.title}</a></Typography>)}</Box> : null}
    </Box>
  );
}

export function UserMessageLabel({ profile, createdAt }: { profile?: OperatorProfileDto; createdAt?: string }): JSX.Element {
  return <ChatOperatorLabel profile={profile} createdAt={createdAt} />;
}
