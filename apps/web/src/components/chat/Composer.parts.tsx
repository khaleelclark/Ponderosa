import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import CampaignOutlinedIcon from "@mui/icons-material/CampaignOutlined";
import CloseIcon from "@mui/icons-material/Close";
import ScheduleSendOutlinedIcon from "@mui/icons-material/ScheduleSendOutlined";
import StopCircleIcon from "@mui/icons-material/StopCircle";
import {
  Button,
  Chip,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { memo, type RefObject } from "react";
import { ComposerAttachment } from "./ComposerAttachment";
import type { DraftUploadStatus } from "./ComposerAttachment";
import type { ComposerProps } from "./Composer.types";

interface ComposerDestinationBarProps {
  destinationError: string | undefined;
  destinationMode: ComposerProps["destinationMode"];
}

export function ComposerDestinationBar({
  destinationError,
  destinationMode: _destinationMode,
}: ComposerDestinationBarProps): JSX.Element | null {
  return destinationError ? (
    <Typography
      variant="caption"
      color="error.main"
      sx={{ display: "block", px: 0.25, pb: 0.75 }}
    >
      {destinationError}
    </Typography>
  ) : null;
}

export function ComposerTargetDestinationAction({
  broadcast,
  handles,
  onClear,
}: {
  broadcast: boolean;
  handles: string[];
  onClear(): void;
}): JSX.Element | null {
  const labels = [
    ...(broadcast ? ["#broadcast"] : []),
    ...handles.map(handle => `#${handle}`),
  ];
  if (labels.length === 0) return null;
  const label = labels.length > 1
    ? `${labels[0]} +${labels.length - 1}`
    : labels[0]!;
  return (
    <Chip
      size="small"
      color={broadcast ? "info" : "primary"}
      icon={broadcast ? <CampaignOutlinedIcon /> : undefined}
      label={label}
      title={labels.join(" ")}
      aria-label={`Destinations: ${labels.join(", ")}`}
      onDelete={onClear}
      sx={{
        maxWidth: { xs: 124, sm: 240 },
        height: 34,
        fontWeight: 700,
        "& .MuiChip-label": {
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
        },
      }}
    />
  );
}

interface ComposerProjectDestinationActionProps {
  clearDestination(handle: string): void;
  continueWith: ComposerProps["continueWith"];
  hasBroadcastDestination: boolean;
  hasEveryoneDestination: boolean;
  inputRef: RefObject<HTMLTextAreaElement>;
  implicitContinueSelected: boolean;
  projectDestinations: Array<{ handle: string }>;
  selectImplicitContinue(selected: boolean): void;
}

export function ComposerProjectDestinationAction({
  clearDestination,
  continueWith,
  hasBroadcastDestination,
  hasEveryoneDestination,
  inputRef,
  implicitContinueSelected,
  projectDestinations,
  selectImplicitContinue,
}: ComposerProjectDestinationActionProps): JSX.Element | null {
  const explicitDestinationCount =
    Number(hasBroadcastDestination) +
    Number(hasEveryoneDestination) +
    projectDestinations.length;
  const continuing =
    implicitContinueSelected &&
    Boolean(continueWith) &&
    explicitDestinationCount === 0;
  const explicitLabels = [
    ...(hasBroadcastDestination ? ["#broadcast"] : []),
    ...(hasEveryoneDestination ? ["#everyone"] : []),
    ...projectDestinations.map(destination => `#${destination.handle}`),
  ];
  const continuingHandleSelected =
    explicitLabels.length === 1 &&
    continueWith &&
    projectDestinations.length === 1 &&
    projectDestinations[0]!.handle.toLocaleLowerCase() ===
      continueWith.handle.toLocaleLowerCase();
  const targetedNextRun = hasBroadcastDestination && projectDestinations.length > 0;
  const targetedLabels = projectDestinations.map(destination => `#${destination.handle}`);
  const selectedLabel = targetedNextRun
    ? `Next run: ${targetedLabels[0]}${targetedLabels.length > 1 ? ` +${targetedLabels.length - 1}` : ""}`
    : continuing || continuingHandleSelected
    ? `To: ${continueWith!.title}`
    : explicitLabels.length > 1
      ? `${explicitLabels[0]} +${explicitLabels.length - 1}`
      : (explicitLabels[0] ?? "Destination");
  const selectedDestinationTitle = targetedNextRun
    ? `Deliver on next run to ${targetedLabels.join(", ")}. Passive delivery; no Run or reply requested.`
    : continuing || continuingHandleSelected
    ? selectedLabel
    : explicitLabels.join(" ");
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
    focusInput();
  };
  const hasSelectedDestination =
    continuing || explicitDestinationCount > 0;
  if (hasSelectedDestination) {
    return (
      <Chip
        size="small"
        color={
          targetedNextRun || hasBroadcastDestination
            ? "info"
            : hasEveryoneDestination
              ? "secondary"
              : "primary"
        }
        icon={
          targetedNextRun
            ? <ScheduleSendOutlinedIcon />
            : hasBroadcastDestination
              ? <CampaignOutlinedIcon />
              : undefined
        }
        label={selectedLabel}
        title={selectedDestinationTitle}
        aria-label={`${selectedLabel}${
          explicitLabels.length > 1
            ? `: ${explicitLabels.join(", ")}`
            : ""
        }. Press Delete or Backspace to clear.`}
        onDelete={chooseNewAgent}
        deleteIcon={<CloseIcon />}
        sx={{
          maxWidth: { xs: 124, sm: 240 },
          height: 34,
          fontWeight: 700,
          "& .MuiChip-label": {
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
          },
        }}
      />
    );
  }
  const helperText = "Sending without a recipient starts a new Agent.";
  return (
    <Typography
      variant="caption"
      color="text.secondary"
      sx={{
        display: { xs: "none", sm: "block" },
        maxWidth: 360,
        fontSize: 11,
        lineHeight: 1.25,
      }}
    >
      {helperText}
    </Typography>
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

const composerAttachmentKeys = new WeakMap<File, string>();
let nextComposerAttachmentKey = 0;

function composerAttachmentKey(file: File): string {
  const existing = composerAttachmentKeys.get(file);
  if (existing) return existing;
  nextComposerAttachmentKey += 1;
  const key = `composer-attachment-${nextComposerAttachmentKey}`;
  composerAttachmentKeys.set(file, key);
  return key;
}

function ComposerAttachmentListView({
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
            key={composerAttachmentKey(file)}
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

/** Keep mounted image previews untouched while only composer text changes. */
export const ComposerAttachmentList = memo(ComposerAttachmentListView);

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
  cancelPending: boolean;
  canSend: boolean;
  destinationError: string | undefined;
  destinationMode: ComposerProps["destinationMode"];
  mentionedBusyHandles: string[];
  onCancel: ComposerProps["onCancel"];
  queue(): void;
  recipientRequiredMessage: string | undefined;
  sendUnavailableReason: string | undefined;
  send(): void;
  showQueue: boolean;
  steer(): void;
  targetRequiredRecipientTagged: boolean;
}

export function ComposerSendActions({
  allowSendWhileRunning,
  canCancel,
  cancelPending,
  canSend,
  destinationError,
  destinationMode,
  mentionedBusyHandles,
  onCancel,
  queue,
  recipientRequiredMessage,
  sendUnavailableReason,
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
        <Tooltip title={cancelPending ? "Cancelling…" : "Cancel Run"}>
          <span>
            <IconButton
              color="error"
              disabled={cancelPending}
              onClick={onCancel}
              aria-label={cancelPending ? "Cancelling…" : "Cancel run"}
            >
              <StopCircleIcon />
            </IconButton>
          </span>
        </Tooltip>
      ) : null}
      {!showQueue && (!canCancel || allowSendWhileRunning) ? (
        <Tooltip
          title={
            !canSend &&
            (destinationError ||
              sendUnavailableReason ||
              (destinationMode === "target-required" &&
                !targetRequiredRecipientTagged))
              ? (destinationError ??
                sendUnavailableReason ??
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
