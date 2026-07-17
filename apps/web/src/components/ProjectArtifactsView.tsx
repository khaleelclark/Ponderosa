import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import SearchIcon from "@mui/icons-material/Search";
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  InputAdornment,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { AgentDetailDto, AgentDto, ArtifactDto } from "@ponderosa/core";
import { useMemo, useState } from "react";
import { artifactDisplayLabel } from "./panes";

interface ProjectArtifactRecord {
  agent: AgentDto;
  artifact: ArtifactDto;
}

export function ProjectArtifactsView({
  agents,
  detailByAgentId,
  onOpenArtifact,
}: {
  agents: AgentDto[];
  detailByAgentId: Map<string, AgentDetailDto | undefined>;
  onOpenArtifact(agentId: string, artifactId: string): void;
}): JSX.Element {
  const [filter, setFilter] = useState("");
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const records = useMemo(() => agents.flatMap((agent) =>
    (detailByAgentId.get(agent.id)?.artifacts ?? []).map((artifact) => ({ agent, artifact }))), [agents, detailByAgentId]);
  const filtered = useMemo(() => records.filter(({ agent, artifact }) => !normalizedFilter || [
    agent.title,
    artifactDisplayLabel(artifact),
    artifact.path,
    artifact.summary,
    artifact.kind,
  ].filter(Boolean).join(" ").toLocaleLowerCase().includes(normalizedFilter)), [records, normalizedFilter]);
  const loading = agents.some((agent) => !detailByAgentId.has(agent.id) || detailByAgentId.get(agent.id) === undefined);

  return <Box sx={{ minHeight: 0, minWidth: 0, overflowY: "auto", p: { xs: 1.5, sm: 3 } }}>
    <Stack spacing={1.5} sx={{ maxWidth: 1040 }}>
      <Box>
        <Typography variant="h5" component="h2" fontWeight={800}>Project files</Typography>
        <Typography variant="body2" color="text.secondary">Artifacts, generated files, logs, and results produced by this project’s agents.</Typography>
      </Box>
      <TextField
        size="small"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Search files, results, or agents"
        inputProps={{ "aria-label": "Search project files" }}
        InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
        sx={{ maxWidth: 420 }}
      />
      <Typography variant="caption" color="text.secondary">{filtered.length === records.length ? `${records.length} project files` : `${filtered.length} of ${records.length} project files`}</Typography>
      {loading && records.length === 0 ? <Stack direction="row" spacing={1} sx={{ alignItems: "center", py: 2 }}><CircularProgress size={18} /><Typography variant="body2" color="text.secondary">Loading project files…</Typography></Stack> : null}
      {!loading && records.length === 0 ? <Alert severity="info">No project files yet. Agent-created artifacts and generated results will appear here.</Alert> : null}
      {records.length > 0 && filtered.length === 0 ? <Alert severity="info">No project files match “{filter.trim()}”.</Alert> : null}
      <List aria-label="Project files" disablePadding sx={{ display: "grid", gap: 0.75 }}>
        {filtered.map(({ agent, artifact }) => <ListItemButton
          key={`${agent.id}:${artifact.id}`}
          aria-label={`Open ${artifactDisplayLabel(artifact)} from ${agent.title}`}
          onClick={() => onOpenArtifact(agent.id, artifact.id)}
          sx={{ border: 1, borderColor: "divider", borderRadius: 1.5, bgcolor: "background.paper", minWidth: 0, px: 1.5 }}
        >
          <ListItemIcon sx={{ minWidth: 40 }}><Inventory2OutlinedIcon /></ListItemIcon>
          <ListItemText
            primary={artifactDisplayLabel(artifact)}
            secondary={`${agent.title} · ${artifact.path}`}
            primaryTypographyProps={{ fontWeight: 750, noWrap: true }}
            secondaryTypographyProps={{ noWrap: true }}
          />
          <Stack direction="row" spacing={1} sx={{ ml: 1, alignItems: "center", flexShrink: 0 }}>
            <Chip size="small" variant="outlined" label={artifact.kind.replaceAll("_", " ")} />
            <Typography variant="caption" color="text.secondary" sx={{ display: { xs: "none", sm: "block" } }}>{new Date(artifact.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</Typography>
          </Stack>
        </ListItemButton>)}
      </List>
    </Stack>
  </Box>;
}
