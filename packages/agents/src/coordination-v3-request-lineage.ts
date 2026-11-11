/** Canonical mapping from Activation sources to the Requests whose authority
 * they carry. Keep every consumer on this one definition so resumed answers
 * and Join continuations cannot diverge from direct Request ownership. */
export function requestSourceLineageBody(
  sourceTable: "activation_sources" | "task_wake_sources" | "branch_live_sources" | "branch_retry_sources" = "activation_sources",
): string {
  return `request_source_lineage AS (
    SELECT source.activation_id, source.source_kind,
      source.source_id AS request_id
    FROM ${sourceTable} source
    WHERE source.source_kind = 'request'

    UNION ALL

    SELECT source.activation_id, source.source_kind,
      request_update.request_id
    FROM ${sourceTable} source
    JOIN coordination_request_updates request_update
      ON request_update.id = source.source_id
    WHERE source.source_kind = 'request_update'

    UNION ALL

    SELECT source.activation_id, source.source_kind,
      continuation.value AS request_id
    FROM ${sourceTable} source
    JOIN coordination_joins join_record ON join_record.id = source.source_id
    JOIN json_each(join_record.continuation_request_ids_json) continuation
    WHERE source.source_kind = 'join'
  )
`;
}

export const REQUEST_SOURCE_LINEAGE_CTE = `WITH ${requestSourceLineageBody()}`;

/** Keep ambiguous history authoritative; exclude only exact unsent cancellations.
 * Aliases are internal SQL identifiers, never caller input. */
export function currentRequestAttachmentSql(attachment: "attached" | "a"): string {
  const membership = `injection.run_id = ${attachment}.run_id
        AND member.value = ${attachment}.activation_id`;
  return `(NOT EXISTS (
    SELECT 1 FROM scheduler_prompt_injections injection,
      json_each(injection.activation_ids_json) member
    WHERE ${membership}
  ) OR EXISTS (
    SELECT 1 FROM scheduler_prompt_injections injection,
      json_each(injection.activation_ids_json) member
    WHERE ${membership}
      AND NOT (injection.state = 'cancelled'
        AND injection.submitted_at IS NULL
        AND injection.acknowledged_at IS NULL
        AND injection.provider_turn_id IS NULL)
  ))`;
}
