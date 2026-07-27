import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import CampaignOutlinedIcon from "@mui/icons-material/CampaignOutlined";
import StopCircleIcon from "@mui/icons-material/StopCircle";
import {
  Box,
  Button,
  Chip,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { ReactNode, RefObject } from "react";
import { ComposerAttachment } from "./ComposerAttachment";
import type { DraftUploadStatus } from "./ComposerAttachment";
import type { ComposerProps } from "./Composer.types";

interface ComposerGuidanceProps {
  guidance: ReactNode;
}

export function ComposerGuidance({
  guidance,
}: ComposerGuidanceProps): JSX.Element | null {
  return guidance ? (
    <Box sx={{ px: 0.25, pb: 0.9, color: "text.secondary" }}>
      {typeof guidance === "string" ? (
        <Typography
          variant="body2"
          sx={{ fontSize: { xs: 12.5, sm: 13.5 }, lineHeight: 1.45 }}
        >
          {guidance}
        </Typography>
      ) : (
        guidance
      )}
    </Box>
  ) : null;
}

interface ComposerDestinationBarProps {
  clearDestination(handle: string): void;
  continueWith: ComposerProps["continueWith"];
  destinationError: string | undefined;
  destinationMode: ComposerProps["destinationMode"];
  fixedRecipientTitle: string | undefined;
  hasBroadcastDestination: boolean;
  hasEveryoneDestination: boolean;
  inputRef: RefObject<HTMLTextAreaElement>;
  implicitContinueSelected: boolean;
  projectDestinationHelper: string;
  projectDestinations: Array<{ handle: string; title: string }>;
  selectImplicitContinue(selected: boolean): void;
  setDestination(handle: string): void;
  targetRequiredDestinations: Array<{ handle: string; title: string }>;
  targetRequiredHelper: string;
}

export function ComposerDestinationBar({
  clearDestination,
  continueWith,
  destinationError,
  destinationMode,
  fixedRecipientTitle,
  hasBroadcastDestination,
  hasEveryoneDestination,
  inputRef,
  implicitContinueSelected,
  projectDestinationHelper,
  projectDestinations,
  selectImplicitContinue,
  setDestination,
  targetRequiredDestinations,
  targetRequiredHelper,
}: ComposerDestinationBarProps): JSX.Element | null {
  return destinationMode === "project-chat" ? (
    <Stack
      direction="row"
      spacing={0.75}
      useFlexGap
      flexWrap="wrap"
      sx={{ px: 0.25, pb: 0.75, alignItems: "center" }}
    >
      {hasBroadcastDestination ? (
        <Chip
          size="small"
          color="info"
          icon={<CampaignOutlinedIcon />}
          label="#broadcast"
          onDelete={() => clearDestination("broadcast")}
        />
      ) : null}
      {hasEveryoneDestination ? (
        <Chip
          size="small"
          color="secondary"
          label="#everyone"
          onDelete={() => clearDestination("everyone")}
        />
      ) : null}
      {projectDestinations.map(destination => (
        <Chip
          key={destination.handle.toLocaleLowerCase()}
          size="small"
          color="primary"
          label={`#${destination.handle}`}
          onDelete={() => clearDestination(destination.handle)}
        />
      ))}
      {!hasBroadcastDestination &&
      !hasEveryoneDestination &&
      projectDestinations.length === 0 &&
      !implicitContinueSelected ? (
        <Chip size="small" variant="outlined" label="New Agent" />
      ) : null}
      {!hasBroadcastDestination &&
      !hasEveryoneDestination &&
      projectDestinations.length === 0 &&
      continueWith ? (
        implicitContinueSelected ? (
          <>
            <Chip
              size="small"
              color="primary"
              label={`Continue with ${continueWith.title}`}
            />
            <Button size="small" onClick={() => selectImplicitContinue(false)}>
              New Agent
            </Button>
          </>
        ) : (
          <Button
            size="small"
            onClick={() => {
              if (continueWith.responding) {
                selectImplicitContinue(true);
              } else {
                setDestination(continueWith.handle);
              }
              window.requestAnimationFrame(() => {
                const input = inputRef.current;
                if (!input) return;
                input.focus();
                const end = input.value.length;
                input.setSelectionRange(end, end);
              });
            }}
          >
            Continue with {continueWith.title}
          </Button>
        )
      ) : null}
      <Typography
        variant="caption"
        color={destinationError ? "error.main" : "text.secondary"}
      >
        {projectDestinationHelper}
      </Typography>
      {!destinationError ? (
        <Tooltip title="Use @ to reference a Project file.">
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ whiteSpace: "nowrap" }}
          >
            · @ file
          </Typography>
        </Tooltip>
      ) : null}
    </Stack>
  ) : destinationMode === "target-required" ? (
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
      <Typography
        variant="caption"
        color={destinationError ? "error.main" : "text.secondary"}
      >
        {targetRequiredHelper}
      </Typography>
    </Stack>
  ) : destinationMode === "fixed" && fixedRecipientTitle ? (
    <Typography
      variant="caption"
      color="text.secondary"
      sx={{ display: "block", px: 0.25, pb: 0.75 }}
    >
      {fixedRecipientTitle} will receive this.
    </Typography>
  ) : null;
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
