import type { ActiveMessageDeliveryReceiptsDto, CancelQueuedMessageResponse, QueuedConversationMessageDto, MessageDeliveryReceiptDto } from "@ponderosa/core";
import { replaceEqualDeep, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { queryKeys } from "../queryKeys";
import { productApiPath } from "../api/productScope";

export interface ReceiptSource {
  id?: string;
  communicationEventId?: string;
  conversationId?: string;
  source?: { conversationId?: string };
  deliveryReceipts?: MessageDeliveryReceiptDto[];
}

/** Queue presentation never removes delivered work or another legitimate recipient. */
export function messageHiddenByQueue(source: ReceiptSource, queuedIds?: ReadonlySet<string>): boolean {
  const receipts = source.deliveryReceipts;
  if (receipts?.length && receipts.every(receipt => receipt.queueDeletionConfirmed)) return true;
  if (!(source.id && queuedIds?.has(source.id) || source.communicationEventId && queuedIds?.has(source.communicationEventId))) return false;
  return !receipts?.length || receipts.every(receipt => receipt.queuedForNextRun);
}

const receiptScope = (source: ReceiptSource) => JSON.stringify([
  source.conversationId ?? source.source?.conversationId ?? "", source.communicationEventId,
]);
function newerReceipt(left: MessageDeliveryReceiptDto, right: MessageDeliveryReceiptDto): MessageDeliveryReceiptDto {
  const staleQueue = ["queued","retrying","cancelled"].includes(right.state) && !right.providerAcknowledged &&
    !right.executionId && !right.recoveryExecutionId && !right.injectionId;
  return left.updatedAt > right.updatedAt || left.updatedAt === right.updatedAt &&
    left.activationId === right.activationId && left.attemptCount === right.attemptCount && left.queueDeletionConfirmed && staleQueue
    ? left : right;
}

/** Commit response evidence enters the existing exact receipt cache, never a hidden-ID list. */
export function applyQueuedMessageCancellation(client: QueryClient, response: CancelQueuedMessageResponse): void {
  if (!response.cancelled || !response.message) return;
  const message = response.message;
  const prefix = queryKeys.conversations.activeDeliveryReceiptsPrefix(message.conversationId);
  for (const [key, data] of client.getQueriesData<ActiveMessageDeliveryReceiptsDto>({queryKey:prefix})) {
    if (key[4] !== undefined && key[4] !== productApiPath("/api/conversations")) continue;
    if (typeof key[2] !== "string" || !key[2].split("\0").includes(message.communicationEventId)) continue;
    const items = data?.items ?? [];
    const previous = items.find(item => item.communicationEventId === message.communicationEventId);
    const current = new Map(previous?.deliveryReceipts.map(receipt => [receipt.targetAgentId, receipt]));
    const deliveryReceipts = message.deliveryReceipts.map(receipt => current.has(receipt.targetAgentId)
      ? newerReceipt(current.get(receipt.targetAgentId)!, receipt) : receipt);
    void client.cancelQueries({queryKey:key,exact:true},{revert:false});
    client.setQueryData(key, {...data, items:[...items.filter(item => item.communicationEventId !== message.communicationEventId),
      {communicationEventId:message.communicationEventId,deliveryReceipts}]});
  }
}

export function projectMessageDeliveryReceipts<T extends ReceiptSource>(
  sources: readonly T[], items: ActiveMessageDeliveryReceiptsDto["items"], previous: T[] = [],
): T[] {
  const exact = new Map(items.map(item => [item.communicationEventId, item.deliveryReceipts]));
  const retained = new Map(previous.filter(source => source.communicationEventId).map(source => [receiptScope(source),source]));
  const projected = sources.map(source => {
    const deliveryReceipts = source.communicationEventId ? exact.get(source.communicationEventId) : undefined;
    const saved = retained.get(receiptScope(source));
    if (deliveryReceipts === undefined && !saved) return source;
    // A cached exact read must not roll back a newer transition for another recipient.
    const current = new Map(source.deliveryReceipts?.map(receipt => [receipt.targetAgentId, receipt]));
    for (const receipt of saved?.deliveryReceipts ?? []) {
      const timeline = current.get(receipt.targetAgentId);
      if (timeline) current.set(receipt.targetAgentId, newerReceipt(timeline, receipt));
      else if (receipt.queueDeletionConfirmed) current.set(receipt.targetAgentId,receipt);
    }
    const latest = (deliveryReceipts ?? source.deliveryReceipts ?? []).map(receipt => {
      const timeline = current.get(receipt.targetAgentId);
      return timeline ? newerReceipt(timeline, receipt) : receipt;
    });
    for (const receipt of current.values()) {
      if (receipt.queueDeletionConfirmed && !latest.some(value => value.targetAgentId === receipt.targetAgentId)) latest.push(receipt);
    }
    return replaceEqualDeep(source, { ...source, deliveryReceipts: latest });
  });
  return replaceEqualDeep(previous, projected);
}



/** A committed receipt adopts its queue projection before a slower query refresh. */
export function adoptQueuedMessageReceipt(client:QueryClient,key:QueryKey,rows:QueuedConversationMessageDto[]):void {
 if(!rows.length)return;
 void client.cancelQueries({queryKey:key,exact:true},{revert:false});
 client.setQueryData<QueuedConversationMessageDto[]>(key,previous=>{
  const byId=new Map((previous??[]).map(row=>[row.deliveryId,row]));
  for(const row of rows)byId.set(row.deliveryId,{...row,...byId.get(row.deliveryId)});
  return [...byId.values()];
 });
}
