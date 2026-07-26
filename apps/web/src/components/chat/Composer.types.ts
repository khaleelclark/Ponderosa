import type { ChatComposerContract } from "./composerContracts";

export interface ComposerProps extends ChatComposerContract {
  /** Keep the composer available while other Agents in this shared chat are working. */
  allowSendWhileRunning?: boolean;
  placeholder?: string;
  projectId?: string;
  mentionHandles?: string[];
  mentionSuggestionHandles?: string[];
  ambiguousMentionHandles?: string[];
  onCapabilitiesOpen?(): Promise<unknown> | unknown;
  attachmentsEnabled?: boolean;
  attachmentsUnavailableReason?: string;
  busyMentionHandles?: string[];
  allowUnmentionedSend?: boolean;
  preferQueue?: boolean;
  queuedMentionHandles?: string[];
  agentResponding?: boolean;
  onCancel?(): void;
  draftStorageKey?: string;
  conversationDraftId?: string;
  insertTextRequest?: { id: string; text: string };
  /** Project Chat exposes its deliberate fresh-agent default as a destination. */
  destinationMode?: "project-chat" | "fixed" | "target-required";
  fixedRecipientTitle?: string;
  requiredRecipient?: { handle: string; title: string; onClear(): void };
  recipientRequiredMessage?: string;
  removeTextRequest?: { id: string; text: string };
  onMentionedHandlesChange?(handles: string[]): void;
  continueWith?: { handle: string; title: string };
  destinationTitleForHandle?(handle: string): string | undefined;
}
