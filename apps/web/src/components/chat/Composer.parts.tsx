import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import CampaignOutlinedIcon from "@mui/icons-material/CampaignOutlined";
import CloseIcon from "@mui/icons-material/Close";
import StopCircleIcon from "@mui/icons-material/StopCircle";
import SubdirectoryArrowRightIcon from "@mui/icons-material/SubdirectoryArrowRight";
import {
  Button,
  Chip,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { RefObject } from "react";
import { ComposerAttachment } from "./ComposerAttachment";
import type { DraftUploadStatus } from "./ComposerAttachment";
import type { ComposerProps } from "./Composer.types";

interface ComposerDestinationBarProps {
  destinationError: string | undefined;
  destinationMode: ComposerProps["destinationMode"];
}

export function ComposerDestinationBar({
  destinationError,
  destinationMode,
}: ComposerDestinationBarProps): JSX.Element | null {
  return destinationMode === "target-required" && destinationError ? (
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
  setDestination(handle: string): void;
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
  setDestination,
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
  const selectedLabel = continuing || continuingHandleSelected
    ? `To: ${continueWith!.title}`
    : explicitLabels.length > 1
      ? `${explicitLabels[0]} +${explicitLabels.length - 1}`
      : (explicitLabels[0] ?? "Destination");
  const selectedDestinationTitle = continuing || continuingHandleSelected
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
  const chooseContinuation = () => {
    if (!continueWith) return;
    clearExplicitDestinations();
    if (continueWith.responding) {
      selectImplicitContinue(true);
    } else {
      selectImplicitContinue(false);
      setDestination(continueWith.handle);
    }
    focusInput();
  };
  const hasSelectedDestination =
    continuing || explicitDestinationCount > 0;
  if (hasSelectedDestination) {
    return (
      <Chip
        size="small"
        color={
          hasBroadcastDestination
            ? "info"
            : hasEveryoneDestination
              ? "secondary"
              : "primary"
        }
        icon={
          hasBroadcastDestination ? <CampaignOutlinedIcon /> : undefined
        }
        label={selectedLabel}
        title={selectedDestinationTitle}
        aria-label={`${selectedLabel}. Press Delete or Backspace to clear.`}
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
  if (!continueWith) return null;
  const explanation =
    `Select ${continueWith.title} as the recipient. Sending without a recipient starts a new Agent.`;
  const helperText = "Sending without a recipient starts a new Agent.";
  return (
    <Stack
      spacing={0.25}
      sx={{
        minWidth: 0,
        maxWidth: { xs: 190, sm: 360 },
        alignItems: "flex-start",
      }}
    >
      <Tooltip title={explanation} describeChild>
        <Button
          aria-label={`Continue with ${continueWith.title}`}
          variant="outlined"
          size="small"
          color="primary"
          startIcon={<SubdirectoryArrowRightIcon />}
          onClick={chooseContinuation}
          sx={{
            minHeight: 36,
            minWidth: 0,
            maxWidth: { xs: 190, sm: 240 },
            px: 1,
            borderRadius: 1,
            fontWeight: 700,
            textTransform: "none",
            justifyContent: "flex-start",
            "& .MuiButton-startIcon": { mr: 0.5 },
          }}
        >
          <Typography
            component="span"
            variant="body2"
            noWrap
            sx={{ minWidth: 0, fontWeight: 700 }}
          >
            Continue with {continueWith.title}
          </Typography>
        </Button>
      </Tooltip>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{
          maxWidth: 360,
          fontSize: 11,
          lineHeight: 1.25,
        }}
      >
        {helperText}
      </Typography>
    </Stack>
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
