import type { AgentStore, CoordinationV3Store, WorkspaceStore } from "@ponderosa/agents";
import type { AssetDto, DecisionDto } from "@ponderosa/core";
import { ASSET_LIMITS, AssetError, type AssetStore } from "./assets.js";
import type { DraftService } from "./routes/drafts.js";

type Context = {
  store: Pick<AgentStore, "getAgent" | "getConversation">;
  workspace: Pick<WorkspaceStore, "getDecision">;
  coordinationV3: Pick<CoordinationV3Store, "protectMessageAttachments">;
  drafts: Pick<DraftService, "acquireMutationLease" | "withMutationLock" | "prepared" | "retireDecisionDraft">;
  assets: Pick<AssetStore, "stage" | "remove" | "associate">;
  deletingAgentIds: ReadonlySet<string>;
  deletingConversationIds: ReadonlySet<string>;
  reconcilingAssetAgentIds: ReadonlySet<string>;
  agentDeliveryLeases: Map<string, number>;
  conversationDeliveryLeases: Map<string, number>;
};

/** Reuse the Agent surface with the exact Decision ID as its separate owner.
 * Ordinary message drafts and their browser owner IDs are never consulted. */
export async function withDecisionAttachments<T>(context: Context, decision: DecisionDto, ids: string[], commit: (files: AssetDto[]) => Promise<T>): Promise<T> {
  const { store, workspace, coordinationV3, drafts, assets } = context;
  const agent = store.getAgent(decision.agentId);
  const conversationId = decision.conversationId ?? agent?.conversationId;
  const conversation = conversationId ? store.getConversation(conversationId) : undefined;
  if (!agent || agent.projectId !== decision.projectId || !conversation || conversation.projectId !== decision.projectId ||
      agent.conversationId !== conversation.id) throw new AssetError(409, "The Decision owner is unavailable");
  if (context.deletingAgentIds.has(agent.id) || context.deletingConversationIds.has(conversation.id) ||
      context.reconcilingAssetAgentIds.has(agent.id)) throw new AssetError(409, "Decision files are busy; retry safely");
  const scope = `agent:${agent.id}`, release = drafts.acquireMutationLease(scope);
  if (!release) throw new AssetError(409, "The Decision owner is being deleted");
  const leases: Array<[Map<string, number>, string]> = [[context.agentDeliveryLeases, agent.id], [context.conversationDeliveryLeases, conversation.id]];
  for (const [map, id] of leases) map.set(id, (map.get(id) ?? 0) + 1);
  const promoted: AssetDto[] = [];
  let protectionAttempted = false;
  try {
    return await drafts.withMutationLock(scope, decision.id, async () => {
      if (workspace.getDecision(decision.id)?.status !== "pending") return commit([]);
      let total = 0;
      for (const id of ids) {
        const staged = await drafts.prepared(scope, decision.id, id);
        if (!staged) throw new AssetError(404, "A Decision file is missing or belongs to another answer. Keep the answer and upload that file again.");
        total += staged.body.length;
        if (total > ASSET_LIMITS.maxMessageBytes) throw new AssetError(413, "Decision files exceed the message byte limit");
        const file = await assets.stage({ projectId: decision.projectId, agentId: agent.id, body: staged.body, prepared: staged.prepared });
        const base = `/api/decisions/${decision.id}/attachments/${file.id}`;
        promoted.push({ ...file, state: "associated", url: `${base}/${file.mediaType.startsWith("image/") ? "preview" : "download"}`,
          previewUrl: file.previewUrl ? `${base}/preview` : undefined, downloadUrl: `${base}/download` });
      }
      if (workspace.getDecision(decision.id)?.status !== "pending") return commit([]);
      // Protect bytes before the fsynced workspace mutation. Unknown save/commit
      // outcomes keep these bindings; startup reconciles each exact saved file.
      protectionAttempted = true;
      coordinationV3.protectMessageAttachments({ projectId: decision.projectId, agentId: agent.id,
        messageId: `decision:${decision.id}:response`, payload: { dispatch: { attachments: promoted.map(file => ({
          id: file.id, name: file.name, mediaType: file.mediaType, size: file.size,
        })) } } });
      return commit(promoted);
    });
  } finally {
    if (!protectionAttempted) await Promise.allSettled(promoted.map(file => assets.remove(decision.projectId, agent.id, file.id)));
    const accepted = workspace.getDecision(decision.id)?.response?.attachments?.filter(file => promoted.some(item => item.id === file.id)) ?? [];
    if (accepted.length) {
      try { await assets.associate(decision.projectId, agent.id, accepted.map(file => file.id)); }
      catch { /* canonical bindings protect bytes; startup retries association */ }
    }
    // Failure here cannot undo an accepted answer. The existing maintenance
    // owner retries closed-Decision draft retirement on its next pass.
    try { drafts.retireDecisionDraft(scope, decision.id); } catch { /* durable refs and cleanup receipts remain protected */ }
    for (const [map, id] of leases) {
      const remaining = (map.get(id) ?? 1) - 1;
      if (remaining > 0) map.set(id, remaining); else map.delete(id);
    }
    release();
  }
}
