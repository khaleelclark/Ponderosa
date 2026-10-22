import type {
  AgentStore,
  ConversationDeletionReceipt,
  WorkspaceStore,
} from "@ponderosa/agents";
import type { WorkspaceEventEnvelope } from "@ponderosa/core";
import type { DraftService } from "./routes/drafts.js";
import type { AssetStore } from "./assets.js";

export function createConversationDeletionAuthority(context: {
  store: AgentStore;
  workspace: WorkspaceStore;
  drafts: Pick<DraftService, "deleteSurface" | "fenceMutations">;
  assets: Pick<AssetStore, "purgeConversationAssets">;
  deletingConversationIds: Set<string>;
  agentCreationConversationLeases: ReadonlyMap<string, number>;
  conversationDeliveryLeases: ReadonlyMap<string, number>;
  reconcileConversationRuntimeCommunicationProjections(
    projectId: string,
    conversationId: string,
  ): Promise<number>;
  closeChatBrowsers?(conversationId: string): Promise<void>;
  purgeChatMemory?(conversationId:string):Promise<void>;
  commitAgentDeletion(
    rootAgentIds: string[],
    previewHash: string,
  ): Promise<unknown>;
  purgeCommunicationV4Conversation(conversationId: string): void;
  publishWorkspace(event: WorkspaceEventEnvelope): void;
}) {
  const operations = new Map<string, Promise<boolean>>();
  const processConversationDeletion = async (
    initial: ConversationDeletionReceipt,
  ): Promise<boolean> => {
    let receipt = context.store.getConversationDeletionReceipt(
      initial.conversationId,
    ) ?? initial;
    context.deletingConversationIds.add(receipt.conversationId);
    let releaseDraftFence: (() => void) | undefined;
    if (!receipt.canonicalDeletionCompleted) {
      try {
        const conversation = context.store.getConversation(receipt.conversationId, { includeDeleting: true });
        if (!conversation) {
          await context.closeChatBrowsers?.(receipt.conversationId);
          const superseded = context.store.commitConversationDeletion(
            receipt.conversationId,
            context.purgeCommunicationV4Conversation,
          );
          if (!superseded?.canonicalDeletionCompleted) {
            throw new Error("Chat deletion intent lost its canonical Chat");
          }
          receipt = superseded;
        } else if (conversation.projectId !== receipt.projectId) {
          throw new Error("Chat deletion intent lost its canonical Chat");
        } else {
          releaseDraftFence = await context.drafts.fenceMutations([
            conversation.id,
            `collaboration:${conversation.id}`,
          ]);
          await context.reconcileConversationRuntimeCommunicationProjections(
            conversation.projectId,
            conversation.id,
          );
          if ((context.agentCreationConversationLeases.get(conversation.id) ?? 0) > 0) {
            throw new Error("Agent creation is still using this Chat");
          }
          if ((context.conversationDeliveryLeases.get(conversation.id) ?? 0) > 0) {
            throw new Error("Message delivery is still using this Chat");
          }
          await context.closeChatBrowsers?.(conversation.id);
          const linkedAgents = context.store.listAgents(conversation.projectId)
            .filter((agent) => agent.conversationId === conversation.id);
          if (linkedAgents.length > 0) {
            const preview = context.store.previewAgentDeletion(
              linkedAgents.map((agent) => agent.id),
            );
            await context.commitAgentDeletion(preview.rootAgentIds, preview.previewHash);
          }
          if (context.store.listAgents(conversation.projectId)
            .some((agent) => agent.conversationId === conversation.id)) {
            throw new Error("Chat deletion could not reach an Agent-free commit boundary");
          }
          await context.closeChatBrowsers?.(conversation.id);
          const committed = context.store.commitConversationDeletion(
            conversation.id,
            context.purgeCommunicationV4Conversation,
          );
          if (!committed?.canonicalDeletionCompleted) {
            throw new Error("Chat deletion could not commit its canonical receipt");
          }
          receipt = committed;
        }
      } catch (error) {
        try {
          context.store.recordConversationDeletionCleanupError(
            receipt.conversationId,
            error instanceof Error ? error.message : "Chat canonical deletion remains pending",
          );
        } catch { /* the durable precommit intent remains retry authority */ }
        return false;
      } finally {
        releaseDraftFence?.();
      }
    }
    if (receipt.storageCleanupCompleted && receipt.serverCleanupCompleted) {
      context.deletingConversationIds.delete(receipt.conversationId);
      return true;
    }
    const errors: string[] = [];
    try { await context.closeChatBrowsers?.(receipt.conversationId); }
    catch (error) {
      try {
        context.store.recordConversationDeletionCleanupError(receipt.conversationId,
          error instanceof Error ? error.message : "Chat browser cleanup remains pending");
      } catch { /* the durable receipt remains retry authority */ }
      return false;
    }
    if (!receipt.storageCleanupCompleted) {
      try {
        context.store.finishConversationDeletionStorageCleanup(receipt);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "Chat storage cleanup failed");
      }
      receipt = context.store.getConversationDeletionReceipt(receipt.conversationId) ?? receipt;
    }
    try {
      await context.assets.purgeConversationAssets(receipt.projectId, receipt.conversationId);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Chat attachment cleanup failed");
    }
    for (const draftId of [
      receipt.conversationId,
      `collaboration:${receipt.conversationId}`,
    ]) {
      try {
        context.workspace.deleteDraft(draftId);
        await context.drafts.deleteSurface(draftId);
      } catch (error) {
        errors.push(`${draftId}: ${error instanceof Error ? error.message : "draft cleanup failed"}`);
      }
    }
    try {
      context.store.refreshConversationDeletionProjection(receipt);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Chat projection cleanup failed");
    }
    try {
      const folders = context.workspace.getPreferences().chatFolders;
      if (folders?.some(folder => folder.conversationIds.includes(receipt.conversationId))) {
        const cursor = context.workspace.cursor();
        context.workspace.updatePreferences({ chatFolders: folders.map(folder => ({ ...folder,
          conversationIds: folder.conversationIds.filter(id => id !== receipt.conversationId),
        })).filter(folder => folder.conversationIds.length) });
        for (const event of context.workspace.readSince(cursor)) context.publishWorkspace(event);
      }
      context.publishWorkspace(context.workspace.reconcileConversationDeletion(
        receipt.projectId,
        receipt.conversationId,
      ));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "workspace publication failed");
    }
    try { await context.purgeChatMemory?.(receipt.conversationId); }
    catch(error){errors.push(error instanceof Error?error.message:'Chat memory cleanup failed');}
    if (errors.length > 0 || !receipt.storageCleanupCompleted) {
      try {
        context.store.recordConversationDeletionCleanupError(
          receipt.conversationId,
          errors.join("; ") || "Chat storage cleanup remains pending",
        );
      } catch { /* the incomplete durable receipt remains retry authority */ }
      return false;
    }
    try {
      context.store.markConversationDeletionServerCleanupComplete(
        receipt.conversationId,
      );
      context.deletingConversationIds.delete(receipt.conversationId);
      return true;
    } catch (error) {
      try {
        context.store.recordConversationDeletionCleanupError(
          receipt.conversationId,
          error instanceof Error ? error.message : "Chat cleanup receipt could not complete",
        );
      } catch { /* startup reconciliation will retry the durable receipt */ }
      return false;
    }
  };

  const processConversationDeletionCleanup = (
    receipt: ConversationDeletionReceipt,
  ): Promise<boolean> => {
    const existing = operations.get(receipt.conversationId);
    if (existing) return existing;
    const operation = processConversationDeletion(receipt).finally(() => {
      if (operations.get(receipt.conversationId) === operation) {
        operations.delete(receipt.conversationId);
      }
    });
    operations.set(receipt.conversationId, operation);
    return operation;
  };

  return { processConversationDeletionCleanup };
}

export async function drainProjectConversationDeletions(
  store: Pick<AgentStore, "listPendingConversationDeletionReceipts">,
  projectId: string,
  processConversationDeletionCleanup: (
    receipt: ConversationDeletionReceipt,
  ) => Promise<boolean>,
): Promise<boolean> {
  const pending = () => store.listPendingConversationDeletionReceipts()
    .filter(receipt => receipt.projectId === projectId);
  for (const receipt of pending()) {
    await processConversationDeletionCleanup(receipt);
  }
  return pending().length === 0;
}
