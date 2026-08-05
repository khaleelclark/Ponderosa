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
  AgentDto,
  ConversationDto,
  EngineDto,
} from "@ponderosa/core";
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
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
  engines,
  model,
  models,
  effort,
  efforts,
  speed,
  speeds,
  selectedRuntime,
  onEngineChange,
  onModelChange,
  onEffortChange,
}: {
  engine?: EngineDto;
  engines: EngineDto[];
  model: string;
  models: RuntimeControlState["models"];
  effort: string;
  efforts: RuntimeControlState["efforts"];
  speed: string;
  speeds: RuntimeControlState["speeds"];
  selectedRuntime: {
    selectModel(nextModel: string): void;
    selectEffort(nextEffort: string): void;
    selectSpeed(nextSpeed: string): void;
  };
  onEngineChange(nextEngine: string): void;
  onModelChange?(nextModel: string): void;
  onEffortChange?(nextEffort: string): void;
}): JSX.Element {
  return (
    <ComposerRuntimeSelector
      engine={engine?.id ?? ""}
      engines={engines.map(option => ({
        id: option.id,
        label: option.displayName,
        disabled: !option.available || option.enabled === false,
        detail: option.available
          ? option.enabled === false
            ? "Disabled in Settings"
            : undefined
          : option.authenticated
            ? "Access unavailable"
            : "Signed out",
      }))}
      model={model}
      models={models}
      effort={effort}
      efforts={efforts}
      speed={speed}
      speeds={speeds}
      onEngineChange={onEngineChange}
      onModelChange={nextModel => {
        (onModelChange ?? selectedRuntime.selectModel)(nextModel);
      }}
      onEffortChange={nextEffort => {
        (onEffortChange ?? selectedRuntime.selectEffort)(nextEffort);
      }}
      onSpeedChange={(nextSpeed) => {
        selectedRuntime.selectSpeed(nextSpeed);
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
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (rename.isError) inputRef.current?.focus();
  }, [rename.isError]);

  const submit = () => {
    const name = renameValue.trim();
    if (!name || rename.isPending) return;
    rename.mutate(name);
  };

  return (
    <Dialog
      open={renameOpen}
      onClose={() => {
        if (!rename.isPending) setRenameOpen(false);
      }}
      fullWidth
      maxWidth="xs"
    >
      <form
        onSubmit={event => {
          event.preventDefault();
          submit();
        }}
      >
        <DialogTitle>Rename agent</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            inputRef={inputRef}
            label="Agent name"
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
            type="submit"
            variant="contained"
            disabled={!renameValue.trim() || rename.isPending}
          >
            Save
          </Button>
        </DialogActions>
      </form>
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
          {updateMemberships.isPending ? "Saving…" : "Save Membership"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function AgentOrganizationDialog({
  open,
  onClose,
  organizationParentId,
  setOrganizationParentId,
  agent,
  agents,
  updateOrganization,
}: {
  open: boolean;
  onClose(): void;
  organizationParentId: string;
  setOrganizationParentId: StateSetter<string>;
  agent: AgentDto;
  agents: AgentDto[];
  updateOrganization: VoidMutation;
}): JSX.Element {
  return (
    <Dialog
      open={open}
      onClose={onClose}
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
            {eligibleOrganizationParents(agent, agents).map(
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
          onClick={onClose}
          disabled={updateOrganization.isPending}
        >
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={updateOrganization.isPending}
          onClick={() => updateOrganization.mutate()}
        >
          {updateOrganization.isPending ? "Saving…" : "Save Organization"}
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
