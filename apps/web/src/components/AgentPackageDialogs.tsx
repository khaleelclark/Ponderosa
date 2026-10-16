import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { AgentDto, ConversationDto } from "@ponderosa/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { createClientId } from "../clientId";
import { queryKeys } from "../queryKeys";
import { useQueryClient } from "@tanstack/react-query";
import { ConfirmDialog } from "./ConfirmationDialogs";
import { agentBelongsToConversation } from "../agents";

import { ChatInstructionsImportChoice, chatInstructionsResolution, type ChatInstructionsAction } from "./ChatInstructionsImportChoice";

type PackageMode = "template" | "full";

function selectedAgents(source: AgentDto, agents: AgentDto[], organization: boolean): AgentDto[] {
  if (!organization) return [source];
  const children = new Map<string, AgentDto[]>();
  for (const agent of agents) {
    if (!agent.managerAgentId || agent.projectId !== source.projectId) continue;
    const siblings = children.get(agent.managerAgentId) ?? [];
    siblings.push(agent);
    children.set(agent.managerAgentId, siblings);
  }
  const included = new Map([[source.id, source]]);
  const pending = [source.id];
  while (pending.length) {
    for (const child of children.get(pending.pop()!) ?? []) {
      if (included.has(child.id)) continue;
      included.set(child.id, child);
      pending.push(child.id);
    }
  }
  return [...included.values()];
}

function PackageChoices({
  organization,
  mode,
  agentCount,
  onOrganizationChange,
  onModeChange,
}: {
  organization: boolean;
  mode: PackageMode;
  agentCount: number;
  onOrganizationChange(value: boolean): void;
  onModeChange(value: PackageMode): void;
}): JSX.Element {
  return <Stack spacing={2} sx={{ pt: 1 }}>
    <FormControl fullWidth size="small">
      <InputLabel id="agent-package-scope-label">Scope</InputLabel>
      <Select labelId="agent-package-scope-label" label="Scope" value={organization ? "organization" : "agent"}
        onChange={event => onOrganizationChange(event.target.value === "organization")}>
        <MenuItem value="agent">This Agent</MenuItem>
        <MenuItem value="organization">This Agent and descendants</MenuItem>
      </Select>
    </FormControl>
    <FormControl fullWidth size="small">
      <InputLabel id="agent-package-contents-label">Contents</InputLabel>
      <Select labelId="agent-package-contents-label" label="Contents" value={mode}
        onChange={event => onModeChange(event.target.value as PackageMode)}>
        <MenuItem value="template">Setup only</MenuItem>
        <MenuItem value="full">Setup, private history, and managed artifacts</MenuItem>
      </Select>
    </FormControl>
    <Typography variant="body2" color="text.secondary">
      {agentCount} Agent{agentCount === 1 ? "" : "s"} selected. {mode === "template"
        ? "Setup only excludes history and artifacts."
        : "Full packages include available Agent history, managed artifacts, and project instructions."}
      {" "}Credentials are not included.
    </Typography>
  </Stack>;
}

export function AgentPackageExportDialog({
  open,
  source,
  agents,
  initialOrganization = false,
  onClose,
  onCopy,
  onDownload,
}: {
  open: boolean;
  source: AgentDto;
  agents: AgentDto[];
  initialOrganization?: boolean;
  onClose(): void;
  onCopy(mode: PackageMode, organization: boolean): Promise<void>;
  onDownload(mode: PackageMode, organization: boolean): void;
}): JSX.Element {
  const [organization, setOrganization] = useState(initialOrganization);
  const [mode, setMode] = useState<PackageMode>("template");
  const [copying, setCopying] = useState(false);
  useEffect(() => {
    if (open) { setOrganization(initialOrganization); setMode("template"); }
  }, [open, source.id, initialOrganization]);
  const agentCount = selectedAgents(source, agents, organization).length;
  return <Dialog open={open} onClose={copying ? undefined : onClose} fullWidth maxWidth="sm" aria-busy={copying || undefined}>
    <DialogTitle>Export Agent package</DialogTitle>
    <DialogContent>
      <Typography variant="body2" color="text.secondary">Choose what to export from {source.title}.</Typography>
      <PackageChoices organization={organization} mode={mode} agentCount={agentCount}
        onOrganizationChange={setOrganization} onModeChange={setMode} />
    </DialogContent>
    <DialogActions sx={{ flexWrap: "wrap", p: 2 }}>
      <Button onClick={onClose} disabled={copying}>Close</Button>
      <Button startIcon={<ContentCopyOutlinedIcon />} disabled={copying} onClick={async () => {
        setCopying(true);
        try { await onCopy(mode, organization); } finally { setCopying(false); }
      }}>{copying ? "Copying…" : "Copy JSON"}</Button>
      <Button variant="contained" startIcon={<DownloadOutlinedIcon />} disabled={copying}
        onClick={() => onDownload(mode, organization)}>Download JSON</Button>
    </DialogActions>
  </Dialog>;
}

