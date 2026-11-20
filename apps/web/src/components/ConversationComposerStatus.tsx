import type { AgentDto, AgentHealthDto } from "@ponderosa/core";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { Box, ButtonBase, Tooltip } from "@mui/material";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatExecutionElapsed } from "../time";
import { ChatLiveBanner } from "./chat/ChatLiveBanner";

export function ChatWorkingAgents({ conversationId, agents, healthByAgentId }: {
  agents: AgentDto[];
  healthByAgentId: Map<string, AgentHealthDto>;
  conversationId: string;
}): JSX.Element | null {
  const [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState(false);
  const [fittedSummary, setFittedSummary] = useState<string>();
  const containerRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const elapsedRef = useRef<HTMLSpanElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pending = useMemo(() => [...healthByAgentId.values()].flatMap(({ agentId, runtimeActivity }) => {
    if (runtimeActivity?.conversationId !== conversationId) return [];
    return [{
      agentId,
      name: agents.find(agent => agent.id === agentId)?.title.trim() || "Agent",
      since: runtimeActivity.startedAt,
    }];
  }).sort((left, right) => left.since.localeCompare(right.since)), [agents, conversationId, healthByAgentId]);
  const ticking = pending.length > 0;
  useEffect(() => {
    if (!ticking) { setOpen(false); return; }
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  const summary = pending.length === 1 ? `${pending[0]!.name} is working` : `${pending.length} agents are working`;
  useLayoutEffect(() => {
    const container = containerRef.current, label = labelRef.current, elapsed = elapsedRef.current;
    if (!container || !label || !elapsed) return;
    const names = pending.map(row => row.name);
    const fit = () => {
      // Measure in the pill so its actual font, icon, and timer set the available width.
      const text = label.firstChild;
      if (!(text instanceof Text)) return;
      const previous = text.data;
      let fitted = summary;
      for (let count = names.length; count > 0; count -= 1) {
        const extra = count < names.length ? ` +${names.length - count}` : "";
        const candidate = `${names.slice(0, count).join(", ")}${extra} are working`;
        text.data = candidate;
        if (label.scrollWidth <= label.clientWidth) {
          fitted = candidate;
          break;
        }
      }
      text.data = previous;
      setFittedSummary(fitted);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    observer.observe(elapsed);
    document.fonts.addEventListener("loadingdone", fit);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", fit);
    };
  }, [pending, summary]);
  const workingLabel = pending.length > 1 ? fittedSummary ?? summary : summary;
  const announcement = pending.length ? summary : "No agents are working";
  return <>
    <Box role="status" aria-live="polite" aria-atomic="true"
      sx={{ position: "absolute", width: "1px", height: "1px", p: 0, m: "-1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 }}>{announcement}</Box>
    {pending.length ? <Box ref={containerRef} sx={{ containerType: "inline-size" }}>
      <ChatLiveBanner singleLine>
        <Tooltip describeChild open={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)} disableTouchListener
          slotProps={{ tooltip: { sx: { maxWidth: "min(360px, calc(100vw - 32px))", p: 1 } } }}
          title={<Box ref={detailsRef} tabIndex={0} onKeyDown={event => { if (event.key === "Escape") triggerRef.current?.focus(); }}
            sx={{ maxHeight: "min(320px, 50vh)", overflowY: "auto", overflowWrap: "anywhere" }}>
            {pending.map(({ agentId, name, since }) => <Box key={agentId} sx={{ display: "flex", alignItems: "baseline", gap: 0.5, py: 0.25 }}>
              <InfoOutlinedIcon color="info" sx={{ fontSize: 14, flexShrink: 0, alignSelf: "flex-start", mt: 0.25 }} />
              <Box component="span" sx={{ minWidth: 0 }}>{name} — Working · {formatExecutionElapsed(since, now)}</Box>
            </Box>)}
          </Box>}>
          <ButtonBase ref={triggerRef} aria-label={workingLabel} aria-expanded={open} onClick={() => setOpen(true)}
            onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); detailsRef.current?.focus(); } }}
            sx={{ minWidth: 0, maxWidth: "100%", color: "inherit", font: "inherit", pointerEvents: "auto", borderRadius: 1,
              "&.Mui-focusVisible": { outline: "2px solid", outlineColor: "info.main", outlineOffset: 2 } }}>
            {pending.length === 1 ? <>
              <Box component="span" sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pending[0]!.name}</Box>
              <Box component="span" sx={{ flexShrink: 0, whiteSpace: "pre" }}>{" is working"}</Box>
            </> : <Box component="span" ref={labelRef} sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "pre" }}>{workingLabel}</Box>}
            <Box component="span" ref={elapsedRef} aria-hidden="true" sx={{ ml: 0.75, flexShrink: 0, fontVariantNumeric: "tabular-nums", "@container (max-width: 260px)": { display: "none" } }}>
              · {formatExecutionElapsed(pending[0]!.since, now)}
            </Box>
          </ButtonBase>
        </Tooltip>
      </ChatLiveBanner>
    </Box> : null}
  </>;
}
