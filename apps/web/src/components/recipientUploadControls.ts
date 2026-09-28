import type { AssetDto } from "@ponderosa/core";
import { ApiRequestError } from "../api/types.js";
import {
  discardRecipientUploads,
  recipientUploadCleanupReporter,
  recipientUploadCleanupSettled,
  type RecipientUploads,
} from "../conversationRouting.js";
import { definitiveSubmissionStatus } from "./idempotentAttempt.js";

/** Shared error classification and exact upload cleanup for both Chat send
 * surfaces. A committed/uncertain send is never retried by this helper. */
export function recipientUploadControls(input: {
  deleteAttachment: (agentId: string, attachmentId: string) => Promise<unknown>;
  onPendingDelta: (delta: 1 | -1) => void;
}) {
  const recipientUnavailable = (error: unknown) =>
    error instanceof ApiRequestError && error.status === 404;
  const cleanupSettled = (error: unknown) =>
    error instanceof ApiRequestError &&
    recipientUploadCleanupSettled(error.status, error.message);
  const definitiveFailure = (error: unknown) =>
    error instanceof ApiRequestError &&
    definitiveSubmissionStatus(error.status, error.message);
  const cleanupPendingReporter = () => recipientUploadCleanupReporter(input.onPendingDelta);
  const cleanupRecipientUploads = (
    recipients: RecipientUploads<Pick<AssetDto, "id">>,
  ) => discardRecipientUploads(
    recipients,
    (agentId, item) => input.deleteAttachment(agentId, item.id),
    cleanupSettled,
    cleanupPendingReporter(),
  );
  return {
    recipientUnavailable,
    cleanupSettled,
    definitiveFailure,
    cleanupPendingReporter,
    cleanupRecipientUploads,
  };
}
