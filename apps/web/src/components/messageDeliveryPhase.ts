import type { MessageDeliveryReceiptDto } from "@ponderosa/core";

/** Routine phases share exact delivery evidence; recovery/uncertainty keeps its own wording. */
export function messageDeliveryPhase(receipt: MessageDeliveryReceiptDto): "Waiting" | "Starting" | "Working" | undefined {
  if (receipt.state === "queued" || receipt.state === "retrying" || receipt.state === "steering") return "Waiting";
  if (receipt.state === "preparing" || receipt.state === "started") return "Starting";
  if (receipt.state === "delivered" && receipt.injectionKind === "turn" &&
      receipt.providerAcknowledged && receipt.injectionId && receipt.executionId) return "Working";
  return undefined;
}
