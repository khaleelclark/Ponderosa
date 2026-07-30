import { createHash } from "node:crypto";

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
