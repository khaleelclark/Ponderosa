/** Canonical mapping from Activation sources to the Requests whose authority
 * they carry. Keep every consumer on this one definition so resumed answers
 * and Join continuations cannot diverge from direct Request ownership. */
export const REQUEST_SOURCE_LINEAGE_CTE = `
  WITH request_source_lineage AS (
    SELECT source.activation_id, source.source_kind,
      source.source_id AS request_id
    FROM activation_sources source
    WHERE source.source_kind = 'request'

    UNION ALL

    SELECT source.activation_id, source.source_kind,
      request_update.request_id
    FROM activation_sources source
    JOIN coordination_request_updates request_update
      ON request_update.id = source.source_id
    WHERE source.source_kind = 'request_update'

    UNION ALL

    SELECT source.activation_id, source.source_kind,
      continuation.value AS request_id
    FROM activation_sources source
    JOIN coordination_joins join_record ON join_record.id = source.source_id
    JOIN json_each(join_record.continuation_request_ids_json) continuation
    WHERE source.source_kind = 'join'
  )
`;
