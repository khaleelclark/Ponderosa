import type {
  AgentMentionBindingDto,
  DraftPendingSubmissionDto,
  EngineCommand,
  EngineComposerCapability,
} from "@ponderosa/core";
import type { ReactNode } from "react";

export interface ChatComposerContract {
  disabled: boolean;
  running: boolean;
  onSend(
    text: string,
    files: File[],
    stagedAttachmentIds?: string[],
    draftOwnerId?: string,
    context?: {
      mentionedAgents?: AgentMentionBindingDto[];
      newAgentRequested?: boolean;
      /** Re-dispatch the exact operation retained after an ambiguous response. */
      retryPreparedAttempt?: boolean;
      pendingSubmission?: DraftPendingSubmissionDto;
      persistPendingSubmission?(
        value: DraftPendingSubmissionDto,
        retainOnFailure?: boolean,
      ): Promise<void>;
    },
  ): Promise<unknown> | unknown;
  onQueue?(
    text: string,
    files: File[],
    stagedAttachmentIds?: string[],
    draftOwnerId?: string,
    context?: {
      mentionedAgents?: AgentMentionBindingDto[];
      newAgentRequested?: boolean;
      /** Re-dispatch the exact operation retained after an ambiguous response. */
      retryPreparedAttempt?: boolean;
      pendingSubmission?: DraftPendingSubmissionDto;
      persistPendingSubmission?(
        value: DraftPendingSubmissionDto,
        retainOnFailure?: boolean,
      ): Promise<void>;
    },
  ): Promise<unknown> | unknown;
  onCommand?(command: EngineCommand, argumentsText?: string): Promise<unknown> | unknown;
  commands?: EngineCommand[];
  capabilities?: EngineComposerCapability[];
  /** Controls placed beside the attachment/capability button. */
  leadingControls?: ReactNode;
  controls?: ReactNode;
}
