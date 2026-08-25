import type { ChatComposerContract } from "./composerContracts";
import type { AgentMentionBindingDto } from "@ponderosa/core";

export interface ComposerProps extends ChatComposerContract {
  /** Keep the composer available while other Agents in this shared chat are working. */
  allowSendWhileRunning?: boolean;
  placeholder?: string;
  projectId?: string;
  mentionHandles?: string[];
  /** Stable recipient identities corresponding to selectable Agent handles. */
  mentionBindings?: AgentMentionBindingDto[];
  mentionSuggestionHandles?: string[];
  ambiguousMentionHandles?: string[];
  onCapabilitiesOpen?(): Promise<unknown> | unknown;
  attachmentsEnabled?: boolean;
  attachmentsUnavailableReason?: string;
  /** Expose browser dictation for an unambiguously routed Direct Agent Chat. */
  enableVoiceDictation?: boolean;
  busyMentionHandles?: string[];
  allowUnmentionedSend?: boolean;
  /** Explains why a valid-looking draft cannot use the ordinary send path. */
  sendUnavailableReason?: string;
  agentResponding?: boolean;
  onCancel?(): void;
  cancelPending?: boolean;
  draftStorageKey?: string;
  conversationDraftId?: string;
  insertTextRequest?: { id: string; text: string };
  /** Project Chat exposes its deliberate fresh-agent default as a destination. */
  destinationMode?: "project-chat" | "fixed" | "target-required";
  requiredRecipient?: { handle: string; title: string; onClear(): void };
  recipientRequiredMessage?: string;
  removeTextRequest?: { id: string; text: string };
  onMentionedHandlesChange?(handles: string[]): void;
  /** Reports the one exact visible Agent handle that may own provider commands. */
  onCommandTargetHandleChange?(handle?: string): void;
  /** Reports the stable identity of a structurally selected Agent destination. */
  onCommandTargetAgentIdChange?(agentId?: string): void;
  /** One shared visible destination used by Project, Agent, and All Messages composers. */
  defaultDestination?: {
    handle: string;
    /** Stable recipient identity; visible handle text is presentation only. */
    binding?: AgentMentionBindingDto;
    /** Changes when a newly committed destination should populate the draft. */
    selectionKey: string;
  };
}
