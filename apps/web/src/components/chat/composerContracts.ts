import type {
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
    context?: { implicitRecipientId?: string },
  ): Promise<unknown> | unknown;
  onQueue?(
    text: string,
    files: File[],
    stagedAttachmentIds?: string[],
    draftOwnerId?: string,
    context?: { implicitRecipientId?: string },
  ): Promise<unknown> | unknown;
  onCommand?(command: EngineCommand, argumentsText?: string): Promise<unknown> | unknown;
  commands?: EngineCommand[];
  capabilities?: EngineComposerCapability[];
  /** Controls placed beside the attachment/capability button. */
  leadingControls?: ReactNode;
  controls?: ReactNode;
}
