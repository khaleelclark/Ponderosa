import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import CancelOutlinedIcon from "@mui/icons-material/CancelOutlined";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { Alert, Box, Button, Chip, Collapse, IconButton, Stack, Typography } from "@mui/material";
import { useState } from "react";
import {
  buildAssignmentTree,
  type AssignmentStatus,
  type AssignmentStore,
  type AssignmentTreeNode,
} from "../assignments";
import type { AssignmentDto } from "@ponderosa/core";

const statusColor = (status: AssignmentStatus): "default" | "info" | "success" | "error" => {
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
  node: AssignmentTreeNode;
  store: AssignmentStore;
  cancelling: ReadonlySet<string>;
  onCancel(run: AssignmentDto): void;
  onOpenAgent(agentId: string): void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(node.status === "running" || node.status === "awaiting_disposition");
  const detailId = `assignment-detail-${node.id}`;
  const canExpand = Boolean(node.taskBriefMarkdown || node.failure || node.parentWake);

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
          aria-label={`${expanded ? "Collapse" : "Expand"} ${node.title}`}
          aria-controls={canExpand ? detailId : undefined}
          onClick={() => {
            setExpanded((value) => !value);
          }}
        >
          {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        </IconButton>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="body2" fontWeight={700} noWrap>{node.title}</Typography>
          <Typography variant="caption" color="text.secondary">Depth {node.depth}</Typography>
        </Box>
        <Chip size="small" label={node.status} color={statusColor(node.status)} />
        {node.canCancel && (node.status === "queued" || node.status === "running" || node.status === "awaiting_disposition") ? (
          <IconButton
            size="small"
            color="warning"
            disabled={cancelling.has(node.id)}
            aria-label={`Cancel ${node.title} and descendants`}
            onClick={() => onCancel(node)}
          >
            <CancelOutlinedIcon />
          </IconButton>
        ) : null}
      </Stack>
      <Collapse in={expanded} unmountOnExit>
        <Stack id={detailId} spacing={1} sx={{ p: 1.25, bgcolor: "action.hover" }}>
          <Typography component="pre" variant="body2" sx={{ whiteSpace: "pre-wrap", m: 0 }}>{node.taskBriefMarkdown}</Typography>
          {node.status === "awaiting_disposition" ? <Alert severity="info">Runtime turn finished; awaiting an explicit objective disposition.</Alert> : null}
          {node.disposition?.message ? <Alert severity={node.status === "blocked" ? "warning" : "success"}>{node.disposition.message}</Alert> : null}
          {node.parentWake ? (
            <Typography variant="caption" color={node.parentWake.status === "failed" ? "error.main" : "text.secondary"}>
              Parent wake: {node.parentWake.status}
            </Typography>
          ) : null}
          {node.failure ? <Alert severity="error">{node.failure.message}</Alert> : null}
          {node.childAgentId ? (
            <Button size="small" onClick={() => onOpenAgent(node.childAgentId)}>
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

export function AssignmentTreePanel({
  store,
  cancelling = new Set(),
  onCancel,
  onOpenAgent,
}: {
  store: AssignmentStore;
  cancelling?: ReadonlySet<string>;
  onCancel(run: AssignmentDto): void;
  onOpenAgent(agentId: string): void;
}): JSX.Element | null {
  const tree = buildAssignmentTree(store.assignments.values());
  const [open, setOpen] = useState(true);
  if (!tree.length) return null;

  return (
    <Box component="section" aria-labelledby="assignment-tree-heading" sx={{ border: 1, borderColor: "divider", borderRadius: 2 }}>
      <Button
        fullWidth
        color="inherit"
        startIcon={<AccountTreeOutlinedIcon />}
        endIcon={open ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        aria-expanded={open}
        aria-controls="assignment-tree"
        onClick={() => setOpen((value) => !value)}
        sx={{ justifyContent: "flex-start", px: 1.5 }}
      >
        <Typography id="assignment-tree-heading" component="span" sx={{ flex: 1, textAlign: "left", fontWeight: 700 }}>
          Assignments ({store.assignments.size})
        </Typography>
      </Button>
      <Collapse in={open}>
        <Box id="assignment-tree" role="tree" aria-label="Assignment lineage" sx={{ px: 1.25, pb: 1 }}>
          {tree.map((node) => (
          <RunNode key={node.id} node={node} store={store} cancelling={cancelling} onCancel={onCancel} onOpenAgent={onOpenAgent} />
          ))}
        </Box>
      </Collapse>
    </Box>
  );
}