export function AgentDuplicateDialog({
  open,
  source,
  agents,
  conversations,
  initialConversationId,
  onClose,
  onCreated,
}: {
  open: boolean;
  source: AgentDto;
  agents: AgentDto[];
  conversations: ConversationDto[];
  initialConversationId?: string;
  onClose(): void;
  onCreated(agentId: string): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const availableChats = conversations.filter(chat => !chat.deletedAt);
  const [organization, setOrganization] = useState(false);
  const [mode, setMode] = useState<PackageMode>("template");
  const [conversationId, setConversationId] = useState("");
  const [rootTitle, setRootTitle] = useState("");
  const [instructionsAction, setInstructionsAction] = useState<ChatInstructionsAction>("");
  const sourceInstructions = mode === "full" ? conversations.find(chat => chat.id === source.conversationId)?.instructions : undefined;
  const destinationInstructions = conversations.find(chat => chat.id === conversationId)?.instructions ?? "";
  const instructionsConflict = Boolean(sourceInstructions && destinationInstructions && sourceInstructions !== destinationInstructions);
  useEffect(() => { setInstructionsAction(""); }, [mode, sourceInstructions, destinationInstructions, conversationId]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const attempt = useRef<{ signature: string; id: string }>();
  useEffect(() => {
    if (!open) { attempt.current = undefined; return; }
    setOrganization(false);
    setMode("template");
    setConversationId(availableChats.find(chat => chat.id === initialConversationId)?.id
      ?? availableChats.find(chat => chat.id === source.conversationId)?.id
      ?? availableChats[0]?.id ?? "");
    setRootTitle(`${source.title.trim().slice(0, 75)} copy`);
    setAcknowledged(false);
    setError(undefined);
  }, [open, source.id, initialConversationId]);
  const included = useMemo(() => selectedAgents(source, agents, organization), [source, agents, organization]);
  const elevated = included.some(agent =>
    agent.managementPermissions.allowAutomaticDescendantDeletion
    || agent.managementPermissions.allowAutomaticDescendantReorganization,
  );
  const normalizedTitle = rootTitle.trim().toLocaleLowerCase();
  const nameCollision = normalizedTitle && agents.some(agent =>
    agentBelongsToConversation(agent, conversationId)
    && agent.title.trim().toLocaleLowerCase() === normalizedTitle,
  );
  const duplicate = async () => {
    const signature = JSON.stringify([source.id, conversationId, rootTitle.trim(), mode, organization, acknowledged, instructionsAction, destinationInstructions]);
    if (attempt.current?.signature !== signature) attempt.current = { signature, id: createClientId() };
    setPending(true);
    setError(undefined);
    try {
      const result = await api.copyAgent(source.projectId, {
        sourceAgentId: source.id,
        conversationId,
        rootTitle: rootTitle.trim(),
        mode,
        organization,
        chatInstructionsResolution: await chatInstructionsResolution(instructionsAction, destinationInstructions),
        ...(elevated ? { acknowledgeElevatedManagementPermissions: acknowledged } : {}),
      }, attempt.current.id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.project(source.projectId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDirectory.kind("agent") });
      onClose();
      onCreated(result.rootAgentId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The Agent could not be duplicated.");
    } finally {
      setPending(false);
    }
  };
  return <ConfirmDialog open={open} title={organization ? "Duplicate organization" : "Duplicate Agent"}
    confirmLabel={organization ? "Duplicate organization" : "Duplicate Agent"}
    pendingLabel="Duplicating…" pending={pending} error={error}
    confirmDisabled={(instructionsConflict && !instructionsAction) || !conversationId || !rootTitle.trim() || rootTitle.trim().length > 80 || (elevated && !acknowledged)} onCancel={onClose}
    onConfirm={() => void duplicate()}>
    <Stack spacing={2} sx={{ pt: 1 }}>
      <Typography variant="body2" color="text.secondary">Source: {source.title}</Typography>
      <PackageChoices organization={organization} mode={mode} agentCount={included.length}
        onOrganizationChange={setOrganization} onModeChange={setMode} />
      <FormControl fullWidth size="small">
        <InputLabel id="duplicate-agent-chat-label">Destination chat</InputLabel>
        <Select labelId="duplicate-agent-chat-label" label="Destination chat" value={conversationId}
          onChange={event => setConversationId(event.target.value)}>
          {availableChats.map(chat => <MenuItem key={chat.id} value={chat.id}>{chat.title}</MenuItem>)}
        </Select>
      </FormControl>
      <ChatInstructionsImportChoice source={sourceInstructions} destination={destinationInstructions}
        value={instructionsAction} onChange={setInstructionsAction} />
      <TextField label="New root Agent name" value={rootTitle} onChange={event => setRootTitle(event.target.value)}
        inputProps={{ maxLength: 80 }} fullWidth size="small"
        error={Boolean(rootTitle && !rootTitle.trim())}
        helperText="Descendant names stay the same." />
      {nameCollision ? <Alert severity="warning">
        An Agent named “{rootTitle.trim()}” already exists in this chat. The duplicate will be separate; no existing Agent is replaced.
      </Alert> : null}
      {elevated ? <Alert severity="warning">
        This selection contains elevated organization permissions.
        <FormControlLabel control={<Checkbox checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />}
          label="Keep these elevated permissions in the duplicate" />
      </Alert> : null}
      <Typography variant="caption" color="text.secondary">
        Nothing is submitted to an external service.
      </Typography>
    </Stack>
  </ConfirmDialog>;
}
