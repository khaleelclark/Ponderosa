import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import {
  Alert, Box, Button, CircularProgress, Paper, Stack, Typography,
} from "@mui/material";
import type { ArtifactKind } from "@ponderosa/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { previewCapability } from "./mimeCapabilities";
import { renderableWorkspaceMarkdownHref, workspaceMarkdownMediaHref } from "./workspaceMarkdownLinks";
import { lazy, Suspense, useState } from "react";
import { FeatureErrorBoundary } from "../FeatureErrorBoundary";
const PdfPreview = lazy(() => import("./PdfPreview"));
const DocxPreview = lazy(() => import("./DocxPreview"));

function diffLineKind(line: string): "addition" | "deletion" | "neutral" {
  if (line.startsWith("+") && !line.startsWith("+++")) return "addition";
  if (line.startsWith("-") && !line.startsWith("---")) return "deletion";
  return "neutral";
}

export function UnifiedDiffViewer({ diff }: { diff: string }): JSX.Element {
  return <Box component="pre" aria-label="Unified diff" sx={{ m: 0, py: .75, overflowX: "auto", bgcolor: "background.paper", fontFamily: "monospace", fontSize: 12.5, lineHeight: 1.55 }}>
    {diff.split("\n").map((line, index) => {
      const kind = diffLineKind(line);
      return <Box
        component="span"
        key={`${index}:${line.slice(0, 24)}`}
        sx={{
          display: "block",
          minWidth: "max-content",
          px: 1,
          color: theme => kind === "addition" ? theme.palette.mode === "dark" ? "#9be9a8" : "#166534" : kind === "deletion" ? theme.palette.mode === "dark" ? "#ffb4ab" : "#991b1b" : theme.palette.text.primary,
          bgcolor: kind === "addition" ? "rgba(46, 160, 67, 0.16)" : kind === "deletion" ? "rgba(248, 81, 73, 0.16)" : "transparent",
        }}
      >{line || " "}</Box>;
    })}
  </Box>;
}

function MarkdownImage({ src, alt }: { src?: string; alt?: string }): JSX.Element {
  const [failed, setFailed] = useState(false);
  return src && !failed ? <Box component="img" src={src} alt={alt ?? "Document image"} onError={() => setFailed(true)} sx={{ maxWidth: "100%", height: "auto" }} /> : <Typography component="span" color="text.secondary">Image unavailable{alt ? `: ${alt}` : ""}</Typography>;
}

function MarkdownPreview({ content, projectId, path, agentId, conversationId }: { content: string; projectId?: string; path?: string; agentId?: string; conversationId?: string }): JSX.Element {
  return <Box sx={{ overflowWrap: "anywhere", "& pre": { overflowX: "auto" }, "& code": { fontSize: ".86rem" }, "& p": { lineHeight: 1.65 } }}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
      a: ({ href, children, ...rest }) => {
        const safeHref = renderableWorkspaceMarkdownHref(projectId, path, href, { agentId, conversationId, returnTo: window.location.pathname + window.location.search });
        return safeHref ? <a {...rest} href={safeHref}>{children}</a> : <span>{children}</span>;
      },
      img: ({ src, alt }) => <MarkdownImage key={src} src={workspaceMarkdownMediaHref(projectId, path, src, { agentId, conversationId })} alt={alt} />,
    }}>{content}</ReactMarkdown>
  </Box>;
}

export interface FilePreviewProps {
  title: string;
  projectId?: string;
  agentId?: string;
  conversationId?: string;
  path?: string;
  mediaType?: string;
  artifactKind?: ArtifactKind;
  contentType?: "markdown" | "diff" | "text";
  content?: string;
  previewUrl?: string;
  downloadUrl?: string;
  loading?: boolean;
  error?: boolean | string | Error;
  truncated?: boolean;
  totalBytes?: number;
  hideHeader?: boolean;
  maxHeight?: string | Record<string, string>;
  emptyMessage?: string;
}

