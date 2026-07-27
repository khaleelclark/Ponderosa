import type { CommunicationProjection } from "@ponderosa/core";
import { readRepairableJsonl } from "./append-jsonl.js";
import { communicationProjectionsPath } from "./paths.js";

type ProjectionIndex = {
  projections: CommunicationProjection[];
  byTuple: Map<string, CommunicationProjection>;
};

/** Small process-local caches and cursor encoding shared by AgentStore facades. */
export class AgentStoreSupport {
  private readonly communicationProjectionCache = new Map<string, ProjectionIndex>();

  constructor(private readonly dataDir: string) {}

  clearCommunicationProjectionCache(projectId: string): void {
    this.communicationProjectionCache.delete(projectId);
  }

  projectionIndex(projectId: string): ProjectionIndex {
    let cached = this.communicationProjectionCache.get(projectId);
    if (cached) return cached;
    const records = readRepairableJsonl<CommunicationProjection>(
      communicationProjectionsPath(this.dataDir, projectId),
      "communication projection log",
      true,
    );
    const byTuple = new Map(records.map((projection) => [
      `${projection.eventId}\u0000${projection.surface}\u0000${projection.projectionKey}`,
      projection,
    ]));
    cached = { projections: [...byTuple.values()], byTuple };
    this.communicationProjectionCache.set(projectId, cached);
    return cached;
  }

  encodeHistoryCursor(input: {
    stream: string;
    scope: string;
    orderKey: string;
    rowKey: string;
  }): string {
    return Buffer.from(JSON.stringify({ v: 1, ...input }), "utf8")
      .toString("base64url");
  }

  decodeHistoryCursor(
    cursor: string,
    stream: string,
    scope: string,
  ): { orderKey: string; rowKey: string } {
    let parsed: unknown;
    try {
      const decoded = Buffer.from(cursor, "base64url");
      if (decoded.toString("base64url") !== cursor) {
        throw new Error("non-canonical cursor");
      }
      parsed = JSON.parse(decoded.toString("utf8"));
    } catch {
      throw new Error("invalid history cursor");
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error("invalid history cursor");
    }
    const value = parsed as Record<string, unknown>;
    if (
      value.v !== 1 ||
      value.stream !== stream ||
      value.scope !== scope ||
      typeof value.orderKey !== "string" ||
      typeof value.rowKey !== "string"
    ) {
      throw new Error("invalid history cursor");
    }
    return { orderKey: value.orderKey, rowKey: value.rowKey };
  }
}
