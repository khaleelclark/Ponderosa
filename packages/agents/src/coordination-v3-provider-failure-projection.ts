import type Database from "better-sqlite3";
import { publicProviderFailureSummary } from "@ponderosa/core";

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
  const providerFailure = sqlite.prepare(`
    SELECT request_update.provider_failure_category AS category
    FROM json_tree(CASE WHEN json_valid(?) THEN ? ELSE '{}' END) payload_node
    JOIN coordination_request_updates request_update
      ON payload_node.key = 'updateId' AND payload_node.value = request_update.id
    WHERE request_update.provider_failure_category IS NOT NULL
    LIMIT 1
  `).get(payloadJson, payloadJson) as { category: string } | undefined;
  if (providerFailure) {
    return {
      providerFailure: publicProviderFailureSummary(
        undefined,
        providerFailure.category,
      ) ?? "Provider execution failed.",
    };
  }
  try {
    return JSON.parse(payloadJson) as unknown;
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
