import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import CampaignOutlinedIcon from "@mui/icons-material/CampaignOutlined";
import CheckIcon from "@mui/icons-material/Check";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import StopCircleIcon from "@mui/icons-material/StopCircle";
import SubdirectoryArrowRightIcon from "@mui/icons-material/SubdirectoryArrowRight";
import {
  ButtonBase,
  Chip,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { RefObject } from "react";
import { useId, useState } from "react";
import { ComposerAttachment } from "./ComposerAttachment";
import type { DraftUploadStatus } from "./ComposerAttachment";
import type { ComposerProps } from "./Composer.types";

interface ComposerDestinationBarProps {
  clearDestination(handle: string): void;
  destinationError: string | undefined;
  destinationMode: ComposerProps["destinationMode"];
  hasBroadcastDestination: boolean;
  targetRequiredDestinations: Array<{ handle: string }>;
}

export function ComposerDestinationBar({
  clearDestination,
  destinationError,
  destinationMode,
  hasBroadcastDestination,
  targetRequiredDestinations,
}: ComposerDestinationBarProps): JSX.Element | null {
  return destinationMode === "target-required" ? (
    <Stack
      direction="row"
      spacing={0.75}
      useFlexGap
      flexWrap="wrap"
      sx={{ px: 0.25, pb: 0.75, alignItems: "center" }}
    >
      {targetRequiredDestinations.map(destination => (
        <Chip
          key={destination.handle.toLocaleLowerCase()}
          size="small"
          color="primary"
          label={`#${destination.handle}`}
          onDelete={() => clearDestination(destination.handle)}
        />
      ))}
      {hasBroadcastDestination ? (
        <Chip
          size="small"
          color="info"
          icon={<CampaignOutlinedIcon />}
          label="#broadcast"
          onDelete={() => clearDestination("broadcast")}
        />
      ) : null}
      {targetRequiredDestinations.length === 0 &&
      !hasBroadcastDestination ? (
        <Chip size="small" variant="outlined" label="Choose an Agent" />
      ) : null}
      {destinationError ? (
        <Typography variant="caption" color="error.main">
          {destinationError}
        </Typography>
      ) : null}
    </Stack>
  ) : null;
}

interface ComposerProjectDestinationPickerProps {
  clearDestination(handle: string): void;
  continueWith: ComposerProps["continueWith"];
  hasBroadcastDestination: boolean;
  hasEveryoneDestination: boolean;
  inputRef: RefObject<HTMLTextAreaElement>;
  implicitContinueSelected: boolean;
  projectDestinations: Array<{ handle: string }>;
  selectImplicitContinue(selected: boolean): void;
  setDestination(handle: string): void;
}

export function ComposerProjectDestinationPicker({
  clearDestination,
  continueWith,
  hasBroadcastDestination,
  hasEveryoneDestination,
  inputRef,
  implicitContinueSelected,
  projectDestinations,
  selectImplicitContinue,
  setDestination,
}: ComposerProjectDestinationPickerProps): JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const menuId = useId();
  const explicitDestinationCount =
    Number(hasBroadcastDestination) +
    Number(hasEveryoneDestination) +
    projectDestinations.length;
  const matchingContinuation = Boolean(
    explicitDestinationCount === 1 &&
    projectDestinations.length === 1 &&
    continueWith?.handle.toLocaleLowerCase() ===
      projectDestinations[0]!.handle.toLocaleLowerCase(),
  );
  const continuing =
    implicitContinueSelected &&
    Boolean(continueWith) &&
    explicitDestinationCount === 0;
  const label = hasBroadcastDestination
    ? "#broadcast"
    : hasEveryoneDestination
      ? "#everyone"
      : projectDestinations.length > 1
        ? `${projectDestinations.length} Agents`
        : projectDestinations.length === 1
          ? matchingContinuation
            ? continueWith!.title
            : `#${projectDestinations[0]!.handle}`
          : continuing
            ? continueWith!.title
            : "New Agent";
  const clearExplicitDestinations = () => {
    clearDestination("broadcast");
    clearDestination("everyone");
    for (const destination of projectDestinations) {
      clearDestination(destination.handle);
    }
  };
  const focusInput = () => {
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    });
  };
  const chooseNewAgent = () => {
    clearExplicitDestinations();
    selectImplicitContinue(false);
    setAnchor(null);
    focusInput();
  };
  const chooseContinuation = () => {
    if (!continueWith) return;
    clearExplicitDestinations();
    if (continueWith.responding) {
      selectImplicitContinue(true);
    } else {
      selectImplicitContinue(false);
      setDestination(continueWith.handle);
    }
    setAnchor(null);
    focusInput();
  };
  const canChoose = Boolean(continueWith) || explicitDestinationCount > 0;
  return (
    <>
      <Tooltip title="Choose who should handle this message">
        <ButtonBase
          aria-label={`Message destination: ${label}`}
          aria-haspopup={canChoose ? "menu" : undefined}
          aria-controls={anchor ? menuId : undefined}
          aria-expanded={anchor ? true : undefined}
          aria-disabled={!canChoose}
          onClick={event => {
            if (canChoose) setAnchor(event.currentTarget);
          }}
          sx={{
            minHeight: 40,
            minWidth: 0,
            maxWidth: { xs: 132, sm: 220 },
            px: 0.75,
            borderRadius: 1.25,
            color: continuing || explicitDestinationCount > 0
              ? "primary.main"
              : "text.secondary",
            "&:hover": { bgcolor: "action.hover" },
            "&:focus-visible": {
              outline: "2px solid",
              outlineColor: "primary.main",
              outlineOffset: 2,
            },
          }}
        >
          <SubdirectoryArrowRightIcon sx={{ mr: 0.5, fontSize: 19 }} />
          <Typography
            variant="body2"
            noWrap
            sx={{ minWidth: 0, fontWeight: 700 }}
          >
            {label}
          </Typography>
          {canChoose ? (
            <KeyboardArrowDownIcon sx={{ ml: 0.25, fontSize: 19 }} />
          ) : null}
        </ButtonBase>
      </Tooltip>
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "top", horizontal: "left" }}
        transformOrigin={{ vertical: "bottom", horizontal: "left" }}
        slotProps={{ paper: { sx: { minWidth: 220, maxWidth: 320 } } }}
      >
        <MenuItem
          selected={!continuing && explicitDestinationCount === 0}
          onClick={chooseNewAgent}
        >
          <ListItemIcon>
            {!continuing && explicitDestinationCount === 0 ? (
              <CheckIcon fontSize="small" />
            ) : null}
          </ListItemIcon>
          New Agent
        </MenuItem>
        {continueWith ? (
          <MenuItem
            selected={continuing || matchingContinuation}
            onClick={chooseContinuation}
          >
            <ListItemIcon>
              {continuing || matchingContinuation ? (
                <CheckIcon fontSize="small" />
              ) : null}
            </ListItemIcon>
            <Typography noWrap>Continue with {continueWith.title}</Typography>
          </MenuItem>
        ) : null}
      </Menu>
    </>
  );
}

