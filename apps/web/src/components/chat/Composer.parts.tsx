import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import PersonAddAltOutlinedIcon from "@mui/icons-material/PersonAddAltOutlined";
import StopCircleIcon from "@mui/icons-material/StopCircle";
import {
  Button,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { memo } from "react";
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

interface ComposerProjectDestinationActionProps {
  disabled: boolean;
  newAgentSelected: boolean;
  toggleNewAgent(): void;
  replyDestination?: string;
}

export function ComposerProjectDestinationAction({
  disabled,
  newAgentSelected,
  toggleNewAgent,
  replyDestination,
}: ComposerProjectDestinationActionProps): JSX.Element {
  if (replyDestination) {
    return (
      <Tooltip title="Switch to a new Agent">
        <Button
          disabled={disabled}
          size="small"
          variant="text"
          color="primary"
          onClick={toggleNewAgent}
          sx={{
            whiteSpace: "nowrap",
            minHeight: { xs: 44, sm: 34 },
            "@media (pointer: coarse)": { minHeight: 44 },
          }}
        >
          Reply to {replyDestination}
        </Button>
      </Tooltip>
    );
  }
  return (
    <Button
      disabled={disabled}
      size="small"
      variant={newAgentSelected ? "contained" : "text"}
      color={newAgentSelected ? "primary" : "inherit"}
      startIcon={<PersonAddAltOutlinedIcon />}
      aria-pressed={newAgentSelected}
      onClick={toggleNewAgent}
      sx={{
        whiteSpace: "nowrap",
        minHeight: { xs: 44, sm: 34 },
        "@media (pointer: coarse)": { minHeight: 44 },
      }}
    >
      New Agent
    </Button>
  );
}

interface ComposerAttachmentListProps {
  disabled: boolean;
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
  disabled,
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
            disabled={disabled}
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
