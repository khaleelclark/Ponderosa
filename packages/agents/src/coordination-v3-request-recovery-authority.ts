import type Database from "better-sqlite3";
import type { CoordinationRequestState } from "@ponderosa/core";

const RECOVERABLE_REQUEST_STATES = new Set<CoordinationRequestState>([
  "blocked",
  "failed",
  "outcome_unknown",
  "expired",
  "recipient_unavailable",
]);
const LEGACY_RECOVERY_LIMIT = 10_000;
const LEGACY_RECOVERY_LIMIT_ERROR_CODE =
  "coordination_legacy_recovery_candidate_limit_exceeded";

class RecoveryBindingValidationError extends Error {}

export class CoordinationLegacyRecoveryLimitError extends Error {
  readonly code = LEGACY_RECOVERY_LIMIT_ERROR_CODE;

  constructor() {
    super(
      `${LEGACY_RECOVERY_LIMIT_ERROR_CODE}: Ponderosa cannot start because more than ${LEGACY_RECOVERY_LIMIT} legacy Request recovery candidates require reconciliation. Remove or migrate the legacy retry markers, then restart Ponderosa.`,
    );
    this.name = "CoordinationLegacyRecoveryLimitError";
  }
}

interface RecoveryRequestRow {
  id: string;
  project_id: string;
  conversation_id: string | null;
  requester_agent_id: string | null;
  recipient_agent_id: string;
  state: CoordinationRequestState;
  superseded_by_request_id: string | null;
}

/** Owns the immutable, direct Request recovery edge. The existing
 * superseded_by_request_id column is canonical; payload text is never
 * consulted for newly created Requests. */
export class CoordinationV3RequestRecoveryAuthority {
  constructor(private readonly sqlite: Database.Database) {}

  bind(input: {
    predecessorRequestId: string;
    successorRequestId: string;
    actorScope: string;
    actorAgentId?: string;
  }): void {
    const { predecessorRequestId, successorRequestId } = input;
    if (predecessorRequestId === successorRequestId) {
      throw new RecoveryBindingValidationError("a recovery Request cannot recover itself");
    }
    const predecessor = this.request(predecessorRequestId);
    const successor = this.request(successorRequestId);
    if (!RECOVERABLE_REQUEST_STATES.has(predecessor.state)) {
      throw new RecoveryBindingValidationError(
        "the predecessor Request is not in a recoverable terminal state",
      );
    }
    if (
      predecessor.project_id !== successor.project_id ||
      predecessor.conversation_id !== successor.conversation_id
    ) {
      throw new RecoveryBindingValidationError(
        "recovery Requests must remain in the exact Project and Team Chat",
      );
    }
    if (
      predecessor.requester_agent_id !== successor.requester_agent_id ||
      predecessor.recipient_agent_id !== successor.recipient_agent_id
    ) {
      throw new RecoveryBindingValidationError(
        "recovery Requests must preserve the exact requester and recipient",
      );
    }
    const operator = input.actorScope === "user:local-operator";
    const requester = Boolean(
      input.actorAgentId &&
      input.actorAgentId === predecessor.requester_agent_id &&
      input.actorAgentId === successor.requester_agent_id,
    );
    if (!operator && !requester) {
      throw new RecoveryBindingValidationError(
        "the actor is not authorized to recover this Request",
      );
    }
    if (
      predecessor.superseded_by_request_id &&
      predecessor.superseded_by_request_id !== successor.id
    ) {
      throw new RecoveryBindingValidationError(
        "the predecessor Request already has an exact successor",
      );
    }
    const ownedPredecessor = this.sqlite.prepare(`
      SELECT id FROM coordination_requests
      WHERE superseded_by_request_id = ? AND id <> ?
      LIMIT 1
    `).get(successor.id, predecessor.id);
    if (ownedPredecessor) {
      throw new RecoveryBindingValidationError(
        "the successor Request is already bound to another predecessor",
      );
    }
    const createsCycle = Boolean(this.sqlite.prepare(`
      WITH RECURSIVE successors(id) AS (
        SELECT superseded_by_request_id FROM coordination_requests WHERE id = ?
        UNION
        SELECT request.superseded_by_request_id
        FROM coordination_requests request
        JOIN successors ON request.id = successors.id
        WHERE request.superseded_by_request_id IS NOT NULL
      )
      SELECT 1 FROM successors WHERE id = ? LIMIT 1
    `).get(successor.id, predecessor.id));
    if (createsCycle) {
      throw new RecoveryBindingValidationError(
        "Request recovery lineage cannot contain a cycle",
      );
    }
    if (predecessor.superseded_by_request_id === successor.id) return;
    const changed = this.sqlite.prepare(`
      UPDATE coordination_requests SET superseded_by_request_id = ?
      WHERE id = ? AND superseded_by_request_id IS NULL
    `).run(successor.id, predecessor.id).changes;
    if (changed !== 1) {
      throw new RecoveryBindingValidationError(
        "Request recovery lineage changed concurrently",
      );
    }
  }

  /** Bounded compatibility import for historical rows written before the
   * structured edge became authoritative. Invalid, ambiguous, or cyclic
   * payload claims are ignored and can never overwrite a canonical edge. */
  reconcileLegacyPayloadRelations(): void {
    const reconcile = this.sqlite.transaction(() => {
      const rows = this.sqlite.prepare(`
        SELECT id,
          json_extract(payload_json, '$.retryOfRequestId') AS predecessor_id
        FROM coordination_requests
        WHERE json_valid(payload_json)
          AND json_type(payload_json, '$.retryOfRequestId') = 'text'
          AND length(json_extract(payload_json, '$.retryOfRequestId')) BETWEEN 1 AND 200
        ORDER BY created_at, id
        LIMIT ?
      `).all(LEGACY_RECOVERY_LIMIT + 1) as Array<{
        id: string;
        predecessor_id: string;
      }>;
      if (rows.length > LEGACY_RECOVERY_LIMIT) {
        throw new CoordinationLegacyRecoveryLimitError();
      }
      for (const row of rows) {
        try {
          const successor = this.request(row.id);
          this.bind({
            predecessorRequestId: row.predecessor_id,
            successorRequestId: row.id,
            actorScope: successor.requester_agent_id
              ? `legacy-agent:${successor.requester_agent_id}`
              : "legacy-unowned",
            ...(successor.requester_agent_id
              ? { actorAgentId: successor.requester_agent_id }
              : {}),
          });
        } catch (error) {
          if (!(error instanceof RecoveryBindingValidationError)) throw error;
          // Legacy payload is compatibility evidence, never mutation authority.
        }
      }
    });
    reconcile.immediate();
  }

  private request(requestId: string): RecoveryRequestRow {
    const row = this.sqlite.prepare(`
      SELECT id, project_id, conversation_id, requester_agent_id,
        recipient_agent_id, state, superseded_by_request_id
      FROM coordination_requests WHERE id = ?
    `).get(requestId) as RecoveryRequestRow | undefined;
    if (!row) {
      throw new RecoveryBindingValidationError(
        "recovery predecessor Request was not found",
      );
    }
    return row;
  }
}
