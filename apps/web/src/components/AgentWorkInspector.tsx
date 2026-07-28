import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import RefreshIcon from "@mui/icons-material/Refresh";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { AgentWorkInspectorDto, AgentWorkItemDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { copyText } from "../clipboard";
import { queryKeys } from "../queryKeys";
import { isChatNearBottom, scrollChatToBottom, ScrollToLatestButton } from "./chat/scroll";

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

function agentWorkStateLabel(state: string): string {
  return state.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}

function agentWorkItemMatchesFocus(item: AgentWorkItemDto, focusId: string | undefined): boolean {
  if (!focusId) return false;
  const bareId = focusId.includes(":") ? focusId.slice(focusId.indexOf(":") + 1) : focusId;
  return item.id === focusId || item.recordId === focusId || item.referenceIds.includes(focusId)
    || item.recordId === bareId || item.referenceIds.includes(bareId);
}

function diagnosticLogBundle(data: AgentWorkInspectorDto): string {
  return [
    "Ponderosa Diagnostic Logs",
    `Project ID: ${data.projectId}`,
    data.conversationId ? `Chat ID: ${data.conversationId}` : undefined,
    data.agentId ? `Agent ID: ${data.agentId}` : undefined,
    `Generated: ${new Date(data.generatedAt).toLocaleString()}`,
    data.truncated ? "Window: bounded recent evidence (older records omitted)" : "Window: complete returned evidence",
    "",
    JSON.stringify({ traces: data.traces, records: data.items }, null, 2),
  ].filter((line): line is string => line !== undefined).join("\n");
}

function AgentWorkTechnicalDetails({
  projectId,
  conversationId,
  item,
}: {
  projectId: string;
  conversationId?: string;
  item: AgentWorkItemDto;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const query = useQuery({
    queryKey: queryKeys.agentWork.detail(projectId, conversationId, item.id),
    queryFn: () => api.getAgentWorkItemDetails(projectId, item.kind, item.recordId, { conversationId }),
    enabled: expanded && item.details === undefined,
    staleTime: 15_000,
  });
  const details = item.details ?? query.data?.details;
  return <Box
    component="details"
    onToggle={(event) => setExpanded(event.currentTarget.open)}
    sx={{ mt: 0.75, "& > summary": { cursor: "pointer" } }}
  >
    <Typography component="summary" variant="caption" color="text.secondary">Raw fields and provider data</Typography>
    {query.isLoading ? <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", mt: 0.75 }}>
      <CircularProgress size={14} /><Typography variant="caption">Loading technical details…</Typography>
    </Stack> : null}
    {query.isError ? <Alert severity="error" sx={{ mt: 0.75 }}>Technical details could not be loaded.</Alert> : null}
    {details ? <Stack spacing={0.5} sx={{ mt: 0.75 }}>
      {details.length === 0 ? <Typography variant="caption" color="text.secondary">No technical fields were recorded.</Typography> : null}
      {details.map((detail) => <Box key={`${detail.label}:${detail.value}`}>
        <Typography variant="caption" sx={{ fontWeight: 700 }}>{detail.label}</Typography>
        <Typography component="pre" variant="caption" sx={{ m: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "monospace" }}>{detail.value}</Typography>
      </Box>)}
    </Stack> : null}
  </Box>;
}

function CopyRecordId({ id }: { id: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return <Tooltip title={copied ? "Copied" : `Copy ID ${id}`}>
    <IconButton size="small" aria-label={`Copy ID ${id}`} onClick={() => {
      void copyText(id).then(() => {
        setCopied(true);
        globalThis.setTimeout(() => setCopied(false), 1_500);
      });
    }}><ContentCopyIcon fontSize="inherit" /></IconButton>
  </Tooltip>;
}

function TechnicalRecord({ projectId, conversationId, item, elementId, focused = false }: { projectId: string; conversationId?: string; item: AgentWorkItemDto; elementId?: string; focused?: boolean }): JSX.Element {
  return <Box
    id={elementId}
    tabIndex={focused ? -1 : undefined}
    data-agent-work-item={item.id}
    sx={{ minWidth: 0, p: 1.25, borderRadius: 1.5, bgcolor: focused ? "action.selected" : "action.hover", outline: focused ? 2 : 0, outlineColor: "primary.main" }}
  >
    <Stack direction="row" spacing={0.75} sx={{ alignItems: "center", minWidth: 0 }}>
      <Chip size="small" variant="outlined" label={kindLabel(item.kind)} />
      <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{item.title}</Typography>
      <Chip size="small" label={agentWorkStateLabel(item.state)} />
    </Stack>
    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, overflowWrap: "anywhere" }}>{item.summary}</Typography>
    <Stack direction="row" spacing={0.5} sx={{ mt: 0.5, alignItems: "center", minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
        {new Date(item.createdAt).toLocaleString()} · ID {item.recordId}
      </Typography>
      <CopyRecordId id={item.recordId} />
    </Stack>
    <AgentWorkTechnicalDetails projectId={projectId} conversationId={conversationId} item={item} />
  </Box>;
}

export function AgentWorkInspector({
  open,
  projectId,
  conversationId,
  agentId,
  focus,
  onClose,
  backLabel = "Back to Project",
}: {
  open: boolean;
  projectId: string;
  conversationId?: string;
  agentId?: string;
  focus?: AgentWorkFocus;
  onClose(): void;
  backLabel?: string;
}): JSX.Element {
  const query = useQuery({
    queryKey: queryKeys.agentWork.list(
      projectId,
      conversationId,
      agentId,
      focus?.id,
    ),
    queryFn: () => api.getAgentWork(projectId, { conversationId, agentId, focusId: focus?.id, limit: 200 }),
    enabled: open,
  });
  const [expandedTraceId, setExpandedTraceId] = useState<string>();
  const [logsCopied, setLogsCopied] = useState(false);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const scrollRegionRef = useRef<HTMLDivElement>(null);
  const positionedScopeRef = useRef<string>();
  const scopeKey = `${projectId}:${conversationId ?? ""}:${agentId ?? ""}:${focus?.id ?? ""}`;
  const items = useMemo(() => new Map((query.data?.items ?? []).map((item) => [item.id, item])), [query.data?.items]);
  const orderedTraces = useMemo(
    () => [...(query.data?.traces ?? [])].sort((a, b) =>
      a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id)),
    [query.data?.traces],
  );
  const focusedTraceId = useMemo(() => query.data?.traces.find((trace) =>
    trace.itemIds.some((itemId) => {
      const item = items.get(itemId);
      return item ? agentWorkItemMatchesFocus(item, focus?.id) : false;
    }))?.id, [focus?.id, items, query.data?.traces]);
  const focusedItemId = useMemo(() => query.data?.items.find((item) => agentWorkItemMatchesFocus(item, focus?.id))?.id, [focus?.id, query.data?.items]);
  const focusedItem = focusedItemId ? items.get(focusedItemId) : undefined;

  useEffect(() => {
    if (!open) return;
    if (focusedTraceId) setExpandedTraceId(focusedTraceId);
  }, [open, focusedTraceId]);

  useEffect(() => {
    if (!open || !query.data || focus?.id || positionedScopeRef.current === scopeKey) return;
    positionedScopeRef.current = scopeKey;
    const frame = window.requestAnimationFrame(() => {
      const region = scrollRegionRef.current;
      if (!region) return;
      scrollChatToBottom(region);
      setShowScrollToLatest(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focus?.id, open, query.data, scopeKey]);

  useEffect(() => {
    if (!open || !focusedItemId) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(`agent-work-focus-${focusedItemId}`);
      target?.scrollIntoView({ block: "center" });
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusedItemId, open]);

  const stateCounts = query.data?.traces.reduce((counts, trace) => {
    if (trace.state in counts) counts[trace.state] += 1;
    return counts;
  }, { active: 0, attention: 0, finished: 0 }) ?? { active: 0, attention: 0, finished: 0 };

  if (!open) return <></>;

  return <Stack data-testid="technical-details-workspace" sx={{ position: "relative", height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden" }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", px: 2, py: 1.5, borderBottom: 1, borderColor: "divider" }}>
        <Tooltip title={backLabel}><IconButton aria-label={backLabel} onClick={onClose}><ArrowBackIcon /></IconButton></Tooltip>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6">Diagnostics</Typography>
          <Typography variant="caption" color="text.secondary">Understand why work stopped or behaved unexpectedly.</Typography>
        </Box>
        <Button
          size="small"
          color="inherit"
          startIcon={<ContentCopyIcon />}
          disabled={!query.data}
          onClick={() => {
            if (!query.data) return;
            void copyText(diagnosticLogBundle(query.data)).then(() => {
              setLogsCopied(true);
              globalThis.setTimeout(() => setLogsCopied(false), 1_500);
            });
          }}
        >
          {logsCopied ? "Copied" : "Copy Logs"}
        </Button>
        <Tooltip title="Refresh Diagnostics"><span><IconButton aria-label="Refresh Diagnostics" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshIcon /></IconButton></span></Tooltip>
      </Stack>
      <Box
        ref={scrollRegionRef}
        className="ponderosa-scroll"
        onScroll={(event) => setShowScrollToLatest(!isChatNearBottom(event.currentTarget, 64))}
        sx={{ flex: 1, minHeight: 0, minWidth: 0, overflowY: "auto", overflowX: "hidden", p: 1.5 }}
      >
        {query.isLoading ? <Stack direction="row" spacing={1} sx={{ alignItems: "center", p: 2 }}><CircularProgress size={20} /><Typography variant="body2">Loading diagnostics…</Typography></Stack> : null}
        {query.isError ? <Alert severity="error">{query.error instanceof Error ? query.error.message : "Diagnostics could not be loaded."}</Alert> : null}
        {query.data?.truncated ? <Alert severity="info" sx={{ mb: 1 }}>
          Showing recent diagnostic evidence. Older records remain preserved and are omitted from this view.
        </Alert> : null}
        {query.data ? <Stack spacing={1.5} sx={{ width: "100%", maxWidth: 1100, mx: "auto" }}>
          <Alert severity={stateCounts.attention ? "warning" : stateCounts.active ? "info" : "success"} icon={false} sx={{ py: 0.75 }}>
            <Typography variant="body2" fontWeight={800}>
              {stateCounts.attention
                ? `${stateCounts.attention} workflow${stateCounts.attention === 1 ? "" : "s"} need attention`
                : stateCounts.active
                  ? `${stateCounts.active} workflow${stateCounts.active === 1 ? " is" : "s are"} still active`
                  : "No unresolved workflow problems in this evidence window"}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Expand a workflow to see what started it, what ran, and where it stopped.
            </Typography>
          </Alert>
          {focusedItem ? <Box component="section" aria-labelledby="focused-technical-record">
            <Typography id="focused-technical-record" variant="overline" color="text.secondary">Why You’re Here</Typography>
            <TechnicalRecord
              projectId={projectId}
              conversationId={conversationId}
              item={focusedItem}
              elementId={`agent-work-focus-${focusedItem.id}`}
              focused
            />
          </Box> : focus?.id ? <Alert severity="warning">The focused technical record is not available in this bounded evidence window.</Alert> : null}

          <Box component="section" aria-labelledby="diagnostic-workflows">
            <Typography id="diagnostic-workflows" variant="overline" color="text.secondary">Workflows</Typography>
            {orderedTraces.length === 0 ? <Alert severity="info">No diagnostic records are available for this scope.</Alert> : null}
          {orderedTraces.map((trace) => {
            const traceItems = trace.itemIds.map((id) => items.get(id)).filter((item): item is AgentWorkItemDto => Boolean(item));
            return <Accordion
              key={trace.id}
              expanded={expandedTraceId === trace.id}
              onChange={(_, expanded) => setExpandedTraceId(expanded ? trace.id : undefined)}
              disableGutters
              data-agent-work-trace={trace.id}
              sx={{
                bgcolor: "transparent",
                borderTop: 1,
                borderColor: "divider",
                boxShadow: "none",
                "&:before": { display: "none" },
                "&:last-of-type": { borderBottom: 1, borderColor: "divider" },
              }}
            >
              <AccordionSummary
                expandIcon={<ExpandMoreIcon />}
                aria-label={`${expandedTraceId === trace.id ? "Collapse" : "Expand"} ${trace.title}`}
                sx={{ minWidth: 0, px: 1.5, minHeight: 64, "& .MuiAccordionSummary-content": { minWidth: 0, my: 1.25 } }}
              >
                <Stack direction="row" spacing={1} sx={{ width: "100%", minWidth: 0, alignItems: "center" }}>
                  <Chip size="small" color={trace.state === "attention" ? "warning" : trace.state === "active" ? "info" : "default"} label={trace.state === "attention" ? "Needs attention" : trace.state === "active" ? "Active" : "Finished"} />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="subtitle2" fontWeight={750} noWrap>{trace.title}</Typography>
                    <Typography variant="body2" color="text.secondary" noWrap>{trace.summary}</Typography>
                  </Box>
                  <Typography variant="caption" color="text.secondary">{traceItems.length} records</Typography>
                  <Typography variant="caption" color="text.secondary">{new Date(trace.updatedAt).toLocaleString()}</Typography>
                </Stack>
              </AccordionSummary>
              <AccordionDetails sx={{ pt: 0, px: 1 }}>
                <Stack spacing={0} sx={{ borderLeft: 2, borderColor: "divider", ml: 1, mb: 1 }}>
                  {traceItems.map((item) => {
                    const focused = agentWorkItemMatchesFocus(item, focus?.id);
                    return <Box key={item.id} id={`agent-work-${item.id}`} tabIndex={focused ? -1 : undefined} data-agent-work-item={item.id} sx={{ position: "relative", minWidth: 0, ml: 1.5, px: 1.25, py: 1.25, borderBottom: 1, borderColor: "divider", bgcolor: focused ? "action.selected" : "transparent", outline: focused ? 2 : 0, outlineColor: "primary.main" }}>
                      <Box sx={{ position: "absolute", width: 8, height: 8, borderRadius: "50%", bgcolor: item.state === "failed" || item.state === "blocked" ? "warning.main" : "text.secondary", left: -20, top: 16 }} />
                      <Box sx={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", gap: 0.75, alignItems: "start" }}>
                        <Chip size="small" variant="outlined" label={kindLabel(item.kind)} />
                        <Typography variant="body2" fontWeight={700} sx={{ minWidth: 0, overflowWrap: "anywhere" }}>{item.title}</Typography>
                        <Chip size="small" label={agentWorkStateLabel(item.state)} />
                      </Box>
                      <Typography variant="body2" color="text.secondary" sx={{ display: "block", mt: 0.5, overflowWrap: "anywhere" }}>{item.summary}</Typography>
                      <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
                        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>{new Date(item.createdAt).toLocaleString()} · ID {item.recordId}</Typography>
                        <CopyRecordId id={item.recordId} />
                      </Stack>
                      <AgentWorkTechnicalDetails projectId={projectId} conversationId={conversationId} item={item} />
                    </Box>;
                  })}
                </Stack>
              </AccordionDetails>
            </Accordion>;
          })}
          </Box>
        </Stack> : null}
      </Box>
      <ScrollToLatestButton
        visible={showScrollToLatest}
        label="Jump to latest workflow"
        onClick={() => {
          const region = scrollRegionRef.current;
          if (!region) return;
          scrollChatToBottom(region);
          setShowScrollToLatest(false);
        }}
      />
  </Stack>;
}
