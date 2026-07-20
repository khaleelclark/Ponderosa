import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import TimelineIcon from "@mui/icons-material/Timeline";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Stack,
  Typography,
} from "@mui/material";
import type { AgentDto, AgentHealthDto, ArtifactDto, ProjectDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { TokenUsageButton } from "./TokenUsageButton";
import { artifactDisplayLabel } from "./panes";

const attentionAgentStates = new Set(["blocked", "failed", "interrupted", "stalled"]);

export function ProjectOverview({
  project,
  agents,
  healthByAgentId,
  importantArtifacts,
  onOpenAgentWork,
  onOpenProjectFiles,
  onOpenImportantArtifact,
}: {
  project: ProjectDto;
  agents: AgentDto[];
  healthByAgentId: Map<string, AgentHealthDto>;
  importantArtifacts: ArtifactDto[];
  onOpenAgentWork(): void;
  onOpenProjectFiles(): void;
  onOpenImportantArtifact(artifact: ArtifactDto): void;
}): JSX.Element {
  const work = useQuery({
    queryKey: ["agent-work", project.id, "", "", "overview"],
    queryFn: () => api.getAgentWork(project.id, { limit: 120 }),
    staleTime: 10_000,
  });
  const decisions = useQuery({
    queryKey: ["decisions", "project", project.id],
    queryFn: () => api.listDecisions({ projectId: project.id, status: "pending" }),
    staleTime: 10_000,
  });
  const activeAgents = agents.filter((agent) => {
    const status = healthByAgentId.get(agent.id)?.status;
    return status === "running" || status === "compacting";
  });
  const attentionAgents = agents.filter((agent) => attentionAgentStates.has(healthByAgentId.get(agent.id)?.status ?? ""));
  const activeWork = (work.data?.traces ?? []).filter((trace) => trace.state === "active");
  const attentionWork = (work.data?.traces ?? []).filter((trace) => trace.state === "attention");
  const importantOutputs = importantArtifacts
    .filter((artifact) => artifact.pinned || artifact.visibility === "published")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 3);
  const pendingDecisionCount = decisions.data?.length ?? 0;
  const attentionTotal = attentionWork.length + pendingDecisionCount + attentionAgents.length;

  return <Accordion defaultExpanded disableGutters variant="outlined" sx={{ mb: 1.5, borderRadius: "10px !important", "&:before": { display: "none" } }}>
    <AccordionSummary expandIcon={<ExpandMoreIcon />} aria-controls="project-overview-content">
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ alignItems: "center", width: "100%", minWidth: 0 }}>
        <Typography variant="subtitle1" fontWeight={800} sx={{ flex: 1 }}>Project overview</Typography>
        <Chip size="small" color={activeAgents.length ? "info" : "default"} label={`${activeAgents.length} active`} />
        <Chip size="small" color={attentionTotal ? "warning" : "default"} label={`${attentionTotal} need attention`} />
      </Stack>
    </AccordionSummary>
    <AccordionDetails id="project-overview-content" sx={{ pt: 0 }}>
      <Stack spacing={1.25}>
        <Box>
          <Typography variant="overline" color="text.secondary">Purpose and constraints</Typography>
          {project.instructions?.trim()
            ? <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", maxHeight: 220, overflowY: "auto" }}>{project.instructions.trim()}</Typography>
            : <Typography variant="body2" color="text.secondary">No Project instructions have been set. Project history remains canonical, but the current purpose is not stated as a rule.</Typography>}
        </Box>
        <Divider />
        <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="overline" color="text.secondary">Attention</Typography>
            {attentionTotal === 0 ? <Typography variant="body2" color="text.secondary">Nothing currently needs attention.</Typography> : <Stack spacing={0.35}>
              {pendingDecisionCount ? <Typography variant="body2">{pendingDecisionCount} pending {pendingDecisionCount === 1 ? "Decision" : "Decisions"}</Typography> : null}
              {attentionWork.length ? <Typography variant="body2">{attentionWork.length} work {attentionWork.length === 1 ? "trace" : "traces"} need attention</Typography> : null}
              {attentionAgents.length ? <Typography variant="body2">{attentionAgents.length} {attentionAgents.length === 1 ? "Agent is" : "Agents are"} blocked, failed, or interrupted</Typography> : null}
            </Stack>}
            <Button size="small" startIcon={<TimelineIcon />} onClick={onOpenAgentWork} sx={{ mt: 0.5 }}>Open Agent Work</Button>
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="overline" color="text.secondary">Current activity</Typography>
            {activeWork.length ? <Stack spacing={0.35}>{activeWork.slice(0, 3).map((trace) => <Typography key={trace.id} variant="body2" noWrap>{trace.title}</Typography>)}</Stack>
              : <Typography variant="body2" color="text.secondary">No coordinated work is active.</Typography>}
            {activeWork.length > 3 ? <Typography variant="caption" color="text.secondary">+{activeWork.length - 3} more active work traces</Typography> : null}
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="overline" color="text.secondary">Important outputs</Typography>
            {importantOutputs.length ? <Stack spacing={0.15}>{importantOutputs.map((artifact) => <Button key={artifact.id} size="small" color="inherit" onClick={() => onOpenImportantArtifact(artifact)} sx={{ justifyContent: "flex-start", px: 0, minWidth: 0 }}><Typography variant="body2" noWrap>{artifactDisplayLabel(artifact)}</Typography></Button>)}</Stack>
              : <Typography variant="body2" color="text.secondary">No pinned or published outputs yet.</Typography>}
            <Button size="small" startIcon={<FolderOutlinedIcon />} onClick={onOpenProjectFiles} sx={{ mt: 0.5 }}>Files & Results</Button>
          </Box>
        </Stack>
        {work.isError || decisions.isError ? <Alert severity="warning">Some overview details could not be refreshed. Open the linked source view for authoritative state.</Alert> : null}
        <Box><TokenUsageButton scope="project" scopeId={project.id} label="Project" compact /></Box>
      </Stack>
    </AccordionDetails>
  </Accordion>;
}
