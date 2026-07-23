import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import {
  Alert, Box, Button, CircularProgress, Paper, Stack, Typography,
} from "@mui/material";
import type { ArtifactKind } from "@ponderosa/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { previewCapability } from "./mimeCapabilities";
import { FeatureErrorBoundary } from "../FeatureErrorBoundary";

export function diffLineKind(line: string): "addition" | "deletion" | "neutral" {
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
        data-diff-line-kind={kind}
        sx={{
          display: "block",
          minWidth: "max-content",
          px: 1,
          color: kind === "addition" ? "success.dark" : kind === "deletion" ? "error.dark" : "text.primary",
          bgcolor: kind === "addition" ? "rgba(46, 160, 67, 0.16)" : kind === "deletion" ? "rgba(248, 81, 73, 0.16)" : "transparent",
        }}
      >{line || " "}</Box>;
    })}
  </Box>;
}

export function MarkdownPreview({ content }: { content: string }): JSX.Element {
  return <Box sx={{ overflowWrap: "anywhere", "& pre": { overflowX: "auto" }, "& code": { fontSize: ".86rem" }, "& p": { lineHeight: 1.65 } }}>
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
  </Box>;
}

export interface FilePreviewProps {
  title: string;
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
    body = <Alert severity="error">{errorMessage ? `Preview is unavailable: ${errorMessage}` : "Preview is unavailable. Download the file to inspect it."}</Alert>;
  } else if (capability.kind === "image" && props.previewUrl) {
    body = <Box component="img" data-testid="file-image-preview" src={props.previewUrl} alt={props.title} sx={{ display: "block", maxWidth: "100%", maxHeight: props.maxHeight ?? { xs: "55vh", md: "66vh" }, objectFit: "contain", mx: "auto" }} />;
  } else if (capability.kind === "pdf" && props.previewUrl) {
    body = <Box component="iframe" data-testid="file-pdf-preview" title={`Preview ${props.title}`} src={props.previewUrl} sx={{ width: "100%", minHeight: props.maxHeight ?? { xs: "55vh", md: "66vh" }, border: 0, bgcolor: "background.paper" }} />;
  } else if (capability.kind === "diff" && props.content !== undefined) {
    body = props.content ? <UnifiedDiffViewer diff={props.content} /> : <Alert severity="info">This diff is empty.</Alert>;
  } else if (capability.kind === "markdown" && props.content !== undefined) {
    body = props.content ? <MarkdownPreview content={props.content} /> : <Alert severity="info">This document is empty.</Alert>;
  } else if (capability.kind === "text" && props.content !== undefined) {
    body = props.content
      ? <Box component="pre" aria-label={`Text preview for ${props.title}`} sx={{ m: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "monospace", fontSize: 13 }}>{props.content}</Box>
      : <Alert severity="info">This file is empty.</Alert>;
  } else {
    body = <Alert severity="info">{props.emptyMessage ?? (capability.inline ? "A preview is not available yet." : "This file type cannot be displayed safely in Ponderosa. Download it to open it with a compatible application.")}</Alert>;
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
