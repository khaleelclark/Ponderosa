import type Database from "better-sqlite3";
import { publicProviderFailureSummary } from "@ponderosa/core";

interface ProviderFailureUpdateProjection {
  id: string;
  payload: Record<string, unknown>;
}

const UNAVAILABLE_ACTIVATION_SECTION = {
  detail: "Activation payload section is unavailable.",
} as const;

function providerFailureUpdateProjections(
  sqlite: Database.Database,
  payloadJson: string,
): Map<string, ProviderFailureUpdateProjection> {
  const rows = sqlite.prepare(`
    SELECT request_update.id, request_update.provider_failure_category AS category,
      request_update.payload_json
    FROM coordination_request_updates request_update
    WHERE request_update.provider_failure_category IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM json_tree(CASE WHEN json_valid(?) THEN ? ELSE '{}' END) payload_node
        WHERE payload_node.type = 'text' AND payload_node.value = request_update.id
      )
    ORDER BY request_update.created_at, request_update.id
  `).all(payloadJson, payloadJson) as Array<{
    id: string;
    category: string;
    payload_json: string;
  }>;
  return new Map(rows.map((row) => {
    let activationId: string | undefined;
    let activationOutcome: string | undefined;
    try {
      const payload = JSON.parse(row.payload_json) as unknown;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const record = payload as Record<string, unknown>;
        if (typeof record.activationId === "string" &&
            record.activationId.length <= 1_024 &&
            !/[\u0000-\u001f\u007f-\u009f]/u.test(record.activationId)) {
          activationId = record.activationId;
        }
        if (typeof record.activationOutcome === "string" && [
          "recipient_unavailable",
          "permanent_failure",
          "retry_exhausted",
        ].includes(record.activationOutcome)) {
          activationOutcome = record.activationOutcome;
        }
      }
    } catch {
      // The provider-derived row is not copied. Only validated canonical
      // linkage and code-owned public failure text may enter the Activation.
    }
    return [row.id, {
      id: row.id,
      payload: {
        ...(activationId ? { activationId } : {}),
        ...(activationOutcome ? { activationOutcome } : {}),
        reason: publicProviderFailureSummary(undefined, row.category)
          ?? "Provider execution failed.",
      },
    }];
  }));
}

function defineJsonProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function sanitizeMaterializedProviderUpdates(
  value: unknown,
  updates: Map<string, ProviderFailureUpdateProjection>,
  budget = { nodes: 0 },
  depth = 0,
): { value: unknown; changed: boolean } {
  budget.nodes += 1;
  if (budget.nodes > 100_000 || depth > 128) {
    return { value: UNAVAILABLE_ACTIVATION_SECTION, changed: true };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const projected = value.map((item) => {
      const next = sanitizeMaterializedProviderUpdates(
        item,
        updates,
        budget,
        depth + 1,
      );
      changed ||= next.changed;
      return next.value;
    });
    return { value: changed ? projected : value, changed };
  }
  if (!value || typeof value !== "object") return { value, changed: false };

  const record = value as Record<string, unknown>;
  const directUpdate = typeof record.updateId === "string"
    ? updates.get(record.updateId)
    : undefined;
  const wrappedUpdate = typeof record.id === "string" &&
      Object.prototype.hasOwnProperty.call(record, "payload")
    ? updates.get(record.id)
    : undefined;
  let changed = false;
  const projected: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === "update" && directUpdate) {
      defineJsonProperty(projected, key, directUpdate.payload);
      changed = true;
      continue;
    }
    if (key === "payload" && wrappedUpdate) {
      defineJsonProperty(projected, key, wrappedUpdate.payload);
      changed = true;
      continue;
    }
    const next = sanitizeMaterializedProviderUpdates(
      child,
      updates,
      budget,
      depth + 1,
    );
    defineJsonProperty(projected, key, next.value);
    changed ||= next.changed;
  }
  return { value: changed ? projected : value, changed };
}

/**
 * Project an Activation payload before it crosses any read or execution
 * boundary. Historical coordination outcome payloads may contain a
 * materialized provider-failed Request update even when the durable update has
 * since been repaired. The structured update row is canonical for the public
 * and provider-input projection; exact provider evidence remains restricted to
 * scheduler_runs.provider_failure_json.
 */
export function providerSafeActivationPayload(
  sqlite: Database.Database,
  activationId: string,
  payloadJson: string,
): unknown {
  try {
    const payload = JSON.parse(payloadJson) as unknown;
    const updates = providerFailureUpdateProjections(sqlite, payloadJson);
    if (updates.size === 0) return payload;
    return sanitizeMaterializedProviderUpdates(payload, updates).value;
  } catch {
    return { activationId, detail: "Activation payload is unavailable." };
  }
}

export function publicActivationDeliveryError(input: {
  lastDeliveryError: string | null;
  providerFailureCategory?: string | null;
  hasProviderFailure?: boolean;
}): string | undefined {
  if (!input.lastDeliveryError) return undefined;
  if (input.providerFailureCategory || input.hasProviderFailure) {
    return publicProviderFailureSummary(
      undefined,
      input.providerFailureCategory ?? "unknown",
    ) ?? "Provider execution failed.";
  }
  return input.lastDeliveryError;
}