interface ComposerAttachmentListProps {
  draftUploadStates: Map<
    File,
    { status: DraftUploadStatus; error?: string }
  >;
  files: File[];
  removeFile(index: number): void;
  retryDraftUpload(file: File): void;
}

export function ComposerAttachmentList({
  draftUploadStates,
  files,
  removeFile,
  retryDraftUpload,
}: ComposerAttachmentListProps): JSX.Element | null {
  return files.length > 0 ? (
    <Stack
      direction="row"
      spacing={1}
      useFlexGap
      flexWrap="wrap"
      sx={{ mb: 1 }}
    >
      {files.map((file, index) => {
        const upload = draftUploadStates.get(file);
        return (
          <ComposerAttachment
            key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
            file={file}
            status={upload?.status}
            error={upload?.error}
            onRetry={() => retryDraftUpload(file)}
            onRemove={() => removeFile(index)}
          />
        );
      })}
    </Stack>
  ) : null;
}

interface ComposerMentionStatusProps {
  destinationMode: ComposerProps["destinationMode"];
  mentionedBusyHandles: string[];
  mentionedHandles: string[];
}

export function ComposerMentionStatus({
  destinationMode,
  mentionedBusyHandles,
  mentionedHandles,
}: ComposerMentionStatusProps): JSX.Element | null {
  return mentionedHandles.length > 0 &&
    destinationMode !== "project-chat" &&
    destinationMode !== "target-required" ? (
    <Typography
      variant="caption"
      color={
        mentionedBusyHandles.length > 0
          ? "warning.main"
          : "text.secondary"
      }
    >
      {mentionedHandles.some(
        handle => handle.toLocaleLowerCase() === "broadcast",
      )
        ? "Adding durable shared context without starting an agent"
        : mentionedBusyHandles.length > 0
          ? `${mentionedBusyHandles.map(handle => `#${handle}`).join(", ")} ${mentionedBusyHandles.length > 1 ? "are" : "is"} working — your message will steer the active turn when supported.`
          : mentionedHandles.some(
                handle => handle.toLocaleLowerCase() === "everyone",
              )
            ? "Notifying every active agent in this conversation"
            : `Messaging ${mentionedHandles.map(handle => `#${handle}`).join(", ")}`}
    </Typography>
  ) : null;
}

interface ComposerSendActionsProps {
  allowSendWhileRunning: boolean;
  canCancel: boolean;
  canSend: boolean;
  destinationError: string | undefined;
  destinationMode: ComposerProps["destinationMode"];
  mentionedBusyHandles: string[];
  onCancel: ComposerProps["onCancel"];
  queue(): void;
  recipientRequiredMessage: string | undefined;
  send(): void;
  showQueue: boolean;
  steer(): void;
  targetRequiredRecipientTagged: boolean;
}

export function ComposerSendActions({
  allowSendWhileRunning,
  canCancel,
  canSend,
  destinationError,
  destinationMode,
  mentionedBusyHandles,
  onCancel,
  queue,
  recipientRequiredMessage,
  send,
  showQueue,
  steer,
  targetRequiredRecipientTagged,
}: ComposerSendActionsProps): JSX.Element {
  return (
    <>
      {showQueue ? (
        <Tooltip title="Steer the active response">
          <span>
            <Button
              size="small"
              variant="contained"
              disabled={!canSend}
              onClick={steer}
              aria-label="Steer active response"
              sx={{ minHeight: 40, px: 1.5, boxShadow: "none" }}
            >
              Steer
            </Button>
          </span>
        </Tooltip>
      ) : null}
      {showQueue ? (
        <Tooltip title="Send after the active response finishes">
          <span>
            <Button
              size="small"
              variant="outlined"
              disabled={!canSend}
              onClick={queue}
              aria-label="Queue message"
              sx={{ minHeight: 40, px: 1.5 }}
            >
              Queue
            </Button>
          </span>
        </Tooltip>
      ) : null}
      {canCancel ? (
        <Tooltip title="Cancel Run">
          <IconButton
            color="error"
            onClick={onCancel}
            aria-label="Cancel run"
          >
            <StopCircleIcon />
          </IconButton>
        </Tooltip>
      ) : null}
      {!showQueue && (!canCancel || allowSendWhileRunning) ? (
        <Tooltip
          title={
            !canSend &&
            (destinationError ||
              (destinationMode === "target-required" &&
                !targetRequiredRecipientTagged))
              ? (destinationError ??
                recipientRequiredMessage ??
                "Choose at least one Agent recipient.")
              : "Send"
          }
        >
          <span>
            <IconButton
              color="primary"
              disabled={!canSend}
              onClick={send}
              aria-label={
                mentionedBusyHandles.length > 0
                  ? "Queue message"
                  : "Send message"
              }
            >
              <ArrowUpwardIcon />
            </IconButton>
          </span>
        </Tooltip>
      ) : null}
    </>
  );
}
