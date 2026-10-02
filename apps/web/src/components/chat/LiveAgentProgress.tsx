import { Box, Button, Stack, Typography } from "@mui/material";
import type { MessageDeliveryReceiptDto } from "@ponderosa/core";
import { useLayoutEffect, useRef, useState } from "react";
import { AgentMention } from "./ChatMessages";

function ProgressText({ text, truncated, expanded, onToggle }: {
  text: string;
  truncated?: true;
  expanded: boolean;
  onToggle(): void;
}): JSX.Element {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element || expanded) return;
    const measure = () => setClipped(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, truncated, expanded]);
  return <>
    <Typography ref={textRef} variant="body2" sx={{ color: "text.secondary", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
      ...(!expanded ? { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 4, overflow: "hidden" } : {}) }}>
      {text}{truncated ? "…" : ""}
    </Typography>
    {expanded || clipped ? <Button className="chat-text-navigation" size="small" aria-expanded={expanded} onClick={onToggle}
      sx={{ minHeight: 28, py: 0.25 }}>{expanded ? "Collapse update" : "Show full update"}</Button> : null}
  </>;
}

/** An ephemeral read projection, never Communication or proof of understanding. */
export function LiveAgentProgress({ receipts, onOpenAgent }: {
  receipts?: MessageDeliveryReceiptDto[];
  onOpenAgent?(agentId: string): void;
}): JSX.Element | null {
  const [expandedKey, setExpandedKey] = useState<string>();
  const updates = receipts?.filter(receipt => receipt.state === "delivered" && receipt.providerAcknowledged &&
    receipt.executionId && receipt.injectionId && receipt.liveProgress);
  if (!updates?.length) return null;
  return <Stack spacing={0.5} sx={{ mt: 0.5, minWidth: 0, maxWidth: "100%" }} aria-label="Live Agent progress">
    {updates.map(receipt => {
      const progress = receipt.liveProgress!;
      const key = `${receipt.activationId}:${progress.seq}`;
      const expanded = expandedKey === key;
      return <Box key={receipt.activationId} data-live-progress-execution={receipt.executionId}
      sx={{ borderLeft: "2px solid", borderColor: "divider", pl: 1, py: 0.25, minWidth: 0, textAlign: "left" }}>
      <Typography variant="caption" component="div" color="text.secondary">
        <AgentMention agentId={receipt.targetAgentId} label={progress.recipientHandle} onOpenAgent={onOpenAgent} />
        {" · Latest update"}
      </Typography>
      <ProgressText text={progress.text} truncated={progress.truncated} expanded={expanded}
        onToggle={() => setExpandedKey(expanded ? undefined : key)} />
    </Box>;
    })}
  </Stack>;
}
