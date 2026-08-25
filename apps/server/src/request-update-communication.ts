import { createHash } from "node:crypto";
import type {
  CommunicationEvent,
  CoordinationRequestUpdateKind,
} from "@ponderosa/core";

const REQUEST_COMMUNICATION_HANDOFF_KINDS:
  ReadonlySet<CoordinationRequestUpdateKind> = new Set([
    "answer",
    "completed",
    "blocked",
    "failed",
  ]);

/** Only consequential Request handoffs belong in Team and Agent chat audits. */
export function isRequestCommunicationHandoffKind(
  kind: CoordinationRequestUpdateKind,
): boolean {
  return REQUEST_COMMUNICATION_HANDOFF_KINDS.has(kind);
}

/** Stable identity shared by immediate passive projection and read recovery. */
export function requestUpdateCommunicationEventId(
  projectId: string,
  requestId: string,
  updateId: string,
): string {
  return `request-update-${createHash("sha256")
    .update(`${projectId}\0${requestId}\0${updateId}`)
    .digest("hex")}`;
}

/** Resolve only server-authored passive Request handoffs. Rendered text and
 * artifact pointers never establish this relationship. */
export function requestUpdateCommunicationLink(
  communication: CommunicationEvent | undefined,
): {
  requestId: string;
  updateId: string;
  sourceCommunicationEventId: string;
} | undefined {
  if (
    !communication
    || communication.intent !== "collaboration"
    || communication.sender.kind !== "agent"
    || communication.audience.kind !== "agents"
  ) return undefined;
  const requestId = communication.correlationId?.trim();
  const sourceCommunicationEventId = communication.causationId?.trim();
  const idempotencyKey = communication.idempotencyKey?.trim();
  if (!requestId || !sourceCommunicationEventId || !idempotencyKey) {
    return undefined;
  }
  const prefix = `request-update:${requestId}:`;
  if (!idempotencyKey.startsWith(prefix)) return undefined;
  const updateId = idempotencyKey.slice(prefix.length);
  if (
    !updateId
    || communication.eventId !== requestUpdateCommunicationEventId(
      communication.projectId,
      requestId,
      updateId,
    )
  ) return undefined;
  return { requestId, updateId, sourceCommunicationEventId };
}