/** MIME-aware read-only preview shared by workspace, Agent, Project, and chat files. */
export function FilePreview(props: FilePreviewProps): JSX.Element {
  const capability = previewCapability(props);
  const errorMessage = props.error instanceof Error ? props.error.message : typeof props.error === "string" ? props.error : undefined;
  const actions = <>
    {props.previewUrl ? <Button component="a" href={props.previewUrl} target="_blank" rel="noreferrer" size="small" startIcon={<OpenInNewOutlinedIcon />}>Open</Button> : null}
    {props.downloadUrl ? <Button component="a" href={props.downloadUrl} download size="small" startIcon={<DownloadOutlinedIcon />}>Download</Button> : null}
  </>;

  let body: JSX.Element;
  if (props.loading) {
    body = <Stack direction="row" spacing={1} role="status" aria-live="polite" sx={{ alignItems: "center", justifyContent: "center", minHeight: 120 }}><CircularProgress size={22} /><Typography variant="body2">Loading preview…</Typography></Stack>;
  } else if (props.error) {
    body = <Alert severity="error">{errorMessage
      ? `Preview is unavailable: ${errorMessage}`
      : props.downloadUrl
        ? "Preview is unavailable. Download the file to inspect it."
        : "Preview is unavailable."}</Alert>;
  } else if (capability.kind === "image" && props.previewUrl) {
    body = <Box component="img" src={props.previewUrl} alt={props.title} sx={{ display: "block", maxWidth: "100%", maxHeight: props.maxHeight ?? { xs: "55vh", md: "66vh" }, objectFit: "contain", mx: "auto" }} />;
  } else if (capability.kind === "pdf" && props.previewUrl) {
    body = <Suspense fallback={<Typography role="status" sx={{ p: 2 }}>Loading PDF viewer…</Typography>}><PdfPreview key={props.previewUrl} url={props.previewUrl} title={props.title}/></Suspense>;
  } else if (capability.kind === "docx" && (props.downloadUrl ?? props.previewUrl)) {
    body = <Suspense fallback={<Typography role="status" sx={{ p: 2 }}>Loading Word document viewer…</Typography>}><DocxPreview key={props.downloadUrl ?? props.previewUrl} url={(props.downloadUrl ?? props.previewUrl)!} title={props.title}/></Suspense>;
  } else if (capability.kind === "diff" && props.content !== undefined) {
    body = props.content ? <UnifiedDiffViewer diff={props.content} /> : <Alert severity="info">This diff is empty.</Alert>;
  } else if (capability.kind === "markdown" && props.content !== undefined) {
    body = props.content ? <MarkdownPreview content={props.content} projectId={props.projectId} path={props.path} agentId={props.agentId} conversationId={props.conversationId} /> : <Alert severity="info">This document is empty.</Alert>;
  } else if (capability.kind === "text" && props.content !== undefined) {
    body = props.content
      ? <Box component="pre" aria-label={`Text preview for ${props.title}`} sx={{ m: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "monospace", fontSize: 13 }}>{props.content}</Box>
      : <Alert severity="info">This file is empty.</Alert>;
  } else {
    body = <Alert severity="info">{props.emptyMessage ?? (capability.inline ? "A preview is not available yet." : props.downloadUrl ? "This file type cannot be displayed safely in Ponderosa. Download it to open it with a compatible application." : "This file type cannot be displayed safely in Ponderosa.")}</Alert>;
  }

  return <FeatureErrorBoundary feature={`${capability.label} preview`}>
    <Box data-preview-capability={capability.kind} sx={{ minWidth: 0 }}>
      {!props.hideHeader ? <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "center" }, mb: 1 }}>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="subtitle2" noWrap>{props.title}</Typography>
          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block" }}>{props.path ?? capability.label}</Typography>
        </Box>
        <Stack direction="row" spacing={.5}>{actions}</Stack>
      </Stack> : null}
      {props.truncated ? <Alert severity="info" sx={{ mb: 1 }}>Preview is limited to 2 MiB{props.totalBytes ? ` of ${props.totalBytes.toLocaleString()} bytes` : ""}. {props.downloadUrl ? "Download the file for complete contents." : null}</Alert> : null}
      <Paper variant="outlined" sx={{ p: capability.kind === "pdf" ? 0 : { xs: 1, sm: 1.5 }, overflow: "auto", maxHeight: capability.kind === "pdf" ? undefined : props.maxHeight ?? { xs: "55vh", md: "66vh" } }}>
        {body}
      </Paper>
    </Box>
  </FeatureErrorBoundary>;
}
