import { Box, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DecisionDto } from "@ponderosa/core";
import { api } from "../../api";
import { productApiPath } from "../../api/productScope";
import { queryKeys } from "../../queryKeys";
import { workspaceRead } from "../../workspaceAvailability";
import { WorkspaceQueryError } from "../WorkspaceQueryError";
import { composerSurfaceWidth } from "../chat/Composer.styles";
import type { DecisionPrompt } from "../../decisions";
import { DecisionCard } from "./DecisionCard";

export const DECISION_IDLE_COLLAPSE_MS = 60_000;
type Props = { projectId: string; conversationId: string; agentId?: string; active?: boolean; decisions?: readonly DecisionDto[]; focusDecisionId?: string; agentTitle?(id: string): string | undefined };

function PendingQuestion({ decision, active, focused, title, onRetentionChange }: {
  decision: DecisionPrompt; active: boolean; focused: boolean; title: string;
  onRetentionChange(decision: DecisionPrompt, retain: boolean): void;
}) {
  const [expanded, setExpanded] = useState(true);
  const element = useRef<HTMLDetailsElement>(null), summary = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const resetIdle = useCallback(() => {
    clearTimeout(timer.current);
    if (!expanded || !active) return;
    timer.current = setTimeout(() => {
      if (element.current?.contains(document.activeElement)) summary.current?.focus({ preventScroll: true });
      setExpanded(false);
    }, DECISION_IDLE_COLLAPSE_MS);
  }, [expanded, active]);
  useEffect(() => { resetIdle(); return () => clearTimeout(timer.current); }, [resetIdle]);
  useEffect(() => {
    if (!active || !focused) return;
    setExpanded(true); summary.current?.focus({ preventScroll: true });
  }, [active, focused]);
  return <Box component="details" ref={element} id={`decision:${decision.id}`} open={expanded}
    onToggle={event => {
      const open = event.currentTarget.open; setExpanded(open);
      if (open) {
        const input = element.current?.querySelector('textarea');
        if (input?.getClientRects().length) input.focus({ preventScroll: true });
      } else if (element.current?.contains(document.activeElement)) summary.current?.focus({ preventScroll: true });
    }}
    onInputCapture={resetIdle} onPointerDownCapture={resetIdle} onKeyDownCapture={resetIdle} onFocusCapture={resetIdle} onScrollCapture={resetIdle}
    sx={{ minWidth: 0, '& > summary': { cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center', px: 1.5, outlineOffset: -2 }, '& + details': { borderTop: 1, borderColor: 'divider' } }}>
    <summary ref={summary}><Typography component="span" variant="body2">{expanded ? `Question From ${title}` : 'Answer Question'}</Typography></summary>
    <DecisionCard decision={decision} inline onRetentionChange={onRetentionChange} onDismiss={() => {
      summary.current?.focus({ preventScroll: true }); setExpanded(false);
    }} />
  </Box>;
}

function ScopedDecisionPanel({ projectId, conversationId, agentId, active = true, decisions, focusDecisionId, agentTitle }: Props) {
  const query = useQuery({ queryKey: [...queryKeys.decisions.all, 'chat-panel', productApiPath('/api/decisions'), projectId, conversationId, agentId],
    queryFn: ({ signal }) => api.listDecisions({ projectId, conversationId, ...(agentId ? { agentId } : {}), status: 'pending' }, signal), enabled: active && decisions === undefined });
  // Retain only the existing mounted response owner while its approval/action
  // completion is pending or uncertain. Canonical Decision state stays in Query.
  const [retained, setRetained] = useState(new Map<string, DecisionPrompt>());
  const retain = useCallback((decision: DecisionPrompt, keep: boolean) => setRetained(previous => {
    if (keep ? previous.get(decision.id) === decision : !previous.has(decision.id)) return previous;
    const next = new Map(previous); if (keep) next.set(decision.id, decision); else next.delete(decision.id); return next;
  }), []);
  const pending = (decisions ?? query.data ?? []).filter(decision => decision.status === 'pending' && decision.projectId === projectId && (decision.conversationId === conversationId || (!decision.conversationId && agentId && decision.agentId === agentId)) && (!agentId || decision.agentId === agentId));
  const questions = [...new Map<string, DecisionPrompt>([...retained, ...pending.map(decision => [decision.id, decision] as const)]).values()];
  return <Box role="region" aria-label="Chat Questions" hidden={!active} sx={{ display: active ? 'block' : 'none', width: composerSurfaceWidth, mx: 'auto', minWidth: 0, maxHeight: 'min(45dvh, max(44px, calc(var(--ponderosa-app-viewport-block-size, 100dvh) - 12rem)))', overflowY: 'auto', overflowX: 'hidden', bgcolor: 'background.paper' }}>
    {decisions === undefined && <WorkspaceQueryError read={workspaceRead(`questions:${conversationId}`, 'Questions', query)} />}
    {questions.map(decision => <PendingQuestion key={decision.id} decision={decision} active={active} focused={focusDecisionId === decision.id}
      title={agentTitle?.(decision.agentId ?? '') ?? 'Agent'} onRetentionChange={retain} />)}
  </Box>;
}

/** Ownership changes remount presentation, never another Chat's answer draft. */
export function ChatDecisionPanel(props: Props) {
  return <ScopedDecisionPanel key={JSON.stringify([productApiPath('/api/decisions'), props.projectId, props.conversationId, props.agentId])} {...props} />;
}
