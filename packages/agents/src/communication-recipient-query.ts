// Resolve both ID forms before looking up activation sources. CROSS JOIN keeps
// SQLite seeking each resolved ID instead of scanning all communication sources.
export const communicationRecipientQuery = `
  FROM (
    SELECT id, project_id FROM runtime_communications WHERE id = ?
    UNION
    SELECT id, project_id FROM runtime_communications INDEXED BY runtime_communications_authored_event
    WHERE json_valid(payload_json) AND json_extract(payload_json, '$.communication.eventId') = ?
  ) communication
  CROSS JOIN activation_sources source INDEXED BY activation_sources_communication_lookup
    ON source.source_kind = 'communication' AND source.source_id = communication.id
  JOIN agent_activations activation ON activation.id = source.activation_id
  WHERE communication.project_id = ?
    AND activation.project_id = communication.project_id
`;
