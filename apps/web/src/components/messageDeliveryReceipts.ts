import type { ActiveMessageDeliveryReceiptsDto, MessageDeliveryReceiptDto } from "@ponderosa/core";
import { replaceEqualDeep } from "@tanstack/react-query";

export interface ReceiptSource {
  communicationEventId?: string;
  conversationId?: string;
  source?: { conversationId?: string };
  deliveryReceipts?: MessageDeliveryReceiptDto[];
}

export function projectMessageDeliveryReceipts<T extends ReceiptSource>(
  sources: readonly T[], items: ActiveMessageDeliveryReceiptsDto["items"], previous: T[] = [],
): T[] {
  const exact = new Map(items.map(item => [item.communicationEventId, item.deliveryReceipts]));
  const projected = sources.map(source => {
    const deliveryReceipts = source.communicationEventId ? exact.get(source.communicationEventId) : undefined;
    if (deliveryReceipts === undefined) return source;
    // A cached exact read must not roll back a newer transition for another recipient.
    const current = new Map(source.deliveryReceipts?.map(receipt => [receipt.targetAgentId, receipt]));
    const latest = deliveryReceipts.map(receipt => {
      const timeline = current.get(receipt.targetAgentId);
      return timeline && timeline.updatedAt > receipt.updatedAt ? timeline : receipt;
    });
    return replaceEqualDeep(source, { ...source, deliveryReceipts: latest });
  });
  return replaceEqualDeep(previous, projected);
}

