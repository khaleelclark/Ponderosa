import type { MessageDeliveryReceiptDto } from "@ponderosa/core";

/** Routine phases share exact delivery evidence; recovery/uncertainty keeps its own wording. */
export function messageDeliveryPhase(receipt: MessageDeliveryReceiptDto): "Queued" | "Retrying delivery" | "Awaiting acknowledgement" | "Starting" | "Working" | undefined {
  if (receipt.state === "queued") return "Queued";
  if (receipt.state === "retrying") return "Retrying delivery";
  if (receipt.state === "steering") return "Awaiting acknowledgement";
  if (receipt.state === "preparing" || receipt.state === "started") return "Starting";
  if (receipt.state === "delivered" && receipt.injectionKind === "turn" &&
      receipt.providerAcknowledged && receipt.injectionId && receipt.executionId) return "Working";
  return undefined;
}
