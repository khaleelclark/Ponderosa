/** Scope only the exact queued Activation. A failed or uncertain rollover
 * remains a hold even if its failure was recorded by startup recovery rather
 * than the ordinary transition path. */
export function settingsTransitionActivationHoldSql(activation:string):string {
  return `(EXISTS (SELECT 1 FROM activation_sources reservation
      WHERE reservation.activation_id=${activation}.id AND reservation.source_kind='settings_transition_reservation_wait')
    OR EXISTS (
      SELECT 1 FROM context_rollovers rollover
      JOIN activation_sources source ON source.source_kind='context_rollover' AND source.source_id=rollover.id
      JOIN agent_activations handoff ON handoff.id=source.activation_id AND handoff.kind='context_rollover_handoff'
      WHERE rollover.project_id=${activation}.project_id AND rollover.agent_id=${activation}.agent_id
        AND rollover.state IN ('failed','outcome_unknown')
        AND json_extract(handoff.payload_json,'$.settingsTransition.activationId')=${activation}.id
        AND NOT EXISTS (SELECT 1 FROM activation_sources released
          WHERE released.activation_id=${activation}.id AND released.source_kind='settings_transition_release'
            AND released.source_id=rollover.id)
    ))`;
}
