import { Box, Button, Stack, Typography } from "@mui/material";
import type { MessageDeliveryReceiptDto } from "@ponderosa/core";
import { useId, useLayoutEffect, useRef, useState } from "react";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { AgentMention } from "./ChatMessages";
import { readBrowserStorage, writeBrowserStorage } from "../../browserStorage";

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

function ProgressCard({ receipt, onOpenAgent }: {
  receipt: MessageDeliveryReceiptDto;
  onOpenAgent?(agentId: string): void;
}): JSX.Element {
  const progress = receipt.liveProgress!;
  const storageKey = `ponderosa.live-progress.collapsed.v1.${receipt.targetAgentId}.${receipt.executionId}`;
  const [collapsed, setCollapsed] = useState(() => readBrowserStorage("sessionStorage", storageKey) === "true");
  const [expandedKey, setExpandedKey] = useState<string>();
  const bodyId = useId();
  const key = `${receipt.injectionId}:${progress.seq}`;
  const expanded = expandedKey === key;
  const activity = progress.activity === "command" ? "running a command" : progress.activity === "browser" ? "using the browser"
    : progress.activity === "tool" ? "using a tool" : "working";
  return <Box data-live-progress-execution={receipt.executionId}
    sx={{ borderLeft: "2px solid", borderColor: "divider", pl: 1, py: 0.25, minWidth: 0, textAlign: "left" }}>
    <Stack direction="row" alignItems="center" sx={{ minWidth: 0, gap: 0.5 }}>
      {/* Separate buttons avoid nesting a clickable identity inside a disclosure. */}
      <Box title={`#${progress.recipientHandle}`} sx={{ minWidth: 0, maxWidth: "50%", flexShrink: 1, fontSize: 12,
        "& > button, & > span": { display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }}>
        <AgentMention agentId={receipt.targetAgentId} label={progress.recipientHandle} onOpenAgent={onOpenAgent} />
      </Box>
      <Button className="chat-text-navigation" size="small" aria-expanded={!collapsed} aria-controls={bodyId}
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${progress.recipientHandle} progress: ${activity}`}
        onClick={() => {
          setCollapsed(!collapsed);
          writeBrowserStorage("sessionStorage", storageKey, String(!collapsed));
        }}
        sx={{ color: "text.secondary", flex: 1, minWidth: 0, minHeight: 44, p: 0.5, justifyContent: "space-between", gap: 0.5,
          textTransform: "none", textAlign: "left", fontSize: 12, lineHeight: 1.35 }}>
        <Box component="span" sx={{ minWidth: 0, overflowWrap: "anywhere" }}>is {activity}</Box>
        {collapsed ? <ExpandMoreIcon fontSize="small" sx={{ flexShrink: 0 }} /> : <ExpandLessIcon fontSize="small" sx={{ flexShrink: 0 }} />}
      </Button>
    </Stack>
    <Box id={bodyId} hidden={collapsed}>
      {!collapsed ? <ProgressText text={progress.text} truncated={progress.truncated} expanded={expanded}
        onToggle={() => setExpandedKey(expanded ? undefined : key)} /> : null}
    </Box>
  </Box>;
}

/** An ephemeral read projection, never Communication or proof of understanding. */
export function LiveAgentProgress({ receipts, onOpenAgent }: {
  receipts?: MessageDeliveryReceiptDto[];
  onOpenAgent?(agentId: string): void;
}): JSX.Element | null {
  const updates = receipts?.filter(receipt => receipt.state === "delivered" && receipt.providerAcknowledged &&
    receipt.executionId && receipt.injectionId && receipt.liveProgress);
  if (!updates?.length) return null;
  return <Stack spacing={0.5} sx={{ mt: 0.5, minWidth: 0, maxWidth: "100%" }} aria-label="Live Agent progress">
    {updates.map(receipt => <ProgressCard key={`${receipt.targetAgentId}:${receipt.executionId}`} receipt={receipt} onOpenAgent={onOpenAgent} />)}
  </Stack>;
}
