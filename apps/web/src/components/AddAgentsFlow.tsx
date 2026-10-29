import AddIcon from "@mui/icons-material/Add";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import FileUploadOutlinedIcon from "@mui/icons-material/FileUploadOutlined";
import {
  Alert,
  Autocomplete,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { AgentDto, ConversationDto, EngineDto, ProjectDto } from "@ponderosa/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { queryKeys } from "../queryKeys";
import { AgentDuplicateDialog } from "./AgentPackageDialogs";
import { ImportAgentDialog } from "./ImportAgentDialog";
import { useMutationNotification } from "./MutationNotifications";

type AddStep = "choose" | "import" | "pick-source" | "duplicate";

/** Shared entry point for adding Agents from a Chat or the Agent directory. */
export function AddAgentsFlow({
  open,
  projects = [],
  fixedProjectId,
  initialProjectId,
  initialConversation,
  conversations = [],
  engines,
  onCreate,
  onClose,
  onCreated,
}: {
  open: boolean;
  projects?: ProjectDto[];
  fixedProjectId?: string;
  initialProjectId?: string;
  initialConversation?: ConversationDto;
  conversations?: ConversationDto[];
  engines: EngineDto[];
  onCreate(): void;
  onClose(): void;
  onCreated?(projectId: string, agentId: string): void;
}): JSX.Element {
  const notify = useMutationNotification();
  const [step, setStep] = useState<AddStep>("choose");
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId ?? "");
  const [sourceId, setSourceId] = useState("");
  const sourceProjectId = fixedProjectId ?? selectedProjectId;
  useEffect(() => {
    if (!open) return;
    setStep("choose");
    setSelectedProjectId(initialProjectId ?? (projects.length === 1 ? projects[0]!.id : ""));
    setSourceId("");
  }, [open, initialProjectId, projects.length]);
  const pickingSource = open && (step === "pick-source" || step === "duplicate");
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.project(sourceProjectId),
    queryFn: () => api.listAgents(sourceProjectId),
    enabled: pickingSource && Boolean(sourceProjectId),
  });
  const chatsQuery = useQuery({
    queryKey: queryKeys.conversations.project(sourceProjectId),
    queryFn: () => api.listConversations(sourceProjectId),
    enabled: pickingSource && Boolean(sourceProjectId),
  });
  const agents = agentsQuery.data ?? [];
  const chats = (chatsQuery.data ?? []).filter(chat => !chat.deletedAt);
  const source = agents.find(agent => agent.id === sourceId);
  const chatNames = new Map(chats.map(chat => [chat.id, chat.title]));
  const sourceLabel = (agent: AgentDto) =>
    `${agent.title} · ${chatNames.get(agent.conversationId ?? "") ?? "Unassigned"}`;

  return <>
    <Dialog open={open && step === "choose"} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Add Agents</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ pt: 1 }}>
          <Button variant="outlined" startIcon={<AddIcon />} onClick={() => { onClose(); onCreate(); }}>
            Create new Agent
          </Button>
          <Button variant="outlined" startIcon={<ContentCopyOutlinedIcon />} disabled={!fixedProjectId && !projects.length}
            onClick={() => setStep("pick-source")}>
            Duplicate existing Agent
          </Button>
          <Button variant="outlined" startIcon={<FileUploadOutlinedIcon />} disabled={!fixedProjectId && !projects.length}
            onClick={() => setStep("import")}>
            Import Agent package
          </Button>
          <Typography variant="body2" color="text.secondary">
            Duplicate an Agent or import a JSON package.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Cancel</Button></DialogActions>
    </Dialog>

    <ImportAgentDialog
      open={open && step === "import"}
      projectId={projects.length ? undefined : fixedProjectId}
      projects={projects}
      initialProjectId={selectedProjectId || initialProjectId}
      engines={engines}
      conversations={initialConversation ? [initialConversation] : conversations}
      initialConversationId={initialConversation?.id ?? conversations[0]?.id}
      onClose={onClose}
    />

    <Dialog open={open && step === "pick-source"} onClose={() => setStep("choose")} fullWidth maxWidth="sm">
      <DialogTitle>Duplicate existing Agent</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {!fixedProjectId ? <FormControl fullWidth size="small">
            <InputLabel id="duplicate-source-project-label">Source workspace</InputLabel>
            <Select labelId="duplicate-source-project-label" label="Source workspace" value={selectedProjectId}
              onChange={event => { setSelectedProjectId(event.target.value); setSourceId(""); }}>
              {projects.map(project => <MenuItem key={project.id} value={project.id}>{project.label}</MenuItem>)}
            </Select>
          </FormControl> : null}
          {sourceProjectId ? <Autocomplete<AgentDto>
            options={agents}
            value={source}
            loading={agentsQuery.isFetching || chatsQuery.isFetching}
            getOptionLabel={sourceLabel}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            onChange={(_event, value) => setSourceId(value?.id ?? "")}
            renderInput={params => <TextField {...params} label="Source Agent" size="small" />}
          /> : <Typography variant="body2" color="text.secondary">Choose a source workspace first.</Typography>}
          {agentsQuery.isError || chatsQuery.isError ? <Alert severity="error">
            Could not load Agents or chats from this workspace. <Button size="small" onClick={() => { void agentsQuery.refetch(); void chatsQuery.refetch(); }}>Retry</Button>
          </Alert> : null}
          {sourceProjectId && agentsQuery.isSuccess && agents.length === 0 ? <Alert severity="info">No Agents to duplicate in this workspace.</Alert> : null}
          <Typography variant="body2" color="text.secondary">
            Select an Agent to duplicate.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setStep("choose")}>Back</Button>
        <Button variant="contained" disabled={!source || !chats.length || agentsQuery.isFetching || chatsQuery.isFetching}
          onClick={() => setStep("duplicate")}>Continue</Button>
      </DialogActions>
    </Dialog>

    {source ? <AgentDuplicateDialog
      open={open && step === "duplicate"}
      source={source}
      agents={agents}
      conversations={chats}
      initialConversationId={initialConversation?.projectId === source.projectId ? initialConversation.id : undefined}
      onClose={() => setStep("pick-source")}
      onCreated={agentId => {
        notify({ message: "Agent duplicated.", severity: "success" });
        onClose();
        onCreated?.(source.projectId, agentId);
      }}
    /> : null}
  </>;
}
