import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type {
  AgentDetailDto,
  AgentDto,
  ConversationDto,
  EngineDto,
  ProjectEngineCapabilitiesDto,
} from "@ponderosa/core";
import type { Dispatch, SetStateAction } from "react";
import type { RuntimeControlState } from "../conversationEngine";
import { conversationDisplayTitle } from "../conversationLabels";
import { ComposerRuntimeSelector } from "./ComposerRuntimeSelector";
import { eligibleOrganizationParents } from "./AgentDetail.helpers";

type StateSetter<T> = Dispatch<SetStateAction<T>>;

interface StringMutation {
  isError: boolean;
  isPending: boolean;
  error: unknown;
  mutate(value: string): void;
}

interface VoidMutation {
  isError: boolean;
  isPending: boolean;
  error: unknown;
  mutate(): void;
}

function AgentRuntimeControls({
  engine,
  engineCapability,
  model,
  models,
  effort,
  efforts,
  selectedRuntime,
}: {
  engine?: EngineDto;
  engineCapability?: ProjectEngineCapabilitiesDto;
  model: string;
  models: RuntimeControlState["models"];
  effort: string;
  efforts: RuntimeControlState["efforts"];
  selectedRuntime: {
    selectModel(nextModel: string): void;
    selectEffort(nextEffort: string): void;
  };
}): JSX.Element {
  return (
    <ComposerRuntimeSelector
      engine={engine?.id ?? ""}
      engines={engine ? [{ id: engine.id, label: engine.displayName }] : []}
      engineLocked
      model={model}
      models={models}
      resolvedModel={
        engineCapability?.selectedModel === model
          ? engineCapability.model
          : undefined
      }
      effort={effort}
      efforts={efforts}
      onModelChange={(nextModel) => {
        selectedRuntime.selectModel(nextModel);
      }}
      onEffortChange={(nextEffort) => {
        selectedRuntime.selectEffort(nextEffort);
      }}
    />
  );
}

