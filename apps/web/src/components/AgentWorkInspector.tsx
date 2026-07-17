import CloseIcon from "@mui/icons-material/Close";
import RefreshIcon from "@mui/icons-material/Refresh";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Chip,
  CircularProgress,
  Drawer,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { AgentWorkItemDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";

export interface AgentWorkFocus {
  id: string;
}

function kindLabel(kind: AgentWorkItemDto["kind"]): string {
  if (kind === "activation") return "Wake-up";
  if (kind === "join") return "Waiting";
  if (kind === "request") return "Assigned work";
  if (kind === "run") return "Run";
  if (kind === "trigger") return "Trigger";
  return "Decision";
}

function itemMatchesFocus(item: AgentWorkItemDto, focusId: string | undefined): boolean {
  if (!focusId) return false;
  const bareId = focusId.includes(":") ? focusId.slice(focusId.indexOf(":") + 1) : focusId;
  return item.id === focusId || item.recordId === focusId || item.referenceIds.includes(focusId)
    || item.recordId === bareId || item.referenceIds.includes(bareId);
}

export function AgentWorkInspector({
  open,
  projectId,
  conversationId,
  agentId,
  focus,
  onClose,
}: {
  open: boolean;
  projectId: string;
  conversationId?: string;
  agentId?: string;
  focus?: AgentWorkFocus;
  onClose(): void;
}): JSX.Element {
  const query = useQuery({
    queryKey: ["agent-work", projectId, conversationId ?? "", agentId ?? ""],
    queryFn: () => api.getAgentWork(projectId, { conversationId, agentId, limit: 500 }),
    enabled: open,
  });
  const [expandedTraceId, setExpandedTraceId] = useState<string>();
  const items = useMemo(() => new Map((query.data?.items ?? []).map((item) => [item.id, item])), [query.data?.items]);
  const focusedTraceId = useMemo(() => query.data?.traces.find((trace) =>
    trace.itemIds.some((itemId) => {
      const item = items.get(itemId);
      return item ? itemMatchesFocus(item, focus?.id) : false;
    }))?.id, [focus?.id, items, query.data?.traces]);
  const focusedItemId = useMemo(() => query.data?.items.find((item) => itemMatchesFocus(item, focus?.id))?.id, [focus?.id, query.data?.items]);

  useEffect(() => {
    if (!open) return;
    if (focusedTraceId) setExpandedTraceId(focusedTraceId);
    else if (!expandedTraceId) setExpandedTraceId(query.data?.traces[0]?.id);
  }, [open, focusedTraceId, query.data?.traces, expandedTraceId]);

  useEffect(() => {
    if (!open || !focusedItemId || expandedTraceId !== focusedTraceId) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(`agent-work-${focusedItemId}`);
      target?.scrollIntoView({ block: "center" });
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expandedTraceId, focusedItemId, focusedTraceId, open]);

  const stateCounts = query.data?.traces.reduce((counts, trace) => {
    counts[trace.state] += 1;
    return counts;
  }, { active: 0, attention: 0, finished: 0 }) ?? { active: 0, attention: 0, finished: 0 };

  return <Drawer
    anchor="right"
    open={open}
    onClose={onClose}
    PaperProps={{ sx: { width: { xs: "100%", sm: 520 }, maxWidth: "100%" } }}
  >
    <Stack sx={{ height: "100%", minHeight: 0 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", px: 2, py: 1.5, borderBottom: 1, borderColor: "divider" }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6">Agent work</Typography>
          <Typography variant="caption" color="text.secondary">Requests, waiting, wake-ups, Runs, Triggers, and Decisions</Typography>
        </Box>
        <Tooltip title="Refresh now"><span><IconButton aria-label="Refresh Agent work" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshIcon /></IconButton></span></Tooltip>
        <IconButton aria-label="Close Agent work" onClick={onClose}><CloseIcon /></IconButton>
      </Stack>
      <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ px: 2, py: 1.25, borderBottom: 1, borderColor: "divider" }}>
        <Chip size="small" color="info" variant="outlined" label={`${stateCounts.active} active`} />
        <Chip size="small" color="warning" variant="outlined" label={`${stateCounts.attention} need attention`} />
        <Chip size="small" variant="outlined" label={`${stateCounts.finished} finished`} />
        {query.isFetching ? <CircularProgress size={18} sx={{ ml: "auto" }} aria-label="Refreshing Agent work" /> : null}
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: 1.5 }}>
        {query.isLoading ? <Stack direction="row" spacing={1} sx={{ alignItems: "center", p: 2 }}><CircularProgress size={20} /><Typography variant="body2">Loading Agent work…</Typography></Stack> : null}
        {query.isError ? <Alert severity="error">{query.error instanceof Error ? query.error.message : "Agent work could not be loaded."}</Alert> : null}
        {query.data?.truncated ? <Alert severity="info" sx={{ mb: 1 }}>
          Showing the newest connected work. Some older records are outside this view’s safety limit.
        </Alert> : null}
        {query.data && query.data.traces.length === 0 ? <Alert severity="info">No coordinated Agent work has been recorded in this scope yet.</Alert> : null}
        <Stack spacing={1}>
          {(query.data?.traces ?? []).map((trace) => {
            const traceItems = trace.itemIds.map((id) => items.get(id)).filter((item): item is AgentWorkItemDto => Boolean(item));
            return <Accordion
              key={trace.id}
              expanded={expandedTraceId === trace.id}
              onChange={(_, expanded) => setExpandedTraceId(expanded ? trace.id : undefined)}
              disableGutters
              variant="outlined"
              data-agent-work-trace={trace.id}
              sx={{ borderRadius: "8px !important", "&:before": { display: "none" } }}
            >
              <AccordionSummary>
                <Box sx={{ width: "100%", minWidth: 0 }}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                    <Chip size="small" color={trace.state === "attention" ? "warning" : trace.state === "active" ? "info" : "default"} label={trace.state === "attention" ? "Attention" : trace.state === "active" ? "Active" : "Finished"} />
                    <Typography variant="subtitle2" noWrap sx={{ flex: 1 }}>{trace.title}</Typography>
                    <Typography variant="caption" color="text.secondary">{new Date(trace.updatedAt).toLocaleString()}</Typography>
                  </Stack>
                  <Typography variant="caption" color="text.secondary">{trace.summary}</Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails sx={{ pt: 0 }}>
                <Stack spacing={0} sx={{ borderLeft: 2, borderColor: "divider", ml: 1 }}>
                  {traceItems.map((item) => {
                    const focused = itemMatchesFocus(item, focus?.id);
                    return <Box key={item.id} id={`agent-work-${item.id}`} tabIndex={focused ? -1 : undefined} data-agent-work-item={item.id} sx={{ position: "relative", ml: 1.5, mb: 1.25, p: 1.25, borderRadius: 1.5, bgcolor: focused ? "action.selected" : "action.hover", outline: focused ? 2 : 0, outlineColor: "primary.main" }}>
                      <Box sx={{ position: "absolute", width: 10, height: 10, borderRadius: "50%", bgcolor: "text.secondary", left: -21, top: 18 }} />
                      <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
                        <Chip size="small" variant="outlined" label={kindLabel(item.kind)} />
                        <Typography variant="subtitle2" sx={{ flex: 1 }}>{item.title}</Typography>
                        <Chip size="small" label={item.state.replaceAll("_", " ")} />
                      </Stack>
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>{item.summary}</Typography>
                      <Typography variant="caption" color="text.secondary">{new Date(item.createdAt).toLocaleString()}</Typography>
                      <Box component="details" sx={{ mt: 0.75, "& > summary": { cursor: "pointer" } }}>
                        <Typography component="summary" variant="caption" color="text.secondary">Technical details</Typography>
                        <Stack spacing={0.5} sx={{ mt: 0.75 }}>
                          {item.details.map((detail) => <Box key={`${detail.label}:${detail.value}`}>
                            <Typography variant="caption" sx={{ fontWeight: 700 }}>{detail.label}</Typography>
                            <Typography component="pre" variant="caption" sx={{ m: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "monospace" }}>{detail.value}</Typography>
                          </Box>)}
                        </Stack>
                      </Box>
                    </Box>;
                  })}
                </Stack>
              </AccordionDetails>
            </Accordion>;
          })}
        </Stack>
      </Box>
    </Stack>
  </Drawer>;
}
