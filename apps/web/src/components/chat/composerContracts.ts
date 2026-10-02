import type {
  AgentMentionBindingDto,
  AgentDto,
  DraftPendingSubmissionDto,
  EngineCommand,
  EngineComposerCapability,
} from "@ponderosa/core";
import type { ReactNode, RefObject } from "react";

export interface ComposerMenuAction {
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
  onSelect(): void;
}

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
      /** Presentation-only handoff from the committed creation response. */
      onAgentCreated?(agent: AgentDto): void;
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
      onAgentCreated?(agent: AgentDto): void;
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
  /** Additional context-specific actions shown in the attachment/capability menu. */
  menuActions?: ComposerMenuAction[];
  /** Optional persistent focus anchor for context-specific composer flows. */
  capabilityButtonRef?: RefObject<HTMLButtonElement>;
  /** Controls placed beside the attachment/capability button. */
  leadingControls?: ReactNode;
  controls?: ReactNode;
}