function AgentRenameDialog({
  renameOpen,
  setRenameOpen,
  renameValue,
  setRenameValue,
  rename,
}: {
  renameOpen: boolean;
  setRenameOpen: StateSetter<boolean>;
  renameValue: string;
  setRenameValue: StateSetter<string>;
  rename: StringMutation;
}): JSX.Element {
  return (
    <Dialog
      open={renameOpen}
      onClose={() => setRenameOpen(false)}
      fullWidth
      maxWidth="xs"
    >
      <DialogTitle>Rename agent</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          value={renameValue}
          onChange={event => setRenameValue(event.target.value)}
          helperText="Spaces are supported; tag multi-word names with hyphens (for example, #Grand-Teton)."
          sx={{ mt: 1 }}
        />
        {rename.isError ? (
          <Alert severity="error" sx={{ mt: 1 }}>
            {String(rename.error)}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button
          onClick={() => setRenameOpen(false)}
          disabled={rename.isPending}
        >
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={!renameValue.trim() || rename.isPending}
          onClick={() => rename.mutate(renameValue.trim())}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function AgentMembershipDialog({
  membershipOpen,
  setMembershipOpen,
  membershipIds,
  setMembershipIds,
  conversations,
  primaryConversationId,
  setPrimaryConversationId,
  updateMemberships,
}: {
  membershipOpen: boolean;
  setMembershipOpen: StateSetter<boolean>;
  membershipIds: string[];
  setMembershipIds: StateSetter<string[]>;
  conversations: ConversationDto[];
  primaryConversationId: string;
  setPrimaryConversationId: StateSetter<string>;
  updateMemberships: VoidMutation;
}): JSX.Element {
  return (
    <Dialog
      open={membershipOpen}
      onClose={() => setMembershipOpen(false)}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>Project chat membership</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <FormControl fullWidth>
            <InputLabel id="agent-memberships-label">
              Project chats
            </InputLabel>
            <Select
              labelId="agent-memberships-label"
              multiple
              value={membershipIds}
              label="Project chats"
              renderValue={selected =>
                selected
                  .map(id => {
                    const chat = conversations.find(
                      candidate => candidate.id === id,
                    );
                    return chat
                      ? conversationDisplayTitle(chat, conversations)
                      : id;
                  })
                  .join(", ")
              }
              onChange={event => {
                const ids =
                  typeof event.target.value === "string"
                    ? event.target.value.split(",")
                    : event.target.value;
                setMembershipIds(ids);
                if (!ids.includes(primaryConversationId))
                  setPrimaryConversationId(ids[0] ?? "");
              }}
            >
              {conversations
                .filter(
                  chat => !chat.archived || membershipIds.includes(chat.id),
                )
                .map(chat => (
                  <MenuItem key={chat.id} value={chat.id}>
                    <Checkbox checked={membershipIds.includes(chat.id)} />
                    <ListItemText
                      primary={conversationDisplayTitle(chat, conversations)}
                      secondary={chat.archived ? "Archived" : undefined}
                    />
                  </MenuItem>
                ))}
            </Select>
          </FormControl>
          <FormControl fullWidth disabled={membershipIds.length === 0}>
            <InputLabel id="agent-primary-chat-label">Home chat</InputLabel>
            <Select
              labelId="agent-primary-chat-label"
              value={primaryConversationId}
              label="Home chat"
              onChange={event => setPrimaryConversationId(event.target.value)}
            >
              {membershipIds.map(id => {
                const chat = conversations.find(
                  candidate => candidate.id === id,
                );
                return (
                  <MenuItem key={id} value={id}>
                    {chat
                      ? conversationDisplayTitle(chat, conversations)
                      : id}
                  </MenuItem>
                );
              })}
            </Select>
          </FormControl>
          <Typography variant="body2" color="text.secondary">
            The home chat controls default routing and shared organizational
            context. Every membership uses this agent's single session and
            history.
          </Typography>
          {updateMemberships.isError ? (
            <Alert severity="error">{String(updateMemberships.error)}</Alert>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setMembershipOpen(false)}>Cancel</Button>
        <Button
          variant="contained"
          disabled={
            updateMemberships.isPending ||
            (membershipIds.length > 0 && !primaryConversationId)
          }
          onClick={() => updateMemberships.mutate()}
        >
          Save Membership
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function AgentOrganizationDialog({
  organizationOpen,
  setOrganizationOpen,
  organizationParentId,
  setOrganizationParentId,
  detail,
  agents,
  updateOrganization,
}: {
  organizationOpen: boolean;
  setOrganizationOpen: StateSetter<boolean>;
  organizationParentId: string;
  setOrganizationParentId: StateSetter<string>;
  detail: AgentDetailDto;
  agents: AgentDto[];
  updateOrganization: VoidMutation;
}): JSX.Element {
  return (
    <Dialog
      open={organizationOpen}
      onClose={() => setOrganizationOpen(false)}
      fullWidth
      maxWidth="xs"
    >
      <DialogTitle>Agent organization</DialogTitle>
      <DialogContent>
        <FormControl fullWidth sx={{ mt: 1 }}>
          <InputLabel id="agent-organizational-parent-label">
            Delegated under
          </InputLabel>
          <Select
            labelId="agent-organizational-parent-label"
            value={organizationParentId}
            label="Delegated under"
            onChange={event => setOrganizationParentId(event.target.value)}
          >
            <MenuItem value="">Top Level</MenuItem>
            {eligibleOrganizationParents(detail.agent, agents).map(
              candidate => (
                <MenuItem key={candidate.id} value={candidate.id}>
                  {candidate.title}
                </MenuItem>
              ),
            )}
          </Select>
        </FormControl>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
          This changes which Agent delegates work to this Agent. Its Run and
          message history remain attached to the same Agent.
        </Typography>
        {updateOrganization.isError ? (
          <Alert severity="error" sx={{ mt: 1 }}>
            {String(updateOrganization.error)}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button
          onClick={() => setOrganizationOpen(false)}
          disabled={updateOrganization.isPending}
        >
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={updateOrganization.isPending}
          onClick={() => updateOrganization.mutate()}
        >
          Save Organization
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export {
  AgentMembershipDialog,
  AgentOrganizationDialog,
  AgentRenameDialog,
  AgentRuntimeControls,
};
