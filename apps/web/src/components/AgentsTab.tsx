import AddIcon from "@mui/icons-material/Add";
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import type { SelectChangeEvent } from "@mui/material/Select";
import type { MasterChatDto, ThreadDetailDto, ThreadDto } from "@ponderosa/core";
import { useState } from "react";
import {
  agentActivity,
  agentStatusColor,
  agentStatusLabel,
  relativeTime,
  type AgentStatus,
} from "../agents";

type StatusFilter = "all" | "running" | "waiting" | "completed" | "unassigned";

export function AgentsTab({
  agents,
  masterChats,
  statusByAgentId,
  detailByAgentId,
  onOpenAgent,
  onNewAgent,
}: {
  agents: ThreadDto[];
  masterChats: MasterChatDto[];
  statusByAgentId: Map<string, AgentStatus>;
  detailByAgentId: Map<string, ThreadDetailDto | undefined>;
  onOpenAgent(agentId: string): void;
  onNewAgent(): void;
}): JSX.Element {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [masterFilter, setMasterFilter] = useState<string>("all");

  const masterName = (id: string | undefined): string =>
    id ? (masterChats.find((master) => master.id === id)?.title ?? "Unknown master chat") : "Unassigned";

  const filtered = agents.filter((agent) => {
    const status = statusByAgentId.get(agent.id) ?? "idle";
    if (statusFilter === "unassigned" && agent.masterChatId) {
      return false;
    }
    if (statusFilter === "running" && status !== "running") {
      return false;
    }
    if (statusFilter === "waiting" && status !== "waiting") {
      return false;
    }
    if (statusFilter === "completed" && status !== "completed") {
      return false;
    }
    if (masterFilter !== "all" && agent.masterChatId !== masterFilter) {
      return false;
    }
    return true;
  });

  return (
    <Box sx={{ minHeight: 0, display: "grid", gridTemplateRows: "auto auto 1fr" }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "center", px: { xs: 1.5, md: 2 }, py: 1.25, borderBottom: 1, borderColor: "divider" }}
      >
        <Typography variant="h6" sx={{ flex: 1 }}>
          Agents
        </Typography>
        <Button variant="contained" size="small" startIcon={<AddIcon />} onClick={onNewAgent}>
          New Agent
        </Button>
      </Stack>

      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={1}
        sx={{ alignItems: { sm: "center" }, px: { xs: 1.5, md: 2 }, py: 1 }}
      >
        <ToggleButtonGroup
          size="small"
          exclusive
          value={statusFilter}
          onChange={(_event, value: StatusFilter | null) => value && setStatusFilter(value)}
        >
          <ToggleButton value="all">All</ToggleButton>
          <ToggleButton value="running">Running</ToggleButton>
          <ToggleButton value="waiting">Waiting</ToggleButton>
          <ToggleButton value="completed">Completed</ToggleButton>
          <ToggleButton value="unassigned">Unassigned</ToggleButton>
        </ToggleButtonGroup>
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel id="agents-master-filter-label">Master chat</InputLabel>
          <Select
            labelId="agents-master-filter-label"
            label="Master chat"
            value={masterFilter}
            onChange={(event: SelectChangeEvent) => setMasterFilter(event.target.value)}
          >
            <MenuItem value="all">All master chats</MenuItem>
            {masterChats.map((master) => (
              <MenuItem key={master.id} value={master.id}>
                {master.title}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Stack>

      <Box sx={{ minHeight: 0, overflow: "auto", p: { xs: 1.5, md: 2 }, pt: 0 }}>
        {filtered.length === 0 ? (
          <Alert severity="info">No agents match this filter.</Alert>
        ) : (
          <Stack spacing={1.25}>
            {filtered.map((agent) => {
              const status = statusByAgentId.get(agent.id) ?? "idle";
              const activity = agentActivity(detailByAgentId.get(agent.id));
              return (
                <Paper
                  key={agent.id}
                  variant="outlined"
                  sx={{ p: 1.5, cursor: "pointer", "&:hover": { borderColor: "primary.main" } }}
                  onClick={() => onOpenAgent(agent.id)}
                >
                  <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
                    <Typography variant="subtitle1" sx={{ flex: 1, minWidth: 0, fontWeight: 700 }} noWrap>
                      {agent.title}
                    </Typography>
                    <Chip size="small" label={agentStatusLabel(status)} color={agentStatusColor(status)} />
                  </Stack>
                  <Stack
                    direction="row"
                    spacing={1}
                    useFlexGap
                    flexWrap="wrap"
                    sx={{ mt: 0.75, alignItems: "center" }}
                  >
                    <Chip size="small" variant="outlined" label={agent.activeEngine} />
                    <Chip
                      size="small"
                      variant="outlined"
                      color={agent.masterChatId ? "default" : "warning"}
                      label={masterName(agent.masterChatId)}
                    />
                    <Typography variant="caption" color="text.secondary">
                      updated {relativeTime(agent.updatedAt)}
                    </Typography>
                  </Stack>
                  {activity ? (
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ mt: 0.5, overflowWrap: "anywhere" }}
                      noWrap
                    >
                      {activity}
                    </Typography>
                  ) : null}
                </Paper>
              );
            })}
          </Stack>
        )}
      </Box>
    </Box>
  );
}
