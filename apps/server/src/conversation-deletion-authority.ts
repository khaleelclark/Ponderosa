import type {
  AgentStore,
  ConversationDeletionReceipt,
  WorkspaceStore,
} from "@ponderosa/agents";
import type { WorkspaceEventEnvelope } from "@ponderosa/core";
import type { DraftService } from "./routes/drafts.js";

export function createConversationDeletionAuthority(context: {
  store: AgentStore;
  workspace: WorkspaceStore;
  drafts: Pick<DraftService, "deleteSurface">;
  refreshTriggerSources(): Promise<unknown>;
  publishWorkspace(event: WorkspaceEventEnvelope): void;
}) {
  const processConversationDeletionCleanup = async (
    initial: ConversationDeletionReceipt,
  ): Promise<boolean> => {
    let receipt = context.store.getConversationDeletionReceipt(
      initial.conversationId,
    ) ?? initial;
    if (receipt.storageCleanupCompleted && receipt.serverCleanupCompleted) {
      return true;
    }
    const errors: string[] = [];
    if (!receipt.storageCleanupCompleted) {
      try {
        context.store.finishConversationDeletionStorageCleanup(receipt);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "Chat storage cleanup failed");
      }
      receipt = context.store.getConversationDeletionReceipt(receipt.conversationId) ?? receipt;
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
      await context.refreshTriggerSources();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Automation refresh failed");
    }
    try {
      context.publishWorkspace(context.workspace.reconcileConversationDeletion(
        receipt.projectId,
        receipt.conversationId,
      ));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "workspace publication failed");
    }
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

  return { processConversationDeletionCleanup };
}
