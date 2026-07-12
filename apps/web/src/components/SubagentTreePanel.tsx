import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import CancelOutlinedIcon from "@mui/icons-material/CancelOutlined";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { Alert, Box, Button, Chip, Collapse, IconButton, Stack, Typography } from "@mui/material";
import { useState } from "react";
import {
  buildSubagentTree,
  type SubagentStatus,
  type SubagentStore,
  type SubagentTreeNode,
} from "../subagents";
import type { SubagentRunDto } from "@ponderosa/core";

const statusColor = (status: SubagentStatus): "default" | "info" | "success" | "error" => {
  if (status === "running") return "info";
  if (status === "completed") return "success";
  if (status === "failed" || status === "blocked") return "error";
  return "default";
};

function RunNode({
  node,
  store,
  cancelling,
  onCancel,
  onOpenAgent,
}: {
  node: SubagentTreeNode;
  store: SubagentStore;
  cancelling: ReadonlySet<string>;
  onCancel(run: SubagentRunDto): void;
  onOpenAgent(agentId: string): void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(node.status === "running" || node.status === "awaiting_disposition");
  const detailId = `subagent-detail-${node.id}`;
  const canExpand = Boolean(node.delegationSummary || node.failure || node.completionDelivery);

  return (
    <Box role="treeitem" aria-expanded={canExpand ? expanded : undefined} sx={{ ml: node.depth ? 2 : 0 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "center", py: 0.75, borderBottom: 1, borderColor: "divider" }}
      >
        <IconButton
          size="small"
          disabled={!canExpand}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${node.displayLabel}`}
          aria-controls={canExpand ? detailId : undefined}
          onClick={() => {
            setExpanded((value) => !value);
          }}
        >
          {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        </IconButton>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="body2" fontWeight={700} noWrap>{node.displayLabel}</Typography>
          <Typography variant="caption" color="text.secondary">Depth {node.depth}</Typography>
        </Box>
        <Chip size="small" label={node.status} color={statusColor(node.status)} />
        {node.canCancel && (node.status === "queued" || node.status === "running" || node.status === "awaiting_disposition") ? (
          <IconButton
            size="small"
            color="warning"
            disabled={cancelling.has(node.id)}
            aria-label={`Cancel ${node.displayLabel} and descendants`}
            onClick={() => onCancel(node)}
          >
            <CancelOutlinedIcon />
          </IconButton>
        ) : null}
      </Stack>
      <Collapse in={expanded} unmountOnExit>
        <Stack id={detailId} spacing={1} sx={{ p: 1.25, bgcolor: "action.hover" }}>
          {node.delegationSummary ? <Typography variant="body2">{node.delegationSummary}</Typography> : null}
          {node.status === "awaiting_disposition" ? <Alert severity="info">Runtime turn finished; awaiting an explicit objective disposition.</Alert> : null}
          {node.disposition?.message ? <Alert severity={node.status === "blocked" ? "warning" : "success"}>{node.disposition.message}</Alert> : null}
          {node.completionDelivery ? (
            <Typography variant="caption" color={node.completionDelivery.status === "failed" ? "error.main" : "text.secondary"}>
              Parent completion delivery: {node.completionDelivery.status}
            </Typography>
          ) : null}
          {node.failure ? <Alert severity="error">{node.failure.message}</Alert> : null}
          {node.childThreadId ? (
            <Button size="small" onClick={() => onOpenAgent(node.childThreadId!)}>
              Open agent output
            </Button>
          ) : null}
        </Stack>
      </Collapse>
      {node.children.length ? (
        <Box role="group">
          {node.children.map((child) => (
            <RunNode key={child.id} node={child} store={store} cancelling={cancelling} onCancel={onCancel} onOpenAgent={onOpenAgent} />
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

export function SubagentTreePanel({
  store,
  cancelling = new Set(),
  onCancel,
  onOpenAgent,
}: {
  store: SubagentStore;
  cancelling?: ReadonlySet<string>;
  onCancel(run: SubagentRunDto): void;
  onOpenAgent(agentId: string): void;
}): JSX.Element | null {
  const tree = buildSubagentTree(store.runs.values());
  const [open, setOpen] = useState(true);
  if (!tree.length) return null;

  return (
    <Box component="section" aria-labelledby="subagent-tree-heading" sx={{ border: 1, borderColor: "divider", borderRadius: 2 }}>
      <Button
        fullWidth
        color="inherit"
        startIcon={<AccountTreeOutlinedIcon />}
        endIcon={open ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        aria-expanded={open}
        aria-controls="subagent-tree"
        onClick={() => setOpen((value) => !value)}
        sx={{ justifyContent: "flex-start", px: 1.5 }}
      >
        <Typography id="subagent-tree-heading" component="span" sx={{ flex: 1, textAlign: "left", fontWeight: 700 }}>
          Delegated agents ({store.runs.size})
        </Typography>
      </Button>
      <Collapse in={open}>
        <Box id="subagent-tree" role="tree" aria-label="Delegated agent lineage" sx={{ px: 1.25, pb: 1 }}>
          {tree.map((node) => (
          <RunNode key={node.id} node={node} store={store} cancelling={cancelling} onCancel={onCancel} onOpenAgent={onOpenAgent} />
          ))}
        </Box>
      </Collapse>
    </Box>
  );
}
