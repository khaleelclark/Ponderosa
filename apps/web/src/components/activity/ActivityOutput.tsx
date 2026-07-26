import { Alert, Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import type { AgentActivityOutputDto, RunOutputDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { queryKeys } from "../../queryKeys";
import type { ActivityStreamResult } from "./activityStream";

function byteLabel(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

export function ActivityOutput({
  result,
  label = "Output",
  collapsedLines = 10,
}: {
  result: ActivityStreamResult;
  label?: string;
  collapsedLines?: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [additionalPages, setAdditionalPages] = useState<AgentActivityOutputDto[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const reference = result.outputPreview;
  const query = useQuery({
    queryKey: queryKeys.activityOutput.detail(
      result.agentId,
      result.seq,
      reference?.sha256,
    ),
    queryFn: () => api.getActivityOutput(reference!.retrievalUrl),
    enabled: open && Boolean(reference),
  });
  useEffect(() => {
    setAdditionalPages([]);
    setLoadMoreError(false);
  }, [result.agentId, result.seq, reference?.sha256]);

  const pages = query.data ? [query.data, ...additionalPages] : [];
  const nextCursor = pages.at(-1)?.nextCursor;
  const loadedBytes = pages.reduce((sum, page) => sum + page.pageUtf8Bytes, 0);
  const canonicalOutput = pages.map((page) => page.output).join("");
  const output = open && canonicalOutput ? canonicalOutput : result.output;
  const lineCount = result.output.split("\n").length;
  const collapsible = lineCount > collapsedLines || result.output.length > 800 || Boolean(reference);
  const totalBytes = reference?.totalUtf8Bytes ?? new TextEncoder().encode(result.output).byteLength;

  return <Box sx={{ mt: 0.75 }}>
    <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.25, fontWeight: 700 }}>
      {label}:
    </Typography>
    <Box sx={{
      position: "relative",
      ...(!open && collapsible ? {
        maxHeight: `${collapsedLines * 1.45}em`,
        overflow: "hidden",
        maskImage: "linear-gradient(to bottom, black calc(100% - 2.5em), transparent)",
      } : {}),
    }}>
      {open && query.isLoading
        ? <CircularProgress size={18} />
        : open && query.isError
          ? <Alert severity="error">The complete canonical tool output could not be loaded.</Alert>
          : <Typography
              component="pre"
              variant="caption"
              color={result.isError ? "error.main" : "text.secondary"}
              sx={{ m: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "monospace", lineHeight: 1.45, userSelect: "text" }}
            >{output || "(no output)"}</Typography>}
    </Box>
    {collapsible ? <Stack direction="row" spacing={1} sx={{ alignItems: "center", mt: 0.25 }}>
      <Button size="small" color="inherit" onClick={() => setOpen((value) => !value)}>
        {open ? "Show less" : `Show more · ${byteLabel(totalBytes)}`}
      </Button>
      {open && reference && canonicalOutput ? <Typography variant="caption" color="text.secondary">
        Loaded {loadedBytes.toLocaleString()} of {reference.totalUtf8Bytes.toLocaleString()} bytes
      </Typography> : null}
      {open && nextCursor ? <Button size="small" disabled={loadingMore} onClick={() => {
        setLoadingMore(true);
        setLoadMoreError(false);
        void api.getActivityOutput(reference!.retrievalUrl, nextCursor)
          .then((page) => setAdditionalPages((current) => [...current, page]))
          .catch(() => setLoadMoreError(true))
          .finally(() => setLoadingMore(false));
      }}>{loadingMore ? "Loading…" : "Load More"}</Button> : null}
    </Stack> : null}
    {loadMoreError ? <Alert severity="error" sx={{ mt: 0.75 }}>The next output page could not be loaded.</Alert> : null}
  </Box>;
}

export function RunOutputFullText({
  segment,
  render,
}: {
  segment: RunOutputDto;
  render(text: string): JSX.Element;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const reference = segment.textPreview;
  const query = useQuery({
    queryKey: queryKeys.runOutputText.detail(
      segment.agentId,
      segment.seq,
      reference?.totalUtf8Bytes ?? 0,
    ),
    queryFn: () => api.getRunOutputText(reference!.retrievalUrl),
    enabled: open && Boolean(reference),
  });
  if (!reference) return render(segment.text);
  return <Box>
    {render(open && query.data ? query.data.text : segment.text)}
    <Button size="small" color="inherit" onClick={() => setOpen((value) => !value)} sx={{ mt: 0.5 }}>
      {open ? "Show preview" : `Load full text · ${byteLabel(reference.totalUtf8Bytes)}`}
    </Button>
    {open && query.isLoading ? <CircularProgress size={18} sx={{ ml: 1 }} /> : null}
    {open && query.isError ? <Alert severity="error" sx={{ mt: 0.75 }}>The complete canonical segment could not be loaded.</Alert> : null}
  </Box>;
}
