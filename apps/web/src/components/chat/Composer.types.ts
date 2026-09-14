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
  /** False while the authoritative recipient roster is unavailable; never infer deletion from loading. */
  mentionBindingsReady?: boolean;
  mentionSuggestionHandles?: string[];
  ambiguousMentionHandles?: string[];
  onCapabilitiesOpen?(): Promise<unknown> | unknown;
  attachmentsEnabled?: boolean;
  attachmentsUnavailableReason?: string;
  /** Expose browser dictation on a composer with structurally resolved routing. */
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
  /** Parent-owned epoch for explicit recipient/source changes. */
  submissionIntentKey?: string;
  /** Stable provider/runtime identity included in durable send authority. */
  submissionRuntimeKey?: string;
  /** Parent-owned epoch advanced only by an explicit runtime control edit. */
  submissionRuntimeIntentKey?: string;
  /** Abandons any parent-owned prepared operation after a local draft mutation. */
  onSubmissionIntentChange?(): void;
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
