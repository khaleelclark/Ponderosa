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
  agentResponding?: boolean;
  onCancel?(): void;
  draftStorageKey?: string;
  conversationDraftId?: string;
  insertTextRequest?: { id: string; text: string };
  /** Project Chat exposes its deliberate fresh-agent default as a destination. */
  destinationMode?: "project-chat" | "fixed" | "target-required";
  requiredRecipient?: { handle: string; title: string; onClear(): void };
  recipientRequiredMessage?: string;
  removeTextRequest?: { id: string; text: string };
  onMentionedHandlesChange?(handles: string[]): void;
  /** Reports the one exact Agent destination that may own provider commands. */
  onCommandTargetHandleChange?(handle?: string): void;
  continueWith?: {
    agentId: string;
    handle: string;
    title: string;
    responding?: boolean;
    /** Changes when a newly committed Direct message should restore selection. */
    selectionKey: string;
  };
}
